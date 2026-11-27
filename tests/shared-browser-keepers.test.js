import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startBrowserSession} from '../agent/browser.mjs';
import {createSharedBrowser, tabKey, KEEPER, REAP_MS, SAVE_MS, KEEPER_MS, QUIT_IDLE_MS} from '../agent/shared-browser.mjs';
import {createJarStore} from '../agent/account-jars.mjs';
import {fakeCdp} from './fake-cdp.js';

/* The device's housekeeping: idle tabs reaped, jars saved on a timer, a keeper tab per signed-in account, the
 * idle quit, and the saves a takeover or a close must not lose. Time is a fake clock handed to the shared
 * browser, so a ten-minute sweep takes no time. Against the scripted DevTools connection: no Chrome starts. */

const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const B = '0a1b2c3d-0000-4000-8000-00000000000b';
const SITE = 'crm.example.com';
const HOME = `https://${SITE}/`;
const MARKER = 'MARKER-COOKIE-7f3';
const SID = {name: 'sid', value: 'abc', domain: SITE, path: '/'};
const MIN = 60000;
const HOME_PAGE = {title: 'CRM', text: 'Inbox', elements: [{index: 1, tag: 'button', text: 'Go'}]};
const LOGIN_PAGE = {title: 'Sign in', text: 'Please sign in', elements: [{index: 1, tag: 'input', type: 'password', text: ''}]};
const IDP_URL = 'https://accounts.google.com/v3/signin/identifier';
// The page a task is sent to after the site bounced it to an identity provider: no password field, no sign-in title.
const IDP_PAGE = {shown: IDP_URL, title: 'Choose an account', text: 'Choose an account to continue to CRM', elements: [{index: 1, tag: 'button', text: 'Next'}]};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (promise, ms, why) => Promise.race([promise, new Promise((_, reject) => { const id = setTimeout(() => reject(new Error(why)), ms); promise.finally(() => clearTimeout(id)).catch(() => {}); })]);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

/** A Map-backed jar store with the methods of `createJarStore`, counting saves. */
function memJars(initial = {}) {
  const map = new Map(Object.entries(initial)), saves = [];
  return {
    map, saves,
    load: id => (map.has(id) ? structuredClone(map.get(id)) : null),
    save(id, cookies) { saves.push(id); map.set(id, structuredClone(cookies)); },
    wipe: id => { map.delete(id); },
    ids: () => [...map.keys()],
    retain: () => [],
  };
}

function rig(t, {jars = memJars(), extra = {}, allow = [SITE]} = {}) {
  const processes = [], site = {out: false, idp: false};
  let clock = 1_800_000_000_000;
  const pages = {[HOME]: () => (site.out ? LOGIN_PAGE : site.idp ? IDP_PAGE : HOME_PAGE)};
  const sb = createSharedBrowser({
    allow, settleMs: 0, jars, now: () => clock, ...extra,
    start: async () => { const fake = fakeCdp({pages}); processes.push(fake); return startBrowserSession({connection: fake.connection}); },
  });
  t.after(() => sb.close());
  return {sb, jars, processes, site, fake: () => processes.at(-1), advance: ms => { clock += ms; return clock; }, at: () => clock};
}
/** Hold the Nth page evaluation that is an action (not a snapshot or a read) until released. */
function holdStep(fake, nth) {
  let seen = 0;
  const began = deferred(), gate = deferred();
  fake.hook('Runtime.evaluate', async ({expression}) => {
    if (expression === 'location.href' || expression.startsWith('(function(){var els=') || expression.startsWith('JSON.stringify(')) return undefined;
    if (++seen === nth) { began.resolve(); await gate.promise; }
    return undefined;
  });
  return {began: began.promise, release: gate.resolve};
}
const bots = sb => sb.status().map(s => s.botId).sort();
const navigations = fake => fake.called('Page.navigate').length;

