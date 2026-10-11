/** Notifications: in-app by default, opt-in webhook/email relay.
 *
 * The dashboard used to log everything to the Activity feed, which only
 * reaches someone staring at the page. This module turns notable events
 * (reminders, failed tasks, revoked agents, disputed evidence blocking an
 * approval) into per-user notifications.
 *
 * Channels:
 * - `in_app` is always recorded; it needs no external service.
 * - `webhook` POSTs the payload to a URL stored in the encrypted credential
 *   vault path of the preferences... stored in plaintext preferences is
 *   avoided: the URL often contains a token, so it is stored encrypted in the
 *   credentials table and referenced here by id.
 * - `email` records a relay-ready notification; actual delivery needs an
 *   external SMTP/gateway this project does not embed (zero-dependency
 *   constraint), so the preference and the record exist and the transport is
 *   documented rather than fake.
 *
 * Delivery is durable: outbound notifications are queue tasks with the same
 * retry/backoff rules as everything else, and a failure never claims success.
 */
import crypto from 'node:crypto';
import {encryptJson, decryptJson} from './vault.js';

const now = () => new Date().toISOString();
const MAX_IN_APP = 200;

export const CHANNELS = ['in_app', 'webhook', 'email'];

export function fail(message, status = 400) { throw Object.assign(new Error(message), {status}); }

export function getPreferences(store, userId) {
  const row = store.get('SELECT * FROM notification_prefs WHERE user_id=?', userId);
  if (!row) return {inApp: true, webhook: false, webhookCredentialId: null, email: false, emailAddress: ''};
  return {
    inApp: Boolean(row.in_app), webhook: Boolean(row.webhook), webhookCredentialId: row.webhook_url || null,
    email: Boolean(row.email), emailAddress: row.email_address || '',
  };
}

export function updatePreferences(store, userId, body) {
  const current = getPreferences(store, userId);
  const next = {
    inApp: body.inApp === undefined ? current.inApp : Boolean(body.inApp),
    webhook: body.webhook === undefined ? current.webhook : Boolean(body.webhook),
    webhookCredentialId: body.webhookCredentialId === undefined ? current.webhookCredentialId : (body.webhookCredentialId || null),
    email: body.email === undefined ? current.email : Boolean(body.email),
    emailAddress: body.emailAddress === undefined ? current.emailAddress : String(body.emailAddress || '').slice(0, 200),
  };
  // A webhook channel needs a credential holding the URL; the URL itself is
  // never stored in the preferences table.
  if (next.webhook && !next.webhookCredentialId) fail('Webhook notifications need a stored credential holding the webhook URL.', 400);
  if (next.email && !next.emailAddress) fail('Email notifications need an email address.', 400);
  if (next.webhookCredentialId) {
    const credential = store.get('SELECT id FROM credentials WHERE id=?', next.webhookCredentialId);
    if (!credential) fail('The selected webhook credential was not found.', 404);
  }
  store.run(`INSERT INTO notification_prefs (user_id,in_app,webhook,webhook_url,email,email_address,updated_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET
    in_app=excluded.in_app, webhook=excluded.webhook, webhook_url=excluded.webhook_url,
    email=excluded.email, email_address=excluded.email_address, updated_at=excluded.updated_at`,
    userId, next.inApp ? 1 : 0, next.webhook ? 1 : 0, next.webhookCredentialId, next.email ? 1 : 0, next.emailAddress, now());
  return next;
}

/** Record an in-app notification immediately (durable row), and enqueue
 * outbound delivery for the opt-in channels through the task queue. */
