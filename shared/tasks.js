/** Structured, runnable tasks (the durable queue's document side).
 *
 * The prototype stored reminders as passive text events fired by the scheduler
 * tick. Anything with retries, leases, idempotency or an agent execution needs
 * a real record: a kind, a validated payload, a status, attempts and a lease.
 * These transitions are pure and mirror `workflow.js`: the Node worker and the
 * browser-local demo both run them, so the two backends cannot drift.
 */
import {activity, cleanText} from './core.js';

export const TASK_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'];
export const MAX_ATTEMPTS_DEFAULT = 5;

/** Payload validators per kind. Unknown kinds are refused, so a stale UI or a
 * crafted request cannot enqueue a kind the worker does not know how to run. */
const PAYLOAD_KINDS = {
  reminder: body => {
    if (!['once', 'interval'].includes(body.kind)) throw fail('Label and valid schedule kind required.', 400);
    const kind = body.kind;
    const label = cleanText(body.label, 200);
    if (!label) throw fail('Label and valid schedule kind required.', 400);
    if (kind === 'once') {
      const when = Date.parse(body.nextAt);
      if (!Number.isFinite(when) || when < Date.now() + 1000 || when > Date.now() + 365 * 86400000) throw fail('Choose a future date within one year.', 400);
      return {label, kind, nextAt: new Date(when).toISOString()};
    }
    const intervalMinutes = Number(body.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080) throw fail('Interval must be 1\u201310080 minutes.', 400);
    return {label, kind, intervalMinutes};
  },
  'candidate-draft': body => ({candidateId: cleanText(body.candidateId, 64), direction: cleanText(body.direction, 500)}),
  'group-run': body => ({groupId: cleanText(body.groupId, 64), message: cleanText(body.message, 4000), directBotId: cleanText(body.directBotId, 64) || null}),
  'agent-job': body => ({action: cleanText(body.action, 64), params: body.params && typeof body.params === 'object' ? body.params : {}, agentId: cleanText(body.agentId, 64) || null}),
  notification: body => ({
    notificationId: cleanText(body.notificationId, 64) || null,
    channel: ['in_app', 'webhook', 'email', 'push'].includes(body.channel) ? body.channel : 'in_app',
    target: cleanText(body.target, 4000) || null,
    title: cleanText(body.title, 200), body: cleanText(body.body, 2000),
    meta: body.meta && typeof body.meta === 'object' ? body.meta : {},
  }),
};

export function fail(message, status = 400) {
  throw Object.assign(new Error(message), {status});
}

export const taskKinds = () => Object.keys(PAYLOAD_KINDS);

/** What each kind must actually carry to be runnable. The old "some value is
 * present" check was defeated by object defaults (`params: {}`), so a job with
 * no action reached the worker and burned its retries; each kind now names the
 * scalar it needs. */
const REQUIRED_FIELDS = {
  'candidate-draft': payload => payload.candidateId || fail('A draft task needs a candidate id.'),
  'group-run': payload => (payload.groupId && payload.message) || fail('A group run needs a group and a message.'),
  'agent-job': payload => payload.action || fail('An agent job needs an action.'),
};

/** Validate a task request and build the canonical payload for its kind. */
export function buildPayload(kind, body = {}) {
  const validate = PAYLOAD_KINDS[kind];
  if (!validate) fail(`Unknown task kind. Expected one of: ${taskKinds().join(', ')}.`);
  const payload = validate(body || {});
  if (REQUIRED_FIELDS[kind]) REQUIRED_FIELDS[kind](payload);
  return payload;
}

/** Exponential backoff between retries: 1s, 2s, 4s ... capped at 5 minutes.
 * `attempt` is the count after claiming (1 on the first run), so subtract one. */
export function retryDelay(attempt, now = Date.now()) {
  const base = Math.min(2 ** Math.max(0, attempt - 1) * 1000, 300000);
  return now + base;
}

/** Enqueue a task. An explicit idempotency key makes re-submission of the same
 * intent (a double-clicked button, a retried agent poll) return the original
 * task instead of running the work twice. */
