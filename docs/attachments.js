/** Files the owner attaches to a message: what may be attached, how big, and
 * how a stored file is named and typed. Pure and browser-safe, so the composer,
 * the Node upload route and the Pages demo apply the same rules.
 *
 * The type is read from the bytes, never from the name or what the browser
 * claims: an image must start with its format's signature, and a text file must
 * have a text extension and decode as UTF-8 with no NUL bytes. Anything else is
 * refused. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES = 10;
/** What one model request can carry: Anthropic takes an image of at most 5 MB, and a request (Gemini's inline data,
 * Anthropic's body) has room for about 15 MB of images. A bigger file stays in the chat and is named to the model. */
export const MODEL_IMAGE_BYTES = 5 * 1024 * 1024;
export const MODEL_IMAGES_TOTAL = 15 * 1024 * 1024;
export const tooBigNote = names => `[The owner also attached ${names.join(', ')}, too large for this model to see. Say so if it matters to the answer.]`;
/** The demo keeps files in localStorage, which holds a few MB in all. */
export const DEMO_MAX_FILE_BYTES = 512 * 1024;
export const DEMO_MAX_STORED = 8;
/** How much of a text file a model reads. */
export const MAX_TEXT_CHARS = 12000;

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const TEXT_EXT = {txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json'};
export const FILE_TYPES = [...IMAGE_TYPES, ...Object.values(TEXT_EXT)];
/** The file picker's `accept`. */
export const ACCEPT = '.png,.jpg,.jpeg,.webp,.gif,.txt,.md,.csv,.json';
const ID = /^[a-z0-9-]{8,64}$/;

export const isImage = type => IMAGE_TYPES.includes(type);
export const validAttachmentId = id => typeof id === 'string' && ID.test(id);

const starts = (b, sig, at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = s => [...s].map(c => c.charCodeAt(0));

/** The type the bytes are, or '' when they are none we accept. */
export function sniffType(bytes, name = '') {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!b.length) return '';
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts(b, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts(b, ascii('GIF87a')) || starts(b, ascii('GIF89a'))) return 'image/gif';
  if (b.length >= 12 && starts(b, ascii('RIFF')) && starts(b, ascii('WEBP'), 8)) return 'image/webp';
  const type = TEXT_EXT[String(name).toLowerCase().split('.').pop()];
  if (!type || b.includes(0)) return '';
  let text;
  try { text = new TextDecoder('utf-8', {fatal: true}).decode(b); } catch { return ''; }
  if (type === 'application/json') { try { JSON.parse(text); } catch { return ''; } }
  return type;
}

/** A display name with no path, no control characters and a bounded length. */
export function cleanFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>"]/g, '').trim();
  return base.slice(-120) || 'file';
}

/** The attachment references a chat message may carry, cleaned: at most
 * MAX_FILES, each with a generated id, a clean name and an accepted type. */
export function attachmentRefs(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const raw of list) {
    if (out.length >= MAX_FILES) break;
    if (!raw || typeof raw !== 'object' || !validAttachmentId(raw.id) || !FILE_TYPES.includes(raw.type)) continue;
    if (out.some(a => a.id === raw.id)) continue;
    const size = Number(raw.size);
    out.push({id: raw.id, name: cleanFileName(raw.name), type: raw.type, size: Number.isFinite(size) && size >= 0 ? Math.floor(size) : 0});
  }
  return out;
}

/** Why a picked file cannot be attached, or '' when it can. `count` is how many are already attached. */
export function pickProblem({size = 0, count = 0, max = MAX_FILE_BYTES} = {}) {
  if (count >= MAX_FILES) return `Attach at most ${MAX_FILES} files to one message.`;
  if (size > max) return `Each file must be ${sizeLabel(max)} or smaller.`;
  if (!size) return 'That file is empty.';
  return '';
}

export function sizeLabel(n) {
  const bytes = Number(n) || 0;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 104857.6) / 10} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/** base64 text to bytes and back, without Node's Buffer, so the demo can use them. */
export function base64Bytes(text) {
  const clean = String(text ?? '').replace(/^data:[^,]*,/, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4) return null;
  const raw = atob(clean), out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** A text file as the model reads it: fenced, named, cut to MAX_TEXT_CHARS. */
export function fencedFile(name, text, max = MAX_TEXT_CHARS) {
  const body = String(text ?? ''), cut = body.length > max;
  const fence = body.includes('```') ? '~~~~' : '```';
  return `Attached file ${cleanFileName(name)}${cut ? ` (first ${max} characters)` : ''}:\n${fence}\n${cut ? body.slice(0, max) : body}\n${fence}`;
}

/** The note a model gets when it cannot see the images the owner attached. */
export const imageNote = count => `[The owner attached ${count === 1 ? 'an image' : `${count} images`} to this message, but this model cannot see images. Say so if the image matters to the answer.]`;
