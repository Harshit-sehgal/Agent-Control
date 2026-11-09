import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOTS,EXTENSIONS,sourceFiles} from '../scripts/check.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** The filesystem's own answer to "what is source here", independent of the
 * walker in scripts/check.mjs. If the walker starts skipping a root or an
 * extension, this walk still sees the file and the comparison fails. */
async function walk(dir,prefix){
  const out=[];
  for(const entry of await readdir(dir,{withFileTypes:true})){
    if(entry.name.startsWith('.'))continue;
    const rel=`${prefix}/${entry.name}`;
    if(entry.isDirectory())out.push(...await walk(path.join(dir,entry.name),rel));
    else if(EXTENSIONS.includes(path.extname(entry.name)))out.push(rel);
  }
  return out;
}

test('npm run check syntax-checks every source file, not a hand-kept list',async()=>{
  // A new source file that is not in the check list ships unvalidated. The check
  // used to be 66 hand-written `node --check` lines, which quietly left
  // agent/, extension/popup.js and scripts/ out; it is now a walk of the roots.
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  assert.equal(pkg.scripts?.check?.trim(),'node scripts/check.mjs','`npm run check` must run the walker');

  // The five roots are the contract, not whatever the walker happens to use.
  assert.deepEqual([...ROOTS].sort(),['agent','extension','scripts','shared','src']);
  assert.deepEqual([...EXTENSIONS].sort(),['.js','.mjs']);

  const found=[];
  for(const dir of ROOTS)found.push(...await walk(path.join(root,dir),dir));
  assert.ok(found.length>=60,`expected to find source files, found ${found.length}`);

  const covered=new Set(await sourceFiles());
  const missing=found.filter(file=>!covered.has(file)).sort();
  assert.deepEqual(missing,[],`These files exist but npm run check would skip them: ${missing.join(', ')}`);
});

test('the roots that used to escape the check are pinned',async()=>{
  // Each of these was missing from the old hand-written list, and every test
  // stayed green while their syntax was unchecked.
  const covered=new Set(await sourceFiles());
  for(const file of ['agent/agent.mjs','agent/net-guard.mjs','agent/browser.mjs','extension/popup.js','scripts/build-pages.js','scripts/backup.mjs','src/server.js','shared/assets.js']){
    assert.ok(covered.has(file),`${file} is not syntax-checked`);
  }
});
