/** Durable memory for the Node server.
 *
 * Every bot turn gets what the workspace remembers for that bot: its own
 * rulebook and the shared company notebook (shared/memory.js builds the block).
 * Every turn leaves something behind: durable user sentences are noted for the
 * bot's own book, the chat recap is rebuilt from stored messages, and on a
 * cadence one extra model call rewrites both into a compact form.
 *
 * Consolidation is best effort. A provider error must never fail the reply the
 * user is waiting for; the deterministic recap and the pending rules survive.
 */
import {cleanText} from '../shared/core.js';
import {
  modelKey, modelLabel, promptMemory, rulebook, noteTurn, noteChat, botKey, COMPANY_KEY, memoryState,
  consolidationInstructions, consolidationInput, parseConsolidation, mergeConsolidation,
  consolidationDue, findRulebook,
} from '../shared/memory.js';
import {complete} from './ai.js';
import {resolveConfig} from './ai-providers.js';
import {companyBots} from '../shared/company.js';
import {botSettings} from '../shared/bot-settings.js';

/** Consolidation calls already in flight, per store and model key, so two steps
 * of the same run cannot start two rewrites of one book. Keyed by store first:
 * two workspaces that both use `env:gpt-4.1-mini` are separate books, and one
 * must not silence the other's pass. */
const locks = new WeakMap();
function runningFor(store) {
  let set = locks.get(store);
  if (!set) { set = new Set(); locks.set(store, set); }
  return set;
}

/** Merge a conversation from both stores. A group chat is written twice: its
 * run log (`groupMessages`) and the chat record `say()` appends to. */
export function conversationMessages(state, chatKey) {
  const own = state.chats?.[chatKey] || [];
  const group = typeof chatKey === 'string' && chatKey.startsWith('team-') ? state.groupMessages?.[chatKey.slice(5)] || [] : [];
  const byId = new Map();
  for (const message of [...own, ...group]) if (message?.id) byId.set(message.id, message);
  return [...byId.values()].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}

/** The book a bot's turns are noted in: its own, by bot id. (With no bot, the
 * model's, as before bots had their own.) */
const bookFor = (bot, config) => (bot?.id ? {key: botKey(bot.id), label: cleanText(bot.name, 160) || modelLabel(config)} : {key: modelKey(config), label: modelLabel(config)});

/** The memory block for one bot turn, or null when this bot is set to forget.
 * `config` says a provider is there to use; it no longer picks the book. */
export function memoryFor(store, {bot, config, chatKey}) {
  if (!config || (bot && botSettings(bot).memory === false)) return null;
  const state = store.read();
  const {key, label} = bookFor(bot, config);
  const prompt = promptMemory(state, key, chatKey, {label});
  return {...prompt, key, label};
}

/** Record one exchange. Adds durable candidates to this model's book and
 * rebuilds the chat recap from what is stored (plus the user line the client
 * may still be delivering). Returns the book, or null when memory is off. */
export async function rememberTurn(store, {bot, config, chatKey, userText = '', botText = '', now = new Date().toISOString()}) {
  if (!config || !chatKey || (bot && botSettings(bot).memory === false)) return null;
  const {key, label} = bookFor(bot, config);
  return store.update(state => {
    const messages = conversationMessages(state, chatKey);
    const pending = cleanText(userText, 8000);
    const hasUser = pending && messages.some(m => m.role === 'user' && String(m.text || '').trim() === pending.trim());
    const list = hasUser || !pending ? messages : [...messages, {id: `pending-${key}`, role: 'user', text: pending, at: now}];
    const book = noteTurn(state, key, {userText: pending, botText, now, label, chatKey});
    const entry = noteChat(state, chatKey, {now, messages: list});
    return {book, chat: entry};
  });
}

/** Run one consolidation pass for a model. `executor(instructions, input,
 * config)` is injectable for tests; by default it is one provider call. */
