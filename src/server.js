import './env.js'; // load .env before anything reads process.env
import './env.js'; // load .env before anything reads process.env
import http from 'node:http';
import https from 'node:https';
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
import * as tasks from '../shared/tasks.js';
import * as evidence from '../shared/evidence.js';
import * as agent from './agent.js';
import * as credentials from './credentials.js';
import * as backup from './backup.js';
import * as notifications from './notifications.js';
import {pruneState,RETENTION_DEFAULTS} from '../shared/retention.js';
import {aiEnabled,aiModel,aiProvider,makeDraft,executeCustomBot} from './ai.js';
import {startScheduler,startRetention} from './scheduler.js';
import {queueGroupRun,markInterrupted,coordinationState} from './coordination.js';
import {createQueue,recoverQueue,defaultHandlers} from './queue.js';
import {Auth,ROLES,sessionCookie,clearCookie,DEFAULT_WORKSPACE as DEFAULT_WORKSPACE_ID} from './auth.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PUBLIC=path.join(ROOT,'shared');
// The /api/health version is the package version, not a literal, so a release
// bump cannot drift away from the health endpoint.
const VERSION=JSON.parse(await fs.readFile(path.join(ROOT,'package.json'),'utf8')).version;
const PORT=Number(process.env.PORT||4173);
const HOST=process.env.HOST||'127.0.0.1';
const STORE_PATH=process.env.DATA_FILE||path.join(ROOT,'data','state.json');
const PASSWORD=process.env.DASHBOARD_PASSWORD||crypto.randomBytes(12).toString('base64url');
const attempts=new Map();
const store=await openStore(STORE_PATH);
await store.update(s=>{wf.migrate(s);wf.recoverInterrupted(s);});
await markInterrupted(store);
const stopScheduler=startScheduler(store);
const stopRetention=startRetention(store);
// First boot bootstraps the owner account from DASHBOARD_PASSWORD; afterwards
// sessions, resets and roles live in the database.
const auth=new Auth(store);
auth.ensureBootstrap(PASSWORD);
await recoverQueue(store);
// Tasks orphaned by a disconnected agent are re-armed at boot rather
// than left leased to a process that no longer exists.
const recoveredAgentTasks=agent.recoverAgentTasks(store);
if(recoveredAgentTasks)console.log(`Re-armed ${recoveredAgentTasks} agent task(s) from a previous run.`);
// Paired-agent secrets are encrypted with this key; MASTER_KEY overrides the
// auto-generated keyfile that lives with the data directory.
agent.attachVault(store,STORE_PATH);
// Task kinds map to handlers here rather than inside the queue module, so the
// worker stays independent of the server surface it drives.
// Notifications enqueue themselves as queue tasks, so the enqueue hook is
// filled in once the queue exists (handlers are registered before start()).
let enqueueNotification=()=>{};
const notify=(event)=>notifications.notify(store,enqueueNotification,{workspaceId:DEFAULT_WORKSPACE_ID,userId:null,...event});
const queue=createQueue(store,{
  ...defaultHandlers(store,notify),  'candidate-draft': async task=>processCandidate(task.payload.candidateId),
  'group-run': async task=>{ await queueGroupRun(store,{groupId:task.payload.groupId,message:task.payload.message,directBotId:task.payload.directBotId}); },
  'agent-job': async task=>{
    // Dispatch to a paired local agent: enqueue an agent task for each agent
    // that holds the required permission. The queue's idempotency and the
    // agent-side lease make exactly-once practical without claiming more than
    // the protocol can prove.
    const kind=task.payload.action;
    const agents=store.all("SELECT id,permissions FROM agents WHERE revoked_at IS NULL").map(a=>({id:a.id,permissions:JSON.parse(a.permissions||'[]')}))
      .filter(a=>!task.payload.agentId||a.id===task.payload.agentId)
      .filter(a=>a.permissions.includes(kind));
    if(!agents.length)throw new Error('No paired local agent holds the permission this job needs.');
    for(const a of agents){
      agent.enqueueAgentTask(store,a.id,{kind,payload:task.payload.params||{},idempotencyKey:`job:${task.id}:${a.id}`,createdBy:task.createdBy});
    }
    return {dispatchedTo:agents.map(a=>a.id)};
  },
  'notification': async task=>{
    const result=await notifications.deliver(store,task);
    store.run('UPDATE notifications SET status=?, sent_at=? WHERE id=?','sent',new Date().toISOString(),task.payload.notificationId);
    return result;
  },
},{onFail:(task,error)=>Promise.resolve(notify({title:'A background task failed',body:`${task.title}: ${error.message}`,kind:'task-failure',meta:{taskId:task.id}}))});
// The queue exists now, so notifications can enqueue themselves as delivery
// tasks. Handlers above captured this closure, not a started loop.
enqueueNotification=(s,spec)=>s.update(st=>{enqueueTask(st,spec);});
const stopQueue=queue.start();
if(store.recoveredFrom)console.warn(`WARNING: ${STORE_PATH} was unreadable and has been moved to ${store.recoveredFrom}. A fresh state was created.`);
const TYPES={'html':'text/html; charset=utf-8','js':'text/javascript; charset=utf-8','css':'text/css; charset=utf-8','svg':'image/svg+xml','png':'image/png','ico':'image/x-icon'};
const isLive=()=>aiEnabled();
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
const HSTS_ENABLED=process.env.HSTS==='1'||String(process.env.PUBLIC_ORIGIN||'').startsWith('https://');
const SECURITY={'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer',...(HSTS_ENABLED?{'Strict-Transport-Security':'max-age=31536000; includeSubDomains'}:{})};
function send(res,status,value,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...SECURITY,...headers});res.end(JSON.stringify(value));}
function cookie(req,key){const found=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(key+'='));return found?.slice(key.length+1);}
/** Resolve the signed-in principal from the server-side session table, or null. */
function principal(req){return auth.session(cookie(req,'agent_session'));}
function requireAuth(req){const p=principal(req);if(!p)fail('Sign in first.',401);return p;}
function requireRole(req,minRole){const p=requireAuth(req);if(ROLES.indexOf(p.role)<ROLES.indexOf(minRole))fail(`This action needs the ${minRole} role or higher.`,403);return p;}
// Drop expired rows so a long-lived process cannot grow the maps without bound.
// An attempt record is only meaningful while its window is open; once it lapses
// the counter is reset on the next login anyway, so the row can go.
function pruneExpired(){const now=Date.now();for(const [ip,r] of attempts)if(now>r.until)attempts.delete(ip);}
function timingEqual(a,b){const h1=crypto.createHash('sha256').update(String(a)).digest(),h2=crypto.createHash('sha256').update(String(b)).digest();return crypto.timingSafeEqual(h1,h2);}
function checkOrigin(req){if(req.url?.split('?')[0]==='/api/capture')return; if(!['POST','PATCH','DELETE','PUT'].includes(req.method))return;
  const origin=req.headers.origin;
  if(!origin)return; // Nonbrowser clients still require authenticated session/capture token.
  const possible=[`http://${req.headers.host}`,`https://${req.headers.host}`,process.env.PUBLIC_ORIGIN].filter(Boolean);
  if(!possible.includes(origin))fail('Cross-origin request rejected.',403);
}
/** Minimum role per mutating route. GET routes are open to any authenticated
 * member; every write and every admin surface is checked here so a viewer
 * session cannot mutate even if a future route forgets to ask. */
