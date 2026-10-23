/** How this worker process was launched, as decided by its entry point. */
export interface WorkerLaunch {
  /**
   * True only when the native worker service launched it (`__worker-service-run
   * <id>` with an id that matched its finalized environment, cli.ts
   * runWorkerForeground). The OpenClaw Gateway and the standalone engine host
   * both supervise that child and restart it after an unexpected exit. Never
   * inferred from an ambient variable: a foreground worker that inherited or
   * loaded OLYMPUS_NATIVE_SERVICE_INSTANCE_ID is not supervised.
   */
  nativeServiceSupervised?: boolean;
}

/**
 * Whether something restarts this worker when it exits: the native worker
 * service's validated launch, or the generated LaunchAgent/systemd unit
 * (OLYMPUS_MANAGED_WORKER, unchanged). A worker started by hand in a terminal
 * has neither and cannot restart itself.
 */
export function workerRestartsItself(launch: WorkerLaunch, env: Record<string, string | undefined>): boolean {
  return launch.nativeServiceSupervised === true || env.OLYMPUS_MANAGED_WORKER === '1';
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

/**
 * Whether one restart request also restarts the embedding drain, which keeps
 * the connector stores open in a process of its own. Only the standalone
 * engine host does: it supervises the worker and the drain together and
 * applies a pending delete before it starts either. Under the OpenClaw Gateway
 * the drain is a separate registered service, and on a generated
 * LaunchAgent/systemd worker unit it is a separate unit, so restarting the
 * worker would leave the deleted stores open in a live drain.
 */
export function restartCoversEmbeddingDrain(launch: WorkerLaunch, env: Record<string, string | undefined>): boolean {
  return env.OLYMPUS_ENGINE_HOST === '1' && launch.nativeServiceSupervised === true;
}
