/** Regression tests for the queue's recovery paths, each one a defect that made
 * a durable queue behave like a best-effort one:
 *
 * - a cancelled task's idempotency key could never be used again (the store's
 *   unique index refused the duplicate and rolled back every later write);
 * - the retry budget was ~15 seconds, and a recurring task that went terminally
 *   failed never came back;
 * - a failing completion write was mistaken for a handler failure, so the
 *   handler ran a second time (duplicate webhook POST, duplicate group run);
 * - a heartbeat queued behind the failure path renewed a lease that path had
 *   just expired, leaving a stuck task `running` for another full window.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {SqliteStore} from '../src/sqlite-store.js';
import {createQueue} from '../src/queue.js';
import * as tasks from '../shared/tasks.js';
import {RETRY_WINDOW_MS} from '../shared/tasks.js';
import * as wf from '../shared/workflow.js';

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-queue-recovery-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  await store.update(s => { wf.migrate(s); wf.recoverInterrupted(s); });
  return {dir, store};
}

/** Write a task row directly, for kinds the API whitelist does not know. */
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

/** The payload key `shared/tasks.js` uses for the retry window's start; it is
 * written by the transitions, not by callers. Spelled out here so a test can
 * age a retry session without waiting six hours. */
const ageRetryWindow = (state, id) => {
  state.tasks.find(t => t.id === id).payload.retryStartedAt = Date.now() - RETRY_WINDOW_MS - 1000;
};

test('a cancelled idempotency key can be enqueued again without breaking the store', async () => {
  const {store, dir} = await harness();
  const spec = {kind: 'candidate-draft', payload: {candidateId: 'c1', direction: ''}, title: 'Draft for c1', idempotencyKey: 'webhook:7'};
  const first = await store.update(s => tasks.enqueueTask(s, spec));
  await store.update(s => tasks.cancelTask(s, first.task.id));
  // Before the fix this inserted a second row with the same key, the unique
  // index refused it, the whole document write rolled back, and every retry of
  // the same submission failed the same way.
  const again = await store.update(s => tasks.enqueueTask(s, spec));
  assert.equal(again.duplicate, false);
  assert.equal(again.task.id, first.task.id, 'the cancelled row already owns the key, so it is the row that is reused');
  const keyed = store.read().tasks.filter(t => t.idempotencyKey === 'webhook:7');
  assert.equal(keyed.length, 1, 'one row per key, cancelled or not');
  assert.equal(keyed[0].status, 'queued');
  // And the work actually runs again, which is what the caller asked for.
  const calls = [];
  const queue = createQueue(store, {'candidate-draft': async task => { calls.push(task.id); return {drafted: true}; }}, {intervalMs: 60000});
  await queue.sweep();
  assert.deepEqual(calls, [first.task.id]);
  const after = store.read().tasks[0];
  assert.equal(after.status, 'done');
  assert.deepEqual(after.result, {drafted: true});
  await fs.rm(dir, {recursive: true, force: true});
});

