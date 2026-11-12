/** Turn a bot's ```setup blocks into cards in the chat.
 *
 * A card carries the change the bot proposed (see shared/setup.js) and one button. Nothing is applied here:
 * the owner's tap calls the ordinary settings route with the owner's session. A block that cannot be
 * carried out becomes a plain line saying why, so the owner is never left guessing. */
import {randomUUID} from 'node:crypto';
import {parseSetupRequests, stripSetupBlocks, resolveSetup, setupDone} from '../shared/setup.js';

const stamp = () => new Date().toISOString();

/** Read one reply. Returns the reply without its blocks and the chat lines to add. */
export function setupCardsFromReply(store, {bot, output, makeId = randomUUID, now = stamp}) {
  const found = parseSetupRequests(output);
  if (!found.length) return {text: String(output ?? ''), lines: []};
  const state = store.read();
  // A card already offered in the last ten minutes is not offered again: the owner has one button for it.
  const since = Date.now() - 10 * 60000;
  const offered = new Set(Object.values(state.chats || {}).flat().filter(m => m?.kind === 'setup' && m.setup && Date.parse(m.at || 0) >= since).map(m => m.setup));
  const lines = found.map(item => {
    let out = item.ok ? resolveSetup(state, item.request, {speaker: bot}) : item;
    // A change that is already in place gets no button: the bot hears so and tells the owner.
    if (out.ok && setupDone(state, out.card)) out = {ok: false, error: `that is already so (${out.card.text}), so there is nothing to change.`};
    if (out.ok && offered.has(JSON.stringify(out.card))) return null;
    if (out.ok) offered.add(JSON.stringify(out.card));
    return out.ok
      ? {id: makeId(), role: 'system', kind: 'setup', botId: bot.id, setup: JSON.stringify(out.card), text: `${bot.name} suggests: ${out.card.text}`, at: now()}
      : {id: makeId(), role: 'system', kind: 'setup', botId: bot.id, text: `${bot.name} could not set that up: ${out.error}`, at: now()};
  }).filter(Boolean);
  return {text: stripSetupBlocks(output) || `${bot.name} suggested a change.`, lines};
}
