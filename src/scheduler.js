import {markDue,activity} from './core.js';
export async function tick(store,now=Date.now()) {
  return store.update(state=>{
    let changed=0;
    for(const draft of state.drafts){
      if(markDue(draft,now)){changed++;activity(state,'ready',`Draft for ${draft.author} is ready for manual posting.`,{draftId:draft.id});}
    }
    for(const sched of state.schedules){
      if(sched.enabled && sched.nextAt && Date.parse(sched.nextAt)<=now){
        activity(state,'reminder',sched.label,{scheduleId:sched.id}); changed++;
        if(sched.kind==='once')sched.enabled=false;
        else {
          const period=sched.intervalMinutes*60000;
          sched.nextAt=new Date(now+period).toISOString();
        }
      }
    }
    return changed;
  });
}
export function startScheduler(store,intervalMs=3000) {
  let busy=false;
  const timer=setInterval(async()=>{if(busy)return;busy=true;try{await tick(store);}catch(e){console.error('Scheduler error:',e.message);}finally{busy=false;}},intervalMs);
  timer.unref();return ()=>clearInterval(timer);
}
