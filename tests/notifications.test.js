import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey} from '../src/vault.js';
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
  assert.equal(after.status, 'failed', 'After the budget it stays failed, never silently sent.');
  assert.equal(attempts.length, 2);
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
  // Email has no embedded relay, so it must fail loudly rather than let the
  // queue mark the notification "sent".
  await assert.rejects(notifications.deliver(store, {payload: {channel: 'email', target: 'ops@example.com', title: 't', body: 'b'}}), /external relay/i);
  // Unknown channels fail.
  await assert.rejects(notifications.deliver(store, {payload: {channel: 'carrier-pigeon', target: 'x', title: 't', body: 'b'}}), /Unknown notification channel/);
  await fs.rm(dir, {recursive: true, force: true });
});
