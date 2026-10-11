/** Workspace credential vault.
 *
 * Credentials (API keys, webhook URLs with tokens) are stored encrypted with
 * AES-256-GCM through src/vault.js. Values are written once and never
 * returned by list endpoints; revealing one is a deliberate, audited action
 * restricted to admins. Deletion is immediate and irreversible.
 *
 * Backups deliberately do NOT carry credential ciphertext: a backup restored
 * onto a different MASTER_KEY could not decrypt them anyway, so the operator
 * re-enters secrets instead of copying an unreadable blob around.
 */
import crypto from 'node:crypto';
import {encryptJson, decryptJson} from './vault.js';

const now = () => new Date().toISOString();

export function fail(message, status = 400) { throw Object.assign(new Error(message), {status}); }

export function addCredential(store, workspaceId, {name, kind, value, expiresAt, createdBy}) {
  const label = String(name || '').trim();
  if (!label || label.length > 120) fail('Credential name is required (max 120 characters).');
  if (String(kind || '').trim().length > 60) fail('Credential kind is too long.');
  if (typeof value !== 'string' || !value) fail('Credential value is required.');
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) fail('Expiry must be a valid date.', 400);
  if (expiresAt && Date.parse(expiresAt) < Date.now()) fail('Expiry must be in the future.', 400);
  const id = crypto.randomUUID();
  const {ciphertext, iv, tag} = encryptJson(store.vaultKey, {value});
  store.run('INSERT INTO credentials (id,workspace_id,name,kind,ciphertext,iv,tag,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, workspaceId, label, String(kind || 'secret'), ciphertext, iv, tag, createdBy || null, now(), expiresAt ? new Date(expiresAt).toISOString() : null);
  return {ok: true, id};
}

/** Metadata-only listing. The ciphertext columns are never selected. */
export function listCredentials(store, workspaceId) {
  return store.all(
    `SELECT id,name,kind,created_by,created_at,expires_at FROM credentials WHERE workspace_id=? ORDER BY created_at DESC`, workspaceId)
    .map(c => ({
      id: c.id, name: c.name, kind: c.kind, createdBy: c.created_by, createdAt: c.created_at,
      expiresAt: c.expires_at,
      expired: c.expires_at ? Date.parse(c.expires_at) < Date.now() : false,
      expiringSoon: c.expires_at ? Date.parse(c.expires_at) >= Date.now() && Date.parse(c.expires_at) - Date.now() < 7 * 86400000 : false,
    }));
}

/** Decrypt for use. Restricted to admins by the route; the caller records the
 * access in the activity log. */
export function revealCredential(store, workspaceId, id) {
  const row = store.get('SELECT * FROM credentials WHERE id=? AND workspace_id=?', id, workspaceId);
  if (!row) fail('Credential not found.', 404);
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) fail('This credential has expired and was not decrypted.', 410);
  let value;
  try { value = decryptJson(store.vaultKey, {ciphertext: row.ciphertext, iv: row.iv, tag: row.tag}).value; }
  catch { fail('This credential cannot be decrypted with the current MASTER_KEY.', 500); }
  return {id, name: row.name, kind: row.kind, value};
}

export function deleteCredential(store, workspaceId, id) {
  const result = store.run('DELETE FROM credentials WHERE id=? AND workspace_id=?', id, workspaceId);
  if (result.changes === 0) fail('Credential not found.', 404);
  return {ok: true};
}
