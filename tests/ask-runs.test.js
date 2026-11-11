/** Runs wait on the owner's answer (Phase 3, Task 2).
 *
 * A bot that needs a page asks the owner instead of answering "I don't have
 * permission". The run parks as `awaiting_ask`, holds nothing, and goes on when
 * the owner answers: Allow once, Always allow for this bot, or Decline (the bot
 * gets one closing turn). The model is scripted, the browser is a fake, and the
 * run loop, the store and the answer flow are the real ones.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRouter} from '../src/router.js';
import {groupRoutes} from '../src/routes-groups.js';
import {cancelRun, markInterrupted, resumeBrowserRun} from '../src/coordination.js';
import {setBrowserResultHooks} from '../src/bot-browser.js';
import {browserRuntime} from '../src/browser-runtime.js';
import {answerAskFlow, expirePendingAsks} from '../src/ask-runs.js';
import {grantFor, setGrant, pendingAsks} from '../shared/asks.js';
import {BUSY_STATUSES, STOPPABLE_STATUSES, INTERRUPT_STATUSES} from '../shared/run-state.js';
import {chatIsBusy} from '../shared/coordination.js';
import {company, model, ask} from './run-fixture.js';

const fence = (url, steps) => `One moment.\n\`\`\`browser\n${JSON.stringify(steps ? {url, steps} : {url})}\n\`\`\``;
const until = async (check, note) => {
  for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`timed out waiting for ${note}`);
};
const opened = [];
const realRun = browserRuntime.run, realAvailable = browserRuntime.available;
const useFakeBrowser = t => {
  opened.length = 0;
  browserRuntime.available = () => true;
  browserRuntime.run = async request => { opened.push(request.url); return {title: 'Docs', finalUrl: request.url, text: `Page at ${request.url}`}; };
  t.after(() => { browserRuntime.available = realAvailable; browserRuntime.run = realRun; });
};
/** What the engine does when a page comes back: the same hooks the server registers, with the scripted model. */
const wire = executor => setBrowserResultHooks({
  continueRun: async () => {},
  resumeBrowser: (store, request, options) => resumeBrowserRun(store, request, {...options, executor}),
});
const runOf = (store, id) => store.read().groupRuns.find(r => r.id === id);
const lines = (store, key, kind) => (store.read().chats[key] || []).filter(m => m.kind === kind);

/** Mailroom browses on its first turn and writes up the page on its next. */
const browsing = (url, extra = {}) => model({Mailroom: envelope => (envelope.page || envelope.declined ? (envelope.declined ? `I could not look: ${envelope.declined}` : `Read it: ${envelope.page}`) : fence(url)), ...extra});

test('awaiting_ask is busy and stoppable, and a restart leaves it where it is', () => {
  assert.ok(BUSY_STATUSES.includes('awaiting_ask'));
  assert.ok(STOPPABLE_STATUSES.includes('awaiting_ask'));
  assert.ok(!INTERRUPT_STATUSES.includes('awaiting_ask'), 'it survives a restart');
});

test('a bot with no grant asks the owner; the run parks and holds no page', async t => {
  useFakeBrowser(t);
  const {store, ids} = await company(t);
  const ai = browsing('https://docs.example.com/guide');
  wire(ai.executor);
  const run = await ask(store, {message: 'Look up the guide', to: ids.mail, executor: ai.executor});
  assert.equal(run.status, 'awaiting_ask');
  const state = store.read();
  assert.equal(state.asks.length, 1);
  const [card] = state.asks;
  assert.equal(card.status, 'pending');
  assert.equal(card.action, 'browser.use');
  assert.equal(card.botId, ids.mail);
  assert.equal(card.runId, run.id);
  assert.equal(card.grantScope, 'https://docs.example.com');
  assert.deepEqual(run.askIds, [card.id]);
  assert.equal(state.browserRequests[0].status, 'pending', 'nothing was opened; the request waits');
  assert.equal(state.browserRequests[0].askId, card.id);
  assert.deepEqual(opened, []);
  assert.equal(ai.of('Mailroom').length, 1, 'the bot is not asked again while the owner decides');
  assert.ok(chatIsBusy(state.groupRuns, state.groups[0], ids.mail), 'the chat is busy while an ask waits');
  // The card is in the chat the bot works in, and Atlas gets a "Needs you" line too.
  const mine = lines(store, ids.mail, 'ask');
  assert.equal(mine.length, 1);
  assert.equal(mine[0].askId, card.id);
  assert.match(mine[0].text, /Mailroom wants to read docs\.example\.com/);
  const needs = lines(store, 'atlas', 'ask');
  assert.equal(needs.length, 1);
  assert.equal(needs[0].askId, card.id);
  assert.deepEqual(pendingAsks(state).map(a => a.id), [card.id]);
});

