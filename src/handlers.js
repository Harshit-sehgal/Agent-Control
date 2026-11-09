/** The background work one workspace runs: notification fan-out and the task
 * handler map.
 *
 * These used to live inside `startWorkspace` in server.js, which made that
 * function the place where a task kind was wired as well as started. Keeping
 * them here means the server file only starts services, and the handler map can
 * be read (and changed) without scrolling past the HTTP surface.
 */
import * as tasks from '../shared/tasks.js';
import * as notifications from './notifications.js';
import * as agent from './agent.js';
import {queueGroupRun, runBotTask} from './coordination.js';
import {defaultHandlers} from './queue.js';

/** Notifications enqueue themselves as queue tasks and reach a device through
 * the push subscriptions of the people they are for. Returns the `notify(event)`
 * function the queue handlers and routes call. */
export function createNotifier({ws, workspaceId, auth, push}) {
  // The task and the notification row are separate records, so the outcome is
  // returned rather than swallowed: `notifications.notify` retries a transient
  // failure and marks that channel's row failed when the task never landed.
  const enqueue = (s, spec) => s.update(st => { tasks.enqueueTask(st, spec); })
    .then(() => ({enqueued: true}), error => {
      console.error('Notification enqueue:', error.message);
      return {enqueued: false, error: error.message};
    });
  // Async so `await notify(event)` means more than "a row exists": the
  // delivery tasks are written (or honestly failed) before this resolves, and a
  // caller that waits can never be the reason a row is left reading `queued`
  // with no task behind it while the process exits.
  return async event => {
    const id = notifications.notify(ws, enqueue, {workspaceId, userId: null, ...event});
    // A notification for one person goes to that person's devices; one for the
    // workspace goes to every member who can still sign in.
    const members = auth.listUsers(workspaceId).filter(u => !u.disabled).map(u => u.id);
    push.announce(ws, enqueue, event.userId ? members.filter(id => id === event.userId) : members,
      {id, title: event.title, body: event.body});
    await notifications.deliveriesQueued();
    return id;
  };
}

/** A stored permission list. A row written by an older build, or edited by
 * hand, must not take the whole fan-out down with a parse error: an unreadable
 * list means no permissions, which is the safe failure. */
function permissionsOf(row) {
  try {
    const parsed = JSON.parse(row?.permissions || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch { return []; }
}

/** Task kinds map to handlers here rather than inside the queue module, so the
 * worker stays independent of the server surface it drives. `notify` defaults
 * to this workspace's fan-out, so a caller that only needs the map does not have
 * to build one. */
export function taskHandlers({ws, workspaceId, auth, push, notify, processCandidate}) {
  const fanOut = notify ?? createNotifier({ws, workspaceId, auth, push});
  return {
    ...defaultHandlers(ws, fanOut),
    'candidate-draft': async task => {
      // A deleted candidate is a miss, not a transient error. Say it once, with
      // the status a person would get from the same request.
      if (!ws.get('SELECT id FROM candidates WHERE id=?', task.payload.candidateId)) {
        throw Object.assign(new Error('Candidate not found.'), {status: 404});
      }
      return processCandidate(ws, task.payload.candidateId);
    },
    'group-run': async task => {
      await queueGroupRun(ws, {groupId: task.payload.groupId, message: task.payload.message, directBotId: task.payload.directBotId});
    },
    'bot-task': async task => runBotTask(ws, task),
    'agent-job': async task => {
      // Dispatch to a paired local agent: enqueue an agent task for each agent
      // that holds the required permission. The queue's idempotency and the
      // agent-side lease make exactly-once practical without claiming more than
      // the protocol can prove.
      const kind = task.payload.action;
      const wanted = task.payload.agentId;
      const paired = ws.all('SELECT id,permissions FROM agents WHERE revoked_at IS NULL');
      // A job aimed at one agent that is no longer paired is a miss. Falling
      // through would hand it to whichever agent happens to be left.
      if (wanted && !paired.some(a => a.id === wanted)) {
        throw Object.assign(new Error('That local agent is not paired, or was revoked.'), {status: 404});
      }
      const agents = paired
        .map(a => ({id: a.id, permissions: permissionsOf(a)}))
        .filter(a => !wanted || a.id === wanted)
        .filter(a => a.permissions.includes(kind));
      if (!agents.length) throw new Error('No paired local agent holds the permission this job needs.');
      // One agent's refusal must not drop the work the others accepted, so both
      // outcomes are recorded and the task reports them.
      const dispatchedTo = [], refused = [];
      for (const a of agents) {
        try {
          agent.enqueueAgentTask(ws, a.id, {kind, payload: task.payload.params || {}, idempotencyKey: `job:${task.id}:${a.id}`, createdBy: task.createdBy});
          dispatchedTo.push(a.id);
        } catch (error) {
          refused.push({agentId: a.id, error: error.message});
        }
      }
      if (!dispatchedTo.length) {
        throw Object.assign(new Error(`No agent accepted the job: ${refused[0]?.error || 'unknown error'}`), {status: refused[0]?.status || 500});
      }
      // A clean fan-out reports what it did, nothing more: `refused` appears
      // only when there is a refusal to show.
      return refused.length ? {dispatchedTo, refused} : {dispatchedTo};
    },
    'notification': async task => {
      // A push goes to a device, not to a stored webhook, and a failed one
      // raises no notification of its own: that would be pushed again.
      if (task.payload.channel === 'push') return push.deliver(task);
      // `deliver` records `sent` or `failed` on that channel's own row.
      return notifications.deliver(ws, task);
    },
  };
}
