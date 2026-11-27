/** The live view of the shared browser, between the device and the owner.
 *
 * Everything here is memory. A frame, a tab's address and title, a queued input
 * event: none of it is written to the database, a file or a log, and all of it
 * goes when the viewer, the device or the process does. The owner's browser asks
 * for a frame (`view`); that is what tells the device to start casting that
 * bot's tab (`watch` in its reply). The device sends the newest frame
 * (`putFrame`), and a long poll (`agentSync`) brings the owner's input and
 * takeover back to it.
 *
 * One hub holds one space per workspace and computer, so a device never sees
 * another workspace's or another computer's commands, and an owner never sees
 * another workspace's frames. A bot whose browser account or pin names a computer
 * is served only by that computer; an unpinned bot keeps "the computer that
 * polled last", so one computer behaves as it always did. A tab is told apart by
 * its (account, bot): the same bot on two accounts has two tabs.
 */
import {fail} from '../shared/errors.js';
import {companyBots} from '../shared/company.js';
import {hostOf} from '../shared/bot-browser.js';
import {cleanInput} from '../agent/live-input.mjs';
import {UPDATE_DEVICE_LINE, BROWSER_ACCOUNTS_V1} from '../shared/device-features.js';
import {missingFeatureLine} from './agent.js';
import {browserAccountOf, browserDeviceOf} from '../shared/browser-accounts.js';
import {ACCOUNT_ID} from '../shared/bot-settings.js';

export const LIVE_WAIT_MS = 20000;
/** A viewer that has not asked for a frame for this long is gone. */
const VIEW_TTL_MS = 6000;
/** A device that has not polled for this long is not there. */
const AGENT_FRESH_MS = 45000;
/** The device is given this long to report a takeover before its silence counts. */
const DRIVE_GRACE_MS = 10000;
export const MAX_QUEUED = 100;
const MAX_IMAGE = 700000;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const text = (value, max) => (typeof value === 'string' ? value.slice(0, max) : null);
/** A device's account is an id it was given; anything else reads as the default profile. */
const accountOf = value => (typeof value === 'string' && ACCOUNT_ID.test(value) ? value : null);
/** How a tab is named in a report: the account (none for the default profile) and the bot. */
const tabId = (account, botId) => `${account || ''}|${botId}`;
const ACCOUNTS_LINE = missingFeatureLine(BROWSER_ACCOUNTS_V1);
const sameWatch = (a, b) => (a?.botId ?? null) === (b?.botId ?? null) && (a?.account ?? null) === (b?.account ?? null);

