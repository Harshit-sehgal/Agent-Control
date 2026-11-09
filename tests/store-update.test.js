/** `store.update(fn)` supports an async transition (src/sqlite-store.js awaits
 * fn before persisting), but every caller in the tree happened to be
 * synchronous, so the await path was never exercised. These tests pin the
 * contract: the awaited result is what gets committed, a throw commits nothing,
 * and a synchronous writer that runs while a transition is mid-await is not
 * wiped out by the write that follows. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';

async function open(prefix = 'store-update-') {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const file = path.join(dir, 'state.db');
  const store = await new SqliteStore(file, path.join(dir, 'state.json')).init();
  // Test 1 closes and reopens the file, so closing here must be idempotent.
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await store.close(); } };
  return {dir, file, store, close, async done() { await close(); await fs.rm(dir, {recursive: true, force: true}); }};
}

const candidate = id => ({id, url: `https://x.com/test/status/${id}`, text: 'A post long enough to be captured.', author: 'Tester', topic: 'AI', status: 'new', createdAt: new Date().toISOString()});
const kv = (store, key) => store.get('SELECT value FROM kv WHERE key=?', key)?.value ?? null;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('an async transition is awaited, then committed and persisted', async () => {
  const t = await open();
  try {
    const result = await t.store.update(async state => {
      await sleep(5);
      state.candidates.push(candidate('async-1'));
      return 'committed';
    });
    assert.equal(result, 'committed', 'the transition result is returned to the caller');
    assert.deepEqual(t.store.read().candidates.map(c => c.id), ['async-1']);

    // The in-memory cache alone would pass the line above, so reopen the file:
    // writeCollections() must have run after the await, not before it.
    await t.close();
    const reopened = await new SqliteStore(t.file, path.join(path.dirname(t.file), 'state.json')).init();
    try {
      assert.deepEqual(reopened.read().candidates.map(c => c.id), ['async-1'], 'the row a late-awaited transition added survives a restart');
    } finally { await reopened.close(); }
  } finally { await t.done(); }
});

test('a throwing transition changes nothing and leaves the store usable', async () => {
  const t = await open();
  try {
    await t.store.update(state => { state.candidates.push(candidate('kept')); });
    const before = t.store.read();

    await assert.rejects(t.store.update(async state => {
      state.candidates.push(candidate('doomed'));
      state.settings.style = 'not this';
      await sleep(5);
      throw new Error('the transition said no');
    }), /the transition said no/);

    assert.deepEqual(t.store.read(), before, 'a half-applied transition must not be visible');
    assert.deepEqual(t.store.get('SELECT COUNT(*) AS n FROM candidates').n, 1, 'nothing was written to SQL either');

    // The serial chain must not stay rejected: the next transition still commits.
    await t.store.update(state => { state.candidates.push(candidate('after-failure')); });
    assert.deepEqual(t.store.read().candidates.map(c => c.id), ['kept', 'after-failure']);
  } finally { await t.done(); }
});

test('an update() racing a raw run() loses neither write', async () => {
  const t = await open();
  try {
    // Hold the transition open, so the raw writers below run in the gap between
    // fn() resolving and writeCollections() replacing the document tables.
    let release;
    const held = new Promise(resolve => { release = resolve; });
    let entered;
    const started = new Promise(resolve => { entered = resolve; });

    const transition = t.store.update(async state => {
      entered();
      await held;
      state.candidates.push(candidate('from-update'));
      state.settings.style = 'set by update';
    });
    await started;

    // Both of these land while the update is still awaiting fn().
    t.store.run('INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', 'race_run', 'kept by run');
    t.store.transaction(() => t.store.run('INSERT INTO kv (key,value) VALUES (?,?)', 'race_tx', 'kept by transaction'));
    assert.equal(kv(t.store, 'race_run'), 'kept by run', 'the raw write really happened during the update');

    release();
    await transition;

    assert.equal(kv(t.store, 'race_run'), 'kept by run', 'the update write must not clobber a concurrent raw run()');
    assert.equal(kv(t.store, 'race_tx'), 'kept by transaction', 'nor a write made inside a raw transaction()');
    assert.deepEqual(t.store.read().candidates.map(c => c.id), ['from-update'], 'and the transition itself committed');
    assert.equal(t.store.get('SELECT style FROM settings WHERE id=1').style, 'set by update');
  } finally { await t.done(); }
});

test('two transitions queued at once both apply, in call order', async () => {
  const t = await open();
  try {
    // update() serialises through this.serial; without that the second clone
    // would start from the pre-first state and drop its write.
    const first = t.store.update(async state => { await sleep(10); state.settings.topics.push('first'); });
    const second = t.store.update(async state => { await sleep(1); state.settings.topics.push('second'); });
    await Promise.all([first, second]);
    const topics = t.store.read().settings.topics;
    assert.deepEqual(topics.slice(-2), ['first', 'second']);
    assert.equal(topics.filter(topic => topic === 'first').length, 1, 'the second clone must start from the first one\'s result');
  } finally { await t.done(); }
});
