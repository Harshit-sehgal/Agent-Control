/** The health watch: what stops the bots from working while nobody is looking, said to the owner once.
 *
 * Watched on a timer, per workspace:
 * - a paired computer (the local agent that runs pages) has been quiet past `AGENT_GRACE_MS` while a schedule is
 *   due within that time (a laptop asleep with tomorrow's briefing queued is not a problem);
 * - background work is more than `QUEUE_LAG_MS` late (the queue is not draining);
 * - when `HEALTH_BACKUP_DIR` names the nightly backup folder (deploy/backup-encrypted.sh, mounted read-only), the
 *   newest backup in it is older than `BACKUP_STALE_MS`, or the folder cannot be read. Watched by the first
 *   workspace only, as the folder is the host's.
 *
 * A problem must be seen on two checks in a row before it is said, so the late work every boot or wake finds
 * (the queue has not drained yet) is not an alert. It is then said once, nothing while it lasts, and a plain "back"
 * notice when it clears. The said keys live in the workspace (`kv health_alerts`), so a restart does not repeat
 * them. Only late work is urgent (pushed in quiet hours): nothing is gained by waking the owner for a sleeping
 * laptop or a backup.
 *
 * One more problem is said by the run that met it, not the timer: a scheduled task whose site signed it out
 * (a sign-in card in an unattended run) notifies the owner at once (`signinSites`, `signinNotice`). */
