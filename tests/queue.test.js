import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {SqliteStore} from '../src/sqlite-store.js';
import {createQueue, recoverQueue} from '../src/queue.js';
import * as tasks from '../shared/tasks.js';
import * as wf from '../shared/workflow.js';

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-queue-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  await store.update(s => { wf.migrate(s); });
  return {dir, store};
}
/** Insert a task record directly. The kind whitelist in `buildPayload` is an
 * API safety boundary, so tests that exercise worker behavior with synthetic
 * kinds write the row the way the database would, not through the API. */
function rawTask(state, {kind, title = kind, payload = {}, runAt = new Date().toISOString(), idempotencyKey = null, intervalMinutes = null, status = 'queued', maxAttempts = 5} = {}) {
  const task = {
    id: crypto.randomUUID(), kind, title, payload,
    status, runAt, intervalMinutes, idempotencyKey,
    attempts: 0, maxAttempts, leaseOwner: null, leaseUntil: null, lastError: null, result: null,
    createdBy: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
  };
  state.tasks.unshift(task);
  return task;
}

test('the queue executes a due task exactly once and records completion', async () => {
  const {store, dir} = await harness();
  const calls = [];
  const queue = createQueue(store, {echo: async task => { calls.push(task.id); return {ok: true}; }}, {intervalMs: 60000});
  const task = await store.update(s => rawTask(s, {kind: 'echo', title: 'Echo', payload: {msg: 'hi'}}));
  await queue.sweep();
  assert.deepEqual(calls, [task.id]);
  const after = store.read().tasks[0];
  assert.equal(after.status, 'done');
  assert.deepEqual(after.result, {ok: true});
  assert.equal(after.leaseOwner, null);
  // A completed task is not re-run by the next sweep.
  await queue.sweep();
  assert.deepEqual(calls, [task.id]);
  await fs.rm(dir, {recursive: true, force: true});
});

test('a failing handler retries with backoff, then fails loudly after the attempt budget', async () => {
  const {store, dir} = await harness();
  let fail = true;
  const queue = createQueue(store, {flaky: async () => { if (fail) throw new Error('provider 500'); return {ok: true }; }}, {intervalMs: 60000});
  const task = await store.update(s => rawTask(s, {kind: 'flaky', title: 'Flaky', maxAttempts: 2}));
  await queue.sweep();
  let after = store.read().tasks[0];
  assert.equal(after.status, 'queued', 'A retryable failure re-queues the task.');
  assert.equal(after.attempts, 1);
  assert.equal(after.lastError, 'provider 500');
  assert.ok(Date.parse(after.runAt) > Date.now(), 'The retry must be in the future (backoff).');
  // The backoff window has not elapsed, so nothing runs yet.
  await queue.sweep();
  assert.equal(store.read().tasks[0].attempts, 1);
  // Force the backoff window open and let it succeed on the second attempt.
  await store.update(s => { s.tasks[0].runAt = new Date(Date.now() - 1000).toISOString(); });
  fail = false;
  await queue.sweep();
  after = store.read().tasks[0];
  assert.equal(after.status, 'done');
  assert.equal(after.attempts, 2);
  assert.equal(after.lastError, null);
  // Now the same handler failing repeatedly exhausts the budget and reports it.
  // Both budgets: the attempt cap is spent on the first attempt, and the retry
  // window has to be spent too, or a single failure inside six hours retries.
  const doomed = await store.update(s => rawTask(s, {kind: 'flaky', title: 'Doomed', runAt: new Date(Date.now() - 1000).toISOString(), maxAttempts: 1}));
  await store.update(s => {
    const t = s.tasks.find(x => x.id === doomed.id);
    t.runAt = new Date(Date.now() - 1000).toISOString();
    t.payload.retryStartedAt = Date.now() - tasks.RETRY_WINDOW_MS - 1000;
  });
  fail = true;
  await queue.sweep();
  after = store.read().tasks.find(t => t.id === doomed.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.lastError, 'provider 500');
  assert.ok(store.read().events.some(e => e.type === 'task-error'));
  // A failed task can be requeued by hand.
  await store.update(s => tasks.retryTask(s, doomed.id));
  assert.equal(store.read().tasks.find(t => t.id === doomed.id).status, 'queued');
  await fs.rm(dir, {recursive: true, force: true});
});

