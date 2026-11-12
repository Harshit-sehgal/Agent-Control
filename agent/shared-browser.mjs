/** The one browser every bot on this device shares.
 *
 * One Chrome process runs on one persistent profile, kept in the agent's config
 * directory (`browser-profile`, mode 0700). Sign in to a site there once and the
 * sign-in is there for every bot, because every bot's tab lives in the profile's
 * default context. The profile is never uploaded, logged or backed up by this
 * code: nothing here reads it, Chrome alone does.
 *
 * - One bot drives at a time. A task that finds the browser busy waits its turn,
 *   in the order it asked, and never touches another bot's tab.
 * - The owner can take the browser (`takeover`) and hand it back (`handback`).
 *   While they hold it no bot starts a task. A task already running finishes the
 *   step it is in, runs no further step (the page is no longer the one its steps
 *   were planned for), waits for the hand back and then answers with the page as
 *   the owner left it. The owner's input waits for that step too, so an action
 *   is never applied twice or cut in half.
 * - Each bot has its own tab (`botId` -> tab). A tab the browser no longer has
 *   is dropped and replaced; after a restart there are no tab ids at all, so no
 *   stale one can be used.
 * - The rules that bound a page read still bound every step: the allowlist, the
 *   egress proxy that refuses private addresses, and the X click/type refusal.
 *   Those live in `agent/browser.mjs`, which this file drives.
 */
import fs from 'node:fs';
import path from 'node:path';
import {startBrowserSession, ACTION_OPS, MAX_ACTIONS} from './browser.mjs';
import {hostAllowed, hostOf} from '../shared/bot-browser.js';
import {cleanInput, KEYS, VIEWPORT} from './live-input.mjs';

/** Where the profile lives: `AGENT_BROWSER_PROFILE`, else next to the agent's config. */
export function browserProfileDir(env = process.env, configPath) {
  return env.AGENT_BROWSER_PROFILE ? path.resolve(env.AGENT_BROWSER_PROFILE) : path.join(path.dirname(configPath), 'browser-profile');
}

/** The profile holds cookies, so it is private to this user, and an older,
 * looser directory is tightened rather than trusted. */
export function ensureProfileDir(dir) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.chmodSync(dir, 0o700);
  return dir;
}

/** A task that names no bot (a request made by hand) shares this tab. */
export const ANONYMOUS_BOT = 'shared';

/** The cast the owner watches: small and cheap, since a person is looking at it. */
const SCREENCAST = {format: 'jpeg', quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 2};

