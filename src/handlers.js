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
  const enqueue = (s, spec) => s.update(st => { tasks.enqueueTask(st, spec); })
    .catch(error => console.error('Notification enqueue:', error.message));
  return event => {
    const id = notifications.notify(ws, enqueue, {workspaceId, userId: null, ...event});
    // A notification for one person goes to that person's devices; one for the
    // workspace goes to every member who can still sign in.
    const members = auth.listUsers(workspaceId).filter(u => !u.disabled).map(u => u.id);
    push.announce(ws, enqueue, event.userId ? members.filter(id => id === event.userId) : members,
      {id, title: event.title, body: event.body});
    return id;
  };
}

/** Task kinds map to handlers here rather than inside the queue module, so the
 * worker stays independent of the server surface it drives. `notify` defaults
 * to this workspace's fan-out, so a caller that only needs the map does not have
 * to build one. */
export function taskHandlers({ws, workspaceId, auth, push, notify, processCandidate}) {
  const fanOut = notify ?? createNotifier({ws, workspaceId, auth, push});
  return {
    ...defaultHandlers(ws, fanOut),
    'candidate-draft': async task => processCandidate(ws, task.payload.candidateId),
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
      const agents = ws.all('SELECT id,permissions FROM agents WHERE revoked_at IS NULL')
        .map(a => ({id: a.id, permissions: JSON.parse(a.permissions || '[]')}))
        .filter(a => !task.payload.agentId || a.id === task.payload.agentId)
        .filter(a => a.permissions.includes(kind));
      if (!agents.length) throw new Error('No paired local agent holds the permission this job needs.');
      for (const a of agents) {
        agent.enqueueAgentTask(ws, a.id, {kind, payload: task.payload.params || {}, idempotencyKey: `job:${task.id}:${a.id}`, createdBy: task.createdBy});
      }
      return {dispatchedTo: agents.map(a => a.id)};
    },
    'notification': async task => {
      // A push goes to a device, not to a stored webhook, and a failed one
      // raises no notification of its own: that would be pushed again.
      if (task.payload.channel === 'push') return push.deliver(task);
      const result = await notifications.deliver(ws, task);
      ws.run('UPDATE notifications SET status=?, sent_at=? WHERE id=?', 'sent', new Date().toISOString(), task.payload.notificationId);
      return result;
    },
  };
}
