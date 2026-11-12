/** The write path is incremental.
 *
 * Every `update()` used to delete every row of every collection and insert the
 * whole document again, so adding one chat message rewrote every message, run
 * and event in the workspace. These tests pin the properties that made that
 * safe to change: an unchanged row is not rewritten (its rowid survives), a
 * changed row is replaced in place, a removed row is deleted, and the one
 * foreign key (bots -> groups) still holds when a group disappears.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {openStore} from '../src/sqlite-store.js';

const iso = () => new Date().toISOString();

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-incremental-'));
  const store = await openStore(path.join(dir, 'state.json'));
  return {dir, store, async done() { await store.close(); await fs.rm(dir, {recursive: true, force: true}); }};
}

const rows = (store, sql) => store.all(sql);

test('an update that changes one collection rewrites none of the others', async () => {
  const t = await sandbox();
  try {
    const chat = Array.from({length: 50}, (_, i) => ({id: `m${i}`, at: iso(), role: 'user', text: `hello ${i}`}));
    await t.store.update(s => {
      s.chats = {c1: chat};
      s.events = Array.from({length: 50}, (_, i) => ({id: `e${i}`, at: iso(), type: 'k', message: `e${i}`, meta: {}}));
    });
    const before = rows(t.store, 'SELECT rowid, id FROM chat_messages ORDER BY id');
    assert.equal(before.length, 50, 'the fixture is really stored');

    await t.store.update(s => { s.settings.retention = {events: 30}; });

    assert.deepEqual(rows(t.store, 'SELECT rowid, id FROM chat_messages ORDER BY id'), before,
      'a settings write must not delete and re-insert every chat message');
  } finally { await t.done(); }
});

test('a changed row is replaced in place, so read order survives', async () => {
  const t = await sandbox();
  try {
    await t.store.update(s => {
      s.chats = {c1: [{id: 'a', at: iso(), role: 'user', text: 'first'}, {id: 'b', at: iso(), role: 'bot', text: 'second'}]};
    });
    const before = rows(t.store, 'SELECT rowid, id FROM chat_messages ORDER BY rowid');
    await t.store.update(s => { s.chats.c1[0].text = 'first, edited'; });
    const after = rows(t.store, 'SELECT rowid, id FROM chat_messages ORDER BY rowid');
    assert.deepEqual(after, before, 'editing a message must not move the rows around');
    const doc = JSON.parse(t.store.get('SELECT doc FROM chat_messages WHERE id=?', 'c1/a').doc);
    assert.equal(doc.text, 'first, edited', 'and the change must actually be stored');
  } finally { await t.done(); }
});

test('a removed row is deleted, and a removed group takes its bots', async () => {
  const t = await sandbox();
  try {
    await t.store.update(s => {
      s.groups.push({id: 'g-temp', name: 'Temp', description: '', createdAt: iso(),
        bots: [{id: 'b-temp', name: 'Temp bot', instructions: '', createdAt: iso()}]});
    });
    assert.equal(t.store.get('SELECT count(*) AS n FROM bots WHERE id=?', 'b-temp').n, 1);

    await t.store.update(s => {
      s.groups = s.groups.filter(g => g.id !== 'g-temp');
      s.chats = {c1: [{id: 'gone', at: iso(), role: 'user', text: 'delete me'}]};
    });
    assert.equal(t.store.get('SELECT count(*) AS n FROM bots WHERE id=?', 'b-temp').n, 0,
      'the foreign key must not stop a group from being removed');
    assert.equal(t.store.get('SELECT count(*) AS n FROM chat_messages WHERE id=?', 'c1/gone').n, 1);
    await t.store.update(s => { s.chats = {}; });
    assert.equal(t.store.get('SELECT count(*) AS n FROM chat_messages').n, 0, 'an emptied collection leaves no rows');
  } finally { await t.done(); }
});

test('two chats may hold the same message id, and memory keys stay distinct', async () => {
  const t = await sandbox();
  try {
    await t.store.update(s => {
      s.chats = {
        '@a': [{id: 'same', at: iso(), role: 'user', text: 'from a'}],
        '@b': [{id: 'same', at: iso(), role: 'user', text: 'from b'}],
      };
      s.memory = {version: 1, rulebooks: {x: {rules: ['one']}}, chats: {y: {summary: 'two'}}, forgottenChats: {}};
    });
    assert.equal(t.store.get('SELECT count(*) AS n FROM chat_messages WHERE id=?', '@a/same').n, 1);
    assert.equal(t.store.get('SELECT count(*) AS n FROM chat_messages WHERE id=?', '@b/same').n, 1);

    await t.store.update(s => { delete s.memory.chats.y; s.memory.rulebooks.x = {rules: ['one', 'two']}; });
    assert.equal(t.store.get('SELECT count(*) AS n FROM memory WHERE kind=? AND key=?', 'chat', 'y').n, 0,
      'a forgotten recap must be deleted, not merely left behind');
    assert.deepEqual(JSON.parse(t.store.get('SELECT doc FROM memory WHERE kind=? AND key=?', 'rulebook', 'x').doc), {rules: ['one', 'two']});
  } finally { await t.done(); }
});

test('a reopened store reads exactly what the incremental path wrote', async () => {
  const t = await sandbox();
  try {
    await t.store.update(s => {
      s.chats = {c1: [{id: 'm1', at: iso(), role: 'user', text: 'persisted'}]};
      s.events.push({id: 'e1', at: iso(), type: 'k', message: 'event', meta: {groupId: 'x-engage'}});
      s.tasks.push({id: 't1', kind: 'reminder', title: 'T', payload: {}, status: 'queued', runAt: iso(), attempts: 0, maxAttempts: 5, createdAt: iso(), updatedAt: iso()});
    });
    const expected = t.store.read();
    await t.store.close();
    const reopened = await openStore(path.join(path.dirname(t.dir), path.basename(t.dir), 'state.json'));
    const actual = reopened.read();
    assert.deepEqual(actual.chats, expected.chats);
    assert.deepEqual(actual.events.map(e => e.id), expected.events.map(e => e.id));
    assert.deepEqual(actual.tasks.map(x => x.id), expected.tasks.map(x => x.id));
    await reopened.close();
  } finally { await fs.rm(t.dir, {recursive: true, force: true}); }
});

test('an item prepended to the document is still first after a restart', async () => {
  const t = await sandbox();
  const db = path.join(t.dir, 'state.json');
  const post = (id, at) => ({id, botId: 'atlas', botName: 'Atlas', input: id, output: id, at});
  try {
    // The app prepends: a new run and a new activity event are index
    // 0, and the document's array order is what the API hands the UI.
    await t.store.update(s => {
      s.runs.push(post('c1', iso()));
      s.events.push({id: 'e1', at: iso(), type: 'k', message: 'first', meta: {}});
    });
    await t.store.update(s => {
      s.runs.unshift(post('c2', iso()));
      s.events.unshift({id: 'e2', at: iso(), type: 'k', message: 'second', meta: {}});
    });
    assert.deepEqual(t.store.read().runs.map(c => c.id), ['c2', 'c1'], 'the live cache is in document order');
    await t.store.close();

    const reopened = await openStore(db);
    assert.deepEqual(reopened.read().runs.map(c => c.id), ['c2', 'c1'],
      'a restart must not move the newest run to the end of the list');
    assert.deepEqual(reopened.read().events.map(e => e.id), ['e2', 'e1']);
    await reopened.close();
  } finally { await fs.rm(t.dir, {recursive: true, force: true}); }
});
