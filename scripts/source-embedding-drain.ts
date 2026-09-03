import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { loadConfig, normalizeSourceWorkerBaseUrl } from '../src/core/config.ts';
import { loadSovereigntyEngine } from '../src/core/sovereignty.ts';
import { resolveSecretRefValueSync } from '../src/core/secret-store.ts';
import { withWorkerAuthHeader, workerAuthTokenFromConfig } from '../src/core/worker-auth.ts';
import {
  DROPBOX_CONNECTOR_STORE_DB_PATH_ENV,
  defaultDropboxConnectorStoreDbPath,
} from '../src/workers/dropbox-files/index.ts';
import {
  createSourceIndexEmbeddingProviderFromEnv,
  createSourceIndexEmbeddingProviderFromSovereignty,
} from '../src/workers/email-source/server.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { defaultXBookmarksConnectorStoreDbPath } from '../src/workers/x-bookmarks/index.ts';
import { defaultReadwiseConnectorStoreDbPath } from '../src/workers/readwise/index.ts';
import {
  recordEmbeddingLedgerObservations,
  type EmbeddingCorpusObservation,
} from '../src/workers/embedding-ledger-observer.ts';
import { resolveEmbeddingLedgerPath } from '../src/workers/embedding-ledger.ts';
import {
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  defaultGmailSecureConnectorStoreDbPath,
  defaultGoogleDriveConnectorStoreDbPath,
} from '../src/workers/google-connectors/index.ts';
import {
  defaultInternalTelegramConnectorStoreDbPath,
  defaultProtectedTelegramConnectorStoreDbPath,
} from '../src/workers/telegram-messages/index.ts';
import { defaultWhatsAppConnectorStoreDbPath } from '../src/workers/whatsapp/index.ts';
import { WorkerBootSecretResolver } from '../src/workers/credential-degradation.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import type { SourceTrustDomain } from '../src/core/source-index/types.ts';

const DROPBOX_CORPUS_ID = 'secure_local.dropbox.files' as const;
const EMAIL_CORPUS_ID = GMAIL_SECURE_CONNECTOR_CORPUS_ID;
const WHATSAPP_CORPUS_ID = 'secure_local.whatsapp.messages' as const;
const X_BOOKMARKS_CORPUS_ID = 'internal.x.bookmarks' as const;
const INTERNAL_TELEGRAM_CORPUS_ID = 'internal.telegram.messages' as const;
const PROTECTED_TELEGRAM_CORPUS_ID = 'secure_local.telegram.protected.messages' as const;
const READWISE_CORPUS_ID = 'internal.readwise.library' as const;
const DRIVE_INTERNAL_CORPUS_ID = GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID;
const ACTIVE_EMBEDDING_CORPUS_IDS = [
  DROPBOX_CORPUS_ID,
  EMAIL_CORPUS_ID,
  WHATSAPP_CORPUS_ID,
  X_BOOKMARKS_CORPUS_ID,
  INTERNAL_TELEGRAM_CORPUS_ID,
  PROTECTED_TELEGRAM_CORPUS_ID,
  READWISE_CORPUS_ID,
  DRIVE_INTERNAL_CORPUS_ID,
] as const;
type ActiveEmbeddingCorpusId = (typeof ACTIVE_EMBEDDING_CORPUS_IDS)[number];

const DEFAULT_WORKER_ID = 'source-embedding-drain';
const DEFAULT_IDLE_SLEEP_SECONDS = 15;
const DEFAULT_ERROR_BACKOFF_SECONDS = 60;
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_PROGRESS_HEARTBEAT_SECONDS = 15;
/**
 * Five minutes between ledger observations.
 *
 * A coverage read counts every chunk and every current embedding in each open
 * store, which on a corpus the size of Dropbox is real work. Pass boundaries
 * come far more often than the transitions the ledger records, so the floor
 * costs nothing a reader would notice and keeps the drain's own throughput.
 */
const DEFAULT_LEDGER_OBSERVATION_INTERVAL_SECONDS = 300;

export interface DropboxEmbeddingResult {
  chunks_seen?: number;
  chunks_embedded?: number;
  chunks_skipped?: number;
  status?: string;
}

export interface CorpusEmbeddingRequest {
  corpus_id: ActiveEmbeddingCorpusId;
  max_pending_chunks?: number;
}

/** What one connector store holds, for the embedding decision ledger. */
export interface SourceEmbeddingCorpusCoverage {
  corpusId: ActiveEmbeddingCorpusId;
  trustDomain: Extract<SourceTrustDomain, 'internal' | 'secure_local'>;
  embeddedChunks: number;
  missingChunks: number;
}

/** The embedding configuration one trust domain is running with right now. */
export interface SourceEmbeddingLaneConfig {
  modelId: string;
  epoch: string;
  endpoint?: string;
}

export interface SourceEmbeddingDrainCoverage {
  secureLocal?: SourceEmbeddingLaneConfig;
  internal?: SourceEmbeddingLaneConfig;
  corpora: SourceEmbeddingCorpusCoverage[];
}

export interface SourceEmbeddingDrainClient {
  embedConnectorStore(request: CorpusEmbeddingRequest): Promise<DropboxEmbeddingResult>;
  /**
   * Coverage for the ledger observer, from the stores this client already has
   * open. Direct mode only — over HTTP the drain never touches a database and
   * has nothing to observe, so the method is absent and nothing is recorded.
   */
  observeCoverage?(): SourceEmbeddingDrainCoverage;
  close?(): void;
}

export interface SourceEmbeddingDrainLane {
  corpusId: ActiveEmbeddingCorpusId;
  /**
   * This lane's identity within the roster, defaulting to `corpusId`. Set it
   * only when an operator intentionally defines more than one lane for a
   * corpus.
   */
  laneId?: string;
  trustDomain: Extract<SourceTrustDomain, 'internal' | 'secure_local'>;
  targetKeys: string[];
  cadencePasses: number;
  maxPendingChunks?: number;
  embed(targetKey: string, maxPendingChunks: number | undefined): Promise<DropboxEmbeddingResult>;
}

