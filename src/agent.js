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
import {cleanText} from '../shared/core.js';
import {encryptJson,decryptJson,sha256,loadMasterKey} from './vault.js';

export const AGENT_ACTIONS = ['http.check', 'browser.capture', 'browser.action'];
const PAIRING_TTL_MS = 10 * 60000;
const CLOCK_SKEW_MS = 5 * 60000;
const TASK_KINDS = {
  'http.check': 'http.check',
  'browser.capture': 'browser.capture',
  // Interact with a page (navigate/click/type/wait/read) inside the same
  // allowlist and proxy as a read. A separate permission because it acts, not
  // just reads, so an operator grants it deliberately.
  'browser.action': 'browser.action',
};
const signatureNonces = new Map(); // agentId -> Set of recently used signatures

const now = () => new Date().toISOString();

export function fail(message, status = 400) { throw Object.assign(new Error(message), {status}); }

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
export function createPairing(store, workspaceId, {label, createdBy, ttlMs = PAIRING_TTL_MS} = {}) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(10);
  const code = Array.from(bytes, b => alphabet[b % alphabet.length]).join('');
  const expires = new Date(Date.now() + ttlMs).toISOString();
  store.run('INSERT INTO pairing_codes (code_hash,workspace_id,label,created_by,expires_at,created_at) VALUES (?,?,?,?,?,?)',
    sha256(code), workspaceId, cleanText(label, 120) || 'Local agent', createdBy || null, expires, now());
  return {code, expiresAt: expires, ttlSeconds: Math.round(ttlMs / 1000)};
}

/** Exchange a pairing code for agent credentials. */
export function redeemPairing(store, {code, name, permissions = []}) {
  const row = store.get('SELECT * FROM pairing_codes WHERE code_hash=?', sha256(String(code || '')));
  if (!row) fail('This pairing code is not valid.', 401);
  if (row.consumed_at) fail('This pairing code has already been used.', 409);
  if (Date.parse(row.expires_at) < Date.now()) fail('This pairing code has expired. Create a new one.', 410);
  const secret = crypto.randomBytes(32).toString('base64url');
  const agentId = crypto.randomUUID();
  const granted = (Array.isArray(permissions) ? permissions : []).filter(p => AGENT_ACTIONS.includes(p));
  // The secret is stored encrypted; pairing_codes keeps only hashes.
  const stored = JSON.stringify(encryptJson(store.vaultKey, {secret}));
  store.transaction(() => {
    store.run('UPDATE pairing_codes SET consumed_at=? WHERE code_hash=?', now(), sha256(String(code)));
    store.run('INSERT INTO agents (id,workspace_id,name,secret_hash,secret_enc,status,permissions,paired_by,paired_at) VALUES (?,?,?,?,?,?,?,?,?)',
      agentId, row.workspace_id, cleanText(name, 120) || 'Local agent', sha256(secret), stored, 'paired', JSON.stringify(granted), row.created_by, now());
  });
  return {agentId, secret, workspaceId: row.workspace_id, permissions: granted, pollIntervalMs: 30000};
}

export const agentTaskKinds = () => Object.keys(TASK_KINDS);

/** Enqueue work for a paired agent. Idempotency is per-agent so a repeated
 * request (double-clicked button, retried polling) cannot run a job twice. */
export function enqueueAgentTask(store, agentId, {kind, payload = {}, idempotencyKey, createdBy, permission}) {
  if (!TASK_KINDS[kind]) fail(`Unknown agent task kind. Expected one of: ${agentTaskKinds().join(', ')}.`);
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
    attempts: 0, max_attempts: 3, idempotency_key: idempotencyKey || null, created_by: createdBy || null, created_at: now(),
  };
  store.run('INSERT INTO agent_tasks (id,agent_id,kind,payload,status,attempts,max_attempts,idempotency_key,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    task.id, task.agent_id, task.kind, task.payload, task.status, task.attempts, task.max_attempts, task.idempotency_key, task.created_by, task.created_at, now());
  return {task, duplicate: false};
}

/** Claim due agent tasks for one agent. Claims set a lease; a heartbeat after
 * the lease expired means the agent disconnected, so the task is redelivered. */
export function claimAgentTasks(store, agentId, {leaseMs = 120000, limit = 5, nowMs = Date.now()} = {}) {
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
 * delivery can never be applied twice. */
export function completeAgentTask(store, agentId, taskId, {status, result, error}) {
  const task = store.get('SELECT * FROM agent_tasks WHERE id=? AND agent_id=?', taskId, agentId);
  if (!task) fail('Task not found.', 404);
  if (task.status === 'done' || task.status === 'failed') fail('This task was already completed.', 409);
  if (status === 'done') {
    store.run('UPDATE agent_tasks SET status=?,result=?,lease_until=NULL,updated_at=?,completed_at=? WHERE id=?',
      'done', JSON.stringify(result ?? null), now(), now(), taskId);
    return {ok: true, status: 'done'};
  }
  if (status !== 'failed') fail('Result status must be done or failed.', 400);
  // Retry while attempts remain, exactly like the server queue; the agent
  // gets the task again on a later heartbeat. Attempts are persisted, so
  // repeated failures without a claim still exhaust the budget.
  const attempts = (task.attempts || 0) + 1;
  const retry = attempts < (task.max_attempts || 3);
  store.run('UPDATE agent_tasks SET status=?,attempts=?,error=?,lease_until=NULL,updated_at=? WHERE id=?',
    retry ? 'queued' : 'failed', attempts, cleanText(error, 400) || 'Agent reported failure.', now(), taskId);
  return {ok: true, status: retry ? 'queued' : 'failed'};
}

/** Tasks orphaned by a disconnected agent: expired leases return to queued. */
export function recoverAgentTasks(store, nowMs = Date.now()) {
  const stale = store.all(`SELECT * FROM agent_tasks WHERE status='running' AND (lease_until IS NULL OR lease_until<=?)`,
    new Date(nowMs).toISOString());
  for (const row of stale) {
    store.run(`UPDATE agent_tasks SET status='queued', lease_until=NULL, error=?, updated_at=? WHERE id=?`,
      'The agent disconnected before completing. Re-armed automatically.', now(), row.id);
  }
  return stale.length;
}

export function touchAgent(store, agentId) {
  store.run('UPDATE agents SET last_seen_at=?, status=? WHERE id=?', now(), 'online', agentId);
}

export function listAgents(store, workspaceId) {
  const agents = store.all('SELECT * FROM agents WHERE workspace_id=? ORDER BY paired_at DESC', workspaceId);
  return agents.map(a => ({
    id: a.id, name: a.name, status: a.revoked_at ? 'revoked' : (a.last_seen_at && Date.parse(a.last_seen_at) > Date.now() - 180000 ? 'online' : (a.last_seen_at ? 'stale' : 'paired')),
    permissions: JSON.parse(a.permissions || '[]'), pairedAt: a.paired_at, lastSeenAt: a.last_seen_at,
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
  return {ok: true};
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
export const permissionForKind = kind => TASK_KINDS[kind] || null;

export function agentPublicRow(row) {
  return {
    id: row.id, name: row.name, status: row.status, permissions: JSON.parse(row.permissions || '[]'),
    pairedAt: row.paired_at, lastSeenAt: row.last_seen_at, revokedAt: row.revoked_at,
  };
}
