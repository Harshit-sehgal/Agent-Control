/** The clean feed: a conversation shows the owner's lines, the final answers,
 * the cards that need the owner and the failures that ended a run. Browsing,
 * connector use and the bot-to-bot traffic of a run fold into one status line. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {feed} from '../shared/ui-feed.js';
import {timeline} from '../shared/ui-model.js';

const bot = (id, name, settings = {}) => ({id, name, instructions: `${name} does a job.`, settings});
const bots = [bot('atlas', 'Atlas', {lead: true}), bot('scout', 'Scout', {reportsTo: 'atlas'}), bot('ranker', 'Ranker', {reportsTo: 'atlas'})];
const KEY = 'team-th-1';
const at = n => `2026-11-11T10:00:${String(n).padStart(2, '0')}Z`;
const msg = (id, role, n, extra = {}) => ({id, role, at: at(n), text: id, ...extra});
const sys = (id, n, extra = {}) => msg(id, 'system', n, extra);
const stateOf = (runs, messages, extra = {}) => ({groups: [{id: 'home', bots, settings: {}}, {id: 'th-1', bots: [], settings: {kind: 'thread'}}], groupRuns: runs, chats: {[KEY]: messages}, browserRequests: [], ...extra});
const build = (messages, runs = [], extra = {}) => {
  const state = stateOf(runs, messages, extra);
  return feed({items: timeline({conv: {id: KEY}, state, messages: {[KEY]: messages}}), state, key: KEY, now: Date.parse(at(10))});
};
const kinds = entries => entries.filter(e => e.kind !== 'day').map(e => e.kind);
const ids = entries => entries.filter(e => e.message).map(e => e.message.id);

// Three hops: Atlas asks Scout, Scout passes to Ranker, Ranker hands back to Atlas, who answers the owner.
const hopsTrace = [
  {botId: 'atlas', output: '@Scout find it', toBotId: 'scout'},
  {botId: 'scout', output: 'Found three.', toBotId: 'ranker'},
  {botId: 'ranker', output: 'Ranked them.', toBotId: 'atlas'},
  {botId: 'atlas', output: 'Here are the top three.'},
];
const hopRun = (extra = {}) => ({id: 'r1', groupId: 'th-1', status: 'completed', recipients: ['atlas', 'scout', 'ranker', 'atlas'], currentStep: 4, createdAt: at(1), trace: hopsTrace, ...extra});
const hopLines = [
  msg('q', 'user', 1),
  msg('h1', 'bot', 2, {senderId: 'atlas', senderName: 'Atlas', toBotId: 'scout', runId: 'r1'}),
  msg('h2', 'bot', 3, {senderId: 'scout', senderName: 'Scout', toBotId: 'ranker', runId: 'r1'}),
  msg('h3', 'bot', 4, {senderId: 'ranker', senderName: 'Ranker', toBotId: 'atlas', runId: 'r1'}),
];

test('browsing and connector chatter is hidden from the feed', () => {
  const out = build([
    msg('q', 'user', 1),
    sys('browser-x', 2, {kind: 'browser', text: 'Scout wants to read example.com.'}),
    sys('b2', 3, {kind: 'browser-result', text: 'Browser result for Scout: Example · https://example.com\n\nPage text'}),
    sys('b3', 3, {kind: 'browser-result', text: "Scout's browser request failed: The page did not finish loading within 25s."}),
    sys('b4', 4, {text: 'Scout already has that page, so it was not opened again.'}),
    sys('b5', 4, {text: 'Scout asked for another web page, but 3 browsing rounds in a row is the limit. Ask again to continue.'}),
    sys('b6', 4, {text: 'Scout asked for a web page, but the request was refused: not a web address'}),
    sys('c1', 5, {kind: 'connector', connectorId: 'g', text: 'Scout used Notes: search.'}),
    sys('c2', 5, {kind: 'connector-error', text: 'Scout could not use Notes: add.'}),
    sys('c3', 5, {text: 'Scout asked to use a connector again, but 3 connector rounds in a row is the limit. Ask again to continue.'}),
    sys('p1', 6, {kind: 'peer', runId: 'r9', text: 'Atlas asked Scout: find it'}),
    sys('g1', 6, {origin: 'browser', text: 'Passing this to the group.'}),
    msg('a', 'bot', 7, {senderId: 'scout', senderName: 'Scout'}),
  ]);
  assert.deepEqual(kinds(out), ['me', 'bot']);
});

test('the plain "Done in N step(s)." note is hidden, even when its run is gone', () => {
  const out = build([msg('q', 'user', 1), sys('gone-completed', 2, {runId: 'gone', text: 'Done in 3 step(s).'}), msg('a', 'bot', 3, {senderId: 'atlas'})]);
  assert.deepEqual(kinds(out), ['me', 'bot']);
});

test('the cards that need the owner and the lines that matter stay', () => {
  const failed = {id: 'rf', groupId: 'th-1', status: 'failed', recipients: ['atlas'], trace: [], createdAt: at(1), error: 'no key'};
  const out = build([
    msg('q', 'user', 1),
    sys('ask-a1', 2, {kind: 'ask', askId: 'a1', text: 'Needs you: Scout wants to read example.com.'}),
    sys('s1', 3, {kind: 'setup', text: 'Scout suggests: a schedule', setup: '{}'}),
    sys('m1', 3, {kind: 'model-limit', botId: 'atlas', text: 'Atlas hit its limit.'}),
    sys('n1', 3, {kind: 'no-model', text: 'Atlas needs a model.'}),
    sys('u1', 4, {kind: 'connector', connectorId: 'g', text: 'Atlas is sending an email.', activityId: 'act-1', undoUntil: at(30)}),
    sys('send-act-2', 4, {kind: 'connector-error', text: "Atlas's email to a@b.c was not sent: the server restarted before it went out. Ask again."}),
    sys('k1', 4, {kind: 'bot-created', runId: 'rk', text: 'Atlas created a new bot for this work: Job scout.'}),
    sys('g1', 5, {kind: 'guard', text: 'Bots are paused.'}),
    msg('o1', 'bot', 6, {senderId: 'scout', kind: 'offjob', botId: 'scout', request: 'Book a table'}),
    sys('rf-failed', 7, {runId: 'rf', text: 'The run failed: no key'}),
  ], [failed], {asks: [{id: 'a1', botId: 'scout', status: 'pending', action: 'browser.use'}]});
  assert.deepEqual(kinds(out), ['me', 'ask', 'setup', 'model-limit', 'no-model', 'connector', 'connector', 'note', 'guard', 'offjob', 'note']);
  assert.equal(out.at(-1).run?.id, 'rf', 'the failure note keeps its run, so it can offer Retry');
});

test('a page request still waiting on a person keeps its card; a finished one is hidden', () => {
  const line = sys('browser-br1', 2, {kind: 'browser', text: 'Scout wants to open a page.'});
  const pending = build([msg('q', 'user', 1), line], [], {browserRequests: [{id: 'br1', status: 'pending', url: 'https://example.com/'}]});
  assert.deepEqual(kinds(pending), ['me', 'browser']);
  const done = build([msg('q', 'user', 1), line], [], {browserRequests: [{id: 'br1', status: 'done', url: 'https://example.com/'}]});
  assert.deepEqual(kinds(done), ['me']);
});

test('a finished run with three hops collapses into one line naming the latest hop, holding every hop', () => {
  const out = build([...hopLines, msg('f', 'bot', 5, {senderId: 'atlas', senderName: 'Atlas', runId: 'r1'})], [hopRun()]);
  assert.deepEqual(kinds(out), ['me', 'pill', 'bot']);
  const line = out.find(e => e.kind === 'pill');
  assert.equal(line.pill.done, true);
  assert.equal(line.pill.text, 'Ranker messaged Atlas');
  assert.deepEqual(line.handoffs.map(h => [h.from, h.to, h.text]), [
    ['atlas', 'scout', '@Scout find it'], ['scout', 'ranker', 'Found three.'], ['ranker', 'atlas', 'Ranked them.'],
  ]);
  assert.equal(out.at(-1).message.id, 'f', 'only the final answer is a bubble');
});

test('a live run shows one line with the latest hop in progress, and it can open the hops so far', () => {
  const live = hopRun({status: 'running', currentStep: 2, trace: hopsTrace.slice(0, 2)});
  const out = build(hopLines.slice(0, 3), [live]);
  assert.deepEqual(kinds(out), ['me', 'pill']);
  const line = out[2];
  assert.equal(line.pill.done, undefined);
  assert.equal(line.pill.text, 'Checking with Ranker');
  assert.equal(line.handoffs.length, 2);
});

test('a run that failed after its hops keeps the failure visible under one muted hop line', () => {
  const failed = hopRun({status: 'failed', currentStep: 2, trace: hopsTrace.slice(0, 2), error: 'AI provider returned 502: bad'});
  const out = build([
    ...hopLines.slice(0, 3),
    sys('bx', 4, {kind: 'browser-result', text: "Ranker's browser request failed: timeout"}),
    sys('r1-failed', 5, {runId: 'r1', text: 'The run failed: the model provider had an error (502).'}),
  ], [failed]);
  assert.deepEqual(kinds(out), ['me', 'pill', 'note']);
  assert.equal(out[2].pill.done, true);
  assert.equal(out[2].pill.text, 'Scout messaged Ranker');
  assert.equal(out[3].message.id, 'r1-failed');
  assert.equal(out[3].run?.id, 'r1');
  assert.ok(!ids(out).includes('h1') && !ids(out).includes('h2'));
});

test('a run waiting on an ask keeps its card and still folds its hops into one line', () => {
  const waiting = hopRun({status: 'awaiting_ask', currentStep: 2, trace: hopsTrace.slice(0, 2), askIds: ['a1']});
  const out = build([...hopLines.slice(0, 3), sys('ask-a1', 4, {kind: 'ask', askId: 'a1', runId: 'r1'})], [waiting], {asks: [{id: 'a1', botId: 'scout', status: 'pending', action: 'send'}]});
  assert.deepEqual(kinds(out), ['me', 'pill', 'ask']);
  assert.equal(out[2].pill.text, 'Scout messaged Ranker');
});

test('an ask card leaves the chat once it is answered, whatever the answer', () => {
  const line = sys('ask-a1', 2, {kind: 'ask', askId: 'a1', text: 'Scout wants to send an email.'});
  const asks = status => ({asks: [{id: 'a1', botId: 'scout', status, action: 'send'}]});
  assert.deepEqual(kinds(build([msg('q', 'user', 1), line], [], asks('pending'))), ['me', 'ask']);
  for (const status of ['allowed', 'declined']) assert.deepEqual(kinds(build([msg('q', 'user', 1), line], [], asks(status))), ['me'], status);
  assert.deepEqual(kinds(build([msg('q', 'user', 1), line])), ['me'], 'an ask the state no longer holds is gone too');
});
