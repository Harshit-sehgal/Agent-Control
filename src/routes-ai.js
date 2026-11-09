/** AI providers and model selection (bring your own key).
 *
 * Admin surfaces manage providers and the workspace default; a member may set
 * the model for a bot they can already edit. Keys are never returned — only
 * provider metadata and the model list a provider reports.
 *
 * Five wire protocols are supported (see shared/ai-presets.js): OpenAI chat
 * completions, OpenAI responses, Anthropic messages, Google Gemini and Azure
 * OpenAI. Saving a provider reads that provider's own catalogue with the pasted
 * key, so the picker shows the models the key can actually use.
 *
 * A provider may also carry custom headers (a gateway's own auth or beta flag,
 * stored encrypted like the key and shown to an admin as names only) and an
 * Azure API version. The test route makes one real call, so an operator can tell
 * a working key from a plausible one without waiting for a drafting failure.
 */
import {reply} from './router.js';
import {listProviderListings, publicAi, addProvider, updateProvider, deleteProvider, setDefaults, setBotModel, modelsForProvider, refreshModels, getProvider, testProvider} from './ai-providers.js';
/** Save a provider, then read its catalogue. A discovery failure is recorded on
 * the provider (and shown in the settings page) instead of losing the save: the
 * key is still stored, and the operator can retry once the endpoint is fixed. */
async function withCatalogue(store,id){await refreshModels(store,id).catch(()=>{});return getProvider(store,id);}

export function aiRoutes(router) {
  // Viewers need provider labels and hosts for bot settings. Keep the configured
  // endpoint path in admin responses only, where a custom URL may itself hold a secret.
  router.add('GET', '/api/ai', 'viewer', c => publicAi(c.store.read()));
  // The settings page needs the saved endpoint, the cached model ids and the
  // last catalogue error; a viewer-facing payload must not carry those.
  router.add('GET', '/api/ai/providers', 'admin', c => listProviderListings(c.store));
  router.add('POST', '/api/ai/providers', 'admin', async c => {
    const b = await c.body();
    const created = await addProvider(c.store, c.actor.workspaceId, {...b, createdBy: c.actor.email});
    return reply(201, await withCatalogue(c.store, created.id));
  });
  // Rename, re-point or rotate the key. A changed endpoint or key re-reads the
  // model catalogue, because the old list no longer describes this provider.
  router.add('PATCH', '/api/ai/providers/:id', 'admin', async c => {
    const b = await c.body();
    const updated = await updateProvider(c.store, c.actor.workspaceId, c.params.id, b);
    return updated.endpointChanged ? withCatalogue(c.store, updated.id) : getProvider(c.store, updated.id);
  });
  router.add('DELETE', '/api/ai/providers/:id', 'admin', c => deleteProvider(c.store, c.actor.workspaceId, c.params.id));
  // Fetch the provider's own model list so the picker reflects reality.
  router.add('POST', '/api/ai/providers/:id/models', 'admin', async c => modelsForProvider(c.store, c.params.id));
  // One real round trip. The failure carries the provider's own words (already
  // redacted of the key upstream), which is what the operator needs to fix it.
  router.add('POST', '/api/ai/providers/:id/test', 'admin', async c => testProvider(c.store, c.params.id, await c.body()));
  router.add('PATCH', '/api/ai', 'admin', async c => setDefaults(c.store, await c.body()));
  router.add('PATCH', '/api/ai/bots/:bot', 'member', async c => setBotModel(c.store, c.params.bot, await c.body()));
}
