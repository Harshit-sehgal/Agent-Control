import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadMasterKey,encryptJson,decryptJson,sha256} from '../src/vault.js';

async function sandbox() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vault-'));
  return {dir, dataFile: path.join(dir, 'state.json')};
}

test('a master key from the environment is used verbatim and must decode to 32 bytes', async () => {
  const original = process.env.MASTER_KEY;
  try {
    const {dir, dataFile} = await sandbox();
    const good = Buffer.from('k'.repeat(32)).toString('base64');
    process.env.MASTER_KEY = good;
    const first = loadMasterKey(dataFile);
    assert.equal(first.source, 'env');
    assert.equal(first.key.length, 32);
    // Round-trip through a value encrypted with the env key.
    const stored = encryptJson(first.key, {value: 'secret-1'});
    assert.equal(decryptJson(first.key, stored).value, 'secret-1');
    process.env.MASTER_KEY = Buffer.from('short').toString('base64');
    assert.throws(() => loadMasterKey(dataFile), /32 bytes/);
    // A keyfile is created next to the data file when no env key is set.
    const noEnv = await sandbox();
    delete process.env.MASTER_KEY;
    const fileKey = loadMasterKey(noEnv.dataFile);
    assert.equal(fileKey.source, 'keyfile');
    assert.equal((await fs.stat(path.join(noEnv.dir, 'vault.key'))).mode & 0o777, 0o600);
    // A second load reads the SAME key, so previously stored values still open.
    const again = loadMasterKey(noEnv.dataFile);
    assert.equal(again.key.equals(fileKey.key), true);
    await fs.rm(dir, {recursive: true, force: true});
    await fs.rm(noEnv.dir, {recursive: true, force: true});
  } finally {
    if (original === undefined) delete process.env.MASTER_KEY;
    else process.env.MASTER_KEY = original;
  }
});

test('a wrong key fails authentication instead of returning garbage', async () => {
  const {dir, dataFile} = await sandbox();
  const key = loadMasterKey(dataFile).key;
  const stored = encryptJson(key, {value: 'secret-2'});
  const other = crypto.randomBytes(32);
  assert.throws(() => decryptJson(other, stored), /unable to authenticate data|unsupported state/i);
  await fs.rm(dir, {recursive: true, force: true});
});

test('lookup hashing is stable and one-way', async () => {
  assert.equal(sha256('abc'), sha256('abc'));
  assert.notEqual(sha256('abc'), sha256('abd'));
  assert.equal(sha256('abc').length, 64);
});
