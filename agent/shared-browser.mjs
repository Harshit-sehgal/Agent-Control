/** The one browser every bot on this device shares.
 *
 * One Chrome process runs on one persistent profile, kept in the agent's config
 * directory (`browser-profile`, mode 0700). Sign in to a site there once and the
 * sign-in is there for every bot, because every bot's tab lives in the profile's
 * default context. The profile is never uploaded, logged or backed up by this
 * code: nothing here reads it, Chrome alone does.
 *
 * - One bot drives each tab, and tabs run side by side. A bot's tasks wait their turn on its own
 *   queue, in the order they asked, and never touch another bot's tab (`tabKey` names the queue).
 * - A task may name a browser account. Each account has a browser context of its own (cookies shared
 *   with no other), filled from its jar when the context is made and saved back after a task that
 *   used it. A tab belongs to one (account, bot) pair, and every step first checks that its tab sits in
 *   that account's current context, so a stale tab or a tab in the default profile never serves it.
 * - The owner can take one bot's tab (`takeover`) and hand it back (`handback`). A takeover parks
 *   only the tab the owner holds: no new task starts on that tab, and other bots' tabs go on as
 *   before. A task already running on it finishes the step it is in, runs no further step (the page
 *   is no longer the one its steps were planned for), waits for the hand back and then answers with
 *   the page as the owner left it. The owner's input waits for that step too, so an action is never
 *   applied twice or cut in half, and never waits for another bot's step.
 * - Each (account, bot) has its own tab. A tab the browser no longer has
 *   is dropped and replaced; after a restart there are no tab ids at all, so no
 *   stale one can be used.
 * - Each tab keeps its own typed memory: what the owner types in secret is remembered for the life of that
 *   bot's tab (`typed`, in memory only, never written anywhere) and scrubbed from every result that leaves: a capture, an action's answer and the status.
 *   The page's secret fields are emptied when the owner hands back.
 * - The rules that bound a page read still bound every step: the allowlist, the
 *   egress proxy that refuses private addresses, and the X click/type refusal.
 *   Those live in `agent/browser.mjs`, which this file drives.
 */
import fs from 'node:fs';
import path from 'node:path';
import {startBrowserSession, ACTION_OPS, MAX_ACTIONS} from './browser.mjs';
import {FOCUSED_IS_SECRET_JS, TAG_FOCUSED_SECRET_JS, CLEAR_SECRETS_ON_HANDBACK_JS, rememberTyped, scrubTyped} from './page-secrets.mjs';
import {hostAllowed, hostOf} from '../shared/bot-browser.js';
import {cleanInput, KEYS, VIEWPORT} from './live-input.mjs';
import {ACCOUNT_ID} from '../shared/bot-settings.js';

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

/** What names one tab and its queue: the account (empty for the device's own profile) and the bot. */
export const tabKey = (account, botId) => `${account || ''}\u0000${botId}`;

const NO_ACCOUNT = 'This task names a browser account this device cannot use.';
const WRONG_CONTEXT = 'This tab is not in the bot\'s browser account, so the step was not run.';

