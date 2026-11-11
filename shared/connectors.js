/** Connectors: the shape of one, and how a bot names it.
 *
 * A connector is a service a bot may use through the owner's say-so: Google (Gmail
 * and Drive) or one MCP server. It is `{id, kind: 'google'|'mcp', name, account,
 * actions: [{name, write, description}]}` plus what the Settings page shows
 * (`status`, `statusMessage`, `transport`, `host`, `agentServer`, `addedAt`,
 * `checkedAt`). The records live in `state.connectors` and hold NO secret: a
 * credential is a vault id on the server's copy of the record (`credentialId`,
 * `clientCredentialId`, `tokenCredentialId`), and `publicConnector` leaves those out.
 *
 * Asking is by action: `connector.<id>.read` or `connector.<id>.write` (`shared/asks.js`),
 * scoped to the account, so Always allow for one Google account is not Always allow for another.
 *
 * Pure and browser-safe, like the other shared modules.
 */
import {cleanText} from './core.js';

export const CONNECTOR_KINDS = ['google', 'mcp'];
/** `ready` works; `setup` is Google with a client saved and no sign-in yet; `reconnect` is a sign-in that
 * lapsed (Google rejected the refresh token); `error` is anything else that stopped it, with its words in `statusMessage`. */
export const CONNECTOR_STATUSES = ['ready', 'setup', 'reconnect', 'error'];
export const MAX_CONNECTORS = 20;
export const GOOGLE_ID = 'google';
const RESERVED_IDS = [GOOGLE_ID, 'setup', 'start', 'callback'];

/** `connector.<id>.read` or `.write`, the action an ask and a grant are about. */
export const connectorAction = (connector, write) => `connector.${connector.id}.${write ? 'write' : 'read'}`;

/** A route-safe id from a name: lower case letters and digits joined by single hyphens. */
export function slugOf(name) {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30).replace(/-+$/g, '') || 'connector';
}

/** An id no other connector has. `google` belongs to Google alone. */
export function newConnectorId(state, name, kind = 'mcp') {
  if (kind === 'google') return GOOGLE_ID;
  const taken = new Set((state.connectors || []).map(c => c.id));
  const base = slugOf(name);
  let id = RESERVED_IDS.includes(base) ? `${base}-2` : base, n = 2;
  while (taken.has(id) || RESERVED_IDS.includes(id)) id = `${base}-${n++}`.slice(0, 40);
  return id;
}

/** The connector a bot means by `use`: its id, or its name in any case. Null when none or when the name is not one. */
export function findConnector(state, use) {
  if (typeof use !== 'string') return null;
  const wanted = use.trim().toLowerCase();
  if (!wanted) return null;
  const all = state?.connectors || [];
  return all.find(c => c.id === wanted) || all.find(c => String(c.name).toLowerCase() === wanted) || null;
}

/** What a route or the state snapshot may show: never an id into the vault. */
export const publicConnector = c => ({
  id: c.id, kind: c.kind, name: c.name, account: c.account ?? null, status: c.status || 'ready', statusMessage: c.statusMessage || '',
  transport: c.transport ?? null, host: c.host ?? null, agentServer: c.agentServer ?? null,
  actions: (c.actions || []).map(a => ({name: a.name, write: Boolean(a.write), description: cleanText(a.description, 200)})),
  addedAt: c.addedAt ?? null, checkedAt: c.checkedAt ?? null,
});
export const publicConnectors = state => (Array.isArray(state?.connectors) ? state.connectors : []).map(publicConnector);

/** The one action in a connector by name, or null. */
export const actionOf = (connector, tool) => (connector?.actions || []).find(a => a.name === tool) || null;