export interface SourceEmbeddingDrainOptions {
  client: SourceEmbeddingDrainClient;
  now?: Date;
  lanes?: SourceEmbeddingDrainLane[];
  workerId?: string;
  maxPendingChunks?: number;
  maxRuns?: number;
  maxRuntimeSeconds?: number;
  idleSleepMs?: number;
  errorBackoffMs?: number;
  maxConsecutiveFailures?: number;
  stopWhenIdle?: boolean;
  progressHeartbeatMs?: number;
  onProgress?: (report: SourceEmbeddingDrainReport) => void;
  /**
   * Write what the corpora currently look like into the embedding ledger.
   *
   * Called at ROUND-ROBIN PASS boundaries and once more when the drain exits —
   * never per batch. A re-embed is thousands of batches spread over days, and
   * the ledger's unit is the transition ("this corpus started", "this corpus
   * finished"), not the batch; see the embedding-ledger-observer header.
   *
   * Recording only. This hook can never change what the drain embeds, and a
   * failure to write the record is counted and dropped rather than raised: an
   * unwritable ledger must not stop the work it is a record of.
   */
  recordLedgerObservations?: () => Promise<void>;
  /** Floor between pass-boundary observations. Defaults to five minutes. */
  ledgerObservationIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SourceEmbeddingDrainReport {
  kind: 'source_embedding_drain_report';
  generated_at: string;
  updated_at: string;
  corpus_id: typeof DROPBOX_CORPUS_ID;
  corpus_ids?: ActiveEmbeddingCorpusId[];
  status: 'progress' | 'idle' | 'attention';
  run_state: 'running' | 'complete';
  active_phase: 'starting' | 'embedding' | 'sleeping' | 'backoff' | 'complete';
  heartbeat_seq: number;
  active_scope_key_hash?: string;
  active_corpus_id?: ActiveEmbeddingCorpusId;
  worker_id: string;
  runs: number;
  exhausted_run_budget: boolean;
  exhausted_time_budget: boolean;
  chunks_seen: number;
  chunks_embedded: number;
  chunks_skipped: number;
  consecutive_failures: number;
  transient_lock_retries: number;
  /** Present only when a ledger observer is wired. Counts, never content. */
  ledger_observations?: number;
  ledger_observation_failures?: number;
  scopes: SourceEmbeddingDrainScopeReport[];
  lanes?: SourceEmbeddingDrainLaneReport[];
  policy: {
    raw_source_exposed: false;
    source_text_returned: false;
    source_scope_keys_exposed: false;
    direct_db_mutation: false;
    local_only: boolean;
  };
  actions: string[];
}

export interface SourceEmbeddingDrainLaneReport {
  corpus_id: ActiveEmbeddingCorpusId;
  /** Present only where it differs from `corpus_id`. See SourceEmbeddingDrainLane. */
  lane_id?: string;
  trust_domain: Extract<SourceTrustDomain, 'internal' | 'secure_local'>;
  cadence_passes: number;
  runs: number;
  chunks_seen: number;
  chunks_embedded: number;
  chunks_skipped: number;
  targets: SourceEmbeddingDrainScopeReport[];
}

export interface SourceEmbeddingDrainScopeReport {
  scope_key_hash: string;
  runs: number;
  chunks_seen: number;
  chunks_embedded: number;
  chunks_skipped: number;
  errors: string[];
}

export interface SecureLocalEmbeddingBackfillDryRunReport {
  kind: 'secure_local_embedding_backfill_dry_run';
  generated_at: string;
  status: 'ready' | 'attention';
  model_id: string;
  embedding_provider: string;
  embedding_backend: 'local';
  embedding_dimension: number;
  embedding_epoch: string;
  totals: {
    chunks_seen: number;
    chunks_pending: number;
    chunks_current: number;
    chunks_capped: number;
  };
  corpora: Array<{
    corpus_id: ActiveEmbeddingCorpusId;
    chunks_seen: number;
    chunks_pending: number;
    chunks_current: number;
    chunks_capped: number;
  }>;
  policy: {
    raw_source_exposed: false;
    source_text_returned: false;
    source_scope_keys_exposed: false;
    direct_db_mutation: false;
    local_only: true;
  };
  actions: string[];
}

interface HttpClientOptions {
  baseUrl: string;
  requestTimeoutMs: number;
  authToken?: string;
  fetchImpl?: typeof fetch;
}

class HttpSourceEmbeddingDrainClient implements SourceEmbeddingDrainClient {
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly authToken: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpClientOptions) {
    this.baseUrl = normalizeSourceWorkerBaseUrl(options.baseUrl);
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.authToken = options.authToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async embedConnectorStore(request: CorpusEmbeddingRequest): Promise<DropboxEmbeddingResult> {
    return this.embed(request);
  }

  private async embed(request: CorpusEmbeddingRequest): Promise<DropboxEmbeddingResult> {
    const useTimeout = Number.isFinite(this.requestTimeoutMs);
    const controller = useTimeout ? new AbortController() : undefined;
    const timeout = useTimeout ? setTimeout(() => controller?.abort(), this.requestTimeoutMs) : undefined;
    try {
      const init = withWorkerAuthHeader({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        ...(controller ? { signal: controller.signal } : {}),
      }, this.authToken);
      const response = await this.fetchImpl(`${this.baseUrl}/source/index/embed`, init);
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`/source/index/embed returned HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      return text ? JSON.parse(text) as DropboxEmbeddingResult : {};
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

/** The middle of every `OLYMPUS_SOURCE_EMBEDDING_DRAIN_<NAME>_*` var per lane. */
type ConnectorStoreLaneEnvName =
  | 'DROPBOX'
  | 'EMAIL'
  | 'WHATSAPP'
  | 'INTERNAL_TELEGRAM'
  | 'PROTECTED_TELEGRAM'
  | 'READWISE'
  | 'X_BOOKMARKS'
  | 'DRIVE_INTERNAL';

type ConnectorStoreCorpusId =
  | typeof DROPBOX_CORPUS_ID
  | typeof EMAIL_CORPUS_ID
  | typeof WHATSAPP_CORPUS_ID
  | typeof INTERNAL_TELEGRAM_CORPUS_ID
  | typeof PROTECTED_TELEGRAM_CORPUS_ID
  | typeof READWISE_CORPUS_ID
  | typeof X_BOOKMARKS_CORPUS_ID
  | typeof DRIVE_INTERNAL_CORPUS_ID;

interface DirectClientOptions {
  connectorStores: Array<{
    corpusId: ConnectorStoreCorpusId;
    dbPath?: string;
    family: 'chat' | 'note' | 'file' | 'email' | 'readwise' | 'x';
    trustDomain: Extract<SourceTrustDomain, 'internal' | 'secure_local'>;
  }>;
  secureLocalProvider: SourceEmbeddingProvider;
  internalProvider?: SourceEmbeddingProvider;
  /**
   * The local embedding endpoint, for the ledger's endpoint-drift watch. It is
   * not on SourceEmbeddingProvider, so it is passed alongside; when it is
   * unknown the ledger records no endpoint rather than an invented one, and
   * that is the whole reason 2026-08-20 could not be reconstructed.
   */
  secureLocalEndpoint?: string;
}

class DirectSourceEmbeddingDrainClient implements SourceEmbeddingDrainClient {
  private readonly connectorStoreConfigs: DirectClientOptions['connectorStores'];
  private readonly connectorStores = new Map<string, LocalConnectorStore>();
  private readonly secureLocalProvider: SourceEmbeddingProvider;
  private readonly internalProvider: SourceEmbeddingProvider | undefined;
  private readonly secureLocalEndpoint: string | undefined;

  constructor(options: DirectClientOptions) {
    assertEmbeddingProviderForLane('secure_local', options.secureLocalProvider);
    if (options.internalProvider) assertEmbeddingProviderForLane('internal', options.internalProvider);
    this.connectorStoreConfigs = options.connectorStores;
    this.secureLocalProvider = options.secureLocalProvider;
    this.internalProvider = options.internalProvider;
    this.secureLocalEndpoint = options.secureLocalEndpoint?.trim() || undefined;
  }

  /**
   * What the open connector stores hold, right now.
   *
   * Only stores this client has ALREADY opened are read. Opening the rest to
   * complete the picture would create an empty database for every configured
   * lane that has never run, and a drain that manufactures the stores it is
   * meant to observe is worse than one that reports less.
   */
  observeCoverage(): SourceEmbeddingDrainCoverage {
    const corpora: SourceEmbeddingCorpusCoverage[] = [];
    for (const [corpusId, store] of this.connectorStores) {
      const config = this.connectorStoreConfigs.find((entry) => entry.corpusId === corpusId);
      if (!config) continue;
      const counts = store.status().counts;
      corpora.push({
        corpusId: config.corpusId,
        trustDomain: config.trustDomain,
        embeddedChunks: counts.embeddedChunks,
        missingChunks: Math.max(0, counts.chunks - counts.embeddedChunks),
      });
    }
    return {
      secureLocal: {
        modelId: this.secureLocalProvider.modelId,
        epoch: this.secureLocalProvider.epochId,
        ...(this.secureLocalEndpoint ? { endpoint: this.secureLocalEndpoint } : {}),
      },
      ...(this.internalProvider
        ? {
            internal: {
              modelId: this.internalProvider.modelId,
              epoch: this.internalProvider.epochId,
            },
          }
        : {}),
      corpora,
    };
  }

  async embedConnectorStore(request: CorpusEmbeddingRequest): Promise<DropboxEmbeddingResult> {
    const config = this.connectorStoreConfigs.find((entry) => entry.corpusId === request.corpus_id);
    if (!config?.dbPath) throw new Error(`Direct connector-store embedding is not configured for ${request.corpus_id}.`);
    let store = this.connectorStores.get(config.corpusId);
    if (!store) {
      store = new LocalConnectorStore({
        dbPath: config.dbPath,
        corpusId: config.corpusId,
        family: config.family,
        trustDomain: config.trustDomain,
      });
      this.connectorStores.set(config.corpusId, store);
    }
    const provider = config.trustDomain === 'internal'
      ? this.internalProvider
      : this.secureLocalProvider;
    if (!provider) {
      throw new Error(`Direct connector-store embedding has no sovereignty-resolved ${config.trustDomain} provider.`);
    }
    const result = await store.embedChunks({
      provider,
      ...(request.max_pending_chunks !== undefined ? { limit: request.max_pending_chunks } : {}),
    });
    return {
      chunks_seen: result.chunksSeen,
      chunks_embedded: result.chunksEmbedded,
      chunks_skipped: result.chunksSkipped,
      status: 'completed',
    };
  }

  close(): void {
    for (const store of this.connectorStores.values()) store.close();
  }
}

export async function runSourceEmbeddingDrain(
  options: SourceEmbeddingDrainOptions,
): Promise<SourceEmbeddingDrainReport> {
  const generatedAt = options.now ?? new Date();
  const workerId = options.workerId?.trim() || DEFAULT_WORKER_ID;
  const explicitRoster = options.lanes !== undefined;
  const lanes = normalizeEmbeddingLanes(options.lanes ?? [createDefaultConnectorStoreLane(options)]);
  const laneReports = lanes.map((lane) => ({
    corpus_id: lane.corpusId,
    ...(lane.laneId && lane.laneId !== lane.corpusId ? { lane_id: lane.laneId } : {}),
    trust_domain: lane.trustDomain,
    cadence_passes: lane.cadencePasses,
    runs: 0,
    chunks_seen: 0,
    chunks_embedded: 0,
    chunks_skipped: 0,
    targets: lane.targetKeys.map((target) => emptyScopeReport(target)),
  } satisfies SourceEmbeddingDrainLaneReport));
  const reports = laneReports
    .find((lane) => lane.corpus_id === DROPBOX_CORPUS_ID)?.targets ?? [];
  const totalTargets = sum(lanes, (lane) => lane.targetKeys.length);
  const maxRuns = positiveIntOrUnboundedOption(options.maxRuns, Number.POSITIVE_INFINITY, 'maxRuns');
  const maxRuntimeSeconds = positiveIntOrUnboundedOption(options.maxRuntimeSeconds, Number.POSITIVE_INFINITY, 'maxRuntimeSeconds');
  const idleSleepMs = nonNegativeIntOption(options.idleSleepMs, DEFAULT_IDLE_SLEEP_SECONDS * 1_000, 'idleSleepMs');
  const errorBackoffMs = nonNegativeIntOption(options.errorBackoffMs, DEFAULT_ERROR_BACKOFF_SECONDS * 1_000, 'errorBackoffMs');
  const progressHeartbeatMs = nonNegativeIntOption(options.progressHeartbeatMs, 0, 'progressHeartbeatMs');
  const maxConsecutiveFailures = positiveIntOrUnboundedOption(
    options.maxConsecutiveFailures,
    DEFAULT_MAX_CONSECUTIVE_FAILURES,
    'maxConsecutiveFailures',
  );
  const stopWhenIdle = options.stopWhenIdle ?? false;
  const ledgerObservationIntervalMs = nonNegativeIntOption(
    options.ledgerObservationIntervalMs,
    DEFAULT_LEDGER_OBSERVATION_INTERVAL_SECONDS * 1_000,
    'ledgerObservationIntervalMs',
  );
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const startedAt = Date.now();
  const deadlineMs = startedAt + maxRuntimeSeconds * 1_000;
  let runs = 0;
  let exhaustedTimeBudget = false;
  let consecutiveFailures = 0;
  const laneConsecutiveFailures = lanes.map(() => 0);
  const isolatedLanes = lanes.map(() => false);
  let transientLockRetries = 0;
  let ledgerObservations = 0;
  let ledgerObservationFailures = 0;
  let ledgerObservedAt: number | undefined;
  let consecutiveIdleScopeChecks = 0;
  let activePhase: SourceEmbeddingDrainReport['active_phase'] = 'starting';
  let activeScope: string | undefined;
  let activeCorpusId: ActiveEmbeddingCorpusId | undefined;
  let heartbeatSeq = 0;

  const currentReport = (
    runState: SourceEmbeddingDrainReport['run_state'],
    phase: SourceEmbeddingDrainReport['active_phase'],
  ): SourceEmbeddingDrainReport => {
    for (const laneReport of laneReports) {
      laneReport.chunks_seen = sum(laneReport.targets, (target) => target.chunks_seen);
      laneReport.chunks_embedded = sum(laneReport.targets, (target) => target.chunks_embedded);
      laneReport.chunks_skipped = sum(laneReport.targets, (target) => target.chunks_skipped);
    }
    const chunksSeen = sum(laneReports, (lane) => lane.chunks_seen);
    const chunksEmbedded = sum(laneReports, (lane) => lane.chunks_embedded);
    const chunksSkipped = sum(laneReports, (lane) => lane.chunks_skipped);
    const attention = consecutiveFailures >= maxConsecutiveFailures;
    const status = attention ? 'attention' : chunksEmbedded > 0 ? 'progress' : 'idle';
    return {
      kind: 'source_embedding_drain_report',
      generated_at: generatedAt.toISOString(),
      updated_at: (options.now ?? new Date()).toISOString(),
      corpus_id: DROPBOX_CORPUS_ID,
      ...(explicitRoster ? { corpus_ids: lanes.map((lane) => lane.corpusId) } : {}),
      status,
      run_state: runState,
      active_phase: phase,
      heartbeat_seq: heartbeatSeq,
      ...(activeScope ? { active_scope_key_hash: hashScope(activeScope) } : {}),
      ...(activeCorpusId ? { active_corpus_id: activeCorpusId } : {}),
      worker_id: workerId,
      runs,
      exhausted_run_budget: runs >= maxRuns,
      exhausted_time_budget: exhaustedTimeBudget,
      chunks_seen: chunksSeen,
      chunks_embedded: chunksEmbedded,
      chunks_skipped: chunksSkipped,
      consecutive_failures: consecutiveFailures,
      transient_lock_retries: transientLockRetries,
      ...(options.recordLedgerObservations
        ? {
            ledger_observations: ledgerObservations,
            ledger_observation_failures: ledgerObservationFailures,
          }
        : {}),
      scopes: reports,
      ...(explicitRoster ? { lanes: laneReports } : {}),
      policy: {
        raw_source_exposed: false,
        source_text_returned: false,
        source_scope_keys_exposed: false,
        direct_db_mutation: false,
        local_only: lanes.every((lane) => lane.trustDomain === 'secure_local'),
      },
      actions: actionsFromReport({
        status,
        chunksEmbedded,
        consecutiveFailures,
        transientLockRetries,
        exhaustedTimeBudget,
        exhaustedRunBudget: runs >= maxRuns,
        isolatedLaneCount: isolatedLanes.filter(Boolean).length,
      }),
    };
  };

  const emitProgress = (): void => {
    if (!options.onProgress) return;
    heartbeatSeq += 1;
    options.onProgress(currentReport('running', activePhase));
  };

  /**
   * Record where the corpora stand, if enough time has passed.
   *
   * `final` forces the write, so the pass that finished a corpus is on record
   * even when the drain exits inside the throttle window. Nothing here can
   * throw: the ledger observes the drain and never governs it.
   */
  const observeLedger = async (final: boolean): Promise<void> => {
    if (!options.recordLedgerObservations) return;
    const at = Date.now();
    if (!final && ledgerObservedAt !== undefined && at - ledgerObservedAt < ledgerObservationIntervalMs) return;
    ledgerObservedAt = at;
    try {
      await options.recordLedgerObservations();
      ledgerObservations += 1;
    } catch {
      ledgerObservationFailures += 1;
    }
  };

  const runWithHeartbeat = async <T>(
    phase: SourceEmbeddingDrainReport['active_phase'],
    corpusId: ActiveEmbeddingCorpusId | undefined,
    scope: string | undefined,
    action: () => Promise<T>,
  ): Promise<T> => {
    activePhase = phase;
    activeCorpusId = corpusId;
    activeScope = scope;
    emitProgress();
    const timer = options.onProgress && progressHeartbeatMs > 0
      ? setInterval(emitProgress, progressHeartbeatMs)
      : undefined;
    try {
      return await action();
    } finally {
      if (timer) clearInterval(timer);
      activePhase = 'starting';
      activeCorpusId = undefined;
      activeScope = undefined;
    }
  };

  let pass = 0;
  let passItems = embeddingPassItems(lanes, laneReports, pass, isolatedLanes);
  let passItemIndex = 0;
  while (runs < maxRuns) {
    if (Date.now() >= deadlineMs) {
      exhaustedTimeBudget = true;
      break;
    }

    while (passItemIndex >= passItems.length) {
      // A completed round-robin pass is the drain's only natural boundary: every
      // due lane has just had its turn, so the stores are momentarily quiet and
      // a coverage read is cheap and coherent.
      await observeLedger(false);
      pass += 1;
      passItems = embeddingPassItems(lanes, laneReports, pass, isolatedLanes);
      passItemIndex = 0;
      if (passItems.length === 0) break;
    }
    if (passItems.length === 0) {
      // Lane isolation is permanent for a process, so "no items" with every lane
      // isolated is terminal, not a cadence gap: exit and let the supervisor
      // restart with fresh lane state rather than sleep forever doing no work.
      if (isolatedLanes.every(Boolean)) break;
      if (Number.isFinite(maxRuns) || Number.isFinite(maxRuntimeSeconds)) break;
      await runWithHeartbeat('backoff', undefined, undefined, () => sleep(errorBackoffMs || idleSleepMs || 1_000));
      continue;
    }
    const item = passItems[passItemIndex++]!;
    const scope = item.targetKey;
    const scopeReport = item.targetReport;
    runs += 1;
    scopeReport.runs += 1;
    item.laneReport.runs += 1;

    try {
      const result = await runWithHeartbeat(
        'embedding',
        item.lane.corpusId,
        scope,
        () => item.lane.embed(scope, item.lane.maxPendingChunks),
      );
      const chunksSeen = numberValue(result.chunks_seen);
      const chunksEmbedded = numberValue(result.chunks_embedded);
      const chunksSkipped = numberValue(result.chunks_skipped);
      scopeReport.chunks_seen += chunksSeen;
      scopeReport.chunks_embedded += chunksEmbedded;
      scopeReport.chunks_skipped += chunksSkipped;
      laneConsecutiveFailures[item.laneIndex] = 0;
      consecutiveFailures = Math.max(...laneConsecutiveFailures);
      consecutiveIdleScopeChecks = chunksEmbedded > 0 ? 0 : consecutiveIdleScopeChecks + 1;
      emitProgress();
      if (stopWhenIdle && consecutiveIdleScopeChecks >= totalTargets) break;
      if (chunksEmbedded === 0 && idleSleepMs > 0) {
        await runWithHeartbeat('sleeping', item.lane.corpusId, scope, () => sleep(idleSleepMs));
      }
    } catch (error) {
      const message = errorMessage(error);
      const transientLock = isSqliteBusyError(message);
      if (transientLock) {
        transientLockRetries += 1;
        laneConsecutiveFailures[item.laneIndex] = 0;
      } else {
        laneConsecutiveFailures[item.laneIndex] = (laneConsecutiveFailures[item.laneIndex] ?? 0) + 1;
        if (laneConsecutiveFailures[item.laneIndex]! >= maxConsecutiveFailures) {
          isolatedLanes[item.laneIndex] = true;
        }
      }
      consecutiveFailures = Math.max(...laneConsecutiveFailures);
      scopeReport.errors.push(createHash('sha256').update(message).digest('hex'));
      consecutiveIdleScopeChecks = 0;
      emitProgress();
      if (!isolatedLanes[item.laneIndex] && errorBackoffMs > 0) {
        await runWithHeartbeat('backoff', item.lane.corpusId, scope, () => sleep(errorBackoffMs));
      }
    }
  }

  if (Date.now() >= deadlineMs && runs < maxRuns) exhaustedTimeBudget = true;
  await observeLedger(true);
  activePhase = 'complete';
  const finalReport = currentReport('complete', 'complete');
  if (options.onProgress) options.onProgress(finalReport);
  return finalReport;
}

export function optionsFromEnv(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): SourceEmbeddingDrainOptions {
  if (env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_ENABLED !== 'true') {
    throw new Error('OLYMPUS_SOURCE_EMBEDDING_DRAIN_ENABLED=true is required for source embedding writes.');
  }
  const config = loadConfig(env);
  const authToken = workerAuthTokenFromConfig(config);
  const requestTimeoutSeconds = positiveIntOrUnbounded(
    env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_REQUEST_TIMEOUT_SECONDS,
    Number.POSITIVE_INFINITY,
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_REQUEST_TIMEOUT_SECONDS',
  );
  const maxPendingChunks = optionalPositiveIntOrUnbounded(
    env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_MAX_PENDING_CHUNKS,
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_MAX_PENDING_CHUNKS',
  );
  const mode = env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_MODE?.trim() || 'http';
  if (mode !== 'http' && mode !== 'direct') {
    throw new Error('OLYMPUS_SOURCE_EMBEDDING_DRAIN_MODE must be http or direct.');
  }
  const client = mode === 'direct'
    ? createDirectSourceEmbeddingDrainClient(env)
    : new HttpSourceEmbeddingDrainClient({
        baseUrl: normalizeSourceWorkerBaseUrl(env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_BASE_URL?.trim() || config.email.baseUrl),
        requestTimeoutMs: requestTimeoutSeconds * 1_000,
        ...(authToken ? { authToken } : {}),
        ...(fetchImpl ? { fetchImpl } : {}),
      });
  const rosterEnabled = [
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_EMAIL_ENABLED',
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_DROPBOX_STORE_ENABLED',
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_DROPBOX_STORE_DB_PATH',
    DROPBOX_CONNECTOR_STORE_DB_PATH_ENV,
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_WHATSAPP_ENABLED',
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_X_BOOKMARKS_ENABLED',
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_INTERNAL_TELEGRAM_ENABLED',
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_PROTECTED_TELEGRAM_ENABLED',
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_READWISE_ENABLED',
    'OLYMPUS_SOURCE_EMBEDDING_DRAIN_DRIVE_INTERNAL_ENABLED',
  ].some((name) => env[name] !== undefined);
  const recordLedgerObservations = embeddingLedgerRecorderFromEnv(client, env);
  return {
    client,
    ...(rosterEnabled
      ? { lanes: sourceEmbeddingLaneRosterFromEnv(client, env, maxPendingChunks) }
      : {}),
    ...(recordLedgerObservations ? { recordLedgerObservations } : {}),
    ledgerObservationIntervalMs: secondsToMs(nonNegativeInt(
      env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_LEDGER_OBSERVATION_INTERVAL_SECONDS,
      DEFAULT_LEDGER_OBSERVATION_INTERVAL_SECONDS,
      'OLYMPUS_SOURCE_EMBEDDING_DRAIN_LEDGER_OBSERVATION_INTERVAL_SECONDS',
    )),
    workerId: env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_WORKER_ID?.trim() || DEFAULT_WORKER_ID,
    ...(maxPendingChunks !== undefined ? { maxPendingChunks } : {}),
    maxRuns: positiveIntOrUnbounded(
      env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_MAX_RUNS,
      Number.POSITIVE_INFINITY,
      'OLYMPUS_SOURCE_EMBEDDING_DRAIN_MAX_RUNS',
    ),
    maxRuntimeSeconds: positiveIntOrUnbounded(
      env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_MAX_RUNTIME_SECONDS,
      Number.POSITIVE_INFINITY,
      'OLYMPUS_SOURCE_EMBEDDING_DRAIN_MAX_RUNTIME_SECONDS',
    ),
    idleSleepMs: secondsToMs(nonNegativeInt(
      env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_IDLE_SLEEP_SECONDS,
      DEFAULT_IDLE_SLEEP_SECONDS,
      'OLYMPUS_SOURCE_EMBEDDING_DRAIN_IDLE_SLEEP_SECONDS',
    )),
    errorBackoffMs: secondsToMs(nonNegativeInt(
      env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_ERROR_BACKOFF_SECONDS,
      DEFAULT_ERROR_BACKOFF_SECONDS,
      'OLYMPUS_SOURCE_EMBEDDING_DRAIN_ERROR_BACKOFF_SECONDS',
    )),
    maxConsecutiveFailures: positiveIntOrUnbounded(
      env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_MAX_CONSECUTIVE_FAILURES,
      DEFAULT_MAX_CONSECUTIVE_FAILURES,
      'OLYMPUS_SOURCE_EMBEDDING_DRAIN_MAX_CONSECUTIVE_FAILURES',
    ),
    stopWhenIdle: env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_STOP_WHEN_IDLE === undefined
      ? false
      : parseBoolean(env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_STOP_WHEN_IDLE, 'OLYMPUS_SOURCE_EMBEDDING_DRAIN_STOP_WHEN_IDLE'),
    progressHeartbeatMs: secondsToMs(nonNegativeInt(
      env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_PROGRESS_HEARTBEAT_SECONDS,
      DEFAULT_PROGRESS_HEARTBEAT_SECONDS,
      'OLYMPUS_SOURCE_EMBEDDING_DRAIN_PROGRESS_HEARTBEAT_SECONDS',
    )),
  };
}

/**
 * The name the ledger knows each corpus by.
 *
 * TWO ID SPACES, and they are not interchangeable. The drain works in corpus
 * ids; the embedding ledger was written by hand in store names, and the five
 * it already carries (`dropbox`, `gmail-secure`, `drive-secure`,
 * `whatsapp-live`, `telegram-protected`) name the connector stores the
 * 2026-08-20 invalidation emptied. Translating between them is this file's job
 * precisely because this is the one place both spaces are in view — an
 * observer that guessed would file every entry under a corpus nobody reads.
 *
 * A corpus with no row is simply not observed. Every name here is permanent —
 * changing one splits a corpus's history across two identities.
 */
const EMBEDDING_LEDGER_CORPUS_NAMES: Partial<Record<ActiveEmbeddingCorpusId, string>> = {
  [DROPBOX_CORPUS_ID]: 'dropbox',
  [EMAIL_CORPUS_ID]: 'gmail-secure',
  [WHATSAPP_CORPUS_ID]: 'whatsapp-live',
  [PROTECTED_TELEGRAM_CORPUS_ID]: 'telegram-protected',
  [INTERNAL_TELEGRAM_CORPUS_ID]: 'telegram-internal',
  [READWISE_CORPUS_ID]: 'readwise',
  [X_BOOKMARKS_CORPUS_ID]: 'x-bookmarks',
};

/**
 * The drain's ledger hook, or nothing when there is nothing to observe.
 *
 * The two trust domains are recorded in SEPARATE calls with separate contexts,
 * because the ledger's endpoint- and epoch-drift watch compares against the
 * last value on record regardless of which corpus carried it. Folding the local
 * and the Gemini configurations into one context would make every observation
 * look like the epoch had just moved, and a record that cries wolf about the
 * exact event it exists to catch is worse than no record.
 *
 * The internal call deliberately carries no model, epoch or endpoint at all:
 * this ledger tracks the local embedding configuration, and stamping internal
 * corpora with its fields — or with Gemini's, into the same shared history —
 * would be an invention either way. The corpus transitions still land, which
 * is the part a reader of the internal corpora needs.
 */
export function embeddingLedgerRecorderFromEnv(
  client: SourceEmbeddingDrainClient,
  env: Record<string, string | undefined>,
): (() => Promise<void>) | undefined {
  if (!client.observeCoverage) return undefined;
  if (!booleanEnv(env, 'OLYMPUS_SOURCE_EMBEDDING_DRAIN_LEDGER_OBSERVER_ENABLED', true)) return undefined;
  const observe = client.observeCoverage.bind(client);
  const path = resolveEmbeddingLedgerPath(env);
  return async () => {
    const coverage = observe();
    const observedAt = new Date();
    for (const domain of ['secure_local', 'internal'] as const) {
      const observations = coverage.corpora
        .filter((corpus) => corpus.trustDomain === domain)
        .flatMap((corpus): EmbeddingCorpusObservation[] => {
          const name = EMBEDDING_LEDGER_CORPUS_NAMES[corpus.corpusId];
          return name
            ? [{
                corpus: name,
                embedded_chunks: corpus.embeddedChunks,
                missing_chunks: corpus.missingChunks,
              }]
            : [];
        });
      if (observations.length === 0) continue;
      const config = domain === 'secure_local' ? coverage.secureLocal : undefined;
      await recordEmbeddingLedgerObservations(path, observations, {
        observed_at: observedAt,
        ...(config?.modelId ? { model_id: config.modelId } : {}),
        ...(config?.epoch ? { epoch: config.epoch } : {}),
        ...(config?.endpoint ? { endpoint: config.endpoint } : {}),
      });
    }
  };
}

export function secureLocalBackfillDryRunFromEnv(
  env: Record<string, string | undefined> = process.env,
): SecureLocalEmbeddingBackfillDryRunReport {
  const embeddingProvider = createSourceIndexEmbeddingProviderFromEnv(env);
  if (!embeddingProvider) {
    throw new Error('OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER is required for secure-local embedding backfill dry-run.');
  }
  if (embeddingProvider.backend !== 'local') {
    throw new Error('Secure-local embedding backfill dry-run requires a local source-index embedding provider.');
  }

  const configs: DirectClientOptions['connectorStores'] = [
    {
      corpusId: DROPBOX_CORPUS_ID,
      dbPath: env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_DROPBOX_STORE_DB_PATH?.trim()
        || defaultDropboxConnectorStoreDbPath(env),
      family: 'file' as const,
      trustDomain: 'secure_local' as const,
    },
    ...(env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_EMAIL_ENABLED === 'false'
      ? []
      : [{
          corpusId: EMAIL_CORPUS_ID as typeof EMAIL_CORPUS_ID,
          dbPath: env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_EMAIL_DB_PATH?.trim()
            || defaultGmailSecureConnectorStoreDbPath(env),
          family: 'email' as const,
          trustDomain: 'secure_local' as const,
        }]),
  ];
  const force = env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_FORCE === 'true';
  const corpora = configs.flatMap((config) => {
    if (!config.dbPath || !existsSync(config.dbPath)) return [];
    const store = new LocalConnectorStore({ ...config, dbPath: config.dbPath, readOnly: true });
    try {
      const counts = store.status().counts;
      const chunksCurrent = Math.min(counts.chunks, counts.embeddedChunks);
      const chunksPending = force ? counts.chunks : Math.max(0, counts.chunks - chunksCurrent);
      return [{
        corpus_id: config.corpusId,
        chunks_seen: counts.chunks,
        chunks_pending: chunksPending,
        chunks_current: chunksCurrent,
        chunks_capped: 0,
      }];
    } finally {
      store.close();
    }
  });
  const chunksSeen = sum(corpora, (corpus) => corpus.chunks_seen);
  const chunksPending = sum(corpora, (corpus) => corpus.chunks_pending);
  const chunksCurrent = sum(corpora, (corpus) => corpus.chunks_current);
  const chunksCapped = sum(corpora, (corpus) => corpus.chunks_capped);
  return {
      kind: 'secure_local_embedding_backfill_dry_run',
      generated_at: new Date().toISOString(),
      status: chunksPending > 0 ? 'ready' : 'attention',
      model_id: embeddingProvider.modelId,
      embedding_provider: embeddingProvider.provider,
      embedding_backend: 'local',
      embedding_dimension: embeddingProvider.dimension,
      embedding_epoch: embeddingProvider.epochId,
      totals: {
        chunks_seen: chunksSeen,
        chunks_pending: chunksPending,
        chunks_current: chunksCurrent,
        chunks_capped: chunksCapped,
      },
      corpora,
      policy: {
        raw_source_exposed: false,
        source_text_returned: false,
        source_scope_keys_exposed: false,
        direct_db_mutation: false,
        local_only: true,
      },
      actions: [
        chunksPending > 0
          ? 'backfill: dry-run only; run the gated source-index embedding backfill during the approved window.'
          : 'backfill: no pending secure-local chunks were found for this model epoch.',
        'backfill: do not run before the Delphi no-touch window and load plan are approved.',
      ],
    };
}

function createDirectSourceEmbeddingDrainClient(
  env: Record<string, string | undefined>,
): DirectSourceEmbeddingDrainClient {
  const config = loadConfig(env);
  const sovereigntyEngine = loadSovereigntyEngine({
    env,
    ...(config.sovereignty?.policy ? { inlineConfig: config.sovereignty.policy } : {}),
    ...(config.sovereignty?.configPath ? { configPath: config.sovereignty.configPath } : {}),
  });
  const bootSecretResolver = new WorkerBootSecretResolver({
    resolveSecretRefValueSync: (secretRef, resolverEnv) => resolveSecretRefValueSync(secretRef, { env: resolverEnv }),
  });
  const policySecureProvider = createSourceIndexEmbeddingProviderFromSovereignty(
    sovereigntyEngine,
    'secure_local',
    env,
    bootSecretResolver,
  );
  const envProvider = sovereigntyEngine.source === 'env_bridge'
    ? createSourceIndexEmbeddingProviderFromEnv(env)
    : undefined;
  const secureLocalProvider = policySecureProvider
    ?? (envProvider?.backend === 'local' ? envProvider : undefined);
  if (!secureLocalProvider) {
    throw new Error('OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER is required for direct source embedding drain mode.');
  }
  assertEmbeddingProviderForLane('secure_local', secureLocalProvider);
  const resolvedInternalProvider = createSourceIndexEmbeddingProviderFromSovereignty(
    sovereigntyEngine,
    'internal',
    env,
    bootSecretResolver,
  );
  const internalLaneEnabled = booleanEnv(env, 'OLYMPUS_SOURCE_EMBEDDING_DRAIN_X_BOOKMARKS_ENABLED', false)
    || booleanEnv(env, 'OLYMPUS_SOURCE_EMBEDDING_DRAIN_READWISE_ENABLED', false)
    || booleanEnv(env, 'OLYMPUS_SOURCE_EMBEDDING_DRAIN_INTERNAL_TELEGRAM_ENABLED', false)
    || booleanEnv(env, 'OLYMPUS_SOURCE_EMBEDDING_DRAIN_DRIVE_INTERNAL_ENABLED', false);
  if (internalLaneEnabled && !resolvedInternalProvider) {
    throw new Error('Internal embedding lanes require a sovereignty-resolved internal embedding provider.');
  }
  if (internalLaneEnabled) assertEmbeddingProviderForLane('internal', resolvedInternalProvider!);
  const emailEnabled = booleanEnv(env, 'OLYMPUS_SOURCE_EMBEDDING_DRAIN_EMAIL_ENABLED', false);
  const dropboxEnabled = booleanEnv(env, 'OLYMPUS_SOURCE_EMBEDDING_DRAIN_DROPBOX_STORE_ENABLED', true);
  const connectorStores: DirectClientOptions['connectorStores'] = [
    ...(dropboxEnabled
      ? [{
          corpusId: DROPBOX_CORPUS_ID,
          dbPath: env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_DROPBOX_STORE_DB_PATH?.trim()
            || defaultDropboxConnectorStoreDbPath(env),
          family: 'file' as const,
          trustDomain: 'secure_local' as const,
        }]
      : []),
    ...(emailEnabled
      ? [{
          corpusId: EMAIL_CORPUS_ID as typeof EMAIL_CORPUS_ID,
          dbPath: env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_EMAIL_DB_PATH?.trim()
            || defaultGmailSecureConnectorStoreDbPath(env),
          family: 'email' as const,
          trustDomain: 'secure_local' as const,
        }]
      : []),
    connectorStoreConfigFromEnv(env, WHATSAPP_CORPUS_ID, 'WHATSAPP', 'chat', 'secure_local'),
    connectorStoreConfigFromEnv(env, INTERNAL_TELEGRAM_CORPUS_ID, 'INTERNAL_TELEGRAM', 'chat', 'internal'),
    connectorStoreConfigFromEnv(env, PROTECTED_TELEGRAM_CORPUS_ID, 'PROTECTED_TELEGRAM', 'chat', 'secure_local'),
    connectorStoreConfigFromEnv(env, READWISE_CORPUS_ID, 'READWISE', 'readwise', 'internal'),
    connectorStoreConfigFromEnv(env, X_BOOKMARKS_CORPUS_ID, 'X_BOOKMARKS', 'x', 'internal'),
    connectorStoreConfigFromEnv(env, DRIVE_INTERNAL_CORPUS_ID, 'DRIVE_INTERNAL', 'file', 'internal'),
  ].filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  return new DirectSourceEmbeddingDrainClient({
    connectorStores,
    secureLocalProvider,
    ...(env.OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL?.trim()
      ? { secureLocalEndpoint: env.OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL.trim() }
      : {}),
    ...(resolvedInternalProvider?.provider === 'google-gemini'
      ? { internalProvider: resolvedInternalProvider }
      : {}),
  });
}

/**
 * Connector-store lanes with nothing lane-specific about them.
 *
 * Dropbox and Gmail are absent because their always-present/default lanes are
 * assembled directly in the roster; everything optional is one row here.
 * `envName` is the middle of every env var this lane reads, and it is the key
 * an operator sets on the host — renaming one silently disables a lane.
 */
const CONNECTOR_STORE_LANES: ReadonlyArray<{
  corpusId: ConnectorStoreCorpusId;
  envName: ConnectorStoreLaneEnvName;
  trustDomain: Extract<SourceTrustDomain, 'internal' | 'secure_local'>;
  laneId?: string;
}> = [
  { corpusId: INTERNAL_TELEGRAM_CORPUS_ID, envName: 'INTERNAL_TELEGRAM', trustDomain: 'internal' },
  { corpusId: PROTECTED_TELEGRAM_CORPUS_ID, envName: 'PROTECTED_TELEGRAM', trustDomain: 'secure_local' },
  { corpusId: READWISE_CORPUS_ID, envName: 'READWISE', trustDomain: 'internal' },
  {
    corpusId: X_BOOKMARKS_CORPUS_ID,
    envName: 'X_BOOKMARKS',
    trustDomain: 'internal',
  },
];

export function sourceEmbeddingLaneRosterFromEnv(
  client: SourceEmbeddingDrainClient,
  env: Record<string, string | undefined>,
  dropboxMaxPendingChunks?: number,
): SourceEmbeddingDrainLane[] {
  const embedConnectorStore = client.embedConnectorStore.bind(client);
  const lanes: SourceEmbeddingDrainLane[] = [];
  if (booleanEnv(env, 'OLYMPUS_SOURCE_EMBEDDING_DRAIN_DROPBOX_STORE_ENABLED', true)) {
    lanes.push({
      corpusId: DROPBOX_CORPUS_ID,
      trustDomain: 'secure_local',
      targetKeys: [DROPBOX_CORPUS_ID],
      cadencePasses: laneCadence(env, 'DROPBOX'),
      ...(dropboxMaxPendingChunks !== undefined ? { maxPendingChunks: dropboxMaxPendingChunks } : {}),
      embed: (_target, limit) => embedConnectorStore({
        corpus_id: DROPBOX_CORPUS_ID,
        ...(limit !== undefined ? { max_pending_chunks: limit } : {}),
      }),
    });
  }

  if (booleanEnv(env, 'OLYMPUS_SOURCE_EMBEDDING_DRAIN_EMAIL_ENABLED', false)) {
    const maxPendingChunks = laneLimit(env, 'EMAIL');
    lanes.push({
      corpusId: EMAIL_CORPUS_ID,
      trustDomain: 'secure_local',
      targetKeys: [EMAIL_CORPUS_ID],
      cadencePasses: laneCadence(env, 'EMAIL'),
      ...(maxPendingChunks !== undefined ? { maxPendingChunks } : {}),
      embed: (_target, limit) => embedConnectorStore({
        corpus_id: EMAIL_CORPUS_ID,
        ...(limit !== undefined ? { max_pending_chunks: limit } : {}),
      }),
    });
  }

  if (booleanEnv(env, 'OLYMPUS_SOURCE_EMBEDDING_DRAIN_WHATSAPP_ENABLED', false)) {
    const maxPendingChunks = laneLimit(env, 'WHATSAPP');
    lanes.push({
      corpusId: WHATSAPP_CORPUS_ID,
      trustDomain: 'secure_local',
      targetKeys: [WHATSAPP_CORPUS_ID],
      cadencePasses: laneCadence(env, 'WHATSAPP'),
      ...(maxPendingChunks !== undefined ? { maxPendingChunks } : {}),
      embed: (_target, limit) => embedConnectorStore({
        corpus_id: WHATSAPP_CORPUS_ID,
        ...(limit !== undefined ? { max_pending_chunks: limit } : {}),
      }),
    });
  }

  for (const lane of CONNECTOR_STORE_LANES) {
    if (!booleanEnv(env, `OLYMPUS_SOURCE_EMBEDDING_DRAIN_${lane.envName}_ENABLED`, false)) continue;
    const laneId = lane.laneId ?? lane.corpusId;
    const maxPendingChunks = laneLimit(env, lane.envName);
    lanes.push({
      corpusId: lane.corpusId,
      ...(lane.laneId ? { laneId: lane.laneId } : {}),
      trustDomain: lane.trustDomain,
      targetKeys: [laneId],
      cadencePasses: laneCadence(env, lane.envName),
      ...(maxPendingChunks !== undefined ? { maxPendingChunks } : {}),
      embed: (_target, limit) => embedConnectorStore({
        corpus_id: lane.corpusId,
        ...(limit !== undefined ? { max_pending_chunks: limit } : {}),
      }),
    });
  }

  if (booleanEnv(env, 'OLYMPUS_SOURCE_EMBEDDING_DRAIN_DRIVE_INTERNAL_ENABLED', false)) {
    const maxPendingChunks = laneLimit(env, 'DRIVE_INTERNAL');
    lanes.push({
      corpusId: DRIVE_INTERNAL_CORPUS_ID,
      trustDomain: 'internal',
      targetKeys: [DRIVE_INTERNAL_CORPUS_ID],
      cadencePasses: laneCadence(env, 'DRIVE_INTERNAL'),
      ...(maxPendingChunks !== undefined ? { maxPendingChunks } : {}),
      embed: (_target, limit) => embedConnectorStore({
        corpus_id: DRIVE_INTERNAL_CORPUS_ID,
        ...(limit !== undefined ? { max_pending_chunks: limit } : {}),
      }),
    });
  }

  return lanes;
}

export function assertEmbeddingProviderForLane(
  trustDomain: Extract<SourceTrustDomain, 'internal' | 'secure_local'>,
  provider: SourceEmbeddingProvider,
): void {
  if (trustDomain === 'secure_local' && provider.backend !== 'local') {
    throw new Error('Secure-local embedding lanes require a local/private embedding provider.');
  }
  if (trustDomain === 'internal' && (provider.backend !== 'cloud' || provider.provider !== 'google-gemini')) {
    throw new Error('Internal embedding lanes require the sovereignty-resolved Gemini provider.');
  }
}

function createDefaultConnectorStoreLane(
  options: SourceEmbeddingDrainOptions,
): SourceEmbeddingDrainLane {
  return {
    corpusId: DROPBOX_CORPUS_ID,
    trustDomain: 'secure_local',
    targetKeys: [DROPBOX_CORPUS_ID],
    cadencePasses: 1,
    ...(options.maxPendingChunks !== undefined ? { maxPendingChunks: options.maxPendingChunks } : {}),
    embed: (_target, limit) => options.client.embedConnectorStore({
      corpus_id: DROPBOX_CORPUS_ID,
      ...(limit !== undefined ? { max_pending_chunks: limit } : {}),
    }),
  };
}

function normalizeEmbeddingLanes(lanes: readonly SourceEmbeddingDrainLane[]): SourceEmbeddingDrainLane[] {
  if (lanes.length === 0) throw new Error('At least one source embedding lane is required.');
  const seen = new Set<string>();
  return lanes.map((lane) => {
    const laneId = lane.laneId?.trim() || lane.corpusId;
    if (seen.has(laneId)) throw new Error(`Duplicate source embedding lane: ${laneId}.`);
    seen.add(laneId);
    const targetKeys = normalizeOptionalList(lane.targetKeys);
    if (targetKeys.length === 0) throw new Error(`Embedding lane ${lane.corpusId} requires at least one target.`);
    if (!Number.isInteger(lane.cadencePasses) || lane.cadencePasses < 1) {
      throw new Error(`${lane.corpusId}.cadencePasses must be a positive integer.`);
    }
    return {
      ...lane,
      laneId,
      targetKeys,
      cadencePasses: lane.cadencePasses,
    };
  });
}

function embeddingPassItems(
  lanes: readonly SourceEmbeddingDrainLane[],
  reports: readonly SourceEmbeddingDrainLaneReport[],
  pass: number,
  isolatedLanes: readonly boolean[],
) {
  return lanes.flatMap((lane, laneIndex) => {
    if (isolatedLanes[laneIndex]) return [];
    if (pass % lane.cadencePasses !== 0) return [];
    const laneReport = reports[laneIndex]!;
    return lane.targetKeys.map((targetKey, targetIndex) => ({
      lane,
      laneIndex,
      laneReport,
      targetKey,
      targetReport: laneReport.targets[targetIndex]!,
    }));
  });
}

function laneCadence(env: Record<string, string | undefined>, lane: string): number {
  const name = `OLYMPUS_SOURCE_EMBEDDING_DRAIN_${lane}_CADENCE_PASSES`;
  return positiveInt(env[name], 1, name);
}

function laneLimit(env: Record<string, string | undefined>, lane: string): number | undefined {
  const name = `OLYMPUS_SOURCE_EMBEDDING_DRAIN_${lane}_MAX_PENDING_CHUNKS`;
  const value = env[name];
  return value === undefined ? 32 : optionalPositiveIntOrUnbounded(value, name);
}

function booleanEnv(env: Record<string, string | undefined>, name: string, defaultValue: boolean): boolean {
  const value = env[name];
  return value === undefined ? defaultValue : parseBoolean(value, name);
}

/**
 * The store path a lane falls back to when the host set no explicit one.
 *
 * Every value here is the SAME default the connector that writes the store
 * resolves, so a lane can never embed a different file than the one being
 * filled. A lane with no entry gets no fallback and stays unconfigured, which
 * fails loudly on first use instead of quietly embedding nothing.
 */
function connectorStoreFallbackDbPath(
  env: Record<string, string | undefined>,
  envName: ConnectorStoreLaneEnvName,
): string | undefined {
  switch (envName) {
    case 'DROPBOX': return defaultDropboxConnectorStoreDbPath(env);
    case 'EMAIL': return defaultGmailSecureConnectorStoreDbPath(env);
    case 'WHATSAPP': return defaultWhatsAppConnectorStoreDbPath(env);
    case 'INTERNAL_TELEGRAM': return defaultInternalTelegramConnectorStoreDbPath(env);
    case 'PROTECTED_TELEGRAM': return defaultProtectedTelegramConnectorStoreDbPath(env);
    case 'READWISE': return defaultReadwiseConnectorStoreDbPath(env);
    case 'X_BOOKMARKS': return defaultXBookmarksConnectorStoreDbPath(env);
    case 'DRIVE_INTERNAL': return defaultGoogleDriveConnectorStoreDbPath(env);
    default: return undefined;
  }
}

function connectorStoreConfigFromEnv(
  env: Record<string, string | undefined>,
  corpusId: ConnectorStoreCorpusId,
  envName: ConnectorStoreLaneEnvName,
  family: 'chat' | 'note' | 'file' | 'email' | 'readwise' | 'x',
  trustDomain: Extract<SourceTrustDomain, 'internal' | 'secure_local'>,
): DirectClientOptions['connectorStores'][number] | undefined {
  const enabled = booleanEnv(env, `OLYMPUS_SOURCE_EMBEDDING_DRAIN_${envName}_ENABLED`, false);
  if (!enabled) return undefined;
  const dbPath = env[`OLYMPUS_SOURCE_EMBEDDING_DRAIN_${envName}_DB_PATH`]?.trim()
    || connectorStoreFallbackDbPath(env, envName);
  return { corpusId, family, trustDomain, ...(dbPath ? { dbPath } : {}) };
}

function emptyScopeReport(scope: string): SourceEmbeddingDrainScopeReport {
  return {
    scope_key_hash: hashScope(scope),
    runs: 0,
    chunks_seen: 0,
    chunks_embedded: 0,
    chunks_skipped: 0,
    errors: [],
  };
}

function actionsFromReport(input: {
  status: SourceEmbeddingDrainReport['status'];
  chunksEmbedded: number;
  consecutiveFailures: number;
  transientLockRetries: number;
  exhaustedTimeBudget: boolean;
  exhaustedRunBudget: boolean;
  isolatedLaneCount: number;
}): string[] {
  const actions: string[] = [];
  if (input.exhaustedTimeBudget) actions.push('embedding: continue in the next cycle; runtime budget was exhausted.');
  if (input.exhaustedRunBudget) actions.push('embedding: continue in the next cycle; run budget was exhausted.');
  if (input.status === 'attention') {
    actions.push(`embedding: isolated ${input.isolatedLaneCount} lane(s) after ${input.consecutiveFailures} consecutive failure(s); healthy lanes continue.`);
  }
  if (input.transientLockRetries > 0) {
    actions.push(`embedding: backed off for ${input.transientLockRetries} SQLite writer lock(s); this is expected while metadata/extraction writes are active.`);
  }
  if (input.status !== 'attention' && input.chunksEmbedded === 0) {
    actions.push('embedding: no pending chunks were embedded in this pass; keep the drain idle or refresh extraction first.');
  }
  return actions;
}

function normalizeOptionalList(values: readonly string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function hashScope(scope: string): string {
  return createHash('sha256').update(scope).digest('hex').slice(0, 16);
}

function sum<T>(items: readonly T[], value: (item: T) => number): number {
  return items.reduce((total, item) => total + value(item), 0);
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function optionalPositiveIntOrUnbounded(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  if (isUnboundedToken(value)) return undefined;
  return positiveInt(value, 1, name);
}

function positiveInt(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function nonNegativeInt(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function positiveIntOrUnbounded(value: string | undefined, defaultValue: number, name: string): number {
  if (value === undefined || value.trim().length === 0) return defaultValue;
  if (isUnboundedToken(value)) return Number.POSITIVE_INFINITY;
  return positiveInt(value, defaultValue, name);
}

function positiveIntOrUnboundedOption(value: number | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue;
  if (value === Number.POSITIVE_INFINITY) return value;
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function nonNegativeIntOption(value: number | undefined, defaultValue: number, name: string): number {
  if (value === undefined) return defaultValue;
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
  return value;
}

function isUnboundedToken(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === 'unbounded'
    || normalized === 'none'
    || normalized === 'disabled'
    || normalized === 'infinite'
    || normalized === 'infinity'
    || normalized === 'max';
}

function parseBoolean(value: string, name: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function secondsToMs(value: number): number {
  return value * 1_000;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message.trim() : 'unknown embedding drain error';
}

function isSqliteBusyError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes('database is locked') || normalized.includes('sqlite_busy');
}

function parseArgs(argv: string[]): { reportPath?: string; dryRun?: boolean } {
  const options: { reportPath?: string; dryRun?: boolean } = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--report') {
      const value = argv[index + 1];
      if (!value) throw new Error('--report requires a path.');
      options.reportPath = value;
      index += 1;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

if (import.meta.main) {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun) {
    const report = secureLocalBackfillDryRunFromEnv(process.env);
    const json = JSON.stringify(report, null, 2);
    if (args.reportPath) {
      mkdirSync(dirname(args.reportPath), { recursive: true });
      writeFileSync(args.reportPath, `${json}\n`);
    }
    console.log(json);
    process.exit();
  }
  const options = optionsFromEnv(process.env);
  try {
    if (args.reportPath) {
      mkdirSync(dirname(args.reportPath), { recursive: true });
      options.onProgress = (report) => {
        writeFileSync(args.reportPath!, `${JSON.stringify(report, null, 2)}\n`);
      };
    }
    const report = await runSourceEmbeddingDrain(options);
    const json = JSON.stringify(report, null, 2);
    if (args.reportPath) writeFileSync(args.reportPath, `${json}\n`);
    console.log(json);
    if (process.env.OLYMPUS_SOURCE_EMBEDDING_DRAIN_EXIT_ON_ATTENTION === 'true' && report.status === 'attention') {
      process.exitCode = 1;
    }
  } finally {
    options.client.close?.();
  }
}
