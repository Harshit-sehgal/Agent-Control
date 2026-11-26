/* The one test that fails when any path lets a typed secret out.
 *
 * The owner types a unique marker in secret into a page. The page then echoes it the ways real sites do: in its
 * title, in its address, in its text, in a link, in a field it draws again after a failed sign-in, and in what a
 * read step returns. A bot then captures the page and reads it, the owner hands the page back, and a run is
 * stored. The marker, in any letter case and percent-encoded, must be in no model request body, no console line,
 * no chat line, no activity line, no stored state and no byte of the database.
 *
 * Both takeover paths run: the device's shared browser (the Computer view) and the server's own browser (the
 * takeover sheet), each against the scripted DevTools connection (tests/fake-cdp.js), so no Chrome starts. One
 * variant drives a real Chrome against a local page when one is installed. It keeps off port 4173 and the real
 * data/state.json: every store here is a temporary directory.
 *
 * Failure messages never print the marker: an assertion says which sink held it, not what it held.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import * as agent from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import * as wf from '../shared/workflow.js';
import {createRun} from '../shared/coordination.js';
import {coordinationState, runGroup, resumeBrowserRun} from '../src/coordination.js';
import {onAgentTaskResult, setBrowserResultHooks, beginTakeover, handBackTakeover} from '../src/bot-browser.js';
import {createBrowserRuntime} from '../src/browser-runtime.js';
import {BROWSER_PERMISSION} from '../shared/bot-browser.js';
import {findBrowser, startBrowserSession} from '../agent/browser.mjs';
import {createSharedBrowser, runBrowserTask} from '../agent/shared-browser.mjs';
import {fakeCdp} from './fake-cdp.js';

const HOST = 'docs.example.com';
const PAGE = `https://${HOST}/`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const block = body => `Let me look.\n\`\`\`browser\n${JSON.stringify(body)}\n\`\`\`\nBack soon.`;

/** The marker, and every spelling a site may give it back in. */
const makeMarker = () => `Planted-${randomUUID().replace(/-/g, '').slice(0, 10)}-Zq9`;
const spellings = marker => [marker, marker.toUpperCase(), marker.toLowerCase(), encodeURIComponent(marker), encodeURIComponent(marker).toLowerCase()];
/** The names of the sinks that hold the marker, never the marker itself. */
const holding = (marker, sinks) => Object.entries(sinks).filter(([, text]) => {
  const lower = String(text).toLowerCase();
  return spellings(marker).some(spelling => lower.includes(spelling.toLowerCase()));
}).map(([name]) => name);

/** What a site that echoes a typed value shows: the marker, in the case the site likes. */
const echoing = marker => ({
  title: `Sign in failed for ${marker.toUpperCase()}`,
  shown: `${PAGE}login?error=1&retry=${encodeURIComponent(marker)}`,
  text: `That code did not work. You typed ${marker}. Try again.`,
  links: [{text: `Resend to ${marker}`, url: `${PAGE}resend?c=${marker.toLowerCase()}`}],
  elements: [{index: 1, tag: 'input', type: 'text', text: `Code ${marker}`}, {index: 2, tag: 'button', text: 'Sign in'}],
  read: `Last try: ${marker.toLowerCase()}`,
});

/** A store, a bot with a browser grant, a paired device, and a model that is a function that records what it was asked. */
async function rig(t, {device = true} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-planted-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  const bot = {id: 'web', name: 'Web', instructions: 'Look things up.', type: 'custom', permissions: [BROWSER_PERMISSION], settings: {browserApproval: 'auto'}};
  await store.update(s => {
    wf.migrate(s); coordinationState(s);
    s.groups = [{id: 'lab', name: 'Lab', bots: [bot]}];
    s.grants = [{botId: 'web', action: 'browser.use', scope: `https://${HOST}`, choice: 'always', at: new Date().toISOString()}];
  });
  const bodies = [];
  const executor = async (_bot, raw) => {
    bodies.push(String(raw));
    return JSON.parse(raw).page ? 'I read it.' : block({url: PAGE, steps: [{op: 'read', selector: 'main'}]});
  };
  const hooks = {continueRun: async () => {}, resumeBrowser: (s, request, options) => resumeBrowserRun(s, request, {...options, executor})};
  setBrowserResultHooks(hooks);
  const paired = device ? agent.redeemPairing(store, {code: agent.createPairing(store, 'default', {}).code, name: 'Laptop', permissions: ['browser.action']}) : null;
  /** The bot is asked to look at the page. Its request goes to the device (or waits). */
  const startRun = async id => {
    await store.update(s => { s.groupRuns.push(createRun({group: s.groups[0], message: 'Find the docs', makeId: () => id, chatKey: 'web'})); });
    await runGroup(store, id, executor);
    return store.read().browserRequests.find(r => r.runId === id);
  };
  /** Every place a typed value could have been put, as text. */
  const sinks = () => {
    const state = store.read();
    const database = fs.readdirSync(dir).map(name => fs.readFileSync(path.join(dir, name)).toString('latin1')).join('\n');
    const tasks = store.all ? JSON.stringify(store.all('SELECT * FROM agent_tasks')) : '';
    return {
      'a model request body': bodies.join('\n'),
      'a chat line': JSON.stringify(state.chats),
      'an activity line': JSON.stringify(state.activity),
      'the stored state': JSON.stringify(state),
      'a stored task': tasks,
      'the database files': database,
    };
  };
  return {store, bodies, executor, hooks, paired, startRun, sinks, dir};
}

