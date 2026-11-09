/** What a restore must refuse before it writes a single row.
 *
 * A backup is a file an operator moves between installations, so it is the one
 * document the server reads that no route guard has already shaped. Two shapes
 * it can arrive in look valid and are not:
 *  - memberships that point at a workspace the document does not name. The check
 *    for that used to be conditional on the document naming *some* workspace, so
 *    the file that had lost them all was the one file that skipped it.
 *  - account rows (a delivery opt-in, a notification, a paired device) with no
 *    `users`/`workspaces` behind them: those tables live in the first workspace's
 *    database, so such a document was exported from another workspace. Restoring
 *    it deletes every account row on the way in and inserts none.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {DEFAULT_WORKSPACE} from '../src/auth.js';
import * as backup from '../src/backup.js';
import * as wf from '../shared/workflow.js';

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'backup-validate-'));

/** A document's checksum covers its tables, so any hand edit has to re-seal it
 * or the checksum refusal fires first and the shape check is never reached. */
function reseal(document) {
  document.checksum = crypto.createHash('sha256').update(JSON.stringify(document.tables)).digest('hex');
  return document;
}

async function exported() {
  const dir = await temp();
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  await store.update(s => wf.migrate(s));
  const now = new Date().toISOString();
  store.run('INSERT INTO users (id,email,password_hash,created_at) VALUES (?,?,?,?)', 'user-1', 'owner@example.com', 'redacted', now);
  store.run('INSERT INTO workspaces (id,name,created_at) VALUES (?,?,?)', DEFAULT_WORKSPACE, 'Primary workspace', now);
  store.run('INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)', DEFAULT_WORKSPACE, 'user-1', 'owner', now);
  store.run('INSERT INTO notification_prefs (user_id,email,webhook,updated_at) VALUES (?,?,?,?)', 'user-1', 'owner@example.com', 0, now);
  return {dir, store, document: backup.exportBackup(store)};
}

test('a membership row that points nowhere is refused even when the document names no workspace', async () => {
  const {dir, store, document: original} = await exported();
  try {
    const document = JSON.parse(JSON.stringify(original));
    document.tables.workspaces = [];
    document.tables.workspace_members = [{workspace_id: 'ghost-workspace', user_id: 'user-1', role: 'owner'}];
    assert.throws(() => backup.validateBackup(reseal(document)), /unknown workspace/);
  } finally { await store.close(); await fs.rm(dir, {recursive: true, force: true}); }
});

test('account rows with no accounts are refused for the first workspace, and allowed for a secondary one', async () => {
  const {dir, store, document: original} = await exported();
  try {
    const document = JSON.parse(JSON.stringify(original));
    // What a backup of a secondary workspace looks like: the account tables are
    // in the first workspace's database, so they export empty - but its
    // notification rows come from its own file.
    document.tables.users = [];
    assert.ok(document.tables.notification_prefs.length, 'the fixture carries an opt-in');
    assert.throws(() => backup.validateBackup(reseal(document), {primaryWorkspace: true}), /no users/);
    // Restoring it into a secondary workspace is a legitimate move: that
    // workspace's account tables are empty already, so nothing is deleted.
    assert.doesNotThrow(() => backup.validateBackup(document, {primaryWorkspace: false}));
    // A device is the same mistake with a credential attached.
    const device = JSON.parse(JSON.stringify(original));
    device.tables.users = [];
    device.tables.notification_prefs = [];
    device.tables.agents = [{id: 'agent-1', workspace_id: DEFAULT_WORKSPACE, name: 'Device', secret_hash: 'redacted', secret_enc: null, permissions: '[]', paired_at: '2026-01-01T00:00:00.000Z'}];
    assert.throws(() => backup.validateBackup(reseal(device), {primaryWorkspace: true}), /no users/);
    assert.doesNotThrow(() => backup.validateBackup(device, {primaryWorkspace: false}), 'a device belongs to a secondary workspace too');
  } finally { await store.close(); await fs.rm(dir, {recursive: true, force: true}); }
});

test('the document the exporter writes still validates', async () => {
  const {dir, store, document} = await exported();
  try {
    assert.doesNotThrow(() => backup.validateBackup(document, {primaryWorkspace: true}));
  } finally { await store.close(); await fs.rm(dir, {recursive: true, force: true}); }
});
