import test from 'node:test';
import assert from 'node:assert/strict';
import {maybeConsolidate, consolidateModel} from '../src/memory.js';

/** The smallest store a consolidation pass needs: a book that is due, and a
 * `update` that runs the mutation the way a real store does. */
function bookStore(overrides = {}) {
  const state = {
    memory: {rulebooks: {k: {turns: 9, consolidatedTurns: 0, rules: [], pending: [], label: 'Test model'}}, chats: {}},
    ...overrides,
  };
  const store = {
    read: () => state,
    update: fn => Promise.resolve(fn(state)),
    state,
  };
  return store;
}
const config = {model: 'test-model', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'key'};
const answer = async () => '{"rules": ["Keep replies short."], "summary": "Talks about replies."}';

async function quietly(fn) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try { return {result: await fn(), logged}; } finally { console.error = original; }
}

test('a consolidation pass runs as workspace work, so a paused workspace refuses it', async () => {
  const store = bookStore();
  const started = [];
  store.trackWork = work => { started.push(work); return Promise.reject(Object.assign(new Error('This workspace is being restored. Try again shortly.'), {status: 503})); };
  const {result, logged} = await quietly(() => maybeConsolidate(store, {key: 'k', config, executor: answer}));
  assert.equal(result, null, 'A skipped pass is not an error for the caller.');
  assert.equal(started.length, 1, 'The rewrite went through the workspace queue.');
  assert.deepEqual(logged, [], 'A restore pause is expected, not a failure worth logging.');
});

test('a real failure inside the pass is still reported', async () => {
  const store = bookStore();
  store.trackWork = () => Promise.reject(new Error('The disk is full.'));
  const {result, logged} = await quietly(() => maybeConsolidate(store, {key: 'k', config, executor: answer}));
  assert.equal(result, null);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /Memory consolidation failed: The disk is full/);
});

test('the pass still rewrites the book when it runs, and a store without a queue works', async () => {
  const store = bookStore();
  const order = [];
  let inside = false;
  store.trackWork = work => { order.push('queued'); inside = true; return work().finally(() => { inside = false; }); };
  store.update = fn => { order.push(inside ? 'update inside workspace work' : 'update without work'); return Promise.resolve(fn(store.state)); };
  const pass = await maybeConsolidate(store, {key: 'k', config, executor: answer});
  assert.equal(pass.book.rules.length, 1);
  assert.deepEqual(order, ['queued', 'update inside workspace work']);
  assert.ok(store.state.memory.rulebooks.k.consolidatedAt);
  // A browser or in-memory workspace has no queue to go through.
  const plain = bookStore();
  const written = await maybeConsolidate(plain, {key: 'k', config, executor: answer});
  assert.equal(written.book.rules.length, 1);
});

test('a book that is not due is never touched, queued or not', async () => {
  const store = bookStore();
  let touched = 0;
  store.trackWork = () => { touched++; return Promise.resolve(); };
  store.state.memory.rulebooks.k = {turns: 1, consolidatedTurns: 0, rules: [], pending: []};
  assert.equal(await maybeConsolidate(store, {key: 'k', config, executor: answer}), null);
  assert.equal(touched, 0, 'Nothing was due, so no workspace work was requested.');
  // Model memory switched off is the same: no call, no queue entry.
  assert.equal(await maybeConsolidate(store, {key: 'k', config: null, executor: answer}), null);
  assert.equal(touched, 0);
  assert.equal(await consolidateModel(store, {key: '', config, executor: answer}).catch(error => error.status), 400);
});

test('a rule learned during the model call is not wiped by the answer to the last one', async () => {
  const store = bookStore();
  store.state.memory.rulebooks.k.pending = ['Always cite the source.'];
  const {result} = await quietly(() => consolidateModel(store, {
    key: 'k', config,
    // A person keeps talking while the model thinks; `noteTurn` is deliberately
    // not locked out, so this sentence was never sent to the model.
    executor: async () => {
      store.state.memory.rulebooks.k.pending.push('Never use exclamation marks.');
      store.state.memory.rulebooks.k.turns += 1;
      return '{"rules": ["Always cite the source."], "summary": "Short replies."}';
    },
  }));
  assert.equal(result.skipped, false);
  // The sent instruction became a rule and left the queue; the one that arrived
  // during the call must still be pending, or it is silently forgotten.
  assert.deepEqual(store.state.memory.rulebooks.k.pending, ['Never use exclamation marks.']);
  assert.equal(store.state.memory.rulebooks.k.consolidatedTurns, 9, 'only the turns that were read count as consolidated');
  assert.equal(store.state.memory.rulebooks.k.turns, 10);
});

test('a pass that reads nothing usable says so instead of vanishing', async () => {
  const store = bookStore();
  const original = console.warn;
  const warned = [];
  console.warn = (...args) => warned.push(args.join(' '));
  try {
    const out = await maybeConsolidate(store, {key: 'k', config, executor: async () => 'I could not do that.'});
    assert.equal(out.skipped, true);
    // The caller is fire-and-forget, so this line is the only trace a provider
    // whose JSON never parses leaves; without it the pass is invisible forever.
    assert.match(warned.join('\n'), /Memory consolidation skipped: The model returned no usable memory update\./);
  } finally { console.warn = original; }
});
