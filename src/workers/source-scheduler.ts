import { createHash } from 'node:crypto';
import { parseSchedulerSourceIds, type OlympusConfig } from '../core/config.ts';
import { OperationError } from '../core/operation-error.ts';
import type { SourceIngestionPolicy } from '../core/source-ingestion-policy.ts';
import {
  dropboxPolicyApprovedScopeKeys,
  dropboxPolicyFullExtractionScopeKeys,
} from '../core/source-ingestion-policy.ts';
import {
  DROPBOX_FILES_CORPUS_ID,
  DROPBOX_FILES_SOURCE_ID,
} from './dropbox-files/index.ts';
import type { DropboxProviderStoreSyncHandler } from './dropbox-files/provider-store-sync.ts';
import type { FileExtractionRunner } from './file-extraction/runner.ts';
import type { LocalConnectorStore } from './connector-store/index.ts';
import {
  GMAIL_DAILY_REQUEST_GUARD_REASON,
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_DAILY_REQUEST_GUARD_REASON,
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GoogleRequestBudgetError,
  defaultGmailLiveSyncConfig,
  defaultGoogleDriveLiveSyncConfig,
  type GmailConnectorStoreSyncHandler,
  type GmailConnectorStoreTaskOutcome,
  type GmailLiveSyncConfig,
  type GoogleDriveConnectorStoreSyncHandler,
  type GoogleDriveConnectorStoreTaskOutcome,
  type GoogleDriveLiveSyncConfig,
} from './google-connectors/index.ts';
import {
  READWISE_DAILY_REQUEST_GUARD_REASON,
  READWISE_LIBRARY_CORPUS_ID,
  ReadwiseRequestBudgetError,
  defaultReadwiseLiveSyncConfig,
  type ReadwiseConnectorStoreSyncHandler,
  type ReadwiseConnectorStoreTaskOutcome,
  type ReadwiseLiveSyncConfig,
} from './readwise/index.ts';
import type { SourceEmbeddingProvider } from './source-index/embeddings.ts';
import {
  X_BOOKMARKS_CORPUS_ID,
  XBookmarksLiveSyncError,
  type XBookmarksConnectorStoreSyncHandler,
} from './x-bookmarks/index.ts';
import {
  defaultXBookmarksLiveSyncConfig,
  xBookmarksReconcileWatermarkResult,
  type XBookmarksLiveSyncConfig,
} from './x-bookmarks/live-control.ts';
import {
  WHATSAPP_EXTRACTION_SCOPE_KEY,
  WHATSAPP_LIVE_CORPUS_ID,
  WHATSAPP_PERSONAL_SOURCE_ID,
  type WhatsAppConnectorStoreSyncHandler,
} from './whatsapp/index.ts';
import { TRANSCRIPTION_EXTRACTOR_KIND } from './file-extraction/extractors/transcription.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  TELEGRAM_MESSAGES_SOURCE_ID,
  type TelegramConnectorStoreSyncHandler,
} from './telegram-messages/index.ts';
import {
  LocalSourceSchedulerStateStore,
  type PendingSourceSchedulerUnpark,
  type PersistedSourceSchedulerTaskState,
  type SourceSchedulerTaskStateKey,
} from './source-scheduler-state.ts';
import {
  CREDENTIAL_REFRESH_BUSY_RETRY_MS,
  CredentialBrokerError,
  isCredentialRefreshBusyError,
} from './credential-broker/index.ts';

export type SourceSchedulerTaskKind = 'sync' | 'extract' | 'embed' | 'watch';
export type SourceSchedulerCadence = 'manual' | 'continuous';

/**
 * A provider or corrupt persisted clock may delay one task by at most 48 hours.
 * Repeated healthy scheduler observations can extend a legitimate deferral,
 * while one poisoned timestamp cannot park a live source indefinitely.
 */
export const SOURCE_SCHEDULER_MAX_FUTURE_DEFERRAL_MS = 48 * 60 * 60 * 1_000;
export const SOURCE_SCHEDULER_SOURCE_IDS_ENV = 'OLYMPUS_WORKER_SCHEDULER_SOURCE_IDS';
const GMAIL_REQUEST_BUDGET_CLOCK_REGRESSION = 'gmail_request_budget_clock_regression';
const GOOGLE_DRIVE_REQUEST_BUDGET_CLOCK_REGRESSION = 'google_drive_request_budget_clock_regression';
const GMAIL_REQUEST_BUDGET_LEDGER_BUSY = 'gmail_request_budget_ledger_busy';
const GOOGLE_DRIVE_REQUEST_BUDGET_LEDGER_BUSY = 'google_drive_request_budget_ledger_busy';

/**
 * The scheduler/allowlist identity of every lane a factory can build, defined
 * once. An id that lives only inside its own factory cannot be checked against
 * the allowlist an operator writes: that is how `dropbox.files` was admitted
 * against a source that stamped itself `dropbox.personal` and vanished from the
 * scheduler while every gate input read true (2026-07-28).
 */
export const SCHEDULER_SOURCE_IDS = {
  gmail: 'gmail.email',
  googleDrive: 'google_drive.docs',
  dropbox: DROPBOX_FILES_SOURCE_ID,
  readwise: 'readwise.library',
  xBookmarks: 'x.bookmarks',
  telegram: TELEGRAM_MESSAGES_SOURCE_ID,
  whatsapp: WHATSAPP_PERSONAL_SOURCE_ID,
} as const;

export interface SourceSchedulerConstructionDecision {
  /** For a constructed source this is the source's OWN id, not the expected one. */
  sourceId: string;
  outcome: 'constructed' | 'skipped';
  /** A closed reason token. Never a handle, path, account, or item count. */
  reason: SourceSchedulerConstructionReason;
}

export type SourceSchedulerConstructionReason =
  | 'lane_ready'
  | 'no_handle'
  | 'lane_disabled'
  | 'handle_rebound'
  | 'no_store_sync'
  | 'no_tasks';

/**
 * The boot receipt for source construction: which lanes were built, which were
 * not and under which token, and — the line two investigations needed — the ids
 * that were selected but never constructed and the ids constructed but never
 * selected. Counts and ids only; no handles, paths, accounts, or item counts.
 *
 * The shipped boot log said only "enabled for N source(s)", where N counted
 * constructions. With a source constructed under an unselectable id that number
 * matched the allowlist size exactly while the lane was dead, and the status
 * surface reported only the admitted id it never saw. Both readings were true
 * and neither was the fact.
 *
 * An EMPTY allowlist is the fresh install's "no operator restriction", not a
 * selection of nothing. Comparing constructions against it printed every live
 * lane under `constructed_not_selected` beside `selected=0` — a receipt crying
 * wolf over the ordinary state of a machine whose sources were connected
 * through the dashboard. With no allowlist, selected IS constructed, and the
 * receipt says which rule it is reporting under.
 */
export function sourceSchedulerConstructionLogLines(input: {
  decisions: readonly SourceSchedulerConstructionDecision[];
  selectedSourceIds: readonly string[];
}): string[] {
  const constructed = input.decisions.filter((decision) => decision.outcome === 'constructed');
  const constructedIds = new Set(constructed.map((decision) => decision.sourceId));
  const unrestricted = input.selectedSourceIds.length === 0;
  const selected = unrestricted ? constructedIds : new Set(input.selectedSourceIds);
  const selectedNotConstructed = [...selected].filter((sourceId) => !constructedIds.has(sourceId));
  const constructedNotSelected = [...constructedIds].filter((sourceId) => !selected.has(sourceId));
  const summary = [
    `[source-scheduler] constructed=${constructed.length}`,
    `skipped=${input.decisions.length - constructed.length}`,
    `selected=${selected.size}`,
    ...(unrestricted ? ['selection=no_allowlist_all_constructed_selected'] : []),
    ...(selectedNotConstructed.length > 0
      ? [`selected_not_constructed=${selectedNotConstructed.join(',')}`]
      : []),
    ...(constructedNotSelected.length > 0
      ? [`constructed_not_selected=${constructedNotSelected.join(',')}`]
      : []),
  ].join(' ');
  return [
    ...input.decisions.map((decision) =>
      `[source-scheduler] source=${decision.sourceId} ${decision.outcome} reason=${decision.reason}`
    ),
    summary,
  ];
}

export interface SourceSchedulerRetryAt {
  at: string;
  effectiveIntervalMs?: number;
  degradedReason?: string;
}

/**
 * Who initiated a task run: 'operator' for on-demand runs a human triggered
 * (dashboard Sync now, admin surfaces), 'scheduled' for cadence ticks. Tasks
 * whose providers distinguish the two must treat anything that is not the
 * exact literal 'operator' as scheduled (fail closed).
 */
export type SourceSchedulerRunProvenance = 'scheduled' | 'operator';

export interface SourceSchedulerTaskRunContext {
  sourceId: string;
  corpusId: string;
  taskId: string;
  attemptedAt: string;
  consecutiveFailures: number;
  checkpoint?: string;
  lastSuccessAt?: string;
  effectiveIntervalMs: number;
  degradedReason?: string;
  provenance?: SourceSchedulerRunProvenance;
}

export interface SourceSchedulerTask {
  id: string;
  kind: SourceSchedulerTaskKind;
  writer: true;
  /**
   * Task-specific liveness. Falls back to the host lane's cadence.
   *
   * Load-bearing for a task that is grafted onto whichever lane happens to be
   * selected: the global watch pass must not inherit a manual-cadence host and
   * go dark on every tick with nothing reporting it.
   */
  cadence?: SourceSchedulerCadence;
  /** Task-specific interval. Falls back to the source interval during migration. */
  intervalMs?: number;
  /** Task-specific freshness objective. Falls back to the source threshold during migration. */
  freshnessThresholdMs?: number;
  /** Tasks sharing a key are serialized; different keys may run concurrently. */
  concurrencyKey?: string;
  /** Seeds restart-safe scheduling before this task has durable scheduler state. */
  bootstrapLastSuccessAt?(): string | undefined;
  /** Seeds a counts-only proof for externally completed work after restart. */
  bootstrapLastResult?(): SourceSchedulerTaskRunResult | undefined;
  run(context?: SourceSchedulerTaskRunContext): Promise<SourceSchedulerTaskRunResult>;
}

export interface SourceSchedulerTaskRunResult {
  status: 'progress' | 'idle';
  counts?: Record<string, number>;
  warnings?: string[];
  /** Omitted preserves the durable checkpoint; null clears it. */
  checkpoint?: string | null;
  /** A structured provider/cost guard deferral; never inferred from free-form text. */
  retryAt?: SourceSchedulerRetryAt;
}

export interface SourceSchedulerSource {
  sourceId: string;
  corpusId: string;
  cadence: SourceSchedulerCadence;
  intervalMs: number;
  freshnessThresholdHours: number;
  tasks: SourceSchedulerTask[];
  lastSyncCompletedAt?(): string | undefined;
}

export interface SourceWatchSchedulerPass {
  run(): Promise<SourceSchedulerTaskRunResult>;
}

/**
 * Adds the global watch evaluation to one already-selected source lane. This keeps
 * watches inside the existing worker scheduler without requiring another
 * timer, service, or allowlist entry.
 */
