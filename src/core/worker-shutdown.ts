import { createModelKeyReload } from './model-key-reload.ts';

/** Install before startup awaits. Ownership is a closure over THIS worker's
 * bridge/client, never a global runtime path or another process's epoch. */
export function installWorkerShutdownSignals(options: {
  closeOwnerBridge: () => void;
  exit: (code: number) => void;
}) {
  let shutdown: ((signal: NodeJS.Signals) => void) | undefined;
  const stop = (signal: NodeJS.Signals) => {
    options.closeOwnerBridge();
    if (shutdown) shutdown(signal);
    else options.exit(signal === 'SIGINT' ? 130 : 143);
  };
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  process.once('SIGINT', onInt);
  process.once('SIGTERM', onTerm);
  return {
    setShutdown(handler: (signal: NodeJS.Signals) => void) { shutdown = handler; },
    modelReload(options: { managed: boolean; drain: () => Promise<void>; exit: (code: number) => void }) {
      return createModelKeyReload({ managed: options.managed, shutdown: async () => {
        stop('SIGTERM'); await options.drain();
      }, exit: options.exit });
    },
    dispose() { process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); },
  };
}
