import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as agent from '../src/agent.js';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey} from '../src/vault.js';

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-guard-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary',?)", new Date().toISOString());
  agent.attachVault(store, path.join(dir, 'state.json'));
  return {dir, store};
}

test('a corrupt vault keyfile is never silently overwritten', async () => {
  // Make the file path the only key source for this test.
  const saved = process.env.MASTER_KEY;
  delete process.env.MASTER_KEY;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-guard-'));
  try {
    const dataFile = path.join(dir, 'state.json');
    const keyfile = path.join(dir, 'vault.key');
    await fs.writeFile(keyfile, 'CORRUPTED-NOT-A-KEY');
    assert.throws(() => loadMasterKey(dataFile), /refusing to overwrite|not a valid 32-byte/i);
    assert.equal(await fs.readFile(keyfile, 'utf8'), 'CORRUPTED-NOT-A-KEY', 'A corrupt keyfile must be left untouched, not rotated.');

    // A missing keyfile is generated once and then reused byte-for-byte.
    await fs.rm(keyfile);
    const first = loadMasterKey(dataFile);
    const second = loadMasterKey(dataFile);
    assert.equal(first.key.length, 32);
    assert.equal(first.key.toString('base64'), second.key.toString('base64'));
  } finally {
    if (saved === undefined) delete process.env.MASTER_KEY; else process.env.MASTER_KEY = saved;
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('the task kind permission gates enqueueing even without an explicit permission arg', async () => {
  const {store, dir} = await harness();
  try {
    const {code} = agent.createPairing(store, 'default', {});
    const {agentId} = agent.redeemPairing(store, {code, name: 'Locked', permissions: []});
    // Deliberately no `permission` field: the kind's own permission must still apply.
    assert.throws(() => agent.enqueueAgentTask(store, agentId, {kind: 'http.check', payload: {}}), /does not hold/);
    agent.setAgentPermissions(store, agentId, ['http.check']);
    const {task} = agent.enqueueAgentTask(store, agentId, {kind: 'http.check', payload: {url: 'https://example.com'}});
    assert.ok(task?.id, 'The permitted agent can be given the task.');
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});
