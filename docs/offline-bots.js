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
import {titleFrom} from './threads.js?v=cbbedc32a9';
import {cleanText} from './core.js?v=cbbedc32a9';
import {mentionedBots} from './coordination.js?v=cbbedc32a9';
import {MIN_BOT_JOB} from './bot-create.js?v=cbbedc32a9';
import {basicKind} from './off-job.js?v=cbbedc32a9';

const FILLER = new Set('about after also and are can could does from have here into just like make more need please should some than that their them then there these they this those want what when where which will with would your you for the'.split(' '));
/** Content words of a text, lower-case, with a trailing plural `s` dropped, so
 * "books" in a job meets "book" in a request. */
const stems = text => new Set((String(text ?? '').toLowerCase().match(/[a-z0-9]{3,}/g) || []).filter(w => w.length >= 4 && !FILLER.has(w)).map(w => w.replace(/s$/, '')));
/** How many content words two texts share. */
export const overlap = (a, b) => { const left = stems(a); let n = 0; for (const w of stems(b)) if (left.has(w)) n++; return n; };

/** A settings request the demo can read without a model: rename a bot, change its reply length, switch it
 * on or off, or have the team ask before each step. Returns the ```setup block a model would write (see shared/setup.js), or ''. `self` is the bot
 * that is speaking, so "your replies" in its own chat means itself. */
export function offlineSetup(request, bots = [], self = null) {
  const text = String(request ?? '').trim();
  const fence = body => `\`\`\`setup\n${JSON.stringify(body)}\n\`\`\``;
  const named = bots.filter(b => b?.name && new RegExp(`\\b${b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text))[0];
  const rename = text.match(/\brename\s+(.+?)\s+to\s+["“]?([^"”]+?)["”]?[.!?]*$/i);
  if (rename) return fence({action: 'rename', bot: rename[1].replace(/^(the\s+)?bot\s+/i, ''), name: rename[2].trim()});
  if (/\b(ask|check with) me (before|between) (each|every)\b|\bapprove (each|every) step\b/i.test(text)) return fence({action: 'team', settings: {checkpoints: true}});
  if (/\b(stop asking|don'?t ask me)\b[^.?!]*\bstep/i.test(text)) return fence({action: 'team', settings: {checkpoints: false}});
  const who = named?.name || (self && /\b(you|your|yourself)\b/i.test(text) ? 'me' : '');
  // "every morning at 8, sum up my inbox": a timer for the named bot, or for this one.
  const often = text.match(/\b(?:every|each)\s+(morning|day|evening|night|hour|week)\b/i);
  if (often && !HIRE.test(text) && (who || self)) {
    const at = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
    let hour = at ? Number(at[1]) % 12 + (/pm/i.test(at[3] || '') ? 12 : 0) : null;
    if (at && !at[3] && Number(at[1]) > 12) hour = Number(at[1]);
    if (at && !at[3] && /evening|night/i.test(often[1]) && hour < 12) hour += 12;
    const what = text.replace(often[0], '').replace(at?.[0] || '', '').replace(/^[\s,:;-]+/, '').replace(named ? new RegExp(`^${named.name}\\b[\\s,:;-]*`, 'i') : /$^/, '').replace(/^[\s,:;-]*(please\s+)?(can you\s+|could you\s+)?/i, '').replace(/[.!?]+$/, '').replace(/[\s,]*\bplease$/i, '').replace(/[\s,]+$/, '');
    if (what.length >= 3) return fence({action: 'schedule', bot: who || 'me', do: what.charAt(0).toUpperCase() + what.slice(1), every: /hour/i.test(often[1]) ? 'hour' : /week/i.test(often[1]) ? 'week' : 'day', ...(hour !== null && hour < 24 ? {at: `${String(hour).padStart(2, '0')}:${at[2] || '00'}`} : {})});
  }
  if (!who) return '';
  if (/\b(switch|turn)\b[^.?!]*\boff\b|\bdisable\b/i.test(text)) return fence({action: 'settings', bot: who, settings: {enabled: false}});
  if (/\b(switch|turn)\b[^.?!]*\bon\b|\benable\b/i.test(text)) return fence({action: 'settings', bot: who, settings: {enabled: true}});
  const replies = /\b(replies|answers|responses)\b/i.test(text);
  if (replies && /\b(shorter|briefer|more concise|short)\b/i.test(text)) return fence({action: 'settings', bot: who, settings: {replyLength: 'short'}});
  if (replies && /\b(longer|more detail(ed)?|long)\b/i.test(text)) return fence({action: 'settings', bot: who, settings: {replyLength: 'long'}});
  return '';
}

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
  // The closing reply is the result: the demo has no model, so it says so in one line instead of relaying the team.
  if (closing) return `Done: ${titleFrom(request) || 'that'}.\nThis demo runs without a model, so the team's answers are stand-ins. Connect one in Settings → Models and keys for real results.`;
  if (GREETING.test(request ?? '')) return `Hello! I'm ${bot.name}. Tell me what you need${lead ? " and I'll get the right bot on it" : ''}.`;
  // Thanks, ok and "what can you do?" are answered by any bot itself, never refused or handed on.
  const basic = basicKind(request);
  if (basic === 'self') return lead ? `I'm ${bot.name}. Ask me anything: I answer quick things myself and hand real work to the bot whose job it is.` : `I'm ${bot.name}. ${cleanText(bot.instructions, 300)}`;
  if (basic === 'thanks') return 'Glad to help.';
  if (basic === 'ack') return 'Okay.';
  const setup = offlineSetup(request, [bot, ...team], own || lead ? bot : null);
  if (setup) return `Here is that change.\n${setup}`;
  if (lead) {
    if (HIRE.test(request ?? '')) return `Hiring that now.\n\`\`\`create-bot\n${JSON.stringify({job: jobFrom(request)})}\n\`\`\``;
    // Bots named in the request, then the ones whose job shares words with it.
    team = team.filter(b => b.id !== bot.id);
    const named = mentionedBots(team, request);
    const byJob = team.filter(b => !named.includes(b.id)).map(b => ({id: b.id, n: overlap(request, b.instructions)})).filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 3).map(x => x.id);
    const chosen = [...named, ...byJob].map(id => team.find(b => b.id === id)).filter(Boolean);
    if (chosen.length) return `I'll hand this to ${chosen.map(b => `@${b.name}`).join(' and ')}.`;
    // No bot fits: Atlas makes one for the job and it starts at once, as the served app does.
    return `Making a bot for this.\n\`\`\`create-bot\n${JSON.stringify({job: jobFrom(request)})}\n\`\`\``;
  }
  // A plain bot in its own chat says when a request is not its job, unless told to do it anyway.
  if (own && !anyway && !overlap(request, bot.instructions) && !mentionedBots(team, request).length) {
    return `\`\`\`not-my-job\n${JSON.stringify({reason: 'That is not what I do.'})}\n\`\`\``;
  }
  return `On it: ${task}`;
}
