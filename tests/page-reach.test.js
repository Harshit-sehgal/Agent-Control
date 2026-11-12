/** A bot reads the page, not just its menu: the agent prefers the main article. What the bot is handed at once is
 * a screenful (PAGE_EXCERPT_CHARS); a longer page comes in parts it can ask for, so nothing on it is out of reach. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {capturePageText, PAGE_EXCERPT_CHARS, validateBrowserRequest as validate, recordBrowserRequests as record} from '../shared/bot-browser.js';
import {createEnvelope, MAX_PAGE_CHARS} from '../shared/coordination.js';

const article = 'Large language models are trained to predict text. '.repeat(400);   // ~20k characters

test('a long page is handed over a part at a time, each part says how to get the next, and every part together is the whole page', () => {
  assert.ok(PAGE_EXCERPT_CHARS >= 8000 && PAGE_EXCERPT_CHARS <= 12000);
  const page = Array.from({length: 2500}, (_, i) => `w${i}`).join(' ');   // ~16k characters, every word unique
  const first = capturePageText({text: page}, undefined, '', 1);
  assert.ok(first.length <= PAGE_EXCERPT_CHARS, String(first.length));
  assert.match(first, /^\[Part 1 of 2 of this page\. For part 2, ask for this page again with "part":2/);
  assert.match(first, /^w0 w1 w2/m, 'the top of the page comes first');
  const second = capturePageText({text: page}, undefined, '', 2);
  assert.match(second, /Part 2 of 2: the end of this page/);
  const words = new Set([first, second].join(' ').split(/\s+/));
  assert.ok(Array.from({length: 2500}, (_, i) => `w${i}`).every(w => words.has(w)), 'no word of the page is unreachable');
  assert.match(capturePageText({text: page}, undefined, '', 9), /It has only 2 parts/);
  // A short page is whole, with no part line; a chat line (no part) is only cut.
  assert.doesNotMatch(capturePageText({text: 'Short page.'}, undefined, '', 1), /Part/);
  assert.doesNotMatch(capturePageText({text: page}, 1500), /Part/);
  assert.ok(capturePageText({text: article.repeat(3)}).length <= MAX_PAGE_CHARS);
});

test('a browser request may ask for the next part of a page it read, and that is not a repeat', () => {
  assert.equal(validate({url: 'https://example.com/a', part: 2}).part, 2);
  assert.equal(validate({url: 'https://example.com/a', part: 1}).part, undefined, 'part 1 is the plain read');
  assert.equal(validate({url: 'https://example.com/a', part: 99}).part, undefined);
  const state = {bots: [], groups: [], browserRequests: [], grants: [], asks: []};
  const out = record(state, {bot: {id: 'b', name: 'B', permissions: {browser: true}}, groupId: 'home', chatKey: 'b', output: '```browser\n{"url":"https://example.com/a","part":2}\n```', skipUrls: ['https://example.com/a']});
  assert.equal(out.repeated, 0);
  assert.equal(out.records[0].part, 2);
});

test('the envelope carries a long page whole, up to MAX_PAGE_CHARS', () => {
  assert.ok(MAX_PAGE_CHARS >= 24000);
  const run = {id: 'r', input: 'Read it', recipients: ['a'], trace: [], browserPage: article};
  const env = createEnvelope({run, bot: {id: 'a', name: 'A', instructions: 'x'}});
  assert.equal(env.page.length, article.length);
});

test('the agent reads the main article first, and keeps far more than 4,000 characters', async () => {
  const src = await readFile(new URL('../agent/browser.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('main, article, [role=main], #content'));
  assert.doesNotMatch(src, /text: text\.slice\(0, 4000\)/);
});

import {botCheck, searchAlternates, findPassages, validateBrowserRequest, recordBrowserRequests, BROWSER_TOOL_HINT} from '../shared/bot-browser.js';

test('a bot check is told apart from a page', () => {
  assert.equal(botCheck('Just a moment...', 'Performing security verification. This website uses a security service'), true);
  assert.equal(botCheck('DuckDuckGo', 'Unfortunately, bots use DuckDuckGo too. Please complete the following challenge'), true);
  assert.equal(botCheck('Google', 'Our systems have detected unusual traffic from your computer network.'), true);
  assert.equal(botCheck('Large language model - Wikipedia', article), false);
});

test('a search that hits a bot check has the same words on other engines', () => {
  const alts = searchAlternates('https://html.duckduckgo.com/html/?q=remote+intern+jobs');
  assert.ok(alts.length >= 1);
  assert.ok(alts.every(u => new URL(u).searchParams.toString().includes('remote+intern+jobs')), alts.join());
  assert.ok(!alts.some(u => u.includes('duckduckgo')));
  assert.deepEqual(searchAlternates('https://en.wikipedia.org/wiki/X'), []);
});

test('find returns the passages of a long page that hold the words', () => {
  const long = 'filler text '.repeat(5000) + ' Acme remote software intern, stipend 30k. ' + 'more filler '.repeat(5000);
  const out = findPassages(long, 'remote intern');
  assert.match(out, /Acme remote software intern, stipend 30k/);
  assert.ok(out.length < 4000);
  assert.equal(findPassages(long, 'zebra'), '');
});

test('find with a whole sentence returns the rows that hold most of its words, best first, not nothing', () => {
  const rows = [];
  for (let i = 0; i < 400; i++) rows.push(`| Company${i} | Data Analyst | New York, NY | Apply | ${i % 30}d |`);
  rows.splice(120, 0, '| Acme | Software Engineer Intern | Remote in USA | Apply | 0d |');
  rows.splice(300, 0, '| Globex | Software Engineering Intern | Remote | Apply | 2d |');
  const page = `# Summer 2027 Internships\n${'intro '.repeat(800)}\n${rows.join('\n')}`;
  const out = findPassages(page, 'Remote software engineer intern posted this week, with apply link');
  assert.match(out, /Acme \| Software Engineer Intern \| Remote in USA/);
  assert.match(out, /Globex \| Software Engineering Intern \| Remote/);
  assert.ok(out.length < 8000);
});

test('find on raw HTML markup (a README table) gives several readable rows with their links, not one tag soup', () => {
  const row = (co, role, where, age) => `<tr> <td><strong><a href="https://simplify.jobs/c/${co}">${co}</a></strong></td> <td>${role}</td> <td>${where}</td> <td><div align="center"><a href="https://jobs.example/${co}"><img src="https://i.imgur.com/x.png" width="50" alt="Apply"></a></div></td> <td>${age}</td> </tr>`;
  const rows = [];
  for (let i = 0; i < 300; i++) rows.push(row(`Co${i}`, 'Data Analyst', 'New York, NY', `${i % 30}d`));
  rows.splice(50, 0, row('Acme', 'Software Engineer Intern', 'Remote in USA', '0d'));
  rows.splice(200, 0, row('Globex', 'Software Engineering Intern', 'Remote', '1d'));
  const text = `<table><tbody>${rows.join(' ')}</tbody></table>`;
  const out = capturePageText({text}, 24000, 'Remote software engineer intern 0d apply link');
  assert.match(out, /Acme/);
  assert.match(out, /Globex/);
  assert.match(out, /https:\/\/jobs\.example\/Acme/);
  assert.doesNotMatch(out, /<td>|<img/);
});

test('a page reaches the bot as one full excerpt, not cut at half', () => {
  const text = 'word '.repeat(10000);
  assert.ok(capturePageText({text}).length > PAGE_EXCERPT_CHARS * 0.9);
});

test('a browser request may ask to find words on a page, and that is not a repeat', () => {
  assert.equal(validateBrowserRequest({url: 'https://example.com/a', find: 'intern'}).find, 'intern');
  const state = {bots: [], groups: [], browserRequests: [], grants: [], asks: []};
  const bot = {id: 'b', name: 'B', permissions: {browser: true}};
  const out = recordBrowserRequests(state, {bot, groupId: 'home', chatKey: 'b', output: '```browser\n{"url":"https://example.com/a","find":"intern"}\n```', skipUrls: ['https://example.com/a']});
  assert.equal(out.repeated, 0);
  assert.equal(out.records.length, 1);
});

test('the hint searches on an engine that answers a headless browser, and names find', () => {
  assert.match(BROWSER_TOOL_HINT, /bing\.com\/search\?q=/);
  assert.match(BROWSER_TOOL_HINT, /"find"/);
  assert.match(BROWSER_TOOL_HINT, /"part":2/);
});

import {isSearchPage} from '../shared/bot-browser.js';

test('a page hands the bot its links with their addresses, so it can open a search result', () => {
  const text = capturePageText({text: 'Results', links: [{text: 'Acme remote SWE intern', url: 'https://jobs.acme.example/123'}, {text: 'x', url: 'https://a.example'}]});
  assert.match(text, /Links:/);
  assert.match(text, /Acme remote SWE intern → https:\/\/jobs\.acme\.example\/123/);
});

test('a search page is told apart from the pages it leads to', () => {
  assert.equal(isSearchPage('https://www.bing.com/search?q=intern'), true);
  assert.equal(isSearchPage('https://jobs.acme.example/123'), false);
});

import {createEnvelope as envelopeOf} from '../shared/coordination.js';

test('every bot is told to answer as an outcome and to read enough, then answer', () => {
  const env = envelopeOf({run: {id: 'r', input: 'Find 5 internships', recipients: ['a'], trace: []}, bot: {id: 'a', name: 'A', instructions: 'x'}});
  const rules = env.restrictions.join('\n');
  assert.match(rules, /Lead with the result/);
  assert.match(rules, /do not narrate/i);
  assert.match(rules, /open the results/i);
});

test('a bot finishes what it can do now instead of offering it ("Want me to open the articles?")', () => {
  const env = envelopeOf({run: {id: 'r', input: 'Summarize the top 3 stories on Hacker News', recipients: ['a'], trace: []}, bot: {id: 'a', name: 'A', instructions: 'x'}});
  assert.match(env.restrictions.join('\n'), /do not offer to do what you can do now/i);
});
