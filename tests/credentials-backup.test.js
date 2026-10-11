import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey} from '../src/vault.js';
import * as credentials from '../src/credentials.js';
import * as backup from '../src/backup.js';
import {normalizeRetention,pruneState} from '../shared/retention.js';
import {updateSettings} from '../shared/workflow.js';
import {migrate} from '../shared/workflow.js';

const store = () => {
  const s = {settings: {topics: ['AI'], style: '', opinions: '', minDelay: 0, maxDelay: 0}, candidates: [], drafts: [], evidence: [], events: [], groups: []};
  migrate(s);
  return s;
};

test('retention validation bounds the window and prune only removes exhaust', () => {
  assert.throws(() => normalizeRetention({events: -1}), /0.1825 days|0–1825/);
  assert.throws(() => normalizeRetention({doneTasks: 99999}), /0.1825 days|0–1825/);
  assert.deepEqual(normalizeRetention({}), {events: 90, doneTasks: 30, sentNotifications: 30, runs: 30});
  assert.equal(normalizeRetention({events: 0}).events, 0, 'Zero disables pruning for that collection.');

  const s = store();
  const now = Date.now();
  s.events = [
    {id: 'e1', at: new Date(now - 200 * 86400000).toISOString(), type: 'x', message: 'old', meta: {}},
    {id: 'e2', at: new Date(now - 10 * 86400000).toISOString(), type: 'x', message: 'recent', meta: {}},
  ];
  s.tasks = [
    {id: 't1', kind: 'reminder', title: 'done long ago', status: 'done', completedAt: new Date(now - 400 * 86400000).toISOString(), payload: {}},
    {id: 't2', kind: 'reminder', title: 'still queued', status: 'queued', payload: {}},
  ];
  s.runs = [
    {id: 'r1', botId: 'b', botName: 'B', input: 'i', output: 'o', at: new Date(now - 400 * 86400000).toISOString()},
    {id: 'r2', botId: 'b', botName: 'B', input: 'i', output: 'o', at: new Date(now - 1000).toISOString()},
  ];
  const preview = pruneState(s, {dryRun: true});
  assert.deepEqual(preview, {events: 1, doneTasks: 1, runs: 1, dryRun: true});
  assert.equal(s.events.length, 2, 'A dry run must not change the state.');
  const report = pruneState(s);
  assert.equal(report.events, 1);
  assert.ok(s.events.some(e => e.id === 'e2'), 'The recent event must survive.');
  assert.ok(!s.events.some(e => e.id === 'e1'), 'The old event must be gone.');
  assert.equal(s.tasks.length, 1, 'A queued task must never be pruned.');
  assert.equal(s.tasks[0].id, 't2');
  assert.equal(s.runs.length, 1);
  assert.ok(s.events.some(e => e.type === 'retention'), 'The prune is itself recorded.');
});

test('retention is a workspace setting, validated through the settings route', () => {
  const s = store();
  updateSettings(s, {retention: {events: 7, doneTasks: 3}});
  assert.deepEqual(s.settings.retention, {events: 7, doneTasks: 3, sentNotifications: 30, runs: 30});
  assert.throws(() => updateSettings(s, {retention: {events: 5000}}), /0–1825 days/);
});

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'secrets-'));
  const dataFile = path.join(dir, 'state.json');
  const store = await new SqliteStore(path.join(dir, 'state.db'), dataFile).init();
  loadMasterKey(dataFile);
  store.vaultKey = loadMasterKey(dataFile).key;
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  return {dir, store};
}

