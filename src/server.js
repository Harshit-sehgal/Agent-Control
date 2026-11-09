import './env.js'; // load .env before anything reads process.env
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {ASSETS} from '../shared/assets.js';
import {openStore as openSqliteStore} from './sqlite-store.js';
import {scoreCandidate,CSP} from '../shared/core.js';
import * as wf from '../shared/workflow.js';
import * as agent from './agent.js';
import {aiEnabled,aiModel,aiProvider,makeDraft} from './ai.js';
import {resolveConfig} from './ai-providers.js';
import {startScheduler,startRetention} from './scheduler.js';
import {markInterrupted} from './coordination.js';
import {createQueue,recoverQueue} from './queue.js';
import {taskHandlers,createNotifier} from './handlers.js';
import {smtpConfig} from './mail.js';
import {Auth} from './auth.js';
import {openWorkspaces} from './workspaces.js';
import {createPush} from './push.js';
import {fail,send,cookie,checkOrigin,rawBody,safeJson,SECURITY,HSTS_ENABLED} from './http.js';
import {createRouter,isReply,allows} from './router.js';
import {publicRoutes} from './routes-public.js';
import {workflowRoutes} from './routes-workflow.js';
import {groupRoutes} from './routes-groups.js';
import {accountRoutes} from './routes-account.js';
import {workspaceRoutes} from './routes-workspaces.js';
import {pushRoutes} from './routes-push.js';
import {aiRoutes} from './routes-ai.js';
import {memoryRoutes} from './routes-memory.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PUBLIC=path.join(ROOT,'shared');
// The /api/health version is the package version, not a literal, so a release
// bump cannot drift away from the health endpoint.
const VERSION=JSON.parse(await fs.readFile(path.join(ROOT,'package.json'),'utf8')).version;
const PORT=Number(process.env.PORT||4173);
const HOST=process.env.HOST||'127.0.0.1';
const STORE_PATH=process.env.DATA_FILE||path.join(ROOT,'data','state.json');
const PASSWORD=process.env.DASHBOARD_PASSWORD||crypto.randomBytes(12).toString('base64url');
const store=await openSqliteStore(STORE_PATH);
// First boot bootstraps the owner account from DASHBOARD_PASSWORD; afterwards
// sessions, resets and roles live in the database.
const auth=new Auth(store);
auth.ensureBootstrap(PASSWORD);
// Paired-agent secrets are encrypted with this key; MASTER_KEY overrides the
// auto-generated keyfile that lives with the data directory.
agent.attachVault(store,STORE_PATH);
const push=createPush(store);
/** Agent-protocol retention. Pairing codes and agent tasks are not part of the
 * workflow document, so `pruneState()` never sees them; this is the same daily
 * sweep for those two tables. Work is tracked so a workspace being restored
 * never has raw SQL run against its file mid-swap. */
function startAgentRetention(ws,intervalMs=86400000){
  let busy=false,stopped=false;
  const run=async()=>{if(busy||stopped)return;busy=true;try{
    const report=ws.trackWork?await ws.trackWork(async()=>ws.pruneAgentRows()):ws.pruneAgentRows();
    if(report.pairingCodes||report.agentTasks)console.log(`Retention pruned ${report.pairingCodes} pairing code(s), ${report.agentTasks} agent task record(s).`);
  }catch(e){if(e?.status!==503)console.error('Agent retention error:',e.message);}finally{busy=false;}};
  void run();
  const timer=setInterval(()=>void run(),intervalMs);timer.unref();
  return async()=>{stopped=true;clearInterval(timer);if(busy)await new Promise(resolve=>setTimeout(resolve,50));};
}
/** Everything that runs in the background for one workspace: the handoff
 * clock, retention and the task queue, each bound to that workspace's store.
 * Returns the function that stops them. */
