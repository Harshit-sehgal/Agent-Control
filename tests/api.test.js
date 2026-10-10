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
async function launch(){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'agent-api-')),port=await freePort();
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,['src/server.js'],{cwd:root,env:{...process.env,OPENAI_API_KEY:'',DASHBOARD_PASSWORD:'test-password-1234',HOST:'127.0.0.1',PORT:String(port),DATA_FILE:path.join(dir,'state.json')},stdio:['ignore','pipe','pipe']});
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
