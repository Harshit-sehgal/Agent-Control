// Phase 3, Task 4: the release side of the sign-in card. Hand back signs the account's card in and every waiting run goes
// on, its held page sent again under a new task; Not now, a deleted account and 24 hours with no sign-in deny the held pages
// instead, and each run takes its declined turn. Real runs, a real store, a scripted model and a paired computer whose
// results the tests post by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import * as agent from '../src/agent.js';
import {createApp} from '../src/app.js';
import {browserLive} from '../src/browser-live.js';
import * as browser from '../src/bot-browser.js';
import {resumeBrowserRun} from '../src/coordination.js';
import {answerAskFlow, expirePendingAsks, answerSigninFlow, finishSignin} from '../src/ask-runs.js';
import {releaseSignin, holdForSignin} from '../src/signin-wait.js';
import {isSigninAsk, openSigninAsk, answeredText, SIGNIN_REFUSAL} from '../shared/asks.js';
import {BROWSER_ACCOUNTS_V1} from '../shared/device-features.js';
import {company, model, ask as startRun} from './run-fixture.js';

const A = '11111111-1111-4111-8111-111111111111';
const wall = {finalUrl: 'https://crm.example.com/login', title: 'Sign in', text: '', elements: [{index: 1, tag: 'input', type: 'password'}]};
const inbox = {finalUrl: 'https://crm.example.com/inbox', title: 'Inbox', text: 'Three new leads.'};
const docs = {finalUrl: 'https://docs.example.com/guide', title: 'Docs', text: 'Guide for the docs.'};
const fences = (...urls) => `One moment.\n${urls.map(u => `\`\`\`browser\n${JSON.stringify({url: u})}\n\`\`\``).join('\n')}`;
const CRM = 'https://crm.example.com/';
const DOCS = 'https://docs.example.com/guide';
/** A bot that reads what it asked for, then writes up the page (or says what was declined). */
const browsing = (...urls) => envelope => (envelope.declined ? `Could not look: ${JSON.stringify(envelope.declined)}` : envelope.page ? `Read: ${envelope.page}` : fences(...urls));
const until = async (check, note) => {
  for (let i = 0; i < 300; i++) { const value = check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`timed out waiting for ${note}`);
};

/** The company, a paired computer that holds account A, three bots (Scholar, Scribe, Planner) that sign in as it, Mailroom
 * that does not, an app with an owner and a member, and the hooks the server registers, with the scripted model. */
async function rig(t, script = {}) {
  const {store, ids} = await company(t);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'signin-release-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  const {code} = agent.createPairing(store, 'default', {});
  const device = agent.redeemPairing(store, {code, name: 'Desk', permissions: ['browser.capture']});
  agent.recordAgentFeatures(store, device.agentId, [BROWSER_ACCOUNTS_V1]);
  const sent = [];
  store.notify = async event => { sent.push(event); };
  await store.update(s => {
    s.browserAccounts = [{id: A, name: 'Sales', site: 'crm.example.com', deviceId: device.agentId, storage: 'cookies'}];
    for (const id of [ids.scholar, ids.scribe, ids.plan]) {
      const bot = s.groups.find(g => g.id === 'home').bots.find(b => b.id === id);
      bot.settings = {...bot.settings, browserAccount: A};
    }
  });
  const ai = model({Scholar: browsing(CRM), Scribe: browsing(CRM), Planner: browsing(CRM), ...script});
  const hooks = {continueRun: async () => {}, resumeBrowser: (st, request, options) => resumeBrowserRun(st, request, {...options, executor: ai.executor})};
  const roles = {owner: 'owner', member: 'member'};
  browserLive.close();
  t.after(() => browserLive.close());
  const app = createApp({store, auth: {session: cookie => (roles[cookie] ? {email: `${cookie}@x.test`, role: roles[cookie], workspaceId: 'default'} : null)}, workspaces: {get: () => store, holding: () => store}, push: {}, version: 't'});
  const send = async (method, url, {cookie = 'owner', body} = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const req = Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {method, url, headers: {host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', cookie: `agent_session=${cookie}`}, socket: {remoteAddress: '127.0.0.1'}});
    const res = {status: null, body: null, writeHead(status) { this.status = status; return this; }, end(b) { this.body = b; }};
    await app.handler(req, res);
    return {status: res.status, body: res.body ? JSON.parse(res.body) : null};
  };
  const r = {
    store, ids, ai, hooks, sent, send, device,
    requests: runId => store.read().browserRequests.filter(x => x.runId === runId),
    request: id => store.read().browserRequests.find(x => x.id === id),
    run: id => store.read().groupRuns.find(x => x.id === id),
    cards: () => (store.read().asks || []).filter(isSigninAsk),
    chat: key => store.read().chats?.[key] || [],
    /** The computer reports a page for the request's current task. */
    async returns(request, result) {
      const current = r.request(request.id ?? request);
      const [taskId] = current.agentTaskIds;
      store.run('UPDATE agent_tasks SET status=?, result=? WHERE id=?', 'done', JSON.stringify(result), taskId);
      return browser.onAgentTaskResult(store, taskId, hooks);
    },
    tasks: () => store.all('SELECT id, idempotency_key, status FROM agent_tasks ORDER BY created_at, rowid'),
    /** A bot starts a run; it asks for its pages and parks on them. */
    start: (name, message = 'Check the CRM') => startRun(store, {message, to: ids[name], executor: ai.executor}),
    /** A run whose first page is the account's sign-in wall: parked on the account's card. */
    async parked(name, message) {
      const run = await r.start(name, message);
      const [first] = r.requests(run.id);
      await r.returns(first, wall);
      return {run, first: r.request(first.id)};
    },
    handback: (name = 'scholar') => send('POST', `/api/browser-live/${ids[name]}/handback`),
  };
  return r;
}

test('hand back answers the account\'s card and sends the held page again under a new task', async t => {
  const rg = await rig(t);
  const {run, first} = await rg.parked('scholar');
  const [card] = rg.cards();
  assert.equal(rg.run(run.id).status, 'awaiting_ask');
  const firstTask = first.agentTaskIds[0];

  const back = await rg.handback('scholar');
  assert.equal(back.status, 200);
  assert.deepEqual(Object.keys(back.body).sort(), ['botId', 'signedIn', 'state']);
  assert.equal(back.body.botId, rg.ids.scholar);
  assert.deepEqual(back.body.signedIn, {resumed: 1});

  const answered = rg.store.read().asks.find(a => a.id === card.id);
  assert.equal(answered.status, 'allowed');
  assert.equal(answered.scope, 'once');
  assert.equal(Object.hasOwn(answered, 'expiresAt'), false);
  assert.equal(answeredText(answered), 'You signed in');
  assert.deepEqual(rg.store.read().signinPending, {});
  const again = rg.request(first.id);
  assert.equal(again.status, 'dispatched');
  assert.equal(again.agentTaskIds.length, 1);
  assert.notEqual(again.agentTaskIds[0], firstTask, 'a new task, not the first one handed back');
  assert.equal(rg.tasks().at(-1).idempotency_key, `browser:${first.id}:1`);
  assert.equal(rg.run(run.id).status, 'awaiting_browser');
  assert.deepEqual(rg.run(run.id).askIds, []);

  // The computer posts a signed-in page for the new task: the run goes on with it.
  await rg.returns(first, inbox);
  await until(() => rg.run(run.id).status === 'completed', 'the run to finish');
  assert.match(rg.ai.of('Scholar').at(-1).page, /Three new leads/);
  assert.doesNotMatch(rg.ai.of('Scholar').at(-1).page, /Sign in/);
});

test('any bot\'s tab in the account answers it; a bot with no account answers nothing', async t => {
  const rg = await rig(t);
  const {run, first} = await rg.parked('scholar');
  const [card] = rg.cards();

  // Mailroom signs in as no account: its hand back lets go of its own tab and answers no card.
  const none = await rg.handback('mail');
  assert.equal(none.status, 200);
  assert.deepEqual(Object.keys(none.body).sort(), ['botId', 'state']);
  assert.equal(rg.store.read().asks.find(a => a.id === card.id).status, 'pending');
  assert.equal(rg.request(first.id).status, 'signin');

  // Scribe never asked for anything, but it is in the same account: its tab is the account's tab.
  const other = await rg.handback('scribe');
  assert.deepEqual(other.body.signedIn, {resumed: 1});
  assert.equal(rg.store.read().asks.find(a => a.id === card.id).status, 'allowed');
  assert.equal(rg.request(first.id).status, 'dispatched');
  assert.equal(rg.run(run.id).status, 'awaiting_browser');

  // A second hand back finds no open card for the account: nothing more to answer.
  const spare = await rg.handback('scholar');
  assert.deepEqual(Object.keys(spare.body).sort(), ['botId', 'state']);
});

test('two runs and a 1:1 chat on one account: a hand back resumes all three', async t => {
  const rg = await rig(t);
  const one = await rg.parked('scholar');
  const two = await rg.parked('scribe', 'Check the CRM too');
  assert.equal(rg.cards().length, 1, 'one card for the account');
  // Planner's 1:1 chat: a page with no run.
  const solo = {
    id: 'solo', status: 'dispatched', kind: 'browser.capture', url: CRM, steps: [], botId: rg.ids.plan, botName: 'Planner', chatKey: rg.ids.plan,
    groupId: 'home', depth: 0, account: A, accountName: 'Sales', via: 'agent', agentTaskIds: [], result: null, error: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await rg.store.update(s => { s.browserRequests.push(solo); });
  await browser.finishBrowserRequest(rg.store, rg.request('solo'), {ok: true, result: wall}, rg.hooks);
  assert.equal(rg.request('solo').status, 'signin');
  assert.equal(rg.cards().length, 1);

  const back = await rg.handback('plan');
  assert.deepEqual(back.body.signedIn, {resumed: 3});
  for (const {run, first} of [one, two]) {
    assert.equal(rg.request(first.id).status, 'dispatched');
    assert.notEqual(rg.request(first.id).agentTaskIds[0], first.agentTaskIds[0]);
    assert.equal(rg.run(run.id).status, 'awaiting_browser');
  }
  assert.equal(rg.request('solo').status, 'dispatched', 'the 1:1 chat\'s page goes out again as well');
  assert.equal(rg.request('solo').agentTaskIds.length, 1);
  assert.equal(rg.tasks().filter(x => /:1$/.test(x.idempotency_key)).length, 3, 'three new tasks');
});

test('Not now denies every held page and each run takes its declined turn', async t => {
  const rg = await rig(t);
  const one = await rg.parked('scholar');
  const two = await rg.parked('scribe', 'Check the CRM too');
  const [card] = rg.cards();

  // The route answers with the server's own model; the scripted one is handed to the same flow.
  const answered = await answerAskFlow(rg.store, card.id, 'decline', {actor: 'owner@x.test', executor: rg.ai.executor});
  assert.equal(answered.ask.status, 'declined');
  assert.equal(answered.ask.expired, undefined);
  assert.equal(answered.resumed, true);
  assert.equal(answeredText(rg.store.read().asks.find(a => a.id === card.id)), 'You chose not now');
  assert.deepEqual(rg.store.read().signinPending, {});
  for (const {run, first} of [one, two]) {
    assert.equal(rg.request(first.id).status, 'denied');
    await until(() => rg.run(run.id).status === 'completed', 'the run to finish');
  }
  const told = [rg.ai.of('Scholar').at(-1), rg.ai.of('Scribe').at(-1)];
  for (const envelope of told) assert.match(JSON.stringify(envelope.declined), /signing in to crm\.example\.com as Sales/);
  assert.equal(rg.tasks().length, 2, 'no page was sent again');

  // The next wall makes a fresh card, and that card cannot be allowed: it is answered by signing in.
  const next = await rg.parked('scholar', 'Try the CRM once more');
  const [fresh] = rg.cards().filter(a => a.status === 'pending');
  assert.ok(fresh && fresh.id !== card.id);
  for (const answer of ['allow', 'always']) {
    const refused = await rg.send('POST', `/api/asks/${fresh.id}`, {body: {answer}});
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error, SIGNIN_REFUSAL);
  }
  assert.equal(rg.store.read().asks.find(a => a.id === fresh.id).status, 'pending', 'still waiting for a sign-in');
  assert.equal(rg.request(next.first.id).status, 'signin');
  // Not now over HTTP closes the fresh card; a second Not now is a conflict, as for every ask.
  assert.equal((await rg.send('POST', `/api/asks/${card.id}`, {body: {answer: 'decline'}})).status, 409);
});

test('24 hours with no sign-in end it like Not now, with the expired line', async t => {
  const rg = await rig(t);
  const one = await rg.parked('scholar');
  const two = await rg.parked('scribe', 'Check the CRM too');
  const [card] = rg.cards();
  assert.equal(Date.parse(card.expiresAt) - Date.parse(card.createdAt), 24 * 3600 * 1000);

  const early = await expirePendingAsks(rg.store, {now: new Date(Date.parse(card.createdAt) + 3600 * 1000).toISOString(), executor: rg.ai.executor});
  assert.equal(early.expired.length, 0);
  assert.equal(rg.request(one.first.id).status, 'signin');

  await expirePendingAsks(rg.store, {now: new Date(Date.parse(card.expiresAt) + 1000).toISOString(), executor: rg.ai.executor});
  const lapsed = rg.store.read().asks.find(a => a.id === card.id);
  assert.equal(lapsed.status, 'declined');
  assert.equal(lapsed.expired, true);
  assert.equal(Object.hasOwn(lapsed, 'expiresAt'), false);
  assert.equal(answeredText(lapsed), 'No sign-in in 24 hours, so the task went on without it');
  assert.deepEqual(rg.store.read().signinPending, {}, 'the account is free for a new card');
  for (const {run, first} of [one, two]) {
    assert.equal(rg.request(first.id).status, 'denied');
    await until(() => rg.run(run.id).status === 'completed', 'the run to finish');
  }
  // The second run's card was made by the first run: it is resumed too, with the lapse said in its declined turn.
  for (const name of ['Scholar', 'Scribe']) assert.match(JSON.stringify(rg.ai.of(name).at(-1).declined), /signing in to crm\.example\.com as Sales \(no answer in 24 hours\)/);
  assert.equal(openSigninAsk(rg.store.read(), A), null);
});

test('a hand back while another page of the round is still out waits for it, then goes on with both', async t => {
  const rg = await rig(t, {Scholar: browsing(CRM, DOCS)});
  const run = await rg.start('scholar');
  const [crm, doc] = ['https://crm.example.com/', DOCS].map(url => rg.requests(run.id).find(x => x.url === url));
  await rg.returns(crm, wall);
  assert.equal(rg.run(run.id).status, 'awaiting_ask');
  assert.equal(rg.request(doc.id).status, 'dispatched', 'the second page is still out');

  const back = await rg.handback('scholar');
  assert.deepEqual(back.body.signedIn, {resumed: 1});
  assert.equal(rg.run(run.id).status, 'awaiting_browser');
  assert.equal(rg.request(crm.id).status, 'dispatched');

  await rg.returns(doc, docs);
  assert.equal(rg.run(run.id).status, 'awaiting_browser', 'one page of the round is still out');
  assert.equal(rg.ai.of('Scholar').length, 1, 'the bot has not been given a half round');
  await rg.returns(crm, inbox);
  await until(() => rg.run(run.id).status === 'completed', 'the run to finish');
  const page = rg.ai.of('Scholar').at(-1).page;
  assert.match(page, /Three new leads/);
  assert.match(page, /Guide for the docs/);
});

test('a page that is done but not yet taken into the run is still outstanding when the card is answered', async t => {
  // Signed in: the done page is kept, the held one goes out again, and the run ends with both.
  const rg = await rig(t, {Scholar: browsing(CRM, DOCS)});
  const run = await rg.start('scholar');
  const [crm, doc] = [CRM, DOCS].map(url => rg.requests(run.id).find(x => x.url === url));
  await rg.returns(crm, wall);
  // The page's own status flip has committed, but `resumeBrowserRun` has not taken it into the run yet.
  await rg.store.update(s => {
    const r = s.browserRequests.find(x => x.id === doc.id);
    r.status = 'done'; r.result = {title: 'Docs', finalUrl: docs.finalUrl, text: docs.text, page: `Page: ${docs.finalUrl}\n\n${docs.text}`};
  });
  const back = await rg.handback('scholar');
  assert.deepEqual(back.body.signedIn, {resumed: 1});
  assert.equal(rg.run(run.id).status, 'awaiting_browser');
  await resumeBrowserRun(rg.store, rg.request(doc.id), {ok: true, text: `Page: ${docs.finalUrl}\n\n${docs.text}`, executor: rg.ai.executor});
  assert.equal(rg.run(run.id).status, 'awaiting_browser', 'the re-sent page is still out');
  await rg.returns(crm, inbox);
  await until(() => rg.run(run.id).status === 'completed', 'the run to finish');
  const page = rg.ai.of('Scholar').at(-1).page;
  assert.match(page, /Guide for the docs/);
  assert.match(page, /Three new leads/);
});

test('Not now with a page done but not yet taken in, or still out, does not start the run early', async t => {
  const rg = await rig(t, {Scholar: browsing(CRM, DOCS), Scribe: browsing(CRM, DOCS)});
  // The page that is done, not yet taken in: Not now leaves the run waiting for it, and it is not lost.
  const run = await rg.start('scholar');
  const [crm, doc] = [CRM, DOCS].map(url => rg.requests(run.id).find(x => x.url === url));
  await rg.returns(crm, wall);
  await rg.store.update(s => {
    const r = s.browserRequests.find(x => x.id === doc.id);
    r.status = 'done'; r.result = {title: 'Docs', finalUrl: docs.finalUrl, text: docs.text, page: `Page: ${docs.finalUrl}\n\n${docs.text}`};
  });
  const [card] = rg.cards();
  await answerAskFlow(rg.store, card.id, 'decline', {executor: rg.ai.executor});
  assert.equal(rg.run(run.id).status, 'awaiting_browser', 'waiting for the page that is in flight, not started');
  assert.equal(rg.ai.of('Scholar').length, 1);
  await resumeBrowserRun(rg.store, rg.request(doc.id), {ok: true, text: `Page: ${docs.finalUrl}\n\n${docs.text}`, executor: rg.ai.executor});
  await until(() => rg.run(run.id).status === 'completed', 'the run to finish');
  assert.match(rg.ai.of('Scholar').at(-1).page, /Guide for the docs/, 'the page that was done is not lost');

  // The page that is still out when Not now is said: the run waits for it too.
  const other = await rg.start('scribe');
  const [crm2, doc2] = [CRM, DOCS].map(url => rg.requests(other.id).find(x => x.url === url));
  await rg.returns(crm2, wall);
  const [fresh] = rg.cards().filter(a => a.status === 'pending');
  await answerAskFlow(rg.store, fresh.id, 'decline', {executor: rg.ai.executor});
  assert.equal(rg.run(other.id).status, 'awaiting_browser');
  assert.equal(rg.ai.of('Scribe').length, 1);
  await rg.returns(doc2, docs);
  await until(() => rg.run(other.id).status === 'completed', 'the run to finish');
  assert.match(rg.ai.of('Scribe').at(-1).page, /Guide for the docs/);
});

test('a hand back without signing in holds the page once more; the third wall goes to the bot', async t => {
  const rg = await rig(t);
  const {run, first} = await rg.parked('scholar');
  const [card] = rg.cards();

  await rg.handback('scholar');
  assert.equal(rg.request(first.id).status, 'dispatched');
  // The owner did not sign in: the same wall comes back. It is held again, on a new card.
  await rg.returns(first, wall);
  const held = rg.request(first.id);
  assert.equal(held.status, 'signin');
  assert.equal(held.signinHolds, 2);
  assert.notEqual(held.signinAskId, card.id, 'a new card: the first was answered');
  assert.equal(rg.cards().length, 2);
  assert.equal(rg.run(run.id).status, 'awaiting_ask');
  assert.equal(rg.tasks().at(-1).idempotency_key, `browser:${first.id}:1`);

  await rg.handback('scholar');
  assert.equal(rg.request(first.id).status, 'dispatched');
  assert.equal(rg.tasks().at(-1).idempotency_key, `browser:${first.id}:2`);
  // The third wall is a page like any other: the bot is told.
  await rg.returns(first, wall);
  assert.equal(rg.request(first.id).status, 'done');
  assert.equal(rg.cards().length, 2, 'no third card');
  await until(() => rg.run(run.id).status === 'completed', 'the run to finish');
  assert.match(rg.ai.of('Scholar').at(-1).page, /Sign in/);
});

test('after the re-dispatch, a late result for the first task is ignored and the new task\'s result completes the run', async t => {
  const rg = await rig(t);
  const {run, first} = await rg.parked('scholar');
  const firstTask = first.agentTaskIds[0];
  await rg.handback('scholar');
  const second = rg.request(first.id).agentTaskIds[0];
  assert.notEqual(second, firstTask);

  // The first task reports once more (a retried upload): it matches nothing and changes nothing.
  assert.equal(await browser.onAgentTaskResult(rg.store, firstTask, rg.hooks), null);
  assert.equal(rg.request(first.id).status, 'dispatched');
  assert.equal(rg.run(run.id).status, 'awaiting_browser');
  assert.equal(rg.ai.of('Scholar').length, 1);

  await rg.returns(first, inbox);
  await until(() => rg.run(run.id).status === 'completed', 'the run to finish');
  assert.match(rg.ai.of('Scholar').at(-1).page, /Three new leads/);
});

test('deleting an account declines its open card', async t => {
  const rg = await rig(t);
  const {run, first} = await rg.parked('scholar');
  const [card] = rg.cards();
  // The bots must stop signing in as it before it can go.
  await rg.store.update(s => { for (const bot of s.groups.find(g => g.id === 'home').bots) if (bot.settings?.browserAccount === A) bot.settings = {...bot.settings, browserAccount: null}; });
  const gone = await rg.send('DELETE', `/api/browser-accounts/${A}`);
  assert.equal(gone.status, 200);
  assert.deepEqual(rg.store.read().browserAccounts, []);
  const closed = rg.store.read().asks.find(a => a.id === card.id);
  assert.equal(closed.status, 'declined');
  assert.equal(answeredText(closed), 'You chose not now');
  assert.deepEqual(rg.store.read().signinPending, {});
  assert.equal(rg.request(first.id).status, 'denied');
  // The route resumes the run with the server's own model, which this test has no key for: the run left its wait, and
  // the declined turn itself is checked with the scripted model in the Not now test.
  await until(() => rg.run(run.id).status !== 'awaiting_ask', 'the run to go on');

  // A delete that is refused (bots still use the account) leaves its card open.
  const rg2 = await rig(t);
  const held = await rg2.parked('scholar');
  const refused = await rg2.send('DELETE', `/api/browser-accounts/${A}`);
  assert.equal(refused.status, 409);
  assert.equal(rg2.cards()[0].status, 'pending');
  assert.equal(rg2.request(held.first.id).status, 'signin');
});

test('a sign-in card and another ask: the run goes on only when both are answered, either way round', async t => {
  const rg = await rig(t);
  const one = await rg.parked('scholar');
  const two = await rg.parked('scribe', 'Check the CRM too');
  const [card] = rg.cards();
  // Each run also waits on a permission ask of its own.
  const own = (id, runId, botId) => ({id, kind: 'ask', action: 'send', botId, runId, chatKey: botId, detail: 'send a mail', target: '', grantScope: '', status: 'pending', scope: null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString()});
  await rg.store.update(s => {
    s.asks.push(own('perm1', one.run.id, rg.ids.scholar), own('perm2', two.run.id, rg.ids.scribe));
    s.groupRuns.find(r => r.id === one.run.id).askIds.push('perm1');
    s.groupRuns.find(r => r.id === two.run.id).askIds.push('perm2');
  });

  // Run one: the permission first, then the sign-in (hand back). Run two: Not now first, then the permission.
  await rg.send('POST', '/api/asks/perm1', {body: {answer: 'allow'}});
  assert.equal(rg.run(one.run.id).status, 'awaiting_ask', 'the sign-in card still holds it');
  await rg.send('POST', '/api/asks/perm2', {body: {answer: 'allow'}});
  assert.equal(rg.run(two.run.id).status, 'awaiting_ask', 'the sign-in card holds the second run too, though the card is the first run\'s');
  assert.equal(rg.request(two.first.id).status, 'signin');

  const back = await rg.handback('scholar');
  assert.deepEqual(back.body.signedIn, {resumed: 2});
  for (const {run, first} of [one, two]) {
    assert.equal(rg.run(run.id).status, 'awaiting_browser');
    assert.equal(rg.request(first.id).status, 'dispatched');
  }
  assert.equal(rg.ai.of('Scholar').length + rg.ai.of('Scribe').length, 2, 'no turn ran early');

  // And the other order, on fresh walls: the sign-in is answered first, the permission last.
  const three = await rg.parked('scholar', 'Once more');
  const fresh = rg.cards().find(a => a.status === 'pending');
  await rg.store.update(s => {
    s.asks.push(own('perm3', three.run.id, rg.ids.scholar));
    s.groupRuns.find(r => r.id === three.run.id).askIds.push('perm3');
  });
  await answerAskFlow(rg.store, fresh.id, 'decline', {executor: rg.ai.executor});
  assert.equal(rg.run(three.run.id).status, 'awaiting_ask', 'the permission is still open');
  await answerAskFlow(rg.store, 'perm3', 'allow', {executor: rg.ai.executor});
  await until(() => rg.run(three.run.id).status === 'completed', 'the run to finish');
  assert.match(JSON.stringify(rg.ai.of('Scholar').at(-1).declined), /signing in to crm\.example\.com as Sales/);
});

test('releaseSignin: answers the ask, readies or denies every held request and names the waiters', async () => {
  const at = '2026-11-27T10:00:00.000Z', later = '2026-11-27T11:00:00.000Z';
  const state = () => ({
    asks: [{id: 'k1', kind: 'signin', action: 'signin', botId: 'b', runId: 'r1', chatKey: 'b', accountId: A, accountName: 'Sales', site: 'crm.example.com', status: 'pending', scope: null, createdAt: at, expiresAt: '2026-11-28T10:00:00.000Z'}],
    signinPending: {[A]: 'k1'},
    groups: [{id: 'g', bots: [{id: 'b', name: 'B'}]}],
    groupRuns: [{id: 'r1', status: 'awaiting_ask', askIds: ['k1']}, {id: 'r2', status: 'awaiting_ask', askIds: ['k1', 'x']}, {id: 'r3', status: 'queued', askIds: ['k1']}, {id: 'r4', status: 'awaiting_ask', askIds: ['other']}],
    browserRequests: [
      {id: 'q1', runId: 'r1', status: 'signin', signinAskId: 'k1', signinHolds: 1, agentTaskIds: ['t1'], notAfter: 5, approvedBy: 'auto', via: 'agent', account: A, accountName: 'Sales'},
      {id: 'q2', runId: 'r2', status: 'signin', signinAskId: 'k1', signinHolds: 1, agentTaskIds: ['t2']},
      {id: 'q3', status: 'signin', signinAskId: 'k1', signinHolds: 1, agentTaskIds: ['t3']},
      {id: 'q4', runId: 'r4', status: 'signin', signinAskId: 'other', signinHolds: 1},
      {id: 'q5', runId: 'r1', status: 'done', signinAskId: 'k1'},
    ],
  });
  const signed = state();
  const out = releaseSignin(signed, 'k1', {signedIn: true, now: later});
  assert.equal(out.ask.status, 'allowed');
  assert.equal(out.ask.scope, 'once');
  assert.equal(out.ask.answeredAt, later);
  assert.equal(Object.hasOwn(out.ask, 'expiresAt'), false);
  assert.deepEqual(signed.signinPending, {});
  assert.deepEqual(out.runIds.sort(), ['r1', 'r2'], 'runs parked on the card; a run that went on, or waits on another ask, is not named');
  assert.deepEqual(out.openIds, ['q3']);
  const [q1, q2, q3, q4, q5] = signed.browserRequests;
  for (const q of [q1, q2, q3]) { assert.equal(q.status, 'pending'); assert.deepEqual(q.agentTaskIds, []); assert.equal(q.updatedAt, later); }
  for (const key of ['notAfter', 'approvedBy', 'via', 'account', 'accountName']) assert.equal(Object.hasOwn(q1, key), false, key);
  assert.equal(q1.signinHolds, 1, 'the holds are kept for the new idempotency key');
  assert.equal(q4.status, 'signin', 'another card\'s page is not touched');
  assert.equal(q5.status, 'done');

  const declined = state();
  const no = releaseSignin(declined, 'k1', {signedIn: false, now: later});
  assert.equal(no.ask.status, 'declined');
  assert.equal(Object.hasOwn(no.ask, 'expired'), false);
  assert.deepEqual(declined.browserRequests.slice(0, 3).map(q => q.status), ['denied', 'denied', 'denied']);
  assert.deepEqual(declined.browserRequests[0].agentTaskIds, ['t1'], 'a denied page keeps its record');
  assert.deepEqual(no.openIds, [], 'nothing is sent again on Not now');

  // An ask that already lapsed is left as it is.
  const lapsed = state();
  Object.assign(lapsed.asks[0], {status: 'declined', expired: true, answeredAt: at}); delete lapsed.asks[0].expiresAt;
  const kept = releaseSignin(lapsed, 'k1', {signedIn: false, now: later});
  assert.equal(kept.ask.answeredAt, at);
  assert.equal(kept.ask.expired, true);
  assert.equal(lapsed.browserRequests[0].status, 'denied');
  assert.equal(Object.keys(releaseSignin(state(), 'nope', {signedIn: true}) || {}).length, 0, 'an unknown ask releases nothing');
});

test('answerSigninFlow and finishSignin: the card is found by account, and nothing open answers null', async t => {
  const rg = await rig(t);
  assert.equal(await finishSignin(rg.store, A, {executor: rg.ai.executor}), null, 'no open card');
  const {run, first} = await rg.parked('scholar');
  const done = await finishSignin(rg.store, A, {executor: rg.ai.executor});
  assert.equal(done.resumed, 1);
  assert.equal(done.ask.status, 'allowed');
  assert.equal(rg.request(first.id).status, 'dispatched');
  assert.equal(rg.run(run.id).status, 'awaiting_browser');
  assert.equal(await finishSignin(rg.store, A, {executor: rg.ai.executor}), null, 'the card is answered');
  await assert.rejects(() => answerSigninFlow(rg.store, done.ask.id, {signedIn: false}), error => error.status === 409);
  await assert.rejects(() => answerSigninFlow(rg.store, 'nope', {signedIn: false}), error => error.status === 404);
});
