/** A headless browser that belongs to this server, not to a browser on the
 * user's screen.
 *
 * A paired local agent can open a page on the user's own device. That is the
 * right default for a laptop, and the wrong one for an always-on host: nothing
 * runs the page while the laptop is asleep, and the person has to install an
 * agent before a bot can read a document. This module runs the same engine in
 * the server process instead — one Chromium started on demand, one page per
 * request in a fresh browser context, the same allowlist and egress proxy as
 * the device.
 *
 * `BROWSER_RUNTIME` picks who runs it:
 *
 *   auto    the server when a browser binary and an allowlist are present,
 *           otherwise the paired agent (the default)
 *   server  only the server; a request with no browser here is refused
 *   agent   only a paired agent, exactly the behaviour before this module
 *
 * The server browser is the model a coding agent (Codex, Claude Code) uses: an
 * app-owned Chrome spoken to over the DevTools protocol, not a library that
 * drives the person's own window. It is deliberately not a long-lived signed-in
 * profile — a capture gets a fresh context, so being warm never means being
 * logged in as anyone.
 *
 * One process is reused and closed after `BROWSER_IDLE_MS` without work, so the
 * launch cost (about a second) is paid once per burst rather than per page.
 */
import {findBrowser, startBrowserSession} from '../agent/browser.mjs';
import {parseAllowlist} from '../shared/bot-browser.js';

export const RUNTIME_MODES = ['auto', 'server', 'agent'];

/** `BROWSER_RUNTIME`, read the way an operator writes it: an unknown value is
 * `auto` rather than a guess at what was meant. */
export function runtimeMode(env = process.env) {
  const mode = String(env.BROWSER_RUNTIME || 'auto').trim().toLowerCase();
  return RUNTIME_MODES.includes(mode) ? mode : 'auto';
}

/** The hosts a bot may open, from the same variable and the same spelling the
 * device reads (`shared/bot-browser.js`). */
export function browserAllowlist(env = process.env) {
  return parseAllowlist(env.AGENT_BROWSER_ALLOWLIST);
}

const on = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** One runtime per process. `start` and `env` are injectable so a test can run
 * the state machine without a browser. */
export function createBrowserRuntime({env = process.env, start = startBrowserSession, find = findBrowser} = {}) {
  const mode = runtimeMode(env);
  const timeoutMs = on(env.BROWSER_TIMEOUT_MS, 25000);
  const idleMs = on(env.BROWSER_IDLE_MS, 120000);
  let session = null, starting = null, idle = null;
  let tail = Promise.resolve();
  let closed = false;

  const allowed = () => browserAllowlist(env);
  /** Is there a browser here that a bot could use at all? */
  const available = () => mode !== 'agent' && allowed().length > 0 && Boolean(find(env));

  function forget() {
    clearTimeout(idle);
    idle = null;
    const live = session;
    session = null;
    starting = null;
    return live ? live.close().catch(() => {}) : Promise.resolve();
  }

  function armIdle() {
    clearTimeout(idle);
    idle = setTimeout(() => { void forget(); }, idleMs);
    idle.unref?.();
  }

  async function ensure() {
    if (session) return session;
    if (!starting) {
      starting = (async () => {
        const live = await start({binary: env.AGENT_BROWSER_PATH || undefined});
        session = live;
        return live;
      })().finally(() => { starting = null; });
    }
    return starting;
  }

  /** Run one request. Requests are serial: one Chromium, one page at a time, so
   * two bots cannot interleave their steps on the same browser. */
  function run(request) {
    const next = tail.then(async () => {
      if (closed) throw Object.assign(new Error('The browser runtime is shutting down.'), {status: 503});
      if (!available()) {
        throw Object.assign(new Error(mode === 'server'
          ? 'This install runs browser requests on the server, but no browser or allowlist is configured there. Set AGENT_BROWSER_ALLOWLIST (a host list, or * for any public site) and install Chrome, or point AGENT_BROWSER_PATH at one; or switch BROWSER_RUNTIME=agent.'
          : 'No browser is available on this server.'), {status: 503});
      }
      const live = await ensure();
      // A request now owns the browser, so the idle clock from the last one must
      // not fire under it; it is re-armed in the `finally` below.
      clearTimeout(idle);
      idle = null;
      try {
        return await live.capture(request.url, {allow: allowed(), steps: request.steps || [], timeoutMs});
      } catch (error) {
        // A capture can fail because the page did, or because the process died.
        // Only the second is worth paying a relaunch for, and a dead process
        // cannot answer the close() below: drop the session either way, so the
        // next request starts from a known state.
        await forget();
        throw error;
      } finally {
        // The idle clock starts when the work ends, never when the browser is
        // handed out: a page that takes longer than BROWSER_IDLE_MS would else
        // have the browser closed underneath it mid-capture.
        if (session) armIdle();
      }
    });
    tail = next.then(() => {}, () => {});
    return next;
  }

  /** Stop taking work, let anything in flight finish, then close the browser.
   * Waiting matters on a drain: a killed process cannot answer the request it
   * was serving, and that request would hang instead of failing. */
  return {mode, allowed, available, run, close: async () => { closed = true; await tail; await forget(); }, get open() { return Boolean(session); }};
}

/** The process-wide runtime the queue handler uses. */
export const browserRuntime = createBrowserRuntime();
