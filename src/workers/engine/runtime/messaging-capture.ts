import {
  MessagingCaptureSupervisor,
  NativeMessagingCaptureOwnerError,
  defaultMessagingCaptureGrantPath,
  effectiveMessagingCaptureStatus,
  readMessagingCaptureGrantFacts,
  revokeMessagingCaptureGrant,
  type MessagingCaptureLiveness,
  type MessagingCaptureStatus,
} from '../../../core/messaging-capture.ts';
import { whatsappBridgePathForPackage } from '../../../core/messaging-pairing.ts';
import { NATIVE_CAPTURE_OWNER_ENV_NAMES } from '../../../core/native-worker-service.ts';
import { parseOptionalBooleanEnv } from '../../../core/config.ts';
import { type DashboardCaptureRuntime } from '../../source-dashboard.ts';

type MessagingCaptureSource = 'telegram' | 'whatsapp';

export type WorkerMessagingCaptureSupervisor = Pick<MessagingCaptureSupervisor, 'reconcile' | 'stop'>
  & Partial<Pick<MessagingCaptureSupervisor, 'liveness'>>;

export function createWorkerMessagingCaptureOwnership(options: {
  env?: Record<string, string | undefined>;
  registryPath: string;
  packageRoot: string;
  createSupervisor?: (source: MessagingCaptureSource) => WorkerMessagingCaptureSupervisor;
  revokeGrant?: (path: string) => void;
  shouldResumeCapture?: () => boolean;
  onResumeFailure?: (source: MessagingCaptureSource) => void;
  /** A resume after a pause worked: a failure recorded earlier no longer holds (#687). */
  onResumeSuccess?: (source: MessagingCaptureSource, status: MessagingCaptureStatus) => void;
}): {
  captures: Partial<Record<MessagingCaptureSource, WorkerMessagingCaptureSupervisor>>;
  nativeOwners: Record<MessagingCaptureSource, boolean>;
  stopForUnpair(source: MessagingCaptureSource): Promise<void>;
  withMessagingCapturePaused<T>(source: MessagingCaptureSource, operation: () => Promise<T>): Promise<T>;
} {
  const env = options.env ?? process.env;
  const nativeOwners = {
    telegram: parseOptionalBooleanEnv(
      env[NATIVE_CAPTURE_OWNER_ENV_NAMES.telegram],
      NATIVE_CAPTURE_OWNER_ENV_NAMES.telegram,
    ),
    whatsapp: parseOptionalBooleanEnv(
      env[NATIVE_CAPTURE_OWNER_ENV_NAMES.whatsapp],
      NATIVE_CAPTURE_OWNER_ENV_NAMES.whatsapp,
    ),
  };
  const createSupervisor = options.createSupervisor ?? ((source: MessagingCaptureSource) => (
    source === 'telegram'
      ? new MessagingCaptureSupervisor({ source, registryPath: options.registryPath, packageRoot: options.packageRoot })
      : new MessagingCaptureSupervisor({
          source,
          registryPath: options.registryPath,
          packageRoot: options.packageRoot,
          whatsappBridgePath: whatsappBridgePathForPackage(options.packageRoot, { env }),
        })
  ));
  const captures: Partial<Record<MessagingCaptureSource, WorkerMessagingCaptureSupervisor>> = {};
  const rawCaptures: Partial<Record<MessagingCaptureSource, WorkerMessagingCaptureSupervisor>> = {};
  const paused = { telegram: 0, whatsapp: 0 };
  const queues: Record<MessagingCaptureSource, Promise<unknown>> = { telegram: Promise.resolve(), whatsapp: Promise.resolve() };
  const serialized = <T>(source: MessagingCaptureSource, operation: () => Promise<T>): Promise<T> => {
    const result = queues[source].then(operation);
    queues[source] = result.catch(() => undefined);
    return result;
  };
  for (const source of ['telegram', 'whatsapp'] as const) {
    if (nativeOwners[source]) continue;
    const capture = createSupervisor(source);
    rawCaptures[source] = capture;
    captures[source] = {
      reconcile: async () => {
        const stopped = (): MessagingCaptureStatus => ({ source, state: 'stopped' });
        if (paused[source]) return stopped();
        return serialized(source, async () => paused[source] ? stopped() : capture.reconcile());
      },
      stop: () => serialized(source, () => capture.stop()),
      ...(capture.liveness ? { liveness: () => capture.liveness!() } : {}),
    };
  }
  const revokeGrant = options.revokeGrant ?? revokeMessagingCaptureGrant;
  return {
    captures,
    nativeOwners,
    async stopForUnpair(source) {
      if (nativeOwners[source]) throw new NativeMessagingCaptureOwnerError(source);
      const capture = rawCaptures[source];
      if (!capture) throw new Error(`Worker ${source} capture ownership is unavailable.`);
      await serialized(source, async () => {
        await capture.stop();
        revokeGrant(defaultMessagingCaptureGrantPath(source, options.registryPath));
      });
    },
    async withMessagingCapturePaused<T>(source: MessagingCaptureSource, operation: () => Promise<T>): Promise<T> {
      if (nativeOwners[source]) throw new NativeMessagingCaptureOwnerError(source);
      const capture = rawCaptures[source];
      if (!capture) throw new Error(`Worker ${source} capture ownership is unavailable.`);
      // Mark before waiting for the queue, so a timer cannot enqueue another restart.
      paused[source] += 1;
      return serialized(source, async () => {
        let stopped = false;
        try {
          await capture.stop();
          stopped = true;
          return await operation();
        } finally {
          paused[source] -= 1;
          if (stopped && !paused[source] && (options.shouldResumeCapture?.() ?? true)) {
            let resumed: MessagingCaptureStatus | undefined;
            try { resumed = await capture.reconcile(); }
            catch { options.onResumeFailure?.(source); }
            if (resumed) options.onResumeSuccess?.(source, resumed);
          }
        }
      });
    },
  };
}

