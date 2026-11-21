/** The database and its write-ahead files hold recent writes, so other local users must not read them. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../src/sqlite-store.js';

test('the database and its WAL and shared-memory files are private to the owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-modes-'));
  const file = path.join(dir, 'state.db');
  const store = await openStore(file);
  const file2 = store.dbPath;
  try {
    await store.update(s => { s.activity = [{id: 'a1', at: new Date().toISOString(), kind: 'bots', text: 'x', botId: 'b'}]; });
    for (const f of [file2, `${file2}-wal`, `${file2}-shm`]) {
      if (!fs.existsSync(f)) continue;
      assert.equal(fs.statSync(f).mode & 0o077, 0, `${path.basename(f)} is readable by group or others`);
    }
    assert.ok(fs.existsSync(`${file2}-wal`), 'the WAL file exists, so the check ran on it');
  } finally {
    await store.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
});
