import test from 'node:test';
import assert from 'node:assert/strict';
import {concurrencyOf, taskKey, createTaskPool} from '../agent/task-pool.mjs';

const check = id => ({id, kind: 'http.check', payload: {url: 'https://example.com'}});
const model = (id, engine) => ({id, kind: 'model.run', payload: {engine}});
const page = (id, botId, kind = 'browser.capture') => ({id, kind, payload: {botId}});

// A `run` that logs ['start', id], waits for finish(id) (or fail(id)), then logs ['end', id].
function blocker() {
  const log = [];
  const gates = new Map();
  const run = task => new Promise((resolve, reject) => {
    log.push(['start', task.id]);
    gates.set(task.id, {
      resolve: () => { log.push(['end', task.id]); resolve(); },
      reject: error => { log.push(['end', task.id]); reject(error); },
    });
  });
  return {log, run, finish: id => gates.get(id).resolve(), fail: (id, error) => gates.get(id).reject(error)};
}

test('AGENT_CONCURRENCY: 3 by default, 1 to 8, a bad value is 3', () => {
  assert.deepEqual([{}, {AGENT_CONCURRENCY: '1'}, {AGENT_CONCURRENCY: '8'}, {AGENT_CONCURRENCY: '50'}].map(concurrencyOf), [3, 1, 8, 8]);
  for (const bad of ['0', '-2', '2.5', 'many', '']) assert.equal(concurrencyOf({AGENT_CONCURRENCY: bad}), 3);
});

test('taskKey: one key per model engine, one per bot for pages, none for the rest', () => {
  assert.equal(taskKey(model('m', 'claude')), 'model:claude');
  assert.equal(taskKey(page('p', 'bot-a')), 'bot:bot-a');
  assert.equal(taskKey(page('p', 'bot-a', 'browser.action')), 'bot:bot-a');
  assert.equal(taskKey(page('p', '')), 'bot:shared');
  assert.equal(taskKey({id: 'p', kind: 'browser.capture'}), 'bot:shared');
  assert.equal(taskKey(check('c')), null);
  assert.equal(taskKey({id: 'k', kind: 'mcp.call', payload: {}}), null);
});

test('at most that many run at once, and the rest start as slots free', async () => {
  const b = blocker();
  const pool = createTaskPool({concurrency: 3, run: b.run});
  for (const id of ['1', '2', '3', '4', '5']) pool.add(check(id));
  assert.deepEqual([pool.running(), pool.queued()], [3, 2]);
  b.finish('1'); await pool.settled();
  assert.deepEqual([pool.running(), pool.queued()], [3, 1]);
  assert.deepEqual(b.log.filter(([what]) => what === 'start').map(([, id]) => id), ['1', '2', '3', '4']);
  b.finish('2'); b.finish('3'); b.finish('4');
  await pool.settled();
  b.finish('5');
  await pool.drain();
  assert.deepEqual([pool.running(), pool.queued()], [0, 0]);
});

test('two model.run tasks on the same engine never overlap, and one on each engine do', async () => {
  const b = blocker();
  const pool = createTaskPool({concurrency: 3, run: b.run});
  pool.add(model('c1', 'claude')); pool.add(model('c2', 'claude')); pool.add(model('x1', 'codex'));
  assert.deepEqual(b.log, [['start', 'c1'], ['start', 'x1']]);
  b.finish('c1'); await pool.settled();
  assert.deepEqual(b.log.slice(2), [['end', 'c1'], ['start', 'c2']]);
  b.finish('c2'); b.finish('x1'); await pool.drain();
});

test("one bot's browser tasks run in order, and nothing else waits behind them", async () => {
  const b = blocker();
  const pool = createTaskPool({concurrency: 3, run: b.run});
  pool.add(page('a1', 'bot-a')); pool.add(page('a2', 'bot-a', 'browser.action')); pool.add(page('b1', 'bot-b'));
  assert.deepEqual(b.log, [['start', 'a1'], ['start', 'b1']]);
  b.finish('a1'); await pool.settled();
  assert.deepEqual(b.log.slice(2), [['end', 'a1'], ['start', 'a2']]);
  b.finish('a2'); b.finish('b1'); await pool.drain();
});

test('a capped task never holds back a free-key task queued behind it, even when slots are scarce', async () => {
  const b = blocker();
  const pool = createTaskPool({concurrency: 2, run: b.run});
  pool.add(model('c1', 'claude')); pool.add(model('c2', 'claude')); pool.add(page('p1', 'bot-a')); pool.add(check('h1'));
  // c1 and p1 run; c2 is skipped for its engine, h1 waits only for a slot.
  assert.deepEqual(b.log, [['start', 'c1'], ['start', 'p1']]);
  b.finish('p1'); await pool.settled();
  assert.deepEqual(b.log.slice(3), [['start', 'h1']]);
  assert.deepEqual([pool.running(), pool.queued()], [2, 1]);
  b.finish('c1'); await pool.settled();
  assert.equal(b.log.at(-1)[1], 'c2');
  b.finish('h1'); b.finish('c2'); await pool.drain();
});

