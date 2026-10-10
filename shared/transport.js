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
  var local = window.AGENT_LOCAL_API;
  var staticHosting = location.protocol === 'file:';

  function api(path, method, body) {
    if (staticHosting) return local(path, method, body);
    var options = {method: method || 'GET', credentials: 'same-origin', headers: {'Content-Type': 'application/json'}};
    if (body !== undefined) options.body = JSON.stringify(body);
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
  window.AGENT_PAGES_DEMO = local; // Backwards-compatible alias used by tests.
})();