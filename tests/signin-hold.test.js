// Phase 3, Task 2: when a bot's page comes back as its account's sign-in wall, the server holds the page, parks the run on
// one sign-in card per account, posts the card and pushes it quietly. A held request is `signin`, never done; a late or
// repeated result for it changes nothing; a re-dispatch is a new task; the third wall goes to the bot.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as agent from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import * as wf from '../shared/workflow.js';
import {coordinationState, resumeBrowserRun, cancelRun} from '../src/coordination.js';
import {BROWSER_PERMISSION, capturePageText} from '../shared/bot-browser.js';
import {BROWSER_ACCOUNTS_V1} from '../shared/device-features.js';
import {isSigninAsk, openSigninAsk, createSigninAsk} from '../shared/asks.js';
import {askLineId, signinRoute, notifySignin} from '../src/ask-cards.js';
import * as browser from '../src/bot-browser.js';
import {MAX_SIGNIN_HOLDS, holdForSignin, signinFromKeeper, noticeSignins, releaseSignin} from '../src/signin-wait.js';
import * as backup from '../src/backup.js';
import {loadMasterKey} from '../src/vault.js';
import {company, model, ask as startRun} from './run-fixture.js';

const A = '11111111-1111-4111-8111-111111111111';
const agentOnly = {mode: 'agent', available: () => false};
const wall = {finalUrl: 'https://crm.example.com/login', title: 'Sign in', text: '', elements: [{index: 1, tag: 'input', type: 'password'}]};
const inbox = {finalUrl: 'https://crm.example.com/inbox', title: 'Inbox', text: 'Three new leads.'};
const NOW = '2026-11-27T10:00:00.000Z';
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

const request = (id, over = {}) => ({
  id, status: 'dispatched', kind: 'browser.capture', url: 'https://crm.example.com/', steps: [], botId: 'web', botName: 'Web', chatKey: 'web',
  runId: 'run1', groupId: 'lab', depth: 0, account: A, accountName: 'Sales', via: 'agent', agentTaskIds: [], result: null, error: null,
  createdAt: NOW, updatedAt: NOW, ...over,
});
const runOf = (id, over = {}) => ({id, groupId: 'lab', input: 'check the CRM', recipients: ['web'], mode: 'pipeline', currentStep: 0, status: 'awaiting_browser', trace: [], createdAt: NOW, ...over});

/** A paired computer that holds account A, bots `web` and `web2` that sign in as it, `plain` that does not, and a store
 * whose notifier records every event. */
async function rig(t, {requests = [], runs = [runOf('run1')]} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'signin-hold-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  t.after(async () => { await store.close().catch(() => {}); await fs.rm(dir, {recursive: true, force: true}); });
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  const {code} = agent.createPairing(store, 'default', {});
  const {agentId} = agent.redeemPairing(store, {code, name: 'Desk', permissions: ['browser.capture']});
  agent.recordAgentFeatures(store, agentId, [BROWSER_ACCOUNTS_V1]);
  const sent = [];
  store.notify = async event => { sent.push(event); };
  await store.update(s => {
    wf.migrate(s); coordinationState(s);
    const bot = (id, name, settings = {}) => ({id, name, instructions: 'Look things up.', type: 'custom', permissions: [BROWSER_PERMISSION], settings});
    s.groups = [{id: 'lab', name: 'Lab', bots: [bot('web', 'Web', {browserAccount: A}), bot('web2', 'Web Two', {browserAccount: A}), bot('plain', 'Plain')]}];
    s.browserAccounts = [{id: A, name: 'Sales', site: 'crm.example.com', deviceId: agentId, storage: 'cookies'}];
    s.browserRequests = requests;
    s.groupRuns = runs;
  });
  return {store, agentId, sent, dir};
}
const view = store => store.read();
const chat = (store, key) => view(store).chats?.[key] || [];
const cards = store => (view(store).asks || []).filter(isSigninAsk);
/** The hooks the server registers, recording what each was handed: `calls` the pages given back to a run, `continued` the pages given to a chat. */
const hooksOf = () => {
  const calls = [], continued = [];
  return {calls, continued, hooks: {resumeBrowser: async (st, req, opts) => { calls.push({id: req.id, ...opts}); }, continueRun: async (st, spec) => { continued.push(spec); }}};
};
const requestOf = (store, id) => view(store).browserRequests.find(r => r.id === id);
const runIn = (store, id) => view(store).groupRuns.find(r => r.id === id);