export function attachSourceWatchSchedulerTask(input: {
  sources: SourceSchedulerSource[];
  selectedSourceIds: readonly string[];
  intervalMs: number;
  pass: SourceWatchSchedulerPass;
}): SourceSchedulerSource[] {
  const selected = new Set(input.selectedSourceIds);
  const hostIndex = input.sources.findIndex((source) => selected.has(source.sourceId));
  if (hostIndex < 0) return input.sources;
  return input.sources.map((source, index) => index === hostIndex
    ? {
        ...source,
        tasks: [...source.tasks, {
          id: 'source_watches_evaluate',
          kind: 'watch',
          writer: true,
          // The control plane is global, so its liveness cannot be the host
          // lane's: a manual-cadence host would silently park every watch.
          cadence: 'continuous',
          intervalMs: input.intervalMs,
          concurrencyKey: 'source-watches.control-plane',
          run: () => input.pass.run(),
        }],
      }
    : source);
}

export interface SourceSchedulerOptions {
  enabled: boolean;
  tickMs: number;
  errorBackoffMs: number;
  maxTransientRetries: number;
  sources: SourceSchedulerSource[];
  /** Undefined is unrestricted; an explicit empty list is fail-closed. */
  allowedSourceIds?: readonly string[];
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  afterTick?: (status: SourceSchedulerStatus) => void | Promise<void>;
  stateStore?: SourceSchedulerStateStore;
  /** Consecutive zero-change runs before a lane is marked degraded. */
  zeroChangeDegradeRuns?: number;
}

export interface SourceSchedulerStateStore {
  get(key: SourceSchedulerTaskStateKey): PersistedSourceSchedulerTaskState | undefined;
  recordAttempt(input: Parameters<LocalSourceSchedulerStateStore['recordAttempt']>[0]): PersistedSourceSchedulerTaskState;
  recordSuccess(input: Parameters<LocalSourceSchedulerStateStore['recordSuccess']>[0]): PersistedSourceSchedulerTaskState;
  recordFailure(input: Parameters<LocalSourceSchedulerStateStore['recordFailure']>[0]): PersistedSourceSchedulerTaskState;
  adoptExternalSuccess?(
    input: Parameters<LocalSourceSchedulerStateStore['adoptExternalSuccess']>[0],
  ): PersistedSourceSchedulerTaskState;
  pendingUnparks?(): PendingSourceSchedulerUnpark[];
  claimUnparkAttempt?(
    input: Parameters<LocalSourceSchedulerStateStore['claimUnparkAttempt']>[0],
  ): PersistedSourceSchedulerTaskState | undefined;
}

export interface SourceSchedulerStatus {
  kind: 'source_scheduler_status';
  enabled: boolean;
  running: boolean;
  generated_at: string;
  selected_source_ids?: string[];
  missing_selected_source_ids?: string[];
  sources: SourceSchedulerSourceStatus[];
  policy: {
    raw_source_exposed: false;
    source_text_returned: false;
    source_scope_keys_exposed: false;
    counts_only: true;
  };
}

export interface SourceSchedulerSourceStatus {
  source_id: string;
  corpus_id: string;
  sync_cadence: SourceSchedulerCadence;
  sync_interval_seconds: number;
  freshness_threshold_hours: number;
  freshness_hours?: number;
  stale_sync_anomaly: boolean;
  tasks: SourceSchedulerTaskStatus[];
}

export interface SourceSchedulerTaskStatus {
  id: string;
  kind: SourceSchedulerTaskKind;
  interval_seconds?: number;
  effective_interval_seconds?: number;
  freshness_threshold_seconds?: number;
  freshness_seconds?: number;
  stale_anomaly?: boolean;
  next_run_at?: string;
  running: boolean;
  consecutive_failures: number;
  last_success_at?: string;
  last_attempt_at?: string;
  last_error_hash?: string;
  last_error_kind?: string;
  degraded_reason?: string;
  last_result?: {
    status: 'progress' | 'idle' | 'failed';
    counts?: Record<string, number>;
    warnings?: string[];
  };
}

interface SchedulerTaskState {
  task: SourceSchedulerTask;
  source: SourceSchedulerSource;
  running: boolean;
  nextRunAt: number;
  bootstrapLastSuccessAt?: string;
  checkpoint?: string;
  consecutiveFailures: number;
  lastCompletedAt?: string;
  lastSuccessAt?: string;
  lastAttemptAt?: string;
  lastErrorHash?: string;
  lastErrorKind?: string;
  effectiveIntervalMs?: number;
  degradedReason?: string;
  lastResult?: SourceSchedulerTaskStatus['last_result'];
  pendingUnpark?: PendingSourceSchedulerUnpark;
}

export class SourceSchedulerTaskFailure extends Error {
  readonly errorKind: string;
  readonly warnings: string[];
  readonly retryAt: SourceSchedulerRetryAt | undefined;
  readonly counts: Record<string, number> | undefined;

  constructor(message: string, options: {
    errorKind: string;
    warnings?: string[];
    retryAt?: SourceSchedulerRetryAt;
    counts?: Record<string, number>;
  }) {
    super(message);
    this.name = 'SourceSchedulerTaskFailure';
    this.errorKind = options.errorKind;
    this.warnings = options.warnings ?? [];
    this.retryAt = options.retryAt;
    this.counts = options.counts ? sanitizeSchedulerCounts(options.counts) : undefined;
  }
}

export class SourceScheduler {
  private readonly enabled: boolean;
  private readonly tickMs: number;
  private readonly errorBackoffMs: number;
  private readonly maxTransientRetries: number;
  private sources: SourceSchedulerSource[];
  private readonly allowedSourceIds: ReadonlySet<string> | undefined;
  private missingSelectedSourceIds: string[] = [];
  private states: SchedulerTaskState[];
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly setIntervalImpl: typeof setInterval;
  private readonly clearIntervalImpl: typeof clearInterval;
  private readonly afterTick: ((status: SourceSchedulerStatus) => void | Promise<void>) | undefined;
  private readonly stateStore: SourceSchedulerStateStore | undefined;
  private readonly zeroChangeDegradeRuns: number;
  private readonly busyConcurrencyKeys = new Set<string>();
  private pendingAfterTickStatus: SourceSchedulerStatus | undefined;
  private afterTickDrain: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly fastWakeTimers = new Map<number, ReturnType<typeof setInterval>>();

  constructor(options: SourceSchedulerOptions) {
    this.enabled = options.enabled;
    this.tickMs = options.tickMs;
    this.errorBackoffMs = options.errorBackoffMs;
    this.maxTransientRetries = options.maxTransientRetries;
    this.allowedSourceIds = options.allowedSourceIds === undefined
      ? undefined
      : new Set(options.allowedSourceIds.map(normalizeSchedulerSourceId));
    this.sources = this.filterAllowedSources(options.sources);
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.setIntervalImpl = options.setIntervalImpl ?? setInterval;
    this.clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
    this.afterTick = options.afterTick;
    this.stateStore = options.stateStore;
    this.zeroChangeDegradeRuns = options.zeroChangeDegradeRuns ?? DEFAULT_ZERO_CHANGE_DEGRADE_RUNS;
    const firstRun = this.now().getTime();
    this.states = this.sources.flatMap((source) => source.tasks.map((task) =>
      this.createTaskState(source, task, firstRun)
    ));
  }

  updateSources(sources: SourceSchedulerSource[], now: Date = this.now()): void {
    const existing = new Map(this.states.map((state) => [schedulerStateKey(state.source, state.task), state]));
    const firstRun = now.getTime();
    this.sources = this.filterAllowedSources(sources);
    this.states = this.sources.flatMap((source) => source.tasks.map((task) => {
      const previous = existing.get(schedulerStateKey(source, task));
      if (!previous) {
        return this.createTaskState(source, task, firstRun);
      }
      // Preserve object identity while a task is running. The active execution
      // and future ticks must observe one shared `running` bit across refreshes.
      previous.task = task;
      previous.source = source;
      return previous;
    }));
    if (this.timer) this.refreshFastWakeTimers();
  }

  private filterAllowedSources(sources: SourceSchedulerSource[]): SourceSchedulerSource[] {
    if (this.allowedSourceIds === undefined) return sources;
    const available = new Set(sources.map((source) => source.sourceId));
    this.missingSelectedSourceIds = [...this.allowedSourceIds].filter((sourceId) => !available.has(sourceId));
    return sources.filter((source) => this.allowedSourceIds!.has(source.sourceId));
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    this.timer = this.setIntervalImpl(() => {
      void this.runDueTasks();
    }, this.tickMs);
    this.timer.unref?.();
    this.refreshFastWakeTimers();
    void this.runDueTasks();
  }

  stop(): void {
    if (this.timer) {
      this.clearIntervalImpl(this.timer);
      this.timer = undefined;
    }
    for (const timer of this.fastWakeTimers.values()) this.clearIntervalImpl(timer);
    this.fastWakeTimers.clear();
  }

  private refreshFastWakeTimers(): void {
    const desired = new Set(this.sources.flatMap((source) => source.tasks
      .filter((task) => taskCadence(source, task) === 'continuous' && taskIntervalMs(source, task) < this.tickMs)
      .map((task) => taskIntervalMs(source, task))));
    for (const [intervalMs, timer] of this.fastWakeTimers) {
      if (desired.has(intervalMs)) continue;
      this.clearIntervalImpl(timer);
      this.fastWakeTimers.delete(intervalMs);
    }
    for (const intervalMs of desired) {
      if (this.fastWakeTimers.has(intervalMs)) continue;
      const timer = this.setIntervalImpl(() => {
        void this.runDueTasks();
      }, intervalMs);
      timer.unref?.();
      this.fastWakeTimers.set(intervalMs, timer);
    }
  }

  async runDueTasks(now: Date = this.now()): Promise<SourceSchedulerStatus> {
    if (!this.enabled) return this.status(now);
    const dueAt = now.getTime();
    this.applyPendingUnparks(dueAt);
    await this.runStates(this.states.filter((state) =>
      taskCadence(state.source, state.task) === 'continuous'
      && !state.running
      && state.nextRunAt <= dueAt
    ), dueAt, 'scheduled');
    const status = this.status(this.now());
    await this.publishAfterTick(status);
    return status;
  }

  async runSource(
    sourceIdOrCorpusId: string,
    now: Date = this.now(),
    // The caller states operator provenance explicitly; the default fails
    // closed so an unlabeled invocation is guarded like any cadence tick.
    provenance: SourceSchedulerRunProvenance = 'scheduled',
  ): Promise<SourceSchedulerStatus> {
    if (!this.enabled) return this.status(now);
    const states = this.states.filter((state) =>
      state.source.sourceId === sourceIdOrCorpusId || state.source.corpusId === sourceIdOrCorpusId
    );
    await this.runStates(states.filter((state) => !state.running), now.getTime(), provenance);
    return this.status(this.now());
  }

