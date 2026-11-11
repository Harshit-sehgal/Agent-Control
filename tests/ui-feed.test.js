import test from 'node:test';
import assert from 'node:assert/strict';
import {feed, runsOfChat} from '../shared/ui-feed.js';
import {timeline} from '../shared/ui-model.js';

const bot = (id, name, settings = {}) => ({id, name, instructions: `${name} does a job.`, settings});
const atlas = bot('atlas', 'Atlas', {lead: true});
const plan = bot('plan', 'Planner', {reportsTo: 'atlas'});
const KEY = 'team-th-1';
const at = n => `2026-11-11T10:00:${String(n).padStart(2, '0')}Z`;
const msg = (id, role, n, extra = {}) => ({id, role, at: at(n), text: id, ...extra});
const run = (extra = {}) => ({id: 'r1', groupId: 'th-1', status: 'completed', recipients: ['atlas', 'plan', 'atlas'], currentStep: 3, createdAt: at(1), trace: [
  {botId: 'atlas', output: '@Planner plan it'}, {botId: 'plan', output: 'Wednesday is free.'}, {botId: 'atlas', output: 'Done: Wednesday.'},
], ...extra});
const stateOf = (runs = [], messages = []) => ({groups: [{id: 'home', bots: [atlas, plan], settings: {}}, {id: 'th-1', bots: [], settings: {kind: 'thread'}}], groupRuns: runs, chats: {[KEY]: messages}, browserRequests: []});
const build = (messages, runs = [], key = KEY) => {
  const state = stateOf(runs, messages);
  return feed({items: timeline({conv: {id: key}, state, messages: {[key]: messages}}), state, key});
};
const kinds = entries => entries.map(e => e.kind);

test('owner lines and bot replies become me and bot entries under a day divider', () => {
  const out = build([msg('q', 'user', 1), msg('a', 'bot', 2, {senderId: 'atlas', senderName: 'Atlas'})]);
  assert.deepEqual(kinds(out), ['day', 'me', 'bot']);
  assert.equal(out[2].message.id, 'a');
});

test('a finished run with handoffs shows one quiet pill before the lead\'s last reply and hides the helpers\' lines', () => {
  const out = build([
    msg('q', 'user', 1),
    msg('h', 'bot', 2, {senderId: 'atlas', runId: 'r1'}),
    msg('p', 'bot', 3, {senderId: 'plan', runId: 'r1'}),
    msg('f', 'bot', 4, {senderId: 'atlas', runId: 'r1'}),
  ], [run()]);
  assert.deepEqual(kinds(out), ['day', 'me', 'pill', 'bot']);
  assert.equal(out[2].pill.done, true);
  assert.equal(out[2].pill.text, 'Planner helped · 2 messages');
  assert.equal(out[2].handoffs.length, 2);
  assert.equal(out[3].message.id, 'f');
});

test('a live run shows the progress pill and keeps its lines back until it ends', () => {
  const live = run({status: 'running', currentStep: 1, trace: [{botId: 'atlas', output: '@Planner plan it'}]});
  const out = build([msg('q', 'user', 1), msg('h', 'bot', 2, {senderId: 'atlas', runId: 'r1'})], [live]);
  assert.deepEqual(kinds(out), ['day', 'me', 'pill']);
  assert.equal(out[2].pill.text, 'Planner is on it');
});

test('a live run with no line yet puts its pill last', () => {
  const out = build([msg('q', 'user', 1)], [run({status: 'running', recipients: ['atlas'], trace: [], currentStep: 0})]);
  assert.deepEqual(kinds(out), ['day', 'me', 'pill']);
  assert.equal(out[2].pill.text, 'Atlas is working out who does what');
});

test('a run where one bot did everything leaves its lines alone and adds no pill', () => {
  const solo = run({recipients: ['atlas'], trace: [{botId: 'atlas', output: 'Hi'}]});
  const out = build([msg('q', 'user', 1), msg('a', 'bot', 2, {senderId: 'atlas', runId: 'r1'})], [solo]);
  assert.deepEqual(kinds(out), ['day', 'me', 'bot']);
});

