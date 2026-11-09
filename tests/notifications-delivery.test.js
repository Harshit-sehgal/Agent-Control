import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import {loadMasterKey} from '../src/vault.js';
import * as credentials from '../src/credentials.js';
import * as notifications from '../src/notifications.js';

async function harness() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'notif-chan-'));
  const dataFile = path.join(dir, 'state.json');
  const store = await new SqliteStore(path.join(dir, 'state.db'), dataFile).init();
  loadMasterKey(dataFile);
  store.vaultKey = loadMasterKey(dataFile).key;
  store.run("INSERT INTO workspaces (id,name,created_at) VALUES ('default','Primary workspace',?)", new Date().toISOString());
  return {dir, store};
}

const rows = (store, channel) => store.all('SELECT rowid AS seq, * FROM notifications WHERE channel=? ORDER BY rowid', channel);

/** Silences the module's own logging while a failure is the point of the test. */
async function quietly(fn) {
  const original = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args.join(' '));
  try { return {result: await fn(), logged}; } finally { console.error = original; }
}

test('one notification with two outbound channels writes one row per channel', async () => {
  const {store, dir} = await harness();
  credentials.addCredential(store, 'default', {name: 'hook', kind: 'webhook', value: 'https://hooks.example.com/abc', createdBy: 'u1'});
  const credentialId = credentials.listCredentials(store, 'default')[0].id;
  notifications.updatePreferences(store, 'u1', {inApp: true, webhook: true, webhookCredentialId: credentialId, email: true, emailAddress: 'ops@example.com'});
  const specs = [];
  const queue = (s, spec) => { specs.push(spec); return Promise.resolve({enqueued: true}); };
  const id = notifications.notify(store, queue, {userId: 'u1', title: 'Standup', body: 'Now'});
  assert.ok(id);
  const inApp = rows(store, 'in_app'), webhook = rows(store, 'webhook'), email = rows(store, 'email');
  assert.equal(inApp.length, 1);
  assert.equal(webhook.length, 1);
  assert.equal(email.length, 1);
  // Each channel is its own record, so one channel's delivery outcome cannot be
  // read as another's. The old code shared a single row id across channels and
  // only ever wrote the in-app copy.
  const ids = [inApp[0].id, webhook[0].id, email[0].id];
  assert.equal(new Set(ids).size, 3);
  assert.equal(inApp[0].status, 'delivered');
  assert.equal(webhook[0].status, 'queued');
  assert.equal(email[0].status, 'queued');
  // The delivery tasks point at their own row, not at the in-app notice.
  assert.deepEqual(specs.map(s => s.payload.channel), ['webhook', 'email']);
  assert.deepEqual(specs.map(s => s.payload.notificationId), [webhook[0].id, email[0].id]);
  assert.deepEqual(specs.map(s => s.idempotencyKey), [`notify:webhook:${webhook[0].id}`, `notify:email:${email[0].id}`]);
  await fs.rm(dir, {recursive: true, force: true});
});

test('a delivery writes only its own channel row', async () => {
  const {store, dir} = await harness();
  credentials.addCredential(store, 'default', {name: 'hook', kind: 'webhook', value: 'https://hooks.example.com/abc', createdBy: 'u1'});
  const credentialId = credentials.listCredentials(store, 'default')[0].id;
  notifications.updatePreferences(store, 'u1', {webhook: true, webhookCredentialId: credentialId});
  const specs = [];
  notifications.notify(store, (s, spec) => { specs.push(spec); return Promise.resolve({enqueued: true}); },
    {userId: 'u1', title: 'Heads up', body: '', channels: ['in_app', 'webhook']});
  const emailLike = rows(store, 'in_app')[0];
  // A webhook task quoting another channel's row must not be able to mark it
  // sent (or failed): the update is scoped by id *and* channel.
  const task = {id: 't1', attempts: 0, maxAttempts: 2, payload: {notificationId: emailLike.id, channel: 'webhook', target: 'gone'}};
  await assert.rejects(notifications.deliver(store, task), /no longer exists/);
  assert.equal(rows(store, 'in_app')[0].status, 'delivered');
  // The channel's own row stays queued while a retry is still coming, and only
  // the last attempt records the failure with its reason.
  const webhookRow = rows(store, 'webhook')[0];
  const own = {...task, payload: {...task.payload, notificationId: webhookRow.id}};
  await assert.rejects(notifications.deliver(store, own), /no longer exists/);
  assert.equal(rows(store, 'webhook')[0].status, 'queued');
  await assert.rejects(notifications.deliver(store, {...own, attempts: 2}), /no longer exists/);
  const failed = rows(store, 'webhook')[0];
  assert.equal(failed.status, 'failed');
  assert.match(failed.meta, /no longer exists/);
  assert.equal(rows(store, 'in_app')[0].status, 'delivered', 'The in-app notice is untouched.');
  await fs.rm(dir, {recursive: true, force: true});
});

