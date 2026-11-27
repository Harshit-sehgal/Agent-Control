// Encrypted cookie jars: one file per browser account, on this computer only.
//
// A jar holds every cookie of one account's browser context, so it is as
// valuable as a password. It is AES-256-GCM encrypted under a key derived from
// the pairing secret, bound to its account id, 0600 inside a 0700 folder, and
// never read by anything but the shared browser. Nothing here logs a cookie
// value or a key, and no error message carries one.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** A local copy of the server's ACCOUNT_ID pattern (`shared/browser-accounts.js`),
 * so this module needs no import from `shared/`. An id is checked before any
 * path is built from it. */
const JAR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BAD_ID = 'This task names a browser account this device cannot use.';
const TAG_BYTES = 16;
const KEY_INFO = 'agent-control browser-account jar v1';

/** Where the jars live: `AGENT_BROWSER_ACCOUNTS`, else next to the agent's config. */
export function browserAccountsDir(env = process.env, configPath) {
  return env.AGENT_BROWSER_ACCOUNTS ? path.resolve(env.AGENT_BROWSER_ACCOUNTS) : path.join(path.dirname(configPath), 'browser-accounts');
}

function checkId(id) {
  if (typeof id !== 'string' || !JAR_ID.test(id)) throw new Error(BAD_ID);
  return id;
}
const keyOf = (secret, salt) => Buffer.from(crypto.hkdfSync('sha256', secret, salt, KEY_INFO, 32));
const b64 = buf => buf.toString('base64');
const missing = e => e?.code === 'ENOENT';
function rmQuiet(file) { try { fs.unlinkSync(file); } catch (e) { if (!missing(e)) throw e; } }

