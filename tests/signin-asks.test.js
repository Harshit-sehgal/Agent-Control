// Phase 3: signing in from the phone. The shared rules every later task builds on: one sign-in ask per browser
// account (never a grant), the account's own wall, and the `signin` request status that holds a run's request.
import test from 'node:test';
import assert from 'node:assert/strict';
import {SIGNIN_ASK, isSigninAsk, createSigninAsk, openSigninAsk, signinBotFor, signinDeclined, answerAsk, askText, answeredText, isAskAction, expireAsks, ASK_EXPIRY_MS} from '../shared/asks.js';
import {accountWall, onSite, stepsAct} from '../shared/browser-accounts.js';
import {OPEN_REQUEST_STATUSES, isSigninHost, pruneBrowserRequests, denyBrowserRequest, recordBrowserRequests, MAX_BROWSER_REQUESTS} from '../shared/bot-browser.js';
import {releaseChatWork} from '../shared/chats.js';
import {removeBot} from '../shared/workflow.js';

const A = '0b6f1c2e-4d5a-4b8c-9e1f-2a3b4c5d6e7f';
const acct = {id: A, name: 'Work CRM', site: 'crm.example.com'};
const NOW = '2026-11-27T10:00:00.000Z';
const state = () => ({groups: [{id: 'home', bots: [{id: 'scout', name: 'Scout', settings: {browserAccount: A}}]}], asks: [], grants: [], browserRequests: [], browserAccounts: [{...acct, deviceId: 'pc-1', storage: 'cookies'}]});
const mkAsk = (s, makeId = () => 'k1') => createSigninAsk(s, {botId: 'scout', chatKey: 'scout', account: acct, now: NOW, makeId});

test('a sign-in ask is one per account, lasts 24 hours and is never a grant', () => {
  const s = state();
  const ask = mkAsk(s);
  assert.equal(SIGNIN_ASK, 'signin');
  assert.equal(isSigninAsk(ask), true);
  assert.equal(isSigninAsk({action: 'send'}), false);
  assert.deepEqual(ask, {
    id: 'k1', kind: 'signin', action: 'signin', botId: 'scout', runId: null, chatKey: 'scout', accountId: A, accountName: 'Work CRM', site: 'crm.example.com',
    url: 'https://crm.example.com/', detail: 'signing in to crm.example.com as Work CRM', target: '', grantScope: '', status: 'pending', scope: null,
    createdAt: NOW, expiresAt: '2026-11-28T10:00:00.000Z',
  });
  assert.equal(Date.parse(ask.expiresAt) - Date.parse(ask.createdAt), ASK_EXPIRY_MS);
  assert.deepEqual(s.signinPending, {[A]: 'k1'});
  assert.equal(openSigninAsk(s, A).id, 'k1');
  assert.equal(askText(ask, 'Scout'), 'Scout needs you to sign in to crm.example.com as Work CRM.');
  assert.equal(answeredText(ask), 'Waiting for you');
  for (const no of ['allow', 'always']) assert.throws(() => answerAsk(s, 'k1', no), e => e.status === 409 && /^This card is answered by signing in: tap Take control, sign in, then Hand back\.$/.test(e.message));
  assert.equal(ask.status, 'pending', 'a refused answer leaves the card open');
  assert.deepEqual(s.grants, [], 'no grant ever names it');
  const out = answerAsk(s, 'k1', 'decline', '2026-11-27T11:00:00.000Z');
  assert.equal(out.resumeRunId, null);
  assert.equal(ask.status, 'declined');
  assert.equal(ask.answeredAt, '2026-11-27T11:00:00.000Z');
  assert.equal(answeredText(ask), 'You chose not now');
  assert.equal(openSigninAsk(s, A), null);
  assert.deepEqual(s.signinPending, {});
  assert.equal(isAskAction('signin'), false);
  assert.throws(() => answerAsk(s, 'k1', 'decline'), e => e.status === 409);
});

