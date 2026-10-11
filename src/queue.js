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

export function createQueue(store, handlers = {}, {intervalMs = 2000, workerId, leaseMs = 60000, batch = 5} = {}) {
  const id = workerId || `worker-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let busy = false;
  let timer = null;

  async function sweep(now = Date.now()) {
    if (busy) return; // one sweep at a time; the store serializes writes anyway
    busy = true;
    try {
      const claimed = await store.update(s => tasks.claimTasks(s, {workerId: id, now, leaseMs, limit: batch}));
      for (const task of claimed) {
        const handler = handlers[task.kind];
        try {
          if (!handler) throw new Error(`No handler is registered for task kind "${task.kind}".`);
          const result = await handler(task);
          await store.update(s => tasks.completeTask(s, task.id, result ?? null));
        } catch (e) {
          await store.update(s => tasks.failTask(s, task.id, e.message));
        }
      }
    } catch (e) {
      console.error('Queue sweep error:', e.message);
    } finally {
      busy = false;
    }
  }

  return {
    workerId: id,
    sweep,
    start() {
      timer = setInterval(() => { void sweep(); }, intervalMs);
      timer.unref();
      return () => clearInterval(timer);
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
