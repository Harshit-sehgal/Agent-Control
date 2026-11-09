// The shared UI modules coordinate tabs through `navigator.locks`. Node 24
// exposes it; Node 22 (the supported floor, and what CI runs) does not. Without
// this, a test either depends on the Node version or asserts a lock that never
// runs. Install before importing anything from shared/.
//
// The stand-in keeps the contract `withLocalLock` relies on: one exclusive
// holder per name, later requests queue behind earlier ones, and the callback's
// result is what the caller gets back.
/** One exclusive holder per name, later requests queued behind earlier ones. */
export function webLocks() {
  const tails = new Map();
  return {
    request: (name, options, callback) => {
      const run = (tails.get(name) || Promise.resolve()).then(() => callback({name, mode: 'exclusive'}));
      tails.set(name, run.then(() => {}, () => {}));
      return run;
    },
  };
}

export function installWebLocks() {
  if (typeof globalThis.navigator?.locks?.request === 'function') return false;
  const locks = webLocks();
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    writable: true,
    value: {
      ...globalThis.navigator,
      locks,
    },
  });
  return true;
}
