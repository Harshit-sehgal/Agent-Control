/** The rules behind pinning and reordering bots, with no DOM and no globals.
 *
 * The pinned row and the list are two lists the owner arranges: a bot is pinned
 * (it joins the row of faces at a slot), unpinned (it goes back to its place in
 * the company list), reordered among the bots on its own team, or dropped on a
 * manager to change its team. A manager moves with its reports, so rows are
 * handled as blocks: a row and the rows under it. ui-gestures.js reads the
 * rectangles from the page and calls these; they are tested in
 * tests/ui-reorder.test.js. */

/** Saved pins when they are a list, else the default. */
export const pinned = (saved, fallback = []) => (Array.isArray(saved) ? saved : fallback);

/** `pins` with `id` at `index` (a bot already pinned moves; a slot out of range is clamped). */
export function withPin(pins, id, index) {
  const rest = pins.filter(x => x !== id);
  rest.splice(Math.max(0, Math.min(index, rest.length)), 0, id);
  return rest;
}
export const withoutPin = (pins, id) => pins.filter(x => x !== id);

/** The slot among faces drawn in rows: how many of them the pointer is past. A face
 * on an earlier line is before the pointer; on the pointer's own line it is before
 * once the pointer is past its middle. Each box is {left, top, right, bottom}. */
export function pinSlot(boxes, {x, y}) {
  return boxes.filter(b => b.bottom < y || (b.top <= y && (b.left + b.right) / 2 < x)).length;
}
/** The slot among blocks stacked in a column: how many have their middle above `y`. */
export const slotAmong = (boxes, y) => boxes.filter(b => (b.top + b.bottom) / 2 < y).length;

/** The saved order is the order on screen; bots that are not on screen (hidden, filtered out) keep their place after. */
export function mergeOrder(order, visible) {
  const seen = new Set(), out = [];
  for (const id of [...visible, ...(Array.isArray(order) ? order : [])]) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

/** The rows that move together: `id` and the rows after it that report to it, or to a row in the block.
 * `rows` is [{id, team}] in list order, where a row's team is the id of the bot it reports to. */
export function unitOf(rows, id) {
  const at = rows.findIndex(r => r.id === id);
  if (at < 0) return [];
  const ids = new Set([id]);
  for (let i = at + 1; i < rows.length && ids.has(rows[i].team); i++) ids.add(rows[i].id);
  return [...ids];
}

/** The ids in list order after `id`'s block steps one place up (-1) or down (1) past
 * the neighbouring block on its own team; null when it is already at that end. */
export function stepUnit(rows, id, dir) {
  const me = rows.find(r => r.id === id);
  if (!me) return null;
  const peers = rows.filter(r => r.team === me.team), at = peers.findIndex(r => r.id === id), next = peers[at + dir];
  if (!next) return null;
  const mine = unitOf(rows, id), theirs = unitOf(rows, next.id);
  const rest = rows.map(r => r.id).filter(x => !mine.includes(x));
  const where = dir > 0 ? rest.indexOf(theirs[theirs.length - 1]) + 1 : rest.indexOf(theirs[0]);
  rest.splice(where, 0, ...mine);
  return rest;
}

/** The pinned ids after a face steps one place left (-1) or right (1); null at the end. */
export function stepPin(pins, id, dir) {
  const at = pins.indexOf(id), to = at + dir;
  if (at < 0 || to < 0 || to >= pins.length) return null;
  const out = [...pins];
  [out[at], out[to]] = [out[to], out[at]];
  return out;
}

const within = (box, {x, y}) => Boolean(box) && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

/** What dropping here would do, from the pointer and the page's rectangles.
 *   {kind:'pin'}    a row over the shelf: it joins the pinned faces
 *   {kind:'pins'}   a face over the shelf: it reorders among them
 *   {kind:'unpin'}  a face over the list: it leaves the shelf
 *   {kind:'team', team}  a row over the middle of a manager's row: it moves to that team
 *   {kind:'rows'}   a row in the list: it reorders among its team
 *   {kind:'none'}   anywhere else
 * `from` is 'shelf' or 'list'; `inside` is the ids of the block being dragged. The
 * middle of a row is its middle half; the edges are for reordering. */
export function hitZone({shelf, list, rows = [], from, id, team = null, inside = [], x, y}) {
  const p = {x, y};
  if (within(shelf, p)) return {kind: from === 'shelf' ? 'pins' : 'pin'};
  if (!within(list, p)) return {kind: 'none'};
  if (from === 'shelf') return {kind: 'unpin'};
  for (const row of rows) {
    if (!row.manager || row.id === id || row.id === team || inside.includes(row.id)) continue;
    const band = (row.bottom - row.top) / 4;
    if (x >= row.left && x <= row.right && y > row.top + band && y < row.bottom - band) return {kind: 'team', team: row.id};
  }
  return {kind: 'rows'};
}
