/** The one way a rule refuses a request: an Error carrying the HTTP status the
 * dispatcher should send.
 *
 * Every module that validates something used to declare its own copy of this
 * one-liner, so changing the shape (adding a code, say) meant finding a dozen
 * of them. It lives here because both the browser modules and the Node server
 * need it, and this file has no imports of its own. `src/http.js` re-exports it
 * so the server keeps one name for the same thing.
 */
export const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status}); };
