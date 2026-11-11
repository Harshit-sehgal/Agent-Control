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
  const group = first.read().groups.find(g => g.id === 'home');
  assert.ok(group, 'The built-in Home group must exist on first boot.');
  assert.deepEqual(group.bots.map(b => b.id), ['atlas']);
  await first.update(s => { s.runs.push({id: 'r1', botId: 'atlas', botName: 'Atlas', input: 'in', output: 'out', at: new Date().toISOString()}); });
  const reopened = await new SqliteStore(db, path.join(path.dirname(db), "state.json")).init();
  assert.equal(reopened.read().runs.length, 1);
  // Migration must be idempotent on an existing database.
  await reopened.migrate();
  assert.equal(reopened.get('SELECT version FROM schema_meta WHERE id=1').version, SCHEMA_DB_VERSION);
  await fs.rm(path.dirname(db), {recursive: true, force: true});
});

test('a database written by a newer build is refused instead of silently accepted', async () => {
  const {dir, db, legacy} = await sandbox();
  const store = await new SqliteStore(db, legacy).init();
  store.run('UPDATE schema_meta SET version=? WHERE id=1', SCHEMA_DB_VERSION + 1);
  // Close the handle before reopening the same file.
  await store.close?.();
  await assert.rejects(() => new SqliteStore(db, legacy).init(), /newer version of this app/);
  await fs.rm(dir, {recursive: true, force: true});
});

test('a newer legacy JSON export is imported, and an older one is ignored', async () => {
  const {dir, db, legacy} = await sandbox();
  const fresh = await new SqliteStore(db, legacy).init();
  assert.equal(fresh.read().runs.length, 0);
  // The legacy export still carries the retired X engage records and settings.
  const backup = {version: 2, settings: {topics: ['AI'], style: '', opinions: '', minDelay: 0, maxDelay: 1},
    groups: [{id: 'g1', name: 'Legacy', bots: []}], candidates: [{id: 'c1', url: 'https://example.com/a', author: 'A', topic: 'AI', text: 'hello world this is text', status: 'new'}], drafts: [],
    runs: [{id: 'r1', botId: 'writer', botName: 'Writer', input: 'in', output: 'out', at: '2026-01-01T00:00:00.000Z'}], events: []};
  await fs.writeFile(legacy, JSON.stringify(backup));
  const imported = await new SqliteStore(db, legacy).init();
  assert.equal(imported.read().runs.length, 1, 'The newer legacy document must be imported.');
  assert.equal(imported.read().groups[0].id, 'g1');
  assert.equal('candidates' in imported.read(), false, 'The retired X candidates are dropped, not imported.');
  assert.equal('topics' in imported.read().settings, false, 'The retired X settings are dropped, not imported.');
  // Restarting again without touching the file must not re-import or duplicate.
  const again = await new SqliteStore(db, legacy).init();
  assert.equal(again.read().runs.length, 1);
  assert.equal(again.read().groups.length, 1);
  await fs.rm(dir, {recursive: true, force: true});
});

test('a corrupt legacy JSON file is quarantined instead of crash-looping the boot', async () => {
  const {dir, db, legacy} = await sandbox();
  await fs.writeFile(legacy, '{not json');
  const store = await new SqliteStore(db, legacy).init();
  assert.ok(store.recoveredFrom?.startsWith(legacy), 'The bad file must be moved aside.');
  await fs.access(store.recoveredFrom);
  assert.equal(store.read().runs.length, 0);
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
  for (const table of ['users', 'sessions', 'workspaces', 'workspace_members', 'agents', 'agent_tasks', 'credentials', 'notifications', 'jobs', 'tasks', 'pairing_codes', 'password_resets']) {
    assert.equal(store.get(`SELECT count(*) AS n FROM ${table}`).n, 0, `${table} must exist and be empty.`);
  }
  await fs.rm(path.dirname(db), {recursive: true, force: true});
});

