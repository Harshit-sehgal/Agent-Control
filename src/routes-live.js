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
import {SECRET_INPUT_V1, BROWSER_ACCOUNTS_V1, UPDATE_DEVICE_LINE, hasFeature} from '../shared/device-features.js';
import {browserAccountOf, browserDeviceOf} from '../shared/browser-accounts.js';
import {ACCOUNT_GONE} from './bot-browser.js';
import {finishSignin} from './ask-runs.js';

/** A frame is a JPEG in base64: larger than an ordinary request body. */
const FRAME_BODY_LIMIT = 1024 * 1024;

export function liveRoutes(router, {workspaces}) {
  // A task queued for a device answers its parked live poll, so it heartbeats at once.
  agent.onAgentTaskQueued((workspaceId, agentId) => hub.taskQueued(workspaceId, agentId));
  // The workspace a device was paired in, as the other agent routes find it.
  // The hub asks, as it hands commands to a device, whether that device may be sent a typed secret.
  hub.holdsAccounts = (ws, agentId) => {
    const store = workspaces.get?.(ws);
    return Boolean(store && agentId) && hasFeature(agent.readAgentFeatures(store, agentId), BROWSER_ACCOUNTS_V1);
  };
  hub.holdsSecrets = (ws, agentId) => {
    const store = workspaces.get?.(ws);
    return Boolean(store && agentId) && hasFeature(agent.readAgentFeatures(store, agentId), SECRET_INPUT_V1);
  };
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
    return hub.putFrame(who.workspace_id, who.id, {botId: typeof body.botId === 'string' ? body.botId.slice(0, 64) : '', account: body.account, image: body.image, w: body.w, h: body.h});
  });

  /** The bot must exist in this workspace: the live view never names a stranger. */
  const botOf = c => {
    if (!companyBots(c.store.read()).some(bot => bot.id === c.params.botId)) fail('That bot does not exist.', 404);
    return c.params.botId;
  };
  /** One bot's entry in the list, as it is now. */
  const entryOf = (c, botId) => liveStates(c.store.read(), {hub, ws: c.actor.workspaceId}).find(e => e.botId === botId);

  /** The computer that serves a bot's tab, and the browser account it signs in as. The account's computer beats the
   * bot's pin; a bot with neither is served by whichever computer polled last. `missing` is a bot whose account record
   * is gone: it is refused, never shown or driven in the default profile. */
  const lineOf = (c, botId) => {
    const state = c.store.read(), {account, missing} = browserAccountOf(state, botId);
    // One computer for the whole request: the check and the queue must name the same one.
    return {agentId: hub.deviceFor(c.actor.workspaceId, botId, browserDeviceOf(state, botId) || null), account: account?.id ?? null, missing};
  };
  /** What a computer says its app can do (none when no computer is on the line). */
  const featuresOf = (c, agentId = null) => {
    const id = agentId || hub.agentId(c.actor.workspaceId);
    return id ? agent.readAgentFeatures(c.store, id) : [];
  };
  /** Why an account bot cannot be shown or driven now, else null: its account is gone, or its computer's app would ignore
   * the account and act in the default profile. Asked before anything is queued. */
  const accountRefusal = (c, line) => {
    if (line.missing) return ACCOUNT_GONE;
    if (line.account && !hasFeature(featuresOf(c, line.agentId), BROWSER_ACCOUNTS_V1)) return agent.missingFeatureLine(BROWSER_ACCOUNTS_V1);
    return null;
  };

  router.add('GET', '/api/browser-live', 'member', c => liveStates(c.store.read(), {hub, ws: c.actor.workspaceId}));
  router.add('GET', '/api/browser-live/:botId', 'member', c => {
    const after = Number(new URL(c.req.url, 'http://local').searchParams.get('after'));
    const botId = botOf(c), {state, url, title, site} = entryOf(c, botId), line = lineOf(c, botId);
    // `features` is what the view needs to know whether to offer the masked Password and Code fields.
    const features = featuresOf(c, line.agentId), extra = {state, url, title, site, features};
    // An account's tab is never cast by a computer that would ignore the account: nobody is asked to watch it.
    const refusal = accountRefusal(c, line);
    if (refusal) return {botId, agent: hub.agentLive(c.actor.workspaceId, line.agentId), seq: 0, changed: false, notice: refusal, ...extra};
    return {...hub.view(c.actor.workspaceId, botId, {after: Number.isFinite(after) ? after : undefined, agentId: line.agentId, account: line.account}), ...extra};
  });
  router.add('POST', '/api/browser-live/:botId/input', 'admin', async c => {
    const botId = botOf(c), line = lineOf(c, botId);
    const event = await c.body();
    requireSecureSecret(c.req, event);
    // An account bot's computer must know accounts, or the input would land in the default profile. Nothing is queued.
    const refusal = accountRefusal(c, line);
    if (refusal) fail(refusal, 409);
    // A device whose app cannot hold a secret is never sent one: it would type it as any other text. Nothing is queued,
    // and the answer carries none of the typed text.
    if (event?.secret === true && !hasFeature(featuresOf(c, line.agentId), SECRET_INPUT_V1)) fail(UPDATE_DEVICE_LINE, 409);
    hub.input(c.actor.workspaceId, botId, event, {agentId: line.agentId, account: line.account});
    return {ok: true};
  });
  // The owner takes the bot's tab: its run (if any) parks, no bot starts anything, and input is accepted.
  router.add('POST', '/api/browser-live/:botId/takeover', 'admin', c => {
    const botId = botOf(c), line = lineOf(c, botId);
    const refusal = accountRefusal(c, line);
    if (refusal) fail(refusal, 409);
    hub.takeover(c.actor.workspaceId, botId, {agentId: line.agentId, account: line.account});
    return {botId, state: entryOf(c, botId).state};
  });
  // The owner is done: the parked run goes on, and bots may use the browser again.
  // The account's open sign-in card is answered by it: every run waiting on it goes on, and its held pages go out again.
  router.add('POST', '/api/browser-live/:botId/handback', 'admin', async c => {
    const botId = botOf(c), line = lineOf(c, botId);
    hub.handback(c.actor.workspaceId, botId, {agentId: line.agentId, account: line.account});
    const signedIn = line.account ? await finishSignin(c.store, line.account, {actor: c.actor.email}) : null;
    return {botId, state: entryOf(c, botId).state, ...(signedIn ? {signedIn: {resumed: signedIn.resumed}} : {})};
  });
}
