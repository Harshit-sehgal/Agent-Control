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
import {BROWSER_PERMISSION, validateBrowserRequest} from '../shared/bot-browser.js';
import {BROWSER_ACCOUNTS_V1, SECRET_INPUT_V1} from '../shared/device-features.js';
import * as browser from '../src/bot-browser.js';

/* A bot that signs in as a browser account has its pages opened on that account's computer with the account stamped,
 * or not at all: never in the default profile, never on the server, never on another computer. */

const MIN = 60000;
const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const GONE = '22222222-2222-4222-8222-222222222222';
const agentOnly = {mode: 'agent', available: () => false};
const ago = ms => new Date(Date.now() - ms).toISOString();
const pending = id => ({id, status: 'pending', kind: 'browser.capture', url: 'https://crm.example.com/', steps: [], botId: 'web', botName: 'Web', chatKey: 'web', depth: 0});

const GONE_LINE = 'This bot\'s browser account no longer exists. Choose another on the bot\'s Edit page, or clear it.';
const SERVER_LINE = 'This bot signs in as a browser account, which lives on a computer, and this install opens pages only on the server (BROWSER_RUNTIME=server). Set BROWSER_RUNTIME=auto, or clear the bot\'s account on its Edit page.';
const NOT_PINNED_LINE = 'This bot\'s browser account is on a computer that is not available. Pair it again, or move the account to another computer in Settings → Local agents.';
const TAKEOVER_LINE = 'This bot signs in as a browser account, which lives on its computer. Take over from the bot\'s Computer view instead.';

async function rig(t, {requests = ['br1']} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-account-dispatch-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  t.after(async () => { await store.close(); await fs.rm(dir, {recursive: true, force: true}); });
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  const pair = (name, permissions, {seenAgo = 0, features = [BROWSER_ACCOUNTS_V1]} = {}) => {
    const {code} = agent.createPairing(store, 'default', {});
    const {agentId} = agent.redeemPairing(store, {code, name, permissions});
    store.run('UPDATE agents SET last_seen_at=?, paired_at=? WHERE id=?', ago(seenAgo), ago(86400000), agentId);
    if (features) agent.recordAgentFeatures(store, agentId, features);
    return agentId;
  };
  /** The bot `web` signs in as `account` (an id; its record exists only when `deviceId` is given) and may be pinned. */
  const setup = async ({account = null, deviceId = null, pin = null} = {}) => store.update(s => {
    wf.migrate(s); coordinationState(s);
    const settings = {...(pin ? {device: pin} : {}), ...(account ? {browserAccount: account} : {})};
    s.groups = [{id: 'lab', name: 'Lab', bots: [{id: 'web', name: 'Web', instructions: 'Look things up.', type: 'custom', permissions: [BROWSER_PERMISSION], settings}]}];
    s.browserAccounts = deviceId ? [{id: account, name: 'Sales', site: 'crm.example.com', deviceId, storage: 'cookies'}] : [];
    s.browserRequests = requests.map(pending);
  });
  await setup();
  return {store, pair, setup};
}
const tasks = store => store.all('SELECT agent_id, payload FROM agent_tasks');
const noRun = {mode: 'auto', available: () => true, run: async () => assert.fail('ran on the server')};

test('a model\'s block cannot name an account: it never reaches the request or the payload', () => {
  const v = validateBrowserRequest({url: 'https://crm.example.com/', account: 'someone-else', deviceId: 'x'});
  assert.equal(Object.hasOwn(v, 'account'), false);
  assert.equal(Object.hasOwn(v, 'deviceId'), false);
});

test('an account bot\'s page goes to the account\'s computer with the account stamped, even over the bot\'s own pin', async t => {
  const {store, pair, setup} = await rig(t);
  const pc1 = pair('Desk', ['browser.capture'], {seenAgo: 2 * MIN});
  const pc2 = pair('Laptop', ['browser.capture'], {seenAgo: 0});
  await setup({account: ACCOUNT, deviceId: pc1, pin: pc2});
  const sent = await browser.dispatchBrowserRequest(store, 'br1', {runtime: noRun});
  assert.equal(sent.via, 'agent');
  assert.equal(sent.account, ACCOUNT);
  assert.equal(sent.accountName, 'Sales');
  const rows = tasks(store);
  assert.deepEqual(rows.map(r => r.agent_id), [pc1]);
  assert.deepEqual(JSON.parse(rows[0].payload), {url: 'https://crm.example.com/', steps: [], botId: 'web', account: ACCOUNT, deviceId: pc1});
  assert.equal(store.read().browserRequests[0].account, ACCOUNT);
});

test('an account bot with no pin still goes to the account\'s computer, not the most recent one', async t => {
  const {store, pair, setup} = await rig(t);
  const pc1 = pair('Desk', ['browser.capture'], {seenAgo: 2 * MIN});
  pair('Laptop', ['browser.capture'], {seenAgo: 0});
  await setup({account: ACCOUNT, deviceId: pc1});
  await browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly});
  assert.deepEqual(tasks(store).map(r => r.agent_id), [pc1]);
});

test('a request that asks for another need keeps it, and the account feature is added', async t => {
  const {store, pair, setup} = await rig(t);
  const pc1 = pair('Desk', ['browser.capture']);
  await setup({account: ACCOUNT, deviceId: pc1});
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly, needs: SECRET_INPUT_V1}), e => e.status === 409 && e.message === missingFeatureLine(SECRET_INPUT_V1));
  assert.equal(tasks(store).length, 0);
});

