import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ASSETS} from '../shared/assets.js';

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

  const listed=new Set(ASSETS);
  for(const name of needed){
    assert.ok(listed.has(name),`${name} is imported by the UI but missing from shared/assets.js`);
  }
});

test('the served list names real files, exactly once',async()=>{
  assert.equal(new Set(ASSETS).size,ASSETS.length,'shared/assets.js lists a file twice');
  const present=new Set(await readdir(sharedDir));
  for(const name of ASSETS)assert.ok(present.has(name),`${name} is listed but not in shared/`);
});

test('styles, install assets and the page itself are in the one list',async()=>{
  const listed=new Set(ASSETS);
  for(const name of ['index.html','app.css','manifest.webmanifest','icon-192.png','icon-512.png','demo-feed.html']){
    assert.ok(listed.has(name),`${name} is missing from shared/assets.js`);
  }
  // The list is consumed by a Node build script and by the server, never by the
  // page, so shipping it would be a 404-free way to widen the surface.
  assert.equal(listed.has('assets.js'),false,'shared/assets.js must not list itself');
});

test('both readers import the same list instead of keeping a copy',async()=>{
  // The duplicate is what this test would otherwise have to compare forever.
  for(const file of ['scripts/build-pages.js','src/server.js']){
    const source=await readFile(path.join(root,file),'utf8');
    assert.match(source,/from '\.\.\/shared\/assets\.js'/,`${file} must import shared/assets.js`);
  }
  // shared/ has to stay browser-safe: plain data, no Node builtins.
  const source=await readFile(path.join(sharedDir,'assets.js'),'utf8');
  assert.doesNotMatch(source,/^\s*import\s/m,'shared/assets.js must not import anything');
});
