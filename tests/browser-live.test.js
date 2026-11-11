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
import {createLiveHub, browserLive} from '../src/browser-live.js';

/* What the owner sees and does in a bot's tab, between the device and the owner's
 * browser. The hub keeps only the newest frame, in memory, only while somebody
 * watches; every route to it needs a signed-in member or a signed device. */

const WS = 'default';
const click = {type: 'click', x: 5, y: 6};
const status = code => error => error.status === code;

/** A hub on a clock the test moves. */
function rig(extra = {}) {
  let t = 1_000_000;
  const hub = createLiveHub({now: () => t, waitMs: 25, ...extra});
  return {hub, tick: ms => { t += ms; }};
}
/** The device is polling: it counts as live. */
const live = (hub, ws = WS, agentId = 'dev-1') => hub.agentSync(ws, agentId, {tabs: []});

test('a poll with nothing to say is answered empty when its wait ends, and a viewer wakes it at once', async () => {
  const {hub} = rig({waitMs: 40});
  const started = Date.now();
  assert.deepEqual(await live(hub), {commands: [], watch: null});
  assert.ok(Date.now() - started >= 30, 'it held the call');
  const parked = live(hub);
  hub.view(WS, 'bot-a', {});
  const woke = Date.now();
  assert.deepEqual(await parked, {commands: [], watch: 'bot-a'});
  assert.ok(Date.now() - woke < 30, 'and a viewer woke it at once');
  hub.close();
});

test('frames are kept only for the bot being watched, only the newest, and they go when the viewer does', async () => {
  const {hub, tick} = rig();
  await live(hub);
  hub.view(WS, 'bot-a', {});
  assert.deepEqual(hub.putFrame(WS, 'dev-1', {botId: 'bot-b', image: 'BBBB', w: 1280, h: 800}), {watch: 'bot-a'}, 'a frame of a tab nobody watches is dropped');
  hub.putFrame(WS, 'dev-1', {botId: 'bot-a', image: 'AAAA', w: 1280, h: 800});
  hub.putFrame(WS, 'dev-1', {botId: 'bot-a', image: 'CCCC', w: 1280, h: 800});
  tick(1000);
  const seen = hub.view(WS, 'bot-a', {});
  assert.equal(seen.image, 'data:image/jpeg;base64,CCCC', 'the newest frame, as an image the owner\'s page can show');
  assert.deepEqual([seen.w, seen.h, seen.changed, seen.agent], [1280, 800, true, true]);
  // Polling again with the sequence number answers without the picture.
  const again = hub.view(WS, 'bot-a', {after: seen.seq});
  assert.deepEqual([again.changed, again.image], [false, undefined]);
  assert.equal(again.seq, seen.seq);
  hub.putFrame(WS, 'dev-1', {botId: 'bot-a', image: 'DDDD', w: 1280, h: 800});
  assert.equal(hub.view(WS, 'bot-a', {after: seen.seq}).image, 'data:image/jpeg;base64,DDDD');
  // Nobody has looked for a while: the device is told to stop, and the frame is gone.
  tick(30000);
  assert.deepEqual(hub.putFrame(WS, 'dev-1', {botId: 'bot-a', image: 'EEEE', w: 1280, h: 800}), {watch: null});
  assert.equal(hub.view(WS, 'bot-a', {}).image, undefined, 'no frame outlives its viewer');
  hub.close();
});

test('a frame must be a bounded base64 image', async () => {
  const {hub} = rig();
  await live(hub);
  hub.view(WS, 'bot-a', {});
  assert.throws(() => hub.putFrame(WS, 'dev-1', {botId: 'bot-a', image: 'not base64!!', w: 1, h: 1}), status(400));
  assert.throws(() => hub.putFrame(WS, 'dev-1', {botId: 'bot-a', image: 'A'.repeat(900_000), w: 1, h: 1}), status(413));
  assert.throws(() => hub.putFrame(WS, 'dev-1', {botId: 'bot-a', image: '', w: 1, h: 1}), status(400));
  hub.close();
});

test('owner input is refused unless the owner is driving, and is queued for the device in order', async () => {
  const {hub} = rig();
  assert.throws(() => hub.input(WS, 'bot-a', click), status(409));
  assert.throws(() => hub.takeover(WS, 'bot-a'), status(409), 'no device is polling, so there is nothing to take over');
  await live(hub);
  hub.takeover(WS, 'bot-a');
  assert.equal(hub.isDriving(WS, 'bot-a'), true);
  assert.throws(() => hub.input(WS, 'bot-b', click), status(409), 'driving one bot is not driving another');
  hub.input(WS, 'bot-a', click);
  hub.input(WS, 'bot-a', {type: 'type', text: 'hi', extra: 1});
  assert.throws(() => hub.input(WS, 'bot-a', {type: 'eval'}), status(400));
  const delivered = await live(hub);
  assert.deepEqual(delivered.commands.map(c => [c.type, c.botId, c.event?.type]), [['takeover', 'bot-a', undefined], ['input', 'bot-a', 'click'], ['input', 'bot-a', 'type']]);
  assert.deepEqual(delivered.commands[2].event, {type: 'type', text: 'hi'}, 'the device gets the normalised event');
  assert.deepEqual((await live(hub)).commands, [], 'a command is delivered once');
  hub.handback(WS, 'bot-a');
  assert.equal(hub.isDriving(WS, 'bot-a'), false);
  assert.throws(() => hub.input(WS, 'bot-a', click), status(409), 'after the hand back input is refused again');
  assert.deepEqual((await live(hub)).commands.map(c => c.type), ['handback']);
  hub.close();
});

