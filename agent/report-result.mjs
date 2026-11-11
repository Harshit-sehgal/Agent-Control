/** Reporting one finished task back to the server.
 *
 * Reporting is separate from executing: a refused report (409, a superseded
 * attempt) is not a local failure and is not reported again. One refusal is:
 * a result too large for the server's body limit (413). Left alone, the server
 * would wait out the whole run for a result that never lands and then blame the
 * agent; reported as `output-too-large`, the run fails at once and says why.
 */
const TOO_LARGE = 'The result was too large to send back to the server, so it was dropped.';

/** `call(config, path, body)` is the agent's signed POST; it throws "server responded <status>: ...". */
export async function reportResult(call, config, task, result) {
  const path = `/api/agent/tasks/${task.id}/result`;
  try {
    await call(config, path, {status: 'done', result, attempts: task.attempts});
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
