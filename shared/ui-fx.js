/** Small moments of delight, and the behaviour that makes the bots feel alive.
 * None of it blocks input, and all of it does nothing when the user asked for
 * reduced motion. The looks themselves are CSS (app.css, "the bots are alive");
 * this module only decides WHEN: it toggles short-lived state classes. */
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Throw a few dots from `origin`, in the theme's own accent colours. */
export function confetti(origin) {
  if (calm() || !origin) return;
  const box = origin.getBoundingClientRect(), css = getComputedStyle(document.documentElement);
  const colours = ['--brand', '--wait', '--good', '--bad'].map(name => css.getPropertyValue(name).trim());
  for (let i = 0; i < 8; i++) {
    const dot = document.createElement('i'), angle = (Math.PI * 2 * i) / 8 + Math.random() * 0.5, reach = 36 + Math.random() * 34;
    dot.className = 'confetti';
    dot.style.left = `${box.left + box.width / 2}px`; dot.style.top = `${box.top + box.height / 2}px`;
    dot.style.background = colours[i % colours.length];
    dot.style.setProperty('--dx', `${Math.cos(angle) * reach}px`);
    dot.style.setProperty('--dy', `${Math.sin(angle) * reach - 20}px`);
    dot.style.setProperty('--rot', `${Math.round(Math.random() * 540 - 270)}deg`);
    dot.addEventListener('animationend', () => dot.remove(), {once: true});
    // animationend is the tidy exit, but a tab that is hidden mid-throw may never
    // fire it (or fires it late), and these dots are fixed-position children of
    // <body>: without a timer they pile up over the whole page. The timer is the
    // guarantee; the second remove() is harmless.
    setTimeout(() => dot.remove(), 1200);
    document.body.appendChild(dot);
  }
}

/** The send arrow flies off and a fresh one slides in. */
export function whoosh(button) {
  if (calm() || !button) return;
  button.classList.remove('sent'); void button.offsetWidth; button.classList.add('sent');
  button.addEventListener('animationend', () => button.classList.remove('sent'), {once: true});
}

/* ---------- living bots ---------- */

/** Put `name` on `node` for `ms`, restarting it if it is already playing. */
function flash(node, name, ms) {
  if (calm() || !node) return;
  node.classList.remove(name); void node.offsetWidth; node.classList.add(name);
  clearTimeout(node[`_${name}`]); node[`_${name}`] = setTimeout(() => node.classList.remove(name), ms);
}
const stage = () => document.getElementById('root');
/** The open chat's bots react together: 'nod' (you spoke), 'cheer' (you approved
 * or posted), 'aww' (you skipped one), 'woke' (they were dozing). */
export const react = (mood, ms = 1100) => flash(stage(), mood, ms);

const NAP_AFTER_MS = 40000;
/** The ambient wiring, in a function of its own so it can be taken apart again:
 * every listener and pending frame is registered here and undone by the disposer. */
function wireBots() {
  let frame = 0, napTimer = null;
  const listeners = [];
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); listeners.push([target, type, fn]); };
  const big = '.pr-face .face--awake, .lk-preview .face--awake';
  const follow = ev => {
    // A hidden tab draws no frames and a page without a big face on it (the chat
    // list, the admin pages) has nothing to move: both bail before the geometry
    // pass, so the pointer loop costs one selector hit instead of a rect per node.
    if (frame || document.hidden || !document.querySelector(big)) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const face of document.querySelectorAll(big)) {
        const look = face.querySelector('.face-eyes'); if (!look) continue;
        const box = face.getBoundingClientRect(), reach = 4; // in the face's own 100-unit box
        const dx = ev.clientX - (box.left + box.width / 2), dy = ev.clientY - (box.top + box.height / 2), far = Math.hypot(dx, dy) || 1;
        const pull = Math.min(1, far / 220);
        look.style.transform = `translate(${(dx / far * reach * pull).toFixed(2)}px, ${(dy / far * reach * pull).toFixed(2)}px)`;
      }
    });
  };
  const stir = () => {
    const root = stage(); if (!root) return;
    if (root.classList.contains('sleepy')) { root.classList.remove('sleepy'); react('woke', 700); }
    clearTimeout(napTimer); napTimer = setTimeout(() => root.classList.add('sleepy'), NAP_AFTER_MS);
  };
  const composing = ev => {
    if (ev.target.matches?.('.composer textarea')) stage()?.classList.toggle('composing', ev.type === 'focusin');
  };
  on(window, 'pointermove', ev => { follow(ev); stir(); }, {passive: true});
  on(window, 'keydown', stir, {passive: true});
  on(window, 'pointerdown', stir, {passive: true});
  on(document, 'focusin', composing);
  on(document, 'focusout', composing);
  stir();
  return () => {
    clearTimeout(napTimer); if (frame) cancelAnimationFrame(frame);
    for (const [target, type, fn] of listeners) target.removeEventListener(type, fn);
    const root = stage(); if (root) root.classList.remove('composing', 'sleepy');
  };
}

/** Wire the ambient behaviour: big faces follow the pointer, the bots doze off when
 * nothing happens for a while and startle awake when you come back, and they watch
 * the composer while you write. Safe to call again; the returned disposer unhooks. */
export function bringBotsToLife() {
  const query = matchMedia('(prefers-reduced-motion: reduce)');
  let stop = null;
  // Reduced motion can be turned on while the page is open (the OS setting, a test
  // harness, a battery saver), so the wiring follows the query rather than being
  // decided once at boot: it is torn down when the preference flips on and back
  // when it flips off.
  const sync = () => {
    if (query.matches) { stop?.(); stop = null; }
    else if (!stop) stop = wireBots();
  };
  sync();
  query.addEventListener('change', sync);
  return () => { query.removeEventListener('change', sync); stop?.(); stop = null; };
}
