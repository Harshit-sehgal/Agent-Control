/** Encrypted secret storage (the credential vault).
 *
 * Paired-agent secrets and stored credentials must be verifiable at rest
 * without keeping plaintext keys in the database. This module owns:
 *
 * - a master key: `MASTER_KEY` when the operator sets one, otherwise a
 *   keyfile generated once inside the (git-ignored, 0600) data directory and
 *   never transmitted;
 * - AES-256-GCM encryption with per-value IVs, stored as base64 columns;
 * - lookup hashes (SHA-256) so a row can be found without decrypting.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_FILE = 'vault.key';

function loadEnvKey() {
  const raw = process.env.MASTER_KEY;
  if (!raw) return null;
  const key = raw.length === 64 && /^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('MASTER_KEY must decode to exactly 32 bytes (64 hex characters).');
  return key;
}

export function resolveVaultKeyPath(dataFile) {
  return path.join(path.dirname(dataFile), KEY_FILE);
}

/** Environment key wins; otherwise create/read the keyfile next to the store. */
export function loadMasterKey(dataFile) {
  const env = loadEnvKey();
  if (env) return {key: env, source: 'env'};
  const file = resolveVaultKeyPath(dataFile);
  // Only generate a key when the file is *absent*. If it exists but cannot be
  // read or is not a valid 32-byte key, fail loudly instead of overwriting it:
  // a silent rotation would make every previously encrypted secret unreadable.
  if (fs.existsSync(file)) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8').trim(); }
    catch (e) { throw new Error(`The vault keyfile at ${file} exists but could not be read (${e.code || e.message}). Refusing to overwrite it.`); }
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error(`The vault keyfile at ${file} is not a valid 32-byte key. Restore it from backup or set MASTER_KEY; refusing to overwrite it because that would make existing encrypted secrets unreadable.`);
    return {key, source: 'keyfile'};
  }
  const key = crypto.randomBytes(32);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, key.toString('base64'), {mode: 0o600});
  return {key, source: 'keyfile'};
}

export function encryptJson(key, value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return {ciphertext: ciphertext.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64')};
}

export function decryptJson(key, {ciphertext, iv, tag}) {
  // setAuthTag rather than the constructor's 4th argument: some Node builds
  // differ on the tag-as-constructor-arg form, and a silent auth failure here
  // would look like corrupted credentials instead of a bad key.
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  const plain = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

export const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
