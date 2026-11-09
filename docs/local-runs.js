/** Cross-tab coordination for Pages-demo runs. Web Locks provide an atomic
 * short claim; localStorage leases keep live work visible and recoverable. */
import {groupIdOfChat, matchesBusyChat} from './chats.js?v=4f8cfed5b9';

export const LOCAL_RUNS_KEY = 'agent-control-coordination-runs-v1';
export const LOCAL_RUN_BUSY = ['running', 'queued', 'awaiting_feed', 'awaiting_browser', 'awaiting_plan', 'awaiting_checkpoint'];
const ACTIVE = new Set(['running', 'queued']);
const LEASE_MS = 5 * 60_000;
const now = () => new Date().toISOString();
const fail = (message, status = 409) => { throw Object.assign(new Error(message), {status}); };

export function withLocalLock(name, fn) {
  const lockName = `agent-control:${name}`;
  if (typeof globalThis.navigator?.locks?.request !== 'function') {
    fail('This browser cannot safely coordinate updates across tabs. Use a browser with Web Locks enabled.', 503);
  }
  // Never reject inside the Web Locks callback: Node 24's LockManager keeps
  // the lock held forever when the callback's promise rejects (browsers
  // release it), which wedges every later lock request under that name — the
  // whole tab's run coordination deadlocks after one failed claim. Capture
  // the error and rethrow it once the lock has been properly released.
  let failure;
  return navigator.locks.request(lockName, {mode: 'exclusive'}, async () => {
    try { return await fn(); } catch (error) { failure = error; }
  }).then(result => {
    if (failure) throw failure;
    return result;
  });
}

export function readLocalRuns() {
  let raw;
  try { raw = localStorage.getItem(LOCAL_RUNS_KEY); }
  catch { throw new Error('Browser storage is unavailable. Enable local storage to use this demo.'); }
  if (!raw) return [];
  try {
    const runs = JSON.parse(raw);
    if (!Array.isArray(runs)) throw new Error();
    return runs;
  } catch { throw new Error('Browser run history is unreadable. Clear the demo storage to continue.'); }
}

export function writeLocalRuns(runs) {
  try { localStorage.setItem(LOCAL_RUNS_KEY, JSON.stringify(runs)); }
  catch { throw new Error('Unable to save browser-local run state. Check available storage and private browsing settings.'); }
}

export async function mutateLocalRuns(update) {
  return withLocalLock('runs', () => {
    const runs = readLocalRuns();
    const result = update(runs);
    writeLocalRuns(runs);
    return result;
  });
}

function interruptExpired(runs, time = Date.now()) {
  let changed = false;
  const next = runs.map(run => {
    if (!ACTIVE.has(run.status)) return run;
    const leaseUntil = Date.parse(run.leaseUntil || '');
    const startedAt = Date.parse(run.updatedAt || run.createdAt || '');
    const expired = Number.isFinite(leaseUntil) ? leaseUntil <= time
      : Number.isFinite(startedAt) && startedAt <= time - LEASE_MS;
    if (!expired) return run;
    changed = true;
    const {leaseOwner, leaseUntil: _leaseUntil, ...rest} = run;
    return {...rest, status: 'interrupted', error: 'This browser reloaded before the run finished.', updatedAt: now()};
  });
  return {runs: next, changed};
}

export async function reclaimExpiredLocalRuns() {
  return withLocalLock('runs', () => {
    const runs = readLocalRuns();
    const reclaimed = interruptExpired(runs);
    if (reclaimed.changed) writeLocalRuns(reclaimed.runs);
  });
}

/** Atomically occupy one group and persist its renewable lease before work starts. */
export async function claimLocalRun(run, {existing = false} = {}) {
  return withLocalLock('runs', () => {
    let runs = readLocalRuns();
    const reclaimed = interruptExpired(runs);
    if (reclaimed.changed) runs = reclaimed.runs;
    const busy = runs.find(item => item.groupId === run.groupId && item.id !== run.id && LOCAL_RUN_BUSY.includes(item.status));
    if (busy) {
      if (reclaimed.changed) writeLocalRuns(runs);
      fail('A group run is already active. Wait or retry later.');
    }
    const current = run.id ? runs.find(item => item.id === run.id) : null;
    if (existing && !current) {
      if (reclaimed.changed) writeLocalRuns(runs);
      fail('That plan is no longer waiting.', 409);
    }
    if (current && !LOCAL_RUN_BUSY.includes(current.status)) {
      if (reclaimed.changed) writeLocalRuns(runs);
      fail('That run is no longer active.', 409);
    }
    // A lease held by another tab is the one to respect. A caller presenting the
    // same `leaseOwner` is the tab that already holds it, so a re-claim after a
    // retry is not "another browser tab" and must not be refused by its own lease.
    if (current?.leaseOwner && current.leaseOwner !== run.leaseOwner && Date.parse(current.leaseUntil || '') > Date.now()) {
      if (reclaimed.changed) writeLocalRuns(runs);
      fail('That run is already active in another browser tab.', 409);
    }
    const leaseOwner = crypto.randomUUID(), at = now();
    const record = {...current, ...run, id: run.id || crypto.randomUUID(), status: 'running', leaseOwner, leaseUntil: new Date(Date.now() + LEASE_MS).toISOString(), updatedAt: at};
    writeLocalRuns([record, ...runs.filter(item => item.id !== record.id).slice(0, 49)]);
    return {id: record.id, groupId: record.groupId, owner: leaseOwner};
  });
}

export async function patchLocalRun(id, patch, owner = null) {
  return mutateLocalRuns(runs => {
    const index = runs.findIndex(run => run.id === id);
    if (index < 0) return false;
    const current = runs[index];
    if (owner && current.leaseOwner !== owner) return false;
    if (current.status === 'cancelled' && patch.status !== 'cancelled') return current;
    const next = {...current, ...patch, updatedAt: patch.updatedAt || now()};
    if (patch.status && !ACTIVE.has(patch.status)) {
      delete next.leaseOwner;
      delete next.leaseUntil;
    }
    runs[index] = next;
    return next;
  });
}

export async function renewLocalRun(lease) {
  return patchLocalRun(lease.id, {leaseUntil: new Date(Date.now() + LEASE_MS).toISOString()}, lease.owner);
}

export async function finishLocalRun(lease, patch) {
  return mutateLocalRuns(runs => {
    const index = runs.findIndex(run => run.id === lease.id);
    if (index < 0 || runs[index].leaseOwner !== lease.owner) return null;
    const current = runs[index];
    if (current.status === 'cancelled') return current;
    const next = {...current, ...patch, updatedAt: now()};
    delete next.leaseOwner;
    delete next.leaseUntil;
    runs[index] = next;
    return next;
  });
}

export function localRunCancelled(id) {
  return readLocalRuns().find(run => run.id === id)?.status === 'cancelled';
}

export async function cancelLocalRunsForChat(state, key, error) {
  const groupId = groupIdOfChat(state, key), at = now();
  return mutateLocalRuns(runs => {
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (!matchesBusyChat(run, key, groupId) || !LOCAL_RUN_BUSY.includes(run.status)) continue;
      const next = {...run, status: 'cancelled', error, updatedAt: at};
      delete next.leaseOwner;
      delete next.leaseUntil;
      runs[i] = next;
    }
  });
}
