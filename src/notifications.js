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
 * - `email` speaks SMTP itself when `SMTP_HOST` is set (`src/mail.js`), so a
 *   mailbox needs no gateway. `EMAIL_RELAY_URL` remains for an HTTP(S) relay:
 *   it POSTs `{to, title, body, meta, at}`, and an optional `EMAIL_RELAY_TOKEN`
 *   is sent as `Authorization: Bearer` only over HTTPS. SMTP wins when both are
 *   configured. With neither, delivery throws so the queue retries instead of
 *   claiming the message was sent.
 *
 * Delivery is durable: outbound notifications are queue tasks with the same
 * retry/backoff rules as everything else, and a failure never claims success.
 */
import {resolvePublicAddress, pinnedRequest} from '../agent/net-guard.mjs';
import crypto from 'node:crypto';
import {encryptJson, decryptJson} from './vault.js';
import {smtpConfig, sendMail} from './mail.js';
import {MAX_ATTEMPTS_DEFAULT} from '../shared/tasks.js';

const now = () => new Date().toISOString();
const MAX_IN_APP = 200;
const isEmailAddress = value => typeof value === 'string' && value.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const privateRelayAllowed = () => process.env.WEBHOOK_ALLOW_PRIVATE === '1';
async function postPublic(url, {headers, body} = {}) {
  const {address} = await resolvePublicAddress(url, {allowPrivate: privateRelayAllowed()});
  return pinnedRequest(url, {address, method: 'POST', headers, body, timeoutMs: 10000});
}

function redactSecrets(message, secrets) {
  let text = String(message || 'Email delivery failed.');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) text = text.split(secret).join('[redacted]');
  }
  return text;
}

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
  if (next.email && !isEmailAddress(next.emailAddress)) fail('Email notifications need a valid email address.', 400);
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

/** Record one notification row on one channel, and enqueue outbound delivery
 * for the opt-in channels through the task queue. Every channel gets its own
 * row: a single shared row let the in-app copy's `delivered` stand for an email
 * that never left, and one `sent_at` claimed both had gone. */
