/** The one vocabulary for the life of a run.
 *
 * A run is a coordination run: a group pipeline, or the page turn a 1:1 bot
 * takes. It is `queued`, then `running`; it may stop at a plan, a checkpoint, a
 * page or a feed read; and it ends. Those ten words are read by the Node
 * orchestrator (`src/coordination.js`), the Pages demo engine
 * (`shared/local-api.js`) and the UI (`shared/ui-model.js`,
 * `shared/ui-panel.js`) — and each of them used to keep its own hand-written
 * list of which of the words count as busy, interruptible or stoppable, so the
 * three could disagree about what "busy" meant after any change.
 *
 * The categories are declared here once. Everything else derives from them.
 * Pure and dependency-free, like the other shared modules: the browser and the
 * server both import it.
 */

/** A run that still holds work: about to start, between steps, or waiting on a
 * person. A second run waits while one of these is open — Start or Continue is
 * the way through, not another message. */
export const BUSY_STATUSES = ['running', 'queued', 'awaiting_browser', 'awaiting_plan', 'awaiting_checkpoint'];

/** A run a person may still stop. It is the same set as `BUSY_STATUSES` today,
 * but kept under its own name because "blocks a new run" and "can be stopped"
 * are different questions and a future status may answer them differently. A
 * finished, failed or cancelled run has nothing left to stop. */
export const STOPPABLE_STATUSES = [...BUSY_STATUSES];

/** A restart cuts only a run that was still calling a model or waiting on a
 * page. A shown plan and a checkpoint stay, so Start and Continue still work. */
export const INTERRUPT_STATUSES = ['running', 'queued', 'awaiting_browser'];