test('an unknown task kind fails explicitly instead of being marked done', async () => {
  const {store, dir} = await harness();
  const queue = createQueue(store, {}, {intervalMs: 60000});
  const task = await store.update(s => rawTask(s, {kind: 'mystery', title: 'Mystery', payload: {action: 'x'}}));
  await queue.sweep();
  const after = store.read().tasks[0];
  assert.equal(after.status, 'queued', 'It retries like any other failure.');
  assert.match(after.lastError, /No handler is registered for task kind "mystery"/);
  await fs.rm(dir, {recursive: true, force: true});
});

test('an idempotency key collapses duplicate submissions into one task', async () => {
  const {store, dir} = await harness();
  const spec = {kind: 'group-run', payload: {groupId: 'home', message: 'Coordinate.'}, title: 'Once', idempotencyKey: 'click:42'};
  const first = await store.update(s => tasks.enqueueTask(s, spec));
  const second = await store.update(s => tasks.enqueueTask(s, spec));
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.task.id, first.task.id);
  assert.equal(store.read().tasks.length, 1);
  await fs.rm(dir, {recursive: true, force: true});
});

test('a task whose worker died is re-armed, never stuck; a recurring task re-arms itself', async () => {
  const {store, dir} = await harness();
  const queue = createQueue(store, {}, {intervalMs: 60000});
  // A stale lease = the process that owned it died mid-execution.
  await store.update(s => {
    rawTask(s, {kind: 'ghost', title: 'Ghost'});
    const t = s.tasks[0];
    t.status = 'running';
    t.attempts = 1;
    t.leaseOwner = 'worker-dead';
    t.leaseUntil = new Date(Date.now() - 5000).toISOString();
  });
  const recovered = await recoverQueue(store);
  assert.equal(recovered, 1);
  let after = store.read().tasks[0];
  assert.equal(after.status, 'queued');
  assert.match(after.lastError, /Re-armed automatically/);
  // A live lease is respected: recovery must not touch it.
  await store.update(s => {
    rawTask(s, {kind: 'alive', title: 'Alive'});
    const t = s.tasks[0];
    t.status = 'running';
    t.leaseOwner = 'worker-live';
    t.leaseUntil = new Date(Date.now() + 60000).toISOString();
  });
  assert.equal(await recoverQueue(store), 0);
  assert.equal(store.read().tasks.find(t => t.title === 'Alive').status, 'running');
  // A recurring task schedules its next window on completion instead of ending.
  const recurring = await store.update(s => rawTask(s, {kind: 'echo', title: 'Recurring', intervalMinutes: 5, runAt: new Date(Date.now() - 1000).toISOString()}));
  const queue2 = createQueue(store, {echo: async () => ({ok: true})}, {intervalMs: 60000});
  await queue2.sweep();
  after = store.read().tasks.find(t => t.title === 'Recurring');
  assert.equal(after.status, 'queued', 'The recurring window is re-armed.');
  assert.equal(after.attempts, 0, 'The attempt budget resets for the next window.');
  assert.ok(Date.parse(after.runAt) > Date.now() + 4 * 60000);
  // The still-leased task was never touched by the worker.
  assert.equal(store.read().tasks.find(t => t.title === 'Alive').status, 'running');
  await fs.rm(dir, {recursive: true, force: true});
});

