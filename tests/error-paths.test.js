/** Error paths that used to end the server, strand a chat or drop a result.
 *
 * Each test names the failure it pins: a background page whose every write is refused, a page a restart cut, a
 * Keep going that waited out the whole run, a refused write marking a run failed, a result POST lost to one network
 * blip, a provider's one busy answer, a schedule failing in silence, a workspace that will not open, follow-ups
 * cleared in one write and lost in the next, CLI stderr in the chat, blank log lines and a poll that ended quietly.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {EventEmitter} from 'node:events';
import * as agent from '../src/agent.js';
import * as wf from '../shared/workflow.js';
import * as tasks from '../shared/tasks.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {createRun} from '../shared/coordination.js';
import {coordinationState, markInterrupted, resumeGroupRun, runGroup, SERVER_PAGE_RESTARTED} from '../src/coordination.js';
import {dispatchBrowserRequest} from '../src/bot-browser.js';
import {BROWSER_PERMISSION} from '../shared/bot-browser.js';
import {guardRejections} from '../src/crash-guard.js';
import {reportResult} from '../agent/report-result.mjs';
import {retryWaitMs, executeCustomBot} from '../src/ai.js';
import {createQueue} from '../src/queue.js';
import {scheduleRows} from '../shared/schedules.js';
import {openWorkspaces, workspaceDbPath} from '../src/workspaces.js';
import {startFollowUps} from '../src/follow-ups.js';
import {createApp} from '../src/app.js';
import {pollRun} from '../shared/run-follow.js';
import {isOfflineError, OFFLINE_TEXT} from '../shared/ui-model.js';
import {feed} from '../shared/ui-feed.js';
import {company, model, ask} from './run-fixture.js';
import {installWebLocks} from './web-locks.js';

installWebLocks();

async function harness(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'error-paths-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  t.after(async () => { await store.close().catch(() => {}); await fs.rm(dir, {recursive: true, force: true}); });
  return {dir, store};
}
const browserBot = {id: 'web', name: 'Web', instructions: 'Look things up.', type: 'custom', permissions: [BROWSER_PERMISSION], settings: {}};
const page = (id, extra = {}) => {
  const now = new Date().toISOString();
  return {id, botId: 'web', botName: 'Web', groupId: 'lab', chatKey: 'web', url: 'https://example.com/docs', steps: [], kind: 'browser.capture', depth: 0, status: 'pending', agentTaskIds: [], result: null, error: null, createdAt: now, updatedAt: now, ...extra};
};
const until = async (check, note) => {
  for (let i = 0; i < 200; i++) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`timed out waiting for ${note}`);
};
/** Collect console.error lines for the length of `fn`. */
async function errorsDuring(fn) {
  const lines = [], original = console.error;
  console.error = (...args) => { lines.push(args.map(a => (a instanceof Error ? a.stack : String(a))).join(' ')); };
  try { await fn(); } finally { console.error = original; }
  return lines;
}

test('#1 a page on this server whose every write is refused is logged, never an unhandled rejection', async t => {
  const {store} = await harness(t);
  await store.update(s => {
    wf.migrate(s); coordinationState(s);
    s.groups = [{id: 'lab', name: 'Lab', bots: [browserBot]}];
    s.grants = [{botId: 'web', action: 'browser.use', scope: 'https://example.com', choice: 'always', at: new Date().toISOString()}];
    s.browserRequests = [page('here')];
  });
  const unhandled = [];
  const onRejection = reason => unhandled.push(reason);
  process.on('unhandledRejection', onRejection);
  t.after(() => process.off('unhandledRejection', onRejection));
  let release;
  const ran = new Promise(resolve => { release = resolve; });
  const runtime = {mode: 'auto', available: () => true, close: async () => {}, run: async () => { await ran; throw new Error('The page did not load.'); }};
  const lines = await errorsDuring(async () => {
    await dispatchBrowserRequest(store, 'here', {runtime});
    // From here on the store refuses every write, so both the failure finish and its fallback reject.
    store.update = async () => { throw Object.assign(new Error('This workspace is paused for a restore.'), {status: 503}); };
    release();
    await until(() => unhandled.length || null, 'the rejection').catch(() => {});
  });
  assert.deepEqual(unhandled, [], 'nothing escapes to the process');
  assert.ok(lines.some(line => /paused for a restore/.test(line)), lines.join('\n'));
});

