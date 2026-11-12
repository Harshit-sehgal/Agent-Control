/** The MCP wire rules, shared by both transports.
 *
 * An MCP server is a JSON-RPC 2.0 peer: the client says `initialize`, then
 * `notifications/initialized`, then asks `tools/list` or `tools/call`. The server
 * side of this app reaches a streamable-HTTP server itself (`src/mcp-client.js`);
 * a stdio server runs inside the paired local agent (`agent/mcp-stdio.mjs`). Both
 * build and read messages here, so they cannot disagree about what a message is,
 * which tool counts as a write, or how big a result may be.
 *
 * Pure and browser-safe, like the other shared modules. Nothing here sends anything.
 */
import {cleanText} from './core.js';

export const PROTOCOL_VERSION = '2025-06-18';
export const CLIENT_INFO = {name: 'agent-control', version: '1'};
/** What a bot is shown of one tool result. A longer one is cut and says so. */
export const MAX_RESULT_CHARS = 12000;
export const MAX_TOOLS = 100;
const MAX_DESCRIPTION = 200;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

/** One plain line: control characters and runs of white space become single spaces. */
const oneLine = (value, max) => cleanText(String(value ?? '').replace(/[\u0000-\u001f\u007f\s]+/g, ' '), max);

const rpc = (id, method, params) => ({jsonrpc: '2.0', id, method, params});

export const initializeRequest = id => rpc(id, 'initialize', {protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO});
export const initializedNotification = () => ({jsonrpc: '2.0', method: 'notifications/initialized'});
export const toolsListRequest = (id, cursor) => rpc(id, 'tools/list', cursor ? {cursor: String(cursor)} : {});
export const toolsCallRequest = (id, name, args) => rpc(id, 'tools/call', {name, arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {}});

/** The answer to request `id`, or undefined when `message` is anything else (another id, a server
 * notification, a request the server is making). An error answer throws with the server's own words. */
export function rpcResult(message, id) {
  if (!message || typeof message !== 'object' || Array.isArray(message) || message.id !== id) return undefined;
  if (message.error) throw new Error(cleanText(typeof message.error === 'object' ? message.error.message : message.error, 300) || 'The MCP server reported an error.');
  if (!('result' in message)) throw new Error('The MCP server answered with no result.');
  return message;
}

/** A tool is a read only when the server says so and does not also call it destructive. No
 * annotations, or anything unclear, is a write: a tool nobody described is treated as one that changes things. */
export const toolIsWrite = tool => {
  const hints = tool?.annotations && typeof tool.annotations === 'object' ? tool.annotations : {};
  return !(hints.readOnlyHint === true && hints.destructiveHint !== true);
};

const ARG_NAME = /^[A-Za-z0-9_.-]{1,40}$/, MAX_ARGS = 12;
/** A tool's argument names from its input schema, a required one ending in `*` (`['query*', 'max']`); or the same
 * list another part of this app already cleaned. Empty when the tool names none. */
function argsOf(tool) {
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object' ? tool.inputSchema : null;
  if (!schema) return (Array.isArray(tool.args) ? tool.args : []).filter(a => typeof a === 'string' && ARG_NAME.test(a.replace(/\*$/, ''))).slice(0, MAX_ARGS);
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const props = schema.properties && typeof schema.properties === 'object' ? Object.keys(schema.properties) : [];
  return props.filter(name => ARG_NAME.test(name)).slice(0, MAX_ARGS).map(name => (required.has(name) ? `${name}*` : name));
}

/** The tools a bot may be told about: a callable name, a short plain description, whether it writes, and its
 * argument names. A description comes from the server and goes into a prompt, so it is cut to one short line. */
export function cleanTools(list) {
  const seen = new Set(), out = [];
  for (const tool of Array.isArray(list) ? list : []) {
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name) || seen.has(tool.name)) continue;
    seen.add(tool.name);
    const args = argsOf(tool);
    out.push({name: tool.name, description: oneLine(typeof tool.description === 'string' ? tool.description : '', MAX_DESCRIPTION), write: toolIsWrite(tool), ...(args.length ? {args} : {})});
    if (out.length >= MAX_TOOLS) break;
  }
  return out;
}

/** Tools another part of this app already cleaned (the paired agent's list): read again with the same limits, and
 * `write` kept only as the boolean it was. Anything unclear is a write. Never used on what an MCP server itself sent. */
export function readTools(list) {
  return cleanTools((Array.isArray(list) ? list : []).map(tool => (tool && typeof tool === 'object' ? {...tool, annotations: tool.write === false ? {readOnlyHint: true} : {}} : tool)));
}

/** A tool result as text for the bot: text parts kept, anything else named, an error flagged, the length capped. */
export function resultText(result, cap = MAX_RESULT_CHARS) {
  if (!result || typeof result !== 'object') return {ok: false, text: 'The tool returned an answer this app could not read.'};
  const parts = Array.isArray(result.content)
    ? result.content.map(part => (part?.type === 'text' && typeof part.text === 'string' ? part.text : `[${typeof part?.type === 'string' ? part.type.replace(/[^a-z_-]/gi, '').slice(0, 20) || 'content' : 'content'} omitted]`))
    : [];
  let text = parts.join('\n');
  if (!text && result.structuredContent !== undefined) { try { text = JSON.stringify(result.structuredContent); } catch { /* Left empty. */ } }
  text = text.replace(/\u0000/g, '');
  if (!text.trim()) text = '(the tool returned nothing)';
  if (text.length > cap) text = `${text.slice(0, cap)}\n[cut: the result was longer than ${cap} characters]`;
  return {ok: result.isError !== true, text};
}