import {readdir, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {DEFAULT_WORKSPACE} from './auth.js';
import {startSweep} from './interval.js';

export const WATCH_MS = 5 * 60000;
export const AGENT_GRACE_MS = 15 * 60000;
export const QUEUE_LAG_MS = 15 * 60000;
export const BACKUP_STALE_MS = 36 * 3600000;
export const ALERTS_KEY = 'health_alerts';
const BACKUP_FILE = /^agent-control-.*\.tgz\.enc$/;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const clock = iso => new Date(iso).toISOString().slice(11, 16);

/** The problems in one workspace right now, from plain facts. Pure.
 * `backup`: undefined when no backup folder is watched, else `{readable, newest}` (newest is ms or null). */
export function healthIssues({agents = [], tasks = [], schedulesPaused = false, backup, now = Date.now()} = {}) {
  const issues = [];
  // Only a schedule due soon waits on a computer; a running one already has what it needs or will fail and say so.
  const due = tasks.filter(t => t?.kind === 'bot-task' && t.status === 'queued' && Date.parse(t.runAt) <= now + AGENT_GRACE_MS).length;
  if (due && !schedulesPaused) for (const agent of agents) {
    // A computer paired but never started is the setup checklist's job, not an alert.
    if (agent.revokedAt || !agent.lastSeenAt) continue;
    const seen = Date.parse(agent.lastSeenAt);
    if (!Number.isFinite(seen) || now - seen <= AGENT_GRACE_MS) continue;
    issues.push({key: `agent-offline:${agent.id}`, urgent: false, title: `${agent.name || 'Your computer'} went offline`,
      body: `${agent.name || 'The paired computer'} has not been seen since ${clock(agent.lastSeenAt)} UTC, and ${plural(due, 'schedule')} due soon may need it to open pages. Start the agent on that computer.`});
  }
  // The kill switch holds work on purpose, so held work is not late.
  if (!schedulesPaused) {
    const late = tasks.filter(t => t?.status === 'queued' && now - Date.parse(t.runAt) > QUEUE_LAG_MS).length;
    if (late) issues.push({key: 'queue-behind', urgent: true, title: 'Background work is running late',
      body: `${plural(late, 'background task')} ${late === 1 ? 'is' : 'are'} more than ${QUEUE_LAG_MS / 60000} minutes late. If this does not clear, restart the server.`});
  }
  if (backup && !backup.readable) {
    issues.push({key: 'backup-stale', urgent: false, title: 'The backup folder cannot be read',
      body: 'The server cannot list the backup folder named in HEALTH_BACKUP_DIR, so it cannot tell whether nightly backups run. Check that the folder is mounted and readable by the app.'});
  } else if (backup && (backup.newest == null || now - backup.newest > BACKUP_STALE_MS)) {
    issues.push({key: 'backup-stale', urgent: false, title: 'The nightly backup did not run',
      body: backup.newest == null ? 'The backup folder has no backup in it yet. Check the nightly backup job on the server.'
        : `The newest backup is from ${new Date(backup.newest).toISOString().slice(0, 16).replace('T', ' ')} UTC, more than a day and a half ago. Check the nightly backup job on the server.`});
  }
  return issues;
}

/** What to say and what to clear. A problem is said when it was also seen on the check before (`seenBefore`) and
 * was not said already (`previousKeys`); one that went away is cleared at once. Pure. */
export function alertChanges(previousKeys = [], issues = [], seenBefore = null) {
  const said = new Set(previousKeys), now = new Set(issues.map(i => i.key));
  const raise = issues.filter(i => !said.has(i.key) && (!seenBefore || seenBefore.has(i.key)));
  const clear = previousKeys.filter(k => !now.has(k));
  return {raise, clear, keys: [...previousKeys.filter(k => now.has(k)), ...raise.map(i => i.key)]};
}

const cleared = key => key.startsWith('agent-offline:')
  ? {title: 'Your computer is back', body: 'The paired computer is online again; waiting schedules run as planned.'}
  : key === 'backup-stale' ? {title: 'Backups are fine again', body: 'A fresh nightly backup is in the backup folder.'}
    : {title: 'Background work caught up', body: 'Nothing is running late any more.'};

/** The nightly backup folder: whether it can be listed, and when its newest backup was written (ms, or null). */
export async function readBackupFolder(dir) {
  let names;
  try { names = await readdir(dir); } catch { return {readable: false, newest: null}; }
  let newest = null;
  for (const name of names.filter(n => BACKUP_FILE.test(n))) {
    try { const t = (await stat(join(dir, name))).mtimeMs; if (newest == null || t > newest) newest = t; } catch { /* gone since the listing */ }
  }
  return {readable: true, newest};
}

async function factsOf(ws, workspaceId, now, backupDir) {
  const state = ws.read();
  const agents = (ws.all?.('SELECT id, name, last_seen_at, revoked_at FROM agents WHERE workspace_id=?', workspaceId) || [])
    .map(a => ({id: a.id, name: a.name, lastSeenAt: a.last_seen_at, revokedAt: a.revoked_at}));
  const backup = backupDir && workspaceId === DEFAULT_WORKSPACE ? await readBackupFolder(backupDir) : undefined;
  return {agents, tasks: state.tasks || [], schedulesPaused: state.schedulesPaused === true, backup, now};
}

function savedKeys(ws) {
  try { const keys = JSON.parse(ws.kvGet?.(ALERTS_KEY) || '[]'); return Array.isArray(keys) ? keys.map(String) : []; }
  catch { return []; }
}

/** One workspace's watch. `tick()` checks once; `start()` checks now and every `intervalMs`, and returns stop. */
export function createHealthWatch(ws, {workspaceId = DEFAULT_WORKSPACE, backupDir = process.env.HEALTH_BACKUP_DIR || '', notify, now = () => Date.now(), intervalMs = WATCH_MS, log = message => console.error(message)} = {}) {
  // The problems the check before saw, kept in memory: a restart starts over, so a problem is never said on the
  // first check after boot.
  let seenBefore = new Set();
  const check = async () => {
    const issues = healthIssues(await factsOf(ws, workspaceId, now(), backupDir));
    const {raise, clear, keys} = alertChanges(savedKeys(ws), issues, seenBefore);
    seenBefore = new Set(issues.map(i => i.key));
    if (!raise.length && !clear.length) return;
    // Saved first: a notice that fails to send is not worth a second one every five minutes.
    ws.kvSet?.(ALERTS_KEY, JSON.stringify(keys));
    for (const issue of raise) await notify({title: issue.title, body: issue.body, kind: 'health', urgent: issue.urgent === true, meta: {health: issue.key}});
    for (const key of clear) await notify({...cleared(key), kind: 'health', urgent: false, meta: {health: key}});
  };
  const tick = async () => { try { await check(); } catch (error) { log(`Health watch error: ${error.message}`); } };
  return {tick, start: () => startSweep('Health watch', check, {intervalMs, ws, log})};
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

/** The notice for a scheduled task a site signed out. Not urgent: the next run needs it, not the owner's sleep. */
export function signinNotice({botName = 'A bot', sites = []} = {}) {
  const where = sites.join(', ');
  return {title: `Sign in again to ${where}`, kind: 'health', urgent: false,
    body: `${botName}'s scheduled task could not get into ${where}: the sign-in there has run out. Open the app and sign in from the card in its chat; the next run uses it.`};
}