test('answered lines: signed in, not now, and a lapse after 24 hours', () => {
  assert.equal(answeredText({status: 'allowed', scope: 'once', kind: 'signin', action: 'signin'}), 'You signed in');
  assert.equal(answeredText({status: 'declined', kind: 'signin', action: 'signin'}), 'You chose not now');
  assert.equal(answeredText({status: 'declined', expired: true, kind: 'signin', action: 'signin'}), 'No sign-in in 24 hours, so the task went on without it');
  // An ordinary ask keeps its own words.
  assert.equal(answeredText({status: 'allowed', scope: 'once', action: 'send'}), 'You allowed it once');
  const s = state(); const ask = mkAsk(s);
  const {expired} = expireAsks(s, '2026-11-28T10:00:01.000Z');
  assert.deepEqual(expired.map(a => a.id), ['k1']);
  assert.equal(answeredText(ask), 'No sign-in in 24 hours, so the task went on without it');
  assert.equal(openSigninAsk(s, A), null);
});

test('a stale entry heals: an ask gone, or whose bot is gone, is no open card', () => {
  const s = state(); mkAsk(s);
  s.groups[0].bots = [];
  assert.equal(openSigninAsk(s, A), null);
  assert.equal(s.signinPending[A], undefined);
  const t = state(); mkAsk(t);
  t.asks = [];
  assert.equal(openSigninAsk(t, A), null);
  assert.equal(t.signinPending[A], undefined);
  assert.equal(openSigninAsk(state(), A), null, 'no map at all is no card');
});

test('a card follows its account: its bot moved or deleted, a bot that still signs in as the account answers it', () => {
  const two = () => { const s = state(); s.groups[0].bots.push({id: 'helper', name: 'Helper', settings: {browserAccount: A}}); return s; };
  // The card's own bot while it still uses the account.
  const s = two(); const ask = mkAsk(s);
  assert.equal(signinBotFor(s, ask), 'scout');
  // Scout moves to another account: the card stays open, and Helper (still on A) is the tab that answers it.
  s.groups[0].bots[0].settings.browserAccount = 'another-account';
  assert.equal(signinBotFor(s, ask), 'helper');
  assert.equal(openSigninAsk(s, A).id, 'k1');
  // Scout is deleted: the same.
  const t = two(); const ask2 = mkAsk(t);
  t.groups[0].bots = t.groups[0].bots.filter(b => b.id !== 'scout');
  assert.equal(signinBotFor(t, ask2), 'helper');
  assert.equal(openSigninAsk(t, A).id, 'k1');
  // No bot signs in as the account any more: no bot answers it, and the entry heals.
  t.groups[0].bots[0].settings.browserAccount = null;
  assert.equal(signinBotFor(t, ask2), null);
  assert.equal(openSigninAsk(t, A), null);
  assert.equal(signinBotFor(t, null), null);
});

test('settled sign-in history is bounded like any ask, and an open one is never dropped', () => {
  const s = state();
  for (let i = 0; i < 502; i++) { const ask = mkAsk(s, () => `d${i}`); answerAsk(s, ask.id, 'decline', NOW); }
  mkAsk(s, () => 'open');
  assert.equal(s.asks.filter(a => a.status !== 'pending').length, 500);
  assert.ok(s.asks.some(a => a.id === 'open'));
});

test('the account\'s wall: a sign-in page on its site, a password field alone, an IdP with no way back; never another site', () => {
  const page = (finalUrl, elements = []) => ({finalUrl, elements});
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/r/1', page('https://crm.example.com/login')), true);
  // A two-step login's second page shows a password field and nothing else: it is a wall (Phase 2 Task 10, pinned here).
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/', page('https://crm.example.com/u/next', [{tag: 'input', type: 'password'}])), true);
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/', page('https://accounts.google.com/v3/signin/identifier')), true);
  assert.equal(accountWall('crm.example.com', 'https://other.example.org/', page('https://other.example.org/login')), false);
  assert.equal(accountWall('crm.example.com', 'https://localhost/', page('https://localhost/', [{tag: 'input', type: 'password'}])), false);
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/', page('https://crm.example.com/home')), false);
  // An IdP reached from another site is not this account's wall.
  assert.equal(accountWall('crm.example.com', 'https://other.example.org/', page('https://accounts.google.com/v3/signin/identifier')), false);
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/', null), false);
  // The host showing the form decides, never where its return parameter points.
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/r/1', page('https://crm.example.com/login?next=https%3A%2F%2Fportal.example.com%2F')), true);
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/r/1', page('https://crm.example.com/login?next=https%3A%2F%2Fportal.example.com%2F', [{tag: 'input', type: 'password'}])), true);
  assert.equal(accountWall('crm.example.com', 'https://other.example.org/', page('https://other.example.org/login?next=https%3A%2F%2Fcrm.example.com%2F')), false);
  // An IdP that names the site as its way back is still the wall only when the page was the site's.
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/', page('https://accounts.google.com/signin?continue=https%3A%2F%2Fcrm.example.com%2F')), true);
});

