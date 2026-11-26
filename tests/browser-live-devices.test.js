import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import * as agent from '../src/agent.js';
import {missingFeatureLine} from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import * as wf from '../shared/workflow.js';
import {createApp} from '../src/app.js';
import {createLiveHub, browserLive, liveStates} from '../src/browser-live.js';
import {BROWSER_ACCOUNTS_V1} from '../shared/device-features.js';

/* The live hub keeps one line per computer, so a takeover, an input event and a watch for a bot whose account or pin
 * names computer B are queued for B even when computer A polled last. An unpinned bot keeps "the computer that polled
 * last", so one computer behaves as it always did. */

const WS = 'default';
const A = '0a1b2c3d-0000-4000-8000-00000000000a';
const B = '0a1b2c3d-0000-4000-8000-00000000000b';
const click = {type: 'click', x: 5, y: 6};
const rig = (extra = {}) => { let t = 1_000_000; const hub = createLiveHub({now: () => t, waitMs: 25, ...extra}); return {hub, tick: ms => { t += ms; }}; };

test('with two computers, an account bot\'s takeover, input and watch go to the account\'s computer, not the last poller', async () => {
  const {hub} = rig();
  const fromB = hub.agentSync(WS, 'pc-b', {});           // B parks first
  const fromA = hub.agentSync(WS, 'pc-a', {});           // A polled last
  hub.takeover(WS, 'scout', {agentId: 'pc-b', account: A});
  assert.deepEqual((await fromB).commands, [{type: 'takeover', botId: 'scout', account: A}]);
  assert.deepEqual((await fromA).commands, []);
  hub.view(WS, 'scout', {agentId: 'pc-b'});
  const next = await hub.agentSync(WS, 'pc-b', {});
  assert.equal(next.watch, 'scout');
  assert.equal(next.watchAccount, A);
  hub.input(WS, 'scout', click, {agentId: 'pc-b', account: A});
  const typed = await hub.agentSync(WS, 'pc-b', {});
  assert.deepEqual(typed.commands.map(c => [c.type, c.botId, c.account]), [['input', 'scout', A]]);
  assert.deepEqual((await hub.agentSync(WS, 'pc-a', {})).commands, [], 'the other computer heard none of it');
  assert.equal((await hub.agentSync(WS, 'pc-a', {})).watch, null, 'and is not told to cast that tab');
  hub.handback(WS, 'scout', {agentId: 'pc-b', account: A});
  assert.deepEqual((await hub.agentSync(WS, 'pc-b', {})).commands, [{type: 'handback', botId: 'scout', account: A}]);
  hub.close();
});

test('an unpinned bot with one computer behaves exactly as before', async () => {
  const {hub} = rig();
  const parked = hub.agentSync(WS, 'pc-1', {});
  hub.takeover(WS, 'atlas');
  assert.deepEqual(await parked, {commands: [{type: 'takeover', botId: 'atlas'}], watch: null}, 'no account field, no watchAccount');
  hub.input(WS, 'atlas', click);
  assert.deepEqual((await hub.agentSync(WS, 'pc-1', {})).commands, [{type: 'input', botId: 'atlas', event: {type: 'click', x: 5, y: 6, double: false}}]);
  hub.view(WS, 'atlas', {});
  assert.deepEqual(await hub.agentSync(WS, 'pc-1', {}), {commands: [], watch: 'atlas'});
  assert.equal(hub.agentLive(WS), true);
  assert.equal(hub.agentId(WS), 'pc-1');
  hub.close();
});

test('an unpinned bot is served by whichever computer polled last', async () => {
  const {hub} = rig();
  await hub.agentSync(WS, 'pc-a', {});
  const last = hub.agentSync(WS, 'pc-b', {});
  hub.takeover(WS, 'atlas');
  assert.deepEqual((await last).commands, [{type: 'takeover', botId: 'atlas'}]);
  assert.equal(hub.agentId(WS), 'pc-b');
  hub.close();
});

