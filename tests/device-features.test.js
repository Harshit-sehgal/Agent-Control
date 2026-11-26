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
import {browserLive} from '../src/browser-live.js';
import {SECRET_INPUT_V1, DEVICE_FEATURES, cleanFeatures, hasFeature, UPDATE_DEVICE_LINE} from '../shared/device-features.js';
import {mergeView} from '../shared/ui-computer.js';

/* A device says what it can do (`features` on each heartbeat). The one feature Phase 0 relies on is
 * `secret-input-v1`: the server queues a masked `secret` event only for a device that reported it. */

const SECRET = 'hunter22-DO-NOT-LEAK';
const typed = {type: 'type', text: SECRET, secret: true};

test('the names are fixed, the list a report is read from is bounded, and nothing else survives', () => {
  assert.equal(SECRET_INPUT_V1, 'secret-input-v1');
  assert.deepEqual(DEVICE_FEATURES, ['secret-input-v1']);
  assert.deepEqual(cleanFeatures(['secret-input-v1', 'secret-input-v1', 'future-thing-v2']), ['secret-input-v1', 'future-thing-v2'], 'a repeat is dropped, a new name of the same shape is kept');
  for (const bad of [undefined, null, 'secret-input-v1', 7, {0: 'secret-input-v1'}, true]) assert.deepEqual(cleanFeatures(bad), [], `${JSON.stringify(bad)} is no list`);
  assert.deepEqual(cleanFeatures([7, null, {}, [], 'Has Spaces', 'UPPER-v1', '../etc', 'a'.repeat(41), '', '<b>x</b>', 'ok-v1']), ['ok-v1'], 'only short lowercase names of one shape');
  assert.equal(cleanFeatures(Array.from({length: 500}, (_, i) => `feature-${i}`)).length, 16, 'capped in count');
  assert.equal(hasFeature(['secret-input-v1'], SECRET_INPUT_V1), true);
  assert.equal(hasFeature(undefined, SECRET_INPUT_V1), false);
  assert.equal(hasFeature('secret-input-v1', SECRET_INPUT_V1), false, 'a string is not a list');
  assert.equal(UPDATE_DEVICE_LINE, 'Update the app on your computer to type passwords and codes here.');
});

test('the Computer view keeps the device features from the frame reply, and a reply without them means none', () => {
  const had = mergeView(null, {agent: true, state: 'driving', features: ['secret-input-v1']});
  assert.deepEqual(had.features, ['secret-input-v1']);
  assert.deepEqual(mergeView(had, {agent: true, state: 'driving'}).features, [], 'an older server or a device with none: none');
  assert.deepEqual(mergeView(had, {agent: true, features: ['Bad Name', 7]}).features, []);
  assert.deepEqual(mergeView(had, {agent: false}).features, [], 'no device, no feature');
});

async function open(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'device-features-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  t.after(async () => { browserLive.close(); await store.close(); await fs.rm(dir, {recursive: true, force: true}); });
  return {dir, store};
}

test('the heartbeat stores the device\'s features, the agent list shows them, and a later beat replaces them', async t => {
  const {store} = await open(t);
  const {code} = agent.createPairing(store, 'default', {});
  const {agentId} = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['browser.action']});
  assert.deepEqual(agent.listAgents(store, 'default')[0].features, [], 'a device that has not reported has none');
  agent.recordAgentFeatures(store, agentId, ['secret-input-v1', 'x'.repeat(200), 7, '<script>']);
  assert.deepEqual(agent.listAgents(store, 'default')[0].features, ['secret-input-v1']);
  assert.deepEqual(agent.readAgentFeatures(store, agentId), ['secret-input-v1']);
  agent.recordAgentFeatures(store, agentId, undefined);
  assert.deepEqual(agent.readAgentFeatures(store, agentId), [], 'an older app sends none: the last list is not kept');
  assert.equal(agent.recordAgentFeatures(store, agentId, 'not a list'), undefined);
  assert.deepEqual(agent.readAgentFeatures(store, agentId), []);
  assert.deepEqual(agent.readAgentFeatures(store, 'nobody'), []);
});

