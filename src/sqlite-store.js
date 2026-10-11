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
import {initialState, uuid} from '../shared/core.js';
import crypto from 'node:crypto';
import {sqlite} from './sqlite.js';
import * as wf from '../shared/workflow.js';

const now = () => new Date().toISOString();
/** Current schema version. Keep in sync with the migration list; tests and
 * operators read it, so it is exported rather than duplicated. */
export const SCHEMA_DB_VERSION = 4;

/** v1 ships the full target schema: the workflow document plus the surfaces
 * the roadmap adds (task queue, agents, vault, notifications, users). Adding a
 * table here is idempotent; later phases add numbered migrations for changes. */
const DOC_TABLES = ['candidates', 'drafts', 'runs', 'group_runs', 'group_messages'];
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
export function readDocuments(rows) {
  const s = {};
  s.candidates = rows('candidates').map(c => c.doc ? fromRow(c) : {...fromRow(c, {json: ['score']}), demo: Boolean(c.demo)});
  s.drafts = rows('drafts').map(d => fromRow(d));
  s.runs = rows('runs').map(r => fromRow(r));
  s.groupRuns = rows('group_runs').map(r => fromRow(r, {json: ['recipients', 'trace', 'checkpoint']}));
  s.groupMessages = {};
  for (const m of rows('group_messages')) (s.groupMessages[m.group_id] ??= []).push(fromRow(m, {drop: ['group_id']}));
  s.chats = {};
  for (const m of rows('chat_messages')) (s.chats[m.chat_key] ??= []).push(JSON.parse(m.doc));
  return s;
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
        contract TEXT, permissions TEXT, created_at TEXT NOT NULL);
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
    for (const table of DOC_TABLES) db.exec(`ALTER TABLE ${table} ADD COLUMN doc TEXT`);
    db.exec('CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, chat_key TEXT NOT NULL, doc TEXT NOT NULL, at TEXT NOT NULL)');
  }},
  // v4: session ids were stored as issued, so the database file (or the
  // sessions list) held live sign-in tokens. Only their hash is kept now;
  // sessions that are already open keep working.
  {to: 4, up(db) {
    const rehash = db.prepare('UPDATE sessions SET id=? WHERE id=?');
    for (const row of db.prepare('SELECT id FROM sessions').all()) rehash.run(crypto.createHash('sha256').update(row.id).digest('hex'), row.id);
  }}];
