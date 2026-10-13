/** AI providers and model selection (bring your own key).
 *
 * Admin surfaces manage providers and the workspace default; a member may set
 * the model for a bot they can already edit. Keys are never returned — only
 * provider metadata and the model list a provider reports.
 */
import {reply} from './router.js';
import {listProviders, addProvider, deleteProvider, setDefaults, setBotModel, modelsForProvider} from './ai-providers.js';

export function aiRoutes(router) {
  router.add('GET', '/api/ai', 'viewer', c => listProviders(c.store.read()));
  router.add('POST', '/api/ai/providers', 'admin', async c => {
    const b = await c.body();
    return reply(201, addProvider(c.store, c.actor.workspaceId, {...b, createdBy: c.actor.email}));
  });
  router.add('DELETE', '/api/ai/providers/:id', 'admin', c => deleteProvider(c.store, c.actor.workspaceId, c.params.id));
  // Fetch the provider's own model list so the picker reflects reality.
  router.add('POST', '/api/ai/providers/:id/models', 'admin', async c => ({models: await modelsForProvider(c.store, c.params.id)}));
  router.add('PATCH', '/api/ai', 'admin', async c => setDefaults(c.store, await c.body()));
  router.add('PATCH', '/api/ai/bots/:bot', 'member', async c => setBotModel(c.store, c.params.bot, await c.body()));
}
