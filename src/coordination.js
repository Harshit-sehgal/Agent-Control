/** Persistent Node group orchestrator. All execution is local, read/compose only.
 * No browser or external-action tools are given to model workers.
 */
import {randomUUID} from 'node:crypto';
import {createRun,createEnvelope,MAX_HANDOFFS} from '../shared/coordination.js';
import {executeCustomBot,aiEnabled} from './ai.js';
import {activity} from '../shared/core.js';
const running=new Set();
const clean=v=>String(v??'').slice(0,4000);
const stamp=()=>new Date().toISOString();
export function coordinationState(s){s.groupMessages??={};s.groupRuns??=[];}
export async function markInterrupted(store){
  await store.update(s=>{coordinationState(s);for(const r of s.groupRuns){if(r.status==='running'||r.status==='queued'){r.status='interrupted';r.error='Server restarted before the run completed. Retry explicitly to avoid duplicate model calls.';}}});
}
export async function queueGroupRun(store,{groupId,message,directBotId=null}){
  // Validate the request against the store first so a missing group reports 404
  // and a busy group reports 409, instead of the AI-key check shadowing them
  // with a misleading 422 on an instance that simply has no key yet.
  const snapshot=store.read();
  const probe=snapshot.groups.find(g=>g.id===groupId);
  if(!probe)throw Object.assign(new Error('Group not found'),{status:404});
  if(snapshot.groupRuns?.filter(r=>r.groupId===groupId&&['running','queued'].includes(r.status)).length>=1)throw Object.assign(new Error('A group run is already active. Wait or retry later.'),{status:409});
  if(!aiEnabled())throw Object.assign(new Error('Set OPENAI_API_KEY on the Node server for real agent-to-agent model execution. GitHub Pages runs a labeled simulation.'),{status:422});
  const id=await store.update(s=>{
    coordinationState(s);
    const group=s.groups.find(g=>g.id===groupId);
    if(!group)throw Object.assign(new Error('Group not found'),{status:404});
    if(s.groupRuns.filter(r=>r.groupId===groupId&&['running','queued'].includes(r.status)).length>=1)throw Object.assign(new Error('A group run is already active. Wait or retry later.'),{status:409});
    const run=createRun({group,message:clean(message),directBotId,makeId:randomUUID});
    if(run.recipients.length>MAX_HANDOFFS)throw Object.assign(new Error('Run too long.'),{status:400});
    s.groupRuns.unshift(run);s.groupRuns=s.groupRuns.slice(0,100);
    s.groupMessages[groupId]??=[];
    s.groupMessages[groupId].push({id:randomUUID(),runId:run.id,role:'user',text:run.input,at:stamp()});
    activity(s,'group-run',`Queued ${group.name} coordination run`,{runId:run.id});return run.id;
  });
  // The API response is not blocked by model inference. The execution is bounded.
  void runGroup(store,id).catch(error=>console.error('Group execution:',error.message));
  return {runId:id,status:'queued'};
}
export async function runGroup(store,id,executor=executeCustomBot){
  if(running.has(id))return;running.add(id);
  try{
    await store.update(s=>{coordinationState(s);const r=s.groupRuns.find(x=>x.id===id);if(!r||r.status!=='queued')throw new Error('Run is not queued');r.status='running';r.startedAt=stamp();});
    const original=store.read().groupRuns.find(x=>x.id===id);
    let previous=null;
    for(let i=0;i<original.recipients.length;i++){
      const current=store.read();const g=current.groups.find(x=>x.id===original.groupId);const r=current.groupRuns.find(x=>x.id===id);
      const bot=g?.bots.find(x=>x.id===r.recipients[i]);
      if(!g||!bot)throw new Error('Bot or group was removed during execution.');
      r.currentStep=i;
      const envelope=createEnvelope({run:r,bot,previous});
      const output=await executor(bot,JSON.stringify(envelope));
      if(typeof output!=='string'||!output.trim())throw new Error('Bot returned empty output.');
      const toBotId=r.recipients[i+1]??null;
      previous={botId:bot.id,output:output.slice(0,3600)};
      await store.update(s=>{coordinationState(s);const live=s.groupRuns.find(x=>x.id===id);if(live.status!=='running')throw new Error('Run no longer active');
        live.currentStep=i+1;live.trace.push({botId:bot.id,output:previous.output,toBotId,at:stamp()});
        const chat=s.groupMessages[live.groupId]??=[];
        chat.push({id:randomUUID(),runId:id,role:'bot',senderId:bot.id,senderName:bot.name,toBotId,text:previous.output,at:stamp()});
        s.groupMessages[live.groupId]=chat.slice(-300);
      });
    }
    await store.update(s=>{const r=s.groupRuns.find(x=>x.id===id);r.status='completed';r.completedAt=stamp();r.lastOutput=previous?.output??null;activity(s,'group-run','Completed bot coordination run',{runId:id});});
  }catch(e){await store.update(s=>{const r=s.groupRuns?.find(x=>x.id===id);if(r){r.status='failed';r.error=clean(e.message);r.completedAt=stamp();activity(s,'group-error',`Coordination failed: ${clean(e.message)}`,{runId:id});}});}
  finally{running.delete(id);}
}
