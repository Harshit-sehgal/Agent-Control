import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import * as coordination from '../src/coordination.js';
import {noteUsage} from '../src/usage.js';

// A run's details show what it used: tokens per turn on the trace, the run's total, and each bot's day.

const until = async (check, timeout = 4000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return true; await new Promise(r => setTimeout(r, 10)); }
  throw new Error('Timed out waiting for the run.');
};
const quietly = async fn => { const original = console.error; console.error = () => {}; try { return await fn(); } finally { console.error = original; } };

async function workspace(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-usage-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  t.after(() => rm(dir, {recursive: true, force: true}));
  await store.update(s => {
    s.groups = [{id: 'team', name: 'Team', kind: 'group', instructions: 'Work.', autopilot: false, coordination: 'tracked', maxSteps: 1, messages: [], bots: [{id: 'scout', name: 'Scout', instructions: 'Read.', permissions: []}]}];
    s.groupRuns = []; s.groupMessages = {};
  });
  return store;
}

test('a run records each turn\'s tokens on its trace, its total, and the bot\'s day', async t => {
  const server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify({choices: [{message: {content: 'Done.'}}], usage: {prompt_tokens: 1500, completion_tokens: 40, prompt_tokens_details: {cached_tokens: 1024}}})); });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  Object.assign(process.env, {AI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, AI_API_KEY: 'test-key', AI_MODEL: 'test-model', AI_API_STYLE: 'chat'});
  t.after(() => { for (const k of ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_API_STYLE']) delete process.env[k]; });
  const store = await workspace(t);
  const {runId} = await quietly(() => coordination.queueGroupRun(store, {groupId: 'team', message: 'Look at this'}));
  await until(() => ['completed', 'failed'].includes(store.read().groupRuns.find(r => r.id === runId)?.status));
  const run = store.read().groupRuns.find(r => r.id === runId);
  assert.equal(run.status, 'completed', run.error || '');
  assert.equal(run.usage.calls, 1);
  assert.equal(run.usage.input, 476);
  assert.equal(run.usage.cacheRead, 1024);
  assert.equal(run.usage.output, 40);
  assert.equal(run.usage.unpriced, 1, 'the environment provider has no price, so no money is shown');
  assert.equal(run.trace[0].usage.output, 40);
  const day = Object.values(store.read().usage.days)[0];
  assert.equal(day.scout.calls, 1);
});

test('when the fallback model answered, the trace and the chat say which model did and why', async t => {
  process.env.AI_API_KEY = 'test-key'; process.env.AI_BASE_URL = 'http://127.0.0.1:9/v1';
  t.after(() => { delete process.env.AI_API_KEY; delete process.env.AI_BASE_URL; });
  const store = await workspace(t);
  // Hold the run at queued, then drive it with an executor that reports a fallback call the way src/ai.js does.
  store.trackWork = () => new Promise(() => {});
  const {runId} = await quietly(() => coordination.queueGroupRun(store, {groupId: 'team', message: 'Look at this', chatKey: 'team-chat'}));
  delete store.trackWork;
  const executor = async bot => {
    await noteUsage({input: 10, output: 5, model: 'spare-model', botId: bot.id, fallbackFrom: {model: 'main-model', why: 'rate limited'}});
    return 'Answered by the spare.';
  };
  await coordination.runGroup(store, runId, executor);
  const run = store.read().groupRuns.find(r => r.id === runId);
  assert.equal(run.status, 'completed', run.error || '');
  assert.deepEqual(run.trace[0].fallbacks, [{botId: 'scout', from: 'main-model', why: 'rate limited', to: 'spare-model'}]);
  const all = Object.values(store.read().chats || {}).flatMap(c => Array.isArray(c) ? c : c?.messages || []);
  const line = all.find(m => m.kind === 'fallback');
  assert.ok(line, 'the chat says a fallback answered');
  assert.match(line.text, /Scout's model \(main-model\) couldn't answer \(rate limited\), so the fallback model spare-model answered instead/);
});