export function createSharedBrowser({start = startBrowserSession, allow = [], profile, settleMs, timeoutMs, jars = null, idleMs = Number(process.env.AGENT_TAKEOVER_IDLE_MS) || 0} = {}) {
  const allowed = () => (typeof allow === 'function' ? allow() : allow);
  let session = null, starting = null;
  const tabs = new Map();      // tabKey -> {botId, account, tab, url, title, typed}: `typed` is what the owner typed in secret, in memory only
  const opening = new Map();   // tabKey -> the tab being opened, so two askers for one tab open one
  const contexts = new Map();  // account -> {id, restored}: the browser contexts of this session, gone with it
  const contextStarts = new Map(); // account -> the context being made
  // tabKey -> {queue: ticket[], holding, parked, epoch}. Made on first use, dropped when nothing is queued or running.
  const lanes = new Map();
  const waits = new Set();     // {predicate, resolve}
  let driving = null;          // the tab the owner holds, {key, botId, account}: one tab at a time
  let idleTimer = null;
  let watched = null;          // the tab being cast: {key, botId, account, tab, live, off}
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
    contexts.clear();
    if (dropped) void dropped.close().catch(() => {});
  }

  /** A task that names an account needs jars to keep it in and an id that cannot be a path. */
  function checkAccount(account) {
    if (account == null) return;
    if (!jars || typeof account !== 'string' || !ACCOUNT_ID.test(account)) throw new Error(NO_ACCOUNT);
  }

  /** This account's browser context: made once (however many ask at once) and filled from its jar. */
  function contextFor(live, account) {
    const have = contexts.get(account);
    if (have) return Promise.resolve(have);
    let pending = contextStarts.get(account);
    if (!pending) {
      pending = (async () => {
        const id = await live.createContext();
        try {
          let cookies;
          // Said in fixed words: an error from here must never carry a cookie.
          try { cookies = jars.load(account) || []; await live.setCookies(id, cookies); }
          catch { throw new Error('This browser account\'s saved sign-in could not be put back in the browser.'); }
          // A browser that was replaced while this ran must not have this context in its map.
          if (session !== live) throw new Error('The browser restarted. Try again.');
          const made = {id, restored: cookies.length > 0};
          contexts.set(account, made);
          return made;
        } catch (error) { await live.disposeContext(id).catch(() => {}); throw error; }
      })().finally(() => contextStarts.delete(account));
      contextStarts.set(account, pending);
    }
    return pending;
  }

  /** Throws unless `tab` sits in the context this account has now (the default profile for none). The account's
   * own context id is the only one compared: a browser also names the default context. */
  function checkContext(account, tab) {
    const want = account ? contexts.get(account)?.id : null;
    if (account ? !want || tab.browserContextId !== want : tab.browserContextId != null) throw new Error(WRONG_CONTEXT);
  }

  /** Closes an account's tabs, then its context (Chrome closes a context's targets but leaves a tab's listener on). */
  async function dropContext(live, account) {
    const entry = contexts.get(account);
    contexts.delete(account);
    for (const [key, held] of tabs) {
      if (held.account !== account) continue;
      tabs.delete(key);
      if (watched?.key === key) watched = null;
      await live.closeTab(held.tab);
    }
    if (entry) await live.disposeContext(entry.id).catch(() => {});
  }

  /** The account's cookies, written to its jar. A failure is said in fixed words: nothing here may print a cookie. */
  async function saveJar(live, account) {
    const entry = contexts.get(account);
    if (!entry || session !== live || live.dead) return;
    try { jars.save(account, await live.getCookies(entry.id)); }
    catch { console.error('agent: could not save a browser account\'s cookies.'); }
  }

  /** This tab: the one it has if the browser still has it (in the account's current context), else a new one.
   * One at a time per tab, so a takeover and a task asking together open one. */
  function tabFor(live, account, botId) {
    const key = tabKey(account, botId);
    let pending = opening.get(key);
    if (!pending) {
      pending = openTab(live, key, account, botId).finally(() => opening.delete(key));
      opening.set(key, pending);
    }
    return pending;
  }
  async function openTab(live, key, account, botId) {
    const known = tabs.get(key);
    if (known) {
      const alive = (await live.liveTargets().catch(() => [])).some(target => target.targetId === known.tab.targetId);
      if (alive && !account === !known.tab.browserContextId && (!account || known.tab.browserContextId === contexts.get(account)?.id)) return known.tab;
      tabs.delete(key);
      known.tab.off();
    }
    let context = account ? await contextFor(live, account) : null;
    let tab;
    try { tab = await live.newTab({allow: allowed(), browserContextId: context?.id}); }
    catch (error) {
      if (!context) throw error;
      // The context is gone under a live browser: start it again from the jar.
      await dropContext(live, account);
      context = await contextFor(live, account);
      tab = await live.newTab({allow: allowed(), browserContextId: context.id});
    }
    tabs.set(key, {botId, account, tab, url: null, title: null, typed: new Set()});
    return tab;
  }

  /** Wait this tab's turn on its own lane (and for the owner, if they hold this tab). Returns the lane. */
  async function acquire(key, botId) {
    let lane = lanes.get(key);
    if (!lane) lanes.set(key, lane = {queue: [], holding: false, parked: false, epoch: 0});
    const ticket = {botId};
    lane.queue.push(ticket);
    await until(() => lane.queue[0] === ticket && !lane.holding && driving?.key !== key);
    lane.queue.shift();
    lane.holding = true;
    return lane;
  }
  const release = (key, lane) => {
    lane.holding = false; lane.parked = false;
    if (!lane.queue.length && lanes.get(key) === lane) lanes.delete(key);
    notify();
  };

  /** Run one page read or action list on this bot's tab (in its account's context, if it names one). A browser
   * that died under it is noticed by `ensure` on the next task. */
  async function run(botId, {url, steps = [], approved = [], account = null}) {
    // A host nobody allowed, or an account this device cannot hold, costs no process and no place in the queue.
    checkAccount(account);
    if (!hostAllowed(url, allowed())) throw new Error(`Refusing to open ${url}: its host is not in AGENT_BROWSER_ALLOWLIST.`);
    const id = botId || ANONYMOUS_BOT, key = tabKey(account, id);
    const lane = await acquire(key, id);
    let live = null;
    try {
      live = await ensure();
      const tab = await tabFor(live, account, id);
      checkContext(account, tab);
      const {typed} = tabs.get(key);
      const remember = ({url: at, title}) => { const entry = tabs.get(key); if (entry) { entry.url = at || entry.url; entry.title = title ?? entry.title; } };
      // Asked before each step. False once the owner has taken this bot's tab since this task began (another
      // bot's tab being taken changes nothing here); if they still hold it, wait here for the hand back.
      const startEpoch = lane.epoch;
      const gate = async () => {
        checkContext(account, tab);
        if (driving?.key === key) { lane.parked = true; notify(); try { await until(() => driving === null); } finally { lane.parked = false; } return false; }
        return lane.epoch === startEpoch;
      };
      // The last point before the result leaves the device: what the owner typed in secret is hidden from all of it.
      try { return scrubTyped(await live.capture(url, {allow: allowed(), steps, approved, tab, timeoutMs, settleMs, onPage: remember, gate}), typed); }
      catch (error) {
        // An error names what the page did (a blocked address it was sent to may carry the echo), and leaves as text.
        throw Object.assign(new Error(scrubTyped(String(error?.message ?? ''), typed)), {status: error?.status});
      }
    } finally {
      // What the page changed in the account's cookies is kept before the next task, or a restart, can lose it.
      if (account && live) await saveJar(live, account);
      release(key, lane);
    }
  }

  const armIdle = () => {
    clearTimeout(idleTimer);
    // No clock by default: the person holds the browser until they hand back. AGENT_TAKEOVER_IDLE_MS opts into one.
    if (!idleMs) return;
    idleTimer = setTimeout(() => { if (driving) void handback(driving.botId); }, idleMs);
    idleTimer.unref?.();
  };
  const conflict = message => Object.assign(new Error(message), {status: 409});

  /** The owner takes this bot's tab (opening it if the bot never had one). The
   * bot's running task, if any, is not interrupted mid-step: see the header. */
  async function takeover(botId, account = null) {
    checkAccount(account);
    const key = tabKey(account, botId);
    if (driving && driving.key !== key) throw conflict('You are already driving another bot\'s tab. Hand it back first.');
    const first = !driving;
    if (first) { driving = {key, botId, account}; const lane = lanes.get(key); if (lane) lane.epoch++; notify(); }
    armIdle();
    try { await tabFor(await ensure(), account, botId); }
    catch (error) {
      // A browser that will not start must not leave the owner "holding" nothing.
      if (first) { driving = null; clearTimeout(idleTimer); notify(); }
      throw error;
    }
  }
  /** Empty the page's secret fields (the typed memory is kept: the site may echo it later). Said in fixed words when
   * it fails, and it never holds anything up: one that does not answer in two seconds is let go. Nothing to clear
   * when the owner typed nothing in secret on this tab. */
  async function clearSecretFields(entry) {
    if (!entry?.typed.size || !session) return;
    let timer;
    const answer = await Promise.race([
      session.cdp.send('Runtime.evaluate', {expression: CLEAR_SECRETS_ON_HANDBACK_JS, returnByValue: true}, entry.tab.sessionId).catch(() => null),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); }),
    ]);
    clearTimeout(timer);
    if (!answer || answer.exceptionDetails) console.error('agent: could not empty the secret fields on the page.');
  }

  /** The owner is done: bots may go on, and the page's secret fields are emptied first. Handing back what you do not hold does nothing. */
  async function handback(botId) {
    if (driving?.botId !== botId) return;
    await clearSecretFields(tabs.get(driving.key));
    if (driving?.botId !== botId) return;
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
  async function watch(botId, account = null) {
    const key = tabKey(account, botId), entry = tabs.get(key);
    if (!entry || !session) { await unwatch(); return false; }
    if (watched?.key === key && watched.tab === entry.tab) return true;
    await unwatch();
    const live = session, tab = entry.tab;
    const off = live.cdp.on('Page.screencastFrame', (params, raw) => {
      if (params.sessionId !== tab.sessionId) return;
      // Chrome sends no further frame until the last one is acked, with its own id.
      live.cdp.send('Page.screencastFrameAck', {sessionId: raw.sessionId}, tab.sessionId).catch(() => {});
      frameSink?.({botId, account, image: params.data, w: Number(params.metadata?.deviceWidth) || tab.viewport.width, h: Number(params.metadata?.deviceHeight) || tab.viewport.height, at: Date.now()});
    });
    watched = {key, botId, account, tab, live, off};
    try {
      await live.cdp.send('Page.startScreencast', SCREENCAST, tab.sessionId);
      // A page that never repaints sends no frame, and the viewer would stare at nothing.
      const {data} = await live.cdp.send('Page.captureScreenshot', {format: 'jpeg', quality: SCREENCAST.quality}, tab.sessionId);
      if (data && watched?.tab === tab) frameSink?.({botId, account, image: data, w: tab.viewport.width, h: tab.viewport.height, at: Date.now()});
    } catch { await unwatch(); return false; }
    return true;
  }

  /** One owner event, applied to the bot's tab as real input. The device
   * bounds it again here (the server already did), and a navigation is held to
   * the allowlist like every page the browser opens. */
  async function applyInput(botId, event) {
    const ev = cleanInput(event);
    if (driving?.botId !== botId) throw conflict('You are not driving that bot\'s tab. Take it over first.');
    // The bot's step in flight finishes first, or the owner's click would land in the middle of it.
    // Only this tab's own lane: another tab's step is no reason to hold the owner's typing.
    const key = driving.key;
    await until(() => { const lane = lanes.get(key); return !lane?.holding || lane.parked || driving?.key !== key; });
    const entry = tabs.get(key);
    if (driving?.key !== key || !entry || !session) throw conflict('You are not driving that bot\'s tab. Take it over first.');
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
      // Ask the page whether the cursor is in a secret field, tag that field while focus is certain (before the
      // text can move it), then type. An answer that is not a plain boolean (a page expression that threw) counts
      // as yes, and a tag that fails stops the typing. The tag lands only on a text-entry field. Nothing here ever names the text.
      const asked = await send('Runtime.evaluate', {expression: FOCUSED_IS_SECRET_JS, returnByValue: true})
        .then(reply => (!reply?.exceptionDetails && typeof reply?.result?.value === 'boolean' ? reply.result.value : true), () => true);
      if (ev.secret || asked) {
        const tagged = await send('Runtime.evaluate', {expression: TAG_FOCUSED_SECRET_JS, returnByValue: true}).catch(() => null);
        // `false` is the page's own answer that nothing typeable has the focus (a wrapper an app focused, a button):
        // nothing was tagged, so nothing is typed. Any other failure is the generic one.
        if (tagged && !tagged.exceptionDetails && tagged.result?.value === false) throw new Error('Tap the field you want to type into first.');
        if (!tagged || tagged.exceptionDetails || tagged.result?.value !== true) throw new Error('The browser could not mark that field secret.');
      }
      // Remembered before the text goes in, so nothing the page does with it can come back unhidden.
      if (ev.secret || asked) rememberTyped(entry.typed, ev.text);
      await send('Input.insertText', {text: ev.text}).catch(() => { throw new Error('The browser did not take the typed text.'); });
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

  /** What the device knows about each tab: for the status it reports. `refresh` stores Chrome's own address and title,
   * so what leaves here is scrubbed of what the owner typed in secret. */
  const status = () => [...tabs].map(([key, {botId, account, url, title, typed}]) => ({botId, account, state: driving?.key === key ? 'driving' : lanes.get(key)?.holding ? 'browsing' : 'idle', ...scrubTyped({url, title}, typed)}));

  async function close() {
    clearTimeout(idleTimer);
    const live = session;
    session = null;
    watched = null;
    tabs.clear();
    contexts.clear();
    if (live) await live.close().catch(() => {});
  }

  /** `value` scrubbed of what the owner typed in secret on this bot's tab: for a result that left some other way. */
  const scrub = (botId, value, account = null) => scrubTyped(value, tabs.get(tabKey(account, botId || ANONYMOUS_BOT))?.typed);

  return {run, scrub, status, close, onFrame, watch, unwatch, applyInput, refresh, takeover, handback, owner: () => driving?.botId ?? null, laneCount: () => lanes.size};
}

/** One `browser.capture` or `browser.action` task, with the rules every browser
 * task has had since they were added: the host must be allowlisted, an action
 * needs steps drawn from the known operations, and interaction needs the real
 * browser (`AGENT_BROWSER=1`), not the plain HTTP read. `shared` is the shared
 * browser; `botId` in the payload picks the tab. */
export async function runBrowserTask(task, {shared, allow, env = process.env, agentId = null}) {
  const payload = task.payload || {};
  // A task another computer was meant for, or an account id that could be a path, is refused before anything else.
  if (agentId && payload.deviceId != null && payload.deviceId !== agentId) throw new Error('This task is for another computer, so it was not run.');
  const account = payload.account == null || payload.account === '' ? null : payload.account;
  if (account !== null && !(typeof account === 'string' && ACCOUNT_ID.test(account))) throw new Error('This task names a browser account this device cannot use.');
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
  return shared.run(typeof payload.botId === 'string' && payload.botId ? payload.botId : ANONYMOUS_BOT, {url: target, steps, approved, account});
}
