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
 * The engine turns each block into a request record. A person approves it in
 * the chat (the default), or it runs at once when the bot's `browserApproval`
 * is `auto`. It then runs in a headless browser — the server's own, or a paired
 * local agent's — inside that runtime's allowlist and egress proxy. This module
 * only parses and bounds the request; it never runs anything.
 *
 * Posting stays human: interaction (click, type) is refused on X and Twitter
 * hosts, so no bot can press Post there. Reading those pages is allowed.
 */
import {cleanText, validHttpUrl} from './core.js?v=1ab2a4f06e';
import {fail} from './errors.js?v=1ab2a4f06e';
import {canBot} from './contracts.js?v=1ab2a4f06e';
import {controlFence} from './reply-blocks.js?v=1ab2a4f06e';

export const BROWSER_PERMISSION = 'browser.use';
export const MAX_REQUESTS_PER_REPLY = 2;
export const MAX_STEPS = 25;
/** The highest index a request may name; matches what a snapshot reports. */
export const MAX_ELEMENT_INDEX = 500;
export const MAX_BROWSER_REQUESTS = 200;
export const STEP_OPS = ['navigate', 'click', 'type', 'waitFor', 'read', 'scroll'];
export const HOME_FEED_URL = 'https://x.com/home';
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
export const BROWSER_TOOL_HINT = 'You can read or use a web page through a headless browser. Put one block per page in your reply, e.g. ```browser\n{"url":"https://example.com"}\n``` That returns the page text and a numbered list of controls. To act, name a control by its number in the same block: {"url":"https://example.com","steps":[{"op":"click","index":3}]} then read the result. Ops: navigate, click, type, waitFor, read, scroll. A CSS selector also works instead of an index. Scroll only moves the page. Only hosts the user allowlisted work. You can never click or type on X or Twitter. The result comes back in the chat.';

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

export function recordBrowserRequests(state, {bot, groupId, chatKey, output, depth = 0, skipUrls = [], runId = null, makeId = () => crypto.randomUUID(), now = new Date().toISOString()}) {
  depth = Math.max(0, Math.min(MAX_BROWSER_DEPTH, Number(depth) || 0));
  const found = parseBrowserRequests(output), text = stripBrowserBlocks(output), lines = [], records = [];
  if (!found.length) return {text: String(output ?? ''), records, lines};
  const say = line => lines.push({id: makeId(), role: 'system', text: line, at: now});
  if (!canBot(bot, BROWSER_PERMISSION)) say(`${bot.name} asked for a web page but does not hold the ${BROWSER_PERMISSION} permission. Grant it in the bot profile to allow this.`);
  else if (depth >= MAX_BROWSER_DEPTH) say(`${bot.name} asked for another web page, but ${MAX_BROWSER_DEPTH} browsing rounds in a row is the limit. Ask again to continue.`);
  else for (const item of found) {
    if (!item.ok) { say(`${bot.name} asked for a web page, but the request was refused: ${item.error}`); continue; }
    if (skipUrls.some(url => samePage(url, item.request.url))) { say(`${bot.name} already has that page, so it was not opened again.`); continue; }
    const record = {id: makeId(), botId: bot.id, botName: bot.name, groupId, chatKey, ...(runId ? {runId} : {}), ...item.request, depth, status: 'pending', agentTaskIds: [], result: null, error: null, createdAt: now, updatedAt: now};
    records.push(record);
    lines.push({id: browserMessageId(record.id), role: 'system', kind: 'browser', text: `${bot.name} wants to ${describe(record)}.`, at: now});
  }
  state.browserRequests ??= [];
  state.browserRequests.unshift(...records);
  pruneBrowserRequests(state);
  return {text: text || `${bot.name} asked to open a web page.`, records, lines};
}

/** Page text worth drafting from. A short capture, or a signed-out X wall, is empty.
 * The wall often says "Happening now" and "Sign in" without the phrase "Sign in to X". */
export function feedPageText(result) {
  const reads = Array.isArray(result?.actions) ? result.actions.filter(a => a && typeof a.text === 'string').map(a => a.text) : [];
  const page = String(reads.join(' ') || result?.text || '').replace(/\s+/g, ' ').trim();
  if (page.length < 80) return '';
  const seen = `${result?.title || ''} ${page}`;
  const wall = /\b(happening now|join today|sign in|log in|sign up|create your account)\b/i.test(seen);
  const posts = (page.match(/\b(reposted|replying to)\b/gi) || []).length;
  if (wall && posts === 0) return '';
  return page.slice(0, 3600);
}

/** The read-only home-feed request a tracked run files before any bot drafts.
 * Scroll moves the page. There is no click and no type. */
export function homeFeedRequest() {
  return validateBrowserRequest({url: HOME_FEED_URL, steps: [{op: 'scroll', times: 3}, {op: 'read', selector: 'main'}]});
}

/** File that request for the source bot, or a line saying why it cannot.
 * The record carries `runId` so the result resumes that run and a denial stops it. */
export function queueFeedRead(state, {bot, groupId, chatKey, runId, makeId = () => crypto.randomUUID(), now = new Date().toISOString()}) {
  if (!canBot(bot, BROWSER_PERMISSION)) {
    return {record: null, line: {id: makeId(), role: 'system', kind: 'feed-permission', senderId: bot.id, runId, text: `${bot.name} would open your X home feed, but it does not hold the ${BROWSER_PERMISSION} permission. Grant it in the bot profile. Nothing else ran.`, at: now}};
  }
  const record = {id: makeId(), botId: bot.id, botName: bot.name, groupId, chatKey, runId, purpose: 'feed', ...homeFeedRequest(), depth: 0, status: 'pending', agentTaskIds: [], result: null, error: null, createdAt: now, updatedAt: now};
  state.browserRequests ??= [];
  state.browserRequests.unshift(record);
  pruneBrowserRequests(state);
  return {record, line: {id: browserMessageId(record.id), role: 'system', kind: 'browser', runId, text: `${bot.name} wants to scroll and read your X home feed. It does not click or type. You still post.`, at: now}};
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
