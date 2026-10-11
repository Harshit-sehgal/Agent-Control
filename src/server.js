import './env.js'; // load .env before anything reads process.env
import './env.js'; // load .env before anything reads process.env
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {openStore as openSqliteStore} from './sqlite-store.js';
// The JSON store remains available behind STORE_BACKEND=json for testing and
// as an explicit escape hatch; SQLite is the default persistence engine.
const openStore = async file => process.env.STORE_BACKEND === 'json'
  ? new (await import('./store.js')).JsonStore(file).init()
  : openSqliteStore(file);
import {activity,candidateInput,cleanText,scoreCandidate,uuid,CSP,DEMO_SAMPLES} from '../shared/core.js';
import * as wf from '../shared/workflow.js';
import {aiEnabled,aiModel,aiProvider,makeDraft,executeCustomBot} from './ai.js';
import {startScheduler} from './scheduler.js';
import {queueGroupRun,markInterrupted,coordinationState} from './coordination.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PUBLIC=path.join(ROOT,'shared');
// The /api/health version is the package version, not a literal, so a release
// bump cannot drift away from the health endpoint.
const VERSION=JSON.parse(await fs.readFile(path.join(ROOT,'package.json'),'utf8')).version;
const PORT=Number(process.env.PORT||4173);
const HOST=process.env.HOST||'127.0.0.1';
const STORE_PATH=process.env.DATA_FILE||path.join(ROOT,'data','state.json');
const PASSWORD=process.env.DASHBOARD_PASSWORD||crypto.randomBytes(12).toString('base64url');
const sessions=new Map(), attempts=new Map();
const store=await openStore(STORE_PATH);
await store.update(s=>{wf.migrate(s);wf.recoverInterrupted(s);});
await markInterrupted(store);
const stopScheduler=startScheduler(store);
if(store.recoveredFrom)console.warn(`WARNING: ${STORE_PATH} was unreadable and has been moved to ${store.recoveredFrom}. A fresh state was created.`);
const TYPES={'html':'text/html; charset=utf-8','js':'text/javascript; charset=utf-8','css':'text/css; charset=utf-8','svg':'image/svg+xml','png':'image/png','ico':'image/x-icon'};
const isLive=()=>aiEnabled();
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
const SECURITY={'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer'};
function send(res,status,value,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...SECURITY,...headers});res.end(JSON.stringify(value));}
function cookie(req,key){const found=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(key+'='));return found?.slice(key.length+1);}
function authed(req){const sid=cookie(req,'agent_session'),s=sid&&sessions.get(sid);if(!s)return false;if(s.exp<Date.now()){sessions.delete(sid);return false;}return true;}
// Drop expired rows so a long-lived process cannot grow the maps without bound.
// An attempt record is only meaningful while its window is open; once it lapses
// the counter is reset on the next login anyway, so the row can go.
function pruneExpired(){const now=Date.now();for(const [sid,s] of sessions)if(s.exp<now)sessions.delete(sid);for(const [ip,r] of attempts)if(now>r.until)attempts.delete(ip);}
function requireAuth(req){if(!authed(req))fail('Sign in first.',401);}
function timingEqual(a,b){const h1=crypto.createHash('sha256').update(String(a)).digest(),h2=crypto.createHash('sha256').update(String(b)).digest();return crypto.timingSafeEqual(h1,h2);}
function checkOrigin(req){if(req.url?.split('?')[0]==='/api/capture')return; if(!['POST','PATCH','DELETE','PUT'].includes(req.method))return;
  const origin=req.headers.origin;
  if(!origin)return; // Nonbrowser clients still require authenticated session/capture token.
  const possible=[`http://${req.headers.host}`,`https://${req.headers.host}`,process.env.PUBLIC_ORIGIN].filter(Boolean);
  if(!possible.includes(origin))fail('Cross-origin request rejected.',403);
}
async function jsonBody(req){let total=0;const chunks=[];for await (const chunk of req){total+=chunk.length;if(total>128*1024)fail('Request too large.',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{fail('Invalid JSON.',400);}}
function snapshot(){const s=store.read();return {...s,aiEnabled:isLive(),aiModel:isLive()?aiModel():null,serverTime:new Date().toISOString()};}
async function api(req,res,u){
  const p=u.pathname,m=req.method;
  // Health checks and uptime probes commonly use HEAD; answer both, bodyless for HEAD.
  if(p==='/api/health'&&(m==='GET'||m==='HEAD')){const payload=JSON.stringify({ok:true,version:VERSION});res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...SECURITY});return res.end(m==='HEAD'?undefined:payload);}
  if(p==='/api/login'&&m==='POST'){
    const ip=req.socket.remoteAddress||'unknown',record=attempts.get(ip)||{count:0,until:0};
    if(Date.now()>record.until){record.count=0;record.until=Date.now()+900000;}
    pruneExpired();
    if(record.count>=8)fail('Too many attempts. Try again in 15 minutes.',429);
    const b=await jsonBody(req);
    if(!timingEqual(b.password||'',PASSWORD)){record.count++;attempts.set(ip,record);fail('Incorrect password.',401);}
    attempts.delete(ip);const sid=crypto.randomBytes(32).toString('hex');sessions.set(sid,{exp:Date.now()+7*86400000});
    const secure=Boolean(req.socket.encrypted||req.headers['x-forwarded-proto']==='https');
    return send(res,200,{ok:true},{'Set-Cookie':`agent_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure?'; Secure':''}`});
  }
  if(p==='/api/logout'&&m==='POST'){const sid=cookie(req,'agent_session');if(sid)sessions.delete(sid);return send(res,200,{ok:true},{'Set-Cookie':'agent_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'});}
  if(p==='/api/capture'&&m==='POST'){
    // A separate token limits extension permissions to adding a candidate only.
    const token=req.headers['x-capture-token'];
    if(!token||!timingEqual(token,store.read().captureToken))fail('Invalid extension token.',401);
    const body=candidateInput(await jsonBody(req));
    const result=await store.update(s=>wf.addCandidate(s,body));
    return send(res,result.duplicate?200:201,result);
  }
  requireAuth(req);
  if(p==='/api/state'&&m==='GET')return send(res,200,snapshot());
  if(p==='/api/settings'&&m==='PATCH'){
    const b=await jsonBody(req);
    const result=await store.update(s=>wf.updateSettings(s,b));
    return send(res,200,result);
  }
  if(p==='/api/demo/seed'&&m==='POST'){
    // Samples come from the shared core.js constant, exactly like the Pages demo.
    const result=await store.update(s=>wf.seedDemo(s,DEMO_SAMPLES));
    return send(res,200,result);
  }
  if(p==='/api/candidates'&&m==='POST'){
    const b=await jsonBody(req);
    // Report duplicates the same way /api/capture does, so the UI can tell the
    // user the post was already queued instead of pretending it was added. The
    // flag has to ride along with the candidate or the browser-local transport
    // and the Node route would answer differently for the same input.
    const result=await store.update(s=>wf.addCandidate(s,b));
    return send(res,result.duplicate?200:201,{...result.candidate,duplicate:result.duplicate});
  }
  let match=p.match(/^\/api\/candidates\/([a-f0-9-]+)\/process$/);
  if(match&&m==='POST'){
    const id=match[1];
    const context=await store.update(s=>wf.beginProcessing(s,id));
    try{
      const evaluation=scoreCandidate(context.candidate,context.settings.topics);
      const result=await makeDraft(context.candidate,context.settings);
      const newDraft=await store.update(s=>wf.finishProcessing(s,id,evaluation,result));
      return send(res,201,newDraft);
    } catch(e){await store.update(s=>wf.failProcessing(s,id,e.message));throw e;}
  }
  match=p.match(/^\/api\/drafts\/([a-f0-9-]+)$/);
  if(match&&m==='PATCH'){
    const b=await jsonBody(req);
    const d=await store.update(s=>wf.editDraft(s,match[1],b.text));
    return send(res,200,d);
  }
  match=p.match(/^\/api\/drafts\/([a-f0-9-]+)\/(approve|reject|ready|posted|rewrite)$/);
  if(match&&m==='POST'){
    const [_,id,action]=match;
    if(action==='rewrite'){
      const b=await jsonBody(req),existing=store.read(),old=wf.findDraft(existing,id),c=wf.findCandidate(existing,old.candidateId);
      if(!['pending','scheduled','ready'].includes(old.status))fail('Cannot rewrite this draft.',409);
      const out=await makeDraft(c,existing.settings,b.direction||'');
      const d=await store.update(s=>{
        const x=wf.findDraft(s,id);if(x.revision!==old.revision)fail('Draft changed during rewrite. Retry.',409);
        x.text=out.text;x.revision++;x.status='pending';x.mode=out.mode;x.note=out.note;
        delete x.approvedText;delete x.approvedRevision;delete x.dueAt;delete x.approvedAt;
        activity(s,'rewrite',`Rewrote draft ${x.id}.`,{draftId:x.id});return x;
      });return send(res,200,d);
    }
    const b=await jsonBody(req);
    const d=await store.update(s=>wf.draftAction(s,id,action,b));
    return send(res,200,d);
  }
  if(p==='/api/groups'&&m==='POST'){
    const b=await jsonBody(req);
    const group=await store.update(s=>wf.addGroup(s,b));
    return send(res,201,group);
  }
  match=p.match(/^\/api\/groups\/([a-z0-9-]+)\/bots$/);
  if(match&&m==='POST'){
    const b=await jsonBody(req);
    const bot=await store.update(s=>wf.addBot(s,match[1],b));
    return send(res,201,bot);
  }
  // Persist lasting bot profile edits to the store so they survive a reload and
  // are shared by every device, instead of living only in browser localStorage.
  match=p.match(/^\/api\/groups\/([a-z0-9-]+)\/bots\/([a-z0-9-]+)$/);
  if(match&&m==='PATCH'){
    const b=await jsonBody(req);
    const bot=await store.update(s=>wf.updateBot(s,match[1],match[2],b));
    return send(res,200,bot);
  }
  // Durable text-only bot coordination. Humans approve every external action separately.
  match=p.match(/^\/api\/groups\/([a-z0-9-]+)\/chat$/);
  if(match&&m==='GET'){
    const s=store.read();coordinationState(s);
    return send(res,200,{messages:(s.groupMessages[match[1]]||[]).slice(-300),runs:s.groupRuns.filter(r=>r.groupId===match[1]).slice(0,50)});
  }
  if(match&&m==='POST'){
    const b=await jsonBody(req);
    const result=await queueGroupRun(store,{groupId:match[1],message:b.message,directBotId:b.directBotId||null});
    return send(res,202,result);
  }
  if(p==='/api/bots/run'&&m==='POST'){
    const b=await jsonBody(req),input=cleanText(b.input,4000);
    const state=store.read(),bot=state.groups.flatMap(g=>g.bots).find(x=>x.id===b.botId);
    if(!bot||bot.type!=='custom')fail('Select a custom bot.',404);
    if(!input)fail('Provide task input.');
    const result=await executeCustomBot(bot,input);
    const run=await store.update(s=>{const r={id:uuid(),botId:bot.id,botName:bot.name,input,output:result,at:new Date().toISOString()};s.runs.unshift(r);s.runs=s.runs.slice(0,100);activity(s,'run',`Completed ${bot.name} task.`,{runId:r.id});return r;});return send(res,201,run);
  }
  if(p==='/api/schedules'&&m==='POST'){
    const b=await jsonBody(req);
    const item=await store.update(s=>wf.addSchedule(s,b));
    return send(res,201,item);
  }
  match=p.match(/^\/api\/schedules\/([a-f0-9-]+)$/);
  if(match&&m==='DELETE'){const result=await store.update(s=>wf.removeSchedule(s,match[1]));return send(res,200,result);}
  if(p==='/api/reset-demo'&&m==='POST'){
    const result=await store.update(s=>wf.resetDemo(s));
    return send(res,200,result);
  }
  fail('Unknown endpoint.',404);
}
const ASSETS=new Set(['index.html','app.css','polish.css','usability.css','transport.js','local-api.js','app.js','core.js','workflow.js','coordination.js','group-simulator.js','chat-engine.js','usability.js','demo-feed.html']);
async function serve(req,res,u){
  let rel=u.pathname==='/'?'index.html':u.pathname.slice(1);
  if(!ASSETS.has(rel))return send(res,404,{error:'Not found'});
  try {const body=await fs.readFile(path.join(PUBLIC,rel));res.writeHead(200,{'Content-Type':TYPES[rel.split('.').pop()]||'application/octet-stream','Content-Security-Policy':CSP,...SECURITY,'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:body);}catch{return send(res,404,{error:'Missing asset'});}
}
const server=http.createServer(async(req,res)=>{
  try{
    const host=req.headers.host||'localhost';const url=new URL(req.url,`http://${host}`);
    checkOrigin(req);
    if(url.pathname.startsWith('/api/'))await api(req,res,url);
    else if(req.method==='GET'||req.method==='HEAD')await serve(req,res,url);
    else fail('Method not allowed.',405);
  }catch(e){let status=e.status||500;console.error(status===500?'Server error: '+e.message:'');if(res.headersSent){res.end();return;}send(res,status,{error:status===500?'Internal server error':e.message});}
});
server.listen(PORT,HOST,()=>{
  console.log(`\nAgent Control Prototype: http://${HOST}:${PORT}`);
  if(!process.env.DASHBOARD_PASSWORD) console.log(`Temporary dashboard password (changes on restart): ${PASSWORD}`);
  console.log(`AI mode: ${isLive()?`Connected · ${aiModel()} @ ${aiProvider()}`:'Template drafts (no AI provider configured)'}`);
  if(HOST!=='127.0.0.1'&&HOST!=='localhost')console.warn('WARNING: Use HTTPS plus a private network / access proxy for remote access.');
});
process.on('SIGINT',()=>{stopScheduler();server.close(()=>process.exit(0));});
