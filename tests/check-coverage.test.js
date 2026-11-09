import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ROOTS,EXTENSIONS,sourceFiles} from '../scripts/check.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Files under the check roots that `npm run check` is allowed not to walk.
 * Keep this empty unless there is a real reason, and write the reason down:
 * every entry is a file whose syntax nothing validates. The comparison below
 * is a set equality, so a new file fails this test either way — either the
 * walker must reach it or it must be named here. */
export const EXCLUDED=[];

/** The filesystem's own answer to "what is source here", independent of the
 * walker in scripts/check.mjs. Dot directories and files are NOT skipped here:
 * the walker does skip them, so this is what proves the exclusions are the
 * documented ones instead of whatever the walker happened to do.
 *
 * The old version of this test only asked for `>= 60` files, so the set could
 * drift in both directions unnoticed: a root or an extension dropped by the
 * walker, or 10 new files nobody syntax-checks. The counts in README.md
 * (hand-kept) had already drifted from reality for the same reason. */
async function walk(dir,prefix){
  const out=[];
  for(const entry of await readdir(dir,{withFileTypes:true})){
    const rel=prefix?`${prefix}/${entry.name}`:entry.name;
    if(entry.isDirectory())out.push(...await walk(path.join(dir,entry.name),rel));
    else if(EXTENSIONS.includes(path.extname(entry.name)))out.push(rel);
  }
  return out;
}

test('npm run check syntax-checks exactly the source files on disk',async()=>{
  // A new source file that is not in the check list ships unvalidated. The check
  // used to be 66 hand-written `node --check` lines, which quietly left
  // agent/, extension/popup.js and scripts/ out; it is now a walk of the roots.
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  assert.equal(pkg.scripts?.check?.trim(),'node scripts/check.mjs','`npm run check` must run the walker');

  // The five roots and two extensions are the contract, not whatever the
  // walker happens to use this week.
  assert.deepEqual([...ROOTS].sort(),['agent','extension','scripts','shared','src']);
  assert.deepEqual([...EXTENSIONS].sort(),['.js','.mjs']);

  const found=[];
  for(const dir of ROOTS)found.push(...await walk(path.join(root,dir),dir));
  const excluded=new Set(EXCLUDED);
  const expected=found.filter(file=>!excluded.has(file)).sort();

  const covered=await sourceFiles();
  const coveredSet=new Set(covered);
  assert.equal(coveredSet.size,covered.length,'scripts/check.mjs walks a file twice');

  const skipped=expected.filter(file=>!coveredSet.has(file));
  const extra=covered.filter(file=>!expected.includes(file));
  assert.deepEqual(skipped,[],`These files exist but npm run check would skip them: ${skipped.join(', ')}\n`+
    'If a file is generated or not ours, add it to EXCLUDED in tests/check-coverage.test.js with a reason; '+
    'otherwise the walker in scripts/check.mjs must reach it (and README.md\'s file count needs updating).');
  assert.deepEqual(extra,[],`scripts/check.mjs reports files that are not on disk: ${extra.join(', ')}`);
  // Pinned to the walker, not to a magic number: adding a source file must not
  // need an edit here, but dropping one from the walk must fail.
  assert.equal(covered.length,expected.length,`expected ${expected.length} checked files, the walker covers ${covered.length}`);
});

test('the walk is stable and ordered',async()=>{
  const files=await sourceFiles();
  assert.deepEqual(files,[...files].sort(),'sourceFiles() must be sorted so the count is reproducible');
  assert.ok(files.length>0,'sourceFiles() found nothing');
  for(const file of files){
    assert.match(file,/^(?:src|shared|agent|extension|scripts)\//,`${file} must be reported root-relative`);
  }
});

test('the roots that used to escape the check are pinned',async()=>{
  // Each of these was missing from the old hand-written list, and every test
  // stayed green while their syntax was unchecked.
  const covered=new Set(await sourceFiles());
  for(const file of ['agent/agent.mjs','agent/net-guard.mjs','agent/browser.mjs','extension/popup.js','scripts/build-pages.js','scripts/backup.mjs','src/server.js','shared/assets.js']){
    assert.ok(covered.has(file),`${file} is not syntax-checked`);
  }
});
