import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey, encryptJson} from '../src/vault.js';
import * as credentials from '../src/credentials.js';
import * as notifications from '../src/notifications.js';
import {createQueue} from '../src/queue.js';

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notif-'));
  const dataFile = path.join(dir, 'state.json');
  const store = await new SqliteStore(path.join(dir, 'state.db'), dataFile).init();
  loadMasterKey(dataFile);
  store.vaultKey = loadMasterKey(dataFile).key;
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  return {dir, store};
}

test('in-app notifications are recorded and bounded; read state is per user', async () => {
  const {store, dir} = await harness();
  const id = notifications.notify(store, null, {userId: 'u1', title: 'Reminder fired', body: 'Check the queue', kind: 'reminder'});
  assert.ok(id);
  assert.equal(notifications.unreadCount(store, 'u1'), 1);
  assert.equal(notifications.unreadCount(store, 'u2'), 0, 'Another user must not see this row.');
  // Workspace-wide (no user) rows are visible to everyone but still readable.
  notifications.notify(store, null, {userId: null, title: 'Agent revoked', body: ''});
  assert.equal(notifications.unreadCount(store, 'u1'), 2);
  assert.equal(notifications.markRead(store, 'u1', [id]).marked, 1);
  assert.equal(notifications.markRead(store, 'u1', [id]).marked, 0, 'Reading twice is a no-op.');
  assert.equal(notifications.unreadCount(store, 'u1'), 1);
  assert.equal(notifications.markRead(store, 'u1', []).marked, 0);
  // The feed is bounded per scope: one user's flood cannot evict the shared notice.
  for (let i = 0; i < 205; i++) notifications.notify(store, null, {userId: 'u1', title: `n${i}`, body: ''});
  assert.equal(store.get("SELECT count(*) AS n FROM notifications WHERE channel='in_app' AND user_id='u1'").n, 200, "A user's own feed is capped");
  assert.equal(store.get("SELECT count(*) AS n FROM notifications WHERE channel='in_app' AND user_id IS NULL").n, 1, 'The shared notice survives');
  await fs.rm(dir, {recursive: true, force: true});
});

test('preferences are validated and webhook URLs live in the credential vault', async () => {
  const {store, dir} = await harness();
  const prefs = notifications.updatePreferences(store, 'u1', {inApp: true, webhook: false});
  assert.deepEqual(prefs, {inApp: true, webhook: false, webhookCredentialId: null, email: false, emailAddress: ''});
  assert.throws(() => notifications.updatePreferences(store, 'u1', {webhook: true}), /stored credential/);
  credentials.addCredential(store, 'default', {name: 'hook', kind: 'webhook', value: 'https://hooks.example.com/abc', createdBy: 'u1'});
  const credentialId = credentials.listCredentials(store, 'default')[0].id;
  assert.throws(() => notifications.updatePreferences(store, 'u1', {webhook: true, webhookCredentialId: 'missing'}), /not found/);
  const withWebhook = notifications.updatePreferences(store, 'u1', {webhook: true, webhookCredentialId: credentialId});
  assert.equal(withWebhook.webhook, true);
  assert.equal(withWebhook.webhookCredentialId, credentialId);
  // The URL itself is never written to the preferences table.
  assert.doesNotMatch(JSON.stringify(store.get('SELECT * FROM notification_prefs WHERE user_id=?', 'u1')), /hooks.example.com/);
  assert.throws(() => notifications.updatePreferences(store, 'u1', {email: true}), /email address/);
  const withEmail = notifications.updatePreferences(store, 'u1', {email: true, emailAddress: 'ops@example.com'});
  assert.equal(withEmail.email, true);
  await fs.rm(dir, {recursive: true, force: true});
});