test('#2 an unhandled rejection is logged and the process keeps going', () => {
  const proc = new EventEmitter(), logged = [];
  const stop = guardRejections(proc, (...args) => logged.push(args.join(' ')));
  proc.emit('unhandledRejection', new Error('a background write was refused'));
  assert.equal(logged.length, 1);
  assert.match(logged[0], /keeps running.*a background write was refused/s);
  assert.equal(proc.listenerCount('uncaughtException'), 0, 'a synchronous crash is left to Node');
  stop();
  assert.equal(proc.listenerCount('unhandledRejection'), 0);
});

test('#3 after a restart a page this server was opening is failed and the chat says so', async t => {
  const {store} = await harness(t);
  await store.update(s => {
    wf.migrate(s); coordinationState(s);
    s.groups = [{id: 'lab', name: 'Lab', bots: [browserBot]}];
    s.browserRequests = [page('server-page', {status: 'dispatched', via: 'server'}), page('device-page', {status: 'dispatched', via: 'agent', agentTaskIds: ['t-1']})];
  });
  await markInterrupted(store);
  const [server, device] = store.read().browserRequests;
  assert.equal(server.status, 'failed');
  assert.equal(server.error, SERVER_PAGE_RESTARTED);
  assert.equal(device.status, 'dispatched', 'a device page has its own deadline (expireBrowserTasks)');
  assert.ok(store.read().chats.web.some(m => m.kind === 'browser-result' && m.text === 'The server restarted while opening the page. Ask again.'));
});

const block = (to, task) => '```ask\n' + JSON.stringify({to, task}) + '\n```';

test('#4 Keep going answers at once and the run goes on in the background', async t => {
  const {store, ids} = await company(t);
  await store.update(s => { s.limits = {askCheckpoints: true}; });
  let gate = null;
  const ai = model({Mailroom: (env, n) => (n < 14 ? block('@Scholar', `Question ${n}`) : 'All asked.'), Scholar: (env, n) => `Answer ${n}`});
  const paused = await ask(store, {message: 'Ask a lot', to: ids.mail, executor: ai.executor});
  assert.equal(paused.status, 'awaiting_limit');
  // The next model call hangs until the test lets it go: a POST that awaited the run would hang with it.
  const slow = async (bot, input) => { await new Promise(resolve => { gate = resolve; }); return ai.executor(bot, input); };
  const answered = await Promise.race([resumeGroupRun(store, paused.id, slow, {choice: 'more'}), new Promise(resolve => setTimeout(() => resolve('hung'), 2000))]);
  assert.notEqual(answered, 'hung', 'the request does not wait for the bots');
  assert.equal(answered.runId, paused.id);
  assert.equal(JSON.stringify(answered).includes('done'), false, 'the background promise is not sent to the browser');
  await until(() => gate, 'the run to reach the model');
  const go = gate; gate = null; go();
  // The rest of the run answers straight away.
  const fast = setInterval(() => { if (gate) { const g = gate; gate = null; g(); } }, 5);
  t.after(() => clearInterval(fast));
  await answered.done;
  assert.equal(store.read().groupRuns.find(r => r.id === paused.id).status, 'completed');
});

test('#14 a Keep going whose start is refused extends nothing, however often it is pressed', async t => {
  const {store, ids} = await company(t);
  await store.update(s => { s.limits = {askCheckpoints: true}; });
  const ai = model({Mailroom: (env, n) => (n < 30 ? block('@Scholar', `Question ${n}`) : 'All asked.'), Scholar: (env, n) => `Answer ${n}`});
  const paused = await ask(store, {message: 'Ask a lot', to: ids.mail, executor: ai.executor});
  const before = JSON.stringify(paused.asks);
  store.trackWork = () => Promise.reject(Object.assign(new Error('This workspace is paused for a restore.'), {status: 503}));
  for (let i = 0; i < 3; i++) await assert.rejects(resumeGroupRun(store, paused.id, ai.executor, {choice: 'more'}), error => error.status === 503);
  const live = store.read().groupRuns.find(r => r.id === paused.id);
  assert.equal(live.status, 'awaiting_limit', 'still waiting on the person');
  assert.equal(JSON.stringify(live.asks), before, 'the limits were not extended by the refused presses');
});