test('a cancelled schedule is not resurrected by re-running the legacy migration', async () => {
  const {store, dir} = await harness();
  const schedule = {id: 's1', label: 'Check the feed', kind: 'interval', intervalMinutes: 60, enabled: true};
  await store.update(s => { s.schedules = [schedule]; tasks.migrateSchedules(s); });
  const migrated = store.read().tasks.find(t => t.idempotencyKey === 'schedule:s1');
  assert.ok(migrated, 'the legacy row becomes a task');
  await store.update(s => tasks.cancelTask(s, migrated.id));
  // A restored legacy JSON can replay the same schedule row. The cancelled
  // task still holds the key, so the migration leaves it cancelled instead of
  // creating a second row (which the unique index would refuse) or reviving it.
  await store.update(s => { s.schedules = [schedule]; tasks.migrateSchedules(s); });
  const rows = store.read().tasks.filter(t => t.idempotencyKey === 'schedule:s1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'cancelled');
  await fs.rm(dir, {recursive: true, force: true});
});

test('a transient failure keeps retrying past the attempt cap while the retry window is open', async () => {
  const {store, dir} = await harness();
  let failures = 0;
  const queue = createQueue(store, {notify: async () => { failures++; throw new Error('Webhook responded 502.'); }}, {intervalMs: 60000});
  const task = await store.update(s => rawTask(s, {kind: 'notify', title: 'Deliver', maxAttempts: 1}));
  // One attempt was the whole budget before the fix: fifteen seconds of backoff
  // and a webhook outage longer than that ended the task for good.
  for (let attempt = 1; attempt <= 4; attempt++) {
    await store.update(s => { s.tasks.find(t => t.id === task.id).runAt = new Date(Date.now() - 1000).toISOString(); });
    await queue.sweep();
    const after = store.read().tasks.find(t => t.id === task.id);
    assert.equal(after.status, 'queued', `attempt ${attempt} is inside the window, so it retries`);
    assert.equal(after.attempts, attempt);
    assert.equal(after.lastError, 'Webhook responded 502.');
    assert.ok(Date.parse(after.runAt) > Date.now(), 'and backoff still spaces the attempts out');
  }
  assert.equal(failures, 4);
  const lastDelay = Date.parse(store.read().tasks.find(t => t.id === task.id).runAt) - Date.now();
  assert.ok(lastDelay <= 5 * 60000 + 1000, 'the ladder is capped at five minutes, not the retrying');
  // Once the window is spent, the failure is terminal and announced.
  await store.update(s => { ageRetryWindow(s, task.id); s.tasks.find(t => t.id === task.id).runAt = new Date(Date.now() - 1000).toISOString(); });
  await queue.sweep();
  const dead = store.read().tasks.find(t => t.id === task.id);
  assert.equal(dead.status, 'failed');
  assert.equal(dead.lastError, 'Webhook responded 502.');
  assert.ok(store.read().events.some(e => e.type === 'task-error'), 'a spent budget is reported, not hidden');
  await fs.rm(dir, {recursive: true, force: true});
});

test('a recurring schedule survives an outage longer than the retry window', async () => {
  const {store, dir} = await harness();
  let down = true;
  const queue = createQueue(store, {'bot-task': async () => { if (down) throw new Error('SMTP relay greylisted.'); return {ran: true}; }}, {intervalMs: 60000});
  const task = await store.update(s => rawTask(s, {
    kind: 'bot-task', title: 'Hourly digest', payload: {message: 'digest'}, intervalMinutes: 60, maxAttempts: 1,
    runAt: new Date(Date.now() - 1000).toISOString(),
  }));
  await store.update(s => ageRetryWindow(s, task.id));
  await queue.sweep();
  let after = store.read().tasks.find(t => t.id === task.id);
  assert.equal(after.status, 'queued', 'the schedule re-arms instead of ending');
  assert.equal(after.attempts, 0, 'the next window gets a fresh budget');
  assert.equal(after.lastError, 'SMTP relay greylisted.', 'the error stays visible until a run succeeds');
  assert.ok(Date.parse(after.runAt) > Date.now() + 59 * 60000, 'and it fires at its next hourly window');
  assert.equal(store.read().events.some(e => e.type === 'task-error'), false, 'a missed window is not a permanent failure');
  // The next window runs the same task, and a success clears the error.
  down = false;
  await store.update(s => { s.tasks.find(t => t.id === task.id).runAt = new Date(Date.now() - 1000).toISOString(); });
  await queue.sweep();
  after = store.read().tasks.find(t => t.id === task.id);
  assert.equal(after.status, 'queued');
  assert.equal(after.lastError, null);
  assert.ok(Date.parse(after.runAt) > Date.now() + 59 * 60000);
  await fs.rm(dir, {recursive: true, force: true});
});

test('a permanent miss on a recurring task still ends it: a deleted group is not an outage', async () => {
  const {store, dir} = await harness();
  const queue = createQueue(store, {
    'bot-task': async () => { throw Object.assign(new Error('That bot or group no longer exists.'), {status: 404, permanent: true}); },
  }, {intervalMs: 60000});
  const task = await store.update(s => rawTask(s, {kind: 'bot-task', title: 'Gone', payload: {message: 'x'}, intervalMinutes: 30}));
  await queue.sweep();
  const after = store.read().tasks.find(t => t.id === task.id);
  assert.equal(after.status, 'failed');
  assert.match(after.lastError, /no longer exists/);
  await fs.rm(dir, {recursive: true, force: true});
});

test('a completion write that fails is recorded later, and the handler runs exactly once', async () => {
  const {store, dir} = await harness();
  const task = await store.update(s => rawTask(s, {kind: 'webhook', title: 'POST once'}));
  let calls = 0;
  let failNextWrite = false;
  const realUpdate = store.update.bind(store);
  store.update = async fn => {
    if (failNextWrite) { failNextWrite = false; throw new Error('database is locked'); }
    return realUpdate(fn);
  };
  const lines = [];
  const realError = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    const queue = createQueue(store, {webhook: async () => { calls++; failNextWrite = true; return {posted: 1}; }}, {intervalMs: 60000});
    await queue.sweep();
    assert.equal(calls, 1);
    let after = store.read().tasks.find(t => t.id === task.id);
    assert.equal(after.status, 'running', 'the outcome is known but not recorded yet');
    assert.equal(after.attempts, 1, 'a failed completion write is not a handler failure, so nothing was retried');
    assert.ok(Date.parse(after.leaseUntil) <= Date.now(), 'and the lease is expired so the next sweep can claim the task');
    assert.equal(store.read().events.some(e => e.type === 'task-retry' || e.type === 'task-error'), false, 'no failure was recorded for work that succeeded');
    assert.match(lines.join('\n'), /could not record completion/);
    // The next sweep claims the task again, sees the stored result, and writes
    // it — without calling the handler a second time.
    await queue.sweep();
    assert.equal(calls, 1, 'the handler must not run twice for one execution');
    after = store.read().tasks.find(t => t.id === task.id);
    assert.equal(after.status, 'done');
    assert.deepEqual(after.result, {posted: 1});
  } finally {
    console.error = realError;
    store.update = realUpdate;
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('a task whose failure could not be recorded is not renewed back into a full window', async () => {
  const {store, dir} = await harness();
  const leaseMs = 1500; // one heartbeat every 1000ms
  const task = await store.update(s => rawTask(s, {kind: 'slow', title: 'Stuck', maxAttempts: 5}));
  const realUpdate = store.update.bind(store);
  let failing = false;
  let held = false;
  store.update = async fn => {
    if (!failing) return realUpdate(fn);
    // Classify the transition on a throwaway copy: the failure write re-queues
    // the task, the lease expiry after it leaves the task `running` with an
    // epoch lease.
    const probe = structuredClone(store.read());
    await fn(probe);
    if (probe.tasks.find(t => t.id === task.id).status === 'queued') throw new Error('database is locked');
    if (held) return realUpdate(fn);
    held = true;
    // Hold the lease-expiry write open so the heartbeat that is due during it
    // lands after it — the race this test exists for. With the fix there is no
    // heartbeat left to land, because the task left `live` before the failure
    // path ran.
    const write = realUpdate(fn);
    await new Promise(resolve => setTimeout(resolve, leaseMs + 800));
    return write;
  };
  const lines = [];
  const realError = console.error;
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    const queue = createQueue(store, {slow: async () => { failing = true; throw new Error('Provider 500.'); }}, {intervalMs: 60000, leaseMs});
    await queue.sweep();
    // Let any write the heartbeat managed to start finish before looking.
    await new Promise(resolve => setTimeout(resolve, 300));
    const after = store.read().tasks.find(t => t.id === task.id);
    assert.equal(after.status, 'running', 'the failure was never recorded');
    assert.ok(Date.parse(after.leaseUntil || 0) <= Date.now(), 'and the expired lease was not renewed into another full window');
    assert.match(lines.join('\n'), /could not record task failure/);
  } finally {
    console.error = realError;
    store.update = realUpdate;
    await fs.rm(dir, {recursive: true, force: true});
  }
});
