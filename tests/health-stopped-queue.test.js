/** A queue that was stopped on purpose is not a stalled queue.
 *
 * A restore stops a workspace's services (`workspaces.withPaused`) while its store stays listed for health. The
 * stopped queue's last tick then aged past a minute and `/api/health` answered 503 mid-restore, which a container
 * health check reads as a reason to restart the server. Stopping now clears the tick, and starting sets it at once.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {SqliteStore} from '../src/sqlite-store.js';
import {createQueue, lastSweepAt} from '../src/queue.js';
import {healthOf} from '../src/health.js';

test('a stopped queue drops out of the health check, and a started one is in it at once', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-health-stop-'));
  const store = await new SqliteStore(path.join(dir, 'state.db'), path.join(dir, 'state.json')).init();
  try {
    const queue = createQueue(store, {}, {intervalMs: 10});
    const stop = queue.start();
    assert.ok(lastSweepAt(store) > 0, 'a started queue is ticking from the start');
    await new Promise(r => setTimeout(r, 40));
    await stop();
    assert.equal(lastSweepAt(store), 0);
    assert.equal(healthOf([store], {lastSweep: lastSweepAt, now: Date.now() + 120000}), true, 'a restore that takes two minutes is not an outage');
    const again = queue.start();
    assert.ok(Date.now() - lastSweepAt(store) < 1000);
    await again();
  } finally {
    await store.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
});
