/** Browser accounts: one signed-in browser context with its own cookie jar, kept on one paired computer, so two bots can
 * be signed in to two accounts of one site.
 *
 * The record is `{id, name, site, deviceId, storage}`. The id is a UUID the server makes (never typed), `site` is a
 * hostname, `deviceId` is the one computer that holds the cookies, and `storage` is `cookies`. A bot names an account
 * through the owner-only bot setting `browserAccount` (shared/bot-settings.js); no model text can set it.
 *
 * Pure and browser-safe, no secrets: a jar never reaches this file. The route checks that `deviceId` is a paired
 * computer of the workspace; the rules here check only its shape. */
import {cleanText} from './core.js?v=18c4ca58d0';
import {fail} from './errors.js?v=18c4ca58d0';
import {hostOf} from './bot-browser.js?v=18c4ca58d0';
import {ACCOUNT_ID, DEVICE_ID, botSettings, pinnedDevice} from './bot-settings.js?v=18c4ca58d0';

export const MAX_ACCOUNTS = 20;
export const ACCOUNT_STATES = ['signed-in', 'signed-out', 'unknown'];
const MAX_NAME = 60;

const isObject = v => v && typeof v === 'object' && !Array.isArray(v);
const accountsOf = state => (Array.isArray(state?.browserAccounts) ? state.browserAccounts : []);
const botsOf = state => (state?.groups || []).flatMap(group => group.bots || []);
const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

/** The hostname of what the owner typed: a bare host, or a URL whose host is kept. Empty when it is not one with a dot. */
function siteOf(value) {
  if (typeof value !== 'string' || /\s/.test(value.trim())) return '';
  const text = value.trim();
  const host = hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  return host.includes('.') ? host : '';
}

/** A request body read as an account's fields, or a refusal. With `current`, a field the body leaves out keeps its
 * value. The computer is checked for shape only; the route checks that it is paired. */
export function cleanAccount(body, {current = null} = {}) {
  const from = isObject(body) ? body : {};
  const pick = key => (from[key] !== undefined ? from[key] : current?.[key]);
  const name = typeof pick('name') === 'string' ? cleanText(pick('name'), 1000) : '';
  if (!name || name.length > MAX_NAME) fail(`An account needs a name of up to ${MAX_NAME} characters.`);
  const site = siteOf(pick('site'));
  if (!site) fail('An account needs the site it signs in to, such as crm.example.com.');
  const storage = pick('storage') ?? 'cookies';
  if (storage !== 'cookies') fail('An account with its own browser is not available yet. Use cookies.');
  const deviceId = pick('deviceId');
  if (!(typeof deviceId === 'string' && DEVICE_ID.test(deviceId))) fail('That computer is not paired. Choose one in Settings → Local agents.');
  return {name, site, deviceId, storage};
}

const refuseTaken = (state, name, exceptId) => {
  if (accountsOf(state).some(a => a.id !== exceptId && sameName(a.name, name))) fail('Another account is already called that.');
};

/** Add an account to `state.browserAccounts` and return it. `makeId` is the server's `crypto.randomUUID`. */
export function addAccount(state, body, {makeId}) {
  const clean = cleanAccount(body);
  if (accountsOf(state).length >= MAX_ACCOUNTS) fail(`At most ${MAX_ACCOUNTS} browser accounts.`);
  refuseTaken(state, clean.name);
  const id = makeId();
  if (!ACCOUNT_ID.test(id) || accountsOf(state).some(a => a.id === id)) fail('Could not make an account id.', 500);
  const record = {id, ...clean};
  if (!Array.isArray(state.browserAccounts)) state.browserAccounts = [];
  state.browserAccounts.push(record);
  return record;
}

const find = (state, id) => accountsOf(state).find(a => a.id === id) || fail('Browser account not found.', 404);

/** Change an account in place and return it. A refused change leaves it as it was. */
export function updateAccount(state, id, body) {
  const record = find(state, id);
  const clean = cleanAccount(body, {current: record});
  refuseTaken(state, clean.name, id);
  return Object.assign(record, clean);
}

/** Remove an account and return it, unless a bot still signs in as it: then 409, naming the bots in group order. */
export function removeAccount(state, id) {
  const record = find(state, id);
  const users = botsOf(state).filter(bot => botSettings(bot).browserAccount === id);
  if (users.length) fail(`Bots still sign in as this account: ${users.map(b => b.name || b.id).join(', ')}. Choose another account on their Edit pages first.`, 409);
  state.browserAccounts.splice(state.browserAccounts.indexOf(record), 1);
  return record;
}

/** A stored or backed-up record read as untrusted: the five fields, or null for anything that is not an account. */
export function sanitizeAccount(raw) {
  if (!isObject(raw) || typeof raw.id !== 'string' || !ACCOUNT_ID.test(raw.id)) return null;
  try { return {id: raw.id, ...cleanAccount(raw)}; } catch { return null; }
}

/** The account a bot signs in as. `missing` is true when the bot names an id that has no record: it must be refused,
 * never run in the default profile. */
export function browserAccountOf(state, botId) {
  const bot = botsOf(state).find(b => b.id === botId);
  const id = bot ? botSettings(bot).browserAccount : null;
  if (!id) return {account: null, missing: false};
  const account = accountsOf(state).find(a => a.id === id) || null;
  return {account, missing: !account};
}

/** The computer a bot's pages run on: its account's, else its own pin, else null for any computer. */
export const browserDeviceOf = (state, botId) => browserAccountOf(state, botId).account?.deviceId || pinnedDevice(state, botId);

/** Move every account and every bot pin from one computer to another (a re-pair). Returns how many moved. */
export function repointDevice(state, fromId, toId) {
  if (!fromId || fromId === toId) return 0;
  let moved = 0;
  for (const account of accountsOf(state)) if (account.deviceId === fromId) { account.deviceId = toId; moved++; }
  for (const bot of botsOf(state)) if (isObject(bot.settings) && bot.settings.device === fromId) { bot.settings.device = toId; moved++; }
  return moved;
}

/** What a device says of its accounts, read as untrusted: only ids in `allowedIds`, one entry each, at most
 * MAX_ACCOUNTS, with `{id, state, storage, lost?}` and nothing else. */
export function cleanAccountReport(list, allowedIds) {
  if (!Array.isArray(list)) return [];
  const allowed = new Set(allowedIds || []);
  const out = [];
  for (const entry of list) {
    if (!isObject(entry) || typeof entry.id !== 'string' || !allowed.has(entry.id) || out.some(o => o.id === entry.id)) continue;
    const row = {id: entry.id, state: ACCOUNT_STATES.includes(entry.state) ? entry.state : 'unknown', storage: 'cookies'};
    if (entry.lost === true) row.lost = true;
    out.push(row);
    if (out.length >= MAX_ACCOUNTS) break;
  }
  return out;
}
