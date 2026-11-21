/** A slow bot turn must not hold up a task that is due later (a push, a follow-up). The timer starts a new sweep
 * while an earlier one is still running, up to a small cap, so the due task runs at once. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {SqliteStore} from '../src/sqlite-store.js';
import {createQueue, lastSweepAt} from '../src/queue.js';
import * as wf from '../shared/workflow.js';

/** Insert a row the way the database would: synthetic kinds are not valid through the API. */
function rawTask(state, {kind, title = kind}) {
  state.tasks.unshift({id: crypto.randomUUID(), kind, title, payload: {}, status: 'queued', runAt: new Date().toISOString(),
    intervalMinutes: null, idempotencyKey: null, attempts: 0, maxAttempts: 5, leaseOwner: null, leaseUntil: null,
    lastError: null, result: null, createdBy: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null});
}

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-queue-lanes-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  await store.update(s => { wf.migrate(s); });
  return {dir, store};
}
const waitFor = async (test, ms = 3000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (test()) return true; await new Promise(r => setTimeout(r, 10)); }
  return false;
};

test('a due task runs while a slow task is still running', async () => {
  const {store, dir} = await harness();
  let releaseSlow;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  let slowStarted = false, quickDone = false;
  const queue = createQueue(store, {
    slow: async () => { slowStarted = true; await slowGate; return {ok: true}; },
    quick: async () => { quickDone = true; return {ok: true}; },
  }, {intervalMs: 20, leaseMs: 60000});
  const stop = queue.start();
  try {
    await store.update(s => rawTask(s, {kind: 'slow', title: 'Slow turn'}));
    assert.ok(await waitFor(() => slowStarted), 'the slow task started');
    await store.update(s => rawTask(s, {kind: 'quick', title: 'Push'}));
    assert.ok(await waitFor(() => quickDone), 'the quick task ran while the slow one was still in progress');
  } finally {
    releaseSlow();
    await stop();
    await store.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('a due task in the same claimed batch as a slow one does not wait for it', async () => {
  const {store, dir} = await harness();
  let releaseSlow;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  let quickDone = false;
  const queue = createQueue(store, {
    slow: async () => { await slowGate; return {ok: true}; },
    quick: async () => { quickDone = true; return {ok: true}; },
  }, {intervalMs: 20, leaseMs: 60000});
  // Both are due before the queue starts, so one claim takes both.
  // The slow task is first in the claim (rawTask puts each new row at the front, so insert the push first).
  await store.update(s => { rawTask(s, {kind: 'quick', title: 'Push'}); rawTask(s, {kind: 'slow', title: 'Slow turn'}); });
  const stop = queue.start();
  try {
    assert.ok(await waitFor(() => quickDone), 'the quick task ran while the slow one held its place in the batch');
  } finally {
    releaseSlow();
    await stop();
    await store.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('the sweep clock keeps ticking while a slow task holds the queue', async () => {
  const {store, dir} = await harness();
  let releaseSlow;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  let slowStarted = false;
  const queue = createQueue(store, {slow: async () => { slowStarted = true; await slowGate; return {ok: true}; }},
    {intervalMs: 20, leaseMs: 60000, maxOverlap: 1});
  const stop = queue.start();
  try {
    await store.update(s => rawTask(s, {kind: 'slow', title: 'Slow turn'}));
    assert.ok(await waitFor(() => slowStarted));
    const before = lastSweepAt(store);
    await new Promise(r => setTimeout(r, 200));
    assert.ok(lastSweepAt(store) > before, 'health sees a live timer, not only a sweep that finished');
  } finally {
    releaseSlow();
    await stop();
    await store.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
});