  status(now: Date = this.now()): SourceSchedulerStatus {
    return {
      kind: 'source_scheduler_status',
      enabled: this.enabled,
      running: this.timer !== undefined,
      generated_at: now.toISOString(),
      selected_source_ids: this.allowedSourceIds === undefined
        ? this.sources.map((source) => source.sourceId)
        : [...this.allowedSourceIds],
      missing_selected_source_ids: [...this.missingSelectedSourceIds],
      sources: this.sources.map((source) => this.sourceStatus(source, now)),
      policy: {
        raw_source_exposed: false,
        source_text_returned: false,
        source_scope_keys_exposed: false,
        counts_only: true,
      },
    };
  }

  private publishAfterTick(status: SourceSchedulerStatus): Promise<void> {
    if (!this.afterTick) return Promise.resolve();
    this.pendingAfterTickStatus = status;
    if (!this.afterTickDrain) {
      this.afterTickDrain = this.drainAfterTickStatuses().finally(() => {
        this.afterTickDrain = undefined;
      });
    }
    return this.afterTickDrain;
  }

  private async drainAfterTickStatuses(): Promise<void> {
    while (this.pendingAfterTickStatus) {
      const status = this.pendingAfterTickStatus;
      this.pendingAfterTickStatus = undefined;
      try {
        await this.afterTick!(status);
      } catch (error) {
        console.error(`[olympus:source-scheduler] after_tick_failed error_kind=${safeSchedulerErrorKind(error)}`);
      }
    }
  }

  private async runStates(
    states: SchedulerTaskState[],
    dueAt: number,
    provenance: SourceSchedulerRunProvenance,
  ): Promise<void> {
    const groups = new Map<string, SchedulerTaskState[]>();
    for (const state of states) {
      const concurrencyKey = taskConcurrencyKey(state.source, state.task);
      const group = groups.get(concurrencyKey) ?? [];
      group.push(state);
      groups.set(concurrencyKey, group);
    }

    await Promise.all([...groups.entries()].map(async ([concurrencyKey, group]) => {
      if (this.busyConcurrencyKeys.has(concurrencyKey)) return;
      this.busyConcurrencyKeys.add(concurrencyKey);
      try {
        for (const state of group) {
          if (state.running) continue;
          state.running = true;
          try {
            await this.runTask(state, dueAt, provenance);
          } finally {
            state.running = false;
          }
        }
      } finally {
        this.busyConcurrencyKeys.delete(concurrencyKey);
      }
    }));
  }

  private async runTask(
    state: SchedulerTaskState,
    dueAt: number,
    provenance: SourceSchedulerRunProvenance,
  ): Promise<void> {
    const runningTask = state.task;
    const cadenceAnchor = state.nextRunAt;
    // dueAt is only the cadence anchor. Provider usage, retry, and snapshot
    // clocks must reflect when execution actually starts (including delayed
    // ticks and UTC rollovers).
    const attemptedAt = this.now().toISOString();
    state.lastAttemptAt = attemptedAt;
    try {
      if (this.stateStore) {
        if (state.pendingUnpark && this.stateStore.claimUnparkAttempt) {
          const pendingUnpark = state.pendingUnpark;
          delete state.pendingUnpark;
          const claimed = this.stateStore.claimUnparkAttempt({
            ...pendingUnpark,
            attemptedAt,
          });
          if (!claimed) {
            const persisted = this.stateStore.get(schedulerTaskStateKey(state.source, state.task));
            if (persisted) this.applyPersistedState(state, persisted);
            state.nextRunAt = initialNextRunAt({
              persisted,
              bootstrapLastSuccessAt: state.bootstrapLastSuccessAt,
              configuredIntervalMs: taskIntervalMs(state.source, state.task),
              errorBackoffMs: this.errorBackoffMs,
              firstRun: Date.parse(attemptedAt),
            });
            return;
          }
          this.applyPersistedState(state, claimed);
        } else {
          this.applyPersistedState(state, this.stateStore.recordAttempt({
            ...schedulerTaskStateKey(state.source, state.task),
            attemptedAt,
          }));
        }
      }
      const result = await this.runWithTransientRetries(state, runningTask, attemptedAt, provenance);
      const completedAt = this.now().toISOString();
      // The streak is derived BEFORE state.lastResult is replaced, so it reads
      // the previous run's counts. It is carried inside the counts the
      // scheduler already persists, which is what makes it survive a restart
      // without a new column anywhere.
      const zeroChangeRuns = nextZeroChangeRuns(state.lastResult?.counts, result.counts);
      const normalizedResult = normalizeTaskResult(
        zeroChangeRuns === undefined
          ? result
          : { ...result, counts: { ...result.counts, zero_change_runs: zeroChangeRuns } },
      );
      const retryAt = normalizeRetryAt(result.retryAt, completedAt);
      // A structured provider deferral is the more specific explanation and
      // keeps precedence; the traversal gate fills the silence otherwise.
      const degradedReason = retryAt?.degradedReason
        ?? (zeroChangeRuns !== undefined && zeroChangeRuns >= this.zeroChangeDegradeRuns
          ? LANE_NOT_ADVANCING_DEGRADED_REASON
          : undefined);
      const configuredIntervalMs = taskIntervalMs(state.source, state.task);
      const effectiveIntervalMs = retryAt?.effectiveIntervalMs ?? configuredIntervalMs;
      const nextRunAt = retryAt?.at
        ? Date.parse(retryAt.at)
        : nextCadenceAfter(cadenceAnchor, effectiveIntervalMs, Date.parse(completedAt));

      if (this.stateStore) {
        const checkpointSupplied = Object.prototype.hasOwnProperty.call(result, 'checkpoint');
        this.applyPersistedState(state, this.stateStore.recordSuccess({
          ...schedulerTaskStateKey(state.source, state.task),
          completedAt,
          resultStatus: result.status,
          ...(normalizedResult.counts ? { counts: normalizedResult.counts } : {}),
          ...(normalizedResult.warnings ? { warnings: normalizedResult.warnings } : {}),
          ...(checkpointSupplied ? { checkpoint: result.checkpoint ?? null } : {}),
          notBeforeAt: new Date(nextRunAt).toISOString(),
          ...(retryAt?.effectiveIntervalMs ? { effectiveIntervalMs: retryAt.effectiveIntervalMs } : {}),
          ...(degradedReason ? { degradedReason } : {}),
        }));
      } else {
        state.consecutiveFailures = 0;
        delete state.lastErrorHash;
        delete state.lastErrorKind;
        state.lastCompletedAt = completedAt;
        state.lastSuccessAt = completedAt;
        state.lastResult = normalizedResult;
        if (retryAt?.effectiveIntervalMs) state.effectiveIntervalMs = retryAt.effectiveIntervalMs;
        else delete state.effectiveIntervalMs;
        if (degradedReason) state.degradedReason = degradedReason;
        else delete state.degradedReason;
        if (Object.prototype.hasOwnProperty.call(result, 'checkpoint')) {
          if (result.checkpoint === null || result.checkpoint === undefined) delete state.checkpoint;
          else state.checkpoint = result.checkpoint;
        }
      }
      state.nextRunAt = nextRunAt;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorKind = safeSchedulerErrorKind(error);
      const errorHash = hash(message);
      const warnings = safeSchedulerWarnings(error);
      const failureCounts = error instanceof SourceSchedulerTaskFailure ? error.counts : undefined;
      const completedAt = this.now().toISOString();
      const retryAt = safeNormalizeFailureRetryAt(error, completedAt, this.errorBackoffMs);
      const notBeforeAt = retryAt?.at ?? new Date(Date.parse(completedAt) + this.errorBackoffMs).toISOString();
      if (this.stateStore) {
        try {
          this.applyPersistedState(state, this.stateStore.recordFailure({
            ...schedulerTaskStateKey(state.source, state.task),
            completedAt,
            notBeforeAt,
            errorKind,
            errorHash,
            ...(warnings.length > 0 ? { warnings } : {}),
            ...(failureCounts ? { counts: failureCounts } : {}),
            ...(retryAt?.effectiveIntervalMs ? { effectiveIntervalMs: retryAt.effectiveIntervalMs } : {}),
            ...(retryAt?.degradedReason ? { degradedReason: retryAt.degradedReason } : {}),
          }));
        } catch (stateError) {
          this.applyInMemoryFailure(
            state, completedAt, errorKind, errorHash, warnings, retryAt, failureCounts,
          );
          console.error(
            `[olympus:source-scheduler] state_persist_failed source_id=${state.source.sourceId} task_id=${state.task.id} error_kind=${safeSchedulerErrorKind(stateError)}`,
          );
        }
      } else {
        this.applyInMemoryFailure(
          state, completedAt, errorKind, errorHash, warnings, retryAt, failureCounts,
        );
      }
      state.nextRunAt = Date.parse(notBeforeAt);
      console.error(
        `[olympus:source-scheduler] task_failed source_id=${state.source.sourceId} task_id=${state.task.id} error_kind=${errorKind} retry_at=${notBeforeAt} degraded_reason=${retryAt?.degradedReason ?? 'none'} error_hash=${errorHash}`,
      );
    }
  }

  private applyPendingUnparks(dueAt: number): void {
    if (!this.stateStore?.pendingUnparks) return;
    const states = new Map(this.states.map((state) => [
      schedulerStateKey(state.source, state.task),
      state,
    ]));
    for (const request of this.stateStore.pendingUnparks()) {
      const state = states.get(`${request.sourceId}\n${request.corpusId}\n${request.taskId}`);
      if (!state || state.running) continue;
      state.pendingUnpark = request;
      // One immediate run uses the normal configured interval afterward. No
      // persistent cadence field is changed by the control request.
      state.nextRunAt = Math.min(state.nextRunAt, dueAt);
    }
  }

