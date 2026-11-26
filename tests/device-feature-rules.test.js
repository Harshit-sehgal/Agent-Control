import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import * as agent from '../src/agent.js';
import {chooseDevice, readAgentFeatures, recordAgentFeatures, redeemPairing} from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import * as wf from '../shared/workflow.js';
import {createApp} from '../src/app.js';
import {FEATURES, FEATURE_GRACE_DAYS, DEVICE_FEATURES, SECRET_INPUT_V1, cleanFeatures, hasFeature, neededNow, requiredNow, updateNeeded} from '../shared/device-features.js';

/* The device feature list: needed or preferred, the 60 days a preferred one keeps the older path, and what a device
 * says when it pairs. Every rule here fails closed: an unknown name, a malformed list or a missing kv means "lacks it". */

const DAY = 86400000;
const LIST = [
  {name: 'new-thing-v1', since: '2026-12-01', use: 'preferred', what: 'do the new thing'},
  {name: 'must-v1', since: '2026-12-01', use: 'needed', what: 'do the must'},
];
const at = days => Date.parse('2026-12-01') + days * DAY;

async function rig(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'device-feature-rules-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  t.after(async () => { await store.close(); await fs.rm(dir, {recursive: true, force: true}); });
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  const code = () => agent.createPairing(store, 'default', {}).code;
  return {store, code};
}

test('the list is well formed, and what the device reports is every name on it', () => {
  for (const f of FEATURES) {
    assert.deepEqual(cleanFeatures([f.name]), [f.name]);
    assert.ok(['needed', 'preferred'].includes(f.use));
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(f.since) && Number.isFinite(Date.parse(f.since)));
    assert.ok(f.what);
  }
  assert.equal(new Set(FEATURES.map(f => f.name)).size, FEATURES.length);
  assert.deepEqual(DEVICE_FEATURES, FEATURES.map(f => f.name));
  assert.deepEqual(DEVICE_FEATURES, [SECRET_INPUT_V1], 'Phase 1 adds no feature name');
  assert.deepEqual(FEATURES.find(f => f.name === SECRET_INPUT_V1), {name: SECRET_INPUT_V1, since: '2026-11-26', use: 'needed', what: 'type passwords and codes'});
  assert.equal(FEATURE_GRACE_DAYS, 60);
});

test('a preferred feature keeps the older path for 60 days, then counts as needed; an unknown one always does', () => {
  assert.equal(neededNow('new-thing-v1', {nowMs: at(59), list: LIST}), false);
  assert.equal(neededNow('new-thing-v1', {nowMs: at(60), list: LIST}), true);
  assert.equal(neededNow('must-v1', {nowMs: at(0), list: LIST}), true);
  assert.equal(neededNow('typo-v1', {list: LIST}), true);
  assert.equal(neededNow(SECRET_INPUT_V1), true, 'the shipped list, the real clock');
  assert.deepEqual(requiredNow(['new-thing-v1'], {nowMs: at(10), list: LIST}), []);
  assert.deepEqual(requiredNow(['new-thing-v1'], {nowMs: at(61), list: LIST}), ['new-thing-v1']);
  assert.deepEqual(requiredNow(['new-thing-v1', 'typo-v1'], {nowMs: at(10), list: LIST}), ['typo-v1'], 'an unknown name is needed at once');
  assert.deepEqual(requiredNow('new-thing-v1', {nowMs: at(99), list: LIST}), [], 'not a list names nothing');
  assert.deepEqual(requiredNow(undefined), []);
});

test("a preferred feature's older path still answers inside the 60 days, and is refused after", async t => {
  const {store, code} = await rig(t);
  const {agentId} = redeemPairing(store, {code: code(), name: 'Laptop', permissions: ['browser.capture']});
  store.run('UPDATE agents SET last_seen_at=? WHERE id=?', new Date().toISOString(), agentId);
  const choose = days => chooseDevice(store, {kind: 'browser.capture', needs: requiredNow(['new-thing-v1'], {nowMs: at(days), list: LIST})});
  assert.ok(choose(30).agent, 'inside the window it is still chosen');
  assert.equal(hasFeature(readAgentFeatures(store, choose(30).agent.id), 'new-thing-v1'), false, 'so the caller takes the older path');
  assert.deepEqual(choose(61), {reason: 'missing-feature', feature: 'new-thing-v1'});
});