test('the housekeeping constants are the plan\'s', () => {
  assert.deepEqual([REAP_MS, SAVE_MS, KEEPER_MS, QUIT_IDLE_MS], [600000, 600000, 1800000, 1800000]);
  assert.equal(KEEPER, '\u0000keeper');
});

test('a tab idle for ten minutes is closed after its cookies are saved; a driven, busy or watched one is not', async t => {
  const r = rig(t, {jars: memJars({[A]: [SID]}), extra: {timeoutMs: 400}}); // a click waits for the page to move: a short deadline keeps that short
  const {sb, jars} = r;
  await sb.setAccounts([{id: A, site: SITE}]);
  for (const bot of ['idle', 'driven', 'busy', 'watched']) await sb.run(bot, {url: HOME, account: A});
  await sb.takeover('driven', A);
  assert.equal(await sb.watch('watched', A), true);
  const held = holdStep(r.fake(), 1);
  const busy = sb.run('busy', {url: HOME, account: A, steps: [{op: 'click', index: 1}]});
  await held.began;
  r.advance(REAP_MS - 1);
  await sb.sweep();
  assert.deepEqual(bots(sb), ['busy', 'driven', 'idle', 'watched'], 'nothing is idle for ten minutes yet');
  r.advance(1);
  const mark = r.fake().calls.length, saved = jars.saves.length;
  await sb.sweep();
  assert.deepEqual(bots(sb), ['busy', 'driven', 'watched'], 'only the idle one was reaped');
  const after = r.fake().calls.slice(mark);
  const closes = after.filter(c => c.method === 'Target.closeTarget');
  assert.equal(closes.length, 1, 'one tab closed: not the driven, busy or watched one, and no keeper');
  assert.ok(after.findIndex(c => c.method === 'Storage.getCookies') < after.indexOf(closes[0]), 'its jar was saved first');
  assert.ok(jars.saves.length > saved);
  held.release();
  await busy;
  await sb.handback('driven');
  await sb.unwatch();
});

test('a context is saved every ten minutes, and one with no tab and no keeper is disposed after it is saved', async t => {
  const r = rig(t, {jars: memJars({[A]: [SID]})});
  const {sb, jars} = r;
  await sb.run('scout', {url: HOME, account: A});            // no setAccounts: no site, so no keeper
  await sb.takeover('scout', A);                              // a driven tab is never reaped, but its context is still saved
  const base = jars.saves.length;
  r.advance(SAVE_MS - 1);
  await sb.sweep();
  assert.equal(jars.saves.length, base, 'saved a task ago: not yet');
  r.advance(1);
  await sb.sweep();
  assert.equal(jars.saves.length, base + 1, 'saved after ten minutes');
  await sb.handback('scout');
  r.advance(REAP_MS);
  await sb.sweep();
  assert.deepEqual(bots(sb), [], 'the tab was reaped');
  assert.equal(r.fake().contexts().length, 0, 'and the context with it, once saved');
  assert.equal(r.fake().called('Target.disposeBrowserContext').length, 1);
  assert.ok(jars.map.has(A), 'the jar stays: the account comes back from it');
  assert.equal((await sb.run('scout', {url: HOME, account: A})).text, 'Inbox');
  assert.equal(r.fake().called('Target.createBrowserContext').length, 2);
});

