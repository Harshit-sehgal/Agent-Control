/** Three safety presets for Settings → Permissions, and which one the workspace is on.
 *
 *   Careful    every bot asks before it opens a page or reads an app (askBasics on), Hands-off off, and every
 *              Always allow rule becomes Ask each time. A Deny stays a Deny.
 *   Balanced   the defaults: browsing and reading go without asking; sending, posting, deleting and paying ask
 *              unless a rule says Always allow for that bot and site. Rules are left as they are.
 *   Hands-off  Balanced plus the Hands-off switch (`state.handsOff`, read by verdict in asks.js): a send, a post
 *              or a connector write with no rule goes without asking, on every site. Payments and deletes still
 *              ask. It is one switch, never a grant per bot and site, so it can never be an every-site payment
 *              Always allow (asks.js refuses and sweeps those).
 *
 * `applyPreset` changes the state and returns the sentences the confirm sheet lists (run it on a copy to preview)
 * and the Undo snapshot `restorePermissions` in asks.js puts back. Pure and browser-safe: the server route and the
 * Pages demo apply it the same way. */
import {fail} from './errors.js?v=20a8b2d024';
import {setAskBasics, setHandsOff, setGrant, grantEnded, grantPrior} from './asks.js?v=20a8b2d024';
import {grantWhat} from './ui-asks.js?v=20a8b2d024';

export const PRESETS = [
  {id: 'careful', name: 'Careful', text: 'Every bot asks before it opens a page, reads an app, sends, posts or pays.', askBasics: true, handsOff: false},
  {id: 'balanced', name: 'Balanced', text: 'Bots browse and read on their own. Sending, posting, deleting and paying ask, unless you Always allow a bot on a site.', askBasics: false, handsOff: false},
  {id: 'handsOff', name: 'Hands-off', text: 'Bots also send, post and change connected apps on their own. Payments and deletes still ask.', askBasics: false, handsOff: true},
];

const iso = () => new Date().toISOString();
const botName = (state, id) => (state.groups || []).flatMap(g => g.bots || []).find(b => b.id === id)?.name || 'A bot';
const liveAlways = (state, now) => (state.grants || []).filter(g => g?.choice === 'always' && !grantEnded(g, now));

/** The preset the settings match, or 'custom'. */
export function presetOf(state, now = iso()) {
  const ask = Boolean(state?.askBasics), hands = state?.handsOff === true;
  if (ask && !hands && !liveAlways(state || {}, now).length) return 'careful';
  if (!ask && !hands) return 'balanced';
  if (!ask && hands) return 'handsOff';
  return 'custom';
}

const SAY = {
  askBasics: on => (on ? 'Every bot will ask before opening a web page or reading a connected app.' : 'Bots will open web pages and read connected apps without asking.'),
  handsOff: on => (on ? 'Every bot may send, post and change connected apps on any site without asking. Payments still ask every time, and so do deletes.'
    : 'Bots will ask again before sending, posting or changing a connected app, unless a rule says Always allow.'),
};

/** Apply one preset. Returns {preset, changes: [sentence], undo}. `changes` is empty when it is already on. */
export function applyPreset(state, id, now = iso()) {
  const preset = PRESETS.find(p => p.id === id);
  if (!preset) fail('Choose the Careful, Balanced or Hands-off preset.');
  const undo = {askBasics: Boolean(state.askBasics), handsOff: state.handsOff === true, grants: []}, changes = [];
  if (undo.askBasics !== preset.askBasics) { setAskBasics(state, preset.askBasics, now); changes.push(SAY.askBasics(preset.askBasics)); }
  if (undo.handsOff !== preset.handsOff) { setHandsOff(state, preset.handsOff, now); changes.push(SAY.handsOff(preset.handsOff)); }
  if (id === 'careful') {
    for (const g of liveAlways(state, now)) {
      undo.grants.push(grantPrior(state, g.botId, g.action, g.scope));
      setGrant(state, g.botId, g.action, g.scope, 'ask', now);
      changes.push(`${botName(state, g.botId)}: "${grantWhat(g.action, g.scope)}" goes from Always allow to Ask each time.`);
    }
  }
  return {preset: id, changes, undo};
}