/**
 * One pass over the sources this worker runs capture for. Each source is
 * reconciled on its own: one that throws (no Python, a missing executable) is
 * recorded as a failure for the dashboard and does not stop the others, and a
 * failure clears when a later reconcile succeeds. No privacy policy stops
 * capture: each captured message is tiered by its own content, like any
 * other source's items.
 */
export async function reconcileWorkerCaptures(input: {
  captures: Partial<Record<MessagingCaptureSource, WorkerMessagingCaptureSupervisor>>;
  statuses: Partial<Record<MessagingCaptureSource, MessagingCaptureStatus>>;
  failures: Partial<Record<MessagingCaptureSource, true>>;
  warn?: (message: string) => void;
}): Promise<void> {
  const warn = input.warn ?? ((message: string) => console.warn(message));
  const entries = Object.entries(input.captures) as Array<[MessagingCaptureSource, WorkerMessagingCaptureSupervisor]>;
  await Promise.all(entries.map(async ([source, capture]) => {
    try {
      input.statuses[source] = await capture.reconcile();
      delete input.failures[source];
    } catch {
      // Not reconciled: the last status is no longer a fact about the helper.
      // Said once when it starts failing, not on every 10 s pass (Sparta,
      // 14 Nov: 53 lines in 10 minutes); the dashboard keeps showing it.
      const first = !input.failures[source];
      input.failures[source] = true;
      if (first) warn('An Olympus messaging capture process needs attention. Check pairing and its approved scope.');
    }
  }));
}

/**
 * The dashboard's view of live capture on this computer, by source id: the
 * supervisor's report (corrected by whether its helper is alive and whether
 * the last reconcile failed), what the grant approved as a count, and when it
 * was granted. Only for the sources this worker runs capture for (`sources`):
 * where the native service owns capture there is no supervisor here and no
 * claim is made. A source whose grant cannot be read is reported without it,
 * never as an error: this runs while the dashboard is being built.
 */
export function workerCaptureRuntime(input: {
  sources: readonly MessagingCaptureSource[];
  statuses: Partial<Record<MessagingCaptureSource, MessagingCaptureStatus>>;
  registryPath: string | undefined;
  liveness?: Partial<Record<MessagingCaptureSource, MessagingCaptureLiveness | undefined>>;
  failures?: Partial<Record<MessagingCaptureSource, boolean>>;
}): Record<string, DashboardCaptureRuntime> {
  const runtime: Record<string, DashboardCaptureRuntime> = {};
  for (const source of input.sources) {
    try {
      const status = effectiveMessagingCaptureStatus({
        status: input.statuses[source],
        liveness: input.liveness?.[source],
        reconcileFailed: input.failures?.[source] === true,
      });
      const facts = readMessagingCaptureGrantFacts(source, defaultMessagingCaptureGrantPath(source, input.registryPath));
      if (!status && !facts.scope && !facts.pairedAt) continue;
      runtime[source === 'telegram' ? 'telegram.messages' : 'whatsapp.personal.messages'] = {
        ...(status ? { supervisor: { state: status.state, ...(status.reason ? { reason: status.reason } : {}) } } : {}),
        ...(facts.scope ? { scope: facts.scope } : {}),
        ...(facts.pairedAt ? { paired_at: facts.pairedAt } : {}),
      };
    } catch {
      // One source's damaged record never takes the dashboard down with it.
    }
  }
  return runtime;
}