test('a bot that answered alone in its own chat leaves no "helped" pill', () => {
  const alone = run({chatKey: 'plan', recipients: ['plan'], trace: [{botId: 'plan', output: 'Hi'}]});
  const out = build([msg('q', 'user', 1), msg('a', 'bot', 2, {senderId: 'plan', runId: 'r1'})], [alone], 'plan');
  assert.deepEqual(kinds(out), ['day', 'me', 'bot']);
});

test('a failed run keeps every line, and only the newest note of a run carries the run', () => {
  const failed = run({status: 'failed', error: 'no key'});
  const out = build([
    msg('q', 'user', 1),
    msg('p', 'bot', 2, {senderId: 'plan', runId: 'r1'}),
    msg('n1', 'system', 3, {runId: 'r1'}),
    msg('n2', 'system', 4, {runId: 'r1'}),
  ], [failed]);
  assert.deepEqual(kinds(out), ['day', 'me', 'bot', 'note', 'note']);
  assert.equal(out[3].run, null);
  assert.equal(out[4].run.id, 'r1');
});

test('the "Done in N steps" note of a completed run is dropped: the pill says it', () => {
  const out = build([msg('q', 'user', 1), msg('d', 'system', 5, {runId: 'r1', id: 'r1-completed'})], [run()]);
  assert.ok(!kinds(out).includes('note'));
});

test('a run waiting at a limit ends the feed with the checkpoint card, not a pill', () => {
  const paused = run({status: 'awaiting_limit', limit: {kind: 'pair', at: 12}});
  const out = build([msg('q', 'user', 1)], [paused]);
  assert.deepEqual(kinds(out), ['day', 'me', 'limit']);
  assert.equal(out[2].run.id, 'r1');
});

test('an out-of-job reply keeps its buttons until something is said after it', () => {
  const offjob = msg('o', 'bot', 2, {senderId: 'plan', kind: 'offjob', request: 'Book a table', botId: 'plan'});
  assert.equal(build([msg('q', 'user', 1), offjob]).at(-1).open, true);
  assert.equal(build([msg('q', 'user', 1), offjob, msg('q2', 'user', 3)]).find(e => e.kind === 'offjob').open, false);
  // "Do it anyway" answers with a plain reply and no new owner line.
  assert.equal(build([msg('q', 'user', 1), offjob, msg('a', 'bot', 3, {senderId: 'plan'})]).find(e => e.kind === 'offjob').open, false);
  // A system line (a run note) does not settle it.
  assert.equal(build([msg('q', 'user', 1), offjob, msg('n', 'system', 3)]).find(e => e.kind === 'offjob').open, true);
});

test('a browser card keeps its own kind', () => {
  assert.ok(kinds(build([msg('b', 'system', 2, {kind: 'browser'})])).includes('browser'));
});

test('runs of other chats are ignored', () => {
  const other = run({chatKey: 'plan', id: 'r2'});
  assert.deepEqual(runsOfChat(stateOf([other, run()]), KEY).map(r => r.id), ['r1']);
  assert.deepEqual(runsOfChat(stateOf([other, run()]), 'plan').map(r => r.id), ['r2']);
});

test('the "N messages" note a paused run writes is dropped: its card says it', () => {
  const paused = run({status: 'awaiting_limit', limit: {kind: 'pair', at: 12}, asks: {total: 12}});
  const out = build([msg('q', 'user', 1), msg('l', 'system', 2, {runId: 'r1', kind: 'limit'})], [paused]);
  assert.deepEqual(kinds(out), ['day', 'me', 'limit']);
});

test('the runaway guard line asks Keep going or Stop only while bots are still paused, and only its newest line asks', () => {
  const lines = [msg('q', 'user', 1), msg('g1', 'system', 2, {kind: 'guard'}), msg('g2', 'system', 3, {kind: 'guard'})];
  const state = {...stateOf([], lines), guard: {paused: true}};
  const open = feed({items: timeline({conv: {id: KEY}, state, messages: {[KEY]: lines}}), state, key: KEY}).filter(e => e.kind === 'guard');
  assert.deepEqual(open.map(e => e.open), [false, true]);
  const resumed = {...state, guard: {paused: false}};
  const done = feed({items: timeline({conv: {id: KEY}, state: resumed, messages: {[KEY]: lines}}), state: resumed, key: KEY}).filter(e => e.kind === 'guard');
  assert.deepEqual(done.map(e => e.open), [false, false]);
});