test('a task is taken once, and its id is free again after it ends', async () => {
  const b = blocker();
  const pool = createTaskPool({concurrency: 1, run: b.run});
  assert.equal(pool.add(check('1')), true);
  assert.equal(pool.add(check('1')), false, 'running');
  assert.equal(pool.add(check('2')), true);
  assert.equal(pool.add(check('2')), false, 'queued');
  assert.deepEqual([pool.running(), pool.queued()], [1, 1]);
  b.finish('1'); await pool.settled();
  b.finish('2'); await pool.drain();
  assert.equal(pool.add(check('1')), true, 'a finished id may come again');
  b.finish('1'); await pool.drain();
});

test('a failure frees its slot and the pool goes on', async () => {
  const b = blocker();
  const pool = createTaskPool({concurrency: 1, run: b.run});
  pool.add(check('1')); pool.add(check('2'));
  b.fail('1', new Error('boom')); await pool.settled();
  assert.deepEqual([pool.running(), pool.queued()], [1, 0]);
  assert.deepEqual(b.log.at(-1), ['start', '2']);
  b.finish('2'); await pool.drain();
  assert.equal(pool.running(), 0);
});

test('a run that throws before it returns a promise frees its slot too', async () => {
  const pool = createTaskPool({concurrency: 1, run: () => { throw new Error('sync'); }});
  pool.add(check('1'));
  await pool.settled();
  assert.deepEqual([pool.running(), pool.queued()], [0, 0]);
});

test('drain starts nothing more, and resolves once the running tasks have ended', async () => {
  const b = blocker();
  const pool = createTaskPool({concurrency: 1, run: b.run});
  pool.add(check('1')); pool.add(check('2'));
  let drained = false;
  const done = pool.drain().then(() => { drained = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false, 'task 1 is still running');
  b.finish('1'); await done;
  assert.equal(drained, true);
  assert.deepEqual(b.log, [['start', '1'], ['end', '1']], 'task 2 never started');
  assert.deepEqual([pool.running(), pool.queued()], [0, 1]);
  pool.add(check('3'));
  assert.deepEqual(b.log, [['start', '1'], ['end', '1']], 'nor does one added after');
});

test('drain on an idle pool resolves at once, and a failing running task still lets it resolve', async () => {
  const idle = createTaskPool({run: () => Promise.resolve()});
  await idle.drain();
  const b = blocker();
  const pool = createTaskPool({concurrency: 2, run: b.run});
  pool.add(check('1')); pool.add(check('2'));
  const done = pool.drain();
  b.fail('1', new Error('boom')); b.finish('2');
  await done;
  assert.equal(pool.running(), 0);
});

test('a failed task goes to onError, with the task and the error, and the pool goes on', async () => {
  const seen = [];
  const b = blocker();
  const pool = createTaskPool({concurrency: 1, run: b.run, onError: (task, error) => seen.push([task.id, error.message])});
  pool.add(check('1')); pool.add(check('2'));
  b.fail('1', new Error('boom')); await pool.settled();
  assert.deepEqual(seen, [['1', 'boom']]);
  b.finish('2'); await pool.drain();
  assert.deepEqual(seen, [['1', 'boom']], 'a task that succeeds is not reported');
});

test('with no onError a failure logs one fixed line, never the error text or the task', async () => {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args);
  try {
    const pool = createTaskPool({concurrency: 1, run: () => Promise.reject(new Error('secret-token-123'))});
    pool.add({id: '1', kind: 'http.check', payload: {url: 'https://secret.example/path'}});
    await pool.settled(); await pool.drain();
  } finally { console.error = original; }
  assert.deepEqual(lines, [['agent: a task failed in the worker pool.']]);
});

test('an onError that throws does not stall the pool', async () => {
  const b = blocker();
  const pool = createTaskPool({concurrency: 1, run: b.run, onError: () => { throw new Error('reporter broke'); }});
  pool.add(check('1')); pool.add(check('2'));
  b.fail('1', new Error('boom')); await pool.settled();
  assert.deepEqual(b.log.at(-1), ['start', '2']);
  b.finish('2'); await pool.drain();
});

test('a keyOf that throws in add leaves the id free and stores nothing, and drain still resolves', async () => {
  const b = blocker();
  let bad = true;
  const pool = createTaskPool({concurrency: 2, run: b.run, keyOf: task => { if (bad && task.id === 'x') throw new Error('bad key'); return null; }});
  pool.add(check('1'));
  assert.throws(() => pool.add(check('x')), /bad key/);
  assert.deepEqual([pool.running(), pool.queued()], [1, 0]);
  bad = false;
  assert.equal(pool.add(check('x')), true, 'the id was never taken');
  const done = pool.drain();
  b.finish('1'); b.finish('x');
  await done;
  assert.equal(pool.running(), 0);
});