test('a page that comes back as its account\'s sign-in page is held, the run parks on one card, and the push is quiet', async t => {
  const {store, sent} = await rig(t, {requests: [request('br1')]});
  const {calls, hooks} = hooksOf();
  await browser.finishBrowserRequest(store, requestOf(store, 'br1'), {ok: true, result: wall}, hooks);
  await tick();

  const [ask] = cards(store);
  assert.ok(ask, 'one sign-in card was made');
  const held = requestOf(store, 'br1');
  assert.equal(held.status, 'signin');
  assert.equal(held.signinHolds, 1);
  assert.equal(held.signinAskId, ask.id);
  assert.equal(held.result, null, 'the wall is not recorded as a page');
  assert.deepEqual(chat(store, 'web').filter(m => m.kind === 'browser-result'), [], 'a held page posts no browser-result line');
  const run = runIn(store, 'run1');
  assert.equal(run.status, 'awaiting_ask');
  assert.deepEqual(run.askIds, [ask.id]);
  assert.deepEqual(calls, [], 'nothing resumes the run');

  const line = chat(store, 'web').find(m => m.id === askLineId(ask));
  assert.equal(line.kind, 'ask');
  assert.equal(line.askId, ask.id);
  assert.equal(line.text, 'Web needs you to sign in to crm.example.com as Sales.');
  assert.deepEqual(Object.entries(view(store).signinPending), [[A, ask.id]]);
  assert.equal(openSigninAsk(view(store), A).id, ask.id);

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    title: 'Sign in to crm.example.com', kind: 'signin', urgent: false, route: '#bot/web', meta: {askId: ask.id, accountId: A},
    body: 'Web needs you to sign in to crm.example.com as Sales. Open the card and tap Take control; the task carries on by itself.',
  });
});

test('a second run on the same account parks on the same card: one push, its own chat line', async t => {
  const {store, sent} = await rig(t, {
    requests: [request('br1'), request('br2', {botId: 'web2', botName: 'Web Two', chatKey: 'team-lab', runId: 'run2'}), request('br3', {botId: 'web2', botName: 'Web Two', chatKey: 'team-lab', runId: 'run2'})],
    runs: [runOf('run1'), runOf('run2', {recipients: ['web2'], chatKey: 'team-lab'})],
  });
  const {hooks} = hooksOf();
  await browser.finishBrowserRequest(store, requestOf(store, 'br1'), {ok: true, result: wall}, hooks);
  await browser.finishBrowserRequest(store, requestOf(store, 'br2'), {ok: true, result: wall}, hooks);
  await tick();

  assert.equal(cards(store).length, 1, 'one card for the account, not one per run');
  const [ask] = cards(store);
  assert.equal(ask.botId, 'web', 'the card names the bot that met the wall first');
  assert.equal(requestOf(store, 'br2').status, 'signin');
  assert.equal(requestOf(store, 'br2').signinAskId, ask.id);
  assert.equal(requestOf(store, 'br2').signinHolds, 1);
  for (const id of ['run1', 'run2']) {
    assert.equal(runIn(store, id).status, 'awaiting_ask');
    assert.deepEqual(runIn(store, id).askIds, [ask.id]);
  }
  assert.equal(chat(store, 'web').filter(m => m.id === askLineId(ask)).length, 1);
  const second = chat(store, 'team-lab').filter(m => m.id === askLineId(ask));
  assert.equal(second.length, 1, 'the second run\'s chat has its own line');
  assert.equal(second[0].text, 'Web Two needs you to sign in to crm.example.com as Sales.');
  assert.equal(second[0].runId, 'run2', 'the line carries the run that waits on it here, not the run that made the card');
  assert.equal(chat(store, 'web').find(m => m.id === askLineId(ask)).runId, 'run1');
  assert.equal(sent.length, 1, 'one push for the card');

  // A further wall in a chat that already holds the line neither adds a line, rewrites it, nor pushes again.
  const before = JSON.stringify(chat(store, 'team-lab'));
  await browser.finishBrowserRequest(store, requestOf(store, 'br3'), {ok: true, result: wall}, hooks);
  await tick();
  assert.equal(JSON.stringify(chat(store, 'team-lab')), before);
  assert.deepEqual(runIn(store, 'run2').askIds, [ask.id], 'the ask is added once');
  assert.equal(cards(store).length, 1);
  assert.equal(sent.length, 1);

  // A request with no run puts the card in its chat with no run id at all.
  await store.update(s => { s.browserRequests.push(request('br4', {botId: 'plain', botName: 'Plain', chatKey: 'plain', runId: undefined, account: undefined})); });
  await store.update(s => { s.groups[0].bots.find(b => b.id === 'plain').settings = {browserAccount: A}; s.browserRequests.find(r => r.id === 'br4').account = A; });
  await browser.finishBrowserRequest(store, requestOf(store, 'br4'), {ok: true, result: wall}, hooks);
  const bare = chat(store, 'plain').find(m => m.id === askLineId(ask));
  assert.equal(bare.text, 'Plain needs you to sign in to crm.example.com as Sales.');
  assert.equal(Object.hasOwn(bare, 'runId'), false);
});

