import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey} from '../src/vault.js';
import * as credentials from '../src/credentials.js';
import * as backup from '../src/backup.js';
import {normalizeRetention,pruneState} from '../shared/retention.js';
import {updateRetention, migrate} from '../shared/workflow.js';

const store = () => {
  const s = {settings: {}, events: [], groups: []};
  migrate(s);
  return s;
};

test('retention validation bounds the window and prune only removes exhaust', () => {
  assert.throws(() => normalizeRetention({events: -1}), /0.1825 days|0–1825/);
  assert.throws(() => normalizeRetention({doneTasks: 99999}), /0.1825 days|0–1825/);
  assert.deepEqual(normalizeRetention({}), {events: 90, doneTasks: 30, runs: 30});
  assert.equal(normalizeRetention({events: 0}).events, 0, 'Zero disables pruning for that collection.');

  const s = store();
  const now = Date.now();
  s.events = [
    {id: 'e1', at: new Date(now - 200 * 86400000).toISOString(), type: 'x', message: 'old', meta: {}},
    {id: 'e2', at: new Date(now - 10 * 86400000).toISOString(), type: 'x', message: 'recent', meta: {}},
  ];
  s.tasks = [
    {id: 't1', kind: 'bot-task', title: 'done long ago', status: 'done', completedAt: new Date(now - 400 * 86400000).toISOString(), payload: {}},
    {id: 't2', kind: 'bot-task', title: 'still queued', status: 'queued', payload: {}},
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
  updateRetention(s, {events: 7, doneTasks: 3});
  assert.deepEqual(s.settings.retention, {events: 7, doneTasks: 3, runs: 30});
  assert.throws(() => updateRetention(s, {events: 5000}), /0–1825 days/);
  assert.deepEqual(s.settings.retention, {events: 7, doneTasks: 3, runs: 30}, 'a refused policy keeps the one in force');
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
  // A member who had opted into this webhook is turned off with it: leaving the
  // id behind queues a delivery that can only fail, five times, for a URL that
  // no longer exists.
  store.run(`INSERT INTO notification_prefs (user_id,in_app,webhook,webhook_url,email,email_address,updated_at)
    VALUES ('member@localhost',1,1,?,'0','',?)`, row.id, new Date().toISOString());
  // Deletion is immediate.
  assert.deepEqual(credentials.deleteCredential(store, 'default', row.id), {ok: true, clearedPreferences: true});
  assert.deepEqual(
    {...store.get('SELECT webhook, webhook_url FROM notification_prefs WHERE user_id=?', 'member@localhost')},
    {webhook: 0, webhook_url: null});
  assert.throws(() => credentials.deleteCredential(store, 'default', row.id), /not found/);
  // And the pair is one write: a failure between the DELETE and the preference
  // update must leave the credential in place rather than a preference that
  // points at a row nothing will ever find.
  const second = credentials.addCredential(store, 'default', {name: 'hook', value: 'https://hooks.example.test/abc'});
  store.run('UPDATE notification_prefs SET webhook=1, webhook_url=? WHERE user_id=?', second.id, 'member@localhost');
  const realRun = store.run.bind(store);
  store.run = (sql, ...params) => {
    if (sql.startsWith('UPDATE notification_prefs')) throw new Error('database is locked');
    return realRun(sql, ...params);
  };
  try { assert.throws(() => credentials.deleteCredential(store, 'default', second.id), /locked/); }
  finally { store.run = realRun; }
  assert.equal(store.get('SELECT count(*) AS n FROM credentials WHERE id=?', second.id).n, 1, 'the credential is still there');
  assert.equal(store.get('SELECT webhook_url FROM notification_prefs WHERE user_id=?', 'member@localhost').webhook_url, second.id, 'and the preference still points at a row that exists');
  await fs.rm(dir, {recursive: true, force: true});
});

test('backup export/import round-trips data and never carries credentials or sessions', async () => {
  const {dir, store} = await harness();
  await store.update(s => {
    s.groups.push({id: 'g-backup', name: 'Backed up', description: 'Round trip', bots: [{id: 'b-backup', name: 'Keeper', instructions: 'Hold on to this through a restore.'}]});
    s.events.unshift({id: 'e-backup', at: new Date().toISOString(), type: 'group', message: 'Created group Backed up.', meta: {}});
  });
  credentials.addCredential(store, 'default', {name: 'api', value: 'secret-sauce'});
  const backupDoc = backup.exportBackup(store);
  assert.equal(backupDoc.backupVersion, backup.BACKUP_VERSION);
  assert.ok(backupDoc.tables.groups.some(g => g.id === 'g-backup'));
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
  assert.equal(store2.get('SELECT count(*) AS n FROM groups WHERE id=?', 'g-backup').n, 1);
  assert.equal(store2.get('SELECT count(*) AS n FROM credentials').n, 0, 'Credentials were not part of the backup.');

  // Restore refuses to clobber an existing installation without force.
  assert.throws(() => backup.importBackup(store2, backupDoc), /already holds workspace data/);
  const forced = backup.importBackup(store2, backupDoc, {force: true});
  assert.ok(forced.restored > 0);

  // Validation rejects truncation and tampering before anything is written.
  const tampered = JSON.parse(JSON.stringify(backupDoc));
  tampered.tables.groups.push({id: 'evil', name: 'Evil', description: ''});
  assert.throws(() => backup.importBackup(store2, tampered, {force: true}), /checksum/);
  const missing = JSON.parse(JSON.stringify(backupDoc));
  delete missing.tables.events;
  assert.throws(() => backup.validateBackup(missing), /missing the "events" table/);
  assert.throws(() => backup.validateBackup({backupVersion: 99, tables: {}}), /Unsupported backup version/);
  await fs.rm(dir, {recursive: true, force: true});
  await fs.rm(dir2, {recursive: true, force: true});
});

test('a backup read failure is not saved as an empty table', () => {
  const missing = {
    all(sql) {
      if (String(sql).includes('chat_messages')) throw new Error('no such table: chat_messages');
      return [];
    },
    get() { return {version: 7}; },
  };
  const doc = backup.exportBackup(missing);
  assert.deepEqual(doc.tables.chat_messages, []);
  assert.ok(doc.checksum);
  const locked = {
    all(sql) { if (String(sql).includes('users')) throw new Error('database is locked'); return []; },
    get() { return {version: 7}; },
  };
  assert.throws(() => backup.exportBackup(locked), /database is locked/);
});

test('a backup drops agent secrets and still restores the agent row', async () => {
  const {dir, store} = await harness();
  const rawSecret = 'agent-device-secret-RAW';
  const rawHash = 'agent-secret-hash-RAW';
  store.run('INSERT INTO agents (id,workspace_id,name,secret_hash,secret_enc,status,permissions,paired_at) VALUES (?,?,?,?,?,?,?,?)',
    'agent-1', 'default', 'Device', rawHash, rawSecret, 'paired', '[]', new Date().toISOString());
  const backupDoc = backup.exportBackup(store);
  const blob = JSON.stringify(backupDoc);
  assert.equal(blob.includes(rawSecret), false, 'Agent ciphertext must not be exported.');
  assert.equal(blob.includes(rawHash), false, 'The real secret hash must not be exported.');
  assert.equal(backupDoc.tables.agents[0].secret_enc, null);
  assert.equal(backupDoc.tables.agents[0].secret_hash, 'redacted');

  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'secrets-agent-'));
  const store2 = await new SqliteStore(path.join(dir2, 'state.db'), path.join(dir2, 'state.json')).init();
  backup.importBackup(store2, JSON.parse(JSON.stringify(backupDoc)));
  const restored = store2.get('SELECT secret_hash, secret_enc FROM agents WHERE id=?', 'agent-1');
  assert.equal(restored.secret_hash, 'redacted');
  assert.equal(restored.secret_enc, null);

  // A backup written when secret_hash was SQL NULL must still validate and restore.
  const legacy = JSON.parse(JSON.stringify(backupDoc));
  legacy.tables.agents[0].secret_hash = null;
  legacy.checksum = crypto.createHash('sha256').update(JSON.stringify(legacy.tables)).digest('hex');
  const dir3 = await fs.mkdtemp(path.join(os.tmpdir(), 'secrets-agent-old-'));
  const store3 = await new SqliteStore(path.join(dir3, 'state.db'), path.join(dir3, 'state.json')).init();
  backup.importBackup(store3, legacy);
  assert.equal(store3.get('SELECT secret_hash FROM agents WHERE id=?', 'agent-1').secret_hash, 'redacted');

  await fs.rm(dir, {recursive: true, force: true});
  await fs.rm(dir2, {recursive: true, force: true});
  await fs.rm(dir3, {recursive: true, force: true});
});

