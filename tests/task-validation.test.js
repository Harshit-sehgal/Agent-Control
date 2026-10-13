import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPayload, retryDelay, migrateSchedules} from '../shared/tasks.js';
import {initialState} from '../shared/core.js';

test('a task kind rejects requests missing the field it actually needs', () => {
  // Object defaults (`params: {}`) used to satisfy the old "some value" check,
  // so a job with no action reached the worker and burned its retries.
  assert.throws(() => buildPayload('agent-job', {params: {}}), /action/i);
  assert.throws(() => buildPayload('candidate-draft', {}), /candidate/i);
  assert.throws(() => buildPayload('group-run', {groupId: 'g1'}), /group and a message/i);
  assert.equal(buildPayload('agent-job', {action: 'http.check', params: {url: 'https://x'}}).action, 'http.check');
  assert.equal(buildPayload('candidate-draft', {candidateId: 'c1'}).candidateId, 'c1');
  assert.equal(buildPayload('reminder', {kind: 'interval', label: 'L', intervalMinutes: 30}).label, 'L');
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

test('migrating schedules counts only the reminders it actually creates', () => {
  const state = initialState();
  state.schedules = [{id: 's1', label: 'Check', kind: 'interval', intervalMinutes: 60, enabled: true}];
  assert.deepEqual(migrateSchedules(state), {migrated: 1});
  assert.equal(state.tasks.filter(t => t.idempotencyKey === 'schedule:s1').length, 1);

  // A second pass over the same schedule creates nothing and reports nothing.
  state.schedules = [{id: 's1', label: 'Check', kind: 'interval', intervalMinutes: 60, enabled: true}];
  assert.deepEqual(migrateSchedules(state), {migrated: 0});
  assert.equal(state.tasks.length, 1);
});