test('an unpinned bot the owner holds stays on the computer it was taken over on, whichever polls next', async () => {
  const {hub} = rig();
  const x = hub.agentSync(WS, 'pc-x', {});
  hub.takeover(WS, 'atlas');
  assert.deepEqual((await x).commands, [{type: 'takeover', botId: 'atlas'}]);
  await hub.agentSync(WS, 'pc-y', {});                 // the other computer polls last now
  hub.input(WS, 'atlas', click);
  assert.deepEqual((await hub.agentSync(WS, 'pc-y', {})).commands, [], 'not on the other computer\'s line');
  assert.deepEqual((await hub.agentSync(WS, 'pc-x', {})).commands.map(c => c.type), ['input'], 'on the computer that holds the tab');
  hub.handback(WS, 'atlas');
  assert.deepEqual((await hub.agentSync(WS, 'pc-x', {})).commands, [{type: 'handback', botId: 'atlas'}]);
  hub.close();
});

test('a named computer that has not polled is not there: nothing is queued for it', async () => {
  const {hub} = rig();
  await hub.agentSync(WS, 'pc-a', {});
  assert.equal(hub.agentLive(WS, 'pc-b'), false);
  assert.equal(hub.agentLive(WS, 'pc-a'), true);
  assert.equal(hub.agentId(WS, 'pc-b'), null);
  assert.throws(() => hub.takeover(WS, 'scout', {agentId: 'pc-b', account: A}), e => e.status === 409);
  assert.deepEqual((await hub.agentSync(WS, 'pc-a', {})).commands, [], 'the computer that polled was not handed it');
  assert.equal(hub.view(WS, 'scout', {agentId: 'pc-b'}).agent, false);
  hub.close();
});

test('a computer that went quiet is not there, whatever the others do', async () => {
  const {hub, tick} = rig();
  await hub.agentSync(WS, 'pc-b', {});
  tick(60_000);
  await hub.agentSync(WS, 'pc-a', {});
  assert.equal(hub.agentLive(WS, 'pc-a'), true);
  assert.equal(hub.agentLive(WS, 'pc-b'), false);
  assert.throws(() => hub.takeover(WS, 'scout', {agentId: 'pc-b', account: A}), e => e.status === 409);
  hub.close();
});

test('isDriving is true when any of the workspace\'s computers is driven, and input needs the takeover on that computer', async () => {
  const {hub} = rig();
  await hub.agentSync(WS, 'pc-a', {});
  await hub.agentSync(WS, 'pc-b', {});
  hub.takeover(WS, 'scout', {agentId: 'pc-b', account: A});
  assert.equal(hub.isDriving(WS, 'scout'), true);
  assert.equal(hub.isDriving('other', 'scout'), false);
  assert.throws(() => hub.input(WS, 'scout', click, {agentId: 'pc-a', account: A}), e => e.status === 409, 'pc-a holds nothing');
  hub.input(WS, 'scout', click, {agentId: 'pc-b', account: A});
  hub.handback(WS, 'scout', {agentId: 'pc-b', account: A});
  assert.equal(hub.isDriving(WS, 'scout'), false);
  hub.close();
});

test('a device\'s tabs are keyed by account and bot: one bot on two accounts has two tabs', async () => {
  const {hub} = rig();
  await hub.agentSync(WS, 'pc-b', {tabs: [
    {botId: 'scout', account: A, url: 'https://crm.example.com/a', title: 'A'},
    {botId: 'scout', account: B, url: 'https://crm.example.com/b', title: 'B'},
    {botId: 'scout', account: null, url: 'https://x.example.com/', title: 'plain'},
  ]});
  assert.equal(hub.tab(WS, 'scout', {agentId: 'pc-b', account: A}).title, 'A');
  assert.equal(hub.tab(WS, 'scout', {agentId: 'pc-b', account: B}).title, 'B');
  assert.equal(hub.tab(WS, 'scout', {agentId: 'pc-b'}).title, 'plain');
  assert.equal(hub.tab(WS, 'scout', {agentId: 'pc-a', account: A}), null, 'another computer has no such tab');
  hub.close();
});