const WRITE_ROUTES=[
  [/^\/api\/settings$/,'PATCH','admin'],
  [/^\/api\/candidates$/,'POST','member'],
  [/^\/api\/candidates\/[a-f0-9-]+\/process$/,'POST','member'],
  [/^\/api\/drafts\/[a-f0-9-]+$/,'PATCH','member'],
  [/^\/api\/drafts\/[a-f0-9-]+\/(approve|reject|ready|posted|rewrite)$/,'POST','member'],
  [/^\/api\/groups$/,'POST','member'],
  [/^\/api\/groups\/[a-z0-9-]+\/bots$/,'POST','member'],
  [/^\/api\/groups\/[a-z0-9-]+\/bots\/[a-z0-9-]+$/,'PATCH','member'],
  [/^\/api\/groups\/[a-z0-9-]+\/chat$/,'POST','member'],
  [/^\/api\/bots\/run$/,'POST','member'],
  [/^\/api\/schedules$/,'POST','member'],
  [/^\/api\/schedules\/[a-f0-9-]+$/,'DELETE','member'],
  [/^\/api\/tasks$/,'POST','member'],
  [/^\/api\/tasks\/[a-f0-9-]+\/retry$/,'POST','member'],
  [/^\/api\/tasks\/[a-f0-9-]+$/,'DELETE','member'],
  [/^\/api\/drafts\/[a-f0-9-]+\/evidence$/,'POST','member'],
  [/^\/api\/evidence\/[a-f0-9-]+\/verify$/,'POST','member'],
  [/^\/api\/evidence\/[a-f0-9-]+$/,'DELETE','member'],
  [/^\/api\/agents\/pair$/,'POST','admin'],
  [/^\/api\/agents\/[a-f0-9-]+\/tasks$/,'POST','member'],
  [/^\/api\/agents\/[a-f0-9-]+$/,'PATCH','admin'],
  [/^\/api\/agents\/[a-f0-9-]+$/,'DELETE','admin'],
  [/^\/api\/credentials$/,'POST','admin'],
  [/^\/api\/credentials\/[a-f0-9-]+$/,'DELETE','admin'],
  [/^\/api\/retention\/prune$/,'POST','admin'],
  [/^\/api\/admin\/restore$/,'POST','admin'],
  [/^\/api\/notifications\/read$/,'POST','member'],
  [/^\/api\/notification-prefs$/,'PATCH','member'],
  [/^\/api\/demo\/seed$/,'POST','member'],
  [/^\/api\/reset-demo$/,'POST','member'],
];
function authorize(actor,p,m){
  for(const [pattern,method,role] of WRITE_ROUTES){
    if(method===m&&pattern.test(p)){
      if(ROLES.indexOf(actor.role)<ROLES.indexOf(role))fail(`This action needs the ${role} role or higher.`,403);
      return;
    }
  }
}
/** Raw bytes of a request body, bounded. The agent protocol signs exactly the
 * bytes it sends, so these routes parse JSON only after signature checks. */
