import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import * as agent from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import * as wf from '../shared/workflow.js';
import {createApp} from '../src/app.js';
import {createLiveHub, browserLive, liveStates} from '../src/browser-live.js';
import {finishBrowserRequest} from '../src/bot-browser.js';

/* What the Computer view shows: idle, browsing or driving per bot, the page,
 * the site, and the pages of this run (or the last one). All of it is derived
 * from the run records the app already keeps and from the device's live report;
 * nothing new is stored. */

const WS = 'default';
const bot = (id, name) => ({id, name, instructions: 'x', type: 'custom', permissions: [], settings: {}});
let at = 0;
const request = (id, botId, extra = {}) => ({id, botId, botName: botId, groupId: 'lab', chatKey: botId, url: `https://${id}.example.com/`, steps: [], kind: 'browser.capture', depth: 0, status: 'done', agentTaskIds: [], result: {title: `Title ${id}`, finalUrl: `https://${id}.example.com/landed`, text: '', page: ''}, error: null, createdAt: new Date(Date.UTC(2026, 10, 11, 10, 0, ++at)).toISOString(), updatedAt: new Date(Date.UTC(2026, 10, 11, 10, 0, at)).toISOString(), ...extra});
const state = requests => ({groups: [{id: 'lab', name: 'Lab', bots: [bot('web', 'Web'), bot('mail', 'Mail'), bot('quiet', 'Quiet')]}], browserRequests: requests});
const by = list => Object.fromEntries(list.map(e => [e.botId, e]));
function hubRig() {
  let t = 5_000_000;
  const hub = createLiveHub({now: () => t, waitMs: 20});
  return {hub, tick: ms => { t += ms; }};
}

test('a bot with a request out is browsing, one the owner holds is driving, the rest are idle', async () => {
  const {hub} = hubRig();
  await hub.agentSync(WS, 'dev', {tabs: []});
  const s = state([request('a', 'web', {status: 'dispatched', result: null, runId: 'run-1'})]);
  let list = by(liveStates(s, {hub, ws: WS}));
  assert.deepEqual([list.web.state, list.mail.state, list.quiet.state], ['browsing', 'idle', 'idle']);
  assert.equal(list.web.runId, 'run-1');
  assert.equal(list.web.live, true);
  hub.takeover(WS, 'web');
  list = by(liveStates(s, {hub, ws: WS}));
  assert.equal(list.web.state, 'driving', 'the owner holding the tab wins over the bot\'s run, which is parked');
  hub.close();
});

test('the site is the host of the page the tab is on now, only while the bot browses or is driven', async () => {
  const {hub} = hubRig();
  const s = state([request('a', 'web', {status: 'dispatched', result: null}), request('b', 'mail')]);
  // No device report: the request's own address is the best there is.
  let list = by(liveStates(s, {hub, ws: WS}));
  assert.deepEqual([list.web.url, list.web.site], ['https://a.example.com/', 'a.example.com']);
  // The device says where the tab really is.
  await hub.agentSync(WS, 'dev', {tabs: [{botId: 'web', url: 'https://accounts.google.com/signin?x=1', title: 'Sign in'}, {botId: 'mail', url: 'https://mail.example.com/inbox', title: 'Inbox'}]});
  list = by(liveStates(s, {hub, ws: WS}));
  assert.deepEqual([list.web.url, list.web.title, list.web.site], ['https://accounts.google.com/signin?x=1', 'Sign in', 'accounts.google.com']);
  assert.equal(list.mail.state, 'idle');
  assert.equal(list.mail.site, null, 'an idle bot shows no site chip');
  assert.equal(list.mail.url, 'https://mail.example.com/inbox', 'but its tab\'s page is still known');
  hub.close();
});

