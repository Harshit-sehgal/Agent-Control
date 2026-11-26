/** Event triggers on the server: the owner's triggers, and what happens when an outside event arrives.
 *
 * A trigger is stored in the workspace (`state.triggers`, kv `triggers`). Its secret lives in the vault as a
 * credential, because HMAC needs the secret itself: a hash would not verify GitHub's signature. The secret is
 * shown once, when the trigger is made or its secret rotated.
 *
 * `receiveEvent` is the one path an outside sender reaches. Its checks run in this order, and each stops the
 * rest: the trigger exists and is on, the signature matches, the body is JSON, the kill switch is off, the
 * condition matches, the body is new, the cooldown has passed. Only then does a bot-task get queued.
 */
import crypto from 'node:crypto';
import * as tasks from '../shared/tasks.js';
import {MAX_SEEN, DEDUP_MS, eventMatches, eventMessage, normalizeTrigger} from '../shared/triggers.js';
import {addCredential, deleteCredential, replaceValue, revealValue} from './credentials.js';
import {fail} from './http.js';

const ensureTriggers = state => { if (!Array.isArray(state.triggers)) state.triggers = []; return state.triggers; };
const findTrigger = (state, id) => ensureTriggers(state).find(t => t.id === id) || null;
export const eventPath = (workspaceId, triggerId) => `/api/events/${workspaceId}/${triggerId}`;
const freshSecret = () => crypto.randomBytes(32).toString('hex');

/** What the owner may see of a trigger: never the secret. */
export function triggerView(trigger, workspaceId) {
  return {
    id: trigger.id, name: trigger.name, botId: trigger.botId, groupId: trigger.groupId, instruction: trigger.instruction,
    match: trigger.match || null, cooldownMinutes: trigger.cooldownMinutes || 0, enabled: trigger.enabled !== false,
    fired: trigger.fired || 0, lastFiredAt: trigger.lastFiredAt || null, createdAt: trigger.createdAt,
    path: eventPath(workspaceId, trigger.id),
  };
}

export function listTriggers(state, workspaceId) {
  return (Array.isArray(state.triggers) ? state.triggers : []).map(t => triggerView(t, workspaceId));
}

function assertBot(state, groupId, botId) {
  const group = (state.groups || []).find(g => g.id === groupId);
  if (!group || !(group.bots || []).some(b => b.id === botId)) fail('That bot or group no longer exists.', 404);
}

/** Make a trigger. Returns the view and the secret, which is shown only now. */
export async function createTrigger(store, workspaceId, input, {createdBy = null} = {}) {
  const spec = normalizeTrigger(input);
  assertBot(store.read(), spec.groupId, spec.botId);
  const secret = freshSecret();
  const {id: secretId} = addCredential(store, workspaceId, {name: `Event secret: ${spec.name}`, kind: 'event_secret', value: secret, createdBy});
  const trigger = {
    id: crypto.randomUUID(), ...spec, enabled: true, secretId, seen: {}, fired: 0, lastFiredAt: null,
    createdAt: new Date().toISOString(), createdBy,
  };
  await store.update(s => { ensureTriggers(s).push(trigger); });
  return {trigger: triggerView(trigger, workspaceId), secret};
}

export async function setTriggerEnabled(store, workspaceId, id, enabled) {
  const view = await store.update(s => {
    const trigger = findTrigger(s, id) || fail('Trigger not found.', 404);
    trigger.enabled = enabled === true;
    return triggerView(trigger, workspaceId);
  });
  return {trigger: view};
}

/** A new secret for one trigger. The old one stops working at once. Returned once. */
export async function rotateTriggerSecret(store, workspaceId, id) {
  const trigger = findTrigger(store.read(), id) || fail('Trigger not found.', 404);
  const secret = freshSecret();
  replaceValue(store, trigger.secretId, secret);
  return secret;
}