export async function consolidateModel(store, {key, config, chatKey = '', label = '', executor = null, now = new Date().toISOString()}) {
  const id = cleanText(key, 200);
  if (!id) throw Object.assign(new Error('Which model should update its rulebook?'), {status: 400});
  if (!config) throw Object.assign(new Error('No AI provider is configured for this model.'), {status: 422});
  const running = runningFor(store);
  if (running.has(id)) return {book: rulebook(store.read(), id), skipped: true};
  running.add(id);
  try {
    const state = store.read();
    const book = rulebook(state, id, {label: label || modelLabel(config)});
    const chatEntry = chatKey ? state.memory?.chats?.[chatKey] : null;
    const messages = chatKey ? conversationMessages(state, chatKey) : [];
    const sentPending = [...(book.pending || [])], sentTurns = Number(book.turns || 0);
    const input = consolidationInput({book, messages, chatSummary: chatEntry?.summary || ''});
    const call = executor || ((instructions, body, cfg) => complete({instructions, input: body, maxTokens: 1600, config: cfg}));
    const raw = await call(consolidationInstructions(), input, config);
    const parsed = parseConsolidation(raw);
    // The model call can take minutes, and the person who started it can press
    // "Forget this model" while it runs. `rulebook()` creates a book that is not
    // there, so every write below would resurrect the thing they just deleted -
    // and stamping `consolidatedAt` would keep them from re-adding it cleanly.
    if (!parsed) {
      // A reply we cannot read still spends the cooldown, otherwise every later
      // step retries the same paid call with no pause at all.
      const stamped = await store.update(current => {
        const book = findRulebook(current, id);
        if (!book) return null;
        book.consolidatedAt = now;
        book.updatedAt = now;
        return book;
      });
      if (!stamped) return {book: null, skipped: true, reason: 'The rulebook was removed while the model was answering.'};
      return {book: stamped, skipped: true, reason: 'The model returned no usable memory update.'};
    }
    const updated = await store.update(current => {
      if (!findRulebook(current, id)) return null;
      return mergeConsolidation(current, id, parsed, {now, label: label || modelLabel(config), chatKey: chatKey || null, sentPending, sentTurns});
    });
    if (!updated) return {book: null, skipped: true, reason: 'The rulebook was removed while the model was answering.'};
    return {book: updated, skipped: false};
  } finally {
    running.delete(id);
  }
}

/** Rewrite the book when enough has happened and the cooldown has passed.
 * Fire-and-forget: the reply already went out, and a failed pass loses nothing
 * because the deterministic recap and pending rules are still stored. */
export async function maybeConsolidate(store, {key, config, chatKey = '', label = '', executor = null, now = Date.now()}) {
  if (!config) return null;
  const run = () => consolidateModel(store, {key, config, chatKey, label, executor, now: new Date(now).toISOString()});
  // This pass writes the book, so it is workspace work like any other. A
  // workspace that is paused for a restore refuses it, and consolidation is
  // best effort: skip quietly rather than surfacing a 503 the user never asked
  // about, or appending to a book that is about to be replaced.
  const tracked = typeof store.trackWork === 'function' ? () => store.trackWork(run) : run;
  try {
    const state = store.read();
    const book = state.memory?.rulebooks?.[cleanText(key, 200)];
    if (!consolidationDue(book, now)) return null;
    const out = await tracked();
    // The caller is fire-and-forget, so the only place "the model answered with
    // nothing I can read" can be seen is here. Without it a provider whose JSON
    // never parses is skipped silently on every pass, forever.
    if (out?.skipped && out.reason) console.warn('Memory consolidation skipped:', out.reason);
    return out;
  } catch (error) {
    if (error?.status !== 503) console.error('Memory consolidation failed:', error.message);
    return null;
  }
}

/** Once, when a workspace first starts after bots got their own memory: copy each
 * model's old rulebook into every bot that runs on that model. The company
 * notebook is created at the same time, and its existence is the mark that this
 * has run, so a bot made later starts empty and a deleted line stays deleted.
 * A bot that already has a book of its own is left alone. */
export async function migrateModelBooks(store) {
  await store.update(state => {
    const memory = memoryState(state);
    if (memory.rulebooks[COMPANY_KEY]) return;
    for (const bot of companyBots(state)) {
      const from = memory.rulebooks[modelKey(resolveConfig(store, bot.id) || {})];
      if (!from || memory.rulebooks[botKey(bot.id)]) continue;
      const copy = structuredClone(from);
      Object.assign(copy, {model: botKey(bot.id), label: bot.name, turns: 0, consolidatedTurns: 0, consolidatedAt: null});
      memory.rulebooks[botKey(bot.id)] = copy;
    }
    rulebook(state, COMPANY_KEY, {label: 'Company notebook'});
  });
}
