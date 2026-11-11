/** Restoring a backup into a workspace that is not the installation's first one
 * goes through `workspaces.withPaused` (src/workspaces.js): stop that
 * workspace's services, drain its in-flight work, swap the data, start them
 * again. It is the secondary-workspace restore path, and a failure there must
 * leave the workspace usable rather than paused forever. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openWorkspaces, workspaceDbPath} from '../src/workspaces.js';
import {DEFAULT_WORKSPACE} from '../src/auth.js';
import {SqliteStore} from '../src/sqlite-store.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const restored = id => ({id, botId: 'atlas', botName: 'Atlas', input: 'in', output: 'Restored run to keep.', at: new Date().toISOString()});

/** A real primary store plus one secondary workspace, with a `start` that only
 * records which workspace's services were started and stopped. */
async function installation() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workspaces-restore-'));
  const primaryFile = path.join(dir, 'state.db');
  const primary = await new SqliteStore(primaryFile, path.join(dir, 'state.json')).init();
  const services = [];
  const start = (store, id) => {
    services.push(['start', id]);
    const stop = async () => { services.push(['stop', id]); };
    stop.ready = Promise.resolve();
    return stop;
  };
  // Only `workspaceIds()` is consulted outside a restore, and `sync()` is not
  // part of this path, so a plain stub is the whole contract.
  const auth = {workspaceIds: () => [DEFAULT_WORKSPACE, 'client']};
  const workspaces = await openWorkspaces(primary, auth, start);
  return {
    dir, primaryFile, primary, workspaces, services, start,
    clientCalls: () => services.filter(([, id]) => id === 'client').map(([kind]) => kind),
    async done() {
      await workspaces.stop();
      for (const {store} of workspaces.all()) await store.close();
      await fs.rm(dir, {recursive: true, force: true});
    },
  };
}

test('restoring into a secondary workspace pauses it, swaps its data and resumes it', async () => {
  const t = await installation();
  try {
    const client = t.workspaces.get('client');
    assert.ok(client, 'the secondary workspace is opened at boot');
    assert.ok(!client.read().runs.some(c => c.id === 'restored-1'));

    // An in-flight piece of work must be drained before the data is replaced,
    // or a model result computed from the old rows lands after the restore.
    const order = [];
    const work = client.trackWork(async () => { await sleep(20); order.push('work'); return 'worked'; });
    const result = await t.workspaces.withPaused('client', async store => {
      order.push('restore');
      assert.equal(store, client, 'the restore operates on the live store, not a copy');
      assert.deepEqual(t.clientCalls(), ['start', 'stop'], 'its services are stopped while the data is swapped');
      await assert.rejects(store.trackWork(async () => 'late'), error => error.status === 503, 'new work is refused while paused');
      // What backup.importBackup does: replace the collections inside the store.
      await store.update(state => { state.runs = [restored('restored-1')]; });
      return 'swapped';
    });
    await work;

    assert.equal(result, 'swapped');
    assert.deepEqual(order, ['work', 'restore'], 'in-flight work finishes before the restore starts');
    assert.deepEqual(t.clientCalls(), ['start', 'stop', 'start'], 'its services are started again afterwards');

    const after = t.workspaces.get('client');
    assert.deepEqual(after.read().runs.map(c => c.id), ['restored-1'], 'the restored rows are what the workspace now holds');
    assert.equal(await after.trackWork(async () => 'accepted'), 'accepted', 'the workspace accepts work again');

    // The first workspace was never fenced by a secondary restore.
    assert.equal(await t.workspaces.get(DEFAULT_WORKSPACE).trackWork(async () => 'primary'), 'primary');
  } finally { await t.done(); }
});

test('a failed restore leaves the secondary workspace usable, not paused forever', async () => {
  const t = await installation();
  try {
    const client = t.workspaces.get('client');
    await client.update(state => { state.runs = [restored('before-failure')]; });
    const before = t.services.length;

    await assert.rejects(t.workspaces.withPaused('client', async store => {
      await store.update(state => { state.runs = [restored('half-written')]; });
      throw new Error('the backup document was rejected');
    }), /the backup document was rejected/);

    assert.deepEqual(t.services.slice(before).filter(([, id]) => id === 'client').map(([kind]) => kind), ['stop', 'start'],
      'the finally block must restart the services even when the restore throws');
    assert.equal(await t.workspaces.get('client').trackWork(async () => 'usable'), 'usable', 'not left refusing every request');
    await t.workspaces.get('client').update(state => { state.runs.push(restored('after-failure')); });
    assert.deepEqual(t.workspaces.get('client').read().runs.map(c => c.id), ['half-written', 'after-failure'],
      'a failed restore keeps whatever it had written rather than rolling back into a broken state');

    // And the workspace is still the same live store, so later restores work.
    await t.workspaces.withPaused('client', async store => { await store.update(state => { state.runs = [restored('second-try')]; }); });
    assert.deepEqual(t.workspaces.get('client').read().runs.map(c => c.id), ['second-try']);
    assert.deepEqual(t.clientCalls(), ['start', 'stop', 'start', 'stop', 'start']);
  } finally { await t.done(); }
});

test('withPaused refuses a workspace it does not know and one that is already restoring', async () => {
  const t = await installation();
  try {
    await assert.rejects(t.workspaces.withPaused('missing', async () => 'x'), error => error.status === 404);
    const first = t.workspaces.withPaused('client', () => sleep(30));
    await sleep(5);
    await assert.rejects(t.workspaces.withPaused('client', async () => 'x'), error => error.status === 409);
    await first;
  } finally { await t.done(); }
});

test('each workspace keeps its database next to the primary one', async () => {
  const t = await installation();
  try {
    await fs.stat(workspaceDbPath(t.primaryFile, 'client'));
  } finally { await t.done(); }
});
