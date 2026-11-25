import {pruneState} from '../shared/retention.js';
import {startSweep} from './interval.js';
/** Retention runs on a slow cadence: prune at boot (a restart is a natural
 * chance to reclaim space) and then daily. Only event/task/run exhaust is
 * pruned. */
export function startRetention(store,intervalMs=86400000){
  return startSweep('Retention',async()=>{const report=await store.update(s=>pruneState(s));if(report.events||report.doneTasks||report.runs)console.log(`Retention pruned ${report.events} event(s), ${report.doneTasks} task record(s), ${report.runs} run record(s).`);},{intervalMs});
}