test('a signed-in account keeps one keeper, checked every 30 minutes; a sign-in page marks it signed out', async t => {
  const r = rig(t, {jars: memJars({[A]: [SID]})});
  const {sb, site} = r;
  assert.deepEqual(sb.accountStates(), [], 'no list yet: nothing to report');
  await sb.setAccounts([{id: A, site: SITE}]);
  assert.deepEqual(sb.accountStates().map(s => s.state), ['unknown'], 'a jar and no check');
  await sb.run('scout', {url: HOME, account: A});
  assert.deepEqual(sb.accountStates(), [{id: A, state: 'signed-in', storage: 'cookies'}]);
  const first = navigations(r.fake());
  r.advance(5 * MIN);
  await sb.sweep();
  assert.equal(r.fake().called('Target.createTarget').length, 2, 'the keeper has a tab of its own');
  assert.equal(navigations(r.fake()), first, 'not due: it read nothing');
  assert.deepEqual(bots(sb), ['scout'], 'the keeper is not a bot');
  r.advance(KEEPER_MS - 5 * MIN);
  await sb.sweep();
  assert.equal(navigations(r.fake()), first + 1, 'due after 30 minutes: it read the site\'s front page');
  assert.equal(r.fake().called('Target.createTarget').length, 2, 'the same keeper tab');
  assert.equal(sb.accountStates()[0].state, 'signed-in');
  r.advance(10 * MIN);
  await sb.sweep();
  assert.equal(navigations(r.fake()), first + 1, 'not again for another 30 minutes');
  site.out = true;
  r.advance(KEEPER_MS);
  await sb.sweep();
  assert.equal(navigations(r.fake()), first + 2);
  assert.deepEqual(sb.accountStates(), [{id: A, state: 'signed-out', storage: 'cookies'}]);
  assert.equal(r.fake().targets.size, 0, 'the keeper closed, and the bot\'s idle tab with it');
  r.advance(KEEPER_MS * 2);
  await sb.sweep();
  assert.equal(navigations(r.fake()), first + 2, 'a signed-out account has no keeper');
});

test('a task on the account\'s site sets its state; a page on another site does not', async t => {
  const r = rig(t, {allow: [SITE, 'other.example.com']});
  const {sb, site} = r;
  await sb.setAccounts([{id: A, site: SITE}]);
  assert.deepEqual(sb.accountStates(), [{id: A, state: 'signed-out', storage: 'cookies'}], 'no jar and no context');
  await sb.run('scout', {url: 'https://other.example.com/', account: A});
  assert.equal(sb.accountStates()[0].state, 'unknown', 'a context, but nothing found on the site');
  site.out = true;
  await sb.run('scout', {url: HOME, account: A});
  assert.equal(sb.accountStates()[0].state, 'signed-out');
  site.out = false;
  await sb.run('scout', {url: HOME, account: A});
  assert.equal(sb.accountStates()[0].state, 'signed-in');
});

test('an account dropped from the list loses its tabs, its context and its jar; no list changes nothing', async t => {
  const r = rig(t, {jars: memJars({[A]: [SID], [B]: [SID], '0a1b2c3d-0000-4000-8000-00000000000c': [SID]})});
  const {sb, jars} = r;
  await sb.setAccounts([{id: A, site: SITE}, {id: B, site: SITE}, {id: '0a1b2c3d-0000-4000-8000-00000000000c', site: SITE}]);
  await sb.run('a-bot', {url: HOME, account: A});
  await sb.run('b-bot', {url: HOME, account: B});
  assert.equal(r.fake().contexts().length, 2);
  await sb.setAccounts([{id: A}, {id: B}]);
  assert.deepEqual(jars.ids().sort(), [A, B], 'a jar the browser holds but no list names is wiped');
  for (const nothing of [undefined, null, 'x', {id: A}, 7]) await sb.setAccounts(nothing);
  assert.deepEqual(jars.ids().sort(), [A, B], 'not an array: nothing changes');
  await sb.setAccounts([{id: A}]);
  assert.deepEqual(jars.ids(), [A]);
  assert.equal(r.fake().contexts().length, 1, 'B\'s context is gone');
  assert.deepEqual(sb.status().map(s => [s.botId, s.account]), [['a-bot', A]], 'and its tabs');
  assert.deepEqual(sb.accountStates().map(s => s.id), [A]);
  await sb.run('a-bot', {url: HOME, account: A});
  assert.deepEqual(jars.ids(), [A], 'a task in flight cannot bring a dropped jar back');
});