  private async runWithTransientRetries(
    state: SchedulerTaskState,
    task: SourceSchedulerTask,
    attemptedAt: string,
    provenance: SourceSchedulerRunProvenance,
  ): Promise<SourceSchedulerTaskRunResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxTransientRetries; attempt += 1) {
      try {
        return await task.run({
          ...schedulerTaskStateKey(state.source, task),
          attemptedAt,
          consecutiveFailures: state.consecutiveFailures,
          // Only an operator run marks itself: a scheduled context stays
          // byte-identical to what tasks received before provenance existed,
          // and the X adapter reads a missing marker as scheduled (R62).
          ...(provenance === 'operator' ? { provenance } : {}),
          ...(state.checkpoint ? { checkpoint: state.checkpoint } : {}),
          ...(state.lastSuccessAt ? { lastSuccessAt: state.lastSuccessAt } : {}),
          effectiveIntervalMs: state.effectiveIntervalMs ?? taskIntervalMs(state.source, task),
          // Same expiry as the status report: a task must not be handed an
          // advisory about a budget that has already reset under it.
          ...(reportedDegradedReason(state.degradedReason, state.lastCompletedAt, new Date(attemptedAt))
            ? { degradedReason: state.degradedReason }
            : {}),
        });
      } catch (error) {
        lastError = error;
        if (safeSchedulerRetryAt(error) || !isTransientError(error) || attempt >= this.maxTransientRetries) break;
        await this.sleep(this.errorBackoffMs);
      }
    }
    throw lastError;
  }

  private createTaskState(
    source: SourceSchedulerSource,
    task: SourceSchedulerTask,
    firstRun: number,
  ): SchedulerTaskState {
    const key = schedulerTaskStateKey(source, task);
    let persisted = this.stateStore?.get(key);
    const externalBootstrapLastSuccessAt = taskBootstrapLastSuccessAt(source, task);
    const externalBootstrapMs = parseSchedulerTimestamp(externalBootstrapLastSuccessAt);
    const persistedActivityMs = Math.max(
      ...[
        persisted?.lastAttemptAt,
        persisted?.lastCompletedAt,
        persisted?.lastSuccessAt,
      ].map(parseSchedulerTimestamp).filter((value): value is number => value !== undefined),
      Number.NEGATIVE_INFINITY,
    );
    const useExternalBootstrap = externalBootstrapMs !== undefined
      && (!persisted || externalBootstrapMs > persistedActivityMs);
    const bootstrapResult = useExternalBootstrap ? task.bootstrapLastResult?.() : undefined;
    if (useExternalBootstrap && externalBootstrapLastSuccessAt
      && this.stateStore?.adoptExternalSuccess) {
      persisted = this.stateStore.adoptExternalSuccess({
        ...key,
        completedAt: externalBootstrapLastSuccessAt,
        resultStatus: bootstrapResult?.status ?? 'idle',
        ...(bootstrapResult?.counts ? { counts: bootstrapResult.counts } : {}),
        ...(bootstrapResult?.warnings ? { warnings: bootstrapResult.warnings } : {}),
      });
    }
    const bootstrapLastSuccessAt = useExternalBootstrap
      ? externalBootstrapLastSuccessAt
      : persisted?.lastSuccessAt;
    const state: SchedulerTaskState = {
      task,
      source,
      running: false,
      nextRunAt: initialNextRunAt({
        persisted,
        bootstrapLastSuccessAt,
        configuredIntervalMs: taskIntervalMs(source, task),
        errorBackoffMs: this.errorBackoffMs,
        firstRun,
      }),
      consecutiveFailures: 0,
      ...(bootstrapLastSuccessAt ? { bootstrapLastSuccessAt } : {}),
      ...(bootstrapLastSuccessAt ? { lastSuccessAt: bootstrapLastSuccessAt } : {}),
    };
    if (persisted) this.applyPersistedState(state, persisted);
    if (useExternalBootstrap && externalBootstrapLastSuccessAt
      && !this.stateStore?.adoptExternalSuccess) {
      state.bootstrapLastSuccessAt = externalBootstrapLastSuccessAt;
      state.lastSuccessAt = externalBootstrapLastSuccessAt;
      state.lastCompletedAt = externalBootstrapLastSuccessAt;
      state.consecutiveFailures = 0;
      delete state.lastErrorHash;
      delete state.lastErrorKind;
      delete state.effectiveIntervalMs;
      delete state.degradedReason;
      state.nextRunAt = initialNextRunAt({
        persisted: undefined,
        bootstrapLastSuccessAt: externalBootstrapLastSuccessAt,
        configuredIntervalMs: taskIntervalMs(source, task),
        errorBackoffMs: this.errorBackoffMs,
        firstRun,
      });
      if (bootstrapResult) state.lastResult = normalizeTaskResult(bootstrapResult);
    }
    return state;
  }

  private applyPersistedState(
    state: SchedulerTaskState,
    persisted: PersistedSourceSchedulerTaskState,
  ): void {
    state.consecutiveFailures = persisted.consecutiveFailures;
    if (persisted.checkpoint) state.checkpoint = persisted.checkpoint;
    else delete state.checkpoint;
    if (persisted.lastCompletedAt) state.lastCompletedAt = persisted.lastCompletedAt;
    else delete state.lastCompletedAt;
    if (persisted.lastSuccessAt) state.lastSuccessAt = persisted.lastSuccessAt;
    else if (state.bootstrapLastSuccessAt) state.lastSuccessAt = state.bootstrapLastSuccessAt;
    else delete state.lastSuccessAt;
    if (persisted.lastAttemptAt) state.lastAttemptAt = persisted.lastAttemptAt;
    else delete state.lastAttemptAt;
    if (persisted.lastErrorHash) state.lastErrorHash = persisted.lastErrorHash;
    else delete state.lastErrorHash;
    if (persisted.lastErrorKind) state.lastErrorKind = persisted.lastErrorKind;
    else delete state.lastErrorKind;
    if (persisted.effectiveIntervalMs) state.effectiveIntervalMs = persisted.effectiveIntervalMs;
    else delete state.effectiveIntervalMs;
    if (persisted.degradedReason) state.degradedReason = persisted.degradedReason;
    else delete state.degradedReason;
    if (persisted.lastResultStatus) {
      state.lastResult = {
        status: persisted.lastResultStatus,
        ...(persisted.lastCounts ? { counts: persisted.lastCounts } : {}),
        ...(persisted.lastWarnings ? { warnings: persisted.lastWarnings } : {}),
      };
    } else {
      delete state.lastResult;
    }
  }

  private applyInMemoryFailure(
    state: SchedulerTaskState,
    completedAt: string,
    errorKind: string,
    errorHash: string,
    warnings: string[],
    retryAt: SourceSchedulerRetryAt | undefined,
    counts?: Record<string, number>,
  ): void {
    state.consecutiveFailures += 1;
    state.lastCompletedAt = completedAt;
    state.lastErrorHash = errorHash;
    state.lastErrorKind = errorKind;
    state.lastResult = {
      status: 'failed',
      ...(counts ? { counts } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
    if (retryAt?.effectiveIntervalMs) state.effectiveIntervalMs = retryAt.effectiveIntervalMs;
    if (retryAt?.degradedReason) state.degradedReason = retryAt.degradedReason;
  }

  private sourceStatus(source: SourceSchedulerSource, now: Date): SourceSchedulerSourceStatus {
    const sourceStates = this.states.filter((state) => state.source === source);
    const taskLastSyncCompletedAt = latestCompletedAt(sourceStates
      .filter((state) => state.task.kind === 'sync')
      .map((state) => state.lastSuccessAt));
    const lastSyncCompletedAt = source.lastSyncCompletedAt?.() ?? taskLastSyncCompletedAt;
    const freshnessHours = freshnessHoursFrom(lastSyncCompletedAt, now);
    const taskStatuses = sourceStates.map((state) => this.taskStatus(state, now));
    return {
      source_id: source.sourceId,
      corpus_id: source.corpusId,
      sync_cadence: source.cadence,
      sync_interval_seconds: Math.round(source.intervalMs / 1_000),
      freshness_threshold_hours: source.freshnessThresholdHours,
      ...(freshnessHours !== undefined ? { freshness_hours: freshnessHours } : {}),
      stale_sync_anomaly: source.cadence === 'continuous' && (
        source.lastSyncCompletedAt
          ? freshnessHours === undefined || freshnessHours > source.freshnessThresholdHours
          : taskStatuses.some((task) => task.kind === 'sync' && task.stale_anomaly === true)
      ),
      tasks: taskStatuses,
    };
  }

  private taskStatus(state: SchedulerTaskState, now: Date): SourceSchedulerTaskStatus {
    const configuredIntervalMs = taskIntervalMs(state.source, state.task);
    const effectiveIntervalMs = state.effectiveIntervalMs ?? configuredIntervalMs;
    const freshnessThresholdMs = taskFreshnessThresholdMs(state.source, state.task);
    const freshnessMs = ageMsFrom(state.lastSuccessAt, now);
    return {
      id: state.task.id,
      kind: state.task.kind,
      interval_seconds: Math.round(configuredIntervalMs / 1_000),
      effective_interval_seconds: Math.round(effectiveIntervalMs / 1_000),
      freshness_threshold_seconds: Math.round(freshnessThresholdMs / 1_000),
      ...(freshnessMs !== undefined ? { freshness_seconds: Math.round(freshnessMs / 1_000) } : {}),
      stale_anomaly: taskCadence(state.source, state.task) === 'continuous'
        && (freshnessMs === undefined || freshnessMs > freshnessThresholdMs),
      ...(state.nextRunAt > 0 ? { next_run_at: new Date(state.nextRunAt).toISOString() } : {}),
      running: state.running,
      consecutive_failures: state.consecutiveFailures,
      ...(state.lastSuccessAt ? { last_success_at: state.lastSuccessAt } : {}),
      ...(state.lastAttemptAt ? { last_attempt_at: state.lastAttemptAt } : {}),
      ...(state.lastErrorHash ? { last_error_hash: state.lastErrorHash } : {}),
      ...(state.lastErrorKind ? { last_error_kind: state.lastErrorKind } : {}),
      ...(reportedDegradedReason(state.degradedReason, state.lastCompletedAt, now)
        ? { degraded_reason: state.degradedReason }
        : {}),
      ...(state.lastResult ? { last_result: state.lastResult } : {}),
    };
  }
}

export function createSourceSchedulerFromConfig(input: {
  config: OlympusConfig;
  sources: SourceSchedulerSource[];
  afterTick?: (status: SourceSchedulerStatus) => void | Promise<void>;
  stateStore?: SourceSchedulerStateStore;
}): SourceScheduler {
  return new SourceScheduler({
    enabled: input.config.worker.scheduler.enabled,
    tickMs: input.config.worker.scheduler.tickSeconds * 1_000,
    errorBackoffMs: input.config.worker.scheduler.errorBackoffSeconds * 1_000,
    maxTransientRetries: input.config.worker.scheduler.maxTransientRetries,
    sources: input.sources,
    // An empty configured allowlist is "no operator restriction", not
    // "fail closed on everything". A fresh install enables the scheduler
    // before any source is connected, so it necessarily starts empty; passing
    // the empty list straight through would leave the scheduler permanently
    // filtering out every lane the connect flow later builds. The class keeps
    // its own contract: undefined is unrestricted, an explicit empty list is
    // fail-closed, and only this config bridge maps empty to unrestricted.
    ...(input.config.worker.scheduler.sourceIds.length > 0
      ? { allowedSourceIds: input.config.worker.scheduler.sourceIds }
      : {}),
    ...(input.afterTick ? { afterTick: input.afterTick } : {}),
    ...(input.config.worker.scheduler.enabled
      ? { stateStore: input.stateStore ?? new LocalSourceSchedulerStateStore() }
      : {}),
  });
}

export function sourceSchedulerSourceIdsFromEnv(
  env: Record<string, string | undefined> = process.env,
): string[] {
  const raw = env[SOURCE_SCHEDULER_SOURCE_IDS_ENV]?.trim();
  if (!raw) return [];
  return parseSchedulerSourceIds(raw);
}

export function createCanonicalDropboxSchedulerSource(input: {
  policy: SourceIngestionPolicy;
  config: OlympusConfig;
  providerSync?: DropboxProviderStoreSyncHandler;
  store?: LocalConnectorStore;
  fileExtraction?: FileExtractionRunner;
  embeddingProvider?: SourceEmbeddingProvider;
}): SourceSchedulerSource | undefined {
  if (!input.providerSync || !input.store) return undefined;
  if (input.embeddingProvider && input.embeddingProvider.backend !== 'local') {
    throw new Error('Dropbox secure_local embeddings require a local/private embedding provider.');
  }

  const metadataScopes = dropboxPolicyApprovedScopeKeys(input.policy);
  const extractionScopes = dropboxPolicyFullExtractionScopeKeys(input.policy);
  const tasks: SourceSchedulerTask[] = [];

  for (const approvedScopeKey of metadataScopes) {
    const scopeHash = schedulerScopeHash(approvedScopeKey);
    tasks.push({
      id: `dropbox.files_store_pull.${scopeHash}`,
      kind: 'sync',
      writer: true,
      run: async (context?: SourceSchedulerTaskRunContext) => {
        const outcome = await input.providerSync!.pull({
          approved_scope_key: approvedScopeKey,
          max_items: input.policy.sync.max_entries_per_pass,
          ...(context?.checkpoint ? { checkpoint: context.checkpoint } : {}),
        });
        return {
          status: outcome.receipt.status,
          counts: outcome.receipt.counts,
          ...(outcome.receipt.warnings ? { warnings: outcome.receipt.warnings } : {}),
          checkpoint: outcome.checkpoint,
        };
      },
    });
  }

  if (input.fileExtraction) {
    for (const approvedScopeKey of extractionScopes) {
      const scopeHash = schedulerScopeHash(approvedScopeKey);
      const accountScope = accountFromApprovedScope(approvedScopeKey) ?? 'personal';
      tasks.push({
        id: `dropbox.files_extract.${scopeHash}`,
        kind: 'extract',
        writer: true,
        run: async (context?: SourceSchedulerTaskRunContext) => {
          const plan = await input.fileExtraction!.plan({
            corpusId: input.policy.corpusId,
            provider: 'dropbox',
            accountScope,
            approvedScopeKey,
            limit: input.policy.content.plan_limit,
            policyDecision: 'index_allowed',
            ...(context?.checkpoint ? { cursor: context.checkpoint } : {}),
          });
          const run = await input.fileExtraction!.run({
            corpusId: input.policy.corpusId,
            provider: 'dropbox',
            accountScope,
            approvedScopeKey,
            limit: input.policy.content.batch_size,
            preflightExtractorKinds: plan.extractorKinds,
          });
          const counts = {
            candidates_seen: plan.candidates,
            jobs_queued: plan.jobsQueued,
            jobs_existing: plan.jobsExisting,
            jobs_unroutable: plan.jobsUnroutable,
            jobs_processed: run.processedJobs,
            jobs_indexed: run.counts.indexed,
            jobs_metadata_only: run.counts.metadata_only,
            jobs_unsupported: run.counts.skipped_unsupported,
            jobs_too_large: run.counts.skipped_too_large,
            jobs_failed_retryable: run.counts.failed_retryable,
            jobs_failed_terminal: run.counts.failed_terminal,
          };
          if (run.paused) {
            throw new SourceSchedulerTaskFailure('Dropbox extraction paused at the extractor health gate.', {
              errorKind: run.preflightErrorKind ?? run.pauseReason ?? 'extractor_health_probe_failed',
              ...(run.pauseReason ? { warnings: [run.pauseReason] } : {}),
              counts,
            });
          }
          return {
            status: plan.jobsQueued > 0 || run.processedJobs > 0 ? 'progress' : 'idle',
            counts,
            checkpoint: plan.done ? null : plan.nextCursor ?? context?.checkpoint ?? null,
          };
        },
      });
    }
  }

  if (input.embeddingProvider) {
    tasks.push({
      id: 'dropbox.files_embeddings',
      kind: 'embed',
      writer: true,
      run: async () => {
        const result = await input.store!.embedChunks({ provider: input.embeddingProvider! });
        return progressFromCounts({
          chunks_seen: result.chunksSeen,
          chunks_embedded: result.chunksEmbedded,
          chunks_skipped: result.chunksSkipped,
        });
      },
    });
  }

  return {
    sourceId: SCHEDULER_SOURCE_IDS.dropbox,
    corpusId: input.policy.corpusId,
    cadence: input.policy.sync.cadence,
    intervalMs: input.config.worker.scheduler.syncIntervalSeconds * 1_000,
    freshnessThresholdHours: input.config.worker.scheduler.freshnessThresholdHours,
    tasks,
    lastSyncCompletedAt: () => {
      const completions = metadataScopes.map((scope) =>
        input.store!.lastCompletedSyncRun(input.providerSync!.connectorIdForScope(scope))?.completedAt
      );
      if (completions.some((completedAt) => completedAt === undefined)) return undefined;
      return completions.sort()[0];
    },
  };
}

function schedulerScopeHash(approvedScopeKey: string): string {
  return createHash('sha256').update(approvedScopeKey).digest('hex').slice(0, 16);
}

export function createReadwiseSchedulerSource(input: {
  config: OlympusConfig;
  liveSync?: ReadwiseConnectorStoreSyncHandler;
  liveConfig?: ReadwiseLiveSyncConfig;
}): SourceSchedulerSource | undefined {
  if (!input.liveSync) return undefined;
  const liveConfig = input.liveConfig ?? defaultReadwiseLiveSyncConfig();
  return {
    sourceId: SCHEDULER_SOURCE_IDS.readwise,
    corpusId: READWISE_LIBRARY_CORPUS_ID,
    cadence: 'continuous',
    intervalMs: input.config.worker.scheduler.syncIntervalSeconds * 1_000,
    freshnessThresholdHours: input.config.worker.scheduler.freshnessThresholdHours,
    // Both tasks deliberately share the source-default concurrency key:
    // one provider token, one daily request budget, serialized access.
    tasks: [
      {
            id: 'readwise.library_store_pull',
            kind: 'sync' as const,
            writer: true as const,
            intervalMs: liveConfig.storePullIntervalMs,
            freshnessThresholdMs: liveConfig.storePullFreshnessThresholdMs,
            run: async (context?: SourceSchedulerTaskRunContext) => {
              try {
                return readwiseStoreProgress(await input.liveSync!.pull({
                  attempted_at: context?.attemptedAt ?? new Date().toISOString(),
                  ...(context?.checkpoint ? { checkpoint: context.checkpoint } : {}),
                  max_items: liveConfig.storePullMaxItems,
                  // Only the exact operator label crosses, and only when it is
                  // present: a scheduled request stays byte-identical to what
                  // this handler received before provenance existed, and the
                  // budget reads a missing marker as scheduled (R62).
                  ...(context?.provenance === 'operator' ? { provenance: 'operator' as const } : {}),
                }));
              } catch (error) {
                throw readwiseSchedulerFailure(error);
              }
            },
      },
      {
            id: 'readwise.library_store_reconcile',
            kind: 'sync' as const,
            writer: true as const,
            intervalMs: liveConfig.storeReconcileIntervalMs,
            freshnessThresholdMs: liveConfig.storeReconcileFreshnessThresholdMs,
            run: async (context?: SourceSchedulerTaskRunContext) => {
              try {
                return readwiseStoreProgress(await input.liveSync!.reconcile({
                  attempted_at: context?.attemptedAt ?? new Date().toISOString(),
                  ...(context?.provenance === 'operator' ? { provenance: 'operator' as const } : {}),
                }));
              } catch (error) {
                throw readwiseSchedulerFailure(error);
              }
            },
      },
    ],
    lastSyncCompletedAt: () => input.liveSync?.lastStoreRunCompletedAt(),
  };
}

export function createWhatsAppSchedulerSource(input: {
  config: OlympusConfig;
  sync?: WhatsAppConnectorStoreSyncHandler;
  fileExtraction?: FileExtractionRunner;
  maxItems?: number;
  extractionPlanLimit?: number;
  extractionBatchSize?: number;
}): SourceSchedulerSource | undefined {
  if (!input.sync) return undefined;
  const tasks: SourceSchedulerTask[] = [{
    id: 'whatsapp.personal.messages_store_pull',
    kind: 'sync',
    writer: true,
    run: async () => {
      const receipt = await input.sync!.pull({
        ...(input.maxItems !== undefined ? { max_items: input.maxItems } : {}),
      });
      return {
        status: receipt.status,
        counts: receipt.counts,
        ...(receipt.warnings ? { warnings: receipt.warnings } : {}),
      };
    },
  }];
  if (input.fileExtraction) {
    tasks.push({
      id: 'whatsapp.personal.messages_extract',
      kind: 'extract',
      writer: true,
      run: async (context?: SourceSchedulerTaskRunContext) => {
        const plan = await input.fileExtraction!.plan({
          corpusId: WHATSAPP_LIVE_CORPUS_ID,
          provider: 'whatsapp',
          accountScope: 'personal',
          approvedScopeKey: WHATSAPP_EXTRACTION_SCOPE_KEY,
          limit: input.extractionPlanLimit ?? 25,
          mimeTypes: ['audio/*', 'video/*'],
          extractorKind: TRANSCRIPTION_EXTRACTOR_KIND,
          policyDecision: 'index_allowed',
          ...(context?.checkpoint ? { cursor: context.checkpoint } : {}),
        });
        const run = await input.fileExtraction!.run({
          corpusId: WHATSAPP_LIVE_CORPUS_ID,
          provider: 'whatsapp',
          accountScope: 'personal',
          approvedScopeKey: WHATSAPP_EXTRACTION_SCOPE_KEY,
          extractorKind: TRANSCRIPTION_EXTRACTOR_KIND,
          limit: input.extractionBatchSize ?? 2,
          leaseSeconds: 1_800,
        });
        return {
          status: plan.jobsQueued > 0 || run.processedJobs > 0 ? 'progress' : 'idle',
          counts: {
            candidates_seen: plan.candidates,
            jobs_queued: plan.jobsQueued,
            jobs_existing: plan.jobsExisting,
            jobs_unroutable: plan.jobsUnroutable,
            jobs_processed: run.processedJobs,
            jobs_indexed: run.counts.indexed,
            jobs_metadata_only: run.counts.metadata_only,
            jobs_unsupported: run.counts.skipped_unsupported,
            jobs_too_large: run.counts.skipped_too_large,
            jobs_failed_retryable: run.counts.failed_retryable,
            jobs_failed_terminal: run.counts.failed_terminal,
          },
          ...(run.paused && run.pauseReason ? { warnings: [run.pauseReason] } : {}),
          checkpoint: plan.done ? null : plan.nextCursor ?? context?.checkpoint ?? null,
        };
      },
    });
  }
  return {
    sourceId: SCHEDULER_SOURCE_IDS.whatsapp,
    corpusId: WHATSAPP_LIVE_CORPUS_ID,
    cadence: 'continuous',
    intervalMs: input.config.worker.scheduler.syncIntervalSeconds * 1_000,
    freshnessThresholdHours: input.config.worker.scheduler.freshnessThresholdHours,
    tasks,
    lastSyncCompletedAt: () => input.sync?.lastStoreRunCompletedAt(),
  };
}

export function createTelegramSchedulerSource(input: {
  config: OlympusConfig;
  sync?: TelegramConnectorStoreSyncHandler;
  maxItems?: number;
}): SourceSchedulerSource | undefined {
  if (!input.sync) return undefined;
  return {
    sourceId: SCHEDULER_SOURCE_IDS.telegram,
    corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    cadence: 'continuous',
    intervalMs: input.config.worker.scheduler.syncIntervalSeconds * 1_000,
    freshnessThresholdHours: input.config.worker.scheduler.freshnessThresholdHours,
    tasks: [{
      id: 'telegram.messages_store_pull',
      kind: 'sync',
      writer: true,
      run: async () => {
        const receipt = await input.sync!.pull({
          ...(input.maxItems !== undefined ? { max_items: input.maxItems } : {}),
        });
        return {
          status: receipt.status,
          counts: receipt.counts,
          ...(receipt.warnings ? { warnings: receipt.warnings } : {}),
        };
      },
    }],
    lastSyncCompletedAt: () => input.sync?.lastStoreRunCompletedAt(),
  };
}

export function createXBookmarksSchedulerSource(input: {
  config: OlympusConfig;
  liveSync?: XBookmarksConnectorStoreSyncHandler;
  liveConfig?: XBookmarksLiveSyncConfig;
}): SourceSchedulerSource | undefined {
  // Fail closed: there is only one X lane, backed by the shared connector
  // store. Without that handler there is no source to register.
  if (!input.liveSync) return undefined;
  const liveConfig = input.liveConfig ?? defaultXBookmarksLiveSyncConfig();
  return {
    sourceId: SCHEDULER_SOURCE_IDS.xBookmarks,
    corpusId: X_BOOKMARKS_CORPUS_ID,
    cadence: 'continuous',
    intervalMs: liveConfig.headIntervalMs,
    freshnessThresholdHours: liveConfig.reconcileFreshnessThresholdMs / (60 * 60_000),
    tasks: [
      {
        id: 'x.bookmarks_head',
        kind: 'sync',
        writer: true,
        intervalMs: liveConfig.headIntervalMs,
        freshnessThresholdMs: liveConfig.headFreshnessThresholdMs,
        concurrencyKey: 'x.bookmarks.head',
        run: async (context) => {
          try {
            return xBookmarksLiveProgress(await input.liveSync!.syncHead({
              attempted_at: context?.attemptedAt ?? new Date().toISOString(),
              consecutive_failures: context?.consecutiveFailures ?? 0,
              ...(context?.checkpoint ? { checkpoint: context.checkpoint } : {}),
              // Only the exact operator label crosses; everything else stays
              // fail-closed scheduled at the usage guard.
              ...(context?.provenance === 'operator' ? { provenance: 'operator' as const } : {}),
            }));
          } catch (error) {
            throw xBookmarksSchedulerFailure(error, liveConfig);
          }
        },
      },
      {
        id: 'x.bookmarks_reconcile',
        kind: 'sync',
        writer: true,
        intervalMs: liveConfig.reconcileIntervalMs,
        freshnessThresholdMs: liveConfig.reconcileFreshnessThresholdMs,
        concurrencyKey: 'x.bookmarks.reconcile',
        bootstrapLastSuccessAt: () => input.liveSync!.lastCompleteReconcileAt(),
        bootstrapLastResult: () => {
          const watermark = input.liveSync!.completeReconcileWatermark();
          return watermark ? xBookmarksReconcileWatermarkResult(watermark) : undefined;
        },
        run: async (context) => {
          try {
            return xBookmarksLiveProgress(await input.liveSync!.reconcile({
              attempted_at: context?.attemptedAt ?? new Date().toISOString(),
              consecutive_failures: context?.consecutiveFailures ?? 0,
              ...(context?.provenance === 'operator' ? { provenance: 'operator' as const } : {}),
            }));
          } catch (error) {
            throw xBookmarksSchedulerFailure(error, liveConfig);
          }
        },
      },
    ],
  };
}

export function createGmailConnectorStoreSchedulerSource(input: {
  config: OlympusConfig;
  sync?: GmailConnectorStoreSyncHandler;
  internalStore?: LocalConnectorStore;
  secureStore?: LocalConnectorStore;
  liveConfig?: GmailLiveSyncConfig;
}): SourceSchedulerSource | undefined {
  // Fail closed per lane, like Readwise, X and Drive: without the bounded
  // connector-store handler there is no Gmail lane to register at all. The
  // shipped source registered with no stores whenever anything else was
  // supplied.
  if (!input.sync) return undefined;
  const liveConfig = input.liveConfig ?? defaultGmailLiveSyncConfig();
  const lastCompletedAt = () => latestCompletedAt([
    input.internalStore?.status().lastSyncRun?.completedAt,
    input.secureStore?.status().lastSyncRun?.completedAt,
  ]);
  return {
    sourceId: SCHEDULER_SOURCE_IDS.gmail,
    corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
    cadence: 'continuous',
    intervalMs: liveConfig.storePullIntervalMs,
    freshnessThresholdHours: liveConfig.storeReconcileFreshnessThresholdMs / (60 * 60_000),
    // Both canonical tasks deliberately share the source-default concurrency key: one
    // provider token, one daily request budget, serialized access.
    tasks: [
      {
        id: 'gmail.email_store_pull',
        kind: 'sync',
        writer: true,
        intervalMs: liveConfig.storePullIntervalMs,
        freshnessThresholdMs: liveConfig.storePullFreshnessThresholdMs,
        bootstrapLastSuccessAt: lastCompletedAt,
        run: async (context?: SourceSchedulerTaskRunContext) => {
          try {
            return gmailStoreProgress(await input.sync!.pull({
              attempted_at: context?.attemptedAt ?? new Date().toISOString(),
              ...(context?.checkpoint ? { checkpoint: context.checkpoint } : {}),
              max_items: liveConfig.storePullMaxItems,
              // Only the exact operator label crosses, and only when it is
              // present: a scheduled request stays byte-identical to what this
              // handler received before provenance existed, and the budget
              // reads a missing marker as scheduled (R62).
              ...(context?.provenance === 'operator' ? { provenance: 'operator' as const } : {}),
            }));
          } catch (error) {
            throw gmailSchedulerFailure(error);
          }
        },
      },
      {
        id: 'gmail.email_store_reconcile',
        kind: 'sync',
        writer: true,
        intervalMs: liveConfig.storeReconcileIntervalMs,
        freshnessThresholdMs: liveConfig.storeReconcileFreshnessThresholdMs,
        run: async (context?: SourceSchedulerTaskRunContext) => {
          try {
            return gmailStoreProgress(await input.sync!.reconcile({
              attempted_at: context?.attemptedAt ?? new Date().toISOString(),
              ...(context?.provenance === 'operator' ? { provenance: 'operator' as const } : {}),
            }));
          } catch (error) {
            throw gmailSchedulerFailure(error);
          }
        },
      },
    ],
    lastSyncCompletedAt: lastCompletedAt,
  };
}

export function createGoogleDriveConnectorStoreSchedulerSource(input: {
  config: OlympusConfig;
  liveSync?: GoogleDriveConnectorStoreSyncHandler;
  internalStore?: LocalConnectorStore;
  secureStore?: LocalConnectorStore;
  liveConfig?: GoogleDriveLiveSyncConfig;
}): SourceSchedulerSource | undefined {
  // Fail closed per lane, like Readwise and X: without the bounded
  // connector-store handler there is no Drive lane to register at all. The
  // shipped source registered with no stores whenever anything else was
  // supplied.
  if (!input.liveSync) return undefined;
  const liveConfig = input.liveConfig ?? defaultGoogleDriveLiveSyncConfig();
  const lastCompletedAt = () => latestCompletedAt([
    input.internalStore?.status().lastSyncRun?.completedAt,
    input.secureStore?.status().lastSyncRun?.completedAt,
  ]);
  return {
    sourceId: SCHEDULER_SOURCE_IDS.googleDrive,
    corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
    cadence: 'continuous',
    intervalMs: liveConfig.storePullIntervalMs,
    freshnessThresholdHours: liveConfig.storeReconcileFreshnessThresholdMs / (60 * 60_000),
    // Both tasks deliberately share the source-default concurrency key: one
    // provider token, one daily request budget, serialized access.
    tasks: [
      {
        id: 'google_drive.docs_store_pull',
        kind: 'sync',
        writer: true,
        intervalMs: liveConfig.storePullIntervalMs,
        freshnessThresholdMs: liveConfig.storePullFreshnessThresholdMs,
        bootstrapLastSuccessAt: lastCompletedAt,
        run: async (context?: SourceSchedulerTaskRunContext) => {
          try {
            return googleDriveStoreProgress(await input.liveSync!.pull({
              attempted_at: context?.attemptedAt ?? new Date().toISOString(),
              ...(context?.checkpoint ? { checkpoint: context.checkpoint } : {}),
              max_items: liveConfig.storePullMaxItems,
              // Only the exact operator label crosses, and only when it is
              // present: a scheduled request stays byte-identical to what this
              // handler received before provenance existed, and the budget
              // reads a missing marker as scheduled (R62).
              ...(context?.provenance === 'operator' ? { provenance: 'operator' as const } : {}),
            }));
          } catch (error) {
            throw googleDriveSchedulerFailure(error);
          }
        },
      },
      {
        id: 'google_drive.docs_store_reconcile',
        kind: 'sync',
        writer: true,
        intervalMs: liveConfig.storeReconcileIntervalMs,
        freshnessThresholdMs: liveConfig.storeReconcileFreshnessThresholdMs,
        run: async (context?: SourceSchedulerTaskRunContext) => {
          try {
            return googleDriveStoreProgress(await input.liveSync!.reconcile({
              attempted_at: context?.attemptedAt ?? new Date().toISOString(),
              ...(context?.provenance === 'operator' ? { provenance: 'operator' as const } : {}),
            }));
          } catch (error) {
            throw googleDriveSchedulerFailure(error);
          }
        },
      },
    ],
    lastSyncCompletedAt: lastCompletedAt,
  };
}

function readwiseStoreProgress(
  outcome: ReadwiseConnectorStoreTaskOutcome,
): SourceSchedulerTaskRunResult {
  return {
    status: outcome.receipt.status,
    counts: outcome.receipt.counts,
    ...(outcome.receipt.warnings ? { warnings: outcome.receipt.warnings } : {}),
    // Always supplied: null clears the durable checkpoint after a completed
    // traversal, a string carries the resume point for the next bounded slice.
    checkpoint: outcome.checkpoint,
  };
}

/**
 * The daily request guard is a planned park, not a failure to retry: bridge it
 * to a structured deferral so the scheduler waits for the UTC rollover instead
 * of fail-looping the lane at the error backoff all day.
 */
function readwiseSchedulerFailure(error: unknown): SourceSchedulerTaskFailure | unknown {
  if (!(error instanceof ReadwiseRequestBudgetError)) return error;
  return new SourceSchedulerTaskFailure(error.message, {
    errorKind: READWISE_DAILY_REQUEST_GUARD_REASON,
    retryAt: {
      at: error.retryAt,
      degradedReason: READWISE_DAILY_REQUEST_GUARD_REASON,
    },
  });
}

function xBookmarksLiveProgress(result: Awaited<ReturnType<XBookmarksConnectorStoreSyncHandler['syncHead']>>): SourceSchedulerTaskRunResult {
  return {
    status: result.status,
    counts: result.counts,
    ...(result.warnings ? { warnings: result.warnings } : {}),
    ...(result.retry_at
      ? {
        retryAt: {
          at: result.retry_at.at,
          effectiveIntervalMs: result.retry_at.effective_interval_ms,
          degradedReason: result.retry_at.degraded_reason,
        },
      }
      : {}),
  };
}

function xBookmarksSchedulerFailure(
  error: unknown,
  config: XBookmarksLiveSyncConfig,
): SourceSchedulerTaskFailure | unknown {
  if (!(error instanceof XBookmarksLiveSyncError)) return error;
  return new SourceSchedulerTaskFailure(error.message, {
    errorKind: error.errorKind,
    ...(error.warnings.length > 0 ? { warnings: error.warnings } : {}),
    ...(error.counts ? { counts: error.counts } : {}),
    ...(error.retryAt
      ? {
        retryAt: {
          at: error.retryAt,
          effectiveIntervalMs: config.degradedIntervalMs,
          ...(error.degradedReason ? { degradedReason: error.degradedReason } : {}),
        },
      }
      : {}),
  });
}

function gmailStoreProgress(
  outcome: GmailConnectorStoreTaskOutcome,
): SourceSchedulerTaskRunResult {
  return {
    status: outcome.receipt.status,
    counts: outcome.receipt.counts,
    ...(outcome.receipt.warnings ? { warnings: outcome.receipt.warnings } : {}),
    // Always supplied: null clears the durable checkpoint after a completed
    // traversal, a string carries the two-lane resume envelope for the next
    // bounded slice.
    checkpoint: outcome.checkpoint,
  };
}

/**
 * The daily request guard is a planned park, not a failure to retry: bridge it
 * to a structured deferral so the scheduler waits for the UTC rollover instead
 * of fail-looping the lane at the error backoff all day.
 */
function gmailSchedulerFailure(error: unknown): SourceSchedulerTaskFailure | unknown {
  if (!(error instanceof GoogleRequestBudgetError)) return error;
  const errorKind = error.reason === 'future_utc_day'
    ? GMAIL_REQUEST_BUDGET_CLOCK_REGRESSION
    : error.reason === 'ledger_busy'
      ? GMAIL_REQUEST_BUDGET_LEDGER_BUSY
      : GMAIL_DAILY_REQUEST_GUARD_REASON;
  return new SourceSchedulerTaskFailure(error.message, {
    errorKind,
    retryAt: {
      at: error.retryAt,
      degradedReason: errorKind,
    },
  });
}

function googleDriveStoreProgress(
  outcome: GoogleDriveConnectorStoreTaskOutcome,
): SourceSchedulerTaskRunResult {
  return {
    status: outcome.receipt.status,
    counts: outcome.receipt.counts,
    ...(outcome.receipt.warnings ? { warnings: outcome.receipt.warnings } : {}),
    // Always supplied: null clears the durable checkpoint after a completed
    // traversal, a string carries the resume point for the next bounded slice.
    checkpoint: outcome.checkpoint,
  };
}

/**
 * The daily request guard is a planned park, not a failure to retry: bridge it
 * to a structured deferral so the scheduler waits for the UTC rollover instead
 * of fail-looping the lane at the error backoff all day.
 */
function googleDriveSchedulerFailure(error: unknown): SourceSchedulerTaskFailure | unknown {
  if (!(error instanceof GoogleRequestBudgetError)) return error;
  const errorKind = error.reason === 'future_utc_day'
    ? GOOGLE_DRIVE_REQUEST_BUDGET_CLOCK_REGRESSION
    : error.reason === 'ledger_busy'
      ? GOOGLE_DRIVE_REQUEST_BUDGET_LEDGER_BUSY
      : GOOGLE_DRIVE_DAILY_REQUEST_GUARD_REASON;
  return new SourceSchedulerTaskFailure(error.message, {
    errorKind,
    retryAt: {
      at: error.retryAt,
      degradedReason: errorKind,
    },
  });
}

function progressFromCounts(counts: Record<string, number>): SourceSchedulerTaskRunResult {
  return {
    status: Object.values(counts).some((value) => value > 0) ? 'progress' : 'idle',
    counts,
  };
}

function normalizeTaskResult(result: SourceSchedulerTaskRunResult): NonNullable<SourceSchedulerTaskStatus['last_result']> {
  return {
    status: result.status,
    ...(result.counts ? { counts: sanitizeSchedulerCounts(result.counts) } : {}),
    ...(result.warnings && result.warnings.length > 0 ? { warnings: sanitizeSchedulerWarnings(result.warnings) } : {}),
  };
}

/**
 * Length of the zero-change streak that marks a lane as not advancing.
 *
 * Five, because the two lane shapes this has to be honest about pull in
 * opposite directions. A bounded pull lane runs every 30-120 minutes, so five
 * runs flags a stuck traversal within a working day rather than after one. A
 * daily full reconcile runs once, so five runs means five consecutive whole-
 * corpus snapshots that changed nothing — a quiet week, not a quiet weekend.
 * Anything below three would fire on the second shape routinely; anything much
 * above five stops being an alarm on the first.
 *
 * The idle protection is structural rather than numeric: a lane that sees no
 * items does not increment the streak at all, at any N. The streak only grows
 * when the lane spent provider I/O and produced nothing.
 *
 * Degrading is advisory — it marks the lane in status and in the run context,
 * and does not change cadence or stop work — so the cost of a false positive
 * is a flag, never freshness. It clears on the first run that changes anything.
 */
const DEFAULT_ZERO_CHANGE_DEGRADE_RUNS = 5;
export const LANE_NOT_ADVANCING_DEGRADED_REASON = 'traversal_not_advancing';

/**
 * The streak of consecutive completed runs that saw items and changed none.
 *
 * Returns undefined for a lane that does not report both counts: participation
 * is by reporting `items_changed`, so no lane is judged by a signal it does not
 * publish. Source-generic by construction — it reads two count keys and knows
 * nothing about any family.
 */
function nextZeroChangeRuns(
  previous: Record<string, number> | undefined,
  current: Record<string, number> | undefined,
): number | undefined {
  const seen = current?.['items_seen'];
  const changed = current?.['items_changed'];
  if (seen === undefined || changed === undefined) return undefined;
  if (seen === 0 || changed > 0) return 0;
  return (previous?.['zero_change_runs'] ?? 0) + 1;
}

function sanitizeSchedulerCounts(counts: Record<string, number>): Record<string, number> {
  const safe: Record<string, number> = {};
  for (const [key, count] of Object.entries(counts)) {
    if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(key)) continue;
    if (!Number.isSafeInteger(count) || count < 0) continue;
    safe[key] = count;
  }
  return safe;
}

