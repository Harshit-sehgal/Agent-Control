/** Whether this process can serve work: every open store answers a read, and every queue that has started is still
 * sweeping. Pure, so the health route and its tests share one rule. */
export function healthOf(stores, {lastSweep = () => 0, now = Date.now(), staleMs = 60000} = {}) {
  for (const store of stores) {
    try { store.get('SELECT 1 AS n'); } catch { return false; }
    const last = lastSweep(store);
    if (last && now - last > staleMs) return false;
  }
  return true;
}
