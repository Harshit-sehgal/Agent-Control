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

const ID = /^[a-z0-9-]{1,64}$/;

/** The database file of a workspace, next to the installation's own. */
export function workspaceDbPath(primaryDbPath, id) {
  if (!ID.test(id)) throw new Error('Workspace id is not usable as a file name.');
  return `${primaryDbPath.replace(/\.db$/, '')}.ws-${id}.db`;
}

/** `start(store, id)` runs a workspace's background services and returns the
 * function that stops them. */
export async function openWorkspaces(primary, auth, start) {
  const open = new Map();
  // A workspace is handed out only after its recovery has run, so no request
  // or sweep can see state left half-finished by a previous process.
  async function add(id, store) {
    const stop = start(store, id);
    await stop.ready;
    open.set(id, {store, stop});
    return store;
  }
  async function load(id) {
    const file = workspaceDbPath(primary.dbPath, id);
    // No legacy JSON document exists for these, so the import path is a file
    // that is never there.
    const store = await new SqliteStore(file, `${file}.json`).init();
    store.vaultKey = primary.vaultKey;
    return add(id, store);
  }
  await add(DEFAULT_WORKSPACE, primary);
  for (const id of auth.workspaceIds()) if (id !== DEFAULT_WORKSPACE) await load(id);

  return {
    get: id => open.get(id)?.store || null,
    all: () => [...open].map(([id, {store}]) => ({id, store})),
    create: load,
    /** Open any workspace that is listed but not open, after a restore. */
    async sync() { for (const id of auth.workspaceIds()) if (!open.has(id)) await load(id); },
    /** Stop the workspace's services and delete its database files. */
    async remove(id) {
      if (id === DEFAULT_WORKSPACE) throw new Error('The first workspace cannot be removed.');
      const entry = open.get(id);
      if (!entry) return;
      open.delete(id);
      entry.stop();
      await entry.store.close();
      const file = workspaceDbPath(primary.dbPath, id);
      for (const suffix of ['', '-wal', '-shm']) await fs.rm(file + suffix, {force: true});
    },
    stop() { for (const {stop} of open.values()) stop(); },
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
