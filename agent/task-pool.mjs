// The device's worker pool: up to `concurrency` tasks at once, and no two that share a key.
// No imports, no I/O: the caller hands in `run`.

const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 8;

// AGENT_CONCURRENCY: a whole number from 1 to 8. Above 8 is 8; anything else is 3.
export function concurrencyOf(env = process.env) {
  const raw = String(env?.AGENT_CONCURRENCY ?? '');
  if (!/^\d+$/.test(raw)) return DEFAULT_CONCURRENCY;
  const n = Number(raw);
  if (n < 1) return DEFAULT_CONCURRENCY;
  return Math.min(n, MAX_CONCURRENCY);
}

// What a task must not overlap with: one model.run per CLI engine, one browser task per tab (account and bot).
// null means no cap beyond the pool's own. A later phase changes only this function.
export function taskKey(task) {
  if (task?.kind === 'model.run') return `model:${task.payload?.engine}`;
  if (task?.kind === 'browser.capture' || task?.kind === 'browser.action') return `tab:${task.payload?.account || ''}:${task.payload?.botId || 'shared'}`;
  return null;
}

// With no onError, a failed task says only this fixed line: never the error text or the task.
function logFailure() { console.error('agent: a task failed in the worker pool.'); }

export function createTaskPool({concurrency = DEFAULT_CONCURRENCY, keyOf = taskKey, run, onError = logFailure} = {}) {
  const limit = Number.isInteger(concurrency) && concurrency >= 1 ? concurrency : DEFAULT_CONCURRENCY;
  const queue = [];            // waiting {task, key}, in arrival order; the key is read once, in add
  const ids = new Set();       // ids that are queued or running
  const activeKeys = new Set();
  let running = 0;
  let draining = false;
  let settledWaiters = [];
  let drainWaiters = [];

  function pump() {
    while (!draining && running < limit) {
      const at = queue.findIndex(({key}) => key == null || !activeKeys.has(key));
      if (at < 0) return;
      start(queue.splice(at, 1)[0]);
    }
  }

  function start({task, key}) {
    if (key != null) activeKeys.add(key);
    running += 1;
    // An async wrapper turns a synchronous throw into a rejection, and runs `run` right now.
    (async () => run(task))().catch(error => {
      try { onError(task, error); } catch { /* a failing reporter must not stall the pool */ }
    }).then(() => {
      try {
        if (key != null) activeKeys.delete(key);
        running -= 1;
        ids.delete(task.id);
        pump();
      } finally {
        const woken = settledWaiters; settledWaiters = [];
        for (const resolve of woken) resolve();
        if (running === 0) { const done = drainWaiters; drainWaiters = []; for (const resolve of done) resolve(); }
      }
    });
  }

  return {
    add(task) {
      if (ids.has(task.id)) return false;
      const key = keyOf(task); // may throw: nothing is stored yet
      ids.add(task.id);
      queue.push({task, key});
      pump();
      return true;
    },
    running: () => running,
    queued: () => queue.length,
    // Resolves when the next running task has ended and its slot has been refilled; at once when none runs.
    settled: () => (running === 0 ? Promise.resolve() : new Promise(resolve => settledWaiters.push(resolve))),
    // Starts nothing more; resolves when the running tasks have ended. Queued tasks stay queued.
    drain() {
      draining = true;
      return running === 0 ? Promise.resolve() : new Promise(resolve => drainWaiters.push(resolve));
    },
  };
}