test('a restored jar that does not sign the site in is marked lost', async t => {
  // By a task.
  let r = rig(t, {jars: memJars({[A]: [SID]})});
  r.site.out = true;
  await r.sb.setAccounts([{id: A, site: SITE}]);
  await r.sb.run('scout', {url: HOME, account: A});
  assert.deepEqual(r.sb.accountStates(), [{id: A, state: 'signed-out', storage: 'cookies', lost: true}]);
  r.site.out = false;
  await r.sb.run('scout', {url: HOME, account: A});
  assert.deepEqual(r.sb.accountStates(), [{id: A, state: 'signed-in', storage: 'cookies'}], 'signing in clears it');
  // By the keeper's first check.
  r = rig(t, {jars: memJars({[A]: [SID]})});
  r.site.out = true;
  await r.sb.setAccounts([{id: A, site: SITE}]);
  await r.sb.sweep();
  assert.deepEqual(r.sb.accountStates(), [{id: A, state: 'signed-out', storage: 'cookies', lost: true}]);
  // No jar to restore: signed out, nothing lost. A later sign-out is not the first check either.
  r = rig(t);
  r.site.out = true;
  await r.sb.setAccounts([{id: A, site: SITE}]);
  await r.sb.run('scout', {url: HOME, account: A});
  assert.deepEqual(r.sb.accountStates(), [{id: A, state: 'signed-out', storage: 'cookies'}]);
  r = rig(t, {jars: memJars({[A]: [SID]})});
  await r.sb.setAccounts([{id: A, site: SITE}]);
  await r.sb.run('scout', {url: HOME, account: A});
  r.site.out = true;
  r.advance(KEEPER_MS);
  await r.sb.sweep();
  assert.deepEqual(r.sb.accountStates(), [{id: A, state: 'signed-out', storage: 'cookies'}], 'the session ran out later: not lost');
  // The expired session's context is then recycled (disposed, unused, and restored from the stale jar by the next task):
  // that restore is routine, and its sign-in page is still the session that ran out, not a sign-in the site keeps elsewhere.
  r.advance(REAP_MS + 1);
  await r.sb.sweep();
  assert.equal(r.fake().contexts().length, 0, 'the unused context was disposed');
  await r.sb.run('scout', {url: HOME, account: A});
  assert.equal(r.fake().called('Target.createBrowserContext').length, 2, 'and the task restored it from the jar');
  assert.deepEqual(r.sb.accountStates(), [{id: A, state: 'signed-out', storage: 'cookies'}], 'a recycled context is not a lost sign-in');
});

test('a hand back with no new sign-in keeps `lost`; a real sign-in afterwards clears it', async t => {
  const r = rig(t, {jars: memJars({[A]: [SID]})});
  const {sb, site} = r;
  site.out = true;
  await sb.setAccounts([{id: A, site: SITE}]);
  await sb.run('scout', {url: HOME, account: A});
  assert.equal(sb.accountStates()[0].lost, true);
  await sb.takeover('scout', A);
  await sb.handback('scout');                                  // the owner signed in to nothing
  assert.equal(sb.accountStates()[0].state, 'unknown', 'the keeper will look again');
  await sb.sweep();
  assert.deepEqual(sb.accountStates(), [{id: A, state: 'signed-out', storage: 'cookies', lost: true}], 'still the same site that keeps its sign-in elsewhere');
  await sb.takeover('scout', A);
  site.out = false;
  r.fake().setCookie(r.fake().contexts()[0], {...SID, value: 'new'});  // now a real sign-in
  await sb.handback('scout');
  await sb.sweep();
  assert.deepEqual(sb.accountStates(), [{id: A, state: 'signed-in', storage: 'cookies'}]);
});