test('a delivery task that never lands marks its row failed instead of leaving it queued', async () => {
  const {store, dir} = await harness();
  const {logged} = await quietly(async () => {
    notifications.updatePreferences(store, 'u1', {email: true, emailAddress: 'ops@example.com'});
    notifications.notify(store, () => Promise.reject(new Error('This workspace is being restored. Try again shortly.')),
      {userId: 'u1', title: 'Now', body: '', channels: ['email']});
    notifications.notify(store, () => { throw new Error('No queue bound'); },
      {userId: 'u1', title: 'Now', body: '', channels: ['email']});
    // A successful enqueue must keep reading as queued, not as failed.
    notifications.notify(store, () => Promise.resolve({enqueued: true}),
      {userId: 'u1', title: 'Now', body: '', channels: ['email']});
    // Every enqueue is tracked, so waiting on the module is deterministic: no
    // fixed sleep, and no retry that outlives the test.
    await notifications.deliveriesQueued();
  });
  const states = rows(store, 'email').map(row => row.status);
  assert.deepEqual(states, ['failed', 'failed', 'queued'], 'A task that never landed is not still "queued".');
  const metas = rows(store, 'email').map(row => row.meta);
  assert.match(metas[0], /restored/);
  assert.match(metas[1], /No queue bound/);
  assert.ok(logged.some(line => /Notification enqueue/.test(line)), 'The enqueue failure is still logged.');
  await fs.rm(dir, {recursive: true, force: true});
});

test('an enqueue that reports failure without throwing still fails the row', async () => {
  const {store, dir} = await harness();
  notifications.updatePreferences(store, 'u1', {email: true, emailAddress: 'ops@example.com'});
  await quietly(async () => {
    notifications.notify(store, (s, spec) => Promise.resolve({enqueued: false, error: 'Duplicate delivery task.'}),
      {userId: 'u1', title: 'Now', body: '', channels: ['email']});
    await notifications.deliveriesQueued();
  });
  const row = rows(store, 'email')[0];
  assert.equal(row.status, 'failed');
  assert.match(row.meta, /Duplicate delivery task/);
  await fs.rm(dir, {recursive: true, force: true});
});

test('a transient enqueue failure is retried instead of stranding the row', async () => {
  const {store, dir} = await harness();
  await quietly(async () => {
    notifications.updatePreferences(store, 'u1', {email: true, emailAddress: 'ops@example.com'});
    const specs = [];
    // The first attempt is the one a restore or a busy database refuses; the
    // next one lands. Giving up after the first was the defect.
    notifications.notify(store, (s, spec) => {
      specs.push(spec);
      return specs.length === 1
        ? Promise.reject(new Error('This workspace is being restored. Try again shortly.'))
        : Promise.resolve({enqueued: true});
    }, {userId: 'u1', title: 'Now', body: '', channels: ['email']});
    await notifications.deliveriesQueued();
    assert.equal(specs.length, 2, 'A transient failure is retried rather than abandoned.');
    assert.equal(specs[1].idempotencyKey, specs[0].idempotencyKey, 'The retry is the same task, not a second one.');
  });
  assert.equal(rows(store, 'email')[0].status, 'queued', 'A retried enqueue leaves the row honestly queued.');
  await fs.rm(dir, {recursive: true, force: true});
});

test('a row whose delivery task never landed is reaped, and one that did is left alone', async () => {
  const {store, dir} = await harness();
  const ago = ms => new Date(Date.now() - ms).toISOString();
  const insert = (id, channel, createdAt) => store.run(
    `INSERT INTO notifications (id,workspace_id,user_id,channel,title,body,meta,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`, id, 'default', 'u1', channel, 'Interrupted', '', '{}', 'queued', createdAt);
  // The process exited between the row's commit and the task's: the row reads
  // `queued` and no task exists to deliver it.
  const orphan = crypto.randomUUID();
  insert(orphan, 'email', ago(11 * 60000));
  // A row written a moment ago may still be waiting on `store.update`.
  const fresh = crypto.randomUUID();
  insert(fresh, 'email', ago(1000));
  // A row whose task did land is queued in the honest sense.
  const queued = crypto.randomUUID();
  insert(queued, 'email', ago(30 * 60000));
  const {enqueueTask} = await import('../shared/tasks.js');
  await store.update(s => { enqueueTask(s, {kind: 'notification', idempotencyKey: `notify:email:${queued}`,
    payload: {notificationId: queued, channel: 'email', target: 'ops@example.com', title: 't', body: ''}}); });
  assert.equal(notifications.reapOrphanedDeliveries(store), 1, 'Only the row with no task behind it is reaped.');
  const row = id => store.get('SELECT status, meta FROM notifications WHERE id=?', id);
  assert.equal(row(orphan).status, 'failed');
  assert.match(row(orphan).meta, /never queued/);
  assert.equal(row(fresh).status, 'queued', 'A row younger than the grace window is left alone.');
  assert.equal(row(queued).status, 'queued', 'A row with a delivery task is left alone.');
  // Recording anything reaps on its own, so the feed cannot show a pending
  // delivery forever while nothing sweeps.
  const stale = crypto.randomUUID();
  insert(stale, 'webhook', ago(60 * 60000));
  notifications.notify(store, null, {userId: 'u1', title: 'Later', body: ''});
  assert.equal(row(stale).status, 'failed', 'The next notification corrects the stale row.');
  await fs.rm(dir, {recursive: true, force: true});
});