test('restoring a backup interrupts in-flight runs that would otherwise wedge the group', async () => {
  const {dir, store} = await harness();
  await store.update(s => {
    s.groupRuns.push({
      id: 'r-wait', groupId: 'home', input: 'hi', recipients: ['atlas'],
      mode: 'pipeline', status: 'awaiting_browser', currentStep: 0,
      createdAt: new Date().toISOString(), trace: [], lastOutput: null, error: null,
    });
  });
  const backupDoc = backup.exportBackup(store);
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'secrets-restore-busy-'));
  const dataFile2 = path.join(dir2, 'state.json');
  const store2 = await new SqliteStore(path.join(dir2, 'state.db'), dataFile2).init();
  store2.vaultKey = loadMasterKey(dataFile2).key;
  backup.importBackup(store2, JSON.parse(JSON.stringify(backupDoc)));
  assert.equal(store2.read().groupRuns.find(r => r.id === 'r-wait')?.status, 'interrupted');
  await fs.rm(dir, {recursive: true, force: true});
  await fs.rm(dir2, {recursive: true, force: true});
});

test('restoring a backup keeps a shown plan and a checkpoint, and drops live browser cards', async () => {
  const {dir, store} = await harness();
  await store.update(s => {
    s.groupRuns.push(
      {id: 'r-plan', groupId: 'home', input: 'hi', recipients: ['atlas'], mode: 'pipeline', status: 'awaiting_plan', currentStep: 0, createdAt: new Date().toISOString(), trace: [], lastOutput: null, error: null},
      {id: 'r-pause', groupId: 'home', input: 'hi', recipients: ['atlas'], mode: 'pipeline', status: 'awaiting_checkpoint', currentStep: 1, createdAt: new Date().toISOString(), trace: [], lastOutput: null, error: null},
    );
    s.browserRequests = [{id: 'ghost', status: 'pending', chatKey: 'atlas'}];
  });
  const backupDoc = backup.exportBackup(store);
  const dir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'secrets-restore-plan-'));
  const dataFile2 = path.join(dir2, 'state.json');
  const store2 = await new SqliteStore(path.join(dir2, 'state.db'), dataFile2).init();
  store2.vaultKey = loadMasterKey(dataFile2).key;
  store2.kvSet('browser_requests', JSON.stringify([{id: 'stale', status: 'pending'}]));
  backup.importBackup(store2, JSON.parse(JSON.stringify(backupDoc)));
  assert.equal(store2.read().groupRuns.find(r => r.id === 'r-plan')?.status, 'awaiting_plan');
  assert.equal(store2.read().groupRuns.find(r => r.id === 'r-pause')?.status, 'awaiting_checkpoint');
  assert.equal((store2.read().browserRequests || []).length, 0);
  await fs.rm(dir, {recursive: true, force: true});
  await fs.rm(dir2, {recursive: true, force: true});
});
