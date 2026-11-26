import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey} from '../src/vault.js';
import * as ai from '../src/ai-providers.js';
import {executeCustomBot, clearCoolOff} from '../src/ai.js';
import {meterTurn} from '../src/usage.js';
import {migrate} from '../shared/workflow.js';

// The whole path a saved fallback takes: Settings' `setDefaults` writes it, `resolveConfig` attaches it to the bot,
// and a bot turn whose own provider is down is answered by the fallback. Loopback provider stubs, no mocks.

async function stub(reply) {
  const requests = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { requests.push(req.url); res.writeHead(reply.status, {'Content-Type': 'application/json'}); res.end(JSON.stringify(reply.json)); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {requests, port: server.address().port, close: () => server.close()};
}
const ok = text => ({status: 200, json: {choices: [{message: {content: text}}], usage: {prompt_tokens: 7, completion_tokens: 3}}});
const down = {status: 503, json: {error: {message: 'trouble'}}};

async function withStore(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-fallback-turn-'));
  const retry = process.env.AI_RETRY_MS; process.env.AI_RETRY_MS = '0';
  clearCoolOff();
  try {
    const dataFile = path.join(dir, 'state.json');
    const store = await new SqliteStore(path.join(dir, 'state.db'), dataFile).init();
    store.vaultKey = loadMasterKey(dataFile).key;
    await store.update(s => { migrate(s); s.groups = [{id: 'home', name: 'Home', bots: [{id: 'writer', name: 'Writer', type: 'custom'}]}]; });
    return await fn(store);
  } finally {
    if (retry === undefined) delete process.env.AI_RETRY_MS; else process.env.AI_RETRY_MS = retry;
    await fs.rm(dir, {recursive: true, force: true});
  }
}
/** A saved provider whose address is a loopback stub. */
async function provider(store, label, model, server) {
  const p = await ai.addProvider(store, 'w1', {label, baseUrl: `http://127.0.0.1/${label.toLowerCase()}/v1`, apiKey: `key-for-${label}-12345`, protocol: 'openai-chat'});
  await store.update(s => { const row = s.ai.providers.find(x => x.id === p.id); row.baseUrl = `http://127.0.0.1:${server.port}/v1`; row.models = row.chatModels = [model]; });
  return p;
}
const bot = {id: 'writer', name: 'Writer', instructions: 'Write things.'};
const turn = (store) => meterTurn(store, {}, () => executeCustomBot(bot, 'hello', ai.resolveConfig(store, 'writer')));

test('a saved ai.fallbacks answers a bot turn whose own provider returns 503', async () => withStore(async store => {
  const main = await stub(down), second = await stub(ok('from the second')), third = await stub(ok('from the third'));
  try {
    const a = await provider(store, 'Main', 'big', main), b = await provider(store, 'Second', 'mid', second), c = await provider(store, 'Third', 'small', third);
    await ai.setDefaults(store, {providerId: a.id, model: 'big'});
    await ai.setDefaults(store, {fallbacks: [{providerId: b.id, model: 'mid'}, {providerId: c.id, model: 'small'}]});
    const out = await turn(store);
    assert.equal(out.value, 'from the second');
    assert.deepEqual([main.requests.length, second.requests.length, third.requests.length], [2, 1, 0]);
    assert.deepEqual(out.calls[0].fallbackFrom, {model: 'big', why: 'the provider is having trouble'});
    assert.equal(out.calls[0].providerId, b.id);
    // Next turn the main provider is resting: no request goes to it.
    assert.equal((await turn(store)).value, 'from the second');
    assert.equal(main.requests.length, 2);
  } finally { for (const s of [main, second, third]) s.close(); }
}));

test('a stored ai.fallback with no ai.fallbacks (an install from before) answers a bot turn the same way', async () => withStore(async store => {
  const main = await stub(down), spare = await stub(ok('from the old fallback'));
  try {
    const a = await provider(store, 'Main', 'big', main), b = await provider(store, 'Spare', 'mid', spare);
    await ai.setDefaults(store, {providerId: a.id, model: 'big'});
    await store.update(s => { delete s.ai.fallbacks; s.ai.fallback = {providerId: b.id, model: 'mid'}; });
    assert.equal(store.read().ai.fallbacks, undefined);
    const out = await turn(store);
    assert.equal(out.value, 'from the old fallback');
    assert.deepEqual([main.requests.length, spare.requests.length], [2, 1]);
    assert.equal(out.calls[0].fallbackFrom.model, 'big');
  } finally { main.close(); spare.close(); }
}));