test('a frame is shown only to the (account, bot) being watched', async () => {
  const {hub} = rig();
  await hub.agentSync(WS, 'pc-b', {});
  hub.takeover(WS, 'scout', {agentId: 'pc-b', account: A});
  hub.view(WS, 'scout', {agentId: 'pc-b'});
  assert.deepEqual(hub.putFrame(WS, 'pc-b', {botId: 'scout', account: B, image: 'BBBB', w: 1, h: 1}), {watch: 'scout', watchAccount: A}, 'the other account\'s frame is dropped');
  assert.equal(hub.view(WS, 'scout', {agentId: 'pc-b'}).changed, false);
  hub.putFrame(WS, 'pc-b', {botId: 'scout', account: A, image: 'AAAA', w: 1, h: 1});
  assert.equal(hub.view(WS, 'scout', {agentId: 'pc-b'}).image, 'data:image/jpeg;base64,AAAA');
  assert.equal(hub.view(WS, 'scout', {agentId: 'pc-a'}).changed, false, 'another computer\'s view of that bot shows no frame');
  hub.close();
});

test('a queued task wakes only the computer it is for', async () => {
  const {hub} = rig({waitMs: 40});
  const a = hub.agentSync(WS, 'pc-a', {}), b = hub.agentSync(WS, 'pc-b', {});
  hub.taskQueued(WS, 'pc-b');
  assert.equal((await b).tasks, true);
  assert.equal((await a).tasks, undefined, 'pc-a waited out its poll');
  hub.close();
});

test('liveStates names each bot\'s account, and takes live and url from the bot\'s own computer', async () => {
  const {hub} = rig();
  await hub.agentSync(WS, 'pc-b', {tabs: [{botId: 'scout', account: A, url: 'https://crm.example.com/', title: 'CRM'}]});
  await hub.agentSync(WS, 'pc-a', {tabs: [{botId: 'atlas', url: 'https://plain.example.com/', title: 'Plain'}]});
  const state = {
    groups: [{id: 'g', bots: [{id: 'scout', name: 'Scout', settings: {browserAccount: A}}, {id: 'atlas', name: 'Atlas', settings: {}}, {id: 'pinned', name: 'Pinned', settings: {device: 'pc-gone'}}]}],
    browserAccounts: [{id: A, name: 'CRM', site: 'crm.example.com', deviceId: 'pc-b', storage: 'cookies'}],
  };
  const by = Object.fromEntries(liveStates(state, {hub, ws: WS}).map(e => [e.botId, e]));
  assert.deepEqual(by.scout.account, {id: A, name: 'CRM'});
  assert.equal(by.scout.url, 'https://crm.example.com/');
  assert.equal(by.scout.live, true);
  assert.equal(by.atlas.account, null);
  assert.equal(by.atlas.url, 'https://plain.example.com/');
  assert.equal(by.pinned.live, false, 'a bot pinned to a computer that is not there has no live line');
  assert.equal(Object.keys(by.scout.account).sort().join(), 'id,name', 'a member gets the name, no computer, site or jar');
  hub.close();
});

/* Over HTTP, through the real dispatcher. */

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-live-devices-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  const pair = name => {
    const {code} = agent.createPairing(store, 'default', {});
    const d = agent.redeemPairing(store, {code, name, permissions: ['browser.capture', 'browser.action']});
    return {id: d.agentId, secret: d.secret};
  };
  const pcA = pair('Desk'), pcB = pair('Laptop');
  await store.update(s => {
    wf.migrate(s);
    s.groups = [{id: 'lab', name: 'Lab', bots: [
      {id: 'scout', name: 'Scout', instructions: 'x', type: 'custom', permissions: [], settings: {browserAccount: A}},
      {id: 'atlas', name: 'Atlas', instructions: 'x', type: 'custom', permissions: [], settings: {}},
    ]}];
    s.browserAccounts = [{id: A, name: 'CRM', site: 'crm.example.com', deviceId: pcB.id, storage: 'cookies'}];
  });
  const roles = {owner: 'owner', member: 'member'};
  const app = createApp({
    store,
    auth: {session: cookie => (roles[cookie] ? {email: `${cookie}@x.test`, role: roles[cookie], workspaceId: 'default'} : null)},
    workspaces: {get: () => store, holding: () => store},
    push: {}, version: 't',
  });
  const send = async (method, url, {cookie, body, signedBy} = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = {host: '127.0.0.1:4173', ...(cookie ? {cookie: `agent_session=${cookie}`} : {})};
    if (signedBy) {
      const ts = Date.now();
      Object.assign(headers, {'x-agent-id': signedBy.id, 'x-agent-ts': String(ts), 'x-agent-sig': agent.signRequest(signedBy.secret, {method, path: url, timestamp: ts, body: text})});
    }
    const req = Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {method, url, headers});
    const res = {status: null, body: null, writeHead(status) { this.status = status; return this; }, end(b) { this.body = b; }};
    await app.handler(req, res);
    return {status: res.status, body: res.body ? JSON.parse(res.body) : null};
  };
  return {dir, store, send, pcA, pcB};
}

