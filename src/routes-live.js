/** The live view of the shared browser over HTTP.
 *
 * Two kinds of caller, two kinds of check:
 *
 * - the paired device (`/api/agent/live`, `/api/agent/frames`) is verified by its
 *   HMAC signature, like every other agent route;
 * - the owner (`/api/browser-live/...`) needs a signed-in member. A frame is a
 *   picture of whatever the browser is signed in to, so a viewer cannot have one.
 *
 * `src/browser-live.js` keeps what these routes carry, in memory only. */
import {companyBots} from '../shared/company.js';
import * as agent from './agent.js';
import {browserLive as hub} from './browser-live.js';
import {DEFAULT_WORKSPACE} from './auth.js';
import {fail, safeJson} from './http.js';

/** A frame is a JPEG in base64: larger than an ordinary request body. */
const FRAME_BODY_LIMIT = 1024 * 1024;

export function liveRoutes(router, {workspaces}) {
  // The workspace a device was paired in, as the other agent routes find it.
  const agentStore = c => workspaces.holding('SELECT 1 AS x FROM agents WHERE id=?', String(c.req.headers['x-agent-id'] || '')) || workspaces.get(DEFAULT_WORKSPACE);
  const device = (c, raw) => agent.verifyAgentRequest(agentStore(c), c.req.headers, 'POST', c.path, raw);

  router.add('POST', '/api/agent/live', 'agent', async c => {
    const raw = await c.raw();
    const who = device(c, raw);
    return hub.agentSync(who.workspace_id, who.id, safeJson(raw));
  });
  router.add('POST', '/api/agent/frames', 'agent', async c => {
    const raw = await c.raw(FRAME_BODY_LIMIT);
    const who = device(c, raw);
    const body = safeJson(raw);
    return hub.putFrame(who.workspace_id, who.id, {botId: typeof body.botId === 'string' ? body.botId.slice(0, 64) : '', image: body.image, w: body.w, h: body.h});
  });

  /** The bot must exist in this workspace: the live view never names a stranger. */
  const botOf = c => {
    if (!companyBots(c.store.read()).some(bot => bot.id === c.params.botId)) fail('That bot does not exist.', 404);
    return c.params.botId;
  };
  router.add('GET', '/api/browser-live/:botId', 'member', c => {
    const after = Number(new URL(c.req.url, 'http://local').searchParams.get('after'));
    return hub.view(c.actor.workspaceId, botOf(c), {after: Number.isFinite(after) ? after : undefined});
  });
  router.add('POST', '/api/browser-live/:botId/input', 'member', async c => {
    const botId = botOf(c);
    hub.input(c.actor.workspaceId, botId, await c.body());
    return {ok: true};
  });
}
