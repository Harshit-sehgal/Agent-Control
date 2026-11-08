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
      for (const task of claimed) {
        // Keep the lease alive while the handler runs: a handler may legitimately
        // take minutes (model calls), and re-claiming it in sweep would double-run.
        const beat = setInterval(() => {
          void store.update(s => {
            const t = (s.tasks || []).find(x => x.id === task.id);
            if (t && t.status === 'running' && t.leaseOwner === id) t.leaseUntil = new Date(Date.now() + leaseMs).toISOString();
          }).catch(() => { /* best effort */ });
        }, Math.max(1000, Math.floor(leaseMs / 3)));
        beat.unref?.();
        const handler = handlers[task.kind];
        try {
          if (!handler) throw new Error(`No handler is registered for task kind "${task.kind}".`);
          const result = await handler(task);
          await store.update(s => tasks.completeTask(s, task.id, result ?? null));
        } catch (e) {
          // A busy-group 409 outlasts the attempt budget; errors marked
          // permanent (for example, a missing bot) fail immediately.
          const conflict = e?.status === 409 && /already active/i.test(String(e?.message || ''));
          const permanent = e?.permanent === true;
          let transition = null;
          try {
            transition = await store.update(s => tasks.failTask(s, task.id, e?.message, undefined, {conflict, permanent}));
          } catch (transitionError) {
            console.error('Queue could not record task failure:', transitionError.message);
          }
          // Notify only after the retry policy reaches a terminal failure. A
          // transient provider error must not announce failure while requeued.
          if (transition?.status === 'failed') {
            try { if (onFail) await onFail(task, e); } catch (notifyError) { console.error('Failure notify error:', notifyError.message); }
          }
        } finally {
          clearInterval(beat);
        }
      }
    } catch (e) {
      console.error('Queue sweep error:', e.message);
    } finally {
      busy = false;
      for (const resolve of idleWaiters.splice(0)) resolve();
    }
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
