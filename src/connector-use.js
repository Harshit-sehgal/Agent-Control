/** Using a connector: one tool call, whichever kind of connector it is.
 *
 * Nothing here decides whether a call may happen. That is `shared/asks.js`
 * (`verdict`, the ask card and the grants), and `src/connector-runs.js` only
 * calls this for a call that was cleared. This is the single place that turns
 * "connector + tool + args" into a request to a service, so a new kind of
 * connector is one branch.
 */
import {fail} from '../shared/errors.js';
import {mcpCall} from './mcp-client.js';
import {mcpTarget} from './connectors.js';
import {callGoogle} from './google-actions.js';

/** Run one call. Returns `{ok, text}`; throws for a failure the service did not report as a tool result. */
export async function useConnector(store, connector, tool, args = {}) {
  if (connector.kind === 'mcp') return mcpCall(await mcpTarget(store, connector), tool, args);
  if (connector.kind === 'google') return callGoogle(store, connector, tool, args);
  fail(`${connector.name} cannot be used yet.`, 422);
}
