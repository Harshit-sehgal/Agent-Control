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
  await store.update(s => { wf.migrate(s); wf.recoverInterrupted(s); });
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
  const doomed = await store.update(s => rawTask(s, {kind: 'flaky', title: 'Doomed', runAt: new Date(Date.now() - 1000).toISOString(), maxAttempts: 1}));
  await store.update(s => { s.tasks.find(t => t.id === doomed.id).runAt = new Date(Date.now() - 1000).toISOString(); });
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
  const first = await store.update(s => tasks.enqueueTask(s, {kind: 'candidate-draft', payload: {candidateId: 'c1', direction: ''}, title: 'Once', idempotencyKey: 'click:42'}));
  const second = await store.update(s => tasks.enqueueTask(s, {kind: 'candidate-draft', payload: {candidateId: 'c1', direction: ''}, title: 'Once', idempotencyKey: 'click:42'}));
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

test('reminder tasks fire as activity events, mirroring the old scheduler behavior', async () => {
  const {store, dir} = await harness();
  const queue = createQueue(store, {...(await import('../src/queue.js')).defaultHandlers(store)}, {intervalMs: 60000});
  await store.update(s => tasks.enqueueTask(s, {kind: 'reminder', payload: {label: 'Check the queue', kind: 'interval', intervalMinutes: 30}, title: 'Check the queue'}));
  await queue.sweep();
  const state = store.read();
  const task = state.tasks[0];
  assert.equal(task.status, 'queued', 'An interval reminder re-arms.');
  assert.ok(Date.parse(task.runAt) > Date.now() + 29 * 60000);
  assert.ok(state.events.some(e => e.type === 'reminder' && e.message === 'Check the queue'));
  await fs.rm(dir, {recursive: true, force: true});
});
