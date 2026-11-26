/** A workspace's background pass on a timer, written once: ask expiry, browser expiry, agent retention and the
 * health watch all use it.
 *
 * - A pass never overlaps itself: a tick that finds one running is skipped.
 * - A failure is logged as "<name> error: <message>" and the timer keeps going; a closed store (status 503, the
 *   workspace is shutting down) is not an error worth a line.
 * - With the workspace's `trackWork`, the pass counts as work in flight, so the store waits for it before closing.
 * - The returned `stop()` clears the timer and waits for the pass in flight, instead of guessing how long it takes.
 */
export function startSweep(name, pass, {intervalMs, ws = null, immediate = true, log = message => console.error(message)} = {}) {
  let current = null, stopped = false;
  const run = () => {
    if (current || stopped) return current;
    current = (async () => {
      try { await (ws?.trackWork ? ws.trackWork(pass) : pass()); }
      catch (error) { if (error?.status !== 503) log(`${name} error: ${error?.message ?? error}`); }
      finally { current = null; }
    })();
    return current;
  };
  if (immediate) void run();
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    if (current) await current;
  };
}
