/** Store-level persistence guarantees that do not need a running server:
 * a failed transaction must surface the original error, a store that fails to
 * open must not leak its file handle, and the candidate release / agent
 * retention paths must survive the rows they are asked to touch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../src/sqlite-store.js';
import * as wf from '../shared/workflow.js';

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'store-guards-'));
const openAt = async dir => new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();

/** Whether a path is still an open descriptor in this process (Linux only). */
async function openDescriptors(file) {
  try {
    const names = await fs.readdir('/proc/self/fd');
    const links = await Promise.all(names.map(name => fs.readlink(`/proc/self/fd/${name}`).catch(() => '')));
    return links.filter(link => link === file).length;
  } catch { return null; }
}

/** Wrap a real connection so one statement (`ROLLBACK`) fails the way SQLite
 * does after it has already rolled the transaction back itself. */
function withFailingRollback(db) {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'exec') {
        return sql => {
          if (/^\s*ROLLBACK/i.test(String(sql))) throw new Error('cannot rollback - no transaction is active');
          return target.exec(sql);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('a transaction whose ROLLBACK also fails still reports the original error', async () => {
  const dir = await temp();
  try {
    const store = await openAt(dir);
    const real = store.db;
    store.db = withFailingRollback(real);
    try {
      assert.throws(() => store.transaction(() => {
        store.run("INSERT INTO kv (key,value) VALUES ('half','written')");
        throw new Error('disk I/O error while writing the transaction');
      }), /disk I\/O error while writing the transaction/,
        'the guard must rethrow the real failure, not "cannot rollback"');
    } finally { store.db = real; }
    // The guard swallowed the refused ROLLBACK instead of masking the original
    // error; the transaction is still open here, so unwind it and prove the
    // store keeps working.
    real.exec('ROLLBACK');
    assert.equal(store.kvGet('half'), null);
    store.kvSet('after', 'ok');
    assert.equal(store.kvGet('after'), 'ok');
    await store.close();
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('migrate() rolls back cleanly when its own ROLLBACK is refused', async () => {
  const dir = await temp();
  try {
    const store = await openAt(dir);
    const real = store.db;
    store.run('UPDATE schema_meta SET version=? WHERE id=1', 1);
    store.db = withFailingRollback(real);
    try {
      // v2+ would run again against a database that already has those columns.
      assert.throws(() => store.migrate(), /duplicate column|already exists|no such/i);
    } finally { store.db = real; }
    assert.equal(store.get('SELECT version FROM schema_meta WHERE id=1').version, 1, 'the failed migration is not recorded');
    await store.close();
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('a store that refuses to open closes its file handle', async () => {
  const dir = await temp();
  try {
    const file = path.join(dir, 'state.db');
    const first = await openAt(dir);
    first.run('UPDATE schema_meta SET version=? WHERE id=1', 999);
    await first.close();

    const before = await openDescriptors(file);
    const second = new SqliteStore(file, path.join(dir, 'state.json'));
    await assert.rejects(second.init(), /written by a newer version/);
    assert.equal(second.db, null, 'the failed open must not keep the handle reference');
    const after = await openDescriptors(file);
    if (before !== null && after !== null) {
      assert.equal(after, before, 'the handle is closed, not leaked for the process lifetime');
    }
    // Back to a version this build understands: the file still opens.
    const {DatabaseSync} = await import('../src/sqlite.js').then(m => m.sqlite());
    const raw = new DatabaseSync(file);
    raw.prepare('UPDATE schema_meta SET version=? WHERE id=1').run(1);
    raw.close();
    const third = new SqliteStore(file, path.join(dir, 'state.json')).init();
    await assert.rejects(third, /duplicate column|already exists|no such/i, 'a downgraded file is still this build\'s problem to report');
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('a candidate whose draft failed is released even when the workflow transition cannot run', async () => {
  const dir = await temp();
  try {
    const store = await openAt(dir);
    const added = await store.update(s => wf.addCandidate(s, {url: 'https://x.com/test/status/9', text: 'A post about queues and retries.', author: 'Tester', topic: 'AI'}));
    const id = added.candidate.id;
    await store.update(s => wf.beginProcessing(s, id));

    assert.equal(store.failCandidate(id), true);
    const row = store.get('SELECT status, doc FROM candidates WHERE id=?', id);
    assert.equal(row.status, 'error', 'the typed column the queue reads is released');
    assert.equal(JSON.parse(row.doc).status, 'error', 'the document the UI reads is released too');
    // A candidate deleted mid-draft is not an error for the fallback.
    assert.equal(store.failCandidate('gone'), false);
    // The workflow transition itself throws for that case, which is exactly why
    // the draft-failure path needs a fallback that cannot 404 over the real error.
    assert.throws(() => wf.failProcessing(store.read(), 'gone', 'provider timed out'), error => error.status === 404 && /Candidate not found/.test(error.message));
    await assert.rejects(store.update(s => wf.failProcessing(s, 'gone', 'provider timed out')), error => error.status === 404);
    await store.close();
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});

test('agent retention prunes consumed pairing codes and finished tasks only', async () => {
  const dir = await temp();
  try {
    const store = await openAt(dir);
    const iso = ms => new Date(Date.now() - ms).toISOString();
    const day = 86400000;
    const code = (hash, {consumed = null, expires = iso(0)}) => store.run(
      'INSERT INTO pairing_codes (code_hash,workspace_id,label,created_by,expires_at,created_at,consumed_at) VALUES (?,?,?,?,?,?,?)',
      hash, 'default', 'Device', null, expires, iso(30 * day), consumed);
    code('consumed-old', {consumed: iso(2 * day)});
    code('consumed-recent', {consumed: iso(3600000)});
    code('expired-unused', {expires: iso(2 * day)});
    code('still-open', {expires: iso(-10 * 60000)});

    const task = (id, {status, completed = null}) => store.run(
      'INSERT INTO agent_tasks (id,agent_id,kind,payload,status,attempts,max_attempts,created_by,created_at,updated_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id, 'agent-1', 'http.check', '{}', status, 1, 3, null, iso(60 * day), iso(60 * day), completed);
    task('done-old', {status: 'done', completed: iso(40 * day)});
    task('failed-old', {status: 'failed', completed: iso(40 * day)});
    task('done-recent', {status: 'done', completed: iso(day)});
    task('queued-old', {status: 'queued'});
    task('running-old', {status: 'running'});

    const report = store.pruneAgentRows();
    assert.deepEqual(report, {pairingCodes: 2, agentTasks: 2});
    assert.deepEqual(store.all('SELECT code_hash FROM pairing_codes ORDER BY code_hash').map(r => r.code_hash), ['consumed-recent', 'still-open']);
    // Work that has not finished is never pruned, however old it is.
    assert.deepEqual(store.all('SELECT id FROM agent_tasks ORDER BY id').map(r => r.id), ['done-recent', 'queued-old', 'running-old']);
    // A second sweep has nothing left to do.
    assert.deepEqual(store.pruneAgentRows(), {pairingCodes: 0, agentTasks: 0});
    await store.close();
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
});