/** The real dispatcher, an owner on the device's own computer, and one paired device. */
async function harness(t) {
  const {store} = await open(t);
  await store.update(s => { wf.migrate(s); s.groups = [{id: 'lab', name: 'Lab', bots: [{id: 'web', name: 'Web', instructions: 'x', type: 'custom', permissions: [], settings: {}}]}]; });
  const {code} = agent.createPairing(store, 'default', {});
  const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['browser.capture', 'browser.action']});
  const app = createApp({
    store,
    auth: {session: cookie => (cookie === 'owner' ? {email: 'owner@x.test', role: 'owner', workspaceId: 'default'} : null)},
    workspaces: {get: () => store, holding: () => store},
    push: {}, version: 't',
  });
  let lastTs = 0;   // two signed requests with the same body in one millisecond would be read as a replay
  const send = async (method, url, {cookie, body, signedBy, remote = '127.0.0.1'} = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    const headers = {host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', ...(cookie ? {cookie: `agent_session=${cookie}`} : {})};
    if (signedBy) {
      const ts = Math.max(Date.now(), lastTs + 1);
      lastTs = ts;
      Object.assign(headers, {'x-agent-id': signedBy.id, 'x-agent-ts': String(ts), 'x-agent-sig': agent.signRequest(signedBy.secret, {method, path: url, timestamp: ts, body: text})});
    }
    const req = Object.assign(Readable.from(text ? [Buffer.from(text)] : []), {method, url, headers, socket: {remoteAddress: remote}});
    const res = {status: null, body: null, writeHead(status) { this.status = status; return this; }, end(b) { this.body = b; }};
    await app.handler(req, res);
    return {status: res.status, body: res.body ? JSON.parse(res.body) : null};
  };
  const signed = {id: device.agentId, secret: device.secret};
  /** One heartbeat, with whatever `features` the app of that version would send. */
  const beat = features => send('POST', '/api/agent/heartbeat', {body: {version: '1', os: 'linux', ...(features === undefined ? {} : {features})}, signedBy: signed});
  const drive = async () => {
    browserLive.waitMs = 20;
    assert.equal((await send('POST', '/api/agent/live', {body: {tabs: []}, signedBy: signed})).status, 200);
    assert.equal((await send('POST', '/api/browser-live/web/takeover', {cookie: 'owner', body: {}})).status, 200);
  };
  /** Another paired device in the same workspace, with its own beat. */
  const pairAnother = name => {
    const again = agent.createPairing(store, 'default', {});
    const other = agent.redeemPairing(store, {code: again.code, name, permissions: ['browser.capture', 'browser.action']});
    const who = {id: other.agentId, secret: other.secret};
    return {signed: who, beat: features => send('POST', '/api/agent/heartbeat', {body: {version: '1', os: 'linux', ...(features === undefined ? {} : {features})}, signedBy: who})};
  };
  return {store, send, signed, beat, drive, agentId: device.agentId, pairAnother};
}

test('over HTTP: a heartbeat with features is stored, one without clears them, and a bad list never fails the beat', async t => {
  const {send, beat, store, agentId} = await harness(t);
  assert.equal((await beat(['secret-input-v1'])).status, 200);
  assert.deepEqual(agent.readAgentFeatures(store, agentId), ['secret-input-v1']);
  assert.equal((await beat()).status, 200, 'an older app that sends no features still beats');
  assert.deepEqual(agent.readAgentFeatures(store, agentId), []);
  for (const bad of ['secret-input-v1', 7, null, {a: 1}, [{}], Array.from({length: 300}, () => 'x'.repeat(60))]) {
    assert.equal((await beat(bad)).status, 200, JSON.stringify(bad).slice(0, 40));
    assert.ok(agent.readAgentFeatures(store, agentId).length <= 16);
  }
  assert.equal((await beat(['secret-input-v1'])).status, 200);
  const listed = await send('GET', '/api/agents', {cookie: 'owner'});
  assert.equal(listed.status, 200);
  assert.deepEqual((listed.body.agents || listed.body)[0].features, ['secret-input-v1']);
});

