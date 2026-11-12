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
 * X and Twitter work like any other site: a bot may read, click and type there, and a click on Post asks
 * unless the owner set Always allow for posting on that site.
 */
import {cleanText, validHttpUrl} from './core.js?v=71b92f8de6';
import {fail} from './errors.js?v=71b92f8de6';
import {decide, createAsk, scopeOf, declinedNeed} from './asks.js?v=71b92f8de6';
import {controlFence} from './reply-blocks.js?v=71b92f8de6';
import {BACKSTOP, pagesCap, roundsCap} from './limits.js?v=71b92f8de6';
import {appForHost} from './app-catalog.js?v=71b92f8de6';

/** The most page text one model turn carries (the pages of a round together). */
export const MAX_PAGE_CHARS = 24000;

export const BROWSER_PERMISSION = 'browser.use';
/** The most blocks one reply is read for: the backstop. The owner's own limit (Settings → Limits) may be lower. */
export const MAX_REQUESTS_PER_REPLY = BACKSTOP.pages;
export const MAX_STEPS = 25;
/** The highest index a request may name; matches what a snapshot reports. */
export const MAX_ELEMENT_INDEX = 500;
export const MAX_BROWSER_REQUESTS = 200;
export const STEP_OPS = ['navigate', 'click', 'type', 'waitFor', 'read', 'scroll'];
const INTERACTIVE = ['click', 'type'];
// One fence grammar shared with every other control block (see bot-link.js):
// the last block in a reply may be unclosed, and the strip path removes it.
const BLOCK = () => controlFence('browser');

// `x.com.` and `x.com%2e` are x.com: the trailing dot is dropped, so a grant for a site holds for every spelling of it.
/** Sites that hold the owner's own mail and files once they are signed in: reading them is reading private data. */
export const PRIVATE_HOSTS = /^(?:mail|drive|docs|calendar|contacts|photos)\.google\.com$|^outlook\.(?:live|office|office365)\.com$|^(?:www\.)?dropbox\.com$|^mail\.yahoo\.com$|^(?:www\.)?icloud\.com$/;
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
 * addresses whatever this says. */
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


