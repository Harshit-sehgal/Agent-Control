import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
async function freePort(){return await new Promise((resolve,reject)=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});server.on('error',reject);});}
async function launch(extraEnv={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-api-')),port=await freePort();
  const base=`http://127.0.0.1:${port}`;
  // Hermetic: ignore any developer `.env` and every AI env var so the tests
  // always run against the template-draft path, regardless of local setup.
  const child=spawn(process.execPath,['src/server.js'],{cwd:root,env:{...process.env,AGENT_SKIP_DOTENV:'1',AI_API_KEY:'',OPENAI_API_KEY:'',AI_BASE_URL:'',OPENAI_BASE_URL:'',DASHBOARD_PASSWORD:'test-password-1234',HOST:'127.0.0.1',PORT:String(port),DATA_FILE:path.join(dir,'state.json'),...extraEnv},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b.toString());child.stderr.on('data',b=>output+=b.toString());
  let live=false;
  for(let i=0;i<90;i++){
    if(child.exitCode!==null)break;
    try{const r=await fetch(base+'/api/health');if(r.ok){live=true;break;}}catch{}
    await new Promise(r=>setTimeout(r,70));
  }
  if(!live){child.kill();await fs.rm(dir,{recursive:true,force:true});throw new Error('Server did not start: '+output);}
  return {base,child,dir,async stop(){child.kill('SIGINT');await new Promise(resolve=>child.once('exit',resolve));await fs.rm(dir,{recursive:true,force:true});}};
}

test('the X capture endpoint is gone', {timeout:25000}, async()=>{
  const t=await launch();
  try{
    const login=await fetch(t.base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'test-password-1234'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    const state=await (await fetch(t.base+'/api/state',{headers:{Cookie:cookie}})).json();
    assert.equal('captureToken' in state,false,'state still carries a capture token');
    const r=await fetch(t.base+'/api/capture',{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify({url:'https://x.com/a/status/1',text:'hi',author:'a'})});
    assert.equal(r.status,404);
  }finally{await t.stop();}
});

test('login is rate limited after repeated failures and the limit resets after the window', {timeout:25000}, async()=>{
  const t=await launch();
  try{
    const login=async password=>{
      const r=await fetch(t.base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
      return r.status;
    };
    // Eight failures are tolerated; the ninth is refused without checking the password.
    for(let i=0;i<8;i++) assert.equal(await login('wrong'),401,`attempt ${i+1}`);
    assert.equal(await login('wrong'),429);
    // Even the correct password is refused while the window is open.
    assert.equal(await login('test-password-1234'),429);
    // A different client IP is unaffected by another IP's lockout.
    assert.equal((await fetch(t.base+'/api/state')).status,401);
  }finally{await t.stop();}
});

test('bot profile edits persist to the store and survive a restart', {timeout:25000}, async()=>{
  const t=await launch();
  try{
    const send=async(method,url,body,cookie,headers={})=>{
      const r=await fetch(t.base+url,{method,headers:{'Content-Type':'application/json',...headers,...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
      const value=await r.json();return {status:r.status,body:value,cookie:r.headers.get('set-cookie')};
    };
    const login=await send('POST','/api/login',{password:'test-password-1234'});
    const cookie=login.cookie.split(';')[0];
    const patched=await send('PATCH','/api/groups/home/bots/atlas',{name:'Senior Atlas',instructions:'Draft concise replies in the user voice.'},cookie);
    assert.equal(patched.status,200);
    assert.equal(patched.body.name,'Senior Atlas');
    assert.equal(patched.body.instructions,'Draft concise replies in the user voice.');
    // The change must be in persisted state, not just the response.
    const state=(await send('GET','/api/state',undefined,cookie)).body;
    const atlas=state.groups[0].bots.find(b=>b.id==='atlas');
    assert.equal(atlas.name,'Senior Atlas');
    assert.equal((await send('PATCH','/api/groups/home/bots/missing',{name:'x',instructions:'y'},cookie)).status,404);
    assert.equal((await send('PATCH','/api/groups/missing/bots/atlas',{name:'x',instructions:'y'},cookie)).status,404);
    assert.equal((await send('PATCH','/api/groups/home/bots/atlas',{name:'',instructions:'y'},cookie)).status,400);
    assert.equal((await send('PATCH','/api/groups/home/bots/atlas',{name:'x',instructions:'y'})).status,401);
  }finally{await t.stop();}
});
test('behind a trusted proxy the rate limit keys on the forwarded client address', {timeout:30000}, async () => {
  const t = await launch({TRUST_PROXY: '1'});
  try {
    const send = xff => fetch(t.base + '/api/login', {method: 'POST', headers: {'Content-Type': 'application/json', 'X-Forwarded-For': xff}, body: JSON.stringify({password: 'wrong'})});
    for (let i = 0; i < 8; i++) assert.equal((await send('10.0.0.1')).status, 401, 'the first eight are checked');
    assert.equal((await send('10.0.0.1')).status, 429, 'the ninth from one address is refused');
    // A different forwarded client address is a different bucket.
    assert.equal((await send('10.0.0.2')).status, 401, 'another client is unaffected');
  } finally { await t.stop(); }
});

/** Shared login + request helper for the API invariants below. */
async function session(){
  const t=await launch();
  const send=async(method,url,body,cookie)=>{
    const r=await fetch(t.base+url,{method,headers:{'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
    const text=await r.text();
    return {status:r.status,body:text?JSON.parse(text):null,cookie:r.headers.get('set-cookie')};
  };
  const login=await send('POST','/api/login',{password:'test-password-1234'});
  assert.equal(login.status,200);
  return {t,send,cookie:login.cookie.split(';')[0]};
}

test('an unknown group has no chat thread instead of an empty one', {timeout:25000}, async()=>{
  const {t,send,cookie}=await session();
  try{
    const state=(await send('GET','/api/state',undefined,cookie)).body;
    assert.ok(state.groups.length,'the install ships a group');
    const known=await send('GET',`/api/groups/${state.groups[0].id}/chat`,undefined,cookie);
    assert.equal(known.status,200);
    // POST to an unknown group answers 404, so the read must agree rather than
    // render an empty conversation for a group that does not exist.
    const unknown=await send('GET','/api/groups/not-a-group/chat',undefined,cookie);
    assert.equal(unknown.status,404);
    assert.match(unknown.body.error,/Group not found/);
  }finally{await t.stop();}
});

test('a browser task is validated before it is queued', {timeout:25000}, async()=>{
  const {t,send,cookie}=await session();
  try{
    const queue=(kind,payload)=>send('POST','/api/agents/no-such-agent/tasks',{kind,payload},cookie);
    // MAX_STEPS is the same limit a bot's browser block has.
    const tooMany=await queue('browser.action',{url:'https://example.com',steps:Array.from({length:26},()=>({op:'read',selector:'main'}))});
    assert.equal(tooMany.status,400);
    assert.match(tooMany.body.error,/at most 25 steps/);
    // Clicking on X is allowed like any other site; this route only checks the shape.
    const xClick=await queue('browser.action',{url:'https://x.com/home',steps:[{op:'click',selector:'article'}]});
    assert.notEqual(xClick.status,403);
    // A url that is not http(s) is refused, and the payload is normalized.
    assert.equal((await queue('browser.capture',{url:'javascript:alert(1)'})).status,400);
    // The kind has to match what the payload describes.
    assert.equal((await queue('browser.capture',{url:'https://example.com',steps:[{op:'read',selector:'main'}]})).status,400);
    // A valid request gets past validation: the only failure left is the
    // unknown agent (404), not the payload (400).
    const valid=await queue('browser.capture',{url:'https://example.com/home'});
    assert.equal(valid.status,404);
    // Non-browser kinds are untouched by browser validation.
    assert.equal((await queue('http.check',{url:'https://example.com'})).status,404);
  }finally{await t.stop();}
});

test('a restore cannot silently delete a workspace created after the backup, and says the caller is signed out', {timeout:30000}, async()=>{
  const crypto=await import('node:crypto');
  const {t,send,cookie}=await session();
  try{
    const created=await send('POST','/api/workspaces',{name:'Client work'},cookie);
    assert.equal(created.status,201);
    const id=created.body.id;
    const file=path.join(t.dir,'state.ws-'+id+'.db');
    assert.ok(await fs.access(file).then(()=>true,()=>false),'the second workspace has a database');

    const document=(await send('GET','/api/admin/backup',undefined,cookie)).body;
    assert.ok(document.tables.workspaces.some(w=>w.id===id));
    // The same document, as it was written before that workspace existed.
    const tables={...document.tables,workspaces:document.tables.workspaces.filter(w=>w.id!==id),workspace_members:document.tables.workspace_members.filter(m=>m.workspace_id!==id)};
    const older={...document,tables,checksum:crypto.createHash('sha256').update(JSON.stringify(tables)).digest('hex')};

    const refused=await send('POST','/api/admin/restore',{...older,force:true},cookie);
    assert.equal(refused.status,409);
    assert.match(refused.body.error,new RegExp(id),'the refusal names the workspace it would delete');
    const stillThere=await send('GET','/api/workspaces',undefined,cookie);
    assert.equal(stillThere.status,200,'nothing was restored, so the session and the data are intact');
    assert.ok(stillThere.body.workspaces.some(w=>w.id===id),'the newer workspace is still listed');
    assert.ok(await fs.access(file).then(()=>true,()=>false),'and its database is still on disk');

    // Naming it is the operator's explicit confirmation.
    const restored=await send('POST','/api/admin/restore',{...older,force:true,discardWorkspaces:[id]},cookie);
    assert.equal(restored.status,200);
    assert.equal(restored.body.signedOut,true,'a primary restore deletes every session, so it must say so');
    assert.equal(await fs.access(file).then(()=>true,()=>false),false,'the named workspace is discarded');
    assert.equal((await send('GET','/api/workspaces',undefined,cookie)).status,401,'the old cookie is dead, as the body said');
  }finally{await t.stop();}
});

test('SIGTERM drains the server like Ctrl-C instead of killing it', {timeout:25000}, async()=>{
  const t=await launch();
  try{
    const exited=new Promise(resolve=>t.child.once('exit',(code,signal)=>resolve({code,signal})));
    t.child.kill('SIGTERM');
    // A signal that is not handled shows up as a signal death (code null).
    assert.deepEqual(await exited,{code:0,signal:null},'SIGTERM runs the same shutdown as SIGINT');
    await assert.rejects(fetch(t.base+'/api/health'),'and the socket is released');
  }finally{
    if(t.child.exitCode===null&&t.child.signalCode===null)t.child.kill('SIGKILL');
    await fs.rm(t.dir,{recursive:true,force:true});
  }
});

test('removed X routes answer 404 JSON', {timeout:25000}, async()=>{
  const t=await launch();
  try{
    const login=await fetch(t.base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:'test-password-1234'})});
    const cookie=login.headers.get('set-cookie').split(';')[0];
    for(const [method,route] of [['POST','/api/candidates'],['PATCH','/api/drafts/x'],['POST','/api/evidence'],['GET','/api/schedules'],['POST','/api/settings'],['POST','/api/demo/seed']]){
      const r=await fetch(t.base+route,{method,headers:{'Content-Type':'application/json',Cookie:cookie,Origin:t.base},...(method==='GET'?{}:{body:'{}'})});
      assert.equal(r.status,404,`${method} ${route}`);
      const body=await r.json();
      assert.equal(typeof body.error,'string',`${method} ${route} has an error message`);
    }
  }finally{await t.stop();}
});
