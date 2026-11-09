import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ASSETS} from '../shared/assets.js';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sharedDir=path.join(root,'shared');

/** Every `<script src>` the page loads, root-relative to shared/.
 *
 * The entry list used to be hardcoded here, so a fourth `<script>` added to
 * index.html shipped unlisted and this test stayed green. The page is the only
 * authority on what the browser starts from, so read it. Inline module scripts
 * are ignored: they cannot be resolved to a file, and the page has none.
 * Absolute/CDN URLs are ignored too — they are not ours to ship. */
export function scriptSources(html){
  const out=[];
  for(const tag of html.match(/<script\b[^>]*>/g)||[]){
    const src=/\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag);
    if(!src) continue;
    const url=src[1].trim().replace(/[?#].*$/,'');
    if(!url||/^(?:[a-z]+:|\/\/)/i.test(url)) continue;
    out.push(url.replace(/^\.\//,''));
  }
  return [...new Set(out)];
}

/** Relative ES module specifiers in one source file: static `from './x.js'`,
 * side-effect `import './x.js'` and dynamic `import('./x.js')`. A bare
 * specifier (`node:fs`, `crypto`) is deliberately not returned — it cannot be
 * resolved against shared/ and is a separate failure, checked below.
 * Optional `?query`/`#hash` suffixes are dropped so a build-time
 * `?v=<hash>` stamp does not change the answer. */
export function relativeImports(source){
  const out=[];
  const patterns=[
    // import … from './x.js' | export … from './x.js' | import './x.js'
    /(?:^|[^\w$.])(?:import|export)\b(?:[^;'"`]*?\bfrom\b)?\s*['"]\.\/([^'"?#\s]+\.m?js)(?:[?#][^'"]*)?['"]/g,
    // const m = await import('./x.js')
    /(?:^|[^\w$.])import\s*\(\s*['"]\.\/([^'"?#\s]+\.m?js)(?:[?#][^'"]*)?['"]\s*\)/g,
  ];
  for(const re of patterns)for(const match of source.matchAll(re))out.push(match[1]);
  return [...new Set(out)];
}

/** All module specifiers, relative or not, so bare imports can be refused.
 * Same shapes as `relativeImports`, but any specifier is captured. */
export function allSpecifiers(source){
  const out=[];
  const patterns=[
    /(?:^|[^\w$.])(?:import|export)\b(?:[^;'"`]*?\bfrom\b)?\s*['"]([^'"\s]+)['"]/g,
    /(?:^|[^\w$.])import\s*\(\s*['"]([^'"\s]+)['"]\s*\)/g,
  ];
  for(const re of patterns)for(const match of source.matchAll(re))out.push(match[1]);
  return [...new Set(out)];
}

/** Follow the import graph from the page's own `<script src>` entries to every
 * module the browser needs. Nested paths resolve relative to the importer;
 * missing files are skipped (a comment or a stale name must not crash the walk,
 * the entry assertion below is what catches a genuinely missing module). */
export async function browserModules(){
  const index=await readFile(path.join(sharedDir,'index.html'),'utf8');
  const present=new Set((await readdir(sharedDir,{recursive:true,withFileTypes:true}))
    .filter(e=>e.isFile())
    .map(e=>path.posix.join(e.parentPath.slice(sharedDir.length+1).split(path.sep).join('/'),e.name)));
  const needed=new Set(),queue=[...scriptSources(index)];
  const entries=new Set(queue);
  while(queue.length){
    const name=path.posix.normalize(queue.pop());
    if(!/\.m?js$/.test(name)||!present.has(name)||needed.has(name))continue;
    needed.add(name);
    const source=await readFile(path.join(sharedDir,name),'utf8');
    for(const spec of relativeImports(source))queue.push(path.posix.join(path.posix.dirname(name),spec));
  }
  return {needed:[...needed],entries,index};
}

test('the walker reads entry scripts, static, side-effect and dynamic imports',()=>{
  // The three shapes the shipped closure does not use today. If the walker only
  // understood `from './x.js'`, these would be enqueued as unlisted modules.
  const html=[`<script type="module" src="./app.js"></script>`,
    `<script defer src="./transport.js?v=abc"></script>`,
    `<script src="https://cdn.example/x.js"></script>`,
    `<script type="module">import './inline.js'</script>`,
    `<link rel="stylesheet" href="./app.css">`].join('\n');
  assert.deepEqual(scriptSources(html),['app.js','transport.js']);
  assert.deepEqual(relativeImports(`import a from './a.js';`),['a.js']);
  assert.deepEqual(relativeImports(`import './side.js';`),['side.js']);
  assert.deepEqual(relativeImports(`const m = await import('./dyn.js');`),['dyn.js']);
  assert.deepEqual(relativeImports(`export {x} from './re.js';`),['re.js']);
  assert.deepEqual(relativeImports(`import c from 'node:crypto'; import d from 'crypto';`),[]);
  assert.deepEqual(relativeImports(`import q from './q.js?v=0123abcd';`),['q.js']);
});

test('every module the page starts is shipped by both the Pages build and the Node server',async()=>{
  const {needed,entries}=await browserModules();
  assert.ok(entries.size>=3,`index.html must load its entry modules, found ${[...entries].join(', ')||'none'}`);
  for(const entry of ['app.js','local-api.js','transport.js']){
    assert.ok(entries.has(entry),`${entry} is no longer a <script src> of shared/index.html`);
  }
  assert.ok(needed.includes('app.js'),'closure walk found no entry modules');
  assert.ok(needed.includes('contracts.js'),'sanity: the closure must reach nested imports');
  // A fourth <script src>, a side-effect import or a dynamic import is in the
  // closure by construction now, so it has to be listed or the browser 404s.
  const listed=new Set(ASSETS);
  for(const name of needed){
    assert.ok(listed.has(name),`${name} is loaded by the UI but missing from shared/assets.js`);
  }
});

test('the closure stays browser-safe: no bare or node: specifiers',async()=>{
  // shared/ is served to the browser verbatim. One `import fs from 'node:fs'`
  // in a page-loadable module is a blank screen, not an error the Node tests see.
  const {needed}=await browserModules();
  for(const name of needed){
    const source=await readFile(path.join(sharedDir,name),'utf8');
    for(const spec of allSpecifiers(source)){
      assert.ok(spec.startsWith('./'),`${name} imports "${spec}"; a browser module may only use relative "./" imports`);
    }
  }
});

test('every shipped module, not just the reachable ones, stays browser-safe',async()=>{
  for(const name of ASSETS.filter(f=>f.endsWith('.js'))){
    const source=await readFile(path.join(sharedDir,name),'utf8');
    for(const spec of allSpecifiers(source)){
      assert.ok(spec.startsWith('./'),`${name} imports "${spec}"; shared/ must stay browser-safe`);
    }
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
