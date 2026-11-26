import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as agent from '../src/agent.js';
import {missingFeatureLine} from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import * as wf from '../shared/workflow.js';
import {coordinationState} from '../src/coordination.js';
import {BROWSER_PERMISSION} from '../shared/bot-browser.js';
import {SECRET_INPUT_V1} from '../shared/device-features.js';
import * as browser from '../src/bot-browser.js';

/* A bot pinned to one computer sends its pages there and nowhere else. A page for a bot with no pin goes as it
 * always did: to the most recently seen online computer that may run it. */

const MIN = 60000;
const agentOnly = {mode: 'agent', available: () => false};
const ago = ms => new Date(Date.now() - ms).toISOString();
const pending = id => ({id, status: 'pending', kind: 'browser.capture', url: 'https://example.com', steps: [], botId: 'web', botName: 'Web', chatKey: 'web', depth: 0});

async function rig(t, {device = null, requests = ['br1']} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'device-pin-browser-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  t.after(async () => { await store.close(); await fs.rm(dir, {recursive: true, force: true}); });
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  const pair = (name, permissions, {seenAgo = 0, features} = {}) => {
    const {code} = agent.createPairing(store, 'default', {});
    const {agentId} = agent.redeemPairing(store, {code, name, permissions});
    store.run('UPDATE agents SET last_seen_at=?, paired_at=? WHERE id=?', ago(seenAgo), ago(86400000), agentId);
    if (features) agent.recordAgentFeatures(store, agentId, features);
    return agentId;
  };
  const setup = async pin => store.update(s => {
    wf.migrate(s); coordinationState(s);
    s.groups = [{id: 'lab', name: 'Lab', bots: [{id: 'web', name: 'Web', instructions: 'Look things up.', type: 'custom', permissions: [BROWSER_PERMISSION], settings: pin ? {device: pin} : {}}]}];
    s.browserRequests = requests.map(pending);
  });
  await setup(device);
  return {store, pair, setup};
}
const tasks = store => store.all('SELECT agent_id FROM agent_tasks');

test('unpinned: the browser answers as before', async t => {
  const {store, pair} = await rig(t);
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly}), e => e.status === 409 && /No paired local agent holds the browser\.capture permission/.test(e.message));
  pair('Other', ['http.check'], {seenAgo: 0});
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly}), e => e.status === 409 && /No paired local agent holds the browser\.capture permission/.test(e.message));
  assert.equal(store.read().browserRequests[0].status, 'pending');
  assert.equal(tasks(store).length, 0);

  const laptop = pair('Laptop', ['browser.capture'], {seenAgo: 10 * MIN});
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly}), e => e.status === 409 && /agent is offline/.test(e.message));
  assert.equal(tasks(store).length, 0);

  store.run('UPDATE agents SET last_seen_at=? WHERE id=?', ago(0), laptop);
  const sent = await browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly});
  assert.equal(sent.status, 'dispatched');
  assert.deepEqual(tasks(store).map(r => r.agent_id), [laptop]);
});

test('a pinned bot\'s page goes only to its computer', async t => {
  const {store, pair, setup} = await rig(t);
  const laptop = pair('Laptop', ['browser.capture'], {seenAgo: MIN});
  const desk = pair('Desk', ['browser.capture'], {seenAgo: 2 * MIN});
  await setup(desk);
  const sent = await browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly});
  assert.equal(sent.via, 'agent');
  assert.equal(store.get('SELECT agent_id FROM agent_tasks').agent_id, desk);
  assert.notEqual(desk, laptop);
});

test('a pinned computer that is asleep is refused as offline, even when another is awake', async t => {
  const {store, pair, setup} = await rig(t);
  pair('Laptop', ['browser.capture'], {seenAgo: 0});
  const desk = pair('Desk', ['browser.capture'], {seenAgo: 10 * MIN});
  await setup(desk);
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly}), e => e.status === 409 && /agent is offline/.test(e.message));
  assert.equal(store.read().browserRequests[0].status, 'pending');
  assert.equal(tasks(store).length, 0);
});

test('a revoked pin is not-pinned, and nothing is queued', async t => {
  const {store, pair, setup} = await rig(t);
  pair('Laptop', ['browser.capture'], {seenAgo: 0});
  const desk = pair('Desk', ['browser.capture'], {seenAgo: MIN});
  await setup(desk);
  agent.revokeAgent(store, desk);
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly}), e => e.status === 409 && /^This bot's computer is not available\. Pair it again, or choose another computer on the bot's profile\.$/.test(e.message));
  assert.equal(store.read().browserRequests[0].status, 'pending');
  assert.equal(tasks(store).length, 0);
});

test('a pin to a computer without the permission is not-pinned', async t => {
  const {store, pair, setup} = await rig(t);
  const desk = pair('Desk', ['http.check'], {seenAgo: 0});
  pair('Laptop', ['browser.capture'], {seenAgo: 0});
  await setup(desk);
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly}), e => e.status === 409 && /computer is not available/.test(e.message));
  assert.equal(tasks(store).length, 0);
});

