/** Multi-user authentication and authorization.
 *
 * The prototype was single-user: one shared password checked against an
 * in-memory session map. The roadmap's cloud control plane needs real
 * identities, revocable server-side sessions, password resets, and
 * workspace-scoped roles, so all of that now lives in SQLite behind this
 * module. `/api/login` keeps working: first boot bootstraps an owner account
 * from DASHBOARD_PASSWORD so existing installs and tests are unaffected.
 *
 * Zero dependencies: passwords use node:crypto scrypt, sessions and reset
 * tokens are random ids stored only as SHA-256 hashes.
 */
import crypto from 'node:crypto';

export const ROLES = ['viewer', 'member', 'admin', 'owner'];
export const DEFAULT_WORKSPACE = 'default';
const OWNER_EMAIL = 'owner@localhost';
const SESSION_TTL_MS = 7 * 86400000;
const RESET_TTL_MS = 3600000;
const SCRYPT = {N: 16384, r: 8, p: 1};

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const now = () => new Date().toISOString();
const rank = role => Math.max(0, ROLES.indexOf(role));

const hashPassword = password => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT).toString('hex');
  return `scrypt$${SCRYPT.N}$${salt}$${hash}`;
};
const verifyPassword = (password, stored) => {
  const [scheme, n, salt, hash] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const actual = crypto.scryptSync(String(password), salt, 64, {...SCRYPT, N: Number(n) || SCRYPT.N});
  return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
};
// Verified against when the address is unknown, to spend the same time.
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));
export const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || '').trim());

