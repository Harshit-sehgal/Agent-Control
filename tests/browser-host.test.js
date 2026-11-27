import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {startBrowserSession} from '../agent/browser.mjs';
import {createBrowserHost} from '../agent/browser-host.mjs';
import {createJarStore} from '../agent/account-jars.mjs';
import {QUIT_IDLE_MS} from '../agent/shared-browser.mjs';
import {fakeCdp} from './fake-cdp.js';

/* What the device process wires together (agent/agent.mjs cannot be imported by a test, so the wiring lives in
 * agent/browser-host.mjs): the jars and the computer's id reach the shared browser, an account the latest list does not
 * hold is refused, the list is applied one update at a time, the sweep runs on a timer and shutdown waits for it, and
 * no account page is ever read by a cookieless fallback. Against the scripted DevTools connection: no Chrome starts. */

const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const B = '0a1b2c3d-0000-4000-8000-00000000000b';
const SITE = 'crm.example.com';
const HOME = `https://${SITE}/`;
const AGENT = 'agent-1';
const SECRET = 'pairing-secret-1';
const MARKER = 'MARKER-COOKIE-7f3';
const SID = {name: 'sid', value: MARKER, domain: SITE, path: '/'};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };
const PAGES = {[HOME]: ({cookies}) => ({title: 'CRM', text: cookies.some(c => c.name === 'sid') ? 'signed in' : 'signed out', elements: []})};
const task = payload => ({kind: 'browser.capture', payload: {url: HOME, botId: 'scout', ...payload}});

function rig(t, {env = {}, shared = {}, accounts = true} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-host-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const processes = [];
  let clock = 1_800_000_000_000;
  const host = createBrowserHost({
    agentId: AGENT, secret: SECRET, configPath: path.join(dir, 'agent.config.json'),
    env: {AGENT_BROWSER_ALLOWLIST: SITE, ...env}, sweepMs: 10, accounts,
    sharedOptions: {settleMs: 0, now: () => clock, start: async () => { const fake = fakeCdp({pages: PAGES}); processes.push(fake); return startBrowserSession({connection: fake.connection}); }, ...shared},
  });
  t.after(() => host.close());
  const dirOf = path.join(dir, 'browser-accounts');
  return {host, processes, dir, jarDir: dirOf, jars: () => createJarStore({dir: dirOf, secret: SECRET}), otherJars: secret => createJarStore({dir: dirOf, secret}), advance: ms => { clock += ms; }};
}

test('both the jars and this computer\'s id reach the shared browser', async t => {
  const r = rig(t);
  r.jars().save(A, [SID]);
  await r.host.applyAccounts([{id: A, site: SITE}], 1);
  const ok = await r.host.run(task({account: A, deviceId: AGENT}));
  assert.equal(ok.text, 'signed in', 'the jar the host made was handed to the browser: the account\'s own cookie was put back');
  await assert.rejects(r.host.run(task({account: A, deviceId: 'agent-2'})), /^Error: This task is for another computer, so it was not run\.$/);
  await assert.rejects(r.host.run(task({account: A})), /^Error: This task names a browser account this device cannot use\.$/, 'an account task with no device id is not run');
  assert.equal((await r.host.run(task({}))).text, 'signed out', 'no account: the default profile');
});

test('the idle quit is on only when asked, through the environment', async t => {
  for (const [value, quits] of [['1', true], [undefined, false]]) {
    const r = rig(t, {env: value ? {AGENT_BROWSER_QUIT_IDLE: value} : {}});
    await r.host.applyAccounts([{id: A, site: SITE}], 1);
    await r.host.run(task({account: A, deviceId: AGENT}));
    r.advance(QUIT_IDLE_MS);
    await r.host.shared().sweep();
    assert.equal(r.processes[0].closed, quits, `AGENT_BROWSER_QUIT_IDLE=${value}`);
  }
});

