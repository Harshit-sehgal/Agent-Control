/** The store's cheap paths keep their behaviour.
 *
 * Each update used to rewrite every kv blob (the browser requests carry whole
 * captured pages), rewrite every row of an ordered table whenever a row was
 * prepended (`activity()` unshifts an event on almost every write), and every
 * read-only caller paid for a full structured clone. These tests pin that the
 * shortcuts leave what is stored, and what is read back, exactly as before.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {openStore, orderPlan, peek} from '../src/sqlite-store.js';
import {activity} from '../shared/core.js';

const iso = () => new Date().toISOString();

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-perf-'));
  const file = path.join(dir, 'state.json');
  const store = await openStore(file);
  return {dir, file, store, async done() { await this.store.close(); await fs.rm(dir, {recursive: true, force: true}); }};
}

test('a prepended event keeps every stored row in place and still reads back first', async () => {
  const t = await sandbox();
  try {
    await t.store.update(s => { s.events = Array.from({length: 20}, (_, i) => ({id: `e${i}`, at: iso(), type: 'k', message: `m${i}`, meta: {}})); });
    const before = t.store.all('SELECT rowid, id FROM events');
    await t.store.update(s => activity(s, 'k', 'newest'));
    const after = t.store.all('SELECT rowid, id FROM events ORDER BY rowid');
    assert.equal(after.length, 21);
    for (const row of before) assert.deepEqual(after.find(r => r.id === row.id), row, `${row.id} was not rewritten`);
    const ids = t.store.read().events.map(e => e.id);
    assert.equal(t.store.read().events[0].message, 'newest');
    await t.store.close();
    t.store = await openStore(t.file);
    assert.deepEqual(t.store.read().events.map(e => e.id), ids, 'the order survives a restart');
    assert.equal(t.store.read().events[0].message, 'newest');
  } finally { await t.done(); }
});

test('prepends, trims, appends and removals keep document order across a restart', async () => {
  const t = await sandbox();
  try {
    const run = id => ({id, groupId: 'g', input: id, recipients: [], mode: 'm', status: 'completed', trace: []});
    await t.store.update(s => { s.groupRuns = ['a', 'b', 'c'].map(run); });
    await t.store.update(s => { s.groupRuns.unshift(run('z')); s.groupRuns = s.groupRuns.slice(0, 3); });
    await t.store.update(s => { s.groupRuns.unshift(run('y'), run('x')); s.groupRuns.splice(2, 1); });
    await t.store.update(s => { s.groupRuns.push(run('w')); });
    const expected = t.store.read().groupRuns.map(r => r.id);
    assert.deepEqual(expected, ['y', 'x', 'a', 'b', 'w']);
    // A real reorder still falls back to a full rewrite in document order.
    await t.store.update(s => { s.groupRuns.reverse(); });
    await t.store.close();
    t.store = await openStore(t.file);
    assert.deepEqual(t.store.read().groupRuns.map(r => r.id), [...expected].reverse());
  } finally { await t.done(); }
});

test('orderPlan names a prefix and suffix, or null for a real reorder', () => {
  const prev = seq => ({seq, map: new Map(seq.map(k => [k, {}]))});
  assert.deepEqual(orderPlan(['n', 'a', 'b'], prev(['a', 'b', 'c'])), {prefix: ['n'], suffix: []});
  assert.deepEqual(orderPlan(['a', 'b', 'n'], prev(['a', 'b'])), {prefix: [], suffix: ['n']});
  assert.deepEqual(orderPlan(['a', 'c'], prev(['a', 'b', 'c'])), {prefix: [], suffix: []});
  assert.equal(orderPlan(['b', 'a'], prev(['a', 'b'])), null);
  assert.equal(orderPlan(['a', 'n', 'b'], prev(['a', 'b'])), null);
});

test('an unchanged kv blob is not written again, a changed one is', async () => {
  const t = await sandbox();
  try {
    await t.store.update(s => { s.browserRequests = [{id: 'b1', status: 'done', result: {page: 'p'.repeat(5000)}}]; });
    const writes = [];
    const real = t.store.kvSet.bind(t.store);
    t.store.kvSet = (key, value) => { writes.push(key); return real(key, value); };
    await t.store.update(s => { s.settings.style = 'x'; });
    assert.deepEqual(writes, [], 'nothing in kv changed');
    await t.store.update(s => { s.browserRequests[0].status = 'failed'; });
    assert.deepEqual(writes, ['browser_requests']);
    assert.equal(JSON.parse(t.store.kvGet('browser_requests'))[0].status, 'failed');
  } finally { await t.done(); }
});

test('a write that rolls back does not teach the diff about rows that were never stored', async () => {
  const t = await sandbox();
  try {
    await t.store.update(s => { s.settings.style = 'kept'; s.browserRequests = [{id: 'b1', status: 'pending'}]; });
    const real = t.store.kvSet.bind(t.store);
    t.store.kvSet = () => { throw new Error('disk full'); };
    await assert.rejects(t.store.update(s => { s.settings.style = 'lost'; s.browserRequests[0].status = 'done'; s.chats = {c: [{id: 'm', at: iso(), role: 'user', text: 'x'}]}; }), /disk full/);
    t.store.kvSet = real;
    await t.store.update(s => { s.browserRequests[0].status = 'done'; s.chats = {c: [{id: 'm', at: iso(), role: 'user', text: 'x'}]}; });
    assert.equal(JSON.parse(t.store.kvGet('browser_requests'))[0].status, 'done');
    assert.equal(t.store.get('SELECT count(*) AS n FROM chat_messages').n, 1, 'the row the failed write held back is stored now');
  } finally { await t.done(); }
});

test('peek hands out the cached document without a copy, and updates never mutate it', async () => {
  const t = await sandbox();
  try {
    const first = t.store.peek();
    assert.equal(t.store.peek(), first, 'no copy');
    assert.equal(peek({read: () => 'fallback'}), 'fallback', 'a store without peek is read');
    const tag = t.store.stateTag();
    const frozen = JSON.stringify(first);
    await t.store.update(s => activity(s, 'k', 'after'));
    assert.equal(JSON.stringify(first), frozen, 'the old view is untouched by a later write');
    assert.notEqual(t.store.peek(), first);
    assert.notEqual(t.store.stateTag(), tag, 'a committed write changes the tag');
  } finally { await t.done(); }
});
