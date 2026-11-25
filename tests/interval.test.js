// One way to run a workspace's background pass on a timer: never two passes at once, a failure logged and the
// timer kept, a closed store (503) quiet, and stop() waits for the pass in flight instead of guessing how long.
import test from 'node:test';
import assert from 'node:assert/strict';
import {startSweep} from '../src/interval.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a sweep runs at once, never twice at the same time, and stop waits for the pass in flight', async () => {
  let release, runs = 0, finished = false;
  const stop = startSweep('test', async () => { runs++; await new Promise(resolve => { release = resolve; }); finished = true; }, {intervalMs: 5});
  await tick();
  assert.equal(runs, 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(runs, 1, 'a pass still running is not started again');
  const stopping = stop();
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await tick();
  assert.equal(stopped, false, 'stop waits');
  release();
  await stopping;
  assert.equal(finished, true);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(runs, 1, 'nothing runs after stop');
});

test('a failure is logged and the next pass still runs; a closed store says nothing', async () => {
  const logs = [];
  let runs = 0;
  const stop = startSweep('Thing', async () => { runs++; if (runs === 1) throw new Error('boom'); if (runs === 2) throw Object.assign(new Error('closed'), {status: 503}); }, {intervalMs: 5, log: message => logs.push(message)});
  await new Promise(resolve => setTimeout(resolve, 40));
  await stop();
  assert.ok(runs >= 3);
  assert.deepEqual(logs, ['Thing error: boom']);
});

test('the pass goes through the workspace\'s work tracker when it has one, and can wait for the first interval', async () => {
  let tracked = 0, runs = 0;
  const ws = {trackWork: fn => { tracked++; return fn(); }};
  const stop = startSweep('t', async () => { runs++; }, {intervalMs: 10, ws, immediate: false});
  await tick();
  assert.equal(runs, 0, 'not at once');
  await new Promise(resolve => setTimeout(resolve, 25));
  await stop();
  assert.ok(runs >= 1);
  assert.equal(tracked, runs);
});
