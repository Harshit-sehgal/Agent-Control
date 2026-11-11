import {pruneState} from '../shared/retention.js';
/** Retention runs on a slow cadence: prune at boot (a restart is a natural
 * chance to reclaim space) and then daily. Only event/task/run exhaust is
 * pruned. */
export function startRetention(store,intervalMs=86400000){
  let busy=false,stopped=false;
  const idle=[];
  const run=async()=>{if(busy||stopped)return;busy=true;try{const report=await store.update(s=>pruneState(s));if(report.events||report.doneTasks||report.runs)console.log(`Retention pruned ${report.events} event(s), ${report.doneTasks} task record(s), ${report.runs} run record(s).`);}catch(e){console.error('Retention error:',e.message);}finally{busy=false;for(const resolve of idle.splice(0))resolve();}};
  void run();
  const timer=setInterval(run,intervalMs);timer.unref();return async()=>{stopped=true;clearInterval(timer);if(busy)await new Promise(resolve=>idle.push(resolve));};
}