test('pages are this run\'s, or the last run\'s when idle, in order, and only pages that opened', async () => {
  const {hub} = hubRig();
  const s = state([
    request('old', 'web', {runId: 'run-0'}),
    request('p1', 'web', {runId: 'run-1'}),
    request('bad', 'web', {runId: 'run-1', status: 'failed', result: null}),
    request('wait', 'web', {runId: 'run-1', status: 'pending', result: null}),
    request('p2', 'web', {runId: 'run-1'}),
  ]);
  const web = by(liveStates(s, {hub, ws: WS})).web;
  assert.deepEqual(web.pages.map(p => [p.url, p.title]), [['https://p1.example.com/landed', 'Title p1'], ['https://p2.example.com/landed', 'Title p2']]);
  assert.ok(web.pages.every(p => Date.parse(p.at) > 0));
  assert.equal(by(liveStates(s, {hub, ws: WS})).quiet.pages.length, 0);
  // A 1:1 chat has no run id: its chain of follow-up requests (depth 0, 1, 2) is the run.
  const chain = state([
    request('x0', 'mail', {depth: 0}), request('older', 'mail', {depth: 0}),
    request('c0', 'mail', {depth: 0}), request('c1', 'mail', {depth: 1}), request('c2', 'mail', {depth: 2}),
  ]);
  assert.deepEqual(by(liveStates(chain, {hub, ws: WS})).mail.pages.map(p => p.title), ['Title c0', 'Title c1', 'Title c2']);
  // The page being opened right now is listed too, without a title yet.
  const open = state([request('p1', 'web', {runId: 'run-1'}), request('now', 'web', {runId: 'run-1', status: 'dispatched', result: null})]);
  assert.deepEqual(by(liveStates(open, {hub, ws: WS})).web.pages.map(p => [p.url, p.title]), [['https://p1.example.com/landed', 'Title p1'], ['https://now.example.com/', null]]);
  // A page visited twice in a row is listed once, and the list is bounded.
  const repeat = state([request('same', 'web', {runId: 'r'}), request('same', 'web', {runId: 'r'})]);
  assert.equal(by(liveStates(repeat, {hub, ws: WS})).web.pages.length, 1);
  const many = state(Array.from({length: 40}, (_, i) => request(`m${i}`, 'web', {runId: 'r'})));
  assert.equal(by(liveStates(many, {hub, ws: WS})).web.pages.length, 20);
  hub.close();
});

test('a takeover that could not start drops the owner\'s hold and says why', async () => {
  const {hub} = hubRig();
  await hub.agentSync(WS, 'dev', {tabs: []});
  hub.takeover(WS, 'web');
  await hub.agentSync(WS, 'dev', {tabs: [], owner: null, failed: {botId: 'web', message: 'No Chrome, Chromium or Edge was found on this device.'}});
  assert.equal(hub.isDriving(WS, 'web'), false, 'dropped at once, not after the grace period');
  assert.match(hub.view(WS, 'web', {}).notice, /No Chrome/);
  hub.takeover(WS, 'web');
  assert.equal(hub.view(WS, 'web', {}).notice, undefined, 'a new takeover clears it');
  hub.close();
});

test('a tab the device last reported is forgotten when the device goes quiet', async () => {
  const {hub, tick} = hubRig();
  await hub.agentSync(WS, 'dev', {tabs: [{botId: 'web', url: 'https://a.example.com/', title: 'A'}]});
  assert.equal(hub.tab(WS, 'web').title, 'A');
  tick(120000);
  assert.equal(hub.tab(WS, 'web'), null);
  hub.close();
});

/* Over HTTP */

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-live-state-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  await store.update(s => { wf.migrate(s); s.groups = [{id: 'lab', name: 'Lab', bots: [bot('web', 'Web'), bot('mail', 'Mail')]}]; });
  const {code} = agent.createPairing(store, 'default', {});
  const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['browser.capture', 'browser.action']});
  const roles = {owner: 'owner', member: 'member', viewer: 'viewer'};
  const app = createApp({store, auth: {session: cookie => (roles[cookie] ? {email: `${cookie}@x.test`, role: roles[cookie], workspaceId: 'default'} : null)}, workspaces: {get: () => store, holding: () => store}, push: {}, version: 't'});
  const send = async (method, url, {cookie, body, signed = false} = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = {host: '127.0.0.1:4173', ...(cookie ? {cookie: `agent_session=${cookie}`} : {})};
    if (signed) { const ts = Date.now(); Object.assign(headers, {'x-agent-id': device.agentId, 'x-agent-ts': String(ts), 'x-agent-sig': agent.signRequest(device.secret, {method, path: url, timestamp: ts, body: text})}); }
    const req = Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {method, url, headers});
    const res = {status: null, body: null, writeHead(status) { this.status = status; return this; }, end(b) { this.body = b; }};
    await app.handler(req, res);
    return {status: res.status, body: res.body ? JSON.parse(res.body) : null};
  };
  return {dir, store, send};
}