test('an account the latest list does not hold is refused: no browser starts and no jar is written', async t => {
  const r = rig(t);
  await assert.rejects(r.host.run(task({account: A, deviceId: AGENT})), /cannot use\.$/, 'no list yet');
  await r.host.applyAccounts([{id: B, site: SITE}], 1);
  await assert.rejects(r.host.run(task({account: A, deviceId: AGENT})), /cannot use\.$/, 'a list without it');
  assert.equal(r.processes.length, 0);
  assert.deepEqual(r.jars().ids(), []);
  await r.host.applyAccounts([{id: A, site: SITE}], 2);
  assert.equal((await r.host.run(task({account: A, deviceId: AGENT}))).text, 'signed out');
  assert.deepEqual(r.jars().ids(), [A]);
  await r.host.applyAccounts([], 3);
  await assert.rejects(r.host.run(task({account: A, deviceId: AGENT})), /cannot use\.$/);
  assert.deepEqual(r.jars().ids(), [], 'and the wiped jar stays wiped');
});

test('a list that arrives before the browser exists is applied when it is made', async t => {
  const r = rig(t);
  r.jars().save(A, [SID]); r.jars().save(B, [SID]);
  await r.host.applyAccounts([{id: A, site: SITE}], 1);
  assert.equal(r.processes.length, 0, 'applying a list starts nothing');
  assert.deepEqual(r.jars().ids(), [A], 'the jar the list omits is wiped even with no browser');
  assert.equal((await r.host.run(task({account: A, deviceId: AGENT}))).text, 'signed in');
  assert.deepEqual(r.host.accountReport().map(a => [a.id, a.state]), [[A, 'signed-in']]);
});

test('a beat with no list, or one that is not a list, wipes nothing', async t => {
  const r = rig(t);
  r.jars().save(A, [SID]);
  for (const bad of [undefined, null, 'x', {id: A}, 7]) await r.host.applyAccounts(bad, 5);
  assert.deepEqual(r.jars().ids(), [A]);
});

test('list updates never overlap, and an older beat\'s list never replaces a newer one', async t => {
  const r = rig(t);
  await r.host.applyAccounts([{id: A, site: SITE}], 1);
  const sb = r.host.shared();
  const real = sb.setAccounts;
  let active = 0, most = 0;
  const order = [];
  sb.setAccounts = async list => { active++; most = Math.max(most, active); order.push(list.map(x => x.id)); await sleep(30); try { return await real(list); } finally { active--; } };
  r.jars().save(A, [SID]);
  await Promise.all([r.host.applyAccounts([], 2), r.host.applyAccounts([{id: A, site: SITE}], 3), r.host.applyAccounts([{id: B, site: SITE}], 2)]);
  assert.equal(most, 1, 'one update at a time');
  assert.deepEqual(order, [[], [A]], 'in the order asked; a beat no newer than the last applied is dropped');
  assert.equal((await r.host.run(task({account: A, deviceId: AGENT}))).text, 'signed out', 'A was wiped and listed again: it runs, from no jar');
});

test('the heartbeat reports each jar as unknown with no browser, and the browser\'s own states once there is one', async t => {
  const r = rig(t);
  r.jars().save(A, [SID]);
  assert.deepEqual(r.host.accountReport(), [{id: A, state: 'unknown', storage: 'cookies'}]);
  await r.host.applyAccounts([{id: A, site: SITE}], 1);
  await r.host.run(task({account: A, deviceId: AGENT}));
  const report = r.host.accountReport();
  assert.deepEqual(report.map(a => [a.id, a.storage]), [[A, 'cookies']]);
  assert.ok(!JSON.stringify(report).includes(MARKER), 'no cookie in the report');
});

test('no browser: an account task is refused, and never read by the plain fetch', async t => {
  const r = rig(t);
  let plain = 0;
  const readPlain = async () => { plain++; return {text: 'plain page'}; };
  await assert.rejects(r.host.capture(task({account: A, deviceId: AGENT}), {browser: false, readPlain}), /real browser/);
  await assert.rejects(r.host.capture(task({account: A, deviceId: 'agent-2'}), {browser: false, readPlain}), /^Error: This task is for another computer/);
  await assert.rejects(r.host.capture(task({account: A}), {browser: false, readPlain}), /cannot use\.$/);
  await assert.rejects(r.host.capture(task({account: '../x', deviceId: AGENT}), {browser: false, readPlain}), /cannot use\.$/);
  await assert.rejects(r.host.capture(task({deviceId: 'agent-2'}), {browser: false, readPlain}), /another computer/, 'a task for another computer is refused with no account too');
  assert.equal(plain, 0);
  assert.equal((await r.host.capture(task({}), {browser: false, readPlain})).text, 'plain page');
  assert.equal(plain, 1);
});

