/** Transactional store backed by `node:sqlite`.
 *
 * The legacy store was a single JSON document rewritten atomically. That is
 * fine for one process and one user, but the roadmap calls for transactional
 * SQL with migrations, leases and multi-user state. Rather than rewrite every
 * pure transition in `shared/`, this store keeps the exact same interface
 * (`read()` / `update()` over the same plain-object document) and persists
 * collections relationally inside one WAL transaction per update. The document
 * shape the workflow, coordination and transport layers rely on is unchanged.
 *
 * Tables beyond the workflow document (users, sessions, agents, credentials,
 * jobs, notifications) live here too and are consumed by dedicated modules.
 * Schema changes are numbered in MIGRATIONS; `schema_meta.version` records the
 * applied version, and `migrate()` is idempotent.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {initialState} from '../shared/core.js';
import crypto from 'node:crypto';
import {sqlite} from './sqlite.js';
import * as wf from '../shared/workflow.js';
import {freshGuard} from '../shared/runaway.js';

const now = () => new Date().toISOString();

/** v1 ships the full target schema: the workflow document plus the surfaces
 * the roadmap adds (task queue, agents, vault, notifications, users). Adding a
 * table here is idempotent; later phases add numbered migrations for changes. */
const DOC_TABLES = ['runs', 'group_runs', 'group_messages'];
const camel = key => key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
/** One stored row as the workflow document it came from. Rows written before
 * v3 have no `doc`, so those are rebuilt from their columns: camelCase keys,
 * JSON columns parsed, and NULL meaning "the field was never set". */
export function fromRow(row, {json = [], drop = []} = {}) {
  if (row.doc) return JSON.parse(row.doc);
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === null || key === 'doc' || drop.includes(key)) continue;
    out[camel(key)] = json.includes(key) ? JSON.parse(value) : value;
  }
  return out;
}
/** Rebuild the collections that are stored one document per row. `rows(table)`
 * abstracts the source, so a live database and a backup file share one reader. */
/** A forgotten chat is stored as the moment it was forgotten, so a message
 * written after that request rebuilds the recap. Older rows stored `true`. */
const parseForgotten = doc => {
  try { return JSON.parse(doc); } catch { return true; }
};

/** Rebuild durable memory (per-model rulebooks, per-chat recaps) from rows.
 * `rows(kind)` yields `{key, doc}`. Missing kinds are simply empty. */
export function readMemory(rows) {
  const memory = {version: 1, rulebooks: {}, chats: {}, forgottenChats: {}};
  for (const row of rows('rulebook')) memory.rulebooks[row.key] = JSON.parse(row.doc);
  for (const row of rows('chat')) memory.chats[row.key] = JSON.parse(row.doc);
  for (const row of rows('forgotten')) memory.forgottenChats[row.key] = parseForgotten(row.doc);
  return memory;
}

export function readDocuments(rows) {
  const s = {};
  s.runs = rows('runs').map(r => fromRow(r));
  s.groupRuns = rows('group_runs').map(r => fromRow(r, {json: ['recipients', 'trace', 'checkpoint']}));
  s.groupMessages = {};
  for (const m of rows('group_messages')) (s.groupMessages[m.group_id] ??= []).push(fromRow(m, {drop: ['group_id']}));
  s.chats = {};
  for (const m of rows('chat_messages')) (s.chats[m.chat_key] ??= []).push(JSON.parse(m.doc));
  return s;
}

/** Rebuild the asks, grants and activity log from rows. Same reader for a live database and a backup file. */
export function readAsks(rows) {
  return {
    asks: rows('asks').map(r => fromRow(r)),
    grants: rows('grants').map(g => ({botId: g.bot_id, action: g.action, scope: g.scope ?? '', choice: g.choice, at: g.at})),
    activity: rows('activity').map(a => ({id: a.id, at: a.at, botId: a.bot_id ?? null, kind: a.kind, text: a.text, threadId: a.thread_id ?? null, undoUntil: a.undo_until ?? null})),
  };
}

const json = value => (value ? JSON.stringify(value) : null);

/** One table's shape: the columns it writes, the primary key that identifies a
 * row, and the row parameters built from the document. Declared once, so the
 * diff, the DELETE and the UPSERT cannot disagree about a column.
 *
 * `sig` is the value compared with the last write for that key: the row's
 * stored document when it has one, otherwise its parameters. A row whose `sig`
 * is unchanged is not written again at all. */
