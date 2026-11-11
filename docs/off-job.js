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
import {cleanText} from './core.js?v=b4d3410ab6';
import {controlFence} from './reply-blocks.js?v=b4d3410ab6';

/** The buttons under an out-of-job reply, in order. "Do it anyway" sends the same
 * request again with `anyway`, "Ask Atlas" starts a thread with it, and "Make a
 * new bot" opens the New bot page with it as the job. The last two are the client's. */
export const OFFJOB_CHOICES = [
  {id: 'anyway', label: 'Do it anyway'},
  {id: 'atlas', label: 'Ask Atlas'},
  {id: 'new-bot', label: 'Make a new bot'},
];

/** What a plain bot in its own chat is told about work that is not its job. */
export const OFFJOB_RULE = 'If the request is not part of your job, do not do it: reply only with a not-my-job block giving one short reason. The block is ```not-my-job followed by {"reason":"..."} and a closing ```.';
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