test('with a browser: an account\'s short page stands, a plain one is read again', async t => {
  const r = rig(t);
  let plain = 0;
  const readPlain = async () => { plain++; return {text: 'p'.repeat(600), title: 'Plain', finalUrl: HOME}; };
  await r.host.applyAccounts([{id: A, site: SITE}], 1);
  const seen = await r.host.capture(task({account: A, deviceId: AGENT}), {browser: true, readPlain});
  assert.equal(seen.text, 'signed out', 'the account\'s own answer, however short');
  assert.equal(plain, 0);
  const swapped = await r.host.capture(task({}), {browser: true, readPlain});
  assert.equal(plain, 1);
  assert.equal(swapped.readBy, 'plain');
});

test('the sweep runs on a timer; shutdown stops it and waits for a pass in flight before the browser closes', async t => {
  const r = rig(t);
  await r.host.applyAccounts([{id: A, site: SITE}], 1);
  await r.host.run(task({account: A, deviceId: AGENT}));
  const sb = r.host.shared();
  const events = [];
  const gate = deferred();
  let passes = 0;
  sb.sweep = () => { passes++; events.push('sweep'); return passes === 2 ? gate.promise.then(() => { events.push('sweep done'); }) : Promise.resolve(); };
  const realClose = sb.close;
  sb.close = async () => { events.push('close'); return realClose(); };
  r.host.startSweeps();
  for (let i = 0; i < 100 && passes < 2; i++) await sleep(10);
  assert.ok(passes >= 2, 'the timer calls sweep');
  const closing = r.host.close();
  const early = await Promise.race([closing.then(() => 'closed'), sleep(80).then(() => 'waiting')]);
  assert.equal(early, 'waiting', 'close waits for the pass in flight');
  const seen = passes;
  gate.resolve();
  await closing;
  assert.deepEqual(events.slice(-2), ['sweep done', 'close'], 'the browser closes after the pass');
  await sleep(50);
  assert.equal(passes, seen, 'no pass starts after the stop');
});

test('a sweep that fails is logged and the timer carries on', async t => {
  const r = rig(t);
  await r.host.applyAccounts([{id: A, site: SITE}], 1);
  await r.host.run(task({account: A, deviceId: AGENT}));
  const sb = r.host.shared();
  let passes = 0;
  sb.sweep = () => { passes++; return Promise.reject(new Error('boom')); };
  const lines = [];
  const was = console.error; console.error = line => lines.push(String(line));
  t.after(() => { console.error = was; });
  r.host.startSweeps();
  for (let i = 0; i < 100 && passes < 2; i++) await sleep(10);
  await r.host.close();
  console.error = was;
  assert.ok(passes >= 2);
  assert.ok(lines.some(l => /sweep/.test(l)));
});

test('with accounts off, no jar is opened, wiped or reported, and an account task is refused even with a browser', async t => {
  const r = rig(t, {accounts: false});
  r.otherJars('some-other-secret').save(A, [SID]);        // a jar this run's secret cannot open
  r.otherJars('some-other-secret').save(B, [SID]);
  await r.host.applyAccounts([{id: A, site: SITE}], 1);   // a list that omits B
  assert.deepEqual(r.otherJars('some-other-secret').ids().sort(), [A, B], 'nothing is wiped');
  await assert.rejects(r.host.run(task({account: A, deviceId: AGENT})), /cannot use\.$/);
  await assert.rejects(r.host.capture(task({account: A, deviceId: AGENT}), {browser: true, readPlain: async () => ({text: 'plain'})}), /cannot use\.$/);
  assert.equal(r.processes.length, 0);
  assert.equal(r.otherJars('some-other-secret').load(A)?.[0].value, MARKER, 'the jar was never loaded, so never removed');
  assert.deepEqual(r.host.accountReport(), []);
  assert.equal((await r.host.run(task({}))).text, 'signed out', 'the default profile still works');
});