/** A page that is a "prove you are human" wall, not the page asked for. */
const CHECK_WORDS = /(just a moment|performing security verification|verify(ing)? you are (a )?human|verifying you're not a bot|complete the following challenge|unusual traffic from your computer|are you a robot|press (and|&) hold|sending automated queries|access temporarily suspended|checking your browser|attention required)/i;
export function botCheck(title, text) {
  const t = String(text || '');
  return CHECK_WORDS.test(String(title || '')) || (t.length < 3000 && CHECK_WORDS.test(t));
}

/** The search engines a bot may land on, and the same search on the others, in the order to try them. */
const SEARCHES = [
  {host: /(^|\.)bing\.com$/, url: q => `https://www.bing.com/search?q=${q}`, param: 'q'},
  {host: /(^|\.)search\.yahoo\.com$/, url: q => `https://search.yahoo.com/search?p=${q}`, param: 'p'},
  {host: /(^|\.)duckduckgo\.com$/, url: q => `https://html.duckduckgo.com/html/?q=${q}`, param: 'q'},
  {host: /(^|\.)google\.[a-z.]+$/, url: q => `https://www.google.com/search?q=${q}`, param: 'q'},
  {host: /(^|\.)search\.brave\.com$/, url: q => `https://search.brave.com/search?q=${q}`, param: 'q'},
  {host: /(^|\.)startpage\.com$/, url: q => `https://www.startpage.com/do/search?q=${q}`, param: 'q'},
];
/** A search engine's results page, as opposed to a page a result leads to. */
export function isSearchPage(url) {
  let parsed; try { parsed = new URL(url); } catch { return false; }
  const engine = SEARCHES.find(e => e.host.test(parsed.hostname));
  return Boolean(engine && parsed.searchParams.get(engine.param));
}

export function searchAlternates(url) {
  let parsed; try { parsed = new URL(url); } catch { return []; }
  const from = SEARCHES.find(e => e.host.test(parsed.hostname));
  const words = from && parsed.searchParams.get(from.param);
  if (!words) return [];
  const q = encodeURIComponent(words).replace(/%20/g, '+');
  return SEARCHES.slice(0, 2).filter(e => e !== from).map(e => e.url(q));
}

/** The passages of a long page that hold the words, each with some text around it. */
// Words a bot writes into `find` that say nothing about where the answer is.
const FILLER = new Set('a an and are at be by for from in is it of on or the this that to with what which who how posted find show me my please any all'.split(' '));

/** The parts of a long page that hold the words a bot asked for. A bot often writes a whole sentence; each
 * passage is ranked by how many of its words it holds, so near matches come back instead of nothing. Up to
 * `most` passages, in page order. */
export function findPassages(text, find, {around = 300, most = 8} = {}) {
  const page = String(text || ''), all = String(find || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 1);
  const words = [...new Set(all.filter(w => !FILLER.has(w)))];
  if (!page || !words.length) return '';
  const lower = page.toLowerCase(), found = [];
  for (const w of words) for (let at = lower.indexOf(w), n = 0; at >= 0 && n < 4000; at = lower.indexOf(w, at + w.length), n++) found.push(at);
  if (!found.length) return '';
  const scored = found.map(at => {
    const start = Math.max(0, at - around), end = Math.min(page.length, at + around), piece = lower.slice(start, end);
    return {start, end, score: words.filter(w => piece.includes(w)).length};
  }).sort((x, y) => y.score - x.score || x.start - y.start);
  // A passage must hold at least half the words (or the best any passage holds, when that is less).
  const floor = Math.min(scored[0].score, Math.ceil(words.length / 2));
  const spans = [];
  for (const span of scored) {
    if (spans.length >= most || span.score < floor) break;
    if (!spans.some(o => span.start < o.end && span.end > o.start)) spans.push(span);
  }
  return spans.sort((x, y) => x.start - y.start).map(({start, end}) => `…${page.slice(start, end).trim()}…`).join('\n\n');
}

/** Raw HTML markup that came back as text (a README table read from a raw file) as plain words, links kept as
 * their address, so a bot reads rows instead of tag soup. Text with few tags is returned as it is. */
export function plainMarkup(text) {
  const body = String(text || '');
  if ((body.match(/<\/?(td|tr|div|a|img|span|p|li|table|strong)\b/gi) || []).length < 20) return body;
  return body
    .replace(/<a\b[^>]*\bhref="([^"]+)"[^>]*>/gi, ' $1 ')
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, ' $1 ')
    .replace(/<\/(tr|p|li|div|h\d)>/gi, '\n')
    .replace(/<\/td>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/ *\n[ \n]*/g, '\n').trim();
}

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
        // A read with nothing named reads the whole page.
        out.selector = cleanText(step.selector, 300) || (step.op === 'read' ? 'body' : '');
        if (!out.selector) fail(`A ${step.op} step needs an index from the last result, or a CSS selector.`);
      }
    }
    if (step.op === 'type') out.text = cleanText(step.text, 2000);
    if (step.op === 'waitFor' && Number.isFinite(Number(step.timeoutMs))) out.timeoutMs = Math.min(15000, Math.max(0, Number(step.timeoutMs)));
    return out;
  });
  // No steps is a plain page read, which also works without the real browser.
  const find = cleanText(body.find, 200);
  return {kind: steps.length ? 'browser.action' : 'browser.capture', url, steps, ...(find ? {find} : {})};
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
export const BROWSER_TOOL_HINT = 'You can read or use a web page through a headless browser. Put one block per page in your reply, e.g. ```browser\n{"url":"https://example.com"}\n``` That returns the page text and a numbered list of controls. To act, name a control by its number in the same block: {"url":"https://example.com","steps":[{"op":"click","index":3}]} then read the result. Ops: navigate, click, type, waitFor, read, scroll. A CSS selector also works instead of an index. Scroll only moves the page. Any public site works, including X and YouTube. To find something you have no link for, search first: open https://www.bing.com/search?q=your+search+words and then open the results that fit. A long page is cut short; to reach a part further down, ask for it with "find": {"url":"https://example.com","find":"words on that part"} returns the passages that hold them. To book, apply, order or fill a form for the owner, do it yourself with steps, all the way to the last button: the app asks the owner before anything is sent, posted, booked or paid unless they set it to Always allow, so never say you cannot do it. Ask the owner only for details you cannot find, such as their phone number. If a site shows a human check, do not try to solve it: read another site, or when the owner needs that very site, send the setup block {"action":"signin","site":"that site"} so they can pass it in the shared browser. Do not ask the owner for a link you can find this way, and do not answer from memory when the question is about now. You may put several blocks in one reply to read pages side by side, and ask for more pages after you read those. The result comes back in the chat.';

/** The numbered controls a snapshot returned, in one line. The model acts on
 * these; a page of raw HTML is not something it can click. */
