import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {SqliteStore,SCHEMA_DB_VERSION} from '../src/sqlite-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-sqlite-'));
  return {dir, db: path.join(dir, 'state.db'), legacy: path.join(dir, 'state.json')};
}

test('a fresh database seeds the built-in workspace and persists updates across restarts', async () => {
  const {db} = await sandbox();
  const first = await new SqliteStore(db, path.join(path.dirname(db), "state.json")).init();
  const group = first.read().groups.find(g => g.id === 'x-engage');
  assert.ok(group, 'The built-in X-engage group must exist on first boot.');
  assert.equal(group.bots.length, 6);
  const token = first.read().captureToken;
  await first.update(s => { s.candidates.push({id: 'c1', url: 'https://example.com/a', text: 'A candidate long enough', author: 'T', topic: 'AI', status: 'new', createdAt: new Date().toISOString()}); });
  const reopened = await new SqliteStore(db, path.join(path.dirname(db), "state.json")).init();
  assert.equal(reopened.read().candidates.length, 1);
  assert.equal(reopened.read().captureToken, token, 'The capture token must be stable across restarts.');
  // Migration must be idempotent on an existing database.
  await reopened.migrate();
  assert.equal(reopened.get('SELECT version FROM schema_meta WHERE id=1').version, SCHEMA_DB_VERSION);
  await fs.rm(path.dirname(db), {recursive: true, force: true});
});

test('a newer legacy JSON export is imported, and an older one is ignored', async () => {
  const {dir, db, legacy} = await sandbox();
  const fresh = await new SqliteStore(db, legacy).init();
  assert.equal(fresh.read().candidates.length, 0);
  const backup = {version: 2, settings: {topics: ['AI'], style: '', opinions: '', minDelay: 0, maxDelay: 1}, captureToken: 'legacy-token',
    groups: [{id: 'g1', name: 'Legacy', bots: []}], candidates: [{id: 'c1', url: 'https://example.com/a', author: 'A', topic: 'AI', text: 'hello world this is text', status: 'new'}], drafts: [], runs: [], events: []};
  await fs.writeFile(legacy, JSON.stringify(backup));
  const imported = await new SqliteStore(db, legacy).init();
  assert.equal(imported.read().candidates.length, 1, 'The newer legacy document must be imported.');
  assert.equal(imported.read().captureToken, 'legacy-token');
  assert.equal(imported.read().groups[0].id, 'g1');
  // Restarting again without touching the file must not re-import or duplicate.
  const again = await new SqliteStore(db, legacy).init();
  assert.equal(again.read().candidates.length, 1);
  assert.equal(again.read().groups.length, 1);
  await fs.rm(dir, {recursive: true, force: true});
});

test('a corrupt legacy JSON file is quarantined instead of crash-looping the boot', async () => {
  const {dir, db, legacy} = await sandbox();
  await fs.writeFile(legacy, '{not json');
  const store = await new SqliteStore(db, legacy).init();
  assert.ok(store.recoveredFrom?.startsWith(legacy), 'The bad file must be moved aside.');
  await fs.access(store.recoveredFrom);
  assert.equal(store.read().candidates.length, 0);
  assert.ok(store.read().groups.length, 'A working state must still be created.');
  await fs.rm(dir, {recursive: true, force: true});
});

test('update() is serialized and a throwing transition leaves the previous state intact', async () => {
  const {db} = await sandbox();
  const store = await new SqliteStore(db, path.join(path.dirname(db), "state.json")).init();
  await store.update(s => { s.events.push({id: 'e1', type: 'test', message: 'first', at: new Date().toISOString(), meta: {}}); });
  await assert.rejects(() => store.update(s => { s.events.push({id: 'e2', type: 'test', message: 'second', at: new Date().toISOString(), meta: {}}); throw Object.assign(new Error('nope'), {status: 409}); }));
  assert.equal(store.read().events.length, 1, 'A failed transition must not persist.');
  // A later update still works after a rejected one (serial queue must recover).
  await store.update(s => { s.events.push({id: 'e3', type: 'test', message: 'third', at: new Date().toISOString(), meta: {}}); });
  assert.equal(store.read().events.length, 2);
  const reopened = await new SqliteStore(db, path.join(path.dirname(db), "state.json")).init();
  assert.equal(reopened.read().events.length, 2);
  await fs.rm(path.dirname(db), {recursive: true, force: true});
});

test('the store exposes the target-schema tables the roadmap phases need', async () => {
  const {db} = await sandbox();
  const store = await new SqliteStore(db, path.join(path.dirname(db), "state.json")).init();
  for (const table of ['users', 'sessions', 'workspaces', 'workspace_members', 'agents', 'agent_tasks', 'credentials', 'notifications', 'jobs', 'tasks', 'evidence', 'pairing_codes', 'password_resets']) {
    assert.equal(store.get(`SELECT count(*) AS n FROM ${table}`).n, 0, `${table} must exist and be empty.`);
  }
  await fs.rm(path.dirname(db), {recursive: true, force: true});
});

