import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFromPluginConfig } from './config.ts';
import type {
  NativeProcessServiceContext,
  NativeProcessServiceDefinition,
  NativeProcessStartSettings,
} from './native-process-service.ts';
import { createNativeProcessService } from './native-process-service.ts';

const SERVICE_ID = 'olympus-transcription-temp-cleanup';
const RELOAD_PREFIX = 'plugins.entries.olympus.config.worker.transcriptionCleanup';

export interface NativeTranscriptionCleanupOptions {
  initialPluginConfig: unknown;
  /** Test seam; production resolves the packaged script from the module URL. */
  moduleUrl?: string | URL;
  /** Test seam; overrides the packaged sweep script path. */
  scriptPath?: string;
  /** Test seam; production spawns through node:child_process. */
  spawn?: typeof import('node:child_process').spawn;
  /** Test seam for interval scheduling. */
  intervalMs?: number;
}

/**
 * The parsed `worker.transcriptionCleanup` knobs this service acts on. Note
 * what is NOT here: no delete logic, no liveness check, no credential, and no
 * unrelated worker knob. The packaged sweep script owns all of that; this
 * service only decides when to run it.
 */
interface TranscriptionCleanupSettings {
  enabled: boolean;
  bashPath: string;
  tempRoot: string;
  intervalSeconds: number;
  minAgeMinutes: number;
  maxRuntimeSeconds: number;
}

interface CleanupLifetime {
  context: NativeProcessServiceContext;
  kernel: NativeProcessServiceDefinition;
  /** The pending interval timer, cleared the moment the lifetime is retired. */
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Resolves (false) the pending interval wait so stop() never hangs on it. */
  cancelInterval: (() => void) | undefined;
  /** Settles when the current tick has fully completed (success or failure). */
  tick: Promise<void> | undefined;
  stopped: boolean;
}

/**
 * Supervise the packaged transcription temp-dir sweep in the Gateway process.
 *
 * The sweep is a finite job, not a listener: each tick runs
 * `olympus-whisper-transcribe.sh --sweep` to completion, and the next tick is
 * scheduled only AFTER that completion plus the configured interval. This
 * module deliberately reimplements neither the removal nor the liveness rules
 * — the packaged script is the single owner of both — and never sources
 * `worker.env` or forwards ambient credentials.
 *
 * Lifecycle discipline mirrors the other native services: one live lifetime, a
 * generation fence that refuses every late start/write/health callback after
 * `stop()` or a newer `start()`, and a `stop()` that cancels the pending timer
 * and awaits the active tick.
 */
