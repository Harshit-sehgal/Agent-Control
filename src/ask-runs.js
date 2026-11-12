/** Answering asks: the owner's Decline / Allow / Always allow, and what it sets going.
 *
 * `shared/asks.js` holds the rules (what an answer stores, which run may resume).
 * This module is the server's side of it: it turns an answer into the browser
 * request it was about, and wakes the run that was parked on it
 * (`resumeAfterAsks` in `src/coordination.js`).
 *
 * A run waits on its asks and holds nothing meanwhile. An answer that comes after
 * the run was stopped or deleted is recorded (and an Always allow still stores its
 * grant) but resumes nothing.
 */
import {answerAsk, expireAsks} from '../shared/asks.js';
import {denyBrowserRequest} from '../shared/bot-browser.js';
import {dispatchBrowserRequest, finishBrowserRequest} from './bot-browser.js';
import {resumeAfterAsks} from './coordination.js';

/** Dispatch a request nobody is waiting on a run for (a 1:1 chat). A failure is reported in the chat. */
async function open(store, requestId, {actor, runtime}) {
  try { await dispatchBrowserRequest(store, requestId, {actor, ...(runtime ? {runtime} : {})}); }
  catch (error) {
    const request = store.read().browserRequests.find(r => r.id === requestId);
    if (request) await finishBrowserRequest(store, request, {ok: false, error: error.message});
  }
}

/** Record the owner's answer to one ask, then do what it means. Throws 400 for an answer that is not
 * one (or Always allow for a payment), 404 for an ask that does not exist, 409 for one already answered. */
export async function answerAskFlow(store, askId, answer, {actor = null, runtime, executor, until = null} = {}) {
  const out = await store.update(s => {
    const result = answerAsk(s, askId, answer, undefined, {until});
    const request = (s.browserRequests || []).find(r => r.id === result.ask.requestId) || null;
    // Declined: the page it wanted is never opened.
    if (answer === 'decline' && request?.status === 'pending') denyBrowserRequest(s, request.id);
    return {...result, requestId: request?.status === 'pending' ? request.id : null};
  });
  const ask = store.read().asks.find(a => a.id === askId);
  let resumed = false;
  if (out.resumeRunId) resumed = await resumeAfterAsks(store, out.resumeRunId, {executor, runtime, actor});
  // A conversation with no run to park (a 1:1 chat): the answer itself is the approval.
  else if (!ask.runId && answer !== 'decline' && out.requestId) { await open(store, out.requestId, {actor, runtime}); resumed = true; }
  // `undo`: the rules an Always allow replaced, for the owner's Undo (POST /api/permissions/restore).
  return {ask, resumed, ...(out.undo ? {undo: out.undo} : {})};
}

/** Decline every ask whose 24 hours are up, release the pages it held, and let its run take its
 * closing turn. `now` is for tests. */
export async function expirePendingAsks(store, {now = new Date().toISOString(), executor, runtime} = {}) {
  const out = await store.update(s => {
    const result = expireAsks(s, now);
    for (const ask of result.expired) {
      const request = (s.browserRequests || []).find(r => r.id === ask.requestId);
      if (request?.status === 'pending') denyBrowserRequest(s, request.id);
    }
    return result;
  });
  for (const runId of out.resumeRunIds) await resumeAfterAsks(store, runId, {executor, runtime});
  return out;
}

/** The hourly sweep for one workspace, and one pass at start-up for what lapsed while the server was off.
 * Tracked work, so a restore never runs against a file mid-swap. Returns the stop function. */
export function startAskExpiry(ws, intervalMs = 3600000) {
  let busy = false, stopped = false;
  const run = async () => {
    if (busy || stopped) return;
    busy = true;
    try { await (ws.trackWork ? ws.trackWork(() => expirePendingAsks(ws)) : expirePendingAsks(ws)); }
    catch (e) { if (e?.status !== 503) console.error('Ask expiry error:', e.message); }
    finally { busy = false; }
  };
  void run();
  const timer = setInterval(() => void run(), intervalMs); timer.unref();
  return async () => { stopped = true; clearInterval(timer); if (busy) await new Promise(resolve => setTimeout(resolve, 50)); };
}
