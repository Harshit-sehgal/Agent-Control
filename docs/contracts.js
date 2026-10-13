/** Bot contracts and per-action tool permissions.
 *
 * A bot used to be a name plus free-text instructions. To coordinate safely,
 * each bot now declares what it accepts (inputs), what it must produce
 * (output shape), and which actions it may trigger (permissions). Two rules
 * make this more than paperwork:
 *
 * 1. The Node engine validates every model output against the declared output
 *    contract before handing it to the next bot, so a bot cannot smuggle an
 *    unexpected payload through a handoff.
 * 2. Actions are gated by explicit permission. `publish.post` does not exist
 *    in the registry at all: no contract can ever grant automated publishing,
 *    which is the product's hard boundary.
 *
 * Pure functions over bot records, like the other shared modules.
 */
import {validHttpUrl} from './core.js?v=b3961575ec';

export const CONTRACT_VERSION = 1;

export const INPUTS = ['objective', 'previous_output', 'evidence', 'source_post', 'settings', 'identity'];
export const OUTPUT_KINDS = ['text', 'structured'];
export const FIELD_TYPES = ['text', 'number', 'boolean', 'string_list', 'evidence_list', 'url'];

/** Actions a bot may be granted. Deliberately absent: publish/post anything
 * externally. If it is not in this list, no profile can ever enable it. */
export const ACTIONS = ['evidence.add', 'draft.create', 'schedule.set', 'agent.dispatch', 'chat.send'];

export function fail(message, status = 400) {
  throw Object.assign(new Error(message), {status});
}

export function defaultContract() {
  return {version: CONTRACT_VERSION, inputs: [...INPUTS], output: {kind: 'text', fields: []}};
}

/** Role defaults. Built-in bots keep behaving exactly as before; custom bots
 * start with no permissions and must be granted actions explicitly. */
export function defaultPermissions(type) {
  if (type === 'writing') return ['draft.create'];
  if (type === 'review') return ['evidence.add'];
  return [];
}

export function validateContract(contract) {
  if (contract === undefined || contract === null) return defaultContract();
  if (typeof contract !== 'object') fail('Contract must be an object.');
  const inputs = Array.isArray(contract.inputs) ? contract.inputs : fail('Contract inputs must be an array.');
  for (const input of inputs) {
    if (!INPUTS.includes(input)) fail(`Unknown contract input "${String(input).slice(0, 40)}".`);
  }
  const output = contract.output || fail('Contract output is required.');
  if (!OUTPUT_KINDS.includes(output.kind)) fail(`Contract output kind must be one of: ${OUTPUT_KINDS.join(', ')}.`);
  const fields = Array.isArray(output.fields) ? output.fields : fail('Contract output fields must be an array.');
  if (output.kind === 'structured' && !fields.length) fail('A structured output must declare at least one field.');
  for (const field of fields) {
    if (!field || typeof field !== 'object' || !field.name) fail('Every output field needs a name.');
    if (!FIELD_TYPES.includes(field.type)) fail(`Unknown output field type "${String(field.type || '').slice(0, 40)}".`);
  }
  const names = fields.map(f => f.name);
  if (new Set(names).size !== names.length) fail('Output field names must be unique.');
  return {
    version: CONTRACT_VERSION,
    inputs: [...new Set(inputs)],
    output: {kind: output.kind, fields: fields.map(f => ({name: String(f.name).slice(0, 60), type: f.type, required: Boolean(f.required), description: f.description ? String(f.description).slice(0, 240) : undefined}))},
  };
}

export function validatePermissions(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list)) fail('Permissions must be an array.');
  const granted = [];
  for (const action of list) {
    // An unknown action is refused loudly rather than ignored: silently
    // dropping a typo would hide that the bot can do less than configured.
    if (!ACTIONS.includes(action)) fail(`Unknown permission "${String(action).slice(0, 40)}". Allowed: ${ACTIONS.join(', ')}.`);
    if (!granted.includes(action)) granted.push(action);
  }
  return granted;
}

/** Backfill contract/permissions on stored bots. Idempotent; never downgrades
 * an explicitly configured value. */
export function normalizeBot(bot) {
  if (!bot || typeof bot !== 'object') fail('Bot record is invalid.', 500);
  bot.contract ??= defaultContract();
  bot.permissions ??= defaultPermissions(bot.type);
  return bot;
}

export function canBot(bot, action) {
  if (!bot || !Array.isArray(bot.permissions)) return false;
  return bot.permissions.includes(action);
}

/** Validate a bot step's output against its contract. Returns the parsed
 * structured value when the contract asks for one (tolerating code fences,
 * which models emit constantly), or the text itself. Throws on violation so
 * the coordinator records a real failure instead of passing garbage on. */
/** True when `value` matches the declared field type. */
function matchesType(value, type) {
  switch (type) {
    case 'text': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'url': return typeof value === 'string' && validHttpUrl(value) !== null;
    case 'string_list': return Array.isArray(value) && value.every(v => typeof v === 'string');
    // An evidence reference is a link or a structured item ({link, claim, …}).
    case 'evidence_list': return Array.isArray(value) && value.every(v => (typeof v === 'string' && v.trim()) || (v && typeof v === 'object' && !Array.isArray(v)));
    default: return true;
  }
}

export function assertContractOutput(bot, output) {
  const contract = bot?.contract || defaultContract();
  const text = String(output ?? '');
  if (!text.trim()) fail('Bot returned an empty output.', 502);
  if (contract.output.kind !== 'structured') return text;
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { fail('Structured output was not valid JSON.', 502); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('Structured output must be a JSON object.', 502);
  for (const field of contract.output.fields) {
    const value = parsed[field.name];
    // An absent value only fails a required field; a present value must still
    // match its declared type, so the coordinator never hands a mis-typed
    // payload to the next bot.
    if (value === undefined || value === null || value === '') {
      if (field.required) fail(`Structured output is missing the required field "${field.name}".`, 502);
      continue;
    }
    if (!matchesType(value, field.type)) fail(`Structured output field "${field.name}" must be of type ${field.type}.`, 502);
  }
  return parsed;
}
