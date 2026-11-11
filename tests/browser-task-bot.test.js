import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as agent from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import * as wf from '../shared/workflow.js';
import {dispatchBrowserRequest} from '../src/bot-browser.js';

/* The device gives each bot its own tab in the shared browser, so a browser task
 * has to say which bot it is for. */

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-task-bot-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  const {code} = agent.createPairing(store, 'default', {});
  const device = agent.redeemPairing(store, {code, name: 'Laptop', permissions: ['browser.capture', 'browser.action']});
  return {dir, store, device};
}

test('a browser task keeps the bot it is for, bounded, and drops any other field', async () => {
  const {dir, store, device} = await harness();
  try {
    const {task} = agent.enqueueAgentTask(store, device.agentId, {kind: 'browser.capture', payload: {url: 'https://example.com/', botId: 'bot-7', secret: 'x'}, idempotencyKey: 'a'});
    assert.deepEqual(JSON.parse(task.payload), {url: 'https://example.com/', steps: [], botId: 'bot-7'});
    const long = agent.enqueueAgentTask(store, device.agentId, {kind: 'browser.capture', payload: {url: 'https://example.com/', botId: 'b'.repeat(200)}, idempotencyKey: 'b'});
    assert.equal(JSON.parse(long.task.payload).botId.length, 64);
    const none = agent.enqueueAgentTask(store, device.agentId, {kind: 'browser.capture', payload: {url: 'https://example.com/', botId: {x: 1}}, idempotencyKey: 'c'});
    assert.deepEqual(JSON.parse(none.task.payload), {url: 'https://example.com/', steps: []}, 'a botId that is not text is dropped');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('an approved request reaches the device with the bot that asked', async () => {
  const {dir, store, device} = await harness();
  try {
    const now = new Date().toISOString();
    await store.update(s => {
      wf.migrate(s);
      s.groups = [{id: 'lab', name: 'Lab', bots: [{id: 'web', name: 'Web', instructions: 'x', type: 'custom', permissions: [], settings: {}}]}];
      s.browserRequests = [{id: 'req-1', botId: 'web', botName: 'Web', groupId: 'lab', chatKey: 'web', url: 'https://example.com/', steps: [], kind: 'browser.capture', depth: 0, status: 'pending', agentTaskIds: [], result: null, error: null, createdAt: now, updatedAt: now}];
    });
    await dispatchBrowserRequest(store, 'req-1');
    const [task] = agent.claimAgentTasks(store, device.agentId);
    assert.equal(JSON.parse(task.payload).botId, 'web');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
