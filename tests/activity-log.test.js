/** The activity log (Phase 3, Task 3): one append-only record of what left the app, what the owner
 * allowed or denied, and which bots were made, moved, paused or deleted. It must stay clean: routing,
 * thinking, bot-to-bot messages and reads inside the app never get an entry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {installWebLocks} from './web-locks.js';
import {
  logActivity, activityPage, ACTIVITY_KINDS, ACTIVITY_FILTERS, ACTIVITY_CHIPS, MAX_ACTIVITY,
} from '../shared/activity-log.js';
import * as wf from '../shared/workflow.js';
import {initialState} from '../shared/core.js';
import {addCreatedBot} from '../shared/hire.js';
import {pauseAll, resumeGuard, noteBotWork, GUARD} from '../shared/runaway.js';
import {setGrant, createAsk, answerAsk} from '../shared/asks.js';
import {pruneState} from '../shared/retention.js';
import {createRouter} from '../src/router.js';
import {workflowRoutes} from '../src/routes-workflow.js';
import {groupRoutes} from '../src/routes-groups.js';
import {answerAskFlow} from '../src/ask-runs.js';
import {dispatchBrowserRequest, handBackTakeover} from '../src/bot-browser.js';
import {company, model, ask} from './run-fixture.js';

const state = () => wf.migrate(initialState());
const NOW = '2026-11-11T10:00:00.000Z';
const at = n => new Date(Date.parse(NOW) + n * 60000).toISOString();
const texts = (s, kind) => s.activity.filter(a => !kind || a.kind === kind).map(a => a.text);

test('one entry: a plain sentence, the bot, the chat to open, and a kind from a short list', () => {
  assert.deepEqual(ACTIVITY_KINDS, ['outside', 'perm', 'bots']);
  assert.deepEqual(ACTIVITY_FILTERS, ['outside', 'perm', 'bots', 'all']);
  assert.deepEqual(ACTIVITY_CHIPS.map(c => c.label), ['Left the app', 'Permissions', 'Bots', 'All']);
  assert.deepEqual(ACTIVITY_CHIPS.map(c => c.filter), ['outside', 'perm', 'bots', 'all'], 'the default chip is first');
  const s = state();
  const entry = logActivity(s, {botId: 'atlas', kind: 'outside', text: '  Atlas opened example.com.  ', threadId: 'atlas', undoUntil: at(1), now: NOW, makeId: () => 'a1'});
  assert.deepEqual(entry, {id: 'a1', at: NOW, botId: 'atlas', kind: 'outside', text: 'Atlas opened example.com.', threadId: 'atlas', undoUntil: at(1)});
  assert.deepEqual(s.activity, [entry]);
  const plain = logActivity(s, {kind: 'bots', text: 'All bots were paused.'});
  assert.equal(plain.botId, null); assert.equal(plain.threadId, null); assert.equal(plain.undoUntil, null);
  assert.ok(plain.id && Date.parse(plain.at));
  assert.throws(() => logActivity(s, {kind: 'routing', text: 'x'}), e => e.status === 400);
  assert.throws(() => logActivity(s, {kind: 'bots', text: '   '}), e => e.status === 400);
  assert.equal(s.activity.length, 2, 'a refused entry leaves nothing behind');
});

test('the log is bounded: only the newest entries are kept', () => {
  const s = state();
  for (let i = 0; i < MAX_ACTIVITY + 5; i++) logActivity(s, {kind: 'bots', text: `entry ${i}`, now: at(i), makeId: () => `e${i}`});
  assert.equal(s.activity.length, MAX_ACTIVITY);
  assert.equal(s.activity[0].id, 'e5');
  assert.equal(s.activity.at(-1).id, `e${MAX_ACTIVITY + 4}`);
});

test('a page is newest first, filtered by chip, and walks back with a cursor', () => {
  const s = state();
  const kinds = ['outside', 'perm', 'bots', 'outside', 'bots', 'perm', 'outside'];
  kinds.forEach((kind, i) => logActivity(s, {botId: i % 2 ? 'atlas' : 'b2', kind, text: `entry ${i}`, now: at(i), makeId: () => `e${i}`}));
  const all = activityPage(s, {filter: 'all'});
  assert.deepEqual(all.items.map(a => a.id), ['e6', 'e5', 'e4', 'e3', 'e2', 'e1', 'e0']);
  assert.equal(all.total, 7);
  assert.equal(all.next, null);
  assert.deepEqual(activityPage(s, {filter: 'outside'}).items.map(a => a.id), ['e6', 'e3', 'e0']);
  assert.deepEqual(activityPage(s, {filter: 'perm'}).items.map(a => a.id), ['e5', 'e1']);
  assert.deepEqual(activityPage(s, {filter: 'bots'}).items.map(a => a.id), ['e4', 'e2']);
  assert.equal(activityPage(s).items[0].id, 'e6', 'the default chip is Left the app');
  assert.deepEqual(activityPage(s).items.map(a => a.kind), ['outside', 'outside', 'outside']);
  // A cursor walks older, a page at a time.
  const first = activityPage(s, {filter: 'all', limit: 3});
  assert.deepEqual(first.items.map(a => a.id), ['e6', 'e5', 'e4']);
  assert.equal(first.next, 'e4');
  const second = activityPage(s, {filter: 'all', limit: 3, before: first.next});
  assert.deepEqual(second.items.map(a => a.id), ['e3', 'e2', 'e1']);
  const third = activityPage(s, {filter: 'all', limit: 3, before: second.next});
  assert.deepEqual(third.items.map(a => a.id), ['e0']);
  assert.equal(third.next, null);
  assert.equal(third.total, 7, 'the total is what the filter matches, not what the page holds');
  assert.deepEqual(activityPage(s, {filter: 'all', before: 'unknown'}).items, [], 'a cursor that is not an entry starts nothing');
  // A profile shows only its own bot.
  assert.deepEqual(activityPage(s, {filter: 'all', botId: 'atlas'}).items.map(a => a.id), ['e5', 'e3', 'e1']);
  assert.equal(activityPage(s, {filter: 'all', botId: 'atlas'}).total, 3);
  assert.throws(() => activityPage(s, {filter: 'everything'}), e => e.status === 400);
  assert.equal(activityPage(s, {filter: 'all', limit: 99999}).items.length, 7, 'the page size is capped, not trusted');
  assert.equal(activityPage(s, {filter: 'all', limit: 0}).items.length, 1, 'and never empty by accident');
});

test('bots created, moved, paused, resumed and deleted are logged; a rename is not', () => {
  const s = state();
  const mail = wf.addBot(s, 'home', {name: 'Mailroom', instructions: 'Reads email.'});
  const ops = wf.addBot(s, 'home', {name: 'Ops lead', instructions: 'Runs ops.'});
  assert.deepEqual(texts(s, 'bots'), ['Mailroom was created.', 'Ops lead was created.']);
  assert.ok(s.activity.every(a => a.kind === 'bots'));
  assert.equal(s.activity[0].botId, mail.id);
  wf.updateBot(s, 'home', mail.id, {name: 'Mail desk'});
  assert.equal(s.activity.length, 2, 'a rename is not an event the owner needs to find');
  wf.updateBot(s, 'home', mail.id, {settings: {reportsTo: ops.id}});
  assert.equal(texts(s).at(-1), 'Mail desk now reports to Ops lead.');
  wf.updateBot(s, 'home', mail.id, {settings: {reportsTo: null}});
  assert.equal(texts(s).at(-1), 'Mail desk now works on its own.');
  wf.updateBot(s, 'home', mail.id, {settings: {reportsTo: null}});
  assert.equal(s.activity.length, 4, 'saving the same place again is not a move');
  wf.updateBot(s, 'home', mail.id, {settings: {enabled: false}});
  assert.equal(texts(s).at(-1), 'Mail desk was paused.');
  wf.updateBot(s, 'home', mail.id, {settings: {enabled: true}});
  assert.equal(texts(s).at(-1), 'Mail desk was resumed.');
  wf.removeBot(s, 'home', mail.id);
  assert.equal(texts(s).at(-1), 'Mail desk was deleted.');
  assert.equal(s.activity.at(-1).botId, mail.id);
});

test('a bot made by another bot is logged with who made it', () => {
  const s = state();
  const out = addCreatedBot(s, {bot: s.groups[0].bots[0], groupId: 'home', request: {name: 'Mailroom', job: 'Read my email.'}, makeId: () => 'new-bot'});
  assert.ok(out.record);
  assert.deepEqual(texts(s, 'bots'), ['Atlas created Mailroom.']);
  assert.equal(s.activity[0].botId, out.record.id);
});

test('Pause all, Resume and the guard tripping by itself are logged under Bots', () => {
  const s = state();
  pauseAll(s, NOW);
  pauseAll(s, NOW);
  assert.deepEqual(texts(s, 'bots'), ['All bots were paused.'], 'pausing twice is one event');
  resumeGuard(s, NOW);
  resumeGuard(s, NOW);
  assert.deepEqual(texts(s, 'bots'), ['All bots were paused.', 'All bots were resumed.'], 'resuming what was not paused is nothing');
  for (let i = 0; i <= GUARD.runs; i++) noteBotWork(s, 'run', NOW);
  assert.match(texts(s, 'bots').at(-1), /Bots were paused: they were very busy/);
  assert.equal(s.activity.every(a => a.botId === null), true);
});

test('grant changes are logged under Permissions; Allow once and a Decline are not', () => {
  const s = state();
  setGrant(s, 'atlas', 'browser.use', 'https://docs.example.com', 'always', NOW);
  setGrant(s, 'atlas', 'send', 'https://mail.example.com', 'deny', NOW);
  setGrant(s, 'atlas', 'delete', 'https://mail.example.com', 'ask', NOW);
  setGrant(s, 'atlas', 'spend', '', 'deny', NOW);
  assert.deepEqual(texts(s, 'perm'), [
    'Atlas is always allowed to open docs.example.com.',
    'Atlas is not allowed to send on mail.example.com.',
    'Atlas will ask you each time to delete on mail.example.com.',
    'Atlas is not allowed to spend money.',
  ]);
  assert.ok(s.activity.every(a => a.botId === 'atlas'));
  const once = createAsk(s, {botId: 'atlas', chatKey: 'atlas', action: 'post', target: 'x', now: NOW});
  answerAsk(s, once.id, 'allow', NOW);
  const no = createAsk(s, {botId: 'atlas', chatKey: 'atlas', action: 'post', target: 'x', now: NOW});
  answerAsk(s, no.id, 'decline', NOW);
  assert.equal(s.activity.length, 4, 'neither stores a grant, so neither changes a permission');
  // Always allow is one entry in the chat it was answered in, even though it also covers the page the request reached.
  const always = createAsk(s, {botId: 'atlas', chatKey: 'team-t1', action: 'send', target: 'https://mail.example.com/c', implies: [{action: 'browser.use', scope: 'https://mail.example.com'}], now: NOW});
  s.grants = s.grants.filter(g => g.action !== 'send');
  const before = s.activity.length;
  answerAsk(s, always.id, 'always', NOW);
  assert.equal(s.activity.length, before + 1);
  assert.equal(s.activity.at(-1).kind, 'perm');
  assert.equal(s.activity.at(-1).threadId, 'team-t1');
  assert.match(s.activity.at(-1).text, /Atlas is always allowed to send/);
});

test('retention prunes the log with events, and a preview leaves it alone', () => {
  const s = state();
  const day = 86400000, now = Date.parse(NOW);
  logActivity(s, {kind: 'bots', text: 'old', now: new Date(now - 100 * day).toISOString(), makeId: () => 'old'});
  logActivity(s, {kind: 'bots', text: 'recent', now: new Date(now - 10 * day).toISOString(), makeId: () => 'recent'});
  const policy = {events: 90, doneTasks: 30, runs: 30};
  const dry = pruneState(s, {now, policy, dryRun: true});
  assert.equal(dry.events, 1, 'the preview counts it');
  assert.equal(s.activity.length, 2, 'and keeps it');
  const report = pruneState(s, {now, policy});
  assert.equal(report.events, 1);
  assert.deepEqual(s.activity.map(a => a.id), ['recent']);
  const none = pruneState(s, {now, policy: {events: 0, doneTasks: 0, runs: 0}});
  assert.equal(none.events, 0, 'a window of 0 keeps everything');
  const bare = {events: [], tasks: [], runs: []};
  assert.doesNotThrow(() => pruneState(bare, {now, policy}), 'a state with no log yet is fine');
});

test('a page the owner allowed is logged as having left the app; a declined one is not', async t => {
  const {store, ids} = await company(t);
  const request = id => ({id, botId: ids.mail, botName: 'Mailroom', groupId: 'home', chatKey: ids.mail, url: 'https://docs.example.com/guide', steps: [{op: 'read', selector: 'main'}], kind: 'browser.action', depth: 0, status: 'pending', agentTaskIds: [], result: null, error: null, createdAt: NOW, updatedAt: NOW});
  await store.update(s => { s.browserRequests = [request('r1'), request('r2')]; });
  const before = store.read().activity.length;
  const runtime = {mode: 'auto', available: () => true, run: async () => ({title: 'Docs', finalUrl: 'https://docs.example.com/guide', text: 'ok'}), close: async () => {}};
  await dispatchBrowserRequest(store, 'r1', {actor: 'owner@example.test', runtime});
  const entry = store.read().activity.at(-1);
  assert.equal(store.read().activity.length, before + 1);
  assert.deepEqual([entry.kind, entry.botId, entry.threadId], ['outside', ids.mail, ids.mail]);
  assert.equal(entry.text, 'Mailroom used docs.example.com (1 step).');
  const {denyBrowserRequest} = await import('../shared/bot-browser.js');
  await store.update(s => denyBrowserRequest(s, 'r2'));
  assert.equal(store.read().activity.length, before + 1, 'a page nobody opened is not an event');
  // Handing back a page the owner signed in to is one too.
  await store.update(s => { s.browserRequests.unshift(request('r3')); });
  const handed = await handBackTakeover(store, 's1', {runtime: {endLive: async () => ({requestId: 'r3', page: {url: 'https://docs.example.com/in', title: 'In', text: 'after sign-in'}})}});
  assert.equal(handed.handedBack, true);
  assert.match(store.read().activity.at(-1).text, /Mailroom was handed docs\.example\.com after you signed in/);
});

test('routing, hand-offs, thinking and bot-to-bot asks never reach the log', async t => {
  const {store, ids} = await company(t);
  const before = store.read().activity.length;
  const ai = model({
    Atlas: 'I will split this. @Planner book it.',
    Planner: 'Booked. @Scholar can you check the clinic?',
    Scholar: 'Checked.',
  });
  const run = await ask(store, {message: 'Book a dentist visit', to: ids.atlas, executor: ai.executor});
  assert.equal(run.status, 'completed');
  assert.ok(run.recipients.length >= 3, 'several bots really did hand work to each other');
  assert.equal(store.read().activity.length, before, 'none of it is an event the owner needs to find');
});

test('the log has one read route and no write route, and it is not part of the state snapshot', async t => {
  const router = createRouter();
  workflowRoutes(router, {auth: {listWorkspaces: () => [], roleOf: () => 'owner'}});
  groupRoutes(router, {});
  assert.equal(router.find('GET', '/api/activity').route.access, 'viewer');
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) assert.equal(router.find(method, '/api/activity'), null, `${method} /api/activity`);
  assert.equal(router.routes.some(r => /activity/.test(r.pattern) && r.method !== 'GET'), false);
  const {store, ids} = await company(t);
  const call = async query => router.find('GET', '/api/activity').route.handler({store, req: {url: `/api/activity${query}`}, params: {}, actor: {email: 'viewer@example.test', role: 'viewer', userId: 'u', workspaceId: 'default'}});
  const page = await call('?filter=bots');
  assert.deepEqual(Object.keys(page).sort(), ['items', 'next', 'total']);
  assert.equal(page.items.length, 5, 'the five bots the fixture made');
  assert.ok(page.items.every(a => a.kind === 'bots'));
  assert.deepEqual((await call('?filter=outside')).items, []);
  assert.deepEqual((await call('')).items, [], 'no filter means Left the app');
  const small = await call('?filter=all&limit=2');
  assert.equal(small.items.length, 2);
  const older = await call(`?filter=all&limit=2&before=${small.next}`);
  assert.equal(older.items.length, 2);
  assert.notEqual(older.items[0].id, small.items[0].id);
  const mine = await call(`?filter=all&bot=${ids.mail}`);
  assert.ok(mine.items.length >= 1 && mine.items.every(a => a.botId === ids.mail));
  await assert.rejects(call('?filter=everything'), e => e.status === 400);
  await assert.rejects(call('?limit=abc'), e => e.status === 400);
  // The snapshot the browser polls does not carry the whole log.
  const snapshot = router.find('GET', '/api/state').route.handler({store, actor: {email: 'a@b.test', role: 'viewer', userId: 'u', workspaceId: 'default'}});
  assert.equal(Object.hasOwn(snapshot, 'activity'), false);
  assert.ok(Array.isArray(snapshot.asks) && Array.isArray(snapshot.grants), 'asks and grants do ride along: the UI reads them from the snapshot');
});

test('an answer to an ask that opens a page lands in the log once the page is sent', async t => {
  const {store, ids} = await company(t);
  await store.update(s => { s.askBasics = true; }); // the owner asks even before a page opens
  const ai = model({Mailroom: envelope => (envelope.page ? 'Read it.' : '```browser\n{"url":"https://docs.example.com/guide"}\n```')});
  const {browserRuntime} = await import('../src/browser-runtime.js');
  const real = [browserRuntime.available, browserRuntime.run];
  browserRuntime.available = () => true;
  browserRuntime.run = async () => ({title: 'Docs', finalUrl: 'https://docs.example.com/guide', text: 'ok'});
  t.after(() => { [browserRuntime.available, browserRuntime.run] = real; });
  const {setBrowserResultHooks} = await import('../src/bot-browser.js');
  const {resumeBrowserRun} = await import('../src/coordination.js');
  setBrowserResultHooks({continueRun: async () => {}, resumeBrowser: (s, req, opts) => resumeBrowserRun(s, req, {...opts, executor: ai.executor})});
  await ask(store, {message: 'Look it up', to: ids.mail, executor: ai.executor});
  const [card] = store.read().asks;
  const before = store.read().activity.length;
  assert.equal(store.read().activity.filter(a => a.kind === 'outside').length, 0, 'waiting for an answer opens nothing');
  await answerAskFlow(store, card.id, 'always', {actor: 'owner@example.test', executor: ai.executor});
  for (let i = 0; i < 200 && store.read().activity.filter(a => a.kind === 'outside').length < 1; i++) await new Promise(r => setTimeout(r, 10));
  const kinds = store.read().activity.slice(before).map(a => a.kind).sort();
  assert.deepEqual(kinds, ['outside', 'perm']);
  assert.equal(store.read().activity.slice(before).find(a => a.kind === 'perm').threadId, ids.mail);
});

// The Pages demo reads the same log through the same route.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let storage = {getItem: () => null, setItem: () => {}};
globalThis.window = globalThis.window || {};
Object.defineProperty(globalThis, 'localStorage', {configurable: true, get: () => storage, set: value => { storage = value; }});
installWebLocks();
await import(path.join(root, 'shared/local-api.js'));

test('the Pages demo logs the same events and serves the same page, with no log in its snapshot', async () => {
  const map = new Map();
  storage = {getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, String(value))};
  const request = globalThis.window.AGENT_LOCAL_API;
  const bot = await request('/api/groups/home/bots', 'POST', {name: 'Scout', instructions: 'Looks things up.'});
  await request(`/api/groups/home/bots/${bot.id}`, 'PATCH', {settings: {enabled: false}});
  await request('/api/guard', 'POST', {paused: true});
  await request('/api/grants', 'POST', {botId: bot.id, action: 'send', scope: 'https://mail.example.com', choice: 'deny'});
  const all = await request('/api/activity?filter=all');
  assert.deepEqual(all.items.map(a => a.text), [
    'Scout is not allowed to send on mail.example.com.',
    'All bots were paused.',
    'Scout was paused.',
    'Scout was created.',
  ]);
  assert.equal(all.total, 4);
  assert.deepEqual((await request('/api/activity?filter=perm')).items.map(a => a.kind), ['perm']);
  assert.deepEqual((await request('/api/activity')).items, [], 'the default chip is Left the app');
  const page = await request(`/api/activity?filter=all&limit=1&before=${all.items[0].id}`);
  assert.equal(page.items[0].text, 'All bots were paused.');
  assert.equal(page.next, page.items[0].id);
  await assert.rejects(request('/api/activity?filter=nope'), e => e.status === 400);
  const snapshot = await request('/api/state');
  assert.equal(Object.hasOwn(snapshot, 'activity'), false);
  // The owner's switch for the basics is logged as a permission change, and the demo keeps it.
  await request('/api/permissions/basics', 'POST', {ask: true});
  assert.equal((await request('/api/state')).askBasics, true);
  assert.equal((await request('/api/activity?filter=perm')).items[0].text, 'Bots now ask before opening a web page or reading a connected app.');
  await assert.rejects(request('/api/permissions/basics', 'POST', {ask: 'yes'}), e => e.status === 400);
});
