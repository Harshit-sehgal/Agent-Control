import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey} from '../src/vault.js';
import {Auth} from '../src/auth.js';
import {createPush, encryptPayload, vapidHeader, generateVapidKeys} from '../src/push.js';
import {enablePush, disablePush, pushStatus} from '../shared/ui-push.js';

/** A browser's side of a subscription: its key pair and shared secret. */
function device(endpoint = 'https://push.example.com/send/abc') {
  const ecdh = crypto.createECDH('prime256v1');
  const p256dh = ecdh.generateKeys().toString('base64url'), auth = crypto.randomBytes(16).toString('base64url');
  return {ecdh, subscription: {endpoint, keys: {p256dh, auth}}, keys: {p256dh, auth}};
}
/** Decrypt a push body the way a browser does (RFC 8291), independently of the sender. */
function decrypt(body, {ecdh, keys}) {
  const salt = body.subarray(0, 16), size = body.readUInt32BE(16), idLength = body[20];
  const sender = body.subarray(21, 21 + idLength), sealed = body.subarray(21 + idLength);
  const hkdf = (ikm, s, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, n));
  const ikm = hkdf(ecdh.computeSecret(sender), Buffer.from(keys.auth, 'base64url'), Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(keys.p256dh, 'base64url'), sender]), 32);
  const decipher = crypto.createDecipheriv('aes-128-gcm', hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16), hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  return {size, idLength, delimiter: plain[plain.length - 1], text: plain.subarray(0, plain.length - 1).toString()};
}
async function harness(options) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'push-')), dataFile = path.join(dir, 'state.json');
  const store = await new SqliteStore(path.join(dir, 'state.db'), dataFile).init();
  store.vaultKey = loadMasterKey(dataFile).key;
  const auth = new Auth(store); auth.ensureBootstrap('owner-secret-1');
  const userId = store.get('SELECT id FROM users').id;
  return {dir, store, userId, push: createPush(store, {guard: async () => {}, ...options}), done: () => fs.rm(dir, {recursive: true, force: true})};
}

test('a push payload can be read by the device it was encrypted for, and by no other', () => {
  const phone = device(), other = device();
  const body = encryptPayload('{"title":"Draft ready"}', phone.keys);
  const read = decrypt(body, phone);
  assert.deepEqual([read.size, read.idLength, read.delimiter, read.text], [4096, 65, 2, '{"title":"Draft ready"}']);
  assert.throws(() => decrypt(body, other));
  assert.notDeepEqual(encryptPayload('x', phone.keys), encryptPayload('x', phone.keys), 'Every message uses a fresh salt and key.');
});

test('the VAPID header is a token the push service can verify with the public key', () => {
  const keys = generateVapidKeys(), header = vapidHeader('https://push.example.com/send/abc', keys, 'mailto:ops@example.com', 1_700_000_000_000);
  const [, token, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header);
  assert.equal(k, keys.publicKey);
  const [h, c, sig] = token.split('.');
  const point = Buffer.from(k, 'base64url');
  const publicKey = crypto.createPublicKey({format: 'jwk', key: {kty: 'EC', crv: 'P-256', x: point.subarray(1, 33).toString('base64url'), y: point.subarray(33).toString('base64url')}});
  assert.equal(crypto.verify('sha256', Buffer.from(`${h}.${c}`), {key: publicKey, dsaEncoding: 'ieee-p1363'}, Buffer.from(sig, 'base64url')), true);
  assert.deepEqual(JSON.parse(Buffer.from(c, 'base64url')), {aud: 'https://push.example.com', exp: 1_700_000_000 + 12 * 3600, sub: 'mailto:ops@example.com'});
  assert.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), {typ: 'JWT', alg: 'ES256'});
});

