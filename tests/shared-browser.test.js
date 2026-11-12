import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {browserArgs, startBrowserSession} from '../agent/browser.mjs';
import {browserProfileDir, ensureProfileDir, createSharedBrowser, runBrowserTask} from '../agent/shared-browser.mjs';
import {fakeCdp} from './fake-cdp.js';

/* One persistent profile for every bot. These tests run the real session code
 * against a scripted DevTools connection (tests/fake-cdp.js): no Chrome starts. */

const ALLOW = ['docs.example.com', 'mail.example.com'];
const PAGES = {
  'https://docs.example.com/': {title: 'Docs', text: 'Hello docs', elements: [{index: 1, tag: 'a', text: 'Next'}]},
  'https://mail.example.com/': {title: 'Mail', text: 'Inbox', elements: []},
};
const tmp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-browser-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  return dir;
};
/** A shared browser over one fake DevTools connection per browser "process". */
function rig(t, {pages = PAGES, profile = path.join(tmp(t), 'browser-profile')} = {}) {
  const processes = [];
  const sb = createSharedBrowser({
    allow: ALLOW, profile,
    start: async ({profile}) => {
      const fake = fakeCdp({pages});
      processes.push(fake);
      return startBrowserSession({connection: fake.connection, profile});
    },
    settleMs: 0,
  });
  t.after(() => sb.close());
  return {sb, processes, profile};
}
const navigations = fake => fake.called('Page.navigate').map(c => [c.sessionId, c.params.url]);

test('the profile lives in the agent config dir, is private, and the browser is started on it', t => {
  const config = path.join(tmp(t), 'agent.config.json');
  assert.equal(browserProfileDir({}, config), path.join(path.dirname(config), 'browser-profile'));
  assert.equal(browserProfileDir({AGENT_BROWSER_PROFILE: '/somewhere/else'}, config), '/somewhere/else', 'an explicit directory wins');
  const dir = browserProfileDir({}, config);
  fs.mkdirSync(dir, {mode: 0o755});
  fs.chmodSync(dir, 0o755);
  assert.equal(ensureProfileDir(dir), dir);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700, 'an existing 0755 directory is repaired to 0700');
  const fresh = path.join(tmp(t), 'a', 'b', 'browser-profile');
  ensureProfileDir(fresh);
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o700, 'a new directory is created private');
  assert.ok(browserArgs({profile: dir, proxyPort: 1234}).includes(`--user-data-dir=${dir}`), 'Chrome runs on that profile, not a throwaway one');
});

test('one browser is kept between tasks, and a task never opens a throwaway context', async t => {
  const {sb, processes} = rig(t);
  const first = await sb.run('bot-a', {url: 'https://docs.example.com/'});
  const second = await sb.run('bot-a', {url: 'https://mail.example.com/'});
  assert.equal(processes.length, 1, 'the browser started once');
  assert.deepEqual([first.title, second.title], ['Docs', 'Mail']);
  assert.equal(processes[0].closed, false, 'and is still running between tasks');
  assert.equal(processes[0].called('Target.createBrowserContext').length, 0, 'the default context is the profile; a fresh context would forget every sign-in');
  assert.equal(processes[0].called('Target.disposeBrowserContext').length, 0);
  assert.equal(processes[0].called('Target.closeTarget').length, 0, 'the tab stays open too');
});

test('each bot gets its own tab, and it keeps it', async t => {
  const {sb, processes} = rig(t);
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  await sb.run('bot-b', {url: 'https://mail.example.com/'});
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  const [fake] = processes;
  assert.equal(fake.called('Target.createTarget').length, 2, 'two bots, two tabs');
  const [a1, b, a2] = navigations(fake);
  assert.notEqual(a1[0], b[0], 'bot B did not use bot A\'s tab');
  assert.equal(a1[0], a2[0], 'bot A came back to the same tab');
  assert.deepEqual(sb.status().map(s => [s.botId, s.state]).sort(), [['bot-a', 'idle'], ['bot-b', 'idle']]);
});

test('two bots asking at once: one waits, and neither takes the other\'s tab', async t => {
  const {sb, processes} = rig(t);
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  const [fake] = processes;
  // Hold bot A's next page load open, and let bot B ask while it is in flight.
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  fake.hook('Page.navigate', async () => { await gate; });
  const a = sb.run('bot-a', {url: 'https://docs.example.com/'});
  const b = sb.run('bot-b', {url: 'https://mail.example.com/'});
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(fake.called('Page.navigate').length, 2, 'B has not started: A holds the browser');
  assert.equal(sb.status().find(s => s.botId === 'bot-a').state, 'browsing');
  release();
  const [ra, rb] = await Promise.all([a, b]);
  assert.deepEqual([ra.title, rb.title], ['Docs', 'Mail']);
  const sessions = navigations(fake).map(([s]) => s);
  assert.equal(new Set(sessions).size, 2);
  assert.equal(fake.called('Target.createTarget').length, 2);
});

test('the queue is first come, first served, and a failing task does not strand the next', async t => {
  const {sb, processes} = rig(t);
  const order = [];
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  const [fake] = processes;
  let n = 0;
  fake.hook('Page.navigate', async () => { if (++n === 1) throw new Error('net::ERR_FAILED'); });
  const jobs = ['bot-a', 'bot-b', 'bot-c'].map((id, i) => sb.run(id, {url: 'https://docs.example.com/'}).then(() => order.push(id), () => order.push(`${id}!`)));
  await Promise.all(jobs);
  assert.deepEqual(order, ['bot-a!', 'bot-b', 'bot-c']);
});

