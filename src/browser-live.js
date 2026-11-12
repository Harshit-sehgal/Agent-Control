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
 * One hub holds one space per workspace, so a device never sees another
 * workspace's commands and an owner never sees another workspace's frames.
 */
import {fail} from '../shared/errors.js';
import {companyBots} from '../shared/company.js';
import {hostOf} from '../shared/bot-browser.js';
import {cleanInput} from '../agent/live-input.mjs';

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

export function createLiveHub({now = Date.now, waitMs = LIVE_WAIT_MS} = {}) {
  const spaces = new Map();
  const hub = {waitMs};

  const space = id => {
    let sp = spaces.get(id);
    if (!sp) {
      sp = {agentId: null, polledAt: 0, parked: null, sentWatch: null, commands: [], frame: null, seq: 0, viewers: new Map(), driving: new Map(), tabs: new Map(), notices: new Map(), tasks: false};
      spaces.set(id, sp);
    }
    return sp;
  };
  /** The bot whose tab somebody looked at most recently, if that was lately. */
  const watchOf = sp => {
    let best = null, at = -Infinity;
    for (const [botId, seen] of sp.viewers) {
      if (now() - seen > VIEW_TTL_MS) sp.viewers.delete(botId);
      else if (seen >= at) { best = botId; at = seen; }
    }
    if (sp.frame && sp.frame.botId !== best) sp.frame = null;
    return best;
  };
  const alive = sp => Boolean(sp.parked) || now() - sp.polledAt <= AGENT_FRESH_MS;

  function deliver(sp) {
    const parked = sp.parked;
    if (!parked) return;
    sp.parked = null;
    clearTimeout(parked.timer);
    parked.resolve(answer(sp));
  }
  /** What the device hears: the owner's commands, the tab to cast, and
   * `tasks: true` when work was queued for it since its last answer. */
  function answer(sp) {
    const watch = watchOf(sp);
    sp.sentWatch = watch;
    const out = {commands: sp.commands.splice(0), watch};
    if (sp.tasks) { sp.tasks = false; out.tasks = true; }
    return out;
  }
  /** Something the device should hear now: answer its parked poll. */
  const wake = sp => deliver(sp);

  /** The device's long poll. It reports where its tabs are and who the owner is
   * driving; the answer is what to do and which bot's tab to cast. */
  function agentSync(workspaceId, agentId, report = {}) {
    const sp = space(workspaceId);
    sp.agentId = agentId;
    sp.polledAt = now();
    sp.tabs = new Map((Array.isArray(report?.tabs) ? report.tabs : []).slice(0, 50).filter(t => typeof t?.botId === 'string').map(t => [t.botId.slice(0, 64), {url: text(t.url, 2000), title: text(t.title, 300)}]));
    // A takeover the device could not start (no browser on it): the hold goes at once, and the owner is told why.
    const failed = report?.failed;
    if (typeof failed?.botId === 'string') {
      sp.driving.delete(failed.botId.slice(0, 64));
      sp.notices.set(failed.botId.slice(0, 64), text(failed.message, 200) || 'The takeover could not start.');
    }
    // The device is the authority on whether the owner holds a tab, once it has had time to hear about it.
    for (const [botId, since] of sp.driving) if (report?.owner !== botId && now() - since > DRIVE_GRACE_MS) sp.driving.delete(botId);
    deliver(sp);
    if (sp.commands.length || sp.tasks || watchOf(sp) !== sp.sentWatch) return Promise.resolve(answer(sp));
    return new Promise(resolve => {
      const timer = setTimeout(() => deliver(sp), hub.waitMs);
      sp.parked = {resolve, timer};
    });
  }

  /** The newest frame of the watched tab. Anything else is dropped. */
  function putFrame(workspaceId, agentId, {botId, image, w, h} = {}) {
    const sp = space(workspaceId);
    if (typeof image !== 'string' || !image) fail('A frame needs an image.', 400);
    if (image.length > MAX_IMAGE) fail('That frame is too large.', 413);
    if (!BASE64.test(image)) fail('A frame must be base64.', 400);
    const watch = watchOf(sp);
    if (watch && botId === watch) sp.frame = {botId, image, w: Number(w) || 1280, h: Number(h) || 800, at: now(), seq: ++sp.seq};
    return {watch: watchOf(sp)};
  }

  /** The owner's page asks for a bot's frame. Asking is what makes the device cast it. */
  function view(workspaceId, botId, {after} = {}) {
    const sp = space(workspaceId);
    sp.viewers.set(botId, now());
    if (watchOf(sp) !== sp.sentWatch) wake(sp);
    const frame = sp.frame?.botId === botId ? sp.frame : null;
    const out = {botId, agent: alive(sp), seq: frame ? frame.seq : 0, changed: Boolean(frame) && frame.seq !== Number(after)};
    if (frame) Object.assign(out, {w: frame.w, h: frame.h, at: frame.at});
    const notice = sp.notices.get(botId);
    if (notice && !sp.driving.has(botId)) out.notice = notice;
    if (out.changed) out.image = `data:image/jpeg;base64,${frame.image}`;
    return out;
  }

  const command = (sp, entry) => {
    if (sp.commands.length >= MAX_QUEUED) fail('Too much input is waiting for the browser. Try again in a moment.', 429);
    sp.commands.push(entry);
    wake(sp);
  };

  function takeover(workspaceId, botId) {
    const sp = space(workspaceId);
    if (!alive(sp)) fail('The local agent is not running the shared browser right now, so there is nothing to take over. Start it with AGENT_BROWSER=1 and try again.', 409);
    sp.notices.delete(botId);
    sp.driving.set(botId, now());
    command(sp, {type: 'takeover', botId});
  }
  function handback(workspaceId, botId) {
    const sp = space(workspaceId);
    sp.driving.delete(botId);
    sp.commands.push({type: 'handback', botId});
    wake(sp);
  }
  function input(workspaceId, botId, event) {
    const sp = space(workspaceId);
    if (!sp.driving.has(botId)) fail('Take over the browser before you click or type in it.', 409);
    command(sp, {type: 'input', botId, event: cleanInput(event)});
  }

  /** A task was queued for this workspace's device: answer its parked poll so
   * it heartbeats now instead of at the end of its poll interval. A device that
   * is not on the live line hears it at its next heartbeat, as before. */
  function taskQueued(workspaceId, agentId) {
    const sp = spaces.get(workspaceId);
    if (!sp || (agentId && sp.agentId && sp.agentId !== agentId)) return;
    sp.tasks = true;
    wake(sp);
  }

  return Object.assign(hub, {
    agentSync, putFrame, view, takeover, handback, input, taskQueued,
    isDriving: (workspaceId, botId) => space(workspaceId).driving.has(botId),
    agentLive: workspaceId => alive(space(workspaceId)),
    /** Where the device last said this bot's tab was, while the device is still there. */
    tab: (workspaceId, botId) => { const sp = space(workspaceId); return alive(sp) ? sp.tabs.get(botId) || null : null; },
    /** Release every parked poll and forget everything: shutdown, and tests. */
    close() { for (const sp of spaces.values()) { deliver(sp); sp.frame = null; sp.viewers.clear(); sp.commands.length = 0; sp.driving.clear(); sp.notices.clear(); } spaces.clear(); },
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
  const live = hub.agentLive(ws), seen = new Set(), out = [];
  for (const bot of companyBots(state)) {
    if (seen.has(bot.id)) continue;
    seen.add(bot.id);
    const open = requests.find(r => r.botId === bot.id && r.status === 'dispatched') || null;
    const mode = hub.isDriving(ws, bot.id) ? 'driving' : open ? 'browsing' : 'idle';
    const tab = hub.tab(ws, bot.id);
    const lastDone = requests.filter(r => r.botId === bot.id && r.status === 'done').sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
    const url = tab?.url || (open ? open.url : lastDone?.result?.finalUrl || lastDone?.url) || null;
    const title = tab?.title || (open ? null : lastDone?.result?.title) || null;
    out.push({botId: bot.id, state: mode, url, title, site: mode === 'idle' ? null : hostOf(url) || null, pages: pagesOf(requests, bot.id), runId: open?.runId || null, requestId: open?.id || null, live});
  }
  return out;
}