export async function removeTrigger(store, workspaceId, id) {
  const trigger = findTrigger(store.read(), id) || fail('Trigger not found.', 404);
  await store.update(s => { s.triggers = ensureTriggers(s).filter(t => t.id !== id); });
  try { deleteCredential(store, workspaceId, trigger.secretId); } catch { /* the trigger is gone either way */ }
  return {ok: true};
}

/** The HMAC-SHA256 of the raw body, compared in constant time. */
function signatureOk(secret, raw, signature) {
  const want = Buffer.from(`sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}`);
  const got = Buffer.from(String(signature || ''));
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Keep the dedup records inside their window, and at most MAX_SEEN of the newest. */
function freshSeen(seen, now) {
  const alive = Object.entries(seen || {}).filter(([, at]) => now - at < DEDUP_MS).sort((a, b) => b[1] - a[1]).slice(0, MAX_SEEN);
  return Object.fromEntries(alive);
}

/** One outside event. Returns the HTTP status and a body; never throws on a bad event. */
// Every refusal is the same answer, so an outside caller cannot tell an unknown, a disabled or a wrong-secret trigger
// apart. The refusals that skip a real check still run one against a decoy key, so the time taken does not differ.
const DECOY_SECRET = crypto.randomBytes(32).toString('hex');
const refused = () => ({status: 401, body: {error: 'The signature does not match.'}});
export async function receiveEvent(store, {triggerId, raw, signature, event = null, now = Date.now(), reveal = id => revealValue(store, id)}) {
  const known = findTrigger(store.read(), triggerId);
  if (!known || known.enabled === false) { signatureOk(DECOY_SECRET, raw, signature); return refused(); }
  let secret;
  try { secret = reveal(known.secretId); } catch { signatureOk(DECOY_SECRET, raw, signature); return refused(); }
  if (!signatureOk(secret, raw, signature)) return refused();
  // GitHub sends a ping when a webhook is made. It is signed, but it is not an event: nothing starts.
  if (String(event || '').toLowerCase() === 'ping') return {status: 202, body: {status: 'ignored', reason: 'A ping from the sender. Nothing was started.'}};
  let payload;
  try { payload = JSON.parse(raw); } catch { return {status: 400, body: {error: 'The body must be JSON.'}}; }
  if (!payload || typeof payload !== 'object') return {status: 400, body: {error: 'The body must be a JSON object.'}};
  const key = crypto.createHash('sha256').update(raw).digest('hex');
  // The checks and the write run inside one update, so two copies of an event cannot both pass the dedup check.
  return store.update(s => {
    const trigger = findTrigger(s, triggerId);
    if (!trigger || trigger.enabled === false) return refused();
    if (s.schedulesPaused === true) return {status: 202, body: {status: 'held', reason: 'Schedules are paused (kill switch). Nothing was started.'}};
    if (!eventMatches(trigger.match, payload)) return {status: 202, body: {status: 'ignored', reason: 'The event does not meet the trigger condition.'}};
    trigger.seen = freshSeen(trigger.seen, now);
    if (trigger.seen[key] !== undefined) return {status: 202, body: {status: 'duplicate'}};
    if (trigger.lastFiredAt && now - Date.parse(trigger.lastFiredAt) < (trigger.cooldownMinutes || 0) * 60000) return {status: 202, body: {status: 'cooldown'}};
    const {task} = tasks.enqueueTask(s, {
      kind: 'bot-task', title: `Event: ${trigger.name}`,
      // A one-off run starts a moment from now: the task queue refuses a time less than a second ahead.
      // `source: 'event'` makes Hands-off stop covering this run's sends (shared/asks.js): its text came from outside.
      payload: {groupId: trigger.groupId, botId: trigger.botId, message: eventMessage(trigger, raw), kind: 'once', nextAt: new Date(Date.now() + 2000).toISOString(), source: 'event'},
    });
    trigger.seen = {...trigger.seen, [key]: now};
    trigger.lastFiredAt = new Date(now).toISOString();
    trigger.fired = (trigger.fired || 0) + 1;
    return {status: 202, body: {status: 'queued', taskId: task.id}};
  });
}
