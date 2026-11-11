/** Workspace backup export/import.
 *
 * An export is a single JSON document containing the workflow state plus the
 * relational surfaces (users, agents, agent tasks, jobs, notifications) so an
 * operator can move or archive an installation. The file itself is not
 * encrypted — protect it like the database. It deliberately EXCLUDES
 * credential ciphertext and session secrets, and every secret-shaped value it
 * does carry is replaced with a placeholder: a restored installation re-enters
 * its credentials, pairs its devices again, and everyone signs in again.
 *
 * One consequence, stated plainly: `users.password_hash` is exported as a
 * placeholder, so after a restore no account can sign in until its password is
 * reset. The console token printed by POST /api/auth/forgot is the way back in
 * (see `console.log` in src/routes-public.js); it is a recovery step, not an
 * automatic one, and it is the price of a backup that does not carry an offline
 * cracking target.
 *
 * Import refuses a live database unless `--force`/`{force:true}` is given,
 * because restoring blindly would drop the current workspace. The document is
 * validated before anything is written, so a truncated or tampered file fails
 * before touching the store.
 */
import crypto from 'node:crypto';
import {fail} from '../shared/errors.js';
import * as wf from '../shared/workflow.js';
import {initialState} from '../shared/core.js';
import {DEFAULT_WORKSPACE, ROLES} from './auth.js';
import {readDocuments, readMemory, readAsks} from './sqlite-store.js';
import {GRANT_CHOICES, isAskAction} from '../shared/asks.js';
import {INTERRUPT_STATUSES} from '../shared/coordination.js';
import {validWorkspaceId} from './workspaces.js';

export const BACKUP_VERSION = 1;

export {fail};

const EXPORT_TABLES = ['users', 'password_resets', 'workspaces', 'workspace_members', 'agents', 'agent_tasks', 'jobs', 'notifications', 'notification_prefs', 'settings', 'tasks', 'groups', 'bots', 'runs', 'events', 'group_runs', 'group_messages'];
// Added after the first backups were written: exported when present, and an
// older file that lacks them still restores.
const OPTIONAL_TABLES = ['chat_messages', 'memory', 'asks', 'grants', 'activity'];
// X-engage's tables, dropped at schema v11. A backup written before then lists
// them; it still restores, and their rows are ignored.
const RETIRED_TABLES = ['candidates', 'drafts', 'evidence'];
// Never exported, by design: credential ciphertext cannot be decrypted under a
// different key, pairing codes are single-use, and a live session id is a
// credential an attacker holding a backup must not obtain.
const EXCLUDED_TABLES = ['credentials', 'pairing_codes', 'sessions', 'kv', 'schema_meta'];
// Not a device credential. agents.secret_hash cannot be SQL NULL (the column
// is NOT NULL), and a backup must still restore the agent row.
const REDACTED_AGENT_HASH = 'redacted';
// A password hash is an offline cracking target, not data an operator needs
// back: `verifyPassword` refuses anything that is not `scrypt$...`, so the
// placeholder can never authenticate and the account resets after a restore
// (see the module header).
const REDACTED_PASSWORD_HASH = 'redacted';
// `notification_prefs.webhook_url` and a notification task's `target` hold a
// credential *id* (or an email address), not the webhook URL: the URL itself
// lives in `credentials`, which is excluded above. They are exported unredacted
// on purpose — a restored delivery task needs its reference — and redacting them
// would only break retries. If a future column ever holds the URL itself, it
// belongs in the vault, not here.

/** Browser-request cards live in kv, which backups exclude. A restored
 * awaiting_browser run would 409 the group with no card to finish it. */
function interruptRestoredRun(row) {
  if (!row || typeof row !== 'object') return row;
  let doc = null;
  if (typeof row.doc === 'string' && row.doc) doc = JSON.parse(row.doc);
  // `doc` is authoritative when present because readDocuments loads it instead
  // of rebuilding status from the SQL columns. Keep both representations in
  // sync before deciding whether the restored run is still live.
  const status = typeof doc?.status === 'string' ? doc.status : row.status;
  const next = {...row, status};
  if (!INTERRUPT_STATUSES.includes(status)) {
    if (doc && typeof row.doc === 'string') next.doc = JSON.stringify({...doc, status});
    return next;
  }
  const page = status === 'awaiting_browser';
  const error = page ? 'Restored from backup while waiting for a page. Ask again.' : 'Restored from backup before the run completed. Retry explicitly.';
  next.status = 'interrupted';
  next.error = error;
  if (doc && typeof row.doc === 'string') next.doc = JSON.stringify({...doc, status: 'interrupted', error});
  return next;
}

