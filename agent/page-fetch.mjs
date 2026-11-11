/** Reading a page without a browser.
 *
 * When this computer has no Chrome, Chromium or Edge, a page is still read by a
 * plain fetch. The HTML is turned into the shape the browser returns (title,
 * readable text and links) so the bot sees the same thing either way; only
 * clicking and typing need a real browser.
 */
const MAX_TEXT = 60000;
const MAX_LINKS = 40;
const ENTITIES = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', rupee: '₹'};

const decode = text => String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code) => {
  if (code[0] === '#') {
    const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
    try { return String.fromCodePoint(n); } catch { return whole; }
  }
  return ENTITIES[code.toLowerCase()] ?? whole;
});
const words = html => decode(html.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** A JSON string's text: its \u escapes and \" read back, then any HTML entities. */
const jsonText = text => { try { return decode(JSON.parse(`"${text}"`)); } catch { return decode(text); } };
/** YouTube draws its results from data in a script, so the page's words are empty without a browser.
 * The videos are read from that data: title, channel, views and length, each with its watch link. */
function youtubeVideos(source) {
  const parts = source.split('"videoRenderer":{"videoId":"').slice(1);
  const field = (part, name, inner) => new RegExp(`"${name}":\\{${inner}"((?:[^"\\\\]|\\\\.)*)"`).exec(part)?.[1];
  return parts.slice(0, MAX_LINKS).map(part => {
    const id = /^[\w-]{6,20}/.exec(part)?.[0];
    const title = field(part, 'title', '"runs":\\[\\{"text":');
    if (!id || !title) return null;
    const bits = [field(part, 'longBylineText', '"runs":\\[\\{"text":'), field(part, 'viewCountText', '"simpleText":'), field(part, 'lengthText', '"simpleText":'), field(part, 'publishedTimeText', '"simpleText":')].filter(Boolean).map(jsonText);
    return {title: jsonText(title), url: `https://www.youtube.com/watch?v=${id}`, line: [jsonText(title), ...bits].join(' · ')};
  }).filter(Boolean);
}

/** `html` from `url` as {title, text, links}. The main article when the page marks one, else the body. */
export function readableHtml(html, url) {
  const source = String(html || '');
  const title = words(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] || '') || null;
  let host = ''; try { host = new URL(url).hostname; } catch {}
  if (/(^|\.)youtube\.com$/.test(host)) {
    const videos = youtubeVideos(source);
    if (videos.length) return {title: title || 'YouTube results', text: videos.map((v, i) => `${i + 1}. ${v.line}`).join('\n').slice(0, MAX_TEXT), links: videos.map(v => ({text: v.title.slice(0, 100), url: v.url}))};
  }
  // Menus, headers, footers and sidebars are not the page's words; leaving them out keeps the text budget for the article.
  const clean = source.replace(/<(script|style|noscript|svg|template|nav|header|footer|aside)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(div|ul)\b[^>]*\b(?:role="navigation"|class="[^"]*\b(?:vector-menu|interlanguage|navbox|mw-jump-link)\b[^"]*")[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(clean)?.[2];
  const body = /<body\b[^>]*>([\s\S]*?)(?:<\/body>|$)/i.exec(clean)?.[1] ?? clean;
  const chosen = main && words(main).length > 400 ? main : body;
  // Block ends become spaces so words from two paragraphs never run together.
  const text = words(chosen.replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>|<br\s*\/?>/gi, ' ')).slice(0, MAX_TEXT);
  const links = [], seen = new Set();
  // Links come from the main region whenever the page marks one, as the browser reads them.
  for (const m of (main ?? body).matchAll(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
    let href; try { href = new URL(decode(m[2]), url).href; } catch { continue; }
    const label = words(m[3]);
    if (!/^https?:/.test(href) || label.length < 4 || seen.has(href)) continue;
    seen.add(href);
    links.push({text: label.slice(0, 100), url: href.slice(0, 300)});
    if (links.length >= MAX_LINKS) break;
  }
  return {title, text, links};
}

/** How a plain read names itself. Sites that turn automated browsers away
 * (Wikimedia among them) ask automated clients to say what they are. */
export const PLAIN_AGENT = 'AgentControl/1.0 (personal assistant reading a page for its owner; local-first)';

/** A page that is the site turning this browser away, not the page asked for. */
const AWAY_TITLE = /^(?:wikimedia error|access denied|403\b|forbidden|too many requests|429\b|request blocked|you have been blocked)/i;
const AWAY_TEXT = /^(?:error\s+)?(?:429\s+)?too many requests\b/i;
export function turnedAway(page) {
  if (!page) return false;
  const title = String(page.title || '').trim(), text = String(page.text || '').trim();
  return AWAY_TITLE.test(title) || (!title && AWAY_TEXT.test(text)) || (/error$/i.test(title) && AWAY_TEXT.test(text));
}
