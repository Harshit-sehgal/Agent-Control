import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePageText, signinPage} from '../shared/bot-browser.js';

const password = {index: 1, tag: 'input', type: 'password', text: 'password field'};

test('a page with a visible password field is a sign-in page, wherever it lives', () => {
  assert.equal(signinPage({finalUrl: 'https://crm.example.com/home', elements: [password]}), 'crm.example.com');
  assert.equal(signinPage({finalUrl: 'https://accounts.google.com/v3/signin/identifier?continue=https://mail.google.com/'}), 'mail.google.com');
  assert.equal(signinPage({finalUrl: 'https://crm.example.com/home', elements: [{tag: 'input', type: 'text'}]}), null);
  assert.match(capturePageText({finalUrl: 'https://crm.example.com/home', text: 'Welcome', elements: [password]}), /^This is a sign-in page: the owner is not signed in to crm\.example\.com/);
});

test('signinPage falls back to url, lowercases the host and ignores junk', () => {
  assert.equal(signinPage({url: 'https://CRM.Example.com/home', elements: [password]}), 'crm.example.com');
  assert.equal(signinPage({finalUrl: 'https://www.linkedin.com/login', elements: [password]}), 'www.linkedin.com');
  assert.equal(signinPage({finalUrl: 'not a url', elements: [password]}), null);
  assert.equal(signinPage({finalUrl: 'https://crm.example.com/home', elements: [{tag: 'button', type: 'password'}]}), null);
  assert.equal(signinPage({finalUrl: 'https://crm.example.com/home', elements: 'nope'}), null);
  assert.equal(signinPage(null), null);
});
