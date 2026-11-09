/* Transport selector for the Agent Control app.
 *
 * One UI, two backends:
 *  - Under the Node server, same-origin `/api/*` routes are available. Use them.
 *  - On the static GitHub Pages build there is no server, so fall back to the
 *    browser-local `localStorage` implementation in `local-api.js`.
 *
 * The switch is resolved once at startup. Both transports expose the same
 * `(path, method, body) => Promise` contract, so `app.js` never branches.
 */
(function () {
  'use strict';
  // Build-time marker: the Pages bundle is stamped `static`, the Node-served
  // page keeps `server`. This is the only reliable signal because both are
  // served over http(s) origins where /api may or may not exist.
  var marker = document.querySelector('meta[name="agent-backend"]');
  var backend = marker && marker.getAttribute('content');
  var useLocal = backend === 'static' || location.protocol === 'file:';
  // A request that never settles used to freeze the whole UI: `refreshing` was
  // never cleared, so every later poll was skipped and the progress bar stayed
  // lit. Generous, because the Node build also streams model answers.
  var TIMEOUT_MS = 20000;
  function timedOut(error) { return Boolean(error) && (error.name === 'TimeoutError' || error.name === 'AbortError'); }
  function httpError(response, message) { return Object.assign(new Error(message), {status: response.status}); }
  /** Read the body of a response. `json()` first, because that is the contract;
   * a body that is not JSON is an error page or a proxy, never a snapshot. */
  function bodyOf(response) {
    return response.json().catch(function () {
      return typeof response.text === 'function'
        ? response.text().then(function (text) {
          // An empty successful body is a no-content reply. Anything else is
          // refused below, so a broken answer cannot be stored as the workspace.
          if (!text) return {};
          var error = new Error('The server sent a response that is not JSON.');
          error.notJson = true;
          throw error;
        }, function () { return {}; })
        : {};
    });
  }

  function api(path, method, body) {
    // Resolve the browser-local backend lazily: it is a deferred module and
    // may not have attached its global when this classic script first runs.
    if (useLocal) return window.AGENT_LOCAL_API(path, method, body);
    var verb = method || 'GET';
    var options = {method: verb, credentials: 'same-origin', headers: {'Content-Type': 'application/json'}};
    // GET/HEAD requests must not carry a body, even an empty default.
    if (body !== undefined && verb !== 'GET' && verb !== 'HEAD') options.body = JSON.stringify(body);
    // `AbortSignal.timeout` is missing in some older browsers, so the request
    // still works there; it just cannot give up on its own.
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') options.signal = AbortSignal.timeout(TIMEOUT_MS);
    return fetch(path, options).then(function (response) {
      return bodyOf(response).then(function (data) {
        if (!response.ok) throw httpError(response, (data && data.error) || ('HTTP ' + response.status));
        return data;
      }, function (error) {
        // A failed request whose body is also unreadable still reports the status,
        // which is what sign-in and permission handling key on.
        if (!response.ok) throw httpError(response, 'HTTP ' + response.status);
        throw error;
      });
    }, function (error) {
      // Make a timeout an ordinary error so the caller's error path shows it.
      if (timedOut(error)) throw Object.assign(new Error('The server took too long to answer (' + Math.round(TIMEOUT_MS / 1000) + ' s).'), {timeout: true});
      throw error;
    });
  }

  window.AGENT_API = api;
})();