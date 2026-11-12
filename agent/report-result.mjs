/** Reporting one finished task back to the server.
 *
 * Reporting is separate from executing: a refused report (409, a superseded
 * attempt) is not a local failure and is not reported again. One refusal is:
 * a result too large for the server's body limit (413). Left alone, the server
 * would wait out the whole run for a result that never lands and then blame the
 * agent; reported as `output-too-large`, the run fails at once and says why.
 */
const TOO_LARGE = 'The result was too large to send back to the server, so it was dropped.';

/** The kinds whose payload can carry `notAfter`, the epoch ms after which the server has stopped waiting. */
const DEADLINED = ['mcp.call', 'model.run'];

/** A task the server already gave up on is not run: it is reported failed as `expired` and true is returned.
 * Run before executing, so an MCP write or a model run nobody will read never happens. */
export async function skipExpired(call, config, task, nowMs = Date.now()) {
  const notAfter = Number(task?.payload?.notAfter);
  if (!DEADLINED.includes(task?.kind) || !Number.isFinite(notAfter) || nowMs <= notAfter) return false;
  console.error(`agent: ${task.kind} ${task.id} expired before it started; skipped`);
  await call(config, `/api/agent/tasks/${task.id}/result`, {status: 'failed', error: 'expired', attempts: task.attempts}).catch(error => console.error(`agent: ${task.kind} ${task.id} could not report the expiry: ${error.message}`));
  return true;
}

/** Waits before each retry of a result POST. */
export const REPORT_RETRY_MS = [1000, 3000, 9000];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
/** A server that answered 4xx has decided; a network failure or a 5xx may not have seen the result at all. */
const transient = error => { const m = /server responded (\d{3})\b/.exec(error?.message || ''); return !m || Number(m[1]) >= 500; };

/** `call` once, and again (up to `waits.length` times) while it fails in a way a moment may fix. */
async function withRetry(call, config, path, body, waits, sleep) {
  for (let attempt = 0; ; attempt++) {
    try { return await call(config, path, body); }
    catch (error) {
      if (attempt >= waits.length || !transient(error)) throw error;
      console.error(`agent: reporting to ${path} failed (${error.message}); trying again`);
      await sleep(waits[attempt]);
    }
  }
}

/** `call(config, path, body)` is the agent's signed POST; it throws "server responded <status>: ...".
 * A network failure or a 5xx is tried again a few times: the work is done, and dropping its result would
 * leave the server waiting out the whole run for it. */
export async function reportResult(call, config, task, result, {waits = REPORT_RETRY_MS, sleep = pause} = {}) {
  const path = `/api/agent/tasks/${task.id}/result`;
  try {
    await withRetry(call, config, path, {status: 'done', result, attempts: task.attempts}, waits, sleep);
    console.log(`agent: ${task.kind} ${task.id} done`);
  } catch (error) {
    console.error(`agent: ${task.kind} ${task.id} result was refused: ${error.message}`);
    if (!/server responded 413\b/.test(error.message || '')) return;
    const body = task.kind === 'model.run'
      ? {status: 'done', result: {ok: false, code: 'output-too-large', message: TOO_LARGE, detail: ''}, attempts: task.attempts}
      : {status: 'failed', error: TOO_LARGE, attempts: task.attempts};
    await call(config, path, body).catch(again => console.error(`agent: ${task.kind} ${task.id} could not report the refusal: ${again.message}`));
  }
}
