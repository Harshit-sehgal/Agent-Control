/** Event triggers over HTTP. Two kinds of caller:
 *
 *  - an outside sender (GitHub, a deploy hook) posts an event to `/api/events/:workspace/:trigger`. It is a
 *    public route with no session, so it checks its own HMAC signature; an unknown trigger and a wrong
 *    signature are told apart only by the status, and nothing else is revealed.
 *  - the owner and members list, make, switch off, re-key and remove triggers, behind the usual roles.
 *
 * Behind Cloudflare Access the event path needs a bypass rule for senders that cannot log in. That is the
 * owner's decision, not something the app changes.
 */
import {reply} from './router.js';
import {fail, clientIpOf} from './http.js';
import {MAX_EVENT_BYTES} from '../shared/triggers.js';
import {createTrigger, eventPath, listTriggers, receiveEvent, removeTrigger, rotateTriggerSecret, setTriggerEnabled} from './triggers.js';

/** Counts refusals, not events: a client that keeps sending bad signatures or unknown ids is blocked for the window,
 * while a sender with a good signature is never counted. Keys are the trigger and the real client address. */
export function eventGuard({max = 20, windowMs = 60000, now = () => Date.now()} = {}) {
  const windows = new Map();
  const current = key => {
    const t = now();
    let w = windows.get(key);
    if (!w || t >= w.until) { w = {count: 0, until: t + windowMs}; windows.set(key, w); }
    if (windows.size > 10000) for (const [k, v] of windows) if (t >= v.until) windows.delete(k);
    return w;
  };
  return {
    blocked: key => current(key).count >= max,
    refused: key => { current(key).count += 1; },
  };
}
const guard = eventGuard();

export function eventRoutes(router, {workspaces}) {
  router.add('POST', '/api/events/:workspace/:trigger', 'public', async c => {
    const key = `${c.params.workspace}/${c.params.trigger}|${clientIpOf(c.req)}`;
    if (guard.blocked(key)) return reply(429, {error: 'Too many refused events from this address. Try again in a minute.'}, {'Retry-After': '60'});
    const store = workspaces.get(c.params.workspace);
    // An unknown workspace gets the same answer as a bad signature, so the route does not reveal which exist.
    if (!store) { guard.refused(key); return reply(401, {error: 'The signature does not match.'}); }
    // rawBody refuses anything over the cap before it is read, and the signature is checked on these exact bytes.
    const raw = await c.raw(MAX_EVENT_BYTES);
    const out = await receiveEvent(store, {triggerId: c.params.trigger, raw, signature: c.req.headers['x-hub-signature-256'], event: c.req.headers['x-github-event']});
    if (out.status === 401) guard.refused(key);
    return reply(out.status, out.body);
  });

  router.add('GET', '/api/triggers', 'viewer', c => ({triggers: listTriggers(c.store.read(), c.actor.workspaceId)}));

  // The secret comes back once, here. Store it in the sender now; it is never shown again (rotate for a new one).
  router.add('POST', '/api/triggers', 'member', async c => {
    const b = await c.body();
    const out = await createTrigger(c.store, c.actor.workspaceId, b, {createdBy: c.actor.email});
    return reply(201, {trigger: out.trigger, secret: out.secret, path: eventPath(c.actor.workspaceId, out.trigger.id)});
  });

  router.add('PATCH', '/api/triggers/:id', 'member', async c => {
    const b = await c.body();
    if (typeof b.enabled !== 'boolean') fail('Say whether the trigger is on (enabled: true or false).', 400);
    return setTriggerEnabled(c.store, c.actor.workspaceId, c.params.id, b.enabled);
  });

  router.add('POST', '/api/triggers/:id/rotate', 'member', async c => {
    const secret = await rotateTriggerSecret(c.store, c.actor.workspaceId, c.params.id);
    return {ok: true, secret, path: eventPath(c.actor.workspaceId, c.params.id)};
  });

  router.add('DELETE', '/api/triggers/:id', 'member', c => removeTrigger(c.store, c.actor.workspaceId, c.params.id));
}
