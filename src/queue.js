/** Durable task queue worker.
 *
 * Tasks live in SQLite (`shared/tasks.js` owns the document transitions), and
 * this loop is what executes them:
 *
 * - a task is claimed by setting a lease with the worker's id, so a crashed
 *   process's task is visibly stale rather than stuck (see recoverStalledTasks);
 * - a handler failure re-queues the task with exponential backoff while
 *   attempts remain, then marks it `failed` instead of pretending it passed;
 * - handlers may not enqueue directly: they run inside one store transaction
 *   per transition, so a crash mid-handler leaves no half-written state.
 *
 * `src/queue.js` is generic. `src/server.js` injects the handlers for each task
 * kind so this module never imports the server (and can be unit-tested without
 * one).
 */
import * as tasks from '../shared/tasks.js';
import {activity} from '../shared/core.js';

export function createQueue(store, handlers = {}, {intervalMs = 2000, workerId, leaseMs = 60000, batch = 5, onFail = null} = {}) {
  const id = workerId || `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let busy = false;
  let timer = null;
  let started = false;
  const idleWaiters = [];
  // Handler results whose completion write failed, keyed by task id. The work
  // is finished, so running the handler again would repeat its side effects (a
  // second webhook POST, a second group run); the next sweep records the result
  // instead. It lives in memory because this module does not own a schema
  // column for it: if the process dies before the write lands, the row is
  // re-armed and the work runs once more, which is the failure mode we cannot
  // avoid here and can live with.
  const pendingResults = new Map();

  async function sweep(now = Date.now()) {
    if (busy) return; // one sweep at a time; the store serializes writes anyway
    busy = true;
    try {
      // Skip the write when nothing is due: store.update rewrites the whole
      // state (DELETE + re-INSERT for SQLite) and this runs every couple of
      // seconds, so an idle install should not write to disk at all.
      // A running row whose lease has expired is due as well. Boot recovery
      // ignores a lease that is still in the future, and after that lease
      // ends no sweep looked at `running` rows, so a restart inside the
      // window left the task stuck forever.
      const leaseHeld = task => {
        const until = Date.parse(task.leaseUntil || 0);
        return Number.isFinite(until) && until > now;
      };
      const list = store.read().tasks || [];
      const stalled = list.some(t => t.status === 'running' && !leaseHeld(t));
      const due = list.some(t => t.status === 'queued' && Date.parse(t.runAt) <= now && !leaseHeld(t));
      if (!stalled && !due) return;
      const claimed = await store.update(s => {
        tasks.recoverStalledTasks(s, now);
        return tasks.claimTasks(s, {workerId: id, now, leaseTTL: leaseMs, limit: batch});
      });
      // One heartbeat renews the whole batch, not just the task being run. The
      // handlers are serial and a single model call can outlast the lease, so a
      // task still waiting its turn would otherwise look stalled to another
      // worker's sweep and be claimed and run twice.
      const live = new Set(claimed.map(task => task.id));
      let warnedLeaseAt = 0;
      const beat = setInterval(() => {
        if (!live.size) return;
        void store.update(s => {
          for (const t of s.tasks || []) {
            if (!live.has(t.id) || t.status !== 'running' || t.leaseOwner !== id) continue;
            t.leaseUntil = new Date(Date.now() + leaseMs).toISOString();
          }
        }).catch(error => {
          // A failed renewal means another worker may claim these tasks and run
          // them twice, so it cannot be silent. One line per minute keeps a
          // persistent write failure from flooding the log every beat.
          if (Date.now() - warnedLeaseAt < 60000) return;
          warnedLeaseAt = Date.now();
          console.error(`Queue lease renewal failed for ${live.size} task(s) (${[...live].join(', ')}), lease ${leaseMs}ms: ${error?.message || error}`);
        });
      }, Math.max(1000, Math.floor(leaseMs / 3)));
      beat.unref?.();
      try {
        for (const task of claimed) {
          // The release has to reach `runTask`: it drops the id before the
          // failure transition, so a heartbeat that is already queued cannot
          // renew a lease that transition just expired.
          try { await runTask(task, () => live.delete(task.id)); }
          finally { live.delete(task.id); }
        }
      } finally {
        clearInterval(beat);
      }
    } catch (e) {
      console.error('Queue sweep error:', e.message);
    } finally {
      busy = false;
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
  }

  /** Expire one task's lease so the next sweep can claim and finish it. A write
   * that failed may keep failing, so the lease lapsing on its own is the
   * fallback. */
  async function expireLease(taskId) {
    await store.update(s => {
      const t = (s.tasks || []).find(x => x.id === taskId);
      if (t && t.status === 'running' && t.leaseOwner === id) t.leaseUntil = new Date(0).toISOString();
    }).catch(() => { /* the lease lapses on its own */ });
  }

  /** Write the outcome a handler already produced. A failure here is a
   * bookkeeping problem, never a handler failure: the result stays in
   * `pendingResults` and a later sweep writes it, with no second execution. */
  async function recordCompletion(task, release) {
    try {
      const result = pendingResults.get(task.id) ?? null;
      await store.update(s => tasks.completeTask(s, task.id, result));
      pendingResults.delete(task.id);
    } catch (e) {
      // A definitive refusal — the row is gone, or another worker already moved
      // it on — cannot be fixed by asking again, and keeping the result would
      // retry it forever. Nothing ran twice either way.
      if (e?.status === 404 || e?.status === 409) {
        pendingResults.delete(task.id);
        console.error(`Queue dropped the result of ${task.id} (${e.message}).`);
        return;
      }
      console.error(`Queue could not record completion of ${task.id} (${e.message}); the result is kept and the next sweep records it, the handler will not run again.`);
      release();
      await expireLease(task.id);
    }
  }

  /** Run one claimed task to a terminal transition. A handler failure re-queues
   * the task with backoff while attempts remain, or marks it failed. */
  async function runTask(task, release) {
    // This task's handler already returned on an earlier attempt: write that
    // result, never run the work again.
    if (pendingResults.has(task.id)) return recordCompletion(task, release);
    let result;
    try {
      const handler = handlers[task.kind];
      if (!handler) throw new Error(`No handler is registered for task kind "${task.kind}".`);
      result = await handler(task);
    } catch (e) {
      // Stop renewing before the failure path: a heartbeat already queued on
      // the store's serial chain would otherwise commit after the lease-expiry
      // fallback below and give a stuck task another full `running` window.
      release();
      // A busy-group 409 outlasts the attempt budget; errors marked
      // permanent (for example, a missing bot) fail immediately.
      const conflict = e?.status === 409 && /already active/i.test(String(e?.message || ''));
      const permanent = e?.permanent === true;
      let transition = null;
      try {
        transition = await store.update(s => tasks.failTask(s, task.id, e?.message, undefined, {conflict, permanent}));
      } catch (transitionError) {
        console.error('Queue could not record task failure:', transitionError.message);
        // The failure record itself failed, so the task is still `running` with
        // a lease and nobody is heartbeating it. Expire the lease now so the
        // next sweep re-arms it instead of waiting for the window to lapse.
        await expireLease(task.id);
      }
      // Notify only after the retry policy reaches a terminal failure. A
      // transient provider error must not announce failure while requeued.
      if (transition?.status === 'failed') {
        try { if (onFail) await onFail(task, e); } catch (notifyError) { console.error('Failure notify error:', notifyError.message); }
      }
      return;
    }
    // The handler returned: the outcome is known and the work is done, so a
    // failing completion write must never be read as a handler failure. Keep
    // the result before the write so a later sweep can record it.
    pendingResults.set(task.id, result ?? null);
    await recordCompletion(task, release);
  }

  return {
    workerId: id,
    sweep,
    start() {
      started = true;
      timer = setInterval(() => { if (started) void sweep(); }, intervalMs);
      timer.unref();
      return () => {
        started = false;
        clearInterval(timer);
        return busy ? new Promise(resolve => idleWaiters.push(resolve)) : Promise.resolve();
      };
    },
  };
}

/** Re-arm tasks orphaned by a previous process (lease expired or never set).
 * Called once at boot before the first sweep so a restart never silently drops
 * work that was in flight. */
export function recoverQueue(store) {
  return store.update(s => {
    const {recovered} = tasks.recoverStalledTasks(s);
    return recovered;
  });
}

/** Default handlers the server composes over. `reminder` needs no imports of
 * server modules; the server adds candidate/group/agent handlers itself. */
export function defaultHandlers(store, notify = null) {
  return {
    reminder: task => store.update(s => {
      activity(s, 'reminder', task.payload.label, {taskId: task.id});
      if (notify) notify({kind: 'reminder', title: task.payload.label, body: 'A scheduled reminder fired.', taskId: task.id});
    }),
  };
}
