import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('npm run check syntax-checks every src/ and shared/ module',async()=>{
  // A new source file that is not in the check script ships unvalidated; this
  // guard keeps the check list honest as the roadmap adds modules.
  const pkg=JSON.parse(await readFile(path.join(root,'package.json'),'utf8'));
  const check=pkg.scripts?.check||'';
  const modules=[];
  for(const dir of ['src','shared']){
    for(const name of await readdir(path.join(root,dir))){
      if(name.endsWith('.js'))modules.push(`${dir}/${name}`);
    }
  }
  assert.ok(modules.length>=10,'expected to find source modules');
  const missing=modules.filter(m=>!check.includes(`node --check ${m}`));
  assert.deepEqual(missing,[],`These modules are missing from the check script: ${missing.join(', ')}`);
});
