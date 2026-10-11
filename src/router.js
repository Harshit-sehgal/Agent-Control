/** Route table.
 *
 * Every route is registered with the access it needs, so the permission is
 * part of the route and cannot be forgotten in a separate list:
 *
 *   public  no session (health, sign-in, password reset, extension capture)
 *   agent   a paired local agent, verified by the handler with an HMAC signature
 *   viewer / member / admin / owner   the least workspace role allowed
 *
 * A handler receives one context object and returns the JSON to send (status
 * 200), or `reply(status, body, headers)` for anything else.
 */
import {ROLES} from './auth.js';

export const ACCESS = ['public', 'agent', ...ROLES];
const PARAM = /:([a-zA-Z]+)/g;
const REPLY = Symbol('reply');

export const reply = (status, body, headers = {}) => ({[REPLY]: true, status, body, headers});
export const isReply = value => Boolean(value?.[REPLY]);
/** True when a session role may use a route that asks for `access`. */
export const allows = (role, access) => ROLES.indexOf(role) >= ROLES.indexOf(access);

export function createRouter() {
  const routes = [];
  /** `pattern` is a literal path; `:name` matches one id segment. */
  function add(method, pattern, access, handler) {
    if (!ACCESS.includes(access)) throw new Error(`Unknown access "${access}" for ${method} ${pattern}.`);
    if (routes.some(r => r.method === method && r.pattern === pattern)) throw new Error(`Route ${method} ${pattern} is registered twice.`);
    const names = [...pattern.matchAll(PARAM)].map(m => m[1]);
    routes.push({method, pattern, access, handler, names, regex: new RegExp(`^${pattern.replace(PARAM, '([a-z0-9-]+)')}$`)});
  }
  function find(method, path) {
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.regex.exec(path);
      if (match) return {route, params: Object.fromEntries(route.names.map((name, i) => [name, match[i + 1]]))};
    }
    return null;
  }
  return {add, find, routes};
}
