/** What a device can do that the server relies on: named, optional features.
 *
 * A device reports its list on every heartbeat (`features: ["secret-input-v1"]`); the server keeps it with the
 * device's row and hides or refuses what a device lacks, instead of sending it and hoping. The device app and the
 * server both read the names from here, so they cannot drift. A name is never renamed: a changed feature gets a
 * `-v2` beside it. A feature is added in the same release as the server code that uses it.
 *
 * Phase 0 ships only `secret-input-v1` and the one check that goes with it (the server queues a masked `secret`
 * event only for a device that reports it). The general "needs" and "missing-feature" answers are later.
 *
 * Browser-safe: no imports, no globals. */

/** Masked `secret` input: the device holds a typed password or code in memory only and scrubs it from every result. */
export const SECRET_INPUT_V1 = 'secret-input-v1';

/** What this build of the device app can do, and so what it reports. */
export const DEVICE_FEATURES = [SECRET_INPUT_V1];

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
