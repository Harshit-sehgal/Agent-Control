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
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'shared');
const dest = path.join(root, 'docs');

/** Stable hash of the bundled asset contents, used to bust browser caches. */
async function bundleVersion(names) {
  const hash = crypto.createHash('sha256');
  for (const name of names.slice().sort()) hash.update(name).update(await fs.readFile(path.join(src, name)));
  return hash.digest('hex').slice(0, 10);
}

// The demo cannot execute the Node coordinators, so it ships only the
// browser-safe modules plus the pages and styles.
const files = [
  'index.html', 'app.css',
  'transport.js', 'local-api.js', 'app.js',
  'ui-kit.js', 'ui-model.js', 'ui-store.js', 'ui-dialogs.js', 'ui-chat.js', 'ui-views.js', 'ui-panel.js', 'ui-sheets.js', 'ui-admin.js', 'ui-actions.js', 'ui-fx.js',
  'core.js', 'workflow.js', 'tasks.js', 'evidence.js', 'contracts.js', 'retention.js',
  'coordination.js', 'chats.js', 'group-simulator.js',
  'chat-engine.js', 'usability.js', 'demo-feed.html',
];
// Files that used to live in docs/ before the UI moved to shared/.
const stale = ['polish.css', 'usability.css', 'demo-api.js', 'app.css.map', 'usability.mjs', 'coordination.mjs', 'group-simulator.mjs', 'chat-engine.mjs'];

await fs.mkdir(dest, {recursive: true});
const copied = [];
for (const name of files) {
  await fs.copyFile(path.join(src, name), path.join(dest, name));
  copied.push(name);
}
for (const name of stale) {
  try { await fs.rm(path.join(dest, name)); } catch { /* Already gone. */ }
}
// Mark the copied page as browser-local so transport.js uses localStorage
// instead of trying to reach an /api that does not exist on static hosting.
const indexPath = path.join(dest, 'index.html');
const marked = (await fs.readFile(indexPath, 'utf8')).replace('<meta name="agent-backend" content="server">', '<meta name="agent-backend" content="static">');
await fs.writeFile(indexPath, marked);

// Cache-bust the browser-local assets with a content hash so a returning
// visitor cannot keep a stale bundle after a deploy.
const version = await bundleVersion(files.filter(f => /\.(js|css)$/.test(f)));
const stamped = marked.replace(/(href|src)="(\.\/[^"?]+\.(?:js|css))"/g, (_, attr, url) => `${attr}="${url}?v=${version}"`);
await fs.writeFile(indexPath, stamped);

// Relative ES module imports must carry the same version, otherwise a browser
// can serve a cached older module while the entry point is fresh.
for (const name of files.filter(f => f.endsWith('.js'))) {
  const file = path.join(dest, name);
  const body = (await fs.readFile(file, 'utf8')).replace(/((?:from|import)\s*)(['"])(\.\/[\w-]+\.js)\2/g, (_, kw, quote, url) => `${kw}${quote}${url}?v=${version}${quote}`);
  await fs.writeFile(file, body);
}
// Prevent Jekyll from stripping files that start with an underscore.
await fs.writeFile(path.join(dest, '.nojekyll'), '');
copied.push('.nojekyll');
console.log(`Pages build: ${copied.length} files written to docs/ from shared/.`);