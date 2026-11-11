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

/** `html` from `url` as {title, text, links}. The main article when the page marks one, else the body. */
export function readableHtml(html, url) {
  const source = String(html || '');
  const title = words(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] || '') || null;
  const clean = source.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
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
