import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {complete} from '../src/ai.js';
import {EFFORT_LEVELS, cleanEffort, effortLabel} from '../shared/ai-presets.js';
import {buildCommand} from '../agent/cli-model.mjs';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey} from '../src/vault.js';
import * as ai from '../src/ai-providers.js';
import {migrate} from '../shared/workflow.js';

// How hard a model thinks is one setting with three levels. Each wire spells it
// its own way, a provider that does not know it is asked again without it, and
// the owner's own CLIs get it as a flag.

/** A loopback provider that answers each request with the next scripted reply. */
async function stub(replies) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', c => body += c);
    req.on('end', () => {
      requests.push({url: req.url, body: body ? JSON.parse(body) : null});
      const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
      res.writeHead(reply.status, {'Content-Type': 'application/json'});
      res.end(JSON.stringify(reply.json));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return {requests, port: server.address().port, close: () => server.close()};
}
const cfg = (port, extra) => ({baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'm', ...extra});
const ask = config => complete({instructions: 'Answer briefly.', input: 'hi', config});
const CHAT_OK = {status: 200, json: {choices: [{message: {content: 'ok'}}]}};

test('effort has three levels, and anything else is no effort', () => {
  assert.deepEqual(EFFORT_LEVELS.map(l => l.id), ['low', 'medium', 'high']);
  assert.equal(cleanEffort('HIGH'), 'high');
  assert.equal(cleanEffort(''), '');
  assert.equal(cleanEffort(null), '');
  assert.equal(cleanEffort('turbo'), null, 'an unknown level is refused, not guessed');
  assert.match(effortLabel('low'), /low/i);
  assert.match(effortLabel(''), /default/i);
});

test('each wire carries the effort in its own field', async () => {
  const cases = [
    ['openai-chat', CHAT_OK, b => b.reasoning_effort],
    ['openai-responses', {status: 200, json: {output_text: 'ok'}}, b => b.reasoning?.effort],
    ['anthropic', {status: 200, json: {content: [{type: 'text', text: 'ok'}]}}, b => b.output_config?.effort],
    ['gemini', {status: 200, json: {candidates: [{content: {parts: [{text: 'ok'}]}}]}}, b => b.generationConfig?.thinkingConfig?.thinkingLevel],
  ];
  for (const [protocol, reply, read] of cases) {
    const s = await stub([reply]);
    try { assert.equal(await ask(cfg(s.port, {protocol, effort: 'high'})), 'ok'); } finally { s.close(); }
    assert.equal(read(s.requests[0].body), 'high', protocol);
    const plain = await stub([reply]);
    try { await ask(cfg(plain.port, {protocol})); } finally { plain.close(); }
    assert.equal(read(plain.requests[0].body), undefined, `${protocol} sends nothing without an effort`);
  }
});

test('a provider that rejects the effort is asked once more without it', async () => {
  for (const [protocol, error, ok] of [
    ['openai-chat', {error: {message: 'Unrecognized request argument supplied: reasoning_effort'}}, CHAT_OK],
    ['anthropic', {type: 'error', error: {type: 'invalid_request_error', message: 'This model does not support the effort parameter.'}}, {status: 200, json: {content: [{type: 'text', text: 'ok'}]}}],
  ]) {
    const s = await stub([{status: 400, json: error}, ok]);
    try { assert.equal(await ask(cfg(s.port, {protocol, effort: 'low'})), 'ok', protocol); } finally { s.close(); }
    assert.equal(s.requests.length, 2, protocol);
    assert.equal(JSON.stringify(s.requests[1].body).includes('low'), false, `${protocol} retry drops the effort`);
  }
  // A 400 about something else is not retried as an effort problem.
  const bad = await stub([{status: 400, json: {error: {message: 'Invalid API key'}}}]);
  try { await assert.rejects(ask(cfg(bad.port, {protocol: 'openai-chat', effort: 'low'})), /400/); } finally { bad.close(); }
  assert.equal(bad.requests.length, 1);
});

test('the owner\'s own CLIs get the effort as their flag', () => {
  const claude = buildCommand('claude', {dir: '/x', effort: 'medium'}).args;
  assert.equal(claude[claude.indexOf('--effort') + 1], 'medium');
  const codex = buildCommand('codex', {dir: '/x', effort: 'high'}).args;
  assert.ok(codex.includes('model_reasoning_effort="high"'), codex.join(' '));
  assert.equal(buildCommand('claude', {dir: '/x'}).args.includes('--effort'), false);
  assert.throws(() => buildCommand('claude', {dir: '/x', effort: '--yolo'}), /effort/i);
});

test('effort is saved for the workspace and per bot, and the bot wins', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'effort-'));
  try {
    const dataFile = path.join(dir, 'state.json');
    const store = await new SqliteStore(path.join(dir, 'state.db'), dataFile).init();
    store.vaultKey = loadMasterKey(dataFile).key;
    await store.update(s => { migrate(s); s.groups = [{id: 'g', name: 'G', bots: [{id: 'writer', name: 'Writer', type: 'custom'}, {id: 'other', name: 'Other', type: 'custom'}]}]; });
    const p = await ai.addProvider(store, 'default', {label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'gsk_x'});
    await ai.setDefaults(store, {providerId: p.id, model: 'm1', effort: 'low'});
    assert.equal(ai.resolveConfig(store, 'writer').effort, 'low');
    await ai.setBotModel(store, 'writer', {effort: 'high'});
    assert.equal(ai.resolveConfig(store, 'writer').effort, 'high');
    assert.equal(ai.resolveConfig(store, 'writer').model, 'm1', 'an effort alone keeps the default model');
    assert.equal(ai.resolveConfig(store, 'other').effort, 'low');
    const pub = ai.publicAi(store.read());
    assert.equal(pub.defaultEffort, 'low');
    assert.equal(pub.bots.writer.effort, 'high');
    await assert.rejects(ai.setBotModel(store, 'writer', {effort: 'turbo'}), /effort/i);
    await ai.setBotModel(store, 'writer', {effort: ''});
    assert.equal(store.read().ai.bots.writer, undefined, 'clearing the only override removes it');
    await ai.setDefaults(store, {effort: ''});
    assert.equal(ai.resolveConfig(store, 'writer').effort || null, null);
    await assert.rejects(ai.setDefaults(store, {effort: 'max!'}), /effort/i);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