test('a late result for the first task leaves a held request held; the re-dispatch is a new task', async t => {
  const {store, sent} = await rig(t, {requests: [{...request('br1'), status: 'pending', agentTaskIds: [], via: undefined, account: undefined, accountName: undefined}]});
  const {calls, hooks} = hooksOf();
  const idem = () => store.all('SELECT id, idempotency_key, status FROM agent_tasks ORDER BY created_at, rowid');

  await browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly});
  const [first] = idem();
  assert.equal(first.idempotency_key, 'browser:br1', 'the first dispatch keeps its key');
  store.run('UPDATE agent_tasks SET status=?, result=? WHERE id=?', 'done', JSON.stringify(wall), first.id);
  await browser.onAgentTaskResult(store, first.id, hooks);
  await tick();
  assert.equal(requestOf(store, 'br1').status, 'signin');
  assert.equal(sent.length, 1);

  // The same report arriving again changes nothing: no second ask, no second push, no page.
  assert.equal(await browser.onAgentTaskResult(store, first.id, hooks), null);
  await tick();
  assert.equal(requestOf(store, 'br1').status, 'signin');
  assert.equal(requestOf(store, 'br1').signinHolds, 1);
  assert.equal(cards(store).length, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual(calls, []);
  assert.deepEqual(chat(store, 'web').filter(m => m.kind === 'browser-result'), []);

  // The owner signed in and handed back: the request waits again and goes out as a new task.
  await store.update(s => { const r = s.browserRequests.find(x => x.id === 'br1'); r.status = 'pending'; s.groupRuns[0].status = 'awaiting_browser'; });
  await browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly});
  const rows = idem();
  assert.equal(rows.length, 2, 'a second task, not the first one handed back');
  assert.equal(rows[1].idempotency_key, 'browser:br1:1');
  assert.notEqual(rows[1].id, first.id);
  assert.deepEqual(requestOf(store, 'br1').agentTaskIds, [rows[1].id]);

  // The first task reporting once more cannot finish the new one.
  assert.equal(await browser.onAgentTaskResult(store, first.id, hooks), null);
  assert.equal(requestOf(store, 'br1').status, 'dispatched');
  assert.deepEqual(calls, []);
});

test('what is never held: a watch, a takeover result, a page with no account, a wall on another site, a third wall, a run that is not waiting', async t => {
  const {store, sent} = await rig(t, {
    requests: [
      request('watch', {watchId: 'w1', chatKey: 'watch:w1', runId: undefined}),
      request('took', {runId: undefined}),
      request('plain', {botId: 'plain', botName: 'Plain', chatKey: 'plain', runId: undefined, account: undefined, accountName: undefined}),
      request('other', {runId: undefined}),
      request('third', {signinHolds: MAX_SIGNIN_HOLDS}),
      request('busy', {runId: 'run3'}),
      request('ghost', {runId: 'nowhere'}),
      request('failed', {runId: undefined}),
    ],
    runs: [runOf('run1'), runOf('run3', {status: 'running'})],
  });
  const {calls, hooks} = hooksOf();
  const elsewhere = {finalUrl: 'https://other.example.org/login', title: 'Sign in', text: '', elements: [{index: 1, tag: 'input', type: 'password'}]};
  const finish = (id, outcome) => browser.finishBrowserRequest(store, requestOf(store, id), outcome, hooks);

  await finish('watch', {ok: true, result: wall});
  await finish('took', {ok: true, result: {...wall, tookOver: true}});
  await finish('plain', {ok: true, result: wall});
  await finish('other', {ok: true, result: elsewhere});
  await finish('third', {ok: true, result: wall});
  await finish('busy', {ok: true, result: wall});
  await finish('ghost', {ok: true, result: wall});
  await finish('failed', {ok: false, error: 'boom'});
  await tick();

  for (const id of ['watch', 'took', 'plain', 'other', 'third', 'busy', 'ghost']) assert.equal(requestOf(store, id).status, 'done', id);
  assert.equal(requestOf(store, 'failed').status, 'failed');
  assert.deepEqual(cards(store), [], 'no card was made for any of them');
  assert.deepEqual(view(store).signinPending || {}, {});
  assert.deepEqual(sent, []);
  assert.equal(runIn(store, 'run1').status, 'awaiting_browser', 'the third wall\'s run was not parked');
  assert.equal(requestOf(store, 'third').signinHolds, MAX_SIGNIN_HOLDS);
  // The third wall, and a wall seen by a run that is not waiting, reach the run's hook as pages; a watch reaches no one.
  assert.deepEqual(calls.map(c => c.id).sort(), ['busy', 'ghost', 'third']);
  assert.match(calls.find(c => c.id === 'third').text, /\n\nThis is a sign-in page/);
});

