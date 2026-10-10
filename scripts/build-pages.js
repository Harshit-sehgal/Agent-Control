/** Build the GitHub Pages bundle.
 *
 * `shared/` is the single source for the UI and the browser-safe logic modules.
 * The Node server serves that same folder directly; the static Pages site needs
 * it copied to `docs/` (the folder Pages publishes). Run `npm run build:pages`
 * after changing anything in `shared/` so the demo does not drift.
 *
 * `docs/COORDINATION.md` and `docs/ROADMAP.md` are authored docs and are left
 * untouched.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'shared');
const dest = path.join(root, 'docs');

// The demo cannot execute the Node coordinators, so it ships only the
// browser-safe modules plus the pages and styles.
const files = [
  'index.html', 'app.css', 'polish.css', 'usability.css',
  'transport.js', 'local-api.js', 'app.js',
  'core.js', 'workflow.js', 'coordination.js', 'group-simulator.js',
  'chat-engine.js', 'usability.js', 'demo-feed.html',
];
// Files that used to live in docs/ before the UI moved to shared/.
const stale = ['demo-api.js', 'app.css.map', 'usability.mjs', 'coordination.mjs', 'group-simulator.mjs', 'chat-engine.mjs'];

await fs.mkdir(dest, {recursive: true});
const copied = [];
for (const name of files) {
  await fs.copyFile(path.join(src, name), path.join(dest, name));
  copied.push(name);
}
for (const name of stale) {
  try { await fs.rm(path.join(dest, name)); } catch { /* Already gone. */ }
}
// Prevent Jekyll from stripping files that start with an underscore.
await fs.writeFile(path.join(dest, '.nojekyll'), '');
copied.push('.nojekyll');
console.log(`Pages build: ${copied.length} files written to docs/ from shared/.`);