/** The lock one process holds on this computer's pairing and browser jars: a running agent, or a `pair`.
 *
 * A pair re-keys the jars and replaces the secret; a run saves jars under the secret it loaded. They must never overlap,
 * so each holds `<config>.lock` while it works. The file is created whole with `wx` (no hard links are needed, so it
 * works on any filesystem) holding `{pid, token, at}`, and the holder refreshes its time while it runs.
 *
 * A lock is stale, and replaced, when its process is the one asking (an agent in a container restarts with the same pid),
 * when its process is gone, or when it was not refreshed for two minutes (the pid belongs to something else now). A lock
 * with no readable pid is a maker caught mid-write while it is younger than ten seconds, and stale after. The token read
 * back after a replacement says whether this process is the one that won.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export const STALE_MS = 120000, YOUNG_MS = 10000, REFRESH_MS = 30000;

export const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** `<config>.lock`, named from the config's real path when it exists, so a link and its target share one lock. */
export function lockFileFor(configPath) {
  let real = configPath;
  try { real = fs.realpathSync(configPath); } catch {}
  return `${real}.lock`;
}

const UNAVAILABLE = new Set(['EROFS', 'EACCES', 'EPERM', 'ENOENT']);

function create(file, pid, now) {
  const token = crypto.randomBytes(16).toString('hex');
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify({pid, token, at: now()}));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return token;
}

/** The lock on disk now: `{text, pid, token, age}`, or null when there is none. */
function inspect(file, now) {
  let text, stat;
  try { text = fs.readFileSync(file, 'utf8'); stat = fs.statSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  let body = null;
  try { body = JSON.parse(text); } catch {}
  const pid = body && Number.isInteger(body.pid) && body.pid > 0 ? body.pid : null;
  return {text, pid, token: typeof body?.token === 'string' ? body.token : null, age: now() - stat.mtimeMs};
}

function stale(seen, pid, alive) {
  if (!seen.pid) return seen.age >= YOUNG_MS;
  return seen.pid === pid || !alive(seen.pid) || seen.age > STALE_MS;
}

/** `{status: 'taken', lock}`, `{status: 'held'}` (another live process has it) or `{status: 'unavailable', code}`
 * (the folder cannot be written: the caller decides whether that matters). */
export function takeLock(file, {pid = process.pid, now = Date.now, alive = processAlive} = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const token = create(file, pid, now);
      // Read back: a replacement that raced another replacement is won by exactly one of them.
      if (inspect(file, now)?.token !== token) return {status: 'held'};
      return {status: 'taken', lock: {file, token}};
    } catch (e) {
      if (UNAVAILABLE.has(e.code) && e.code !== 'EEXIST') return {status: 'unavailable', code: e.code};
      if (e.code !== 'EEXIST') throw e;
    }
    const seen = inspect(file, now);
    if (seen && !stale(seen, pid, alive)) return {status: 'held'};
    // Stale: removed only if it is still the one that was judged.
    if (seen && inspect(file, now)?.text === seen.text) { try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
  }
  return {status: 'held'};
}

const mine = lock => lock && inspect(lock.file, Date.now)?.token === lock.token;

/** Marks the lock as alive. Nothing is done to a lock another process has replaced. */
export function refreshLock(lock) {
  try { if (mine(lock)) { const at = new Date(); fs.utimesSync(lock.file, at, at); } } catch {}
}

/** Gives the lock back, when it is still this process's. */
export function releaseLock(lock) {
  try { if (mine(lock)) fs.unlinkSync(lock.file); } catch {}
}
