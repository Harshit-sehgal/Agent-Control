/** Threads: a new chat every time, always run by the primary bot.
 *
 * A thread is a group record with `settings.kind = 'thread'` and no bots of its
 * own. The primary bot answers in it, and the bots it hands work to take part as
 * guests; they are listed in `settings.members`, never moved into the record. A
 * thread never opens or reuses a bot's own chat.
 *
 * Pure and browser-safe: the server and the Pages engine share these rules.
 */
import {primaryOf} from './company.js?v=8bbac178a9';

export const isThread = group => group?.settings?.kind === 'thread';

/** The first line of a message as a title: at most 60 characters, cut at a word
 * boundary (a single long word is cut hard). */
export function titleFrom(text) {
  const line = String(text ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60), space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut).trim();
}

export function createThread(state, {title = '', now = new Date().toISOString(), makeId = () => crypto.randomUUID()} = {}) {
  return {
    id: `th-${makeId()}`, name: title || 'New thread', description: '', createdAt: now,
    settings: {kind: 'thread', ownerId: primaryOf(state)?.id ?? null, members: []},
    bots: [],
  };
}

/** Record that a bot took part in the thread. Once per bot. */
export function noteMember(group, botId) {
  const members = group.settings.members ??= [];
  if (botId && !members.includes(botId)) members.push(botId);
}

const lastActive = (state, g) => {
  const at = (state.chats?.[`team-${g.id}`] || []).at(-1)?.at;
  return Date.parse(at) || Date.parse(g.createdAt) || 0;
};

/** Every thread, newest activity first. */
export function threadsOf(state) {
  return (state?.groups || []).filter(isThread).sort((a, b) => lastActive(state, b) - lastActive(state, a));
}
