/** A page that comes back as its account's sign-in wall is held, not handed to the bot: the owner signs the account in
 * from the phone (Take control, sign in, Hand back) and the page is asked for again. This is the server's side of
 * that: the rule that decides a page is held, the one card per account the run parks on, and the card a keeper makes
 * when an account signs out with nothing waiting.
 *
 * Server only. It imports `shared/` and `ask-cards.js` and nothing else, so `bot-browser.js` can use it without a cycle.
 * The state functions are pure over the workspace state; `noticeSignins` is the one that writes a store. */
import {randomUUID} from 'node:crypto';
import {accountWall, browserAccountOf} from '../shared/browser-accounts.js';
import {createSigninAsk, openSigninAsk, isSigninAsk} from '../shared/asks.js';
import {botSettings} from '../shared/bot-settings.js';
import {addAskCards, addAskLine, notifySignin} from './ask-cards.js';

/** How many times one page may be held. The third wall is a page like any other: the bot is told the owner is not signed in. */
export const MAX_SIGNIN_HOLDS = 2;

/** The run statuses that may park on a sign-in: waiting on its page, or already parked on an ask. */
const PARKABLE = ['awaiting_browser', 'awaiting_ask'];
const stamp = () => new Date().toISOString();

/** Hold a request whose page is its account's sign-in wall. Changes nothing and answers null when it is not held:
 * a watch, a takeover, a bot with no account (or one the page did not run as), a page that is not that account's
 * wall, a request already held `MAX_SIGNIN_HOLDS` times, or a request whose run is not waiting on a page.
 * Otherwise the request becomes `signin`, its run (if any) parks on the account's card, and the card is posted:
 * the account's open card is reused (its line added to this request's chat), else one is made. `fresh` says a card
 * was made, so the caller pushes it once. */
export function holdForSignin(state, request, result, {now = stamp(), makeId = randomUUID} = {}) {
  if (!request || request.watchId || !result || typeof result !== 'object' || result.tookOver === true) return null;
  // Only a page a computer was sent for is held, never one waiting for approval or already held.
  if (request.status !== 'dispatched') return null;
  const holds = Number(request.signinHolds) || 0;
  if (holds >= MAX_SIGNIN_HOLDS) return null;
  const {account} = browserAccountOf(state, request.botId);
  if (!account?.site || request.account !== account.id || !accountWall(account.site, request.url, result)) return null;
  const run = request.runId ? (state.groupRuns || []).find(r => r.id === request.runId) : null;
  if (request.runId && !(run && PARKABLE.includes(run.status))) return null;

  const bot = {name: request.botName};
  let ask = openSigninAsk(state, account.id), fresh = false;
  if (ask) addAskLine(state, request.chatKey, ask, bot, request.runId);
  else {
    ask = createSigninAsk(state, {botId: request.botId, runId: request.runId ?? null, chatKey: request.chatKey ?? null, account, now, makeId});
    addAskCards(state, ask, bot);
    fresh = true;
  }
  request.status = 'signin'; request.signinAskId = ask.id; request.signinHolds = holds + 1; request.updatedAt = now;
  if (run) { run.status = 'awaiting_ask'; run.askIds = [...new Set([...(run.askIds || []), ask.id])]; }
  return {ask, fresh};
}

/** The owner's answer to a sign-in card, applied to everything that waited on it: the ask is answered (signed in:
 * `allowed`, once; not now: `declined`), the account is free for a new card, and every request held on it is made
 * ready to go out again (`pending`) or denied. An ask that already lapsed keeps its own `declined`, `expired` and
 * time. A page sent again is a new task: it loses the old task ids (so a late result for the first one matches
 * nothing, and a failed re-dispatch may put it back to `pending`) and the claim of its first dispatch, as the revert in
 * `dispatchBrowserRequest` does; it keeps `signinHolds`, which makes the new task's idempotency key.
 *
 * Returns null for an ask that is not a sign-in card. `runIds` are the runs parked on the card (the caller resumes each
 * with `resumeAfterAsks`, which also waits for any other ask or page that run has open). `openIds` are the requests
 * with no run, made ready, for the caller to send. A held request whose run is no longer parked on the card (stopped,
 * deleted) is denied either way, so nothing is sent for a run nobody waits on. */
export function releaseSignin(state, askId, {signedIn = false, now = stamp()} = {}) {
  const ask = (state.asks || []).find(a => a.id === askId);
  if (!ask || !isSigninAsk(ask)) return null;
  if (ask.status === 'pending') {
    Object.assign(ask, signedIn ? {status: 'allowed', scope: 'once'} : {status: 'declined', scope: null}, {answeredAt: now});
    delete ask.expiresAt;
  }
  if (state.signinPending?.[ask.accountId] === ask.id) delete state.signinPending[ask.accountId];
  const runIds = (state.groupRuns || []).filter(r => r.status === 'awaiting_ask' && (r.askIds || []).includes(ask.id)).map(r => r.id);
  const openIds = [];
  for (const request of state.browserRequests || []) {
    if (request.status !== 'signin' || request.signinAskId !== ask.id) continue;
    request.updatedAt = now;
    if (!signedIn || (request.runId && !runIds.includes(request.runId))) { request.status = 'denied'; continue; }
    request.status = 'pending'; request.agentTaskIds = [];
    for (const key of ['notAfter', 'approvedBy', 'via', 'account', 'accountName']) delete request[key];
    if (!request.runId) openIds.push(request.id);
  }
  return {ask, runIds, openIds};
}

/** A card for an account that signed out while no run was waiting on it (the account's keeper saw it). Null when
 * the account has no record, already has an open card, or no bot signs in as it; otherwise the new card (in the
 * bot's own chat) and that bot. */
export function signinFromKeeper(state, accountId, {now = stamp(), makeId = randomUUID} = {}) {
  const account = (state.browserAccounts || []).find(a => a.id === accountId);
  if (!account || openSigninAsk(state, accountId)) return null;
  const bot = (state.groups || []).flatMap(g => g.bots || []).find(b => botSettings(b).browserAccount === accountId);
  if (!bot) return null;
  const ask = createSigninAsk(state, {botId: bot.id, runId: null, chatKey: bot.id, account, now, makeId});
  addAskCards(state, ask, bot);
  return {ask, bot};
}

/** Make the keeper's card for each account, in one write, and push each card made. Returns how many were made. */
export async function noticeSignins(store, accountIds) {
  const made = await store.update(s => [...new Set(accountIds || [])].map(id => signinFromKeeper(s, id)).filter(Boolean));
  for (const {ask, bot} of made) notifySignin(store, ask, bot.name);
  return made.length;
}
