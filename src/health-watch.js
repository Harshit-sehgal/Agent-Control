/** The health watch: what stops the bots from working while nobody is looking, said to the owner once.
 *
 * Two kinds of problem are watched on a timer, per workspace:
 * - a paired computer (the local agent that runs pages) has been quiet past `AGENT_GRACE_MS` while a schedule
 *   is waiting to run;
 * - background work is more than `QUEUE_LAG_MS` late (the queue is not draining).
 * Each one is an urgent notice (pushed even in quiet hours) the first time it is seen, nothing while it
 * lasts, and a plain "back" notice when it clears. The raised keys live in the workspace (`kv health_alerts`),
 * so a restart does not send the same notice again.
 *
 * A third problem is said by the run that met it, not the timer: a scheduled task whose site signed it out
 * (a sign-in card in an unattended run) notifies the owner at once (`signinSites`, `signinNotice`). */

export const WATCH_MS = 5 * 60000;
export const AGENT_GRACE_MS = 15 * 60000;
export const QUEUE_LAG_MS = 15 * 60000;
export const ALERTS_KEY = 'health_alerts';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clock = iso => new Date(iso).toISOString().slice(11, 16);

/** The problems in one workspace right now, from plain facts. Pure. */
export function healthIssues({agents = [], tasks = [], schedulesPaused = false, now = Date.now()} = {}) {
  const issues = [];
  const waiting = tasks.filter(t => t?.kind === 'bot-task' && ['queued', 'running'].includes(t.status)).length;
  if (waiting) for (const agent of agents) {
    // A computer paired but never started is the setup checklist's job, not an alert.
    if (agent.revokedAt || !agent.lastSeenAt) continue;
    const seen = Date.parse(agent.lastSeenAt);
    if (!Number.isFinite(seen) || now - seen <= AGENT_GRACE_MS) continue;
    issues.push({key: `agent-offline:${agent.id}`, title: `${agent.name || 'Your computer'} went offline`,
      body: `${agent.name || 'The paired computer'} has not been seen since ${clock(agent.lastSeenAt)} UTC, and ${plural(waiting, 'schedule')} may need it to open pages. Start the agent on that computer.`});
  }
  // The kill switch holds work on purpose, so held work is not late.
  if (!schedulesPaused) {
    const late = tasks.filter(t => t?.status === 'queued' && now - Date.parse(t.runAt) > QUEUE_LAG_MS).length;
    if (late) issues.push({key: 'queue-behind', title: 'Background work is running late',
      body: `${plural(late, 'background task')} ${late === 1 ? 'is' : 'are'} more than ${QUEUE_LAG_MS / 60000} minutes late. If this does not clear, restart the server.`});
  }
  return issues;
}

/** What to raise and what to clear, given the keys raised before. Pure. */
export function alertChanges(previousKeys = [], issues = []) {
  const before = new Set(previousKeys);
  const keys = issues.map(i => i.key);
  return {raise: issues.filter(i => !before.has(i.key)), clear: previousKeys.filter(k => !keys.includes(k)), keys};
}

const cleared = key => key.startsWith('agent-offline:')
  ? {title: 'Your computer is back', body: 'The paired computer is online again; waiting schedules run as planned.'}
  : {title: 'Background work caught up', body: 'Nothing is running late any more.'};

function factsOf(ws, workspaceId, now) {
  const state = ws.read();
  const agents = (ws.all?.('SELECT id, name, last_seen_at, revoked_at FROM agents WHERE workspace_id=?', workspaceId) || [])
    .map(a => ({id: a.id, name: a.name, lastSeenAt: a.last_seen_at, revokedAt: a.revoked_at}));
  return {agents, tasks: state.tasks || [], schedulesPaused: state.schedulesPaused === true, now};
}

function savedKeys(ws) {
  try { const keys = JSON.parse(ws.kvGet?.(ALERTS_KEY) || '[]'); return Array.isArray(keys) ? keys.map(String) : []; }
  catch { return []; }
}

/** One workspace's watch. `tick()` checks once; `start()` checks now and every `intervalMs`, and returns stop. */
export function createHealthWatch(ws, {workspaceId = 'default', notify, now = () => Date.now(), intervalMs = WATCH_MS, log = message => console.error(message)} = {}) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const {raise, clear, keys} = alertChanges(savedKeys(ws), healthIssues(factsOf(ws, workspaceId, now())));
      if (!raise.length && !clear.length) return;
      // Saved first: a notice that fails to send is not worth a second one every five minutes.
      ws.kvSet?.(ALERTS_KEY, JSON.stringify(keys));
      for (const issue of raise) await notify({title: issue.title, body: issue.body, kind: 'health', urgent: true, meta: {health: issue.key}});
      for (const key of clear) await notify({...cleared(key), kind: 'health', urgent: false, meta: {health: key}});
    } catch (error) { log(`Health watch: ${error.message}`); }
    finally { busy = false; }
  };
  const start = () => {
    void tick();
    const timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
    return async () => { clearInterval(timer); };
  };
  return {tick, start};
}

/** The sites named by the sign-in cards in some chat lines, once each, without `www.`. Pure. */
export function signinSites(lines = []) {
  const sites = [];
  for (const line of lines) {
    if (line?.kind !== 'setup' || !line.setup) continue;
    let card;
    try { card = JSON.parse(line.setup); } catch { continue; }
    if (card?.action !== 'signin') continue;
    let site = String(card.site || '').trim().toLowerCase();
    if (!site && card.url) try { site = new URL(card.url).hostname; } catch { site = ''; }
    site = site.replace(/^www\./, '');
    if (site && !sites.includes(site)) sites.push(site);
  }
  return sites;
}

/** The urgent notice for a scheduled task a site signed out. */
export function signinNotice({botName = 'A bot', sites = []} = {}) {
  const where = sites.join(', ');
  return {title: `Sign in again to ${where}`, kind: 'health', urgent: true,
    body: `${botName}'s scheduled task could not get into ${where}: the sign-in there has run out. Open the app and sign in from the card in its chat; the next run uses it.`};
}