test('subscriptions are validated, owned by one account, and the key pair is kept', async () => {
  const t = await harness(), phone = device();
  try {
    for (const bad of [{}, {endpoint: 'http://push.example.com/x', keys: phone.keys}, {endpoint: 'javascript:alert(1)', keys: phone.keys}, {endpoint: phone.subscription.endpoint, keys: {p256dh: 'AAAA', auth: phone.keys.auth}}, {endpoint: phone.subscription.endpoint, keys: {p256dh: phone.keys.p256dh, auth: 'AAAA'}}]) {
      assert.throws(() => t.push.subscribe(t.userId, bad), e => e.status === 400);
    }
    t.push.subscribe(t.userId, phone.subscription, 'Phone');
    t.push.subscribe(t.userId, phone.subscription, 'Phone');
    assert.deepEqual(t.push.endpoints(t.userId), [phone.subscription.endpoint], 'Subscribing twice keeps one row.');
    assert.equal(t.push.unsubscribe('someone-else', phone.subscription.endpoint).removed, 0, 'Only the owner can remove a device.');
    assert.equal(t.push.unsubscribe(t.userId, phone.subscription.endpoint).removed, 1);
    for (let i = 0; i < 12; i++) t.push.subscribe(t.userId, device(`https://push.example.com/send/${i}`).subscription);
    assert.equal(t.push.endpoints(t.userId).length, 10, 'Old devices make room for new ones.');
    const key = t.push.publicKey();
    assert.equal(Buffer.from(key, 'base64url').length, 65);
    assert.equal(createPush(t.store).publicKey(), key, 'A restart must not change the key browsers subscribed with.');
    assert.equal(t.store.kvGet('vapid_keys').includes(key), false, 'The key pair is stored encrypted.');
  } finally { await t.done(); }
});

test('delivery encrypts for the device, drops dead subscriptions and retries the rest', async () => {
  const calls = [], phone = device();
  let status = 201;
  const t = await harness({fetcher: async (url, init) => { calls.push({url, init}); return {status, ok: status >= 200 && status < 300}; }});
  try {
    t.push.subscribe(t.userId, phone.subscription);
    const queued = [];
    t.push.announce('ws', (store, spec) => queued.push({store, spec}), [t.userId, 'nobody'], {id: 'n1', title: 'Draft ready', body: 'For @tester'});
    assert.equal(queued.length, 1);
    assert.deepEqual([queued[0].store, queued[0].spec.kind, queued[0].spec.payload.channel], ['ws', 'notification', 'push']);
    const task = {payload: queued[0].spec.payload};
    assert.deepEqual(await t.push.deliver(task), {delivered: 'sent'});
    const {url, init} = calls[0];
    assert.equal(url, phone.subscription.endpoint);
    assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(init.redirect, 'manual');
    assert.match(init.headers.Authorization, /^vapid t=.+, k=.+$/);
    assert.deepEqual(JSON.parse(decrypt(init.body, phone).text), {title: 'Draft ready', body: 'For @tester'});

    status = 500;
    await assert.rejects(t.push.deliver(task), /responded 500/);
    assert.equal(t.push.endpoints(t.userId).length, 1, 'A failing push service does not lose the device.');
    status = 410;
    assert.deepEqual(await t.push.deliver(task), {delivered: 'gone'});
    assert.equal(t.push.endpoints(t.userId).length, 0, 'A device that unsubscribed is forgotten.');
    assert.deepEqual(await t.push.deliver(task), {delivered: 'gone'});
  } finally { await t.done(); }
});

test('turning push on keeps a subscription made for this server key', async () => {
  const key = generateVapidKeys().publicKey;
  const raw = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4)), c => c.charCodeAt(0));
  const calls = [];
  let unsubscribed = false, subscribed = false;
  const existing = {
    endpoint: 'https://push.example.com/send/keep',
    options: {applicationServerKey: raw.buffer},
    unsubscribe: async () => { unsubscribed = true; },
    toJSON: () => ({endpoint: 'https://push.example.com/send/keep', keys: {p256dh: 'p', auth: 'a'}}),
  };
  const registration = {pushManager: {
    getSubscription: async () => existing,
    subscribe: async () => { subscribed = true; throw new Error('rotated'); },
  }};
  const previous = {window: globalThis.window, Notification: globalThis.Notification, atob: globalThis.atob, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator')};
  globalThis.document = {getElementById() { return null; }};
  globalThis.atob = text => { if (text.length % 4) throw new Error('atob padding'); return previous.atob(text); };
  globalThis.Notification = {requestPermission: async () => 'granted'};
  Object.defineProperty(globalThis, 'navigator', {configurable: true, writable: true, value: {serviceWorker: {register: async () => registration, ready: Promise.resolve()}}});
  globalThis.window = {AGENT_API: async (path, method, body) => {
    calls.push({path, method, body});
    if (method === 'POST') throw new Error('offline');
    return {publicKey: key, endpoints: []};
  }};
  try {
    await assert.rejects(enablePush(), /offline/);
    assert.equal(unsubscribed, false, 'A failed save must not drop the subscription the browser already has.');
    assert.equal(subscribed, false);
    assert.equal(calls.at(-1).body.endpoint, existing.endpoint);
  } finally {
    globalThis.atob = previous.atob;
    if (previous.Notification === undefined) delete globalThis.Notification; else globalThis.Notification = previous.Notification;
    Object.defineProperty(globalThis, 'navigator', previous.navigator);
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
    delete globalThis.document;
  }
});

