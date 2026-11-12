/** Connectors on the server: adding, listing, refreshing and removing one.
 *
 * `shared/connectors.js` holds the shape. This is where a connector meets the
 * vault and the network. Every secret (an MCP server's address, which may carry
 * a key, and its headers; later Google's client secret and refresh token) is one
 * encrypted vault credential, referenced from the record by id. A route returns
 * `publicConnector`, which has no id into the vault, and an error carries only
 * what the client already redacted.
 */
import {cleanText} from '../shared/core.js';
import {fail} from '../shared/errors.js';
import {CONNECTOR_KINDS, MAX_CONNECTORS, newConnectorId, publicConnector, slugOf, siteConnector} from '../shared/connectors.js';
import {appById} from '../shared/app-catalog.js';
import {checkMcpUrl, mcpList} from './mcp-client.js';
import * as credentials from './credentials.js';
import {mcpAuthHeaders, askToSignInAgain} from './mcp-oauth.js';

const now = () => new Date().toISOString();
export const connectorsOf = state => (state.connectors ??= []);

const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const MAX_HEADERS = 8;
/** What the protocol itself says; a custom header cannot change it. */
const MANAGED = new Set(['content-type', 'accept', 'host', 'content-length', 'connection', 'transfer-encoding', 'mcp-session-id', 'mcp-protocol-version']);
const AGENT_SERVER = /^[A-Za-z0-9._-]{1,40}$/;

/** A header set an owner pasted, checked strictly: a value is written to the wire on every call, so a
 * stray line break must not split the request. */
function cleanHeaders(headers) {
  if (headers === undefined || headers === null) return {};
  if (typeof headers !== 'object' || Array.isArray(headers)) fail('Headers must be an object of header name to value.');
  const entries = Object.entries(headers);
  if (entries.length > MAX_HEADERS) fail(`Use at most ${MAX_HEADERS} headers.`);
  const out = {};
  for (const [rawName, value] of entries) {
    const name = String(rawName ?? '').trim();
    if (!HEADER_NAME.test(name)) fail(`"${cleanText(name, 40)}" is not a valid header name.`);
    if (MANAGED.has(name.toLowerCase())) fail(`The ${name} header is managed by the app.`);
    if (typeof value !== 'string' || !value || value.length > 2000) fail(`Header "${name}" needs a value of 1 to 2000 characters.`);
    if (/[\r\n]/.test(value)) fail(`Header "${name}" must not contain a line break.`);
    out[name] = value;
  }
  return out;
}

/** The target an MCP client reaches: from the vault for an HTTP server, the agent for a stdio one. A server the owner
 * signed in to gets a live access token (renewed when it is near its end). */
function savedSecret(store, connector) {
  try { return JSON.parse(credentials.revealValue(store, connector.credentialId)); }
  catch (error) { fail(error.status === 404 ? 'This connector\'s saved address was deleted. Remove it and add it again.' : 'This connector\'s saved address could not be read.', 502); }
}
export async function mcpTarget(store, connector) {
  if (connector.transport === 'stdio') return {transport: 'stdio', store, server: connector.agentServer};
  const secret = savedSecret(store, connector);
  return {transport: 'http', url: secret.url, headers: await mcpAuthHeaders(store, connector, secret), oauth: Boolean(secret.oauth)};
}

/** `use(target)` against this connector's server. A signed-in server can refuse a token before its stated end
 * (revoked, rotated): the token is renewed once and the call made again, and a second refusal asks the owner to
 * sign in again instead of blaming headers they never typed. */
export async function withMcp(store, connector, use) {
  const target = await mcpTarget(store, connector);
  try { return await use(target); }
  catch (error) {
    if (error?.httpStatus !== 401 || !target.oauth) throw error;
    const headers = await mcpAuthHeaders(store, connector, savedSecret(store, connector), {force: true});
    try { return await use({...target, headers}); }
    catch (again) {
      if (again?.httpStatus !== 401) throw again;
      return askToSignInAgain(store, connector);
    }
  }
}

/** Add an MCP server. It is reached first, with the pasted secrets in hand; only a server that answers is saved,
 * so a typo leaves no record and no credential behind. */
