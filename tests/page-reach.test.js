/** A bot reads the page, not just its menu: the agent prefers the main article, and what the bot is handed is long
 * enough for a real article (a Wikipedia page's menu alone used to fill the old 3,600 characters). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {capturePageText} from '../shared/bot-browser.js';
import {createEnvelope, MAX_PAGE_CHARS} from '../shared/coordination.js';

const article = 'Large language models are trained to predict text. '.repeat(400);   // ~20k characters

test('a captured page keeps a ~20k article whole for the bot, and never more than MAX_PAGE_CHARS', () => {
  const text = capturePageText({text: article});
  assert.ok(text.length >= article.length - 10, String(text.length));
  assert.ok(capturePageText({text: article.repeat(3)}).length <= MAX_PAGE_CHARS);
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

test('a page reaches the bot at the size the model input keeps (MAX_PAGE_CHARS), not cut at half', () => {
  const text = 'word '.repeat(10000);
  assert.ok(capturePageText({text}).length > 20000);
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
