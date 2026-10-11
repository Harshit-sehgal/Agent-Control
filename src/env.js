/** Zero-dependency `.env` loading, imported by src/server.js before anything
 * reads `process.env`. Real environment variables always win, so
 * `AI_API_KEY=… npm start` still overrides the file. Set AGENT_SKIP_DOTENV=1 to
 * opt out (tests use this to stay hermetic against a developer's local setup).
 *
 * This is deliberately minimal: `export`-style expansion and multi-line values
 * are not supported, because they invite subtle injection into the process
 * environment of a dashboard that holds AI keys.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Parse dotenv text into an ordered list of entries. Exported for tests. */
export function parseDotEnv(text) {
  const out = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    // Strip one layer of matching quotes; `"a#b"` keeps its hash, bare `a#b`
    // does not get comment-stripped mid-value, matching common dotenv behavior.
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    out.push([key, value]);
  }
  return out;
}

/** Load `<root>/.env` into process.env without overwriting existing values. */
export function loadDotEnv(root = ROOT) {
  if (process.env.AGENT_SKIP_DOTENV === '1') return {loaded: 0};
  let text;
  try { text = fs.readFileSync(path.join(root, '.env'), 'utf8'); }
  catch (e) {
    if (e && e.code !== 'ENOENT') console.warn(`WARNING: could not read .env (${e.message}); continuing without it.`);
    return {loaded: 0};
  }
  let loaded = 0;
  for (const [key, value] of parseDotEnv(text)) {
    if (process.env[key] === undefined) { process.env[key] = value; loaded++; }
  }
  return {loaded};
}

const result = loadDotEnv();
if (result.loaded) console.log(`Loaded ${result.loaded} setting(s) from .env (real environment variables take precedence).`);