test('over HTTP: a secret goes to a device that reports secret-input-v1, and is refused with 409 for one that does not', async t => {
  const {send, beat, drive, signed} = await harness(t);
  await drive();
  /** What the device hears on its next live poll. */
  const heard = async () => (await send('POST', '/api/agent/live', {body: {tabs: []}, signedBy: signed})).body.commands.filter(c => c.type === 'input');

  // An older app: nothing is queued, and the answer says what to do and holds no typed text.
  assert.equal((await beat()).status, 200);
  const refused = await send('POST', '/api/browser-live/web/input', {cookie: 'owner', body: typed});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error, 'Update the app on your computer to type passwords and codes here.');
  assert.equal(JSON.stringify(refused.body).includes(SECRET), false);
  assert.deepEqual(await heard(), [], 'nothing was queued for it');
  // Its ordinary typing still works: only the masked input needs the feature.
  assert.equal((await send('POST', '/api/browser-live/web/input', {cookie: 'owner', body: {type: 'type', text: 'hello'}})).status, 200);
  assert.deepEqual((await heard()).map(c => c.event.text), ['hello']);

  // The app is updated: the next beat says so, and the same request is queued, marked secret.
  assert.equal((await beat(['secret-input-v1'])).status, 200);
  const accepted = await send('POST', '/api/browser-live/web/input', {cookie: 'owner', body: typed});
  assert.deepEqual([accepted.status, accepted.body], [200, {ok: true}]);
  const [command] = await heard();
  assert.deepEqual(command.event, {type: 'type', text: SECRET, secret: true});
});

test('over HTTP: the insecure-connection 403 still comes first, and a plain event never needs the feature', async t => {
  const {send, beat, drive} = await harness(t);
  await drive();
  assert.equal((await beat()).status, 200);
  const far = await send('POST', '/api/browser-live/web/input', {cookie: 'owner', body: typed, remote: '203.0.113.9'});
  assert.equal(far.status, 403, 'not safe to carry a password: refused before the device is even asked');
  assert.equal((await send('POST', '/api/browser-live/web/input', {cookie: 'owner', body: {type: 'type', text: 'x', secret: false}})).status, 200);
  assert.equal((await send('POST', '/api/browser-live/web/input', {cookie: 'owner', body: {type: 'click', x: 1, y: 2}})).status, 200);
});

test('over HTTP: the frame reply names the serving device\'s features, so the Computer view can hide the masked fields', async t => {
  const {send, beat, drive} = await harness(t);
  await drive();
  const features = async () => (await send('GET', '/api/browser-live/web', {cookie: 'owner'})).body.features;
  assert.equal((await beat()).status, 200);
  assert.deepEqual(await features(), []);
  assert.equal((await beat(['secret-input-v1'])).status, 200);
  assert.deepEqual(await features(), ['secret-input-v1']);
});

const secretsOf = reply => reply.body.commands.filter(c => c.type === 'input' && c.event?.secret === true);

test('over HTTP: with two devices on one workspace, a secret is handed only to one that holds secret-input-v1', async t => {
  const {send, beat, drive, signed: newer, pairAnother} = await harness(t);
  const older = pairAnother('Old laptop');
  await drive();
  const poll = who => send('POST', '/api/agent/live', {body: {tabs: []}, signedBy: who});
  assert.equal((await beat(['secret-input-v1'])).status, 200);
  assert.equal((await older.beat()).status, 200);
  const type = () => send('POST', '/api/browser-live/web/input', {cookie: 'owner', body: typed});

  // The newer device polled last, so the queue-time check passes; the older one polls first and drains the queue.
  await poll(older.signed); await poll(newer);
  assert.equal((await type()).status, 200);
  const old = await poll(older.signed);
  assert.deepEqual(secretsOf(old), [], 'the older device is never sent the secret');
  assert.equal(JSON.stringify(old.body).includes(SECRET), false);
  assert.deepEqual(secretsOf(await poll(newer)), [], 'and it was dropped, not kept for another device');
  // The owner is told in fixed words, never the text (a notice shows once the owner is not driving).
  assert.equal((await send('POST', '/api/browser-live/web/handback', {cookie: 'owner', body: {}})).status, 200);
  const view = await send('GET', '/api/browser-live/web', {cookie: 'owner'});
  assert.equal(view.body.notice, 'Update the app on your computer to type passwords and codes here.');
  assert.equal(JSON.stringify(view.body).includes(SECRET), false);

  // The newer device, polling, is handed it.
  assert.equal((await send('POST', '/api/browser-live/web/takeover', {cookie: 'owner', body: {}})).status, 200);
  await poll(newer);
  assert.equal((await type()).status, 200);
  const got = secretsOf(await poll(newer));
  assert.deepEqual(got.map(c => c.event), [{type: 'type', text: SECRET, secret: true}]);

  // A device that reported the feature and later beats without it (the app was rolled back) is no longer sent one.
  assert.equal((await type()).status, 200);
  assert.equal((await beat()).status, 200);
  assert.deepEqual(secretsOf(await poll(newer)), []);
  assert.equal((await type()).status, 409, 'and the queue-time check agrees');
});