test('Allow once opens the page, resumes the run with it, and leaves no grant', async t => {
  useFakeBrowser(t);
  const {store, ids} = await company(t);
  const ai = browsing('https://docs.example.com/guide');
  wire(ai.executor);
  const run = await ask(store, {message: 'Look up the guide', to: ids.mail, executor: ai.executor});
  const [card] = store.read().asks;
  const answered = await answerAskFlow(store, card.id, 'allow', {actor: 'owner@example.test', executor: ai.executor});
  assert.equal(answered.ask.status, 'allowed');
  await until(() => runOf(store, run.id).status === 'completed', 'the run to finish');
  assert.deepEqual(opened, ['https://docs.example.com/guide']);
  assert.match(ai.of('Mailroom')[1].page, /Page at https:\/\/docs\.example\.com\/guide/);
  assert.equal(grantFor(store.read(), ids.mail, 'browser.use', 'https://docs.example.com'), null);
  assert.deepEqual(runOf(store, run.id).askIds || [], [], 'nothing is left waiting');
  // A second run asks again.
  const again = await ask(store, {message: 'And once more', to: ids.mail, executor: ai.executor});
  assert.equal(again.status, 'awaiting_ask');
});

test('Always allow stores the grant, and the next run goes without asking; another site still asks', async t => {
  useFakeBrowser(t);
  const {store, ids} = await company(t);
  const ai = browsing('https://docs.example.com/guide');
  wire(ai.executor);
  const first = await ask(store, {message: 'Look up the guide', to: ids.mail, executor: ai.executor});
  await answerAskFlow(store, store.read().asks[0].id, 'always', {actor: 'owner@example.test', executor: ai.executor});
  await until(() => runOf(store, first.id).status === 'completed', 'the first run to finish');
  assert.equal(grantFor(store.read(), ids.mail, 'browser.use', 'https://docs.example.com'), 'always');
  assert.equal(store.read().asks[0].scope, 'always');
  const second = await ask(store, {message: 'Again please', to: ids.mail, executor: ai.executor});
  assert.equal(store.read().asks.length, 1, 'no second ask for a site the bot is always allowed on');
  await until(() => runOf(store, second.id).status === 'completed', 'the second run to finish unasked');
  assert.equal(opened.length, 2);
  // Another origin is another question, and another bot never inherited it.
  const other = model({Mailroom: e => (e.page ? 'ok' : fence('https://other.example.org/x'))});
  const third = await ask(store, {message: 'Somewhere else', to: ids.mail, executor: other.executor});
  assert.equal(third.status, 'awaiting_ask');
  const scholar = model({Scholar: e => (e.page ? 'ok' : fence('https://docs.example.com/guide'))});
  const fourth = await ask(store, {message: 'Same site, other bot', to: ids.scholar, executor: scholar.executor});
  assert.equal(fourth.status, 'awaiting_ask', 'a grant is per bot');
});