test('the profile survives a restart and stale tab ids are dropped', async t => {
  const profile = path.join(tmp(t), 'browser-profile');
  const first = rig(t, {profile});
  await first.sb.run('bot-a', {url: 'https://docs.example.com/'});
  const oldTab = first.processes[0].called('Target.createTarget').length;
  assert.equal(oldTab, 1);
  await first.sb.close();
  assert.ok(fs.existsSync(profile), 'closing the browser keeps the profile');
  assert.equal(fs.statSync(profile).mode & 0o777, 0o700);
  // A new agent process: no tab ids carry over, so bot A gets a fresh tab.
  const second = rig(t, {profile});
  assert.deepEqual(second.sb.status(), []);
  await second.sb.run('bot-a', {url: 'https://docs.example.com/'});
  assert.equal(second.processes[0].called('Target.createTarget').length, 1);
  // A tab the browser no longer has (closed, crashed) is replaced, not reused.
  const [fake] = second.processes;
  fake.targets.clear();
  await second.sb.run('bot-a', {url: 'https://docs.example.com/'});
  assert.equal(fake.called('Target.createTarget').length, 2, 'a stale tab id is dropped and a new tab opened');
});

test('a browser that died is started again on the next task, with fresh tabs', async t => {
  const {sb, processes} = rig(t);
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  processes[0].die();
  const next = await sb.run('bot-a', {url: 'https://docs.example.com/'});
  assert.equal(next.title, 'Docs');
  assert.equal(processes.length, 2);
  assert.equal(processes[1].called('Target.createTarget').length, 1);
});

test('the allowlist is checked before any browser is started', async t => {
  const {sb, processes} = rig(t);
  await assert.rejects(sb.run('bot-a', {url: 'https://evil.example.net/'}), /not in AGENT_BROWSER_ALLOWLIST/);
  assert.equal(processes.length, 0, 'a host nobody allowed costs no process');
});

test('a tab\'s own guard blocks a document off the allowlist, and the count reaches the result', async t => {
  const {sb, processes} = rig(t);
  await sb.run('bot-a', {url: 'https://docs.example.com/'});
  const [fake] = processes;
  // While the page loads it asks for a document on a host nobody allowed.
  fake.hook('Page.navigate', async (params, sessionId) => {
    fake.emit('Fetch.requestPaused', {requestId: 'r1', request: {url: 'https://evil.example.net/', method: 'GET'}, resourceType: 'Document'}, sessionId);
    fake.emit('Fetch.requestPaused', {requestId: 'r2', request: {url: 'https://cdn.example.net/a.js', method: 'GET'}, resourceType: 'Script'}, sessionId);
  });
  const result = await sb.run('bot-a', {url: 'https://docs.example.com/'});
  assert.deepEqual(fake.called('Fetch.failRequest').map(c => c.params.requestId), ['r1']);
  assert.deepEqual(fake.called('Fetch.continueRequest').map(c => c.params.requestId), ['r2']);
  assert.equal(result.blockedRequests, 1);
});

test('browser.action steps run on the bot\'s tab and report each outcome', async t => {
  const {sb, processes} = rig(t);
  const result = await sb.run('bot-a', {url: 'https://docs.example.com/', steps: [{op: 'click', index: 1}, {op: 'read', selector: 'main'}]});
  assert.equal(result.actions.length, 2);
  assert.equal(result.actions.every(a => a.ok), true);
  assert.equal(processes[0].actions.length, 2, 'both steps were evaluated in the page');
  assert.equal(new Set(processes[0].actions.map(a => a.sessionId)).size, 1, 'on one tab');
});

test('runBrowserTask holds the same rules the old path held', async t => {
  const {sb} = rig(t);
  const env = {AGENT_BROWSER: '1'};
  await assert.rejects(runBrowserTask({kind: 'browser.capture', payload: {url: 'https://evil.example.net/'}}, {shared: sb, allow: ALLOW, env}), /not in AGENT_BROWSER_ALLOWLIST/);
  await assert.rejects(runBrowserTask({kind: 'browser.action', payload: {url: 'https://docs.example.com/', steps: []}}, {shared: sb, allow: ALLOW, env}), /at least one step/);
  await assert.rejects(runBrowserTask({kind: 'browser.action', payload: {url: 'https://docs.example.com/', steps: [{op: 'fly'}]}}, {shared: sb, allow: ALLOW, env}), /Unsupported action "fly"/);
  await assert.rejects(runBrowserTask({kind: 'browser.action', payload: {url: 'https://docs.example.com/', steps: [{op: 'read', selector: 'a'}]}}, {shared: sb, allow: ALLOW, env: {}}), /AGENT_BROWSER=1/);
  const page = await runBrowserTask({kind: 'browser.capture', payload: {url: 'https://docs.example.com/', botId: 'bot-9'}}, {shared: sb, allow: ALLOW, env});
  assert.equal(page.title, 'Docs');
  assert.deepEqual(sb.status().map(s => s.botId), ['bot-9'], 'the bot named in the task got the tab');
  const anon = await runBrowserTask({kind: 'browser.capture', payload: {url: 'https://mail.example.com/'}}, {shared: sb, allow: ALLOW, env});
  assert.equal(anon.title, 'Mail');
  assert.equal(sb.status().length, 2, 'a task that names no bot shares one anonymous tab');
});
