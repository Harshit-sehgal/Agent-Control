/** What the device process wires around the shared browser.
 *
 * `agent/agent.mjs` runs its top level on import, so a test cannot reach it; the decisions that matter for browser
 * accounts live here instead, and the agent only calls them:
 *
 * - the cookie jars (`account-jars.mjs`, under the pairing secret) and this computer's own id reach the shared
 *   browser and every browser task, so a task for another computer, or for an account this computer was not told it
 *   holds, is refused before anything starts;
 * - the server's account list is applied one update at a time, newest beat first, and remembered for a browser that
 *   is made later (a list is never lost because no page had been opened yet);
 * - the housekeeping `sweep` runs on a timer, and shutdown stops the timer and waits for a pass in flight before the
 *   browser closes (a pass that outlived `close()` would start Chrome again);
 * - a page read as a browser account is never replaced by a plain, cookieless read.
 *
 * Nothing here logs a cookie, a secret or an error text from the jars.
 */
import {createSharedBrowser, browserProfileDir, runBrowserTask, taskAccount, SWEEP_MS} from './shared-browser.mjs';
import {createJarStore, browserAccountsDir} from './account-jars.mjs';
import {parseAllowlist} from '../shared/bot-browser.js';
import {plainFallback, turnedAway, preferRead} from './page-fetch.mjs';

export const NEEDS_BROWSER = 'This bot signs in as a browser account, which needs the real browser on this computer. Set AGENT_BROWSER=1 on it, with Chrome, Chromium or Edge installed.';

/** `accounts: false` switches browser accounts off for this run (the jars could not be brought under this secret): no jar
 * is opened, wiped or reported, and every account task is refused. The default profile works as ever. */
export function createBrowserHost({agentId, secret, configPath, env = process.env, sweepMs = SWEEP_MS, sharedOptions = {}, accounts = true}) {
  const jars = accounts ? createJarStore({dir: browserAccountsDir(env, configPath), secret}) : null;
  const allow = () => parseAllowlist(env.AGENT_BROWSER_ALLOWLIST);
  let sb = null;
  let lastList = null;          // the server's latest account list, for a browser made after it came
  let appliedSeq = -Infinity;   // the beat that list came from: an older beat's list never replaces it
  let chain = Promise.resolve();// list updates, one at a time
  let timer = null, sweepRun = null, closing = false;

  /** The browser every bot shares, made on first use (its process starts only when a task needs it). */
  function shared() {
    if (sb) return sb;
    sb = createSharedBrowser({allow, profile: browserProfileDir(env, configPath), jars, quitIdle: env.AGENT_BROWSER_QUIT_IDLE === '1', requireListed: true, ...sharedOptions});
    // The list that came before this browser: set at once (its first line), so a task that follows is not refused for a list not yet applied.
    if (lastList) { const first = sb.setAccounts(lastList).catch(() => console.error('agent: could not apply the browser account list.')); chain = chain.then(() => first); }
    return sb;
  }

  /** Apply the server's account list: jars it omits are wiped, and the browser, when there is one, lets those accounts
   * go. Anything but an array changes nothing (an older server, an error). One update at a time, and a beat no newer
   * than the last applied is dropped: an older list applied late would re-list an account that was just wiped. */
  function applyAccounts(list, seq = appliedSeq + 1) {
    if (!Array.isArray(list) || seq <= appliedSeq) return chain;
    appliedSeq = seq;
    lastList = list;
    chain = chain.then(async () => {
      try { jars?.retain(list.map(a => a?.id)); } catch { console.error('agent: could not remove a browser account\'s saved sign-in.'); }
      if (sb) await sb.setAccounts(list);
    }).catch(() => console.error('agent: could not apply the browser account list.'));
    return chain;
  }

  /** What each heartbeat reports of the accounts: the browser's states, or, before it exists, each jar as unknown. */
  function accountReport() {
    if (!jars) return [];
    if (sb) return sb.accountStates();
    try { return jars.ids().map(id => ({id, state: 'unknown', storage: 'cookies'})); } catch { return []; }
  }

  const run = task => runBrowserTask(task, {shared: shared(), allow: allow(), env, agentId});

  /** One `browser.capture`. `browser` is whether this computer drives a real browser; `readPlain` reads a page with no
   * browser. The account and computer are checked first, so no fallback sees a task that was not this computer's. */
  async function capture(task, {browser, readPlain}) {
    const account = taskAccount(task.payload || {}, agentId);
    const target = String(task.payload?.url || '');
    if (!browser) {
      if (account) throw new Error(NEEDS_BROWSER);
      return readPlain(target);
    }
    const seen = await run(task);
    // A site that turns the headless browser away, or a page that came back nearly empty, is read once more by a plain
    // request that names itself; a page with steps, or one read as an account, keeps the browser's answer.
    if (plainFallback(task, seen)) {
      const plain = await readPlain(target).catch(() => null);
      if (plain?.text && (turnedAway(seen) ? !turnedAway(plain) : preferRead(seen, plain) === plain)) return shared().scrub(task.payload?.botId, {...plain, readBy: 'plain'}, account);
    }
    return seen;
  }

  /** The housekeeping, on a timer. A pass runs alone; one that fails is said in fixed words and the timer goes on. */
  function startSweeps() {
    if (timer || closing) return;
    timer = setInterval(() => {
      if (!sb || sweepRun || closing) return;
      sweepRun = Promise.resolve().then(() => sb.sweep()).catch(() => console.error('agent: the browser sweep failed.')).finally(() => { sweepRun = null; });
    }, sweepMs);
    timer.unref?.();
  }

  /** Stop the timer and wait for a pass in flight. A pass left running could start the browser again after it closed. */
  async function stopSweeps() {
    closing = true;
    clearInterval(timer); timer = null;
    await sweepRun;
  }

  /** Stop the sweeps, wait for a list update in flight, then close the browser (cookies saved first). */
  async function close() {
    await stopSweeps();
    await chain;
    await sb?.close();
  }

  return {jars, shared, current: () => sb, applyAccounts, accountReport, run, capture, startSweeps, stopSweeps, close};
}