test('Decline gives the bot one closing turn that says what was declined, and opens nothing', async t => {
  useFakeBrowser(t);
  const {store, ids} = await company(t);
  // The closing reply tries to browse again; the engine opens nothing for it.
  const ai = model({Mailroom: envelope => (envelope.declined ? `${fence('https://docs.example.com/again')}\nI could not look. ${envelope.declined}` : fence('https://docs.example.com/guide'))});
  wire(ai.executor);
  const run = await ask(store, {message: 'Look up the guide', to: ids.mail, executor: ai.executor});
  const [card] = store.read().asks;
  await answerAskFlow(store, card.id, 'decline', {actor: 'owner@example.test', executor: ai.executor});
  await until(() => runOf(store, run.id).status === 'completed', 'the closing turn to finish');
  assert.equal(ai.of('Mailroom').length, 2, 'exactly one closing turn');
  assert.match(ai.of('Mailroom')[1].declined, /The owner declined: read docs\.example\.com/);
  assert.match(ai.of('Mailroom')[1].restrictions.join('\n'), /Do not ask for it again/);
  assert.deepEqual(opened, []);
  assert.equal(store.read().browserRequests.filter(r => r.status === 'pending' || r.status === 'dispatched').length, 0);
  assert.equal(store.read().browserRequests.find(r => r.url.endsWith('/guide')).status, 'denied');
  assert.equal(store.read().asks.length, 1, 'the closing reply could not start a second ask');
  assert.equal(grantFor(store.read(), ids.mail, 'browser.use', 'https://docs.example.com'), null);
});