export function enqueueTask(state, body = {}) {
  const kind = cleanText(body.kind, 64);
  const payload = buildPayload(kind, body.payload || body);
  const idempotencyKey = body.idempotencyKey ? cleanText(body.idempotencyKey, 120) : null;
  const intervalMinutes = (kind === 'reminder' && payload.kind === 'interval') ? payload.intervalMinutes : (Number.isInteger(body.intervalMinutes) ? body.intervalMinutes : null);
  if (idempotencyKey) {
    const existing = state.tasks.find(t => t.idempotencyKey === idempotencyKey && t.status !== 'cancelled');
    if (existing) return {task: existing, duplicate: true};
  }
  const task = {
    id: crypto.randomUUID(), kind, title: cleanText(body.title, 200) || taskTitle(kind, payload),
    payload, status: 'queued', runAt: payload.nextAt || new Date().toISOString(), intervalMinutes,
    idempotencyKey, attempts: 0, maxAttempts: Math.max(1, Math.min(20, Number(body.maxAttempts) || MAX_ATTEMPTS_DEFAULT)),
    leaseOwner: null, leaseUntil: null, lastError: null, result: null,
    createdBy: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null,
  };
  state.tasks.unshift(task);
  activity(state, 'task', `Queued task: ${task.title}`, {taskId: task.id});
  return {task, duplicate: false};
}

const taskTitle = (kind, payload) => ({
  reminder: payload.label || 'Reminder',
  'candidate-draft': `Draft reply for ${payload.candidateId || 'candidate'}`,
  'group-run': `Group run: ${String(payload.message || '').slice(0, 80)}`,
  'agent-job': `Agent job: ${payload.action || 'unspecified'}`,
})[kind] || kind;

/** Claim due tasks for execution. Leases are what make execution durable: a
 * crashed worker's task is visibly stale and can be re-claimed by anyone. */
export function claimTasks(state, {workerId, now = Date.now(), leaseMs = 60000, limit = 5, leaseTTL = 60000} = {}) {
  if (!workerId) fail('A worker id is required to claim tasks.', 500);
  if (leaseMs !== leaseTTL) leaseTTL = leaseMs; // one lease window, one meaning
  const claimed = [];
  for (const task of state.tasks) {
    if (claimed.length >= limit) break;
    if (task.status !== 'queued') continue;
    if (Date.parse(task.runAt) > now) continue;
    if (task.leaseUntil && Date.parse(task.leaseUntil) > now) continue;
    task.status = 'running';
    task.leaseOwner = workerId;
    task.leaseUntil = new Date(now + leaseTTL).toISOString();
    task.attempts += 1;
    task.updatedAt = new Date(now).toISOString();
    claimed.push(task);
  }
  return claimed;
}

export function completeTask(state, id, result = null, now = Date.now()) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) fail('Task not found.', 404);
  if (task.status !== 'running') fail('Only a running task can be completed.', 409);
  task.status = 'done';
  task.result = result ?? null;
  task.completedAt = new Date(now).toISOString();
  task.updatedAt = task.completedAt;
  task.leaseOwner = null;
  task.leaseUntil = null;
  task.lastError = null;
  // A recurring task re-arms itself for the next window instead of finishing.
  if (task.intervalMinutes) {
    task.status = 'queued';
    task.runAt = new Date(now + task.intervalMinutes * 60000).toISOString();
    task.completedAt = null;
    task.attempts = 0;
  }
  activity(state, 'task', `Completed task: ${task.title}`, {taskId: task.id});
  return task;
}

/** Record a failure. The task goes back to `queued` with a backoff while
 * attempts remain, and only then to `failed`. */
export function failTask(state, id, message, now = Date.now()) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) fail('Task not found.', 404);
  if (task.status !== 'running') fail('Only a running task can fail.', 409);
  const error = String(message || 'Unknown error').slice(0, 400);
  task.leaseOwner = null;
  task.leaseUntil = null;
  task.updatedAt = new Date(now).toISOString();
  if (task.attempts >= task.maxAttempts) {
    task.status = 'failed';
    task.lastError = error;
    task.completedAt = new Date(now).toISOString();
    activity(state, 'task-error', `Task failed after ${task.attempts} attempts: ${task.title}`, {taskId: task.id});
  } else {
    task.status = 'queued';
    task.lastError = error;
    task.runAt = new Date(retryDelay(task.attempts, now)).toISOString();
    activity(state, 'task-retry', `Task will retry: ${task.title}`, {taskId: task.id});
  }
  return task;
}

