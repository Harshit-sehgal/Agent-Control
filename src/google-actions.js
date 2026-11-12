/** What a bot can do with Google once the owner has said yes: search and read Gmail, save or send an email, search
 * and read Drive. Each action returns `{ok: true, text}` (bounded text) or throws with a plain sentence.
 *
 * Everything a bot supplies is validated here. An id is letters, digits, `_` and `-` only, so it cannot become a
 * path or a query; a recipient is a bare address, so there is no name part to hide a second one in; a subject has
 * no line break, so it cannot start a header; the message is assembled here from those parts, so a bot cannot add a
 * Bcc or any header of its own. The access token goes only to Google's own address. Mail and files are other
 * people's text: they are returned as data (the run hands them on as untrusted), and cut to a size a prompt can hold.
 */
import {cleanText} from '../shared/core.js';
import {fail} from '../shared/errors.js';
import {googleAccessToken, googleEndpoints, googleFetch, forgetGoogleToken} from './google.js';

const MAX_TEXT = 8000;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const ADDRESS = /^[^\s<>@,;"'()[\]\\]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
const parse = text => { try { return JSON.parse(text); } catch { return null; } };
const cut = text => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n[cut: the text was longer than ${MAX_TEXT} characters]` : text);

/** One call to Google's API. A 401 means the cached access token went stale: refresh once and try again. */
async function api(store, path, {method = 'GET', query = {}, json, raw = false, maxBytes} = {}) {
  const url = new URL(`${googleEndpoints().api}${path}`);
  for (const [k, v] of Object.entries(query)) for (const item of Array.isArray(v) ? v : [v]) url.searchParams.append(k, item);
  for (let attempt = 0; ; attempt++) {
    const token = await googleAccessToken(store);
    const reply = await googleFetch(url, {method, headers: {authorization: `Bearer ${token}`, accept: raw ? '*/*' : 'application/json', ...(json ? {'content-type': 'application/json'} : {})}, ...(json ? {body: JSON.stringify(json)} : {})}, maxBytes ? {maxBytes} : {});
    if (reply.status === 401 && attempt === 0) { forgetGoogleToken(store); continue; }
    if (reply.status >= 200 && reply.status < 300) return raw ? reply.text : (parse(reply.text) ?? {});
    const why = cleanText(parse(reply.text)?.error?.message, 160);
    throw Object.assign(new Error(`Google refused the request (${reply.status})${why ? `: ${why}` : '.'}`), {status: reply.status === 404 ? 404 : 502, code: 'google'});
  }
}

const idOf = (value, what) => { if (typeof value !== 'string' || !ID.test(value)) fail(`${what} needs an id from a search (letters, digits, _ and - only).`); return value; };
const wordsOf = (value, what) => { const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() : ''; if (!text || text.length > 300) fail(`${what} needs a query of 1 to 300 characters.`); return text; };
const countOf = value => { const n = Math.floor(Number(value)); return Number.isFinite(n) ? Math.max(1, Math.min(10, n)) : 5; };

// --- Gmail -----------------------------------------------------------------------------------------------

const header = (message, name) => (message?.payload?.headers || []).find(h => String(h.name).toLowerCase() === name.toLowerCase())?.value || '';
const clip = (text, n) => cleanText(String(text ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' '), n);

async function gmailSearch(store, args) {
  const query = wordsOf(args.query, 'gmail.search');
  const list = await api(store, '/gmail/v1/users/me/messages', {query: {q: query, maxResults: String(countOf(args.max))}});
  const ids = (list.messages || []).map(m => m.id).filter(id => typeof id === 'string' && ID.test(id)).slice(0, 10);
  if (!ids.length) return {ok: true, text: 'No messages matched.'};
  const found = await Promise.all(ids.map(id => api(store, `/gmail/v1/users/me/messages/${id}`, {query: {format: 'metadata', metadataHeaders: ['From', 'To', 'Subject', 'Date']}})));
  return {ok: true, text: found.map(m => `id: ${m.id} | ${clip(header(m, 'Date'), 40)} | From: ${clip(header(m, 'From'), 80)} | Subject: ${clip(header(m, 'Subject'), 120)}\n  ${clip(m.snippet, 160)}`).join('\n')};
}

/** The readable text of a message: its text/plain part, else its text/html part with the tags taken out. */
function bodyOf(part) {
  const found = {plain: '', html: ''};
  const walk = p => {
    if (!p || typeof p !== 'object') return;
    const data = typeof p.body?.data === 'string' ? Buffer.from(p.body.data, 'base64url').toString('utf8') : '';
    if (p.mimeType === 'text/plain' && !found.plain) found.plain = data;
    else if (p.mimeType === 'text/html' && !found.html) found.html = data;
    for (const child of Array.isArray(p.parts) ? p.parts : []) walk(child);
  };
  walk(part);
  if (found.plain.trim()) return found.plain;
  return found.html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

async function gmailRead(store, args) {
  const id = idOf(args.id, 'gmail.read');
  const message = await api(store, `/gmail/v1/users/me/messages/${id}`, {query: {format: 'full'}});
  const head = ['From', 'To', 'Cc', 'Date', 'Subject'].map(name => [name, clip(header(message, name), 200)]).filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`).join('\n');
  return {ok: true, text: cut(`${head}\n\n${bodyOf(message.payload).replace(/\u0000/g, '')}`)};
}

