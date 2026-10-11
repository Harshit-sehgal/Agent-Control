import test from 'node:test';
import assert from 'node:assert/strict';
import {initialState} from '../shared/core.js';
import {migrate, addGroup} from '../shared/workflow.js';
import {addChatMessages, clearChat, pruneChats, mergeChat, createOutbox, MAX_CHAT_MESSAGES} from '../shared/chats.js';

const fresh = () => migrate(initialState());

test('a message is stored under its conversation with only the known fields', () => {
  const s = fresh();
  const {added} = addChatMessages(s, 'writer', [{id: 'm1', role: 'user', text: '  make it shorter  ', at: '2026-01-01T00:00:00.000Z', html: '<img onerror=x>', senderName: 'x'.repeat(500)}]);
  assert.equal(added, 1);
  assert.deepEqual(Object.keys(s.chats.writer[0]).sort(), ['at', 'id', 'role', 'senderName', 'text']);
  assert.equal(s.chats.writer[0].text, 'make it shorter');
  assert.equal(s.chats.writer[0].senderName.length, 120);
});

test('posting the same message twice keeps one copy', () => {
  const s = fresh();
  addChatMessages(s, 'team-x-engage', [{id: 'm1', role: 'bot', text: 'one'}]);
  const {added} = addChatMessages(s, 'team-x-engage', [{id: 'm1', role: 'bot', text: 'one'}, {id: 'm2', role: 'bot', text: 'two'}]);
  assert.equal(added, 1);
  assert.deepEqual(s.chats['team-x-engage'].map(m => m.id), ['m1', 'm2']);
});

test('a conversation keeps only its newest messages', () => {
  const s = fresh();
  for (let i = 0; i < 4; i++) addChatMessages(s, 'writer', Array.from({length: 100}, (_, n) => ({id: `m${i}-${n}`, role: 'user', text: 'hi'})));
  assert.equal(s.chats.writer.length, MAX_CHAT_MESSAGES);
  assert.equal(s.chats.writer.at(-1).id, 'm3-99');
});

test('unknown conversations, bad roles, empty text and oversized batches are refused', () => {
  const s = fresh();
  assert.throws(() => addChatMessages(s, 'nobody', [{role: 'user', text: 'hi'}]), {status: 404});
  assert.throws(() => addChatMessages(s, 'team-nope', [{role: 'user', text: 'hi'}]), {status: 404});
  assert.throws(() => addChatMessages(s, '__proto__', [{role: 'user', text: 'hi'}]), {status: 404});
  assert.throws(() => addChatMessages(s, 'writer', [{role: 'admin', text: 'hi'}]), {status: 400});
  assert.throws(() => addChatMessages(s, 'writer', [{role: 'user', text: '   '}]), {status: 400});
  assert.throws(() => addChatMessages(s, 'writer', []), {status: 400});
  assert.throws(() => addChatMessages(s, 'writer', Array.from({length: MAX_CHAT_MESSAGES + 1}, () => ({role: 'user', text: 'hi'}))), {status: 400});
  assert.deepEqual(s.chats, {});
});

test('clearing a conversation removes only that one', () => {
  const s = fresh();
  addChatMessages(s, 'writer', [{role: 'user', text: 'a'}]);
  addChatMessages(s, 'scout', [{role: 'user', text: 'b'}]);
  assert.deepEqual(clearChat(s, 'writer'), {ok: true, removed: 1});
  assert.equal(s.chats.writer, undefined);
  assert.equal(s.chats.scout.length, 1);
});

test('history of a bot or group that no longer exists is dropped', () => {
  const s = fresh();
  const group = addGroup(s, {name: 'Temp', description: ''});
  addChatMessages(s, `team-${group.id}`, [{role: 'user', text: 'a'}]);
  addChatMessages(s, 'writer', [{role: 'user', text: 'b'}]);
  s.groups = s.groups.filter(g => g.id !== group.id);
  pruneChats(s);
  assert.deepEqual(Object.keys(s.chats), ['writer']);
});

test('merging keeps the server order and re-attaches messages still being sent', () => {
  const server = [{id: 'a'}, {id: 'b'}];
  const local = [{id: 'a'}, {id: 'x'}, {id: 'b'}, {id: 'y'}];
  assert.deepEqual(mergeChat(server, local, new Set(['x', 'y'])).map(m => m.id), ['a', 'b', 'x', 'y']);
  // A message the server never confirmed and that is no longer pending is gone.
  assert.deepEqual(mergeChat(server, local, new Set(['y'])).map(m => m.id), ['a', 'b', 'y']);
});

test('a sent message stays visible until a snapshot fetched after the send confirms it', async () => {
  const server = {writer: []};
  let release; const gate = new Promise(resolve => { release = resolve; });
  const outbox = createOutbox(async (key, messages) => { await gate; server[key].push(...messages); });
  const local = {writer: [{id: 'm1', role: 'user', text: 'hi'}]};
  outbox.add('writer', local.writer[0]);
  // A snapshot taken while the send is still in flight does not contain it.
  const early = outbox.beginFetch(), stale = {writer: []};
  assert.deepEqual(outbox.adopt(stale, local, early).writer.map(m => m.id), ['m1']);
  release(); await outbox.settle();
  // The send finished, but this snapshot was requested before that.
  assert.deepEqual(outbox.adopt(stale, local, early).writer.map(m => m.id), ['m1']);
  assert.equal(outbox.size, 1);
  const fresh = outbox.beginFetch();
  assert.deepEqual(outbox.adopt({writer: [...server.writer]}, local, fresh).writer.map(m => m.id), ['m1']);
  assert.equal(outbox.size, 0);
});

test('a failed send is retried, a refused one is dropped, a read-only account keeps it on screen', async () => {
  let mode = 'offline'; const stored = [];
  const outbox = createOutbox(async (key, messages) => {
    if (mode === 'offline') throw new Error('network');
    if (mode === 'gone') throw Object.assign(new Error('nope'), {status: 404});
    if (mode === 'viewer') throw Object.assign(new Error('nope'), {status: 403});
    stored.push(...messages);
  });
  const a = {id: 'a', role: 'user', text: 'one'};
  outbox.add('writer', a); await outbox.settle();
  assert.equal(stored.length, 0); assert.equal(outbox.size, 1);
  mode = 'online'; await outbox.settle();
  assert.deepEqual(stored.map(m => m.id), ['a'], 'The retry must deliver the message once.');
  await outbox.settle();
  assert.equal(stored.length, 1, 'A delivered message is not sent again.');

  mode = 'gone'; outbox.add('ghost', {id: 'b', role: 'user', text: 'two'}); await outbox.settle();
  assert.deepEqual(outbox.adopt({}, {ghost: [{id: 'b'}]}, outbox.beginFetch()).ghost, undefined);

  mode = 'viewer'; const c = {id: 'c', role: 'bot', text: 'three'};
  outbox.add('scout', c); await outbox.settle();
  assert.deepEqual(outbox.adopt({}, {scout: [c]}, outbox.beginFetch()).scout.map(m => m.id), ['c']);
  outbox.forget('scout');
  assert.equal(outbox.adopt({}, {scout: [c]}, outbox.beginFetch()).scout, undefined);
});

test('sends reach the server in the order they were made', async () => {
  const stored = [];
  const outbox = createOutbox(async (key, messages) => { await new Promise(r => setTimeout(r, messages[0].id === 'slow' ? 15 : 0)); stored.push(messages[0].id); });
  for (const id of ['slow', 'b', 'c']) outbox.add('writer', {id, role: 'user', text: id});
  await outbox.settle();
  assert.deepEqual(stored, ['slow', 'b', 'c']);
});