export const TABLE_SHAPES = [
  {
    table: 'groups', pk: ['id'],
    columns: ['id', 'name', 'description', 'created_at', 'settings'],
    rows: state => (state.groups || []).map(g => ({
      key: g.id, pk: [g.id],
      params: [g.id, g.name, g.description || '', g.createdAt || now(), json(g.settings)],
    })),
  },
  {
    table: 'bots', pk: ['id'],
    columns: ['id', 'group_id', 'name', 'instructions', 'type', 'contract', 'permissions', 'created_at', 'settings', 'origin', 'created_by'],
    rows: state => (state.groups || []).flatMap(g => (g.bots || []).map(b => ({
      key: b.id, pk: [b.id],
      params: [b.id, g.id, b.name, b.instructions || '', b.type || 'custom', json(b.contract), json(b.permissions), b.createdAt || now(), json(b.settings), b.origin ?? null, json(b.createdBy)],
    }))),
  },
  {
    table: 'runs', pk: ['id'], ordered: true, docColumn: 6,
    columns: ['id', 'bot_id', 'bot_name', 'input', 'output', 'at', 'doc'],
    rows: state => (state.runs || []).map(r => ({
      key: r.id, pk: [r.id],
      params: [r.id, r.botId, r.botName, r.input ?? null, r.output ?? null, r.at || now(), JSON.stringify(r)],
    })),
  },
  {
    table: 'group_runs', pk: ['id'], ordered: true, docColumn: 14,
    columns: ['id', 'group_id', 'input', 'recipients', 'mode', 'status', 'current_step', 'created_at', 'started_at', 'completed_at', 'trace', 'last_output', 'error', 'checkpoint', 'doc'],
    rows: state => (state.groupRuns || []).map(r => ({
      key: r.id, pk: [r.id],
      params: [r.id, r.groupId, r.input, JSON.stringify(r.recipients), r.mode, r.status, r.currentStep ?? 0, r.createdAt || now(), r.startedAt ?? null, r.completedAt ?? null, JSON.stringify(r.trace || []), r.lastOutput ?? null, r.error ?? null, json(r.checkpoint), JSON.stringify(r)],
    })),
  },
  {
    table: 'group_messages', pk: ['id'], docColumn: 10,
    columns: ['id', 'group_id', 'run_id', 'role', 'sender_id', 'sender_name', 'to_bot_id', 'text', 'kind', 'at', 'doc'],
    rows: state => Object.entries(state.groupMessages || {}).flatMap(([groupId, list]) => (list || []).map(m => ({
      key: m.id, pk: [m.id],
      params: [m.id, groupId, m.runId ?? null, m.role, m.senderId ?? null, m.senderName ?? null, m.toBotId ?? null, m.text, m.kind ?? null, m.at || now(), JSON.stringify(m)],
    }))),
  },
  {
    table: 'tasks', pk: ['id'], ordered: true,
    columns: ['id', 'kind', 'title', 'payload', 'status', 'run_at', 'interval_minutes', 'idempotency_key', 'attempts', 'max_attempts', 'lease_owner', 'lease_until', 'last_error', 'result', 'created_by', 'created_at', 'updated_at', 'completed_at', 'enabled', 'label', 'next_at'],
    rows: state => (state.tasks || []).map(t => ({
      key: t.id, pk: [t.id],
      params: [t.id, t.kind, t.title, JSON.stringify(t.payload || {}), t.status, t.runAt, t.intervalMinutes ?? null, t.idempotencyKey ?? null, t.attempts ?? 0, t.maxAttempts ?? 5, t.leaseOwner ?? null, t.leaseUntil ?? null, t.lastError ?? null, json(t.result), t.createdBy ?? null, t.createdAt || now(), t.updatedAt || now(), t.completedAt ?? null, 1, t.title, t.runAt],
    })),
  },
  {
    table: 'events', pk: ['id'], ordered: true,
    columns: ['id', 'at', 'type', 'message', 'meta', 'group_id'],
    rows: state => (state.events || []).map(e => ({
      key: e.id, pk: [e.id],
      params: [e.id, e.at || now(), e.type, e.message, JSON.stringify(e.meta || {}), e.meta?.groupId || null],
    })),
  },
  {
    table: 'chat_messages', pk: ['id'],
    columns: ['id', 'chat_key', 'doc', 'at'],
    rows: state => Object.entries(state.chats || {}).flatMap(([chatKey, list]) => (list || []).map(m => ({
      key: `${chatKey}/${m.id}`, pk: [`${chatKey}/${m.id}`],
      params: [`${chatKey}/${m.id}`, chatKey, JSON.stringify(m), m.at || now()],
    }))),
  },
  {
    table: 'memory', pk: ['kind', 'key'], docColumn: 2,
    columns: ['kind', 'key', 'doc'],
    rows: state => {
      const memory = state.memory || {};
      return ['rulebook', 'chat', 'forgotten'].flatMap(kind => {
        const source = kind === 'rulebook' ? memory.rulebooks : kind === 'chat' ? memory.chats : memory.forgottenChats;
        return Object.entries(source || {}).map(([key, doc]) => ({
          key: `${kind}/${key}`, pk: [kind, key],
          params: [kind, key, JSON.stringify(doc)],
        }));
      });
    },
  },
  // Asks waiting on (or answered by) the owner. The whole record is the document;
  // the columns are for queries and backups.
  {
    table: 'asks', pk: ['id'], docColumn: 11,
    columns: ['id', 'bot_id', 'run_id', 'chat_key', 'action', 'target', 'detail', 'status', 'scope', 'created_at', 'answered_at', 'doc'],
    rows: state => (state.asks || []).map(a => ({
      key: a.id, pk: [a.id],
      params: [a.id, a.botId, a.runId ?? null, a.chatKey ?? null, a.action, a.target ?? '', a.detail ?? '', a.status, a.scope ?? null, a.createdAt || now(), a.answeredAt ?? null, JSON.stringify(a)],
    })),
  },
  // What the owner said Always allow / Ask each time / Deny to: one row per bot, action and origin or account.
  {
    table: 'grants', pk: ['bot_id', 'action', 'scope'],
    columns: ['bot_id', 'action', 'scope', 'choice', 'at'],
    rows: state => (state.grants || []).map(g => ({
      key: `${g.botId}/${g.action}/${g.scope}`, pk: [g.botId, g.action, g.scope],
      params: [g.botId, g.action, g.scope, g.choice, g.at || now()],
    })),
  },
  // Everything that left the app, every permission change and every bot made, moved, paused or deleted.
  // Append-only: a row is written once and only retention removes it.
  {
    table: 'activity', pk: ['id'],
    columns: ['id', 'at', 'bot_id', 'kind', 'text', 'thread_id', 'undo_until'],
    rows: state => (state.activity || []).map(a => ({
      key: a.id, pk: [a.id],
      params: [a.id, a.at || now(), a.botId ?? null, a.kind, a.text, a.threadId ?? null, a.undoUntil ?? null],
    })),
  },
];