test('every workflow record survives a restart with the same shape, and writes keep working', async () => {
  const {dir, db, legacy} = await sandbox();
  const at = '2026-01-01T00:00:00.000Z';
  const first = await new SqliteStore(db, legacy).init();
  await first.update(s => {
    s.runs.push({id: 'r1', botId: 'writer', botName: 'Writer', input: 'in', output: 'out', at});
    s.groupRuns.push({id: 'g1', groupId: 'x-engage', input: 'hi', recipients: ['scout', 'writer'], mode: 'pipeline', status: 'awaiting_checkpoint', currentStep: 1, createdAt: at, startedAt: at, trace: [{botId: 'scout', output: 'o', toBotId: 'writer', at}], lastOutput: null, checkpointsEnabled: true, checkpoint: {nextStep: 1, previous: {botId: 'scout', output: 'o'}, at}});
    s.groupMessages['x-engage'] = [{id: 'm1', runId: 'g1', role: 'bot', senderId: 'scout', senderName: 'Scout', toBotId: 'writer', text: 'o', at}];
    s.tasks.push({id: 't1', kind: 'bot-task', title: 'Check in', payload: {groupId: 'home', message: 'Check in', kind: 'interval', intervalMinutes: 60}, status: 'queued', runAt: at, intervalMinutes: 60, idempotencyKey: null, attempts: 0, maxAttempts: 5, leaseOwner: null, leaseUntil: null, lastError: null, result: null, createdBy: null, createdAt: at, updatedAt: at, completedAt: null});
    s.chats = {writer: [{id: 'k1', role: 'user', text: 'make it shorter', at}, {id: 'k2', role: 'bot', text: 'Done.', at, mode: 'ai'}]};
  });
  const before = first.read();
  first.db.close();
  const reopened = await new SqliteStore(db, legacy).init();
  const after = reopened.read();
  for (const key of ['runs', 'groupRuns', 'groupMessages', 'tasks', 'chats']) assert.deepEqual(after[key], before[key], `${key} changed shape across a restart.`);
  assert.equal(after.groupRuns[0].checkpointsEnabled, true, 'A paused run must still be gated after a restart.');
  await reopened.update(s => { s.tasks[0].title = 'Edited'; });
  assert.equal(reopened.read().tasks[0].title, 'Edited', 'Writes must keep working after a restart.');
  await fs.rm(dir, {recursive: true, force: true});
});

test('rows written before the document column are read back in the workflow shape', async () => {
  const {dir, db, legacy} = await sandbox();
  const store = await new SqliteStore(db, legacy).init();
  const at = '2026-01-01T00:00:00.000Z';
  store.run('INSERT INTO group_runs (id,group_id,input,recipients,mode,status,created_at,checkpoint) VALUES (?,?,?,?,?,?,?,?)', 'g1', 'x-engage', 'hi', '["scout"]', 'direct', 'completed', at, '{"nextStep":1}');
  store.run('INSERT INTO group_messages (id,group_id,run_id,role,sender_id,text,at) VALUES (?,?,?,?,?,?,?)', 'm1', 'x-engage', 'g1', 'bot', 'scout', 'o', at);
  store.db.close();
  const s = (await new SqliteStore(db, legacy).init()).read();
  assert.equal(s.groupRuns[0].groupId, 'x-engage');
  assert.deepEqual(s.groupRuns[0].checkpoint, {nextStep: 1});
  assert.deepEqual(s.groupMessages['x-engage'][0], {id: 'm1', runId: 'g1', role: 'bot', senderId: 'scout', text: 'o', at});
  await fs.rm(dir, {recursive: true, force: true});
});

test('workspace retention settings survive a restart', async () => {
  const {db} = await sandbox();
  const first = await new SqliteStore(db, path.join(path.dirname(db), 'state.json')).init();
  await first.update(s => { s.settings.retention = {events: 7, doneTasks: 3, runs: 14}; });
  first.db.close();
  const reopened = await new SqliteStore(db, path.join(path.dirname(db), 'state.json')).init();
  assert.deepEqual(reopened.read().settings.retention, {events: 7, doneTasks: 3, runs: 14});
  await fs.rm(path.dirname(db), {recursive: true, force: true});
});

test('a bot keeps how it came to exist, and an older database gains the columns', async () => {
  const at = '2026-01-01T00:00:00.000Z';
  const {dir, db, legacy} = await sandbox();
  const first = await new SqliteStore(db, legacy).init();
  await first.update(s => {
    const group = s.groups.find(g => g.id === 'home');
    group.bots.push({id: 'made', name: 'Helper', instructions: 'Find posts.', type: 'custom', permissions: [],
      origin: 'bot', createdBy: {botId: 'atlas', botName: 'Atlas', runId: 'r1', at}, createdAt: at});
  });
  first.db.close();
  const reopened = await new SqliteStore(db, legacy).init();
  const made = reopened.read().groups.find(g => g.id === 'home').bots.find(b => b.id === 'made');
  assert.equal(made.origin, 'bot');
  assert.deepEqual(made.createdBy, {botId: 'atlas', botName: 'Atlas', runId: 'r1', at});

  // A database written before v10 has neither column: the migration must add
  // them without dropping the bots already in it.
  reopened.db.exec('ALTER TABLE bots DROP COLUMN origin');
  reopened.db.exec('ALTER TABLE bots DROP COLUMN created_by');
  reopened.run('UPDATE schema_meta SET version=? WHERE id=1', 9);
  reopened.db.close();
  const upgraded = await new SqliteStore(db, legacy).init();
  assert.ok(upgraded.read().groups.find(g => g.id === 'home').bots.some(b => b.id === 'made'), 'The bot must survive the migration.');
  assert.equal(upgraded.get('SELECT version FROM schema_meta WHERE id=1').version, SCHEMA_DB_VERSION);
  await fs.rm(dir, {recursive: true, force: true});
});