test('a signed-in bot that clicks Continue with Google is not held: no card, no push, the page goes to the run', async t => {
  const oauth = {finalUrl: 'https://accounts.google.com/o/oauth2/v2/auth?client_id=x&redirect_uri=https%3A%2F%2Fcrm.example.com%2Fcb', title: 'Choose an account', text: 'Choose an account to continue to CRM'};
  const bare = {finalUrl: 'https://accounts.google.com/v3/signin/identifier', title: 'Sign in', text: ''};
  const {store, sent} = await rig(t, {
    requests: [
      request('click', {steps: [{op: 'click', index: 3}]}),
      request('type', {steps: [{op: 'type', index: 2, text: 'me@example.test'}], runId: 'run2'}),
      request('read', {runId: 'run3'}),
      request('nav', {steps: [{op: 'navigate', url: 'https://crm.example.com/settings'}], runId: 'run4'}),
    ],
    runs: [runOf('run1'), runOf('run2'), runOf('run3'), runOf('run4')],
  });
  const {calls, hooks} = hooksOf();
  const finish = (id, result) => browser.finishBrowserRequest(store, requestOf(store, id), {ok: true, result}, hooks);
  await finish('click', oauth);
  await finish('type', bare);
  await tick();
  for (const id of ['click', 'type']) assert.equal(requestOf(store, id).status, 'done', id);
  assert.deepEqual(cards(store), [], 'no card for a click through to the IdP');
  assert.deepEqual(sent, [], 'and no push');
  assert.deepEqual(calls.map(c => c.id).sort(), ['click', 'type'], 'both pages reach their runs');
  for (const id of ['run1', 'run2']) assert.equal(runIn(store, id).status, 'awaiting_browser', id);

  // A plain read, or a navigate, that the site sends to the IdP is still the wall.
  await finish('read', oauth);
  await finish('nav', bare);
  await tick();
  for (const id of ['read', 'nav']) assert.equal(requestOf(store, id).status, 'signin', id);
  assert.equal(cards(store).length, 1);
  assert.equal(sent.length, 1);
});

test('a held request with no run parks nothing and continues no chat', async t => {
  const {store, sent} = await rig(t, {requests: [request('br1', {runId: undefined})]});
  const {calls, continued, hooks} = hooksOf();
  await browser.finishBrowserRequest(store, requestOf(store, 'br1'), {ok: true, result: wall}, hooks);
  await tick();
  assert.equal(requestOf(store, 'br1').status, 'signin');
  assert.equal(cards(store).length, 1);
  assert.equal(sent.length, 1);
  assert.deepEqual([calls, continued], [[], []]);
  assert.equal(runIn(store, 'run1').status, 'awaiting_browser', 'another run is untouched');
});

test('the third wall goes to the bot: two holds, two new tasks, then the page itself', async t => {
  const {store, sent} = await rig(t, {requests: [{...request('br1'), status: 'pending', agentTaskIds: [], account: undefined, accountName: undefined, via: undefined}]});
  const {calls, hooks} = hooksOf();
  const keys = () => store.all('SELECT idempotency_key FROM agent_tasks ORDER BY created_at, rowid').map(r => r.idempotency_key);
  const lastTask = () => store.all('SELECT id FROM agent_tasks ORDER BY created_at, rowid').at(-1).id;
  const wallBack = async () => {
    store.run('UPDATE agent_tasks SET status=?, result=? WHERE id=?', 'done', JSON.stringify(wall), lastTask());
    await browser.onAgentTaskResult(store, lastTask(), hooks);
    await tick();
  };
  // What the hand back does (Task 3): the card is answered, the request waits again and the run waits on its page.
  const handBack = () => store.update(s => {
    const ask = s.asks.find(a => a.id === s.browserRequests[0].signinAskId);
    Object.assign(ask, {status: 'allowed', scope: 'once', answeredAt: NOW}); delete s.signinPending[A];
    s.browserRequests[0].status = 'pending'; s.groupRuns[0].status = 'awaiting_browser'; s.groupRuns[0].askIds = [];
  });

  await browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly});
  await wallBack();
  assert.equal(requestOf(store, 'br1').signinHolds, 1);
  await handBack();
  await browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly});
  await wallBack();
  assert.equal(requestOf(store, 'br1').status, 'signin');
  assert.equal(requestOf(store, 'br1').signinHolds, 2);
  assert.equal(cards(store).length, 2, 'the first card was answered, so the second wall made a new one');
  assert.equal(sent.length, 2);
  await handBack();
  await browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly});
  assert.deepEqual(keys(), ['browser:br1', 'browser:br1:1', 'browser:br1:2']);

  await wallBack();
  const done = requestOf(store, 'br1');
  assert.equal(done.status, 'done', 'the third wall is a page, not a hold');
  assert.equal(cards(store).length, 2);
  assert.equal(sent.length, 2, 'no third push');
  assert.equal(calls.length, 1, 'the run is told');
  assert.equal(calls[0].ok, true);
  assert.match(calls[0].text, /\n\nThis is a sign-in page/);
  assert.equal(calls[0].text, `Page: ${wall.finalUrl}\nTitle: Sign in\n\n${capturePageText(wall, undefined, '', 1)}`);
  assert.ok(chat(store, 'web').some(m => m.kind === 'browser-result'), 'the bot\'s chat says what came back');
});

