import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import crypto from 'node:crypto';
import {JsonStore} from './store.js';
import {activity,candidateInput,cleanText,initialState,markDue,scoreCandidate,scheduleApproval,uuid,validHttpUrl} from './core.js';
import {aiEnabled,makeDraft,executeCustomBot} from './ai.js';
import {startScheduler} from './scheduler.js';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const PUBLIC=path.join(ROOT,'public');
const PORT=Number(process.env.PORT||4173);
const HOST=process.env.HOST||'127.0.0.1';
const STORE_PATH=process.env.DATA_FILE||path.join(ROOT,'data','state.json');
const PASSWORD=process.env.DASHBOARD_PASSWORD||crypto.randomBytes(12).toString('base64url');
const sessions=new Map(), attempts=new Map();
const store=await new JsonStore(STORE_PATH).init();
const stopScheduler=startScheduler(store);
const TYPES={'html':'text/html; charset=utf-8','js':'text/javascript; charset=utf-8','css':'text/css; charset=utf-8','svg':'image/svg+xml','png':'image/png','ico':'image/x-icon'};
const isLive=()=>aiEnabled();
function fail(message,status=400){throw Object.assign(new Error(message),{status});}
function send(res,status,value,headers={}){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers});res.end(JSON.stringify(value));}
function cookie(req,key){const found=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(key+'='));return found?.slice(key.length+1);}
function authed(req){const sid=cookie(req,'agent_session'),s=sid&&sessions.get(sid);if(!s)return false;if(s.exp<Date.now()){sessions.delete(sid);return false;}return true;}
function requireAuth(req){if(!authed(req))fail('Sign in first.',401);}
function timingEqual(a,b){const h1=crypto.createHash('sha256').update(String(a)).digest(),h2=crypto.createHash('sha256').update(String(b)).digest();return crypto.timingSafeEqual(h1,h2);}
function checkOrigin(req){if(req.url?.split('?')[0]==='/api/capture')return; if(!['POST','PATCH','DELETE','PUT'].includes(req.method))return;
  const origin=req.headers.origin;
  if(!origin)return; // Nonbrowser clients still require authenticated session/capture token.
  const possible=[`http://${req.headers.host}`,`https://${req.headers.host}`,process.env.PUBLIC_ORIGIN].filter(Boolean);
  if(!possible.includes(origin))fail('Cross-origin request rejected.',403);
}
async function jsonBody(req){let total=0;const chunks=[];for await (const chunk of req){total+=chunk.length;if(total>128*1024)fail('Request too large.',413);chunks.push(chunk);}try{return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');}catch{fail('Invalid JSON.',400);}}
function findDraft(s,id){const draft=s.drafts.find(x=>x.id===id);if(!draft)fail('Draft not found.',404);return draft;}
function findCandidate(s,id){const item=s.candidates.find(x=>x.id===id);if(!item)fail('Candidate not found.',404);return item;}
function snapshot(){const s=store.read();return {...s,aiEnabled:isLive(),serverTime:new Date().toISOString()};}
async function api(req,res,u){
  const p=u.pathname,m=req.method;
  if(p==='/api/health'&&m==='GET')return send(res,200,{ok:true,version:'0.1.0'});
  if(p==='/api/login'&&m==='POST'){
    const ip=req.socket.remoteAddress||'unknown',record=attempts.get(ip)||{count:0,until:0};
    if(Date.now()>record.until){record.count=0;record.until=Date.now()+900000;}
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
    const result=await store.update(s=>{
      const dup=s.candidates.find(x=>x.url===body.url&&x.text===body.text);
      if(dup)return {candidate:dup,duplicate:true};
      const candidate={...body,id:uuid(),status:'new',createdAt:new Date().toISOString()};
      s.candidates.unshift(candidate);activity(s,'capture',`Captured a post from ${candidate.author}.`,{candidateId:candidate.id});return {candidate,duplicate:false};
    });return send(res,result.duplicate?200:201,result);
  }
  requireAuth(req);
  if(p==='/api/state'&&m==='GET')return send(res,200,snapshot());
  if(p==='/api/settings'&&m==='PATCH'){
    const b=await jsonBody(req);
    const result=await store.update(s=>{
      if(b.style!==undefined)s.settings.style=cleanText(b.style,1000);
      if(b.opinions!==undefined)s.settings.opinions=cleanText(b.opinions,1000);
      if(b.topics!==undefined){if(!Array.isArray(b.topics))fail('Topics must be an array.');s.settings.topics=b.topics.slice(0,30).map(v=>cleanText(v,60)).filter(Boolean);}
      if(b.minDelay!==undefined||b.maxDelay!==undefined){const a=b.minDelay??s.settings.minDelay,c=b.maxDelay??s.settings.maxDelay;if(!Number.isInteger(a)||!Number.isInteger(c)||a<0||c>1440||a>c)fail('Invalid delay window.');s.settings.minDelay=a;s.settings.maxDelay=c;}
      activity(s,'settings','Updated user preferences.');return s.settings;
    });return send(res,200,result);
  }
  if(p==='/api/demo/seed'&&m==='POST'){
    const sample=[
      {url:'https://example.com/robotics-demo',text:'What would make robotics models genuinely useful outside a lab? I care more about reliability than demos.',author:'Demo robotics account',topic:'robotics'},
      {url:'https://example.com/ai-demo',text:'New AI coding benchmark released. Does a benchmark really tell you how the model performs on a messy production codebase?',author:'Demo AI account',topic:'AI'},
      {url:'https://example.com/misc-demo',text:'It is a nice day today.',author:'Demo lifestyle account',topic:'other'}
    ];
    const result=await store.update(s=>{let count=0;for(const b of sample){if(s.candidates.some(c=>c.url===b.url))continue;s.candidates.push({...b,id:uuid(),status:'new',createdAt:new Date().toISOString(),demo:true});count++;}activity(s,'demo',`Loaded ${count} demo candidate(s).`);return {added:count};});return send(res,200,result);
  }
  if(p==='/api/candidates'&&m==='POST'){
    const b=candidateInput(await jsonBody(req));const result=await store.update(s=>{
      const existing=s.candidates.find(c=>c.url===b.url&&c.text===b.text);if(existing)return existing;
      const candidate={...b,id:uuid(),status:'new',createdAt:new Date().toISOString()};s.candidates.unshift(candidate);activity(s,'capture',`Added a candidate from ${b.author}.`,{candidateId:candidate.id});return candidate;
    });return send(res,201,result);
  }
  let match=p.match(/^\/api\/candidates\/([a-f0-9-]+)\/process$/);
  if(match&&m==='POST'){
    const id=match[1];
    const context=await store.update(s=>{
      const c=findCandidate(s,id);if(c.status==='processing')fail('Candidate already processing.',409);
      c.status='processing';return {candidate:structuredClone(c),settings:structuredClone(s.settings)};
    });
    try{
      const evaluation=scoreCandidate(context.candidate,context.settings.topics);
      const result=await makeDraft(context.candidate,context.settings);
      const newDraft=await store.update(s=>{
        const c=findCandidate(s,id);c.status='drafted';c.score=evaluation;
        const draft={id:uuid(),candidateId:id,author:c.author,url:c.url,sourceText:c.text,text:result.text,revision:1,status:'pending',score:evaluation.score,mode:result.mode,note:result.note,createdAt:new Date().toISOString()};
        s.drafts.unshift(draft);activity(s,'draft',`Created ${result.mode} draft for ${c.author}.`,{draftId:draft.id});return draft;
      });return send(res,201,newDraft);
    } catch(e){await store.update(s=>{findCandidate(s,id).status='error';activity(s,'error',`Draft failed: ${e.message.slice(0,160)}`);});throw e;}
  }
  match=p.match(/^\/api\/drafts\/([a-f0-9-]+)$/);
  if(match&&m==='PATCH'){
    const b=await jsonBody(req),text=cleanText(b.text,3000);
    if(!text)fail('Draft cannot be empty.');
    const d=await store.update(s=>{
      const d=findDraft(s,match[1]);if(!['pending','scheduled','ready'].includes(d.status))fail('Draft cannot be edited in this state.',409);
      // Invalidate earlier approval and schedule on EVERY edit.
      d.text=text;d.revision++;d.status='pending';delete d.approvedText;delete d.approvedRevision;delete d.dueAt;delete d.approvedAt;
      activity(s,'edit',`Edited draft. Revision ${d.revision}; previous approval cleared.`,{draftId:d.id});return d;
    });return send(res,200,d);
  }
  match=p.match(/^\/api\/drafts\/([a-f0-9-]+)\/(approve|reject|ready|posted|rewrite)$/);
  if(match&&m==='POST'){
    const [_,id,action]=match;
    if(action==='rewrite'){
      const b=await jsonBody(req),existing=store.read(),old=findDraft(existing,id),c=findCandidate(existing,old.candidateId);
      if(!['pending','scheduled','ready'].includes(old.status))fail('Cannot rewrite this draft.',409);
      const out=await makeDraft(c,existing.settings,b.direction||'');
      const d=await store.update(s=>{
        const x=findDraft(s,id);if(x.revision!==old.revision)fail('Draft changed during rewrite. Retry.',409);
        x.text=out.text;x.revision++;x.status='pending';x.mode=out.mode;x.note=out.note;
        delete x.approvedText;delete x.approvedRevision;delete x.dueAt;delete x.approvedAt;
        activity(s,'rewrite',`Rewrote draft ${x.id}.`,{draftId:x.id});return x;
      });return send(res,200,d);
    }
    const b=await jsonBody(req);
    const d=await store.update(s=>{
      const x=findDraft(s,id);
      if(action==='approve'){
        scheduleApproval(x,b.minDelay??s.settings.minDelay,b.maxDelay??s.settings.maxDelay);
        activity(s,'approve',`Approved exact revision ${x.revision}.`,{draftId:id,dueAt:x.dueAt});
      }else if(action==='reject'){
        if(!['pending','scheduled','ready'].includes(x.status))fail('Cannot reject this draft.',409);
        x.status='rejected';activity(s,'reject',`Rejected draft.`,{draftId:id});
      }else if(action==='ready'){
        if(x.status!=='scheduled')fail('Only scheduled drafts can become ready.',409);
        // Allow manual acceleration of an already approved draft.
        x.status='ready';activity(s,'ready','Draft released for manual posting.',{draftId:id});
      }else if(action==='posted'){
        if(x.status!=='ready')fail('Only ready drafts may be marked posted.',409);
        if(x.approvedRevision!==x.revision||x.approvedText!==x.text)fail('Approval no longer matches draft.',409);
        x.status='posted';x.postedAt=new Date().toISOString();
        activity(s,'posted','User marked a draft as posted manually.',{draftId:id});
      }
      return x;
    });return send(res,200,d);
  }
  if(p==='/api/groups'&&m==='POST'){
    const b=await jsonBody(req),name=cleanText(b.name,80);
    if(!name)fail('Group name required.');
    const group=await store.update(s=>{
      const g={id:uuid(),name,description:cleanText(b.description,300),bots:[]};s.groups.push(g);activity(s,'group',`Created group ${name}.`);return g;
    });return send(res,201,group);
  }
  match=p.match(/^\/api\/groups\/([a-z0-9-]+)\/bots$/);
  if(match&&m==='POST'){
    const b=await jsonBody(req),name=cleanText(b.name,80),instructions=cleanText(b.instructions,3000);
    if(!name||!instructions)fail('Bot name and instructions required.');
    const bot=await store.update(s=>{
      const g=s.groups.find(g=>g.id===match[1]);if(!g)fail('Group not found.',404);
      const bot={id:uuid(),name,instructions,type:'custom'};g.bots.push(bot);activity(s,'bot',`Created bot ${name}.`);return bot;
    });return send(res,201,bot);
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
    const b=await jsonBody(req),label=cleanText(b.label,200),kind=b.kind;
    if(!label||!['once','interval'].includes(kind))fail('Label and valid schedule kind required.');
    let nextAt,intervalMinutes=null;
    if(kind==='once'){
      const when=Date.parse(b.nextAt);if(!Number.isFinite(when)||when<Date.now()+1000||when>Date.now()+365*86400000)fail('Choose a future date within one year.');nextAt=new Date(when).toISOString();
    }else{
      intervalMinutes=Number(b.intervalMinutes);if(!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>10080)fail('Interval must be 1–10080 minutes.');
      nextAt=new Date(Date.now()+intervalMinutes*60000).toISOString();
    }
    const item=await store.update(s=>{const item={id:uuid(),label,kind,nextAt,intervalMinutes,enabled:true};s.schedules.unshift(item);activity(s,'schedule',`Added reminder: ${label}`);return item;});return send(res,201,item);
  }
  match=p.match(/^\/api\/schedules\/([a-f0-9-]+)$/);
  if(match&&m==='DELETE'){const result=await store.update(s=>{const i=s.schedules.findIndex(x=>x.id===match[1]);if(i<0)fail('Schedule not found.',404);const item=s.schedules.splice(i,1)[0];activity(s,'schedule',`Removed reminder: ${item.label}`);return {ok:true};});return send(res,200,result);}
  if(p==='/api/reset-demo'&&m==='POST'){
    const result=await store.update(s=>{s.candidates=s.candidates.filter(x=>!x.demo);s.drafts=s.drafts.filter(x=>s.candidates.some(c=>c.id===x.candidateId));activity(s,'demo','Removed demo candidates and drafts.');return {ok:true};});return send(res,200,result);
  }
  fail('Unknown endpoint.',404);
}
async function serve(req,res,u){
  let rel=u.pathname==='/'?'index.html':u.pathname.slice(1);
  if(!['index.html','app.css','app.js','demo-feed.html'].includes(rel))return send(res,404,{error:'Not found'});
  try {const body=await fs.readFile(path.join(PUBLIC,rel));res.writeHead(200,{'Content-Type':TYPES[rel.split('.').pop()]||'application/octet-stream','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'",'X-Content-Type-Options':'nosniff','Cache-Control':'no-store'});res.end(body);}catch{return send(res,404,{error:'Missing asset'});}
}
const server=http.createServer(async(req,res)=>{
  try{
    const host=req.headers.host||'localhost';const url=new URL(req.url,`http://${host}`);
    checkOrigin(req);
    if(url.pathname.startsWith('/api/'))await api(req,res,url);
    else if(req.method==='GET')await serve(req,res,url);
    else fail('Method not allowed.',405);
  }catch(e){let status=e.status||500;console.error(status===500?'Server error: '+e.message:'');if(res.headersSent){res.end();return;}send(res,status,{error:status===500?'Internal server error':e.message});}
});
server.listen(PORT,HOST,()=>{
  console.log(`\nAgent Control Prototype: http://${HOST}:${PORT}`);
  if(!process.env.DASHBOARD_PASSWORD) console.log(`Temporary dashboard password (changes on restart): ${PASSWORD}`);
  console.log(`AI mode: ${isLive()?'Connected API':'Template drafts (no API key)'}`);
  if(HOST!=='127.0.0.1'&&HOST!=='localhost')console.warn('WARNING: Use HTTPS plus a private network / access proxy for remote access.');
});
process.on('SIGINT',()=>{stopScheduler();server.close(()=>process.exit(0));});
