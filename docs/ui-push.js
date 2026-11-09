/** Push notifications on this device: what the browser allows, whether this
 * device is subscribed, and turning it on or off. The server keeps one
 * subscription per device and only ever sends to the signed-in account's own. */
import {api} from './ui-store.js?v=06d1ba940d';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const keyBytes = text => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(padded + '='.repeat((4 - padded.length % 4) % 4)), c => c.charCodeAt(0));
};
const keyView = value => !value ? null : (ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : new Uint8Array(value));
const sameKey = (subscription, key) => {
  const currentKey = keyView(subscription?.options?.applicationServerKey), next = keyView(key);
  return !!currentKey && !!next && currentKey.length === next.length && currentKey.every((byte, i) => byte === next[i]);
};
/** The live subscription of this browser, or null when it has none. A browser
 * that will not answer (no registration, pushManager blocked) is reported as
 * unsubscribed rather than throwing the whole status call: a device that is off
 * must read as off. */
const current = async () => {
  // Both calls are awaited: getSubscription() is async too, and awaiting only
  // the first left its rejection outside this try.
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    return await registration?.pushManager.getSubscription() ?? null;
  } catch { return null; }
};

/** @returns {{state: 'unsupported'|'insecure'|'blocked'|'off'|'on', devices: number, endpoints: string[], mine: string}} */
export async function pushStatus() {
  if (!window.isSecureContext) return {state: 'insecure', devices: 0, endpoints: [], mine: ''};
  if (!supported()) return {state: 'unsupported', devices: 0, endpoints: [], mine: ''};
  const [server, local] = await Promise.all([api('/api/push'), current()]);
  // A reply without the endpoint list means "no devices", not a crash that
  // blanks the Notifications page it was loading for.
  const endpoints = Array.isArray(server?.endpoints) ? server.endpoints : [];
  const devices = endpoints.length;
  // `endpoints` is the server's list, one push URL per device this account has
  // registered. The page shows them so a phone that was lost, or a browser
  // somebody stopped using, can be dropped without turning push off here first:
  // the only way to remove a stale device used to be to sign in on it.
  const mine = local && endpoints.includes(local.endpoint) ? local.endpoint : '';
  if (Notification.permission === 'denied') return {state: 'blocked', devices, endpoints, mine};
  return {state: mine ? 'on' : 'off', devices, endpoints, mine};
}

/** Ask for permission, subscribe this browser and register it with the server. */
export async function enablePush() {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in the browser settings, then try again.');
  const {publicKey} = await api('/api/push');
  // app.js already registers the worker at boot; registering an existing scope
  // returns that same registration instead of adding a second one. `ready`
  // still has to be awaited, because registration does not imply activation.
  const registration = await navigator.serviceWorker.register('./sw.js');
  await navigator.serviceWorker.ready;
  const key = keyBytes(publicKey);
  // A subscription made for an older server key cannot be reused. One made for
  // this key must be kept: unsubscribing before the server has stored the
  // replacement drops the device if that request fails.
  let subscription = await registration.pushManager.getSubscription();
  if (subscription && !sameKey(subscription, key)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) subscription = await registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: key});
  await api('/api/push/subscriptions', 'POST', subscription.toJSON());
}

export async function disablePush() {
  const subscription = await current();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  // Local first. If this throws, the server still holds the live device and the
  // two sides agree; deleting on the server first and then failing to
  // unsubscribe left a subscription nobody would ever deliver to or forget.
  // The reverse failure (local gone, server still listed) heals itself: the
  // next delivery gets a 410 and src/push.js drops the endpoint.
  await subscription.unsubscribe();
  await api('/api/push/subscriptions', 'DELETE', {endpoint});
}
