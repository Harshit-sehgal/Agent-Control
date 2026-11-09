/** Syntax-check every source file (`npm run check`).
 *
 * This used to be a list of 66 `node --check …` calls chained with `&&` in
 * package.json. A new module shipped unchecked unless someone remembered to add
 * it, and `agent/`, `extension/popup.js` and `scripts/` were easy to forget.
 * Walking the roots instead means whatever is on disk is checked.
 *
 * `tests/check-coverage.test.js` imports ROOTS and sourceFiles() and compares
 * them with its own walk, so the walk cannot silently shrink or start skipping
 * an extension. Files that fail keep the old behaviour: the first error stops
 * the run and carries the file name.
 */
import {execFile} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every root that holds JavaScript we ship or run. */
export const ROOTS = ['src', 'shared', 'agent', 'extension', 'scripts'];
export const EXTENSIONS = ['.js', '.mjs'];

async function walk(dir, prefix) {
  const out = [];
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    // A dot directory is editor or tooling state, never source.
    if (entry.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await walk(path.join(dir, entry.name), rel));
    else if (EXTENSIONS.includes(path.extname(entry.name))) out.push(rel);
  }
  return out;
}

/** Every `.js`/`.mjs` file under ROOTS, as root-relative paths, sorted so the
 * output is stable between runs and across machines. */
export async function sourceFiles() {
  const all = [];
  for (const root of ROOTS) all.push(...await walk(path.join(ROOT, root), root));
  return all.sort();
}

/** Run `node --check` on each file, sequentially; the first failure throws with
 * the file name so the terminal shows what to fix instead of an exit code. */
export async function checkSyntax(files = null) {
  const list = files ?? await sourceFiles();
  for (const file of list) {
    try {
      // No `--experimental-sqlite` here: --check parses, it does not execute,
      // so no flag from the runtime scripts is needed.
      await run(process.execPath, ['--check', path.join(ROOT, file)]);
    } catch (error) {
      const detail = (error.stderr || error.message || '').trim();
      throw new Error(`${file}: ${detail}`);
    }
  }
  return list.length;
}

// Only run when invoked as a script; the coverage test imports the two names
// above, and importing must not spawn 70 child processes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const count = await checkSyntax();
    console.log(`Syntax check: ${count} file(s) OK.`);
  } catch (error) {
    console.error(`Syntax check failed: ${error.message}`);
    process.exit(1);
  }
}
