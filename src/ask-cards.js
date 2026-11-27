/** How an ask reaches the owner: a card in the conversation the bot works in, a
 * "Needs you" line in the primary's chat, and a push notification.
 *
 * Server only. The Pages demo has no bot that can ask. Kept apart from
 * `src/ask-runs.js` (the answer flow) so the run loop can write a card without
 * importing the module that resumes runs.
 */
import {addChatMessages} from '../shared/chats.js';
import {primaryOf} from '../shared/company.js';
import {askText} from '../shared/asks.js';

export const askLineId = ask => `ask-${ask.id}`.slice(0, 64);

/** Write the ask's card into its own chat and, if that is not the primary's chat, a "Needs you" line
 * into the primary's. Both carry `askId`; the card reads the ask's status from `state.asks`, so
 * answering never rewrites a line. A chat that is gone is skipped: the ask still shows in Needs you. */
// The ask is made while the reply is read, a moment before that reply is stamped, and the chat is read in
// time order: the card takes the later of the two so it sits under the reply that asked.
const postedAt = made => new Date(Math.max(Date.parse(made) || 0, Date.now())).toISOString();

/** One ask's line in a conversation: the same card in every chat that shows it, keyed by the ask's id. `runId` is the
 * run that waits on it in that chat, or none. */
const askLine = (ask, text, runId) => ({id: askLineId(ask), role: 'system', kind: 'ask', askId: ask.id, ...(runId ? {runId} : {}), at: postedAt(ask.createdAt), text});

export function addAskCards(state, ask, bot) {
  const name = bot?.name || 'A bot';
  const text = askText(ask, name);
  const targets = [];
  if (ask.chatKey) targets.push([ask.chatKey, text]);
  const primary = primaryOf(state);
  if (primary && primary.id !== ask.chatKey) targets.push([primary.id, `Needs you: ${text}`]);
  for (const [key, line] of targets) {
    try { addChatMessages(state, key, [askLine(ask, line, ask.runId)], {trusted: true}); } catch { /* That conversation is gone. */ }
  }
}

/** Push a notification for each new ask, through the workspace's notifier (`store.notify`, set when
 * the workspace starts). Fire and forget: a notifier that is missing or fails never fails a run. */
export function notifyAsks(store, asks, botName = 'A bot') {
  for (const ask of asks || []) {
    Promise.resolve()
      .then(() => store.notify?.({title: `${botName} needs you`, body: askText(ask, botName), kind: 'ask', meta: {askId: ask.id, runId: ask.runId || null}}))
      .catch(error => console.error('Ask notification:', error.message));
  }
}

/** Put an existing ask's card into one more conversation, only when that conversation lacks it. A sign-in card is one
 * per account, so a second run that meets the same wall gets its own line for the card that is already open and never
 * a second card. The line keeps the ask's id, so answering the card settles every copy, and it names `runId`, the run
 * waiting on the card in this chat (none for a request with no run). Returns whether it was added. */
export function addAskLine(state, key, ask, bot, runId = null) {
  if (!key || (state.chats?.[key] || []).some(m => m.id === askLineId(ask))) return false;
  const text = askText(ask, bot?.name || 'A bot');
  try { addChatMessages(state, key, [askLine(ask, primaryOf(state)?.id === key ? `Needs you: ${text}` : text, runId)], {trusted: true}); return true; } catch { return false; /* That conversation is gone. */ }
}

/** Where tapping a sign-in notice opens: the bot's chat, or `#chat/team-<groupId>`, which the app resolves to the
 * thread, or to the lead's chat for any other team chat (a schedule's, the primary group's). */
export const signinRoute = chatKey => (String(chatKey || '').startsWith('team-') ? `#chat/${chatKey}` : `#bot/${chatKey}`);

/** Push the one notice for a new sign-in card. Quiet (never urgent): the owner signs in when they next pick up the
 * phone. Fire and forget, like `notifyAsks`. */
export function notifySignin(store, ask, botName = 'A bot') {
  Promise.resolve()
    .then(() => store.notify?.({
      title: `Sign in to ${ask.site}`,
      body: `${askText(ask, botName)} Open the card and tap Take control; the task carries on by itself.`,
      kind: 'signin', urgent: false, ...(ask.chatKey ? {route: signinRoute(ask.chatKey)} : {}),
      meta: {askId: ask.id, accountId: ask.accountId},
    }))
    .catch(error => console.error('Sign-in notification:', error.message));
}