test('turning push off unsubscribes locally first, and an unsubscribed device reads as off', async () => {
  const calls = [];
  const endpoint = 'https://push.example.com/send/off';
  let refuse = false, live = null;
  const subscription = () => ({endpoint, unsubscribe: async () => { calls.push('unsubscribe'); if (refuse) throw new Error('the browser refused'); live = null; }, toJSON: () => ({endpoint})});
  const serverEndpoints = [];
  const previous = {window: globalThis.window, Notification: globalThis.Notification, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator')};
  globalThis.document = {getElementById: () => null, querySelector: () => null};
  globalThis.Notification = {permission: 'granted'};
  globalThis.window = {isSecureContext: true, PushManager: function PushManager() {}, Notification: globalThis.Notification,
    AGENT_API: async (path, method = 'GET') => { calls.push(`${method} ${path}`); return {publicKey: '', endpoints: [...serverEndpoints]}; }};
  Object.defineProperty(globalThis, 'navigator', {configurable: true, writable: true, value: {
    serviceWorker: {getRegistration: async () => (live === undefined ? undefined : {pushManager: {getSubscription: async () => live}})},
  }});
  try {
    // Both sides subscribed: the local unsubscribe runs first, so a failure here
    // cannot leave a live subscription the server has already forgotten.
    live = subscription();
    await disablePush();
    assert.deepEqual(calls, ['unsubscribe', 'DELETE /api/push/subscriptions']);
    assert.equal(await pushStatus().then(status => status.state), 'off');

    // A refused local unsubscribe means the server is never told: the device
    // keeps receiving exactly what the server still has.
    calls.length = 0; refuse = true; live = subscription();
    await assert.rejects(disablePush(), /the browser refused/);
    assert.deepEqual(calls, ['unsubscribe'], 'a failed unsubscribe must not delete the server row');

    // No local subscription at all: nothing to delete, and the device says off
    // even though the server still lists an old endpoint for it.
    calls.length = 0; serverEndpoints.push(endpoint); live = null;
    await disablePush();
    assert.deepEqual(calls, [], 'with nothing to unsubscribe there is nothing to delete');
    const off = await pushStatus();
    assert.deepEqual(calls, ['GET /api/push'], 'the status is still asked of the server');
    assert.deepEqual([off.state, off.devices], ['off', 1]);

    // No registration, or a push manager that will not answer, is still off.
    live = undefined;
    assert.equal((await pushStatus()).state, 'off');
    Object.defineProperty(globalThis, 'navigator', {configurable: true, writable: true, value: {serviceWorker: {
      getRegistration: async () => ({pushManager: {getSubscription: async () => { throw new Error('no push manager'); }}}),
    }}});
    assert.equal((await pushStatus()).state, 'off');
  } finally {
    if (previous.Notification === undefined) delete globalThis.Notification; else globalThis.Notification = previous.Notification;
    Object.defineProperty(globalThis, 'navigator', previous.navigator);
    if (previous.window === undefined) delete globalThis.window; else globalThis.window = previous.window;
    delete globalThis.document;
  }
});


test('a push endpoint on a private network is never called', async () => {
  let called = false;
  const t = await harness({guard: undefined, fetcher: async () => { called = true; return {status: 201, ok: true}; }});
  try {
    t.push.subscribe(t.userId, device('https://127.0.0.1/hook').subscription);
    assert.match((await t.push.test(t.userId)).results[0], /failed: Refusing to reach 127\.0\.0\.1/);
    assert.equal(called, false);
  } finally { await t.done(); }
});
