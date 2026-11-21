/** The health answer must fail when a store cannot be read or a queue has stopped sweeping, not only when the process
 * is up. Docker's HEALTHCHECK relies on this answer. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {healthOf} from '../src/health.js';

const store = (ok = true) => ({get: () => { if (!ok) throw new Error('database is locked'); return {n: 1}; }});

test('healthy when every store answers and every queue swept recently', () => {
  assert.equal(healthOf([store()], {lastSweep: () => 1000, now: 1500}), true);
});

test('unhealthy when a store cannot be read', () => {
  assert.equal(healthOf([store(), store(false)], {lastSweep: () => 0, now: 1000}), false);
});

test('unhealthy when a started queue has stopped sweeping', () => {
  assert.equal(healthOf([store()], {lastSweep: () => 1000, now: 1000 + 61000}), false);
});

test('a queue that has not swept yet is not yet unhealthy', () => {
  assert.equal(healthOf([store()], {lastSweep: () => 0, now: 5000}), true);
});
