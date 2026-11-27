import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {takeLock, refreshLock, releaseLock, lockFileFor, STALE_MS} from '../agent/agent-lock.mjs';

/* The lock one process holds on a computer's pairing and browser jars (agent/agent-lock.mjs): a running agent, or a pair.
 * Created whole with `wx` (no hard links needed), and stale when its process is this one (a container restart gives the
 * agent the same pid), is gone, or has not refreshed it for two minutes. */

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-lock-')); t.after(() => { fs.chmodSync(d, 0o700); fs.rmSync(d, {recursive: true, force: true}); }); return d; };
const PID = 4242, OTHER = 7777;
const plant = (file, body, ageMs = 0) => {
  fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body), {mode: 0o600});
  const at = new Date(Date.now() - ageMs);
  fs.utimesSync(file, at, at);
};
const alive = (...pids) => pid => pids.includes(pid);

test('a lock is created with wx: private, whole, with the pid, a token and the time', t => {
  const file = path.join(tmp(t), 'agent.config.json.lock');
  const got = takeLock(file, {pid: PID});
  assert.equal(got.status, 'taken');
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(body.pid, PID);
  assert.match(body.token, /^[0-9a-f]{32}$/);
  assert.ok(Number.isFinite(body.at));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['agent.config.json.lock'], 'no other file is made');
});

test('a fresh lock held by another live process refuses', t => {
  const file = path.join(tmp(t), 'x.lock');
  plant(file, {pid: OTHER, token: 'a'.repeat(32), at: Date.now()});
  assert.equal(takeLock(file, {pid: PID, alive: alive(OTHER)}).status, 'held');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, OTHER, 'and it is left as it was');
});

test('a lock naming this very process is stale: a restarted container gets the same pid', t => {
  const file = path.join(tmp(t), 'x.lock');
  plant(file, {pid: PID, token: 'a'.repeat(32), at: Date.now()});
  assert.equal(takeLock(file, {pid: PID, alive: alive(PID)}).status, 'taken');
});

test('a lock whose process is gone is stale', t => {
  const file = path.join(tmp(t), 'x.lock');
  plant(file, {pid: OTHER, token: 'a'.repeat(32), at: Date.now()});
  assert.equal(takeLock(file, {pid: PID, alive: alive()}).status, 'taken');
});

test('a lock with a live foreign pid but not refreshed for two minutes is stale', t => {
  const file = path.join(tmp(t), 'x.lock');
  plant(file, {pid: OTHER, token: 'a'.repeat(32), at: Date.now()}, STALE_MS + 1000);
  assert.equal(takeLock(file, {pid: PID, alive: alive(OTHER)}).status, 'taken', 'the pid was reused by something else');
  plant(file, {pid: OTHER, token: 'a'.repeat(32), at: Date.now()}, STALE_MS - 20000);
  assert.equal(takeLock(file, {pid: 1, alive: alive(OTHER)}).status, 'held', 'a minute-old one is not');
});

test('a lock with no pid is held while it is young (its maker is mid-write) and stale once it is not', t => {
  const file = path.join(tmp(t), 'x.lock');
  for (const body of ['', '{"pi', 'garbage', '12345']) {
    plant(file, body, 1000);
    assert.equal(takeLock(file, {pid: PID, alive: alive(OTHER)}).status, 'held', `young: ${JSON.stringify(body)}`);
    plant(file, body, 60000);
    assert.equal(takeLock(file, {pid: PID, alive: alive(OTHER)}).status, 'taken', `old: ${JSON.stringify(body)}`);
    releaseLock(takeLock(file, {pid: PID}).lock);
    fs.rmSync(file, {force: true});
  }
});

test('only the holder gives a lock back, and a refresh keeps it fresh without touching another\'s', t => {
  const file = path.join(tmp(t), 'x.lock');
  const mine = takeLock(file, {pid: PID}).lock;
  const old = new Date(Date.now() - 90000);
  fs.utimesSync(file, old, old);
  refreshLock(mine);
  assert.ok(Date.now() - fs.statSync(file).mtimeMs < 5000, 'the refresh moved the time');
  // Another process replaced it (this one was thought gone): the old holder neither refreshes nor removes it.
  plant(file, {pid: OTHER, token: 'b'.repeat(32), at: Date.now()}, 1000);
  const before = fs.statSync(file).mtimeMs;
  refreshLock(mine);
  releaseLock(mine);
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.ok(fs.existsSync(file));
  const again = takeLock(path.join(path.dirname(file), 'y.lock'), {pid: PID}).lock;
  releaseLock(again);
  assert.equal(fs.existsSync(again.file), false, 'the holder removes its own');
});

test('a read-only folder is "unavailable", not a crash', t => {
  if (process.getuid?.() === 0) return t.skip('root writes anywhere');
  const dir = tmp(t);
  fs.chmodSync(dir, 0o500);
  const got = takeLock(path.join(dir, 'x.lock'), {pid: PID});
  assert.equal(got.status, 'unavailable');
  assert.match(got.code, /^(EACCES|EROFS|EPERM)$/);
  releaseLock(got.lock);   // nothing to give back is fine
});

test('any error making the lock other than "it exists" is "unavailable", and a lock whose write failed is not left behind', t => {
  for (const code of ['ENOSPC', 'EDQUOT', 'EIO', 'ENOTSUP']) {
    const file = path.join(tmp(t), 'x.lock');
    const open = t.mock.method(fs, 'openSync', () => { throw Object.assign(new Error(code), {code}); });
    assert.deepEqual(takeLock(file, {pid: PID}), {status: 'unavailable', code}, `${code} at open`);
    open.mock.restore();
    const write = t.mock.method(fs, 'writeFileSync', () => { throw Object.assign(new Error(code), {code}); });
    assert.deepEqual(takeLock(file, {pid: PID}), {status: 'unavailable', code}, `${code} at write`);
    write.mock.restore();
    assert.equal(fs.existsSync(file), false, `${code}: the empty lock the failed write made is removed`);
    assert.equal(takeLock(file, {pid: PID}).status, 'taken', 'and the next try takes it');
  }
});

test('a link and its target share one lock', t => {
  const dir = tmp(t);
  const real = path.join(dir, 'volume.json');
  fs.writeFileSync(real, '{}');
  const link = path.join(dir, 'agent.config.json');
  fs.symlinkSync(real, link);
  assert.equal(lockFileFor(link), `${fs.realpathSync(real)}.lock`);
  assert.equal(lockFileFor(path.join(dir, 'not-yet.json')), path.join(dir, 'not-yet.json.lock'), 'a config not made yet');
});
