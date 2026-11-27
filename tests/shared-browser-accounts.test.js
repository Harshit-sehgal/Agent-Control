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
function rig(t, {jars = memJars(), wrap = null, extra = {}, pages = PAGES, allow = ['docs.example.com']} = {}) {
  const processes = [];
  const sb = createSharedBrowser({
    allow, settleMs: 0, jars, ...extra,
    start: async () => {
      const fake = fakeCdp({pages});
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

test('a tab that fails to open on a healthy context does not tear the context down', async t => {
  const {sb, jars, processes} = rig(t, {jars: memJars({[A]: [who('alice')]})});
  await sb.run('scout', {url: URL_, account: A});
  const [fake] = processes, [context] = fake.contexts(), saved = jars.saves.length;
  let failed = false;
  fake.hook('Target.createTarget', () => { if (!failed) { failed = true; throw new Error('Target closed'); } return undefined; });
  await assert.rejects(sb.run('writer', {url: URL_, account: A}), /Target closed/);
  assert.deepEqual(fake.contexts(), [context], 'the context is the same one');
  assert.equal(fake.called('Target.createBrowserContext').length, 1, 'no new context was made');
  assert.equal((await sb.run('scout', {url: URL_, account: A})).text, 'alice', 'the account\'s other tab goes on');
  assert.equal(fake.called('Target.disposeBrowserContext').length, 0);
  assert.ok(jars.saves.length > saved);
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
    await sleep(150); // a task asked while the owner holds the tab waits for the hand back
    await sb.handback('scout');
    const outcomes = await Promise.all([one, two]);
    assert.equal(outcomes.find(o => o?.text)?.text, 'alice', 'the task ran and read the account\'s page');
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

const TYPED = 'hunter22-marker';
const ECHO = 'https://echo.example.com/';
/** A page that says back what was typed into it, on a site two bots can reach. */
const ECHOING = {...PAGES, [ECHO]: {title: 'Echo', text: `you said ${TYPED}`, elements: [{index: 1, tag: 'button', text: 'Go'}]}};
const echoRig = (t, extra = {}) => rig(t, {pages: ECHOING, allow: ['docs.example.com', 'echo.example.com'], ...extra});

test('what the owner types in secret on one bot\'s account tab is hidden in another bot\'s tab of that account', async t => {
  const {sb} = echoRig(t);
  await sb.run('scout', {url: URL_, account: A});
  await sb.run('writer', {url: URL_, account: A});
  await sb.takeover('scout', A);
  await sb.applyInput('scout', {type: 'type', text: TYPED, secret: true});
  await sb.handback('scout');
  const writer = await sb.run('writer', {url: ECHO, account: A});
  const text = JSON.stringify(writer);
  assert.ok(!text.includes(TYPED), 'the marker reached the second bot\'s result');
  assert.ok(text.includes('[hidden]'), 'the echo is hidden in words');
  assert.ok(!JSON.stringify(sb.status()).includes(TYPED), 'nor the status');
  // The same account's other bot, a different account and no account: each keeps the memory it has.
  const other = await sb.run('atlas', {url: ECHO, account: B});
  assert.ok(JSON.stringify(other).includes(TYPED), 'another account\'s tab has its own memory');
  const plain = await sb.run('atlas', {url: ECHO});
  assert.ok(JSON.stringify(plain).includes(TYPED), 'a tab with no account keeps its own memory, empty here');
});

test('a tab opened after the owner typed still has that account\'s memory', async t => {
  const {sb} = echoRig(t);
  await sb.run('scout', {url: URL_, account: A});
  await sb.takeover('scout', A);
  await sb.applyInput('scout', {type: 'type', text: TYPED, secret: true});
  await sb.handback('scout');
  const late = await sb.run('late', {url: ECHO, account: A});
  assert.ok(!JSON.stringify(late).includes(TYPED) && JSON.stringify(late).includes('[hidden]'));
});

test('letting an account go forgets what was typed on it', async t => {
  const {sb} = echoRig(t);
  await sb.setAccounts([{id: A, site: 'docs.example.com'}]);
  await sb.run('scout', {url: URL_, account: A});
  await sb.takeover('scout', A);
  await sb.applyInput('scout', {type: 'type', text: TYPED, secret: true});
  await sb.handback('scout');
  assert.ok(!JSON.stringify(await sb.run('scout', {url: ECHO, account: A})).includes(TYPED), 'hidden while the account is held');
  await sb.setAccounts([]);
  await sb.setAccounts([{id: A, site: 'docs.example.com'}]);
  const again = await sb.run('scout', {url: ECHO, account: A});
  assert.ok(JSON.stringify(again).includes(TYPED), 'the memory went with the account: nothing is left to hide');
});

test('an account with nothing open any more still forgets what was typed on it when the server lets it go', async t => {
  // No jar is kept and no site is listed, so only the typed memory is left of the account once its idle tab is reaped.
  let clock = 1_800_000_000_000;
  const jars = {...memJars(), save() {}};
  const {sb} = echoRig(t, {jars, extra: {now: () => clock}});
  await sb.setAccounts([{id: A, site: ''}]);
  await sb.run('scout', {url: URL_, account: A});
  await sb.takeover('scout', A);
  await sb.applyInput('scout', {type: 'type', text: TYPED, secret: true});
  await sb.handback('scout');
  clock += 11 * 60000;
  await sb.sweep();
  assert.deepEqual(sb.status(), [], 'the idle tab is gone');
  await sb.setAccounts([{id: B, site: ''}]);
  await sb.setAccounts([{id: A, site: ''}, {id: B, site: ''}]);
  assert.ok(JSON.stringify(await sb.run('scout', {url: ECHO, account: A})).includes(TYPED), 'nothing of it is left to hide');
});