export class Auth {
  constructor(store) { this.store = store; }
  /** Create the owner account and default workspace on a brand-new install. */
  ensureBootstrap(password) {
    if (this.store.get('SELECT id FROM users LIMIT 1')) return;
    const id = crypto.randomUUID();
    this.store.transaction(() => {
      this.store.run('INSERT INTO users (id,email,password_hash,created_at,verified_at) VALUES (?,?,?,?,?)', id, OWNER_EMAIL, hashPassword(password), now(), now());
      this.store.run('INSERT OR IGNORE INTO workspaces (id,name,created_at) VALUES (?,?,?)', DEFAULT_WORKSPACE, 'Primary workspace', now());
      this.store.run('INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)', DEFAULT_WORKSPACE, id, 'owner', now());
    });
  }
  /** @returns {{ok:true,user,role,sessionId} | {ok:false,error,status}} */
  login({email, password}, {ip, userAgent} = {}) {
    // Omitting the email keeps the single-owner behavior of the prototype:
    // one shared password for the bootstrapped owner account.
    const mail = String(email || OWNER_EMAIL).trim().toLowerCase();
    const row = this.store.get('SELECT * FROM users WHERE email=?', mail);
    // One answer for an unknown address, a wrong password and a disabled
    // account, after the same amount of work, so sign-in cannot be used to
    // find out which addresses have accounts.
    const refused = {ok: false, error: 'Incorrect email or password.', status: 401};
    if (!verifyPassword(password, row ? row.password_hash : DUMMY_HASH) || !row) return refused;
    if (row.disabled_at) return {ok: false, error: 'Account disabled.', status: 403};
    // The cookie holds the id; the table holds only its hash, so neither the
    // database file nor the sessions list can be replayed as a login.
    const sessionId = crypto.randomBytes(32).toString('hex');
    this.store.run('INSERT INTO sessions (id,user_id,created_at,expires_at,ip,user_agent) VALUES (?,?,?,?,?,?)',
      sha256(sessionId), row.id, now(), new Date(Date.now() + SESSION_TTL_MS).toISOString(), ip || null, String(userAgent || '').slice(0, 200));
    return {ok: true, userId: row.id, user: {id: row.id, email: row.email}, role: this.roleOf(row.id), sessionId};
  }
  /** Resolve the cookie's session id to a live principal, or null. The
   * principal's `sessionId` is the stored handle (the hash), not the cookie. */
  session(cookieId) {
    if (!cookieId) return null;
    const sessionId = sha256(cookieId);
    const row = this.store.get(
      `SELECT s.id AS sid, s.expires_at, u.id, u.email, u.disabled_at
       FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=? AND s.revoked_at IS NULL`, sessionId);
    if (!row || Date.parse(row.expires_at) < Date.now()) return null;
    if (row.disabled_at) return null;
    return {userId: row.id, email: row.email, sessionId: row.sid, role: this.roleOf(row.id)};
  }
  roleOf(userId) {
    const row = this.store.get('SELECT role FROM workspace_members WHERE user_id=? AND workspace_id=?', userId, DEFAULT_WORKSPACE);
    return row?.role || 'viewer';
  }
  logout(cookieId) { if (cookieId) this.store.run('UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL', now(), sha256(cookieId)); }
  listSessions(userId) {
    return this.store.all(
      `SELECT id, created_at, expires_at, ip, user_agent FROM sessions
       WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC`,
      userId, new Date().toISOString()).map(r => ({id: r.id, createdAt: r.created_at, expiresAt: r.expires_at, ip: r.ip, userAgent: r.user_agent, current: false}));
  }
  revokeSession(userId, sessionId) {
    const row = this.store.get('SELECT user_id FROM sessions WHERE id=? AND revoked_at IS NULL', sessionId);
    if (!row) return false;
    if (row.user_id !== userId) throw Object.assign(new Error('That session belongs to another account.'), {status: 403});
    this.store.run('UPDATE sessions SET revoked_at=? WHERE id=?', now(), sessionId);
    return true;
  }
  revokeAll(userId, keepSessionId) {
    this.store.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL AND id<>?', now(), userId, keepSessionId || '');
  }
  listUsers() {
    return this.store.all(
      `SELECT u.id, u.email, u.disabled_at, u.created_at, m.role
       FROM users u LEFT JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=?
       ORDER BY u.created_at`, DEFAULT_WORKSPACE)
      .map(u => ({id: u.id, email: u.email, role: u.role || 'viewer', disabled: Boolean(u.disabled_at), createdAt: u.created_at}));
  }
  createUser(actor, {email, password, role}) {
    if (rank(actor.role) < rank('admin')) throw Object.assign(new Error('Only admins can invite users.'), {status: 403});
    const mail = String(email || '').trim().toLowerCase();
    if (!validEmail(mail)) throw Object.assign(new Error('Enter a valid email address.'), {status: 400});
    if (this.store.get('SELECT id FROM users WHERE email=?', mail)) throw Object.assign(new Error('That email already has an account.'), {status: 409});
    const next = ROLES.includes(role) ? role : 'member';
    if (rank(next) >= rank(actor.role)) throw Object.assign(new Error('You cannot grant a role at or above your own.'), {status: 403});
    if (String(password || '').length < 8) throw Object.assign(new Error('Password must be at least 8 characters.'), {status: 400});
    const id = crypto.randomUUID();
    this.store.transaction(() => {
      this.store.run('INSERT INTO users (id,email,password_hash,created_at,verified_at) VALUES (?,?,?,?,?)', id, mail, hashPassword(password), now(), now());
      this.store.run('INSERT INTO workspace_members (workspace_id,user_id,role,created_at) VALUES (?,?,?,?)', DEFAULT_WORKSPACE, id, next, now());
    });
    return {id, email: mail, role: next};
  }
  updateUser(actor, userId, body) {
    if (rank(actor.role) < rank('admin')) throw Object.assign(new Error('Only admins can change users.'), {status: 403});
    const target = this.store.get('SELECT u.id, m.role FROM users u JOIN workspace_members m ON m.user_id=u.id WHERE u.id=? AND m.workspace_id=?', userId, DEFAULT_WORKSPACE);
    if (!target) throw Object.assign(new Error('User not found.'), {status: 404});
    if (rank(target.role) >= rank(actor.role) && target.id !== actor.userId) throw Object.assign(new Error('You cannot change a user at or above your own role.'), {status: 403});
    if (body.role !== undefined) {
      if (!ROLES.includes(body.role)) throw Object.assign(new Error('Unknown role.'), {status: 400});
      if (rank(body.role) >= rank(actor.role)) throw Object.assign(new Error('You cannot grant a role at or above your own.'), {status: 403});
      this.store.run('UPDATE workspace_members SET role=? WHERE user_id=? AND workspace_id=?', body.role, userId, DEFAULT_WORKSPACE);
    }
    if (body.disabled === true) {
      if (target.id === actor.userId) throw Object.assign(new Error('You cannot disable your own account.'), {status: 409});
      this.store.run('UPDATE users SET disabled_at=? WHERE id=?', now(), userId);
      this.store.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', now(), userId);
    }
    if (body.disabled === false) this.store.run('UPDATE users SET disabled_at=NULL WHERE id=?', userId);
    return this.listUsers().find(u => u.id === userId);
  }
  deleteUser(actor, userId) {
    if (rank(actor.role) < rank('admin')) throw Object.assign(new Error('Only admins can remove users.'), {status: 403});
    if (userId === actor.userId) throw Object.assign(new Error('Use account deletion to remove your own account.'), {status: 409});
    const target = this.store.get('SELECT m.role FROM workspace_members m WHERE m.user_id=? AND m.workspace_id=?', userId, DEFAULT_WORKSPACE);
    if (!target) throw Object.assign(new Error('User not found.'), {status: 404});
    if (rank(target.role) >= rank(actor.role)) throw Object.assign(new Error('You cannot remove a user at or above your own role.'), {status: 403});
    this.store.transaction(() => {
      this.store.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', now(), userId);
      this.store.run('DELETE FROM notification_prefs WHERE user_id=?', userId);
      this.store.run('DELETE FROM notifications WHERE user_id=?', userId);
      this.store.run('DELETE FROM workspace_members WHERE user_id=?', userId);
      this.store.run('DELETE FROM password_resets WHERE user_id=?', userId);
      this.store.run('DELETE FROM users WHERE id=?', userId);
    });
    return {ok: true};
  }
  /** Issue a single-use reset token. Returns null when the address is unknown
   * so the response cannot be used to enumerate accounts. */
  requestPasswordReset(email) {
    const mail = String(email || '').trim().toLowerCase();
    const user = this.store.get('SELECT id FROM users WHERE email=?', mail);
    if (!user) return null;
    const token = crypto.randomBytes(32).toString('base64url');
    // A stale token for the same user must not linger and remain valid after
    // a newer one was issued.
    this.store.run('DELETE FROM password_resets WHERE user_id=?', user.id);
    this.store.run('INSERT INTO password_resets (token_hash,user_id,expires_at,created_at) VALUES (?,?,?,?)',
      sha256(token), user.id, new Date(Date.now() + RESET_TTL_MS).toISOString(), now());
    return token;
  }
  consumePasswordReset(token, newPassword) {
    const row = this.store.get('SELECT user_id, expires_at, used_at FROM password_resets WHERE token_hash=?', sha256(String(token || '')));
    if (!row || row.used_at) throw Object.assign(new Error('This reset link is not valid.'), {status: 400});
    if (Date.parse(row.expires_at) < Date.now()) throw Object.assign(new Error('This reset link has expired. Request a new one.'), {status: 400});
    if (String(newPassword || '').length < 8) throw Object.assign(new Error('Password must be at least 8 characters.'), {status: 400});
    this.store.transaction(() => {
      this.store.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(newPassword), row.user_id);
      this.store.run('UPDATE password_resets SET used_at=? WHERE token_hash=?', now(), sha256(String(token)));
      // Any session opened with the old password is no longer trustworthy.
      this.store.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', now(), row.user_id);
    });
    return {ok: true};
  }
  /** Change the acting user's own password, invalidating other sessions. */
  changePassword(userId, currentPassword, newPassword) {
    const row = this.store.get('SELECT password_hash FROM users WHERE id=?', userId);
    if (!row) throw Object.assign(new Error('Account not found.'), {status: 404});
    if (!verifyPassword(currentPassword, row.password_hash)) throw Object.assign(new Error('Current password is incorrect.'), {status: 401});
    if (String(newPassword || '').length < 8) throw Object.assign(new Error('Password must be at least 8 characters.'), {status: 400});
    this.store.transaction(() => {
      this.store.run('UPDATE users SET password_hash=? WHERE id=?', hashPassword(newPassword), userId);
      this.store.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', now(), userId);
    });
    return {ok: true};
  }
  /** Delete the acting account and everything only it could see. */
  selfDeleteAccount(userId, password) {
    const row = this.store.get('SELECT password_hash FROM users WHERE id=?', userId);
    if (!row || !verifyPassword(password, row.password_hash)) throw Object.assign(new Error('Password is incorrect.'), {status: 401});
    this.store.transaction(() => {
      this.store.run('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL', now(), userId);
      this.store.run('DELETE FROM notification_prefs WHERE user_id=?', userId);
      this.store.run('DELETE FROM notifications WHERE user_id=?', userId);
      this.store.run('DELETE FROM password_resets WHERE user_id=?', userId);
      this.store.run('DELETE FROM workspace_members WHERE user_id=?', userId);
      this.store.run('DELETE FROM users WHERE id=?', userId);
    });
    return {ok: true};
  }
}

/** Cookie helper and the route guard used by the API. */
export const sessionCookie = (id, {secure = false, maxAge = SESSION_TTL_MS / 1000} = {}) =>
  `agent_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
export const clearCookie = () => 'agent_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0';