test('a webhook delivery is a durable task that retries and then fails loudly', async () => {
  const {store, dir} = await harness();
  const {enqueueTask, retryTask} = await import('../shared/tasks.js');
  // Webhook delivery goes through the queue; a failing endpoint must not
  // pretend the notification was sent.
  const attempts = [];
  const queue = createQueue(store, {
    notification: async task => {
      attempts.push(task.payload.url || 'no-url');
      throw new Error('Webhook responded 500.');
    },
  }, {intervalMs: 60000});
  const {task} = await store.update(s => enqueueTask(s, {
    kind: 'notification', payload: {notificationId: 'n1', channel: 'webhook', url: 'https://hooks.example.com/x', title: 't', body: 'b'},
    title: 'Deliver webhook n1', maxAttempts: 2,
  }));
  await queue.sweep();
  assert.equal(attempts.length, 1);
  let after = store.read().tasks.find(t => t.id === task.id);
  assert.equal(after.status, 'queued', 'A failed delivery retries.');
  assert.equal(after.lastError, 'Webhook responded 500.');
  await store.update(s => { s.tasks.find(t => t.id === task.id).runAt = new Date(Date.now() - 1000).toISOString(); });
  await queue.sweep();
  after = store.read().tasks.find(t => t.id === task.id);
  // Attempts are no longer the whole budget: a retry that gave up after four
  // attempts (about fifteen seconds on the backoff ladder) let a webhook 502
  // end a reminder that fires every hour. The budget is now a wall-clock window
  // as well, so this one is still waiting for its next try.
  assert.equal(after.status, 'queued', 'Past the attempt cap the task still waits inside the retry window.');
  assert.equal(attempts.length, 2);
  // Age the retry window past its end: only then is the endpoint declared dead.
  await store.update(s => {
    const t = s.tasks.find(x => x.id === task.id);
    t.payload.retryStartedAt = Date.now() - 7 * 3600000;
    t.runAt = new Date(Date.now() - 1000).toISOString();
  });
  await queue.sweep();
  after = store.read().tasks.find(t => t.id === task.id);
  assert.equal(after.status, 'failed', 'After the window it stays failed, never silently sent.');
  assert.equal(attempts.length, 3);
  await fs.rm(dir, {recursive: true, force: true });
});

