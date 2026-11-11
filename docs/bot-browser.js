/** Bot browser control: how a bot asks for a web page, and the rules that
 * bound the request.
 *
 * A bot holding the `browser.use` permission may ask for a page by putting a
 * fenced block in its reply:
 *
 *     ```browser
 *     {"url": "https://example.com/docs", "steps": [{"op": "read", "selector": "main"}]}
 *     ```
 *
 * The engine turns each block into a request record. Any bot may ask for a page:
 * if the owner has not said Always allow for this bot at this site, an ask card
 * waits for Decline, Allow or Always allow (`shared/asks.js`); a Deny the owner
 * set refuses it. The request then runs in a headless browser — the server's own,
 * or a paired local agent's — inside that runtime's allowlist and egress proxy.
 * The app, never the bot, decides which card a request earns: a click on a Send,
 * Post, Delete or Pay control is asked about as that, not as a page read. This
 * module only parses, classifies and bounds the request; it never runs anything.
 *
 * Posting stays human: interaction (click, type) is refused on X and Twitter
 * hosts, so no bot can press Post there. Reading those pages is allowed.
 */
import {cleanText, validHttpUrl} from './core.js?v=8ce3bc47dc';
import {fail} from './errors.js?v=8ce3bc47dc';
import {decide, createAsk, scopeOf} from './asks.js?v=8ce3bc47dc';
import {controlFence} from './reply-blocks.js?v=8ce3bc47dc';

export const BROWSER_PERMISSION = 'browser.use';
export const MAX_REQUESTS_PER_REPLY = 2;
export const MAX_STEPS = 25;
/** The highest index a request may name; matches what a snapshot reports. */
export const MAX_ELEMENT_INDEX = 500;
export const MAX_BROWSER_REQUESTS = 200;
export const STEP_OPS = ['navigate', 'click', 'type', 'waitFor', 'read', 'scroll'];
const INTERACTIVE = ['click', 'type'];
const POSTING_HOSTS = ['x.com', 'twitter.com'];
// One fence grammar shared with every other control block (see bot-link.js):
// the last block in a reply may be unclosed, and the strip path removes it.
const BLOCK = () => controlFence('browser');

// `x.com.` and `x.com%2e` are x.com. Leaving the trailing dot on treated that
// spelling as a different site, so a click or type there was allowed.
export const hostOf = url => { try { return new URL(url).hostname.toLowerCase().replace(/\.+$/, ''); } catch { return ''; } };

/** An allowlist entry in the same spelling as `hostOf`: no scheme, no path, no
 * port, no trailing dot, lower case. `https://Docs.Example.com:8443/x`,
 * `docs.example.com:8443` and `docs.example.com.` are one host, so the server
 * and the device cannot read the same `AGENT_BROWSER_ALLOWLIST` differently.
 * An IPv6 literal keeps its brackets, which is how a URL writes one. */
export const normalizeHost = value => {
  const text = String(value ?? '').trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split('/')[0];
  const host = text.startsWith('[') ? text.slice(0, text.indexOf(']') + 1) : text.split(':')[0];
  return host.replace(/\.+$/, '');
};

/** `AGENT_BROWSER_ALLOWLIST`, read the way an operator writes it. */
export const parseAllowlist = value => String(value ?? '').split(',').map(normalizeHost).filter(Boolean);

/** The one entry that means "any public host", instead of naming them all.
 * It is spelled like a host so the same parser and the same comparison apply,
 * and it is still only a host rule: the egress proxy refuses private and local
 * addresses whatever this says, and X keeps its click/type refusal. */
export const ALLOW_ALL = '*';

/** May `url` be opened? Matching is on the host, so the same page is allowed
 * whether the URL spells the port or not, and an empty host never matches.
 * A list containing `*` allows any host with a name; it never allows a URL
 * that has none (`file:`, `mailto:`, `about:`). */
export const hostAllowed = (url, allow = []) => {
  const host = hostOf(url);
  if (!host) return false;
  const entries = (allow || []).map(normalizeHost);
  return entries.includes(ALLOW_ALL) || entries.includes(host);
};

export const isPostingHost = url => { const host = hostOf(url); return POSTING_HOSTS.some(h => host === h || host.endsWith(`.${h}`)); };