test('a keeper does not run for a host the allowlist refuses', async t => {
  const r = rig(t, {jars: memJars({[A]: [SID]}), allow: ['elsewhere.example.com']});
  await r.sb.setAccounts([{id: A, site: SITE}]);
  await r.sb.sweep();
  assert.equal(r.processes.length, 0, 'no browser was started for it');
  assert.equal(r.sb.accountStates()[0].state, 'unknown');
});

test('with the idle quit, a quiet browser saves every jar and closes; keepers wait until it starts again', async t => {
  const r = rig(t, {jars: memJars({[A]: [SID]}), extra: {quitIdle: true}});
  const {sb, jars} = r;
  await sb.setAccounts([{id: A, site: SITE}]);
  await sb.run('scout', {url: HOME, account: A});
  r.advance(QUIT_IDLE_MS - 1);
  await sb.sweep();
  assert.equal(r.fake().closed, false, 'not yet quiet for 30 minutes');
  r.fake().setCookie(r.fake().contexts()[0], {...SID, name: 'late', value: 'v'});  // after the last save
  r.advance(1);
  await sb.sweep();
  assert.equal(r.fake().closed, true, 'closed');
  assert.ok(jars.map.get(A).some(c => c.name === 'late'), 'every jar was saved first');
  assert.equal(sb.accountStates()[0].state, 'signed-in', 'the last state stands');
  r.advance(3 * KEEPER_MS);
  await sb.sweep();
  assert.equal(r.processes.length, 1, 'no keeper wakes the browser');
  assert.equal((await sb.run('scout', {url: HOME, account: A})).text, 'Inbox');
  assert.equal(r.processes.length, 2, 'a task starts it again');
  r.advance(KEEPER_MS);
  const before = navigations(r.fake());
  await sb.sweep();
  assert.equal(navigations(r.fake()), before + 1, 'and the keeper checks again');
});

test('the idle quit waits while a person drives or watches, and without it nothing quits', async t => {
  const r = rig(t, {jars: memJars({[A]: [SID]}), extra: {quitIdle: true}});
  const {sb} = r;
  await sb.run('scout', {url: HOME, account: A});
  await sb.takeover('scout', A);
  r.advance(QUIT_IDLE_MS * 2);
  await sb.sweep();
  assert.equal(r.fake().closed, false, 'driven');
  await sb.handback('scout');
  await sb.sweep();
  assert.equal(r.fake().closed, false, 'the hand back is activity');
  assert.equal(await sb.watch('scout', A), true);
  r.advance(QUIT_IDLE_MS * 2);
  await sb.sweep();
  assert.equal(r.fake().closed, false, 'watched');
  await sb.unwatch();
  r.advance(QUIT_IDLE_MS);
  await sb.sweep();
  assert.equal(r.fake().closed, true);

  const plain = rig(t, {jars: memJars({[A]: [SID]})});
  await plain.sb.run('scout', {url: HOME, account: A});
  plain.advance(QUIT_IDLE_MS * 4);
  await plain.sb.sweep();
  assert.equal(plain.fake().closed, false, 'no idle quit unless asked for');
});

test('the idle quit gives way to a task that arrives while it saves the jars', async t => {
  // The same quiet browser twice: once to count the cookie reads a quitting sweep makes, once to hold its last one.
  const quiet = async r => {
    await r.sb.setAccounts([{id: A, site: SITE}]);
    await r.sb.run('scout', {url: HOME});
    r.advance(QUIT_IDLE_MS);
  };
  const dry = rig(t, {jars: memJars({[A]: [SID]}), extra: {quitIdle: true}});
  await quiet(dry);
  const before = dry.fake().called('Storage.getCookies').length;
  await dry.sb.sweep();
  assert.equal(dry.fake().closed, true, 'a quiet browser quits');
  const reads = dry.fake().called('Storage.getCookies').length - before;
  assert.ok(reads > 0, 'the quit saves a jar first');

  const r = rig(t, {jars: memJars({[A]: [SID]}), extra: {quitIdle: true}});
  await quiet(r);
  const began = deferred(), gate = deferred();
  let seen = 0;
  r.fake().hook('Storage.getCookies', async () => { if (++seen === reads) { began.resolve(); await gate.promise; } return undefined; });
  const sweeping = r.sb.sweep();
  await began.promise;
  const task = r.sb.run('scout', {url: HOME});
  for (let i = 0; i < 50 && !r.sb.laneCount(); i++) await sleep(5);
  gate.resolve();
  await sweeping;
  assert.equal((await task).text, 'Inbox', 'the task that came during the saves is served');
  assert.equal(r.fake().closed, false, 'and the browser is not closed under it');
  assert.equal(r.processes.length, 1);
});