export function createSharedBrowser({start = startBrowserSession, allow = [], profile, settleMs, timeoutMs, idleMs = Number(process.env.AGENT_TAKEOVER_IDLE_MS) || 0} = {}) {
  const allowed = () => (typeof allow === 'function' ? allow() : allow);
  let session = null, starting = null;
  const tabs = new Map();      // botId -> {tab, url, title}
  const queue = [];            // tickets, first come first served
  const waits = new Set();     // {predicate, resolve}
  let holder = null;           // the bot whose task has the browser
  let driving = null;          // the bot whose tab the owner holds
  let epoch = 0;               // bumps whenever the owner takes the browser
  let parked = false;          // the running task is waiting at a step for the hand back
  let idleTimer = null;
  let watched = null;          // the tab being cast: {botId, tab, live, off}
  let frameSink = null;

  const notify = () => { for (const wait of [...waits]) if (wait.predicate()) { waits.delete(wait); wait.resolve(); } };
  const until = predicate => (predicate() ? Promise.resolve() : new Promise(resolve => { waits.add({predicate, resolve}); }));

  /** The browser process, started on first use and kept. One that died is dropped
   * with every tab it had, and the next task starts a new one on the same profile. */
  async function ensure() {
    if (session?.dead) forget();
    if (session) return session;
    starting ??= (async () => {
      if (profile) ensureProfileDir(profile);
      const live = await start({profile});
      session = live;
      return live;
    })().finally(() => { starting = null; });
    return starting;
  }
  function forget() {
    const dropped = session;
    session = null;
    watched = null;
    tabs.clear();
    if (dropped) void dropped.close().catch(() => {});
  }

  /** This bot's tab: the one it has if the browser still has it, else a new one. */
  async function tabFor(live, botId) {
    const known = tabs.get(botId);
    if (known) {
      const alive = (await live.liveTargets().catch(() => [])).some(target => target.targetId === known.tab.targetId);
      if (alive) return known.tab;
      tabs.delete(botId);
      known.tab.off();
    }
    const tab = await live.newTab({allow: allowed()});
    tabs.set(botId, {tab, url: null, title: null});
    return tab;
  }

  async function acquire(botId) {
    const ticket = {botId};
    queue.push(ticket);
    // Bots wait for the owner as well as for each other.
    await until(() => queue[0] === ticket && holder === null && driving === null);
    queue.shift();
    holder = botId;
  }
  const release = () => { holder = null; parked = false; notify(); };

  /** Run one page read or action list on this bot's tab. A browser that died
   * under it is noticed by `ensure` on the next task. */
  async function run(botId, {url, steps = [], approved = []}) {
    // A host nobody allowed costs no process, and no place in the queue.
    if (!hostAllowed(url, allowed())) throw new Error(`Refusing to open ${url}: its host is not in AGENT_BROWSER_ALLOWLIST.`);
    const id = botId || ANONYMOUS_BOT;
    await acquire(id);
    try {
      const live = await ensure();
      const tab = await tabFor(live, id);
      const remember = ({url: at, title}) => { const entry = tabs.get(id); if (entry) { entry.url = at || entry.url; entry.title = title ?? entry.title; } };
      // Asked before each step. False once the owner has taken the browser since
      // this task began; if they still hold it, wait here for the hand back.
      const startEpoch = epoch;
      const gate = async () => {
        if (driving) { parked = true; notify(); try { await until(() => driving === null); } finally { parked = false; } return false; }
        return epoch === startEpoch;
      };
      return await live.capture(url, {allow: allowed(), steps, approved, tab, timeoutMs, settleMs, onPage: remember, gate});
    } finally { release(); }
  }

  const armIdle = () => {
    clearTimeout(idleTimer);
    // No clock by default: the person holds the browser until they hand back. AGENT_TAKEOVER_IDLE_MS opts into one.
    if (!idleMs) return;
    idleTimer = setTimeout(() => { if (driving) { driving = null; notify(); } }, idleMs);
    idleTimer.unref?.();
  };
  const conflict = message => Object.assign(new Error(message), {status: 409});

  /** The owner takes this bot's tab (opening it if the bot never had one). The
   * bot's running task, if any, is not interrupted mid-step: see the header. */
  async function takeover(botId) {
    if (driving && driving !== botId) throw conflict('You are already driving another bot\'s tab. Hand it back first.');
    const first = !driving;
    if (first) { driving = botId; epoch++; notify(); }
    armIdle();
    try { await tabFor(await ensure(), botId); }
    catch (error) {
      // A browser that will not start must not leave the owner "holding" nothing.
      if (first) { driving = null; clearTimeout(idleTimer); notify(); }
      throw error;
    }
  }
  /** The owner is done: bots may go on. Handing back what you do not hold does nothing. */
  async function handback(botId) {
    if (driving !== botId) return;
    driving = null;
    clearTimeout(idleTimer);
    notify();
  }

  /** Frames of the watched tab, newest first wins at the receiver: `fn({botId, image, w, h, at})`. */
  const onFrame = fn => { frameSink = fn; };

  async function unwatch() {
    const was = watched;
    watched = null;
    if (!was) return;
    was.off();
    await was.live.cdp.send('Page.stopScreencast', {}, was.tab.sessionId).catch(() => {});
  }

  /** Cast one bot's tab, and only that one: Chrome pays for every frame it
   * encodes, so a tab nobody looks at is never cast. A bot with no tab has
   * nothing to show yet (false). Asking again for the same tab changes nothing. */
  async function watch(botId) {
    const entry = tabs.get(botId);
    if (!entry || !session) { await unwatch(); return false; }
    if (watched?.botId === botId && watched.tab === entry.tab) return true;
    await unwatch();
    const live = session, tab = entry.tab;
    const off = live.cdp.on('Page.screencastFrame', (params, raw) => {
      if (params.sessionId !== tab.sessionId) return;
      // Chrome sends no further frame until the last one is acked, with its own id.
      live.cdp.send('Page.screencastFrameAck', {sessionId: raw.sessionId}, tab.sessionId).catch(() => {});
      frameSink?.({botId, image: params.data, w: Number(params.metadata?.deviceWidth) || tab.viewport.width, h: Number(params.metadata?.deviceHeight) || tab.viewport.height, at: Date.now()});
    });
    watched = {botId, tab, live, off};
    try {
      await live.cdp.send('Page.startScreencast', SCREENCAST, tab.sessionId);
      // A page that never repaints sends no frame, and the viewer would stare at nothing.
      const {data} = await live.cdp.send('Page.captureScreenshot', {format: 'jpeg', quality: SCREENCAST.quality}, tab.sessionId);
      if (data && watched?.tab === tab) frameSink?.({botId, image: data, w: tab.viewport.width, h: tab.viewport.height, at: Date.now()});
    } catch { await unwatch(); return false; }
    return true;
  }

  /** One owner event, applied to the bot's tab as real input. The device
   * bounds it again here (the server already did), and a navigation is held to
   * the allowlist like every page the browser opens. */
  async function applyInput(botId, event) {
    const ev = cleanInput(event);
    if (driving !== botId) throw conflict('You are not driving that bot\'s tab. Take it over first.');
    // The bot's step in flight finishes first, or the owner's click would land in the middle of it.
    await until(() => holder === null || parked || driving !== botId);
    const entry = tabs.get(botId);
    if (driving !== botId || !entry || !session) throw conflict('You are not driving that bot\'s tab. Take it over first.');
    armIdle();
    const {sessionId} = entry.tab, send = (method, params) => session.cdp.send(method, params, sessionId);
    if (ev.type === 'click') {
      await send('Input.dispatchMouseEvent', {type: 'mouseMoved', x: ev.x, y: ev.y});
      for (let count = 1; count <= (ev.double ? 2 : 1); count++) {
        await send('Input.dispatchMouseEvent', {type: 'mousePressed', x: ev.x, y: ev.y, button: 'left', clickCount: count});
        await send('Input.dispatchMouseEvent', {type: 'mouseReleased', x: ev.x, y: ev.y, button: 'left', clickCount: count});
      }
    } else if (ev.type === 'scroll') {
      await send('Input.dispatchMouseEvent', {type: 'mouseWheel', x: ev.x, y: ev.y, deltaX: ev.dx, deltaY: ev.dy});
    } else if (ev.type === 'type') {
      await send('Input.insertText', {text: ev.text});
    } else if (ev.type === 'key') {
      const key = KEYS[ev.key], base = {key: ev.key, code: key.code, windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk};
      await send('Input.dispatchKeyEvent', {type: 'keyDown', ...base, ...(key.text ? {text: key.text} : {})});
      await send('Input.dispatchKeyEvent', {type: 'keyUp', ...base});
    } else if (ev.type === 'navigate') {
      if (!hostAllowed(ev.url, allowed())) throw new Error('That host is not in AGENT_BROWSER_ALLOWLIST.');
      await send('Page.navigate', {url: ev.url});
    }
  }

  /** Where each tab is now, from the browser itself (a click may have navigated). */
  async function refresh() {
    if (!session || !tabs.size) return;
    const targets = await session.liveTargets().catch(() => null);
    if (!targets) return;
    for (const entry of tabs.values()) {
      const target = targets.find(t => t.targetId === entry.tab.targetId);
      if (target) { entry.url = target.url; entry.title = target.title || entry.title; }
    }
  }

  /** What the device knows about each tab: for the status it reports. */
  const status = () => [...tabs].map(([botId, {url, title}]) => ({botId, state: driving === botId ? 'driving' : holder === botId ? 'browsing' : 'idle', url, title}));

  async function close() {
    clearTimeout(idleTimer);
    const live = session;
    session = null;
    watched = null;
    tabs.clear();
    if (live) await live.close().catch(() => {});
  }

  return {run, status, close, onFrame, watch, unwatch, applyInput, refresh, takeover, handback, owner: () => driving};
}