/** Validate one request body into the agent task it becomes. A step targets an
 * element by `index` from the result's numbered list, or by `selector` when a
 * page is stable enough to name it. An index is what lets a second request act
 * on a page the model has only read once. */
export function validateBrowserRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('A browser request must be an object.');
  const url = validHttpUrl(cleanText(body.url, 2000));
  if (!url) fail('A browser request needs a public http(s) url.');
  const raw = body.steps === undefined ? [] : body.steps;
  if (!Array.isArray(raw)) fail('Browser steps must be a list.');
  if (raw.length > MAX_STEPS) fail(`A browser request may have at most ${MAX_STEPS} steps.`);
  const steps = raw.map(step => {
    if (!step || typeof step !== 'object' || !STEP_OPS.includes(step.op)) fail(`Each step needs an op: ${STEP_OPS.join(', ')}.`);
    const out = {op: step.op};
    if (step.op === 'scroll') {
      const times = Number(step.times);
      out.times = Number.isFinite(times) ? Math.min(4, Math.max(1, Math.round(times))) : 2;
    } else if (step.op === 'navigate') {
      out.url = validHttpUrl(cleanText(step.url, 2000));
      if (!out.url) fail('A navigate step needs a public http(s) url.');
    } else {
      const index = Number(step.index);
      if (Number.isInteger(index) && index >= 1 && index <= MAX_ELEMENT_INDEX) out.index = index;
      else {
        out.selector = cleanText(step.selector, 300);
        if (!out.selector) fail(`A ${step.op} step needs an index from the last result, or a CSS selector.`);
      }
    }
    if (step.op === 'type') out.text = cleanText(step.text, 2000);
    if (step.op === 'waitFor' && Number.isFinite(Number(step.timeoutMs))) out.timeoutMs = Math.min(15000, Math.max(0, Number(step.timeoutMs)));
    return out;
  });
  const interactive = steps.some(s => INTERACTIVE.includes(s.op));
  const pages = [url, ...steps.filter(s => s.op === 'navigate').map(s => s.url)];
  if (interactive && pages.some(isPostingHost)) fail('Bots may read X and Twitter pages but never click or type there. Posting stays yours.', 403);
  // No steps is a plain page read, which also works without the real browser.
  return {kind: steps.length ? 'browser.action' : 'browser.capture', url, steps};
}

/** Every browser block in a reply, validated. An invalid block is reported,
 * not dropped, so the chat can say why nothing ran. At most
 * `MAX_REQUESTS_PER_REPLY` blocks are processed in total, valid or invalid,
 * so a reply cannot flood the chat with error cards. */
export function parseBrowserRequests(output) {
  const found = [];
  for (const match of String(output ?? '').matchAll(BLOCK())) {
    if (found.length >= MAX_REQUESTS_PER_REPLY) break;
    try {
      let body;
      try { body = JSON.parse(match[1].trim()); } catch { fail('The browser block is not valid JSON.'); }
      found.push({ok: true, request: validateBrowserRequest(body)});
    } catch (error) { found.push({ok: false, error: error.message}); }
  }
  return found;
}

/** The reply as the chat shows it: the blocks are replaced by request cards. */
export const stripBrowserBlocks = output => String(output ?? '').replace(BLOCK(), '').replace(/\n{3,}/g, '\n\n').trim();

/** What a bot is told about the tool when it holds the permission. */
export const BROWSER_TOOL_HINT = 'You can read or use a web page through a headless browser. Put one block per page in your reply, e.g. ```browser\n{"url":"https://example.com"}\n``` That returns the page text and a numbered list of controls. To act, name a control by its number in the same block: {"url":"https://example.com","steps":[{"op":"click","index":3}]} then read the result. Ops: navigate, click, type, waitFor, read, scroll. A CSS selector also works instead of an index. Scroll only moves the page. Any public site works, including X and YouTube pages (read them; you can never click or type on X or Twitter). To find something you have no link for, search first: open https://html.duckduckgo.com/html/?q=your+search+words and then open the results that fit. Do not ask the owner for a link you can find this way, and do not answer from memory when the question is about now. You may put up to 2 blocks in one reply to read pages side by side, and ask for more pages after you read those. The result comes back in the chat.';