test('credentials are encrypted at rest, listed without values, and revealed by admins only', async () => {
  const {dir, store} = await harness();
  credentials.addCredential(store, 'default', {name: 'webhook-token', kind: 'webhook', value: 'super-secret-value', expiresAt: new Date(Date.now() + 86400000).toISOString(), createdBy: 'owner@localhost'});
  const list = credentials.listCredentials(store, 'default');
  assert.equal(list.length, 1);
  assert.equal(list[0].name, 'webhook-token');
  assert.equal(list[0].expiringSoon, true);
  assert.equal('value' in list[0], false, 'The listing must never carry the secret.');
  // The raw row holds only ciphertext.
  const row = store.get('SELECT * FROM credentials');
  assert.doesNotMatch(String(row.ciphertext), /super-secret-value/);
  const revealed = credentials.revealCredential(store, 'default', row.id);
  assert.equal(revealed.value, 'super-secret-value');
  // Validation.
  assert.throws(() => credentials.addCredential(store, 'default', {name: '', value: 'x'}), /name is required/);
  assert.throws(() => credentials.addCredential(store, 'default', {name: 'x'}), /value is required/);
  assert.throws(() => credentials.addCredential(store, 'default', {name: 'x', value: 'v', expiresAt: 'nope'}), /valid date/);
  assert.throws(() => credentials.addCredential(store, 'default', {name: 'x', value: 'v', expiresAt: new Date(Date.now() - 1000).toISOString()}), /future/);
  assert.throws(() => credentials.revealCredential(store, 'default', 'missing'), /not found/);
  // Expiry is enforced at reveal time, not just displayed.
  credentials.addCredential(store, 'default', {name: 'old', value: 'v', expiresAt: new Date(Date.now() + 2000).toISOString()});
  const expiredId = credentials.listCredentials(store, 'default').find(c => c.name === 'old').id;
  store.run('UPDATE credentials SET expires_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), expiredId);
  assert.throws(() => credentials.revealCredential(store, 'default', expiredId), /expired/);
  // Deletion is immediate.
  assert.deepEqual(credentials.deleteCredential(store, 'default', row.id), {ok: true});
  assert.throws(() => credentials.deleteCredential(store, 'default', row.id), /not found/);
  await fs.rm(dir, {recursive: true, force: true});
});

test('backup export/import round-trips data and never carries credentials or sessions', async () => {
  const {dir, store} = await harness();
  await store.update(s => {
    s.candidates.push({id: 'c1', url: 'https://x.com/a/status/1', author: 'A', topic: 'AI', text: 'A candidate long enough to matter.', status: 'new', createdAt: new Date().toISOString()});
  });
  credentials.addCredential(store, 'default', {name: 'api', value: 'secret-sauce'});
  const backupDoc = backup.exportBackup(store);
  assert.equal(backupDoc.backupVersion, backup.BACKUP_VERSION);
  assert.ok(backupDoc.tables.candidates.some(c => c.id === 'c1'));
  assert.ok(!('credentials' in backupDoc.tables), 'Credentials must never be exported.');
  assert.ok(!('sessions' in backupDoc.tables), 'Live sessions must never be exported.');
  assert.ok(backupDoc.excluded.includes('credentials'));

  // Restoring into a second installation reproduces the workflow data.
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'secrets-restore-'));
  const dataFile2 = path.join(dir2, 'state.json');
  const store2 = await new SqliteStore(path.join(dir2, 'state.db'), dataFile2).init();
  store2.vaultKey = loadMasterKey(dataFile2).key;
  const result = backup.importBackup(store2, JSON.parse(JSON.stringify(backupDoc)));
  assert.ok(result.restored > 0);
  assert.equal(store2.get('SELECT count(*) AS n FROM candidates').n, 1);
  assert.equal(store2.get('SELECT count(*) AS n FROM credentials').n, 0, 'Credentials were not part of the backup.');

  // Restore refuses to clobber an existing installation without force.
  assert.throws(() => backup.importBackup(store2, backupDoc), /already holds workspace data/);
  const forced = backup.importBackup(store2, backupDoc, {force: true});
  assert.ok(forced.restored > 0);

  // Validation rejects truncation and tampering before anything is written.
  const tampered = JSON.parse(JSON.stringify(backupDoc));
  tampered.tables.candidates.push({id: 'evil', url: 'https://evil.example', author: 'E', topic: '', text: 'x', status: 'new', created_at: new Date().toISOString()});
  assert.throws(() => backup.importBackup(store2, tampered, {force: true}), /checksum/);
  const missing = JSON.parse(JSON.stringify(backupDoc));
  delete missing.tables.drafts;
  assert.throws(() => backup.validateBackup(missing), /missing the "drafts" table/);
  assert.throws(() => backup.validateBackup({backupVersion: 99, tables: {}}), /Unsupported backup version/);
  await fs.rm(dir, {recursive: true, force: true});
  await fs.rm(dir2, {recursive: true, force: true});
});
