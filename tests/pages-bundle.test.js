import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,access} from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ASSETS} from '../shared/assets.js';
import {stampDocument, stampImports} from '../scripts/pages-rewrites.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shared = path.join(root, 'shared');
const docs = path.join(root, 'docs');

// The bundle file list is the one registry both readers import, so this test
// can never disagree with `npm run build:pages` about what ships to Pages.
const bundleFiles = ASSETS;
assert.ok(bundleFiles.includes('index.html') && bundleFiles.includes('app.js'), 'Unexpected bundle file list.');

/** scripts/build-pages.js is a top-level-await script, so importing it would
 * run the build. This is its `bundleVersion` copied verbatim: sha256 over
 * `name` + bytes for every `.js`/`.css` asset, sorted, first 10 hex chars.
 * If that function changes, this must change with it — and the build output
 * comparison below is what catches a mismatch. */
async function hashOf(dir, names) {
  const hash = crypto.createHash('sha256');
  for (const name of names.slice().sort()) hash.update(name).update(await readFile(path.join(dir, name)));
  return hash.digest('hex').slice(0, 10);
}

const hashed = bundleFiles.filter(f => /\.(js|css)$/.test(f));
const version = await hashOf(shared, hashed);
/** The hash the shipped copies were stamped from: the docs bytes with the
 * `?v=<10 hex>` suffixes removed again, i.e. the build's own inverse. This is
 * independent of whether docs/ is current (test 1 owns that), so the stamping
 * test can prove the suffixes are a content hash and not a constant. */
const unstamp = body => body.replace(/\?v=[0-9a-f]{10}/g, '');
const shippedVersion = await (async () => {
  const hash = crypto.createHash('sha256');
  for (const name of hashed.slice().sort()) hash.update(name).update(unstamp(await readFile(path.join(docs, name), 'utf8')));
  return hash.digest('hex').slice(0, 10);
})();

/** What `npm run build:pages` must write for one asset, from the source bytes.
 * Compared with docs/ byte for byte, so a stale `?v=` hash is a failure rather
 * than something a normaliser can hide. Mirrors the two rewrites in the build:
 * the backend marker swap, then `?v=<hash>` on href/src and on relative imports. */
function buildLike(name, source) {
  // The build's own rewrites, imported rather than copied: two regexes with the
  // same blind spot would let a module ship unstamped and still pass.
  if (name === 'index.html') {
    const marked = source.replace('<meta name="agent-backend" content="server">', '<meta name="agent-backend" content="static">');
    return stampDocument(marked, version);
  }
  if (name.endsWith('.js')) return stampImports(source, version);
  return source;
}

test('the shipped docs/ Pages bundle is exactly what the build would write (no drift)', async () => {
  for (const name of bundleFiles) {
    const [src, built] = await Promise.all([
      readFile(path.join(shared, name), 'utf8'),
      readFile(path.join(docs, name), 'utf8'),
    ]);
    assert.equal(built, buildLike(name, src), `${name} is stale: run "npm run build:pages"`);
  }
});

