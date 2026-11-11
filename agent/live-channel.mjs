/** The device's live line to the server: what the owner watches and does.
 *
 * Two signed calls, both outbound like every other call the agent makes:
 *
 * - `/api/agent/live` is a long poll. The device says where its tabs are; the
 *   server holds the call until it has something (the owner's input, a takeover)
 *   or about twenty seconds pass, and answers with `{commands, watch}`. `watch`
 *   is the bot whose tab somebody is looking at, or null.
 * - `/api/agent/frames` carries one screencast frame of that tab. Only the
 *   newest frame is kept and at most about ten go out a second; an older one is
 *   dropped, never queued. The reply says whether anyone still watches.
 *
 * Nothing here keeps a frame: a frame is in memory from Chrome to the request. */
export function createLiveChannel({call, shared, frameGapMs = 100, retryMs = 2000, maxRetryMs = 30000, log = console} = {}) {
  const abort = new AbortController();
  let failed = null, stopped = false, cast = null, latest = null, posting = false, lastPost = 0, timer = null, loop = Promise.resolve();

  /** Cast what the server says is watched, and nothing else. */
  async function apply(next) {
    next = next || null;
    if (!next) {
      if (cast) { cast = null; latest = null; await shared.unwatch(); }
      return;
    }
    if (cast === next) return;
    // Set first: the seed frame arrives while `watch` is still resolving.
    cast = next;
    if (!(await shared.watch(next).catch(() => false)) && cast === next) cast = null;
  }

  function pump() {
    if (stopped || posting || !latest || !cast) return;
    const wait = lastPost + frameGapMs - Date.now();
    if (wait > 0) { timer ??= setTimeout(() => { timer = null; pump(); }, wait); return; }
    const frame = latest;
    latest = null; posting = true; lastPost = Date.now();
    call('/api/agent/frames', {botId: frame.botId, image: frame.image, w: frame.w, h: frame.h}, {signal: abort.signal})
      .then(reply => apply(reply?.watch), error => { if (!stopped) log.error(`agent: could not send a frame (${error.message}).`); })
      .finally(() => { posting = false; pump(); });
  }
  shared.onFrame(frame => { if (frame.botId === cast) { latest = frame; pump(); } });

  async function handle(command) {
    if (command?.type === 'input') await shared.applyInput(command.botId, command.event).catch(error => log.error(`agent: input refused (${error.message}).`));
    else if (command?.type === 'takeover') {
      await shared.takeover(command.botId).catch(error => { failed = {botId: command.botId, message: String(error.message).slice(0, 200)}; log.error(`agent: takeover failed (${error.message}).`); });
    } else if (command?.type === 'handback') await shared.handback(command.botId);
  }

  const pause = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); abort.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, {once: true}); });

  async function run() {
    let delay = retryMs;
    while (!stopped) {
      try {
        await shared.refresh();
        const tabs = shared.status().map(({botId, url, title}) => ({botId, url, title}));
        // Who the owner holds, and a takeover that could not start, so the server's picture follows the device's.
        const report = {tabs, owner: shared.owner(), ...(failed ? {failed} : {})};
        failed = null;
        const reply = await call('/api/agent/live', report, {timeoutMs: 30000, signal: abort.signal});
        delay = retryMs;
        for (const command of reply?.commands || []) await handle(command);
        await apply(reply?.watch);
      } catch (error) {
        if (stopped) break;
        log.error(`agent: live view failed (${error.message}). Retrying in ${Math.max(1, Math.round(delay / 1000))}s.`);
        await pause(delay);
        delay = Math.min(delay * 2, maxRetryMs);
      }
    }
  }

  return {
    start() { loop = run(); },
    async stop() {
      stopped = true;
      abort.abort();
      clearTimeout(timer);
      await loop;
      await shared.unwatch();
    },
  };
}
