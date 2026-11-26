import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as agent from '../src/agent.js';
import {chooseDevice, normalizeNeeds, agentOnline, missingFeatureLine, AGENT_ONLINE_MS} from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {SECRET_INPUT_V1} from '../shared/device-features.js';

/* One chooser for every caller that hands work to a paired computer: the most recently seen one that may run the
 * task, reports what it needs and is online, or the one reason there is none. */

const MIN = 60000;

async function rig(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'choose-device-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  t.after(async () => { await store.close(); await fs.rm(dir, {recursive: true, force: true}); });
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  /** seenAgo: null means never seen. pairedAgo defaults to a day. */
  const pair = (name, permissions, {seenAgo = 0, pairedAgo = 86400000, features} = {}) => {
    const {code} = agent.createPairing(store, 'default', {});
    const {agentId} = agent.redeemPairing(store, {code, name, permissions});
    const at = ms => new Date(Date.now() - ms).toISOString();
    store.run('UPDATE agents SET last_seen_at=?, paired_at=? WHERE id=?', seenAgo === null ? null : at(seenAgo), at(pairedAgo), agentId);
    if (features) agent.recordAgentFeatures(store, agentId, features);
    return agentId;
  };
  return {store, pair};
}

test('no computer, none that may, none online: the three reasons', async t => {
  const {store, pair} = await rig(t);
  assert.deepEqual(chooseDevice(store, {kind: 'model.run'}), {reason: 'no-agent'});
  pair('Laptop', ['browser.capture'], {seenAgo: 0});
  assert.deepEqual(chooseDevice(store, {kind: 'model.run'}), {reason: 'no-permission'});
  pair('Desk', ['model.run'], {seenAgo: 10 * MIN});
  assert.deepEqual(chooseDevice(store, {kind: 'model.run'}), {reason: 'agent-offline'});
  assert.deepEqual(chooseDevice({read: () => ({})}, {kind: 'model.run'}), {reason: 'no-agent'});
});

test('online is seen within AGENT_ONLINE_MS, or paired within it and never seen', async t => {
  assert.equal(AGENT_ONLINE_MS, 180000);
  const {store, pair} = await rig(t);
  const fresh = pair('New', ['model.run'], {seenAgo: null, pairedAgo: MIN});
  assert.equal(chooseDevice(store, {kind: 'model.run'}).agent.id, fresh);
  store.run('UPDATE agents SET paired_at=? WHERE id=?', new Date(Date.now() - 10 * MIN).toISOString(), fresh);
  assert.deepEqual(chooseDevice(store, {kind: 'model.run'}), {reason: 'agent-offline'});
  const at = ms => new Date(Date.now() - ms).toISOString();
  assert.equal(agentOnline({last_seen_at: at(10 * MIN), paired_at: at(MIN)}), false, 'a device that was seen is judged by when it was seen');
});

test('the most recently seen capable computer is chosen, and a revoked one never is', async t => {
  const {store, pair} = await rig(t);
  const older = pair('Desk', ['browser.capture'], {seenAgo: 2 * MIN});
  const newer = pair('Laptop', ['browser.capture'], {seenAgo: MIN});
  assert.equal(chooseDevice(store, {kind: 'browser.capture'}).agent.id, newer);
  agent.revokeAgent(store, newer);
  assert.equal(chooseDevice(store, {kind: 'browser.capture'}).agent.id, older);
});

test('a pin restricts the choice to that computer, and a revoked pin gives not-pinned', async t => {
  const {store, pair} = await rig(t);
  pair('Laptop', ['browser.capture'], {seenAgo: MIN});
  const desk = pair('Desk', ['browser.capture'], {seenAgo: 2 * MIN});
  const asleep = pair('Old', ['browser.capture'], {seenAgo: 10 * MIN});
  assert.equal(chooseDevice(store, {kind: 'browser.capture', deviceId: desk}).agent.id, desk);
  assert.deepEqual(chooseDevice(store, {kind: 'model.run', deviceId: desk}), {reason: 'not-pinned'});
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', deviceId: 'nope'}), {reason: 'not-pinned'});
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', deviceId: asleep}), {reason: 'agent-offline'});
  for (const row of store.all('SELECT id FROM agents')) agent.revokeAgent(store, row.id);
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', deviceId: desk}), {reason: 'not-pinned'}, 'not no-agent');
});

