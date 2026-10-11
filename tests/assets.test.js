import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sharedDir=path.join(root,'shared');
// The modules the browser starts from (index.html script tags). Everything they
// import, transitively, must be reachable or the UI dies on a bare 404.
const entries=['app.js','local-api.js','transport.js'];

async function browserModules(){
  const present=new Set(await readdir(sharedDir));
  const needed=new Set(),queue=[...entries];
  while(queue.length){
    const name=queue.pop();
    if(!name.endsWith('.js')||!present.has(name)||needed.has(name))continue;
    needed.add(name);
    const source=await readFile(path.join(sharedDir,name),'utf8');
    for(const match of source.matchAll(/(?:import|export)[^'"]*?from\s*['"]\.\/([\w.-]+\.js)['"]/g))queue.push(match[1]);
  }
  return [...needed];
}

test('every browser module is shipped by both the Pages build and the Node server',async()=>{
  const needed=await browserModules();
  assert.ok(needed.includes('app.js'),'closure walk found no entry modules');
  assert.ok(needed.includes('contracts.js'),'sanity: the closure must reach nested imports');

  const build=await readFile(path.join(root,'scripts','build-pages.js'),'utf8');
  const buildBlock=/const files\s*=\s*\[([\s\S]*?)\]/.exec(build);
  assert.ok(buildBlock,'could not find the `files` array in scripts/build-pages.js');
  const buildList=new Set([...buildBlock[1].matchAll(/['"]([\w.-]+\.js)['"]/g)].map(m=>m[1]));

  const server=await readFile(path.join(root,'src','server.js'),'utf8');
  const assetsBlock=/const ASSETS\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(server);
  assert.ok(assetsBlock,'could not find the ASSETS set in src/server.js');
  const assets=new Set([...assetsBlock[1].matchAll(/['"]([\w.-]+\.js)['"]/g)].map(m=>m[1]));

  for(const name of needed){
    assert.ok(buildList.has(name),`${name} is imported by the UI but missing from scripts/build-pages.js`);
    assert.ok(assets.has(name),`${name} is imported by the UI but missing from the server ASSETS set`);
  }
});
