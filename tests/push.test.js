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

test('a push endpoint on a private network is never called', async () => {
  let called = false;
  const t = await harness({guard: undefined, fetcher: async () => { called = true; return {status: 201, ok: true}; }});
  try {
    t.push.subscribe(t.userId, device('https://127.0.0.1/hook').subscription);
    assert.match((await t.push.test(t.userId)).results[0], /failed: Refusing to reach 127\.0\.0\.1/);
    assert.equal(called, false);
  } finally { await t.done(); }
});