async function rawBody(req){let total=0;const chunks=[];for await(const chunk of req){total+=chunk.length;if(total>64*1024)fail('Request too large.',413);chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}
function safeJson(raw){try{return JSON.parse(raw||'{}');}catch{fail('Invalid JSON.',400);}}
async function jsonBody(req){let total=0;const chunks=[];for await (const chunk of req){total+=chunk.length;if(total>128*1024)fail('Request too large.',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{fail('Invalid JSON.',400);}}
/** Shared by the HTTP route and the queue worker: score a candidate and
 * produce a draft, releasing the candidate if anything fails so a transient
 * provider error never strands it. */
async function processCandidate(id){
  const context=await store.update(s=>wf.beginProcessing(s,id));
  try{
    const evaluation=scoreCandidate(context.candidate,context.settings.topics);
    const result=await makeDraft(context.candidate,context.settings);
    return await store.update(s=>wf.finishProcessing(s,id,evaluation,result));
  } catch(e){
    await store.update(s=>wf.failProcessing(s,id,e.message));
    throw e;
  }
}

function snapshot(req){const s=store.read();const me=principal(req);return {...s,aiEnabled:isLive(),aiModel:isLive()?aiModel():null,me:me?{email:me.email,role:me.role}:null,retention:retentionSettings(s),notifications:me?notifications.listNotifications(store,me.userId,50):[],unread:me?notifications.unreadCount(store,me.userId):0,serverTime:new Date().toISOString()};}
const retentionSettings=s=>({...RETENTION_DEFAULTS,...(s.settings?.retention||{})});
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
    const result=auth.login({email:b.email,password:b.password},{ip,userAgent:req.headers['user-agent']});
    if(!result.ok){record.count++;attempts.set(ip,record);fail(result.error,result.status);}
    attempts.delete(ip);
    const secure=Boolean(req.socket.encrypted||req.headers['x-forwarded-proto']==='https');
    return send(res,200,{ok:true,me:{email:result.user.email,role:result.role}},{'Set-Cookie':sessionCookie(result.sessionId,{secure})});
  }
  if(p==='/api/logout'&&m==='POST'){auth.logout(cookie(req,'agent_session'));return send(res,200,{ok:true},{'Set-Cookie':clearCookie()});}
  // Local-agent protocol. /api/agent/pair redeems a one-time code; the other
  // agent routes verify an HMAC signature over the raw request bytes instead of
  // a browser session, because no browser is involved.
  let match=null;
  if(p==='/api/agent/pair'&&m==='POST'){
    const raw=await rawBody(req);
    const b=safeJson(raw);
    if(!b?.code||typeof b.code!=='string')fail('A pairing code is required.',400);
    const result=agent.redeemPairing(store,{code:b.code,name:b.name,permissions:b.permissions});
    await store.update(s=>{activity(s,'agent',`Paired local agent "${String(b.name||'Local agent').slice(0,60)}".`,{agentId:result.agentId});});
    return send(res,201,result);
  }
  if(p==='/api/agent/heartbeat'&&m==='POST'){
    const raw=await rawBody(req);
    const device=agent.verifyAgentRequest(store,req.headers,'POST',p,raw);
    agent.touchAgent(store,device.id);
    const recovered=agent.recoverAgentTasks(store);
    const tasks=agent.claimAgentTasks(store,device.id).map(t=>({id:t.id,kind:t.kind,payload:JSON.parse(t.payload),attempts:t.attempts}));
    if(recovered)await store.update(s=>{activity(s,'agent',`Re-armed ${recovered} agent task(s) after a disconnect.`);});
    return send(res,200,{ok:true,serverTime:new Date().toISOString(),agent:{id:device.id,name:device.name},tasks});
  }
  match=p.match(/^\/api\/agent\/tasks\/([a-f0-9-]+)\/result$/);
  if(match&&m==='POST'){
    const raw=await rawBody(req);
    const device=agent.verifyAgentRequest(store,req.headers,'POST',p,raw);
    const b=safeJson(raw);
    if(!b?.status)fail('A result status is required.',400);
    const result=agent.completeAgentTask(store,device.id,match[1],{status:b.status,result:b.result,error:b.error});
    await store.update(s=>activity(s,'agent',`Agent task ${match[1]} reported ${b.status}.`,{taskId:match[1]}));
    return send(res,200,result);
  }
  // Public, unauthenticated auth routes. They answer identically whether or not
  // the address exists, so they cannot be used to enumerate accounts.
  if(p==='/api/auth/forgot'&&m==='POST'){
    const b=await jsonBody(req);
    const token=auth.requestPasswordReset(b.email);
    // Local-first deployment: the console prints the token because there is no
    // mail transport configured. Do not log tokens in a public deployment.
    if(token)console.log(`\nPassword reset token for ${String(b.email||'').trim().toLowerCase()} (valid 1 hour, single use):\n  ${token}\n`);
    return send(res,200,{ok:true});
  }
  if(p==='/api/auth/reset'&&m==='POST'){
    const b=await jsonBody(req);
    auth.consumePasswordReset(b.token,b.password);
    return send(res,200,{ok:true});
  }
  if(p==='/api/capture'&&m==='POST'){
    // A separate token limits extension permissions to adding a candidate only.
    const token=req.headers['x-capture-token'];
    if(!token||!timingEqual(token,store.read().captureToken))fail('Invalid extension token.',401);
    const body=candidateInput(await jsonBody(req));
    const result=await store.update(s=>wf.addCandidate(s,body));
    return send(res,result.duplicate?200:201,result);
  }
  const actor=requireAuth(req);
  authorize(actor,p,m);
  if(p==='/api/state'&&m==='GET')return send(res,200,snapshot(req));
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
  match=p.match(/^\/api\/candidates\/([a-f0-9-]+)\/process$/);
  if(match&&m==='POST'){
    const draft=await processCandidate(match[1]);
    return send(res,201,draft);
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
  // Structured task queue: the same records the internal worker executes.
  if(p==='/api/tasks'&&m==='POST'){
    const b=await jsonBody(req);
    const result=await store.update(s=>tasks.enqueueTask(s,b));
    return send(res,result.duplicate?200:201,result.task);
  }
  match=p.match(/^\/api\/tasks\/([a-f0-9-]+)\/retry$/);
  if(match&&m==='POST'){const result=await store.update(s=>tasks.retryTask(s,match[1]));return send(res,200,result);}
  match=p.match(/^\/api\/tasks\/([a-f0-9-]+)$/);
  if(match&&m==='DELETE'){const result=await store.update(s=>tasks.cancelTask(s,match[1]));return send(res,200,result);}
  if(p==='/api/reset-demo'&&m==='POST'){
    const result=await store.update(s=>wf.resetDemo(s));
    return send(res,200,result);
  }
  // --- Authenticated account, session, and user management (Phase B) ---
  if(p==='/api/me'&&m==='GET'){const u=requireAuth(req);return send(res,200,{email:u.email,role:u.role});}
  if(p==='/api/auth/password'&&m==='POST'){const u=requireAuth(req);const b=await jsonBody(req);auth.changePassword(u.userId,b.currentPassword,b.newPassword);return send(res,200,{ok:true});}
  if(p==='/api/sessions'&&m==='GET'){const u=requireAuth(req);return send(res,200,{sessions:auth.listSessions(u.userId).map(s=>({...s,current:s.id===u.sessionId}))});}
  if(p==='/api/sessions/revoke-all'&&m==='POST'){const u=requireAuth(req);auth.revokeAll(u.userId,u.sessionId);return send(res,200,{ok:true});}
  match=p.match(/^\/api\/sessions\/([a-f0-9-]+)$/);
  if(match&&m==='DELETE'){const u=requireAuth(req);if(!auth.revokeSession(u.userId,match[1]))fail('Session not found.',404);return send(res,200,{ok:true});}
  if(p==='/api/users'&&m==='GET'){requireRole(req,'admin');return send(res,200,{users:auth.listUsers(),roles:ROLES});}
  if(p==='/api/users'&&m==='POST'){const u=requireRole(req,'admin');const b=await jsonBody(req);return send(res,201,auth.createUser(u,b));}
  match=p.match(/^\/api\/users\/([a-f0-9-]+)$/);
  if(match&&m==='PATCH'){const u=requireRole(req,'admin');const b=await jsonBody(req);return send(res,200,auth.updateUser(u,match[1],b));}
  if(match&&m==='DELETE'){const u=requireRole(req,'admin');return send(res,200,auth.deleteUser(u,match[1]));}
  if(p==='/api/account'&&m==='DELETE'){const u=requireAuth(req);const b=await jsonBody(req);auth.selfDeleteAccount(u.userId,b.password);return send(res,200,{ok:true},{'Set-Cookie':clearCookie()});}
  // --- Paired local agents (admin management) ---
  if(p==='/api/agents/pair'&&m==='POST'){
    requireRole(req,'admin');
    const b=await jsonBody(req);
    const pairing=agent.createPairing(store,DEFAULT_WORKSPACE_ID,{label:b.label,createdBy:actor.email});
    await store.update(s=>activity(s,'agent','Created a local-agent pairing code.',{expiresAt:pairing.expiresAt}));
    return send(res,201,pairing);
  }
  if(p==='/api/agents'&&m==='GET')return send(res,200,{agents:agent.listAgents(store,DEFAULT_WORKSPACE_ID),actions:agent.AGENT_ACTIONS});
  match=p.match(/^\/api\/agents\/([a-f0-9-]+)\/tasks$/);
  if(match&&m==='POST'){
    const b=await jsonBody(req);
    const kind=String(b.kind||'');
    const {task,duplicate}=agent.enqueueAgentTask(store,match[1],{kind,payload:b.payload||{},idempotencyKey:b.idempotencyKey||null,createdBy:actor.email,permission:agent.permissionForKind(kind)});
    if(!duplicate)await store.update(s=>activity(s,'agent',`Queued ${kind} for a local agent.`,{taskId:task.id}));
    return send(res,duplicate?200:201,{...task,payload:JSON.parse(task.payload),duplicate});
  }
  match=p.match(/^\/api\/agents\/([a-f0-9-]+)$/);
  if(match&&m==='PATCH'){
    requireRole(req,'admin');
    const b=await jsonBody(req);
    if(b.name!==undefined)store.run('UPDATE agents SET name=? WHERE id=?',cleanText(b.name,120)||'Local agent',match[1]);
    const result=b.permissions!==undefined?agent.setAgentPermissions(store,match[1],b.permissions):{ok:true};
    await store.update(s=>activity(s,'agent',`Updated local agent permissions.`,{agentId:match[1]}));
    return send(res,200,result);
  }
  if(match&&m==='DELETE'){
    requireRole(req,'admin');
    const result=agent.revokeAgent(store,match[1]);
    await store.update(s=>activity(s,'agent','Revoked a local agent. Its in-flight tasks were failed, not dropped silently.',{agentId:match[1]}));
    return send(res,200,result);
  }
  // --- Credential vault: encrypted at rest, revealed only by admins ---
  if(p==='/api/credentials'&&m==='GET')return send(res,200,{credentials:credentials.listCredentials(store,DEFAULT_WORKSPACE_ID)});
  if(p==='/api/credentials'&&m==='POST'){
    requireRole(req,'admin');
    const b=await jsonBody(req);
    const result=credentials.addCredential(store,DEFAULT_WORKSPACE_ID,{...b,createdBy:actor.email});
    await store.update(s=>activity(s,'credential',`Stored credential "${String(b.name||'').slice(0,60)}".`,{credentialId:result.id}));
    return send(res,201,result);
  }
  match=p.match(/^\/api\/credentials\/([a-f0-9-]+)\/reveal$/);
  if(match&&m==='POST'){
    // Admins only: the reveal returns plaintext and is written to the audit log.
    requireRole(req,'admin');
    const item=credentials.revealCredential(store,DEFAULT_WORKSPACE_ID,match[1]);
    await store.update(s=>activity(s,'credential',`Revealed credential "${String(item.name).slice(0,60)}".`,{credentialId:item.id}));
    return send(res,200,item);
  }
  match=p.match(/^\/api\/credentials\/([a-f0-9-]+)$/);
  if(match&&m==='DELETE'){
    requireRole(req,'admin');
    const result=credentials.deleteCredential(store,DEFAULT_WORKSPACE_ID,match[1]);
    await store.update(s=>activity(s,'credential','Deleted a credential.',{credentialId:match[1]}));
    return send(res,200,result);
  }
  // --- Retention: preview then apply the workspace policy ---
  // --- Notifications: feed, read state, and per-user channel preferences ---
  if(p==='/api/notifications'&&m==='GET'){
    const u=requireAuth(req);
    return send(res,200,{notifications:notifications.listNotifications(store,u.userId),unread:notifications.unreadCount(store,u.userId)});
  }
  match=p.match(/^\/api\/notifications\/read$/);
  if(match&&m==='POST'){
    const u=requireAuth(req);
    const b=await jsonBody(req);
    return send(res,200,notifications.markRead(store,u.userId,Array.isArray(b?.ids)?b.ids:[b?.ids].filter(Boolean)));
  }
  if(p==='/api/notification-prefs'&&m==='GET'){const u=requireAuth(req);return send(res,200,notifications.getPreferences(store,u.userId));}
  if(p==='/api/notification-prefs'&&m==='PATCH'){
    const u=requireAuth(req);
    const b=await jsonBody(req);
    return send(res,200,notifications.updatePreferences(store,u.userId,b));
  }
  if(p==='/api/retention/preview'&&m==='GET'){
    const state=store.read();
    return send(res,200,{policy:retentionSettings(state),preview:pruneState(state,{dryRun:true})});
  }
  if(p==='/api/retention/prune'&&m==='POST'){
    const report=await store.update(s=>pruneState(s));
    return send(res,200,report);
  }
  // --- Backup: export/restore. Credentials and sessions never travel ---
  if(p==='/api/admin/backup'&&m==='GET'){
    requireRole(req,'admin');
    return send(res,200,backup.exportBackup(store));
  }
  if(p==='/api/admin/restore'&&m==='POST'){
    requireRole(req,'admin');
    const b=await jsonBody(req);
    const result=backup.importBackup(store,b,{force:Boolean(b.force)});
    await store.update(s=>activity(s,'backup',`Restored a backup into this installation (${result.restored} rows).`));
    return send(res,200,result);
  }
  // --- Source evidence: what supports a draft, verified by whom ---
  match=p.match(/^\/api\/drafts\/([a-f0-9-]+)\/evidence$/);
  if(match&&m==='POST'){
    const b=await jsonBody(req);
    const item=await store.update(s=>evidence.addEvidence(s,{...b,draftId:match[1],createdBy:actor.email}));
    return send(res,201,item);
  }
  match=p.match(/^\/api\/evidence\/([a-f0-9-]+)\/verify$/);
  if(match&&m==='POST'){
    const b=await jsonBody(req);
    const item=await store.update(s=>evidence.verifyEvidence(s,match[1],b.status,{actor:actor.email}));
    return send(res,200,item);
  }
  match=p.match(/^\/api\/evidence\/([a-f0-9-]+)$/);
  if(match&&m==='DELETE'){const result=await store.update(s=>evidence.dropEvidence(s,match[1]));return send(res,200,result);}
  fail('Unknown endpoint.',404);
}
const ASSETS=new Set(['index.html','app.css','polish.css','usability.css','transport.js','local-api.js','app.js','core.js','workflow.js','tasks.js','evidence.js','contracts.js','retention.js','coordination.js','group-simulator.js','chat-engine.js','usability.js','demo-feed.html']);
async function serve(req,res,u){
  let rel=u.pathname==='/'?'index.html':u.pathname.slice(1);
  if(!ASSETS.has(rel))return send(res,404,{error:'Not found'});
  try {const body=await fs.readFile(path.join(PUBLIC,rel));res.writeHead(200,{'Content-Type':TYPES[rel.split('.').pop()]||'application/octet-stream','Content-Security-Policy':CSP,...SECURITY,'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:body);}catch{return send(res,404,{error:'Missing asset'});}
}const handler=async(req,res)=>{
  try{
    const host=req.headers.host||'localhost';const url=new URL(req.url,`http://${host}`);
    checkOrigin(req);
    if(url.pathname.startsWith('/api/'))await api(req,res,url);
    else if(req.method==='GET'||req.method==='HEAD')await serve(req,res,url);
    else fail('Method not allowed.',405);
  }catch(e){let status=e.status||500;console.error(status===500?'Server error: '+e.message:'');if(res.headersSent){res.end();return;}send(res,status,{error:status===500?'Internal server error':e.message});}
};
// Optional in-process TLS. A reverse proxy is still the recommended front for
// a real deployment; this exists so a private single-host install can serve
// HTTPS without one. `req.socket.encrypted` drives the Secure cookie flag.
const TLS={cert:process.env.TLS_CERT,key:process.env.TLS_KEY};
let server;
if(TLS.cert||TLS.key){
  if(!TLS.cert||!TLS.key)throw new Error('TLS_CERT and TLS_KEY must be set together. Remove both to serve plain HTTP (local use only).');
  let cert,key;
  try{cert=await fs.readFile(TLS.cert);key=await fs.readFile(TLS.key);}
  catch(e){throw new Error(`TLS_CERT/TLS_KEY could not be read: ${e.message}`);}
  server=https.createServer({cert,key},handler);
  console.log(`TLS: serving HTTPS from ${TLS.cert}`);
}else server=http.createServer(handler);
// Fail loudly on a misconfiguration that would silently weaken security, and
// warn about the rest; every check is about the deployment, not the app logic.
function preflight(){
  const origin=process.env.PUBLIC_ORIGIN||'';
  if(origin&&!/^https?:\/\//.test(origin))throw new Error('PUBLIC_ORIGIN must be an absolute http(s) URL, e.g. https://dash.example.com');
  if(HSTS_ENABLED&&!origin.startsWith('https://'))console.warn('config: HSTS is on but PUBLIC_ORIGIN is not https. Only enable it behind TLS termination.');
  if(!process.env.DASHBOARD_PASSWORD)console.warn('config: no DASHBOARD_PASSWORD set. A random password is printed each boot; set one for a stable login.');
  if(HOST!=='127.0.0.1'&&HOST!=='localhost'&&!origin.startsWith('https://'))console.warn('config: binding to '+HOST+' without HTTPS. Put TLS in front (reverse proxy).');
}
preflight();
server.listen(PORT,HOST,()=>{
  console.log(`\nAgent Control Prototype: http${server instanceof https.Server?'s':''}://${HOST}:${PORT}`);
  if(!process.env.DASHBOARD_PASSWORD) console.log(`Temporary dashboard password (changes on restart): ${PASSWORD}`);
  console.log(`AI mode: ${isLive()?`Connected · ${aiModel()} @ ${aiProvider()}`:'Template drafts (no AI provider configured)'}`);
  if(HOST!=='127.0.0.1'&&HOST!=='localhost')console.warn('WARNING: Use HTTPS plus a private network / access proxy for remote access.');
});
process.on('SIGINT',()=>{stopQueue();stopScheduler();stopRetention();server.close(()=>process.exit(0));});