test('which features a device needs an update for: none when it has them, a malformed list counts as none', () => {
  assert.deepEqual(updateNeeded([SECRET_INPUT_V1]), []);
  for (const none of [[], undefined, null, 'secret-input-v1', {}, 7]) assert.deepEqual(updateNeeded(none).map(f => f.name), [SECRET_INPUT_V1]);
  assert.deepEqual(updateNeeded([], {nowMs: Date.parse('2026-12-02'), list: LIST}).map(f => f.name), ['must-v1'], 'a preferred one inside its window is not asked for yet');
  assert.deepEqual(updateNeeded([], {nowMs: at(60), list: LIST}).map(f => f.name), ['new-thing-v1', 'must-v1'], 'past its window it is');
  assert.deepEqual(updateNeeded(['must-v1'], {nowMs: at(60), list: LIST}).map(f => f.name), ['new-thing-v1']);
  assert.deepEqual(updateNeeded([], {list: LIST, nowMs: at(0)})[0], {name: 'must-v1', what: 'do the must'}, 'a name and the words, nothing else');
});

test('a device reports its features when it pairs, an older app that sends none records none, and a heartbeat still replaces them', async t => {
  const {store, code} = await rig(t);
  const first = redeemPairing(store, {code: code(), name: 'New app', permissions: [], features: [SECRET_INPUT_V1, 'BAD NAME']});
  assert.deepEqual(readAgentFeatures(store, first.agentId), [SECRET_INPUT_V1]);
  const older = redeemPairing(store, {code: code(), name: 'Old app', permissions: []});
  assert.deepEqual(readAgentFeatures(store, older.agentId), []);
  assert.equal(store.kvGet(`agent_features:${older.agentId}`), null, 'nothing is recorded for an app that sends none');
  const odd = redeemPairing(store, {code: code(), name: 'Odd app', permissions: [], features: 'secret-input-v1'});
  assert.deepEqual(readAgentFeatures(store, odd.agentId), [], 'a string is no list');
  recordAgentFeatures(store, first.agentId, []);
  assert.deepEqual(readAgentFeatures(store, first.agentId), []);
});

test('a paired computer that has not beaten yet is chosen for work that needs a feature it reported at pairing', async t => {
  const {store, code} = await rig(t);
  const {agentId} = redeemPairing(store, {code: code(), name: 'Fresh', permissions: ['browser.capture'], features: DEVICE_FEATURES});
  assert.equal(chooseDevice(store, {kind: 'browser.capture', needs: [SECRET_INPUT_V1]}).agent.id, agentId);
});

test('POST /api/agent/pair stores the features in its body, and a body with none still pairs', async t => {
  const {store, code} = await rig(t);
  await store.update(s => { wf.migrate(s); });
  const app = createApp({store, auth: {session: () => null}, workspaces: {get: () => store, holding: () => store}, push: {}, version: 't'});
  const pair = async body => {
    const text = JSON.stringify(body);
    const headers = {host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173'};
    const req = Object.assign(Readable.from([Buffer.from(text)]), {method: 'POST', url: '/api/agent/pair', headers, socket: {remoteAddress: '127.0.0.1'}});
    const res = {status: null, body: null, writeHead(status) { this.status = status; return this; }, end(b) { this.body = b; }};
    await app.handler(req, res);
    return {status: res.status, body: res.body ? JSON.parse(res.body) : null};
  };
  const withList = await pair({code: code(), name: 'New app', permissions: [], features: [SECRET_INPUT_V1, 'BAD NAME']});
  assert.equal(withList.status, 201, JSON.stringify(withList.body));
  assert.deepEqual(readAgentFeatures(store, withList.body.agentId), [SECRET_INPUT_V1]);
  const without = await pair({code: code(), name: 'Old app', permissions: []});
  assert.equal(without.status, 201, JSON.stringify(without.body));
  assert.deepEqual(readAgentFeatures(store, without.body.agentId), []);
});

test('pairing is one write: a failed feature record leaves no used code and no agent behind', async t => {
  const {store, code} = await rig(t);
  const c = code();
  const kvSet = store.kvSet;
  store.kvSet = () => { throw new Error('disk full'); };
  assert.throws(() => redeemPairing(store, {code: c, name: 'Laptop', permissions: [], features: [SECRET_INPUT_V1]}), /disk full/);
  store.kvSet = kvSet;
  assert.equal(store.all('SELECT id FROM agents').length, 0);
  assert.ok(redeemPairing(store, {code: c, name: 'Laptop', permissions: [], features: [SECRET_INPUT_V1]}).agentId, 'the same code still works');
});

test('updateNeeded with a list that is not an array fails closed, like neededNow', () => {
  assert.deepEqual(updateNeeded([], {list: null}).map(f => f.name), [SECRET_INPUT_V1], 'the shipped list answers instead of nothing');
  assert.equal(neededNow('x-v1', {list: null}), true);
});
