import {FOCUSED_IS_SECRET_JS, TAG_FOCUSED_SECRET_JS, CLEAR_SECRETS_ON_HANDBACK_JS} from '../agent/page-secrets.mjs';

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
  // Browser contexts: id -> {cookies}. `null` is the default context, which always exists.
  const contexts = new Map([[null, {cookies: []}]]);
  const contextNamed = id => {
    const context = contexts.get(id ?? null);
    if (!context) throw new Error(`Failed to find browser context with id ${id}`);
    return context;
  };
  // What Storage.setCookies accepts (CookieParam): anything else is a protocol error, as in Chrome.
  const COOKIE_PARAM = new Set(['name', 'value', 'url', 'domain', 'path', 'secure', 'httpOnly', 'sameSite', 'expires', 'priority', 'sameParty', 'sourceScheme', 'sourcePort', 'partitionKey']);
  const asCookie = param => {
    for (const key of Object.keys(param)) if (!COOKIE_PARAM.has(key)) throw new Error(`Invalid parameters: unexpected cookie field ${key}`);
    if (typeof param.name !== 'string' || typeof param.value !== 'string') throw new Error('Invalid parameters: a cookie needs a name and a value');
    const session = !(param.expires > 0);
    return {path: '/', secure: false, httpOnly: false, ...param, expires: session ? -1 : param.expires, size: param.name.length + param.value.length, session};
  };
  const hostOf = url => { try { return new URL(url).hostname; } catch { return ''; } };
  // A cookie goes to a page when its domain is the page's host or a parent of it.
  const sentTo = (cookie, url) => { const host = hostOf(url), domain = String(cookie.domain || '').replace(/^\./, ''); return !domain || host === domain || host.endsWith(`.${domain}`); };
  /** What a url shows for the cookies the page's context holds: a `pages` value may be a function of them. */
  const shownFor = page => {
    const value = pages[page.url];
    if (typeof value !== 'function') return value || {};
    return value({cookies: contexts.get(page.browserContextId ?? null)?.cookies.filter(c => sentTo(c, page.url)).map(c => ({...c})) || []}) || {};
  };
  const state = {focusSecret: false};
  let seq = 0, closed = false;

  const emit = (method, params = {}, sessionId, raw = params) => {
    for (const listener of [...(listeners.get(method) || [])]) listener({...params, sessionId}, raw);
  };
  const pageOf = sessionId => [...targets.values()].find(t => t.sessionId === sessionId);

  const evaluate = (expression, sessionId) => {
    const page = pageOf(sessionId) || {url: 'about:blank', title: ''};
    const shown = shownFor(page);
    const snapshot = {count: (shown.elements || []).length, elements: shown.elements || []};
    // The takeover's two questions about the focused field: is it secret (answered by `focusSecret`), and the tag.
    if (expression === FOCUSED_IS_SECRET_JS) {
      // 'throws': the page expression threw, which Chrome answers with exceptionDetails and no value.
      return state.focusSecret === 'throws' ? {result: {type: 'object', subtype: 'error'}, exceptionDetails: {text: 'Uncaught'}} : {result: {value: state.focusSecret}};
    }
    if (expression === TAG_FOCUSED_SECRET_JS) { tagged.push({sessionId, expression}); return {result: {value: true}}; }
    // The device emptying the page's secret fields when the owner hands back.
    if (expression === CLEAR_SECRETS_ON_HANDBACK_JS) { cleared.push({sessionId, when: 'handback'}); return {result: {value: 1}}; }
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
        contextNamed(params.browserContextId); // a target in a context that is gone is refused
        targets.set(targetId, {targetId, sessionId: null, url: params.url || 'about:blank', title: '', type: 'page', browserContextId: params.browserContextId ?? null});
        return {targetId};
      }
      case 'Target.attachToTarget': {
        const target = targets.get(params.targetId);
        if (!target) throw new Error('No target with the given id was found.');
        target.sessionId = `S${++seq}`;
        return {sessionId: target.sessionId};
      }
      case 'Target.getTargets': return {targetInfos: [...targets.values()].map(({targetId, url, title, type, browserContextId}) => ({targetId, url, title, type, ...(browserContextId ? {browserContextId} : {})}))};
      case 'Target.createBrowserContext': {
        const id = `C${++seq}`;
        contexts.set(id, {cookies: []});
        return {browserContextId: id};
      }
      case 'Target.disposeBrowserContext': {
        if (params.browserContextId == null || !contexts.has(params.browserContextId)) throw new Error(`Failed to find context with id ${params.browserContextId}`);
        contexts.delete(params.browserContextId);
        for (const [id, target] of targets) if (target.browserContextId === params.browserContextId) targets.delete(id);
        return {};
      }
      case 'Storage.getCookies': return {cookies: contextNamed(params.browserContextId).cookies.map(c => ({...c}))};
      case 'Storage.setCookies': {
        const context = contextNamed(params.browserContextId);
        const next = (params.cookies || []).map(asCookie); // all or nothing, as Chrome does
        for (const cookie of next) {
          const same = c => c.name === cookie.name && c.domain === cookie.domain && c.path === cookie.path;
          context.cookies = [...context.cookies.filter(c => !same(c)), cookie];
        }
        return {};
      }
      case 'Target.closeTarget': return {success: targets.delete(params.targetId)};
      case 'Page.navigate': {
        const page = pageOf(sessionId);
        if (page) { page.url = params.url; page.title = shownFor(page).title || ''; }
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
    /** Put a cookie (as Storage.getCookies reports it) in a browser context, as if a sign-in had set it. */
    setCookie: (contextId, cookie) => {
      const context = contextNamed(contextId);
      context.cookies = [...context.cookies.filter(c => !(c.name === cookie.name && c.domain === cookie.domain && c.path === (cookie.path ?? '/'))), {path: '/', ...cookie}];
    },
    /** The ids of the contexts that exist now (the default one is not listed). */
    contexts: () => [...contexts.keys()].filter(id => id !== null),
    /** The cookies a context holds. */
    cookiesOf: contextId => contextNamed(contextId).cookies.map(c => ({...c})),
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
