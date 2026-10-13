/** Push notifications on this device: what the browser allows, whether this
 * device is subscribed, and turning it on or off. The server keeps one
 * subscription per device and only ever sends to the signed-in account's own. */
import {api} from './ui-store.js?v=bf1c2663b4';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const keyBytes = text => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const current = async () => (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription() ?? null;

/** @returns {{state: 'unsupported'|'insecure'|'blocked'|'off'|'on', devices: number}} */
export async function pushStatus() {
  if (!window.isSecureContext) return {state: 'insecure', devices: 0};
  if (!supported()) return {state: 'unsupported', devices: 0};
  const [server, mine] = await Promise.all([api('/api/push'), current()]);
  const devices = server.endpoints.length;
  if (Notification.permission === 'denied') return {state: 'blocked', devices};
  return {state: mine && server.endpoints.includes(mine.endpoint) ? 'on' : 'off', devices};
}

/** Ask for permission, subscribe this browser and register it with the server. */
export async function enablePush() {
  if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked for this site. Allow them in the browser settings, then try again.');
  const {publicKey} = await api('/api/push');
  const registration = await navigator.serviceWorker.register('./sw.js');
  await navigator.serviceWorker.ready;
  // A subscription made for an older server key cannot be reused.
  const old = await registration.pushManager.getSubscription();
  if (old) await old.unsubscribe();
  const subscription = await registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: keyBytes(publicKey)});
  await api('/api/push/subscriptions', 'POST', subscription.toJSON());
}

export async function disablePush() {
  const subscription = await current();
  if (!subscription) return;
  await api('/api/push/subscriptions', 'DELETE', {endpoint: subscription.endpoint});
  await subscription.unsubscribe();
}
