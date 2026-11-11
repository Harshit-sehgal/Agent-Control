/** Local agent protocol: server side.
 *
 * The roadmap's "independent local agent" is a separate process on the user's
 * machine that the control plane never dials. Everything is outbound from the
 * agent:
 *
 * 1. An admin creates a short-lived pairing code (hashed at rest).
 * 2. The agent exchanges it once for its own id and secret, which the server
 *    stores only as a SHA-256 hash. The secret is shown exactly once.
 * 3. Every subsequent request is HMAC-signed (method, path, timestamp, body
 *    hash) so a stolen cookie cannot drive the agent and a replayed request is
 *    rejected by the timestamp window and per-agent nonce cache.
 * 4. Work arrives as agent tasks with leases, exactly like the queue: a
 *    disconnected agent's tasks expire and are redelivered rather than lost,
 *    and a result for an already-completed task is rejected, not double-applied.
 *
 * The agent executes only task kinds its permissions allow; permissions are
 * granted on the server and enforced here, so a compromised device process
 * cannot widen its own scope.
 */
import crypto from 'node:crypto';
import {fail} from '../shared/errors.js';
import {cleanText} from '../shared/core.js';
import {validateBrowserRequest} from '../shared/bot-browser.js';
import {cliEngineById,cleanCliModel,LOCAL_CLI_ENGINE_IDS} from '../shared/ai-presets.js';
import {encryptJson,decryptJson,sha256,loadMasterKey} from './vault.js';

export const AGENT_ACTIONS = ['http.check', 'browser.capture', 'browser.action', 'model.run', 'mcp.call'];
const PAIRING_TTL_MS = 10 * 60000;
const CLOCK_SKEW_MS = 5 * 60000;
// How long a claimed task stays leased to the device. It is also how recently a
// device must have been seen for it to count as alive in recovery below.
const DEFAULT_LEASE_MS = 120000;
// A task kind is its own permission: 'browser.action' exists beside
// 'browser.capture' because acting on a page is a deliberate grant, not a read.
// AGENT_ACTIONS is the list; a separate kind table only ever repeated it.
const signatureNonces = new Map(); // agentId -> Set of recently used signatures

/** Kinds that are never run a second time. A browser action may already have
 * clicked; a model run has already spent the owner's subscription. */
const ONCE_ONLY = ['browser.action', 'model.run', 'mcp.call'];
export const MODEL_RUN_TIMEOUT_MS = 180000;

/** The canonical `model.run` payload: an engine, an optional model that cannot
 * read as a flag, the bot's instructions and input as bounded text, and a
 * timeout. Anything else the caller sent is dropped. */
export function validateModelRun(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const engine = cliEngineById(p.engine);
  if (!engine) fail(`A model.run task needs an engine: ${LOCAL_CLI_ENGINE_IDS.join(' or ')}.`, 400);
  const model = cleanCliModel(p.model);
  if (model === null) fail('That model name is not valid for a CLI.', 400);
  if (typeof p.input !== 'string' || !p.input.trim()) fail('A model.run task needs input text.', 400);
  if (p.input.length > 100000) fail('A model.run input is too long (100000 characters at most).', 400);
  if (p.instructions !== undefined && typeof p.instructions !== 'string') fail('Instructions must be text.', 400);
  if ((p.instructions || '').length > 30000) fail('A model.run instruction is too long (30000 characters at most).', 400);
  let timeoutMs = MODEL_RUN_TIMEOUT_MS;
  if (p.timeoutMs !== undefined) {
    timeoutMs = Number(p.timeoutMs);
    if (!Number.isFinite(timeoutMs)) fail('The timeout must be a number of milliseconds.', 400);
    timeoutMs = Math.min(600000, Math.max(5000, Math.round(timeoutMs)));
  }
  return {engine: engine.id, model, instructions: p.instructions || '', input: p.input, timeoutMs};
}

/** The canonical `mcp.call` payload: the NAME of an MCP server configured on the agent's own machine, an
 * operation and, for a call, a tool and its arguments. There is no command and no environment here: what runs
 * is decided by the agent's config alone. Anything else the caller sent is dropped. */
