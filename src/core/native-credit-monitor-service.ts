import { isAbsolute } from 'node:path';
import { configFromPluginConfig } from './config.ts';
import type {
  NativeProcessServiceContext,
  NativeProcessServiceDefinition,
} from './native-process-service.ts';
import {
  VENICE_BILLING_BASE_URL,
  fetchVeniceCreditStatus,
  reconcileProviderPauseFile,
  writeReport,
  type VeniceCreditFetch,
  type VeniceCreditStatusReport,
} from './provider-credit-status.ts';

const SERVICE_ID = 'olympus-provider-credit-monitor';
const RELOAD_PREFIX = 'plugins.entries.olympus.config.worker.creditMonitor';
const API_KEY_CREDENTIAL_NAME = 'VENICE_API_KEY';

export interface NativeCreditMonitorSettings {
  enabled: boolean;
  /** The only supported provider is `venice`; anything else fails categorically. */
  provider: string;
  intervalSeconds: number;
  reportPath?: string;
  pauseFile?: string;
  credentials: Record<string, string>;
}

export interface NativeCreditMonitorServiceOptions {
  initialPluginConfig: unknown;
  /** Test seam; production uses the platform fetch. */
  fetchImpl?: VeniceCreditFetch;
  /** Test seam; production uses the validated intervalSeconds. */
  intervalMs?: number;
}

interface MonitorLifetime {
  context: NativeProcessServiceContext;
  controller: AbortController;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The tick that stop() must await; undefined once every tick has settled. */
  tick: Promise<void> | undefined;
  stopping: boolean;
}

/**
 * Supervise the Venice credit-status probe inside the Gateway process.
 *
 * Unlike the child-process services this definition spans no child: there is
 * nothing to respawn and no listener to own. What it must keep is the same
 * lifecycle discipline — one live lifetime, a tick that never overlaps its
 * predecessor, and a generation fence that refuses every write and health
 * callback belonging to a lifetime that stop() or a newer start() retired.
 */
export function createNativeCreditMonitorService(
  options: NativeCreditMonitorServiceOptions,
): NativeProcessServiceDefinition {
  let current: MonitorLifetime | undefined;
  let generation = 0;

  const isCurrent = (lifetime: MonitorLifetime): boolean =>
    current === lifetime && !lifetime.stopping;

  const reportFailure = (lifetime: MonitorLifetime, message: string): void => {
    if (!isCurrent(lifetime)) return;
    try {
      lifetime.context.serviceHealth?.reportFailure(new Error(message));
    } catch {
      // A retired host lease may throw; shutdown still wins.
    }
  };

  const clearFailure = (lifetime: MonitorLifetime): void => {
    if (!isCurrent(lifetime)) return;
    try {
      lifetime.context.serviceHealth?.clearFailure();
    } catch {
      // See reportFailure.
    }
  };

  async function tickOnce(lifetime: MonitorLifetime, settings: NativeCreditMonitorSettings): Promise<void> {
    if (!isCurrent(lifetime)) return;
    let report: VeniceCreditStatusReport;
    try {
      report = await fetchVeniceCreditStatus({
        // ONLY the explicit credential map reaches the probe: no ambient
        // process environment, and the fixed official origin, so a resolved
        // key can never be forwarded to a configurable host.
        env: { [API_KEY_CREDENTIAL_NAME]: settings.credentials[API_KEY_CREDENTIAL_NAME] },
        baseUrl: VENICE_BILLING_BASE_URL,
        signal: lifetime.controller.signal,
        ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
    } catch {
      reportFailure(lifetime, 'Olympus Venice credit monitor could not complete its billing probe.');
      return;
    }
    if (!isCurrent(lifetime)) return;
    const reportPath = settings.reportPath;
    if (!reportPath) return;
    try {
      writeReport(reportPath, report);
      if (settings.pauseFile) {
        if (!isCurrent(lifetime)) return;
        reconcileProviderPauseFile(settings.pauseFile, report);
      }
    } catch {
      reportFailure(lifetime, 'Olympus Venice credit monitor could not publish its status files.');
      return;
    }
    if (!isCurrent(lifetime)) return;
    // The status is a closed categorical set; provider text and the key never
    // reach the host health surface.
    if (report.status === 'ok') clearFailure(lifetime);
    else reportFailure(lifetime, `Olympus Venice credit monitor reported status ${report.status}.`);
  }

  async function runTick(lifetime: MonitorLifetime, settings: NativeCreditMonitorSettings): Promise<void> {
    try {
      await tickOnce(lifetime, settings);
    } catch {
      // tickOnce reports categorically; never forward a raw failure.
    } finally {
      if (!isCurrent(lifetime)) return;
      lifetime.timer = setTimeout(() => {
        lifetime.timer = undefined;
        if (!isCurrent(lifetime)) return;
        lifetime.tick = runTick(lifetime, settings);
      }, options.intervalMs ?? settings.intervalSeconds * 1_000);
      lifetime.timer.unref?.();
    }
  }

  async function stopCurrent(): Promise<void> {
    const lifetime = current;
    if (!lifetime) return;
    current = undefined;
    lifetime.stopping = true;
    if (lifetime.timer) {
      clearTimeout(lifetime.timer);
      lifetime.timer = undefined;
    }
    lifetime.controller.abort();
    try {
      await lifetime.tick;
    } catch {
      // The tick swallows its own failures; a rejected tick must not block stop.
    }
  }

  return {
    id: SERVICE_ID,
    reload: { configPrefixes: [RELOAD_PREFIX] },
    async start(context) {
      const startGeneration = ++generation;
      await stopCurrent();
      if (startGeneration !== generation) return;
      let settings: NativeCreditMonitorSettings;
      try {
        settings = configFromPluginConfig(freshPluginConfig(context.config, options.initialPluginConfig)).worker.creditMonitor;
      } catch {
        try { context.serviceHealth?.reportFailure(new Error('Olympus credit monitor configuration is invalid or contains unresolved credentials.')); } catch {}
        return;
      }
      if (!settings.enabled) return;
      const problem = creditMonitorConfigurationProblem(settings);
      if (problem) {
        try {
          context.serviceHealth?.reportFailure(new Error(problem));
        } catch {
          // Retired lease.
        }
        return;
      }
      const lifetime: MonitorLifetime = {
        context,
        controller: new AbortController(),
        timer: undefined,
        tick: undefined,
        stopping: false,
      };
      current = lifetime;
      try {
        context.logger?.info?.('Olympus Venice credit monitor is running.');
      } catch {
        // Logging is advisory; a host logger must never fail the start.
      }
      // Start returns promptly; the first tick begins immediately.
      lifetime.tick = runTick(lifetime, settings);
    },
    async stop() {
      generation += 1;
      await stopCurrent();
    },
  };
}

/** Categorical configuration problems; never the offending value. */
function creditMonitorConfigurationProblem(settings: NativeCreditMonitorSettings): string | undefined {
  if (settings.provider !== 'venice') {
    return 'Olympus credit monitor is configured with an unsupported provider.';
  }
  if (!settings.reportPath || !isAbsolute(settings.reportPath)) {
    return 'Olympus Venice credit monitor requires an absolute worker.creditMonitor.reportPath.';
  }
  if (!settings.credentials[API_KEY_CREDENTIAL_NAME]) {
    return `Olympus Venice credit monitor requires a resolved worker.creditMonitor.credentials.${API_KEY_CREDENTIAL_NAME}.`;
  }
  return undefined;
}

/**
 * The Gateway's fresh context config wins over the registration snapshot; a
 * removed plugin entry disables the monitor instead of resurrecting a stale
 * enabled config.
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

