/** A new install starts on Hands-off. An install that already chose a setting keeps it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {SqliteStore} from '../src/sqlite-store.js';

async function open(dir) {
  return new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
}

test('a new install starts on Hands-off', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-default-'));
  const store = await open(dir);
  try {
    assert.equal(store.read().handsOff, true);
  } finally { await store.close(); await fs.rm(dir, {recursive: true, force: true}); }
});

test('an install that chose Balanced keeps it after a restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ac-default-'));
  let store = await open(dir);
  await store.update(s => { s.handsOff = false; });
  await store.close();
  store = await open(dir);
  try {
    assert.equal(store.read().handsOff, false);
  } finally { await store.close(); await fs.rm(dir, {recursive: true, force: true}); }
});