test('a click or a type that ends on an identity provider is not the account\'s wall; a navigate or a read sent there is', () => {
  const page = (finalUrl, elements = []) => ({finalUrl, elements});
  const back = 'https://accounts.google.com/o/oauth2/v2/auth?redirect_uri=https://crm.example.com/cb';
  const bare = 'https://accounts.google.com/v3/signin/identifier';
  // "Continue with Google" on a signed-in site: both branches (a return parameter, or none) give way to the click.
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/', page(back), {clicked: true}), false);
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/', page(bare), {clicked: true}), false);
  // Without the click they are walls, as before.
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/', page(back)), true);
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/', page(bare), {clicked: false}), true);
  // A click that ends on the site's own sign-in page still counts.
  assert.equal(accountWall('crm.example.com', 'https://crm.example.com/', page('https://crm.example.com/login'), {clicked: true}), true);
  // Which steps act: a click or a type does; a navigate, a read, a scroll or a wait does not.
  assert.equal(stepsAct([{op: 'click', index: 1}]), true);
  assert.equal(stepsAct([{op: 'navigate', url: 'https://crm.example.com/x'}, {op: 'type', index: 2, text: 'a'}]), true);
  assert.equal(stepsAct([{op: 'navigate', url: 'https://crm.example.com/x'}, {op: 'read', selector: 'main'}, {op: 'scroll'}, {op: 'waitFor', selector: 'h1'}]), false);
  assert.equal(stepsAct([]), false);
  assert.equal(stepsAct(undefined), false);
  assert.equal(stepsAct([null]), false);
});

test('onSite and isSigninHost', () => {
  assert.equal(onSite('crm.example.com', 'crm.example.com'), true);
  assert.equal(onSite('app.crm.example.com', 'crm.example.com'), true);
  assert.equal(onSite('CRM.Example.com', 'crm.EXAMPLE.com'), true);
  assert.equal(onSite('evilcrm.example.com', 'crm.example.com'), false);
  assert.equal(onSite('crm.example.com.evil.org', 'crm.example.com'), false);
  assert.equal(onSite('', 'crm.example.com'), false);
  assert.equal(onSite('crm.example.com', ''), false);
  assert.equal(isSigninHost('accounts.google.com'), true);
  assert.equal(isSigninHost('login.microsoftonline.com'), true);
  assert.equal(isSigninHost('crm.example.com'), false);
  assert.equal(isSigninHost(''), false);
});

const heldRequest = (id, status = 'signin', extra = {}) => ({id, botId: 'scout', chatKey: 'scout', url: 'https://crm.example.com/r', status, signinAskId: 'k1', signinHolds: 1, createdAt: NOW, updatedAt: NOW, ...extra});

test('a held request is open: pruning keeps it, a decline, a cleared chat and a removed bot deny it', () => {
  assert.deepEqual(OPEN_REQUEST_STATUSES, ['pending', 'dispatched', 'signin']);
  // Pruning: MAX + 1 requests, the held one the oldest, so it would be the first cut if it were finished.
  const s = state();
  s.browserRequests = [...Array.from({length: MAX_BROWSER_REQUESTS}, (_, i) => heldRequest(`d${i}`, 'done')), heldRequest('held')];
  assert.equal(s.browserRequests.length, MAX_BROWSER_REQUESTS + 1);
  pruneBrowserRequests(s);
  assert.equal(s.browserRequests.length, MAX_BROWSER_REQUESTS);
  assert.ok(s.browserRequests.some(r => r.id === 'held' && r.status === 'signin'));
  // A decline of the request.
  const d = state(); d.browserRequests = [heldRequest('held')];
  assert.equal(denyBrowserRequest(d, 'held').status, 'denied');
  assert.throws(() => denyBrowserRequest(d, 'held'), e => e.status === 409, 'a denied one is no longer waiting');
  // A cleared chat.
  const c = state(); c.browserRequests = [heldRequest('held'), heldRequest('done1', 'done')];
  releaseChatWork(c, 'scout');
  assert.deepEqual(c.browserRequests.map(r => r.status), ['denied', 'done']);
  // A removed bot.
  const b = state(); Object.assign(b, {activity: [], tasks: [], events: []}); b.groups[0].bots.push({id: 'other', name: 'Other', settings: {}});
  b.browserRequests = [heldRequest('held'), heldRequest('theirs', 'signin', {botId: 'other', chatKey: 'other'})];
  removeBot(b, 'home', 'scout');
  assert.equal(b.browserRequests.find(r => r.id === 'held').status, 'denied');
  assert.equal(b.browserRequests.find(r => r.id === 'theirs').status, 'signin', 'another bot\'s request is untouched');
});