export function validateMcpCall(payload) {
  const p = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  if (typeof p.server !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(p.server)) fail('An mcp.call task needs the name of a server configured on the agent (letters, digits . _ - only).', 400);
  if (p.op !== 'list' && p.op !== 'call') fail('An mcp.call task is a list or a call.', 400);
  const out = {server: p.server, op: p.op};
  if (p.op === 'call') {
    if (typeof p.tool !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(p.tool)) fail('A call needs a tool name.', 400);
    const args = p.args === undefined ? {} : p.args;
    if (!args || typeof args !== 'object' || Array.isArray(args)) fail('Tool arguments must be an object.', 400);
    if (JSON.stringify(args).length > 100000) fail('The tool arguments are too long (100000 characters at most).', 400);
    Object.assign(out, {tool: p.tool, args});
  }
  let timeoutMs = 30000;
  if (p.timeoutMs !== undefined) {
    timeoutMs = Number(p.timeoutMs);
    if (!Number.isFinite(timeoutMs)) fail('The timeout must be a number of milliseconds.', 400);
    timeoutMs = Math.min(120000, Math.max(2000, Math.round(timeoutMs)));
  }
  return {...out, timeoutMs};
}

const now = () => new Date().toISOString();

export {fail};

/** Body-independent signature material: method, path, timestamp, body hash. */
export function signRequest(secret, {method, path, timestamp, body}) {
  const payload = [String(method).toUpperCase(), String(path), String(timestamp), sha256(body ?? '')].join('\n');
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/** The vault key lives with the data file, so every instance of this module
 * works against the store it was constructed with. */
export function attachVault(store, dataFile) {
  const {key} = loadMasterKey(dataFile);
  store.vaultKey = key;
  return store;
}

/** Verify a signed agent request by decrypting the stored secret and comparing
 * HMACs. The plaintext secret never leaves this module or the database. */
export function verifyAgentRequest(store, headers, method, path, rawBody) {
  const agentId = headers['x-agent-id'];
  const timestamp = Number(headers['x-agent-ts']);
  const signature = headers['x-agent-sig'];
  if (!agentId || !timestamp || !signature) fail('Agent request is missing its signature headers.', 401);
  if (Math.abs(Date.now() - timestamp) > CLOCK_SKEW_MS) fail('Agent request timestamp is outside the accepted window.', 401);
  const agent = store.get('SELECT * FROM agents WHERE id=?', agentId);
  if (!agent) fail('Unknown agent.', 401);
  if (agent.revoked_at) fail('This agent has been revoked.', 403);
  let secret;
  try { secret = decryptJson(store.vaultKey, JSON.parse(agent.secret_enc)).secret; }
  catch { fail('This agent credential cannot be read. Re-pair the device.', 500); }
  const expected = signRequest(secret, {method, path, timestamp, body: rawBody});
  const a = Buffer.from(String(signature), 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) fail('Agent signature does not match.', 401);
  const seen = signatureNonces.get(agentId) || new Set();
  if (seen.has(signature)) fail('This agent request was already used.', 409);
  seen.add(signature);
  signatureNonces.set(agentId, seen);
  // Bound the replay cache; the timestamp window is the real protection, this
  // is only here to catch an immediate replay inside that window.
  if (seen.size > 512) signatureNonces.set(agentId, new Set([...seen].slice(-256)));
  return agent;
}

/** Create a pairing code. The plaintext code is returned exactly once; only
 * its hash is stored, so a database leak cannot redeem pending pairings. */
export function createPairing(store, workspaceId, {label, createdBy, permissions, ttlMs = PAIRING_TTL_MS} = {}) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  const code = Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
  const expires = new Date(Date.now() + ttlMs).toISOString();
  // The admin's chosen scope rides on the code. When unspecified it defaults to
  // every action (the historical behavior); the device can only ever be granted
  // a subset of this set at redemption.
  const scope = (permissions === undefined ? AGENT_ACTIONS : (Array.isArray(permissions) ? permissions : [])).filter(p => AGENT_ACTIONS.includes(p));
  store.run('INSERT INTO pairing_codes (code_hash,workspace_id,label,created_by,expires_at,created_at,permissions) VALUES (?,?,?,?,?,?,?)',
    sha256(code), workspaceId, cleanText(label, 120) || 'Local agent', createdBy || null, expires, now(), JSON.stringify(scope));
  return {code, expiresAt: expires, ttlSeconds: Math.round(ttlMs / 1000), permissions: scope};
}

