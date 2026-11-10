/** Set an account's password from the command line.
 *
 * `npm run reset-password -- <email>` takes the new password from
 * DASHBOARD_PASSWORD, or from stdin when that is empty, so it never appears in
 * argv (and therefore in `ps`) or in the shell history. The database path is
 * resolved exactly the way the server resolves it: DATA_FILE, then DATA_DB.
 *
 *   npm run reset-password                      # the owner account
 *   npm run reset-password -- you@example.com
 *
 * The value is never printed. A reset is what a forgotten password, or a
 * DASHBOARD_PASSWORD that was overridden after first boot, needs.
 */
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {hashPassword} from '../src/auth.js';
import {resolveDbPath} from '../src/sqlite-store.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const dataFile = process.env.DATA_FILE || path.join(ROOT, 'data', 'state.json');
const dbPath = resolveDbPath(dataFile);

const email = String(process.argv[2] || '').trim().toLowerCase();

function readPassword() {
  const fromEnv = process.env.DASHBOARD_PASSWORD;
  if (fromEnv) return String(fromEnv);
  if (process.stdin.isTTY) {
    process.stderr.write('New password: ');
    const tty = process.stdin;
    tty.setRawMode?.(true);
    let value = '';
    const buf = Buffer.alloc(1);
    while (true) {
      const n = fs.readSync(0, buf, 0, 1, null);
      if (!n) break;
      const ch = buf.toString('utf8');
      if (ch === '\n' || ch === '\r') break;
      if (ch === '\u0003') process.exit(130);
      if (ch === '\u007f') { value = value.slice(0, -1); continue; }
      value += ch;
    }
    tty.setRawMode?.(false);
    process.stderr.write('\n');
    return value;
  }
  return fs.readFileSync(0, 'utf8').trim();
}

const password = readPassword();
if (String(password).length < 8) {
  console.error('A password of at least 8 characters is required. Set DASHBOARD_PASSWORD or pipe one on stdin.');
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error(`No database at ${dbPath}. Set DATA_FILE/DATA_DB, or start the server once.`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
try {
  const rows = email
    ? db.prepare('SELECT id,email FROM users WHERE lower(email)=?').all(email)
    : db.prepare('SELECT id,email FROM users ORDER BY created_at LIMIT 1').all();
  if (!rows.length) {
    console.error(email ? `No account with that email in ${dbPath}.` : `No account in ${dbPath}.`);
    process.exit(1);
  }
  if (rows.length > 1) {
    console.error('More than one account. Name the address: npm run reset-password -- you@example.com');
    process.exit(1);
  }
  const now = new Date().toISOString();
  db.prepare('UPDATE users SET password_hash=?, disabled_at=NULL WHERE id=?').run(hashPassword(password), rows[0].id);
  // Every other session was opened with the old password; the point of a reset
  // is that they end. The owner's own devices sign in again.
  const ended = db.prepare('DELETE FROM sessions WHERE user_id=?').run(rows[0].id).changes;
  console.log(`Password reset for ${rows[0].email}. ${ended} session(s) ended. Sign in again.`);
} finally {
  db.close();
}