test('the input queue is bounded, and one workspace never gets another\'s commands', async () => {
  const {hub} = rig();
  await live(hub, WS, 'dev-1');
  await live(hub, 'other', 'dev-2');
  hub.takeover(WS, 'bot-a');
  for (let i = 0; i < 99; i++) hub.input(WS, 'bot-a', click);
  assert.throws(() => hub.input(WS, 'bot-a', click), status(429));
  assert.deepEqual((await live(hub, 'other', 'dev-2')).commands, []);
  assert.equal((await live(hub, WS, 'dev-1')).commands.length, 100);
  hub.close();
});

test('a takeover the device no longer reports is dropped after a grace period', async () => {
  const {hub, tick} = rig();
  await live(hub);
  hub.takeover(WS, 'bot-a');
  await hub.agentSync(WS, 'dev-1', {tabs: [], owner: null});
  assert.equal(hub.isDriving(WS, 'bot-a'), true, 'the command may still be on its way');
  tick(11000);
  await hub.agentSync(WS, 'dev-1', {tabs: [], owner: null});
  assert.equal(hub.isDriving(WS, 'bot-a'), false, 'the device says the owner holds nothing (it restarted, or timed the takeover out)');
  hub.takeover(WS, 'bot-a');
  tick(11000);
  await hub.agentSync(WS, 'dev-1', {tabs: [], owner: 'bot-a'});
  assert.equal(hub.isDriving(WS, 'bot-a'), true, 'while it agrees, it stays');
  hub.close();
});

test('a device that stops polling is not live, and the view says so', async () => {
  const {hub, tick} = rig();
  assert.equal(hub.view(WS, 'bot-a', {}).agent, false);
  await live(hub);
  assert.equal(hub.view(WS, 'bot-a', {}).agent, true);
  tick(60000);
  assert.equal(hub.view(WS, 'bot-a', {}).agent, false);
  hub.close();
});

test('the tab a device reports is what the view shows as the page', async () => {
  const {hub} = rig();
  await hub.agentSync(WS, 'dev-1', {tabs: [{botId: 'bot-a', url: 'https://docs.example.com/', title: 'Docs'}, {botId: 'bot-b', url: 'x'.repeat(5000), title: 't'.repeat(900)}]});
  assert.deepEqual(hub.tab(WS, 'bot-a'), {url: 'https://docs.example.com/', title: 'Docs'});
  assert.ok(hub.tab(WS, 'bot-b').url.length <= 2000 && hub.tab(WS, 'bot-b').title.length <= 300, 'what a device reports is bounded');
  hub.close();
});

test('closing the hub releases a parked poll', async () => {
  const {hub} = rig({waitMs: 10_000});
  const parked = live(hub);
  hub.close();
  assert.deepEqual(await parked, {commands: [], watch: null});
});

/* The same, over HTTP, through the real dispatcher. */

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-live-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  await store.update(s => { wf.migrate(s); s.groups = [{id: 'lab', name: 'Lab', bots: [{id: 'web', name: 'Web', instructions: 'x', type: 'custom', permissions: [], settings: {}}]}]; });
  const {code} = agent.createPairing(store, 'default', {});
  const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['browser.capture', 'browser.action']});
  const roles = {owner: 'owner', member: 'member', viewer: 'viewer'};
  const app = createApp({
    store,
    auth: {session: cookie => (roles[cookie] ? {email: `${cookie}@x.test`, role: roles[cookie], workspaceId: 'default'} : null)},
    workspaces: {get: () => store, holding: () => store},
    push: {}, version: 't',
  });
  const send = async (method, url, {cookie, body, signedBy, raw} = {}) => {
    const text = raw ?? (body === undefined ? '' : JSON.stringify(body));
    const headers = {host: '127.0.0.1:4173', ...(cookie ? {cookie: `agent_session=${cookie}`} : {})};
    if (signedBy) {
      const ts = signedBy.ts ?? Date.now();
      Object.assign(headers, {'x-agent-id': signedBy.id, 'x-agent-ts': String(ts), 'x-agent-sig': signedBy.sig ?? agent.signRequest(signedBy.secret, {method, path: url, timestamp: ts, body: text})});
    }
    const req = Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {method, url, headers});
    const res = {status: null, body: null, writeHead(status) { this.status = status; return this; }, end(b) { this.body = b; }};
    await app.handler(req, res);
    return {status: res.status, body: res.body ? JSON.parse(res.body) : null};
  };
  const signed = {id: device.agentId, secret: device.secret};
  return {dir, store, send, signed};
}