test('a page that comes back while its run waits on a sign-in is kept for the run', async t => {
  const {store} = await rig(t, {requests: [request('r1'), request('r2')]});
  let started = 0;
  const executor = async () => { started++; return 'unexpected'; };
  const hooks = {resumeBrowser: (st, req, opts) => resumeBrowserRun(st, req, {...opts, executor}), continueRun: async () => {}};
  await browser.finishBrowserRequest(store, requestOf(store, 'r2'), {ok: true, result: wall}, hooks);
  assert.equal(runIn(store, 'run1').status, 'awaiting_ask');
  await browser.finishBrowserRequest(store, requestOf(store, 'r1'), {ok: true, result: inbox}, hooks);
  await tick();

  const run = runIn(store, 'run1');
  assert.deepEqual(run.browserConsumed, ['r1'], 'r1 is consumed, r2 is still outstanding');
  assert.match(run.browserPage, /Three new leads\./);
  assert.match(run.browserPage, /^Page: https:\/\/crm\.example\.com\/inbox/);
  assert.equal(run.status, 'awaiting_ask', 'the run keeps waiting on the sign-in');
  assert.equal(started, 0, 'no turn started');
  assert.equal(requestOf(store, 'r1').status, 'done');
  assert.equal(requestOf(store, 'r2').status, 'signin');
});

test('an unattended run on an account with an open card sends no second sign-in notice', async t => {
  const signin = '```setup\n{"action":"signin","site":"crm.example.com"}\n```\nI need you to sign in to the CRM.';
  const runUnattended = async (open) => {
    const {store} = await company(t);
    const sent = [];
    store.notify = async event => { sent.push(event); };
    await store.update(s => {
      s.browserAccounts = [{id: A, name: 'Sales', site: 'crm.example.com', deviceId: 'pc-1', storage: 'cookies'}];
      s.groups.find(g => g.id === 'home').bots.find(b => b.id === 'atlas').settings.browserAccount = A;
      if (open) createSigninAsk(s, {botId: 'atlas', chatKey: 'atlas', account: s.browserAccounts[0], now: NOW});
    });
    await startRun(store, {message: 'Check the CRM', executor: model({Atlas: signin}).executor, extra: {unattended: true}});
    await tick();
    return sent.filter(n => n.kind === 'health');
  };
  const control = await runUnattended(false);
  assert.equal(control.length, 1, 'with no open card the owner is told once, as before');
  assert.match(control[0].title, /crm\.example\.com/);
  assert.deepEqual(await runUnattended(true), [], 'the open card already asks the owner');
});

test('a card the account\'s keeper makes: none without a record, an open card or a bot; otherwise one, pushed once', async t => {
  const {store, sent} = await rig(t);
  const make = (accountId, now = NOW) => store.update(s => signinFromKeeper(s, accountId, {now, makeId: () => 'keeper-1'}));

  assert.equal(await make('99999999-9999-4999-8999-999999999999'), null, 'no such account');
  await store.update(s => { s.browserAccounts.push({id: 'b2222222-2222-4222-8222-222222222222', name: 'Idle', site: 'idle.example.com', deviceId: 'pc', storage: 'cookies'}); });
  assert.equal(await make('b2222222-2222-4222-8222-222222222222'), null, 'no bot signs in as it');

  const made = await make(A);
  assert.equal(made.ask.id, 'keeper-1');
  assert.equal(made.bot.id, 'web', 'the first bot that signs in as the account');
  assert.equal(made.ask.runId, null);
  assert.equal(made.ask.chatKey, 'web');
  assert.ok(chat(store, 'web').some(m => m.id === askLineId(made.ask)), 'its card is in the bot\'s chat');
  assert.equal(await make(A), null, 'the account has an open card now');
  assert.equal(cards(store).length, 1);

  // Through noticeSignins: a fresh card is pushed once, an open one never again.
  await store.update(s => { s.asks.find(a => a.id === 'keeper-1').status = 'declined'; delete s.signinPending[A]; });
  assert.equal(await noticeSignins(store, [A, A, 'nobody']), 1);
  await tick();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, 'signin');
  assert.equal(sent[0].urgent, false);
  assert.equal(sent[0].route, '#bot/web');
  assert.equal(sent[0].title, 'Sign in to crm.example.com');
  assert.equal(await noticeSignins(store, [A]), 0);
  await tick();
  assert.equal(sent.length, 1);
});

