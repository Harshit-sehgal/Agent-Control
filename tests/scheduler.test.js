/** src/scheduler.js is the retention sweep (daily, plus once at boot). It
 * wraps `store.update`, so a fake store that records the
 * writes proves the behaviour without timers left running in a real store. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {startRetention} from '../src/scheduler.js';

const HOUR = 3600000, DAY = 86400000;
const iso = ms => new Date(ms).toISOString();

/** A store with the two methods the scheduler uses. `gate`, when set, holds
 * every update open so the drain-on-stop path can be observed. */
function fakeStore(state) {
  const store = {
    state,
    updates: 0,
    gate: null,
    transitions: [],
    read: () => structuredClone(store.state),
    async update(fn) {
      store.updates++;
      const next = structuredClone(store.state);
      if (store.gate) await store.gate;
      const result = await fn(next);
      store.state = next;
      store.transitions.push(result);
      return result;
    },
  };
  return store;
}

/** Poll instead of sleeping a fixed time: the interval is real but tiny. */
async function until(condition, label, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('stop() waits for an in-flight sweep instead of returning mid-write', async () => {
  let release;
  const store = fakeStore({settings: {retention: {events: 0, doneTasks: 0, runs: 0}}, events: [], tasks: [], runs: []});
  store.gate = new Promise(resolve => { release = resolve; });
  const stop = startRetention(store, DAY);
  await until(() => store.updates === 1, 'the boot sweep to start');
  let stopped = false;
  const stopping = stop().then(() => { stopped = true; });
  await sleep(20);
  assert.equal(stopped, false, 'stop() must drain the running sweep, not abandon the write');
  store.gate = null;
  release();
  await stopping;
  assert.equal(store.transitions.length, 1, 'the sweep finished before stop() resolved');
});

test('a failing sweep is logged and does not kill the clock', async () => {
  const store = fakeStore({settings: {retention: {events: 0, doneTasks: 0, runs: 0}}, events: [], tasks: [], runs: []});
  const working = store.update.bind(store);
  let calls = 0;
  store.update = async fn => { calls++; if (calls === 1) throw new Error('disk full'); return working(fn); };
  const errors = [], original = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  const stop = startRetention(store, 5);
  try {
    await until(() => store.transitions.length >= 1, 'the retry after the failed sweep');
    assert.match(errors.join('\n'), /Retention error: disk full/);
  } finally { console.error = original; await stop(); }
});

test('retention prunes at boot, before the first interval', async () => {
  const now = Date.now();
  const store = fakeStore({
    settings: {retention: {events: 90, doneTasks: 30, runs: 30}},
    events: [{id: 'old', at: iso(now - 200 * DAY), type: 'x', message: 'old'}, {id: 'new', at: iso(now), type: 'x', message: 'new'}],
    tasks: [
      {id: 'finished', status: 'done', completedAt: iso(now - 100 * DAY), updatedAt: iso(now - 100 * DAY)},
      {id: 'pending', status: 'queued', runAt: iso(now + HOUR), updatedAt: iso(now - 400 * DAY)},
    ],
    runs: [{id: 'old-run', at: iso(now - 200 * DAY)}, {id: 'new-run', at: iso(now)}],
  });
  // A day-long interval is never reached inside the test: a prune here can only
  // come from the boot run the scheduler is documented to do.
  const stop = startRetention(store, DAY);
  try {
    await until(() => store.updates === 1, 'the boot-time prune');
    assert.deepEqual(store.state.events.map(e => e.id).filter(id => id === 'old'), [], 'an expired event is pruned');
    assert.ok(store.state.events.some(e => e.id === 'new'), 'a recent event stays');
    assert.ok(store.state.events.some(e => e.type === 'retention'), 'the prune leaves one activity line saying what went');
    assert.deepEqual(store.state.tasks.map(t => t.id), ['pending'], 'a queued task is not exhaust and is never pruned');
    assert.deepEqual(store.state.runs.map(r => r.id), ['new-run']);
    assert.deepEqual([store.transitions[0].events, store.transitions[0].doneTasks, store.transitions[0].runs], [1, 1, 1]);
  } finally { await stop(); }
});

test('the retention interval fires and stop() prevents later sweeps', async () => {
  const store = fakeStore({settings: {retention: {events: 0, doneTasks: 0, runs: 0}}, events: [], tasks: [], runs: []});
  const stop = startRetention(store, 5);
  await until(() => store.updates >= 2, 'a second sweep from the interval');
  await stop();
  const after = store.updates;
  await sleep(40);
  assert.equal(store.updates, after, 'a stopped sweep must not run again');
});
