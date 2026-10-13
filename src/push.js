/** Web Push, without a library.
 *
 * A browser that subscribes hands over an endpoint at its push service plus two
 * keys. To reach it the server encrypts the message for those keys (RFC 8291,
 * `aes128gcm` content coding from RFC 8188) and signs the request with this
 * installation's own key pair (VAPID, RFC 8292). Both are a few calls into
 * node:crypto, which is why no dependency is needed.
 *
 * Subscriptions belong to the account, so they sit in the first workspace's
 * database beside users and sessions. A notification raised in any workspace
 * reaches the devices of that workspace's members.
 */
import crypto from 'node:crypto';
import {assertPublicUrl} from '../agent/net-guard.mjs';
import {encryptJson, decryptJson} from './vault.js';

const RECORD_SIZE = 4096;
const MAX_PER_USER = 10;
const now = () => new Date().toISOString();
const b64 = value => Buffer.from(String(value || ''), 'base64url');
const refuse = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
const hkdf = (ikm, salt, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));

/** Encrypt `plaintext` for one subscription. Returns the request body. */
export function encryptPayload(plaintext, {p256dh, auth}) {
  const receiver = b64(p256dh), secret = b64(auth);
  const sender = crypto.createECDH('prime256v1');
  const senderPublic = sender.generateKeys();
  const ikm = hkdf(sender.computeSecret(receiver), secret, Buffer.concat([Buffer.from('WebPush: info\0'), receiver, senderPublic]), 32);
  const salt = crypto.randomBytes(16);
  const key = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce);
  // One record; the 0x02 byte marks it as the last.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header); header.writeUInt32BE(RECORD_SIZE, 16); header[20] = senderPublic.length;
  return Buffer.concat([header, senderPublic, sealed]);
}