// Buttons, fields and links named for an action come first, so a "Book Now" late on a page of links is still shown.
const ACTION_WORDS = /\b(book|reserve|reservation|table|apply|buy|order|add to (?:cart|bag)|checkout|sign ?(?:in|up)|log ?in|register|submit|send|search|continue|next|select|choose|confirm|enquire|contact|schedule|slot)\b/i;
const controlLine = elements => {
  const all = (Array.isArray(elements) ? elements : []).filter(e => e && Number.isInteger(e.index) && e.text);
  const first = all.filter(e => e.tag !== 'a' || ACTION_WORDS.test(e.text)).slice(0, 30);
  const shown = new Set(first);
  const rest = all.filter(e => !shown.has(e)).slice(0, Math.max(0, 40 - first.length));
  // A control's words are the page's: no "·", bracket or line break in them, so they cannot plant an entry
  // ("Offer · [7] button Search") that controlLabels would read. A form submit says so, which makes it a Send.
  const words = e => `${String(e.text).replace(/[·[\]\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()}${e.submit ? ' (form submit)' : ''}`;
  return [...first, ...rest].sort((a, b) => a.index - b.index)
    .map(e => `[${e.index}] ${String(e.tag || 'element').replace(/\s+/g, '') || 'element'} ${words(e)}`.trim())
    .join(' · ');
};
/** The prefix of the one line that names a page's controls. */
const CONTROLS = 'Controls: ';

const wordsOf = text => new Set(String(text || '').toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) || []);
/** A control that is not a link (a restaurant card, a "Book a table" button) is reached only by a click, and
 * small models rarely write one unprompted. So the page read shows the exact block: for the control whose words
 * best match what the bot looked for (`match`), else for the first control that is not a link (`example`). */
