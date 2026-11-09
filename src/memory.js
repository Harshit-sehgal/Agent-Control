/** Durable memory for the Node server.
 *
 * Every model turn gets what the workspace remembers (shared/memory.js builds
 * the block), and every turn leaves something behind: durable user sentences
 * become rules at once, the chat recap is rebuilt from stored messages, and on
 * a cadence one extra model call rewrites both into a compact form.
 *
 * Consolidation is best effort. A provider error must never fail the reply the
 * user is waiting for; the deterministic recap and the pending rules survive.
 */
import {cleanText} from '../shared/core.js';
import {
  modelKey, modelLabel, promptMemory, rulebook, noteTurn, noteChat,
  consolidationInstructions, consolidationInput, parseConsolidation, mergeConsolidation,
  consolidationDue, publicMemory, addRules, removeRule, forgetRulebook, forgetChat,
} from '../shared/memory.js';
import {complete} from './ai.js';
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

/** The memory block for one bot turn, or null when this bot is set to forget.
 * `config` is resolved by the caller so each bot uses its own model's book. */
export function memoryFor(store, {bot, config, chatKey}) {
  if (!config || (bot && botSettings(bot).memory === false)) return null;
  const state = store.read();
  const key = modelKey(config);
  const prompt = promptMemory(state, key, chatKey, {label: modelLabel(config)});
  return {...prompt, key};
}

/** Record one exchange. Adds durable candidates to this model's book and
 * rebuilds the chat recap from what is stored (plus the user line the client
 * may still be delivering). Returns the book, or null when memory is off. */
export async function rememberTurn(store, {bot, config, chatKey, userText = '', botText = '', now = new Date().toISOString()}) {
  if (!config || !chatKey || (bot && botSettings(bot).memory === false)) return null;
  const key = modelKey(config);
  return store.update(state => {
    const messages = conversationMessages(state, chatKey);
    const pending = cleanText(userText, 8000);
    const hasUser = pending && messages.some(m => m.role === 'user' && String(m.text || '').trim() === pending.trim());
    const list = hasUser || !pending ? messages : [...messages, {id: `pending-${key}`, role: 'user', text: pending, at: now}];
    const book = noteTurn(state, key, {userText: pending, botText, now, label: modelLabel(config), chatKey});
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
    const input = consolidationInput({book, messages, chatSummary: chatEntry?.summary || ''});
    const call = executor || ((instructions, body, cfg) => complete({instructions, input: body, maxTokens: 1600, config: cfg}));
    const raw = await call(consolidationInstructions(), input, config);
    const parsed = parseConsolidation(raw);
    if (!parsed) {
      // A reply we cannot read still spends the cooldown, otherwise every later
      // step retries the same paid call with no pause at all.
      const stamped = await store.update(current => {
        const book = rulebook(current, id, {label: label || modelLabel(config)});
        book.consolidatedAt = now;
        book.updatedAt = now;
        return book;
      });
      return {book: stamped, skipped: true, reason: 'The model returned no usable memory update.'};
    }
    const updated = await store.update(current => mergeConsolidation(current, id, parsed, {now, label: label || modelLabel(config), chatKey: chatKey || null}));
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
    return await tracked();
  } catch (error) {
    if (error?.status !== 503) console.error('Memory consolidation failed:', error.message);
    return null;
  }
}

/** Preference changes made by a person in the UI. */
export function editMemory(store, {model, action, text = '', ruleId = '', chat = ''}) {
  const key = cleanText(model, 200);
  return store.update(state => {
    if (action === 'add') {
      if (!key) throw Object.assign(new Error('Which model should keep this rule?'), {status: 400});
      return addRules(state, key, [text], {source: 'user'}).book;
    }
    if (action === 'remove') return removeRule(state, key, ruleId);
    if (action === 'forget-model') return forgetRulebook(state, key);
    if (action === 'forget-chat') return forgetChat(state, chat);
    return publicMemory(state);
  });
}