export function createLiveHub({now = Date.now, waitMs = LIVE_WAIT_MS} = {}) {
  const spaces = new Map();   // `${workspace}\0${device}` -> space
  const lastPoller = new Map(); // workspace -> the device that polled last
  const hub = {waitMs};
  /** Whether a device has said it can hold a typed secret (`secret-input-v1`). Set by the routes, which can read the
   * device's stored features; until then no device is trusted with one. Each device drains only its own queue, and this
   * is asked again when commands are handed over, not only when they are queued. */
  hub.holdsSecrets = () => false;
  /** The same for `browser-accounts-v1`: a device without it would ignore an account and act in, or cast, the default
   * profile. Asked when commands and the watch are handed over, so a computer rolled back after they were queued is not
   * sent them. */
  hub.holdsAccounts = () => false;

  const keyOf = (workspaceId, agentId) => `${workspaceId}\u0000${agentId || ''}`;
  /** The device a call means: the one named, else the one that polled last (none before any has). */
  const deviceOf = (workspaceId, agentId) => agentId || lastPoller.get(workspaceId) || null;
  /** A computer's space, or null when it has none: a named computer that never polled is not there. */
  const peek = (workspaceId, agentId = null) => spaces.get(keyOf(workspaceId, deviceOf(workspaceId, agentId))) || null;
  /** The one resolver of a bot's computer, used by every method here and by the routes: the one named (an account's or
   * a pin), else the computer that is still there and holds this bot's tab (so a bot with no pin does not change
   * computer each time another one polls), else the one that polled last, else none. A holder that went quiet does not
   * count: nothing drains its line. */
  const deviceFor = (workspaceId, botId, agentId = null) => {
    if (agentId) return agentId;
    for (const sp of spaces.values()) if (sp.workspaceId === workspaceId && sp.agentId && sp.driving.has(botId) && alive(sp)) return sp.agentId;
    return lastPoller.get(workspaceId) || null;
  };
  const space = (workspaceId, agentId = null) => {
    const id = deviceOf(workspaceId, agentId), key = keyOf(workspaceId, id);
    let sp = spaces.get(key);
    if (!sp) {
      sp = {workspaceId, agentId: id, polledAt: 0, parked: null, sentWatch: null, commands: [], frame: null, seq: 0, viewers: new Map(), driving: new Map(), tabs: new Map(), notices: new Map(), tasks: false};
      spaces.set(key, sp);
    }
    return sp;
  };
  /** The tab somebody looked at most recently, if that was lately: `{botId, account}`. */
  const watchOf = sp => {
    let best = null, at = -Infinity;
    for (const [botId, v] of sp.viewers) {
      if (now() - v.at > VIEW_TTL_MS) sp.viewers.delete(botId);
      else if (v.at >= at) { best = {botId, account: v.account}; at = v.at; }
    }
    if (sp.frame && !(best && sp.frame.botId === best.botId && sp.frame.account === best.account)) sp.frame = null;
    return best;
  };
  const alive = sp => Boolean(sp) && (Boolean(sp.parked) || now() - sp.polledAt <= AGENT_FRESH_MS);

  function deliver(sp) {
    const parked = sp.parked;
    if (!parked) return;
    sp.parked = null;
    clearTimeout(parked.timer);
    parked.resolve(answer(sp, parked.agentId));
  }
  /** What the device hears: the owner's commands, the tab to cast (and its account, when it has one), and
   * `tasks: true` when work was queued for it since its last answer. */
  function answer(sp, agentId) {
    const watch = watchOf(sp);
    sp.sentWatch = watch;
    const out = {commands: sp.commands.splice(0), watch: watch ? watch.botId : null};
    if (watch?.account) out.watchAccount = watch.account;
    // An account's command or tab goes only to a device that holds `browser-accounts-v1` now. For any other it is
    // dropped, never sent, the hold is released here, and the owner is told in fixed words.
    if ((out.commands.some(c => c.account) || watch?.account) && !hub.holdsAccounts(sp.workspaceId, agentId)) {
      for (const c of out.commands) if (c.account) { sp.notices.set(c.botId, ACCOUNTS_LINE); sp.driving.delete(c.botId); }
      out.commands = out.commands.filter(c => !c.account);
      if (watch?.account) { sp.notices.set(watch.botId, ACCOUNTS_LINE); out.watch = null; delete out.watchAccount; }
    }
    // A secret goes only to a device that holds `secret-input-v1` now. For any other it is dropped, never sent (it
    // would be typed untagged and left in the page's results), and the owner is told in fixed words, never the text.
    if (out.commands.some(isSecret) && !hub.holdsSecrets(sp.workspaceId, agentId)) {
      for (const c of out.commands) if (isSecret(c)) sp.notices.set(c.botId, UPDATE_DEVICE_LINE);
      out.commands = out.commands.filter(c => !isSecret(c));
    }
    if (sp.tasks) { sp.tasks = false; out.tasks = true; }
    return out;
  }
  const isSecret = c => c.type === 'input' && c.event?.secret === true;
  /** Something the device should hear now: answer its parked poll. */
  const wake = sp => deliver(sp);

  /** The device's long poll. It reports where its tabs are and who the owner is
   * driving; the answer is what to do and which bot's tab to cast. */
  function agentSync(workspaceId, agentId, report = {}) {
    // What was asked of "the computer that polled last" before any computer polled belongs to the first one that does.
    const early = spaces.get(keyOf(workspaceId, null));
    if (early && !spaces.has(keyOf(workspaceId, agentId))) { spaces.delete(keyOf(workspaceId, null)); early.agentId = agentId; spaces.set(keyOf(workspaceId, agentId), early); }
    lastPoller.set(workspaceId, agentId);
    const sp = space(workspaceId, agentId);
    sp.polledAt = now();
    sp.tabs = new Map((Array.isArray(report?.tabs) ? report.tabs : []).slice(0, 50).filter(t => typeof t?.botId === 'string')
      .map(t => { const botId = t.botId.slice(0, 64), account = accountOf(t.account); return [tabId(account, botId), {url: text(t.url, 2000), title: text(t.title, 300)}]; }));
    // A takeover the device could not start (no browser on it): the hold goes at once, and the owner is told why.
    const failed = report?.failed;
    if (typeof failed?.botId === 'string') {
      sp.driving.delete(failed.botId.slice(0, 64));
      sp.notices.set(failed.botId.slice(0, 64), text(failed.message, 200) || 'The takeover could not start.');
    }
    // The device is the authority on whether the owner holds a tab, once it has had time to hear about it.
    for (const [botId, held] of sp.driving) if (report?.owner !== botId && now() - held.since > DRIVE_GRACE_MS) sp.driving.delete(botId);
    deliver(sp);
    if (sp.commands.length || sp.tasks || !sameWatch(watchOf(sp), sp.sentWatch)) return Promise.resolve(answer(sp, agentId));
    return new Promise(resolve => {
      const timer = setTimeout(() => deliver(sp), hub.waitMs);
      sp.parked = {resolve, timer, agentId};
    });
  }

  /** The newest frame of the watched tab. Anything else is dropped. */
  function putFrame(workspaceId, agentId, {botId, account = null, image, w, h} = {}) {
    const sp = space(workspaceId, agentId);
    if (typeof image !== 'string' || !image) fail('A frame needs an image.', 400);
    if (image.length > MAX_IMAGE) fail('That frame is too large.', 413);
    if (!BASE64.test(image)) fail('A frame must be base64.', 400);
    const watch = watchOf(sp), acct = accountOf(account);
    if (watch && botId === watch.botId && acct === watch.account) sp.frame = {botId, account: acct, image, w: Number(w) || 1280, h: Number(h) || 800, at: now(), seq: ++sp.seq};
    const now_ = watchOf(sp);
    return {watch: now_ ? now_.botId : null, ...(now_?.account ? {watchAccount: now_.account} : {})};
  }

  /** The owner's page asks for a bot's frame. Asking is what makes the device cast it. `account` is the bot's browser
   * account when it has one (else the one the owner took over with). */
  function view(workspaceId, botId, {after, agentId = null, account} = {}) {
    const sp = space(workspaceId, deviceFor(workspaceId, botId, agentId));
    const acct = account === undefined ? sp.driving.get(botId)?.account ?? null : accountOf(account);
    sp.viewers.set(botId, {at: now(), account: acct});
    if (!sameWatch(watchOf(sp), sp.sentWatch)) wake(sp);
    const frame = sp.frame?.botId === botId && sp.frame.account === acct ? sp.frame : null;
    const out = {botId, agent: alive(sp), seq: frame ? frame.seq : 0, changed: Boolean(frame) && frame.seq !== Number(after)};
    if (frame) Object.assign(out, {w: frame.w, h: frame.h, at: frame.at});
    const notice = sp.notices.get(botId);
    if (notice && !sp.driving.has(botId)) out.notice = notice;
    if (out.changed) out.image = `data:image/jpeg;base64,${frame.image}`;
    return out;
  }

  const command = (sp, entry, account) => {
    if (sp.commands.length >= MAX_QUEUED) fail('Too much input is waiting for the browser. Try again in a moment.', 429);
    sp.commands.push(account ? {...entry, account} : entry);
    wake(sp);
  };

  function takeover(workspaceId, botId, {agentId = null, account = null} = {}) {
    const sp = peek(workspaceId, deviceFor(workspaceId, botId, agentId));
    if (!alive(sp)) fail('The local agent is not running the shared browser right now, so there is nothing to take over. Start it with AGENT_BROWSER=1 and try again.', 409);
    sp.notices.delete(botId);
    // Any other computer that held this bot's tab is told to let go (it hears it when it next polls, even if it is quiet now).
    for (const other of spaces.values()) if (other !== sp && other.workspaceId === workspaceId) release(other, botId);
    sp.driving.set(botId, {since: now(), account});
    command(sp, {type: 'takeover', botId}, account);
  }
  /** Forget this computer's hold on a bot and queue the handback it will hear. True when it held it. */
  function release(sp, botId) {
    const held = sp.driving.get(botId);
    if (!held) return false;
    sp.driving.delete(botId);
    sp.commands.push(held.account ? {type: 'handback', botId, account: held.account} : {type: 'handback', botId});
    wake(sp);
    return true;
  }
  function handback(workspaceId, botId, {agentId = null, account = null} = {}) {
    const sp = peek(workspaceId, deviceFor(workspaceId, botId, agentId));
    // The hold goes everywhere at once, and every computer that held it is told, even one that is quiet now.
    const told = new Set();
    for (const other of spaces.values()) if (other.workspaceId === workspaceId && release(other, botId)) told.add(other);
    if (!sp || told.has(sp)) return;
    sp.commands.push(account ? {type: 'handback', botId, account} : {type: 'handback', botId});
    wake(sp);
  }
  function input(workspaceId, botId, event, {agentId = null, account = null} = {}) {
    const sp = peek(workspaceId, deviceFor(workspaceId, botId, agentId));
    if (!sp?.driving.has(botId)) fail('Take over the browser before you click or type in it.', 409);
    command(sp, {type: 'input', botId, event: cleanInput(event)}, account);
  }

  /** A task was queued for a device: answer its parked poll so it heartbeats now instead of at the end of its poll
   * interval. A device that is not on the live line hears it at its next heartbeat, as before. */
  function taskQueued(workspaceId, agentId) {
    const sp = peek(workspaceId, agentId);
    if (!sp) return;
    sp.tasks = true;
    wake(sp);
  }

  return Object.assign(hub, {
    agentSync, putFrame, view, takeover, handback, input, taskQueued,
    /** Whether the owner holds this bot's tab, on any of the workspace's computers. */
    isDriving: (workspaceId, botId) => [...spaces.values()].some(sp => sp.workspaceId === workspaceId && alive(sp) && sp.driving.has(botId)),
    /** The computer that serves this bot now (`agentId` is its account's or its pin): the one resolver, for the routes too. */
    deviceFor,
    /** Whether a computer is polling: the named one, else the one that polled last. A named one with no space is not there. */
    agentLive: (workspaceId, agentId = null) => alive(peek(workspaceId, agentId)),
    /** The computer serving a workspace's live view: the named one if it is known, else the one that polled last, or null. */
    agentId: (workspaceId, agentId = null) => peek(workspaceId, agentId)?.agentId ?? null,
    /** Where a computer last said this bot's tab (on this account) was, while it is still there. */
    tab: (workspaceId, botId, {agentId = null, account = null} = {}) => { const sp = peek(workspaceId, deviceFor(workspaceId, botId, agentId)); return alive(sp) ? sp.tabs.get(tabId(account, botId)) || null : null; },
    /** Release every parked poll and forget everything: shutdown, and tests. */
    close() { for (const sp of spaces.values()) { deliver(sp); sp.frame = null; sp.viewers.clear(); sp.commands.length = 0; sp.driving.clear(); sp.notices.clear(); } spaces.clear(); lastPoller.clear(); },
  });
}

