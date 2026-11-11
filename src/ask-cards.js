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
export function addAskCards(state, ask, bot) {
  const name = bot?.name || 'A bot';
  const text = askText(ask, name);
  const card = {id: askLineId(ask), role: 'system', kind: 'ask', askId: ask.id, ...(ask.runId ? {runId: ask.runId} : {}), at: ask.createdAt};
  const targets = [];
  if (ask.chatKey) targets.push([ask.chatKey, text]);
  const primary = primaryOf(state);
  if (primary && primary.id !== ask.chatKey) targets.push([primary.id, `Needs you: ${text}`]);
  for (const [key, line] of targets) {
    try { addChatMessages(state, key, [{...card, text: line}], {trusted: true}); } catch { /* That conversation is gone. */ }
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
