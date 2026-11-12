/** Threads: a new chat every time, always run by the primary bot.
 *
 * A thread is a group record with `settings.kind = 'thread'` and no bots of its
 * own. The primary bot answers in it, and the bots it hands work to take part as
 * guests; they are listed in `settings.members`, never moved into the record. A
 * thread never opens or reuses a bot's own chat.
 *
 * Pure and browser-safe: the server and the Pages engine share these rules.
 */
import {primaryOf} from './company.js?v=397178f961';

export const isThread = group => group?.settings?.kind === 'thread';

// Politeness and framing before the ask, which a title does without.
const LEAD_IN = /^(?:(?:hey|hi|hello|ok(?:ay)?|so|atlas)\b[,!.]?\s*)*(?:(?:please|pls|kindly)\s+|(?:can|could|would|will)\s+you\s+(?:please\s+)?|i\s+(?:want|need|would\s+like)\s+(?:you\s+)?to\s+|help\s+me\s+(?:to\s+)?|let'?s\s+)*/i;
const DANGLING = /^(?:a|an|the|to|for|in|on|of|at|by|with|from|about|that|which|who|posted|and|or|my|your)$/i;
// "Make a writer bot and have it draft ...": making the bot is the setup, the job is what it is then asked to do.
const HIRE_THEN = /^(?:make|create|build|set\s+up|hire|add)\s+(?:me\s+)?(?:a|an|the|one)?\s*[\w\s'-]{0,40}?\b(?:bot|agent|assistant)\b[\s,]*(?:and\s+|then\s+|and\s+then\s+)*(?:have|ask|get|tell|let)\s+(?:it|him|her|them)\s+(?:to\s+)?(?=\w)/i;
const QUESTION = /^(?:what|whats|what's)\s+(?:is|are)\s+(?:the\s+)?/i;

/** A short name for the first message, the way a chat app names a chat: the ask without the politeness around
 * it, cut before a second clause, at most six words and 40 characters (a single long word is cut hard). */
export function titleFrom(text) {
  let line = String(text ?? '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || '';
  const bare = line.replace(/[?!.]+$/, '').trim(), ask = bare.replace(LEAD_IN, '').replace(QUESTION, '').trim();
  // "Hello there" is the whole message: keep it rather than a title of one word.
  line = ask.split(/\s+/).length >= 2 ? ask : bare;
  const job = line.replace(HIRE_THEN, '');
  if (job !== line && job.split(/\s+/).length >= 2) line = job;
  // Before the second clause: "find a hotel" after "and", or what follows a comma.
  const clause = line.split(/\s*,\s*|\s+and\s+(?=\w)|;\s*/)[0];
  if (clause.split(/\s+/).length >= 2) line = clause;
  let words = line.split(/\s+/).filter(Boolean).slice(0, 6), out = words.join(' ');
  while (out.length > 40 && words.length > 1) { words = words.slice(0, -1); out = words.join(' '); }
  // A title does not end on a word that leads into what was cut ("posted", "with", "the").
  while (words.length > 2 && DANGLING.test(words.at(-1))) { words = words.slice(0, -1); out = words.join(' '); }
  out = out.slice(0, 40).trim();
  return out ? out[0].toUpperCase() + out.slice(1) : '';
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