function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|busy|timeout|temporar|network|connection|ECONN|rate.?limit|too many requests|try again/i.test(message);
}

function freshnessHoursFrom(value: string | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > now.getTime() + SOURCE_SCHEDULER_MAX_FUTURE_DEFERRAL_MS) {
    return undefined;
  }
  return Math.max(0, Math.round(((now.getTime() - timestamp) / 3_600_000) * 10) / 10);
}

function ageMsFrom(value: string | undefined, now: Date): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp > now.getTime() + SOURCE_SCHEDULER_MAX_FUTURE_DEFERRAL_MS) {
    return undefined;
  }
  return Math.max(0, now.getTime() - timestamp);
}

function taskCadence(
  source: SourceSchedulerSource,
  task: SourceSchedulerTask,
): SourceSchedulerCadence {
  return task.cadence ?? source.cadence;
}

function taskIntervalMs(source: SourceSchedulerSource, task: SourceSchedulerTask): number {
  const intervalMs = task.intervalMs ?? source.intervalMs;
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new TypeError(`Source scheduler task ${task.id} intervalMs must be a positive safe integer.`);
  }
  return intervalMs;
}

function taskFreshnessThresholdMs(source: SourceSchedulerSource, task: SourceSchedulerTask): number {
  const thresholdMs = task.freshnessThresholdMs ?? Math.round(source.freshnessThresholdHours * 3_600_000);
  if (!Number.isSafeInteger(thresholdMs) || thresholdMs <= 0) {
    throw new TypeError(`Source scheduler task ${task.id} freshnessThresholdMs must be a positive safe integer.`);
  }
  return thresholdMs;
}