test('a v10 database with X data upgrades to v11', async () => {
  const {dir, db, legacy} = await sandbox();
  const first = await new SqliteStore(db, legacy).init();
  first.db.close();
  // Rebuild what a v10 install held: the X tables, the settings X columns, a
  // capture token, and a reminder still waiting in the queue.
  const {DatabaseSync} = await import('node:sqlite');
  const raw = new DatabaseSync(db);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, url TEXT NOT NULL, author TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, status TEXT NOT NULL, score TEXT, demo INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, doc TEXT);
    CREATE TABLE IF NOT EXISTS drafts (id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, author TEXT NOT NULL, url TEXT NOT NULL, source_text TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL, score INTEGER, mode TEXT, note TEXT, approved_text TEXT, approved_revision INTEGER, approved_at TEXT, due_at TEXT, posted_at TEXT, created_at TEXT NOT NULL, doc TEXT);
    CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, draft_id TEXT, candidate_id TEXT, kind TEXT NOT NULL, link TEXT, claim TEXT NOT NULL, confidence REAL NOT NULL, verification TEXT NOT NULL, reuse TEXT NOT NULL, note TEXT, created_by TEXT, created_at TEXT NOT NULL);`);
  const has = raw.prepare('PRAGMA table_info(settings)').all().map(c => c.name);
  for (const [name, type] of [['topics', "TEXT NOT NULL DEFAULT '[]'"], ['style', "TEXT NOT NULL DEFAULT ''"], ['opinions', "TEXT NOT NULL DEFAULT ''"], ['min_delay', 'INTEGER NOT NULL DEFAULT 2'], ['max_delay', 'INTEGER NOT NULL DEFAULT 10']]) {
    if (!has.includes(name)) raw.exec(`ALTER TABLE settings ADD COLUMN ${name} ${type}`);
  }
  const at = '2026-01-01T00:00:00.000Z';
  raw.prepare("INSERT INTO candidates (id,url,author,text,status,created_at) VALUES ('c1','https://x.com/a/status/1','A','A captured post','new',?)").run(at);
  raw.prepare("INSERT INTO drafts (id,candidate_id,author,url,text,revision,status,created_at) VALUES ('d1','c1','A','https://x.com/a/status/1','Draft',1,'pending',?)").run(at);
  raw.prepare("INSERT INTO evidence (id,draft_id,kind,claim,confidence,verification,reuse,created_at) VALUES ('e1','d1','link','claim',1,'unverified','quote',?)").run(at);
  raw.prepare("INSERT OR REPLACE INTO kv (key,value) VALUES ('capture_token','secret-token')").run();
  raw.prepare("INSERT INTO tasks (id,kind,title,payload,status,run_at,created_at,updated_at) VALUES ('t1','reminder','Check','{}','queued',?,?,?)").run(at, at, at);
  raw.prepare("INSERT INTO tasks (id,kind,title,payload,status,run_at,created_at,updated_at) VALUES ('t2','candidate-draft','Draft','{}','done',?,?,?)").run(at, at, at);
  raw.prepare('UPDATE schema_meta SET version=10 WHERE id=1').run();
  raw.close();

  const upgraded = await new SqliteStore(db, legacy).init();
  try {
    assert.equal(upgraded.get('SELECT version FROM schema_meta WHERE id=1').version, 11);
    const tables = upgraded.all("SELECT name FROM sqlite_master WHERE type='table'").map(t => t.name);
    for (const gone of ['candidates', 'drafts', 'evidence']) assert.equal(tables.includes(gone), false, `${gone} is still a table`);
    const columns = upgraded.all('PRAGMA table_info(settings)').map(c => c.name);
    for (const gone of ['topics', 'style', 'opinions', 'min_delay', 'max_delay']) assert.equal(columns.includes(gone), false, `settings still has ${gone}`);
    assert.equal(upgraded.get("SELECT value FROM kv WHERE key='capture_token'"), undefined);
    assert.deepEqual(upgraded.read().groups.find(g => g.id === 'home').bots.map(b => b.id), ['atlas'], 'the bots are intact');
    assert.equal(upgraded.get("SELECT status FROM tasks WHERE id='t1'").status, 'cancelled', 'a queued reminder cannot run any more');
    assert.equal(upgraded.get("SELECT status FROM tasks WHERE id='t2'").status, 'done', 'finished history is left alone');
    const state = upgraded.read();
    for (const gone of ['candidates', 'drafts', 'evidence']) assert.equal(gone in state, false, `state still has ${gone}`);
    // And it keeps working: a write after the upgrade lands.
    await upgraded.update(s => { s.groups[0].name = 'Home base'; });
  } finally { upgraded.db.close(); await fs.rm(dir, {recursive: true, force: true}); }
});