/** Count every console line while `fn` runs. */
async function consoleOf(fn) {
  const lines = [], keep = {...console};
  const spy = (...args) => { lines.push(args.map(String).join(' ')); };
  Object.assign(console, {log: spy, info: spy, warn: spy, error: spy, debug: spy, trace: spy});
  try { await fn(); } finally { Object.assign(console, keep); }
  return lines.join('\n');
}

const until = async (check, note) => {
  for (let i = 0; i < 200; i++) { const value = check(); if (value) return value; await sleep(15); }
  throw new Error(`timed out waiting for ${note}`);
};

test('the device path: a secret the owner typed reaches no model, log, chat line, activity line or stored page', async t => {
  const marker = makeMarker();
  const r = await rig(t);
  const pages = {[PAGE]: {title: 'Sign in', text: 'Enter your code', elements: [{index: 1, tag: 'input', type: 'password', text: 'password field'}]}};
  const sb = createSharedBrowser({allow: [HOST], settleMs: 0, start: async () => startBrowserSession({connection: fakeCdp({pages}).connection})});
  t.after(() => sb.close());
  const lines = await consoleOf(async () => {
    // The owner signs in through the Computer view's masked field, and the site then echoes what it was given.
    await sb.run('web', {url: PAGE});
    await sb.takeover('web');
    await sb.applyInput('web', {type: 'type', text: marker, secret: true});
    await sb.applyInput('web', {type: 'key', key: 'Enter'});
    await sb.handback('web');
    pages[PAGE] = echoing(marker);
    // The bot asks for the page; the device runs it with the code that runs on a real device.
    const request = await r.startRun('run-device');
    assert.equal(request.status, 'dispatched', 'the page went to the device');
    const [task] = agent.claimAgentTasks(r.store, r.paired.agentId);
    const result = await runBrowserTask({kind: task.kind, payload: JSON.parse(task.payload)}, {shared: sb, allow: [HOST], env: {AGENT_BROWSER: '1'}});
    assert.deepEqual(holding(marker, {'the device result': JSON.stringify(result)}), [], 'the device result carries the marker');
    assert.ok(/\[hidden\]/.test(JSON.stringify(result)), 'the page was scrubbed, not just empty');
    agent.completeAgentTask(r.store, r.paired.agentId, task.id, {status: 'done', result});
    await onAgentTaskResult(r.store, task.id, r.hooks);
    await until(() => r.store.read().groupRuns.find(x => x.id === 'run-device')?.status === 'completed', 'the run to finish');
  });
  assert.ok(r.bodies.some(body => JSON.parse(body).page?.includes('[hidden]')), 'the bot was handed the page with the secret hidden');
  assert.deepEqual(holding(marker, {...r.sinks(), 'the console': lines}), []);
});

test('the server path: a hand back that stores a run carries no typed secret', async t => {
  const marker = makeMarker();
  const r = await rig(t);
  const request = await r.startRun('run-server');
  assert.equal(request.status, 'dispatched');
  const pages = {[PAGE]: {title: 'Sign in', text: 'Enter your code', elements: []}};
  const runtime = createBrowserRuntime({
    env: {BROWSER_RUNTIME: 'server', AGENT_BROWSER_ALLOWLIST: HOST}, find: () => '/fake/chrome',
    start: async () => startBrowserSession({connection: fakeCdp({pages}).connection}),
  });
  t.after(() => runtime.close());
  const lines = await consoleOf(async () => {
    const opened = await beginTakeover(r.store, request.id, {actor: 'owner@example.test', workspaceId: 'default', runtime});
    // The owner types into the takeover sheet's masked field; the site then echoes it.
    const typed = await runtime.liveAct(opened.id, {op: 'type', index: 1, text: marker, secret: true}, {workspaceId: 'default'});
    assert.deepEqual(holding(marker, {'the typing answer': JSON.stringify(typed)}), []);
    pages[PAGE] = echoing(marker);
    const look = await runtime.liveView(opened.id, {workspaceId: 'default'});
    assert.deepEqual(holding(marker, {'the live view': JSON.stringify(look)}), []);
    const acted = await runtime.liveAct(opened.id, {op: 'read', selector: 'main'}, {workspaceId: 'default'});
    assert.deepEqual(holding(marker, {'a read answer': JSON.stringify(acted)}), []);
    assert.ok(/\[hidden\]/.test(JSON.stringify(acted)), 'the read answer was scrubbed, not just empty');
    const back = await handBackTakeover(r.store, opened.id, {workspaceId: 'default', runtime});
    assert.equal(back.handedBack, true);
    assert.deepEqual(holding(marker, {'the handed back page': JSON.stringify(back)}), []);
    await until(() => r.store.read().groupRuns.find(x => x.id === 'run-server')?.status === 'completed', 'the run to finish');
  });
  assert.ok(r.bodies.some(body => JSON.parse(body).page?.includes('[hidden]')), 'the bot was handed the page with the secret hidden');
  assert.ok(r.store.read().browserRequests.some(x => /\[hidden\]/.test(JSON.stringify(x.result))), 'the stored request holds the hidden page');
  assert.deepEqual(holding(marker, {...r.sinks(), 'the console': lines}), []);
});