/** The process's one hub. */
export const browserLive = createLiveHub();

const MAX_PAGES = 20;

/** The pages of the bot's current run, or of its last run when it is idle: the
 * run's own records (a group run has an id; a 1:1 chat's follow-ups are a chain
 * of rising depth). Only pages that opened, or are opening now, and a page seen
 * twice in a row once. Derived, so nothing about a page is stored for this. */
function pagesOf(requests, botId) {
  const mine = requests.filter(r => r.botId === botId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  if (!mine.length) return [];
  const last = mine[0];
  let run;
  if (last.runId) run = mine.filter(r => r.runId === last.runId).reverse();
  else {
    run = [last];
    for (let cur = last; cur.depth > 0;) {
      const before = mine.find(r => r.chatKey === cur.chatKey && r.depth === cur.depth - 1 && String(r.createdAt) < String(cur.createdAt));
      if (!before) break;
      run.unshift(before);
      cur = before;
    }
  }
  const pages = [];
  for (const r of run) {
    if (r.status !== 'done' && r.status !== 'dispatched') continue;
    const done = r.status === 'done';
    const url = (done && r.result?.finalUrl) || r.url;
    if (pages.at(-1)?.url === url) continue;
    pages.push({url, title: (done && r.result?.title) || null, at: r.updatedAt || r.createdAt});
  }
  return pages.slice(-MAX_PAGES);
}

/** The Computer view's list: one entry per bot. `state` is `driving` while the
 * owner holds the bot's tab, `browsing` while one of its requests is out, else
 * `idle`. `site` (the host of the page now) is for the progress pill's chip and
 * only while the bot browses or is driven. */
export function liveStates(state, {hub, ws}) {
  const requests = state?.browserRequests || [];
  const seen = new Set(), out = [];
  for (const bot of companyBots(state)) {
    if (seen.has(bot.id)) continue;
    seen.add(bot.id);
    // The bot's own computer: its account's, else its pin, else whichever polled last.
    const {account} = browserAccountOf(state, bot.id), agentId = browserDeviceOf(state, bot.id) || null;
    const device = hub.deviceFor(ws, bot.id, agentId);
    const live = hub.agentLive(ws, device);
    const open = requests.find(r => r.botId === bot.id && r.status === 'dispatched') || null;
    const mode = hub.isDriving(ws, bot.id) ? 'driving' : open ? 'browsing' : 'idle';
    const tab = hub.tab(ws, bot.id, {agentId: device, account: account?.id || null});
    const lastDone = requests.filter(r => r.botId === bot.id && r.status === 'done').sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    const url = tab?.url || (open ? open.url : lastDone?.result?.finalUrl || lastDone?.url) || null;
    const title = tab?.title || (open ? null : lastDone?.result?.title) || null;
    // A member gets the account's name and id (the id is already in the bot's settings), never its computer, site or jar.
    out.push({botId: bot.id, state: mode, url, title, site: mode === 'idle' ? null : hostOf(url) || null, pages: pagesOf(requests, bot.id), runId: open?.runId || null, requestId: open?.id || null, live, account: account ? {id: account.id, name: account.name} : null});
  }
  return out;
}