/** The statement that writes one row of a shape: an upsert, so a row that did
 * not exist is inserted and a changed row is replaced in place (its rowid, and
 * therefore the table's read order, survives). */
function upsertSql({table, columns, pk}) {
  const updates = columns.filter(column => !pk.includes(column)).map(column => `${column}=excluded.${column}`);
  return `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT(${pk.join(',')}) DO UPDATE SET ${updates.join(',')}`;
}
function deleteSql({table, pk}) {
  return `DELETE FROM ${table} WHERE ${pk.map(column => `${column}=?`).join(' AND ')}`;
}

const MIGRATIONS = [
  {to: 1, up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY CHECK (id=1),
        topics TEXT NOT NULL, style TEXT NOT NULL, opinions TEXT NOT NULL,
        min_delay INTEGER NOT NULL, max_delay INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        name TEXT NOT NULL, instructions TEXT NOT NULL DEFAULT '', type TEXT NOT NULL DEFAULT 'custom',
        contract TEXT, permissions TEXT, created_at TEXT NOT NULL, origin TEXT, created_by TEXT);
      CREATE TABLE IF NOT EXISTS candidates (
        id TEXT PRIMARY KEY, url TEXT NOT NULL, author TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '',
        text TEXT NOT NULL, status TEXT NOT NULL, score TEXT, demo INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts (
        id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL, author TEXT NOT NULL, url TEXT NOT NULL,
        source_text TEXT NOT NULL DEFAULT '', text TEXT NOT NULL, revision INTEGER NOT NULL,
        status TEXT NOT NULL, score INTEGER, mode TEXT, note TEXT,
        approved_text TEXT, approved_revision INTEGER, approved_at TEXT, due_at TEXT, posted_at TEXT,
        created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence (
        id TEXT PRIMARY KEY, draft_id TEXT, candidate_id TEXT, kind TEXT NOT NULL,
        link TEXT, claim TEXT NOT NULL, confidence REAL NOT NULL, verification TEXT NOT NULL,
        reuse TEXT NOT NULL, note TEXT, created_by TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, bot_name TEXT NOT NULL,
        input TEXT, output TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_runs (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, input TEXT NOT NULL, recipients TEXT NOT NULL,
        mode TEXT NOT NULL, status TEXT NOT NULL, current_step INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
        trace TEXT NOT NULL DEFAULT '[]', last_output TEXT, error TEXT, checkpoint TEXT);
      CREATE TABLE IF NOT EXISTS group_messages (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL,
        sender_id TEXT, sender_name TEXT, to_bot_id TEXT, text TEXT NOT NULL,
        kind TEXT, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL, run_at TEXT NOT NULL, interval_minutes INTEGER,
        idempotency_key TEXT, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
        lease_owner TEXT, lease_until TEXT, last_error TEXT, result TEXT,
        created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
        enabled INTEGER NOT NULL DEFAULT 1, label TEXT, next_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS tasks_idem ON tasks(idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, at TEXT NOT NULL, type TEXT NOT NULL, message TEXT NOT NULL,
        meta TEXT NOT NULL DEFAULT '{}', group_id TEXT);
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL, disabled_at TEXT, verified_at TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, ip TEXT, user_agent TEXT);
      CREATE TABLE IF NOT EXISTS password_resets (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at TEXT NOT NULL, used_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (workspace_id, user_id));
      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
        secret_hash TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'paired',
        permissions TEXT NOT NULL DEFAULT '[]', paired_by TEXT, paired_at TEXT NOT NULL,
        last_seen_at TEXT, revoked_at TEXT);
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code_hash TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, label TEXT,
        created_by TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL, consumed_at TEXT);
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
        lease_until TEXT, idempotency_key TEXT, result TEXT, error TEXT,
        created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_idem ON agent_tasks(agent_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE TABLE IF NOT EXISTS credentials (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
        kind TEXT NOT NULL, ciphertext BLOB NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL,
        created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT, expires_at TEXT);
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, user_id TEXT, channel TEXT NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, sent_at TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS notification_prefs (
        user_id TEXT PRIMARY KEY, in_app INTEGER NOT NULL DEFAULT 1, webhook INTEGER NOT NULL DEFAULT 0,
        webhook_url TEXT, email INTEGER NOT NULL DEFAULT 0, email_address TEXT, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'queued', run_at TEXT NOT NULL,
        idempotency_key TEXT, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
        lease_owner TEXT, lease_until TEXT, last_error TEXT, result TEXT, ref_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, started_at TEXT, completed_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS jobs_idem ON jobs(idempotency_key) WHERE idempotency_key IS NOT NULL;
    `);
  }},
  // v2: paired-agent secrets are stored encrypted (the vault) instead of a
  // hash, because the server must be able to verify an HMAC signature made
  // with the secret, which a one-way hash cannot support.
  {to: 2, up(db) {
    db.exec('ALTER TABLE agents ADD COLUMN secret_enc TEXT');
  }},
  // v3: every workflow record also keeps its whole document. The typed columns
  // stay for queries and backups, but reading the document back is what makes a
  // restart lossless: a field with no column of its own (a run's checkpoint
  // gate, anything added later) used to vanish, and the columns came back in
  // snake_case, which broke the next write. Conversations move to the server
  // here too, so they follow the account instead of one browser.
  {to: 3, up(db) {
    // The tables that existed at v3; candidates and drafts were dropped at v11.
    for (const table of ['candidates', 'drafts', 'runs', 'group_runs', 'group_messages']) db.exec(`ALTER TABLE ${table} ADD COLUMN doc TEXT`);
    db.exec('CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, chat_key TEXT NOT NULL, doc TEXT NOT NULL, at TEXT NOT NULL)');
  }},
  // v4: session ids were stored as issued, so the database file (or the
  // sessions list) held live sign-in tokens. Only their hash is kept now;
  // sessions that are already open keep working.
  {to: 4, up(db) {
    const rehash = db.prepare('UPDATE sessions SET id=? WHERE id=?');
    for (const row of db.prepare('SELECT id FROM sessions').all()) rehash.run(crypto.createHash('sha256').update(row.id).digest('hex'), row.id);
  }},
  // v5: a session remembers which workspace it is looking at, and a device can
  // register for push notifications. Sessions opened before this have no
  // workspace and fall back to one the account belongs to.
  {to: 5, up(db) {
    db.exec('ALTER TABLE sessions ADD COLUMN workspace_id TEXT');
    db.exec(`CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
      user_agent TEXT, created_at TEXT NOT NULL)`);
  }},
  // v6: a pairing code carries the permissions the admin chose when issuing it.
  // The redeeming device could previously name its own scope, so an admin who
  // meant to issue a read-only checker could get one that granted itself more.
  {to: 6, up(db) {
    db.exec('ALTER TABLE pairing_codes ADD COLUMN permissions TEXT');
  }},
  // v7: groups and bots keep the user's settings (routing, reply length...).
  {to: 7, up(db) {
    db.exec('ALTER TABLE groups ADD COLUMN settings TEXT');
    db.exec('ALTER TABLE bots ADD COLUMN settings TEXT');
  }},
  // v8: retention windows live with the other workspace settings so a restart
  // does not fall back to the defaults after You → Data saves a policy.
  {to: 8, up(db) {
    db.exec('ALTER TABLE settings ADD COLUMN retention TEXT');
  }},
  // v9: durable memory gets its own table. A rulebook and a chat recap are
  // variable-size JSON keyed by model or conversation, which suits neither the
  // typed tables nor kv (kv is excluded from backups on purpose).
  {to: 9, up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS memory (
      kind TEXT NOT NULL, key TEXT NOT NULL, doc TEXT NOT NULL,
      PRIMARY KEY (kind, key))`);
  }},
  // v10: a bot created by another bot keeps how it came to exist. Without these
  // columns the creator is only known for the life of the process. The CREATE
  // TABLE above already declares them, so an unconditional ALTER would abort a
  // fresh database's boot with "duplicate column name: origin"; only a table
  // made before this change needs them added.
  {to: 10, up(db) {
    const columns = db.prepare('PRAGMA table_info(bots)').all().map(c => c.name);
    if (!columns.includes('origin')) db.exec('ALTER TABLE bots ADD COLUMN origin TEXT');
    if (!columns.includes('created_by')) db.exec('ALTER TABLE bots ADD COLUMN created_by TEXT');
  }},
  // v11: X-engage is gone. Its tables, its settings columns and the capture
  // token go with it, and a queued reminder or drafting task, which no handler
  // can run any more, is cancelled rather than left to fail on every sweep.
  {to: 11, up(db) {
    db.exec('DROP TABLE IF EXISTS candidates; DROP TABLE IF EXISTS drafts; DROP TABLE IF EXISTS evidence;');
    const columns = db.prepare('PRAGMA table_info(settings)').all().map(c => c.name);
    for (const column of ['topics', 'style', 'opinions', 'min_delay', 'max_delay']) {
      if (columns.includes(column)) db.exec(`ALTER TABLE settings DROP COLUMN ${column}`);
    }
    db.prepare("DELETE FROM kv WHERE key='capture_token'").run();
    db.prepare("UPDATE tasks SET status='cancelled', last_error='This task kind was removed with X-engage' WHERE kind IN ('reminder','candidate-draft') AND status NOT IN ('done','failed','cancelled')").run();
  }},
  // v12: the ask mechanism. An ask waits on the owner; a grant is what an answer of
  // Always allow (or a later Ask each time / Deny) left behind, one per bot, action
  // and origin or account; the activity log is the append-only record of what left
  // the app and what changed. A grant has no foreign key to bots on purpose: a
  // restore can carry one for a bot that is gone, and it is ignored, not an error.
  {to: 12, up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS asks (
        id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, run_id TEXT, chat_key TEXT,
        action TEXT NOT NULL, target TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL, scope TEXT, created_at TEXT NOT NULL, answered_at TEXT, doc TEXT);
      CREATE TABLE IF NOT EXISTS grants (
        bot_id TEXT NOT NULL, action TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '',
        choice TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (bot_id, action, scope));
      CREATE TABLE IF NOT EXISTS activity (
        id TEXT PRIMARY KEY, at TEXT NOT NULL, bot_id TEXT, kind TEXT NOT NULL,
        text TEXT NOT NULL, thread_id TEXT, undo_until TEXT);
      CREATE INDEX IF NOT EXISTS activity_at ON activity(at);
    `);
  }}];
/** Current schema version, derived from the migration list so it cannot drift.
 * Tests and operators read it. */
export const SCHEMA_DB_VERSION = MIGRATIONS.length;
export class SqliteStore {
  constructor(dbPath, legacyPath) {
    this.dbPath = dbPath;
    this.legacyPath = legacyPath;
    this.cache = null;
    this.serial = Promise.resolve();
    this.db = null;
    this.recoveredFrom = null;
    // Per-table key -> {pk, sig} of the last write, so an update only writes
    // the rows that changed; and one prepared statement per piece of SQL.
    this.written = new Map();
    this.stmts = new Map();
  }
  async init() {
    await fs.mkdir(path.dirname(this.dbPath), {recursive: true});
    const {DatabaseSync} = await sqlite();
    this.db = new DatabaseSync(this.dbPath);
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
      this.migrate();
      this.cache = await this.loadDocument();
    } catch (e) {
      // A store that failed to open must not keep the file handle: a newer
      // schema or a corrupt legacy import would otherwise leak it for the
      // process lifetime (and on some platforms keep the file locked).
      try { this.db.close(); } catch { /* already unusable */ }
      this.db = null;
      throw e;
    }
    try {await fs.chmod(this.dbPath, 0o600);} catch {}
    return this;
  }
  migrate() {
    // Bootstrap the ledger itself before reading it: a brand-new database has
    // no tables at all, so the version probe must not be the first statement.
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL, updated_at TEXT NOT NULL);`);
    const row = this.db.prepare('SELECT version FROM schema_meta WHERE id=1').get();
    const current = row?.version ?? 0;
    // A database written by a newer build cannot be read by this one: the
    // columns the code expects may not exist yet, or may have been renamed.
    // Refusing loudly beats silently running against a schema we do not know.
    if (current > MIGRATIONS.length) {
      throw new Error(`${this.dbPath} was written by a newer version of this app (schema v${current}; this build understands v${MIGRATIONS.length}). Update the app, or restore a backup taken with this version.`);
    }
    if (current === MIGRATIONS.length) return;
    this.db.exec('BEGIN');
    try {
      for (const migration of MIGRATIONS) {
        if (migration.to > current) migration.up(this.db);
      }
      this.db.prepare('INSERT INTO schema_meta (id,version,updated_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at')
        .run(MIGRATIONS.length, now());
      this.db.exec('COMMIT');
    } catch (e) { rollback(this.db); throw e; }
  }
  kvGet(key) { return this.db.prepare('SELECT value FROM kv WHERE key=?').get(key)?.value ?? null; }
  kvSet(key, value) { this.stmt('INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  /** Read-only accessors for the non-document tables (auth, agents, queue). */
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  transaction(fn) {
    this.db.exec('BEGIN');
    try { const out = fn(); this.db.exec('COMMIT'); return out; }
    catch (e) { rollback(this.db); throw e; }
  }
  /** Retention for the agent protocol's own tables. They live outside the
   * workflow document, so `pruneState()` never sees them: a consumed pairing
   * code and a finished agent task would otherwise be kept forever. Deleting a
   * finished task also drops its idempotency key, which is why the window is
   * generous (a duplicate request that late is not a real retry). */
  pruneAgentRows({now = Date.now(), pairingMs = 24 * 3600000, taskMs = 30 * 86400000} = {}) {
    const pairing = this.db.prepare('DELETE FROM pairing_codes WHERE (consumed_at IS NOT NULL AND consumed_at < ?) OR (consumed_at IS NULL AND expires_at < ?)')
      .run(new Date(now - pairingMs).toISOString(), new Date(now - pairingMs).toISOString());
    const tasks = this.db.prepare("DELETE FROM agent_tasks WHERE status IN ('done','failed') AND COALESCE(completed_at, updated_at, created_at) < ?")
      .run(new Date(now - taskMs).toISOString());
    return {pairingCodes: Number(pairing.changes || 0), agentTasks: Number(tasks.changes || 0)};
  }
  /** Rebuild the workflow document from SQL and fold in a newer legacy JSON
   * export when one exists (operator restore, or the old dev data dir). */
  async loadDocument() {
    const imported = this.kvGet('legacy_imported_mtime');
    let legacy = null;
    // Guard the pathological configuration where DATA_FILE points at the
    // database itself; quarantining it would delete the live store.
    const legacyIsDb = path.resolve(this.legacyPath) === path.resolve(this.dbPath);
    try {
      const stat = legacyIsDb ? null : await fs.stat(this.legacyPath);
      const stamp = `${stat.mtimeMs}`;
      if (imported !== stamp) {
        legacy = JSON.parse(await fs.readFile(this.legacyPath, 'utf8'));
        this.kvSet('legacy_pending_mtime', stamp);
      }
    } catch (e) {
      if (e && e.code !== 'ENOENT' && !legacyIsDb && legacy === null && !this.recoveredFrom) {
        // Quarantine corrupt legacy JSON exactly like the old store, but only
        // when we have not already imported a good copy at least once.
        this.recoveredFrom = `${this.legacyPath}.corrupt-${Date.now()}`;
        await fs.rename(this.legacyPath, this.recoveredFrom).catch(() => {});
      }
      legacy = null;
    }
    const state = this.readCollections();
    if (legacy) {
      wf.migrate(legacy);
      Object.assign(state, structuredClone(legacy));
      this.writeCollections(state);
      this.kvSet('legacy_imported_mtime', this.kvGet('legacy_pending_mtime'));
    }
    // A brand-new database (or an imported document with an empty roster) still
    // needs the built-in Home group and its primary bot.
    if (!state.groups.length) {
      const seed = initialState();
      state.groups = seed.groups;
      state.settings = {...state.settings, ...seed.settings};
      this.writeCollections(state);
    }
    return state;
  }
  readCollections() {
    const s = {
      version: 2,
      createdAt: this.kvGet('created_at') || now(),
      settings: {},
      groups: [], runs: [], tasks: [], events: [],
      groupMessages: {}, groupRuns: [], chats: {},
      ai: (() => { try { return JSON.parse(this.kvGet('ai') || '{}'); } catch { return {}; } })(),
      browserRequests: (() => { try { return JSON.parse(this.kvGet('browser_requests') || '[]'); } catch { return []; } })(),
      // Connectors hold no secret (those are vault credentials); like the provider list they stay out of backups.
      connectors: (() => { try { return JSON.parse(this.kvGet('connectors') || '[]'); } catch { return []; } })(),
      // Emails waiting out their Undo window (a few seconds of content); never in a backup or the snapshot.
      heldSends: (() => { try { return JSON.parse(this.kvGet('held_sends') || '[]'); } catch { return []; } })(),
      // The runaway guard keeps its pause across a restart, so Pause all holds.
      guard: (() => { try { return {...freshGuard(), ...JSON.parse(this.kvGet('guard') || '{}')}; } catch { return freshGuard(); } })(),
      // The owner's switch to ask before a bot opens a page or reads a connected app (shared/asks.js).
      askBasics: this.kvGet('ask_basics') === '1',
      // The owner's limits on how far bots go per message (shared/limits.js); empty is no limit.
      limits: (() => { try { return JSON.parse(this.kvGet('limits') || '{}'); } catch { return {}; } })(),
      memory: readMemory(kind => this.db.prepare('SELECT key, doc FROM memory WHERE kind=? ORDER BY rowid').all(kind)),
    };
    const cfg = this.db.prepare('SELECT * FROM settings WHERE id=1').get();
    if (cfg?.retention) {
      try { s.settings.retention = JSON.parse(cfg.retention); } catch { /* ignore */ }
    }
    for (const g of this.db.prepare('SELECT * FROM groups ORDER BY rowid').all()) {
      g.bots = this.db.prepare('SELECT * FROM bots WHERE group_id=? ORDER BY rowid').all(g.id).map(b => ({
        id: b.id, name: b.name, instructions: b.instructions, type: b.type,
        ...(b.contract ? {contract: JSON.parse(b.contract)} : {}),
        ...(b.permissions ? {permissions: JSON.parse(b.permissions)} : {}),
        ...(b.settings ? {settings: JSON.parse(b.settings)} : {}),
        ...(b.origin ? {origin: b.origin} : {}),
        ...(b.created_by ? {createdBy: JSON.parse(b.created_by)} : {}),
      }));
      delete g.rowid;
      if (g.settings) g.settings = JSON.parse(g.settings); else delete g.settings;
      s.groups.push(g);
    }
    Object.assign(s, readDocuments(table => this.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    s.events = this.db.prepare('SELECT * FROM events').all().map(e => ({...e, meta: JSON.parse(e.meta)}));
    Object.assign(s, readAsks(table => this.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    s.tasks = this.db.prepare('SELECT * FROM tasks ORDER BY rowid').all().map(t => ({
      id: t.id, kind: t.kind, title: t.title, payload: JSON.parse(t.payload), status: t.status,
      runAt: t.run_at, intervalMinutes: t.interval_minutes, idempotencyKey: t.idempotency_key,
      attempts: t.attempts, maxAttempts: t.max_attempts, leaseOwner: t.lease_owner, leaseUntil: t.lease_until,
      lastError: t.last_error, result: t.result ? JSON.parse(t.result) : null,
      createdBy: t.created_by, createdAt: t.created_at, updatedAt: t.updated_at, completedAt: t.completed_at,
    }));
    return s;
  }
  writeCollections(state) {
    const t = this.transaction(() => {
      // Diff each table against the last write: one document update usually
      // touches one row, and rewriting the whole table (all chat messages, all
      // events) for it made every update cost O(rows) forever.
      const work = TABLE_SHAPES.map(shape => {
        const rows = shape.rows(state);
        const previous = this.written.get(shape.table) || this.existingRows(shape);
        const seq = rows.map(row => row.key);
        // The document's array order is part of what `read()` returns, and rows
        // come back in rowid order. A row that is prepended (`events.unshift`,
        // a captured post) would otherwise read back last after a restart, so
        // a table whose order changed is rewritten in document order. Append
        // and in-place edits, the common case, still write only their own row.
        const reordered = shape.ordered && (seq.length !== previous.seq.length || seq.some((key, i) => key !== previous.seq[i]));
        const next = new Map(), upserts = [];
        for (const row of rows) {
          // The stored document, where the table has one, is already built for
          // the column: reusing it as the change signature costs one compare.
          const sig = shape.docColumn === undefined ? JSON.stringify(row.params) : String(row.params[shape.docColumn]);
          next.set(row.key, {pk: row.pk, sig});
          const was = previous.map.get(row.key);
          if (reordered || !was || was.sig !== sig) upserts.push(row);
        }
        const deletes = [];
        if (!reordered) for (const [key, was] of previous.map) if (!next.has(key)) deletes.push(was.pk);
        this.written.set(shape.table, {map: next, seq});
        return {shape, deletes, upserts, reordered};
      });
      // Children first on the way out, parents first on the way in: the one
      // foreign key is bots.group_id -> groups.id, so a removed group must lose
      // its bots before the parent row goes.
      for (const {shape, deletes} of [...work].reverse()) {
        const remove = this.stmt(deleteSql(shape));
        for (const pk of deletes) remove.run(...pk);
      }
      for (const {shape, upserts, reordered} of work) {
        // A rewrite starts from an empty table so every row lands in document
        // order; otherwise only the changed rows are upserted in place.
        if (reordered) this.stmt(`DELETE FROM ${shape.table}`).run();
        const upsert = this.stmt(upsertSql(shape));
        for (const row of upserts) upsert.run(...row.params);
      }
      this.kvSet('created_at', state.createdAt || now());
      this.kvSet('ai', JSON.stringify(state.ai || {}));
      this.kvSet('browser_requests', JSON.stringify(state.browserRequests || []));
      this.kvSet('connectors', JSON.stringify(state.connectors || []));
      this.kvSet('held_sends', JSON.stringify(state.heldSends || []));
      this.kvSet('guard', JSON.stringify(state.guard || freshGuard()));
      this.kvSet('ask_basics', state.askBasics ? '1' : '0');
      this.kvSet('limits', JSON.stringify(state.limits || {}));
      this.stmt('INSERT INTO settings (id,retention) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET retention=excluded.retention')
        .run(state.settings?.retention ? JSON.stringify(state.settings.retention) : null);
    });
    return t;
  }
  /** The keys already in a table, used the first time this process writes it:
   * rows the document no longer carries are then deleted rather than left
   * behind. Signatures start unknown, so every present row is written once. */
  existingRows(shape) {
    const map = new Map(), seq = [];
    for (const row of this.db.prepare(`SELECT ${shape.pk.join(',')} FROM ${shape.table} ORDER BY rowid`).all()) {
      const pk = shape.pk.map(column => row[column]);
      const key = pk.length === 1 ? String(pk[0]) : pk.join('/');
      map.set(key, {pk, sig: undefined});
      seq.push(key);
    }
    return {map, seq};
  }
  /** One prepared statement per piece of SQL, kept for the life of the store:
   * the write path now runs a handful of statements per update instead of one
   * per row. */
  stmt(sql) {
    let statement = this.stmts.get(sql);
    if (!statement) { statement = this.db.prepare(sql); this.stmts.set(sql, statement); }
    return statement;
  }
  /** Wait for queued writes, then release the file. Used when a workspace is deleted. */
  async close() { await this.serial; this.stmts.clear(); this.written.clear(); this.db.close(); }
  read() { return structuredClone(this.cache); }
  async persist(state = this.cache) { this.writeCollections(state); this.cache = state; }
  /** Queue one read-copy-write of the whole document behind every write already
   * waiting. Every change to the cache has to pass through here: a mutation made
   * outside the queue is overwritten by the clone of whichever write was already
   * in flight, and the next write then persists that stale document. */
  enqueue(fn) {
    const op = this.serial.then(async () => {
      const next = structuredClone(this.cache);
      const result = await fn(next);
      this.writeCollections(next);
      this.cache = next;
      return result;
    });
    this.serial = op.catch(() => {});
    return op;
  }
  update(fn) { return this.enqueue(fn); }
}

/** ROLLBACK can itself fail: SQLite already rolls the transaction back on
 * SQLITE_FULL, SQLITE_IOERR and some SQLITE_BUSY cases, so the second attempt
 * throws "cannot rollback - no transaction is active" and replaces the real
 * error with a confusing one. Best effort, then rethrow the original. */
function rollback(db) {
  try { db.exec('ROLLBACK'); } catch { /* the transaction is already gone */ }
}

export function resolveDbPath(dataFile) {
  if (process.env.DATA_DB) return process.env.DATA_DB;
  return dataFile.endsWith('.json') ? `${dataFile.slice(0, -5)}.db` : `${dataFile}.db`;
}

export async function openStore(dataFile) {
  return new SqliteStore(resolveDbPath(dataFile), dataFile).init();
}