test('a claimed batch keeps every lease alive while an earlier task runs', async () => {
  const {store, dir} = await harness();
  const calls = [];
  let openGate;
  const gate = new Promise(resolve => { openGate = resolve; });
  const leaseMs = 1500;
  // Handlers run serially. Only the first blocks, so a second worker that
  // wrongly re-claims a task records the duplicate instead of deadlocking.
  const handler = async task => { calls.push(task.id); if (calls.length === 1) await gate; };
  const a = createQueue(store, {slow: handler}, {intervalMs: 60000, workerId: 'worker-a', leaseMs, batch: 2});
  const b = createQueue(store, {slow: handler}, {intervalMs: 60000, workerId: 'worker-b', leaseMs, batch: 2});
  const first = await store.update(s => rawTask(s, {kind: 'slow', title: 'first'}));
  const second = await store.update(s => rawTask(s, {kind: 'slow', title: 'second'}));
  const running = a.sweep();
  // Wait past the original lease window while the first task still runs. Every
  // claim in the batch must have been renewed by then, or the waiting second
  // task looks stalled and gets executed twice.
  await new Promise(resolve => setTimeout(resolve, leaseMs + 400));
  await b.sweep();
  assert.equal(calls.length, 1, 'the waiting task must not be re-claimed by another worker');
  openGate();
  await running;
  assert.deepEqual([...calls].sort(), [first.id, second.id].sort(), 'each task ran exactly once');
  for (const task of store.read().tasks) assert.equal(task.status, 'done');
  await fs.rm(dir, {recursive: true, force: true});
});

test('a failed lease renewal is logged instead of silently swallowed', async () => {
  const {store, dir} = await harness();
  const realUpdate = store.update.bind(store);
  let renewalFails = false;
  store.update = fn => (renewalFails ? Promise.reject(new Error('database is locked')) : realUpdate(fn));
  const lines = [];
  const realError = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    // Two beats fit inside the handler, so the rate limit is exercised too.
    const queue = createQueue(store, {slow: async () => {
      renewalFails = true;
      await new Promise(resolve => setTimeout(resolve, 2400));
      renewalFails = false;
      return {ok: true};
    }}, {intervalMs: 60000, leaseMs: 3000});
    const task = await store.update(s => rawTask(s, {kind: 'slow', title: 'slow'}));
    await queue.sweep();
    assert.equal(store.read().tasks[0].status, 'done', 'the task still completes once the write path recovers');
    const warnings = lines.filter(line => /lease renewal failed/.test(line));
    assert.equal(warnings.length, 1, `one warning per minute, not one per beat: ${JSON.stringify(lines)}`);
    assert.match(warnings[0], new RegExp(task.id), 'the warning names the task');
    assert.match(warnings[0], /3000ms/, 'and the lease length');
    assert.match(warnings[0], /database is locked/, 'and why the renewal failed');
  } finally { console.error = realError; await fs.rm(dir, {recursive: true, force: true}); }
});

test('duplicate work delivery: two workers claiming at once get one task each', async () => {
  const {store, dir} = await harness();
  await store.update(s => { rawTask(s, {kind: 'echo', title: 'A'}); rawTask(s, {kind: 'echo', title: 'B'}); });
  const a = await store.update(s => tasks.claimTasks(s, {workerId: 'w1', now: Date.now(), limit: 1}));
  const b = await store.update(s => tasks.claimTasks(s, {workerId: 'w2', now: Date.now(), limit: 1}));
  assert.equal(a.length, 1);
  assert.equal(b.length, 1);
  assert.notEqual(a[0].id, b[0].id, 'Each worker claims different work; no double delivery.');
  const third = await store.update(s => tasks.claimTasks(s, {workerId: 'w3', now: Date.now(), limit: 5}));
  assert.equal(third.length, 0, 'Nothing is left to claim while both are leased.');
  await fs.rm(dir, {recursive: true, force: true});
});

