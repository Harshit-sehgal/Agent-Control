import {FOCUSED_IS_SECRET_JS, TAG_FOCUSED_SECRET_JS, CLEAR_SECRETS_AFTER_CLICK_JS, CLEAR_SECRETS_AFTER_ENTER_JS, CLEAR_SECRETS_ON_HANDBACK_JS} from '../agent/page-secrets.mjs';

const CLEARS = new Map([[CLEAR_SECRETS_AFTER_CLICK_JS, 'click'], [CLEAR_SECRETS_AFTER_ENTER_JS, 'enter'], [CLEAR_SECRETS_ON_HANDBACK_JS, 'handback']]);

/** A scripted DevTools connection, so the browser code can run with no Chrome.
 *
 * `fakeCdp()` returns the shape `connect()` in agent/browser.mjs returns
 * ({send, on, close, onClose}) plus what a test needs to steer and read it:
 * `calls` (every command, in order), `emit` (an event from the browser), `hook`
 * (replace or delay one command), `pages` (what a url shows) and `die` (the
 * browser process went away). It is not Chrome: it answers the commands the
 * agent sends with the replies Chrome gives for them, nothing more.
 */
export function fakeCdp({pages = {}} = {}) {
  const calls = [], tagged = [], cleared = [], listeners = new Map(), closers = [], hooks = {}, targets = new Map(), actions = [], input = [];
  const state = {focusSecret: false};
  let seq = 0, closed = false;

  const emit = (method, params = {}, sessionId, raw = params) => {
    for (const listener of [...(listeners.get(method) || [])]) listener({...params, sessionId}, raw);
  };
  const pageOf = sessionId => [...targets.values()].find(t => t.sessionId === sessionId);

  const evaluate = (expression, sessionId) => {
    const page = pageOf(sessionId) || {url: 'about:blank', title: ''};
    const shown = pages[page.url] || {};
    const snapshot = {count: (shown.elements || []).length, elements: shown.elements || []};
    // The takeover's two questions about the focused field: is it secret (answered by `focusSecret`), and the tag.
    if (expression === FOCUSED_IS_SECRET_JS) {
      // 'throws': the page expression threw, which Chrome answers with exceptionDetails and no value.
      return state.focusSecret === 'throws' ? {result: {type: 'object', subtype: 'error'}, exceptionDetails: {text: 'Uncaught'}} : {result: {value: state.focusSecret}};
    }
    if (expression === TAG_FOCUSED_SECRET_JS) { tagged.push({sessionId, expression}); return {result: {value: true}}; }
    // The device emptying the page's secret fields: which of its three moments asked, in order.
    if (CLEARS.has(expression)) { cleared.push({sessionId, when: CLEARS.get(expression)}); return {result: {value: 1}}; }
    if (expression === 'location.href') return {result: {value: page.url}};
    if (expression === 'document.readyState') return {result: {value: 'complete'}};
    if (expression.startsWith('(function(){var els=')) return {result: {value: snapshot}};
    // A page read: `url` is the real address the device decides with, `shown` the one a model is handed (secrets hidden).
    if (expression.startsWith('JSON.stringify((function(){') && expression.includes('shown:')) {
      return {result: {value: JSON.stringify({url: page.url, shown: shown.shown ?? page.url, title: shown.title || '', text: shown.text || '', links: shown.links || [], snapshot})}};
    }
    actions.push({sessionId, url: page.url, expression});
    return {result: {value: {ok: true, text: shown.read ?? null}}};
  };

  async function send(method, params = {}, sessionId) {
    if (closed) throw new Error('The browser connection is closed.');
    calls.push({method, params, sessionId});
    if (hooks[method]) { const replaced = await hooks[method](params, sessionId); if (replaced !== undefined) return replaced; }
    switch (method) {
      case 'Target.createTarget': {
        const targetId = `T${++seq}`;
        targets.set(targetId, {targetId, sessionId: null, url: params.url || 'about:blank', title: '', type: 'page'});
        return {targetId};
      }
      case 'Target.attachToTarget': {
        const target = targets.get(params.targetId);
        if (!target) throw new Error('No target with the given id was found.');
        target.sessionId = `S${++seq}`;
        return {sessionId: target.sessionId};
      }
      case 'Target.getTargets': return {targetInfos: [...targets.values()].map(({targetId, url, title, type}) => ({targetId, url, title, type}))};
      case 'Target.closeTarget': return {success: targets.delete(params.targetId)};
      case 'Page.navigate': {
        const page = pageOf(sessionId);
        if (page) { page.url = params.url; page.title = pages[params.url]?.title || ''; }
        setTimeout(() => emit('Page.loadEventFired', {}, sessionId), 0);
        return {frameId: 'F'};
      }
      case 'Runtime.evaluate': return evaluate(params.expression, sessionId);
      case 'Page.captureScreenshot': return {data: 'c2VlZA=='};
      case 'Input.dispatchMouseEvent': case 'Input.dispatchKeyEvent': case 'Input.insertText': input.push({method, params, sessionId}); return {};
      default: return {};
    }
  }

  const cdp = {
    send,
    on: (method, listener) => {
      listeners.set(method, [...(listeners.get(method) || []), listener]);
      return () => listeners.set(method, (listeners.get(method) || []).filter(entry => entry !== listener));
    },
    onClose: listener => { closers.push(listener); },
    close: () => { closed = true; },
  };
  return {
    cdp, calls, pages, actions, input, targets, tagged, cleared,
    /** Whether the focused field answers "secret" to the takeover's check (true, false, or 'throws'). */
    set focusSecret(value) { state.focusSecret = value; },
    connection: {cdp},
    emit, hook: (method, fn) => { hooks[method] = fn; },
    called: method => calls.filter(call => call.method === method),
    /** The browser process went away: every later command fails, and listeners hear it. */
    die: () => { closed = true; for (const closer of closers) closer(); },
    get closed() { return closed; },
  };
}
