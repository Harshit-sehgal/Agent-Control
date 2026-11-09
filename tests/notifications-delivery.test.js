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
import {RETRY_STARTED, RETRY_WINDOW_MS} from '../shared/tasks.js';

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
  const stillTrying = rows(store, 'webhook')[0];
  assert.equal(stillTrying.status, 'queued', 'Out of attempts is not the end: the queue re-arms inside its window.');
  assert.match(stillTrying.meta, /no longer exists/);
  await assert.rejects(notifications.deliver(store, {...own, attempts: 2, payload: {...own.payload, [RETRY_STARTED]: Date.now() - 7 * 3600000}}), /no longer exists/);
  const failed = rows(store, 'webhook')[0];
  assert.equal(failed.status, 'failed', 'The window spent with no attempt left is the terminal failure.');
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

test('a row stays in doubt while the queue still has the six-hour window left', async () => {
  const {store, dir} = await harness();
  const id = crypto.randomUUID();
  store.run(`INSERT INTO notifications (id,workspace_id,user_id,channel,title,body,meta,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, id, 'default', 'u1', 'webhook', 'Heads up', '', '{}', 'queued', new Date().toISOString());
  const task = {id: 't-window', attempts: 3, maxAttempts: 3, payload: {notificationId: id, channel: 'webhook', target: 'gone'}};
  // Out of attempts, but the retry window is still open: `failTask` re-arms this,
  // so the feed must not say "failed" hours before the last try.
  await assert.rejects(notifications.deliver(store, task));
  const pending = store.get('SELECT status, meta FROM notifications WHERE id=?', id);
  assert.equal(pending.status, 'queued');
  assert.match(pending.meta, /no longer exists/, 'The reason is recorded, so the feed can say why it is retrying.');
  // The window spent is the queue's own rule, measured from the first failure.
  const spent = {...task, payload: {...task.payload, [RETRY_STARTED]: Date.now() - 7 * 3600000}};
  await assert.rejects(notifications.deliver(store, spent));
  assert.equal(store.get('SELECT status FROM notifications WHERE id=?', id).status, 'failed');
  await fs.rm(dir, {recursive: true, force: true});
});

test('a row whose task finished but whose own write was refused settles from the task', async () => {
  const {store, dir} = await harness();
  const {enqueueTask, claimTasks, completeTask} = await import('../shared/tasks.js');
  const old = new Date(Date.now() - 30 * 60000).toISOString();
  const insert = (id, channel) => store.run(`INSERT INTO notifications (id,workspace_id,user_id,channel,title,body,meta,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?)`, id, 'default', 'u1', channel, 'Heads up', '', '{}', 'queued', old);
  const delivered = crypto.randomUUID();
  const broke = crypto.randomUUID();
  insert(delivered, 'email');
  insert(broke, 'email');
  await store.update(s => {
    for (const id of [delivered, broke]) enqueueTask(s, {kind: 'notification', idempotencyKey: `notify:email:${id}`,
      payload: {notificationId: id, channel: 'email', target: 'ops@example.com', title: 't', body: ''}});
    const claimed = claimTasks(s, {workerId: 'w1', now: Date.now()});
    for (const task of claimed) completeTask(s, task.id, {ok: true, id: task.payload.notificationId});
  });
  // The delivery left, but the `sent_at` write was refused (a busy workspace), and
  // nothing else would ever look at the row again: the reaper only knew about rows
  // with *no* task.
  assert.equal(store.get('SELECT status FROM notifications WHERE id=?', delivered).status, 'queued');
  notifications.reapOrphanedDeliveries(store);
  assert.equal(store.get('SELECT status FROM notifications WHERE id=?', delivered).status, 'sent');
  assert.equal(store.get('SELECT status FROM notifications WHERE id=?', broke).status, 'sent');
  await fs.rm(dir, {recursive: true, force: true});
});

const insertRow = (store, id, channel, createdAt = new Date().toISOString()) => store.run(
  `INSERT INTO notifications (id,workspace_id,user_id,channel,title,body,meta,status,created_at)
   VALUES (?,?,?,?,?,?,?,?,?)`, id, 'default', 'u1', channel, 'title', 'body', '{}', 'queued', createdAt);
const insertTask = (store, id, payload, status = 'queued') => store.run(
  `INSERT INTO tasks (id,kind,title,payload,status,run_at,created_at,updated_at)
   VALUES (?,?,?,?,?,?,?,?)`, id, 'notification', 'Deliver', JSON.stringify(payload), status,
  new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
const rowOf = (store, id) => store.get('SELECT status, meta FROM notifications WHERE id=?', id);

test('a delivery row is failed only once the queue itself has given up', async () => {
  const {store, dir} = await harness();
  for (const id of ['n-spent', 'n-fresh', 'n-unanchored']) insertRow(store, id, 'email');
  const task = (id, payload) => ({id, attempts: 1, maxAttempts: 1, payload: {notificationId: id.replace('t-', 'n-'), channel: 'email', target: 'ops@example.com', ...payload}});
  const mail = process.env.SMTP_HOST, relay = process.env.EMAIL_RELAY_URL;
  delete process.env.SMTP_HOST; delete process.env.EMAIL_RELAY_URL; // no mailbox and no gateway
  try {
    // Budget spent and the window gone: this is the only case that reads "failed".
    await assert.rejects(notifications.deliver(store, task('t-spent', {[RETRY_STARTED]: Date.now() - RETRY_WINDOW_MS - 60000})));
    assert.equal(rowOf(store, 'n-spent').status, 'failed');

    // The same exhausted attempt count with the window still open is in doubt,
    // not failed: the queue re-arms and the next try may succeed.
    await assert.rejects(notifications.deliver(store, task('t-fresh', {[RETRY_STARTED]: Date.now() - 60000})));
    assert.equal(rowOf(store, 'n-fresh').status, 'queued');

    // And the anchor the queue actually writes is the one read here. The old key
    // (`retryStarted`) never matched, so the window was never spent and a channel
    // that had used every attempt stayed "queued" in the feed for good.
    await assert.rejects(notifications.deliver(store, task('t-unanchored', {})));
    assert.equal(rowOf(store, 'n-unanchored').status, 'queued');
    assert.match(String(JSON.parse(rowOf(store, 'n-unanchored').meta).deliveryError), /mailbox|relay/i);
  } finally {
    if (mail === undefined) delete process.env.SMTP_HOST; else process.env.SMTP_HOST = mail;
    if (relay === undefined) delete process.env.EMAIL_RELAY_URL; else process.env.EMAIL_RELAY_URL = relay;
    await fs.rm(dir, {recursive: true, force: true});
  }
});

test('the sweep settles a row from the task of its own channel, never a sibling channel', async () => {
  const {store, dir} = await harness();
  const long = new Date(Date.now() - 3600000).toISOString();
  insertRow(store, 'n-1', 'email', long);
  // A task that names this row's id but belongs to another channel. The join
  // used to match on the id alone, so a webhook delivery reported the email row
  // "sent" even though no email was ever attempted.
  insertTask(store, 'task-webhook', {notificationId: 'n-1', channel: 'webhook', target: 'https://hooks.example.com/x'}, 'done');

  const settled = notifications.reapOrphanedDeliveries(store, {now: Date.now(), graceMs: 1000});

  assert.equal(rowOf(store, 'n-1').status, 'queued', 'another channel must not settle this row');
  assert.equal(settled, 0, 'nothing was settled and the row is not an orphan either: a task does name it');
  // Its own task is the one that settles it, with its own outcome.
  insertTask(store, 'task-email', {notificationId: 'n-1', channel: 'email', target: 'ops@example.com'}, 'failed');
  store.run("UPDATE tasks SET last_error='Email relay responded 500.' WHERE id='task-email'");
  notifications.reapOrphanedDeliveries(store, {now: Date.now(), graceMs: 1000});
  assert.equal(rowOf(store, 'n-1').status, 'failed');
  assert.match(String(JSON.parse(rowOf(store, 'n-1').meta).deliveryError), /500/);
  await fs.rm(dir, {recursive: true, force: true});
});