test('every workflow record survives a restart with the same shape, and writes keep working', async () => {
  const {dir, db, legacy} = await sandbox();
  const at = '2026-01-01T00:00:00.000Z';
  const first = await new SqliteStore(db, legacy).init();
  await first.update(s => {
    s.candidates.push({id: 'c1', url: 'https://example.com/a', text: 'A candidate long enough', author: 'T', topic: 'AI', status: 'drafted', demo: false, score: {total: 80, reasons: ['topic']}, createdAt: at});
    s.drafts.push({id: 'd1', candidateId: 'c1', author: 'T', url: 'https://example.com/a', sourceText: 'A candidate long enough', text: 'Reply', revision: 2, status: 'scheduled', score: 80, mode: 'template', note: 'n', approvedText: 'Reply', approvedRevision: 2, approvedAt: at, dueAt: at, createdAt: at});
    s.runs.push({id: 'r1', botId: 'writer', botName: 'Writer', input: 'in', output: 'out', at});
    s.groupRuns.push({id: 'g1', groupId: 'x-engage', input: 'hi', recipients: ['scout', 'writer'], mode: 'pipeline', status: 'awaiting_checkpoint', currentStep: 1, createdAt: at, startedAt: at, trace: [{botId: 'scout', output: 'o', toBotId: 'writer', at}], lastOutput: null, checkpointsEnabled: true, checkpoint: {nextStep: 1, previous: {botId: 'scout', output: 'o'}, at}});
    s.groupMessages['x-engage'] = [{id: 'm1', runId: 'g1', role: 'bot', senderId: 'scout', senderName: 'Scout', toBotId: 'writer', text: 'o', at}];
    s.tasks.push({id: 't1', kind: 'reminder', title: 'Check drafts', payload: {label: 'Check drafts', kind: 'interval', intervalMinutes: 60}, status: 'queued', runAt: at, intervalMinutes: 60, idempotencyKey: null, attempts: 0, maxAttempts: 5, leaseOwner: null, leaseUntil: null, lastError: null, result: null, createdBy: null, createdAt: at, updatedAt: at, completedAt: null});
    s.chats = {writer: [{id: 'k1', role: 'user', text: 'make it shorter', at}, {id: 'k2', role: 'bot', text: 'Done.', at, mode: 'ai'}]};
  });
  const before = first.read();
  first.db.close();
  const reopened = await new SqliteStore(db, legacy).init();
  const after = reopened.read();
  for (const key of ['candidates', 'drafts', 'runs', 'groupRuns', 'groupMessages', 'tasks', 'chats']) assert.deepEqual(after[key], before[key], `${key} changed shape across a restart.`);
  assert.equal(after.groupRuns[0].checkpointsEnabled, true, 'A paused run must still be gated after a restart.');
  await reopened.update(s => { s.drafts[0].text = 'Edited'; });
  assert.equal(reopened.read().drafts[0].text, 'Edited', 'Writes must keep working after a restart.');
  await fs.rm(dir, {recursive: true, force: true});
});

test('rows written before the document column are read back in the workflow shape', async () => {
  const {dir, db, legacy} = await sandbox();
  const store = await new SqliteStore(db, legacy).init();
  const at = '2026-01-01T00:00:00.000Z';
  store.run('INSERT INTO candidates (id,url,author,topic,text,status,score,demo,created_at) VALUES (?,?,?,?,?,?,?,?,?)', 'c1', 'https://example.com/a', 'T', 'AI', 'A candidate long enough', 'drafted', '{"total":80}', 0, at);
  store.run('INSERT INTO drafts (id,candidate_id,author,url,source_text,text,revision,status,created_at) VALUES (?,?,?,?,?,?,?,?,?)', 'd1', 'c1', 'T', 'https://example.com/a', 'src', 'Reply', 1, 'pending', at);
  store.run('INSERT INTO group_runs (id,group_id,input,recipients,mode,status,created_at,checkpoint) VALUES (?,?,?,?,?,?,?,?)', 'g1', 'x-engage', 'hi', '["scout"]', 'direct', 'completed', at, '{"nextStep":1}');
  store.run('INSERT INTO group_messages (id,group_id,run_id,role,sender_id,text,at) VALUES (?,?,?,?,?,?,?)', 'm1', 'x-engage', 'g1', 'bot', 'scout', 'o', at);
  store.db.close();
  const s = (await new SqliteStore(db, legacy).init()).read();
  assert.deepEqual(s.drafts[0], {id: 'd1', candidateId: 'c1', author: 'T', url: 'https://example.com/a', sourceText: 'src', text: 'Reply', revision: 1, status: 'pending', createdAt: at});
  assert.deepEqual(s.candidates[0].score, {total: 80});
  assert.equal(s.candidates[0].demo, false);
  assert.equal(s.groupRuns[0].groupId, 'x-engage');
  assert.deepEqual(s.groupRuns[0].checkpoint, {nextStep: 1});
  assert.deepEqual(s.groupMessages['x-engage'][0], {id: 'm1', runId: 'g1', role: 'bot', senderId: 'scout', text: 'o', at});
  await fs.rm(dir, {recursive: true, force: true});
});
