/** Connectors over HTTP: Google and MCP servers a bot may use.
 *
 * Reading is for any signed-in member (no secret is ever in the answer: see
 * `publicConnector`); adding, refreshing and removing one is the admin's.
 * Every use of a connector by a bot goes through the ask mechanism, not here.
 */
import {publicConnectors} from '../shared/connectors.js';
import {addMcpConnector, refreshConnector, removeConnector, publicBaseUrl} from './connectors.js';
import {reply} from './router.js';

export const GOOGLE_CALLBACK = '/api/connectors/google/callback';

export function connectorRoutes(router) {
  router.add('GET', '/api/connectors', 'viewer', c => ({
    connectors: publicConnectors(c.store.read()),
    google: {configured: false, redirectUri: `${publicBaseUrl(c.req)}${GOOGLE_CALLBACK}`},
  }));
  router.add('POST', '/api/connectors', 'admin', async c => reply(201, await addMcpConnector(c.store, c.actor.workspaceId, await c.body(), {createdBy: c.actor.email})));
  router.add('POST', '/api/connectors/:id/refresh', 'admin', c => refreshConnector(c.store, c.params.id));
  router.add('DELETE', '/api/connectors/:id', 'admin', c => removeConnector(c.store, c.actor.workspaceId, c.params.id));
}