export function notify(store, queue, {workspaceId = 'default', userId, title, body, kind = 'event', meta = {}, channels}) {
  const prefs = userId ? getPreferences(store, userId) : {inApp: true, webhook: false, email: false};
  const wanted = channels || CHANNELS.filter(c => prefs[c === 'in_app' ? 'inApp' : c]);
  const id = crypto.randomUUID();
  if (prefs.inApp || wanted.includes('in_app')) {
    store.run(`INSERT INTO notifications (id,workspace_id,user_id,channel,title,body,meta,status,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, id, workspaceId || null, userId || null, 'in_app',
      String(title).slice(0, 200), String(body || '').slice(0, 2000), JSON.stringify(meta || {}), 'delivered', now());
    // Bound the in-app feed; oldest goes first so the newest stays readable.
    const overflow = store.all(
      `SELECT id FROM notifications WHERE channel='in_app' AND (user_id IS NULL OR user_id=?) ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
      userId || null, MAX_IN_APP);
    for (const row of overflow) store.run('DELETE FROM notifications WHERE id=?', row.id);
  }
  // Outbound channels become durable queue tasks rather than inline fetches,
  // so a webhook outage retries with backoff instead of being lost.
  for (const channel of wanted) {
    if (channel === 'in_app') continue;
    const notifier = channel === 'webhook'
      ? prefs.webhookCredentialId
      : prefs.emailAddress;
    if (!notifier) continue;
    if (queue) queue(store, {
      kind: 'notification',
      payload: {notificationId: id, channel, target: notifier, title, body, meta},
      idempotencyKey: `notify:${channel}:${id}`,
    });
    else {
      // No queue available (browser demo context): record the attempt so the
      // status is visible rather than pretending it was sent.
      store.run(`INSERT INTO notifications (id,workspace_id,user_id,channel,title,body,meta,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, crypto.randomUUID(), workspaceId || null, userId || null, channel,
        String(title).slice(0, 200), String(body || '').slice(0, 2000), JSON.stringify(meta || {}), 'queued', now());
    }
  }
  return id;
}

/** Deliver one queued notification. Throws to trigger the queue's retry. */
export async function deliver(store, task) {
  const {channel, target, title, body, meta} = task.payload;
  if (channel === 'webhook') {
    const row = store.get('SELECT * FROM credentials WHERE id=?', target);
    if (!row) throw new Error('Webhook credential no longer exists.');
    let url;
    try { url = decryptJson(store.vaultKey, {ciphertext: row.ciphertext, iv: row.iv, tag: row.tag}).value; }
    catch { throw new Error('Webhook credential cannot be decrypted with the current MASTER_KEY.'); }
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Webhook URL must be http(s).');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(url, {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({title, body, meta, at: now()}),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Webhook responded ${res.status}.`);
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('Webhook delivery timed out.');
      throw e;
    } finally { clearTimeout(timer); }
    return {delivered: 'webhook'};
  }
  if (channel === 'email') {
    // Honest limitation: delivering mail needs an SMTP client or gateway this
    // zero-dependency project does not embed. Record that it is waiting on a
    // relay rather than claiming it was sent.
    return {delivered: 'email-pending-relay', note: 'Configure an external relay to deliver.'};
  }
  throw new Error(`Unknown notification channel "${String(channel).slice(0, 40)}".`);
}

export function listNotifications(store, userId, limit = 50) {
  return store.all(
    `SELECT * FROM notifications WHERE user_id IS NULL OR user_id=? ORDER BY created_at DESC LIMIT ?`,
    userId, Math.max(1, Math.min(200, limit)));
}

export function markRead(store, userId, ids) {
  const list = Array.isArray(ids) ? ids.slice(0, 100) : [];
  if (!list.length) return {marked: 0};
  let marked = 0;
  for (const id of list) {
    marked += store.run(
      `UPDATE notifications SET status='read' WHERE id=? AND (user_id IS NULL OR user_id=?) AND status<>'read'`,
      id, userId).changes;
  }
  return {marked};
}

export function unreadCount(store, userId) {
  return store.get(
    `SELECT count(*) AS n FROM notifications WHERE (user_id IS NULL OR user_id=?) AND status<>'read'`, userId).n;
}
