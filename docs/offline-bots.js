/** What the bots of the Pages demo say, with no model behind them.
 *
 * The demo cannot run a bot's instructions, so it answers with a few canned
 * replies picked by keyword. They are written so the real rules still decide
 * what happens: a lead's reply names the teammates it hands work to with
 * `@Name` (the same hand-off path a model uses), a hire is a ```create-bot
 * block, and an out-of-job refusal is a ```not-my-job block. The caller reads
 * them exactly as it reads a model's reply.
 *
 * Pure and browser-safe.
 */
import {cleanText} from './core.js?v=b2a252f47f';
import {mentionedBots} from './coordination.js?v=b2a252f47f';
import {MIN_BOT_JOB} from './bot-create.js?v=b2a252f47f';

const FILLER = new Set('about after also and are can could does from have here into just like make more need please should some than that their them then there these they this those want what when where which will with would your you for the'.split(' '));
/** Content words of a text, lower-case, with a trailing plural `s` dropped, so
 * "books" in a job meets "book" in a request. */
const stems = text => new Set((String(text ?? '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(w => w.length >= 4 && !FILLER.has(w)).map(w => w.replace(/s$/, '')));
/** How many content words two texts share. */
export const overlap = (a, b) => { const left = stems(a); let n = 0; for (const w of stems(b)) if (left.has(w)) n++; return n; };

const GREETING = /^\s*(hi|hello|hey|hiya|good (morning|afternoon|evening)|thanks|thank you)\b[\s\S]{0,40}$/i;
const HIRE = /\b(make|create|build|hire|add|set up|need)\b[^.?!]*\b(bot|helper|assistant|agent)\b/i;

/** The job of a bot that a "make me a bot…" sentence describes: the sentence
 * itself, long enough to be a job. */
const jobFrom = request => {
  const sentence = cleanText(String(request ?? '').split(/(?<=[.!?])\s+/)[0], 600).replace(/[.!?]+$/, '');
  return sentence.length >= MIN_BOT_JOB ? sentence : `${sentence} for the owner`;
};

/** The reply of one offline bot step.
 *
 * `request` is the owner's message, `team` the bots a lead may hand work to,
 * `previous` what the step was handed (for a closing step, the team's answers).
 * `own` is true in the bot's own chat; `anyway` is "Do it anyway". */
export function offlineReply({bot, request, team = [], previous = null, closing = false, lead = false, own = false, anyway = false}) {
  const task = cleanText(request, 220);
  if (closing) return `All done. Here is what the team said:\n${cleanText(previous?.output, 600)}`;
  if (GREETING.test(request ?? '')) return `Hello! I'm ${bot.name}. Tell me what you need${lead ? " and I'll get the right bot on it" : ''}.`;
  if (lead) {
    if (HIRE.test(request ?? '')) return `Hiring that now.\n\`\`\`create-bot\n${JSON.stringify({job: jobFrom(request)})}\n\`\`\``;
    // Bots named in the request, then the ones whose job shares words with it.
    team = team.filter(b => b.id !== bot.id);
    const named = mentionedBots(team, request);
    const byJob = team.filter(b => !named.includes(b.id)).map(b => ({id: b.id, n: overlap(request, b.instructions)})).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3).map(x => x.id);
    const chosen = [...named, ...byJob].map(id => team.find(b => b.id === id)).filter(Boolean);
    if (chosen.length) return `I'll hand this to ${chosen.map(b => `@${b.name}`).join(' and ')}.`;
    return `I can take that. Ask me to make a bot for it, or tell me which bot should do it.`;
  }
  // A plain bot in its own chat says when a request is not its job, unless told to do it anyway.
  if (own && !anyway && !overlap(request, bot.instructions) && !mentionedBots(team, request).length) {
    return `\`\`\`not-my-job\n${JSON.stringify({reason: 'That is not what I do.'})}\n\`\`\``;
  }
  return `On it: ${task}`;
}
