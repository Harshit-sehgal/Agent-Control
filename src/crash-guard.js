/** The last line of defence for a promise nobody awaited.
 *
 * Node ends the process on an unhandled rejection. Every background path here
 * (a page opened on this server, a run started after Keep going, a follow-up)
 * is meant to catch its own errors; one that slips through should cost a log
 * line, not every workspace on the server. An uncaught exception is left to
 * Node's default (print and exit): after a synchronous throw the process state
 * is unknown, and a supervisor restarting it is the safe answer. */
export function guardRejections(proc = process, log = console.error) {
  const onRejection = reason => {
    log('Unhandled rejection (the server keeps running):', reason instanceof Error ? (reason.stack || reason.message) : reason);
  };
  proc.on('unhandledRejection', onRejection);
  return () => proc.off('unhandledRejection', onRejection);
}
