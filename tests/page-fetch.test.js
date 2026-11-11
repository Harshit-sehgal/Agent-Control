// With no Chrome, Chromium or Edge installed, a page is still read: the agent's
// plain fetch turns the HTML into the same shape the browser returns (title,
// readable text, links), so a bot never needs a browser set up to read a page.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readableHtml} from '../agent/page-fetch.mjs';

const html = `<!doctype html><html><head><title>Acme &amp; Co careers</title><style>.x{color:red}</style><script>var secret=1</script></head>
<body><nav><a href="/">Home</a></nav><main><h1>Open roles</h1><p>Frontend intern, stipend &#8377;30,000 a month.</p>
<a href="/jobs/1">Apply for Frontend intern</a> <a href="https://other.example/x">Partner site link</a> <a href="javascript:void(0)">Nope here</a></main></body></html>`;

test('a fetched page becomes title, text and links, without scripts or styles', () => {
  const page = readableHtml(html, 'https://acme.example/careers');
  assert.equal(page.title, 'Acme & Co careers');
  assert.match(page.text, /Open roles Frontend intern, stipend ₹30,000 a month\./);
  assert.doesNotMatch(page.text, /secret|color:red/);
  assert.deepEqual(page.links, [{text: 'Apply for Frontend intern', url: 'https://acme.example/jobs/1'}, {text: 'Partner site link', url: 'https://other.example/x'}]);
});

test('the text is capped like the browser\'s', () => {
  const big = readableHtml(`<p>${'word '.repeat(30000)}</p>`, 'https://a.example/');
  assert.ok(big.text.length <= 60000);
});