function taskConcurrencyKey(source: SourceSchedulerSource, task: SourceSchedulerTask): string {
  const concurrencyKey = task.concurrencyKey?.trim() || source.corpusId;
  if (concurrencyKey.length > 256) {
    throw new TypeError(`Source scheduler task ${task.id} concurrencyKey must be at most 256 characters.`);
  }
  return concurrencyKey;
}

function normalizeSchedulerSourceId(value: string): string {
  const sourceId = value.trim();
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(sourceId)) {
    throw new TypeError(`${SOURCE_SCHEDULER_SOURCE_IDS_ENV} contains an invalid source id.`);
  }
  return sourceId;
}

function taskBootstrapLastSuccessAt(
  _source: SourceSchedulerSource,
  task: SourceSchedulerTask,
): string | undefined {
  const candidate = task.bootstrapLastSuccessAt?.();
  return candidate && Number.isFinite(Date.parse(candidate)) ? candidate : undefined;
}

function schedulerTaskStateKey(
  source: SourceSchedulerSource,
  task: SourceSchedulerTask,
): SourceSchedulerTaskStateKey {
  return {
    sourceId: source.sourceId,
    corpusId: source.corpusId,
    taskId: task.id,
  };
}

function initialNextRunAt(input: {
  persisted: PersistedSourceSchedulerTaskState | undefined;
  bootstrapLastSuccessAt: string | undefined;
  configuredIntervalMs: number;
  errorBackoffMs: number;
  firstRun: number;
}): number {
  const lastAttempt = parseSchedulerTimestamp(input.persisted?.lastAttemptAt);
  const lastCompleted = parseSchedulerTimestamp(input.persisted?.lastCompletedAt);
  if (input.persisted?.attemptPending === true && lastAttempt !== undefined
    && (lastCompleted === undefined || lastAttempt >= lastCompleted)) {
    return boundFutureSchedule(lastAttempt + input.errorBackoffMs, input.firstRun);
  }

  const persistedNotBefore = parseSchedulerTimestamp(input.persisted?.notBeforeAt);
  if (persistedNotBefore !== undefined) {
    return boundFutureSchedule(persistedNotBefore, input.firstRun);
  }

  const cadenceAnchor = lastCompleted
    ?? parseSchedulerTimestamp(input.persisted?.lastSuccessAt)
    ?? parseSchedulerTimestamp(input.bootstrapLastSuccessAt);
  if (cadenceAnchor === undefined) return input.firstRun;
  return boundFutureSchedule(
    cadenceAnchor + (input.persisted?.effectiveIntervalMs ?? input.configuredIntervalMs),
    input.firstRun,
  );
}

