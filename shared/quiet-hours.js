/** Quiet hours for phone notices: a window of the day (e.g. 22:00-07:00) when non-urgent push messages wait.
 * Pure and browser-safe. The push sender reads `QUIET_HOURS` and the optional `QUIET_HOURS_TZ` from the environment
 * (src/push.js). */

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

/** Minutes from midnight of `now` in `zone` (an IANA name), or on this machine's clock when there is no usable zone. */
function minuteOfDay(now, zone) {
  if (zone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {timeZone: zone, hour: 'numeric', minute: 'numeric', hourCycle: 'h23'}).formatToParts(now);
      const part = type => Number(parts.find(p => p.type === type)?.value);
      const hour = part('hour'), minute = part('minute');
      if (Number.isFinite(hour) && Number.isFinite(minute)) return hour * 60 + minute;
    } catch { /* unknown zone */ }
  }
  return now.getHours() * 60 + now.getMinutes();
}

/** Is `now` (a Date) inside the window, on the clock of `zone` (`QUIET_HOURS_TZ`) or this machine's? A window that
 * starts at night and ends in the morning wraps past midnight. */
export function inQuietHours(window, now = new Date(), zone = '') {
  if (!window) return false;
  const minute = minuteOfDay(now, zone);
  return window.from < window.to
    ? minute >= window.from && minute < window.to
    : minute >= window.from || minute < window.to;
}
