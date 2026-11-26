/** What a device can do that the server relies on: named, optional features.
 *
 * A device reports its list on every heartbeat (`features: ["secret-input-v1"]`); the server keeps it with the
 * device's row and hides or refuses what a device lacks, instead of sending it and hoping. The device app and the
 * server both read the names from here, so they cannot drift. A name is never renamed: a changed feature gets a
 * `-v2` beside it. A feature is added in the same release as the server code that uses it.
 *
 * `FEATURES` is the one list. A feature is `needed` (work that uses it is refused without it) or `preferred` (the
 * older path still answers for FEATURE_GRACE_DAYS after `since`, then it counts as needed). A name that is not on the
 * list counts as needed, so a mistake refuses instead of letting work through. `chooseDevice` (`src/agent.js`) takes the
 * names a task needs; a device reports its list when it pairs and on every heartbeat.
 *
 * Browser-safe: no imports, no globals. */

/** Masked `secret` input: the device holds a typed password or code in memory only and scrubs it from every result. */
export const SECRET_INPUT_V1 = 'secret-input-v1';

/** Every feature the server knows. `since` is the day (ISO) the server first relied on it; `use` is `needed` or
 * `preferred`; `what` finishes "Its app cannot ..." on the device's card. */
export const FEATURES = [
  {name: SECRET_INPUT_V1, since: '2026-11-26', use: 'needed', what: 'type passwords and codes'},
];

/** How long a preferred feature keeps the older path, from its `since` day. */
export const FEATURE_GRACE_DAYS = 60;

/** What this build of the device app can do, and so what it reports: every name on the list. */
export const DEVICE_FEATURES = FEATURES.map(f => f.name);

/** The words for a device that cannot hold a secret. */
export const UPDATE_DEVICE_LINE = 'Update the app on your computer to type passwords and codes here.';

const MAX_FEATURES = 16;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** A reported list, read as untrusted: an array of short lowercase names, no repeats, at most 16. Anything else is no list. */
export function cleanFeatures(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value.slice(0, 200)) {
    if (typeof item === 'string' && NAME.test(item) && !out.includes(item)) out.push(item);
    if (out.length >= MAX_FEATURES) break;
  }
  return out;
}

/** Whether a list of features names `feature`. Anything that is not a list names nothing. */
export const hasFeature = (features, feature) => Array.isArray(features) && features.includes(feature);

/** Whether work that uses `name` now needs a device that has it: a `needed` one always, a `preferred` one once its
 * grace has run out, and a name that is not on `list` (or has no readable date) always. */
export function neededNow(name, {nowMs = Date.now(), list = FEATURES} = {}) {
  const f = Array.isArray(list) ? list.find(x => x?.name === name) : null;
  if (!f || f.use !== 'preferred') return true;
  const start = Date.parse(f.since);
  return !Number.isFinite(start) || nowMs >= start + FEATURE_GRACE_DAYS * 86400000;
}

/** Of the features a caller only prefers, the names that now count as needed. Not a list: none. */
export const requiredNow = (prefers, opts) => (Array.isArray(prefers) ? prefers.filter(name => neededNow(name, opts)) : []);

/** The entries of `list` that are needed now and that `features` does not name, as `{name, what}`. Anything that is
 * not a list names nothing, so it lacks all of them. */
export const updateNeeded = (features, {list: given = FEATURES, ...rest} = {}) => {
  const list = Array.isArray(given) ? given : FEATURES;   // a list that is not one falls back to the shipped list: it never throws, never says "nothing needed"
  return list.filter(f => neededNow(f.name, {...rest, list}) && !hasFeature(features, f.name)).map(f => ({name: f.name, what: f.what}));
};
