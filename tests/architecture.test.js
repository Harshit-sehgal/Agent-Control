/** The rules that keep the module graph honest.
 *
 * These are not about behaviour: they are the properties that made the last
 * round of work safe. Each one is cheap to state and expensive to rediscover:
 * a browser module that starts importing a Node builtin breaks the Pages
 * bundle, a cycle makes load order load-bearing, an orphan module is dead code
 * nobody dares delete, and a write shape that drifts from the schema fails at
 * the first write instead of at review time.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {openStore, TABLE_SHAPES} from '../src/sqlite-store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const modulesIn = dir => fs.readdirSync(path.join(root, dir)).filter(f => f.endsWith('.js')).map(f => `${dir}/${f}`);

/** Every module a file imports by relative path, normalised to a repo path. */
function importsOf(file) {
  const out = [];
  for (const [, a, b] of read(file).matchAll(/(?:from\s+|import\s+)'([^']+)'/g)) {
    const spec = a || b;
    if (!spec?.startsWith('.')) continue;
    out.push(path.normalize(path.join(path.dirname(file), spec)));
  }
  return out;
}

test('shared/ stays browser-safe: no Node builtins, no server imports', () => {
  for (const file of modulesIn('shared')) {
    const text = read(file);
    assert.doesNotMatch(text, /from 'node:/, `${file} must not import a Node builtin`);
    assert.doesNotMatch(text, /from '\.\.\/src\//, `${file} must not import the server`);
    assert.doesNotMatch(text, /process\.env/, `${file} must not read the server environment`);
  }
});

test('no import cycle makes load order load-bearing', () => {
  const files = [...modulesIn('shared'), ...modulesIn('src')];
  const graph = new Map(files.map(file => [file, importsOf(file).filter(dep => files.includes(dep))]));
  const state = new Map(), cycles = [];
  const visit = (file, stack) => {
    state.set(file, 1);
    for (const dep of graph.get(file) || []) {
      if (state.get(dep) === 1) cycles.push([...stack, file, dep].join(' -> '));
      else if (!state.get(dep)) visit(dep, [...stack, file]);
    }
    state.set(file, 2);
  };
  for (const file of files) if (!state.get(file)) visit(file, []);
  assert.deepEqual(cycles, []);
});

test('every server module is reachable from the entry point', () => {
  const reached = new Set();
  const walk = file => {
    if (reached.has(file) || !fs.existsSync(path.join(root, file))) return;
    reached.add(file);
    for (const dep of importsOf(file)) if (dep.startsWith('src/')) walk(dep);
  };
  walk('src/server.js');
  const orphans = modulesIn('src').filter(file => !reached.has(file));
  assert.deepEqual(orphans, [], 'a module nothing imports is dead code, not a feature');
});

test('each write shape matches the table it writes', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-shape-'));
  const store = await openStore(path.join(dir, 'state.json'));
  try {
    for (const shape of TABLE_SHAPES) {
      const info = store.all(`PRAGMA table_info(${shape.table})`);
      assert.deepEqual(info.map(column => column.name).sort(), [...shape.columns].sort(),
        `${shape.table}: the write columns and the schema must agree`);
      const primary = info.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
      assert.deepEqual(primary, shape.pk, `${shape.table}: the declared primary key must be the table's`);
      assert.ok(store.db.prepare(`SELECT count(*) AS n FROM ${shape.table}`), `${shape.table} exists`);
    }
  } finally {
    await store.close();
    await fsp.rm(dir, {recursive: true, force: true});
  }
});
