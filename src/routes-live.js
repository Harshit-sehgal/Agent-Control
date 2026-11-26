/** The live view of the shared browser over HTTP.
 *
 * Two kinds of caller, two kinds of check:
 *
 * - the paired device (`/api/agent/live`, `/api/agent/frames`) is verified by its
 *   HMAC signature, like every other agent route;
 * - the owner (`/api/browser-live/...`) needs a signed-in member. A frame is a
 *   picture of whatever the browser is signed in to, so a viewer cannot have one.
 *   Driving it (take over, hand back, input) is an admin's: the tab is the owner's
 *   signed-in browser, and a click there needs no ask.
 *
 * `src/browser-live.js` keeps what these routes carry, in memory only. */
import {companyBots} from '../shared/company.js';
import * as agent from './agent.js';
import {browserLive as hub, liveStates} from './browser-live.js';
import {DEFAULT_WORKSPACE} from './auth.js';
import {fail, safeJson, requireSecureSecret} from './http.js';
import {SECRET_INPUT_V1, UPDATE_DEVICE_LINE, hasFeature} from '../shared/device-features.js';

/** A frame is a JPEG in base64: larger than an ordinary request body. */
const FRAME_BODY_LIMIT = 1024 * 1024;

export function liveRoutes(router, {workspaces}) {
  // A task queued for a device answers its parked live poll, so it heartbeats at once.
  agent.onAgentTaskQueued((workspaceId, agentId) => hub.taskQueued(workspaceId, agentId));
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
  /** One bot's entry in the list, as it is now. */
  const entryOf = (c, botId) => liveStates(c.store.read(), {hub, ws: c.actor.workspaceId}).find(e => e.botId === botId);

  /** What the device serving this workspace's live view says its app can do (none when no device is on the line). */
  const featuresOf = c => {
    const id = hub.agentId(c.actor.workspaceId);
    return id ? agent.readAgentFeatures(c.store, id) : [];
  };

  router.add('GET', '/api/browser-live', 'member', c => liveStates(c.store.read(), {hub, ws: c.actor.workspaceId}));
  router.add('GET', '/api/browser-live/:botId', 'member', c => {
    const after = Number(new URL(c.req.url, 'http://local').searchParams.get('after'));
    const botId = botOf(c), {state, url, title, site} = entryOf(c, botId);
    // `features` is what the view needs to know whether to offer the masked Password and Code fields.
    return {...hub.view(c.actor.workspaceId, botId, {after: Number.isFinite(after) ? after : undefined}), state, url, title, site, features: featuresOf(c)};
  });
  router.add('POST', '/api/browser-live/:botId/input', 'admin', async c => {
    const botId = botOf(c);
    const event = await c.body();
    requireSecureSecret(c.req, event);
    // A device whose app cannot hold a secret is never sent one: it would type it as any other text. Nothing is queued,
    // and the answer carries none of the typed text.
    if (event?.secret === true && !hasFeature(featuresOf(c), SECRET_INPUT_V1)) fail(UPDATE_DEVICE_LINE, 409);
    hub.input(c.actor.workspaceId, botId, event);
    return {ok: true};
  });
  // The owner takes the bot's tab: its run (if any) parks, no bot starts anything, and input is accepted.
  router.add('POST', '/api/browser-live/:botId/takeover', 'admin', c => {
    const botId = botOf(c);
    hub.takeover(c.actor.workspaceId, botId);
    return {botId, state: entryOf(c, botId).state};
  });
  // The owner is done: the parked run goes on, and bots may use the browser again.
  router.add('POST', '/api/browser-live/:botId/handback', 'admin', c => {
    const botId = botOf(c);
    hub.handback(c.actor.workspaceId, botId);
    return {botId, state: entryOf(c, botId).state};
  });
}
