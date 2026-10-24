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

/**
 * What a caller may ask of a reload (a restart of the worker). `beforeExit`
 * runs once the worker has shut down and drained, so nothing in the process
 * writes any more, and just before the exit: the place for a last repeat of an
 * idempotent cleanup that an in-process writer could have undone while the
 * worker was winding down.
 */
export interface ModelKeyReloadRequest {
  beforeExit?: () => void | Promise<void>;
}

/** One deliberate credential reload, after the HTTP save response can finish. */
export function createModelKeyReload(options: {
  managed: boolean;
  shutdown: () => void | Promise<void>;
  exit: (code: number) => void;
  schedule?: (run: () => void, delayMs: number) => unknown;
}): (request?: ModelKeyReloadRequest) => boolean {
  let requested = false;
  const beforeExit: Array<() => void | Promise<void>> = [];
  return (request) => {
    if (!options.managed) return false;
    // A request that finds the reload already scheduled still adds its hook:
    // the one exit serves everyone who asked for it.
    if (request?.beforeExit) beforeExit.push(request.beforeExit);
    if (requested) return true;
    requested = true;
    (options.schedule ?? setTimeout)(() => {
      void Promise.resolve().then(options.shutdown).finally(async () => {
        for (const hook of beforeExit) {
          // A hook that fails must not keep the worker from restarting.
          try { await hook(); } catch { /* the restart goes ahead */ }
        }
        // Both generated supervisors restart unsuccessful exits. This is not
        // a Gateway restart, and it leaves all existing policy/data intact.
        options.exit(75);
      }).catch(() => undefined);
    }, 750);
    return true;
  };
}
