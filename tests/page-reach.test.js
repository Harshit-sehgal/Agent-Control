/** A bot reads the page, not just its menu: the agent prefers the main article, and what the bot is handed is long
 * enough for a real article (a Wikipedia page's menu alone used to fill the old 3,600 characters). */
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {capturePageText} from '../shared/bot-browser.js';
import {createEnvelope, MAX_PAGE_CHARS} from '../shared/coordination.js';

const article = 'Large language models are trained to predict text. '.repeat(400);   // ~20k characters

test('a captured page keeps up to 12,000 characters for the bot', () => {
  const text = capturePageText({text: article});
  assert.ok(text.length >= 11000 && text.length <= 12100, String(text.length));
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