test('needs: a computer that reports no features gets no work that needs one, and still gets the rest', async t => {
  const {store, pair} = await rig(t);
  const old = pair('Old app', ['browser.capture'], {seenAgo: 0});           // reports nothing
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', needs: [SECRET_INPUT_V1]}), {reason: 'missing-feature', feature: SECRET_INPUT_V1});
  assert.equal(chooseDevice(store, {kind: 'browser.capture'}).agent.id, old, 'no needs: it is chosen as before');
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', deviceId: old, needs: [SECRET_INPUT_V1]}), {reason: 'missing-feature', feature: SECRET_INPUT_V1});
  const updated = pair('New app', ['browser.capture'], {seenAgo: 2 * MIN, features: [SECRET_INPUT_V1]});
  assert.equal(chooseDevice(store, {kind: 'browser.capture', needs: [SECRET_INPUT_V1]}).agent.id, updated, 'the older-seen one that has it wins');
  store.run('UPDATE agents SET last_seen_at=? WHERE id=?', new Date(Date.now() - 10 * MIN).toISOString(), updated);
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', needs: [SECRET_INPUT_V1]}), {reason: 'agent-offline'}, 'one has it but is asleep');
  assert.deepEqual(chooseDevice({all: () => [{id: 'x', permissions: '["browser.capture"]', last_seen_at: new Date().toISOString()}]}, {kind: 'browser.capture', needs: [SECRET_INPUT_V1]}), {reason: 'missing-feature', feature: SECRET_INPUT_V1}, 'no kv: no features');
  assert.match(missingFeatureLine(SECRET_INPUT_V1), /^This needs a newer app on your computer: it does not report secret-input-v1\. Update the app on your computer, then try again\.$/);
});

test('nowMs moves the clock the online rule reads', async t => {
  const {store, pair} = await rig(t);
  const id = pair('Laptop', ['model.run'], {seenAgo: 0});
  assert.equal(chooseDevice(store, {kind: 'model.run'}).agent.id, id);
  assert.deepEqual(chooseDevice(store, {kind: 'model.run', nowMs: Date.now() + 10 * MIN}), {reason: 'agent-offline'});
});

test('fails closed: an unknown need, a features value that is not a list, and a pin that is asleep and lacks one', async t => {
  const {store, pair} = await rig(t);
  const id = pair('Laptop', ['browser.capture'], {seenAgo: 0, features: [SECRET_INPUT_V1]});
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', needs: ['no-such-v9']}), {reason: 'missing-feature', feature: 'no-such-v9'});
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', needs: [SECRET_INPUT_V1, 'no-such-v9']}), {reason: 'missing-feature', feature: 'no-such-v9'}, 'the first need is met, so the second is named');
  store.kvSet(`agent_features:${id}`, JSON.stringify(SECRET_INPUT_V1));
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', needs: [SECRET_INPUT_V1]}), {reason: 'missing-feature', feature: SECRET_INPUT_V1}, 'a string is not a list');
  store.kvSet(`agent_features:${id}`, JSON.stringify([]));
  store.run('UPDATE agents SET last_seen_at=? WHERE id=?', new Date(Date.now() - 10 * MIN).toISOString(), id);
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', deviceId: id, needs: [SECRET_INPUT_V1]}), {reason: 'missing-feature', feature: SECRET_INPUT_V1}, 'missing-feature comes before agent-offline');
});

test('fails closed: permissions that are not a list grant nothing, and needs that is not a list needs nothing', async t => {
  const {store, pair} = await rig(t);
  const id = pair('Odd', ['browser.capture'], {seenAgo: 0});
  store.run('UPDATE agents SET permissions=? WHERE id=?', JSON.stringify('browser.capture'), id);
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture'}), {reason: 'no-permission'}, 'a string that contains the kind is not a grant');
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', deviceId: id}), {reason: 'not-pinned'});
  store.run('UPDATE agents SET permissions=? WHERE id=?', JSON.stringify(['browser.capture']), id);
  assert.equal(chooseDevice(store, {kind: 'browser.capture', needs: null}).agent.id, id);
  // A string is a one-item list; anything else is a need nobody can meet, so the chooser refuses rather than ignore it.
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', needs: 'no-such-v9'}), {reason: 'missing-feature', feature: 'no-such-v9'});
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', needs: {0: 'x'}}), {reason: 'missing-feature', feature: '<invalid>'});
  assert.deepEqual(chooseDevice(store, {kind: 'browser.capture', needs: 7}), {reason: 'missing-feature', feature: '<invalid>'});
  agent.recordAgentFeatures(store, id, [SECRET_INPUT_V1]);
  assert.equal(chooseDevice(store, {kind: 'browser.capture', needs: SECRET_INPUT_V1}).agent.id, id, 'a string need behaves like a one-item list');
});

test('normalizeNeeds: nothing is no needs, a string is one, a list is itself, anything else is a need nobody meets', () => {
  assert.deepEqual(normalizeNeeds(undefined), []);
  assert.deepEqual(normalizeNeeds(null), []);
  assert.deepEqual(normalizeNeeds('a-v1'), ['a-v1']);
  const list = ['a-v1', 'b-v1'];
  assert.equal(normalizeNeeds(list), list);
  assert.deepEqual(normalizeNeeds([]), []);
  for (const odd of ['', 7, true, {}, {length: 0}, () => {}]) assert.deepEqual(normalizeNeeds(odd), ['<invalid>'], String(typeof odd));
});
