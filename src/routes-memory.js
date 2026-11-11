/** Durable memory over HTTP: inspect, edit and forget what a bot keeps.
 *
 * Memory belongs to the workspace, like chats: every member's device reads the
 * same recap and rulebook. Each bot has its own rulebook and every bot reads the
 * one company notebook (`bot: "company"`); a member may add, correct or delete a
 * line in either, and only the engine writes rules automatically. A route names
 * the book with `bot` (a bot id, or `company`) or, for an older client, with
 * `model` (a book key). Consolidation spends one model call, so it is an explicit
 * action here and a background pass during runs.
 */
import {cleanText} from '../shared/core.js';
import {addRules, editRule, bookKeyOfRule, findRulebook, forgetChat, forgetRulebook, modelKey, botKey, COMPANY_KEY, publicMemory, removeRule} from '../shared/memory.js';
import {consolidateModel} from './memory.js';
import {resolveConfig} from './ai-providers.js';
import {fail} from './http.js';
import {reply} from './router.js';

const query = c => { try { return new URL(c.req.url, 'http://local').searchParams; } catch { return new URLSearchParams(); } };

/** The book a request names: `bot` (an id, or `company`) or, for an older client,
 * `model` (a book key), from the query or the body. Null when it names none. */
const bookOf = (c, body = {}) => {
  const bot = cleanText(query(c).get('bot') || body?.bot, 80), model = cleanText(query(c).get('model') || body?.model, 200);
  return bot ? (bot === COMPANY_KEY ? COMPANY_KEY : botKey(bot)) : model || null;
};

export function memoryRoutes(router) {
  router.add('GET', '/api/memory', 'viewer', c => {
    const bot = cleanText(query(c).get('bot'), 80);
    return publicMemory(c.store.read(), {bot: bot && bot !== COMPANY_KEY ? bot : null});
  });

  router.add('POST', '/api/memory/rules', 'member', async c => {
    const b = await c.body();
    const model = bookOf(c, b);
    if (!model) fail('Which bot should keep this rule?', 400);
    const text = cleanText(b.text, 240);
    if (text.length < 4) fail('A rule needs at least 4 characters.', 400);
    // Only the engine labels a rule as learned. A member adding one by hand is
    // the user's rule, whatever the request body claims.
    const result = await c.store.update(s => addRules(s, model, [text], {source: 'user', label: cleanText(b.label, 160)}));
    return reply(201, {ok: true, model, rules: result.book.rules.map(rule => ({id: rule.id, text: rule.text, source: rule.source}))});
  });

  // Change one line's text. Its book is the one named, else the one that holds it.
  router.add('PATCH', '/api/memory/rules/:id', 'member', async c => {
    const b = await c.body();
    const text = cleanText(b.text, 240);
    if (text.length < 4) fail('A rule needs at least 4 characters.', 400);
    const rule = await c.store.update(s => editRule(s, bookOf(c, b) || bookKeyOfRule(s, c.params.id) || fail('Rule not found.', 404), c.params.id, text));
    if (!rule) fail('That bot already keeps that line.', 409);
    return {ok: true, rule: {id: rule.id, text: rule.text, source: rule.source}};
  });

  router.add('DELETE', '/api/memory/rules/:id', 'member', async c => {
    const result = await c.store.update(s => {
      const model = bookOf(c) || bookKeyOfRule(s, c.params.id);
      if (!model) fail('Rule not found.', 404);
      // `rulebook()` would create the book it is asked to look for, and indexing
      // the map directly can read an inherited property.
      const book = findRulebook(s, model);
      if (!book || !(book.rules || []).some(rule => rule.id === c.params.id)) fail('Rule not found.', 404);
      return removeRule(s, model, c.params.id);
    });
    return result;
  });

  router.add('POST', '/api/memory/forget', 'member', async c => {
    const b = await c.body();
    const model = bookOf(c, b), chat = cleanText(b.chat, 120);
    if (!model && !chat) fail('Say which bot\'s rulebook or which conversation to forget.', 400);
    return c.store.update(s => {
      if (model) forgetRulebook(s, model);
      if (chat) forgetChat(s, chat);
      return {ok: true, model: model || null, chat: chat || null};
    });
  });

  // One explicit consolidation pass. The client may pass the bot whose model
  // should be updated; the book is still keyed by provider + model.
  router.add('POST', '/api/memory/consolidate', 'member', async c => {
    const b = await c.body();
    const config = resolveConfig(c.store, cleanText(b.botId, 80) || null);
    if (!config) fail('No AI provider is configured. Add one under You → AI and models.', 422);
    // A bot's own book when a bot is named; the model's book for an older client.
    const botId = cleanText(b.botId, 80);
    const key = botId ? botKey(botId) : modelKey(config);
    const chat = cleanText(b.chat, 120) || botId;
    const result = await consolidateModel(c.store, {key, config, chatKey: chat});
    const book = result.book;
    return reply(200, {
      ok: true,
      skipped: Boolean(result.skipped),
      ...(result.reason ? {reason: result.reason} : {}),
      model: key,
      label: book.label,
      rules: (book.rules || []).map(rule => ({id: rule.id, text: rule.text, source: rule.source})),
      summary: book.summary || '',
      turns: book.turns || 0,
    });
  });
}
