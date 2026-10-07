/**
 * Whether something restarts this worker when it exits: the generated
 * LaunchAgent/systemd unit (OLYMPUS_MANAGED_WORKER), or the native worker
 * service that the OpenClaw Gateway and the standalone engine host both run,
 * which hands its child a validated instance id and restarts it with backoff.
 * A worker started by hand in a terminal has neither and cannot restart itself.
 */
export function workerRestartsItself(env: Record<string, string | undefined>): boolean {
  return env.OLYMPUS_MANAGED_WORKER === '1' || Boolean(env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID?.trim());
}

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