/** Requeue a task by hand: a failed run an operator wants to try again. */
export function retryTask(state, id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) fail('Task not found.', 404);
  if (!['failed', 'cancelled', 'done'].includes(task.status)) fail('This task is already queued or running.', 409);
  task.status = 'queued';
  task.runAt = new Date().toISOString();
  task.attempts = 0;
  task.lastError = null;
  task.result = null;
  task.updatedAt = new Date().toISOString();
  activity(state, 'task', `Requeued task: ${task.title}`, {taskId: task.id});
  return task;
}

export function cancelTask(state, id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) fail('Task not found.', 404);
  if (task.status === 'running') fail('A running task cannot be cancelled. Wait for it to finish.', 409);
  task.status = 'cancelled';
  task.updatedAt = new Date().toISOString();
  activity(state, 'task', `Cancelled task: ${task.title}`, {taskId: task.id});
  return task;
}

/** Convert passive legacy reminder schedules into runnable tasks. Idempotent:
 * once migrated, `state.schedules` is empty and never repopulated. Legacy rows
 * are shaped by hand rather than through `enqueueTask`'s validators, because a
 * disabled one-off whose date has passed is legitimate stored data that the
 * strict validator would rightly refuse for new input. */
export function migrateSchedules(state) {
  state.tasks ??= [];
  if (!Array.isArray(state.schedules) || !state.schedules.length) { state.schedules = []; return {migrated: 0}; }
  let migrated = 0;
  const stamp = () => new Date().toISOString();
  for (const item of state.schedules) {
    const idempotencyKey = `schedule:${item.id}`;
    // Already converted on an earlier run: leave it, and do not count it as a
    // new conversion in the report.
    if (state.tasks.some(t => t.idempotencyKey === idempotencyKey)) continue;
    const kind = item.kind === 'once' ? 'once' : 'interval';
    const label = cleanText(item.label, 200) || 'Reminder';
    const past = Date.parse(item.nextAt);
    const intervalMinutes = Number.isInteger(item.intervalMinutes) && item.intervalMinutes >= 1 && item.intervalMinutes <= 10080 ? item.intervalMinutes : null;
    const onceAt = Number.isFinite(past) && past > Date.now() + 1000 ? new Date(past).toISOString() : new Date(Date.now() + 60000).toISOString();
    const task = {
      id: crypto.randomUUID(), kind: 'reminder', title: label,
      payload: kind === 'once' ? {label, kind, nextAt: onceAt} : {label, kind, intervalMinutes: intervalMinutes ?? 60},
      status: 'queued',
      runAt: kind === 'once' ? onceAt : stamp(),
      intervalMinutes: kind === 'interval' ? (intervalMinutes ?? 60) : null,
      idempotencyKey, attempts: 0, maxAttempts: 5, leaseOwner: null, leaseUntil: null,
      lastError: null, result: null, createdBy: null, createdAt: stamp(), updatedAt: stamp(), completedAt: null,
    };
    // A disabled row, or a one-off whose time already passed, must not fire late.
    if (item.enabled === false || (kind === 'once' && Number.isFinite(past) && past <= Date.now())) {
      task.status = 'done';
      task.completedAt = stamp();
    }
    state.tasks.unshift(task);
    migrated++;
  }
  state.schedules = [];
  if (migrated) activity(state, 'migration', `Converted ${migrated} reminder(s) into structured tasks.`);
  return {migrated};
}

/** Tasks whose lease has expired (a crashed worker) are visible as interrupted
 * rather than silently stuck, and are re-armed for the next claim. */
export function recoverStalledTasks(state, now = Date.now()) {
  let recovered = 0;
  for (const task of state.tasks) {
    if (task.status !== 'running') continue;
    const leaseUntil = Date.parse(task.leaseUntil || 0);
    if (Number.isFinite(leaseUntil) && leaseUntil > now) continue; // still leased
    task.status = 'queued';
    task.lastError = 'Previous worker stopped before completing. Re-armed automatically.';
    task.leaseOwner = null;
    task.leaseUntil = null;
    task.runAt = new Date(now).toISOString();
    task.updatedAt = new Date(now).toISOString();
    recovered++;
  }
  if (recovered) activity(state, 'recovery', `Re-armed ${recovered} stalled task(s).`);
  return {recovered};
}