function seal(secret, id, cookies) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyOf(secret, salt), iv);
  cipher.setAAD(Buffer.from(`account:${id}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(cookies), 'utf8'), cipher.final()]);
  return JSON.stringify({v: 1, salt: b64(salt), iv: b64(iv), tag: b64(cipher.getAuthTag()), data: b64(data)});
}

/** The cookies in a jar's text, or null when it is not a jar this secret and this id open. */
function unseal(secret, id, text) {
  try {
    const file = JSON.parse(text);
    if (file?.v !== 1) return null;
    const [salt, iv, tag, data] = ['salt', 'iv', 'tag', 'data'].map(k => Buffer.from(String(file[k]), 'base64'));
    // GCM would accept a shortened tag, which anyone who can write the file could
    // cut to 32 bits. Only a full-length tag opens a jar.
    if (tag.length !== TAG_BYTES) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', keyOf(secret, salt), iv, {authTagLength: TAG_BYTES});
    decipher.setAAD(Buffer.from(`account:${id}`));
    decipher.setAuthTag(tag);
    const cookies = JSON.parse(Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8'));
    return Array.isArray(cookies) ? cookies : null;
  } catch { return null; }
}

/** Writes a jar to `<id>.jar.tmp`, private and fsynced, and hands back the means
 * to put it in place or drop it. Private: every caller has already checked the id. */
function stage({dir, secret}, id, cookies) {
  if (!Array.isArray(cookies)) throw new Error('A cookie jar holds an array of cookies.');
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.chmodSync(dir, 0o700);
  const jar = path.join(dir, `${id}.jar`), tmp = `${jar}.tmp`;
  rmQuiet(tmp);                                  // never write through a link someone left here
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, seal(secret, id, cookies));
    fs.fsyncSync(fd);
  } catch (e) { fs.closeSync(fd); rmQuiet(tmp); throw e; }
  fs.closeSync(fd);
  return {commit: () => fs.renameSync(tmp, jar), discard: () => rmQuiet(tmp)};
}

/** The jars of one folder, opened with one secret. */
export function createJarStore({dir, secret}) {
  if (typeof secret !== 'string' || !secret) throw new Error('A cookie jar needs the computer\'s pairing secret.');
  const jarPath = id => path.join(dir, `${id}.jar`);
  const tmpPath = id => `${jarPath(id)}.tmp`;
  const readText = id => { try { return fs.readFileSync(jarPath(id), 'utf8'); } catch (e) { if (missing(e)) return null; throw e; } };
  const names = suffix => { try { return fs.readdirSync(dir).filter(n => n.endsWith(suffix) && JAR_ID.test(n.slice(0, -suffix.length))).map(n => n.slice(0, -suffix.length)); } catch (e) { if (missing(e)) return []; throw e; } };
  const wipeId = id => { rmQuiet(jarPath(id)); rmQuiet(tmpPath(id)); };

  return {
    save(id, cookies) { checkId(id); stage({dir, secret}, id, cookies).commit(); },
    load(id) {
      checkId(id);
      const text = readText(id);
      if (text === null) return null;
      const cookies = unseal(secret, id, text);
      if (!cookies) rmQuiet(jarPath(id));
      return cookies;
    },
    wipe(id) { checkId(id); wipeId(id); },
    ids() { return names('.jar'); },
    /** Wipes every jar (and any half-written copy) whose id is not in an explicit list. */
    retain(ids) {
      if (!Array.isArray(ids)) return [];
      const keep = new Set(ids.filter(id => typeof id === 'string' && JAR_ID.test(id)));
      const wiped = names('.jar').filter(id => !keep.has(id));
      for (const id of new Set([...wiped, ...names('.jar.tmp')])) if (!keep.has(id)) wipeId(id);
      return wiped;
    },
  };
}

/** Whether the jar file of `id` opens under `secret`; nothing is removed either way. */
function opensUnder(secret, dir, id) {
  let text;
  // A jar that is gone is not open. A read that fails for any other reason is an error, not "does not open": taking
  // it for a jar the new secret cannot open would send it to be re-keyed from the old secret, which removes it.
  try { text = fs.readFileSync(path.join(dir, `${id}.jar`), 'utf8'); } catch (e) { if (missing(e)) return false; throw e; }
  return unseal(secret, id, text) !== null;
}

/** Wipes every jar and half-written copy in a folder: for a computer that paired anew, whose jars no secret it holds opens. */
export function wipeAllJars(dir) {
  return createJarStore({dir, secret: crypto.randomBytes(8).toString('hex')}).retain([]);
}

/** A re-pair gives the computer a new secret. Each jar is opened under the old
 * one and written under the new; one that will not open is wiped. Run again over
 * a folder that was half done, it finishes the rest (the agent keeps both secrets
 * in its config until this has run once through).
 *
 * Every copy is staged before any is put in place. A jar that cannot be read or
 * staged throws with the staged copies removed, and every old jar still opens
 * under the old secret. Only the final renames can fail halfway (a full disk,
 * a vanished folder): the copies not yet in place are removed, the jars already
 * renamed open only under the new secret and the rest only under the old, and
 * the error is thrown so the caller does not save the new secret. A jar that no
 * secret opens is removed on its next load, so the worst result is an account
 * that reads signed out, never a readable jar under a wrong key. */
export function rekeyJars({dir, oldSecret, newSecret}) {
  const from = createJarStore({dir, secret: oldSecret});
  const kept = [], wiped = [], staged = [];
  try {
    for (const id of from.ids()) {
      // A jar the new secret already opens (an earlier run got this far) is left alone: `load` under the old secret
      // would remove it.
      if (opensUnder(newSecret, dir, id)) { kept.push(id); continue; }
      const cookies = from.load(id);
      if (cookies) { staged.push(stage({dir, secret: newSecret}, id, cookies)); kept.push(id); } else wiped.push(id);
    }
  } catch (e) { for (const s of staged) s.discard(); throw e; }
  let done = 0;
  try { for (; done < staged.length; done++) staged[done].commit(); }
  catch (e) { for (const s of staged.slice(done)) s.discard(); throw e; }
  return {kept, wiped};
}

/** What a computer sends to prove it held the old secret: the hex HMAC-SHA256
 * of `re-pair\n<code>`. The server checks the same formula (`src/`, Task 3). */
export function rePairProof(secret, code) {
  return crypto.createHmac('sha256', secret).update(`re-pair\n${code}`).digest('hex');
}