/** Build the export document from an open store. */
export function exportBackup(store) {
  const tables = {};
  for (const name of [...EXPORT_TABLES, ...OPTIONAL_TABLES]) {
    try { tables[name] = store.all(`SELECT * FROM ${name}`); }
    catch (e) {
      // An older schema may lack a table. Any other read failure must not
      // become a valid backup of an empty table: restoring that would wipe
      // the live rows.
      if (!/no such table/i.test(String(e?.message || ''))) throw e;
      tables[name] = [];
    }
  }
  // Agent secret ciphertext is bound to this install's master key and would
  // reconstitute usable device credentials if restored. Blank it before
  // checksumming. secret_hash is NOT NULL, so SQL NULL would make any backup
  // that contains an agent fail on restore; a placeholder is not a credential.
  tables.agents = (tables.agents || []).map(a => ({...a, secret_enc: null, secret_hash: REDACTED_AGENT_HASH}));
  // Same reasoning for sign-in passwords, and the header above claims secrets
  // do not travel. password_hash is NOT NULL, so a placeholder replaces it.
  tables.users = (tables.users || []).map(u => ({...u, password_hash: REDACTED_PASSWORD_HASH}));
  const checksum = crypto.createHash('sha256').update(JSON.stringify(tables)).digest('hex');
  return {
    backupVersion: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    schemaVersion: store.get('SELECT version FROM schema_meta WHERE id=1')?.version ?? null,
    excluded: EXCLUDED_TABLES,
    checksum,
    tables,
  };
}

