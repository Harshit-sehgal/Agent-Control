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

const HELLOS = ['hi!', 'hehe', 'beep!', 'boop', 'ready!', 'yay', '\u2665'];
const MOVES = ['boing', 'spin', 'wink', 'shy'];
let pokes = 0;
/** Poke a big bot face: it picks a trick and says something small. */
export function poke(button) {
  if (!button) return;
  const move = MOVES[pokes % MOVES.length], word = HELLOS[pokes % HELLOS.length]; pokes++;
  flash(button, move, 900);
  const said = document.createElement('span');
  said.className = 'poke-say'; said.textContent = word;
  said.addEventListener('animationend', () => said.remove(), {once: true});
  button.appendChild(said);
  if (calm()) setTimeout(() => said.remove(), 900);
}

const NAP_AFTER_MS = 40000;
/** Wire the ambient behaviour once: big faces follow the pointer, the bots doze
 * off when nothing happens for a while and startle awake when you come back,
 * and they watch the composer while you write. */
export function bringBotsToLife() {
  if (calm()) return;
  let frame = 0, napTimer = null;
  const big = '.thread-title .face, .poke .face, .mascot';
  const follow = ev => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const face of document.querySelectorAll(big)) {
        const look = face.querySelector('.look'); if (!look) continue;
        const box = face.getBoundingClientRect(), reach = face.classList.contains('mascot') ? 4 : 2.200;
        const dx = ev.clientX - (box.left + box.width / 2), dy = ev.clientY - (box.top + box.height / 2), far = Math.hypot(dx, dy) || 1;
        const pull = Math.min(1, far / 220);
        look.style.transform = `translate(${(dx / far * reach * pull).toFixed(2)}px, ${(dy / far * reach * pull).toFixed(2)}px)`;
      }
    });
  };
  const stir = () => {
    const root = stage();
    if (root.classList.contains('sleepy')) { root.classList.remove('sleepy'); react('woke', 700); }
    clearTimeout(napTimer); napTimer = setTimeout(() => root.classList.add('sleepy'), NAP_AFTER_MS);
  };
  addEventListener('pointermove', ev => { follow(ev); stir(); }, {passive: true});
  addEventListener('keydown', stir, {passive: true});
  addEventListener('pointerdown', stir, {passive: true});
  document.addEventListener('focusin', ev => { if (ev.target.matches?.('.composer textarea')) stage().classList.add('composing'); });
  document.addEventListener('focusout', ev => { if (ev.target.matches?.('.composer textarea')) stage().classList.remove('composing'); });
  stir();
}