/** The numbered controls a snapshot returned, in one line. The model acts on
 * these; a page of raw HTML is not something it can click. */
const controlLine = elements => (Array.isArray(elements) ? elements : [])
  .filter(e => e && Number.isInteger(e.index) && e.text)
  .slice(0, 24)
  .map(e => `[${e.index}] ${e.tag || 'element'} ${e.text}`.trim())
  .join(' · ');

/** Page text the next bot turn can draft from. The chat line uses a shorter cap. */
export function capturePageText(result, limit = 3600) {
  const r = result && typeof result === 'object' ? result : {};
  const reads = Array.isArray(r.actions) ? r.actions.filter(a => a && typeof a.text === 'string').map(a => a.text) : [];
  const controls = controlLine(r.elements);
  const body = reads.join('\n') || r.text || r.excerpt || '';
  return cleanText([body, controls ? `Controls: ${controls}` : ''].filter(Boolean).join('\n\n'), limit);
}

/** A short chat line summarising an agent's result. */
export function browserResultText(request, result) {
  const r = result && typeof result === 'object' ? result : {};
  const body = capturePageText(result, 1500);
  const head = `${r.title ? `${cleanText(r.title, 160)} · ` : ''}${cleanText(r.finalUrl || request.url, 300)}`;
  return `Browser result for ${request.botName}: ${head}${body ? `\n\n${body}` : '\n\nThe page returned no text.'}`;
}

/** How many browse-then-continue rounds one conversation turn may chain. */
export const MAX_BROWSER_DEPTH = 3;
/** The words that make a click or a typed field something the owner is asked about, riskiest first.
 * The app classifies, never the bot: a step names a control by index or selector, and the label comes
 * from the page result the bot was last shown. A control the bot was not shown a label for is at least
 * a Send. The browser reads the control again when it acts (agent/browser.mjs) with the same words. */
export const RISKS = [
  ['spend', /\b(pay|payment|buy|purchase|checkout|check out|place (?:your |the )?order|subscribe|donate|card number|cvc|cvv)\b/i],
  ['delete', /\b(delete|remove|erase|destroy)\b/i],
  ['post', /\b(post|publish|tweet)\b/i],
  ['send', /\b(send|submit|confirm)\b/i],
];
/** A checkout, payment or billing page: opening one is a payment, and the device refuses a click on one unless a payment was approved. */
export const CHECKOUT_PATH = /\/(checkout|payment|billing)(\/|$)/i;

/** The risk classes a control's label names, riskiest first: ['spend'], ['send'], [] ... */
export const riskOf = label => RISKS.filter(([, pattern]) => pattern.test(String(label ?? ''))).map(([action]) => action);

/** `{index → label}` for the controls of the page this bot last read in this chat ("[3] button Send"). */
export function controlLabels(state, botId, chatKey) {
  const last = (state?.browserRequests || []).find(r => r.botId === botId && r.chatKey === chatKey && r.status === 'done' && r.result?.page);
  const labels = new Map();
  for (const match of String(last?.result?.page || '').matchAll(/\[(\d+)\] (\S+) ([^·\n]*)/g)) labels.set(Number(match[1]), match[3].trim());
  return labels;
}

/** The origin a page URL is on ("https://b.example"), or '' when it is not a web page. */
const originOf = url => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin.toLowerCase() : ''; } catch { return ''; } };
/** One `approved` entry: a risky class cleared for one origin, "send@https://b.example". The browser
 * checks it against `location.origin` at the click (agent/browser.mjs). */
export const approvedFor = (action, url) => `${action}@${originOf(url)}`;

/** Everything one request needs the owner's say on, riskiest first, the page itself last: a send, a
 * post, a delete or a payment where a step's control says so, on the page that step runs on (the request
 * URL, then each `navigate`), and `browser.use` for each origin it reaches. [{action, target, detail}],
 * one per action and origin. */