function clickHint(r, find = '') {
  const at = String(r.finalUrl || r.url || '');
  if (!/^https?:\/\//.test(at)) return {};
  const linkTexts = new Set((Array.isArray(r.links) ? r.links : []).map(l => cleanText(l?.text, 100)));
  const controls = (Array.isArray(r.elements) ? r.elements : []).filter(e => e && Number.isInteger(e.index) && String(e.text || '').trim().length >= 4);
  const block = e => JSON.stringify({url: at.slice(0, 300), steps: [{op: 'click', index: e.index}]});
  const wanted = wordsOf(find);
  const score = e => [...wordsOf(e.text)].filter(w => wanted.has(w)).length;
  const best = wanted.size ? controls.map(e => [score(e), e]).filter(([n]) => n >= 2).sort((a, b) => b[0] - a[0])[0]?.[1] : null;
  const plain = controls.find(e => !linkTexts.has(cleanText(e.text, 100)));
  const target = best || plain;
  return {
    match: best ? `Control ${best.index} (${cleanText(best.text, 80)}) matches it; to open it, send ${block(best)}` : '',
    example: target ? `To click a control, ask for this page again with steps, e.g. for control ${target.index}: ${block(target)}` : '',
  };
}

/** Page text the next bot turn can draft from. The chat line uses a shorter cap. */
/** The site to sign in to when `url` is a sign-in page (Google's accounts page for Gmail, a /login path), else null.
 * A sign-in page that names where it returns to (`continue`, `dest`, `next`, `redirect`) gives that site. */
const SIGNIN_HOSTS = /^(?:accounts\.google\.com|login\.live\.com|login\.microsoftonline\.com|login\.yahoo\.com|appleid\.apple\.com|idmsa\.apple\.com)$/;
const SIGNIN_PATH = /^\/(?:[\w-]+\/)*(?:login|log-in|signin|sign-in|sign_in|servicelogin|identifier|uas\/login|ap\/signin)(?:\.\w+)?\/?$/i;
export function signinSite(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (!SIGNIN_HOSTS.test(u.hostname) && !SIGNIN_PATH.test(u.pathname)) return null;
  for (const key of ['continue', 'dest', 'next', 'redirect', 'redirect_uri', 'returnTo', 'return_to']) {
    const back = u.searchParams.get(key);
    if (!back) continue;
    try { const b = new URL(back, u); if (/^https?:$/.test(b.protocol) && b.hostname.includes('.')) return b.hostname.toLowerCase(); } catch { /* not an address */ }
  }
  return u.hostname.toLowerCase();
}

export function capturePageText(result, limit = MAX_PAGE_CHARS, find = '') {
  const r = result && typeof result === 'object' ? result : {};
  const reads = Array.isArray(r.actions) ? r.actions.filter(a => a && typeof a.text === 'string').map(a => a.text) : [];
  const controls = controlLine(r.elements);
  let body = plainMarkup(reads.join('\n') || r.text || r.excerpt || '');
  // `find`: the bot asked for the parts of a long page that hold some words, so it can reach past the first screenful.
  const click = clickHint(r, find);
  if (find) {
    const found = findPassages(body, find);
    body = found ? `${click.match ? `${click.match}\n` : ''}${found}` : `"${find}" is not on this page.${click.match ? ` ${click.match}` : ''} The page starts: ${String(body).slice(0, 1500)}`;
  }
  const signin = signinSite(r.finalUrl);
  if (signin) body = `This is a sign-in page: the owner is not signed in to ${signin} in this browser. Never type a password or a code. Send the setup block {"action":"signin","site":"${signin}"} so the owner signs in once, then ask for the page again.\n\n${body}`;
  if (r.botCheck) body = `This site showed a human check to the browser. Do not try to solve it: read another site or search for the page elsewhere.\n\n${body}`;
  // The page's own text cannot pose as the Controls line, which names what each control is (controlLabels).
  body = String(body).replace(/^(\s*)Controls:/gim, '$1Controls -');
  // Where the page's links go, so a bot can open a search result (page text alone drops the addresses).
  const links = (Array.isArray(r.links) ? r.links : []).filter(l => l && String(l.text || '').trim().length >= 4 && /^https?:\/\//.test(String(l.url || '')))
    .slice(0, 30).map(l => `${cleanText(String(l.text).replace(/\s+/g, ' '), 100)} → ${String(l.url).replace(/\s+/g, '').slice(0, 300)}`).join('\n');
  // The links go before the page text is cut, so a long page still shows them.
  const tail = [links ? `Links:\n${links}` : '', controls ? `${CONTROLS}${controls}` : '', click.example].filter(Boolean).join('\n\n');
  return cleanText([tail ? String(body).slice(0, Math.max(1000, limit - tail.length - 4)) : body, tail].filter(Boolean).join('\n\n'), limit);
}

/** A short chat line summarising an agent's result. */
export function browserResultText(request, result) {
  const r = result && typeof result === 'object' ? result : {};
  const body = capturePageText(result, 1500);
  const head = `${r.title ? `${cleanText(r.title, 160)} · ` : ''}${cleanText(r.finalUrl || request.url, 300)}`;
  return `Browser result for ${request.botName}: ${head}${body ? `\n\n${body}` : '\n\nThe page returned no text.'}`;
}

/** The most browse-then-continue rounds one message may chain: the backstop. The owner's own limit may be lower. */
export const MAX_BROWSER_DEPTH = BACKSTOP.rounds;
/** The words that make a click or a typed field something the owner is asked about, riskiest first.
 * The app classifies, never the bot: a step names a control by index or selector, and the label comes
 * from the page result the bot was last shown. A control the bot was not shown a label for is at least
 * a Send. The browser reads the control again when it acts (agent/browser.mjs) with the same words. */
export const RISKS = [
  ['spend', /\b(pay|payment|pay now|buy|purchase|checkout|check out|place (?:your |the )?order|order now|complete (?:the |your )?(?:booking|purchase|order)|subscribe|donate|card number|cvc|cvv|upgrade|renew|rent now|place (?:a |your )?bid|bid|transfer|withdraw)\b/i],
  ['delete', /\b(delete|remove|erase|destroy|move to (?:the )?trash|trash|archive|unsubscribe|cancel (?:my |your |the )?(?:subscription|order))\b/i],
  ['post', /\b(post|publish|tweet|reply|repost|retweet|quote|comment|share)\b/i],
  // Booking, applying and signing up commit the owner as much as a send does.
  ['send', /\b(send|submit|confirm|reserve|reservation|rsvp|register|sign ?up|apply(?! filters?\b)|book|booking(?!\.com)|request booking)\b/i],
];
/** A checkout, payment or billing page: opening one is a payment, and the device refuses a click on one unless a payment was approved. */
export const CHECKOUT_PATH = /\/(checkout|payment|billing)(\/|$)/i;

/** The risk classes a control's label names, riskiest first: ['spend'], ['send'], [] ... */
/** A CSS selector as words: "[data-testid=\"tweetButtonInline\"]" → "data testid tweet Button Inline". */
const selectorWords = selector => String(selector ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-\d"'=[\]#.:>()]+/g, ' ');
/** The risk classes that mean a click submits something the owner is committed by. */
const SUBMITS = ['send', 'post', 'spend'];
export const riskOf = label => { const text = foldLabel(label); return RISKS.filter(([, pattern]) => pattern.test(text)).map(([action]) => action); };

/** A label as the risk words read it: NFKC (full-width and compatibility forms), no zero-width or bidi marks, and
 * the Cyrillic and Greek letters that look like Latin ones folded to them, so "\u0405end" reads "Send". Self-contained
 * (no outside names), because agent/browser.mjs runs this very function in the page at the click. */
export function foldLabel(text) {
  const look = {'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X', 'Ѕ': 'S', 'І': 'I', 'Ј': 'J', 'Ү': 'Y', 'Ԁ': 'd', 'Ԛ': 'Q', 'Ԝ': 'W',
    'а': 'a', 'в': 'b', 'е': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p', 'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'ѕ': 's', 'і': 'i', 'ј': 'j', 'ԁ': 'd', 'һ': 'h', 'ӏ': 'l', 'ԛ': 'q', 'ԝ': 'w', 'ү': 'y', 'ɡ': 'g',
    'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H', 'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P', 'Τ': 'T', 'Υ': 'Y', 'Χ': 'X',
    'α': 'a', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x', 'ϲ': 'c', 'ϳ': 'j'};
  return String(text ?? '').normalize('NFKC').replace(/[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0]/g, '')
    .replace(/[\u0370-\u03FF\u0400-\u052F\u0250-\u02AF]/g, c => look[c] || c);
}

/** The risk classes an address names, as a GET that performs an action would ("/unsubscribe", "/cart/add",
 * "?action=delete"): the path's words, the query's names and the values of action-like keys. The words are the
 * verbs such links use, narrower than a button's (a blog's "/post/12" or "/archive" is a read). A search's own
 * words are free text, not an action, so they are not read. */
export const ACTION_KEYS = /^(?:action|do|cmd|command|op|operation|method|task|mode)$/i;
export const PATH_RISKS = [
  ['spend', /\b(pay|pay now|buy|buy now|purchase|checkout)\b/i],
  ['delete', /\b(delete|remove|destroy|erase|trash|unsubscribe|cancel)\b/i],
  ['send', /\b(send|submit|confirm|rsvp|subscribe|add to (?:cart|bag|basket)|(?:cart|bag|basket) add|add (?:cart|bag|basket))\b/i],
];
export function pathRisks(url) {
  let u; try { u = new URL(url); } catch { return []; }
  let path = u.pathname; try { path = decodeURIComponent(path); } catch { /* keep it encoded */ }
  const words = foldLabel([path, ...[...u.searchParams].flatMap(([key, value]) => (ACTION_KEYS.test(key) ? [key, value] : [key]))].join(' ')).replace(/[/_\-.+=&?]+/g, ' ');
  return PATH_RISKS.filter(([, pattern]) => pattern.test(words)).map(([action]) => action);
}

/** `{index → label}` for the controls of the page this bot last read in this chat ("[3] button Send"). */
export function controlLabels(state, botId, chatKey, url) {
  // The page the indices belong to: the latest one this bot read in this chat on the request's own origin.
  const origin = originOf(url);
  const last = origin ? (state?.browserRequests || []).find(r => r.botId === botId && r.chatKey === chatKey && r.status === 'done' && r.result?.page
    && originOf(r.result.finalUrl || r.url) === origin) : null;
  const labels = new Map();
  // Only the Controls line names controls, and it is the last one: capturePageText puts it after the page text
  // and the links, and neutralises any line in them that starts the same way. Each entry is "[N] tag words",
  // and a control's own words cannot hold "·" or brackets (controlLine), so an entry cannot plant another.
  const line = String(last?.result?.page || '').split('\n').filter(l => l.startsWith(CONTROLS)).at(-1) || '';
  for (const entry of line.slice(CONTROLS.length).split(' · ')) {
    const match = /^\[(\d+)\] (\S+) ([^·[\]]*)$/.exec(entry.trim());
    if (match) labels.set(Number(match[1]), match[3].trim());
  }
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
  const needs = [], seen = new Map();
  // One need per action and origin. A later click of the same kind names it instead: the last click is the one
  // that commits ("click Post" after "click the text box").
  const add = (action, target, detail, click = false) => {
    const key = approvedFor(action, target);
    if (seen.has(key)) { if (click) seen.get(key).detail = detail; return; }
    const need = {action, target, detail};
    seen.set(key, need);
    needs.push(need);
  };
  let here = request.url;
  for (const step of request.steps || []) {
    if (step.op === 'navigate') { here = step.url; continue; }
    if (!INTERACTIVE.includes(step.op)) continue;
    const label = step.index ? controls.get(step.index) || '' : '';
    const named = label || step.selector || `control ${step.index}`;
    // A selector's camelCase and underscores are words: [data-testid="tweetButtonInline"] reads "tweet Button Inline".
    const actions = riskOf(label || selectorWords(step.selector));
    // Not labelled on a page this bot was shown: the app cannot tell what it does, so it is at least a Send.
    if (!label && !actions.length) actions.push('send');
    for (const action of actions) add(action, here, `${step.op === 'type' ? 'type into' : 'click'} "${named.slice(0, 60)}" on ${hostOf(here) || here}`, step.op === 'click');
  }
  const pages = [request.url, ...(request.steps || []).filter(s => s.op === 'navigate').map(s => s.url)];
  for (const u of pages) {
    let checkout = false;
    try { checkout = CHECKOUT_PATH.test(new URL(u).pathname); } catch { /* Not a URL: validation refused it already. */ }
    if (checkout) add('spend', u, `open a checkout page on ${hostOf(u)}`);
  }
  // A navigate is a GET, and a GET can perform an action: "/unsubscribe?u=1" unsubscribes as a click would.
  for (const step of request.steps || []) {
    if (step.op !== 'navigate') continue;
    for (const action of pathRisks(step.url)) add(action, step.url, `open ${String(step.url).slice(0, 120)}`);
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

/** Exactly what a request will type and click, one step a line, for the ask card's Full message fold. */
export function stepsBody(request, controls = new Map()) {
  let here = request.url;
  const lines = [];
  for (const step of request.steps || []) {
    if (step.op === 'navigate') { here = step.url; lines.push(`open ${step.url}`); continue; }
    if (!INTERACTIVE.includes(step.op)) continue;
    const label = step.index ? controls.get(step.index) || '' : '';
    const named = label ? `"${label}"` : step.selector ? `"${step.selector}"` : `control ${step.index} (no label shown)`;
    lines.push(step.op === 'type' ? `type into ${named} on ${hostOf(here) || here}:\n${String(step.text ?? '')}` : `click ${named} on ${hostOf(here) || here}`);
  }
  return lines.map((line, i) => `${i + 1}. ${line}`).join('\n');
}

const describe = request => `${request.steps.length ? `use ${hostOf(request.url)} (${request.steps.length} step${request.steps.length === 1 ? '' : 's'})` : `read ${hostOf(request.url)}`}`;
export const browserMessageId = id => `browser-${id}`.slice(0, 64);
export const requestOfMessage = (state, messageId) => (state?.browserRequests || []).find(r => browserMessageId(r.id) === messageId) || null;

/** Turn the browser blocks of one bot reply into request records and the chat
 * lines that show them. Returns the reply text without the blocks, the new
 * records, and the lines to append. A bot without the permission, or a chain
 * past MAX_BROWSER_DEPTH, gets a line saying why nothing ran. */
/** The words of a search, as a set: lower case, any order, plurals folded. */
function searchWords(url) {
  let parsed; try { parsed = new URL(url); } catch { return null; }
  const engine = SEARCHES.find(e => e.host.test(parsed.hostname));
  const q = engine && parsed.searchParams.get(engine.param);
  if (!q) return null;
  const words = q.toLowerCase().split(/[^\p{L}\p{N}:.%₹$]+/u).filter(Boolean).map(w => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
  return [...new Set(words)].sort().join(' ');
}
/** Two searches, on any engines, for the same words: searching it again finds nothing new. */
export function sameSearch(a, b) {
  const left = searchWords(a);
  return Boolean(left) && left === searchWords(b);
}

/** Page titles that mean the site turned this browser away. */
/** A load the site itself turned away (an error status, a blocked request), as the browser reports it. */
const LOAD_REFUSED = /net::ERR_(?:HTTP_RESPONSE_CODE_FAILURE|BLOCKED_BY_\w+)/;
const REFUSED = /^(?:access denied|403\b|forbidden|request blocked|you have been blocked|you['’]ve been blocked|attention required|just a moment)/i;

const samePage = (a, b) => {
  if (sameSearch(a, b)) return true;
  try {
    const left = new URL(a), right = new URL(b);
    return left.host === right.host
      && left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '')
      && left.search === right.search && left.hash === right.hash;
  } catch { return false; }
};

/** The connector that does an app's work directly (its MCP server, or Google's API), when this host is that app's own
 * site and the connector is working. A sign-in through the browser is the browser, so it is not one. */
function connectedVia(state, host) {
  const app = appForHost(host);
  if (!app) return null;
  return (state.connectors || []).find(c => c?.status === 'ready' && (app.google ? c.kind === 'google' : c.kind === 'mcp' && c.app === app.id)) || null;
}

/** The owner's private sites this run has read in the browser: their mail and files, and an app the owner
 * connected by signing in to it in this browser. */
export function runPrivateHosts(state, runId) {
  if (!runId) return new Set();
  const signedIn = new Set((state.connectors || []).filter(c => c?.kind === 'site' && c.host).map(c => String(c.host).toLowerCase()));
  return new Set((state.browserRequests || []).filter(r => r.runId === runId && r.status === 'done')
    .map(r => hostOf(r.result?.finalUrl || r.url)).filter(host => PRIVATE_HOSTS.test(host) || signedIn.has(host)));
}

export function recordBrowserRequests(state, {bot, groupId, chatKey, output, depth = 0, skipUrls = [], runId = null, unattended = false, closed = false, declined = [], makeId = () => crypto.randomUUID(), now = new Date().toISOString()}) {
  depth = Math.max(0, Math.min(MAX_BROWSER_DEPTH, Number(depth) || 0));
  const rounds = roundsCap(state), perReply = pagesCap(state);
  const all = parseBrowserRequests(output), text = stripBrowserBlocks(output), lines = [], records = [], asks = [];
  if (!all.length) return {text: String(output ?? ''), records, lines, asks, limited: false, repeated: 0, again: [], refused: []};
  const found = all.slice(0, perReply);
  const say = line => lines.push({id: makeId(), role: 'system', text: line, at: now});
  // `limited`: the rounds ran out, so the caller gives the bot a closing turn instead of more pages.
  // `repeated`: pages it asked for again that it already has, which is no progress.
  const limited = depth >= rounds;
  let repeated = 0;
  const again = [], refused = [], invalid = [], resent = [];
  const refusals = host => (state.browserRequests || []).filter(r => (runId ? r.runId === runId : r.chatKey === chatKey)
    && hostOf(r.result?.finalUrl || r.url) === host && (REFUSED.test(String(r.result?.title || '').trim()) || REFUSED.test(String(r.result?.text || '').trim()) || r.result?.botCheck
      // The site answered with an error status or blocked the load: it refused, as a block page would. A timeout may pass.
      || (r.status === 'failed' && LOAD_REFUSED.test(String(r.error || ''))))).length;
  // A bot never answers "I don't have permission": a page it has no grant for is an ask, and the owner
  // says Allow, Always allow or Decline. A Deny the owner set is the one thing that refuses outright.
  if (limited) say(`${bot.name} asked for another web page, but ${rounds} browsing rounds in a row is the most ${rounds < BACKSTOP.rounds ? 'your limit in Settings allows' : 'one message may take'}.`);
  else if (closed) say(`${bot.name} asked for another web page, but you had just declined, so nothing was opened.`);
  else if (all.length > found.length) say(`${bot.name} asked for ${all.length} pages at once; ${perReply} ${perReply === 1 ? 'is' : 'are'} opened per reply.`);
  // A run that has read private data carries it: a connector result (now or earlier in the run), or the owner's
  // signed-in mail or files read in the browser. A new site then asks (asks.js verdict); the private site itself
  // does not, since reading more of the owner's own inbox carries nothing anywhere new.
  const run = runId ? (state.groupRuns || []).find(r => r.id === runId) : null;
  const privateHosts = runPrivateHosts(state, runId);
  const guarded = Boolean(run && (run.connectorPage || run.readPrivate || privateHosts.size));
  if (!limited && !closed) for (const item of found) {
    if (!item.ok) { say(`${bot.name} asked for a web page, but the request was refused: ${item.error}`); invalid.push(item.error); continue; }
    // A plain re-read of a page it has is no progress; finding words on it, or acting on it, is.
    if (!item.request.find && !item.request.steps.length && skipUrls.some(url => samePage(url, item.request.url))) {
      // The run read it already (perhaps for another bot): hand that page back instead of opening it again.
      const had = (state.browserRequests || []).find(r => r.status === 'done' && r.result?.page && !r.find && (runId ? r.runId === runId : r.chatKey === chatKey)
        && [r.url, r.result.finalUrl].some(u => u && samePage(u, item.request.url)));
      if (had) again.push(had.result.page); else repeated++;
      say(`${bot.name} already has that page, so it was not opened again.`);
      continue;
    }
    // A site that refused this browser twice in the run (Access Denied, a block page) will refuse it again.
    const host = hostOf(item.request.url);
    // A connected app is used through its own tools, as the owner: its site goes back to the bot once per task. Asked
    // again (its tools could not do this), the page opens. What no connector covers, like X, is the browser's.
    const via = connectedVia(state, host);
    if (via && run && !(run.connectorFirst || []).includes(host)) {
      run.connectorFirst = [...(run.connectorFirst || []), host];
      const why = `${via.name} is connected, so use its tools instead of the browser: a connector block with "use":"${via.id}" and one of its tools. Open this page only if none of its tools can do it.`;
      say(`${bot.name} reached for ${host.replace(/^www\./, '')} in the browser; ${via.name} is connected, so it uses its tools first.`);
      invalid.push(why);
      continue;
    }
    if (!item.request.steps.length && refusals(host) >= 2) {
      if (!refused.includes(host)) refused.push(host);
      repeated++;
      say(`${host} refused this browser twice, so it was not opened again.`);
      // The owner may get in where a bot cannot: once per task, a card opens the shared browser there for them to sign in.
      const live = runId && (state.groupRuns || []).find(r => r.id === runId);
      if (live && !(live.signinOffered || []).includes(host)) {
        live.signinOffered = [...(live.signinOffered || []), host];
        const card = {action: 'signin', botId: bot.id, url: `https://${host}/`, text: `Sign in to ${host.replace(/^www\./, '')} in the browser on this computer. ${host.replace(/^www\./, '')} turned the bots away; once you are signed in, they use the same browser and can read it.`};
        lines.push({id: makeId(), role: 'system', kind: 'setup', botId: bot.id, setup: JSON.stringify(card), text: `${bot.name} suggests: ${card.text}`, at: now});
      }
      continue;
    }
    const labels = controlLabels(state, bot.id, chatKey, item.request.url);
    // A click on a control named for sending, posting or paying submits something. Once one went through in
    // this run on a site, a second is never sent: a booking or an order made twice is worse than once.
    const submits = (item.request.steps || []).some(step => step.op === 'click' && riskOf((step.index && labels.get(step.index)) || selectorWords(step.selector)).some(a => SUBMITS.includes(a)));
    const sentBefore = submits && runId && (state.browserRequests || []).find(r => r.runId === runId && r.submits && r.status === 'done' && originOf(r.url) === originOf(item.request.url));
    if (sentBefore) {
      say(`${bot.name} asked to submit on ${hostOf(item.request.url)} again, but it was already submitted in this task, so it was not sent twice.`);
      resent.push(item.request.url);
      if (sentBefore.result?.page) again.push(sentBefore.result.page);
      continue;
    }
    const needs = browserNeeds(item.request, labels);
    // What the owner declined in this task stays declined; another site, or reading where a send was declined, goes on.
    const no = declinedNeed(declined, needs);
    if (no) { say(`${bot.name} asked to ${describe(item.request)}, but you declined that in this task, so it was not asked again.`); invalid.push(`the owner declined ${no.action === 'browser.use' ? 'opening' : no.action} ${hostOf(no.target)} in this task; do not ask for it again.`); continue; }
    // Per page: every site the request reaches that is not one of the run's private hosts asks, including one a
    // `navigate` step opens after a private first page.
    const decision = decide(state, bot, needs, {readPrivate: need => guarded && need.action === BROWSER_PERMISSION && !privateHosts.has(hostOf(need.target))});
    if (decision.verdict === 'deny') { say(`${bot.name} asked to ${describe(item.request)}. ${decision.message}`); continue; }
    // `approved`: the risky classes this request is cleared for once it is sent (a grant, or the owner's
    // answer to its ask), each for the origin it runs on ("send@https://b.example"). Written here after the
    // validated request, so a reply cannot set it; the browser refuses any other risky control it meets,
    // and one approved for another origin (agent/browser.mjs).
    const approved = needs.filter(n => n.action !== BROWSER_PERMISSION).map(n => approvedFor(n.action, n.target));
    const record = {id: makeId(), botId: bot.id, botName: bot.name, groupId, chatKey, ...(runId ? {runId} : {}), ...item.request, approved, ...(submits ? {submits: true} : {}), depth, status: 'pending', agentTaskIds: [], result: null, error: null, createdAt: now, updatedAt: now};
    records.push(record);
    if (decision.verdict === 'ask') {
      const {need} = decision;
      // One ask stands for every pair still needing the owner's say, and names each of them: Allow approves
      // exactly `approved`, and an ask across sites gets no Always allow (asks.js).
      const asked = createAsk(state, {botId: bot.id, runId, chatKey, action: need.action, target: need.target, detail: askedDetail(decision.asked), body: stepsBody(item.request, labels), unattended, requestId: record.id, implies: decision.implies, covers: decision.asked, now, makeId});
      record.askId = asked.id;
      asks.push(asked);
    } else lines.push({id: browserMessageId(record.id), role: 'system', kind: 'browser', text: `${bot.name} wants to ${describe(record)}.`, at: now});
  }
  state.browserRequests ??= [];
  state.browserRequests.unshift(...records);
  pruneBrowserRequests(state);
  return {text: text || `${bot.name} asked to open a web page.`, records, lines, asks, limited, repeated, again, refused, invalid, resent};
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