test('a beat that reports a sign-out late makes no second card after the wall\'s card was answered with Not now', async t => {
  const {store, sent} = await rig(t);
  // The computer last said signed in at 09:00. A page met the wall at 10:00 and made the card; the owner chose Not now.
  await store.update(s => { createSigninAsk(s, {botId: 'web', chatKey: 'web', account: s.browserAccounts[0], now: NOW, makeId: () => 'wall-1'}); });
  await store.update(s => { const ask = s.asks.find(a => a.id === 'wall-1'); ask.status = 'declined'; delete s.signinPending[A]; });
  // The next beat says the account fell: that sign-out was already the wall's card, so nothing new.
  assert.equal(await noticeSignins(store, [{id: A, since: '2026-11-27T09:00:00.000Z'}]), 0);
  await tick();
  assert.equal(sent.length, 0);
  assert.equal(cards(store).length, 1);
  // A fall after the account was signed in again (heard at 10:30, after the card) is a new sign-out: a new card.
  assert.equal(await noticeSignins(store, [{id: A, since: '2026-11-27T10:30:00.000Z'}]), 1);
  await tick();
  assert.equal(sent.length, 1);
  // With no time kept for the earlier state, the fall makes a card as before.
  await store.update(s => { const open = s.asks.find(a => a.status === 'pending'); open.status = 'declined'; delete s.signinPending[A]; });
  assert.equal(await noticeSignins(store, [{id: A, since: null}]), 1);
});

test('a sign-out after the owner signed in from a card makes a new card, though no beat saw the sign-in', async t => {
  const {store, sent} = await rig(t);
  // Signed in at 09:00. A wall at 10:00 made the card and the owner signed in from it before the next beat, so every
  // beat said signed in and the time first heard stayed 09:00.
  await store.update(s => { createSigninAsk(s, {botId: 'web', chatKey: 'web', account: s.browserAccounts[0], now: NOW, makeId: () => 'wall-1'}); });
  await store.update(s => releaseSignin(s, 'wall-1', {signedIn: true, now: NOW}));
  // A later, separate sign-out is a new one: a card and a push.
  assert.equal(await noticeSignins(store, [{id: A, since: '2026-11-27T09:00:00.000Z'}]), 1);
  await tick();
  assert.equal(sent.length, 1);
  // A card made after the signed-in one and answered Not now covers the fall again: the newest card decides.
  await store.update(s => { const open = s.asks.find(a => a.status === 'pending'); open.status = 'declined'; delete s.signinPending[A]; });
  assert.equal(await noticeSignins(store, [{id: A, since: '2026-11-27T09:00:00.000Z'}]), 0);
});

test('the account report says when the fallen state was first heard', () => {
  const kv = new Map();
  const store = {kvSet: (k, v) => kv.set(k, v), kvGet: k => kv.get(k) ?? null, read: () => ({browserAccounts: [{id: A, deviceId: 'pc'}]})};
  assert.deepEqual(agent.recordAccountReports(store, 'pc', [{id: A, state: 'signed-in'}]), [], 'a first report is no fall');
  const heard = JSON.parse(kv.get('agent_accounts:pc'))[0].checkedAt;
  const fell = agent.recordAccountReports(store, 'pc', [{id: A, state: 'signed-out'}]);
  assert.deepEqual(fell, [{id: A, since: heard}]);
});

test('holdForSignin answers null and leaves the state exactly as it was whenever a page is not held', () => {
  const base = () => ({
    groups: [{id: 'lab', bots: [{id: 'web', name: 'Web', settings: {browserAccount: A}}]}],
    browserAccounts: [{id: A, name: 'Sales', site: 'crm.example.com', deviceId: 'pc', storage: 'cookies'}],
    groupRuns: [runOf('run1'), runOf('run8', {status: 'running'})], asks: [], grants: [], chats: {}, browserRequests: [],
  });
  const opts = {now: NOW, makeId: () => 'k1'};
  const cases = {
    'no wall': [request('a'), inbox],
    'an unreadable result': [request('a'), null],
    'a takeover': [request('a'), {...wall, tookOver: true}],
    'a watch': [request('a', {watchId: 'w'}), wall],
    'the cap': [request('a', {signinHolds: MAX_SIGNIN_HOLDS}), wall],
    'a run not waiting': [request('a', {runId: 'run9'}), wall],
    'a run that is running': [request('a', {runId: 'run8'}), wall],
    'another account stamped': [request('a', {account: 'someone-else'}), wall],
    'a request that is not out with a computer': [request('a', {status: 'pending'}), wall],
    'a request already held': [request('a', {status: 'signin'}), wall],
  };
  for (const [name, [req, result]] of Object.entries(cases)) {
    const s = base(), before = JSON.stringify(s);
    assert.equal(holdForSignin(s, req, result, opts), null, name);
    assert.equal(JSON.stringify(s), before, `${name}: nothing was written`);
  }
  // A held request with no run is held and parks nothing; the ask is fresh, then reused.
  const s = base();
  const first = holdForSignin(s, request('a', {runId: undefined}), wall, opts);
  assert.equal(first.fresh, true);
  const again = holdForSignin(s, request('b', {runId: undefined}), wall, {now: NOW, makeId: () => 'k2'});
  assert.equal(again.fresh, false);
  assert.equal(again.ask.id, first.ask.id);
  assert.equal(s.asks.length, 1);
  assert.equal(MAX_SIGNIN_HOLDS, 2);
});