export function createNativeTranscriptionCleanupService(
  options: NativeTranscriptionCleanupOptions,
): NativeProcessServiceDefinition {
  const scriptPath = options.scriptPath
    ?? fileURLToPath(new URL('../config/systemd/user/olympus-whisper-transcribe.sh', options.moduleUrl ?? import.meta.url));
  let current: CleanupLifetime | undefined;
  let generation = 0;

  const isCurrent = (lifetime: CleanupLifetime): boolean =>
    current === lifetime && !lifetime.stopped;

  const reportFailure = (lifetime: CleanupLifetime, message: string): void => {
    if (!isCurrent(lifetime)) return;
    try {
      lifetime.context.serviceHealth?.reportFailure(new Error(message));
    } catch {
      // A retired host lease may throw; shutdown still wins.
    }
  };

  /**
   * Run one sweep to completion. Returns only after the child is ready-and-done
   * (clean exit) or after the kernel has reported a bounded failure (nonzero
   * exit, signal, or the maxRuntime deadline). Never throws: a failed sweep is
   * categorical health, and the loop decides whether another tick is worth it.
   */
  async function runSweepOnce(
    lifetime: CleanupLifetime,
    kernel: NativeProcessServiceDefinition,
  ): Promise<void> {
    if (!isCurrent(lifetime)) return;
    try {
      await kernel.start(lifetime.context);
    } catch {
      reportFailure(lifetime, 'Olympus transcription temp cleanup failed to complete.');
    }
  }

  async function runLoop(
    lifetime: CleanupLifetime,
    kernel: NativeProcessServiceDefinition,
    settings: TranscriptionCleanupSettings,
  ): Promise<void> {
    while (isCurrent(lifetime)) {
      await runSweepOnce(lifetime, kernel);
      if (!isCurrent(lifetime)) return;
      const waited = await waitInterval(lifetime, settings.intervalSeconds);
      if (!waited || !isCurrent(lifetime)) return;
    }
  }

  /**
   * Wait one interval, waking immediately (with `false`) the moment the
   * lifetime is retired. The timer is stored on the lifetime so `stop()` clears
   * it and resolves this wait rather than hanging on an interval no tick wants.
   */
  function waitInterval(lifetime: CleanupLifetime, seconds: number): Promise<boolean> {
    if (!isCurrent(lifetime)) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        lifetime.timer = undefined;
        lifetime.cancelInterval = undefined;
        resolve(isCurrent(lifetime));
      }, options.intervalMs ?? seconds * 1_000);
      timer.unref?.();
      lifetime.timer = timer;
      lifetime.cancelInterval = () => {
        lifetime.timer = undefined;
        lifetime.cancelInterval = undefined;
        resolve(false);
      };
    });
  }

  function buildSettings(settings: TranscriptionCleanupSettings): NativeProcessStartSettings {
    return {
      command: settings.bashPath,
      args: [scriptPath, '--sweep'],
      // ONLY home/path/temp/locale plus the two sweep knobs reach the child. No
      // worker.env, no host service-wrapper environment, no credentials.
      env: sweepEnvironment(settings),
      // A finite job's startup deadline is the whole job: a sweep that cannot
      // finish inside maxRuntimeSeconds is a bounded failure, not a hang.
      startupTimeoutMs: settings.maxRuntimeSeconds * 1_000,
      // No listener to contend over: this child never owns an endpoint.
      endpointOccupied: false,
      // Completion IS readiness for a one-shot job. Only this exact child's
      // clean exit counts; there is no receipt file and no external service.
      readinessProbe: async (child) => child.exitCode === 0 && child.signalCode === null,
    };
  }

  return {
    id: SERVICE_ID,
    reload: { configPrefixes: [RELOAD_PREFIX] },
    async start(context) {
      const startGeneration = ++generation;
      await stopCurrent();
      if (startGeneration !== generation) return;
      let settings: TranscriptionCleanupSettings;
      try {
        const configured = configFromPluginConfig(freshPluginConfig(context.config, options.initialPluginConfig)).worker.transcriptionCleanup;
        settings = { ...configured, tempRoot: configured.tempRoot ?? tmpdir() };
      } catch {
        try {
          context.serviceHealth?.reportFailure(
            new Error('Olympus transcription temp cleanup configuration is invalid.'),
          );
        } catch {
          // Retired lease.
        }
        return;
      }
      if (!settings.enabled) return;
      const problem = cleanupConfigurationProblem(settings);
      if (problem) {
        reportStandalone(context, problem);
        return;
      }
      const kernel = createNativeProcessService<NativeProcessStartSettings>({
        id: SERVICE_ID,
        label: 'transcription temp cleanup',
        initialConfig: options.initialPluginConfig,
        reload: { configPrefixes: [RELOAD_PREFIX] },
        // A finished sweep is completion, not a crash: no replacement is
        // scheduled, and the exact child's process group is still stopped.
        restartOnCleanExit: false,
        prepareStart: async () => (isCurrent(lifetime) ? buildSettings(settings) : undefined),
        ...(options.spawn ? { spawn: options.spawn } : {}),
      });
      const lifetime: CleanupLifetime = {
        context,
        kernel,
        timer: undefined,
        cancelInterval: undefined,
        tick: undefined,
        stopped: false,
      };
      current = lifetime;
      try {
        context.logger?.info?.('Olympus transcription temp cleanup is running.');
      } catch {
        // Logging is advisory; a host logger must never fail the start.
      }
      // Start returns promptly; the first sweep begins immediately.
      lifetime.tick = runLoop(lifetime, kernel, settings);
    },
    async stop() {
      generation += 1;
      await stopCurrent();
    },
  };

  /**
   * Retirement order matters: stop() flips the epoch fence first, so the tick
   * already in flight settles on the fence instead of starting work late.
   */
  async function stopCurrent(): Promise<void> {
    const lifetime = current;
    if (!lifetime) return;
    current = undefined;
    lifetime.stopped = true;
    if (lifetime.timer) {
      clearTimeout(lifetime.timer);
      lifetime.timer = undefined;
    }
    lifetime.cancelInterval?.();
    await lifetime.kernel.stop();
    try {
      await lifetime.tick;
    } catch {
      // The tick swallows its own failures; a rejected tick must not block stop.
    }
  }
}

/** Categorical configuration problems; never the offending value. */
function cleanupConfigurationProblem(settings: TranscriptionCleanupSettings): string | undefined {
  if (!isAbsolute(settings.bashPath)) {
    return 'Olympus transcription temp cleanup requires an absolute worker.transcriptionCleanup.bashPath.';
  }
  if (!isAbsolute(settings.tempRoot)) {
    return 'Olympus transcription temp cleanup requires an absolute worker.transcriptionCleanup.tempRoot.';
  }
  return undefined;
}

/**
 * The `--sweep` environment, and nothing else: home/path/temp/locale so the
 * packaged script can find its own tools, plus the temp root and age knob it
 * reads. No ambient key survives, and no other wrapper knob is forwarded.
 */
function sweepEnvironment(settings: TranscriptionCleanupSettings): NodeJS.ProcessEnv {
  return {
    HOME: process.env.HOME ?? '',
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    LANG: process.env.LANG ?? 'C',
    OLYMPUS_TRANSCRIBE_TMP_ROOT: settings.tempRoot,
    OLYMPUS_TRANSCRIBE_SWEEP_AGE_MINUTES: String(settings.minAgeMinutes),
  };
}

function reportStandalone(context: NativeProcessServiceContext, message: string): void {
  try {
    context.serviceHealth?.reportFailure(new Error(message));
  } catch {
    // Retired lease.
  }
}

/**
 * The Gateway's fresh context config wins over the registration snapshot; a
 * removed plugin entry disables the sweep instead of resurrecting stale config.
 */
function freshPluginConfig(contextConfig: unknown, initialPluginConfig: unknown): unknown {
  const root = asRecord(contextConfig);
  const entries = asRecord(asRecord(root?.plugins)?.entries);
  const olympus = asRecord(entries?.olympus);
  if (entries) {
    return olympus && Object.prototype.hasOwnProperty.call(olympus, 'config')
      ? olympus.config
      : undefined;
  }
  if (root && ['worker', 'email', 'sourceIndex', 'argus', 'identity', 'sovereignty']
    .some((key) => Object.prototype.hasOwnProperty.call(root, key))) {
    return root;
  }
  return initialPluginConfig;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
