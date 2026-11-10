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
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  return {
    setShutdown(handler: (signal: NodeJS.Signals) => void) { shutdown = handler; },
    modelReload(options: { managed: boolean; drain: () => Promise<void>; exit: (code: number) => void; beforeExit?: () => void | Promise<void> }) {
      return createModelKeyReload({ managed: options.managed, shutdown: async () => {
        // A reload drains and exits with its own code: no signal deadline.
        stop('SIGTERM', false); await options.drain();
      }, exit: options.exit, ...(options.beforeExit ? { beforeExit: options.beforeExit } : {}) });
    },
    dispose() { process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); },
  };
}