test('the assertions can fail: a marker that is left in a sink is found, in any case and encoded', () => {
  const marker = makeMarker();
  for (const text of [marker, marker.toUpperCase(), `?x=${encodeURIComponent(marker)}`, `a ${marker.toLowerCase()} b`]) assert.deepEqual(holding(marker, {sink: text}), ['sink']);
  assert.deepEqual(holding(marker, {sink: '[hidden] and planted'}), []);
});

const browser = findBrowser();
test('a real Chrome: typed in secret, echoed by the next page, and the page\'s field emptied after the submit', {skip: !browser && 'no browser installed', timeout: 90000}, async t => {
  const marker = makeMarker();
  // A site that keeps the last failed sign-in and shows it back on every page load: in the title, in the text and
  // in a plain field it draws again. Its form never navigates; a script sends the attempt and the page stays.
  let last = '';
  const escape = text => text.replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/fail') { last = url.searchParams.get('pw') || ''; res.writeHead(204).end(); return; }
    res.writeHead(200, {'Content-Type': 'text/html'});
    res.end(`<!doctype html><title>${last ? `Failed for ${escape(last)}` : 'Sign in'}</title><body style="margin:0">
<form id="f" style="position:absolute;left:20px;top:20px">
<input id="pw" type="password" placeholder="Password" style="position:absolute;left:0;top:0;width:300px;height:40px">
<button id="go" type="submit" style="position:absolute;left:0;top:60px;width:300px;height:40px">Sign in</button></form>
<main id="m" style="position:absolute;left:20px;top:140px">${last ? `<p>You typed ${escape(last)}</p><input id="again" type="text" value="${escape(last)}">` : ''}</main>
<script>document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); fetch('/fail?pw=' + encodeURIComponent(document.getElementById('pw').value)); });</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const host = `127.0.0.1:${server.address().port}`;
  const base = `http://${host}/`;
  const tabs = [];
  const start = async opts => {
    const live = await startBrowserSession({binary: browser, permit: h => h !== 'localhost', ...opts});
    const open = live.newTab;
    live.newTab = async options => { const tab = await open(options); tabs.push(tab); return tab; };
    return live;
  };
  let live = null;
  const shared = createSharedBrowser({allow: [host], settleMs: 100, start: async opts => (live = await start(opts))});
  t.after(async () => { await shared.close(); server.close(); });
  const field = async () => (await live.cdp.send('Runtime.evaluate', {returnByValue: true, expression: 'JSON.stringify({value: document.getElementById("pw").value, attr: document.getElementById("pw").hasAttribute("value")})'}, tabs.at(-1).sessionId)).result.value;
  const lines = await consoleOf(async () => {
    await shared.run('web', {url: base});
    await shared.takeover('web');
    await shared.applyInput('web', {type: 'click', x: 100, y: 40});
    await shared.applyInput('web', {type: 'type', text: marker, secret: true});
    assert.ok(JSON.parse(await field()).value === marker, 'the owner typed it into the real field');
    await shared.applyInput('web', {type: 'click', x: 100, y: 100});
    await until(() => last === marker, 'the site to get the attempt: the clearing must not cut the submit short');
    await sleep(2200);
    const after = JSON.parse(await field());
    assert.ok(after.value === '' && after.attr === false, 'the password field was emptied after the submit');
    await shared.handback('web');
    // The bot reloads the page, which now echoes the attempt, and reads it.
    const result = await shared.run('web', {url: base, steps: [{op: 'waitFor', selector: '#again'}, {op: 'read', selector: 'main'}]});
    assert.ok(result.actions.every(a => a.ok), 'the page showed what the site drew');
    assert.deepEqual(holding(marker, {'the capture': JSON.stringify(result)}), [], 'the capture carries the marker');
    assert.ok(/\[hidden\]/.test(JSON.stringify(result)), 'the capture was scrubbed, not just empty');
    assert.deepEqual(holding(marker, {'the status': JSON.stringify(shared.status())}), []);
  });
  assert.deepEqual(holding(marker, {'the console': lines}), []);
});
