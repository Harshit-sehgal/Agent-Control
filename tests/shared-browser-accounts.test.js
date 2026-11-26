import test from 'node:test';
import assert from 'node:assert/strict';
import {startBrowserSession} from '../agent/browser.mjs';
import {createSharedBrowser, runBrowserTask, tabKey} from '../agent/shared-browser.mjs';
import {taskKey} from '../agent/task-pool.mjs';
import {fakeCdp} from './fake-cdp.js';

/* Two bots on two accounts of one site each see their own sign-in. Against the scripted DevTools
 * connection (tests/fake-cdp.js): no Chrome starts. */

const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const B = '0a1b2c3d-0000-4000-8000-00000000000b';
const URL_ = 'https://docs.example.com/';
const WRONG = "This tab is not in the bot's browser account, so the step was not run.";
const MARKER = 'cookie-marker-7f3a';
/** The page shows the `who` cookie its own context holds: the sign-in it would really see. */
const PAGES = {[URL_]: ({cookies}) => ({title: 'Docs', text: cookies.find(c => c.name === 'who')?.value ?? 'signed out', elements: [{index: 1, tag: 'button', text: 'Go'}]})};
const who = value => ({name: 'who', value, domain: 'docs.example.com', path: '/'});

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
function rig(t, {jars = memJars(), wrap = null, extra = {}} = {}) {
  const processes = [];
  const sb = createSharedBrowser({
    allow: ['docs.example.com'], settleMs: 0, jars, ...extra,
    start: async () => {
      const fake = fakeCdp({pages: PAGES});
      processes.push(fake);
      const live = await startBrowserSession({connection: fake.connection});
      return wrap ? wrap(live) : live;
    },
  });
  t.after(() => sb.close());
  return {sb, jars, processes};
}
/** A session that hands back tabs claiming another context than the one they were made in. */
const lying = claimed => live => new Proxy(live, {get(target, prop) {
  if (prop === 'newTab') return async options => ({...(await target.newTab(options)), browserContextId: claimed});
  const value = target[prop];
  return typeof value === 'function' ? value.bind(target) : value;
}});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('two bots on two accounts of one site each see their own sign-in, side by side', async t => {
  const {sb, jars, processes} = rig(t, {jars: memJars({[A]: [who('alice')], [B]: [who('bob')]})});
  const [scout, writer] = await Promise.all([sb.run('scout', {url: URL_, account: A}), sb.run('writer', {url: URL_, account: B})]);
  assert.equal(scout.text, 'alice');
  assert.equal(writer.text, 'bob');
  const plain = await sb.run('plain', {url: URL_});
  assert.equal(plain.text, 'signed out', 'the default profile is nobody\'s account');
  const fake = processes[0];
  assert.equal(fake.contexts().length, 2, 'one context per account, none for the default profile');
  const made = fake.called('Target.createTarget').map(c => c.params.browserContextId ?? null);
  assert.deepEqual(made.filter(Boolean).sort(), fake.contexts().sort());
  assert.equal(made.filter(id => id === null).length, 1, 'the default-profile bot\'s tab has no account context');
  assert.deepEqual([...jars.saves].sort(), [A, B].sort(), 'each account\'s jar was saved once after its task');
  assert.deepEqual(sb.status().map(s => [s.botId, s.account]).sort(), [['plain', null], ['scout', A], ['writer', B]]);
});

test('one bot on two accounts gets two tabs and two lanes; the same account and bot share one', async t => {
  const {sb, processes} = rig(t, {jars: memJars({[A]: [who('alice')], [B]: [who('bob')]})});
  await sb.run('scout', {url: URL_, account: A});
  await sb.run('scout', {url: URL_, account: B});
  await sb.run('scout', {url: URL_, account: A});
  assert.equal(processes[0].called('Target.createTarget').length, 2, 'the second task on A reuses its tab');
  assert.equal(tabKey(A, 'scout'), `${A}\u0000scout`);
  assert.equal(tabKey(null, 'scout'), '\u0000scout');
  // The owner holding A's tab parks only that tab: the same bot's other tab goes on.
  await sb.takeover('scout', A);
  const other = await Promise.race([sb.run('scout', {url: URL_, account: B}), sleep(1500).then(() => 'waited')]);
  assert.equal(other.text, 'bob');
  assert.equal(sb.owner(), 'scout');
  await sb.handback('scout');
});

test('a stale context after the browser died is never used: the tab and context come back from the jar', async t => {
  const {sb, processes} = rig(t, {jars: memJars({[A]: [who('alice')]})});
  assert.equal((await sb.run('scout', {url: URL_, account: A})).text, 'alice');
  processes[0].die();
  const again = await sb.run('scout', {url: URL_, account: A});
  assert.equal(again.text, 'alice', 'the cookies came back from the jar');
  assert.equal(processes.length, 2);
  assert.equal(processes[1].called('Target.createBrowserContext').length, 1, 'a new context was made in the new browser');
  const [fresh] = processes[1].contexts();
  assert.deepEqual([...processes[1].targets.values()].map(target => target.browserContextId), [fresh], 'the tab used lives in the new context');
});

test('a context that vanished under a live browser is rebuilt from the jar', async t => {
  const {sb, processes} = rig(t, {jars: memJars({[A]: [who('alice')]})});
  await sb.run('scout', {url: URL_, account: A});
  const [old] = processes[0].contexts();
  await processes[0].cdp.send('Target.disposeBrowserContext', {browserContextId: old});
  const again = await sb.run('scout', {url: URL_, account: A});
  assert.equal(again.text, 'alice');
  assert.equal(processes[0].called('Target.createBrowserContext').length, 2);
  assert.notEqual(processes[0].contexts()[0], old);
});

