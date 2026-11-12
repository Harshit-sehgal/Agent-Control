/** Files attached to messages, kept in the workspace's own database.
 *
 * A file arrives as base64 in a JSON body, is typed from its bytes
 * (shared/attachments.js), gets an id this server generates and is stored in
 * the `attachments` table of the session's workspace store. Nothing the client
 * sends becomes a path, and a file is only ever read back through that same
 * workspace's store, so another workspace's session cannot name it.
 *
 * A file no chat message points at any more (the chat was cleared, the bot
 * removed, the line fell out of the history window, or it was never sent) is
 * deleted by the daily sweep once it is a day old. */
import crypto from 'node:crypto';
import {MAX_FILE_BYTES, sniffType, cleanFileName, isImage, attachmentRefs, base64Bytes, fencedFile, MAX_FILES} from '../shared/attachments.js';
import {fail} from './http.js';

const now = () => new Date().toISOString();

/** Store one file and return the reference a message carries. */
export function saveAttachment(store, {name, data} = {}, {by = null, at = now()} = {}) {
  if (typeof store?.run !== 'function') fail('Attachments need the server database.', 501);
  const bytes = base64Bytes(data);
  if (!bytes) fail('Send the file as base64 in "data".');
  if (!bytes.length) fail('That file is empty.');
  if (bytes.length > MAX_FILE_BYTES) fail(`Each file must be ${MAX_FILE_BYTES / 1048576} MB or smaller.`, 413);
  const clean = cleanFileName(name), type = sniffType(bytes, clean);
  if (!type) fail('Attach an image (PNG, JPEG, WebP or GIF) or a text file (.txt, .md, .csv, .json).', 415);
  const id = crypto.randomUUID();
  store.run('INSERT INTO attachments (id,name,type,size,data,created_by,created_at) VALUES (?,?,?,?,?,?,?)', id, clean, type, bytes.length, bytes, by, at);
  return {id, name: clean, type, size: bytes.length};
}

/** One stored file with its bytes, or null. */
export function readAttachment(store, id) {
  if (typeof store?.get !== 'function' || !/^[a-z0-9-]{8,64}$/.test(String(id))) return null;
  const row = store.get('SELECT id,name,type,size,data FROM attachments WHERE id=?', id);
  return row ? {...row, data: Buffer.from(row.data)} : null;
}

/** The HTTP answer for one file: its validated type, never sniffed by the
 * browser, a sandbox CSP, and a download for anything that is not an image. */
export function attachmentHeaders(file) {
  const image = isImage(file.type);
  const type = image ? file.type : `${file.type}; charset=utf-8`;
  const filename = encodeURIComponent(file.name);
  return {
    'Content-Type': type,
    'Content-Length': String(file.data.length),
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'Cache-Control': 'private, max-age=86400',
    'Content-Disposition': `${image ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}`,
  };
}

/** Delete files no message points at, once they are `graceMs` old. */
export function pruneAttachments(store, {now: at = Date.now(), graceMs = 86400000} = {}) {
  if (typeof store?.all !== 'function') return 0;
  const used = new Set();
  for (const list of Object.values(store.read().chats || {})) for (const m of list || []) for (const a of m.attachments || []) used.add(a.id);
  const cutoff = new Date(at - graceMs).toISOString();
  let removed = 0;
  for (const row of store.all('SELECT id FROM attachments WHERE created_at < ?', cutoff)) {
    if (used.has(row.id)) continue;
    store.run('DELETE FROM attachments WHERE id=?', row.id);
    removed++;
  }
  return removed;
}

/** What a model turn gets from the files the owner just attached: the images
 * as parts, and the text files fenced into the text. The files are those on the
 * owner's lines after the last bot line in the envelope's thread, so a later
 * turn without files does not pay for old images again. */
export function turnFiles(input, read) {
  let env;
  try { env = JSON.parse(String(input ?? '')); } catch { return null; }
  const thread = Array.isArray(env?.thread) ? env.thread : [];
  const refs = [];
  for (let i = thread.length - 1; i >= 0 && thread[i]?.from === 'user'; i--) refs.unshift(...attachmentRefs(thread[i].files));
  if (!refs.length) return null;
  const images = [], texts = [];
  for (const ref of refs.slice(-MAX_FILES)) {
    const file = read(ref.id);
    if (!file) continue;
    if (isImage(file.type)) images.push({type: file.type, data: file.data.toString('base64'), name: file.name});
    else texts.push(fencedFile(file.name, file.data.toString('utf8')));
  }
  return images.length || texts.length ? {images, text: texts.join('\n\n')} : null;
}