export async function addMcpConnector(store, workspaceId, body, {createdBy = null} = {}) {
  const b = body && typeof body === 'object' ? body : {};
  if (b.kind === 'google') fail('Google is set up with its own steps: save the client under Google setup, then sign in.');
  if (b.kind !== 'mcp') fail(`The kind must be one of: ${CONNECTOR_KINDS.filter(k => k !== 'google').join(', ')}.`);
  const name = cleanText(b.name, 100);
  if (!name || name.length > 60) fail('Give the connector a name (up to 60 characters).');
  const hasUrl = b.url !== undefined && b.url !== null && b.url !== '', hasServer = b.agentServer !== undefined && b.agentServer !== null && b.agentServer !== '';
  if (hasUrl === hasServer) fail('Give either an address (url) or the name of a server on your agent (agentServer), not both and not neither.');
  const taken = connectorsOf(store.read());
  if (taken.length >= MAX_CONNECTORS) fail(`You can connect up to ${MAX_CONNECTORS} services.`);
  if (taken.some(c => c.name.toLowerCase() === name.toLowerCase() || slugOf(c.name) === slugOf(name))) fail(`A connector called "${name}" is already added.`, 409);
  let target, record;
  if (hasUrl) {
    const url = checkMcpUrl(b.url);
    const headers = cleanHeaders(b.headers);
    target = {transport: 'http', url, headers};
    record = {transport: 'http', host: new URL(url).host, agentServer: null, account: new URL(url).host.toLowerCase()};
  } else {
    if (typeof b.agentServer !== 'string' || !AGENT_SERVER.test(b.agentServer)) fail('The agent server name may use letters, digits . _ - only (up to 40 characters).');
    if (b.headers !== undefined && b.headers !== null && Object.keys(b.headers || {}).length) fail('Headers apply to an address. A server on your agent has its own environment in the agent config; headers are not used.');
    target = {transport: 'stdio', store, server: b.agentServer};
    record = {transport: 'stdio', host: null, agentServer: b.agentServer, account: `agent:${b.agentServer}`.toLowerCase()};
  }
  const {tools} = await mcpList(target);
  let credentialId = null;
  if (target.transport === 'http') credentialId = credentials.addCredential(store, workspaceId, {name: `MCP · ${name}`, kind: 'connector_mcp', value: JSON.stringify({url: target.url, headers: target.headers}), createdBy}).id;
  try {
    return await store.update(s => {
      const list = connectorsOf(s);
      if (list.some(c => c.name.toLowerCase() === name.toLowerCase() || slugOf(c.name) === slugOf(name))) fail(`A connector called "${name}" is already added.`, 409);
      const connector = {id: newConnectorId(s, name), kind: 'mcp', name, ...record, ...(credentialId ? {credentialId} : {}), status: 'ready', statusMessage: '', actions: tools, addedAt: now(), checkedAt: now()};
      list.push(connector);
      return publicConnector(connector);
    });
  } catch (error) {
    if (credentialId) try { credentials.deleteCredential(store, workspaceId, credentialId); } catch { /* Already gone. */ }
    throw error;
  }
}

/** Ask the server for its tools again. A server that does not answer is `error` with its words, and keeps the
 * tools it last had; this returns the connector either way, so the Settings page just shows the status. */
/** Connect apps, one tap: the owner signs in to the app in the shared browser, and this records that bots may read it
 * there. Once per app; a second tap returns the one already made. */
export async function addSiteConnector(store, body = {}) {
  const app = appById(cleanText(body?.app, 40));
  if (!app) fail('That app is not in the list.', 400);
  return store.update(s => {
    const list = connectorsOf(s), had = list.find(c => c.kind === 'site' && c.app === app.id);
    if (had) return publicConnector(had);
    const made = siteConnector(s, app, {now: now()});
    list.push(made);
    return publicConnector(made);
  });
}

export async function refreshConnector(store, id) {
  const connector = connectorsOf(store.read()).find(c => c.id === id);
  if (!connector) fail('Connector not found.', 404);
  if (connector.kind === 'site') return publicConnector(connector);
  if (connector.kind !== 'mcp') fail('Only an MCP server is refreshed here. Google reconnects through its own sign-in.', 400);
  let outcome;
  try { outcome = {tools: (await withMcp(store, connector, target => mcpList(target))).tools}; }
  catch (error) { outcome = {error: cleanText(error.message, 300) || 'The server could not be reached.', reconnect: error.reason === 'reconnect'}; }
  return store.update(s => {
    const live = connectorsOf(s).find(c => c.id === id);
    if (!live) fail('Connector not found.', 404);
    // A sign-in that has to be done again keeps saying that, not a generic error.
    if (outcome.reconnect) Object.assign(live, {status: 'reconnect', statusMessage: `Sign in to ${live.name} again.`, checkedAt: now()});
    else if (outcome.error) Object.assign(live, {status: 'error', statusMessage: outcome.error, checkedAt: now()});
    else Object.assign(live, {status: 'ready', statusMessage: '', actions: outcome.tools, checkedAt: now()});
    return publicConnector(live);
  });
}

/** Remove a connector: its record, the grants that were about it and its vault credentials. A pending ask for it
 * stays, and answering it later resolves cleanly (the call then reports that the connector is gone). */
export async function removeConnector(store, workspaceId, id) {
  const gone = await store.update(s => {
    const list = connectorsOf(s);
    const at = list.findIndex(c => c.id === id);
    if (at === -1) fail('Connector not found.', 404);
    const [connector] = list.splice(at, 1);
    const prefix = `connector.${id}.`;
    s.grants = (s.grants || []).filter(g => !String(g.action).startsWith(prefix));
    return connector;
  });
  for (const credentialId of [gone.credentialId, gone.clientCredentialId, gone.tokenCredentialId].filter(Boolean)) {
    try { credentials.deleteCredential(store, workspaceId, credentialId); } catch (error) { if (error.status !== 404) throw error; }
  }
  return {ok: true};
}

/** The address this app is reached at, for the redirect Google sends the owner back to. `PUBLIC_BASE_URL` (or the
 * older `PUBLIC_ORIGIN`) says it; with neither, it is the address the request came to. No host is written into the code. */
export function publicBaseUrl(req) {
  const set = String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_ORIGIN || '').trim().replace(/\/+$/, '');
  if (/^https?:\/\/[^/\s]+$/i.test(set)) return set;
  const proxied = process.env.TRUST_PROXY === '1' && String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  const scheme = req?.socket?.encrypted || proxied ? 'https' : 'http';
  return `${scheme}://${req?.headers?.host || ''}`;
}