function boundFutureSchedule(candidate: number, now: number): number {
  return Math.min(candidate, now + SOURCE_SCHEDULER_MAX_FUTURE_DEFERRAL_MS);
}

function nextCadenceAfter(anchor: number, intervalMs: number, completedAt: number): number {
  const elapsedIntervals = Math.floor(Math.max(0, completedAt - anchor) / intervalMs);
  return anchor + (elapsedIntervals + 1) * intervalMs;
}

function parseSchedulerTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function normalizeRetryAt(
  retryAt: SourceSchedulerRetryAt | undefined,
  completedAt: string,
): SourceSchedulerRetryAt | undefined {
  if (!retryAt) return undefined;
  const completedTimestamp = Date.parse(completedAt);
  const retryTimestamp = Date.parse(retryAt.at);
  if (!Number.isFinite(retryTimestamp)) {
    throw new TypeError('Source scheduler retryAt.at must be a valid timestamp.');
  }
  if (retryAt.effectiveIntervalMs !== undefined
    && (!Number.isSafeInteger(retryAt.effectiveIntervalMs) || retryAt.effectiveIntervalMs <= 0)) {
    throw new TypeError('Source scheduler retryAt.effectiveIntervalMs must be a positive safe integer.');
  }
  if (retryAt.degradedReason !== undefined
    && !/^[a-z0-9][a-z0-9._:-]{0,127}$/.test(retryAt.degradedReason)) {
    throw new TypeError('Source scheduler retryAt.degradedReason must be a safe categorical token.');
  }
  return {
    at: new Date(Math.min(
      Math.max(completedTimestamp, retryTimestamp),
      completedTimestamp + SOURCE_SCHEDULER_MAX_FUTURE_DEFERRAL_MS,
    )).toISOString(),
    ...(retryAt.effectiveIntervalMs !== undefined
      ? { effectiveIntervalMs: Math.min(retryAt.effectiveIntervalMs, SOURCE_SCHEDULER_MAX_FUTURE_DEFERRAL_MS) }
      : {}),
    ...(retryAt.degradedReason ? { degradedReason: retryAt.degradedReason } : {}),
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Explicit connector error kinds that survive as themselves.
 *
 * Every other explicit kind is normalized into a transient class or the
 * untyped `task_failed`. Collapsing these three too made a refusal
 * indistinguishable from a real failure by kind alone, so the health monitor
 * and the X activation gate had to read `degraded_reason` as a fallback --
 * a marker a later run can leave stale, and therefore a way to launder a real
 * failure into "the guard declined it" (2026-07-26 register, live on
 * 2026-07-27). Safe categorical tokens only, matched exactly: they must pass
 * the scheduler state store's token check and never carry provider text.
 *
 * - api_request_guard: the connector's own budget/quota refusal. The specific
 *   XApiUsageGuardKind still rides in degraded_reason as detail, but the
 *   refusal itself is now typed.
 * - reconcile_incomplete: a bounded traversal, a real failure that must never
 *   read as a refusal.
 * - readwise_daily_api_request_guard: the Readwise daily budget park.
 */
const HONEST_SCHEDULER_ERROR_KINDS: ReadonlySet<string> = new Set([
  'api_request_guard',
  'config_missing_folder_argument',
  'credential_missing',
  'credential_reauth_required',
  'credential_refresh_busy',
  'credential_session_latched',
  'reconcile_incomplete',
  READWISE_DAILY_REQUEST_GUARD_REASON,
  GMAIL_DAILY_REQUEST_GUARD_REASON,
  GOOGLE_DRIVE_DAILY_REQUEST_GUARD_REASON,
  GMAIL_REQUEST_BUDGET_CLOCK_REGRESSION,
  GOOGLE_DRIVE_REQUEST_BUDGET_CLOCK_REGRESSION,
  GMAIL_REQUEST_BUDGET_LEDGER_BUSY,
  GOOGLE_DRIVE_REQUEST_BUDGET_LEDGER_BUSY,
]);

/**
 * Degradation markers whose meaning is scoped to one UTC day.
 *
 * Every one of these is a daily budget/quota guard, and every one of those
 * budgets resets at the UTC rollover -- so a marker minted for an earlier day
 * says nothing about today's budget. Readers must therefore treat it as absent
 * once the day has rolled over, whether or not the task has run again. Waiting
 * for the next run is what produced the live 2026-07-27 bug: a marker left by
 * yesterday's run degraded every deploy (`advisory_degraded_reason`) until some
 * later run happened to clear it, and a task that simply is not running never
 * clears anything.
 *
 * Deliberately excludes `provider_rate_limit` and every `x_reconcile_*` marker.
 * Those are not day-scoped -- a rate limit expires on its own reset clock and a
 * reconcile marker describes a structural condition that midnight does not
 * repair -- so expiring them would hide a live fault rather than a stale one.
 */
const UTC_DAY_SCOPED_DEGRADED_REASONS: ReadonlySet<string> = new Set([
  'daily_api_request_guard',
  'daily_resource_read_guard',
  'daily_cost_guard',
  'head_api_request_reserve_guard',
  'head_resource_read_reserve_guard',
  'head_cost_reserve_guard',
  READWISE_DAILY_REQUEST_GUARD_REASON,
  GMAIL_DAILY_REQUEST_GUARD_REASON,
  GOOGLE_DRIVE_DAILY_REQUEST_GUARD_REASON,
]);

/**
 * The degradation marker a reader should see, with an expired day-scoped
 * budget advisory reported as absent.
 *
 * The mint day is the completion that asserted the marker: `degradedReason` is
 * only ever written by the same state update that writes `lastCompletedAt`, so
 * an advisory from a run on an earlier UTC day has outlived its budget.
 *
 * Expiry is strictly-before, never not-equal. A marker minted under a clock
 * that runs ahead sits on a *later* day and keeps degrading, so clock skew can
 * never be laundered into an expiry -- the case the activation gate's
 * `hold:reconcile_clock_ahead` guard exists to catch. An unparseable or absent
 * completion cannot establish a mint day, so the marker is kept.
 */
function reportedDegradedReason(
  degradedReason: string | undefined,
  lastCompletedAt: string | undefined,
  now: Date,
): string | undefined {
  if (!degradedReason || !UTC_DAY_SCOPED_DEGRADED_REASONS.has(degradedReason)) return degradedReason;
  const mintedOn = lastCompletedAt ? utcDayOf(Date.parse(lastCompletedAt)) : undefined;
  const today = utcDayOf(now.getTime());
  if (mintedOn === undefined || today === undefined) return degradedReason;
  return mintedOn < today ? undefined : degradedReason;
}

function utcDayOf(timestamp: number): string | undefined {
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString().slice(0, 10) : undefined;
}

function safeSchedulerErrorKind(error: unknown): string {
  if (error instanceof SourceSchedulerTaskFailure) return mapExplicitSchedulerErrorKind(error.errorKind);
  if (isCredentialRefreshBusyError(error)) {
    return 'credential_refresh_busy';
  }
  if (error instanceof CredentialBrokerError && error.code === 'credential_refresh_failed') {
    return 'credential_session_latched';
  }
  if (error instanceof CredentialBrokerError
    && (error.code === 'credential_reauth_required' || error.code === 'credential_missing')) {
    return error.code;
  }
  // The embedding provider's fixed prose keeps the connect detail in the
  // OperationError suggestion, so the message regexes below never see
  // "connection"/"ECONN" and the outage read as untyped task_failed — which
  // spent 2026-08-20 misattributed to credentials while the real fault was a
  // retired tunnel port. Matched on our own prose prefix, never provider text.
  if (error instanceof OperationError && error.code === 'source_index_error'
    && error.message.startsWith('Local source embedding endpoint ')) {
    return 'embedding_backend_unavailable';
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/vlm_backend_unavailable/i.test(message)) return 'vlm_backend_unavailable';
  if (/SQLITE_BUSY|busy/i.test(message)) return 'sqlite_busy';
  if (/timeout/i.test(message)) return 'timeout';
  if (/rate.?limit|too many requests/i.test(message)) return 'rate_limited';
  if (/network|connection|ECONN/i.test(message)) return 'network';
  if (/temporar|try again/i.test(message)) return 'temporary';
  return 'task_failed';
}

function mapExplicitSchedulerErrorKind(value: string): string {
  if (HONEST_SCHEDULER_ERROR_KINDS.has(value)) return value;
  if (/vlm_backend_unavailable/i.test(value)) return 'vlm_backend_unavailable';
  if (/SQLITE_BUSY|sqlite.?busy|\bbusy\b/i.test(value)) return 'sqlite_busy';
  if (/timeout/i.test(value)) return 'timeout';
  if (/rate.?limit|too many requests/i.test(value)) return 'rate_limited';
  if (/network|connection|ECONN/i.test(value)) return 'network';
  if (/temporar|try again/i.test(value)) return 'temporary';
  return 'task_failed';
}

function safeSchedulerWarnings(error: unknown): string[] {
  if (error instanceof SourceSchedulerTaskFailure) return sanitizeSchedulerWarnings(error.warnings);
  return [];
}

function safeSchedulerRetryAt(
  error: unknown,
  completedAt?: string,
  fallbackRetryAfterMs: number = CREDENTIAL_REFRESH_BUSY_RETRY_MS,
): SourceSchedulerRetryAt | undefined {
  if (error instanceof SourceSchedulerTaskFailure) return error.retryAt;
  if (isCredentialRefreshBusyError(error)) {
    const completedTimestamp = completedAt ? Date.parse(completedAt) : Date.now();
    return {
      at: new Date(
        completedTimestamp + (error.retryAfterMs ?? CREDENTIAL_REFRESH_BUSY_RETRY_MS),
      ).toISOString(),
      degradedReason: 'credential_refresh_busy',
    };
  }
  if (error instanceof CredentialBrokerError
    && (error.code === 'credential_reauth_required' || error.code === 'credential_missing')) {
    const completedTimestamp = completedAt ? Date.parse(completedAt) : Date.now();
    return {
      at: new Date(completedTimestamp + fallbackRetryAfterMs).toISOString(),
      degradedReason: error.code,
    };
  }
  return undefined;
}

function safeNormalizeFailureRetryAt(
  error: unknown,
  completedAt: string,
  fallbackRetryAfterMs: number,
): SourceSchedulerRetryAt | undefined {
  try {
    return normalizeRetryAt(safeSchedulerRetryAt(error, completedAt, fallbackRetryAfterMs), completedAt);
  } catch {
    return undefined;
  }
}

function safeBackendUnavailableWarnings(warnings: readonly string[] | undefined): string[] {
  if (!warnings?.some((warning) => /vlm_backend_unavailable/i.test(warning))) return [];
  return ['vlm_backend_unavailable'];
}

function sanitizeSchedulerWarnings(warnings: readonly string[]): string[] {
  return [...new Set(warnings.map((warning) => {
    if (/^x_(?:head|reconcile)_[a-z0-9_]+$/.test(warning)) return warning;
    if (/vlm_backend_unavailable/i.test(warning)) return 'vlm_backend_unavailable';
    if (/timeout/i.test(warning)) return 'timeout';
    if (/rate.?limit|too many requests/i.test(warning)) return 'rate_limited';
    if (/network|connection|ECONN/i.test(warning)) return 'network';
    return 'task_warning';
  }))];
}

function latestCompletedAt(values: Array<string | undefined>): string | undefined {
  return values
    .filter((value): value is string => !!value)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
}

function schedulerStateKey(source: SourceSchedulerSource, task: SourceSchedulerTask): string {
  return `${source.sourceId}\n${source.corpusId}\n${task.id}`;
}

function accountFromApprovedScope(scope: string | undefined): string | undefined {
  const match = /^dropbox\.([a-z0-9_-]+):/i.exec(scope ?? '');
  return match?.[1];
}