function startWorkspace(ws,workspaceId){
  const ready=(async()=>{
    await ws.update(s=>{wf.migrate(s);wf.recoverInterrupted(s);});
    await markInterrupted(ws);
    await recoverQueue(ws);
  })();
  // Tasks orphaned by a disconnected agent are re-armed at boot rather
  // than left leased to a process that no longer exists.
  const recoveredAgentTasks=agent.recoverAgentTasks(ws);
  if(recoveredAgentTasks)console.log(`Re-armed ${recoveredAgentTasks} agent task(s) from a previous run.`);
  // Notifications enqueue themselves as queue tasks and fan out to the member's
  // devices; the queue handler map lives in src/handlers.js.
  const notify=createNotifier({ws,workspaceId,auth,push});
  const queue=createQueue(ws,taskHandlers({ws,workspaceId,auth,push,notify,processCandidate}),{onFail:(task,error)=>task.payload?.channel==='push'?null:Promise.resolve(notify({title:'A background task failed',body:`${task.title}: ${error.message}`,kind:'task-failure',meta:{taskId:task.id}}))});
  // Nothing runs until recovery has finished, so a stalled task is re-armed
  // before the first sweep can see it.
  let stops=[],stopped=false;
  ready.then(()=>{if(!stopped)stops=[startScheduler(ws),startRetention(ws),startAgentRetention(ws),queue.start()];}).catch(error=>console.error(`Workspace ${workspaceId} failed to start:`,error.message));
  const stop=async()=>{stopped=true;await ready.catch(()=>{});for(const s of stops)await s();};
  stop.ready=ready;
  return stop;
}
const workspaces=await openWorkspaces(store,auth,startWorkspace);
if(store.recoveredFrom)console.warn(`WARNING: ${STORE_PATH} was unreadable and has been moved to ${store.recoveredFrom}. A fresh state was created.`);
const TYPES={'html':'text/html; charset=utf-8','js':'text/javascript; charset=utf-8','css':'text/css; charset=utf-8','svg':'image/svg+xml','png':'image/png','ico':'image/x-icon','webmanifest':'application/manifest+json'};
const isLive=()=>aiEnabled();
/** Shared by the HTTP route and the queue worker: score a candidate and
 * produce a draft, releasing the candidate if anything fails so a transient
 * provider error never strands it. */
async function processCandidate(store,id){
  const context=await store.update(s=>wf.beginProcessing(s,id));
  try{
    const evaluation=scoreCandidate(context.candidate,context.settings.topics);
    const result=await makeDraft(context.candidate,context.settings,'',resolveConfig(store,null));
    return await store.update(s=>wf.finishProcessing(s,id,evaluation,result));
  } catch(e){
    // The candidate may have been deleted (or the write may have failed) while
    // the provider was working. Recording the failure must never replace the
    // real drafting error with the transition's own 404 or leave the row in
    // `processing`, so the fallback writes the stored document directly.
    try{await store.update(s=>wf.failProcessing(s,id,e.message));}
    catch(releaseError){
      try{store.failCandidate(id);}
      catch(resetError){console.error(`Could not release candidate ${id}:`,resetError.message);}
      if(releaseError?.status!==404)console.error(`Could not record the draft failure for ${id}:`,releaseError.message);
    }
    throw e;
  }
}

// Every API route lives in a route module and is registered with the access it
// needs (see src/router.js). This file only wires them to the running services.
const router=createRouter();
const app={store,auth,workspaces,push,processCandidate,version:VERSION};
publicRoutes(router,app);
workflowRoutes(router,app);
groupRoutes(router,app);
accountRoutes(router,app);
workspaceRoutes(router,app);
pushRoutes(router,app);
aiRoutes(router,app);
memoryRoutes(router);