export function browserNeeds(request, controls = new Map()) {
  const needs = [], seen = new Set();
  const add = (action, target, detail) => {
    const key = approvedFor(action, target);
    if (seen.has(key)) return;
    seen.add(key);
    needs.push({action, target, detail});
  };
  let here = request.url;
  for (const step of request.steps || []) {
    if (step.op === 'navigate') { here = step.url; continue; }
    if (!INTERACTIVE.includes(step.op)) continue;
    const label = step.index ? controls.get(step.index) || '' : '';
    const named = label || step.selector || `control ${step.index}`;
    const actions = riskOf(label || step.selector);
    // Not labelled on a page this bot was shown: the app cannot tell what it does, so it is at least a Send.
    if (!label && !actions.length) actions.push('send');
    for (const action of actions) add(action, here, `${step.op === 'type' ? 'type into' : 'click'} "${named.slice(0, 60)}" on ${hostOf(here) || here}`);
  }
  const pages = [request.url, ...(request.steps || []).filter(s => s.op === 'navigate').map(s => s.url)];
  for (const u of pages) {
    let checkout = false;
    try { checkout = CHECKOUT_PATH.test(new URL(u).pathname); } catch { /* Not a URL: validation refused it already. */ }
    if (checkout) add('spend', u, `open a checkout page on ${hostOf(u)}`);
  }
  needs.sort((a, b) => RISKS.findIndex(r => r[0] === a.action) - RISKS.findIndex(r => r[0] === b.action));
  const origins = new Map();
  for (const u of pages) { const origin = scopeOf({action: 'browser.use', target: u}); if (origin && !origins.has(origin)) origins.set(origin, u); }
  let first = true;
  for (const [, u] of origins) { needs.push({action: 'browser.use', target: u, detail: first ? describe(request) : `open ${hostOf(u)}`}); first = false; }
  return needs;
}

/** What one ask says when it stands for several pairs: every action and every site Allow approves, as
 * "send on a.example and b.example; open c.example". Opening a site is implied by acting on it, so a page is
 * named only when nothing else on that site is. One pair keeps its own detail. */
export function askedDetail(asked) {
  const sitesOf = action => [...new Set(asked.filter(n => n.action === action).map(n => hostOf(n.target)).filter(Boolean))];
  const acted = new Set(asked.filter(n => n.action !== BROWSER_PERMISSION).map(n => hostOf(n.target)));
  let pairs = 0;
  const named = [...new Set(asked.map(n => n.action))].map(action => {
    const sites = action === BROWSER_PERMISSION ? sitesOf(action).filter(h => !acted.has(h)) : sitesOf(action);
    pairs += sites.length;
    if (!sites.length) return '';
    const where = sites.join(' and ');
    return action === BROWSER_PERMISSION ? `open ${where}` : action === 'spend' ? `pay on ${where}` : `${action} on ${where}`;
  }).filter(Boolean);
  return pairs > 1 ? named.join('; ') : asked[0].detail;
}

const describe = request => `${request.steps.length ? `use ${hostOf(request.url)} (${request.steps.length} step${request.steps.length === 1 ? '' : 's'})` : `read ${hostOf(request.url)}`}`;
export const browserMessageId = id => `browser-${id}`.slice(0, 64);
export const requestOfMessage = (state, messageId) => (state?.browserRequests || []).find(r => browserMessageId(r.id) === messageId) || null;

/** Turn the browser blocks of one bot reply into request records and the chat
 * lines that show them. Returns the reply text without the blocks, the new
 * records, and the lines to append. A bot without the permission, or a chain
 * past MAX_BROWSER_DEPTH, gets a line saying why nothing ran. */
const samePage = (a, b) => {
  try {
    const left = new URL(a), right = new URL(b);
    return left.host === right.host
      && left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '')
      && left.search === right.search && left.hash === right.hash;
  } catch { return false; }
};

