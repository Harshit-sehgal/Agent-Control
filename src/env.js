/** `.env` loading, imported by src/server.js before anything reads
 * `process.env`.
 *
 * The parser is Node's own (`process.loadEnvFile`, built in since 20.12): quote
 * handling and multi-line values are its semantics now, not a hand-rolled
 * approximation that invited subtle injection into the environment of a
 * dashboard that holds AI keys. Two behaviours are ours and are load-bearing:
 *
 * - Real environment variables win, so `AI_API_KEY=… npm start` still overrides
 *   the file. The native loader does not overwrite either, but the snapshot and
 *   restore below make that a guarantee of this module rather than a detail of
 *   the current Node release.
 * - `AGENT_SKIP_DOTENV=1` skips loading entirely, so the test suite stays
 *   hermetic against a developer's local `.env`.
 */
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Load `<root>/.env` into process.env without overwriting existing values.
 * Returns how many settings the file actually contributed. */
export function loadDotEnv(root = ROOT) {
  if (process.env.AGENT_SKIP_DOTENV === '1') return {loaded: 0};
  // A copy, not a live view: process.env is mutated in place by the loader.
  const before = {...process.env};
  try {
    process.loadEnvFile(path.join(root, '.env'));
  } catch (e) {
    // No `.env` is the normal case for a deployment that sets variables in the
    // environment; anything else is worth a warning but must not stop boot.
    if (e?.code !== 'ENOENT') console.warn(`WARNING: could not load .env (${e.message}); continuing without it.`);
    restore(before);
    return {loaded: 0};
  }
  let loaded = 0;
  for (const key of Object.keys(process.env)) {
    if (key in before) {
      if (process.env[key] !== before[key]) process.env[key] = before[key];
    } else loaded++;
  }
  return {loaded};
}

/** Put the environment back the way it was before a failed load. */
function restore(before) {
  for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
  for (const [key, value] of Object.entries(before)) process.env[key] = value;
}

const result = loadDotEnv();
if (result.loaded) console.log(`Loaded ${result.loaded} setting(s) from .env (real environment variables take precedence).`);
