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
import crypto from 'node:crypto';
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

/** One person at a time. Two takeovers would fight for the same browser
 * process, and "which page is this" would become a guess. A takeover holds only
 * the bot whose page it is (its lane); other bots' pages keep running. */
export const MAX_LIVE = 1;

/** One runtime per process. `start` and `env` are injectable so a test can run
 * the state machine without a browser. */
export function createBrowserRuntime({env = process.env, start = startBrowserSession, find = findBrowser} = {}) {
  const mode = runtimeMode(env);
  // How long one page may take to load. A page that never loads has to end as a failure; this is not a
  // limit on how long a bot or a person uses the browser.
  const timeoutMs = on(env.BROWSER_TIMEOUT_MS, 60000);
  // An idle bot browser is closed after this long and started again on the next page (sign-ins live in the profile).
  const idleMs = on(env.BROWSER_IDLE_MS, 30 * 60000);
  // A takeover has no clock by default: it stays open until the person hands back. An install that wants one
  // sets BROWSER_LIVE_MS (closed after this long without a look) or BROWSER_LIVE_MAX_MS (closed outright).
  const liveIdleMs = on(env.BROWSER_LIVE_MS, 0);
  const liveMaxMs = on(env.BROWSER_LIVE_MAX_MS, Infinity);
  let session = null, starting = null, idle = null;
  // One queue per lane (a workspace and a bot, see `browserLane`): one bot's pages are serial, two bots' pages overlap
  // in the one process, each in its own context. `active` counts the pages open right now, across every lane.
  const tails = new Map();
  let active = 0;
  let closed = false;

  /** Queue `work` behind everything already queued on `lane`. The entry is dropped once its lane is quiet. */
  function enqueue(lane, work) {
    const next = (tails.get(lane) || Promise.resolve()).then(work);
    const settled = next.then(() => {}, () => {});
    tails.set(lane, settled);
    void settled.then(() => { if (tails.get(lane) === settled) tails.delete(lane); });
    return next;
  }

  const allowed = () => browserAllowlist(env);
  /** Is there a browser here that a bot could use at all? */
  const available = () => mode !== 'agent' && allowed().length > 0 && Boolean(find(env));

  /** Drop the browser. With `only`, drop it only if that is still the current one: a page that outlives a
   * dead process must not close the browser that replaced it. */
  function forget(only) {
    if (only && session !== only) return Promise.resolve();
    clearTimeout(idle);
    idle = null;
    const live = session;
    session = null;
    starting = null;
    return live ? live.close().catch(() => {}) : Promise.resolve();
  }

  /** The idle clock runs only while nobody has the browser: no bot's page and no person's takeover. */
  function armIdle() {
    clearTimeout(idle);
    idle = null;
    if (!session || active > 0 || lives.size) return;
    idle = setTimeout(() => { idle = null; if (!active && !lives.size) void forget(); }, idleMs);
    idle.unref?.();
  }

  async function ensure() {
    // A browser that exited on its own is never handed out again: it would fail the page that got it.
    if (session?.dead === true) await forget(session);
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

  /** Run one request. One bot's requests are serial (its lane); another bot's page may be open at the same time. */
  function run(request) {
    const lane = request.lane || '';
    return enqueue(lane, async () => {
      if (closed) throw Object.assign(new Error('The browser runtime is shutting down.'), {status: 503});
      for (const entry of lives.values()) {
        if (entry.lane === lane) throw Object.assign(new Error('A person is using the browser right now. Finish or close that takeover, then approve again.'), {status: 409});
      }
      if (!available()) {
        throw Object.assign(new Error(mode === 'server'
          ? 'This install runs browser requests on the server, but no browser or allowlist is configured there. Set AGENT_BROWSER_ALLOWLIST (a host list, or * for any public site) and install Chrome, or point AGENT_BROWSER_PATH at one; or switch BROWSER_RUNTIME=agent.'
          : 'No browser is available on this server.'), {status: 503});
      }
      // A page now owns the browser, so the idle clock must not fire under it (not even while it launches);
      // it is re-armed in the `finally` below, once no page and no takeover is left.
      active += 1;
      clearTimeout(idle);
      idle = null;
      let live = null;
      try {
        live = await ensure();
        return await live.capture(request.url, {allow: allowed(), steps: request.steps || [], approved: request.approved || [], timeoutMs});
      } catch (error) {
        // A capture can fail because the page did, or because the process died. Only the second is worth paying
        // a relaunch for, and it takes down every other page too. A page that failed on its own leaves the
        // browser alone while another bot's page (or a person) is on it; with nothing else open, drop it so the
        // next request starts from a known state.
        // `active` still counts this page, so "no other page" is a count of one.
        if (live && (live.dead === true || (active === 1 && !lives.size))) await forget(live);
        throw error;
      } finally {
        // The idle clock starts when the work ends, never when the browser is handed out.
        active -= 1;
        armIdle();
      }
    });
  }

  /** Takeovers, one at a time. A person signing in is holding one browser
   * context open; a second one would fight it for the same process and turn
   * "which page is this" into a guess. */
  const lives = new Map();
  let opening = 0;
  const noBrowser = () => Object.assign(new Error(mode === 'server'
    ? 'This install runs browser requests on the server, but no browser or allowlist is configured there. Set AGENT_BROWSER_ALLOWLIST (a host list, or * for any public site) and install Chrome, or point AGENT_BROWSER_PATH at one; or switch BROWSER_RUNTIME=agent.'
    : 'No browser is available on this server.'), {status: 503});

  /** A takeover is reached only from the workspace that opened it. A caller
   * that passes no workspace is the runtime itself (its own idle clock). Another
   * workspace is told "not found", the same as an id that never existed. */
  function liveOf(id, workspaceId) {
    const entry = lives.get(String(id));
    if (!entry || (workspaceId !== undefined && entry.workspaceId !== (workspaceId ?? null))) throw Object.assign(new Error('That takeover is no longer open. Open the page again.'), {status: 404});
    return entry;
  }

  /** A takeover counts as activity: its idle clock restarts on every look. */
  function touch(entry) {
    clearTimeout(entry.timer);
    if (!liveIdleMs) return;
    entry.timer = setTimeout(() => { void endLive(entry.id).catch(() => {}); }, liveIdleMs);
    entry.timer.unref?.();
  }

  /** Open the page for a person to act on. The page is not disposed until the
   * takeover ends, which is what lets a sign-in survive between calls. */
  function beginLive({url, requestId = null, openedBy = null, workspaceId = null, lane = ''}) {
    if (closed) return Promise.reject(Object.assign(new Error('The browser runtime is shutting down.'), {status: 503}));
    if (!available()) return Promise.reject(noBrowser());
    // The slot is taken here, before any queue, because each lane has its own queue: two takeovers on
    // different lanes would otherwise both pass this check and both open a context. `opening` counts the
    // takeovers that hold a slot but are not yet in `lives`.
    if (lives.size + opening >= MAX_LIVE) return Promise.reject(Object.assign(new Error('A takeover is already open. Finish or close it first — one page at a time.'), {status: 409}));
    opening += 1;
    return enqueue(lane, async () => {
      active += 1;
      clearTimeout(idle);
      idle = null;
      try {
        if (closed) throw Object.assign(new Error('The browser runtime is shutting down.'), {status: 503});
        const live = await ensure();
        const handle = await live.open(url, {allow: allowed(), timeoutMs});
        const entry = {id: `takeover-${crypto.randomUUID()}`, handle, requestId, openedBy, workspaceId, lane, url: null, createdAt: Date.now(), timer: null};
        lives.set(entry.id, entry);
        touch(entry);
        const view = await handle.view();
        entry.url = view.url;
        return {id: entry.id, url: view.url, title: view.title, text: view.text, elements: view.elements, elementCount: view.elementCount, blockedRequests: view.blockedRequests, image: view.image};
      } finally {
        // The entry is in `lives` by now (or the open failed), so the slot passes from `opening` to `lives`.
        opening -= 1;
        active -= 1;
        armIdle();
      }
    });
  }

  /** A look or an action queues on the lane of the page it belongs to, so it never waits for another bot's page.
   * An id that is not open is "not found" at once. */
  function onLane(id, workspaceId, work) {
    let lane;
    try { lane = liveOf(id, workspaceId).lane; } catch (error) { return Promise.reject(error); }
    return enqueue(lane, work);
  }

  function liveView(id, {workspaceId} = {}) {
    return onLane(id, workspaceId, async () => {
      const entry = liveOf(id, workspaceId);
      touch(entry);
      return entry.handle.view();
    });
  }

  /** One action by the person, then the page as it is now. */
  function liveAct(id, step, {workspaceId} = {}) {
    return onLane(id, workspaceId, async () => {
      const entry = liveOf(id, workspaceId);
      touch(entry);
      if (Date.now() - entry.createdAt > liveMaxMs) {
        await endLive(entry.id).catch(() => {});
        throw Object.assign(new Error('This takeover has been open too long. Open the page again.'), {status: 409});
      }
      const result = await entry.handle.act(step);
      const page = await entry.handle.view();
      // The action says whether it landed; the page says what the person is
      // looking at now, and the picture is of the page they landed on.
      return {...result, ...page, ok: Boolean(result.ok), reason: String(result.reason || '')};
    });
  }

  /** Close a takeover, returning the page the person left it on and the request
   * it was opened for, so the caller can hand that page back to the bot. */
  async function endLive(id, {workspaceId} = {}) {
    const entry = liveOf(id, workspaceId);
    lives.delete(entry.id);
    clearTimeout(entry.timer);
    const page = await entry.handle.page().catch(() => null);
    await entry.handle.close().catch(() => {});
    armIdle();
    return {requestId: entry.requestId, openedBy: entry.openedBy, page};
  }

  /** Stop taking work, let anything in flight finish, then close the browser.
   * Waiting matters on a drain: a killed process cannot answer the request it
   * was serving, and that request would hang instead of failing. */
  return {
    mode, allowed, available, run,
    beginLive, liveView, liveAct, endLive,
    liveIds: () => [...lives.keys()],
    /** Whether a takeover is on a clock (an idle timer or a hard cap); none by default. */
    liveTimed: id => Boolean(lives.get(String(id))?.timer) || Number.isFinite(liveMaxMs),
    assertLive: (id, workspaceId) => { liveOf(id, workspaceId); },
    liveList: ({workspaceId} = {}) => [...lives.values()].filter(entry => workspaceId === undefined || entry.workspaceId === (workspaceId ?? null)).map(entry => ({id: entry.id, requestId: entry.requestId, openedBy: entry.openedBy, url: entry.url, createdAt: entry.createdAt})),
    close: async () => {
      closed = true;
      // A drain disposes each takeover's context before the process goes away,
      // so a kept sign-in is not left to the process teardown to clean up.
      const open = [...lives.values()];
      lives.clear();
      for (const entry of open) clearTimeout(entry.timer);
      // Every lane finishes what it has; nothing new is accepted because `closed` is set.
      await Promise.all([...tails.values()]);
      await Promise.all(open.map(entry => entry.handle.close().catch(() => {})));
      await forget();
    },
    get open() { return Boolean(session); },
  };
}

/** The process-wide runtime the queue handler uses. */
export const browserRuntime = createBrowserRuntime();