test('#9 a refused write marking a run failed is tried once more', async t => {
  const {store} = await company(t);
  const realUpdate = store.update.bind(store);
  let refuseNext = false, refused = 0;
  store.update = fn => {
    if (refuseNext) { refuseNext = false; refused++; return Promise.reject(new Error('database is locked')); }
    return realUpdate(fn);
  };
  const executor = async () => { refuseNext = true; throw new Error('The model broke.'); };
  let id;
  await store.update(s => { const host = s.groups.find(g => g.id === 'home'); const run = createRun({group: host, message: 'Hello', directBotId: 'atlas', chatKey: 'atlas', makeId: () => 'run-fail-write'}); s.groupRuns.unshift(run); id = run.id; });
  const lines = await errorsDuring(() => runGroup(store, id, executor));
  assert.equal(refused, 1);
  const run = store.read().groupRuns.find(r => r.id === id);
  assert.equal(run.status, 'failed', 'the second write landed');
  assert.match(run.error, /The model broke/);
  assert.ok(lines.some(line => /could not be marked failed.*database is locked/.test(line)), lines.join('\n'));
});

test('#5 a result POST lost to the network or a 5xx is sent again; a 4xx is not', async () => {
  const quick = {waits: [0, 0, 0], sleep: async () => {}};
  const flaky = failures => { const sent = []; return {sent, call: async (c, p, body) => { sent.push(body); if (sent.length <= failures.length) throw new Error(failures[sent.length - 1]); return {}; }}; };
  const net = flaky(['fetch failed', 'server responded 503: busy']);
  await reportResult(net.call, {}, {id: 't1', kind: 'model.run', attempts: 1}, {ok: true, text: 'x'}, quick);
  assert.equal(net.sent.length, 3, 'two failures, then it lands');
  const down = flaky(['fetch failed', 'fetch failed', 'fetch failed', 'fetch failed', 'fetch failed']);
  await reportResult(down.call, {}, {id: 't2', kind: 'model.run', attempts: 1}, {ok: true, text: 'x'}, quick);
  assert.equal(down.sent.length, 4, 'one try and three retries, then it gives up');
  const refused = flaky(['server responded 400: bad']);
  await reportResult(refused.call, {}, {id: 't3', kind: 'model.run', attempts: 1}, {ok: true, text: 'x'}, quick);
  assert.equal(refused.sent.length, 1, 'a 4xx is the server deciding');
});