export function recordBrowserRequests(state, {bot, groupId, chatKey, output, depth = 0, skipUrls = [], runId = null, unattended = false, closed = false, makeId = () => crypto.randomUUID(), now = new Date().toISOString()}) {
  depth = Math.max(0, Math.min(MAX_BROWSER_DEPTH, Number(depth) || 0));
  const found = parseBrowserRequests(output), text = stripBrowserBlocks(output), lines = [], records = [], asks = [];
  if (!found.length) return {text: String(output ?? ''), records, lines, asks};
  const say = line => lines.push({id: makeId(), role: 'system', text: line, at: now});
  // A bot never answers "I don't have permission": a page it has no grant for is an ask, and the owner
  // says Allow, Always allow or Decline. A Deny the owner set is the one thing that refuses outright.
  if (depth >= MAX_BROWSER_DEPTH) say(`${bot.name} asked for another web page, but ${MAX_BROWSER_DEPTH} browsing rounds in a row is the limit. Ask again to continue.`);
  else if (closed) say(`${bot.name} asked for another web page, but you had just declined, so nothing was opened.`);
  // A run that has already read a connector carries private data: a new site asks (asks.js verdict).
  const readPrivate = Boolean(runId && (state.groupRuns || []).find(r => r.id === runId)?.connectorPage);
  if (depth < MAX_BROWSER_DEPTH && !closed) for (const item of found) {
    if (!item.ok) { say(`${bot.name} asked for a web page, but the request was refused: ${item.error}`); continue; }
    if (skipUrls.some(url => samePage(url, item.request.url))) { say(`${bot.name} already has that page, so it was not opened again.`); continue; }
    const needs = browserNeeds(item.request, controlLabels(state, bot.id, chatKey));
    const decision = decide(state, bot, needs, {readPrivate});
    if (decision.verdict === 'deny') { say(`${bot.name} asked to ${describe(item.request)}. ${decision.message}`); continue; }
    // `approved`: the risky classes this request is cleared for once it is sent (a grant, or the owner's
    // answer to its ask), each for the origin it runs on ("send@https://b.example"). Written here after the
    // validated request, so a reply cannot set it; the browser refuses any other risky control it meets,
    // and one approved for another origin (agent/browser.mjs).
    const approved = needs.filter(n => n.action !== BROWSER_PERMISSION).map(n => approvedFor(n.action, n.target));
    const record = {id: makeId(), botId: bot.id, botName: bot.name, groupId, chatKey, ...(runId ? {runId} : {}), ...item.request, approved, depth, status: 'pending', agentTaskIds: [], result: null, error: null, createdAt: now, updatedAt: now};
    records.push(record);
    if (decision.verdict === 'ask') {
      const {need} = decision;
      // One ask stands for every pair still needing the owner's say, and names each of them: Allow approves
      // exactly `approved`, and an ask across sites gets no Always allow (asks.js).
      const asked = createAsk(state, {botId: bot.id, runId, chatKey, action: need.action, target: need.target, detail: askedDetail(decision.asked), unattended, requestId: record.id, implies: decision.implies, covers: decision.asked, now, makeId});
      record.askId = asked.id;
      asks.push(asked);
    } else lines.push({id: browserMessageId(record.id), role: 'system', kind: 'browser', text: `${bot.name} wants to ${describe(record)}.`, at: now});
  }
  state.browserRequests ??= [];
  state.browserRequests.unshift(...records);
  pruneBrowserRequests(state);
  return {text: text || `${bot.name} asked to open a web page.`, records, lines, asks};
}

/** A person turns down a request that is still waiting, including one already
 * sent to the device when that request is tied to a group run. Those block
 * the group until they end. */
export function denyBrowserRequest(state, id) {
  const request = (state.browserRequests || []).find(r => r.id === id);
  if (!request) fail('Browser request not found.', 404);
  const cancellable = request.status === 'pending' || request.status === 'dispatched';
  if (!cancellable) fail('This browser request is no longer waiting.', 409);
  request.status = 'denied';
  request.updatedAt = new Date().toISOString();
  return request;
}

/** Bound finished history without discarding a request that still holds a run. */
export function pruneBrowserRequests(state) {
  state.browserRequests ??= [];
  if (state.browserRequests.length > MAX_BROWSER_REQUESTS) {
    const open = r => ['pending', 'dispatched'].includes(r.status);
    const waiting = state.browserRequests.filter(open);
    const finished = state.browserRequests.filter(r => !open(r));
    state.browserRequests = [...waiting, ...finished.slice(0, Math.max(0, MAX_BROWSER_REQUESTS - waiting.length))];
  }
  return state.browserRequests;
}
