import { createModelKeyReload } from './model-key-reload.ts';

/** How long a signalled worker may finish its shutdown before it exits anyway. */
export const WORKER_SHUTDOWN_DEADLINE_MS = 15_000;

/** Install before startup awaits. Ownership is a closure over THIS worker's
 * bridge/client, never a global runtime path or another process's epoch. */
export function installWorkerShutdownSignals(options: {
  closeOwnerBridge: () => void;
  exit: (code: number) => void;
  deadlineMs?: number;
}) {
  let shutdown: ((signal: NodeJS.Signals) => void) | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const stop = (signal: NodeJS.Signals, exitAfterDeadline = true) => {
    options.closeOwnerBridge();
    const code = signal === 'SIGINT' ? 130 : 143;
    if (!shutdown) return options.exit(code);
    if (exitAfterDeadline) {
      // Armed before the handler runs, so a handler that throws or blocks still
      // has a deadline behind it.
      deadline ??= setTimeout(() => options.exit(code), options.deadlineMs ?? WORKER_SHUTDOWN_DEADLINE_MS);
      deadline.unref?.();
    }
    shutdown(signal);
    // The handler closes the listener (which removes the socket) and stops
    // new work, but a pass already running (a first import's page) keeps the
    // process up until it ends. Past the deadline the worker exits rather than
    // waiting for the service manager's kill, which left the socket behind and
    // the next start refusing it (Sparta, 2026-11-03). SQLite stores are safe
    // to leave mid-write; the pass resumes from its checkpoint.
  };
  // The first signal starts the shutdown, with its deadline. Later ones are
  // ignored, and the handlers stay installed so they cannot fall through to
  // the default action and kill the teardown: under the worker service's own
  // unit with the engine split on, a worker gets SIGTERM from systemd's
  // control-group kill and again from the supervisor stopping it.
  let signalled = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (signalled) return;
    signalled = true;
    stop(signal);
  };
  const onInt = () => onSignal('SIGINT');
  const onTerm = () => onSignal('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  return {
    setShutdown(handler: (signal: NodeJS.Signals) => void) { shutdown = handler; },
    modelReload(options: { managed: boolean; drain: () => Promise<void>; exit: (code: number) => void }) {
      return createModelKeyReload({ managed: options.managed, shutdown: async () => {
        // A reload drains and exits with its own code: no signal deadline.
        stop('SIGTERM', false); await options.drain();
      }, exit: options.exit });
    },
    dispose() { process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); },
  };
}
