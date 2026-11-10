/** Structured, runnable tasks (the durable queue's document side).
 *
 * The prototype stored reminders as passive text events fired by the scheduler
 * tick. Anything with retries, leases, idempotency or an agent execution needs
 * a real record: a kind, a validated payload, a status, attempts and a lease.
 * These transitions are pure and mirror `workflow.js`: the Node worker and the
 * browser-local demo both run them, so the two backends cannot drift.
 */
import {activity, cleanText} from './core.js?v=a9bafba092';

export const MAX_ATTEMPTS_DEFAULT = 5;

/** Wall-clock retry budget: a task keeps retrying until this long after the
 * first failure of the current run, however many attempts that takes. Five
 * attempts on the 1s-5min ladder is about fifteen seconds, and any outage
 * longer than that (a webhook 502, a greylisted SMTP relay, a provider having a
 * bad afternoon) used to end the task — which for a recurring schedule means
 * ending the schedule. Six hours covers an overnight outage; past it the task
 * is either broken or the outage is somebody's incident, and a recurring task
 * re-arms for its next window instead of giving up for good. */
export const RETRY_WINDOW_MS = 6 * 3600000;

/** Where that window starts. The tasks row has no column for retry-session
 * state and the payload is the only part of the row that survives a restart
 * verbatim, so the anchor lives there. Every payload validator builds a fresh
 * object, so this is scheduling metadata a caller cannot set. */
export const RETRY_STARTED = 'retryStartedAt';

/** Drop the anchor once a run succeeds or is re-armed by hand: a stale one
 * would make the next failure look like it was already spent. */
function clearRetryAnchor(task) {
  if (!task.payload || typeof task.payload !== 'object' || !(RETRY_STARTED in task.payload)) return;
  const {[RETRY_STARTED]: _spent, ...rest} = task.payload;
  task.payload = rest;
}

/** Payload validators per kind. Unknown kinds are refused, so a stale UI or a
 * crafted request cannot enqueue a kind the worker does not know how to run. */
const PAYLOAD_KINDS = {
  reminder: body => {
    // Name the schedule kinds: a rejected reminder used to say only that a
    // "valid schedule kind" was required without saying which ones are.
    if (!['once', 'interval'].includes(body.kind)) throw fail(`A valid schedule kind is required: ${SCHEDULE_KINDS.join(' or ')}.`, 400);
    const kind = body.kind;
    const label = cleanText(body.label, 200);
    if (!label) throw fail('A reminder needs a label.', 400);
    return {label, ...timing(body)};
  },
  'bot-task': body => {
    const groupId = cleanText(body.groupId, 64);
    if (!groupId) fail('A scheduled bot task needs a group.');
    if (body.botId !== undefined && body.botId !== null && typeof body.botId !== 'string') fail('Bot id must be text.');
    const botId = cleanText(body.botId, 64) || null;
    const message = typeof body.message === 'string' ? body.message.trim() : '';
    if (!message) fail('A scheduled bot task needs a message.');
    if (message.length > 2000) fail('The message must be 2000 characters or fewer.');
    if (!['once', 'interval'].includes(body.kind)) fail('Choose once or interval.');
    return {groupId, botId, message, label: cleanText(body.label, 200) || message.slice(0, 60), ...timing(body)};
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

/** The schedule part shared by reminders and scheduled bot tasks. */
function timing(body) {
  if (body.kind === 'once') {
    const when = Date.parse(body.nextAt);
    if (!Number.isFinite(when) || when < Date.now() + 1000 || when > Date.now() + 365 * 86400000) fail('Choose a future date within one year.');
    return {kind: 'once', nextAt: new Date(when).toISOString()};
  }
  const intervalMinutes = Number(body.intervalMinutes);
  if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080) fail('Interval must be 1\u201310080 minutes.');
  return {kind: 'interval', intervalMinutes};
}
const SCHEDULED = ['reminder', 'bot-task'];
/** The kinds a one-off or repeating schedule may name, in the order the error
 * message lists them. */
const SCHEDULE_KINDS = ['once', 'interval'];

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
  // `hasOwn`, not truthiness: `constructor`, `toString` and `valueOf` are
  // functions on the prototype, so a bare lookup accepted them as kinds, skipped
  // payload validation, and shipped the row to the floor where `Object` happily
  // "completed" it.
  const validate = Object.hasOwn(PAYLOAD_KINDS, kind) ? PAYLOAD_KINDS[kind] : null;
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
  if (kind === 'bot-task') {
    const group = (state.groups || []).find(g => g.id === payload.groupId);
    if (!group || (payload.botId && !group.bots.some(b => b.id === payload.botId))) fail('That bot or group no longer exists.', 404);
  }
  // Only a schedule may repeat, and only at a length its validator already
  // bounded. The old fallback took `body.intervalMinutes` for *every* kind with no
  // bound, so a stray field turned a one-off group run into an unbounded recurring
  // spend, and `1e15` made `new Date(now + n * 60000)` invalid: `completeTask` threw,
  // the row stayed `running`, the sweep re-claimed it and ran the paid work again,
  // forever.
  const intervalMinutes = payload.kind === 'interval' ? Number(payload.intervalMinutes) : null;
  if (intervalMinutes !== null && (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080)) fail('Interval must be 1\u201310080 minutes.');
  if (idempotencyKey) {
    const existing = state.tasks.find(t => t.idempotencyKey === idempotencyKey);
    if (existing && existing.status !== 'cancelled') return {task: existing, duplicate: true};
    if (existing) {
      // A cancelled task keeps its key (see cancelTask), so asking for the same
      // intent again has to re-open that row rather than insert a second one:
      // the store's unique index on the key refuses the duplicate and takes
      // every later write of the document down with it. Re-opening keeps one
      // row per key for good, and the work runs on the fresh timing the caller
      // just gave.
      existing.kind = kind;
      existing.title = cleanText(body.title, 200) || taskTitle(kind, payload);
      existing.payload = payload;
      existing.status = 'queued';
      existing.runAt = payload.nextAt || new Date().toISOString();
      existing.intervalMinutes = intervalMinutes;
      existing.attempts = 0;
      existing.maxAttempts = Math.max(1, Math.min(20, Number(body.maxAttempts) || MAX_ATTEMPTS_DEFAULT));
      existing.leaseOwner = null;
      existing.leaseUntil = null;
      existing.lastError = null;
      existing.result = null;
      existing.completedAt = null;
      existing.updatedAt = new Date().toISOString();
      activity(state, 'task', `Re-queued task: ${existing.title}`, {taskId: existing.id});
      return {task: existing, duplicate: false};
    }
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
  'bot-task': `Scheduled: ${payload.label}`,
})[kind] || kind;