test('a pinned bot never runs in the server runtime', async t => {
  const {store, pair, setup} = await rig(t, {requests: ['br1', 'br2']});
  const desk = pair('Desk', ['browser.capture'], {seenAgo: 0});
  await setup(desk);
  const here = {mode: 'auto', available: () => true, run: async () => assert.fail('ran on the server')};
  assert.equal((await browser.dispatchBrowserRequest(store, 'br1', {runtime: here})).via, 'agent');
  assert.equal(store.get('SELECT agent_id FROM agent_tasks').agent_id, desk);

  const serverOnly = {mode: 'server', available: () => true, run: async () => assert.fail('ran on the server')};
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br2', {runtime: serverOnly}), e => e.status === 409 && /BROWSER_RUNTIME=server/.test(e.message)
    && e.message === 'This bot is set to use one computer, and this install opens pages only on the server (BROWSER_RUNTIME=server). Clear the bot\'s computer on its profile, or set BROWSER_RUNTIME=auto.');
  assert.equal(store.read().browserRequests[1].status, 'pending');
  assert.equal(tasks(store).length, 1);
});

test('without a pin the server runtime still opens the page itself', async t => {
  const {store} = await rig(t);
  let ran = false;
  const here = {mode: 'auto', available: () => true, run: async () => { ran = true; return {text: 'ok'}; }};
  assert.equal((await browser.dispatchBrowserRequest(store, 'br1', {runtime: here})).via, 'server');
  for (let i = 0; i < 100 && store.read().browserRequests[0]?.status === 'dispatched'; i++) await new Promise(r => setTimeout(r, 20));
  assert.ok(ran);
  assert.equal(tasks(store).length, 0);
});

test('an older device app still reads pages, and is refused only work that needs a feature', async t => {
  const {store, pair} = await rig(t, {requests: ['br1', 'br2']});
  pair('Laptop', ['browser.capture'], {seenAgo: 0});
  assert.equal((await browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly})).via, 'agent');
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br2', {runtime: agentOnly, needs: [SECRET_INPUT_V1]}), e => e.status === 409 && e.message === missingFeatureLine(SECRET_INPUT_V1));
  assert.equal(store.read().browserRequests[1].status, 'pending');
  assert.equal(tasks(store).length, 1);
});

test('a need skips the server browser and goes to a device that reports it', async t => {
  const {store, pair} = await rig(t);
  pair('Old', ['browser.capture'], {seenAgo: 0});
  const fresh = pair('New', ['browser.capture'], {seenAgo: MIN, features: [SECRET_INPUT_V1]});
  const here = {mode: 'auto', available: () => true, run: async () => assert.fail('ran on the server')};
  assert.equal((await browser.dispatchBrowserRequest(store, 'br1', {runtime: here, needs: [SECRET_INPUT_V1]})).via, 'agent');
  assert.equal(store.get('SELECT agent_id FROM agent_tasks').agent_id, fresh);
});

const SERVER_PIN_LINE = 'This bot is set to use one computer, and this install opens pages only on the server (BROWSER_RUNTIME=server). Clear the bot\'s computer on its profile, or set BROWSER_RUNTIME=auto.';

test('a takeover is refused for a pinned bot, because it would open the page on the server', async t => {
  const {store, pair, setup} = await rig(t);
  const desk = pair('Desk', ['browser.capture'], {seenAgo: 0});
  await setup(desk);
  const here = {mode: 'auto', available: () => true, beginLive: async () => assert.fail('opened a pinned bot\'s page on the server')};
  await assert.rejects(browser.beginTakeover(store, 'br1', {runtime: here}), e => e.status === 409 && e.message === SERVER_PIN_LINE);
  assert.equal(store.read().browserRequests[0].status, 'pending');
});

test('a takeover for an unpinned bot still opens on the server', async t => {
  const {store} = await rig(t);
  let opened = null;
  const here = {mode: 'auto', available: () => true, beginLive: async options => { opened = options; return {id: 'takeover-1', url: options.url}; }};
  assert.equal((await browser.beginTakeover(store, 'br1', {runtime: here})).id, 'takeover-1');
  assert.equal(opened.requestId, 'br1');
});

test('a pin to a device id that does not exist gives the server sentence under server mode, and not-pinned elsewhere', async t => {
  const {store, setup} = await rig(t, {requests: ['br1', 'br2']});
  await setup('no-such-device');
  const serverOnly = {mode: 'server', available: () => true, run: async () => assert.fail('ran on the server')};
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: serverOnly}), e => e.status === 409 && e.message === SERVER_PIN_LINE);
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br2', {runtime: agentOnly}), e => e.status === 409 && /computer is not available/.test(e.message));
  assert.equal(tasks(store).length, 0);
});

test('a pinned computer that lacks a needed feature gives the missing-feature line through dispatch', async t => {
  const {store, pair, setup} = await rig(t);
  pair('Laptop', ['browser.capture'], {seenAgo: 0, features: [SECRET_INPUT_V1]});
  const desk = pair('Desk', ['browser.capture'], {seenAgo: 0});
  await setup(desk);
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly, needs: [SECRET_INPUT_V1]}), e => e.status === 409 && e.message === missingFeatureLine(SECRET_INPUT_V1));
  assert.equal(store.read().browserRequests[0].status, 'pending');
  assert.equal(tasks(store).length, 0, 'the other computer that has the feature is not used for a pinned bot');
});