test('a tab that is not in the account\'s context never serves a step, and nothing is navigated', async t => {
  for (const [label, account, claimed] of [['another context', A, 'C-elsewhere'], ['the default profile', A, null], ['an account context for a default-profile task', null, 'C-elsewhere']]) {
    const {sb, processes} = rig(t, {jars: memJars({[A]: [who('alice')]}), wrap: lying(claimed)});
    await assert.rejects(sb.run('scout', {url: URL_, account, steps: [{op: 'click', index: 1}]}), new RegExp(`^Error: ${WRONG.replace(/[.']/g, '\\$&')}$`), label);
    assert.equal(processes[0].called('Page.navigate').length, 0, `${label}: no navigation`);
    assert.equal(processes[0].actions.length, 0, `${label}: no step`);
  }
});

test('a step in flight when its context is replaced does not go on in the new one: its next step is refused', async t => {
  const {sb, processes} = rig(t, {jars: memJars({[A]: [who('alice')]})});
  await sb.run('scout', {url: URL_, account: A});
  const [fake] = processes;
  let seen = 0, release, began;
  const started = new Promise(resolve => { began = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  fake.hook('Runtime.evaluate', async ({expression}) => {
    if (expression === 'location.href' || expression.startsWith('(function(){var els=') || expression.startsWith('JSON.stringify(')) return undefined;
    if (++seen === 1) { began(); await held; }
    return undefined;
  });
  const task = sb.run('scout', {url: URL_, account: A, steps: [{op: 'click', index: 1}, {op: 'click', index: 1}]});
  const refused = assert.rejects(task, new RegExp(`^Error: ${WRONG.replace(/[.']/g, '\\$&')}$`));
  await started;
  // The context goes away under the live browser; the next task on the account builds a new one from the jar.
  await fake.cdp.send('Target.disposeBrowserContext', {browserContextId: fake.contexts()[0]});
  assert.equal((await sb.run('writer', {url: URL_, account: A})).text, 'alice');
  release();
  await refused;
  assert.equal(fake.actions.length, 1, 'only the step in flight ran');
});

test('a takeover and the bot\'s own first task open one tab, not two', async t => {
  for (const [first, second] of [['takeover', 'run'], ['run', 'takeover']]) {
    const {sb, processes} = rig(t, {jars: memJars({[A]: [who('alice')]})});
    const start = {takeover: () => sb.takeover('scout', A), run: () => sb.run('scout', {url: URL_, account: A})};
    const one = start[first](), two = start[second]();
    await Promise.race([sb.owner() === 'scout' ? one : two, sleep(300)]);
    await sb.handback('scout').catch(() => {});
    await Promise.all([one, two]).catch(() => {});
    await sb.handback('scout');
    assert.equal(processes[0].called('Target.createTarget').length, 1, `${first} then ${second}: one Target.createTarget`);
  }
});

test('an account task on a browser with no jars is refused, before anything starts', async t => {
  const {sb, processes} = rig(t, {jars: null});
  await assert.rejects(sb.run('scout', {url: URL_, account: A}), /^Error: This task names a browser account this device cannot use\.$/);
  await assert.rejects(sb.takeover('scout', A), /cannot use\.$/);
  assert.equal(processes.length, 0);
  assert.equal((await sb.run('scout', {url: URL_})).text, 'signed out', 'the default profile still works');
});

test('the device refuses a task for another computer or an account id it cannot use', async t => {
  const {sb} = rig(t);
  const task = payload => ({kind: 'browser.capture', payload: {url: URL_, botId: 'scout', ...payload}});
  const allow = ['docs.example.com'];
  await assert.rejects(runBrowserTask(task({account: A, deviceId: 'pc-2'}), {shared: sb, allow, agentId: 'pc-1'}), /^Error: This task is for another computer, so it was not run\.$/);
  await assert.rejects(runBrowserTask(task({account: '../x'}), {shared: sb, allow}), /^Error: This task names a browser account this device cannot use\.$/);
  await assert.rejects(runBrowserTask(task({account: 7}), {shared: sb, allow}), /cannot use\.$/);
  const ok = await runBrowserTask(task({account: A, deviceId: 'pc-1'}), {shared: sb, allow, agentId: 'pc-1'});
  assert.equal(ok.text, 'signed out', 'the right computer, a good id, an empty jar');
  const noDevice = await runBrowserTask(task({}), {shared: sb, allow, agentId: 'pc-1'});
  assert.equal(noDevice.text, 'signed out', 'a task with no deviceId (an older server) still runs');
});

test('no cookie value reaches a result, the status or an error', async t => {
  const {sb} = rig(t, {jars: memJars({[A]: [{...who(MARKER)}]})});
  const result = await sb.run('scout', {url: URL_, account: A});
  const seen = JSON.stringify([result.title, result.links, sb.status()]);
  assert.ok(!seen.includes(MARKER), 'the status carries no cookie');
  await assert.rejects(sb.run('scout', {url: 'https://nope.example.org/', account: A}), error => !String(error.message).includes(MARKER));
});

test('one lane per account and bot in the worker pool', () => {
  const task = payload => ({kind: 'browser.capture', payload});
  assert.notEqual(taskKey(task({botId: 'scout', account: A})), taskKey(task({botId: 'scout'})));
  assert.notEqual(taskKey(task({botId: 'scout', account: A})), taskKey(task({botId: 'scout', account: B})));
  assert.equal(taskKey(task({botId: 'scout', account: A})), taskKey({kind: 'browser.action', payload: {botId: 'scout', account: A}}));
});
