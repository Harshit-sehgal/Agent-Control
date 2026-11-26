import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as agent from '../src/agent.js';
import {missingFeatureLine} from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {SECRET_INPUT_V1} from '../shared/device-features.js';
import {connectorIdentity} from '../shared/connectors.js';
import {runOnAgent, cliSignIn} from '../src/cli-model.js';
import {mcpCall} from '../src/mcp-client.js';
import {useConnector} from '../src/connector-use.js';
import {runConnectorCalls} from '../src/connector-runs.js';
import {createRun} from '../shared/coordination.js';
import {company} from './run-fixture.js';

/* The CLI model and the device MCP ask the one chooser (src/agent.js) which computer gets the task, and a bot's pin
 * narrows the choice to its own computer. */

const MIN = 60000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async fn => { for (let i = 0; i < 400; i++) { const v = fn(); if (v) return v; await sleep(10); } throw new Error('timed out waiting'); };

function pairer(store) {
  store.run("INSERT OR IGNORE INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  return (name, permissions, {seenAgo = 0, pairedAgo = 86400000, features} = {}) => {
    const {code} = agent.createPairing(store, 'default', {});
    const {agentId} = agent.redeemPairing(store, {code, name, permissions});
    const at = ms => new Date(Date.now() - ms).toISOString();
    store.run('UPDATE agents SET last_seen_at=?, paired_at=? WHERE id=?', seenAgo === null ? null : at(seenAgo), at(pairedAgo), agentId);
    if (features) agent.recordAgentFeatures(store, agentId, features);
    return agentId;
  };
}
async function rig(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pin-model-mcp-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  t.after(async () => { await store.close(); await fs.rm(dir, {recursive: true, force: true}); });
  agent.attachVault(store, path.join(dir, 'state.json'));
  return {store, pair: pairer(store)};
}
const pinBot = (store, botId, device) => store.update(s => { s.groups = [{id: 'lab', name: 'Lab', bots: [{id: botId, name: 'Web', instructions: 'x', settings: {device}}]}]; });
const code = (status, c, re) => e => e.status === status && e.code === c && (!re || re.test(e.message));
const run = (store, extra = {}) => runOnAgent(store, {engine: 'claude', input: 'hi', waitMs: 300, pollMs: 10, ...extra});

test('unpinned model runs and sign-in checks give today\'s codes', async t => {
  const {store, pair} = await rig(t);
  await assert.rejects(run(store), code(422, 'no-agent', /No computer is connected to run `claude`/));
  assert.equal(cliSignIn(store, 'claude').status, 'no-agent');
  pair('Laptop', ['browser.capture']);
  await assert.rejects(run(store), code(422, 'no-permission', /not allowed to run models/));
  assert.equal(cliSignIn(store, 'claude').status, 'no-permission');
  pair('Desk', ['model.run'], {seenAgo: 10 * MIN});
  await assert.rejects(run(store), code(422, 'agent-offline', /agent is offline/));
  const off = cliSignIn(store, 'claude');
  assert.equal(off.status, 'agent-offline');
  assert.match(off.message, /agent is offline/);
});

