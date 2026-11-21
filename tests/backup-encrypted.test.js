/** The nightly encrypted backup round trip: the server encrypts with a PUBLIC certificate only, so a
 * copy of the backup is useless without the private key, which stays off the server. Restore checks the
 * database and the vault key. Skipped when sqlite3 or openssl is missing.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const have = cmd => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const ready = have('sqlite3') && have('openssl');

test('a nightly backup is encrypted to the public certificate and restores with the private key', {skip: !ready && 'needs sqlite3 and openssl', timeout: 60000}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-backup-'));
  const data = path.join(dir, 'data'), out = path.join(dir, 'out'), dest = path.join(dir, 'restored');
  fs.mkdirSync(data); fs.mkdirSync(out);
  execFileSync('sqlite3', [path.join(data, 'state.db'), 'create table tasks(id text); insert into tasks values ("t1");']);
  fs.writeFileSync(path.join(data, 'vault.key'), 'vault-key-material-for-test', {mode: 0o600});
  // The keypair: the private key never reaches the server in production.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=agent-control-backup'], {stdio: 'ignore'});

  const env = {...process.env, DATA_DIR: data, BACKUP_CERT: path.join(dir, 'cert.pem'), BACKUP_DIR: out, BACKUP_KEEP: '2'};
  const backup = execFileSync('bash', [path.join(root, 'deploy', 'backup-encrypted.sh')], {env}).toString().trim();
  assert.match(backup, /agent-control-.*\.tgz\.enc$/);
  const sealed = fs.readFileSync(backup, 'utf8');
  assert.ok(!sealed.includes('vault-key-material-for-test'), 'the backup is not readable without the key');
  assert.ok(!sealed.includes('create table'), 'the database is not readable without the key');

  const restored = execFileSync('bash', [path.join(root, 'deploy', 'restore-encrypted.sh'), backup, path.join(dir, 'key.pem'), dest]).toString();
  assert.match(restored, /integrity ok/);
  assert.equal(fs.readFileSync(path.join(dest, 'vault.key'), 'utf8'), 'vault-key-material-for-test');
  assert.equal(execFileSync('sqlite3', [path.join(dest, 'state.db'), 'select id from tasks;']).toString().trim(), 't1');
});

test('the backup keeps only the newest copies', {skip: !ready && 'needs sqlite3 and openssl', timeout: 60000}, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-keep-'));
  const data = path.join(dir, 'data'), out = path.join(dir, 'out');
  fs.mkdirSync(data); fs.mkdirSync(out);
  execFileSync('sqlite3', [path.join(data, 'state.db'), 'create table t(x);']);
  fs.writeFileSync(path.join(data, 'vault.key'), 'k');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-days', '2', '-subj', '/CN=t'], {stdio: 'ignore'});
  // Three old copies already on disk, oldest first; the run adds a newer one and keeps two.
  for (const [name, age] of [['20260101T000000Z', 3], ['20260102T000000Z', 2], ['20260103T000000Z', 1]]) {
    const file = path.join(out, `agent-control-${name}.tgz.enc`);
    fs.writeFileSync(file, 'old');
    const when = new Date(Date.now() - age * 86400000);
    fs.utimesSync(file, when, when);
  }
  const env = {...process.env, DATA_DIR: data, BACKUP_CERT: path.join(dir, 'cert.pem'), BACKUP_DIR: out, BACKUP_KEEP: '2'};
  const fresh = execFileSync('bash', [path.join(root, 'deploy', 'backup-encrypted.sh')], {env}).toString().trim();
  const left = fs.readdirSync(out).sort();
  assert.equal(left.length, 2);
  assert.ok(left.includes(path.basename(fresh)), 'the newest backup is kept');
  assert.ok(!left.includes('agent-control-20260101T000000Z.tgz.enc'), 'the oldest is removed');
});
