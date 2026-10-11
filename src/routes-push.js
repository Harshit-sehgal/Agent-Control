/** Push notifications over HTTP: the key a browser subscribes with, and the
 * signed-in account's own devices. Nobody can register or remove a device for
 * someone else. */
import {reply} from './router.js';

export function pushRoutes(router, {push}) {
  router.add('GET', '/api/push', 'viewer', c => ({publicKey: push.publicKey(), endpoints: push.endpoints(c.actor.userId)}));
  router.add('POST', '/api/push/subscriptions', 'viewer', async c => reply(201, push.subscribe(c.actor.userId, await c.body(), c.req.headers['user-agent'])));
  router.add('DELETE', '/api/push/subscriptions', 'viewer', async c => push.unsubscribe(c.actor.userId, (await c.body()).endpoint));
  router.add('POST', '/api/push/test', 'viewer', c => push.test(c.actor.userId));
}