test('a pinned bot\'s model run goes only to its computer, and a revoked pin is not-pinned', async t => {
  const {store, pair} = await rig(t);
  const desk = pair('Desk', ['model.run'], {seenAgo: 2 * MIN});
  pair('Laptop', ['model.run'], {seenAgo: 0});
  await pinBot(store, 'web', desk);
  const reply = runOnAgent(store, {engine: 'claude', input: 'hi', botId: 'web', waitMs: 5000, pollMs: 10});
  const task = await until(() => store.get("SELECT id,agent_id FROM agent_tasks WHERE kind='model.run'"));
  assert.equal(task.agent_id, desk, 'not the more recently seen laptop');
  agent.completeAgentTask(store, desk, task.id, {status: 'done', result: {ok: true, text: 'hello'}});
  assert.equal(await reply, 'hello');
  agent.revokeAgent(store, desk);
  await assert.rejects(runOnAgent(store, {engine: 'claude', input: 'hi', botId: 'web'}), code(422, 'not-pinned', /may not run models\. Choose another computer on the bot's profile/));
  assert.equal(cliSignIn(store, 'claude').agent, 'Laptop', 'the sign-in check uses no pin');
});

test('a just-paired computer that has not beaten yet is waited for, not failed as offline', async t => {
  const {store, pair} = await rig(t);
  pair('New', ['model.run', 'mcp.call'], {seenAgo: null, pairedAgo: 1000});
  await assert.rejects(run(store), e => e.code === 'timeout' && e.status === 504);
  await assert.rejects(mcpCall({transport: 'stdio', store, server: 'files'}, 'read', {}, {timeoutMs: 300, pollMs: 10}), e => e.code === 'timeout' && e.status === 504);
});

test('a computer that stops beating while a model run waits fails as offline', async t => {
  const {store, pair} = await rig(t);
  const desk = pair('Desk', ['model.run'], {seenAgo: 0});
  const reply = assert.rejects(runOnAgent(store, {engine: 'claude', input: 'hi', waitMs: 5000, pollMs: 10}), code(503, 'agent-offline'));
  await until(() => store.get("SELECT id FROM agent_tasks WHERE kind='model.run'"));
  store.run('UPDATE agents SET last_seen_at=? WHERE id=?', new Date(Date.now() - 10 * MIN).toISOString(), desk);
  await reply;
});

test('device MCP: today\'s codes unpinned', async t => {
  const {store, pair} = await rig(t);
  const target = {transport: 'stdio', store, server: 'files'};
  await assert.rejects(mcpCall(target, 'read', {}, {timeoutMs: 300}), code(422, 'no-agent', /No computer is connected for an MCP server/));
  pair('Laptop', ['model.run']);
  await assert.rejects(mcpCall(target, 'read', {}, {timeoutMs: 300}), code(422, 'no-permission', /not allowed to run MCP servers/));
  pair('Desk', ['mcp.call'], {seenAgo: 10 * MIN});
  await assert.rejects(mcpCall(target, 'read', {}, {timeoutMs: 300}), code(422, 'agent-offline', /agent is offline/));
});

test('a connector call carries its bot\'s pin', async t => {
  const {store, pair} = await rig(t);
  const gone = pair('Gone', ['mcp.call']);
  agent.revokeAgent(store, gone);
  pair('Other', ['mcp.call']);
  const files = {kind: 'mcp', transport: 'stdio', agentServer: 'files', name: 'Files'};
  await assert.rejects(useConnector(store, files, 'read', {}, {deviceId: gone}), code(422, 'not-pinned', /may not run MCP servers\. Choose another computer on the bot's profile/));
  assert.equal(store.get('SELECT COUNT(*) n FROM agent_tasks').n, 0);
});

test('a connector run for a pinned bot is refused when its computer is gone, and queues nothing', async t => {
  const {store, ids} = await company(t);
  const pair = pairer(store);
  store.vaultKey = crypto.randomBytes(32);
  const gone = pair('Gone', ['mcp.call']);
  pair('Other', ['mcp.call']);
  agent.revokeAgent(store, gone);
  const connector = {id: 'c1', kind: 'mcp', transport: 'stdio', agentServer: 'files', name: 'Files', status: 'ready', addedAt: new Date().toISOString()};
  const runId = await store.update(s => {
    s.connectors = [connector];
    const bot = s.groups.flatMap(g => g.bots).find(b => b.id === ids.mail);
    bot.settings = {...(bot.settings || {}), device: gone};
    const r = createRun({group: s.groups.find(g => g.id === 'home'), message: 'go', directBotId: ids.mail, chatKey: ids.mail, guests: [], makeId: () => 'run-pin'});
    r.status = 'running';
    r.connectorCalls = [{id: 'call-1', connectorId: 'c1', identity: connectorIdentity(connector), connectorName: 'Files', tool: 'read', args: {}, write: false, botId: ids.mail, botName: 'Mailroom', status: 'go', chatKey: ids.mail}];
    s.groupRuns.unshift(r);
    return r.id;
  });
  const lines = [];
  assert.equal(await runConnectorCalls(store, runId, {say: (s, r, line) => lines.push(line)}), true);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, 'connector-error');
  assert.match(lines[0].text, /may not run MCP servers/);
  assert.equal(store.get("SELECT COUNT(*) n FROM agent_tasks WHERE kind='mcp.call'").n, 0);
});

test('a need the computer lacks is 422 missing-feature for a model run and an MCP call, naming the feature', async t => {
  const {store, pair} = await rig(t);
  pair('Desk', ['model.run', 'mcp.call'], {seenAgo: 0, features: []});
  const lacks = e => e.status === 422 && e.code === 'missing-feature' && e.message === missingFeatureLine(SECRET_INPUT_V1);
  await assert.rejects(run(store, {needs: [SECRET_INPUT_V1]}), lacks);
  await assert.rejects(mcpCall({transport: 'stdio', store, server: 'files'}, 'read', {}, {needs: [SECRET_INPUT_V1], timeoutMs: 300}), lacks);
  assert.equal(store.get('SELECT COUNT(*) n FROM agent_tasks').n, 0, 'no task row is written');
});
