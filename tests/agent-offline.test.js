import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as agent from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import * as wf from '../shared/workflow.js';
import {createRun} from '../shared/coordination.js';
import {BROWSER_PERMISSION} from '../shared/bot-browser.js';
import {coordinationState, runGroup, resumeBrowserRun} from '../src/coordination.js';
import * as browser from '../src/bot-browser.js';
import {runOnAgent} from '../src/cli-model.js';
import {mcpCall} from '../src/mcp-client.js';

/* A paired computer that has gone away (asleep, closed, killed) must not leave a
 * bot waiting on it: a page is refused up front or failed within a bounded time,
 * and a model or MCP wait gives up once the device stops being seen. */

const block = body => `Let me look.\n\`\`\`browser\n${JSON.stringify(body)}\n\`\`\`\nBack soon.`;
const browserBot = {id: 'web', name: 'Web', instructions: 'Look things up.', type: 'custom', permissions: [BROWSER_PERMISSION], settings: {}};
const agentOnly = {mode: 'agent', available: () => false};
const ago = ms => new Date(Date.now() - ms).toISOString();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function harness(t, permissions) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-offline-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  t.after(async () => { await store.close(); await fs.rm(dir, {recursive: true, force: true}); });
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  const {code} = agent.createPairing(store, 'default', {});
  const {agentId} = agent.redeemPairing(store, {code, name: 'Laptop', permissions});
  agent.touchAgent(store, agentId);
  return {store, agentId};
}

/** A run whose bot asked for a page, cleared to go without asking, parked on `awaiting_browser`. */
async function parkedOnPage(store) {
  await store.update(s => {
    wf.migrate(s); coordinationState(s);
    s.groups = [{id: 'lab', name: 'Lab', bots: [browserBot]}];
    s.grants = [{botId: 'web', action: 'browser.use', scope: 'https://example.com', choice: 'always', at: new Date().toISOString()}];
    s.groupRuns.push(createRun({group: s.groups[0], message: 'Read it', makeId: () => 'run-1', chatKey: 'web'}));
  });
  await runGroup(store, 'run-1', async () => block({url: 'https://example.com'}));
}

test('a page is refused at dispatch when the only capable computer has been offline for days', async t => {
  const {store, agentId} = await harness(t, ['browser.capture']);
  store.run('UPDATE agents SET last_seen_at=?, paired_at=? WHERE id=?', ago(3 * 86400000), ago(9 * 86400000), agentId);
  await store.update(s => {
    wf.migrate(s); coordinationState(s);
    s.browserRequests = [{id: 'br1', status: 'pending', kind: 'browser.capture', url: 'https://example.com', steps: [], botId: 'web', botName: 'Web', chatKey: 'web', depth: 0}];
  });
  await assert.rejects(browser.dispatchBrowserRequest(store, 'br1', {runtime: agentOnly}), error => error.status === 409 && /agent is offline/.test(error.message));
  assert.equal(store.read().browserRequests[0].status, 'pending', 'It stays pending, so approving again after the computer is back still works.');
  assert.equal(store.all('SELECT id FROM agent_tasks').length, 0, 'Nothing is queued for a device that is not there.');
});

test('a computer that goes offline after a page was sent fails the page, and the run carries on', async t => {
  const {store, agentId} = await harness(t, ['browser.capture']);
  await parkedOnPage(store);
  const request = store.read().browserRequests[0];
  assert.equal(request.status, 'dispatched');
  assert.ok(Number.isFinite(request.notAfter) && request.notAfter > Date.now(), 'The page carries a deadline.');
  assert.equal(store.read().groupRuns[0].status, 'awaiting_browser');
  assert.equal(await browser.expireBrowserTasks(store, {resumeBrowser: resumeBrowserRun}), 0, 'A live device is left alone.');

  store.run('UPDATE agents SET last_seen_at=? WHERE id=?', ago(10 * 60000), agentId);
  assert.equal(await browser.expireBrowserTasks(store, {resumeBrowser: (s, req, opts) => resumeBrowserRun(s, req, {...opts, executor: async () => 'Carried on without the page.'})}), 1);
  const s = store.read();
  assert.equal(s.browserRequests[0].status, 'failed');
  assert.match(s.chats.web.find(m => m.kind === 'browser-result').text, /Web's browser request failed: Your computer went offline/);
  assert.equal(store.get('SELECT status FROM agent_tasks WHERE id=?', request.agentTaskIds[0]).status, 'failed', 'A device that wakes later is not handed the page.');
  for (let i = 0; i < 40 && store.read().groupRuns[0].status !== 'completed'; i++) await sleep(20);
  assert.equal(store.read().groupRuns[0].status, 'completed', 'The chat is no longer stuck on "Still working".');
});

test('a page past its deadline is failed even when the computer is still beating', async t => {
  const {store} = await harness(t, ['browser.capture']);
  await parkedOnPage(store);
  await store.update(s => { s.browserRequests[0].notAfter = Date.now() - 1000; });
  assert.equal(await browser.expireBrowserTasks(store, {resumeBrowser: (s, req, opts) => resumeBrowserRun(s, req, {...opts, executor: async () => 'Done.'})}), 1);
  assert.match(store.read().chats.web.find(m => m.kind === 'browser-result').text, /did not open the page in time/);
});

test('a model run fails early when the computer stops being seen mid-wait, not after the whole timeout', async t => {
  const {store, agentId} = await harness(t, ['model.run']);
  const started = Date.now();
  setTimeout(() => store.run('UPDATE agents SET last_seen_at=? WHERE id=?', ago(10 * 60000), agentId), 60);
  await assert.rejects(runOnAgent(store, {engine: 'claude', input: 'hi', waitMs: 60000, pollMs: 20}),
    error => error.code === 'agent-offline' && /^Your computer went offline while running Claude/.test(error.message) && /Start the app on it again, then retry\./.test(error.message));
  assert.ok(Date.now() - started < 5000, 'It gave up within a poll or two.');
  assert.equal(store.get('SELECT status FROM agent_tasks').status, 'failed');
});

test('a slow but live computer still gets the timeout message', async t => {
  const {store} = await harness(t, ['model.run']);
  await assert.rejects(runOnAgent(store, {engine: 'claude', input: 'hi', waitMs: 300, pollMs: 20}), error => error.code === 'timeout' && /did not answer in time/.test(error.message));
});

test('an MCP call fails early when the computer stops being seen mid-wait', async t => {
  const {store, agentId} = await harness(t, ['mcp.call']);
  setTimeout(() => store.run('UPDATE agents SET last_seen_at=? WHERE id=?', ago(10 * 60000), agentId), 60);
  const started = Date.now();
  await assert.rejects(mcpCall({transport: 'stdio', store, server: 'files'}, 'read_file', {}, {timeoutMs: 60000, pollMs: 20}),
    error => error.code === 'agent-offline' && /^Your computer went offline while running the MCP server/.test(error.message) && /then retry\./.test(error.message));
  assert.ok(Date.now() - started < 5000);
  assert.equal(store.get('SELECT status FROM agent_tasks').status, 'failed');
});
