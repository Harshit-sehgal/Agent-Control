/** Durable memory over HTTP: inspect, edit and forget what a model keeps.
 *
 * Memory belongs to the workspace, like chats: every member's device reads the
 * same recap and rulebook. A member may correct or delete a rule; only the
 * engine writes rules automatically. Consolidation spends one model call, so it
 * is an explicit action here and a background pass during runs.
 */
import {cleanText} from '../shared/core.js';
import {addRules, findRulebook, forgetChat, forgetRulebook, modelKey, publicMemory, removeRule} from '../shared/memory.js';
import {consolidateModel} from './memory.js';
import {resolveConfig} from './ai-providers.js';
import {fail} from './http.js';
import {reply} from './router.js';

const query = c => { try { return new URL(c.req.url, 'http://local').searchParams; } catch { return new URLSearchParams(); } };

export function memoryRoutes(router) {
  router.add('GET', '/api/memory', 'viewer', c => publicMemory(c.store.read()));

  router.add('POST', '/api/memory/rules', 'member', async c => {
    const b = await c.body();
    const model = cleanText(b.model, 200);
    if (!model) fail('Which model should keep this rule?', 400);
    const text = cleanText(b.text, 240);
    if (text.length < 4) fail('A rule needs at least 4 characters.', 400);
    // Only the engine labels a rule as learned. A member adding one by hand is
    // the user's rule, whatever the request body claims.
    const result = await c.store.update(s => addRules(s, model, [text], {source: 'user', label: cleanText(b.label, 160)}));
    return reply(201, {ok: true, model, rules: result.book.rules.map(rule => ({id: rule.id, text: rule.text, source: rule.source}))});
  });

  router.add('DELETE', '/api/memory/rules/:id', 'member', async c => {
    const model = cleanText(query(c).get('model'), 200);
    if (!model) fail('Which model does this rule belong to?', 400);
    const result = await c.store.update(s => {
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
    const model = cleanText(b.model, 200), chat = cleanText(b.chat, 120);
    if (!model && !chat) fail('Say which rulebook or conversation to forget.', 400);
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
    const key = modelKey(config);
    const chat = cleanText(b.chat, 120) || (cleanText(b.botId, 80) || '');
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
