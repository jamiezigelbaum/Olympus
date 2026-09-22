/** One deliberate credential reload, after the HTTP save response can finish. */
export function createModelKeyReload(options: {
  managed: boolean;
  shutdown: () => void | Promise<void>;
  exit: (code: number) => void;
  schedule?: (run: () => void, delayMs: number) => unknown;
}): () => boolean {
  let requested = false;
  return () => {
    if (!options.managed) return false;
    if (requested) return true;
    requested = true;
    (options.schedule ?? setTimeout)(() => {
      void Promise.resolve().then(options.shutdown).finally(() => {
        // Both generated supervisors restart unsuccessful exits. This is not
        // a Gateway restart, and it leaves all existing policy/data intact.
        options.exit(75);
      }).catch(() => undefined);
    }, 750);
    return true;
  };
}