/** Validate an untrusted backup document without writing anything. */
export function validateBackup(document, {primaryWorkspace = false} = {}) {
  if (!document || typeof document !== 'object') fail('Backup is not a JSON object.');
  if (document.backupVersion !== BACKUP_VERSION) fail(`Unsupported backup version ${String(document.backupVersion).slice(0, 20)}.`);
  if (!document.tables || typeof document.tables !== 'object') fail('Backup has no tables.');
  for (const name of EXPORT_TABLES) {
    if (!Array.isArray(document.tables[name])) fail(`Backup is missing the "${name}" table.`);
  }
  for (const name of OPTIONAL_TABLES) {
    if (document.tables[name] !== undefined && !Array.isArray(document.tables[name])) fail(`Backup table "${name}" is not a list.`);
  }
  const workspaceIds = new Set();
  for (const row of document.tables.workspaces) {
    if (!row || !validWorkspaceId(row.id)) fail('Backup holds a workspace id that is not usable as a file name.');
    if (workspaceIds.has(row.id)) fail('Backup holds duplicate workspace ids.');
    workspaceIds.add(row.id);
  }
  if (primaryWorkspace && !workspaceIds.has(DEFAULT_WORKSPACE)) fail('Backup is missing the primary workspace.');
  // Recompute the checksum so a hand-edited or truncated file is rejected. A
  // missing checksum is itself a failure: otherwise stripping the field would
  // let a tampered file through.
  const actual = crypto.createHash('sha256').update(JSON.stringify(document.tables)).digest('hex');
  if (!document.checksum) fail('Backup is missing its checksum, so it cannot be trusted.');
  if (document.checksum !== actual) fail('Backup checksum does not match its contents. The file may be corrupt or edited.');
  // Roles are the known ones, and every link the UI will render is http(s):
  // the normal write paths enforce both, so a restore must not be a way round.
  for (const m of document.tables.workspace_members) {
    if (!m || !ROLES.includes(m.role)) fail('Backup holds an unknown role.');
    // Unconditional: guarding this on "the document names any workspace at all"
    // accepted exactly the document that lost them, a membership row pointing at
    // a workspace the restore would not create.
    if (!workspaceIds.has(m.workspace_id)) fail('Backup membership references an unknown workspace.');
  }
  // A restore of the first workspace replaces the account tables, so a document
  // that carries account-owned rows (a notification, an opt-in, a paired device)
  // while its `users` table is empty would delete every account and insert none
  // - a successful-looking restore of an installation with no users. Such a
  // document was exported from a secondary workspace, whose file holds those
  // rows but not the accounts; restoring it into a secondary workspace is fine,
  // because its account tables were empty already.
  const accountScoped = ['notification_prefs', 'notifications', 'agents'].filter(name => (document.tables[name] || []).length);
  if (primaryWorkspace && accountScoped.length && !document.tables.users.length) {
    fail(`Backup carries ${accountScoped.join(', ')} but no users: it was exported from a workspace other than the first one, which is the only one that holds the accounts. Export the first workspace instead.`);
  }
  // The SQL reader parses these columns after commit. Reject malformed JSON
  // and wrong shapes before import so a bad settings value cannot poison the
  // workspace cache or make the next startup fail.
  const jsonShape = (table, column, accepts, expected) => {
    for (const row of document.tables[table] || []) {
      const value = row?.[column];
      if (value == null || value === '') continue;
      let parsed;
      try { if (typeof value !== 'string') throw new Error(); parsed = JSON.parse(value); }
      catch { fail(`Backup row ${row?.id ?? '?'} in ${table} has invalid ${column} JSON.`); }
      if (!accepts(parsed)) fail(`Backup row ${row?.id ?? '?'} in ${table} has invalid ${column} JSON (expected ${expected}).`);
    }
  };
  const object = value => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  jsonShape('groups', 'settings', object, 'an object');
  jsonShape('bots', 'settings', object, 'an object');
  jsonShape('bots', 'contract', object, 'an object');
  jsonShape('bots', 'permissions', Array.isArray, 'a list');
  jsonShape('group_runs', 'doc', object, 'an object');
  // Everything else the row readers parse with no fallback. The import commits
  // before the cache is rebuilt, so a malformed `events.meta` used to restore
  // fine, throw a 500 on the read-back (the restore was already durable), and
  // then let the next unrelated write replace every table from an empty
  // document - the restore was silently wiped by the first chat message after it.
  jsonShape('events', 'meta', object, 'an object');
  jsonShape('tasks', 'payload', object, 'an object');
  jsonShape('tasks', 'result', () => true, 'JSON');
  jsonShape('bots', 'created_by', object, 'an object');
  jsonShape('chat_messages', 'doc', object, 'an object');
  for (const name of ['runs', 'group_runs', 'group_messages']) jsonShape(name, 'doc', object, 'an object');
  // A forgotten chat's row is the moment it was forgotten, and older rows hold
  // `true`; only "is this JSON at all" is true of every kind of memory row.
  jsonShape('memory', 'doc', () => true, 'JSON');
  jsonShape('asks', 'doc', object, 'an object');
  // A grant is the owner's own word, so a restore cannot widen it: a choice that is not one of the
  // three, an action nobody asks about, or Always allow for a payment is refused before anything is written.
  // A grant for a bot that is not in the document is fine: it is ignored when the workspace loads.
  for (const row of document.tables.grants || []) {
    if (!row || typeof row.bot_id !== 'string' || !GRANT_CHOICES.includes(row.choice) || !isAskAction(row.action)) fail('Backup holds a grant that is not valid.');
    if (row.action === 'spend' && row.choice === 'always') fail('Backup holds Always allow for a payment (spend). Payments are asked every time, so it is refused.');
  }
  for (const row of document.tables.activity || []) {
    if (!row || !['outside', 'perm', 'bots'].includes(row.kind) || typeof row.text !== 'string') fail(`Backup row ${row?.id ?? '?'} in activity is not valid.`);
  }
  jsonShape('group_runs', 'recipients', Array.isArray, 'a list');
  jsonShape('group_runs', 'trace', () => true, 'JSON');
  jsonShape('group_runs', 'checkpoint', () => true, 'JSON');
  // The workflow document must survive a migration before being trusted.
  const tables = Object.fromEntries(Object.entries(document.tables).filter(([name]) => !RETIRED_TABLES.includes(name)));
  const state = tablesToState(tables);
  wf.migrate(state);
  return {tables, state};
}

