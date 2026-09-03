export type WorkerCredentialDegradationState =
  | 'retrying'
  | 'stopped'
  | 'resolved_restart_required';

export interface WorkerCredentialDegradation {
  kind: 'worker_credential_degraded';
  display_name: string;
  state: WorkerCredentialDegradationState;
  status_label: 'Credential unavailable - needs your attention';
  hint: string;
  attempts: number;
  max_attempts: number;
  next_retry_at?: string;
  affected_profiles?: string[];
  affected_capabilities?: string[];
}

export interface WorkerBootSecretResolverOptions {
  maxAttempts?: number;
  retryDelaysMs?: number[];
  now?: () => Date;
  schedule?: (run: () => void, delayMs: number) => unknown;
  cancel?: (handle: unknown) => void;
  resolveSecretRefValueSync?: (secretRef: string, env: Record<string, string | undefined>) => string | undefined;
  warn?: (message: string) => void;
}

export interface WorkerBootSecretContext {
  displayName: string;
  affectedProfiles?: string[];
  affectedCapabilities?: string[];
}

interface SecretFailureState {
  secretRef: string;
  env: Record<string, string | undefined>;
  context: WorkerBootSecretContext;
  attempts: number;
  maxAttempts: number;
  state: WorkerCredentialDegradationState;
  nextRetryAt?: string;
  scheduled: boolean;
  retryHandle?: unknown;
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAYS_MS = [30_000, 60_000];
const CREDENTIAL_HINT = 'Unlock or reconnect this credential, then restart the Olympus worker or run the credential re-check route.';

export class WorkerBootSecretResolver {
  private readonly failures = new Map<string, SecretFailureState>();
  private readonly maxAttempts: number;
  private readonly retryDelaysMs: number[];
  private readonly now: () => Date;
  private readonly schedule: (run: () => void, delayMs: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly resolveSecretRefValueSync: (secretRef: string, env: Record<string, string | undefined>) => string | undefined;
  private readonly warn: (message: string) => void;

  constructor(options: WorkerBootSecretResolverOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.now = options.now ?? (() => new Date());
    this.schedule = options.schedule ?? ((run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      timer.unref?.();
      return timer;
    });
    this.cancel = options.cancel ?? ((handle) => {
      clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
    });
    this.resolveSecretRefValueSync = options.resolveSecretRefValueSync ?? (() => undefined);
    this.warn = options.warn ?? console.warn;
  }

  resolveSync(
    secretRef: string | undefined,
    env: Record<string, string | undefined>,
    context: WorkerBootSecretContext,
  ): string | undefined {
    const ref = secretRef?.trim();
    if (!ref) {
      // A config omission is per lane, so the bucket key has to be per lane too:
      // one shared key would report every affected lane under whichever name
      // resolved first. The composed key is not a resolvable secret ref.
      const lane = context.affectedProfiles?.join(',') || context.displayName;
      this.recordFailure(`__missing_secret_ref__:${lane}`, env, context);
      return undefined;
    }
    try {
      const value = this.resolveSecretRefValueSync(ref, env)?.trim();
      if (value) {
        this.failures.delete(ref);
        return value;
      }
    } catch {
      // The failure detail can contain provider output or secret-store internals.
      // Operator status below uses only the configured display name.
    }
    this.recordFailure(ref, env, context);
    return undefined;
  }

  status(): WorkerCredentialDegradation[] {
    return [...this.failures.values()].map((failure) => {
      const item: WorkerCredentialDegradation = {
        kind: 'worker_credential_degraded',
        display_name: failure.context.displayName,
        state: failure.state,
        status_label: 'Credential unavailable - needs your attention',
        hint: failure.state === 'resolved_restart_required'
          ? 'Credential is now readable; restart the Olympus worker to re-enable the disabled lane.'
          : CREDENTIAL_HINT,
        attempts: failure.attempts,
        max_attempts: failure.maxAttempts,
      };
      if (failure.nextRetryAt) item.next_retry_at = failure.nextRetryAt;
      if (failure.context.affectedProfiles?.length) item.affected_profiles = [...failure.context.affectedProfiles];
      if (failure.context.affectedCapabilities?.length) item.affected_capabilities = [...failure.context.affectedCapabilities];
      return item;
    });
  }

  recheckNow(): WorkerCredentialDegradation[] {
    for (const failure of this.failures.values()) {
      this.tryResolveFailure(failure);
    }
    return this.status();
  }

  private recordFailure(
    secretRef: string,
    env: Record<string, string | undefined>,
    context: WorkerBootSecretContext,
  ): void {
    const existing = this.failures.get(secretRef);
    const failure: SecretFailureState = existing ?? {
      secretRef,
      env,
      context,
      attempts: 0,
      maxAttempts: Math.max(1, this.maxAttempts),
      state: 'retrying',
      scheduled: false,
    };
    failure.context = mergeContext(failure.context, context);
    this.failures.set(secretRef, failure);
    this.warn(`Olympus worker credential unavailable: ${failure.context.displayName}. The affected lane is disabled.`);
    // Several lanes can share one secretRef, so boot alone would spend the whole
    // budget before a single retry ran. Only the first failure opens the ladder;
    // from there tryResolveFailure owns the attempt accounting.
    if (existing) return;
    failure.attempts += 1;
    this.scheduleRetry(failure);
  }

  private scheduleRetry(failure: SecretFailureState): void {
    if (failure.attempts >= failure.maxAttempts) {
      failure.state = 'stopped';
      delete failure.nextRetryAt;
      failure.scheduled = false;
      // An operator re-check can reach the stop threshold while the previous
      // delay is still armed. Stopped has to mean nothing is pending, or status
      // advertises no retry while one still touches the credential store.
      this.cancelScheduledRetry(failure);
      return;
    }
    if (failure.scheduled) return;
    const delayMs = this.retryDelaysMs[Math.min(failure.attempts - 1, this.retryDelaysMs.length - 1)] ?? 60_000;
    const nextRetryAt = new Date(this.now().getTime() + delayMs).toISOString();
    failure.state = 'retrying';
    failure.nextRetryAt = nextRetryAt;
    failure.scheduled = true;
    // Bound retries aggressively to avoid background Keychain modal storms:
    // after maxAttempts this worker stops touching the credential until restart
    // or an explicit operator-triggered re-check.
    failure.retryHandle = this.schedule(() => {
      failure.scheduled = false;
      delete failure.retryHandle;
      this.tryResolveFailure(failure);
    }, delayMs);
  }

  private cancelScheduledRetry(failure: SecretFailureState): void {
    if (failure.retryHandle === undefined) return;
    const handle = failure.retryHandle;
    delete failure.retryHandle;
    this.cancel(handle);
  }

  private tryResolveFailure(failure: SecretFailureState): void {
    if (!this.failures.has(failure.secretRef)) return;
    try {
      const value = this.resolveSecretRefValueSync(failure.secretRef, failure.env)?.trim();
      failure.attempts += 1;
      if (value) {
        failure.state = 'resolved_restart_required';
        delete failure.nextRetryAt;
        failure.scheduled = false;
        return;
      }
    } catch {
      failure.attempts += 1;
    }
    this.scheduleRetry(failure);
  }
}

function mergeContext(
  existing: WorkerBootSecretContext,
  next: WorkerBootSecretContext,
): WorkerBootSecretContext {
  const merged: WorkerBootSecretContext = {
    displayName: existing.displayName,
  };
  const affectedProfiles = unique([
    ...(existing.affectedProfiles ?? []),
    ...(next.affectedProfiles ?? []),
  ]);
  const affectedCapabilities = unique([
    ...(existing.affectedCapabilities ?? []),
    ...(next.affectedCapabilities ?? []),
  ]);
  if (affectedProfiles) merged.affectedProfiles = affectedProfiles;
  if (affectedCapabilities) merged.affectedCapabilities = affectedCapabilities;
  return merged;
}

function unique(values: string[]): string[] | undefined {
  const result = [...new Set(values.filter((value) => value.trim().length > 0))];
  return result.length > 0 ? result : undefined;
}
