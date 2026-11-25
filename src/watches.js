/** The watch sweep: each minute, read what the last checks brought back, then start the checks that are due.
 *
 * A check is a plain page read sent as the watch's bot, through `dispatchBrowserRequest` (the server's browser or a
 * paired computer, the activity log, the 10-minute device wait), under the watch's own key `watch:<id>`. The bot's
 * per-site rules decide first: a watch never asks (nobody is there to answer), so a site set to Ask each time or Deny
 * stops it and the owner is told how to let it through. The per-site daily limit counts each check, and the kill
 * switch holds watches with the schedules (`dueWatches`).
 *
 * Results are read on the next pass rather than through a hook, so `finishBrowserRequest` only has to keep a watch's
 * page out of every chat and every bot. A finished watch request is removed once read, so watches do not push the
 * bots' own page history out of `browserRequests`. Pure rules: shared/watches.js. */
import {randomUUID} from 'node:crypto';
import {dueWatches, recordCheck, watchRequest, WATCH_EVERY} from '../shared/watches.js';
import {browserNeeds} from '../shared/bot-browser.js';
import {decide} from '../shared/asks.js';
import {siteOf, siteCapLeft, countSitePage} from '../shared/limits.js';
import {addChatMessages} from '../shared/chats.js';
import {cleanText} from '../shared/core.js';
import {dispatchBrowserRequest} from './bot-browser.js';
import {startSweep} from './interval.js';

export const WATCH_SWEEP_MS = 60000;
/** A check that has not come back by now is a failed check, so a lost page never holds its watch. */
export const CHECK_STALE_MS = 20 * 60000;
const FINISHED = ['done', 'failed', 'denied'];

const botOf = (state, id) => (state.groups || []).flatMap(g => g.bots || []).find(b => b.id === id) || null;

/** One pass. Returns what it did, for tests: {read, started}. */
export async function watchPass(ws, {notify = async () => {}, runtime, now = () => Date.now(), makeId = randomUUID} = {}) {
  const at = new Date(now()).toISOString();
  // 1. What came back, or never will.
  const said = await ws.update(s => {
    const out = [];
    for (const watch of s.watches || []) {
      if (!watch.requestId) continue;
      const request = (s.browserRequests || []).find(r => r.id === watch.requestId);
      const stale = !request || (!FINISHED.includes(request.status) && Date.parse(at) - Date.parse(request.createdAt) > CHECK_STALE_MS);
      if (!stale && !FINISHED.includes(request.status)) continue;
      const outcome = request?.status === 'done'
        ? {ok: true, text: request.result?.page || request.result?.text || ''}
        : {ok: false, error: request?.error || (request?.status === 'denied' ? 'The check was stopped.' : 'The check did not finish.')};
      const {notice, line} = recordCheck(s, watch.id, outcome, {now: at});
      if (request) s.browserRequests = s.browserRequests.filter(r => r.id !== request.id);
      if (line) try { addChatMessages(s, watch.botId, [{role: 'system', kind: 'watch', text: line}], {trusted: true, now: at, makeId}); } catch { /* The bot's chat is gone. */ }
      if (notice) out.push({...notice, watch});
    }
    return out;
  });
  for (const {title, body, watch} of said) {
    await notify({title, body, kind: 'watch', urgent: false, meta: {watchId: watch.id, url: watch.url}});
  }
  // 2. The checks that are due.
  const started = await ws.update(s => {
    const ids = [], blocked = [];
    for (const watch of dueWatches(s, Date.parse(at))) {
      const bot = botOf(s, watch.botId);
      const request = watchRequest(s, watch, {now: at, makeId});
      const site = siteOf(watch.url);
      const decision = bot ? decide(s, bot, browserNeeds(request), {}) : {verdict: 'deny', message: 'Its bot was removed.'};
      if (decision.verdict !== 'allow') {
        const error = decision.verdict === 'deny'
          ? cleanText(decision.message, 300) || `${bot?.name || 'Its bot'} may not open ${site}.`
          : `${bot.name} needs your OK to open ${site}, and a watch cannot ask. On ${bot.name}'s profile, set ${site} to Always allow, or switch Browse and read without asking back on.`;
        const {notice, line} = recordCheck(s, watch.id, {ok: false, error, blocked: true}, {now: at});
        if (line) try { addChatMessages(s, watch.botId, [{role: 'system', kind: 'watch', text: line}], {trusted: true, now: at, makeId}); } catch { /* The bot's chat is gone. */ }
        if (notice) blocked.push({...notice, watch});
        continue;
      }
      // The owner's per-site daily limit: past it, this check waits for its next turn, and is not a failure.
      if (siteCapLeft(s, site, at) <= 0) {
        watch.nextAt = new Date(Date.parse(at) + (WATCH_EVERY.find(e => e.id === watch.every)?.ms || 3600000)).toISOString();
        continue;
      }
      countSitePage(s, site, at);
      s.browserRequests ??= [];
      s.browserRequests.unshift(request);
      watch.requestId = request.id;
      ids.push(request.id);
    }
    return {ids, blocked};
  });
  for (const {title, body, watch} of started.blocked) {
    await notify({title, body, kind: 'watch', urgent: false, meta: {watchId: watch.id, url: watch.url}});
  }
  for (const id of started.ids) {
    try { await dispatchBrowserRequest(ws, id, {actor: 'watch', ...(runtime ? {runtime} : {})}); }
    catch (error) {
      // No browser and no computer: the check failed now, and the next pass records it on the watch.
      await ws.update(s => {
        const r = (s.browserRequests || []).find(x => x.id === id);
        if (r && r.status === 'pending') { r.status = 'failed'; r.error = cleanText(error.message, 300); r.updatedAt = at; }
      });
    }
  }
  return {read: said.length, started: started.ids.length};
}

/** Check one watch now: it becomes due, and the sweep's next pass (within a minute) starts it. */
export function checkNow(state, id, now = new Date().toISOString()) {
  const watch = (state.watches || []).find(w => w.id === id);
  if (!watch) return null;
  if (!watch.requestId) { watch.nextAt = now; watch.on = true; }
  return watch;
}

/** The workspace's watch sweep. Returns stop. */
export function startWatches(ws, {notify, runtime, intervalMs = WATCH_SWEEP_MS} = {}) {
  return startSweep('Watches', () => watchPass(ws, {notify, runtime}), {intervalMs, ws});
}