test('a sign-in made during a takeover is saved at the hand back', async t => {
  const r = rig(t);
  const {sb, jars} = r;
  await sb.setAccounts([{id: A, site: SITE}]);
  r.site.out = true;
  await sb.run('scout', {url: HOME, account: A});
  assert.equal(sb.accountStates()[0].state, 'signed-out');
  assert.equal(jars.map.get(A).length, 0);
  await sb.takeover('scout', A);
  r.fake().setCookie(r.fake().contexts()[0], SID);               // the owner signed in
  await sb.handback('scout');
  assert.deepEqual(jars.map.get(A).map(c => c.name), ['sid'], 'the jar holds the sign-in');
  assert.equal(sb.accountStates()[0].state, 'unknown', 'the keeper will look again');
  r.site.out = false;
  await sb.sweep();
  assert.equal(sb.accountStates()[0].state, 'signed-in');
});

test('close() saves every account\'s context before it ends, and a hung save cannot hold it', async t => {
  const r = rig(t, {extra: {saveWaitMs: 40}});
  const {sb, jars} = r;
  await sb.run('a-bot', {url: HOME, account: A});
  await sb.run('b-bot', {url: HOME, account: B});
  for (const context of r.fake().contexts()) r.fake().setCookie(context, SID);  // signed in after the last save
  await sb.close();
  assert.deepEqual([A, B].map(id => jars.map.get(id).map(c => c.name)), [['sid'], ['sid']]);
  assert.equal(r.fake().closed, true);

  const hung = rig(t, {extra: {saveWaitMs: 40}});
  await hung.sb.run('a-bot', {url: HOME, account: A});
  hung.fake().hook('Storage.getCookies', () => new Promise(() => {}));
  await within(hung.sb.close(), 3000, 'close() waited for a save that never answers');
  assert.equal(hung.fake().closed, true);
});

test('a hung cookie save never holds a lane: the next task on the tab goes on, and a run waits only a moment for it', async t => {
  const r = rig(t, {jars: memJars({[A]: [SID]}), extra: {saveWaitMs: 60000}});
  const {sb} = r;
  await sb.run('scout', {url: HOME, account: A});
  const began = deferred(), gate = deferred();
  let calls = 0;
  r.fake().hook('Storage.getCookies', async () => { if (++calls === 1) { began.resolve(); await gate.promise; } return undefined; });
  let first = false;
  const one = sb.run('scout', {url: HOME, account: A}).then(() => { first = true; });
  await began.promise;
  const two = await within(sb.run('scout', {url: HOME, account: A}), 2000, 'the second task waited for the first one\'s save');
  assert.equal(two.text, 'Inbox');
  assert.equal(first, false, 'the first run is still waiting for its save');
  gate.resolve();
  await one;

  const tight = rig(t, {jars: memJars({[A]: [SID]}), extra: {saveWaitMs: 30}});
  await tight.sb.run('scout', {url: HOME, account: A});
  tight.fake().hook('Storage.getCookies', () => new Promise(() => {}));
  const answer = await within(tight.sb.run('scout', {url: HOME, account: A}), 3000, 'a run waited for a save that never answers');
  assert.equal(answer.text, 'Inbox');
  await within(tight.sb.sweep(), 3000, 'a sweep waited for a save that never answers');
});

