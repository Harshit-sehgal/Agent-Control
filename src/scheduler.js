import {markDue,activity} from '../shared/core.js';
/** Release approved drafts whose delay window has elapsed. Structured tasks
 * (reminders, queued drafting, agent jobs) are executed by src/queue.js; this
 * tick stays responsible for the publication handoff clock only. */
export async function tick(store,now=Date.now()) {
  return store.update(state=>{
    let changed=0;
    for(const draft of state.drafts){
      if(markDue(draft,now)){changed++;activity(state,'ready',`Draft for ${draft.author} is ready for manual posting.`,{draftId:draft.id});}
    }
    return changed;
  });
}
export function startScheduler(store,intervalMs=3000) {
  let busy=false;
  const timer=setInterval(async()=>{if(busy)return;busy=true;try{await tick(store);}catch(e){console.error('Scheduler error:',e.message);}finally{busy=false;}},intervalMs);
  timer.unref();return ()=>clearInterval(timer);
}