/** Exchange a pairing code for agent credentials. */
export function redeemPairing(store, {code, name, permissions = []}) {
  const row = store.get('SELECT * FROM pairing_codes WHERE code_hash=?', sha256(String(code || '')));
  if (!row) fail('This pairing code is not valid.', 401);
  if (row.consumed_at) fail('This pairing code has already been used.', 409);
  if (Date.parse(row.expires_at) < Date.now()) fail('This pairing code has expired. Create a new one.', 410);
  const secret = crypto.randomBytes(32).toString('base64url');
  const agentId = crypto.randomUUID();
  // The device may ask for a subset of what the admin put on the code, never
  // more. Asking for nothing takes the admin's full scope.
  const allowed = (() => { try { return JSON.parse(row.permissions || '[]'); } catch { return []; } })().filter(p => AGENT_ACTIONS.includes(p));
  // An explicit list (even empty) is intersected with the admin's scope; an
  // omitted one takes the admin's full scope.
  const requested = permissions === undefined ? allowed : (Array.isArray(permissions) ? permissions : []);
  const granted = requested.filter(p => allowed.includes(p));
  // The secret is stored encrypted; pairing_codes keeps only hashes.
  const stored = JSON.stringify(encryptJson(store.vaultKey, {secret}));
  store.transaction(() => {
    store.run('UPDATE pairing_codes SET consumed_at=? WHERE code_hash=?', now(), sha256(String(code)));
    store.run('INSERT INTO agents (id,workspace_id,name,secret_hash,secret_enc,status,permissions,paired_by,paired_at) VALUES (?,?,?,?,?,?,?,?,?)',
      agentId, row.workspace_id, cleanText(name, 120) || 'Local agent', sha256(secret), stored, 'paired', JSON.stringify(granted), row.created_by, now());
  });
  return {agentId, secret, workspaceId: row.workspace_id, permissions: granted, pollIntervalMs: 30000};
}

export const agentTaskKinds = () => [...AGENT_ACTIONS];

/** Enqueue work for a paired agent. Idempotency is per-agent so a repeated
 * request (double-clicked button, retried polling) cannot run a job twice. */
