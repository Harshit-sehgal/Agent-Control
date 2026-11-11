/** The one grammar every control block in a bot reply is read with.
 *
 * A bot asks for something outside its reply — a helper model, a teammate, a
 * new bot, a web page — by fenced block. There are six kinds (`ask`, `spawn`,
 * `create-bot`, `browser`, `not-my-job`, `connector`) and each has its own parser in its own module, but
 * they must agree on one thing: what a block *is*. This module owns that, so no
 * two parsers can drift apart about the fence and leave a bot echoing control
 * text into a prompt, or a quoted block filing a real request.
 *
 * The AI client trims a fence that ends a reply, so an unclosed *final* fence is
 * a real block: the body runs to the end of the text. Every parser and every
 * strip path calls this, so whatever one accepts the others remove.
 *
 * Pure, browser-safe, and dependency-free: `shared/` must not read Node or the
 * server, and both the UI (which strips control text from a draft) and the
 * server (which reads it) import this.
 */

/** Every control block a bot reply may carry. */
export const CONTROL_FENCES = ['ask', 'spawn', 'create-bot', 'browser', 'not-my-job', 'connector'];

/** A fresh regex for the named fences, or for every control fence when no name
 * is given (the strip path). Call it per use: the `g` flag carries matching
 * state, so a shared RegExp object is not safe to hand around. */
export function controlFence(...names) {
  const which = names.length ? names : CONTROL_FENCES;
  return new RegExp('```(?:' + which.join('|') + ')[ \\t]*\\r?\\n([\\s\\S]*?)(?:```|$(?![\\s\\S]))', 'gi');
}
