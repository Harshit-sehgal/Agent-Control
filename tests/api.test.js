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

test('complete dashboard capture → draft → edit → approve → ready → manual posted lifecycle', {timeout:25000}, async()=>{
  const t=await launch();
  try{
    const send=async(method,url,body,cookie,headers={})=>{
      const r=await fetch(t.base+url,{method,headers:{'Content-Type':'application/json',...headers,...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
      const value=await r.json();return {status:r.status,body:value,cookie:r.headers.get('set-cookie')};
    };
    assert.equal((await send('GET','/api/state')).status,401);
    assert.equal((await send('POST','/api/login',{password:'wrong'})).status,401);
    const login=await send('POST','/api/login',{password:'test-password-1234'});
    assert.equal(login.status,200);const cookie=login.cookie.split(';')[0];
    const state=(await send('GET','/api/state',undefined,cookie)).body;
    assert.equal(state.aiEnabled,false);
    // Standard HEAD probes must succeed with the security headers and no body.
    const head=await fetch(t.base+'/',{method:'HEAD'});
    assert.equal(head.status,200);
    assert.equal(await head.text(),'');
    assert.match(head.headers.get('content-security-policy')||'',/frame-ancestors 'none'/);
    assert.equal((await fetch(t.base+'/api/health',{method:'HEAD'})).status,200);
    const c=await send('POST','/api/capture',{url:'https://x.com/test/status/123',text:'How can robotics models become more reliable in practice?',author:'Tester',topic:'robotics'},undefined,{'X-Capture-Token':state.captureToken,Origin:'chrome-extension://example'});
    assert.equal(c.status,201);
    const bad=await send('POST','/api/capture',{url:'https://x.com/test/status/4',text:'Some other post data here'},undefined,{'X-Capture-Token':'wrong'});
    assert.equal(bad.status,401);
    const processed=await send('POST',`/api/candidates/${c.body.candidate.id}/process`,{},cookie);
    assert.equal(processed.status,201);assert.equal(processed.body.mode,'template');
    const draftId=processed.body.id;
    const firstApproval=await send('POST',`/api/drafts/${draftId}/approve`,{minDelay:0,maxDelay:0},cookie);
    assert.equal(firstApproval.status,200);assert.equal(firstApproval.body.status,'scheduled');
    const double=await send('POST',`/api/drafts/${draftId}/approve`,{minDelay:0,maxDelay:0},cookie);
    assert.equal(double.status,409);
    const edit=await send('PATCH',`/api/drafts/${draftId}`,{text:'My actual short opinion after reviewing the original post.'},cookie);
    assert.equal(edit.status,200);assert.equal(edit.body.status,'pending');assert.equal(edit.body.approvedText,undefined);
    const approve=await send('POST',`/api/drafts/${draftId}/approve`,{minDelay:0,maxDelay:0},cookie);
    assert.equal(approve.body.approvedRevision,2);
    const ready=await send('POST',`/api/drafts/${draftId}/ready`,{},cookie);
    assert.equal(ready.body.status,'ready');
    const posted=await send('POST',`/api/drafts/${draftId}/posted`,{},cookie);
    assert.equal(posted.body.status,'posted');
    const editAfter=await send('PATCH',`/api/drafts/${draftId}`,{text:'Not allowed now'},cookie);
    assert.equal(editAfter.status,409);
    assert.equal((await send('POST','/api/groups',{name:'New group',description:'Testing'},cookie)).status,201);
    const schedule=await send('POST','/api/schedules',{label:'Collect posts',kind:'interval',intervalMinutes:60},cookie);
    assert.equal(schedule.status,201);
    assert.equal((await send('DELETE',`/api/schedules/${schedule.body.id}`,undefined,cookie)).status,200);
    const originBlocked=await send('POST','/api/groups',{name:'Bad request'},cookie,{Origin:'https://evil.example'});
    assert.equal(originBlocked.status,403);
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
    const patched=await send('PATCH','/api/groups/x-engage/bots/writer',{name:'Senior Writer',instructions:'Draft concise replies in the user voice.'},cookie);
    assert.equal(patched.status,200);
    assert.equal(patched.body.name,'Senior Writer');
    assert.equal(patched.body.instructions,'Draft concise replies in the user voice.');
    // The change must be in persisted state, not just the response.
    const state=(await send('GET','/api/state',undefined,cookie)).body;
    const writer=state.groups[0].bots.find(b=>b.id==='writer');
    assert.equal(writer.name,'Senior Writer');
    assert.equal((await send('PATCH','/api/groups/x-engage/bots/missing',{name:'x',instructions:'y'},cookie)).status,404);
    assert.equal((await send('PATCH','/api/groups/missing/bots/writer',{name:'x',instructions:'y'},cookie)).status,404);
    assert.equal((await send('PATCH','/api/groups/x-engage/bots/writer',{name:'',instructions:'y'},cookie)).status,400);
    assert.equal((await send('PATCH','/api/groups/x-engage/bots/writer',{name:'x',instructions:'y'})).status,401);
  }finally{await t.stop();}
});
test('adding a duplicate candidate reports the duplicate instead of lying about it', {timeout:25000}, async()=>{
  // /api/capture already reported duplicates, but /api/candidates dropped the
  // flag while returning the candidate, so the Node build and the browser-local
  // transport answered the same input differently and the UI always claimed the
  // post was added.
  const t=await launch();
  try{
    const send=async(method,url,body,cookie,headers={})=>{
      const r=await fetch(t.base+url,{method,headers:{'Content-Type':'application/json',...headers,...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
      const value=await r.json();return {status:r.status,body:value,cookie:r.headers.get('set-cookie')};
    };
    const cookie=(await send('POST','/api/login',{password:'test-password-1234'})).cookie.split(';')[0];
    const post={url:'https://x.com/test/status/999',text:'A candidate long enough to pass validation.',author:'Dup',topic:'AI'};
    const first=await send('POST','/api/candidates',post,cookie);
    assert.equal(first.status,201);
    assert.equal(first.body.duplicate,false);
    const again=await send('POST','/api/candidates',post,cookie);
    assert.equal(again.status,200,'A duplicate is accepted, not created, so it answers 200.');
    assert.equal(again.body.duplicate,true);
    assert.equal(again.body.id,first.body.id,'The duplicate must return the original candidate.');
    const state=(await send('GET','/api/state',undefined,cookie)).body;
    assert.equal(state.candidates.length,1,'No second candidate may be stored.');
  }finally{await t.stop();}
});
test('a candidate interrupted mid-draft is processable again after a restart', {timeout:25000}, async()=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-api-recover-')),port=await freePort();
  const base=`http://127.0.0.1:${port}`;
  const stateFile=path.join(dir,'state.json');
  const env={...process.env,AGENT_SKIP_DOTENV:'1',AI_API_KEY:'',OPENAI_API_KEY:'',AI_BASE_URL:'',OPENAI_BASE_URL:'',DASHBOARD_PASSWORD:'test-password-1234',HOST:'127.0.0.1',PORT:String(port),DATA_FILE:stateFile};
  const waitFor=async child=>{
    for(let i=0;i<90;i++){
      if(child.exitCode!==null)return false;
      try{if((await fetch(base+'/api/health')).ok)return true;}catch{}
      await new Promise(r=>setTimeout(r,70));
    }
    return false;
  };
  const first=spawn(process.execPath,['src/server.js'],{cwd:root,env,stdio:'ignore'});
  try{
    assert.equal(await waitFor(first),true);
    const send=async(method,url,body,cookie,headers={})=>{
      const r=await fetch(base+url,{method,headers:{'Content-Type':'application/json',...headers,...(cookie?{Cookie:cookie}:{})},body:body===undefined?undefined:JSON.stringify(body)});
      const value=await r.json();return {status:r.status,body:value,cookie:r.headers.get('set-cookie')};
    };
    const cookie=(await send('POST','/api/login',{password:'test-password-1234'})).cookie.split(';')[0];
    const state=(await send('GET','/api/state',undefined,cookie)).body;
    const c=await send('POST','/api/capture',{url:'https://x.com/test/status/555',text:'How can robotics models become more reliable in practice?',author:'Tester',topic:'robotics'},undefined,{'X-Capture-Token':state.captureToken,Origin:'chrome-extension://example'});
    const id=c.body.candidate.id;
    // Simulate a crash after beginProcessing but before finishProcessing.
    await fs.writeFile(stateFile,JSON.stringify({...state,version:2,candidates:[{...c.body.candidate,status:'processing'}]},null,2));
    first.kill('SIGINT');await new Promise(resolve=>first.once('exit',resolve));
    const second=spawn(process.execPath,['src/server.js'],{cwd:root,env,stdio:'ignore'});
    try{
      assert.equal(await waitFor(second),true,'Server must restart despite a stranded processing candidate.');
      // Sessions are in-memory, so re-authenticate against the restarted process.
      const fresh=(await send('POST','/api/login',{password:'test-password-1234'})).cookie.split(';')[0];
      const after=(await send('GET','/api/state',undefined,fresh)).body;
      assert.equal(after.candidates.length,1,'The stranded candidate must survive the restart.');
      assert.equal(after.candidates[0].status,'new','The interrupted candidate must be released, not stuck forever.');
      assert.equal((await send('POST',`/api/candidates/${id}/process`,{},fresh)).status,201);
    }finally{second.kill('SIGINT');await new Promise(resolve=>second.once('exit',resolve));}
  }finally{await fs.rm(dir,{recursive:true,force:true});}
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