test('over HTTP: takeover needs a live device, then input flows to it in order, and hand back ends it', async t => {
  const {dir, send} = await harness();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  browserLive.close();
  browserLive.waitMs = 20;
  t.after(() => browserLive.close());
  const input = body => send('POST', '/api/browser-live/web/input', {cookie: 'owner', body});
  // No device is polling: there is nothing to take over, and the state does not change.
  const refused = await send('POST', '/api/browser-live/web/takeover', {cookie: 'owner'});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /not running the shared browser/);
  assert.equal((await send('GET', '/api/browser-live', {cookie: 'member'})).body.find(e => e.botId === 'web').state, 'idle');
  assert.equal((await input({type: 'click', x: 1, y: 1})).status, 409, 'input while the owner is not driving is refused');
  // The device polls; the takeover goes through.
  await send('POST', '/api/agent/live', {body: {tabs: [{botId: 'web', url: 'https://docs.example.com/', title: 'Docs'}]}, signed: true});
  const taken = await send('POST', '/api/browser-live/web/takeover', {cookie: 'owner'});
  assert.deepEqual([taken.status, taken.body.state], [200, 'driving']);
  // The frame poll carries the same line the list does, so the view needs one request, not two.
  const viewed = (await send('GET', '/api/browser-live/web', {cookie: 'member'})).body;
  assert.deepEqual([viewed.state, viewed.url, viewed.title, viewed.site, viewed.agent], ['driving', 'https://docs.example.com/', 'Docs', 'docs.example.com', true]);
  const list = (await send('GET', '/api/browser-live', {cookie: 'member'})).body;
  assert.ok(Array.isArray(list));
  assert.deepEqual(list.map(e => [e.botId, e.state]).sort(), [['mail', 'idle'], ['web', 'driving']]);
  assert.equal(list.find(e => e.botId === 'web').site, 'docs.example.com');
  assert.equal((await input({type: 'click', x: 10, y: 20})).status, 200);
  assert.equal((await input({type: 'type', text: 'abc'})).status, 200);
  assert.equal((await input({type: 'eval'})).status, 400);
  assert.equal((await send('POST', '/api/browser-live/mail/input', {cookie: 'owner', body: {type: 'click', x: 1, y: 1}})).status, 409, 'driving one bot does not let you drive another');
  const poll = await send('POST', '/api/agent/live', {body: {tabs: [], owner: 'web'}, signed: true});
  assert.deepEqual(poll.body.commands.map(c => c.type), ['takeover', 'input', 'input']);
  // Hand back.
  const back = await send('POST', '/api/browser-live/web/handback', {cookie: 'owner'});
  assert.deepEqual([back.status, back.body.state], [200, 'idle']);
  assert.equal((await input({type: 'click', x: 1, y: 1})).status, 409);
  assert.deepEqual((await send('POST', '/api/agent/live', {body: {tabs: [], owner: null}, signed: true})).body.commands.map(c => c.type), ['handback']);
});

test('over HTTP: the list needs a signed-in member, takeover and hand back an admin, and the bot must exist', async t => {
  const {dir, send} = await harness();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  browserLive.close();
  browserLive.waitMs = 20;
  t.after(() => browserLive.close());
  await send('POST', '/api/agent/live', {body: {tabs: []}, signed: true});
  for (const [method, url] of [['GET', '/api/browser-live'], ['POST', '/api/browser-live/web/takeover'], ['POST', '/api/browser-live/web/handback']]) {
    assert.equal((await send(method, url)).status, 401, `${method} ${url} anonymous`);
    assert.equal((await send(method, url, {cookie: 'viewer'})).status, 403, `${method} ${url} viewer`);
  }
  // Driving the owner's signed-in browser is an admin's (Phases 5-6 review, I4).
  for (const url of ['/api/browser-live/web/takeover', '/api/browser-live/web/handback', '/api/browser-live/web/input']) assert.equal((await send('POST', url, {cookie: 'member', body: {type: 'click', x: 1, y: 1}})).status, 403, `${url} member`);
  assert.equal((await send('POST', '/api/browser-live/nobody/takeover', {cookie: 'owner'})).status, 404);
  assert.equal(browserLive.isDriving(WS, 'web'), false, 'none of that took anything over');
});

test('a result the owner interrupted tells the chat and the bot why the steps stopped', async t => {
  const {dir, store} = await harness();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  await store.update(s => { s.browserRequests = [request('x', 'web', {status: 'dispatched', result: null, chatKey: 'web'})]; });
  await finishBrowserRequest(store, store.read().browserRequests[0], {ok: true, result: {url: 'https://x.example.com/', finalUrl: 'https://x.example.com/after', title: 'After', text: 'Signed in as Ada', tookOver: true, actions: [{op: 'click', ok: true}, {op: 'click', ok: false, reason: 'You took over the browser, so this step was not run.'}]}});
  const done = store.read().browserRequests[0];
  assert.match(done.result.page, /The owner took over the browser while this ran, so the steps after that point were not run/);
  assert.match(done.result.page, /Signed in as Ada/, 'the page as they left it is still handed over');
  assert.match(store.read().chats.web.at(-1).text, /You took over the browser, so the steps after that point were not run/);
  // An ordinary result carries neither note.
  await store.update(s => { s.browserRequests = [request('y', 'web', {status: 'dispatched', result: null, chatKey: 'web'})]; });
  await finishBrowserRequest(store, store.read().browserRequests[0], {ok: true, result: {url: 'https://y.example.com/', title: 'Y', text: 'plain'}});
  assert.doesNotMatch(store.read().browserRequests[0].result.page, /took over/);
});