test('a planted cookie value leaves the device nowhere', async t => {
  const lines = [];
  t.mock.method(console, 'error', (...a) => lines.push(a.join(' ')));
  t.mock.method(console, 'log', (...a) => lines.push(a.join(' ')));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jars-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const jars = createJarStore({dir, secret: 'a-pairing-secret'});
  const r = rig(t, {jars});
  const {sb} = r;
  await sb.setAccounts([{id: A, site: SITE}]);
  await sb.run('scout', {url: HOME, account: A});
  r.fake().setCookie(r.fake().contexts()[0], {name: 'sid', value: MARKER, domain: SITE, path: '/'});
  const result = await sb.run('scout', {url: HOME, account: A});
  r.advance(REAP_MS + 1);
  await sb.sweep();
  await sb.takeover('scout', A);
  await sb.handback('scout');
  assert.ok(jars.load(A).some(c => c.value === MARKER), 'the cookie really was kept');
  r.fake().hook('Storage.getCookies', () => { throw new Error(`boom ${MARKER}`); });
  r.advance(SAVE_MS);
  await sb.sweep();                                    // saves fail here, in fixed words
  await sb.run('scout', {url: HOME, account: A});
  // Putting a jar back fails too, in a context made fresh: the browser's error, which names the cookie, stays inside.
  const fresh = rig(t, {jars});
  await fresh.sb.setAccounts([{id: A, site: SITE}]);
  await fresh.sb.run('warmup', {url: HOME});
  fresh.fake().hook('Storage.setCookies', () => { throw new Error(`boom ${MARKER}`); });
  const refused = await fresh.sb.run('scout', {url: HOME, account: A}).then(() => null, error => error);
  assert.ok(refused, 'a jar that cannot be put back refuses the task');
  lines.push(String(refused.message), String(refused.stack));
  const out = JSON.stringify([result, sb.accountStates(), sb.status(), lines]);
  assert.doesNotMatch(out, /MARKER-COOKIE-7f3/i);
  assert.ok(lines.some(line => /could not save/.test(line)), 'the failure was said');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, `${A}.jar`), 'utf8'), /MARKER-COOKIE-7f3/i);
  assert.equal(tabKey(A, KEEPER), `${A}\u0000\u0000keeper`);
});

test('a keeper sent to an IdP with no way back marks the account signed out', async t => {
  const r = rig(t, {jars: memJars({[A]: [SID]})});
  const {sb, site} = r;
  await sb.setAccounts([{id: A, site: SITE}]);
  await sb.run('scout', {url: HOME, account: A});
  assert.deepEqual(sb.accountStates(), [{id: A, state: 'signed-in', storage: 'cookies'}]);
  site.idp = true;
  r.advance(KEEPER_MS);
  await sb.sweep();
  assert.equal(navigations(r.fake()), 2, 'the keeper read the front page once, and the site sent it to the IdP');
  assert.deepEqual(sb.accountStates(), [{id: A, state: 'signed-out', storage: 'cookies'}]);
  // The same wall met by a bot's own task reads the same way, and a way back (the site's page) signs it in again.
  site.idp = false;
  await sb.run('scout', {url: HOME, account: A});
  assert.equal(sb.accountStates()[0].state, 'signed-in');
  site.idp = true;
  await sb.run('scout', {url: HOME, account: A});
  assert.equal(sb.accountStates()[0].state, 'signed-out', 'a task sent to the IdP marks it too');
});

test('a bot with no account that lands on an IdP changes no account\'s state', async t => {
  const r = rig(t, {jars: memJars({[A]: [SID]})});
  const {sb, site} = r;
  await sb.setAccounts([{id: A, site: SITE}]);
  await sb.run('scout', {url: HOME, account: A});
  site.idp = true;
  await sb.run('plain', {url: HOME});
  assert.equal(sb.accountStates()[0].state, 'signed-in');
});
