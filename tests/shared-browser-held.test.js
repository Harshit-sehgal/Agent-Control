import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrowserSession} from '../agent/browser.mjs';
import {createSharedBrowser, runBrowserTask} from '../agent/shared-browser.mjs';
import {fakeCdp} from './fake-cdp.js';

/* A computer serves only the accounts its server's latest list names, and a wipe takes the owner's hold with it.
 * Against the scripted DevTools connection: no Chrome starts. */

const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const B = '0a1b2c3d-0000-4000-8000-00000000000b';
const SITE = 'crm.example.com';
const HOME = `https://${SITE}/`;
const SID = {name: 'sid', value: 'abc', domain: SITE, path: '/'};
const NO_ACCOUNT = /^Error: This task names a browser account this device cannot use\.$/;
const OTHER = /^Error: This task is for another computer, so it was not run\.$/;
const within = (promise, ms, why) => Promise.race([promise, new Promise((_, reject) => { const id = setTimeout(() => reject(new Error(why)), ms); promise.finally(() => clearTimeout(id)).catch(() => {}); })]);

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
function rig(t, {jars = memJars(), extra = {}} = {}) {
  const processes = [];
  const sb = createSharedBrowser({
    allow: [SITE], settleMs: 0, jars, ...extra,
    start: async () => { const fake = fakeCdp({pages: {[HOME]: {title: 'CRM', text: 'Inbox', elements: []}}}); processes.push(fake); return startBrowserSession({connection: fake.connection}); },
  });
  t.after(() => sb.close());
  return {sb, jars, processes};
}

test('with requireListed, an account the list does not name is refused before a browser starts or a jar is written', async t => {
  const {sb, jars, processes} = rig(t, {jars: memJars({[A]: [SID]}), extra: {requireListed: true}});
  await assert.rejects(sb.run('scout', {url: HOME, account: A}), NO_ACCOUNT, 'no list yet');
  await assert.rejects(sb.takeover('scout', A), /cannot use\.$/);
  await sb.setAccounts([{id: B, site: SITE}]);
  await assert.rejects(sb.run('scout', {url: HOME, account: A}), NO_ACCOUNT, 'a list without it');
  await assert.rejects(sb.takeover('scout', A), /cannot use\.$/);
  assert.equal(processes.length, 0, 'nothing started');
  assert.deepEqual(jars.saves, [], 'no jar was written');
  assert.equal((await sb.run('scout', {url: HOME})).text, 'Inbox', 'the default profile needs no list');
  await sb.setAccounts([{id: A, site: SITE}]);
  assert.equal((await sb.run('scout', {url: HOME, account: A})).text, 'Inbox', 'listed: it runs');
  assert.deepEqual(jars.saves, [A]);
});

test('an account dropped from the list while a task waits for its tab never gets a context or a jar', async t => {
  const {sb, jars, processes} = rig(t, {jars: memJars({[A]: [SID]}), extra: {requireListed: true}});
  await sb.setAccounts([{id: A, site: SITE}]);
  await sb.takeover('scout', A);
  const waiting = sb.run('scout', {url: HOME, account: A});     // waits for the hand back
  await new Promise(r => setTimeout(r, 50));
  await sb.setAccounts([]);
  await within(assert.rejects(waiting, /cannot use\.$/), 2000, 'the waiting task hung');
  assert.deepEqual(processes[0].contexts(), [], 'no context came back for it');
  assert.deepEqual(jars.ids(), [], 'and no jar');
});

test('a wipe drops the owner\'s hold on that account\'s tab, so another bot can be taken', async t => {
  const {sb, jars} = rig(t, {jars: memJars({[A]: [SID]}), extra: {requireListed: true}});
  await sb.setAccounts([{id: A, site: SITE}]);
  await sb.takeover('scout', A);
  assert.equal(sb.owner(), 'scout');
  await assert.rejects(sb.takeover('writer'), /already driving/);
  await sb.setAccounts([]);
  assert.equal(sb.owner(), null, 'the hold is gone');
  await assert.rejects(sb.applyInput('scout', {type: 'click', x: 1, y: 2}), /not driving/);
  assert.deepEqual(jars.ids(), []);
  await sb.takeover('writer');
  assert.equal(sb.owner(), 'writer');
});

test('a wipe that lands while a takeover is still opening its tab drops that hold too', async t => {
  const {sb} = rig(t, {extra: {requireListed: true}});
  await sb.setAccounts([{id: A, site: SITE}]);
  const taking = sb.takeover('scout', A);
  await sb.setAccounts([]);                                     // before the tab exists: nothing for letGo to find
  await taking.catch(() => {});
  assert.equal(sb.owner(), null);
});

test('a task for an account must name this computer: a missing, another or unknown device id is refused', async t => {
  const {sb, processes} = rig(t, {extra: {requireListed: true}});
  await sb.setAccounts([{id: A, site: SITE}]);
  const task = payload => ({kind: 'browser.capture', payload: {url: HOME, botId: 'scout', ...payload}});
  const run = (payload, agentId) => runBrowserTask(task(payload), {shared: sb, allow: [SITE], agentId});
  await assert.rejects(run({account: A}, 'pc-1'), NO_ACCOUNT, 'no deviceId');
  await assert.rejects(run({account: A, deviceId: ''}, 'pc-1'), NO_ACCOUNT, 'an empty one');
  await assert.rejects(run({account: A, deviceId: 'pc-2'}, 'pc-1'), OTHER);
  await assert.rejects(run({account: A, deviceId: 'pc-1'}, null), NO_ACCOUNT, 'a device that does not know its own id verifies nothing');
  await assert.rejects(run({account: A, deviceId: 'pc-1'}, undefined), NO_ACCOUNT);
  await assert.rejects(run({account: '../x', deviceId: 'pc-1'}, 'pc-1'), NO_ACCOUNT);
  await assert.rejects(run({deviceId: 'pc-2'}, 'pc-1'), OTHER, 'a device id alone is checked too');
  assert.equal(processes.length, 0, 'none of that started a browser');
  assert.equal((await run({account: A, deviceId: 'pc-1'}, 'pc-1')).text, 'Inbox');
  assert.equal((await run({}, 'pc-1')).text, 'Inbox', 'no account and no device id (an older server) still runs');
});
