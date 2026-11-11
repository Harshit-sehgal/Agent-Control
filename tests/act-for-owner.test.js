// "Book a table", "apply to this job": the bot does the steps in the browser
// itself, and the app asks the owner before the final send, booking or payment.
// It never answers "I can't make reservations".
import test from 'node:test';
import assert from 'node:assert/strict';
import {BROWSER_TOOL_HINT} from '../shared/bot-browser.js';

test('the browser hint tells a bot to book, apply or fill forms itself, up to the owner\'s approval', () => {
  assert.match(BROWSER_TOOL_HINT, /book, apply, order or fill/);
  assert.match(BROWSER_TOOL_HINT, /asks the owner before anything is sent, booked or paid/);
  assert.match(BROWSER_TOOL_HINT, /never say you cannot/i);
});

test('booking, applying and signing up are asked about before the click', async () => {
  const {riskOf} = await import('../shared/bot-browser.js');
  for (const label of ['Book now', 'Reserve a table', 'Apply now', 'Easy Apply', 'Register', 'Sign up', 'RSVP', 'Request booking', 'Make reservation'])
    assert.deepEqual(riskOf(label), ['send'], label);
  for (const label of ['Apply filters', 'Booking.com', 'Read more', 'Search', 'Next page'])
    assert.deepEqual(riskOf(label), [], label);
});
