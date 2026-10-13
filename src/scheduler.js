import {markDue,activity} from '../shared/core.js';
import {pruneState} from '../shared/retention.js';
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
  const timer=setInterval(async()=>{if(busy)return;busy=true;try{
    // Only write when a scheduled draft has come due; otherwise the tick
    // rewrote the whole state document every few seconds for nothing.
    const now=Date.now();
    if((store.read().drafts||[]).some(d=>d.status==='scheduled'&&d.dueAt&&Number.isFinite(Date.parse(d.dueAt))&&Date.parse(d.dueAt)<=now))await tick(store,now);
  }catch(e){console.error('Scheduler error:',e.message);}finally{busy=false;}},intervalMs);
  timer.unref();return ()=>clearInterval(timer);
}
/** Retention runs on a slow cadence: prune at boot (a restart is a natural
 * chance to reclaim space) and then daily. Drafts, candidates and evidence are
 * never pruned; only event/task/run exhaust is. */
export function startRetention(store,intervalMs=86400000){
  const run=async()=>{try{const report=await store.update(s=>pruneState(s));if(report.events||report.doneTasks||report.runs)console.log(`Retention pruned ${report.events} event(s), ${report.doneTasks} task record(s), ${report.runs} run record(s).`);}catch(e){console.error('Retention error:',e.message);}};
  void run();
  const timer=setInterval(run,intervalMs);timer.unref();return ()=>clearInterval(timer);
}