test('Review focus 3: a Deny grant stops the bot, says where to change it, and never loops', async t => {
  useFakeBrowser(t);
  const {store, ids} = await company(t);
  await store.update(s => { setGrant(s, ids.mail, 'browser.use', 'https://docs.example.com', 'deny'); });
  const ai = model({Mailroom: fence('https://docs.example.com/guide')});
  wire(ai.executor);
  const run = await ask(store, {message: 'Look up the guide', to: ids.mail, executor: ai.executor});
  assert.equal(run.status, 'completed');
  assert.equal(ai.of('Mailroom').length, 1, 'one model call: no retry');
  assert.deepEqual(store.read().asks, [], 'a Deny is not asked about');
  assert.deepEqual(store.read().browserRequests, []);
  const said = (store.read().chats[ids.mail] || []).filter(m => m.role === 'system').map(m => m.text).join('\n');
  assert.match(said, /Mailroom's profile → Permissions/);
  assert.deepEqual(opened, []);
});

test('Review focus 1: an answer after the run was stopped is recorded and resumes nothing', async t => {
  useFakeBrowser(t);
  const {store, ids} = await company(t);
  const ai = browsing('https://docs.example.com/guide');
  wire(ai.executor);
  const run = await ask(store, {message: 'Look up the guide', to: ids.mail, executor: ai.executor});
  const [card] = store.read().asks;
  await cancelRun(store, run.id);
  assert.equal(runOf(store, run.id).status, 'cancelled');
  assert.ok(store.read().asks[0].expiresAt, 'the orphaned ask will lapse');
  const answered = await answerAskFlow(store, card.id, 'always', {actor: 'owner@example.test', executor: ai.executor});
  assert.equal(answered.ask.status, 'allowed');
  assert.equal(runOf(store, run.id).status, 'cancelled', 'nothing resumed');
  assert.deepEqual(opened, [], 'and nothing was opened');
  assert.equal(ai.of('Mailroom').length, 1);
  assert.equal(grantFor(store.read(), ids.mail, 'browser.use', 'https://docs.example.com'), 'always', 'the owner\'s choice still stands');
});

test('Review focus 1: an ask whose bot was deleted is answered and nothing crashes', async t => {
  useFakeBrowser(t);
  const {store, ids} = await company(t);
  const ai = browsing('https://docs.example.com/guide');
  wire(ai.executor);
  await ask(store, {message: 'Look up the guide', to: ids.mail, executor: ai.executor});
  const [card] = store.read().asks;
  const wf = await import('../shared/workflow.js');
  await store.update(s => wf.removeBot(s, 'home', ids.mail));
  const out = await answerAskFlow(store, card.id, 'always', {actor: 'owner@example.test', executor: ai.executor});
  assert.equal(out.ask.status, 'allowed');
  assert.equal(grantFor(store.read(), ids.mail, 'browser.use', 'https://docs.example.com'), null, 'no grant for a bot that is gone');
});

test('Review focus 4: two asks in one run, answered out of order, resume it once after the last', async t => {
  useFakeBrowser(t);
  const {store, ids} = await company(t);
  const ai = model({Mailroom: envelope => (envelope.page ? `Read: ${envelope.page}` : `${fence('https://a.example.com/x')}\n${fence('https://b.example.com/y')}`)});
  wire(ai.executor);
  const run = await ask(store, {message: 'Check both', to: ids.mail, executor: ai.executor});
  assert.equal(run.status, 'awaiting_ask');
  const [one, two] = store.read().asks;
  assert.equal(store.read().asks.length, 2);
  assert.deepEqual(runOf(store, run.id).askIds.sort(), [one.id, two.id].sort());
  await answerAskFlow(store, two.id, 'allow', {actor: 'owner@example.test', executor: ai.executor});
  assert.equal(runOf(store, run.id).status, 'awaiting_ask', 'the first answer alone does not resume it');
  assert.deepEqual(opened, [], 'and nothing opens until the run is released');
  await answerAskFlow(store, one.id, 'allow', {actor: 'owner@example.test', executor: ai.executor});
  await until(() => runOf(store, run.id).status === 'completed', 'the run to finish');
  assert.deepEqual([...opened].sort(), ['https://a.example.com/x', 'https://b.example.com/y']);
  assert.match(ai.of('Mailroom')[1].page, /a\.example\.com/);
  assert.match(ai.of('Mailroom')[1].page, /b\.example\.com/);
});

test('one of two declined: the page that was allowed still comes back, with the decline noted', async t => {
  useFakeBrowser(t);
  const {store, ids} = await company(t);
  const ai = model({Mailroom: envelope => (envelope.page || envelope.declined ? `Page: ${envelope.page}; ${envelope.declined || ''}` : `${fence('https://a.example.com/x')}\n${fence('https://b.example.com/y')}`)});
  wire(ai.executor);
  const run = await ask(store, {message: 'Check both', to: ids.mail, executor: ai.executor});
  const [one, two] = store.read().asks;
  await answerAskFlow(store, one.id, 'allow', {actor: 'owner@example.test', executor: ai.executor});
  await answerAskFlow(store, two.id, 'decline', {actor: 'owner@example.test', executor: ai.executor});
  await until(() => runOf(store, run.id).status === 'completed', 'the run to finish');
  assert.deepEqual(opened, ['https://a.example.com/x']);
  assert.match(ai.of('Mailroom')[1].page, /a\.example\.com/);
  assert.match(ai.of('Mailroom')[1].declined, /b\.example\.com/);
});

test('an ask from an unattended run lapses after 24 hours as declined, and the bot reports', async t => {
  useFakeBrowser(t);
  const {store, ids} = await company(t);
  const ai = browsing('https://docs.example.com/guide');
  wire(ai.executor);
  const run = await ask(store, {message: 'Scheduled look', to: ids.mail, executor: ai.executor, extra: {unattended: true}});
  assert.equal(run.status, 'awaiting_ask');
  const [card] = store.read().asks;
  assert.ok(card.expiresAt, 'the timer\'s ask carries its expiry');
  assert.deepEqual((await expirePendingAsks(store, {now: new Date(Date.parse(card.createdAt) + 23 * 3600000).toISOString(), executor: ai.executor})).expired, []);
  const out = await expirePendingAsks(store, {now: new Date(Date.parse(card.createdAt) + 25 * 3600000).toISOString(), executor: ai.executor});
  assert.deepEqual(out.expired.map(a => a.id), [card.id]);
  await until(() => runOf(store, run.id).status === 'completed', 'the run to finish');
  const done = store.read().asks[0];
  assert.equal(done.status, 'declined');
  assert.equal(done.expired, true);
  assert.match(ai.of('Mailroom')[1].declined, /declined/);
  assert.deepEqual(opened, []);
});

test('an ask in the owner\'s own conversation does not expire', async t => {
  useFakeBrowser(t);
  const {store, ids} = await company(t);
  const ai = browsing('https://docs.example.com/guide');
  await ask(store, {message: 'Look up the guide', to: ids.mail, executor: ai.executor});
  const out = await expirePendingAsks(store, {now: '2099-01-01T00:00:00.000Z', executor: ai.executor});
  assert.deepEqual(out.expired, []);
  assert.equal(store.read().asks[0].status, 'pending');
});

test('Stop works on a run waiting for an answer, and a restart leaves it waiting', async t => {
  useFakeBrowser(t);
  const {store, ids} = await company(t);
  const ai = browsing('https://docs.example.com/guide');
  const waiting = await ask(store, {message: 'Look up the guide', to: ids.mail, executor: ai.executor});
  await markInterrupted(store);
  assert.equal(runOf(store, waiting.id).status, 'awaiting_ask', 'a restart does not cut it');
  assert.equal(store.read().asks[0].status, 'pending');
  await cancelRun(store, waiting.id);
  assert.equal(runOf(store, waiting.id).status, 'cancelled');
});

test('a request that classifies as a send, post, delete or payment asks about that, not just the page', async t => {
  useFakeBrowser(t);
  const {store, ids} = await company(t);
  const click = steps => model({Mailroom: fence('https://mail.example.com/compose', steps)});
  const run = await ask(store, {message: 'Send it', to: ids.mail, executor: click([{op: 'type', selector: '#body', text: 'hello'}, {op: 'click', selector: 'button[type=submit]'}]).executor});
  assert.equal(run.status, 'awaiting_ask');
  assert.equal(store.read().asks[0].action, 'send');
  const pay = await ask(store, {message: 'Buy it', to: ids.scholar, executor: model({Scholar: fence('https://shop.example.com/cart', [{op: 'click', selector: '#pay-now'}])}).executor});
  assert.equal(pay.status, 'awaiting_ask');
  const spend = store.read().asks.find(a => a.botId === ids.scholar);
  assert.equal(spend.action, 'spend');
  // A payment can only be allowed once, never always: the route says so.
  await assert.rejects(answerAskFlow(store, spend.id, 'always', {actor: 'owner@example.test'}), e => e.status === 400);
  assert.equal(store.read().asks.find(a => a.id === spend.id).status, 'pending');
  // Always allow on the send also covers reading that site, so the bot is not asked twice for one request.
  const send = store.read().asks.find(a => a.action === 'send');
  await answerAskFlow(store, send.id, 'always', {actor: 'owner@example.test', executor: model().executor});
  assert.equal(grantFor(store.read(), ids.mail, 'send', ''), 'always');
  assert.equal(grantFor(store.read(), ids.mail, 'browser.use', 'https://mail.example.com'), 'always');
});

test('a push notification goes out for a new ask', async t => {
  useFakeBrowser(t);
  const {store, ids} = await company(t);
  const sent = [];
  store.notify = async event => { sent.push(event); };
  const ai = browsing('https://docs.example.com/guide');
  await ask(store, {message: 'Look up the guide', to: ids.mail, executor: ai.executor});
  await until(() => sent.length, 'the notification');
  assert.match(sent[0].title, /Mailroom/);
  assert.match(sent[0].body, /docs\.example\.com/);
  assert.equal(sent[0].meta.askId, store.read().asks[0].id);
  // A notifier that throws never fails the run.
  store.notify = async () => { throw new Error('push is down'); };
  const run = await ask(store, {message: 'Another', to: ids.scholar, executor: model({Scholar: fence('https://x.example.com/')}).executor});
  assert.equal(run.status, 'awaiting_ask');
});

test('the routes: only an admin answers or grants, and the old approve/deny routes are aliases', async t => {
  useFakeBrowser(t);
  const router = createRouter();
  groupRoutes(router, {});
  assert.equal(router.find('POST', '/api/asks/abc').route.access, 'admin');
  assert.equal(router.find('POST', '/api/grants').route.access, 'admin');
  const {store, ids} = await company(t);
  const ai = browsing('https://docs.example.com/guide');
  wire(ai.executor);
  const run = await ask(store, {message: 'Look up the guide', to: ids.mail, executor: ai.executor});
  const [card] = store.read().asks;
  const call = (method, path, body) => {
    const found = router.find(method, path);
    return found.route.handler({store, params: found.params, actor: {email: 'owner@example.test'}, body: async () => body});
  };
  await assert.rejects(call('POST', `/api/asks/${card.id}`, {answer: 'sometimes'}), e => e.status === 400);
  await assert.rejects(call('POST', '/api/asks/nope', {answer: 'allow'}), e => e.status === 404);
  // The old approve route answers the same ask: it is Allow.
  const requestId = store.read().browserRequests[0].id;
  await call('POST', `/api/browser-requests/${requestId}/approve`, {});
  assert.equal(store.read().asks[0].status, 'allowed');
  assert.equal(store.read().asks[0].scope, 'once');
  await until(() => runOf(store, run.id).status === 'completed', 'the run to finish');
  await assert.rejects(call('POST', `/api/asks/${card.id}`, {answer: 'allow'}), e => e.status === 409);
  // Deny is Decline.
  const second = await ask(store, {message: 'Again', to: ids.mail, executor: ai.executor});
  const reqTwo = store.read().browserRequests.find(r => r.status === 'pending');
  await call('POST', `/api/browser-requests/${reqTwo.id}/deny`, {});
  // The closing turn runs on the real executor here (the route takes none), which has no AI: only the ask matters.
  await until(() => runOf(store, second.id).status !== 'awaiting_ask', 'the second run to leave the wait');
  assert.equal(store.read().asks.find(a => a.runId === second.id).status, 'declined');
  // A grant is set by the owner, per bot, action and origin; a payment can never be Always allow.
  await call('POST', '/api/grants', {botId: ids.mail, action: 'delete', choice: 'deny'});
  assert.equal(grantFor(store.read(), ids.mail, 'delete', ''), 'deny');
  await assert.rejects(call('POST', '/api/grants', {botId: ids.mail, action: 'spend', choice: 'always'}), e => e.status === 400);
  await assert.rejects(call('POST', '/api/grants', {botId: 'nobody', action: 'send', choice: 'ask'}), e => e.status === 404);
});

test('a bot with no browser permission is offered the browser tool, because asking is how it gets one', async t => {
  const {store, ids} = await company(t);
  const ai = model({Mailroom: 'No page needed.'});
  await ask(store, {message: 'Hello', to: ids.mail, executor: ai.executor});
  assert.match(ai.of('Mailroom')[0].tools.browser, /headless browser/);
});

test('a backup taken while a run waits on an ask restores the run as interrupted, and the ask can still be answered', async t => {
  useFakeBrowser(t);
  const {store, ids} = await company(t);
  const ai = browsing('https://docs.example.com/guide');
  const run = await ask(store, {message: 'Look up the guide', to: ids.mail, executor: ai.executor});
  assert.equal(run.status, 'awaiting_ask');
  const {exportBackup, importBackup} = await import('../src/backup.js');
  const {SqliteStore} = await import('../src/sqlite-store.js');
  const {mkdtemp, rm} = await import('node:fs/promises');
  const {tmpdir} = await import('node:os');
  const path = await import('node:path');
  const dir = await mkdtemp(path.join(tmpdir(), 'ac-ask-restore-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const other = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  t.after(() => other.close());
  importBackup(other, JSON.parse(JSON.stringify(exportBackup(store))), {force: true});
  const restored = other.read();
  assert.equal(restored.groupRuns.find(r => r.id === run.id).status, 'interrupted', 'its page request did not travel, so it cannot resume');
  const waiting = restored.asks.find(a => a.status === 'pending');
  assert.ok(waiting, 'the ask itself is kept');
  assert.ok(waiting.expiresAt, 'and, with no run to resume, lapses after a day');
  const out = await answerAskFlow(other, waiting.id, 'always', {actor: 'owner@example.test'});
  assert.equal(out.ask.status, 'allowed');
  assert.equal(out.resumed, false, 'nothing resumes');
  assert.equal(other.read().groupRuns.find(r => r.id === run.id).status, 'interrupted');
});