test('deliver() resolves the webhook URL from the encrypted credential and rejects bad ones', async () => {
  const {store, dir} = await harness();
  credentials.addCredential(store, 'default', {name: 'hook', value: 'https://hooks.example.com/abc', kind: 'webhook'});
  const credentialId = credentials.listCredentials(store, 'default')[0].id;
  const task = {payload: {channel: 'webhook', target: credentialId, title: 't', body: 'b', meta: {}}};
  const result = await notifications.deliver(store, task).catch(e => ({error: e.message}));
  // The endpoint does not exist, so delivery must surface the failure rather
  // than resolve; what matters is that it resolved the URL from the vault.
  assert.ok(result.error, 'A real delivery attempt must report its outcome.');
  assert.doesNotMatch(result.error, /decrypt/i, 'The credential decrypted; the failure is the network.');
  // A non-http credential is refused before any request is made.
  credentials.addCredential(store, 'default', {name: 'bad-scheme', value: 'ftp://example.com/x', kind: 'webhook'});
  const badId = credentials.listCredentials(store, 'default').find(c => c.name === 'bad-scheme').id;
  await assert.rejects(notifications.deliver(store, {payload: {channel: 'webhook', target: badId, title: 't', body: 'b'}}), /http\(s\)/);
  // Missing credential fails clearly.
  await assert.rejects(notifications.deliver(store, {payload: {channel: 'webhook', target: 'missing', title: 't', body: 'b'}}), /no longer exists/);
  // No EMAIL_RELAY_URL: delivery must fail loudly rather than let the queue
  // mark the notification "sent".
  const previousRelay = process.env.EMAIL_RELAY_URL;
  const previousSmtpHost = process.env.SMTP_HOST;
  delete process.env.EMAIL_RELAY_URL;
  // A developer's real .env may point at a mailbox; this test is about the
  // case where nothing at all is configured.
  delete process.env.SMTP_HOST;
  try {
    await assert.rejects(notifications.deliver(store, {payload: {channel: 'email', target: 'ops@example.com', title: 't', body: 'b'}}), /external relay/i);
  } finally {
    if (previousRelay === undefined) delete process.env.EMAIL_RELAY_URL;
    else process.env.EMAIL_RELAY_URL = previousRelay;
    if (previousSmtpHost !== undefined) process.env.SMTP_HOST = previousSmtpHost;
  }
  // Unknown channels fail.
  await assert.rejects(notifications.deliver(store, {payload: {channel: 'carrier-pigeon', target: 'x', title: 't', body: 'b'}}), /Unknown notification channel/);
  // An expired credential must not be sent, even though it still decrypts.
  const enc = encryptJson(store.vaultKey, {value: 'https://hooks.example.com/expired'});
  const expiredId = crypto.randomUUID();
  store.run('INSERT INTO credentials (id,workspace_id,name,kind,ciphertext,iv,tag,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    expiredId, 'default', 'old', 'webhook', enc.ciphertext, enc.iv, enc.tag, null, new Date().toISOString(), new Date(Date.now() - 1000).toISOString());
  await assert.rejects(notifications.deliver(store, {payload: {channel: 'webhook', target: expiredId, title: 't', body: 'b'}}), /expired/);
  await fs.rm(dir, {recursive: true, force: true });
});

test('a configured email relay receives the notification and a failure still throws', async () => {
  const {store, dir} = await harness();
  const previous = {
    EMAIL_RELAY_URL: process.env.EMAIL_RELAY_URL,
    EMAIL_RELAY_TOKEN: process.env.EMAIL_RELAY_TOKEN,
    WEBHOOK_ALLOW_PRIVATE: process.env.WEBHOOK_ALLOW_PRIVATE,
  };
  const restoreEnv = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8')});
      if (req.url === '/fail') return res.writeHead(502).end('no');
      if (req.url === '/away') return res.writeHead(302, {Location: 'http://127.0.0.1/stolen'}).end();
      res.writeHead(204).end();
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const task = meta => ({payload: {channel: 'email', target: 'ops@example.com', title: 't', body: 'b', meta}});
  const previousFetch = globalThis.fetch;
  try {
    process.env.WEBHOOK_ALLOW_PRIVATE = '1';
    delete process.env.EMAIL_RELAY_TOKEN;
    process.env.EMAIL_RELAY_URL = `http://127.0.0.1:${port}/relay`;
    assert.deepEqual(await notifications.deliver(store, task({k: 1})), {delivered: 'email'});
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].headers.authorization, undefined);
    assert.match(requests[0].headers['content-type'], /^application\/json/);
    const posted = JSON.parse(requests[0].body);
    assert.equal(posted.to, 'ops@example.com');
    assert.equal(posted.title, 't');
    assert.equal(posted.body, 'b');
    assert.deepEqual(posted.meta, {k: 1});
    assert.equal(typeof posted.at, 'string');

    delete process.env.EMAIL_RELAY_TOKEN;
    await notifications.deliver(store, task({}));
    assert.equal(requests[1].headers.authorization, undefined);

    delete process.env.EMAIL_RELAY_TOKEN;
    process.env.EMAIL_RELAY_URL = `http://127.0.0.1:${port}/fail`;
    await assert.rejects(notifications.deliver(store, task({})), error => {
      assert.match(error.message, /responded 502/);
      assert.doesNotMatch(error.message, /super-secret-token/);
      assert.doesNotMatch(error.message, /ops@example.com/);
      return true;
    });

    process.env.EMAIL_RELAY_URL = `http://127.0.0.1:${port}/away`;
    const beforeRedirect = requests.length;
    await assert.rejects(notifications.deliver(store, task({})), /responded 302/);
    assert.equal(requests.length, beforeRedirect + 1, 'A redirect is not followed.');
    assert.equal(requests.at(-1).url, '/away');

    const beforeBadAddress = requests.length;
    await assert.rejects(notifications.deliver(store, {payload: {channel: 'email', target: 'not-an-email', title: 't', body: 'b'}}), /valid address/);
    assert.equal(requests.length, beforeBadAddress);

    process.env.EMAIL_RELAY_URL = 'ftp://93.184.216.34/relay';
    await assert.rejects(notifications.deliver(store, task({})), /http\(s\)/);

    delete process.env.WEBHOOK_ALLOW_PRIVATE;
    // Cleartext relay on a public host: refused before anything is sent.
    process.env.EMAIL_RELAY_URL = 'http://93.184.216.34/relay';
    await assert.rejects(notifications.deliver(store, task({})), /must use https/);
    // Cleartext relay on a private host: refused too, without the opt-in flag.
    process.env.EMAIL_RELAY_URL = 'http://127.0.0.1/relay';
    await assert.rejects(notifications.deliver(store, task({})), /must use https/);

    process.env.EMAIL_RELAY_URL = 'https://93.184.216.34/relay?x=1';
    process.env.EMAIL_RELAY_TOKEN = 'super-secret-token';
    globalThis.fetch = async () => { throw new Error('connect failed super-secret-token for ops@example.com via https://93.184.216.34/relay?x=1'); };
    await assert.rejects(notifications.deliver(store, task({})), error => {
      assert.doesNotMatch(error.message, /super-secret-token/);
      assert.doesNotMatch(error.message, /ops@example.com/);
      assert.doesNotMatch(error.message, /93\.184\.216\.34/);
      return true;
    });

    // A mailbox wins when both are configured: the relay must not also send.
    // The port is closed, so the attempt fails at connect — which is the proof
    // that SMTP was chosen instead of the relay that is still reachable.
    const closedPort = await new Promise(resolve => {
      const probe = http.createServer().listen(0, '127.0.0.1', () => {
        const port = probe.address().port;
        probe.close(() => resolve(port));
      });
    });
    const beforeSmtp = requests.length;
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = String(closedPort);
    process.env.SMTP_REQUIRE_TLS = '0';
    process.env.SMTP_FROM = 'bot@example.com';
    try {
      await assert.rejects(notifications.deliver(store, task({})), /Email delivery failed/);
      assert.equal(requests.length, beforeSmtp, 'The relay is not used when a mailbox is configured.');
    } finally {
      for (const key of ['SMTP_HOST', 'SMTP_PORT', 'SMTP_REQUIRE_TLS', 'SMTP_FROM']) delete process.env[key];
    }
  } finally {
    globalThis.fetch = previousFetch;
    restoreEnv();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('a burst in one millisecond keeps the newest notices, and reading one is personal', async () => {
  const {store, dir} = await harness();
  const realDate = Date;
  const fixed = new realDate('2026-01-01T00:00:00.000Z');
  global.Date = class extends realDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed.getTime(); }
  };
  try {
    const ids = [];
    for (let i = 0; i < 205; i++) ids.push(notifications.notify(store, null, {userId: 'u1', title: `n${i}`, body: ''}));
    const kept = store.all("SELECT title FROM notifications WHERE user_id='u1'");
    assert.equal(kept.length, 200);
    assert.equal(kept.some(row => row.title === 'n204'), true, 'The notice just recorded has to stay.');
    assert.equal(kept.some(row => row.title === 'n0'), false, 'The oldest notice is the one that makes room.');
    assert.equal(store.get('SELECT id FROM notifications WHERE id=?', ids[204])?.id, ids[204]);
  } finally { global.Date = realDate; }

  const shared = notifications.notify(store, null, {userId: null, title: 'Reminder fired', body: 'In this workspace'});
  const personal = notifications.notify(store, null, {userId: 'u1', title: 'Only u1', body: ''});
  assert.equal(notifications.markRead(store, 'u1', [shared, personal]).marked, 2);
  assert.equal(notifications.listNotifications(store, 'u1').find(row => row.id === shared).status, 'read');
  assert.equal(notifications.listNotifications(store, 'u1').find(row => row.id === personal).status, 'read');
  assert.equal(notifications.unreadCount(store, 'u2'), 1, 'Another member still has the shared notice.');
  assert.equal(notifications.listNotifications(store, 'u2').find(row => row.id === shared).status === 'read', false);
  assert.equal(notifications.markRead(store, 'u1', [shared]).marked, 0);
  // Delivery success rewrites status to sent. That must not unread it.
  const unread = notifications.unreadCount(store, 'u1');
  store.run("UPDATE notifications SET status='sent' WHERE id=?", personal);
  assert.equal(notifications.unreadCount(store, 'u1'), unread);
  assert.equal(notifications.listNotifications(store, 'u1').find(row => row.id === personal).status, 'read');
  await fs.rm(dir, {recursive: true, force: true});
});