export function notify(store, queue, {workspaceId = 'default', userId, title, body, kind = 'event', meta = {}, channels}) {
  const prefs = userId ? getPreferences(store, userId) : {inApp: true, webhook: false, email: false};
  const wanted = channels || CHANNELS.filter(c => prefs[c === 'in_app' ? 'inApp' : c]);
  const id = crypto.randomUUID();
  const insert = (rowId, channel, status) => store.run(`INSERT INTO notifications (id,workspace_id,user_id,channel,title,body,meta,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, rowId, workspaceId || null, userId || null, channel,
    String(title).slice(0, 200), String(body || '').slice(0, 2000), JSON.stringify(meta || {}), status, now());
  if (prefs.inApp || wanted.includes('in_app')) {
    insert(id, 'in_app', 'delivered');
    // Bound the in-app feed; oldest goes first so the newest stays readable.
    // created_at is only millisecond-precise, so rowid breaks ties: the row
    // just inserted has the highest rowid and must not be the one deleted.
    // Global rows (user_id IS NULL, seen by everyone) and a user's own rows are
    // capped separately, so one busy user cannot evict a shared notice.
    const trim = (where, params) => {
      const overflow = store.all(`SELECT id FROM notifications WHERE channel='in_app' AND ${where} ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?`, ...params, MAX_IN_APP);
      for (const row of overflow) store.run('DELETE FROM notifications WHERE id=?', row.id);
    };
    if (userId) trim('user_id=?', [userId]);
    trim('user_id IS NULL', []);
  }
  // Outbound channels become durable queue tasks rather than inline fetches,
  // so a webhook outage retries with backoff instead of being lost.
  for (const channel of wanted) {
    if (channel === 'in_app') continue;
    const notifier = channel === 'webhook'
      ? prefs.webhookCredentialId
      : prefs.emailAddress;
    if (!notifier) continue;
    const rowId = crypto.randomUUID();
    insert(rowId, channel, 'queued');
    // No queue available (browser demo context): the row itself records the
    // attempt rather than pretending it was sent.
    if (!queue) continue;
    const spec = {
      kind: 'notification',
      payload: {notificationId: rowId, channel, target: notifier, title, body, meta},
      idempotencyKey: `notify:${channel}:${rowId}`,
    };
    // A task that never lands leaves no retry behind, so the row must stop
    // reading `queued` as if one were coming.
    const failed = error => {
      const message = String(error?.message ?? error ?? 'The delivery task was not queued.').slice(0, 400);
      console.error('Notification enqueue:', message);
      setStatus(store, rowId, channel, 'failed', message);
    };
    let pending;
    try { pending = queue(store, spec); } catch (error) { failed(error); continue; }
    Promise.resolve(pending).then(result => { if (result?.enqueued === false) failed(result.error); }, failed);
  }
  return id;
}

/** Move one channel's own row and nothing else. The channel is part of the
 * WHERE clause so a task can never report on a row it does not own. */
function setStatus(store, id, channel, status, error = null) {
  if (!id) return false;
  try {
    if (error) {
      store.run(`UPDATE notifications SET status=?, meta=json_set(CASE WHEN json_valid(meta) THEN meta ELSE '{}' END,'$.deliveryError',?) WHERE id=? AND channel=?`,
        status, String(error).slice(0, 400), id, channel);
    } else {
      store.run(`UPDATE notifications SET status=?, sent_at=? WHERE id=? AND channel=?`, status, now(), id, channel);
    }
    return true;
  } catch (e) {
    // Delivery already happened; a row that could not be updated is a display
    // problem, not a reason to retry the send.
    console.error('Notification status:', e.message);
    return false;
  }
}

/** Deliver one queued notification. Throws to trigger the queue's retry, and
 * writes the outcome on this channel's own row: `sent` when it left, `failed`
 * only when the queue has no attempt left, and `queued` while a retry is still
 * coming, so the feed never claims a delivery that is still in doubt. */
export async function deliver(store, task) {
  const {channel} = task.payload;
  const id = task.payload.notificationId;
  try {
    const result = await deliverOnce(store, task);
    setStatus(store, id, channel, 'sent');
    return result;
  } catch (error) {
    const spent = Number(task.attempts || 0) >= Number(task.maxAttempts ?? MAX_ATTEMPTS_DEFAULT);
    if (spent) setStatus(store, id, channel, 'failed', error?.message);
    throw error;
  }
}

/** One delivery attempt, channel by channel. */
async function deliverOnce(store, task) {
  const {channel, target, title, body, meta} = task.payload;
  if (channel === 'webhook') {
    const row = store.get('SELECT * FROM credentials WHERE id=?', target);
    if (!row) throw new Error('Webhook credential no longer exists.');
    if (row.expires_at && Date.parse(row.expires_at) < Date.now()) throw new Error('Webhook credential has expired.');
    let url;
    try { url = decryptJson(store.vaultKey, {ciphertext: row.ciphertext, iv: row.iv, tag: row.tag}).value; }
    catch { throw new Error('Webhook credential cannot be decrypted with the current MASTER_KEY.'); }
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Webhook URL must be http(s).');
    // Connect to the same public address the guard checked. A plain fetch
    // would resolve the hostname again and leave a DNS rebinding window.
    const res = await postPublic(url, {
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({title, body, meta, at: now()}),
    });
    if (res.status < 200 || res.status >= 300) throw new Error(`Webhook responded ${res.status}.`);
    return {delivered: 'webhook'};
  }
  if (channel === 'email') {
    if (!isEmailAddress(target)) throw new Error('Email recipient is not a valid address.');
    // A configured mailbox first: the app speaks SMTP itself, so the common
    // case needs no relay at all. The relay stays for a gateway someone already
    // runs, and SMTP winning keeps one path in charge when both are set.
    const mail = smtpConfig();
    if (mail) {
      try {
        await sendMail({to: target, subject: title ?? 'Agent Control', text: body ?? ''}, mail);
      } catch (e) {
        // The recipient address and the credentials never belong in an error
        // that ends up in the notification feed.
        throw new Error(redactSecrets(`Email delivery failed: ${e?.message || 'SMTP error.'}`, [mail.pass, mail.user, target]));
      }
      return {delivered: 'email'};
    }
    const relay = process.env.EMAIL_RELAY_URL || '';
    if (!relay) {
      // No mailbox and no gateway: fail the queue task. Completing it would mark
      // mail sent that never left. Operators set SMTP_HOST or EMAIL_RELAY_URL,
      // or switch the channel off.
      throw new Error('Email delivery needs an external relay or a mailbox: set SMTP_HOST (or EMAIL_RELAY_URL). Switch the email channel off to stop trying.');
    }
    let parsed;
    try { parsed = new URL(relay); }
    catch { throw new Error('Email relay URL must be http(s).'); }
    const token = process.env.EMAIL_RELAY_TOKEN || '';
    // Draft content travels in this POST: https, or an explicit private-network
    // relay (WEBHOOK_ALLOW_PRIVATE). Never cleartext on a public host.
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Email relay URL must be http(s).');
    if (parsed.protocol !== 'https:' && !(process.env.WEBHOOK_ALLOW_PRIVATE === '1' && !token)) throw new Error('Email relay URL must use https.');
    const headers = {'Content-Type': 'application/json'};
    if (token) headers.Authorization = `Bearer ${token}`;
    const secrets = [token, relay, parsed.host, parsed.hostname, target];
    try {
      const res = await postPublic(relay, {
        headers,
        body: JSON.stringify({to: target, title: title ?? null, body: body ?? null, meta: meta ?? null, at: now()}),
      });
      if (res.status < 200 || res.status >= 300) throw new Error(`Email relay responded ${res.status}.`);
    } catch (e) {
      const message = String(e?.message || '').toLowerCase().includes('timed out') ? 'Email delivery timed out.' : e?.message;
      throw new Error(redactSecrets(message, secrets));
    }
    return {delivered: 'email'};
  }
  throw new Error(`Unknown notification channel "${String(channel).slice(0, 40)}".`);
}

/** Who has already read this row. A workspace-wide row (no user) is one record
 * seen by every member, so each member's read lives in meta and a later
 * delivery status update cannot make it unread again. */
function readBy(row) {
  try {
    const meta = JSON.parse(row?.meta || '{}');
    return Array.isArray(meta.readBy) ? meta.readBy : [];
  } catch { return []; }
}
const seenBy = (row, userId) => row.status === 'read' || readBy(row).includes(userId);

export function listNotifications(store, userId, limit = 50) {
  return store.all(
    `SELECT * FROM notifications WHERE user_id IS NULL OR user_id=? ORDER BY created_at DESC LIMIT ?`,
    userId, Math.max(1, Math.min(200, limit)))
    .map(row => seenBy(row, userId) ? {...row, status: 'read'} : row);
}

export function markRead(store, userId, ids) {
  const list = Array.isArray(ids) ? ids.slice(0, 100) : [];
  if (!list.length) return {marked: 0};
  let marked = 0;
  for (const id of list) {
    const row = store.get('SELECT id, user_id, status, meta FROM notifications WHERE id=? AND (user_id IS NULL OR user_id=?)', id, userId);
    if (!row || seenBy(row, userId)) continue;
    let meta = {};
    try { meta = JSON.parse(row.meta || '{}') || {}; } catch { meta = {}; }
    const readers = Array.isArray(meta.readBy) ? meta.readBy : [];
    meta.readBy = readers.includes(userId) ? readers : [...readers, userId];
    // A personal row can flip its status. A shared row must not: that one
    // status is what every other member's unread count still reads.
    if (row.user_id) store.run(`UPDATE notifications SET status='read', meta=? WHERE id=?`, JSON.stringify(meta), id);
    else store.run(`UPDATE notifications SET meta=? WHERE id=?`, JSON.stringify(meta), id);
    marked++;
  }
  return {marked};
}

export function unreadCount(store, userId) {
  return store.get(
    `SELECT count(*) AS n FROM notifications
     WHERE (user_id IS NULL OR user_id=?) AND status<>'read'
     AND NOT EXISTS (
       SELECT 1 FROM json_each(CASE WHEN json_valid(meta) THEN json_extract(meta, '$.readBy') END)
       WHERE value=?)`,
    userId, userId).n;
}