test('the cache-busting version is the real content hash of the shipped assets', async () => {
  // A normalised comparison used to strip `?v=<hex>` before diffing, which made
  // the hash unfalsifiable: any value passed. Every stamp must equal the hash
  // this test computes from shared/ itself.
  assert.match(version, /^[0-9a-f]{10}$/, 'bundleVersion must produce a 10-char hex hash');
  assert.match(shippedVersion, /^[0-9a-f]{10}$/);
  const index = await readFile(path.join(docs, 'index.html'), 'utf8');
  const stamps = [...index.matchAll(/\?v=([0-9a-f]+)/g)].map(m => m[1]);
  assert.ok(stamps.length >= 3, `docs/index.html must stamp its script and link tags, found ${stamps.length}`);
  for (const stamp of stamps) assert.equal(stamp, shippedVersion, 'a stamp in docs/index.html does not match the bytes shipped beside it');

  const modules = bundleFiles.filter(f => f.endsWith('.js'));
  for (const name of modules) {
    const body = await readFile(path.join(docs, name), 'utf8');
    for (const match of body.matchAll(/\?v=([0-9a-f]+)/g)) {
      assert.equal(match[1], shippedVersion, `${name} carries an import stamp that does not match the shipped bytes`);
    }
  }
  // A module with relative imports and no stamp would be cached across deploys.
  const withImports = [];
  for (const name of modules) {
    const src = await readFile(path.join(shared, name), 'utf8');
    if (/(?:from|import)\s*['"]\.\/[\w-]+\.js['"]/.test(src)) withImports.push(name);
  }
  assert.ok(withImports.length > 0, 'sanity: the closure has relative imports to stamp');
  for (const name of withImports) {
    const body = await readFile(path.join(docs, name), 'utf8');
    assert.match(body, new RegExp(`\\?v=${shippedVersion}`), `${name} must stamp its relative imports`);
  }
});

test('docs/ holds no generated file the asset list does not name', async () => {
  // Hand-written docs (markdown) and images are authored, not generated; every
  // other non-hidden file in docs/ is a copy of shared/ and must be in ASSETS.
  const authored = name => name.endsWith('.md') || /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(name);
  const entries = await readdir(docs, {withFileTypes: true});
  const copied = entries
    .filter(e => e.isFile() && !e.name.startsWith('.') && !authored(e.name))
    .map(e => e.name)
    .sort();
  const expected = bundleFiles.filter(name => !authored(name)).sort();
  const extra = copied.filter(name => !expected.includes(name));
  const missing = expected.filter(name => !copied.includes(name));
  assert.deepEqual(extra, [], `docs/ has generated files shared/assets.js does not name: ${extra.join(', ')}`);
  assert.deepEqual(missing, [], `docs/ is missing shipped assets: ${missing.join(', ')}`);
});

test('the Pages bundle keeps its Jekyll bypass marker', async () => {
  await access(path.join(docs, '.nojekyll'));
});

test('the Pages index is marked browser-local and cache-busted', async () => {
  const built = await readFile(path.join(docs, 'index.html'), 'utf8');
  assert.match(built, /<meta name="agent-backend" content="static">/,
    'the Pages copy must not ask a local agent backend for data');
  // Present, uniform and on every tag; whether the stamp is current is test 1.
  const stamps = [...built.matchAll(/\.\/[\w-]+\.(?:js|css)\?v=([0-9a-f]{10})/g)].map(m => m[1]);
  assert.ok(stamps.length >= 3, `expected a stamp on every script/link tag, found ${stamps.length}`);
  assert.equal(new Set(stamps).size, 1, 'every tag in the index must carry the same version');
  assert.match(built, /\.\/app\.js\?v=[0-9a-f]{10}/);
});

test('every kind of local module and tag gets a cache-busting suffix', () => {
  // The old regexes only matched `./<word>.js`, and the test used the same
  // pattern, so a subdirectory or dotted module shipped stale and passed.
  assert.equal(stampImports("import {a} from './ui/x.js';", 'abc1234567'), "import {a} from './ui/x.js?v=abc1234567';");
  assert.equal(stampImports("import './ui-kit.v2.js';", 'abc1234567'), "import './ui-kit.v2.js?v=abc1234567';");
  assert.equal(stampDocument('<script src="./app.js"></script>', 'abc1234567'), '<script src="./app.js?v=abc1234567"></script>');
  assert.equal(stampDocument('<link href="app.css">', 'abc1234567'), '<link href="app.css?v=abc1234567">');
  // An absolute URL is not a local asset and must keep its own cache semantics.
  assert.equal(stampDocument('<script src="https://cdn.example.com/x.js"></script>', 'abc1234567'), '<script src="https://cdn.example.com/x.js"></script>');
});
