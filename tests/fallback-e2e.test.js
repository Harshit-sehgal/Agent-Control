import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey} from '../src/vault.js';
import * as ai from '../src/ai-providers.js';
import {createApp} from '../src/app.js';
import {clearCoolOff} from '../src/ai.js';
import {migrate} from '../shared/workflow.js';
import {BUSY_STATUSES as BUSY} from '../shared/run-state.js';

process.env.AGENT_SKIP_DOTENV = '1';

// Phase 1b's "see it work", end to end: the real request handler on an ephemeral port, a temp data directory, and two
// loopback provider stubs. The bot's own model answers 429 with Retry-After: 1; the owner saved a second model as
// its fallback through PATCH /api/ai. The first message is answered by the fallback and the chat says so once; after
// the rest ends (real time) the own model, now answering 200, is asked again and answers.

/** A provider stub: `modes[model]` (`status`, `retryAfter`, `text`) is read per request, so a test can heal it. */
async function provider(modes) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const model = JSON.parse(body).model;
      const mode = modes[model];
      requests.push(model);
      if (mode.status === 200) {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify({choices: [{message: {content: mode.text}}], usage: {prompt_tokens: 7, completion_tokens: 3}}));
      } else {
        res.writeHead(mode.status, {'Content-Type': 'application/json', ...(mode.retryAfter ? {'Retry-After': mode.retryAfter} : {})});
        res.end(JSON.stringify({error: {message: 'slow down'}}));
      }
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {requests, port: server.address().port, close: () => new Promise(r => server.close(r))};
}

for (const same of [false, true]) test(`a rate-limited own model: the fallback${same ? ' on the same provider' : ''} answers and the chat says so once; after the rest the own model is back`, {timeout: 60000}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fallback-e2e-'));
  const dataFile = path.join(dir, 'state.json');
  const store = await new SqliteStore(path.join(dir, 'state.db'), dataFile).init();
  store.vaultKey = loadMasterKey(dataFile).key;
  clearCoolOff();
  const ownMode = {status: 429, retryAfter: '1'}, spareMode = {status: 200, text: 'from the fallback'};
  // Two providers, or one provider holding both models (one account: its big model limited, its small one fine).
  const own = await provider(same ? {big: ownMode, small: spareMode} : {big: ownMode}), spare = same ? own : await provider({small: spareMode});
  const app = createApp({store, auth: {session: id => (id === 'owner' ? {email: 'owner@example.test', role: 'owner', workspaceId: 'w1'} : null)}, workspaces: {get: id => (id === 'w1' ? store : null)}, push: {}, version: 'e2e'});
  const server = http.createServer(app.handler);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, {method, headers: {cookie: 'agent_session=owner', 'content-type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
    const text = await res.text();
    assert.ok(res.status < 400, `${method} ${url}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  // The route answers 202 as the run starts; the run is over when the group's runs are no longer busy (`BUSY`).
  const sayHello = async text => {
    await call('POST', '/api/groups/home/chat', {message: text, directBotId: 'writer'});
    for (let i = 0; i < 300 && (store.read().groupRuns || []).some(r => BUSY.includes(r.status)); i++) await new Promise(r => setTimeout(r, 50));
    assert.ok(!(store.read().groupRuns || []).some(r => BUSY.includes(r.status)), 'the run finished');
    return store.read().chats.writer || [];
  };
  const saved = async (label, model, server_) => {
    const p = await ai.addProvider(store, 'w1', {label, baseUrl: `http://127.0.0.1/${label.toLowerCase()}/v1`, apiKey: `key-for-${label}-12345`, protocol: 'openai-chat'});
    await store.update(s => { const row = s.ai.providers.find(x => x.id === p.id); row.baseUrl = `http://127.0.0.1:${server_.port}/v1`; row.models = row.chatModels = [model]; });
    return p;
  };
  const asked = (server_, model) => server_.requests.filter(m => m === model).length;
  try {
    assert.notEqual(server.address().port, 4173);
    await store.update(s => { migrate(s); s.groups = [{id: 'home', name: 'Home', bots: [{id: 'writer', name: 'Writer', type: 'custom', instructions: 'Write things.'}]}]; });
    const a = await saved('Main', 'big', own), b = same ? a : await saved('Spare', 'small', spare);
    if (same) await store.update(s => { s.ai.providers.find(x => x.id === a.id).models = s.ai.providers.find(x => x.id === a.id).chatModels = ['big', 'small']; });
    await call('PATCH', '/api/ai', {providerId: a.id, model: 'big'});
    await call('PATCH', '/api/ai', {fallbacks: [{providerId: b.id, model: 'small'}]});
    assert.deepEqual((await call('GET', '/api/ai')).fallbacks, [{providerId: b.id, model: 'small'}]);

    // 1. The own model is rate limited: its one retry (after Retry-After) is limited too, so the fallback answers.
    let chat = await sayHello('hello');
    const replies = chat.filter(m => m.role === 'bot' && m.mode === 'ai');
    assert.deepEqual(replies.map(m => m.text), ['from the fallback']);
    assert.deepEqual([asked(own, 'big'), asked(spare, 'small')], [2, 1]);
    const notes = chat.filter(m => m.kind === 'fallback');
    assert.equal(notes.length, 1, 'the chat says the fallback answered, once');
    assert.match(notes[0].text, /big.*rate limited.*small/s);

    // 2. Past the rest (Retry-After: 1) with the own provider answering again: the own model is asked and answers.
    await new Promise(r => setTimeout(r, 1500));
    Object.assign(ownMode, {status: 200, text: 'from the own model'});
    chat = await sayHello('hello again');
    assert.equal(chat.filter(m => m.role === 'bot' && m.mode === 'ai').at(-1).text, 'from the own model');
    assert.deepEqual([asked(own, 'big'), asked(spare, 'small')], [3, 1], 'the spare was not asked again');
    assert.equal(chat.filter(m => m.kind === 'fallback').length, 1, 'no new fallback line');
    console.log(same ? 'one provider' : 'two providers', '| own model requests:', asked(own, 'big'), '| fallback requests:', asked(spare, 'small'), '| chat:', chat.filter(m => m.role !== 'user').map(m => `${m.kind || m.role}: ${m.text}`));
  } finally {
    await new Promise(r => server.close(r));
    await own.close(); if (spare !== own) await spare.close();
    await store.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
});
