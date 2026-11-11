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

export function createSharedBrowser({start = startBrowserSession, allow = [], profile, settleMs, timeoutMs} = {}) {
  const allowed = () => (typeof allow === 'function' ? allow() : allow);
  let session = null, starting = null;
  const tabs = new Map();      // botId -> {tab, url, title}
  const queue = [];            // tickets, first come first served
  const waits = new Set();     // {predicate, resolve}
  let holder = null;           // the bot whose task has the browser

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
    await until(() => queue[0] === ticket && holder === null);
    queue.shift();
    holder = botId;
  }
  const release = () => { holder = null; notify(); };

  /** Run one page read or action list on this bot's tab. A browser that died
   * under it is noticed by `ensure` on the next task. */
  async function run(botId, {url, steps = []}) {
    // A host nobody allowed costs no process, and no place in the queue.
    if (!hostAllowed(url, allowed())) throw new Error(`Refusing to open ${url}: its host is not in AGENT_BROWSER_ALLOWLIST.`);
    const id = botId || ANONYMOUS_BOT;
    await acquire(id);
    try {
      const live = await ensure();
      const tab = await tabFor(live, id);
      const remember = ({url: at, title}) => { const entry = tabs.get(id); if (entry) { entry.url = at || entry.url; entry.title = title ?? entry.title; } };
      return await live.capture(url, {allow: allowed(), steps, tab, timeoutMs, settleMs, onPage: remember});
    } finally { release(); }
  }

  /** What the device knows about each tab: for the status it reports. */
  const status = () => [...tabs].map(([botId, {url, title}]) => ({botId, state: holder === botId ? 'browsing' : 'idle', url, title}));

  async function close() {
    const live = session;
    session = null;
    tabs.clear();
    if (live) await live.close().catch(() => {});
  }

  return {run, status, close};
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
  return shared.run(typeof payload.botId === 'string' && payload.botId ? payload.botId : ANONYMOUS_BOT, {url: target, steps});
}