/** Claim due tasks for execution. Leases are what make execution durable: a
 * crashed worker's task is visibly stale and can be re-claimed by anyone. */
export function claimTasks(state, {workerId, now = Date.now(), limit = 5, leaseMs = 60000, leaseTTL = leaseMs} = {}) {
  if (!workerId) fail('A worker id is required to claim tasks.', 500);
  // One lease window, one meaning, and its length is the caller's: the old
  // `leaseTTL = 60000` default then overwrote an explicit TTL with the defaulted
  // `leaseMs`, so a queue configured for a 1.5 s lease got a 60 s first window.
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
  // Removed while this attempt was in flight. Completing it would re-arm an
  // interval against a bot or group that is already gone.
  if (task.status === 'cancelled') return task;
  if (task.status !== 'running') fail('Only a running task can be completed.', 409);
  task.status = 'done';
  task.result = result ?? null;
  task.completedAt = new Date(now).toISOString();
  task.updatedAt = task.completedAt;
  task.leaseOwner = null;
  task.leaseUntil = null;
  task.lastError = null;
  clearRetryAnchor(task);
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
 * attempts remain, and only then to `failed`. A 409 conflict (a busy group
 * run) keeps that backoff past the budget instead of ending the task. */
export function failTask(state, id, message, now = Date.now(), {conflict = false, permanent = false} = {}) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) fail('Task not found.', 404);
  if (task.status === 'cancelled') return task;
  if (task.status !== 'running') fail('Only a running task can fail.', 409);
  const error = String(message || 'Unknown error').slice(0, 400);
  task.leaseOwner = null;
  task.leaseUntil = null;
  task.updatedAt = new Date(now).toISOString();
  // The window is measured from the first failure of this run, not from
  // `createdAt`: a recurring task keeps its id for months, and a long-lived one
  // must still get a full budget when today's provider hiccups.
  if (!Number.isFinite(Number(task.payload?.[RETRY_STARTED]))) {
    task.payload = {...(task.payload || {}), [RETRY_STARTED]: now};
  }
  const spent = now - Number(task.payload[RETRY_STARTED]) >= RETRY_WINDOW_MS;
  // A busy group run outlasts both budgets. A 409 must wait it out instead of
  // being the error that marks the task failed. A permanent miss (the bot or
  // group is gone) fails on this attempt.
  // A conflict waits out the attempt count, but not the window: a group parked on
  // a checkpoint made every task for it spin at five-minute intervals with nothing
  // recorded and nothing said. Once the six hours are gone the task says why.
  if (permanent || (spent && (conflict || task.attempts >= task.maxAttempts))) {
    // A recurring task that ran out of budget missed windows, it did not
    // retire: the schedule is the point of the task, so it re-arms for its
    // next window with a fresh budget and keeps the error visible until a run
    // succeeds. A permanent miss stays failed — a deleted group is not an
    // outage — and is retried by hand if it comes back.
    if (task.intervalMinutes && !permanent) {
      clearRetryAnchor(task);
      task.status = 'queued';
      task.lastError = error;
      task.runAt = new Date(now + task.intervalMinutes * 60000).toISOString();
      task.completedAt = null;
      task.attempts = 0;
      activity(state, 'task-retry', `Task missed its window and will run again at its next one: ${task.title}`, {taskId: task.id});
    } else {
      task.status = 'failed';
      task.lastError = error;
      task.completedAt = new Date(now).toISOString();
      activity(state, 'task-error', `Task failed after ${task.attempts} attempts: ${task.title}`, {taskId: task.id});
    }
  } else {
    task.status = 'queued';
    task.lastError = error;
    task.runAt = new Date(retryDelay(task.attempts, now)).toISOString();
    activity(state, 'task-retry', `Task will retry: ${task.title}`, {taskId: task.id});
  }
  return task;
}

