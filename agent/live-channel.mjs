/** The device's live line to the server: what the owner watches and does.
 *
 * Two signed calls, both outbound like every other call the agent makes:
 *
 * - `/api/agent/live` is a long poll. The device says where its tabs are; the
 *   server holds the call until it has something (the owner's input, a takeover)
 *   or about twenty seconds pass, and answers with `{commands, watch, watchAccount}`.
 *   `watch` is the bot whose tab somebody is looking at, or null; `watchAccount`
 *   is the browser account that tab is in, when it has one.
 * - A tab is named by its (account, bot): one bot on two accounts has two tabs.
 *   Every command, frame and report here carries the account, and the owner's
 *   input reaches only the tab the owner took over; a handback always releases it.
 * - `/api/agent/frames` carries one screencast frame of that tab. Only the
 *   newest frame is kept and at most about ten go out a second; an older one is
 *   dropped, never queued. The reply says whether anyone still watches.
 *
 * Nothing here keeps a frame: a frame is in memory from Chrome to the request. */
export function createLiveChannel({call, shared, frameGapMs = 100, retryMs = 2000, maxRetryMs = 30000, log = console, onTasks = null} = {}) {
  const abort = new AbortController();
  let failed = null, stopped = false, cast = null, held = null, latest = null, posting = false, lastPost = 0, timer = null, loop = Promise.resolve();

  const accountOf = value => value || null;
  /** Cast what the server says is watched (a bot, in its account), and nothing else. */
  async function apply(botId, account = null) {
    if (!botId) {
      if (cast) { cast = null; latest = null; await shared.unwatch(); }
      return;
    }
    const next = {botId, account: accountOf(account)};
    if (cast && cast.botId === next.botId && cast.account === next.account) return;
    // Set first: the seed frame arrives while `watch` is still resolving.
    cast = next;
    if (!(await shared.watch(next.botId, next.account).catch(() => false)) && cast === next) cast = null;
  }

  function pump() {
    if (stopped || posting || !latest || !cast) return;
    const wait = lastPost + frameGapMs - Date.now();
    if (wait > 0) { timer ??= setTimeout(() => { timer = null; pump(); }, wait); return; }
    const frame = latest;
    latest = null; posting = true; lastPost = Date.now();
    call('/api/agent/frames', {botId: frame.botId, ...(frame.account ? {account: frame.account} : {}), image: frame.image, w: frame.w, h: frame.h}, {signal: abort.signal})
      .then(reply => apply(reply?.watch, reply?.watchAccount), error => { if (!stopped) log.error(`agent: could not send a frame (${error.message}).`); })
      .finally(() => { posting = false; pump(); });
  }
  shared.onFrame(frame => { if (cast && frame.botId === cast.botId && accountOf(frame.account) === cast.account) { latest = frame; pump(); } });

  /** The owner holds this (account, bot) tab now, as far as this line knows: only it takes input or a handback. */
  const holds = command => Boolean(held) && shared.owner() === command.botId && held.botId === command.botId && held.account === accountOf(command.account);

  async function handle(command) {
    const account = accountOf(command?.account);
    if (command?.type === 'input') {
      if (!holds(command)) { log.error('agent: input refused (the owner does not hold that tab).'); return; }
      await shared.applyInput(command.botId, command.event).catch(error => log.error(`agent: input refused (${error.message}).`));
    } else if (command?.type === 'takeover') {
      try { await shared.takeover(command.botId, account); held = {botId: command.botId, account}; }
      catch (error) { failed = {botId: command.botId, message: String(error.message).slice(0, 200)}; log.error(`agent: takeover failed (${error.message}).`); }
    } else if (command?.type === 'handback') {
      // Releasing is always safe, and the server has already let go (the account may have changed or gone meanwhile),
      // so it is honoured whatever account it names. Only the owner's input is gated by the account.
      if (held?.botId === command.botId) held = null;
      await shared.handback(command.botId);
    }
  }

  const pause = ms => new Promise(resolve => { const t = setTimeout(resolve, ms); abort.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, {once: true}); });

  async function run() {
    let delay = retryMs;
    while (!stopped) {
      try {
        await shared.refresh();
        const tabs = shared.status().map(({botId, account, url, title}) => ({botId, account: accountOf(account), url, title}));
        // Who the owner holds, and a takeover that could not start, so the server's picture follows the device's.
        const report = {tabs, owner: shared.owner(), ...(failed ? {failed} : {})};
        failed = null;
        const reply = await call('/api/agent/live', report, {timeoutMs: 30000, signal: abort.signal});
        delay = retryMs;
        // Work was queued for this device: heartbeat now rather than at the next interval.
        if (reply?.tasks && onTasks) { try { onTasks(); } catch { /* Only a hint. */ } }
        for (const command of reply?.commands || []) await handle(command);
        await apply(reply?.watch, reply?.watchAccount);
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
