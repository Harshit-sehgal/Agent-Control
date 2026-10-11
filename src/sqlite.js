/** Loader for `node:sqlite`. Node 23.4+ ships it unflagged; Node 22 requires
 * `--experimental-sqlite`. Rather than raising the documented minimum version,
 * detect the failure once and re-exec the process with the flag (guarded by an
 * env marker so a genuinely broken runtime fails with a clear message instead
 * of an exec loop). */
let cached = null;

export async function sqlite() {
  if (cached) return cached;
  try {
    cached = await import('node:sqlite');
    return cached;
  } catch (err) {
    if (process.env.AGENT_SQLITE_REEXEC) {
      throw new Error('node:sqlite is unavailable on this runtime, even with --experimental-sqlite. Node 22.5+ is required.');
    }
    const {spawn} = await import('node:child_process');
    const child = spawn(
      process.execPath,
      ['--experimental-sqlite', ...process.execArgv, ...process.argv.slice(1)],
      {stdio: 'inherit', env: {...process.env, AGENT_SQLITE_REEXEC: '1'}},
    );
    // Keep this process parked until the child exits so the caller never
    // continues with a broken database handle.
    child.on('exit', code => process.exit(code ?? 1));
    await new Promise(() => {});
  }
}
