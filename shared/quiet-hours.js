/** Quiet hours for phone notices: a window of the day (e.g. 22:00-07:00) when non-urgent push messages wait.
 * Pure and browser-safe. The push sender reads `QUIET_HOURS` from the environment (src/push.js). */

const TIME = /^(\d{1,2}):(\d{2})$/;
const minutesOf = text => {
  const m = TIME.exec(String(text ?? '').trim());
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

/** "22:00-07:00" as {from, to} in minutes from midnight, or null when unset or not a valid window. */
export function parseQuietHours(text) {
  const [a, b, extra] = String(text ?? '').split('-');
  if (extra !== undefined || b === undefined) return null;
  const from = minutesOf(a), to = minutesOf(b);
  if (from === null || to === null || from === to) return null;
  return {from, to};
}

/** Is `now` (a Date) inside the window? A window that starts at night and ends in the morning wraps past midnight. */
export function inQuietHours(window, now = new Date()) {
  if (!window) return false;
  const minute = now.getHours() * 60 + now.getMinutes();
  return window.from < window.to
    ? minute >= window.from && minute < window.to
    : minute >= window.from || minute < window.to;
}