export function enqueueAgentTask(store, agentId, {kind, payload = {}, idempotencyKey, createdBy, permission, approved = []}) {
  if (!AGENT_ACTIONS.includes(kind)) fail(`Unknown agent task kind. Expected one of: ${agentTaskKinds().join(', ')}.`);
  // Every enqueue goes through here — the pairing route, the queue scheduler and
  // the bot's own request — so the browser rules are enforced once, at the choke
  // point, instead of at whichever route happened to remember them.
  if (kind.startsWith('browser.')) {
    const request = validateBrowserRequest(payload);
    if (request.kind !== kind) fail(`A ${kind} task does not match the payload: it describes a ${request.kind}.`, 400);
    // `botId` picks the bot's own tab in the device's shared browser. It is only a label for
    // that tab, so it is bounded text or nothing.
    const botId = typeof payload?.botId === 'string' ? cleanText(payload.botId, 64) : '';
    // `approved` (the risky classes the owner cleared) is an argument, never read from the payload:
    // only the bot-browser dispatch passes it, so no route, schedule or model text can widen it. Absent
    // means none: the device refuses every risky control.
    const cleared = (Array.isArray(approved) ? approved : []).filter(a => typeof a === 'string').slice(0, 8);
    payload = {url: request.url, steps: request.steps, ...(botId ? {botId} : {}), ...(cleared.length ? {approved: cleared} : {})};
  }
  if (kind === 'model.run') payload = validateModelRun(payload);
  if (kind === 'mcp.call') payload = validateMcpCall(payload);
  const agent = store.get('SELECT * FROM agents WHERE id=?', agentId);
  if (!agent) fail('Agent not found.', 404);
  if (agent.revoked_at) fail('This agent has been revoked.', 409);
  const granted = JSON.parse(agent.permissions || '[]');
  // Always require the task kind's own permission, not only an explicitly
  // passed one: a caller that forgets `permission` must not be able to enqueue
  // work the agent was never granted.
  const required = permission || permissionForKind(kind);
  if (required && !granted.includes(required)) fail(`This agent does not hold the ${required} permission.`, 403);
  if (idempotencyKey) {
    const existing = store.get('SELECT * FROM agent_tasks WHERE agent_id=? AND idempotency_key=?', agentId, idempotencyKey);
    if (existing) return {task: existing, duplicate: true};
  }
  const id = crypto.randomUUID();
  const task = {
    id, agent_id: agentId, kind, payload: JSON.stringify(payload || {}), status: 'queued',
    attempts: 0, max_attempts: ONCE_ONLY.includes(kind) ? 1 : 3, idempotency_key: idempotencyKey || null, created_by: createdBy || null, created_at: now(),
  };
  store.run('INSERT INTO agent_tasks (id,agent_id,kind,payload,status,attempts,max_attempts,idempotency_key,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    task.id, task.agent_id, task.kind, task.payload, task.status, task.attempts, task.max_attempts, task.idempotency_key, task.created_by, task.created_at, now());
  return {task, duplicate: false};
}

/** Claim due agent tasks for one agent. Claims set a lease; a heartbeat after
 * the lease expired means the agent disconnected, so the task is redelivered. */
export function claimAgentTasks(store, agentId, {leaseMs = DEFAULT_LEASE_MS, limit = 5, nowMs = Date.now()} = {}) {
  const due = store.all(
    `SELECT * FROM agent_tasks WHERE agent_id=? AND status='queued' AND (lease_until IS NULL OR lease_until<=?)
     ORDER BY created_at LIMIT ?`, agentId, new Date(nowMs).toISOString(), limit);
  const claimed = [];
  for (const row of due) {
    const result = store.run(
      `UPDATE agent_tasks SET status='running', lease_until=?, attempts=attempts+1, updated_at=?
       WHERE id=? AND status='queued'`, new Date(nowMs + leaseMs).toISOString(), now(), row.id);
    if (result.changes === 1) claimed.push({...row, status: 'running', attempts: row.attempts + 1});
  }
  return claimed;
}

/** Record an agent's result. Completing twice is rejected, so a duplicate
 * delivery can never be applied twice.
 *
 * The device reports the attempt number the task was claimed with. The write is
 * fenced on it: when a lease lapsed and the task was re-delivered, the honest
 * but late result of the earlier attempt must not overwrite the run that is
 * executing now (and must not re-queue it as failed either). Without the fence
 * the second report silently won, and whatever it said became the task's
 * outcome even though it described an attempt nobody was running any more.
 * A report that carries no attempt number (an older device build) is accepted
 * as before; there is no attempt to fence on. */
export function completeAgentTask(store, agentId, taskId, {status, result, error, attempts}) {
  const task = store.get('SELECT * FROM agent_tasks WHERE id=? AND agent_id=?', taskId, agentId);
  if (!task) fail('Task not found.', 404);
  if (task.status === 'done' || task.status === 'failed') fail('This task was already completed.', 409);
  const claimed = attempts === undefined || attempts === null || attempts === '' ? null : Number(attempts);
  const fence = claimed === null || !Number.isFinite(claimed) ? '' : ' AND attempts=?';
  const fenceArgs = fence ? [claimed] : [];
  /** A write that matched no row is a result for an attempt the server has
   * already replaced: the task is running again for another attempt. */
  const superseded = () => {
    if (store.get('SELECT id FROM agent_tasks WHERE id=?', taskId)) {
      fail('This result is for an earlier attempt: the task was re-delivered and is running again, so the result was not applied.', 409);
    }
    fail('Task not found.', 404);
  };
  if (status === 'done') {
    const written = store.run(
      `UPDATE agent_tasks SET status='done', result=?, lease_until=NULL, updated_at=?, completed_at=?
       WHERE id=? AND status IN ('queued','running')${fence}`,
      JSON.stringify(result ?? null), now(), now(), taskId, ...fenceArgs);
    if (written.changes !== 1) superseded();
    return {ok: true, status: 'done'};
  }
  if (status !== 'failed') fail('Result status must be done or failed.', 400);
  // Retry while attempts remain, exactly like the server queue; the agent
  // gets the task again on a later heartbeat. `attempts` was already incremented
  // when the task was claimed, so this is the count for the run that just failed
  // — incrementing again here made a max_attempts=3 task run only twice.
  const used = task.attempts || 0;
  const retry = used < (task.max_attempts || 3);
  const written = store.run(
    `UPDATE agent_tasks SET status=?, attempts=?, error=?, lease_until=NULL, updated_at=?, completed_at=?
     WHERE id=? AND status IN ('queued','running')${fence}`,
    retry ? 'queued' : 'failed', used, cleanText(error, 400) || 'Agent reported failure.', now(), retry ? null : now(), taskId, ...fenceArgs);
  if (written.changes !== 1) superseded();
  return {ok: true, status: retry ? 'queued' : 'failed'};
}

/** Tasks orphaned by a disconnected agent: expired leases return to queued,
 * except browser actions and model runs, which fail instead (never retried). Returns how many
 * stale tasks were settled.
 *
 * A lapsed lease is only evidence of a disconnect when the device has also
 * stopped being seen. A device that is alive and still working (seen inside the
 * lease window) is skipped rather than re-armed: re-queueing a capture it is
 * running would run it twice, and failing a browser action would report a click
 * that actually landed as "The agent disconnected". The device renews its own
 * leases on every heartbeat; this is the backstop for the heartbeat that did
 * not reach the server. */
export function recoverAgentTasks(store, nowMs = Date.now(), {aliveMs = DEFAULT_LEASE_MS} = {}) {
  const stale = store.all(`SELECT * FROM agent_tasks WHERE status='running' AND (lease_until IS NULL OR lease_until<=?)`,
    new Date(nowMs).toISOString());
  const aliveSince = nowMs - aliveMs;
  let rearmed = 0;
  for (const row of stale) {
    if (agentSeenSince(store, row.agent_id, aliveSince)) continue;
    rearmed++;
    if (ONCE_ONLY.includes(row.kind)) {
      store.run(`UPDATE agent_tasks SET status='failed', lease_until=NULL, error=?, updated_at=?, completed_at=? WHERE id=?`,
        `The agent disconnected before completing. ${row.kind === 'model.run' ? 'Model runs' : row.kind === 'mcp.call' ? 'Connector calls' : 'Browser actions'} are not retried.`, now(), now(), row.id);
      continue;
    }
    store.run(`UPDATE agent_tasks SET status='queued', lease_until=NULL, error=?, updated_at=? WHERE id=?`,
      'The agent disconnected before completing. Re-armed automatically.', now(), row.id);
  }
  return rearmed;
}

export function touchAgent(store, agentId) {
  store.run('UPDATE agents SET last_seen_at=?, status=? WHERE id=?', now(), 'online', agentId);
}

/** Whether this device has heartbeated since `sinceMs`: the difference between a
 * device that is working and one that is gone. */
function agentSeenSince(store, agentId, sinceMs) {
  const seen = store.get('SELECT last_seen_at FROM agents WHERE id=?', agentId)?.last_seen_at;
  return Boolean(seen) && Date.parse(seen) > sinceMs;
}

/** Push the lease of every task this agent is still running out again.
 *
 * A device heartbeats while it works, so a *live* long job (a slow page, a
 * serial queue) must not look abandoned. Without this, `recoverAgentTasks`
 * re-armed any task whose 120s lease had lapsed even though the device was
 * still executing it, and the task ran twice. Call this before recovery in the
 * heartbeat. Returns how many leases were pushed out. */
export function renewAgentTaskLeases(store, agentId, {leaseMs = DEFAULT_LEASE_MS, nowMs = Date.now()} = {}) {
  const result = store.run(
    `UPDATE agent_tasks SET lease_until=?, updated_at=? WHERE agent_id=? AND status='running'`,
    new Date(nowMs + leaseMs).toISOString(), now(), agentId);
  return Number(result.changes || 0);
}

/** What the device reports about its CLIs. Only these four words are kept; any
 * other value, and anything that is not an object, is ignored or `unknown`. The
 * report lives in kv (never in a backup): it describes a machine, not the data. */
export const CLI_STATES = ['signed-in', 'signed-out', 'missing', 'unknown'];
export function recordAgentCli(store, agentId, report) {
  if (!report || typeof report !== 'object' || Array.isArray(report) || typeof store.kvSet !== 'function') return;
  const word = value => (CLI_STATES.includes(value) ? value : 'unknown');
  store.kvSet(`agent_cli:${agentId}`, JSON.stringify({claude: word(report.claude), codex: word(report.codex), checkedAt: now()}));
}
export function readAgentCli(store, agentId) {
  try {
    const raw = typeof store.kvGet === 'function' ? store.kvGet(`agent_cli:${agentId}`) : null;
    const value = raw ? JSON.parse(raw) : null;
    return value ? {claude: value.claude, codex: value.codex, checkedAt: value.checkedAt} : null;
  } catch { return null; }
}

export function listAgents(store, workspaceId) {
  const agents = store.all('SELECT * FROM agents WHERE workspace_id=? ORDER BY paired_at DESC', workspaceId);
  return agents.map(a => ({
    id: a.id, name: a.name, status: a.revoked_at ? 'revoked' : (a.last_seen_at && Date.parse(a.last_seen_at) > Date.now() - 180000 ? 'online' : (a.last_seen_at ? 'stale' : 'paired')),
    permissions: JSON.parse(a.permissions || '[]'), pairedAt: a.paired_at, lastSeenAt: a.last_seen_at,
    // Whether `claude` and `codex` are signed in on that machine, as the device last said.
    cli: a.revoked_at ? null : readAgentCli(store, a.id),
    tasks: {queued: store.get("SELECT count(*) AS n FROM agent_tasks WHERE agent_id=? AND status='queued'", a.id).n,
      running: store.get("SELECT count(*) AS n FROM agent_tasks WHERE agent_id=? AND status='running'", a.id).n,
      failed: store.get("SELECT count(*) AS n FROM agent_tasks WHERE agent_id=? AND status='failed'", a.id).n},
  }));
}

export function revokeAgent(store, agentId) {
  const agent = store.get('SELECT * FROM agents WHERE id=?', agentId);
  if (!agent) fail('Agent not found.', 404);
  store.run('UPDATE agents SET revoked_at=?, status=? WHERE id=?', now(), 'revoked', agentId);
  // In-flight work must not complete for a revoked device.
  store.run("UPDATE agent_tasks SET status='failed', error='Agent was revoked before completion.', lease_until=NULL, updated_at=? WHERE agent_id=? AND status IN ('queued','running')", now(), agentId);
  // Drop its replay cache so a revoked agent's entry is not retained for the
  // process lifetime.
  signatureNonces.delete(agentId);
  return {ok: true};
}

/** Drop queued or running agent work. A denied browser request uses this so
 * the device is not still asked to open a page the person turned down. */
export function failAgentTasks(store, ids, error) {
  if (typeof store.run !== 'function') return;
  const at = now();
  const message = cleanText(error, 400) || 'Cancelled.';
  for (const id of ids || []) {
    if (!id) continue;
    store.run("UPDATE agent_tasks SET status='failed', error=?, lease_until=NULL, updated_at=?, completed_at=? WHERE id=? AND status IN ('queued','running')", message, at, at, id);
  }
}

/** Drop a task row that never became an instruction anybody could act on.
 *
 * Deleting is the point, not tidying: the enqueue is idempotent on
 * `agent_id + idempotency_key`, so a dead row left behind would be handed back as
 * "already queued" on the next approval and the request could never be dispatched.
 * A row a device already claimed is failed instead - the page really is in its
 * hands and the history has to say so. */
export function discardAgentTask(store, id) {
  if (!id || typeof store.run !== 'function') return;
  store.run("DELETE FROM agent_tasks WHERE id=? AND status='queued'", id);
  failAgentTasks(store, [id], 'The browser request could not be recorded; approve it again.');
}

/** Grant or shrink an agent's permissions. Only the server can widen them:
 * an agent's heartbeat body is never trusted for its own scope. */
export function setAgentPermissions(store, agentId, permissions) {
  const agent = store.get('SELECT * FROM agents WHERE id=?', agentId);
  if (!agent) fail('Agent not found.', 404);
  if (!Array.isArray(permissions)) fail('Permissions must be an array.', 400);
  const granted = [];
  for (const p of permissions) {
    if (!AGENT_ACTIONS.includes(p)) fail(`Unknown agent permission "${String(p).slice(0, 40)}". Allowed: ${AGENT_ACTIONS.join(', ')}.`);
    if (!granted.includes(p)) granted.push(p);
  }
  store.run('UPDATE agents SET permissions=? WHERE id=?', JSON.stringify(granted), agentId);
  return {ok: true, permissions: granted};
}

/** The permission a task kind requires. */
export const permissionForKind = kind => (AGENT_ACTIONS.includes(kind) ? kind : null);
