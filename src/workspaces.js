/** One store per workspace.
 *
 * Accounts, sessions and memberships live in the first workspace's database.
 * Everything a workspace owns (groups, bots, posts, drafts, conversations,
 * tasks, paired agents, credentials, notifications) lives in a database file of
 * its own, so one workspace's data cannot leak into another through a query
 * that forgot a filter: the rows are not in the file being read.
 *
 * The first workspace keeps using the installation's original database, so an
 * existing single-workspace install needs no data move.
 */
import fs from 'node:fs/promises';
import {SqliteStore} from './sqlite-store.js';
import {DEFAULT_WORKSPACE} from './auth.js';
import {timingEqual} from './http.js';
import {markInterrupted} from './coordination.js';

const ID = /^[a-z0-9-]{1,64}$/;
export const validWorkspaceId = id => typeof id === 'string' && ID.test(id);

/** The database file of a workspace, next to the installation's own. */
export function workspaceDbPath(primaryDbPath, id) {
  if (!validWorkspaceId(id)) throw new Error('Workspace id is not usable as a file name.');
  return `${primaryDbPath.replace(/\.db$/, '')}.ws-${id}.db`;
}

/** `start(store, id)` runs a workspace's background services and returns the
 * function that stops them. */
export async function openWorkspaces(primary, auth, start) {
  const open = new Map();
  const changes = new Set();
  let globallyPaused = false;
  const waitForWork = entry => entry.active
    ? new Promise(resolve => entry.idle.push(resolve))
    : Promise.resolve();
  const trackChange = fn => {
    const change = Promise.resolve().then(fn);
    changes.add(change);
    change.then(() => changes.delete(change), () => changes.delete(change));
    return change;
  };
  async function waitForChanges() {
    while (changes.size) await Promise.allSettled([...changes]);
  }
  async function stopEntry(entry) {
    if (!entry.stop || entry.stopped) return;
    const stop = entry.stop;
    await stop();
    if (entry.stop === stop) entry.stopped = true;
  }
  async function pauseEntry(entry) {
    entry.paused = true;
    await stopEntry(entry);
    await waitForWork(entry);
    await entry.store.serial;
  }
  async function resumeEntry(id, entry) {
    if (open.get(id) !== entry || !entry.paused) return;
    if (entry.stopped) {
      const stop = start(entry.store, id);
      entry.stop = stop;
      entry.stopped = false;
      try { await stop.ready; }
      catch (error) {
        await stopEntry(entry);
        throw error;
      }
    }
    entry.paused = false;
  }
  function track(entry, fn) {
    if (entry.paused) return Promise.reject(Object.assign(new Error('This workspace is being restored. Try again shortly.'), {status: 503}));
    entry.active++;
    return Promise.resolve().then(fn).finally(() => {
      entry.active--;
      if (!entry.active) for (const resolve of entry.idle.splice(0)) resolve();
    });
  }
  // A workspace is handed out only after its recovery has run, so no request
  // or sweep can see state left half-finished by a previous process.
  async function add(id, store, paused = false) {
    const entry = {store, stop: null, stopped: true, active: 0, idle: [], paused};
    store.trackWork = fn => track(entry, fn);
    entry.stop = start(store, id);
    entry.stopped = false;
    try {
      if (paused) await stopEntry(entry);
      await entry.stop.ready;
    } catch (error) {
      await stopEntry(entry).catch(() => {});
      throw error;
    }
    open.set(id, entry);
    return store;
  }
  async function load(id, paused = false) {
    const file = workspaceDbPath(primary.dbPath, id);
    // No legacy JSON document exists for these, so the import path is a file
    // that is never there.
    const store = await new SqliteStore(file, `${file}.json`).init();
    store.vaultKey = primary.vaultKey;
    return add(id, store, paused || globallyPaused);
  }
  async function discard(id, entry, beforeDiscard = null) {
    try { await pauseEntry(entry); }
    catch (error) {
      await resumeEntry(id, entry).catch(restartError => console.error(`Could not restart workspace ${id}:`, restartError.message));
      throw error;
    }
    try { await beforeDiscard?.(); }
    catch (error) {
      await resumeEntry(id, entry).catch(restartError => console.error(`Could not restart workspace ${id}:`, restartError.message));
      throw error;
    }
    if (open.get(id) === entry) open.delete(id);
    try { await markInterrupted(entry.store); }
    catch (error) { console.error(`Could not interrupt removed workspace ${id}:`, error.message); }
    await entry.store.close();
    const file = workspaceDbPath(primary.dbPath, id);
    for (const suffix of ['', '-wal', '-shm']) await fs.rm(file + suffix, {force: true});
  }
  await add(DEFAULT_WORKSPACE, primary);
  for (const id of auth.workspaceIds()) if (id !== DEFAULT_WORKSPACE) await load(id);

  return {
    get: id => open.get(id)?.store || null,
    all: () => [...open].map(([id, {store}]) => ({id, store})),
    create(idOrCreate) {
      if (globallyPaused) return Promise.reject(Object.assign(new Error('A restore is already in progress.'), {status: 409}));
      return trackChange(async () => load(typeof idOrCreate === 'function' ? await idOrCreate() : idOrCreate));
    },
    /** Reconcile stores after a restore: start listed workspaces and stop
     * services for workspaces the restored account database no longer lists. */
    async sync() {
      if (!globallyPaused) await waitForChanges();
      const ids = new Set(auth.workspaceIds());
      for (const [id, entry] of open) {
        if (ids.has(id)) continue;
        await discard(id, entry);
      }
      for (const id of ids) if (!open.has(id)) await load(id, globallyPaused);
    },
    /** Stop background services, drain model work, and run a synchronous
     * database replacement without allowing an old model result to land after it. */
    async withPaused(id, fn) {
      if (globallyPaused) throw Object.assign(new Error('A restore is already in progress.'), {status: 409});
      const entry = open.get(id);
      if (!entry) throw Object.assign(new Error('This workspace is no longer available.'), {status: 404});
      if (entry.paused) throw Object.assign(new Error('A restore is already in progress for this workspace.'), {status: 409});
      entry.paused = true;
      try {
        await pauseEntry(entry);
        return await fn(entry.store);
      } finally {
        try { await resumeEntry(id, entry); }
        finally { for (const resolve of entry.idle.splice(0)) resolve(); }
      }
    },
    /** Fence every workspace while the primary database and memberships are replaced. */
    async withAllPaused(fn) {
      if (globallyPaused || [...open.values()].some(entry => entry.paused)) {
        throw Object.assign(new Error('A restore is already in progress.'), {status: 409});
      }
      globallyPaused = true;
      for (const entry of open.values()) entry.paused = true;
      let result, failure;
      try {
        await waitForChanges();
        const entries = [...open].map(([id, entry]) => [id, entry]);
        const paused = await Promise.allSettled(entries.map(([, entry]) => pauseEntry(entry)));
        const failedPause = paused.find(item => item.status === 'rejected');
        if (failedPause) throw failedPause.reason;
        const entry = open.get(DEFAULT_WORKSPACE);
        if (!entry) throw Object.assign(new Error('The primary workspace is no longer available.'), {status: 404});
        result = await fn(entry.store);
      } catch (error) {
        failure = error;
      }
      const resumed = await Promise.allSettled([...open].map(([id, entry]) => resumeEntry(id, entry)));
      globallyPaused = false;
      for (const [id, entry] of open) for (const resolve of entry.idle.splice(0)) resolve();
      if (failure) throw failure;
      const failedResume = resumed.find(item => item.status === 'rejected');
      if (failedResume) throw failedResume.reason;
      return result;
    },
    /** Stop the workspace's services and delete its database files. */
    async remove(id, beforeDiscard = null) {
      if (id === DEFAULT_WORKSPACE) throw Object.assign(new Error('The first workspace cannot be removed.'), {status: 409});
      if (globallyPaused) throw Object.assign(new Error('A restore is already in progress.'), {status: 409});
      return trackChange(async () => {
        const entry = open.get(id);
        if (!entry) return;
        if (entry.paused) throw Object.assign(new Error('This workspace is being restored. Try again shortly.'), {status: 409});
        await discard(id, entry, beforeDiscard);
      });
    },
    async stop() { await Promise.all([...open.values()].map(entry => stopEntry(entry))); },
    /** The workspace a capture token belongs to. Every token is compared, so
     * the time taken does not say which workspace came close. */
    byCaptureToken(token) {
      let found = null;
      for (const {store} of open.values()) if (timingEqual(token, store.captureToken())) found = store;
      return found;
    },
    /** The workspace holding a row, for the agent protocol: a device only
     * knows its own id or pairing code, not which workspace issued it. */
    holding(sql, value) {
      for (const {store} of open.values()) if (store.get(sql, value)) return store;
      return null;
    },
  };
}