test('the routes resolve the bot\'s computer, refuse an older app, and name the account', async t => {
  const {dir, store, send, pcA, pcB} = await harness();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  browserLive.waitMs = 30;
  t.after(() => browserLive.close());
  const poll = (who, extra = {}) => send('POST', '/api/agent/live', {body: {tabs: [], ...extra}, signedBy: who});
  // pc-b parks first, pc-a polls last; pc-b reports no features.
  const parkedB = poll(pcB);
  assert.equal((await poll(pcA)).status, 200);
  await parkedB;

  const refused = await send('POST', '/api/browser-live/scout/takeover', {cookie: 'owner'});
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, new RegExp(BROWSER_ACCOUNTS_V1));
  assert.equal(refused.body.error, missingFeatureLine(BROWSER_ACCOUNTS_V1));
  const refusedInput = await send('POST', '/api/browser-live/scout/input', {cookie: 'owner', body: click});
  assert.equal(refusedInput.status, 409);
  assert.equal(refusedInput.body.error, missingFeatureLine(BROWSER_ACCOUNTS_V1));
  assert.deepEqual((await poll(pcB)).body.commands, [], 'nothing was queued for the account\'s computer');
  assert.deepEqual((await poll(pcA)).body.commands, [], 'nor for the other');
  assert.equal(browserLive.isDriving('default', 'scout'), false);
  const watched = await send('GET', '/api/browser-live/scout', {cookie: 'member'});
  assert.equal(watched.status, 200);
  assert.equal((await poll(pcB)).body.watch, null, 'an older app is not asked to cast an account\'s tab: it would cast the default profile');

  // With the feature, the takeover is queued on pc-b although pc-a polled last.
  agent.recordAgentFeatures(store, pcB.id, [BROWSER_ACCOUNTS_V1]);
  await poll(pcB);
  const parked = poll(pcB);
  assert.equal((await send('POST', '/api/browser-live/scout/takeover', {cookie: 'owner'})).status, 200);
  assert.deepEqual((await parked).body.commands, [{type: 'takeover', botId: 'scout', account: A}]);
  assert.equal((await send('POST', '/api/browser-live/scout/input', {cookie: 'owner', body: click})).status, 200);
  assert.deepEqual((await poll(pcB)).body.commands.map(c => [c.type, c.account]), [['input', A]]);
  assert.deepEqual((await poll(pcA)).body.commands, []);
  assert.equal((await send('GET', '/api/browser-live/scout', {cookie: 'member'})).status, 200);
  assert.deepEqual([(await poll(pcB)).body].map(b => [b.watch, b.watchAccount])[0], ['scout', A]);

  const list = await send('GET', '/api/browser-live', {cookie: 'member'});
  const scout = list.body.find(e => e.botId === 'scout');
  assert.deepEqual(scout.account, {id: A, name: 'CRM'});
  assert.equal(scout.state, 'driving');
  assert.equal(list.body.find(e => e.botId === 'atlas').account, null);
  assert.equal(JSON.stringify(list.body).includes(pcB.id), false, 'a member is never told which computer');
  assert.equal((await send('POST', '/api/browser-live/scout/handback', {cookie: 'owner'})).status, 200);
});

test('an account bot whose record is gone is refused, never run in the default profile', async t => {
  const {dir, store, send, pcB} = await harness();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  t.after(() => browserLive.close());
  await store.update(s => { s.browserAccounts = []; });
  await send('POST', '/api/agent/live', {body: {tabs: []}, signedBy: pcB});
  const r = await send('POST', '/api/browser-live/scout/takeover', {cookie: 'owner'});
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no longer exists/);
});