test('a site that refused twice posts no setup card while its account\'s sign-in card is open', () => {
  const blocked = {status: 'done', runId: 'r1', chatKey: 'scout', botId: 'scout', url: 'https://crm.example.com/search', result: {title: null, page: 'x', text: "You've been blocked by network security."}};
  const run = s => { let n = 0; return recordBrowserRequests(s, {bot: {id: 'scout', name: 'Scout'}, groupId: 'home', chatKey: 'scout', output: `\`\`\`browser\n${JSON.stringify({url: 'https://crm.example.com/top'})}\n\`\`\``, depth: 0, makeId: () => `m${++n}`, runId: 'r1', now: NOW}); };
  const fresh = () => { const s = state(); s.groupRuns = [{id: 'r1', status: 'running'}]; s.browserRequests.push({...blocked, id: 'a'}, {...blocked, id: 'b'}); return s; };
  // With the account's sign-in card open: still refused, no setup card.
  const open = fresh(); mkAsk(open);
  const out = run(open);
  assert.equal(out.records.length, 0, 'not opened a third time');
  assert.deepEqual(out.refused, ['crm.example.com']);
  assert.equal(out.lines.filter(l => l.kind === 'setup').length, 0);
  assert.match(out.lines.map(l => l.text).join('\n'), /crm\.example\.com refused this browser twice/);
  // A card for another site of the account's bot does not cover this host.
  const other = fresh(); createSigninAsk(other, {botId: 'scout', chatKey: 'scout', account: {...acct, site: 'other.example.org'}, now: NOW, makeId: () => 'k2'});
  assert.equal(run(other).lines.filter(l => l.kind === 'setup').length, 1);
  // With no open card, the setup card is posted as today.
  const none = fresh();
  const card = run(none).lines.find(l => l.kind === 'setup');
  assert.ok(card);
  assert.equal(JSON.parse(card.setup).url, 'https://crm.example.com/');
  // A card that was answered is no open card.
  const done = fresh(); mkAsk(done); answerAsk(done, 'k1', 'decline', NOW);
  assert.equal(run(done).lines.filter(l => l.kind === 'setup').length, 1);
});

test('a site that refused twice posts no setup card in a run that said Not now to its account', () => {
  const blocked = {status: 'done', runId: 'r1', chatKey: 'scout', botId: 'scout', url: 'https://crm.example.com/search', result: {title: null, page: 'x', text: "You've been blocked by network security."}};
  const run = s => { let n = 0; return recordBrowserRequests(s, {bot: {id: 'scout', name: 'Scout'}, groupId: 'home', chatKey: 'scout', output: `\`\`\`browser\n${JSON.stringify({url: 'https://crm.example.com/top'})}\n\`\`\``, depth: 0, makeId: () => `m${++n}`, runId: 'r1', now: NOW}); };
  const fresh = declinedAsks => { const s = state(); s.groupRuns = [{id: 'r1', status: 'running', declinedAsks}]; s.browserRequests.push({...blocked, id: 'a'}, {...blocked, id: 'b'}); return s; };
  const out = run(fresh([{action: 'signin', scope: A}]));
  assert.equal(out.records.length, 0, 'not opened a third time');
  assert.equal(out.lines.filter(l => l.kind === 'setup').length, 0, 'no card for a sign-in the owner just declined');
  assert.equal(run(fresh([{action: 'signin', scope: 'another-account'}])).lines.filter(l => l.kind === 'setup').length, 1, 'a decline on another account does not cover it');

  assert.equal(signinDeclined({declinedAsks: [{action: 'signin', scope: A}]}, A), true);
  assert.equal(signinDeclined({declinedAsks: [{action: 'browser.use', scope: A}, {action: 'signin', scope: ''}]}, A), false);
  assert.equal(signinDeclined(null, A), false);
  assert.equal(signinDeclined({declinedAsks: [{action: 'signin', scope: ''}]}, ''), false, 'no account, no decline');
});