/** Restore into an empty-ish database inside one transaction. */
export function importBackup(store, document, {force = false, primaryWorkspace = false} = {}) {
  const {tables, state} = validateBackup(document, {primaryWorkspace});
  const restoredAt = new Date().toISOString();
  // A freshly seeded database already contains the built-in group rows, so
  // "populated" means real content, not the defaults every install ships with.
  const CONTENT_TABLES = ['users', 'tasks', 'events', 'runs', 'agents', 'agent_tasks', 'jobs', 'notifications', 'group_runs', 'group_messages'];
  const populated = CONTENT_TABLES.some(name => {
    try { return store.get(`SELECT count(*) AS n FROM ${name}`).n > 0; } catch { return false; }
  });
  if (populated && !force) fail('This installation already holds workspace data. Restore with force=true to replace it (credentials are not carried by backups).', 409);
  store.transaction(() => {
    // Sessions are excluded from the export but they are not part of it to
    // restore: a cookie for a user id that reappears in the backup would come
    // back live. Everyone signs in again after a restore.
    store.run('DELETE FROM sessions');
    // Browser-request cards live in kv, which backups exclude. Drop ghosts
    // from the live database so a restore cannot show Approve for a run that
    // is no longer waiting.
    try { store.run("DELETE FROM kv WHERE key = 'browser_requests'"); } catch { /* Older schema. */ }
    // Pairing codes are excluded from backups. A pre-restore code must not
    // remain usable after restored agents have been revoked.
    store.run('DELETE FROM pairing_codes');
    for (const name of [...EXPORT_TABLES, ...OPTIONAL_TABLES]) {
      store.run(`DELETE FROM ${name}`);
      // Backups written before the placeholder stored SQL NULL in secret_hash,
      // which the column rejects. Fill that in after the checksum check so an
      // older file still validates, then restores.
      let rows = tables[name] || [];
      if (name === 'users') rows = rows.map(row => ({...row, password_hash: row.password_hash || REDACTED_PASSWORD_HASH}));
      if (name === 'agents') rows = rows.map(row => ({
        ...row,
        secret_hash: row.secret_hash || REDACTED_AGENT_HASH,
        secret_enc: null,
        status: 'revoked',
        revoked_at: row.revoked_at || restoredAt,
      }));
      if (name === 'agent_tasks') rows = rows.map(row => ['queued', 'running'].includes(row.status) ? {
        ...row,
        status: 'failed',
        error: 'Local-agent credentials are not included in backups. Pair an agent again before queuing work.',
        lease_until: null,
        updated_at: restoredAt,
        completed_at: restoredAt,
      } : row);
      if (name === 'group_runs') rows = rows.map(interruptRestoredRun);
      if (!rows.length) continue;
      // Column names go into the statement, so only the table's own are used.
      const known = new Set(store.all(`PRAGMA table_info(${name})`).map(c => c.name));
      const columns = Object.keys(rows[0]).filter(c => known.has(c));
      if (!columns.length) fail(`Backup table "${name}" has no usable columns.`);
      const placeholders = columns.map(() => '?').join(',');
      const statement = store.db.prepare(`INSERT INTO ${name} (${columns.join(',')}) VALUES (${placeholders})`);
      for (const row of rows) {
        try { statement.run(...columns.map(c => row[c] ?? null)); }
        // A clear failure beats "cannot be bound to parameter 6": the row id
        // and the offending column tell the operator which table is corrupt.
        catch (e) {
          const bad = columns.find(c => row[c] !== null && row[c] !== undefined && !['number', 'string', 'bigint'].includes(typeof row[c]));
          throw Object.assign(new Error(`Backup row ${row.id ?? '?'} in ${name} cannot be restored (column "${bad || '?'}" has an unusable value): ${e.message}`), {status: 400});
        }
      }
    }
  });
  // The store's in-memory document must agree with what was just written, so it
  // is read back through the store's own row readers, not assembled here.
  // The store remembers what it last wrote per table so an update touches only changed rows. A restore
  // wrote around that memory, so forget it: the next write reads what is really there, which is also
  // what deletes a restored row the loaded workspace chose to ignore (a grant for a bot that is gone).
  store.written?.clear?.();
  if (store.cache && typeof store.readCollections === 'function') store.cache = wf.migrate(store.readCollections());
  return {restored: [...EXPORT_TABLES, ...OPTIONAL_TABLES].reduce((n, name) => n + (tables[name]?.length || 0), 0)};
}

/** Rebuild a plain state document from exported tables (for preview/validate).
 * Rows are cloned: `migrate()` backfills bot contracts, and mutating the
 * exported rows would hand `importBackup` objects where SQL expects strings. */
export function tablesToState(tables) {
  const state = structuredClone(initialState());
  const s = state;
  s.settings = tables.settings?.[0]?.retention ? {retention: JSON.parse(tables.settings[0].retention)} : s.settings;
  s.groups = (tables.groups || []).map(g => ({...g, bots: (tables.bots || []).filter(b => b.group_id === g.id).map(b => ({...b}))}));
  Object.assign(s, readDocuments(name => tables[name] || []));
  s.events = (tables.events || []).map(e => ({...e}));
  s.tasks = (tables.tasks || []).map(t => ({...t, payload: JSON.parse(t.payload || '{}'), result: t.result ? JSON.parse(t.result) : null}));
  s.memory = readMemory(kind => (tables.memory || []).filter(row => row.kind === kind));
  Object.assign(s, readAsks(name => tables[name] || []));
  return s;
}
