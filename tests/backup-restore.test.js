/** Backup document contents and the restore reconciliation they trigger.
 *
 * Two guarantees are load-bearing and covered here:
 *  - a backup carries no usable password: `users.password_hash` is a
 *    placeholder, so a restore cannot hand an attacker an offline cracking
 *    target, and the accounts must be reset before anyone signs in;
 *  - `workspaces.sync()` (what the restore route calls afterwards) refuses to
 *    delete a workspace the caller did not name, because restoring an older
 *    backup would otherwise quietly destroy every workspace created since.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {openWorkspaces, workspaceDbPath} from '../src/workspaces.js';
import {Auth, DEFAULT_WORKSPACE} from '../src/auth.js';
import * as backup from '../src/backup.js';
import * as wf from '../shared/workflow.js';

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'backup-restore-'));
const exists = async file => { try { await fs.access(file); return true; } catch { return false; } };

test('a backup carries no usable password and a restore keeps the accounts but drops the hash', async () => {
  const dir = await temp();
  try {
    const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
    await store.update(s => wf.migrate(s));
    const now = new Date().toISOString();
    store.run('INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)', 'user-1', 'owner@example.com', 'scrypt$16384$c2FsdA$aGFzaA', now);
    store.run('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)', DEFAULT_WORKSPACE, 'Main', now);
    store.run('INSERT INTO agents (id,workspace_id,name,secret_hash,permissions,paired_at) VALUES (?,?,?,?,?,?)', 'agent-1', DEFAULT_WORKSPACE, 'Device', 'have$hash', '[]', now);

    const document = backup.exportBackup(store);
    const [user] = document.tables.users;
    assert.equal(user.email, 'owner@example.com', 'the account is carried so memberships still resolve');
    assert.equal(user.password_hash, 'redacted', 'the hash does not travel');
    assert.doesNotMatch(user.password_hash, /^scrypt\$/, 'what travels is not a password hash at all');
    const [agent] = document.tables.agents;
    assert.equal(agent.secret_enc, null, 'device secrets are dropped');
    assert.equal(agent.secret_hash, 'redacted');
    assert.equal(document.tables.sessions, undefined, 'live sessions are never exported');

    // The document is self-consistent: the checksum covers the redacted rows, so
    // the file it writes is the file it restores.
    const restored = await new SqliteStore(path.join(dir, 'restored.db'), path.join(dir, 'restored.json')).init();
    const result = backup.importBackup(restored, JSON.parse(JSON.stringify(document)), {force: true, primaryWorkspace: true});
    assert.ok(result.restored > 0);
    const row = restored.get('SELECT password_hash FROM users WHERE id=?', 'user-1');
    assert.equal(row.password_hash, 'redacted', 'a restored account must be reset before it can sign in');
    // Even the exact stored string cannot sign in: the placeholder is refused.
    const attempt = new Auth(restored).login({email: 'owner@example.com', password: 'scrypt$16384$c2FsdA$aGFzaA'});
    assert.equal(attempt.ok, false);
    assert.equal(attempt.status, 401);
    assert.equal(restored.get('SELECT count(*) AS n FROM agents').n, 1, 'the device row survives so it can be re-paired');
    await store.close();
    await restored.close();
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('sync refuses to delete a workspace the restore did not name', async () => {
  const dir = await temp();
  const primaryFile = path.join(dir, 'state.db');
  const primary = await new SqliteStore(primaryFile, path.join(dir, 'state.json')).init();
  const ids = [DEFAULT_WORKSPACE, 'client'];
  const start = () => { const stop = async () => {}; stop.ready = Promise.resolve(); return stop; };
  const workspaces = await openWorkspaces(primary, {workspaceIds: () => [...ids]}, start);
  try {
    const clientFiles = ['', '-wal', '-shm'].map(suffix => workspaceDbPath(primary.dbPath, 'client') + suffix);
    assert.ok(await exists(clientFiles[0]), 'the second workspace has a database on disk');

    // The restore replaced the account rows with an older set that never knew
    // about `client`. Nothing may be deleted until the caller names it.
    ids.length = 0;
    ids.push(DEFAULT_WORKSPACE);
    await assert.rejects(workspaces.sync(), error => {
      assert.equal(error.status, 409, 'a restore that would delete a workspace is a conflict, not a silent success');
      assert.match(error.message, /client/);
      assert.deepEqual(error.workspaces, ['client']);
      return true;
    });
    assert.deepEqual(workspaces.all().map(w => w.id), [DEFAULT_WORKSPACE, 'client'], 'nothing was discarded');
    for (const file of clientFiles) assert.ok(await exists(file), `still on disk: ${path.basename(file)}`);
    assert.ok(workspaces.get('client').read().groups.length, 'and still readable');

    // Named explicitly, the deletion proceeds — that is the operator's call.
    await workspaces.sync({discard: ['client']});
    assert.equal(workspaces.get('client'), null);
    for (const file of clientFiles) assert.equal(await exists(file), false, `removed: ${path.basename(file)}`);

    // A workspace the restored rows list but that is not open yet is loaded.
    ids.push('client', 'newcomer');
    await workspaces.sync();
    assert.ok(workspaces.get('newcomer'), 'a workspace added by the restore starts');
  } finally {
    await workspaces.stop();
    for (const {store} of workspaces.all()) await store.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('a backup whose JSON column cannot be parsed is refused before anything is written', async () => {
  const dir = await temp();
  try {
    const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
    store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
    await store.update(s => {
      wf.migrate(s);
      s.events.unshift({id: 'e-kept', type: 'task', message: 'Kept', meta: {note: 'fine'}, createdAt: new Date().toISOString()});
      s.runs.unshift({id: 'r-kept', botId: 'atlas', botName: 'Atlas', input: 'in', output: 'Original run', at: new Date().toISOString()});
    });
    const document = JSON.parse(JSON.stringify(backup.exportBackup(store)));
    // `validateBackup` parsed a fixed list of JSON columns; `events.meta` was not
    // one of them. The import transaction therefore committed, then the cache
    // rebuild threw a raw SyntaxError: the operator saw a 500 that said nothing
    // had happened, the restore route skipped its bookkeeping, and the next
    // unrelated write re-saved the empty document over the restore.
    const row = document.tables.events.find(event => event.id === 'e-kept');
    assert.ok(row, 'the exported backup holds the seeded event');
    row.meta = '{not json';
    const crypto = await import('node:crypto');
    document.checksum = crypto.createHash('sha256').update(JSON.stringify(document.tables)).digest('hex');

    const restored = await new SqliteStore(path.join(dir, 'restored.db'), path.join(dir, 'restored.json')).init();
    // Something of its own already in the target, so "the document survived" is
    // observable: a committed-then-thrown import would have written the backup
    // rows and, after the cache rebuild failed, left the target's document empty.
    await restored.update(s => s.runs.unshift({id: 'r-target', botId: 'atlas', botName: 'Atlas', input: 'in', output: 'Target run', at: new Date().toISOString()}));
    await assert.rejects(
      async () => backup.importBackup(restored, document, {force: true, primaryWorkspace: true}),
      error => /events.*meta|JSON/i.test(String(error.message)));

    // Nothing was written: the live document still holds the row the broken backup
    // would have replaced it with.
    await restored.update(s => s);
    assert.ok(restored.read().runs.some(r => r.id === 'r-target'), 'a refused import must not leave an empty document behind');
    assert.ok(!restored.read().runs.some(r => r.id === 'r-kept'), 'and must not have written the backup either');
    assert.ok(store.read().runs.some(r => r.id === 'r-kept'), 'the source installation is untouched');
    await store.close?.(); await restored.close?.();
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('a backup from before X was removed still restores', async () => {
  const dir = await temp();
  try {
    const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
    store.run('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)', DEFAULT_WORKSPACE, 'Main', new Date().toISOString());
    const document = JSON.parse(JSON.stringify(backup.exportBackup(store)));
    // An older file lists the X tables, with rows, and settings with X columns.
    document.tables.candidates = [{id: 'c1', url: 'https://x.com/a/status/1', author: 'A', topic: '', text: 'A captured post', status: 'new', score: null, demo: 0, created_at: '2026-01-01T00:00:00.000Z', doc: null}];
    document.tables.drafts = [{id: 'd1', candidate_id: 'c1', text: 'Draft', status: 'pending', created_at: '2026-01-01T00:00:00.000Z', doc: null}];
    document.tables.evidence = [{id: 'e1', draft_id: 'd1', claim: 'claim', link: 'https://example.com', created_at: '2026-01-01T00:00:00.000Z'}];
    document.tables.settings = [{id: 1, topics: '["AI"]', style: 's', opinions: '', min_delay: 2, max_delay: 10, retention: null}];
    document.checksum = (await import('node:crypto')).createHash('sha256').update(JSON.stringify(document.tables)).digest('hex');
    assert.ok(backup.validateBackup(document));
    const restored = await new SqliteStore(path.join(dir, 'restored.db'), path.join(dir, 'restored.json')).init();
    backup.importBackup(restored, document, {force: true, primaryWorkspace: true});
    assert.deepEqual(restored.read().groups.map(g => g.id), store.read().groups.map(g => g.id), 'the other tables come back');
    assert.equal('candidates' in restored.read(), false, 'the X rows are ignored');
    await store.close();
    await restored.close();
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
