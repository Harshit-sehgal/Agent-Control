import test from 'node:test';
import assert from 'node:assert/strict';
import {installWebLocks} from './web-locks.js';

// The run store is localStorage, and every write takes a Web Lock. A browser
// tab has both; give the process what it needs before importing the module.
// Node 22 has no `navigator.locks`, so without this the suite fails there.
installWebLocks();
const {claimLocalRun, patchLocalRun, renewLocalRun, finishLocalRun, readLocalRuns, LOCAL_RUNS_KEY} =
  await import('../shared/local-runs.js');

const store = new Map();
globalThis.localStorage = {
  getItem: key => (store.has(key) ? store.get(key) : null),
  setItem: (key, value) => { store.set(key, String(value)); },
  removeItem: key => { store.delete(key); },
};

const owner = id => readLocalRuns().find(run => run.id === id)?.leaseOwner;

test('a live lease belongs to one tab, and re-claiming it is not "another tab"', async () => {
  store.clear();
  const lease = await claimLocalRun({id: 'r9', groupId: 'g9', status: 'running', createdAt: new Date().toISOString()});
  assert.equal(owner('r9'), lease.owner);
  // A tab that does not hold the lease is refused while it is live, whichever
  // way it identifies itself.
  await assert.rejects(claimLocalRun({id: 'r9', groupId: 'g9'}, {existing: true}),
    error => error.status === 409 && /another browser tab/.test(error.message));
  await assert.rejects(claimLocalRun({id: 'r9', groupId: 'g9', leaseOwner: 'other-tab'}, {existing: true}),
    error => error.status === 409);
  // The tab holding the lease can pick its own run back up: its own lease must
  // not strand it behind a 409 it cannot clear.
  const again = await claimLocalRun({id: 'r9', groupId: 'g9', leaseOwner: lease.owner}, {existing: true});
  assert.equal(again.id, 'r9');
  assert.equal(readLocalRuns().find(run => run.id === 'r9').status, 'running');
  assert.notEqual(again.owner, lease.owner, 'Re-claiming mints a fresh lease.');
});

test('renewal keeps the lease owner, and a foreign owner cannot renew or patch', async () => {
  store.clear();
  const lease = await claimLocalRun({id: 'r1', groupId: 'g1', status: 'running', createdAt: new Date().toISOString()});
  const before = readLocalRuns()[0].leaseUntil;
  const renewed = await renewLocalRun(lease);
  assert.equal(renewed.leaseOwner, lease.owner, 'A renewal must not hand the run to another owner.');
  assert.ok(Date.parse(renewed.leaseUntil) >= Date.parse(before));
  // A wrong owner is silently refused, not applied.
  assert.equal(await renewLocalRun({id: 'r1', owner: 'other'}), false);
  assert.equal(owner('r1'), lease.owner);
  // The holder may patch its own run, including a step counter.
  const patched = await patchLocalRun('r1', {currentStep: 2}, lease.owner);
  assert.equal(patched.currentStep, 2);
  assert.equal(readLocalRuns()[0].currentStep, 2);
  assert.equal(await patchLocalRun('r1', {currentStep: 3}, 'other'), false);
  assert.equal(readLocalRuns()[0].currentStep, 2, 'A foreign patch changes nothing.');
  // A bare patch still works: the Cancel button is not the lease holder, and a
  // user must always be able to stop their own run.
  const cancelled = await patchLocalRun('r1', {status: 'cancelled'});
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.leaseOwner, undefined, 'Settling a run releases its lease.');
  // A cancelled run never comes back to life: the old lease is gone and the
  // cancel status wins over any later patch.
  assert.equal(await patchLocalRun('r1', {status: 'running'}, lease.owner), false, 'The released lease matches no owner.');
  assert.equal((await patchLocalRun('r1', {status: 'running'})).status, 'cancelled');
});

test('finishing a run requires its own lease, and a settle releases the group', async () => {
  store.clear();
  const lease = await claimLocalRun({id: 'r2', groupId: 'g2', status: 'running', createdAt: new Date().toISOString()});
  assert.equal(await finishLocalRun({id: 'r2', owner: 'other'}, {status: 'completed'}), null);
  assert.equal(readLocalRuns()[0].status, 'running', 'A stranger cannot finish the run.');
  await assert.rejects(claimLocalRun({id: 'r3', groupId: 'g2', status: 'running', createdAt: new Date().toISOString()}),
    error => error.status === 409 && /already active/.test(error.message));
  const done = await finishLocalRun(lease, {status: 'completed'});
  assert.equal(done.status, 'completed');
  assert.equal(done.leaseOwner, undefined);
  // The group is free again, so the next run can claim it.
  const next = await claimLocalRun({id: 'r3', groupId: 'g2', status: 'running', createdAt: new Date().toISOString()});
  assert.equal(next.id, 'r3');
  assert.equal(JSON.parse(store.get(LOCAL_RUNS_KEY)).length, 2);
});