/** The signed header that tells a push service who is sending. */
export function vapidHeader(endpoint, keys, subject, nowMs = Date.now()) {
  const part = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${part({typ: 'JWT', alg: 'ES256'})}.${part({aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject})}`;
  const signature = crypto.sign('sha256', Buffer.from(unsigned), {key: crypto.createPrivateKey({key: keys.privateJwk, format: 'jwk'}), dsaEncoding: 'ieee-p1363'});
  return `vapid t=${unsigned}.${signature.toString('base64url')}, k=${keys.publicKey}`;
}

export function generateVapidKeys() {
  const {publicKey, privateKey} = crypto.generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
  const jwk = publicKey.export({format: 'jwk'});
  return {publicKey: Buffer.concat([Buffer.from([4]), b64(jwk.x), b64(jwk.y)]).toString('base64url'), privateJwk: privateKey.export({format: 'jwk'})};
}

/** What a browser hands over, checked before it is stored or ever fetched. */
function readSubscription(body) {
  const endpoint = String(body?.endpoint || ''), p256dh = String(body?.keys?.p256dh || ''), auth = String(body?.keys?.auth || '');
  let url;
  try { url = new URL(endpoint); } catch { refuse('The push subscription has no valid endpoint.'); }
  if (url.protocol !== 'https:' || endpoint.length > 1000) refuse('The push endpoint must be an https address.');
  const point = b64(p256dh);
  if (point.length !== 65 || point[0] !== 4 || b64(auth).length !== 16) refuse('The push subscription keys are not valid.');
  // A 65-byte blob starting with 0x04 can still be an invalid curve point.
  // Prove it now so a bad subscription is refused at subscribe time instead of
  // failing (and retrying) every push sent to it later.
  try { const probe = crypto.createECDH('prime256v1'); probe.generateKeys(); probe.computeSecret(point); }
  catch { refuse('The push subscription key is not a valid P-256 point.'); }
  return {endpoint, p256dh, auth};
}

export function createPush(store, {fetcher = fetch, guard = assertPublicUrl} = {}) {
  let keys = null;
  /** The installation's key pair: made once, kept encrypted with the vault key. */
  function vapid() {
    if (keys) return keys;
    const saved = store.kvGet('vapid_keys');
    if (saved) {
      try { keys = decryptJson(store.vaultKey, JSON.parse(saved)); }
      // Sealed with another MASTER_KEY. Devices subscribed with the lost key
      // cannot be reached with a new one, so they have to subscribe again.
      catch { store.run('DELETE FROM push_subscriptions'); }
    }
    if (!keys) {
      keys = generateVapidKeys();
      store.kvSet('vapid_keys', JSON.stringify(encryptJson(store.vaultKey, keys)));
    }
    return keys;
  }
  // Push services want a contact they could write to about a misbehaving sender.
  const subject = () => process.env.VAPID_SUBJECT || (String(process.env.PUBLIC_ORIGIN || '').startsWith('https://') ? process.env.PUBLIC_ORIGIN : 'mailto:admin@example.com');

  /** Send one message. Resolves 'sent', or 'gone' when the browser has
   * unsubscribed (the row is removed); anything else throws so it is retried. */
  async function send(subscription, message) {
    // The endpoint came from a browser, so it must not be a way to make this
    // server call an address on its own network.
    await guard(subscription.endpoint, {allowPrivate: false});
    const response = await fetcher(subscription.endpoint, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: {'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal', Authorization: vapidHeader(subscription.endpoint, vapid(), subject())},
      body: encryptPayload(JSON.stringify({title: String(message.title || 'Agent Control').slice(0, 120), body: String(message.body || '').slice(0, 300)}), subscription),
    });
    if (response.status === 404 || response.status === 410) { store.run('DELETE FROM push_subscriptions WHERE id=?', subscription.id); return 'gone'; }
    if (!response.ok) throw new Error(`The push service responded ${response.status}.`);
    return 'sent';
  }
  const devices = userId => store.all('SELECT * FROM push_subscriptions WHERE user_id=? ORDER BY created_at', userId);

  return {
    publicKey: () => vapid().publicKey,
    endpoints: userId => devices(userId).map(d => d.endpoint),
    subscribe(userId, body, userAgent) {
      const sub = readSubscription(body);
      store.transaction(() => {
        // A browser profile has one subscription; whoever signed in last owns it.
        store.run('DELETE FROM push_subscriptions WHERE endpoint=?', sub.endpoint);
        const extra = devices(userId).slice(0, Math.max(0, devices(userId).length - MAX_PER_USER + 1));
        for (const old of extra) store.run('DELETE FROM push_subscriptions WHERE id=?', old.id);
        store.run('INSERT INTO push_subscriptions (id,user_id,endpoint,p256dh,auth,user_agent,created_at) VALUES (?,?,?,?,?,?,?)',
          crypto.randomUUID(), userId, sub.endpoint, sub.p256dh, sub.auth, String(userAgent || '').slice(0, 200), now());
      });
      return {ok: true};
    },
    unsubscribe(userId, endpoint) {
      return {removed: store.run('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?', userId, String(endpoint || '')).changes};
    },
    /** Send to every device of one account now, and report what happened. */
    async test(userId) {
      const results = [];
      for (const device of devices(userId)) {
        try { results.push(await send(device, {title: 'Agent Control', body: 'Push notifications work on this device.'})); }
        catch (e) { results.push(`failed: ${e.message}`); }
      }
      return {results};
    },
    /** Queue one delivery per device of the given accounts, through the
     * workspace's own task queue so an outage is retried. */
    announce(workspaceStore, enqueue, userIds, {id, title, body}) {
      for (const userId of userIds) for (const device of devices(userId)) {
        enqueue(workspaceStore, {kind: 'notification', title: 'Push notification', maxAttempts: 3, idempotencyKey: `push:${id}:${device.id}`,
          payload: {notificationId: id, channel: 'push', target: device.id, title, body}});
      }
    },
    /** Run one queued delivery. */
    async deliver(task) {
      const device = store.get('SELECT * FROM push_subscriptions WHERE id=?', task.payload.target);
      if (!device) return {delivered: 'gone'};
      return {delivered: await send(device, task.payload)};
    },
  };
}