function addressList(value, what, {required = false} = {}) {
  const items = (Array.isArray(value) ? value : typeof value === 'string' && value ? value.split(/[,;]/) : []).map(v => (typeof v === 'string' ? v.trim() : v));
  if (required && !items.length) fail(`${what} needs a "to" address.`);
  for (const item of items) if (typeof item !== 'string' || !ADDRESS.test(item)) fail(`"${clip(item, 60)}" is not an address. Use plain addresses like name@example.com, separated by commas.`);
  return items;
}
const b64 = text => Buffer.from(text, 'utf8').toString('base64');
/** The message as RFC 822, assembled from validated parts only, then base64url for the Gmail API. */
function mime(args, what) {
  const to = addressList(args.to, what, {required: true}), cc = addressList(args.cc, what);
  if (to.length + cc.length > 10) fail('A message may have at most 10 recipients.');
  if (typeof args.subject !== 'string' || !args.subject.trim() || args.subject.length > 200) fail(`${what} needs a subject of 1 to 200 characters.`);
  if (typeof args.body !== 'string' || !args.body.trim() || args.body.length > 20000) fail(`${what} needs a body of 1 to 20000 characters.`);
  const subject = args.subject.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  const encoded = /^[\x20-\x7e]*$/.test(subject) ? subject : `=?UTF-8?B?${b64(subject)}?=`;
  const lines = [`To: ${to.join(', ')}`, ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []), `Subject: ${encoded}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset="UTF-8"', 'Content-Transfer-Encoding: base64', '', (b64(args.body).match(/.{1,76}/g) || []).join('\r\n')];
  return {raw: Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url'), to};
}

async function gmailDraft(store, args) {
  const {raw, to} = mime(args, 'gmail.draft');
  const out = await api(store, '/gmail/v1/users/me/drafts', {method: 'POST', json: {message: {raw}}});
  return {ok: true, text: `Draft saved (id ${clip(out.id, 60)}) for ${to.join(', ')}. It was not sent.`};
}
async function gmailSend(store, args) {
  const {raw, to} = mime(args, 'gmail.send');
  const out = await api(store, '/gmail/v1/users/me/messages/send', {method: 'POST', json: {raw}});
  return {ok: true, text: `Sent to ${to.join(', ')} (id ${clip(out.id, 60)}).`};
}

// --- Drive -----------------------------------------------------------------------------------------------

async function driveSearch(store, args) {
  const words = wordsOf(args.query, 'drive.search').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const out = await api(store, '/drive/v3/files', {query: {q: `fullText contains '${words}' and trashed = false`, pageSize: String(countOf(args.max)), orderBy: 'modifiedTime desc', fields: 'files(id,name,mimeType,modifiedTime)'}});
  const files = (out.files || []).filter(f => typeof f?.id === 'string' && ID.test(f.id)).slice(0, 10);
  if (!files.length) return {ok: true, text: 'No files matched.'};
  return {ok: true, text: files.map(f => `id: ${f.id} | ${clip(f.name, 120)} | ${clip(f.mimeType, 60)} | modified ${clip(f.modifiedTime, 30)}`).join('\n')};
}

const EXPORTS = {'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.presentation': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv'};
const FILE_BYTES = 5 * 1024 * 1024;
async function driveRead(store, args) {
  const id = idOf(args.id, 'drive.read');
  const meta = await api(store, `/drive/v3/files/${id}`, {query: {fields: 'id,name,mimeType,size'}});
  const mimeType = typeof meta.mimeType === 'string' ? meta.mimeType : '';
  const title = clip(meta.name, 120);
  try {
    if (EXPORTS[mimeType]) return {ok: true, text: cut(`${title}\n\n${await api(store, `/drive/v3/files/${id}/export`, {query: {mimeType: EXPORTS[mimeType]}, raw: true, maxBytes: FILE_BYTES})}`)};
    if (/^text\//.test(mimeType) || mimeType === 'application/json') return {ok: true, text: cut(`${title}\n\n${await api(store, `/drive/v3/files/${id}`, {query: {alt: 'media'}, raw: true, maxBytes: FILE_BYTES})}`)};
  } catch (error) {
    if (error.code === 'too-large') return {ok: false, text: `${title} is too large to read here.`};
    throw error;
  }
  return {ok: false, text: `${title} (${clip(mimeType, 60) || 'unknown type'}) cannot be read as text.`};
}

const ACTIONS = {'gmail.search': gmailSearch, 'gmail.read': gmailRead, 'gmail.draft': gmailDraft, 'gmail.send': gmailSend, 'drive.search': driveSearch, 'drive.read': driveRead};

/** Make one Google call. `args` is what the bot wrote: every field is checked by the action. */
export async function callGoogle(store, connector, tool, args = {}) {
  const action = Object.hasOwn(ACTIONS, tool) ? ACTIONS[tool] : null;
  if (!action) fail(`${connector?.name || 'Google'} has no tool called "${cleanText(tool, 60)}".`);
  return action(store, args && typeof args === 'object' && !Array.isArray(args) ? args : {});
}
