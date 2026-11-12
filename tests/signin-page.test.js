// A bot that opens the owner's Gmail or Reddit while the owner is signed out lands on a sign-in page. It is told
// so, and which site's Sign in card to send, instead of reporting the sign-in page as the answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import {capturePageText, signinSite} from '../shared/bot-browser.js';

test('sign-in pages name the site the owner should sign in to', () => {
  assert.equal(signinSite('https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com%2Fmail%2Fu%2F0%2F&service=mail'), 'mail.google.com');
  assert.equal(signinSite('https://old.reddit.com/login/?reason=lor2&dest=https%3A%2F%2Fold.reddit.com%2Fr%2FdevelopersIndia'), 'old.reddit.com');
  assert.equal(signinSite('https://www.linkedin.com/login'), 'www.linkedin.com');
  assert.equal(signinSite('https://login.live.com/login.srf?wa=wsignin1.0'), 'login.live.com');
  assert.equal(signinSite('https://example.com/blog/how-to-login-faster'), null);
  assert.equal(signinSite('https://mail.google.com/mail/u/0/#inbox'), null);
  assert.equal(signinSite('https://accounts.google.com/v3/signin/identifier?continue=javascript:alert(1)'), 'accounts.google.com');
});

test('a read that lands on a sign-in page tells the bot to offer the Sign in card, never to type a password', () => {
  const text = capturePageText({finalUrl: 'https://accounts.google.com/v3/signin/identifier?continue=https%3A%2F%2Fmail.google.com%2Fmail%2F', title: 'Gmail', text: 'Sign in Email or phone Next'});
  assert.match(text, /not signed in/i);
  assert.match(text, /"action":"signin","site":"mail\.google\.com"/);
  assert.match(text, /never type a password/i);
  assert.doesNotMatch(capturePageText({finalUrl: 'https://example.com/', text: 'hello'}), /signed in/);
});