/** A provider that answers each POST from `answers` in turn: [status, body, headers]. */
async function provider(t, answers) {
  const seen = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const [status, body, headers = {}] = answers[Math.min(seen.length, answers.length - 1)];
      seen.push(status);
      res.writeHead(status, {'content-type': 'application/json', ...headers});
      res.end(JSON.stringify(body));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return {seen, config: {style: 'chat', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test-0123456789', model: 'm-1'}};
}
const ok = {choices: [{message: {role: 'assistant', content: 'Fine.'}}]};
const bot = {id: 'b', name: 'B', instructions: 'Help.', type: 'custom'};

test('#8 one busy answer is tried again after Retry-After; a refusal is not', async t => {
  const busy = await provider(t, [[429, {error: {message: 'slow down'}}, {'retry-after': '0'}], [200, ok]]);
  assert.match(String(await executeCustomBot(bot, 'Hi', busy.config)), /Fine/);
  assert.deepEqual(busy.seen, [429, 200]);
  const down = await provider(t, [[503, {error: {message: 'down'}}, {'retry-after': '0'}]]);
  await assert.rejects(executeCustomBot(bot, 'Hi', down.config), /503/);
  assert.deepEqual(down.seen, [503, 503], 'one retry, not a loop');
  const denied = await provider(t, [[401, {error: {message: 'bad key'}}]]);
  await assert.rejects(executeCustomBot(bot, 'Hi', denied.config), /401/);
  assert.deepEqual(denied.seen, [401]);
  assert.equal(retryWaitMs({providerStatus: 503, retryAfter: '3'}), 3000);
  assert.equal(retryWaitMs({providerStatus: 503, retryAfter: '60'}), null, 'longer than a turn waits: reported, not retried');
  assert.equal(retryWaitMs({providerStatus: 429}), 2000, 'no Retry-After: a short default');
  assert.equal(retryWaitMs({timedOut: true}), 2000);
  for (const status of [400, 401, 403]) assert.equal(retryWaitMs({providerStatus: status}), null);
  assert.equal(retryWaitMs({status: 429}), null, "this app's own slot limit already waited");
});

test('#7 a schedule failing window after window tells the owner on the third, and its card shows why', async t => {
  const {store} = await harness(t);
  await store.update(s => { wf.migrate(s); s.tasks = s.tasks || []; });
  const {task} = await store.update(s => tasks.enqueueTask(s, {kind: 'bot-task', title: 'Morning digest', payload: {groupId: 'home', botId: 'atlas', message: 'Sum up my mail', kind: 'interval', intervalMinutes: 60}, intervalMinutes: 60, maxAttempts: 1}));
  const told = [];
  const queue = createQueue(store, {'bot-task': async () => { throw new Error('No AI provider answered.'); }}, {onFail: (t2, error) => { told.push(error.message); }});
  for (let window = 1; window <= 4; window++) {
    // Due now, with this window's retry budget already spent (six hours of tries).
    await store.update(s => { const live = s.tasks.find(x => x.id === task.id); live.runAt = new Date(Date.now() - 1000).toISOString(); live.payload = {...live.payload, [tasks.RETRY_STARTED]: Date.now() - 7 * 3600e3}; });
    await queue.sweep();
    const live = store.read().tasks.find(x => x.id === task.id);
    assert.equal(live.status, 'queued', 'a schedule re-arms');
    assert.equal(live.payload[tasks.MISSED_WINDOWS], window);
  }
  assert.equal(told.length, 1, 'told once, on the third window in a row');
  assert.match(told[0], /No AI provider answered\. It has failed in 3 windows in a row/);
  const [row] = scheduleRows(store.read(), 'atlas');
  assert.equal(row.lastError, 'No AI provider answered.');
  // A run that works clears the streak and the card.
  await store.update(s => { const live = s.tasks.find(x => x.id === task.id); live.status = 'running'; tasks.completeTask(s, task.id, {}); });
  const after = store.read().tasks.find(x => x.id === task.id);
  assert.equal(after.payload[tasks.MISSED_WINDOWS], undefined);
  assert.equal(scheduleRows(store.read(), 'atlas')[0].lastError, null);
});

test('#11 a workspace whose database will not open is skipped and the others start', async t => {
  const {dir, store} = await harness(t);
  store.dbPath = path.join(dir, 'state.db');
  // A directory where the database file should be: opening it fails.
  await fs.mkdir(workspaceDbPath(store.dbPath, 'broken'), {recursive: true});
  const started = [];
  const auth = {workspaceIds: () => ['default', 'broken', 'fine']};
  let workspaces;
  const lines = await errorsDuring(async () => { workspaces = await openWorkspaces(store, auth, (ws, id) => { started.push(id); const stop = async () => {}; stop.ready = Promise.resolve(); return stop; }); });
  t.after(async () => { for (const {id, store: ws} of workspaces.all()) if (id !== 'default') await ws.close().catch(() => {}); });
  assert.deepEqual(started, ['default', 'fine']);
  assert.equal(workspaces.get('broken'), null);
  assert.ok(lines.some(line => /Workspace broken could not be opened/.test(line)), lines.join('\n'));
});

test('#12 follow-ups waiting behind a run are never lost between two writes', async t => {
  const {store} = await company(t);
  const item = text => ({chatKey: 'atlas', groupId: 'home', message: text, directBotId: 'atlas', checkpoints: false});
  await store.update(s => {
    const host = s.groups.find(g => g.id === 'home');
    const run = createRun({group: host, message: 'First', directBotId: 'atlas', chatKey: 'atlas', makeId: () => 'ended'});
    run.status = 'completed'; run.followUps = [item('second'), item('third'), item('fourth')];
    s.groupRuns.unshift(run);
  });
  const realUpdate = store.update.bind(store);
  let queued = 0, refuse = false;
  store.update = fn => (refuse ? (refuse = false, Promise.reject(new Error('database is locked'))) : realUpdate(fn));
  const queue = async (st, spec) => {
    queued++;
    const id = `next-${queued}`;
    await realUpdate(s => { const host = s.groups.find(g => g.id === 'home'); const run = createRun({group: host, message: spec.message, directBotId: 'atlas', chatKey: 'atlas', makeId: () => id}); s.groupRuns.unshift(run); });
    // The write after the queue (attaching the rest) is refused once.
    refuse = true;
    return {runId: id, status: 'queued'};
  };
  const stop = startFollowUps(store, queue, 20);
  t.after(() => stop());
  await until(() => queued >= 1 || null, 'the first follow-up to start');
  await new Promise(resolve => setTimeout(resolve, 60));
  const waiting = store.read().groupRuns.flatMap(r => (r.followUps || []).map(f => f.message));
  assert.deepEqual(waiting, ['third', 'fourth'], 'the rest are still waiting somewhere');
});

test('#13 a CLI failure says what to do; what the CLI printed stays in the detail', async () => {
  const {runCliModel} = await import('../agent/cli-model.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-fail-'));
  try {
    const bin = path.join(dir, 'claude');
    await fs.writeFile(bin, '#!/bin/sh\necho "segfault reading /home/someone/.config/secret-token-abc" >&2\nexit 3\n', {mode: 0o755});
    const error = await runCliModel({engine: 'claude', input: 'hi', env: {...process.env, PATH: `${dir}:${process.env.PATH}`}}).then(() => null, e => e);
    assert.ok(error, 'the run fails');
    assert.equal(error.code, 'cli-failed');
    assert.equal(error.message, 'The claude CLI on this computer failed. Open Settings → Models and keys to check it.');
    assert.match(error.detail, /secret-token-abc/);
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('#15 a 500 is logged with its stack, and a 4xx logs nothing', async () => {
  const recorder = () => ({status: null, body: null, writeHead(status) { this.status = status; return this; }, end(body) { if (body !== undefined) this.body = body; }});
  const make = session => createApp({store: {read: () => ({})}, auth: {session}, workspaces: {get: () => null}, push: {}, version: '1'});
  const res401 = recorder(), res500 = recorder();
  const quiet = await errorsDuring(() => make(() => null).handler({method: 'GET', url: '/api/me', headers: {host: '127.0.0.1:4173'}}, res401));
  assert.equal(res401.status, 401);
  assert.deepEqual(quiet, [], 'no blank line for a client error');
  const loud = await errorsDuring(() => make(() => { throw new Error('session table is gone'); }).handler({method: 'GET', url: '/api/me', headers: {host: '127.0.0.1:4173', cookie: 'agent_session=x'}}, res500));
  assert.equal(res500.status, 500);
  assert.equal(loud.length, 1);
  assert.match(loud[0], /session table is gone\n\s+at /, 'the stack is in the log');
});

test('#16 a poll that runs out of looks with the run still going says so', async () => {
  const stalls = [];
  const last = await pollRun({runId: 'r1', maxPolls: 3, wait: async () => {}, readLog: async () => ({messages: [], runs: [{id: 'r1', status: 'running'}]}), messages: () => [], requests: () => [], onLine: () => {}, onStall: info => stalls.push(info)});
  assert.equal(last.status, 'running');
  assert.deepEqual(stalls, [{exhausted: true}]);
  const done = [];
  await pollRun({runId: 'r1', maxPolls: 3, wait: async () => {}, readLog: async () => ({messages: [], runs: [{id: 'r1', status: 'completed', recipients: [], trace: []}]}), messages: () => [], requests: () => [], onLine: () => {}, onStall: info => done.push(info)});
  assert.deepEqual(done, [], 'a run that ended is not a stall');
});

test('#10 a send that never reached the server says so and offers Retry', () => {
  const timeout = Object.assign(new Error('The server took too long to answer (20 s).'), {timeout: true});
  assert.equal(isOfflineError(timeout), true);
  assert.equal(isOfflineError(new TypeError('Failed to fetch')), true);
  assert.equal(isOfflineError(new TypeError('NetworkError when attempting to fetch resource.')), true);
  assert.equal(isOfflineError(Object.assign(new Error('A group run is already active.'), {status: 409})), false, 'an answer is not offline');
  assert.equal(isOfflineError(new TypeError('x is not a function')), false);
  assert.equal(OFFLINE_TEXT, 'You seem to be offline, so this was not sent.');
  const at = new Date().toISOString();
  const items = [{kind: 'message', message: {id: 'u1', role: 'user', text: 'Book the train', at}}, {kind: 'message', message: {id: 'o1', role: 'system', kind: 'offline', text: OFFLINE_TEXT, at}}];
  const entry = feed({items, state: {groups: [], groupRuns: []}, key: 'atlas'}).find(e => e.kind === 'offline');
  assert.equal(entry.retry, 'Book the train');
  const later = feed({items: [...items, {kind: 'message', message: {id: 'u2', role: 'user', text: 'Never mind', at}}], state: {groups: [], groupRuns: []}, key: 'atlas'}).find(e => e.kind === 'offline');
  assert.equal(later.retry, '', 'once the owner said more, Retry is gone');
});
