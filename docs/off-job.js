/** A plain bot in its own chat says when a request is not its job.
 *
 * The bot does not quietly do another bot's work and does not quietly refuse. It
 * replies with a `not-my-job` block giving one short reason, and the chat shows
 * that reply with three buttons. The model decides from its own job only, so it
 * needs no list of other bots. Leads (the primary and managers) never reply this
 * way: they hand the work to their team.
 *
 * Pure and browser-safe. The block grammar is the shared one in `reply-blocks.js`.
 */
import {cleanText} from './core.js?v=a9e6960ec3';
import {controlFence} from './reply-blocks.js?v=a9e6960ec3';

/** The buttons under an out-of-job reply, in order. "Do it anyway" sends the same
 * request again with `anyway`, "Ask Atlas" starts a thread with it, and "Make a
 * new bot" opens the New bot page with it as the job. The last two are the client's. */
export const OFFJOB_CHOICES = [
  {id: 'anyway', label: 'Do it anyway'},
  {id: 'atlas', label: 'Ask Atlas'},
  {id: 'new-bot', label: 'Make a new bot'},
];

/** What a plain bot in its own chat is told about work that is not its job. */
export const OFFJOB_RULE = 'Answer anything quick and general yourself, in one short reply: greetings, thanks, questions about you or your work, short facts or explanations, and follow-ups to your earlier replies. When the request is real work that belongs to a different job (a task, a draft, research or an action outside what you do), never leave the owner at a dead end. If you can do it well with what you have, do it yourself, and say it is outside your usual job. If not, in the same reply name the bot in company whose job fits (by name, without @) so the owner can hand it over, or, when no bot does that work, add a create-bot block for one and say you made it. Only when none of that fits, reply only with a not-my-job block giving one short reason. The block is ```not-my-job followed by {"reason":"..."} and a closing ```.';

/** A message any bot answers itself, with no job check: a greeting, thanks, a yes or ok, or a question about the
 * bot itself. The whole message must be that, so "thanks, now email Pat" is still work. */
const BASIC = [
  ['greeting', /^(hi|hello|hey|hiya|yo|howdy|good (morning|afternoon|evening|night))( there| all| everyone)?$/],
  ['thanks', /^(thanks|thank you|thx|ty|cheers|many thanks)( so much| a lot| again| very much)?$/],
  ['ack', /^(ok|okay|k|got it|cool|great|nice|perfect|sounds good|sure|yes|no|yep|nope|alright|all good)$/],
  ['self', /^(what can you do|who are you|what are you|what is your job|whats your job|what do you do|how do you work|how can you help|help)$/],
];
/** Which basic ask a message is (greeting, thanks, ack or self), or null. */
export function basicKind(text) {
  const words = String(text ?? '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words || words.length > 40) return null;
  return BASIC.find(([, re]) => re.test(words))?.[0] ?? null;
}
export const basicAsk = text => basicKind(text) !== null;
/** What it is told when the owner has chosen "Do it anyway". */
export const OFFJOB_ANYWAY = 'The owner asked you to do this once even though it is outside your job.';

const FALLBACK = 'This is outside my job.';

/** `{reason}` when the reply is a not-my-job block, else null. A block that is
 * not valid JSON still means "not my job". */
export function parseOffJob(output) {
  const match = controlFence('not-my-job').exec(String(output ?? ''));
  if (!match) return null;
  let reason = '';
  try { reason = cleanText(JSON.parse(match[1])?.reason, 300); } catch { /* Keep the fallback. */ }
  return {reason: reason || FALLBACK};
}

/** The chat line for an out-of-job reply. `request` is the owner's text, kept
 * (at most 4000 characters) so the buttons can send it on. */
export function offJobMessage({bot, reason, request, ...rest}) {
  return {
    role: 'bot', senderId: bot.id, senderName: bot.name, mode: 'ai',
    text: `That is not part of my job. ${reason || FALLBACK}`,
    kind: 'offjob', botId: bot.id, request: cleanText(request, 4000),
    ...rest,
  };
}
