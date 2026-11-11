import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPayload, retryDelay, enqueueTask, completeTask, failTask, claimTasks} from '../shared/tasks.js';
import {initialState} from '../shared/core.js';

test('a task kind rejects requests missing the field it actually needs', () => {
  // Object defaults (`params: {}`) used to satisfy the old "some value" check,
  // so a job with no action reached the worker and burned its retries.
  assert.throws(() => buildPayload('agent-job', {params: {}}), /action/i);
  assert.throws(() => buildPayload('group-run', {groupId: 'g1'}), /group and a message/i);
  assert.equal(buildPayload('agent-job', {action: 'http.check', params: {url: 'https://x'}}).action, 'http.check');
  assert.equal(buildPayload('bot-task', {groupId: 'g1', message: 'Check', kind: 'interval', intervalMinutes: 30}).intervalMinutes, 30);
});

test('retry backoff is 1s, 2s, 4s for the first three failures', () => {
  const base = 1_000_000;
  // `attempt` is the count after claiming (1 on the first run).
  assert.equal(retryDelay(1, base) - base, 1000);
  assert.equal(retryDelay(2, base) - base, 2000);
  assert.equal(retryDelay(3, base) - base, 4000);
  // Capped at five minutes.
  assert.equal(retryDelay(30, base) - base, 300000);
});

test('completing or failing a cancelled task does not requeue it', () => {
  const state = initialState();
  state.tasks = [];
  const task = enqueueTask(state, {kind: 'bot-task', payload: {groupId: 'home', botId: 'atlas', message: 'hi', kind: 'interval', intervalMinutes: 30}}).task;
  task.status = 'cancelled';
  const runAt = task.runAt;
  assert.equal(completeTask(state, task.id, {ok: true}).status, 'cancelled');
  assert.equal(failTask(state, task.id, 'A group run is already active.').status, 'cancelled');
  assert.equal(task.status, 'cancelled');
  assert.equal(task.runAt, runAt);
});

test('an inherited object key is not a task kind', () => {
  // `PAYLOAD_KINDS[kind]` on a prototype key returned a function, so validation
  // was skipped and the row reached the floor, where `Object` "completed" it.
  for (const kind of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
    assert.throws(() => buildPayload(kind, {message: 'x'}), error => error.status === 400 && /Unknown task kind/.test(error.message), kind);
  }
});

test('an explicit lease window is the one that gets stored', () => {
  const one = () => {
    const state = {tasks: [], events: []};
    enqueueTask(state, {kind: 'group-run', payload: {groupId: 'g', message: 'm'}, runAt: new Date().toISOString()});
    return state;
  };
  // The rows have to exist before the clock is read: a task whose `runAt` is one
  // millisecond in the future is not due, so a `now` captured first made this test
  // fail about one run in three.
  const asked = one(), quiet = one();
  const now = Date.now();
  // The old default (`leaseTTL = 60000`) then overwrote the caller's 1500 ms with
  // the defaulted `leaseMs`: one wrong 60 s window before the heartbeat fixed it.
  claimTasks(asked, {workerId: 'w', now, leaseTTL: 1500});
  assert.equal(Date.parse(asked.tasks[0].leaseUntil) - now, 1500);
  // Asked for nothing at all, the lease is the documented minute.
  claimTasks(quiet, {workerId: 'w', now});
  assert.equal(quiet.tasks[0].leaseUntil, new Date(now + 60000).toISOString());
});