/** One `browser.capture` or `browser.action` task, with the rules every browser
 * task has had since they were added: the host must be allowlisted, an action
 * needs steps drawn from the known operations, and interaction needs the real
 * browser (`AGENT_BROWSER=1`), not the plain HTTP read. `shared` is the shared
 * browser; `botId` in the payload picks the tab. */
export async function runBrowserTask(task, {shared, allow, env = process.env}) {
  const payload = task.payload || {};
  const target = String(payload.url || '');
  if (!hostAllowed(target, allow)) {
    throw new Error(`Refusing to ${task.kind === 'browser.action' ? 'act on' : 'read'} ${hostOf(target) || target}: it is not in AGENT_BROWSER_ALLOWLIST. Only explicitly allowed pages are ${task.kind === 'browser.action' ? 'driven' : 'read'}.`);
  }
  let steps = [];
  if (task.kind === 'browser.action') {
    steps = Array.isArray(payload.steps) ? payload.steps.slice(0, MAX_ACTIONS) : [];
    if (!steps.length) throw new Error('browser.action needs at least one step.');
    const bad = steps.find(step => !step || !ACTION_OPS.includes(step.op));
    if (bad) throw new Error(`Unsupported action "${String(bad?.op)}". Allowed: ${ACTION_OPS.join(', ')}.`);
    // Interaction needs the real browser; the fetch fallback cannot click or type.
    if (env.AGENT_BROWSER !== '1') throw new Error('browser.action needs a real browser: set AGENT_BROWSER=1 on this device.');
  }
  // `approved` is what the server cleared (never the model): the browser refuses any other risky control.
  const approved = Array.isArray(payload.approved) ? payload.approved.filter(a => typeof a === 'string') : [];
  return shared.run(typeof payload.botId === 'string' && payload.botId ? payload.botId : ANONYMOUS_BOT, {url: target, steps, approved});
}
