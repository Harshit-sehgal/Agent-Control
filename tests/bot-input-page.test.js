/** The model input keeps the page a bot asked for. A page cut to a sliver looked like nothing came back, so the bot
 * asked for the same page again and again until the run stopped. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {boundBotInput} from '../src/ai.js';
import {MAX_PAGE_CHARS} from '../shared/coordination.js';

const envelope = (extra = {}) => ({
  objective: 'Summarize the top 3 stories on Hacker News right now.', botId: 'atlas', runId: 'r1', step: 2, maxSteps: 8,
  botRole: 'Atlas runs the company.'.repeat(20), permissions: [],
  page: `Page: https://news.ycombinator.com/\nTitle: Hacker News\n${'1. A story (example.com) 300 points '.repeat(Math.floor((MAX_PAGE_CHARS - 200) / 36))}TAIL-MARK`,
  note: 'You asked again for a page you already have, so here it is again.',
  thread: Array.from({length: 12}, (_, i) => ({role: i % 2 ? 'bot' : 'user', text: `message ${i} `.repeat(80)})),
  memory: {chatSummary: 'summary '.repeat(200), rules: Array.from({length: 12}, (_, i) => `rule ${i}`)},
  restrictions: Array.from({length: 20}, (_, i) => `Restriction ${i}: ${'be careful '.repeat(10)}`),
  tools: {browser: 'Write a ```browser block with {"url": "..."}.'.repeat(10)},
  ...extra,
});

test('a full page (MAX_PAGE_CHARS) reaches the model whole, with the app\'s note, the rules and the tools', () => {
  const out = JSON.parse(boundBotInput(JSON.stringify(envelope())));
  assert.match(out.page, /TAIL-MARK$/);
  assert.equal(out.note, 'You asked again for a page you already have, so here it is again.');
  assert.equal(out.restrictions.length, 20);
  assert.ok(out.tools?.browser);
});

test('an input far over the limit still parses, keeps the start of the page and never overwrites the app\'s note', () => {
  const huge = envelope({message: 'x'.repeat(200000)});
  const text = boundBotInput(JSON.stringify(huge));
  const out = JSON.parse(text);
  assert.match(out.page, /^Page: https:\/\/news\.ycombinator\.com\//);
  assert.equal(out.note, 'You asked again for a page you already have, so here it is again.');
  assert.ok(out.truncated);
});