export class SqliteStore {
  constructor(dbPath, legacyPath) {
    this.dbPath = dbPath;
    this.legacyPath = legacyPath;
    this.cache = null;
    this.serial = Promise.resolve();
    this.db = null;
    this.recoveredFrom = null;
  }
  async init() {
    await fs.mkdir(path.dirname(this.dbPath), {recursive: true});
    const {DatabaseSync} = await sqlite();
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.migrate();
    try {await fs.chmod(this.dbPath, 0o600);} catch {}
    this.cache = await this.loadDocument();
    return this;
  }
  migrate() {
    // Bootstrap the ledger itself before reading it: a brand-new database has
    // no tables at all, so the version probe must not be the first statement.
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id=1), version INTEGER NOT NULL, updated_at TEXT NOT NULL);`);
    const row = this.db.prepare('SELECT version FROM schema_meta WHERE id=1').get();
    const current = row?.version ?? 0;
    if (current >= MIGRATIONS.length) return;
    this.db.exec('BEGIN');
    try {
      for (const migration of MIGRATIONS) {
        if (migration.to > current) migration.up(this.db);
      }
      this.db.prepare('INSERT INTO schema_meta (id,version,updated_at) VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, updated_at=excluded.updated_at')
        .run(MIGRATIONS.length, now());
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  kvGet(key) { return this.db.prepare('SELECT value FROM kv WHERE key=?').get(key)?.value ?? null; }
  kvSet(key, value) { this.db.prepare('INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value); }
  /** Read-only accessors for the non-document tables (auth, agents, queue). */
  all(sql, ...params) { return this.db.prepare(sql).all(...params); }
  get(sql, ...params) { return this.db.prepare(sql).get(...params); }
  run(sql, ...params) { return this.db.prepare(sql).run(...params); }
  transaction(fn) {
    this.db.exec('BEGIN');
    try { const out = fn(); this.db.exec('COMMIT'); return out; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
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
    // needs the built-in X-engage group, exactly like the old first-run path.
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
      settings: {topics: [], style: '', opinions: '', minDelay: 2, maxDelay: 10},
      captureToken: this.kvGet('capture_token'),
      groups: [], candidates: [], drafts: [], runs: [], tasks: [], events: [],
      groupMessages: {}, groupRuns: [], chats: {},
    };
    const cfg = this.db.prepare('SELECT * FROM settings WHERE id=1').get();
    if (cfg) s.settings = {
      topics: JSON.parse(cfg.topics), style: cfg.style, opinions: cfg.opinions,
      minDelay: cfg.min_delay, maxDelay: cfg.max_delay,
    };
    if (!s.captureToken) { s.captureToken = uuid().replaceAll('-', ''); this.kvSet('capture_token', s.captureToken); }
    for (const g of this.db.prepare('SELECT * FROM groups ORDER BY rowid').all()) {
      g.bots = this.db.prepare('SELECT * FROM bots WHERE group_id=? ORDER BY rowid').all(g.id).map(b => ({
        id: b.id, name: b.name, instructions: b.instructions, type: b.type,
        ...(b.contract ? {contract: JSON.parse(b.contract)} : {}),
        ...(b.permissions ? {permissions: JSON.parse(b.permissions)} : {}),
      }));
      delete g.rowid;
      s.groups.push(g);
    }
    Object.assign(s, readDocuments(table => this.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()));
    s.evidence = this.db.prepare('SELECT * FROM evidence').all().map(e => ({
      id: e.id, kind: e.kind, link: e.link, claim: e.claim, confidence: e.confidence,
      verification: e.verification, reuse: e.reuse, note: e.note,
      draftId: e.draft_id, candidateId: e.candidate_id, createdBy: e.created_by, createdAt: e.created_at,
    }));
    s.events = this.db.prepare('SELECT * FROM events').all().map(e => ({...e, meta: JSON.parse(e.meta)}));
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
      for (const table of ['groups', 'bots', 'candidates', 'drafts', 'evidence', 'runs', 'events', 'group_messages', 'group_runs', 'tasks', 'chat_messages']) {
        this.db.prepare(`DELETE FROM ${table}`).run();
      }
      this.db.prepare('INSERT INTO kv (key,value) VALUES (\'created_at\',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(state.createdAt || now());
      this.db.prepare('INSERT INTO kv (key,value) VALUES (\'capture_token\',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(state.captureToken);
      this.db.prepare('INSERT INTO settings (id,topics,style,opinions,min_delay,max_delay) VALUES (1,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET topics=excluded.topics, style=excluded.style, opinions=excluded.opinions, min_delay=excluded.min_delay, max_delay=excluded.max_delay')
        .run(JSON.stringify(state.settings.topics), state.settings.style, state.settings.opinions, state.settings.minDelay, state.settings.maxDelay);
      // Groups before bots: the foreign key requires the parent row to exist.
      for (const g of state.groups) {
        this.db.prepare('INSERT INTO groups (id,name,description,created_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description')
          .run(g.id, g.name, g.description || '', g.createdAt || now());
        for (const b of g.bots) {
          this.db.prepare('INSERT INTO bots (id,group_id,name,instructions,type,contract,permissions,created_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, instructions=excluded.instructions, type=excluded.type, contract=excluded.contract, permissions=excluded.permissions')
            .run(b.id, g.id, b.name, b.instructions || '', b.type || 'custom', b.contract ? JSON.stringify(b.contract) : null, b.permissions ? JSON.stringify(b.permissions) : null, b.createdAt || now());
        }
      }
      for (const c of state.candidates) {
        this.db.prepare('INSERT INTO candidates (id,url,author,topic,text,status,score,demo,created_at,doc) VALUES (?,?,?,?,?,?,?,?,?,?)')
          .run(c.id, c.url, c.author, c.topic || '', c.text, c.status, c.score ? JSON.stringify(c.score) : null, c.demo ? 1 : 0, c.createdAt || now(), JSON.stringify(c));
      }
      for (const d of state.drafts) {
        this.db.prepare('INSERT INTO drafts (id,candidate_id,author,url,source_text,text,revision,status,score,mode,note,approved_text,approved_revision,approved_at,due_at,posted_at,created_at,doc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(d.id, d.candidateId, d.author, d.url, d.sourceText || '', d.text, d.revision, d.status, d.score ?? null, d.mode || null, d.note || null, d.approvedText ?? null, d.approvedRevision ?? null, d.approvedAt ?? null, d.dueAt ?? null, d.postedAt ?? null, d.createdAt || now(), JSON.stringify(d));
      }
      for (const r of state.runs) {
        this.db.prepare('INSERT INTO runs (id,bot_id,bot_name,input,output,at,doc) VALUES (?,?,?,?,?,?,?)')
          .run(r.id, r.botId, r.botName, r.input ?? null, r.output ?? null, r.at || now(), JSON.stringify(r));
      }
      for (const e of (state.evidence || [])) {
        this.db.prepare('INSERT INTO evidence (id,draft_id,candidate_id,kind,link,claim,confidence,verification,reuse,note,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(e.id, e.draftId ?? null, e.candidateId ?? null, e.kind, e.link ?? null, e.claim, e.confidence, e.verification, e.reuse, e.note ?? null, e.createdBy ?? null, e.createdAt || now());
      }
      for (const t of (state.tasks || [])) {
        this.db.prepare('INSERT INTO tasks (id,kind,title,payload,status,run_at,interval_minutes,idempotency_key,attempts,max_attempts,lease_owner,lease_until,last_error,result,created_by,created_at,updated_at,completed_at,enabled,label,next_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(t.id, t.kind, t.title, JSON.stringify(t.payload || {}), t.status, t.runAt, t.intervalMinutes ?? null, t.idempotencyKey ?? null, t.attempts ?? 0, t.maxAttempts ?? 5, t.leaseOwner ?? null, t.leaseUntil ?? null, t.lastError ?? null, t.result ? JSON.stringify(t.result) : null, t.createdBy ?? null, t.createdAt || now(), t.updatedAt || now(), t.completedAt ?? null, 1, t.title, t.runAt);
      }
      // Legacy reminder schedules were migrated into reminder-kind tasks by
      // wf.migrate(); the store only ever sees state.tasks now.
      for (const e of state.events) {
        this.db.prepare('INSERT INTO events (id,at,type,message,meta,group_id) VALUES (?,?,?,?,?,?)')
          .run(e.id, e.at || now(), e.type, e.message, JSON.stringify(e.meta || {}), e.meta?.groupId || null);
      }
      for (const r of state.groupRuns) {
        this.db.prepare('INSERT INTO group_runs (id,group_id,input,recipients,mode,status,current_step,created_at,started_at,completed_at,trace,last_output,error,checkpoint,doc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(r.id, r.groupId, r.input, JSON.stringify(r.recipients), r.mode, r.status, r.currentStep ?? 0, r.createdAt, r.startedAt ?? null, r.completedAt ?? null, JSON.stringify(r.trace || []), r.lastOutput ?? null, r.error ?? null, r.checkpoint ? JSON.stringify(r.checkpoint) : null, JSON.stringify(r));
      }
      for (const [groupId, list] of Object.entries(state.groupMessages || {})) {
        for (const m of list || []) {
          this.db.prepare('INSERT INTO group_messages (id,group_id,run_id,role,sender_id,sender_name,to_bot_id,text,kind,at,doc) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .run(m.id, groupId, m.runId ?? null, m.role, m.senderId ?? null, m.senderName ?? null, m.toBotId ?? null, m.text, m.kind ?? null, m.at || now(), JSON.stringify(m));
        }
      }
      for (const [key, list] of Object.entries(state.chats || {})) {
        for (const m of list || []) this.db.prepare('INSERT INTO chat_messages (id,chat_key,doc,at) VALUES (?,?,?,?)').run(`${key}/${m.id}`, key, JSON.stringify(m), m.at || now());
      }
    });
    return t;
  }
  read() { return structuredClone(this.cache); }
  captureToken() { return this.cache.captureToken; }
  async persist(state = this.cache) { this.writeCollections(state); this.cache = state; }
  update(fn) {
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
}

export function resolveDbPath(dataFile) {
  if (process.env.DATA_DB) return process.env.DATA_DB;
  return dataFile.endsWith('.json') ? `${dataFile.slice(0, -5)}.db` : `${dataFile}.db`;
}

export async function openStore(dataFile) {
  return new SqliteStore(resolveDbPath(dataFile), dataFile).init();
}
