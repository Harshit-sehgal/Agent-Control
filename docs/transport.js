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

  function api(path, method, body) {
    // Resolve the browser-local backend lazily: it is a deferred module and
    // may not have attached its global when this classic script first runs.
    if (useLocal) return window.AGENT_LOCAL_API(path, method, body);
    var verb = method || 'GET';
    var options = {method: verb, credentials: 'same-origin', headers: {'Content-Type': 'application/json'}};
    // GET/HEAD requests must not carry a body, even an empty default.
    if (body !== undefined && verb !== 'GET' && verb !== 'HEAD') options.body = JSON.stringify(body);
    return fetch(path, options).then(function (response) {
      return response.json().catch(function () { return {error: 'Invalid server response'}; }).then(function (data) {
        if (!response.ok) {
          var error = new Error(data.error || ('HTTP ' + response.status));
          error.status = response.status;
          throw error;
        }
        return data;
      });
    });
  }

  window.AGENT_API = api;
})();