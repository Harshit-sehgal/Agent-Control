/** The one mark a sidebar or home row carries at its face: needs you, working, just finished, unread.
 * The decision is pure (shared/ui-company.js); shared/ui-shell.js draws it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {rowMark, botRows, threadRows, DONE_MS} from '../shared/ui-company.js';

const bot = (id, name, settings = {}) => ({id, name, instructions: `${name} does a job.`, settings});
const atlas = bot('atlas', 'Atlas', {lead: true});
const mail = bot('mail', 'Mailroom', {reportsTo: 'atlas'});
const thread = (id, name) => ({id, name, bots: [], settings: {kind: 'thread', ownerId: 'atlas', members: ['atlas']}});
const NOW = Date.parse('2026-11-12T10:00:00Z');
const at = ms => new Date(NOW - ms).toISOString();
const stateOf = (extra = {}) => ({groups: [{id: 'home', name: 'Company', settings: {}, bots: [atlas, mail]}, thread('t1', 'Northwind')], chats: {}, groupRuns: [], asks: [], ...extra});
const rowOf = (rows, id) => rows.find(r => r.id === id);

test('one mark at a time: needs you, then working, then just finished, then unread', () => {
  assert.equal(rowMark({needs: true, working: true, done: 10, unread: true}).kind, 'needs');
  assert.equal(rowMark({working: true, done: 10, unread: true}).kind, 'working');
  assert.equal(rowMark({done: 10, unread: true}).kind, 'done');
  assert.equal(rowMark({unread: true}).kind, 'unread');
  assert.equal(rowMark({}).kind, '');
});

test('every mark says what it means in words, for a screen reader', () => {
  assert.equal(rowMark({needs: true}).label, 'Needs you');
  assert.equal(rowMark({working: true}).label, 'Working');
  assert.equal(rowMark({done: 0}).label, 'Just finished');
  assert.equal(rowMark({unread: true}).label, 'Unread');
  assert.equal(rowMark({}).label, '');
});

test('a just-finished mark carries its age, and says it turns into the unread dot', () => {
  assert.deepEqual(rowMark({done: 1200, unread: true}), {kind: 'done', label: 'Just finished', age: 1200, then: 'unread'});
  assert.deepEqual(rowMark({done: 1200}), {kind: 'done', label: 'Just finished', age: 1200, then: ''});
});

test('a bot row is working while its run is, and needs you while an ask waits', () => {
  const working = botRows(stateOf({groupRuns: [{id: 'r1', groupId: 'home', chatKey: 'mail', status: 'running', recipients: ['mail'], trace: []}]}), {now: NOW});
  assert.equal(rowOf(working, 'mail').mark.kind, 'working');
  const asking = botRows(stateOf({groupRuns: [{id: 'r1', groupId: 'home', chatKey: 'mail', status: 'awaiting_ask', recipients: ['mail'], trace: []}]}), {now: NOW});
  assert.equal(rowOf(asking, 'mail').mark.kind, 'needs');
});

test('a run that finished a moment ago marks its row done, then the mark gives way to the unread dot', () => {
  const finished = age => stateOf({
    groupRuns: [{id: 'r1', groupId: 'home', chatKey: 'mail', status: 'completed', recipients: ['mail'], trace: [], completedAt: at(age)}],
    chats: {mail: [{id: 'm1', role: 'bot', senderId: 'mail', text: 'Done: three drafts.', at: at(age)}]},
  });
  const fresh = rowOf(botRows(finished(800), {now: NOW}), 'mail').mark;
  assert.deepEqual([fresh.kind, fresh.age, fresh.then], ['done', 800, 'unread']);
  assert.equal(rowOf(botRows(finished(DONE_MS + 1), {now: NOW}), 'mail').mark.kind, 'unread');
  // Opened since: nothing left to say once the check has faded.
  assert.equal(rowOf(botRows(finished(DONE_MS + 1), {now: NOW, seen: {mail: at(0)}}), 'mail').mark.kind, '');
});

test('a run that failed or was stopped is never marked done', () => {
  const state = stateOf({groupRuns: [{id: 'r1', groupId: 'home', chatKey: 'mail', status: 'failed', recipients: ['mail'], trace: [], completedAt: at(500)}]});
  assert.equal(rowOf(botRows(state, {now: NOW}), 'mail').mark.kind, '');
});

test('thread rows get the same marks: waiting on you, working, just finished, unread', () => {
  const base = {groupId: 't1', chatKey: 'team-t1', recipients: ['atlas'], trace: []};
  const rowFor = state => [...Object.values(threadRows(state, {now: NOW}))].flat().find(r => r.id === 't1');
  assert.equal(rowFor(stateOf({groupRuns: [{id: 'r1', ...base, status: 'awaiting_ask'}]})).mark.kind, 'needs');
  assert.equal(rowFor(stateOf({groupRuns: [{id: 'r1', ...base, status: 'running', startedAt: at(1000)}]})).mark.kind, 'working');
  const done = stateOf({groupRuns: [{id: 'r1', ...base, status: 'completed', completedAt: at(300)}], chats: {'team-t1': [{id: 'm1', role: 'bot', senderId: 'atlas', text: 'All set.', at: at(300)}]}});
  assert.deepEqual([rowFor(done).mark.kind, rowFor(done).mark.then], ['done', 'unread']);
  const later = stateOf({chats: {'team-t1': [{id: 'm1', role: 'bot', senderId: 'atlas', text: 'All set.', at: at(60000)}]}});
  assert.equal(rowFor(later).mark.kind, 'unread');
});