test('a sweep runs a task whose lease expired and does not write for a live lease', async () => {
  const {store, dir} = await harness();
  const calls = [];
  const queue = createQueue(store, {echo: async task => { calls.push(task.title); return {ok: true}; }}, {intervalMs: 60000});
  await store.update(s => {
    const t = rawTask(s, {kind: 'echo', title: 'Expired'});
    t.status = 'running';
    t.attempts = 1;
    t.leaseOwner = 'worker-dead';
    t.leaseUntil = new Date(Date.now() - 1000).toISOString();
  });
  await queue.sweep();
  assert.deepEqual(calls, ['Expired']);
  assert.equal(store.read().tasks.find(t => t.title === 'Expired').status, 'done');

  await store.update(s => {
    const live = rawTask(s, {kind: 'echo', title: 'Live'});
    live.status = 'running';
    live.leaseOwner = 'worker-live';
    live.leaseUntil = new Date(Date.now() + 60000).toISOString();
    rawTask(s, {kind: 'echo', title: 'Future', runAt: new Date(Date.now() + 3_600_000).toISOString()});
  });
  let writes = 0;
  const update = store.update.bind(store);
  store.update = async fn => { writes += 1; return update(fn); };
  await queue.sweep();
  assert.equal(writes, 0, 'An idle sweep must not rewrite the database.');
  assert.deepEqual(calls, ['Expired']);
  assert.equal(store.read().tasks.find(t => t.title === 'Live').status, 'running');
  assert.equal(store.read().tasks.find(t => t.title === 'Future').status, 'queued');
  await fs.rm(dir, {recursive: true, force: true});
});

test('a busy 409 keeps retrying with backoff after the attempt budget', async () => {
  const {store, dir} = await harness();
  const notices = [];
  const queue = createQueue(store, {
    busy: async () => { throw Object.assign(new Error('A group run is already active.'), {status: 409}); },
  }, {intervalMs: 60000, onFail: (_task, error) => { notices.push(error.message); }});
  const task = await store.update(s => rawTask(s, {kind: 'busy', title: 'Busy', maxAttempts: 1}));
  await queue.sweep();
  let after = store.read().tasks.find(t => t.id === task.id);
  assert.equal(after.status, 'queued');
  assert.equal(after.attempts, 1);
  assert.equal(after.lastError, 'A group run is already active.');
  assert.ok(Date.parse(after.runAt) > Date.now(), 'The conflict waits on backoff.');
  assert.equal(notices.length, 0, 'A busy conflict is not announced as a terminal failure.');
  await queue.sweep();
  assert.equal(store.read().tasks.find(t => t.id === task.id).attempts, 1);
  await store.update(s => { s.tasks.find(t => t.id === task.id).runAt = new Date(Date.now() - 1000).toISOString(); });
  await queue.sweep();
  after = store.read().tasks.find(t => t.id === task.id);
  assert.equal(after.status, 'queued');
  assert.equal(after.attempts, 2);
  assert.ok(Date.parse(after.runAt) > Date.now());
  assert.equal(notices.length, 0);
  // A different 409 is permanent once both budgets (attempts and the wall-clock
  // retry window) are spent.
  await store.update(s => { s.tasks.find(t => t.id === task.id).runAt = new Date(Date.now() + 3_600_000).toISOString(); });
  const other = await store.update(s => rawTask(s, {kind: 'busy', title: 'Off', maxAttempts: 1, runAt: new Date(Date.now() - 1000).toISOString()}));
  await store.update(s => { s.tasks.find(t => t.id === other.id).payload.retryStartedAt = Date.now() - tasks.RETRY_WINDOW_MS - 1000; });
  const queue2 = createQueue(store, {
    busy: async () => { throw Object.assign(new Error('No bot in this group is switched on.'), {status: 409}); },
  }, {intervalMs: 60000, onFail: (_task, error) => { notices.push(error.message); }});
  await queue2.sweep();
  const off = store.read().tasks.find(t => t.id === other.id);
  assert.equal(off.status, 'failed');
  assert.equal(notices.length, 1);
  await fs.rm(dir, {recursive: true, force: true});
});

test('a permanent miss fails on the first attempt instead of re-arming', async () => {
  const {store, dir} = await harness();
  const queue = createQueue(store, {
    gone: async () => { throw Object.assign(new Error('That bot or group no longer exists.'), {status: 404, permanent: true}); },
  }, {intervalMs: 60000});
  const task = await store.update(s => rawTask(s, {kind: 'gone', title: 'Gone', maxAttempts: 5, intervalMinutes: 30}));
  await queue.sweep();
  const after = store.read().tasks.find(t => t.id === task.id);
  assert.equal(after.status, 'failed');
  assert.equal(after.attempts, 1);
  assert.match(after.lastError, /no longer exists/);
  await fs.rm(dir, {recursive: true, force: true});
});