test('over HTTP: frames need a signed-in member, input an admin, and a frame never reaches an anonymous caller', async t => {
  const {dir, send, signed} = await harness();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  browserLive.waitMs = 30;
  t.after(() => browserLive.close());
  // The device polls, an owner starts watching, the device sends a frame.
  assert.equal((await send('POST', '/api/agent/live', {body: {tabs: []}, signedBy: signed})).status, 200);
  assert.equal((await send('GET', '/api/browser-live/web', {cookie: 'member'})).status, 200);
  const big = 'A'.repeat(150_000);
  const posted = await send('POST', '/api/agent/frames', {body: {botId: 'web', image: big, w: 1280, h: 800}, signedBy: signed});
  assert.deepEqual([posted.status, posted.body.watch], [200, 'web'], 'a frame larger than an ordinary request body is accepted');

  const anonymous = await send('GET', '/api/browser-live/web');
  assert.equal(anonymous.status, 401);
  assert.equal(JSON.stringify(anonymous.body).includes('AAAA'), false, 'an anonymous poll sees no frame');
  assert.equal((await send('GET', '/api/browser-live/web', {cookie: 'viewer'})).status, 403, 'a viewer cannot watch a signed-in browser');
  const member = await send('GET', '/api/browser-live/web', {cookie: 'member'});
  assert.equal(member.status, 200);
  assert.equal(member.body.image, `data:image/jpeg;base64,${big}`);
  assert.equal((await send('GET', '/api/browser-live/nobody', {cookie: 'member'})).status, 404);

  // Owner input while the owner is not driving: 409. A member: 403 (driving is an admin's). Not signed in: 401.
  assert.equal((await send('POST', '/api/browser-live/web/input', {cookie: 'owner', body: click})).status, 409);
  assert.equal((await send('POST', '/api/browser-live/web/input', {cookie: 'member', body: click})).status, 403);
  assert.equal((await send('POST', '/api/browser-live/web/input', {body: click})).status, 401);
  assert.equal((await send('POST', '/api/browser-live/web/input', {cookie: 'viewer', body: click})).status, 403);
});

test('over HTTP: the device routes verify the signature, and a signature is good once', async t => {
  const {dir, send, signed} = await harness();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  browserLive.waitMs = 20;
  t.after(() => browserLive.close());
  const body = {botId: 'web', image: 'AAAA', w: 1, h: 1};
  assert.equal((await send('POST', '/api/agent/frames', {body})).status, 401, 'unsigned');
  assert.equal((await send('POST', '/api/agent/frames', {body, signedBy: {...signed, sig: 'ab'.repeat(32)}})).status, 401, 'wrong signature');
  assert.equal((await send('POST', '/api/agent/live', {body: {tabs: []}, signedBy: {...signed, ts: Date.now() - 3600_000}})).status, 401, 'stale clock');
  assert.equal((await send('POST', '/api/agent/live', {body: {tabs: []}, signedBy: signed})).status, 200);
  const ts = Date.now(), once = {...signed, ts};
  assert.equal((await send('POST', '/api/agent/frames', {body, signedBy: once})).status, 200);
  assert.equal((await send('POST', '/api/agent/frames', {body, signedBy: once})).status, 409, 'the same bytes at the same time are a replay');
  assert.equal((await send('POST', '/api/agent/frames', {raw: 'not json', signedBy: signed})).status, 400);
});

test('a frame is never written to the database or any file', async t => {
  const {dir, store, send, signed} = await harness();
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  browserLive.waitMs = 20;
  t.after(() => browserLive.close());
  const marker = 'TWFya2VyRnJhbWVQaXhlbHM'.repeat(40);
  await send('POST', '/api/agent/live', {body: {tabs: [{botId: 'web', url: 'https://secret.example.com/inbox', title: 'Inbox (3)'}]}, signedBy: signed});
  await send('GET', '/api/browser-live/web', {cookie: 'member'});
  const stored = await send('POST', '/api/agent/frames', {body: {botId: 'web', image: marker, w: 1280, h: 800}, signedBy: signed});
  assert.equal(stored.status, 200);
  assert.equal((await send('GET', '/api/browser-live/web', {cookie: 'member'})).body.image.endsWith(marker), true, 'it was served from memory');
  const needle = Buffer.from(marker.slice(0, 40));
  assert.equal(JSON.stringify(store.read()).includes(marker.slice(0, 40)), false, 'not in the state document');
  assert.equal(JSON.stringify(store.read()).includes('Inbox (3)'), false, 'nor the page title the device reported');
  for (const name of await fs.readdir(dir)) {
    const bytes = await fs.readFile(path.join(dir, name));
    assert.equal(bytes.includes(needle), false, `${name} holds no frame`);
    assert.equal(bytes.includes(Buffer.from('secret.example.com/inbox')), false, `${name} holds no page address from the live view`);
  }
});