test('the wrong account is never the fallback: an account that is gone', async t => {
  const {store, pair, setup} = await rig(t);
  pair('Desk', ['browser.capture']);
  await setup({account: GONE});
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: noRun}), e => e.status === 409 && e.message === GONE_LINE);
  assert.equal(store.read().browserRequests[0].status, 'pending');
  assert.equal(tasks(store).length, 0);
});

test('the wrong account is never the fallback: a computer without browser-accounts-v1', async t => {
  const {store, pair, setup} = await rig(t);
  const pc1 = pair('Desk', ['browser.capture'], {features: []});
  pair('Fresh', ['browser.capture'], {features: [BROWSER_ACCOUNTS_V1]});
  await setup({account: ACCOUNT, deviceId: pc1});
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: noRun}), e => e.status === 409 && e.message === missingFeatureLine(BROWSER_ACCOUNTS_V1));
  assert.equal(store.read().browserRequests[0].status, 'pending');
  assert.equal(tasks(store).length, 0);
});

test('the wrong account is never the fallback: an install that opens pages only on the server, or has one beside the device', async t => {
  const {store, pair, setup} = await rig(t, {requests: ['br1', 'br2']});
  const pc1 = pair('Desk', ['browser.capture']);
  await setup({account: ACCOUNT, deviceId: pc1});
  const serverOnly = {mode: 'server', available: () => true, run: async () => assert.fail('ran on the server')};
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: serverOnly}), e => e.status === 409 && e.message === SERVER_LINE);
  assert.equal(store.read().browserRequests[0].status, 'pending');
  assert.equal(tasks(store).length, 0);
  // auto with a server browser: still the device, never runHere.
  assert.equal((await browser.dispatchBrowserRequest(store, 'br2', {runtime: noRun})).via, 'agent');
  assert.deepEqual(tasks(store).map(r => r.agent_id), [pc1]);
});

test('the wrong account is never the fallback: a revoked or permissionless computer', async t => {
  const {store, pair, setup} = await rig(t, {requests: ['br1', 'br2']});
  pair('Laptop', ['browser.capture']);
  const pc1 = pair('Desk', ['browser.capture']);
  await setup({account: ACCOUNT, deviceId: pc1});
  agent.revokeAgent(store, pc1);
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly}), e => e.status === 409 && e.message === NOT_PINNED_LINE);
  const other = pair('Reader', ['http.check']);
  await setup({account: ACCOUNT, deviceId: other});
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br2', {runtime: agentOnly}), e => e.status === 409 && e.message === NOT_PINNED_LINE);
  assert.equal(tasks(store).length, 0);
  assert.equal(store.read().browserRequests[0].status, 'pending');
});

test('the account\'s computer asleep is refused as offline, never another computer', async t => {
  const {store, pair, setup} = await rig(t);
  const pc1 = pair('Desk', ['browser.capture'], {seenAgo: 10 * MIN});
  pair('Laptop', ['browser.capture'], {seenAgo: 0});
  await setup({account: ACCOUNT, deviceId: pc1});
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly}), e => e.status === 409 && /agent is offline/.test(e.message));
  assert.equal(tasks(store).length, 0);
});

test('a server-runtime takeover of an account bot is refused; a bot with no account is unchanged', async t => {
  const {store, pair, setup} = await rig(t, {requests: ['br1', 'br2']});
  const pc1 = pair('Desk', ['browser.capture']);
  await setup({account: ACCOUNT, deviceId: pc1});
  const opens = {mode: 'auto', available: () => true, beginLive: async () => assert.fail('opened an account bot\'s page on the server')};
  await assert.rejects(browser.beginTakeover(store, 'br1', {runtime: opens}), e => e.status === 409 && e.message === TAKEOVER_LINE);
  // An account that is gone is refused too, not opened in a signed-out server context.
  await setup({account: GONE});
  await assert.rejects(browser.beginTakeover(store, 'br1', {runtime: opens}), e => e.status === 409 && e.message === GONE_LINE);

  await setup();
  let opened = null;
  const here = {mode: 'auto', available: () => true, beginLive: async options => { opened = options; return {id: 'takeover-1', url: options.url}; }};
  assert.equal((await browser.beginTakeover(store, 'br1', {runtime: here})).id, 'takeover-1');
  assert.equal(opened.requestId, 'br1');
});

test('a bot with no account is byte for byte as before: no account key in the payload or the request', async t => {
  const {store, pair} = await rig(t);
  const laptop = pair('Laptop', ['browser.capture'], {features: null});
  const sent = await browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly});
  assert.equal(Object.hasOwn(sent, 'account'), false);
  assert.equal(Object.hasOwn(sent, 'accountName'), false);
  const [row] = tasks(store);
  assert.equal(row.agent_id, laptop);
  assert.deepEqual(JSON.parse(row.payload), {url: 'https://crm.example.com/', steps: [], botId: 'web'});
});

test('the queue never lets a payload name an account: only dispatch\'s argument stamps it', async t => {
  const {store, pair} = await rig(t);
  const laptop = pair('Laptop', ['browser.capture']);
  const {task} = agent.enqueueAgentTask(store, laptop, {kind: 'browser.capture', payload: {url: 'https://crm.example.com/', account: ACCOUNT, deviceId: 'x'}});
  assert.deepEqual(JSON.parse(task.payload), {url: 'https://crm.example.com/', steps: []});
});
