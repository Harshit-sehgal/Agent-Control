/** The one cross-tab lock the browser build takes.
 *
 * The Pages demo used to keep its runs in a second localStorage log and guard
 * every write with a Web Lock. Runs now live in the workspace snapshot
 * (`shared/local-api.js` answers the same routes the server does), so the only
 * thing left here is the lock itself: one exclusive holder per name, later
 * requests queued behind earlier ones. The local transport wraps every request
 * in it, so two tabs cannot read-modify-write the same snapshot at once.
 */
const fail = (message, status = 409) => { throw Object.assign(new Error(message), {status}); };

export function withLocalLock(name, fn) {
  const lockName = `agent-control:${name}`;
  if (typeof globalThis.navigator?.locks?.request !== 'function') {
    fail('This browser cannot safely coordinate updates across tabs. Use a browser with Web Locks enabled.', 503);
  }
  // Never reject inside the Web Locks callback: Node 24's LockManager keeps
  // the lock held forever when the callback's promise rejects (browsers
  // release it), which wedges every later lock request under that name — the
  // whole tab's state updates deadlock after one failure. Capture the error and
  // rethrow it once the lock has been properly released.
  let failure;
  return navigator.locks.request(lockName, {mode: 'exclusive'}, async () => {
    try { return await fn(); } catch (error) { failure = error; }
  }).then(result => {
    if (failure) throw failure;
    return result;
  });
}
