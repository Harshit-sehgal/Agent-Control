import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, readdir} from 'node:fs/promises';
import * as kit from '../shared/ui-kit.js';

// A ui-kit helper used without its import is a ReferenceError that only shows when that
// code path runs: the sign-in layer used `esc` after a cleanup dropped the import, and
// the browser smokes (which never sign in) stayed green. This reads every UI module.
const dir = new URL('../shared/', import.meta.url);
const files = ['app.js', ...(await readdir(dir)).filter(f => /^ui-.+\.js$/.test(f) && f !== 'ui-kit.js')];
const helpers = Object.keys(kit);
const strip = src => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

for (const file of files) {
  test(`${file} imports every ui-kit helper it calls`, async () => {
    const src = strip(await readFile(new URL(file, dir), 'utf8'));
    const imported = new Set([...src.matchAll(/import\s*\{([^}]*)\}\s*from/g)].flatMap(m => m[1].split(',').map(s => s.trim().split(/\s+as\s+/).pop())));
    const declared = new Set([...src.matchAll(/(?:const|let|var|function)\s+(\w+)/g)].map(m => m[1]));
    const missing = helpers.filter(name => !imported.has(name) && !declared.has(name) && new RegExp(`(?<![\\w$.])${name}\\(`).test(src));
    assert.deepEqual(missing, [], `${file} calls ${missing.join(', ')} without importing it from ui-kit.js`);
  });
}
