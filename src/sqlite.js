/** Loader for `node:sqlite`.
 *
 * Node 23.4+ exposes it unflagged; Node 22 needs `--experimental-sqlite`. Every
 * entry point passes the flag where it matters (`npm start`/`dev`/`test`/
 * `test:coverage`/`backup` and the Dockerfile CMD), so this is a plain cached
 * import. It used to re-exec the process with the flag, which parked the parent
 * forever with no timeout and could not report which runtime was too old.
 *
 * The import is cached because `node:sqlite` is a builtin module object: the
 * second import would resolve from the module registry anyway, and callers may
 * ask more than once per process (a store per workspace).
 */
let cached = null;

export async function sqlite() {
  if (cached) return cached;
  try {
    cached = await import('node:sqlite');
  } catch (error) {
    throw new Error(`node:sqlite is unavailable on this runtime (${error.message}). Run node with --experimental-sqlite; Node 22.5 or newer is required.`, {cause: error});
  }
  return cached;
}