async function api(req,res,u){
  const found=router.find(req.method,u.pathname),access=found?.route.access;
  let actor=null;
  // A session is checked before the route is, so an anonymous caller learns
  // nothing about which paths exist. Then the route's declared role applies,
  // before the body is read.
  if(access!=='public'&&access!=='agent'){
    actor=auth.session(cookie(req,'agent_session'));
    if(!actor)fail('Sign in first.',401);
    if(!found){
      // The path exists, the verb does not. Anonymous callers still get the same
      // "sign in first" above, so this tells a signed-in client nothing it could
      // not already read from the UI.
      const methods=router.methodsFor(u.pathname);
      if(!methods.length)fail('Unknown endpoint.',404);
      throw Object.assign(new Error('Method not allowed.'),{status:405,allow:methods.join(', ')});
    }
    if(!allows(actor.role,access))fail(`This action needs the ${access} role or higher.`,403);
  }
  // Bodies are read on demand: a handler that rate-limits or verifies a
  // signature does so before any JSON is parsed.
  // A signed-in request works on its session's workspace and no other. Routes
  // without a session find their workspace from what the caller presents.
  const scope=actor?workspaces.get(actor.workspaceId):null;
  if(actor&&!scope)fail('This workspace is no longer available. Sign in again.',401);
  let raw,parsed;
  const context={req,path:u.pathname,params:found.params,actor,store:scope,
    raw:async()=>raw??=await rawBody(req),
    // An optional limit lets a route that legitimately carries a large document
    // (a backup restore) ask for more than the 128 KB default.
    body:async(limit=128*1024)=>parsed??=safeJson(await rawBody(req,limit))};
  const invoke=()=>found.route.handler(context);
  // A route that manages the whole workspace (restore, delete) runs outside the
  // work tracker: the tracker exists so those operations can wait for in-flight
  // requests, so the operation itself must not count as one and wait on itself.
  const result=scope?.trackWork&&found.route.tracksWork
    ? await scope.trackWork(invoke)
    : await invoke();
  const {status,body,headers}=isReply(result)?result:{status:200,body:result,headers:{}};
  if(req.method==='HEAD'){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...SECURITY,...headers});return res.end();}
  send(res,status,body,headers);
}
// The served files are the same list the Pages build ships (shared/assets.js),
// so a UI module cannot be added to one and forgotten in the other.
const SERVED=new Set(ASSETS);
async function serve(req,res,u){
  let rel=u.pathname==='/'?'index.html':u.pathname.slice(1);
  if(!SERVED.has(rel))return send(res,404,{error:'Not found'});
  try {const body=await fs.readFile(path.join(PUBLIC,rel));res.writeHead(200,{'Content-Type':TYPES[rel.split('.').pop()]||'application/octet-stream','Content-Security-Policy':CSP,...SECURITY,'Cache-Control':'no-store'});res.end(req.method==='HEAD'?undefined:body);}catch{return send(res,404,{error:'Missing asset'});}
}
const handler=async(req,res)=>{
  try{
    const host=req.headers.host||'localhost';const url=new URL(req.url,`http://${host}`);
    checkOrigin(req);
    if(url.pathname.startsWith('/api/'))await api(req,res,url);
    else if(req.method==='GET'||req.method==='HEAD')await serve(req,res,url);
    else fail('Method not allowed.',405);
  }catch(e){let status=e.status||500;console.error(status===500?'Server error: '+e.message:'');if(res.headersSent){res.end();return;}send(res,status,{error:status===500?'Internal server error':e.message},e.allow?{Allow:e.allow}:undefined);}
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
  // A mailbox typo should surface at boot, not on the first reminder: an
  // impossible value throws here, and a risky one is only warned about.
  const mail=smtpConfig();
  if(mail){
    if(!mail.requireTls&&!mail.secure)console.warn('config: SMTP_REQUIRE_TLS=0, so mail may be submitted in cleartext. Only do that for a relay on your own network.');
    if(!mail.from)console.warn('config: SMTP_HOST is set without SMTP_FROM or SMTP_USER, so there is no sender address.');
    if(mail.user&&!mail.pass)console.warn('config: SMTP_USER is set without SMTP_PASS; AUTH will fail.');
  }
}
preflight();
server.listen(PORT,HOST,()=>{
  console.log(`\nAgent Control Prototype: http${server instanceof https.Server?'s':''}://${HOST}:${PORT}`);
  if(!process.env.DASHBOARD_PASSWORD) console.log(`Temporary dashboard password (changes on restart): ${PASSWORD}`);
  console.log(`AI mode: ${isLive()?`Connected · ${aiModel()} @ ${aiProvider()}`:'No AI_API_KEY in the environment. Add a provider under You → AI and models, or set AI_API_KEY.'}`);
  if(HOST!=='127.0.0.1'&&HOST!=='localhost')console.warn('WARNING: Use HTTPS plus a private network / access proxy for remote access.');
});
process.on('SIGINT',()=>{void workspaces.stop().finally(()=>server.close(()=>process.exit(0)));});
// A container stops the process with SIGTERM, so it needs the same drain as
// Ctrl-C instead of being killed with requests and leases still open.
process.on('SIGTERM',()=>{void workspaces.stop().finally(()=>server.close(()=>process.exit(0)));});