/** Requeue a task by hand: a failed run an operator wants to try again. A
 * cancelled task stays cancelled, and a done one has nothing to retry. */
export function retryTask(state, id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) fail('Task not found.', 404);
  if (task.status === 'cancelled') fail('A cancelled task cannot be retried. Enqueue a new one.', 409);
  if (task.status !== 'failed') fail('Only a failed task can be retried.', 409);
  task.status = 'queued';
  task.runAt = new Date().toISOString();
  task.attempts = 0;
  task.lastError = null;
  task.result = null;
  task.updatedAt = new Date().toISOString();
  clearRetryAnchor(task);
  // A reminder carries its next fire in the payload too, and a stale `nextAt`
  // would make the retried run report itself as overdue on the way in.
  if (task.payload && typeof task.payload === 'object' && task.payload.nextAt) task.payload = {...task.payload, nextAt: task.runAt};
  activity(state, 'task', `Requeued task: ${task.title}`, {taskId: task.id});
  return task;
}

export function cancelTask(state, id) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) fail('Task not found.', 404);
  if (task.status === 'running') fail('A running task cannot be cancelled. Wait for it to finish.', 409);
  task.status = 'cancelled';
  // The key stays on the row on purpose. The store's unique index is what makes
  // a duplicate submission impossible, and `enqueueTask` re-opens a cancelled
  // row that still holds the key instead of inserting a second one. Dropping
  // the key here would let a replayed legacy schedule (`schedule:<id>`, see
  // migrateSchedules) resurrect work a person cancelled.
  clearRetryAnchor(task);
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
    const kind = item.kind === 'once' ? 'once' : 'interval';
    const label = cleanText(item.label, 200) || 'Reminder';
    const past = Date.parse(item.nextAt);
    const intervalMinutes = Number.isInteger(item.intervalMinutes) && item.intervalMinutes >= 1 && item.intervalMinutes <= 10080 ? item.intervalMinutes : null;
    const onceAt = Number.isFinite(past) && past > Date.now() + 1000 ? new Date(past).toISOString() : new Date(Date.now() + 60000).toISOString();
    // A future interval keeps its next fire. Starting it at `now` would run
    // a reminder that was not due yet. An overdue one is due immediately.
    const runAt = kind === 'once' ? onceAt : (Number.isFinite(past) && past > Date.now() ? new Date(past).toISOString() : stamp());
    const existing = state.tasks.find(t => t.idempotencyKey === idempotencyKey);
    if (existing) {
      // Already converted on an earlier run, and do not count it as a new
      // conversion in the report. A cancelled one stays cancelled: the person
      // who cancelled it meant it, and re-creating a reminder they removed is
      // worse than a stale legacy row. A failed one only spent a retry budget,
      // and the legacy schedule is the record that says it should still fire,
      // so re-arm the row it already owns — a second row under the same key is
      // forbidden by the store's unique index.
      if (existing.status !== 'failed') continue;
      existing.status = 'queued';
      existing.runAt = runAt;
      existing.attempts = 0;
      existing.lastError = null;
      existing.completedAt = null;
      existing.updatedAt = stamp();
      clearRetryAnchor(existing);
      migrated++;
      continue;
    }
    const task = {
      id: crypto.randomUUID(), kind: 'reminder', title: label,
      payload: kind === 'once' ? {label, kind, nextAt: onceAt} : {label, kind, intervalMinutes: intervalMinutes ?? 60},
      status: 'queued',
      runAt,
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