test('a run that said Not now to the account is not held again: its page goes to the bot; a decline on another account holds', () => {
  const B = '22222222-2222-4222-8222-222222222222';
  const base = declined => ({
    groups: [{id: 'lab', bots: [{id: 'web', name: 'Web', settings: {browserAccount: A}}]}],
    browserAccounts: [{id: A, name: 'Sales', site: 'crm.example.com', deviceId: 'pc', storage: 'cookies'}],
    groupRuns: [runOf('run1', {declinedAsks: declined})], asks: [], grants: [], chats: {}, browserRequests: [],
  });
  const opts = {now: NOW, makeId: () => 'k1'};
  const s = base([{action: 'browser.use', scope: 'https://crm.example.com'}, {action: 'signin', scope: A}]), before = JSON.stringify(s);
  assert.equal(holdForSignin(s, request('a'), wall, opts), null);
  assert.equal(JSON.stringify(s), before, 'nothing was written');
  const other = base([{action: 'signin', scope: B}]);
  assert.equal(holdForSignin(other, request('a'), wall, opts).fresh, true, 'a decline on account B does not stop a hold on A');
  // An old record with no account in its scope says nothing about A.
  assert.equal(holdForSignin(base([{action: 'signin', scope: ''}]), request('a'), wall, opts).fresh, true);
});

test('an unattended run that said Not now to the account sends no sign-in notice for its site', async t => {
  const signin = '```setup\n{"action":"signin","site":"crm.example.com"}\n```\nI need you to sign in to the CRM.';
  const runUnattended = async declinedAsks => {
    const {store} = await company(t);
    const sent = [];
    store.notify = async event => { sent.push(event); };
    await store.update(s => {
      s.browserAccounts = [{id: A, name: 'Sales', site: 'crm.example.com', deviceId: 'pc-1', storage: 'cookies'}];
      s.groups.find(g => g.id === 'home').bots.find(b => b.id === 'atlas').settings.browserAccount = A;
    });
    await startRun(store, {message: 'Check the CRM', executor: model({Atlas: signin}).executor, extra: {unattended: true, declinedAsks}});
    await tick();
    return sent.filter(n => n.kind === 'health');
  };
  assert.equal((await runUnattended([{action: 'signin', scope: '22222222-2222-4222-8222-222222222222'}])).length, 1, 'a decline on another account changes nothing');
  assert.deepEqual(await runUnattended([{action: 'signin', scope: A}]), [], 'the owner already said not now to this account in this run');
});

test('signin_pending survives a reopen and is dropped by a restore', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'signin-pending-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'state.db'), data = path.join(dir, 'state.json');
  const store = await new SqliteStore(file, data).init();
  assert.deepEqual(store.read().signinPending, {}, 'a fresh install has none');
  await store.update(s => { s.signinPending = {[A]: 'ask-7'}; });
  await store.close();
  const reopened = await new SqliteStore(file, data).init();
  t.after(() => reopened.close().catch(() => {}));
  assert.deepEqual(reopened.read().signinPending, {[A]: 'ask-7'});
  assert.equal(reopened.kvGet('signin_pending'), JSON.stringify({[A]: 'ask-7'}));

  reopened.vaultKey = loadMasterKey(data).key;
  const doc = backup.exportBackup(reopened);
  assert.equal(JSON.stringify(doc).includes('signin_pending'), false, 'it never travels in a backup');
  backup.importBackup(reopened, JSON.parse(JSON.stringify(doc)), {force: true});
  assert.equal(reopened.kvGet('signin_pending'), null, 'a restore drops it');
  assert.deepEqual(reopened.read().signinPending, {});
});

