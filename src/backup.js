/** Encrypted-at-rest backup export/import.
 *
 * An export is a single JSON document containing the workflow state plus the
 * relational surfaces (users, sessions, agents, agent tasks, jobs,
 * notifications) so an operator can move or archive an installation. It
 * deliberately EXCLUDES credential ciphertext and session secrets: a restored
 * installation re-enters its credentials, and everyone signs in again.
 *
 * Import refuses a live database unless `--force`/`{force:true}` is given,
 * because restoring blindly would drop the current workspace. The document is
 * validated before anything is written, so a truncated or tampered file fails
 * before touching the store.
 */
import crypto from 'node:crypto';
import * as wf from '../shared/workflow.js';
import {initialState, validHttpUrl} from '../shared/core.js';
import {ROLES} from './auth.js';
import {readDocuments} from './sqlite-store.js';

export const BACKUP_VERSION = 1;

export function fail(message, status = 400) { throw Object.assign(new Error(message), {status}); }

const EXPORT_TABLES = ['users', 'password_resets', 'workspaces', 'workspace_members', 'agents', 'agent_tasks', 'jobs', 'notifications', 'notification_prefs', 'settings', 'tasks', 'groups', 'bots', 'candidates', 'drafts', 'evidence', 'runs', 'events', 'group_runs', 'group_messages'];
// Added after the first backups were written: exported when present, and an
// older file that lacks them still restores.
const OPTIONAL_TABLES = ['chat_messages'];
// Never exported, by design: credential ciphertext cannot be decrypted under a
// different key, pairing codes are single-use, and a live session id is a
// credential an attacker holding a backup must not obtain.
const EXCLUDED_TABLES = ['credentials', 'pairing_codes', 'sessions', 'kv', 'schema_meta'];

/** Build the export document from an open store. */
export function exportBackup(store) {
  const tables = {};
  for (const name of [...EXPORT_TABLES, ...OPTIONAL_TABLES]) {
    try { tables[name] = store.all(`SELECT * FROM ${name}`); }
    catch { /* Table absent in an older schema: exported as empty. */ tables[name] = []; }
  }
  // Agent secret ciphertext is bound to this install's master key and would
  // reconstitute usable device credentials if restored. The module's exclusion
  // of secrets applies to it too, so blank those columns before checksumming.
  tables.agents = (tables.agents || []).map(a => ({...a, secret_enc: null, secret_hash: null}));
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
export function validateBackup(document) {
  if (!document || typeof document !== 'object') fail('Backup is not a JSON object.');
  if (document.backupVersion !== BACKUP_VERSION) fail(`Unsupported backup version ${String(document.backupVersion).slice(0, 20)}.`);
  if (!document.tables || typeof document.tables !== 'object') fail('Backup has no tables.');
  for (const name of EXPORT_TABLES) {
    if (!Array.isArray(document.tables[name])) fail(`Backup is missing the "${name}" table.`);
  }
  for (const name of OPTIONAL_TABLES) {
    if (document.tables[name] !== undefined && !Array.isArray(document.tables[name])) fail(`Backup table "${name}" is not a list.`);
  }
  // Recompute the checksum so a hand-edited or truncated file is rejected. A
  // missing checksum is itself a failure: otherwise stripping the field would
  // let a tampered file through.
  const actual = crypto.createHash('sha256').update(JSON.stringify(document.tables)).digest('hex');
  if (!document.checksum) fail('Backup is missing its checksum, so it cannot be trusted.');
  if (document.checksum !== actual) fail('Backup checksum does not match its contents. The file may be corrupt or edited.');
  // Roles are the known ones, and every link the UI will render is http(s):
  // the normal write paths enforce both, so a restore must not be a way round.
  for (const m of document.tables.workspace_members) if (!ROLES.includes(m.role)) fail('Backup holds an unknown role.');
  const link = (value, where) => { if (value && !validHttpUrl(value)) fail(`Backup holds a link that is not http(s) in ${where}.`); };
  for (const e of document.tables.evidence) link(e.link, 'evidence');
  for (const name of ['candidates', 'drafts']) for (const row of document.tables[name]) {
    link(row.url, name);
    if (row.doc) { let doc; try { doc = JSON.parse(row.doc); } catch { fail(`Backup row in ${name} is not valid JSON.`); } link(doc?.url, name); }
  }
  // The workflow document must survive a migration before being trusted.
  const state = tablesToState(document.tables);
  wf.migrate(state);
  return {tables: document.tables, state};
}

/** Restore into an empty-ish database inside one transaction. */
export function importBackup(store, document, {force = false} = {}) {
  const {tables, state} = validateBackup(document);
  // A freshly seeded database already contains the built-in group rows, so
  // "populated" means real content, not the defaults every install ships with.
  const CONTENT_TABLES = ['users', 'candidates', 'drafts', 'tasks', 'events', 'runs', 'evidence', 'agents', 'agent_tasks', 'jobs', 'notifications', 'group_runs', 'group_messages'];
  const populated = CONTENT_TABLES.some(name => {
    try { return store.get(`SELECT count(*) AS n FROM ${name}`).n > 0; } catch { return false; }
  });
  if (populated && !force) fail('This installation already holds workspace data. Restore with force=true to replace it (credentials are not carried by backups).', 409);
  store.transaction(() => {
    // Sessions are excluded from the export but they are not part of it to
    // restore: a cookie for a user id that reappears in the backup would come
    // back live. Everyone signs in again after a restore.
    store.run('DELETE FROM sessions');
    for (const name of [...EXPORT_TABLES, ...OPTIONAL_TABLES]) {
      store.run(`DELETE FROM ${name}`);
      const rows = tables[name] || [];
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
  if (store.cache && typeof store.readCollections === 'function') store.cache = wf.migrate(store.readCollections());
  return {restored: [...EXPORT_TABLES, ...OPTIONAL_TABLES].reduce((n, name) => n + (tables[name]?.length || 0), 0)};
}

/** Rebuild a plain state document from exported tables (for preview/validate).
 * Rows are cloned: `migrate()` backfills bot contracts, and mutating the
 * exported rows would hand `importBackup` objects where SQL expects strings. */
export function tablesToState(tables) {
  const state = structuredClone(initialState());
  const s = state;
  s.settings = tables.settings?.length ? {
    topics: JSON.parse(tables.settings[0].topics || '[]'), style: tables.settings[0].style, opinions: tables.settings[0].opinions,
    minDelay: tables.settings[0].min_delay, maxDelay: tables.settings[0].max_delay,
  } : s.settings;
  s.groups = (tables.groups || []).map(g => ({...g, bots: (tables.bots || []).filter(b => b.group_id === g.id).map(b => ({...b}))}));
  Object.assign(s, readDocuments(name => tables[name] || []));
  s.evidence = (tables.evidence || []).map(e => ({...e}));
  s.events = (tables.events || []).map(e => ({...e}));
  s.tasks = (tables.tasks || []).map(t => ({...t, payload: JSON.parse(t.payload || '{}'), result: t.result ? JSON.parse(t.result) : null}));
  return s;
}
