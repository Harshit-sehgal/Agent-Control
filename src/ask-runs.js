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
import {startSweep} from './interval.js';
import {answerAsk, expireAsks, isSigninAsk, openSigninAsk} from '../shared/asks.js';
import {denyBrowserRequest} from '../shared/bot-browser.js';
import {dispatchBrowserRequest, finishBrowserRequest} from './bot-browser.js';
import {resumeAfterAsks} from './coordination.js';
import {releaseSignin} from './signin-wait.js';
import {fail} from './http.js';

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
  // A sign-in card is closed by Not now here, or by a hand back (`finishSignin`); Allow and Always allow fall through to
  // `answerAsk`, which refuses them.
  if (answer === 'decline' && isSigninAsk(store.read().asks.find(a => a.id === askId))) {
    const {ask, resumed} = await answerSigninFlow(store, askId, {signedIn: false, actor, runtime, executor});
    return {ask, resumed: resumed > 0};
  }
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

/** Do what a released sign-in card means: resume each run that waited on it (it goes on only when nothing else holds
 * it), and send each request with no run out again. Returns how many went on. One that fails is logged and the rest
 * still go on, so a store error on one run never leaves the others parked on a card that is already answered. */
async function carryOn(store, {runIds, openIds}, {actor, runtime, executor}) {
  let resumed = 0;
  for (const runId of runIds) {
    try { if (await resumeAfterAsks(store, runId, {executor, runtime, actor})) resumed++; }
    catch (error) { console.error('Sign-in release:', `run ${runId}:`, error?.message ?? error); }
  }
  for (const id of openIds) {
    try { await open(store, id, {actor, runtime}); resumed++; }
    catch (error) { console.error('Sign-in release:', `request ${id}:`, error?.message ?? error); }
  }
  return resumed;
}

/** The owner's answer to a sign-in card: signed in (the hand back) or Not now. One write answers the card and readies or
 * denies every page held on it; then each run goes on and each chat's page is sent again. Throws 404 for no such card,
 * 409 for one already answered. `resumed` counts the runs and pages that went on. */
export async function answerSigninFlow(store, askId, {signedIn = false, actor = null, runtime, executor} = {}) {
  const out = await store.update(s => {
    const found = (s.asks || []).find(a => a.id === askId);
    if (!isSigninAsk(found)) fail('Ask not found.', 404);
    if (found.status !== 'pending') fail('This ask was already answered.', 409);
    return releaseSignin(s, askId, {signedIn});
  });
  const resumed = await carryOn(store, out, {actor, runtime, executor});
  return {ask: store.read().asks.find(a => a.id === askId), resumed};
}

/** The account's hand back: its open card (if any) is answered as signed in. Null when the account has none. */
export async function finishSignin(store, accountId, opts = {}) {
  const pending = store.read().signinPending?.[accountId];
  if (!pending) return null;
  const out = await store.update(s => { const card = openSigninAsk(s, accountId); return card ? releaseSignin(s, card.id, {signedIn: true}) : null; });
  if (!out) return null;
  const resumed = await carryOn(store, out, {actor: opts.actor ?? null, runtime: opts.runtime, executor: opts.executor});
  return {ask: store.read().asks.find(a => a.id === out.ask.id), resumed};
}

/** Decline every ask whose 24 hours are up, release the pages it held, and let its run take its
 * closing turn. `now` is for tests. */
export async function expirePendingAsks(store, {now = new Date().toISOString(), executor, runtime} = {}) {
  const out = await store.update(s => {
    const result = expireAsks(s, now);
    const lapsed = [];
    for (const ask of result.expired) {
      if (isSigninAsk(ask)) { lapsed.push(releaseSignin(s, ask.id, {signedIn: false, now})); continue; }
      const request = (s.browserRequests || []).find(r => r.id === ask.requestId);
      if (request?.status === 'pending') denyBrowserRequest(s, request.id);
    }
    // A sign-in card is shared by every run that met the wall, not only the run that made it.
    return {...result, resumeRunIds: [...new Set([...result.resumeRunIds, ...lapsed.flatMap(l => l.runIds)])]};
  });
  for (const runId of out.resumeRunIds) await resumeAfterAsks(store, runId, {executor, runtime});
  return out;
}

/** The hourly sweep for one workspace, and one pass at start-up for what lapsed while the server was off.
 * Tracked work, so a restore never runs against a file mid-swap. Returns the stop function. */
export function startAskExpiry(ws, intervalMs = 3600000) {
  return startSweep('Ask expiry', () => expirePendingAsks(ws), {intervalMs, ws});
}