test('a sign-in notice opens the chat its card is in: a bot chat, or a team chat of any kind', () => {
  assert.equal(signinRoute('web'), '#bot/web');
  assert.equal(signinRoute('team-lab'), '#chat/team-lab', 'a thread and any other team chat both resolve from this route');
  const sent = [];
  const store = {notify: async event => { sent.push(event); }};
  const ask = {id: 'k1', site: 'crm.example.com', accountName: 'Sales', accountId: A};
  return Promise.resolve().then(async () => {
    notifySignin(store, {...ask, chatKey: 'web'}, 'Web');
    notifySignin(store, {...ask, chatKey: 'team-lab'}, 'Web');
    notifySignin(store, {...ask, chatKey: null}, 'Web');
    await tick();
    assert.deepEqual(sent.map(e => e.route), ['#bot/web', '#chat/team-lab', undefined]);
    assert.equal(Object.hasOwn(sent[2], 'route'), false, 'no chat, no route key');
    for (const route of ['#bot/web', '#chat/team-lab']) assert.match(route, /^#[A-Za-z0-9/_-]{1,200}$/, 'the push carries it');
  });
});

test('resumeBrowserRun keeps a page only for a run that is still waiting, checked inside the write', async t => {
  const {store} = await rig(t, {requests: [request('r1', {status: 'done', result: {page: 'x'}})], runs: [runOf('run1', {status: 'awaiting_ask'})]});
  const update = store.update.bind(store);
  let started = 0;
  const executor = async () => { started++; return 'unexpected'; };
  // The run goes on between the peek at its status and the write: the page must not be appended into a run that is running.
  store.update = fn => update(s => { s.groupRuns[0].status = 'queued'; return fn(s); });
  await resumeBrowserRun(store, requestOf(store, 'r1'), {ok: true, text: 'Page: https://crm.example.com/inbox\n\nThree new leads.', executor});
  store.update = update;
  await tick();
  const run = runIn(store, 'run1');
  assert.equal(run.browserPage, undefined, 'the page was not appended');
  assert.equal(run.browserConsumed, undefined);
  assert.equal(run.status, 'queued');
  assert.equal(started, 0);
});

test('stopping a run parked on a sign-in denies its held request and fails no device task', async t => {
  const {store} = await rig(t, {requests: [request('r1'), request('r2', {status: 'pending'})]});
  const {hooks} = hooksOf();
  await browser.finishBrowserRequest(store, requestOf(store, 'r1'), {ok: true, result: wall}, hooks);
  assert.equal(requestOf(store, 'r1').status, 'signin');
  // The held request's task is a stale row that still reads queued: only a dispatched request's tasks are failed.
  const {agentId} = {agentId: store.get('SELECT id FROM agents').id};
  const {task} = agent.enqueueAgentTask(store, agentId, {kind: 'browser.capture', payload: {url: 'https://crm.example.com/', steps: [], botId: 'web'}, idempotencyKey: 'browser:r1'});
  await store.update(s => { s.browserRequests.find(r => r.id === 'r1').agentTaskIds = [task.id]; });

  await cancelRun(store, 'run1');
  assert.equal(runIn(store, 'run1').status, 'cancelled');
  assert.equal(requestOf(store, 'r1').status, 'denied', 'the held request is denied, not left as a ghost');
  assert.equal(requestOf(store, 'r2').status, 'denied');
  assert.equal(store.get('SELECT status FROM agent_tasks WHERE id=?', task.id).status, 'queued', 'no task id was collected for it');
});

test('a page that came back first is kept, then the sign-in wall parks the run (the other order)', async t => {
  const {store} = await rig(t, {requests: [request('r1'), request('r2')]});
  let started = 0;
  const executor = async () => { started++; return 'unexpected'; };
  const hooks = {resumeBrowser: (st, req, opts) => resumeBrowserRun(st, req, {...opts, executor}), continueRun: async () => {}};
  await browser.finishBrowserRequest(store, requestOf(store, 'r1'), {ok: true, result: inbox}, hooks);
  assert.equal(runIn(store, 'run1').status, 'awaiting_browser', 'r2 is still out');
  await browser.finishBrowserRequest(store, requestOf(store, 'r2'), {ok: true, result: wall}, hooks);
  await tick();
  const run = runIn(store, 'run1');
  assert.deepEqual(run.browserConsumed, ['r1']);
  assert.match(run.browserPage, /Three new leads\./);
  assert.equal(run.status, 'awaiting_ask');
  assert.equal(cards(store).length, 1);
  assert.equal(started, 0);
  assert.equal(requestOf(store, 'r2').status, 'signin');
});

test('a restore declines every pending sign-in card it brings back, and leaves other asks alone', async t => {
  const first = await rig(t);
  await first.store.update(s => {
    createSigninAsk(s, {botId: 'web', chatKey: 'web', account: s.browserAccounts[0], now: NOW, makeId: () => 'si-1'});
    s.asks.push({id: 'o-1', botId: 'web', runId: null, chatKey: 'web', action: 'send', target: 'x', detail: 'send it', status: 'pending', scope: null, createdAt: NOW, expiresAt: '2026-11-28T10:00:00.000Z'});
  });
  first.store.vaultKey = loadMasterKey(path.join(first.dir, 'state.json')).key;
  const doc = backup.exportBackup(first.store);
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'signin-restore-'));
  t.after(() => fs.rm(dir2, {recursive: true, force: true}));
  const second = await new SqliteStore(path.join(dir2, 'state.db'), path.join(dir2, 'state.json')).init();
  t.after(() => second.close().catch(() => {}));
  second.vaultKey = loadMasterKey(path.join(dir2, 'state.json')).key;
  backup.importBackup(second, JSON.parse(JSON.stringify(doc)));
  const asks = second.read().asks;
  const si = asks.find(a => a.id === 'si-1'), other = asks.find(a => a.id === 'o-1');
  assert.equal(si.status, 'declined');
  assert.equal(si.scope, null);
  assert.ok(si.answeredAt, 'it is answered');
  assert.equal(Object.hasOwn(si, 'expiresAt'), false);
  assert.equal(second.get("SELECT status FROM asks WHERE id='si-1'").status, 'declined', 'the column agrees with the document');
  assert.equal(other.status, 'pending', 'an ordinary ask is left to its own rules');
  assert.deepEqual(second.read().signinPending, {});
  assert.equal(openSigninAsk(second.read(), A), null);
});
