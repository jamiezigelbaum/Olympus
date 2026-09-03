import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { assertNoRawEmailFields } from '../../core/email-policy.ts';
import { PUBLIC_RUNTIME_BUILD } from '../../core/build-flavor.ts';
import { packagedGooglePilotClientId } from '../../core/google-pilot-client.ts';
import { connectPublicApiKeySource, oauthAuthorizeOrigin, safeOAuthErrorCode, startExternalOAuthSourceConnection, startOAuthSourceConnection, type OAuthFetch } from '../../core/connect.ts';
import { OperationError } from '../../core/operation-error.ts';
import { dropboxContentExtractionStallHours } from '../../core/ingestion-throughput.ts';
import { createDefaultSecretStore, normalizeSecretRef, type SecretStore } from '../../core/secret-store.ts';
import { canonicalSourceCorpusId, type SourceCorpusRegistry } from '../../core/source-corpus-registry.ts';
import { selectedItemContentFieldPath } from '../../core/source-index/selected-item-safety.ts';
import { dropboxPolicyExcludedPathPrefixes, type SourceIngestionPolicy } from '../../core/source-ingestion-policy.ts';
import { normalizeVeniceAnalystModelId } from '../../core/venice-models.ts';
import { isV04PublicDashboardRoute } from '../../core/public-surface.ts';
import {
  artifactPresence,
  assertUnpairedRecordWritable,
  readReconciledUnpairedSources,
  readUnpairedSources,
  recordUnpairedSources,
  withoutUnpairedLaneHandles,
  type UnpairedSourceRecord,
  type UnpairedSourcesRead,
} from '../credential-broker/unpaired-sources.ts';
import {
  pairingSessionPathOverridden,
  pairingSessionPathsFromStoredValue,
  planPairingSessionRemoval,
  removePlannedPairingSessionFile,
  telegramPairingSessionPaths,
  whatsappPairingSessionPaths,
  type OlympusPathContext,
  type PairingPathRefusal,
} from '../../core/pairing-session-paths.ts';
import type { V04PublicSourceId } from '../../core/public-source-capabilities.ts';
import { TRANSCRIPTION_EXTRACTOR_KIND } from '../file-extraction/extractors/transcription.ts';
import type { ExtractionLaneKey } from '../file-extraction/job-store.ts';
import type { ExtractionPolicyDecision } from '../file-extraction/types.ts';
import type {
  ExtractionPlanResult,
  ExtractionReclassificationResult,
  ExtractionRunResult,
  FileExtractionRunner,
} from '../file-extraction/runner.ts';
import type {
  SourceAnswerSelectedItem,
  SourceIndexAnswerHandler,
  SourceIndexAnswerRequest,
} from '../source-index/answer-types.ts';
import {
  buildSourceAnswerLatencyRecord,
  buildSourceAnswerLatencyTraceRecord,
  type SourceAnswerLatencyLog,
} from '../source-index/answer-latency-log.ts';
import {
  createSourceAnswerTrace,
  recordSourceAnswerLedgerAppend,
  recordSourceAnswerLedgerBuild,
  recordSourceAnswerSqliteRetry,
  runWithSourceAnswerTrace,
  snapshotSourceAnswerTrace,
  sourceAnswerTraceErrorClass,
  type SourceAnswerTraceOutcome,
} from '../source-index/answer-latency-trace.ts';
import { DASHBOARD_READINESS_LEDGER_MAX_AGE_MS } from '../source-index/status.ts';
import type {
  SourceIndexEmbeddingLaneState,
  SourceIndexStatusHandler,
  SourceIndexStatusRequest,
  SourceIndexStatusResult,
} from '../source-index/status.ts';
import {
  READWISE_LIBRARY_CORPUS_ID,
  type ReadwiseConnectorStoreSyncHandler,
} from '../readwise/index.ts';
import {
  X_BOOKMARKS_CORPUS_ID,
  X_BOOKMARKS_FOLDER_FILTER_CODEC,
  X_BOOKMARKS_HEAD_MAX_LADDER_PAGES,
  XBookmarksLiveSyncError,
  defaultXBookmarksLiveSyncConfig,
  type XBookmarksConnectorStoreSyncHandler,
  type XBookmarksContentRecoveryHandler,
  type XBookmarksLiveSyncResult,
} from '../x-bookmarks/index.ts';
import {
  DROPBOX_APPROVED_SCOPE_FILTER_CODEC,
  DROPBOX_FILES_CORPUS_ID,
  DROPBOX_LOCATOR_RESULT_PROJECTOR_CODEC,
  DropboxSourceExportDestinationError,
  DropboxSourceExportRequestError,
  type DropboxEvalShardExportHandler,
  type DropboxEvalShardExportRequest,
  type DropboxEvalShardManifest,
  type DropboxSourceExportHandler,
  type DropboxSourceExportItemRequest,
  type DropboxSourceExportRequest,
  type DropboxSourceExportResult,
} from '../dropbox-files/index.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  isTelegramMessagesCorpusId,
} from '../telegram-messages/index.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import type { SourceScheduler, SourceSchedulerSource } from '../source-scheduler.ts';
import type { SovereigntyEngine } from '../../core/sovereignty.ts';
import type {
  CreateSourceWatchInput,
  LocalSourceWatchStore,
} from '../../core/source-watch.ts';
import {
  SOURCE_WATCH_POLICY,
  createSourceWatchPublicView,
  listSourceWatchPublicViews,
  sourceWatchPublicView,
  trustedSourceWatchOwnerFromRequest,
} from '../source-watch-runtime.ts';
import {
  GMAIL_SECURE_LOCAL_CORPUS_ID,
  GOOGLE_DRIVE_DOCS_CORPUS_ID,
  INTERNAL_EMAIL_CORPUS_ID,
} from '../google-connectors/corpora.ts';
import { renderDashboardHtmlRoute } from '../dashboard/index.ts';
import { DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER } from '../http.ts';
// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
import { renderEmbeddingLedgerPage } from '../dashboard/pages/embedding-ledger.ts';
import { readEmbeddingLedger, resolveEmbeddingLedgerPath } from '../embedding-ledger.ts';
// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
import {
  readEmbeddingRuntime,
  resolveEmbeddingOverridePath,
  writeEmbeddingOperatorOverride,
} from '../dashboard/embedding-runtime.ts';
import { readBackgroundRuntime } from '../dashboard/background-runtime.ts';
import type { DashboardBackgroundPageOptions } from '../dashboard/pages/background.ts';
import {
  buildSourceDashboardViewModel,
  type DashboardApiKeySource,
  type DashboardConnectSource,
  type DashboardOAuthSource,
  type DashboardPendingConnect,
  type DashboardUnpairedSourceState,
  type SourceDashboardHistory,
} from '../source-dashboard.ts';
import {
  defaultCredentialHealthReportPath,
  readCredentialHealthReport,
} from '../credential-health.ts';
import {
  buildSourceDispositionsView,
  renderSourceDispositionsHtml,
  resolveSourceIngestionExclusionsPath,
  readSourceIngestionExclusionsFile,
  saveSourceDispositions,
  type SourceDispositionsSource,
} from '../source-dispositions.ts';
import type { SourceDispositionEdit, SourceDispositionState } from '../../core/source-disposition-tree.ts';
import type { SourceExclusionCriterionKind } from '../../core/source-ingestion-exclusions.ts';
import { loadSensitivityMap } from '../../core/sensitivity-map.ts';
import {
  buildSourceIngestionLedgerSnapshot,
  type SourceIngestionLedgerExclusionSource,
} from '../source-ingestion-ledger.ts';
import {
  assertOneConnectedAccountPerProvider,
  ConnectedHandleAccountCardinalityError,
  ConnectedHandleGrantMutationError,
  defaultHandleRegistryPath,
  readConnectedHandleRegistry,
  removeConnectedHandles,
  withConnectedHandleGrantCustody,
  type ConnectedCredentialHandle,
  type ConnectedHandleRegistry,
} from '../credential-broker/connected-handles.ts';
import {
  CREDENTIAL_REFRESH_BUSY_RETRY_MS,
  credentialOAuth2StateStoreFromEnv,
  isCredentialRefreshBusyError,
  type CredentialOAuth2StateStore,
} from '../credential-broker/index.ts';
import {
  LocalConnectorStore,
  connectorStoreFilterCapabilityRegistry,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
  normalizeConnectorStoreSearchFilters,
  undeclaredConnectorStoreSearchRequestFields,
  unsupportedConnectorStoreFilterFields,
  type ConnectorStoreFilterCapabilityRegistry,
  type ConnectorStoreResultProjector,
} from '../connector-store/index.ts';
import { CHAT_SCOPE_FILTER_CODEC } from '../chat/chat-scope-filter.ts';
import type { WorkerCredentialDegradation } from '../credential-degradation.ts';
const CONNECTOR_STORE_FILTER_CAPABILITIES = connectorStoreFilterCapabilityRegistry([
  [{ family: 'chat' }, { chatScope: CHAT_SCOPE_FILTER_CODEC }],
  [{ family: 'x' }, { folder: X_BOOKMARKS_FOLDER_FILTER_CODEC }],
  [{ family: 'file', provider: 'dropbox' }, {
    approvedScope: DROPBOX_APPROVED_SCOPE_FILTER_CODEC,
    resultProjector: DROPBOX_LOCATOR_RESULT_PROJECTOR_CODEC,
  }],
]);

export interface EmailAnswerRequest {
  question: string;
  account?: string;
  after?: string;
  before?: string;
  from?: string;
  to?: string;
  max_messages?: number;
}

export interface EmailSearchRequest {
  question?: string;
  query?: string;
  account?: string;
  after?: string;
  before?: string;
  from?: string;
  to?: string;
  max_messages?: number;
  include_sanitized_text?: boolean;
}

export interface EmailSafeEvidence {
  source: 'gmail';
  account?: string;
  thread_id?: string;
  message_id?: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
}

export interface EmailSafeAudit {
  request_id: string;
  queries_attempted: number;
  metadata_hits: number;
  evidence_count: number;
  reasoner_ms: number;
  fallback_used: boolean;
  planner_used?: boolean;
  planner_fallback_used?: boolean;
  planned_search_count?: number;
  planner_failure_reason?: EmailPlannerFailureReason;
  retrieval_searches_attempted?: number;
  retrieval_search_summaries?: EmailRetrievalSearchSummary[];
}

export type EmailPlannerFailureReason = 'timeout' | 'http_error' | 'invalid_json' | 'invalid_plan' | 'empty_plan' | 'error';

export interface EmailRetrievalSearchSummary {
  source: 'baseline' | 'planner';
  index: number;
  hits: number;
  new_candidates_after_dedupe: number;
  capped: boolean;
}

export interface EmailSourceHealth {
  reachable: true;
  configured: boolean;
  connector: string;
  status?: 'ok' | 'degraded';
  degraded_credentials?: WorkerCredentialDegradation[];
  raw_email_exposed: false;
  detail?: string;
  dependency_check?: 'not_run';
}

export interface EmailSourceAnswer {
  answer: string;
  evidence?: EmailSafeEvidence[];
  audit?: EmailSafeAudit;
  policy: {
    raw_email_exposed: false;
    reasoning_lane: 'delphi_local';
  };
}

export interface EmailSourcePacketItem {
  item_id?: string;
  thread_id?: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  sanitized_text?: string;
  provenance: {
    source: 'gmail';
    message_id?: string;
    thread_id?: string;
  };
}

export interface EmailSourceSearch {
  packet: {
    kind: 'email_source_packet';
    packet_id: string;
    source: 'gmail';
    account?: string;
    items: EmailSourcePacketItem[];
  };
  audit: {
    request_id: string;
    queries_attempted: number;
    metadata_hits: number;
    items_returned: number;
    sanitized_reads_attempted: number;
    sanitized_reads_succeeded: number;
    truncated: boolean;
    local_packet: true;
    raw_email_exposed: false;
  };
  policy: {
    raw_email_exposed: false;
    local_only: true;
    requires_local_session: true;
  };
}

export interface EmailSourceConnector {
  name: string;
  health(): Promise<EmailSourceHealth>;
}

export interface EmailSourceWorkerOptions {
  connector?: EmailSourceConnector;
  sourceAnswer?: SourceIndexAnswerHandler;
  // Optional content-free latency ledger. When present, one JSON line per
  // answered source_answer request is appended (phase timings, corpus ids, skip
  // reasons, analyst backend/fallback, release decision — never query/content).
  sourceAnswerLatencyLog?: SourceAnswerLatencyLog;
  sourceIndexStatus?: SourceIndexStatusHandler;
  readwiseConnectorStoreSync?: ReadwiseConnectorStoreSyncHandler;
  xBookmarksConnectorStoreSync?: XBookmarksConnectorStoreSyncHandler;
  xBookmarksContentRecovery?: XBookmarksContentRecoveryHandler;
  /**
   * The source-neutral extraction factory. Serves the generic
   * `/source/index/files/*` routes, and serves a family-scoped extraction path
   * too once that family's own legacy handler is no longer wired — see
   * `fileExtractionAliasFor`.
   */
  fileExtraction?: FileExtractionRunner;
  dropboxEvalShardExport?: DropboxEvalShardExportHandler;
  dropboxSourceExport?: DropboxSourceExportHandler;
  sourceIndexEmbeddingProvider?: SourceEmbeddingProvider;
  dropboxIngestionPolicy?: SourceIngestionPolicy;
  connectorStores?: LocalConnectorStore[];
  /** Generic corpus-keyed overrides for connector-store retrieval providers. */
  connectorStoreEmbeddingProviders?: ReadonlyMap<string, SourceEmbeddingProvider>;
  /** Generic corpus-keyed principal account boundaries for connector-store reads. */
  connectorStoreAccountScopes?: ReadonlyMap<string, string>;
  /** Declared mounted-corpus identities consulted by narrower capability scopes. */
  connectorStorePrincipals?: ReadonlyMap<string, ConnectorStoreDeclaredPrincipal>;
  /** Test/integration override; shipped declarations use the module registry above. */
  connectorStoreFilterCapabilities?: ConnectorStoreFilterCapabilityRegistry;
  sourceScheduler?: SourceScheduler;
  sourceWatch?: {
    store: LocalSourceWatchStore;
  };
  sourceDashboard?: {
    sovereigntyEngine: SovereigntyEngine;
    history?: SourceDashboardHistory;
    // Authority on which dashboard card owns which corpus. Omitted means the
    // shipped default registry; pass the operator's when one is configured so
    // a corpus they added is claimed by a card rather than listed as orphaned.
    corpusRegistry?: SourceCorpusRegistry;
    registryPath?: string;
    credentialHealthReportPath?: string;
    secretStore?: SecretStore;
    oauth2StateStore?: CredentialOAuth2StateStore;
    startOAuthConnection?: typeof startOAuthSourceConnection;
    startExternalOAuthConnection?: typeof startExternalOAuthSourceConnection;
    oauthFetch?: OAuthFetch;
    apiKeyFetch?: OAuthFetch;
    connectApiKey?: typeof connectPublicApiKeySource;
    triggerSourceSync?: (request: DashboardSourceSyncRequest) => Promise<unknown>;
    refreshSchedulerSources?: (
      connectedHandlesOverride?: ConnectedCredentialHandle[],
    ) => SourceSchedulerSource[] | Promise<SourceSchedulerSource[]>;
    /** Release workers require a connected registry handle before manual reads. */
    enforceConnectedSourceReads?: boolean;
    /**
     * How often the worker re-reads the handle registry to notice a re-pair
     * performed in another process. Defaults to 30s; 0 disables the tick and
     * leaves adoption to dashboard renders.
     */
    registryAdoptionIntervalMs?: number;
    /**
     * Where the Telegram and WhatsApp pairing sessions live, for Unpair.
     *
     * Production leaves this undefined and the resolvers read `process.env` and
     * the real home directory, exactly as the export/delete custody path does.
     * It is declared here so a test can point the SAME resolvers — and the same
     * Olympus-owned-root fence in front of them — at a temporary home, rather
     * than being handed a path list that would bypass that fence.
     */
    pairingSessionPathContext?: OlympusPathContext;
    /**
     * The registry mutator Unpair uses to drop a handle.
     *
     * Injectable for the same reason the connect and sync handlers above are:
     * this one step is irreversible-adjacent — it runs after the session files
     * are already deleted — and its failure path (a registry write refused by
     * the filesystem) cannot be produced from outside without also breaking the
     * writes on either side of it. Production leaves it undefined.
     */
    removeConnectedHandles?: typeof removeConnectedHandles;
    /**
     * The folder-disposition picker's data, opened per request.
     *
     * A factory rather than a value because the picker reads stores read-only
     * and must close them again: holding open handles for the lifetime of the
     * worker so a rarely-visited page can render is how a read surface starts
     * blocking writers. Absent means the picker route reports it is not
     * configured, which is honest — the alternative is a page showing an empty
     * tree that reads as "you have no folders".
     */
    ingestionDispositions?: () => Promise<SourceDispositionsRuntime> | SourceDispositionsRuntime;
  };
  credentialDegradations?: () => WorkerCredentialDegradation[];
  recheckCredentials?: () => WorkerCredentialDegradation[];
  basePath?: string;
}

export interface ConnectorStoreDeclaredPrincipal {
  provider: string;
  accountScope: string;
}

export type ConnectorStoreChatPrincipal = ConnectorStoreDeclaredPrincipal;

export interface DashboardSourceSyncRequest {
  source: DashboardConnectSource;
  reason: 'post_connect' | 'manual';
}

/**
 * One opening of the dispositions picker's inputs: the sources, where their
 * rules live, and how to let the stores go again.
 */
export interface SourceDispositionsRuntime {
  sources: SourceDispositionsSource[];
  rulesPath?: string;
  close?: () => void;
}

export class GogcliEmailConnectorStub implements EmailSourceConnector {
  name = 'gogcli';

  async health(): Promise<EmailSourceHealth> {
    return {
      reachable: true,
      configured: false,
      connector: this.name,
      raw_email_exposed: false,
      detail: 'gogcli is not wired yet. Configure the Gateway-side connector before enabling email answers.',
    };
  }

}

export class EmailSourceWorkerError extends Error {
  status: number;
  code: string;
  suggestion?: string;

  constructor(status: number, code: string, message: string, suggestion?: string) {
    super(message);
    this.status = status;
    this.code = code;
    if (suggestion !== undefined) this.suggestion = suggestion;
  }
}

/**
 * The one honest answer for "Sync now reached the end of the dispatch chain".
 * A host `triggerSourceSync` hook that does not serve the requested source
 * raises this too, so a missing lane is a typed 501 the dashboard can read
 * rather than an anonymous 500 that reads as a worker crash.
 */
export function dashboardSourceSyncNotSupportedError(source: string): EmailSourceWorkerError {
  return new EmailSourceWorkerError(
    501,
    'source_sync_not_supported',
    `Private source worker does not support Sync now for ${source}.`,
  );
}

export function createEmailSourceWorker(options: EmailSourceWorkerOptions = {}): {
  fetch(request: Request): Promise<Response>;
  /**
   * Release everything this worker owns outside a request — today, the
   * registry-adoption tick. Idempotent, so a shutdown path that runs twice is
   * not an error.
   */
  close(): void;
} {
  const connector = options.connector ?? new GogcliEmailConnectorStub();
  const sourceAnswer = options.sourceAnswer;
  const sourceAnswerLatencyLog = options.sourceAnswerLatencyLog;
  const sourceIndexStatus = options.sourceIndexStatus;
  const readwiseConnectorStoreSync = options.readwiseConnectorStoreSync;
  const xBookmarksConnectorStoreSync = options.xBookmarksConnectorStoreSync;
  const xBookmarksContentRecovery = options.xBookmarksContentRecovery;
  const fileExtraction = options.fileExtraction;
  const dropboxEvalShardExport = options.dropboxEvalShardExport;
  const dropboxSourceExport = options.dropboxSourceExport;
  const sourceIndexEmbeddingProvider = options.sourceIndexEmbeddingProvider;
  const connectorStores = options.connectorStores ?? [];
  const connectorStoresByCorpusId = new Map(connectorStores.map((store) => [store.corpusId, store]));
  const connectorStoreEmbeddingProviders = options.connectorStoreEmbeddingProviders ?? new Map();
  const connectorStoreAccountScopes = options.connectorStoreAccountScopes ?? new Map();
  const connectorStorePrincipals = options.connectorStorePrincipals ?? new Map();
  const connectorStoreFilterCapabilities = options.connectorStoreFilterCapabilities
    ?? CONNECTOR_STORE_FILTER_CAPABILITIES;
  const sourceScheduler = options.sourceScheduler;
  const sourceWatch = options.sourceWatch;
  const sourceDashboard = options.sourceDashboard;
  const credentialDegradations = options.credentialDegradations;
  const recheckCredentials = options.recheckCredentials;
  const dashboardOAuthAttempts = new Map<DashboardOAuthSource, DashboardOAuthAttempt>();
  const dashboardDisconnectedSources = new Set<V04PublicSourceId>();
  // Paired-session sources this worker has unpaired. Separate from the
  // Disconnect latch because it answers a different question: Disconnect's
  // latch gates manual reads for broker sources, while this one is the explicit
  // connection fact the chat cards need, whose own state is otherwise inferred
  // from sync evidence that an Unpair does not change.
  const dashboardUnpairedSources = new Set<V04PublicSourceId>();
  // The handle-registry fingerprint the running scheduler was last built from.
  // `undefined` means "never looked", so the first render adopts whatever the
  // registry says rather than assuming the boot-time set is still current.
  let dashboardSchedulerRegistryStamp: string | undefined;
  // The background tick that notices a re-pair performed while the dashboard
  // was closed. Unref'd so it never holds the process open, and started only
  // where there is actually a scheduler to re-adopt into. The handle is kept so
  // `close()` can stop it: an interval nobody can cancel is a worker that
  // outlives its own shutdown, and in a test suite a leaked ticking worker goes
  // on touching a temporary registry after the test that owned it has finished.
  let dashboardSchedulerAdoptionTick: ReturnType<typeof setInterval> | undefined;
  // Clearing the interval stops new ticks but says nothing about one already in
  // flight: adoption is async, so a tick that had already started could still
  // rebuild and apply after close() returned. A closed worker must do no
  // further scheduler work, so the flag is re-checked at every await boundary.
  let dashboardWorkerClosed = false;
  if (options.sourceScheduler && options.sourceDashboard?.refreshSchedulerSources) {
    const intervalMs = options.sourceDashboard.registryAdoptionIntervalMs ?? 30_000;
    if (intervalMs > 0) {
      dashboardSchedulerAdoptionTick = setInterval(
        () => { void refreshDashboardSchedulerOnRegistryChange(); },
        intervalMs,
      );
      (dashboardSchedulerAdoptionTick as unknown as { unref?: () => void }).unref?.();
    }
  }
  let dashboardGrantMutationTail: Promise<void> = Promise.resolve();
  // Per worker, so it lives exactly as long as the stores it counted and no
  // test inherits another test's counts.
  const dashboardExclusionDebt: DashboardExclusionDebtCache = new Map();
  const basePath = normalizeBasePath(options.basePath ?? '/v1');

  return {
    close(): void {
      dashboardWorkerClosed = true;
      if (dashboardSchedulerAdoptionTick === undefined) return;
      clearInterval(dashboardSchedulerAdoptionTick);
      dashboardSchedulerAdoptionTick = undefined;
    },

    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        const dashboardNamespace = url.pathname.startsWith('/dashboard')
          || url.pathname.startsWith('/oauth/callback/');
        if (dashboardNamespace && !isV04PublicDashboardRoute(request.method, url.pathname)) {
          return new Response('Not Found', { status: 404 });
        }

        // The family-scoped extraction paths are aliases of the generic
        // `/source/index/files/*` ones, and the rewrite below is what makes the
        // cutover cheap enough to be safe.
        //
        // Family-scoped compatibility URLs are only aliases. All extraction
        // work runs through the shared factory and connector store.
        const filesAlias = fileExtractionAliasFor(url.pathname, basePath);
        const filesAliasTaken = filesAlias !== undefined
          && fileExtraction !== undefined;
        if (filesAliasTaken) url.pathname = `${basePath}${filesAlias!.genericPath}`;
        const filesAliasLane = filesAliasTaken ? filesAlias! : undefined;

        if (request.method === 'GET' && url.pathname === `${basePath}/health`) {
          const degradedCredentials = credentialDegradations?.() ?? [];
          const health = isDeepHealthRequest(url)
            ? withCredentialDegradations(await connector.health(), degradedCredentials)
            : cheapWorkerHealth(connector, degradedCredentials);
          assertNoRawEmailFields(health);
          return json(health);
        }

        if (request.method === 'GET' && url.pathname === `${basePath}/health/dependencies`) {
          const health = withCredentialDegradations(await connector.health(), credentialDegradations?.() ?? []);
          assertNoRawEmailFields(health);
          return json(health);
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/answer`) {
          if (!sourceAnswer) {
            throw new EmailSourceWorkerError(
              501,
              'source_index_answer_not_supported',
              'Private source worker does not support routed source answers.',
            );
          }
          const trace = createSourceAnswerTrace();
          return await runWithSourceAnswerTrace(trace, async () => {
            let requestParsed = false;
            try {
              const sourceAnswerRequest = await parseSourceIndexAnswerRequest(request);
              requestParsed = true;
              const result = await retrySqliteBusy(() => sourceAnswer.answer(sourceAnswerRequest));
              assertNoRawEmailFields(result);
              const response = json(result);
              await emitSourceAnswerLatencyRecords({
                log: sourceAnswerLatencyLog,
                trace,
                outcome: 'success',
                result,
              });
              return response;
            } catch (error) {
              await emitSourceAnswerLatencyRecords({
                log: sourceAnswerLatencyLog,
                trace,
                outcome: classifySourceAnswerTraceOutcome(error, requestParsed, request.signal.aborted),
                error,
              });
              throw error;
            }
          });
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/export`) {
          if (!dropboxSourceExport) {
            throw new EmailSourceWorkerError(
              501,
              'source_export_not_supported',
              'Private source worker does not support source export.',
              'Set OLYMPUS_SOURCE_EXPORT_ENABLED=true with a configured Dropbox files index and OLYMPUS_SOURCE_EXPORT_DROPBOX_ROOTS before requesting source exports.',
            );
          }
          const exportRequest = await parseDropboxSourceExportRequest(request);
          let result: DropboxSourceExportResult;
          try {
            result = await dropboxSourceExport.export(exportRequest);
          } catch (error) {
            if (error instanceof DropboxSourceExportDestinationError) {
              throw new EmailSourceWorkerError(403, 'source_export_destination_not_allowed', error.message);
            }
            if (error instanceof DropboxSourceExportRequestError) {
              throw new EmailSourceWorkerError(400, 'invalid_request', error.message);
            }
            throw error;
          }
          assertNoRawEmailFields(result);
          return json(result);
        }

        if ((request.method === 'GET' || request.method === 'POST') && url.pathname === `${basePath}/source/index/status`) {
          if (!sourceIndexStatus) {
            throw new EmailSourceWorkerError(
              501,
              'source_index_status_not_supported',
              'Private source worker does not support source-index status.',
            );
          }
          const statusRequest = await parseSourceIndexStatusRequest(request, connectorStores);
          const result = withCredentialDegradations(
            await sourceIndexStatus.status(statusRequest),
            credentialDegradations?.() ?? [],
          );
          const resultWithLatencyHealth = sourceAnswerLatencyLog?.health
            ? {
                ...result,
                answer_latency_ledger: sourceAnswerLatencyLog.health(),
              }
            : result;
          assertNoRawEmailFields(resultWithLatencyHealth);
          return json(resultWithLatencyHealth);
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/credentials/recheck`) {
          if (!recheckCredentials) {
            throw new EmailSourceWorkerError(
              501,
              'credential_recheck_not_supported',
              'Private source worker does not have credential re-check configured.',
            );
          }
          return json({
            kind: 'worker_credential_recheck',
            degraded_credentials: recheckCredentials(),
            policy: {
              raw_runtime_secrets_exposed: false,
              secret_refs_exposed: false,
            },
          });
        }

        if ((request.method === 'GET' || request.method === 'POST') && url.pathname === `${basePath}/source/scheduler/status`) {
          if (!sourceScheduler) {
            throw new EmailSourceWorkerError(
              501,
              'source_scheduler_not_supported',
              'Private source worker does not have an in-process source scheduler configured.',
            );
          }
          const result = sourceScheduler.status();
          assertNoRawEmailFields(result);
          return json(result);
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/watch/create`) {
          if (!sourceWatch) throw sourceWatchNotSupported();
          const owner = authenticatedWatchOwner(request);
          const create = await parseSourceWatchCreateRequest(request);
          const watch = createSourceWatchPublicView({ store: sourceWatch.store, create, owner });
          return json({ kind: 'source_watch', watch, policy: SOURCE_WATCH_POLICY });
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/watches`) {
          if (!sourceWatch) throw sourceWatchNotSupported();
          const owner = authenticatedWatchOwner(request);
          const page = await parseSourceWatchesRequest(request);
          return json(listSourceWatchPublicViews({ store: sourceWatch.store, owner, ...page }));
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/watch/cancel`) {
          if (!sourceWatch) throw sourceWatchNotSupported();
          const owner = authenticatedWatchOwner(request);
          const cancel = await parseSourceWatchCancelRequest(request);
          const watch = sourceWatch.store.cancelWatch(owner, cancel);
          return json({
            kind: 'source_watch',
            watch: sourceWatchPublicView(
              watch,
              sourceWatch.store.deliverySummary(owner, watch.watchId),
            ),
            policy: SOURCE_WATCH_POLICY,
          });
        }

        if (request.method === 'GET' && url.pathname === '/dashboard/auth-check') {
          return json({ ok: true });
        }

        // The folder-disposition picker. Three routes, and NONE of them is in
        // the dash_ query-token allowlist in workers/http.ts: that token exists
        // for the two counts-only reads a browser address bar can reach, and
        // this page is made of folder names. It is opened from the dashboard by
        // an authorized fetch, so the strong credential is the only way in.
        if ((request.method === 'GET'
          && (url.pathname === '/dashboard/dispositions' || url.pathname === '/dashboard/dispositions.json'))
          || (request.method === 'POST' && url.pathname === '/dashboard/dispositions')) {
          if (!sourceDashboard?.ingestionDispositions) {
            throw new EmailSourceWorkerError(
              501,
              'ingestion_dispositions_not_supported',
              'Private source worker does not have the ingestion-dispositions picker configured.',
            );
          }
          const runtime = await sourceDashboard.ingestionDispositions();
          try {
            const rulesPath = resolveSourceIngestionExclusionsPath(process.env, runtime.rulesPath);
            if (request.method === 'POST') {
              const body = await parseObjectBody(request);
              const save = saveSourceDispositions(rulesPath, parseSourceDispositionsSave(body, runtime.sources));
              return json({
                ok: true,
                kind: 'source_dispositions_save',
                result: {
                  changed: save.changed,
                  noop: save.noop,
                  applied: save.applied,
                  refused: save.refused,
                  untouched_rule_ids: save.untouched_rule_ids,
                  ...(save.write ? { write: save.write } : {}),
                },
                policy: {
                  writes_config_only: true,
                  deletes_store_content: false,
                  runs_purge_or_strip: false,
                },
              });
            }
            const file = readSourceIngestionExclusionsFile(rulesPath);
            const view = buildSourceDispositionsView({
              sources: runtime.sources,
              document: file.document,
              rulesPath,
              rulesPresent: file.present,
            });
            if (url.pathname === '/dashboard/dispositions.json') return json(view);
            return html(renderSourceDispositionsHtml(view, {
              csrfToken: request.headers.get(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) ?? undefined,
            }));
          } finally {
            runtime.close?.();
          }
        }

        // The embedding decision ledger. A query parameter on /dashboard rather
        // than a path of its own, for the same reason ?background is one: the
        // read-only dash_ token is allowlisted by PATHNAME in workers/http.ts,
        // so a /dashboard/embedding-ledger path would 401 for exactly the
        // reader this page is for. Sitting on /dashboard gives it the same auth
        // as every other dashboard page with no auth code of its own.
        //
        // It is matched ahead of the /dashboard block below and returns without
        // falling through, because it needs none of what that block builds — no
        // view model, no registry, no secret store, no OAuth pruning. This page
        // reads one file. It also stays reachable when the source dashboard is
        // not configured at all, which matters: "what happened to the
        // embeddings" is a question that outlives any particular worker's setup.
        // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
        if (request.method === 'GET'
          && url.pathname === '/dashboard'
          && url.searchParams.has(DASHBOARD_EMBEDDING_LEDGER_QUERY_PARAM)) {
          const ledger = await readEmbeddingLedger(resolveEmbeddingLedgerPath(process.env));
          const ledgerBasePath = embeddingLedgerBasePath(url);
          return html(renderEmbeddingLedgerPage(ledger, {
            ...(ledgerBasePath === undefined ? {} : { basePath: ledgerBasePath }),
          }));
        }
        // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END

        if (request.method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/dashboard.json')) {
          if (!sourceIndexStatus || !sourceDashboard) {
            throw new EmailSourceWorkerError(
              501,
              'source_dashboard_not_supported',
              'Private source worker does not have the source dashboard configured.',
            );
          }
          pruneDashboardOAuthAttempts(dashboardOAuthAttempts, new Date());
          // The worker's tick for noticing that another process re-paired a
          // source this dashboard had parked. Unpair stops the lane; the
          // re-pair runs in the CLI with no channel into this process, so
          // without this the lane stayed stopped until a restart.
          await refreshDashboardSchedulerOnRegistryChange();
          const registryRead = readDashboardRegistryOutcome(sourceDashboard.registryPath);
          const registry = registryRead.registry;
          const secretStore = dashboardSecretStore(sourceDashboard);
          const googleCloudProjectId = dashboardGoogleCloudProjectId();
          const sourceIndexDashboardStatus = withCredentialDegradations(
            // include_readiness_ledger: without it the status answers with no
            // policy counts at all, and the owner-ruled "count only what
            // Olympus reads" denominator has nothing to subtract (live 55% on
            // 2026-08-21 while the corrected ratio code sat deployed). The
            // per-item numerator is NOT gated on this flag — a status that
            // omits it has no honest coverage ratio at all, which is how the
            // same page later saturated at 100%.
            // readiness_ledger_max_age_ms: the staleness this caller would
            // accept, stated rather than assumed. Nothing caches against it
            // today; it is the standing allowance for a readiness owner too
            // expensive to score on every one of this page's polls.
            await sourceIndexStatus.status({
              include_items: false,
              include_readiness_ledger: true,
              readiness_ledger_max_age_ms: DASHBOARD_READINESS_LEDGER_MAX_AGE_MS,
            }),
            credentialDegradations?.() ?? [],
          );
          const schedulerDashboardStatus = sourceScheduler?.status();
          // The owner's exclusion rules live behind the same runtime the picker
          // opens. Without them every count in the page's "excluded by
          // configuration" section is summarized from an empty list, so the
          // page reported zero excluded folders while the rules were enforced.
          const exclusionSources = await dashboardExclusionSources(sourceDashboard, dashboardExclusionDebt);
          // The owner's secure categories, read the same way the exclusion
          // rules above are: off disk, read-only, and tolerantly. A missing map
          // is the ordinary state and an unparseable one must not take the
          // whole page down, so both yield undefined and the page omits the
          // section rather than rendering an empty one.
          const sensitivityMap = loadSensitivityMap({ allowMissing: true, ignoreInvalid: true });
          const credentialHealth = readCredentialHealthReport(
            sourceDashboard.credentialHealthReportPath
              ?? process.env.OLYMPUS_CREDENTIAL_HEALTH_REPORT_PATH?.trim()
              ?? defaultCredentialHealthReportPath(),
          );
          const view = buildSourceDashboardViewModel({
            sourceIndexStatus: sourceIndexDashboardStatus,
            ingestionLedger: buildSourceIngestionLedgerSnapshot(sourceIndexDashboardStatus, {
              exclusions: exclusionSources,
              ...(schedulerDashboardStatus ? { schedulerStatus: schedulerDashboardStatus } : {}),
              // Same registry the page uses, so the health line and the cards
              // agree on which source owns which corpus.
              ...(sourceDashboard.corpusRegistry ? { sourceCorpusRegistry: sourceDashboard.corpusRegistry } : {}),
              safeForCastor: true,
            }),
            ...(schedulerDashboardStatus ? { schedulerStatus: schedulerDashboardStatus } : {}),
            sovereigntyEngine: sourceDashboard.sovereigntyEngine,
            ...(sourceDashboard.corpusRegistry ? { sourceCorpusRegistry: sourceDashboard.corpusRegistry } : {}),
            ...(sourceDashboard.history ? { history: sourceDashboard.history } : {}),
            connectedHandleRegistry: registry,
            ...(registryRead.unreadable ? { connectedHandleRegistryUnreadable: true } : {}),
            unpairedSources: dashboardUnpairedSourceStates(
              dashboardUnpairedSources,
              sourceDashboard.registryPath ?? defaultHandleRegistryPath(),
            ),
            ...(credentialHealth ? { credentialHealth } : {}),
            oauthClientIds: await dashboardOAuthClientIds(registry, secretStore),
            oauthClientSecretAvailability: await dashboardOAuthClientSecretAvailability(secretStore),
            ...(googleCloudProjectId ? { googleCloudProjectId } : {}),
            googlePilotClientConfigured: dashboardGooglePilotClientConfigured(),
            oauthRedirectBaseUrl: dashboardOAuthRedirectOrigin(url, request.headers),
            apiKeyAvailability: await dashboardApiKeyAvailability(secretStore),
            pendingConnects: dashboardPendingConnects(dashboardOAuthAttempts),
            contentExtractionStallThresholdHours: dropboxContentExtractionStallHours(process.env),
            ingestionDispositionsAvailable: sourceDashboard.ingestionDispositions !== undefined,
            ...(sensitivityMap ? { sensitivityMap } : {}),
          });
          assertNoRawEmailFields(view);
          if (url.pathname === '/dashboard.json') return json(view);
          // The embedding lane's run state, schedule and model, read off the
          // overnight guard's and the drain's own report files. Read here rather
          // than inside the renderers because those are synchronous and pure;
          // every failure inside comes back as a stated state, so this never
          // throws and never blocks the page on the router.
          const embeddingRuntime = await readEmbeddingRuntime({ env: process.env });
          // Every background lane's own report, read the same way and for the
          // same reason: these are synchronous file reads, the renderers are
          // pure, and a lane that cannot be read costs the reader a line of
          // text rather than the page. The sample store this appends to is what
          // gives the lanes a trailing rate — one reading per render.
          const backgroundRuntime = readBackgroundRuntime({ env: process.env });
          const controlSessionCsrfToken = request.headers.get(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) ?? undefined;
          const options: DashboardBackgroundPageOptions = {
            embeddingRuntime,
            backgroundRuntime,
            ...(controlSessionCsrfToken ? { controlSessionCsrfToken } : {}),
          };
          const page = renderDashboardHtmlRoute({ url, view, options });
          return html(page.html, page.status);
        }

        if (request.method === 'GET' && url.pathname.startsWith('/oauth/callback/')) {
          if (!sourceDashboard) {
            throw new EmailSourceWorkerError(
              501,
              'source_dashboard_not_supported',
              'Private source worker does not have the source dashboard configured.',
            );
          }
          const source = parseDashboardOAuthSource(decodeURIComponent(url.pathname.slice('/oauth/callback/'.length)));
          const attempt = dashboardOAuthAttempts.get(source);
          // THIS ROUTE IS UNAUTHENTICATED. A provider redirect is just a GET
          // anyone can make, so the `state` this flow generated is the ONLY
          // proof that a given callback belongs to the attempt in memory —
          // and nothing above may be mutated before that proof is checked.
          // Recording a refusal first meant any stranger's
          // `GET /oauth/callback/dropbox?error=access_denied` rewrote the
          // owner's live attempt and dropped their card out of "connecting".
          const state = asOptionalString(url.searchParams.get('state'));
          if (!attempt
            || dashboardOAuthAttemptExpired(attempt, new Date())
            || !state
            || !dashboardOAuthStateMatches(attempt, state)) {
            // Deliberately ONE answer for four different facts — no attempt,
            // an expired one, no state, the wrong state. An unauthenticated
            // caller learns nothing about whether a connect is in flight, and
            // in every one of these cases the stored attempt is left exactly
            // as it was. Only a genuinely absent or expired record is dropped,
            // which the prune pass would have done anyway.
            if (attempt && dashboardOAuthAttemptExpired(attempt, new Date())) {
              clearDashboardOAuthAttempt(dashboardOAuthAttempts, source, attempt);
            }
            return dashboardOAuthFailureHtml({
              source,
              reason: 'This connection attempt is no longer active. Start connect again from the Olympus dashboard.',
              returnTo: dashboardReturnTo(),
              status: 410,
            });
          }
          const callbackError = asOptionalString(url.searchParams.get('error'));
          if (callbackError) {
            // The error param arrives on a provider-crafted redirect: only a
            // known OAuth code is repeated, never the raw value.
            const errorCode = safeOAuthErrorCode(callbackError);
            // Kept, not deleted. The dashboard reads this record to say what
            // the provider refused; without it the card sat in "connecting"
            // for the rest of the ten-minute window over a dead attempt
            // (owner, 2026-09-03). It still expires on the same clock, and the
            // next Connect replaces it outright.
            attempt.error = { code: errorCode ?? 'unrecognized_error', at: new Date().toISOString() };
            return dashboardOAuthFailureHtml({
              source,
              reason: `OAuth provider returned ${errorCode ?? 'an unrecognized error'}.`,
              returnTo: attempt.returnTo,
              status: 400,
            });
          }
          const code = asOptionalString(url.searchParams.get('code'));
          if (!code) {
            clearDashboardOAuthAttempt(dashboardOAuthAttempts, source, attempt);
            return dashboardOAuthFailureHtml({
              source,
              reason: 'OAuth callback is missing code or state.',
              returnTo: attempt.returnTo,
              status: 400,
            });
          }
          try {
            await withDashboardGrantMutation(async () => {
              if (dashboardOAuthAttempts.get(source) !== attempt) {
                throw new Error('OAuth connection attempt is no longer active.');
              }
              await attempt.pending.completeCallback({ state, code });
              clearDashboardOAuthAttempt(dashboardOAuthAttempts, source, attempt);
              markDashboardSourceConnected(source, dashboardDisconnectedSources);
              await triggerDashboardPostConnectSync({
                source,
                reason: 'post_connect',
              });
            });
          } catch (error) {
            clearDashboardOAuthAttempt(dashboardOAuthAttempts, source, attempt);
            return dashboardOAuthFailureHtml({
              source,
              reason: dashboardCallbackFailureReason(error, source),
              returnTo: attempt.returnTo,
              status: 400,
            });
          }
          // The authorization runs in its OWN tab now, so redirecting this one
          // to the dashboard produced a second dashboard tab beside the one the
          // owner is already watching. This tab says the work is done and that
          // it can be closed; the dashboard tab's poll picks the connection up
          // on its own.
          return dashboardOAuthCompleteHtml({ source, returnTo: attempt.returnTo });
        }

        if (request.method === 'POST' && url.pathname === '/dashboard/connect/oauth/start') {
          return await withDashboardGrantMutation(async () => {
          if (!sourceDashboard) {
            throw new EmailSourceWorkerError(
              501,
              'source_dashboard_not_supported',
              'Private source worker does not have the source dashboard configured.',
            );
          }
          const record = await parseObjectBody(request);
          const source = parseDashboardOAuthSource(record.source);
          const secretStore = dashboardSecretStore(sourceDashboard);
          const registry = readDashboardRegistry(sourceDashboard.registryPath);
          assertDashboardAccountCardinality(registry, source);
          const clientIds = await dashboardOAuthClientIds(registry, secretStore);
          const clientId = asOptionalString(record.client_id) ?? dashboardOAuthClientIdForSource(source, clientIds);
          if (!clientId) {
            throw new EmailSourceWorkerError(409, 'oauth_client_id_missing', `Missing OAuth client id: ${dashboardOAuthClientIdConfigKey(source)}.`);
          }
          // Resolved after the client id, because which stored secret may be
          // sent depends on which client this flow is going out with.
          const clientSecret = await dashboardOAuthClientSecret(source, secretStore, asOptionalString(record.client_secret), clientId);
          if (dashboardOAuthClientSecretRequired(source) && !clientSecret) {
            throw new EmailSourceWorkerError(409, 'oauth_client_secret_missing', `Missing OAuth client secret: ${dashboardOAuthClientSecretConfigKey(source)}.`);
          }
          // A client id in the body is a registration, not one call's argument.
          // It used to reach the store only from a COMPLETED callback, so a
          // flow that died at the provider — as the live X flow did on
          // 2026-08-19 — left the next start call failing with
          // oauth_client_id_missing and the owner re-pasting the same id.
          const submittedClientId = asOptionalString(record.client_id);
          if (submittedClientId) {
            await secretStore.set(dashboardOAuthClientIdConfigKey(source), submittedClientId);
          }
          // The secret is a registration for the same reason — and for X it is
          // the credential the token exchange itself authenticates with, so a
          // later Reconnect must find it without the owner re-pasting it.
          const submittedClientSecret = asOptionalString(record.client_secret);
          if (submittedClientSecret && dashboardOAuthClientSecretRequired(source)) {
            await secretStore.set(dashboardOAuthClientSecretConfigKey(source), submittedClientSecret);
          }
          const redirectUri = `${dashboardOAuthRedirectOrigin(url, request.headers)}/oauth/callback/${encodeURIComponent(source)}`;
          const startOAuth = sourceDashboard.startExternalOAuthConnection ?? startExternalOAuthSourceConnection;
          const pending = await startOAuth({
            source,
            clientId,
            ...(clientSecret ? { clientSecret } : {}),
            registryPath: sourceDashboard.registryPath ?? defaultHandleRegistryPath(),
            secretStore,
            redirectUri,
            openBrowser: false,
            ...(sourceDashboard.oauthFetch ? { fetch: sourceDashboard.oauthFetch } : {}),
          });
          // The starter is an injectable seam whose URL the owner's browser
          // will follow and whose clock the dashboard displays: the URL is
          // origin-checked against the source's own provider and the
          // timestamps are route-owned, never trusted (R61E).
          const expectedOrigin = oauthAuthorizeOrigin(source);
          let authorizationUrl: URL;
          try {
            authorizationUrl = new URL(pending.authorizationUrl);
          } catch {
            throw new EmailSourceWorkerError(502, 'oauth_start_invalid', `OAuth start did not produce a valid authorization URL for ${source}.`);
          }
          if (authorizationUrl.origin !== expectedOrigin) {
            throw new EmailSourceWorkerError(502, 'oauth_start_invalid', `OAuth start produced an authorization URL outside ${expectedOrigin}.`);
          }
          const startedAtDate = new Date();
          const expiresAt = dashboardBoundedExpiry(pending.expiresAt, startedAtDate);
          dashboardOAuthAttempts.set(source, {
            source,
            pending,
            returnTo: dashboardReturnTo(),
            startedAt: startedAtDate.toISOString(),
            expiresAt,
          });
          return json({
            ok: true,
            source,
            authorization_url: authorizationUrl.toString(),
            expires_at: expiresAt,
            policy: {
              raw_runtime_secrets_exposed: false,
              client_secret_returned: false,
            },
          });
          });
        }

        // Abandon a consent attempt. Same custody as the start route it undoes
        // (control session + CSRF at the boundary, same public-route list), and
        // nothing else: it deletes one in-memory record. Before it existed the
        // owner's only way past a refused attempt was to wait out its expiry,
        // because pressing the button again started the identical flow.
        if (request.method === 'POST' && url.pathname === '/dashboard/connect/oauth/cancel') {
          return await withDashboardGrantMutation(async () => {
            if (!sourceDashboard) {
              throw new EmailSourceWorkerError(
                501,
                'source_dashboard_not_supported',
                'Private source worker does not have the source dashboard configured.',
              );
            }
            const record = await parseObjectBody(request);
            const source = parseDashboardOAuthSource(record.source);
            const cancelled = dashboardOAuthAttempts.delete(source);
            return json({
              ok: true,
              source,
              cancelled,
              status_message: cancelled
                ? 'Connection attempt cancelled. Press Connect when you are ready to start a new one.'
                : 'No connection attempt was pending.',
            });
          });
        }

        if (request.method === 'POST' && url.pathname === '/dashboard/connect/api-key') {
          return await withDashboardGrantMutation(async () => {
          if (!sourceDashboard) {
            throw new EmailSourceWorkerError(
              501,
              'source_dashboard_not_supported',
              'Private source worker does not have the source dashboard configured.',
            );
          }
          const record = await parseObjectBody(request);
          const source = parseDashboardApiKeySource(record.source);
          if (source === 'readwise') {
            assertDashboardAccountCardinality(
              readConnectedHandleRegistry(sourceDashboard.registryPath ?? defaultHandleRegistryPath()),
              source,
            );
          }
          const apiKey = asOptionalString(record.api_key);
          if (!apiKey) throw new EmailSourceWorkerError(400, 'invalid_request', 'api_key is required.');
          const connectApiKey = sourceDashboard.connectApiKey ?? connectPublicApiKeySource;
          let result: Awaited<ReturnType<typeof connectPublicApiKeySource>>;
          try {
            result = await connectApiKey({
              source,
              apiKey,
              registryPath: sourceDashboard.registryPath ?? defaultHandleRegistryPath(),
              secretStore: dashboardSecretStore(sourceDashboard),
              ...(sourceDashboard.apiKeyFetch ? { fetch: sourceDashboard.apiKeyFetch } : {}),
            });
          } catch (error) {
            if (error instanceof ConnectedHandleGrantMutationError) throw error;
            if (error instanceof ConnectedHandleAccountCardinalityError) {
              throw new EmailSourceWorkerError(
                409,
                'dashboard_account_cardinality_violation',
                'Olympus v0.4 supports one connected account per source. Disconnect the existing account before connecting another.',
              );
            }
            // Validator text is never relayed: no enumeration of transformed
            // key encodings is a complete boundary guarantee (R61C). The stock
            // validators throw fixed strings anyway, so a fixed sentence loses
            // nothing a reader could act on.
            throw new EmailSourceWorkerError(
              400,
              'api_key_validation_failed',
              `Validating the ${source} API key failed. Paste a current key and try again, or retry when the provider is reachable.`,
            );
          }
          markDashboardSourceConnected(source, dashboardDisconnectedSources);
          await triggerDashboardPostConnectSync({
            source,
            reason: 'post_connect',
          });
          // Handle names in the response are a closed vocabulary derived from
          // the source — the injectable connect boundary is hostile on success
          // exactly as on failure (R61D), so connector-returned strings are
          // intersected against the names this route already knows.
          const knownHandles = source === 'readwise' ? ['readwise.personal'] : [];
          return json({
            ok: true,
            source,
            handles: result.handles.filter((handle) => knownHandles.includes(handle)),
            policy: {
              raw_runtime_secrets_exposed: false,
              api_key_returned: false,
            },
          });
          });
        }

        if (request.method === 'POST' && url.pathname === '/dashboard/sync-now') {
          return await withDashboardGrantMutation(async () => {
          if (!sourceDashboard) {
            throw new EmailSourceWorkerError(
              501,
              'source_dashboard_not_supported',
              'Private source worker does not have the source dashboard configured.',
            );
          }
          const record = await parseObjectBody(request);
          const source = parseDashboardSyncSource(record.source);
          assertDashboardSourceMayRead(source, sourceDashboard, dashboardDisconnectedSources);
          const result = await runDashboardSourceSync({
            source,
            reason: 'manual',
          });
          assertNoRawEmailFields(result);
          return json({
            ok: true,
            source,
            result,
            policy: {
              raw_runtime_secrets_exposed: false,
              source_text_returned: false,
            },
          });
          });
        }

        if (request.method === 'POST' && url.pathname === '/dashboard/disconnect') {
          return await withDashboardGrantMutation(async () => {
          if (!sourceDashboard) {
            throw new EmailSourceWorkerError(
              501,
              'source_dashboard_not_supported',
              'Private source worker does not have the source dashboard configured.',
            );
          }
          const record = await parseObjectBody(request);
          const sourceId = parseDashboardDisconnectSource(record.source_id);
          if (record.acknowledge !== true) {
            throw new EmailSourceWorkerError(
              400,
              'disconnect_confirmation_required',
              'Confirm that Disconnect retains indexed data and developer-app registration and does not revoke provider-side access.',
            );
          }
          if (sourceScheduler && !sourceDashboard.refreshSchedulerSources) {
            throw new EmailSourceWorkerError(
              501,
              'disconnect_scheduler_refresh_not_supported',
              'Disconnect cannot safely refresh the active scheduler in this worker.',
            );
          }
          const registryPath = sourceDashboard.registryPath ?? defaultHandleRegistryPath();
          return await withConnectedHandleGrantCustody(
            registryPath,
            { advanceEpoch: true },
            async () => {
              const registry = readConnectedHandleRegistry(registryPath);
              const plan = dashboardDisconnectPlan(registry, sourceId);
              if (plan.handles.length === 0) {
                throw new EmailSourceWorkerError(409, 'source_not_connected', 'This source has no connected local credential/account grant.');
              }
              if (sourceScheduler && sourceDashboard.refreshSchedulerSources) {
                const removedHandleIds = new Set(plan.handles.map((handle) => handle.handle));
                const remainingHandles = registry.handles.filter((handle) => !removedHandleIds.has(handle.handle));
                const nextSources = await sourceDashboard.refreshSchedulerSources(remainingHandles);
                if (dashboardDisconnectHasRunningRead(sourceScheduler.status(), plan.sourceIds)) {
                  throw new EmailSourceWorkerError(
                    409,
                    'disconnect_source_busy',
                    'This source is finishing a read. Retry Disconnect after the current read completes.',
                  );
                }
                // Stop new scheduled reads before touching credential custody. If
                // a later delete fails, the source is safely parked and retrying
                // Disconnect can finish; no stale scheduled definition survives.
                sourceScheduler.updateSources(nextSources);
              }
              const secretStore = dashboardSecretStore(sourceDashboard);
              try {
                for (const key of plan.credentialKeys) await secretStore.delete(key);
                const oauth2StateStore = sourceDashboard.oauth2StateStore
                  ?? credentialOAuth2StateStoreFromEnv(process.env);
                for (const handle of plan.handles.filter((candidate) => candidate.provider === 'x')) {
                  if (handle.oauth2Refresh || handle.tokenSecretRefs?.length) continue;
                  if (!oauth2StateStore?.delete) {
                    throw new Error('X local OAuth state store does not support grant removal.');
                  }
                  await oauth2StateStore.delete(handle.handle);
                }
              } catch {
                throw new EmailSourceWorkerError(
                  500,
                  'disconnect_credential_delete_failed',
                  'Disconnect could not remove the selected local credential. No registry handle was removed.',
                );
              }
              const removed = removeConnectedHandles(plan.handles.map((handle) => handle.handle), registryPath);
              for (const disconnectedSource of plan.sourceIds) dashboardDisconnectedSources.add(disconnectedSource);
              for (const oauthSource of dashboardOAuthSourcesForDisconnected(plan.sourceIds)) {
                dashboardOAuthAttempts.delete(oauthSource);
              }
              return json({
                ok: true,
                source_id: sourceId,
                disconnected_source_ids: [...plan.sourceIds].sort(),
                removed_handles: removed.removed.map((handle) => handle.handle).sort(),
                scheduling_refreshed: sourceScheduler !== undefined,
                policy: {
                  scheduled_reads_stopped: true,
                  manual_reads_stopped: true,
                  indexed_data_deleted: false,
                  developer_app_registration_retained: true,
                  provider_grant_revoked: false,
                  restart_required: false,
                  raw_runtime_secrets_exposed: false,
                },
              });
            },
          );
          });
        }

        // Unpair: Disconnect's twin for a source paired as a session.
        //
        // Telegram and WhatsApp hold no broker credential, so Disconnect — which
        // is attached off the handle registry — never appeared on their rows and
        // there was no way to end a pairing from the dashboard at all (owner
        // decision, 2026-09-02). This removes the pairing session THIS computer
        // holds and parks the lane. Everything else it deliberately leaves:
        //
        // - the indexed corpus, and the raw capture spool and media beside it,
        //   which hold the message text and voice notes. Only the pairing
        //   artifacts named in core/pairing-session-paths.ts are removed, and
        //   the fence below refuses any of them resolved outside an
        //   Olympus-owned root rather than deleting a stranger's directory.
        // - the provider-side linked device. The Telethon reader and the
        //   whatsmeow bridge are separate processes; this worker can park its
        //   own lane and nothing more, so the confirmation tells the reader to
        //   stop the capture service first and where to unlink the device.
        if (request.method === 'POST' && url.pathname === '/dashboard/unpair') {
          return await withDashboardGrantMutation(async () => {
          if (!sourceDashboard) {
            throw new EmailSourceWorkerError(
              501,
              'source_dashboard_not_supported',
              'Private source worker does not have the source dashboard configured.',
            );
          }
          const record = await parseObjectBody(request);
          const sourceId = parseDashboardUnpairSource(record.source_id);
          if (record.acknowledge !== true) {
            throw new EmailSourceWorkerError(
              400,
              'unpair_confirmation_required',
              'Confirm that Unpair removes only this computer\'s pairing session, retains indexed and captured data, and does not remove the linked device at the provider.',
            );
          }
          if (sourceScheduler && !sourceDashboard.refreshSchedulerSources) {
            throw new EmailSourceWorkerError(
              501,
              'unpair_scheduler_refresh_not_supported',
              'Unpair cannot safely refresh the active scheduler in this worker.',
            );
          }
          const registryPath = sourceDashboard.registryPath ?? defaultHandleRegistryPath();
          // The durable latch is committed before the teardown, so it must be
          // committable. Checked before the more general read below, so the
          // specific obstruction — something other than a regular file at that
          // path — is reported as itself rather than as a failed read.
          try {
            assertUnpairedRecordWritable(registryPath);
          } catch {
            throw new EmailSourceWorkerError(
              409,
              'unpair_record_not_writable',
              'The unpaired-source record beside the handle registry is not a regular file, or cannot be inspected, so Unpair cannot record what it did. Repair or remove it by hand, then retry.',
            );
          }
          // Checked before the custody lease and before the handle
          // registry is read. A record that cannot be parsed cannot be safely
          // merged into — the merge would silently drop whatever it held, which
          // is how an unpaired source comes back as connected — and whatever
          // makes it unreadable (a permission on the file, or on the directory
          // holding it) is usually the same thing that would make the lease and
          // the registry read fail a moment later with a bare 500. This refusal
          // names the file, which is safe here: a control route is only ever
          // reached by the holder of a control session, never by the read-only
          // dashboard token.
          const existingRecord = readUnpairedSources(registryPath);
          if (existingRecord.status === 'unreadable') {
            throw new EmailSourceWorkerError(
              409,
              'unpair_record_unreadable',
              `The unpaired-source record cannot be read (${existingRecord.reason}): ${existingRecord.path}. Repair or remove that file, then retry.`,
            );
          }
          return await withConnectedHandleGrantCustody(
            registryPath,
            { advanceEpoch: true },
            async () => {
              const registry = readConnectedHandleRegistry(registryPath);
              // A paired session may own no handle at all — that is the normal
              // state for both chat sources — so an empty plan is not a refusal
              // here, only an empty set of handle-derived credential keys.
              const plan = dashboardDisconnectPlan(registry, sourceId);
              const secretStore = dashboardSecretStore(sourceDashboard);
              const session = await dashboardPairingSession(
                sourceId,
                plan.credentialKeys,
                secretStore,
                sourceDashboard.pairingSessionPathContext,
              );
              // Every artifact and every ancestor is proven before ANY of them
              // is removed: a refusal discovered halfway through a delete loop
              // arrives after earlier artifacts are already gone.
              const removalPlan = planPairingSessionRemoval(
                session.paths,
                sourceDashboard.pairingSessionPathContext ?? { env: process.env },
              );
              if (!removalPlan.ok) throw dashboardUnpairPathError(removalPlan.refusal);
              const selectedSourceIds = new Set<V04PublicSourceId>([sourceId, ...plan.sourceIds]);
              if (sourceScheduler && sourceDashboard.refreshSchedulerSources) {
                const removedHandleIds = new Set(plan.handles.map((handle) => handle.handle));
                const remainingHandles = registry.handles.filter((handle) => !removedHandleIds.has(handle.handle));
                const nextSources = await sourceDashboard.refreshSchedulerSources(remainingHandles);
                if (dashboardDisconnectHasRunningRead(sourceScheduler.status(), selectedSourceIds)) {
                  throw new EmailSourceWorkerError(
                    409,
                    'unpair_source_busy',
                    'This source is finishing a read. Retry Unpair after the current read completes.',
                  );
                }
                // Park the lane before touching the session on disk, so a
                // failed delete leaves a stopped source rather than a running
                // reader over a half-removed login.
                sourceScheduler.updateSources(nextSources);
              }
              const plannedPaths = removalPlan.plan.targets.map((target) => target.path);
              // COMMITTED BEFORE ANY mutation, pessimistically and
              // UNCONDITIONALLY: at this instant every planned artifact is
              // still on disk, so that is what the record says. Skipping the
              // write when the plan was empty left the stored reference and the
              // handle to be deleted with no durable latch behind them at all,
              // so a death in between erased the pairing and forgot it had.
              // Erring toward "unpaired, with work remaining" is the only
              // direction that cannot mislead.
              // Carried forward from whatever a previous attempt left behind.
              // A retry used to REPLACE the record with a fresh in-progress one
              // describing only what it could see now — and after the first
              // attempt's deletions that path list was empty, so the record
              // reconciled straight to a clean `unpaired` while the stale
              // handle the first attempt could not remove still stood and
              // rebuilt the lane on the next boot. Obligations accumulate; they
              // are only ever discharged by the step that owns them.
              // Re-read INSIDE the lease. The pre-lease read above is only an
              // early refusal; obligations must be computed from the record as
              // it stands now, or two attempts interleaving would each write
              // from its own stale snapshot and the later one would erase an
              // obligation the earlier had just recorded.
              const leasedRecord = readUnpairedSources(registryPath);
              if (leasedRecord.status === 'unreadable') {
                throw new EmailSourceWorkerError(
                  409,
                  'unpair_record_unreadable',
                  `The unpaired-source record cannot be read (${leasedRecord.reason}): ${leasedRecord.path}. Repair or remove that file, then retry.`,
                );
              }
              const priorObligations = dashboardUnpairObligations(leasedRecord, selectedSourceIds);
              const openPaths = [...new Set([...priorObligations.paths, ...plannedPaths])].sort();
              const openSteps = [...new Set([
                ...priorObligations.steps,
                ...(session.credentialKeys.length > 0 ? ['stored_reference'] : []),
                ...(plan.handles.length > 0 ? ['connected_handle'] : []),
              ])].sort();
              recordUnpairedSources(
                [...selectedSourceIds].map((unpairedSource) => ({
                  source_id: unpairedSource,
                  state: 'unpair_in_progress' as const,
                  ...(openPaths.length > 0 ? { unremoved_paths: openPaths } : {}),
                  ...(openSteps.length > 0 ? { failed_steps: openSteps } : {}),
                })),
                registryPath,
              );
              for (const unpairedSource of selectedSourceIds) dashboardUnpairedSources.add(unpairedSource);
              const removedSessionPaths: string[] = [];
              const unremovedSessionPaths: string[] = [];
              for (const target of removalPlan.plan.targets) {
                // Past the preflight, a failure is reported rather than thrown.
                // Stopping here would leave the pairing half removed AND the
                // handle, the stored session reference and the card's state all
                // claiming it is still connected — the worst of both answers.
                try {
                  if (removePlannedPairingSessionFile(target) === 'removed') {
                    removedSessionPaths.push(target.path);
                  }
                } catch {
                  unremovedSessionPaths.push(target.path);
                }
              }
              // A stored reference that will not delete is NOT a reason to stop
              // and keep the handle. Throwing here left a usable handle behind
              // artifacts that were already gone, and a usable handle used to
              // suppress the durable record entirely — so the card claimed a
              // live session over a session this route had just deleted, before
              // and after a restart. The teardown continues and the failed step
              // is recorded instead.
              const failedSteps: string[] = [];
              for (const key of session.credentialKeys) {
                try {
                  await secretStore.delete(key);
                } catch {
                  if (!failedSteps.includes('stored_reference')) failedSteps.push('stored_reference');
                }
              }
              // The last irreversible step, and the one that used to escape. A
              // registry write that throws here left the session files already
              // deleted, no failed step recorded, and a stale handle standing —
              // which the pessimistic record would later reconcile away to a
              // plain `unpaired` once the paths were gone, while that handle
              // could rebuild the lane after a restart. It is now a named
              // failure like any other, and `complete` requires it to have
              // worked.
              let removed = { removed: [] as ConnectedCredentialHandle[] };
              if (plan.handles.length > 0) {
                const removeHandles = sourceDashboard.removeConnectedHandles ?? removeConnectedHandles;
                try {
                  removed = removeHandles(plan.handles.map((handle) => handle.handle), registryPath);
                } catch {
                  failedSteps.push('connected_handle');
                }
              }
              // Every obligation this run opened, minus the ones its own step
              // discharged. A step with nothing left to do is discharged too:
              // an attempt that already deleted the stored reference before
              // dying leaves no key to delete, and that is success, not a debt
              // to carry forever.
              const outstandingPaths = [...new Set([
                ...unremovedSessionPaths,
                // Paths a previous attempt recorded that this run did not plan
                // — a session path that has since been reconfigured — are still
                // outstanding if they are still there.
                ...priorObligations.paths.filter((path) =>
                  !plannedPaths.includes(path) && artifactPresence(path) !== 'gone'),
              ])].sort();
              const outstandingSteps = [...new Set(failedSteps)].sort();
              const complete = outstandingPaths.length === 0 && outstandingSteps.length === 0;
              // This run's own outcome, plus a reconcile of every OTHER record
              // the file holds. A previous run that died between its deletes
              // and its narrowing write left a record naming files that are now
              // gone; this is the lease-holding path that can finally commit
              // what the render could only compute.
              // Everything this run PROVED is finished, named explicitly. The
              // writer unions against the record as it stands at write time and
              // removes only what is listed here, so an obligation recorded by
              // another attempt in the meantime survives instead of being
              // overwritten by this run's view of the world.
              const dischargedPaths = [...new Set([
                ...removedSessionPaths,
                ...priorObligations.paths.filter((path) => artifactPresence(path) === 'gone'),
              ])];
              const dischargedSteps = [
                ...(failedSteps.includes('stored_reference') ? [] : ['stored_reference']),
                ...(failedSteps.includes('connected_handle') ? [] : ['connected_handle']),
              ];
              // Reconciliation for OTHER sources, which this run has not
              // touched: a previous attempt that died before its narrowing
              // write left a record naming files that are now gone, and this is
              // a lease-holding path that can finally commit what a render could
              // only compute.
              const reconciledRead = readReconciledUnpairedSources(registryPath);
              const reconciledOthers = (reconciledRead.status === 'ok' ? reconciledRead.records : [])
                .filter((record) => !selectedSourceIds.has(record.source_id as V04PublicSourceId));
              recordUnpairedSources(
                [
                  ...reconciledOthers.map((record) => ({
                    source_id: record.source_id,
                    state: record.state,
                    ...(record.unremoved_paths ? { unremoved_paths: record.unremoved_paths } : {}),
                    ...(record.failed_steps ? { failed_steps: record.failed_steps } : {}),
                    discharged: {
                      paths: (existingRecord.status === 'ok'
                        ? existingRecord.records.find((prior) => prior.source_id === record.source_id)?.unremoved_paths ?? []
                        : []
                      ).filter((path) => !(record.unremoved_paths ?? []).includes(path)),
                    },
                  })),
                  ...[...selectedSourceIds].map((unpairedSource) => ({
                    source_id: unpairedSource,
                    state: complete ? 'unpaired' as const : 'unpair_incomplete' as const,
                    ...(outstandingPaths.length > 0 ? { unremoved_paths: outstandingPaths } : {}),
                    ...(outstandingSteps.length > 0 ? { failed_steps: outstandingSteps } : {}),
                    discharged: { paths: dischargedPaths, steps: dischargedSteps },
                  })),
                ],
                registryPath,
              );
              // The scheduler was just parked from a registry this run rewrote;
              // record that so the registry-change adoption does not treat our
              // own write as somebody else's re-pair.
              dashboardSchedulerRegistryStamp = dashboardRegistryStamp(registryPath);
              return json({
                ok: true,
                source_id: sourceId,
                unpaired_source_ids: [...selectedSourceIds].sort(),
                removed_handles: removed.removed.map((handle) => handle.handle).sort(),
                removed_session_paths: [...removedSessionPaths].sort(),
                ...(outstandingPaths.length > 0 ? { unremoved_session_paths: outstandingPaths } : {}),
                scheduling_refreshed: sourceScheduler !== undefined,
                // The browser shows this verbatim. A partial removal that
                // rendered as the ordinary "Done" was a completion claim over
                // a session file still sitting on disk.
                ...(outstandingSteps.length > 0 ? { failed_steps: outstandingSteps } : {}),
                status_message: complete
                  ? 'Unpaired. Waiting for the next refresh.'
                  : outstandingPaths.length > 0
                    ? `Unpair incomplete — remove by hand: ${outstandingPaths.join(', ')}`
                    : failedSteps.includes('connected_handle')
                    ? 'Unpair incomplete — the pairing session was deleted, but its registry handle could not be removed. Re-run Unpair, or remove the handle with the CLI.'
                    : 'Unpair incomplete — the pairing session was deleted, but its stored reference could not be removed. Re-run Unpair once the secret store is reachable.',
                policy: {
                  scheduled_reads_stopped: true,
                  manual_reads_stopped: true,
                  // True only when nothing this route planned to remove is left
                  // behind, so a partial removal cannot read as a clean one.
                  local_pairing_session_removed: outstandingPaths.length === 0 && plannedPaths.length > 0,
                  session_removal_complete: complete,
                  stored_reference_removed: !outstandingSteps.includes('stored_reference'),
                  connected_handle_removed: !outstandingSteps.includes('connected_handle'),
                  indexed_data_deleted: false,
                  captured_messages_deleted: false,
                  provider_device_still_linked: true,
                  capture_service_stopped: false,
                  restart_required: false,
                  raw_runtime_secrets_exposed: false,
                },
              });
            },
          );
          });
        }

        // The Background page's embedding-priority toggle.
        //
        // It writes one file: the overnight source-drain guard's operator
        // override, whose path comes from the same env var the guard honors
        // (resolveEmbeddingOverridePath), so the control and the thing it
        // controls can never drift onto two different paths. ON writes the
        // guard's `embedding-priority` token; OFF removes the file, which is the
        // guard's own spelling of normal arbitration.
        //
        // Auth is inherited, exactly as /dashboard/sync-now inherits it: the
        // dash_ query token is admitted by workers/http.ts for GET /dashboard
        // and /dashboard.json only, so a POST here can be reached with the
        // worker bearer token and nothing else.
        if (request.method === 'POST' && url.pathname === '/dashboard/embedding-priority') {
          const record = await parseObjectBody(request);
          const on = asOptionalBoolean(record.on);
          if (on === undefined) {
            throw new EmailSourceWorkerError(
              400,
              'invalid_request',
              'on must be true or false.',
            );
          }
          const overridePath = resolveEmbeddingOverridePath(process.env);
          try {
            writeEmbeddingOperatorOverride(overridePath, on);
          } catch {
            // The path is the operator's own state directory. Naming it back at
            // them is useful; relaying the filesystem's message is not, and a
            // raw errno string on a dashboard is how paths and permissions leak
            // into a page that promises neither.
            throw new EmailSourceWorkerError(
              500,
              'embedding_priority_write_failed',
              'Could not write the overnight guard operator override file.',
            );
          }
          return json({
            ok: true,
            embedding_priority: on,
            override_path: overridePath,
            // The guard's timer is OnUnitInactiveSec=1min on a oneshot unit, so
            // the change lands on its next tick rather than immediately.
            takes_effect: 'within_one_guard_tick',
            policy: {
              raw_runtime_secrets_exposed: false,
              source_text_returned: false,
            },
          });
        }

        if (
          request.method === 'POST'
          && url.pathname === `${basePath}/source/index/x-bookmarks/content/recover`
        ) {
          if (!xBookmarksContentRecovery) {
            throw new EmailSourceWorkerError(
              501,
              'x_bookmarks_content_recovery_not_supported',
              'Private source worker does not support X bookmark content recovery.',
            );
          }
          const record = await parseObjectBody(request);
          const execute = asOptionalBoolean(record.execute);
          const limit = asOptionalNumber(record.limit);
          const result = await xBookmarksContentRecovery.recover({
            ...(execute !== undefined ? { execute } : {}),
            ...(limit !== undefined ? { limit } : {}),
          });
          assertNoRawEmailFields(result);
          return json(result);
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/index/sync`) {
          const record = await parseObjectBody(request);
          const corpusId = canonicalRequestCorpusId(record);
          if (!corpusId) {
            throw new EmailSourceWorkerError(400, 'invalid_request', 'corpus_id is required for source sync.');
          }
          const schedulerSourceId = sourceSchedulerSourceIdForCorpus(corpusId);
          const schedulerHasSource = schedulerSourceId !== undefined
            && sourceScheduler?.status().sources.some((source) => source.source_id === schedulerSourceId) === true;
          if (schedulerSourceId && schedulerHasSource && corpusId !== X_BOOKMARKS_CORPUS_ID) {
            const result = await sourceScheduler!.runSource(schedulerSourceId, undefined, 'operator');
            assertNoRawEmailFields(result);
            return json(result);
          }
          if (corpusId === READWISE_LIBRARY_CORPUS_ID) {
            const mode = asOptionalString(record.mode);
            if (mode !== undefined && mode !== 'connector_store') {
              throw new EmailSourceWorkerError(400, 'invalid_request', 'mode must be connector_store for Readwise sync.');
            }
            if (!readwiseConnectorStoreSync) {
              throw new EmailSourceWorkerError(501, 'source_index_sync_not_supported', 'Readwise connector-store sync is not configured.');
            }
            const result = await readwiseConnectorStoreSync.sync();
            assertNoRawEmailFields(result);
            return json(result);
          }
          if (corpusId === X_BOOKMARKS_CORPUS_ID) {
            const mode = asOptionalString(record.mode) ?? 'reconcile';
            if (mode !== 'head' && mode !== 'reconcile' && mode !== 'window_diagnostic') {
              throw new EmailSourceWorkerError(
                400,
                'invalid_request',
                'mode must be head, reconcile, or window_diagnostic for X bookmarks sync.',
              );
            }
            if (!xBookmarksConnectorStoreSync) {
              throw new EmailSourceWorkerError(501, 'source_index_sync_not_supported', 'X bookmarks connector-store sync is not configured.');
            }
            if (mode === 'window_diagnostic' && !xBookmarksConnectorStoreSync.diagnoseWindow) {
              throw new EmailSourceWorkerError(501, 'source_index_sync_not_supported', 'X bookmarks window diagnostics are not configured.');
            }
            try {
              const result = mode === 'head'
                ? await xBookmarksConnectorStoreSync.syncHead({ provenance: 'operator' })
                : mode === 'reconcile'
                  ? await xBookmarksConnectorStoreSync.reconcile({ provenance: 'operator' })
                  : await xBookmarksConnectorStoreSync.diagnoseWindow!({ provenance: 'operator' });
              const safeResult = xBookmarksLiveAdminResult(mode, result);
              assertNoRawEmailFields(safeResult);
              return json(safeResult);
            } catch (error) {
              if (!(error instanceof XBookmarksLiveSyncError)) throw error;
              const safeError = xBookmarksLiveAdminResult(mode, {
                status: 'idle',
                counts: error.counts ?? {},
                ...(error.warnings.length > 0 ? { warnings: error.warnings } : {}),
                ...(error.retryAt && error.degradedReason
                  ? {
                      retry_at: {
                        at: error.retryAt,
                        effective_interval_ms: defaultXBookmarksLiveSyncConfig().degradedIntervalMs,
                        degraded_reason: error.degradedReason,
                      },
                    }
                  : {}),
                api_usage: xBookmarksConnectorStoreSync.apiUsageStatus(),
              });
              assertNoRawEmailFields(safeError);
              return json({ ...safeError, status: 'degraded', error_kind: error.errorKind }, 503);
            }
          }
          throw new EmailSourceWorkerError(
            501,
            'source_index_sync_not_supported',
            `The canonical scheduler lane for ${corpusId} is not configured.`,
          );
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/index/files/extract`) {
          const runner = requireFileExtractionRunner(fileExtraction);
          const record = await parseObjectBody(request);
          const lane = parseFileExtractionLaneRecord(record, filesAliasLane, runner);
          const result = await runner.run({
            ...lane,
            ...optionalNumberField(record.limit, 'limit', 'limit'),
            ...optionalNumberField(record.lease_seconds, 'lease_seconds', 'leaseSeconds'),
            ...optionalStringField(record.extractor_kind, 'extractorKind'),
            ...optionalStringField(record.extractor_version, 'extractorVersion'),
            ...(asOptionalStringArray(record.provider_item_ids, 'provider_item_ids') !== undefined
              ? { providerItemIds: asOptionalStringArray(record.provider_item_ids, 'provider_item_ids')! }
              : {}),
            ...(record.reclassify === false ? { reclassify: false } : {}),
          });
          const body = fileExtractionRunBody(result);
          assertNoRawEmailFields(body);
          return json(body);
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/index/files/plan`) {
          const runner = requireFileExtractionRunner(fileExtraction);
          const record = await parseObjectBody(request);
          const lane = parseFileExtractionLaneRecord(record, filesAliasLane, runner);
          const result = await runner.plan({
            ...lane,
            limit: asOptionalNumber(record.limit, 'limit') ?? DEFAULT_FILE_EXTRACTION_PLAN_LIMIT,
            ...optionalStringField(record.cursor, 'cursor'),
            ...optionalStringField(record.extractor_kind, 'extractorKind'),
            ...(asOptionalStringArray(record.mime_types, 'mime_types') !== undefined
              ? { mimeTypes: asOptionalStringArray(record.mime_types, 'mime_types')! }
              : {}),
            ...optionalNumberField(record.priority, 'priority', 'priority'),
            ...optionalNumberField(record.max_bytes_per_file, 'max_bytes_per_file', 'maxBytesPerFile'),
            ...(record.policy_decision !== undefined
              ? { policyDecision: parseExtractionPolicyDecision(record.policy_decision) }
              : {}),
            ...(record.force === true ? { force: true } : {}),
          });
          const body = fileExtractionPlanBody(result);
          assertNoRawEmailFields(body);
          return json(body);
        }

        // The transcription lane is the generic plan pass with one extractor
        // kind pinned. It is a route of its own only because the fleet already
        // has a unit pointing at that path.
        if (request.method === 'POST' && url.pathname === `${basePath}/source/index/files/transcribe`) {
          const runner = requireFileExtractionRunner(fileExtraction);
          const record = await parseObjectBody(request);
          const lane = parseFileExtractionLaneRecord(record, filesAliasLane, runner);
          const result = await runner.plan({
            ...lane,
            limit: asOptionalNumber(record.limit, 'limit') ?? DEFAULT_FILE_EXTRACTION_PLAN_LIMIT,
            extractorKind: asOptionalString(record.extractor_kind) ?? TRANSCRIPTION_EXTRACTOR_KIND,
            ...optionalStringField(record.cursor, 'cursor'),
            ...optionalNumberField(record.max_bytes_per_file, 'max_bytes_per_file', 'maxBytesPerFile'),
          });
          const body = fileExtractionPlanBody(result);
          assertNoRawEmailFields(body);
          return json(body);
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/index/files/recycle-leases`) {
          const runner = requireFileExtractionRunner(fileExtraction);
          const record = await parseObjectBody(request);
          const lane = parseFileExtractionLaneRecord(record, filesAliasLane, runner);
          const extractorKindPrefix = asOptionalString(record.extractor_kind_prefix);
          if (!extractorKindPrefix) {
            throw new EmailSourceWorkerError(
              400,
              'invalid_request',
              'extractor_kind_prefix is required for a lease recycle.',
            );
          }
          const result = runner.recycleLeases({
            ...lane,
            extractorKindPrefix,
            ...optionalNumberField(record.limit, 'limit', 'limit'),
            ...(record.stale_only === true ? { staleOnly: true } : {}),
            ...(record.dry_run === true ? { dryRun: true } : {}),
          });
          assertNoRawEmailFields(result);
          return json({
            kind: 'file_extraction_lease_recycle',
            corpus_id: lane.corpusId,
            extractor_kind_prefix: result.extractorKindPrefix,
            matched_jobs: result.matchedJobs,
            jobs_requeued: result.jobsRequeued,
            stale_only: result.staleOnly,
            dry_run: result.dryRun,
          });
        }

        // Two shapes behind one path, exactly as the family-scoped route this
        // aliases: an ordinary janitor pass, and the reopening pass that moves
        // a job to a DIFFERENT extractor. With no explicit mode the configured
        // reopening rules run, which is the shape a timer wants.
        if (request.method === 'POST' && url.pathname === `${basePath}/source/index/files/janitor-requeue`) {
          const runner = requireFileExtractionRunner(fileExtraction);
          const record = await parseObjectBody(request);
          const lane = parseFileExtractionLaneRecord(record, filesAliasLane, runner);
          const mode = asOptionalString(record.mode) ?? 'terminal_reclassification';
          if (mode === 'terminal_reclassification' && record.last_error_kind === undefined) {
            const result = runner.reclassifyTerminal({
              ...lane,
              ...optionalNumberField(record.limit, 'limit', 'limit'),
              ...(record.dry_run === true ? { dryRun: true } : {}),
            });
            const body = fileExtractionReclassificationBody(result);
            assertNoRawEmailFields(body);
            return json(body);
          }
          if (mode !== 'expired_retryable' && mode !== 'terminal_reclassification') {
            throw new EmailSourceWorkerError(
              400,
              'invalid_request',
              'mode must be expired_retryable or terminal_reclassification when provided.',
            );
          }
          const reason = asOptionalString(record.reason);
          if (!reason) {
            throw new EmailSourceWorkerError(400, 'invalid_request', 'reason is required for a janitor requeue.');
          }
          const result = runner.janitorRequeue({
            ...lane,
            mode,
            reason,
            ...optionalStringField(record.extractor_kind, 'extractorKind'),
            ...optionalStringField(record.extractor_kind_prefix, 'extractorKindPrefix'),
            ...optionalStringField(record.last_error_kind, 'lastErrorKind'),
            ...optionalStringField(record.target_extractor_kind, 'targetExtractorKind'),
            ...optionalStringField(record.target_extractor_version, 'targetExtractorVersion'),
            ...optionalNumberField(record.escalation_budget, 'escalation_budget', 'escalationBudget'),
            ...optionalNumberField(record.limit, 'limit', 'limit'),
            ...(record.dry_run === true ? { dryRun: true } : {}),
            ...(record.allow_network_terminal_requeue_after_prior_janitor === true
              ? { allowNetworkTerminalRequeueAfterPriorJanitor: true }
              : {}),
          });
          assertNoRawEmailFields(result);
          return json({
            kind: 'file_extraction_janitor_requeue',
            corpus_id: lane.corpusId,
            mode: result.mode,
            matched_jobs: result.matchedJobs,
            jobs_requeued: result.jobsRequeued,
            jobs_escalated: result.jobsEscalated,
            skipped_attempt_budget: result.skippedAttemptBudget,
            skipped_already_janitor_requeued: result.skippedAlreadyJanitorRequeued,
            skipped_policy_excluded: result.skippedPolicyExcluded,
            skipped_escalation_budget: result.skippedEscalationBudget,
            skipped_target_exists: result.skippedTargetExists,
            network_guard_override_used: result.networkGuardOverrideUsed,
            dry_run: result.dryRun,
            reason: result.reason,
          });
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/index/files/status`) {
          const runner = requireFileExtractionRunner(fileExtraction);
          const record = await parseObjectBody(request);
          const lane = parseFileExtractionLaneRecord(record, filesAliasLane, runner);
          const counts = runner.counts(lane);
          const body = {
            kind: 'file_extraction_status',
            corpus_id: lane.corpusId,
            provider: lane.provider,
            counts: counts.map((count) => ({
              status: count.status,
              extractor_kind: count.extractorKind,
              jobs: count.jobs,
            })),
            policy: { worker_private_surface: true, source_text_returned: false },
          };
          assertNoRawEmailFields(body);
          return json(body);
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/index/dropbox/content/export-eval-shard`) {
          if (!dropboxEvalShardExport) {
            throw new EmailSourceWorkerError(
              501,
              'dropbox_eval_shard_export_not_supported',
              'Private source worker does not support Dropbox eval shard export.',
            );
          }
          const exportRequest = await parseDropboxEvalShardExportRequest(request);
          const result: DropboxEvalShardManifest = await dropboxEvalShardExport.export(exportRequest);
          assertNoRawEmailFields(result);
          return json(result);
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/index/search`) {
          const record = await parseObjectBody(request);
          assertSourceIndexSearchQuery(record.query);
          const corpusId = canonicalRequestCorpusId(record);
          const connectorStore = corpusId ? connectorStoresByCorpusId.get(corpusId) : undefined;
          if (connectorStore) {
            const searchRequest = parseConnectorStoreIndexSearchRequestRecord(
              record,
              connectorStore,
              connectorStoreAccountScopes.get(connectorStore.corpusId),
              connectorStore.family === 'chat'
                ? connectorStorePrincipals.get(connectorStore.corpusId)
                : undefined,
              connectorStorePrincipals.get(connectorStore.corpusId),
              connectorStoreFilterCapabilities,
            );
            const connectorStoreEmbeddingProvider = connectorStoreEmbeddingProviders.get(connectorStore.corpusId)
              ?? sourceIndexEmbeddingProvider;
            const adapter = createConnectorStoreCorpusAdapter({
              store: connectorStore,
              retrievalMode: searchRequest.retrievalMode,
              ...(searchRequest.accountScope ? { accountScope: searchRequest.accountScope } : {}),
              ...(searchRequest.filters ? { filters: searchRequest.filters } : {}),
              ...(searchRequest.resultProjector ? { resultProjector: searchRequest.resultProjector } : {}),
              ...(connectorStoreEmbeddingProvider
                && (connectorStore.trustDomain !== 'secure_local' || connectorStoreEmbeddingProvider.backend === 'local')
                ? { embeddingProvider: connectorStoreEmbeddingProvider }
                : {}),
            });
            const result = await retrySqliteBusy(() => adapter({
              query: searchRequest.query,
              maxResults: searchRequest.maxResults,
              corpus: defineConnectorCorpus({
                corpusId: connectorStore.corpusId,
                family: connectorStore.family,
                trustDomain: connectorStore.trustDomain,
              }),
              context: {
                allowedTrustDomains: [connectorStore.trustDomain],
                allowedCorpusIds: [connectorStore.corpusId],
              },
            }));
            const locatorsExposed = result.hits.some((hit) => (
              Object.prototype.hasOwnProperty.call(hit, 'locator')
            ));
            const safeResult = {
              kind: 'source_index_search',
              corpus_id: connectorStore.corpusId,
              retrieval_source: 'local_index',
              hits: result.hits.map((hit) => addSelectedItemToSearchHit(connectorStore.corpusId, hit)),
              audit: {
                request_id: `${connectorStore.corpusId}:connector-store-search`,
                retrieval_source: 'local_index',
                queries_attempted: 1,
                metadata_hits: result.hits.length,
                items_returned: result.hits.length,
                latency_ms: result.latencyMs,
                ...(searchRequest.explicitEmptyChatScope
                  ? {}
                  : { lane_audits: result.laneAudits ?? [] }),
                raw_source_exposed: false,
                source_text_returned: false,
                ...(searchRequest.locatorsRequested ? { locators_requested: true } : {}),
              },
              policy: {
                raw_source_exposed: false,
                source_text_returned: false,
                source_packets_exposed: false,
                local_only: searchRequest.explicitEmptyChatScope
                  || connectorStore.trustDomain === 'secure_local',
                trust_domain: connectorStore.trustDomain,
                ...(locatorsExposed
                  ? { locators_exposed: true, locator_release: 'explicit_request' as const }
                  : {}),
              },
            };
            assertNoRawEmailFields(safeResult);
            return json(safeResult);
          }
          if (!corpusId) {
            throw new EmailSourceWorkerError(
              400,
              'invalid_request',
              `corpus_id must be one of: ${sourceIndexSearchCorpusIds(connectorStores).join(', ')}.`,
            );
          }
          throw new EmailSourceWorkerError(
            501,
            'source_index_search_not_supported',
            `The connector store for ${corpusId} is not mounted.`,
          );
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/index/embed`) {
          const record = await parseObjectBody(request);
          const corpusId = canonicalRequestCorpusId(record);
          if (!corpusId) {
            throw new EmailSourceWorkerError(
              400,
              'invalid_request',
              'corpus_id must name a configured connector-store corpus.',
            );
          }
          const connectorStore = connectorStoresByCorpusId.get(corpusId);
          if (connectorStore) {
            const embeddingProvider = connectorStoreEmbeddingProviders.get(connectorStore.corpusId)
              ?? sourceIndexEmbeddingProvider;
            if (!embeddingProvider) {
              throw new EmailSourceWorkerError(
                501,
                'source_index_embedding_not_configured',
                `Private source worker does not have an embedding provider configured for ${connectorStore.corpusId}.`,
              );
            }
            const modelId = asOptionalString(record.model_id);
            const maxPendingChunks = asOptionalNumber(record.max_pending_chunks);
            const result = await connectorStore.embedChunks({
              provider: embeddingProvider,
              ...(modelId ? { modelId } : {}),
              ...(maxPendingChunks !== undefined ? { limit: maxPendingChunks } : {}),
            });
            assertNoRawEmailFields(result);
            return json(result);
          }
          throw new EmailSourceWorkerError(
            501,
            'source_index_embedding_not_supported',
            `The connector store for ${corpusId} is not mounted.`,
          );
        }
        return json(
          {
            error: {
              code: 'not_found',
              message: 'Email source worker route not found.',
            },
            policy: { raw_email_exposed: false },
          },
          404,
        );
      } catch (error) {
        if (error instanceof EmailSourceWorkerError) {
          return json(
            {
              error: {
                code: error.code,
                message: error.message,
                ...(error.suggestion ? { suggestion: error.suggestion } : {}),
              },
              policy: { raw_email_exposed: false },
            },
            error.status,
          );
        }
        if (error instanceof ConnectedHandleGrantMutationError) {
          return json(
            {
              error: {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
              },
              policy: { raw_email_exposed: false },
            },
            503,
          );
        }
        if (isCredentialRefreshBusyError(error)) {
          const retryAfterMs = error.retryAfterMs ?? CREDENTIAL_REFRESH_BUSY_RETRY_MS;
          return json(
            {
              error: {
                code: 'credential_refresh_busy',
                message: 'The credential is being refreshed by another process; retry shortly.',
                retryable: true,
                retry_at: new Date(Date.now() + retryAfterMs).toISOString(),
              },
              policy: { raw_email_exposed: false },
            },
            503,
          );
        }
        if (error instanceof OperationError) {
          logSourceWorkerInternalError(request, error);
          return json(
            {
              error: {
                code: error.code,
                message: error.message,
                ...(error.suggestion ? { suggestion: error.suggestion } : {}),
              },
              policy: { raw_email_exposed: false },
            },
            error.code === 'source_index_policy_violation'
              ? 403
              : error.code === 'invalid_params'
                ? 400
                : 500,
          );
        }
        logSourceWorkerInternalError(request, error);
        return json(
          {
            error: {
              code: 'source_worker_error',
              message: 'Private source worker request failed before producing a safe result.',
            },
            policy: { raw_email_exposed: false },
          },
          500,
        );
      }
    },
  };

  async function withDashboardGrantMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = dashboardGrantMutationTail;
    let release!: () => void;
    dashboardGrantMutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await mutation();
    } finally {
      release();
    }
  }

  async function runDashboardSourceSync(request: DashboardSourceSyncRequest): Promise<unknown> {
    await refreshDashboardSchedulerSources();
    const schedulerSourceId = dashboardSchedulerSourceId(request.source);
    if (schedulerSourceId) {
      const schedulerStatus = sourceScheduler?.status();
      const hasSchedulerSource = schedulerStatus?.sources.some((source) =>
        source.source_id === schedulerSourceId || source.corpus_id === schedulerSourceId
      ) === true;
      // Only an explicit Sync now press is operator work. The post-connect
      // first sync is dispatched from the OAuth callback, which is bearer-
      // exempt by design — a provider-controlled request must never start a
      // budget-exempt run (R62 finding 1), so it stays scheduled.
      if (hasSchedulerSource) {
        return request.reason === 'manual'
          ? sourceScheduler!.runSource(schedulerSourceId, undefined, 'operator')
          : sourceScheduler!.runSource(schedulerSourceId);
      }
    }

    // A connector-store sync wired into THIS worker outranks the host's
    // dashboard hook. The hook is a single callback shared by every source, so
    // a host that wires it for one source (the product server wires Dropbox)
    // would otherwise starve every fallback sitting behind it. This order is
    // the one `dashboardSourceSyncAvailable` already reports: a source is
    // syncable when either path exists, so neither may preempt the other.
    if (request.source === 'readwise' && readwiseConnectorStoreSync) {
      return readwiseConnectorStoreSync.sync();
    }

    if (request.source === 'x' && xBookmarksConnectorStoreSync) {
      return xBookmarksLiveAdminResult(
        'reconcile',
        await xBookmarksConnectorStoreSync.reconcile(
          request.reason === 'manual' ? { provenance: 'operator' } : {},
        ),
      );
    }

    if (sourceDashboard?.triggerSourceSync) {
      return sourceDashboard.triggerSourceSync(request);
    }

    throw dashboardSourceSyncNotSupportedError(request.source);
  }

  async function refreshDashboardSchedulerSources(): Promise<void> {
    if (!sourceScheduler || !sourceDashboard?.refreshSchedulerSources) return;
    sourceScheduler.updateSources(await sourceDashboard.refreshSchedulerSources());
  }

  /**
   * Re-adopt the scheduler's sources when the handle registry has changed under
   * this worker.
   *
   * Unpair parks the source's lane by rebuilding the scheduler without its
   * handle. Re-pairing happens in ANOTHER process — `olympus connect telegram`
   * — which has no channel into this one, and neither chat source is a
   * dashboard sync source, so nothing else here would ever look again: the lane
   * stayed parked until the worker was restarted, which contradicts Unpair's
   * own `restart_required: false`.
   *
   * Three things make this safe rather than merely eventual:
   *
   * - It runs on a background tick, not only when somebody opens the dashboard.
   *   Bound to a render, a re-pair performed with the page closed stayed parked
   *   indefinitely.
   * - It holds the SAME grant-custody lease Unpair holds. Unleased, this read
   *   the pre-Unpair handles, awaited a rebuild, and then reinstated the lane
   *   that a leased Unpair had parked in between — resurrecting a source the
   *   owner had just torn down.
   * - The stamp is committed only after a rebuild that succeeded AND was still
   *   current when it landed. Advancing it first meant one transient failure
   *   parked the lane until the next unrelated registry write.
   */
  async function refreshDashboardSchedulerOnRegistryChange(): Promise<void> {
    const scheduler = sourceScheduler;
    const refresh = sourceDashboard?.refreshSchedulerSources;
    if (!scheduler || !refresh || !sourceDashboard || dashboardWorkerClosed) return;
    const registryPath = sourceDashboard.registryPath ?? defaultHandleRegistryPath();
    if (dashboardRegistryStamp(registryPath) === dashboardSchedulerRegistryStamp) return;
    try {
      await withConnectedHandleGrantCustody(registryPath, {}, async () => {
        // Re-read INSIDE the lease: whatever this saw a moment ago may already
        // have been superseded by an Unpair that was holding it.
        if (dashboardWorkerClosed) return;
        const observed = dashboardRegistryStamp(registryPath);
        if (observed === dashboardSchedulerRegistryStamp) return;
        // The same consult boot makes, through the same helper: a handle an
        // Unpair could not remove is still in this registry, and rebuilding its
        // lane on the next unrelated registry change would quietly undo the
        // teardown that boot had correctly honoured.
        const handles = withoutUnpairedLaneHandles(readDashboardRegistry(registryPath).handles, registryPath);
        const next = await refresh(handles);
        if (dashboardWorkerClosed) return;
        // The lease makes this belt-and-braces, but the rebuild may await work
        // of its own, and applying a source set built from a registry that has
        // since moved is exactly the resurrection this guards against.
        if (dashboardRegistryStamp(registryPath) !== observed) return;
        scheduler.updateSources(next);
        dashboardSchedulerRegistryStamp = observed;
      });
    } catch (error) {
      // The stamp is deliberately NOT advanced, so the next tick retries. A
      // page render must not die because the scheduler could not be rebuilt,
      // and a busy lease is the ordinary case, not an incident.
      //
      // A worker closed while this was in flight says nothing: it was shut
      // down, and the registry it was reaching for may have gone with it.
      // Reporting that as a failure is noise about work nobody wanted done.
      if (dashboardWorkerClosed) return;
      console.warn(`Olympus scheduler refresh after a registry change failed: ${scrubSourceWorkerLogMessage(error instanceof Error ? error.message : error)}`);
    }
  }

  async function triggerDashboardPostConnectSync(request: DashboardSourceSyncRequest): Promise<void> {
    if (!isDashboardSyncSource(request.source)) return;
    if (!dashboardSourceSyncAvailable(request.source)) return;
    try {
      await runDashboardSourceSync(request);
    } catch (error) {
      console.warn(`Olympus post-connect first sync did not start for ${request.source}: ${scrubSourceWorkerLogMessage(error instanceof Error ? error.message : error)}`);
    }
  }

  function dashboardSourceSyncAvailable(source: DashboardConnectSource): boolean {
    if (source === 'gmail') {
      const schedulerStatus = sourceScheduler?.status();
      return schedulerStatus?.sources.some((candidate) => candidate.source_id === 'gmail.email' || candidate.corpus_id === INTERNAL_EMAIL_CORPUS_ID) === true
        || sourceDashboard?.triggerSourceSync !== undefined;
    }
    if (source === 'google-drive') {
      const schedulerStatus = sourceScheduler?.status();
      return schedulerStatus?.sources.some((candidate) => candidate.source_id === 'google_drive.docs' || candidate.corpus_id === GOOGLE_DRIVE_DOCS_CORPUS_ID) === true
        || sourceDashboard?.triggerSourceSync !== undefined;
    }
    if (source === 'readwise') return readwiseConnectorStoreSync !== undefined || sourceDashboard?.triggerSourceSync !== undefined;
    if (source === 'x') return xBookmarksConnectorStoreSync !== undefined || sourceDashboard?.triggerSourceSync !== undefined;
    if (source === 'dropbox') {
      const schedulerStatus = sourceScheduler?.status();
      return schedulerStatus?.sources.some((candidate) => candidate.source_id === 'dropbox.files' || candidate.corpus_id === DROPBOX_FILES_CORPUS_ID) === true
        || sourceDashboard?.triggerSourceSync !== undefined;
    }
    return false;
  }
}

function scrubSourceWorkerLogMessage(message: unknown): string {
  return String(message).slice(0, 200).replace(/[A-Za-z0-9._~+/=-]{24,}/g, '<redacted>');
}

function logSourceWorkerInternalError(request: Request, error: unknown): void {
  const cause = error as { constructor?: { name?: string }; code?: unknown; message?: unknown } | null | undefined;
  const route = new URL(request.url).pathname;
  if (route.endsWith('/source/answer')) {
    console.error('[source-worker-error] ' + JSON.stringify({
      route,
      method: request.method,
      errorClass: sourceAnswerTraceErrorClass(error),
      code: cause?.code,
    }));
    return;
  }
  console.error('[source-worker-error] ' + JSON.stringify({
    route,
    method: request.method,
    errorClass: cause?.constructor?.name,
    code: cause?.code,
    message: scrubSourceWorkerLogMessage(cause?.message ?? error),
  }));
}

async function emitSourceAnswerLatencyRecords(input: {
  log: SourceAnswerLatencyLog | undefined;
  trace: ReturnType<typeof createSourceAnswerTrace>;
  outcome: SourceAnswerTraceOutcome;
  result?: Awaited<ReturnType<SourceIndexAnswerHandler['answer']>>;
  error?: unknown;
}): Promise<void> {
  if (!input.log) return;

  let compatV1LoggedAt: string | undefined;
  if (input.result) {
    const buildStartedAt = Date.now();
    try {
      const v1 = buildSourceAnswerLatencyRecord(input.result);
      compatV1LoggedAt = v1.logged_at;
      recordSourceAnswerLedgerBuild(Date.now() - buildStartedAt);
      const appendStartedAt = Date.now();
      await recordSourceAnswerLatencyBestEffort(input.log, v1);
      recordSourceAnswerLedgerAppend(Date.now() - appendStartedAt);
    } catch (error) {
      recordSourceAnswerLedgerBuild(Date.now() - buildStartedAt);
      recordSourceAnswerLatencyFailure(input.log, error);
    }
  }

  try {
    const v2 = buildSourceAnswerLatencyTraceRecord({
      trace: snapshotSourceAnswerTrace(input.trace),
      outcome: input.outcome,
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(compatV1LoggedAt ? { compatV1LoggedAt } : {}),
    });
    await recordSourceAnswerLatencyBestEffort(input.log, v2);
  } catch (error) {
    recordSourceAnswerLatencyFailure(input.log, error);
  }
}

async function recordSourceAnswerLatencyBestEffort(
  log: SourceAnswerLatencyLog,
  record: Parameters<SourceAnswerLatencyLog['record']>[0],
): Promise<void> {
  try {
    await log.record(record);
  } catch (error) {
    recordSourceAnswerLatencyFailure(log, error);
  }
}

function recordSourceAnswerLatencyFailure(
  log: SourceAnswerLatencyLog,
  error: unknown,
): void {
  try {
    if (log.recordFailure) {
      log.recordFailure(error);
      return;
    }
  } catch {
    // The health hook is observability-only and may never affect the answer.
  }
  console.error(
    `[source-answer-latency] record failed error_class=${sourceAnswerTraceErrorClass(error)}`,
  );
}

function classifySourceAnswerTraceOutcome(
  error: unknown,
  requestParsed: boolean,
  requestAborted: boolean,
): SourceAnswerTraceOutcome {
  if (!requestParsed) return 'parse_error';
  const errorClass = sourceAnswerTraceErrorClass(error);
  if (requestAborted || errorClass === 'AbortError') return 'cancelled';
  const candidate = error as { code?: unknown; message?: unknown } | null | undefined;
  if (
    errorClass === 'TrustedAnalystTimeoutError'
    || errorClass === 'TimeoutError'
    || candidate?.code === 'ETIMEDOUT'
  ) {
    return 'timeout';
  }
  if (/sovereignty analyst fallback chain exhausted/i.test(String(candidate?.message ?? ''))) {
    return 'route_exhausted';
  }
  return 'error';
}

const DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000, 8_000] as const;
const DEFAULT_DROPBOX_CONTENT_EXTRACTION_LEASE_LIMIT = 10;
const MAX_DROPBOX_CONTENT_EXTRACTION_LEASE_LIMIT = 500;
const MAX_DROPBOX_CONTENT_EXTRACTION_LEASE_SECONDS = 3_600;
const MAX_DROPBOX_SYNC_JOB_MAX_ENTRIES_PER_PASS = 25_000;
const MAX_DROPBOX_SYNC_JOB_MAX_PAGES_PER_PASS = 1_000;
const MAX_DROPBOX_SYNC_JOB_LEASE_SECONDS = 3_600;

async function retrySqliteBusy<T>(operation: () => T | Promise<T>): Promise<T> {
  let lastError: unknown;
  const retryDelays = sqliteBusyRetryDelays();
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error)) {
        throw error;
      }
      if (attempt === retryDelays.length) {
        throw new EmailSourceWorkerError(
          503,
          'source_index_busy',
          'The source index is busy; retry the source request shortly.',
        );
      }
      recordSourceAnswerSqliteRetry(retryDelays[attempt]!);
      await sleep(retryDelays[attempt]!);
    }
  }
  throw lastError;
}

function sqliteBusyRetryDelays(): readonly number[] {
  const configured = process.env.OLYMPUS_SQLITE_BUSY_RETRY_DELAYS_MS;
  if (!configured) return DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS;
  const parsed: number[] = [];
  for (const rawItem of configured.split(',')) {
    const item = rawItem.trim();
    const delay = Number(item);
    if (item === '' || !Number.isFinite(delay) || delay < 0) {
      console.warn(
        'Ignoring malformed OLYMPUS_SQLITE_BUSY_RETRY_DELAYS_MS; using default SQLite busy retry delays.',
      );
      return DEFAULT_SQLITE_BUSY_RETRY_DELAYS_MS;
    }
    parsed.push(delay);
  }
  return parsed;
}

function isSqliteBusyError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown } | null | undefined;
  return candidate?.code === 'SQLITE_BUSY'
    || String(candidate?.message ?? '').toLowerCase().includes('database is locked');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseSourceIndexAnswerRequest(request: Request): Promise<SourceIndexAnswerRequest> {
  const record = await parseObjectBody(request);
  if (typeof record.question !== 'string' || record.question.trim().length === 0) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'question must be a non-empty string.');
  }
  const query = asOptionalString(record.query);
  const account = asOptionalString(record.account);
  const corpusId = asOptionalString(record.corpus_id);
  const corpusIds = asOptionalStringArray(record.corpus_ids, 'corpus_ids');
  // Corpora are dynamic (connector-store corpora are declared via env), so the
  // parser only checks the id shape; the router fails closed on unknown ids
  // (not_requested / no_adapter skips), which is the real gate.
  if (corpusId !== undefined && !/^[a-z0-9_]+(\.[a-z0-9_-]+)+$/i.test(corpusId)) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'corpus_id must be a dotted corpus identifier when provided.');
  }
  if (corpusIds !== undefined) {
    for (const [index, id] of corpusIds.entries()) {
      if (!/^[a-z0-9_]+(\.[a-z0-9_-]+)+$/i.test(id)) {
        throw new EmailSourceWorkerError(400, 'invalid_request', `corpus_ids.${index} must be a dotted corpus identifier.`);
      }
    }
  }
  const approvedScopeKey = asOptionalString(record.approved_scope_key);
  const chatScope = asOptionalString(record.chat_scope)
    ?? asOptionalString(record.chat_title)
    ?? asOptionalString(record.chat_title_hint);
  const conversationId = asOptionalString(record.conversation_id);
  const senderId = asOptionalString(record.sender_id);
  const senderLabel = asOptionalString(record.sender_label);
  const authoredAfter = asOptionalString(record.authored_after);
  const authoredBefore = asOptionalString(record.authored_before);
  try {
    normalizeConnectorStoreSearchFilters({
      ...(conversationId ? { conversationId } : {}),
      ...(senderId ? { senderId } : {}),
      ...(senderLabel ? { senderLabel } : {}),
      ...(authoredAfter ? { authoredAfter } : {}),
      ...(authoredBefore ? { authoredBefore } : {}),
    });
  } catch (error) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      error instanceof Error ? error.message : 'Connector-store metadata filters are invalid.',
    );
  }
  const selectedItems = asOptionalSourceAnswerSelectedItems(record.selected_items);
  const retrievalMode = asOptionalRetrievalMode(record.retrieval_mode);
  const analystProvider = asOptionalSourceAnswerAnalystProvider(record.analyst_provider);
  const analystModel = asOptionalAnalystModel(record.analyst_model, analystProvider);
  const maxResults = asOptionalNumber(record.max_results);
  const includeSecureLocal = asOptionalBoolean(record.include_secure_local);
  const includeSecureLocalContent = asOptionalBoolean(record.include_secure_local_content);
  const includeInternal = asOptionalBoolean(record.include_internal);
  const includeInternalContent = asOptionalBoolean(record.include_internal_content);
  const internalContentMaxBytes = asOptionalNumber(record.internal_content_max_bytes);
  const timeoutMs = asOptionalNumber(record.timeout_ms ?? record.timeoutMs);
  if (timeoutMs !== undefined && timeoutMs <= 0) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'timeout_ms must be a positive number when provided.');
  }
  return {
    question: record.question,
    ...(query !== undefined ? { query } : {}),
    ...(account !== undefined ? { account } : {}),
    ...(corpusId !== undefined ? { corpus_id: corpusId } : {}),
    ...(corpusIds !== undefined ? { corpus_ids: corpusIds } : {}),
    ...(approvedScopeKey !== undefined ? { approved_scope_key: approvedScopeKey } : {}),
    ...(chatScope !== undefined ? { chat_scope: chatScope } : {}),
    ...(conversationId !== undefined ? { conversation_id: conversationId } : {}),
    ...(senderId !== undefined ? { sender_id: senderId } : {}),
    ...(senderLabel !== undefined ? { sender_label: senderLabel } : {}),
    ...(authoredAfter !== undefined ? { authored_after: authoredAfter } : {}),
    ...(authoredBefore !== undefined ? { authored_before: authoredBefore } : {}),
    ...(selectedItems !== undefined ? { selected_items: selectedItems } : {}),
    ...(retrievalMode !== undefined ? { retrieval_mode: retrievalMode } : {}),
    ...(analystProvider !== undefined ? { analyst_provider: analystProvider } : {}),
    ...(analystModel !== undefined ? { analyst_model: analystModel } : {}),
    ...(maxResults !== undefined ? { max_results: maxResults } : {}),
    ...(includeSecureLocal !== undefined ? { include_secure_local: includeSecureLocal } : {}),
    ...(includeSecureLocalContent !== undefined ? { include_secure_local_content: includeSecureLocalContent } : {}),
    ...(includeInternal !== undefined ? { include_internal: includeInternal } : {}),
    ...(includeInternalContent !== undefined ? { include_internal_content: includeInternalContent } : {}),
    ...(internalContentMaxBytes !== undefined ? { internal_content_max_bytes: internalContentMaxBytes } : {}),
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
  };
}

async function parseSourceIndexStatusRequest(
  request: Request,
  connectorStores: readonly LocalConnectorStore[] = [],
): Promise<SourceIndexStatusRequest> {
  const record = request.method === 'GET'
    ? recordFromSearchParams(new URL(request.url).searchParams)
    : await parseObjectBody(request);
  // Resolved before validation so a documented alias is measured against the
  // allow-list as its canonical id. GET and POST share this parser, so both
  // variants are covered. The layer below (source-index/status.ts) canonicalises
  // too; this is what lets a request reach it.
  const corpusId = canonicalRequestCorpusId(record);
  const allowedCorpusIds = sourceIndexStatusCorpusIds(connectorStores);
  if (corpusId !== undefined && !allowedCorpusIds.includes(corpusId)) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      `corpus_id must be one of: ${allowedCorpusIds.join(', ')} when provided (a documented input alias of one of those ids is also accepted).`,
    );
  }
  const account = asOptionalString(record.account);
  const approvedScopeKey = asOptionalString(record.approved_scope_key);
  const chatScope = asOptionalString(record.chat_scope)
    ?? asOptionalString(record.chat_title)
    ?? asOptionalString(record.chat_title_hint);
  const conversationId = asOptionalString(record.conversation_id);
  const includeSenderAggregation = asOptionalBoolean(record.include_sender_aggregation);
  const maxSenders = asOptionalNumber(record.max_senders);
  if (maxSenders !== undefined && (!Number.isInteger(maxSenders) || maxSenders < 1 || maxSenders > 100)) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'max_senders must be an integer from 1 to 100 when provided.',
    );
  }
  if (includeSenderAggregation === true && (!corpusId || !account || !conversationId)) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'include_sender_aggregation requires corpus_id, account, and conversation_id.',
    );
  }
  const includePrefixes = asOptionalStringArray(record.include_path_prefixes, 'include_path_prefixes');
  const excludePrefixes = asOptionalStringArray(record.exclude_path_prefixes, 'exclude_path_prefixes');
  const extractorKind = asOptionalString(record.extractor_kind);
  const extractorVersion = asOptionalString(record.extractor_version);
  const mimeTypes = asOptionalStringArray(record.mime_types, 'mime_types');
  const mimeTypePrefixes = asOptionalStringArray(record.mime_type_prefixes, 'mime_type_prefixes');
  const fileExtensions = asOptionalStringArray(record.file_extensions, 'file_extensions');
  const requiredArtifactKind = asOptionalString(record.required_artifact_kind);
  const requiredArtifactWarning = asOptionalString(record.required_artifact_warning);
  const qaVerdicts = asOptionalStringArray(record.qa_verdicts, 'qa_verdicts');
  const sourceExtractorKinds = asOptionalStringArray(record.source_extractor_kinds, 'source_extractor_kinds');
  const sourceJobStatuses = asOptionalStringArray(record.source_job_statuses, 'source_job_statuses');
  const includeReadinessLedger = asOptionalBoolean(record.include_readiness_ledger);
  const includeIngestionLedger = asOptionalBoolean(record.include_ingestion_ledger);
  const includeItems = asOptionalBoolean(record.include_items);
  const maxItems = asOptionalNumber(record.max_items);
  const query = asOptionalString(record.query);
  const result: SourceIndexStatusRequest = {};
  if (account !== undefined) result.account = account;
  if (approvedScopeKey !== undefined) result.approved_scope_key = approvedScopeKey;
  if (chatScope !== undefined) result.chat_scope = chatScope;
  if (conversationId !== undefined) result.conversation_id = conversationId;
  if (includeSenderAggregation !== undefined) result.include_sender_aggregation = includeSenderAggregation;
  if (maxSenders !== undefined) result.max_senders = maxSenders;
  if (includePrefixes !== undefined) result.include_path_prefixes = includePrefixes;
  if (excludePrefixes !== undefined) result.exclude_path_prefixes = excludePrefixes;
  if (extractorKind !== undefined) result.extractor_kind = extractorKind;
  if (extractorVersion !== undefined) result.extractor_version = extractorVersion;
  if (mimeTypes !== undefined) result.mime_types = mimeTypes;
  if (mimeTypePrefixes !== undefined) result.mime_type_prefixes = mimeTypePrefixes;
  if (fileExtensions !== undefined) result.file_extensions = fileExtensions;
  if (requiredArtifactKind !== undefined) result.required_artifact_kind = requiredArtifactKind;
  if (requiredArtifactWarning !== undefined) result.required_artifact_warning = requiredArtifactWarning;
  if (qaVerdicts !== undefined) result.qa_verdicts = qaVerdicts;
  if (sourceExtractorKinds !== undefined) result.source_extractor_kinds = sourceExtractorKinds;
  if (sourceJobStatuses !== undefined) result.source_job_statuses = sourceJobStatuses;
  if (corpusId !== undefined) result.corpus_id = corpusId;
  if (includeReadinessLedger !== undefined) result.include_readiness_ledger = includeReadinessLedger;
  if (includeIngestionLedger !== undefined) result.include_ingestion_ledger = includeIngestionLedger;
  if (includeItems !== undefined) result.include_items = includeItems;
  if (maxItems !== undefined) result.max_items = maxItems;
  if (query !== undefined) result.query = query;
  return result;
}

function recordFromSearchParams(params: URLSearchParams): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const [key, value] of params.entries()) {
    if (value === 'true') record[key] = true;
    else if (value === 'false') record[key] = false;
    else record[key] = value;
  }
  return record;
}






function xBookmarksLiveAdminResult(
  mode: 'head' | 'reconcile' | 'window_diagnostic',
  result: XBookmarksLiveSyncResult,
): Record<string, unknown> {
  const allowedCountKeys = new Set([
    'api_requests',
    'items_seen',
    'items_indexed',
    'items_tombstoned',
    'folders_seen',
    'folder_memberships_seen',
    'folder_posts_absent_from_global',
    'global_verification_matched',
    'folder_inventory_coverage_gaps',
    'folders_carried_forward',
    'folder_membership_coverage_gaps',
    'folder_provider_outage',
    'global_traversal_exhausted',
    'removal_authoritative',
    'folder_inventory_authoritative',
    'complete_reconciliation_authoritative',
    'global_current_authority',
    'folder_provenance_green',
    'staged_recovery_completed',
    'staged_failure_count',
    'staged_recovery_eligible',
    'staged_pages_cleared',
    'staged_posts_cleared',
    'staged_folders_cleared',
    'staged_memberships_cleared',
    'coverage_scope_recency_window',
    'window_boundary_verified',
    'traversal_cardinality',
    'verification_cardinality',
    'absence_items_tombstoned',
    'out_of_scope_removals',
    'window_removed_items',
    'window_removed_items_tombstoned',
    'window_removals_deferred',
    'window_removal_debt_carried',
    'window_removal_debt_spent',
    'window_removal_debt_standing',
    'window_removal_debt_oldest_age_ms',
    'deleted_event_items_tombstoned',
    'secrets_tier_items_tombstoned',
    'items_demoted',
    'diagnostic_probes',
    'diagnostic_requests',
    'diagnostic_successful_requests',
    'diagnostic_provider_errors',
    'diagnostic_guarded_requests',
    'chunks_indexed',
    'chunks_embedded',
    'head_pages_read',
    'head_truncation_deferrals',
    'reconcile_page_size_80_requests',
    'reconcile_page_size_50_requests',
    'reconcile_page_size_20_requests',
    'reconcile_page_size_other_requests',
    'reconcile_truncation_retries',
  ]);
  for (let index = 0; index < 8; index += 1) {
    allowedCountKeys.add(`traversal_digest_word_${index}`);
    allowedCountKeys.add(`verification_digest_word_${index}`);
  }
  // One key per head page actually read, so the ladder a run climbed is
  // legible from the receipt alone. The bound is the hard page cap both the
  // catch-up page limit and the ladder length validate against.
  for (let page = 1; page <= X_BOOKMARKS_HEAD_MAX_LADDER_PAGES; page += 1) {
    allowedCountKeys.add(`head_page_${page}_max_results`);
  }
  const numericCounts = Object.fromEntries(
    Object.entries(result.counts).filter((entry): entry is [string, number] => (
      allowedCountKeys.has(entry[0])
      && typeof entry[1] === 'number'
      && Number.isFinite(entry[1])
      && entry[1] >= 0
    )),
  );
  const usage = result.api_usage;
  const allowedWarnings = new Set([
    'x_head_catchup_bounded_daily_reconcile_required',
    'x_head_truncation_suspected_deferred_checkpoint_preserved',
    'x_reconcile_truncation_suspected_smaller_page_retry',
    'x_reconcile_truncation_suspected_no_authority',
    'x_reconcile_incomplete_no_removals_applied',
    'x_reconcile_coverage_window_partial_no_absence_removals',
    'x_reconcile_folder_post_absent_from_global_ignored',
    'x_reconcile_global_silent_window_removals_preserved',
    'x_reconcile_window_removal_newer_observation_preserved',
    'x_reconcile_window_removal_debt_standing_beyond_cadence',
    'x_reconcile_global_verification_mismatch_removals_preserved',
    'x_reconcile_folder_membership_coverage_partial_preserved',
    'x_reconcile_folder_inventory_coverage_partial_preserved',
    'x_reconcile_authoritative_freshness_not_advanced',
    'x_reconcile_completed_snapshot_reused_pending_application',
    'x_reconcile_folder_provenance_degraded_daily_cadence',
    'x_reconcile_folder_provider_outage_inventory_carried_forward',
    'x_reconcile_staged_failure_retry_bounded',
    'x_reconcile_staged_recovery_completed',
    'x_reconcile_explicit_staged_recovery_required',
    'x_reconcile_provider_window_boundary_verified',
    'x_reconcile_window_boundary_inconsistent_no_authority',
    'x_window_diagnostic_incomplete_review_report',
  ]);
  const safeWarnings = [...new Set((result.warnings ?? []).filter((warning) => allowedWarnings.has(warning)))];
  return {
    mode,
    status: result.status,
    counts: numericCounts,
    ...(result.authority
      ? {
          authority: {
            global_current_authority: result.authority.global_current_authority,
            folder_provenance: result.authority.folder_provenance,
            staged_recovery: result.authority.staged_recovery,
          },
        }
      : {}),
    ...(safeWarnings.length > 0 ? { warnings: safeWarnings } : {}),
    api_usage: {
      utc_day: usage.utc_day,
      api_requests: usage.api_requests,
      resource_reads: usage.resource_reads,
      estimated_billable_resources: usage.estimated_billable_resources,
      reserved_resource_reads: usage.reserved_resource_reads,
      estimated_spend_microusd: usage.estimated_spend_microusd,
      estimated_spend_usd: usage.estimated_spend_usd,
      estimated_unit_cost_usd: usage.estimated_unit_cost_usd,
      estimate: true,
      hard_budgets: {
        api_requests: usage.hard_budgets.api_requests,
        resource_reads: usage.hard_budgets.resource_reads,
        estimated_spend_microusd: usage.hard_budgets.estimated_spend_microusd,
      },
      ...(usage.rate_limit
        ? {
            rate_limit: {
              ...(usage.rate_limit.limit !== undefined ? { limit: usage.rate_limit.limit } : {}),
              ...(usage.rate_limit.remaining !== undefined ? { remaining: usage.rate_limit.remaining } : {}),
              ...(usage.rate_limit.reset_at !== undefined ? { reset_at: usage.rate_limit.reset_at } : {}),
            },
          }
        : {}),
      guard: {
        state: usage.guard.state,
        ...(usage.guard.degraded_reason ? { degraded_reason: usage.guard.degraded_reason } : {}),
        ...(usage.guard.retry_at ? { retry_at: usage.guard.retry_at } : {}),
      },
    },
    ...(result.retry_at
      ? {
          retry_at: {
            at: result.retry_at.at,
            effective_interval_ms: result.retry_at.effective_interval_ms,
            degraded_reason: result.retry_at.degraded_reason,
          },
        }
      : {}),
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      resource_ids_exposed: false,
      provider_cursor_exposed: false,
      sync_ids_exposed: false,
    },
  };
}




function assertSourceIndexSearchQuery(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'query must be a non-empty string.');
  }
}







function parseConnectorStoreIndexSearchRequestRecord(
  record: Record<string, unknown>,
  store: LocalConnectorStore,
  defaultAccountScope?: string,
  chatPrincipal?: ConnectorStoreChatPrincipal,
  declaredPrincipal?: ConnectorStoreDeclaredPrincipal,
  capabilityRegistry: ConnectorStoreFilterCapabilityRegistry = CONNECTOR_STORE_FILTER_CAPABILITIES,
): {
  query: string;
  maxResults: number;
  retrievalMode: 'keyword' | 'hybrid';
  accountScope?: string;
  explicitEmptyChatScope?: boolean;
  locatorsRequested?: true;
  resultProjector?: ConnectorStoreResultProjector;
  filters?: {
    provider?: string;
    conversationId?: string;
    senderId?: string;
    senderLabel?: string;
    authoredAfter?: string;
    authoredBefore?: string;
    locatorPathScope?: string;
    searchTextExactLines?: readonly string[];
  };
} {
  const corpusId = asOptionalString(record.corpus_id);
  if (corpusId !== store.corpusId) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `corpus_id must be ${store.corpusId}.`);
  }
  if (typeof record.query !== 'string' || record.query.trim().length === 0) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'query must be a non-empty string.');
  }
  const retrievalMode = asOptionalRetrievalMode(record.retrieval_mode) ?? 'keyword';
  const maxResults = asOptionalNumber(record.max_results);
  const requestedAccountScope = asOptionalNarrowingString(record, 'account')
    ?? (defaultAccountScope?.trim() || undefined);
  const requestedAccountScopeExact = asOptionalExactNarrowingString(record, 'account');
  const conversationId = asOptionalNarrowingString(record, 'conversation_id');
  const senderId = asOptionalNarrowingString(record, 'sender_id');
  const senderLabel = asOptionalNarrowingString(record, 'sender_label');
  const authoredAfter = asOptionalNarrowingString(record, 'authored_after');
  const authoredBefore = asOptionalNarrowingString(record, 'authored_before');
  const after = asOptionalNarrowingString(record, 'after');
  const before = asOptionalNarrowingString(record, 'before');
  asOptionalTrustDomainConsistency(record, store.trustDomain);
  const undeclaredFields = undeclaredConnectorStoreSearchRequestFields(record);
  if (undeclaredFields.length > 0) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      `Connector-store search request contains undeclared ${undeclaredFields.length === 1 ? 'property' : 'properties'}: ${undeclaredFields.map((field) => `"${field}"`).join(', ')}. Remove ${undeclaredFields.length === 1 ? 'it' : 'them'} and retry.`,
    );
  }
  const familyCapabilities = capabilityRegistry.resolve({
    family: store.family,
    ...(declaredPrincipal ? { provider: declaredPrincipal.provider } : {}),
  });
  const unsupportedFields = unsupportedConnectorStoreFilterFields(record, familyCapabilities);
  const unsupportedFolderFields = unsupportedFields.filter(
    (field) => field === 'folder_id' || field === 'folder_name',
  );
  if (unsupportedFolderFields.length > 0 && unsupportedFolderFields.length === unsupportedFields.length) {
    throw new EmailSourceWorkerError(
      400,
      'unsupported_filter',
      `Folder filters are not supported for connector-store family "${store.family}".`,
    );
  }
  if (unsupportedFields.length > 0) {
    const namedUnsupportedFields = [...unsupportedFields].sort();
    throw new EmailSourceWorkerError(
      400,
      'unsupported_filter',
      `${namedUnsupportedFields.length === 1 ? 'Filter' : 'Filters'} ${namedUnsupportedFields.map((field) => `"${field}"`).join(', ')} ${namedUnsupportedFields.length === 1 ? 'is' : 'are'} not supported for connector-store search of family "${store.family}". Remove ${namedUnsupportedFields.length === 1 ? 'it' : 'them'} and retry.`,
    );
  }
  if (authoredAfter !== undefined && after !== undefined) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Connector-store search cannot specify both "after" and "authored_after". Remove one and retry.',
    );
  }
  if (authoredBefore !== undefined && before !== undefined) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Connector-store search cannot specify both "before" and "authored_before". Remove one and retry.',
    );
  }
  const folderCodec = familyCapabilities?.folder;
  const chatScopeCodec = familyCapabilities?.chatScope;
  const approvedScopeCodec = familyCapabilities?.approvedScope;
  const resultProjectorCodec = familyCapabilities?.resultProjector;
  const includeLocators = resultProjectorCodec
    ? asOptionalBoolean(record.include_locators)
    : undefined;
  const approvedScopeKey = approvedScopeCodec
    ? asOptionalExactNarrowingString(record, 'approved_scope_key')
    : undefined;
  const chatScope = chatScopeCodec
    ? asOptionalExactNarrowingString(record, 'chat_scope')
    : undefined;
  const folderId = asOptionalNarrowingString(record, 'folder_id');
  const folderName = asOptionalNarrowingString(record, 'folder_name');
  const resolvedAuthoredAfter = authoredAfter ?? after;
  const resolvedAuthoredBefore = authoredBefore ?? before;
  if (approvedScopeKey && !declaredPrincipal) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'The "approved_scope_key" capability is not configured with a declared connector-store principal.',
    );
  }
  if (includeLocators === true && !declaredPrincipal) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'The "include_locators" capability is not configured with a declared connector-store principal.',
    );
  }
  const approvedScopeResolution = approvedScopeKey && approvedScopeCodec && declaredPrincipal
    ? approvedScopeCodec.resolveLocatorPath(approvedScopeKey, declaredPrincipal)
    : undefined;
  if (approvedScopeResolution?.kind === 'invalid') {
    throw new EmailSourceWorkerError(400, 'invalid_request', approvedScopeResolution.message);
  }
  if (
    approvedScopeResolution?.kind === 'path'
    && requestedAccountScopeExact !== undefined
    && requestedAccountScopeExact !== approvedScopeResolution.accountScope
  ) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Connector-store search cannot combine "account" with an "approved_scope_key" for another account.',
    );
  }
  if (
    includeLocators === true
    && requestedAccountScopeExact !== undefined
    && requestedAccountScopeExact !== declaredPrincipal!.accountScope
  ) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Connector-store locator release cannot combine "account" with a different mounted corpus account.',
    );
  }
  if (chatScope && !chatPrincipal) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'The "chat_scope" capability is not configured for this connector-store corpus.',
    );
  }
  if (
    chatScope
    && requestedAccountScopeExact !== undefined
    && requestedAccountScopeExact !== chatPrincipal!.accountScope
  ) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Connector-store search cannot combine "account" with a "chat_scope" for another account.',
    );
  }
  const chatScopeResolution = chatScope && chatScopeCodec
    ? chatScopeCodec.resolveConversationId(
        chatScope,
        (lookupTerms) => store.conversationTitleCandidates(
          lookupTerms,
          chatPrincipal!.accountScope,
          chatPrincipal!.provider,
        ),
      )
    : undefined;
  if (chatScopeResolution?.kind === 'invalid') {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Structured "chat_scope" must use account-scope-prefix:chat:conversation with non-empty segments and no extra segments.',
    );
  }
  if (
    chatScopeResolution?.kind === 'structured'
    && requestedAccountScopeExact !== undefined
    && requestedAccountScopeExact !== chatScopeResolution.accountScope
  ) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Connector-store search cannot combine "account" with a "chat_scope" for another account.',
    );
  }
  if (chatScopeResolution?.kind === 'structured') {
    if (
      chatScopeResolution.provider !== undefined
      && chatScopeResolution.provider !== chatPrincipal!.provider
    ) {
      throw new EmailSourceWorkerError(
        400,
        'invalid_request',
        'Structured "chat_scope" provider does not match the selected connector-store corpus.',
      );
    }
    if (chatScopeResolution.accountScope !== chatPrincipal!.accountScope) {
      throw new EmailSourceWorkerError(
        400,
        'invalid_request',
        'Structured "chat_scope" account does not match the selected connector-store corpus account.',
      );
    }
  }
  const accountScope = chatScopeResolution?.kind === 'structured'
    ? chatScopeResolution.accountScope
    : approvedScopeResolution?.kind === 'path'
      ? approvedScopeResolution.accountScope
      : includeLocators === true
        ? declaredPrincipal!.accountScope
      : chatScope
        ? chatPrincipal!.accountScope
        : requestedAccountScope;
  if (
    conversationId
    && chatScopeResolution
    && (!chatScopeResolution.resolved || chatScopeResolution.conversationId !== conversationId)
  ) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'Connector-store search cannot combine "chat_scope" with a contradictory or unresolved "conversation_id". Remove one and retry.',
    );
  }
  const resolvedConversationId = chatScopeResolution?.conversationId ?? conversationId;
  let filters: ReturnType<typeof normalizeConnectorStoreSearchFilters>;
  try {
    const searchTextExactLines = [
      ...(folderId && folderCodec ? [folderCodec.folderIdExactLine(folderId)] : []),
      ...(folderName && folderCodec ? [folderCodec.folderNameExactLine(folderName)] : []),
    ];
    filters = normalizeConnectorStoreSearchFilters({
      ...(approvedScopeResolution?.kind === 'path'
        ? {
            provider: declaredPrincipal!.provider,
            locatorPathScope: approvedScopeResolution.locatorPath,
          }
        : includeLocators === true
          ? { provider: declaredPrincipal!.provider }
        : chatScope
          ? { provider: chatPrincipal!.provider }
          : {}),
      ...(resolvedConversationId ? { conversationId: resolvedConversationId } : {}),
      ...(senderId ? { senderId } : {}),
      ...(senderLabel ? { senderLabel } : {}),
      ...(resolvedAuthoredAfter ? { authoredAfter: resolvedAuthoredAfter } : {}),
      ...(resolvedAuthoredBefore ? { authoredBefore: resolvedAuthoredBefore } : {}),
      ...(searchTextExactLines.length > 0 ? { searchTextExactLines } : {}),
    });
  } catch (error) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      error instanceof Error ? error.message : 'Connector-store metadata filters are invalid.',
    );
  }
  return {
    query: record.query,
    maxResults: maxResults ?? 10,
    retrievalMode,
    ...(accountScope ? { accountScope } : {}),
    ...(chatScopeResolution?.kind === 'title' && !chatScopeResolution.resolved
      ? { explicitEmptyChatScope: true }
      : {}),
    ...(includeLocators === true
      ? {
          locatorsRequested: true as const,
          resultProjector: resultProjectorCodec!.create({
            principal: declaredPrincipal!,
            ...(approvedScopeKey !== undefined ? { approvedScopeKey } : {}),
          }),
        }
      : {}),
    ...(filters ? { filters } : {}),
  };
}

function sourceIndexSearchCorpusIds(connectorStores: readonly LocalConnectorStore[]): string[] {
  return [
    DROPBOX_FILES_CORPUS_ID,
    X_BOOKMARKS_CORPUS_ID,
    INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
    ...connectorStores.map((store) => store.corpusId),
  ];
}

function sourceIndexStatusCorpusIds(connectorStores: readonly LocalConnectorStore[]): string[] {
  return [
    'secure_local.email.private',
    'internal.email',
    'internal.drive.docs',
    'secure_local.drive.docs',
    INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    READWISE_LIBRARY_CORPUS_ID,
    X_BOOKMARKS_CORPUS_ID,
    DROPBOX_FILES_CORPUS_ID,
    PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
    ...connectorStores.map((store) => store.corpusId),
  ];
}




async function parseDropboxSourceExportRequest(request: Request): Promise<DropboxSourceExportRequest> {
  const record = await parseObjectBody(request);
  const corpusId = asOptionalString(record.corpus_id);
  if (corpusId !== undefined && corpusId !== DROPBOX_FILES_CORPUS_ID) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `corpus_id must be ${DROPBOX_FILES_CORPUS_ID} when provided.`);
  }
  const destinationRoot = asOptionalString(record.destination_root);
  if (!destinationRoot) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'destination_root must be a non-empty Dropbox folder path.');
  }
  if (!Array.isArray(record.items) || record.items.length === 0) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'items must be a non-empty array of export items.');
  }
  const items = record.items.map((item, index) => parseDropboxSourceExportItem(item, index));
  const account = asOptionalString(record.account);
  const dryRun = asOptionalBoolean(record.dry_run);
  return {
    ...(account !== undefined ? { account } : {}),
    destination_root: destinationRoot,
    items,
    ...(dryRun !== undefined ? { dry_run: dryRun } : {}),
  };
}

function parseDropboxSourceExportItem(value: unknown, index: number): DropboxSourceExportItemRequest {
  if (typeof value === 'string' && value.trim()) {
    return { path: value.trim() };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `items.${index} must be a path string or an object with a path.`);
  }
  const record = value as Record<string, unknown>;
  const path = asOptionalString(record.path);
  if (!path) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `items.${index}.path must be a non-empty string.`);
  }
  const destSubfolder = asOptionalString(record.dest_subfolder);
  return {
    path,
    ...(destSubfolder !== undefined ? { dest_subfolder: destSubfolder } : {}),
  };
}











async function parseDropboxEvalShardExportRequest(request: Request): Promise<DropboxEvalShardExportRequest> {
  const record = await parseObjectBody(request);
  const corpusId = asOptionalString(record.corpus_id);
  if (corpusId !== undefined && corpusId !== DROPBOX_FILES_CORPUS_ID) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `corpus_id must be ${DROPBOX_FILES_CORPUS_ID} when provided.`);
  }
  const approvedScopeKey = asOptionalString(record.approved_scope_key);
  const count = asOptionalNumber(record.count);
  const outDir = asOptionalString(record.out_dir);
  if (!approvedScopeKey || count === undefined || !outDir) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'approved_scope_key, count, and out_dir are required for Dropbox eval shard export.',
    );
  }
  const account = asOptionalString(record.account);
  const dryRun = asOptionalBoolean(record.dry_run);
  const docTypes = asOptionalStringArray(record.doc_types, 'doc_types');
  return {
    ...(account !== undefined ? { account } : {}),
    approved_scope_key: approvedScopeKey,
    count,
    out_dir: outDir,
    ...(docTypes !== undefined ? { doc_types: docTypes } : {}),
    ...(dryRun !== undefined ? { dry_run: dryRun } : {}),
  };
}



















const SOURCE_DISPOSITION_STATES: readonly SourceDispositionState[] = ['ingest', 'metadata_only', 'exclude'];

/**
 * Validate a folder-picker save.
 *
 * Two things here are load-bearing rather than hygiene:
 *
 *   - `source` must be one this worker actually serves. A save is allowed to
 *     scope a new rule to a source key, and an unchecked one would let a caller
 *     write rules against a source that does not exist — which parse accepts
 *     and no gate ever applies, so the owner would see a rule on the page that
 *     never matches anything.
 *   - `enforceable` is read from that source's own declaration and is NEVER
 *     taken from the body. It is what decides whether a folder rule can be
 *     written at all, so a caller that supplied it could write path rules into
 *     a source that cannot enforce them — the exact silent no-op the gate's
 *     capability declaration exists to prevent.
 */
function parseSourceDispositionsSave(
  body: Record<string, unknown>,
  sources: readonly SourceDispositionsSource[],
): {
  source?: string;
  enforceable?: readonly SourceExclusionCriterionKind[];
  edits: SourceDispositionEdit[];
  document?: unknown;
} {
  const requested = asOptionalString(body.source);
  const matched = requested === undefined
    ? undefined
    : sources.find((source) => source.source_id.toLowerCase() === requested.trim().toLowerCase());
  if (requested !== undefined && !matched) {
    throw new EmailSourceWorkerError(
      400,
      'unknown_dispositions_source',
      'That source is not served by this worker, so no rule was written for it.',
    );
  }
  const rawEdits = body.edits;
  if (rawEdits !== undefined && !Array.isArray(rawEdits)) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'edits must be an array.');
  }
  const edits = (Array.isArray(rawEdits) ? rawEdits : []).map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new EmailSourceWorkerError(400, 'invalid_request', `edits[${index}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const path = asOptionalString(record.path);
    const state = asOptionalString(record.state);
    if (!path) {
      throw new EmailSourceWorkerError(400, 'invalid_request', `edits[${index}].path must be a non-empty string.`);
    }
    const known = SOURCE_DISPOSITION_STATES.find((candidate) => candidate === state);
    if (!known) {
      throw new EmailSourceWorkerError(
        400,
        'invalid_request',
        `edits[${index}].state must be one of ${SOURCE_DISPOSITION_STATES.join(', ')}.`,
      );
    }
    const reason = asOptionalString(record.reason);
    return { path, state: known, ...(reason ? { reason } : {}) };
  });
  if (edits.length === 0 && body.document === undefined) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'Send at least one edit, or a whole rules document.');
  }
  return {
    ...(matched ? { source: matched.source_id, enforceable: matched.enforceable } : {}),
    edits,
    ...(body.document !== undefined ? { document: body.document } : {}),
  };
}

async function parseObjectBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new EmailSourceWorkerError(400, 'invalid_json', 'Request body must be a JSON object.');
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

/**
 * Resolves a request body's corpus_id through the shared corpus registry so a
 * documented input alias reaches dispatch as its canonical id. The parsed body
 * is rewritten in place because the per-family request parsers below re-read
 * record.corpus_id themselves; canonicalising once here keeps every downstream
 * branch and parser working on canonical ids only, with no per-family alias
 * checks anywhere. The alias table lives in the registry, so this stays
 * source-neutral as families come and go.
 */
function canonicalRequestCorpusId(record: Record<string, unknown>): string | undefined {
  const requestedCorpusId = asOptionalString(record.corpus_id);
  if (requestedCorpusId === undefined) return undefined;
  const corpusId = canonicalSourceCorpusId(requestedCorpusId);
  if (corpusId !== requestedCorpusId) record.corpus_id = corpusId;
  return corpusId;
}

function sourceSchedulerSourceIdForCorpus(corpusId: string): string | undefined {
  if (corpusId === INTERNAL_EMAIL_CORPUS_ID || corpusId === GMAIL_SECURE_LOCAL_CORPUS_ID) {
    return 'gmail.email';
  }
  if (corpusId === GOOGLE_DRIVE_DOCS_CORPUS_ID || corpusId === 'secure_local.drive.docs') {
    return 'google_drive.docs';
  }
  if (corpusId === DROPBOX_FILES_CORPUS_ID) return 'dropbox.files';
  if (corpusId === READWISE_LIBRARY_CORPUS_ID) return 'readwise.library';
  if (corpusId === X_BOOKMARKS_CORPUS_ID) return 'x.bookmarks';
  if (isTelegramMessagesCorpusId(corpusId)) return 'telegram.messages';
  if (corpusId === 'secure_local.whatsapp.messages') return 'whatsapp.personal.messages';
  return undefined;
}

// --- the source-neutral extraction factory's HTTP surface -------------------

const DEFAULT_FILE_EXTRACTION_PLAN_LIMIT = 100;

/**
 * The lane provider the Dropbox extraction source stamps on every ref it
 * enumerates. The aliased paths never carried it in their bodies, so the alias
 * supplies it the same way it supplies the corpus id.
 */
const DROPBOX_FILE_EXTRACTION_PROVIDER = 'dropbox';

type FileExtractionAliasOperation =
  | 'extract'
  | 'plan'
  | 'transcribe'
  | 'recycle_leases'
  | 'janitor_requeue';

interface FileExtractionRouteAlias {
  operation: FileExtractionAliasOperation;
  genericPath: string;
  corpusId: string;
  provider: string;
}

/**
 * The family-scoped extraction paths, and the generic path each one aliases.
 *
 * These are the URLs the running supervisor fleet already speaks to, so they
 * keep working unchanged. The alias injects the corpus id AND the provider the
 * caller never had to name — the two things the generic route needs that the
 * family-scoped one carried in its path instead of its body.
 *
 * Four family-scoped extraction paths have NO generic twin here on purpose:
 * `retarget-queued`, `requalify-terminal` and `retire-jobs` are operations the
 * factory's job store does not implement, and `on-demand-media`,
 * `apply-tier-overrides`, `export-eval-shard` and the promotion routes were
 * already out of scope for the factory. Aliasing a path onto an operation that
 * does not exist would be worse than leaving it legacy.
 */
const FILE_EXTRACTION_ROUTE_ALIASES: ReadonlyMap<string, FileExtractionRouteAlias> = new Map([
  ['/source/index/dropbox/content/extract', {
    operation: 'extract' as const,
    genericPath: '/source/index/files/extract',
    corpusId: DROPBOX_FILES_CORPUS_ID,
    provider: DROPBOX_FILE_EXTRACTION_PROVIDER,
  }],
  ['/source/index/dropbox/content/plan', {
    operation: 'plan' as const,
    genericPath: '/source/index/files/plan',
    corpusId: DROPBOX_FILES_CORPUS_ID,
    provider: DROPBOX_FILE_EXTRACTION_PROVIDER,
  }],
  ['/source/index/dropbox/content/recycle-leases', {
    operation: 'recycle_leases' as const,
    genericPath: '/source/index/files/recycle-leases',
    corpusId: DROPBOX_FILES_CORPUS_ID,
    provider: DROPBOX_FILE_EXTRACTION_PROVIDER,
  }],
  ['/source/index/dropbox/content/janitor-requeue', {
    operation: 'janitor_requeue' as const,
    genericPath: '/source/index/files/janitor-requeue',
    corpusId: DROPBOX_FILES_CORPUS_ID,
    provider: DROPBOX_FILE_EXTRACTION_PROVIDER,
  }],
  ['/source/index/dropbox/transcribe', {
    operation: 'transcribe' as const,
    genericPath: '/source/index/files/transcribe',
    corpusId: DROPBOX_FILES_CORPUS_ID,
    provider: DROPBOX_FILE_EXTRACTION_PROVIDER,
  }],
]);

function fileExtractionAliasFor(pathname: string, basePath: string): FileExtractionRouteAlias | undefined {
  if (!pathname.startsWith(basePath)) return undefined;
  return FILE_EXTRACTION_ROUTE_ALIASES.get(pathname.slice(basePath.length));
}

function requireFileExtractionRunner(runner: FileExtractionRunner | undefined): FileExtractionRunner {
  if (!runner) {
    throw new EmailSourceWorkerError(
      501,
      'file_extraction_not_supported',
      'Private source worker does not have the file-extraction factory configured.',
    );
  }
  return runner;
}

/**
 * The lane every factory route is scoped to.
 *
 * The corpus id goes through the shared canonicaliser, so a documented input
 * alias reaches dispatch as its canonical id rather than as an unknown corpus.
 * A family-scoped path supplies the id and the provider itself, which is what
 * makes it an alias rather than a second implementation.
 */
function parseFileExtractionLaneRecord(
  record: Record<string, unknown>,
  alias: FileExtractionRouteAlias | undefined,
  runner: FileExtractionRunner,
): ExtractionLaneKey {
  const corpusId = canonicalRequestCorpusId(record) ?? alias?.corpusId;
  if (corpusId === undefined) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'corpus_id is required for file extraction.');
  }
  if (!runner.corpusIds().includes(corpusId)) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'corpus_id must name a corpus the file-extraction factory serves.',
    );
  }
  const provider = asOptionalString(record.provider) ?? alias?.provider;
  if (!provider) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'provider is required for file extraction.');
  }
  const accountScope = asOptionalString(record.account_scope) ?? asOptionalString(record.account);
  if (!accountScope) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'account is required for file extraction.');
  }
  const approvedScopeKey = asOptionalString(record.approved_scope_key);
  if (!approvedScopeKey) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'approved_scope_key is required for file extraction.');
  }
  return { corpusId, provider, accountScope, approvedScopeKey };
}

function parseExtractionPolicyDecision(value: unknown): ExtractionPolicyDecision {
  const decision = asOptionalString(value);
  if (
    decision !== 'index_allowed'
    && decision !== 'index_redacted'
    && decision !== 'metadata_only'
    && decision !== 'blocked_sensitive'
    && decision !== 'needs_review'
  ) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'policy_decision is not a recognised decision.');
  }
  return decision;
}

function optionalStringField<K extends string>(value: unknown, key: K): { [P in K]?: string } {
  const parsed = asOptionalString(value);
  return (parsed === undefined ? {} : { [key]: parsed }) as { [P in K]?: string };
}

function optionalNumberField<K extends string>(
  value: unknown,
  name: string,
  key: K,
): { [P in K]?: number } {
  const parsed = asOptionalNumber(value, name);
  return (parsed === undefined ? {} : { [key]: parsed }) as { [P in K]?: number };
}

function fileExtractionRunBody(result: ExtractionRunResult): Record<string, unknown> {
  return {
    kind: result.kind,
    corpus_id: result.corpusId,
    provider: result.provider,
    account: result.accountScope,
    scope_key_hash: result.scopeKeyHash,
    worker_id_hash: result.workerIdHash,
    leased_jobs: result.leasedJobs,
    processed_jobs: result.processedJobs,
    abandoned_leases: result.abandonedLeases,
    paused: result.paused,
    ...(result.pauseReason !== undefined ? { pause_reason: result.pauseReason } : {}),
    ...(result.preflightErrorKind !== undefined
      ? { preflight_error_kind: result.preflightErrorKind }
      : {}),
    consecutive_retryable_failures: result.consecutiveRetryableFailures,
    counts: result.counts,
    records: result.records.map((record) => ({
      job_id: record.jobId,
      status: record.status,
      extractor_kind: record.extractorKind,
      extractor_version: record.extractorVersion,
      attempts: record.attempts,
      ...(record.errorKind !== undefined ? { error_kind: record.errorKind } : {}),
      ...(record.nextRetryAt !== undefined ? { next_retry_at: record.nextRetryAt } : {}),
      ...(record.chunksIndexed !== undefined ? { chunks_indexed: record.chunksIndexed } : {}),
      ...(record.chunksAwaitingEmbedding !== undefined
        ? { chunks_awaiting_embedding: record.chunksAwaitingEmbedding }
        : {}),
      ...(record.artifactsRecorded !== undefined ? { artifacts_recorded: record.artifactsRecorded } : {}),
      ...(record.egressDestination !== undefined
        ? { egress_destination: record.egressDestination }
        : {}),
      ...(record.leaseLost === true ? { lease_lost: true } : {}),
    })),
    ...(result.reclassification !== undefined
      ? { reclassification: fileExtractionReclassificationBody(result.reclassification) }
      : {}),
    policy: {
      worker_private_surface: true,
      raw_source_exposed: false,
      source_text_returned: false,
      file_bytes_persisted: false,
      temp_bytes_cleaned: true,
      local_only: result.policy.localOnly,
      trust_domain: result.policy.trustDomain,
      ...(result.policy.egressDestination !== undefined
        ? { egress_destination: result.policy.egressDestination }
        : {}),
    },
  };
}

function fileExtractionPlanBody(result: ExtractionPlanResult): Record<string, unknown> {
  return {
    kind: result.kind,
    corpus_id: result.corpusId,
    candidates: result.candidates,
    jobs_queued: result.jobsQueued,
    jobs_existing: result.jobsExisting,
    jobs_forced: result.jobsForced,
    jobs_skipped_too_large: result.jobsSkippedTooLarge,
    jobs_unroutable: result.jobsUnroutable,
    extractor_kinds: result.extractorKinds,
    ...(result.nextCursor !== undefined ? { next_cursor: result.nextCursor } : {}),
    done: result.done,
    policy: {
      worker_private_surface: true,
      raw_source_exposed: false,
      source_text_returned: false,
      file_bytes_downloaded: false,
      local_only: result.policy.localOnly,
      trust_domain: result.policy.trustDomain,
      ...(result.policy.egressDestination !== undefined
        ? { egress_destination: result.policy.egressDestination }
        : {}),
    },
  };
}

function fileExtractionReclassificationBody(
  result: ExtractionReclassificationResult,
): Record<string, unknown> {
  return {
    kind: result.kind,
    corpus_id: result.corpusId,
    jobs_escalated: result.jobsEscalated,
    dry_run: result.dryRun,
    rules: result.rules.map((rule) => ({
      from_extractor_kind: rule.fromExtractorKind,
      last_error_kind: rule.lastErrorKind,
      to_extractor_kind: rule.toExtractorKind,
      matched_jobs: rule.matchedJobs,
      jobs_escalated: rule.jobsEscalated,
      skipped_target_exists: rule.skippedTargetExists,
    })),
  };
}

async function parseSourceWatchCreateRequest(request: Request): Promise<CreateSourceWatchInput> {
  const record = await parseObjectBody(request);
  assertOnlyRequestFields(record, [
    'corpus_id',
    'query_text',
    'mode',
    'expires_at',
    'max_delivery_attempts',
  ]);
  // Resolved before the watch is persisted. A watch is long-lived work, so
  // storing the id as sent would keep an unresolved alias on disk and the watch
  // would be accepted and then never fire - accepting work that can never
  // happen. Storing the canonical id means the evaluation pass finds the corpus.
  const corpusId = canonicalRequestCorpusId(record);
  const queryText = asOptionalString(record.query_text);
  const mode = asOptionalString(record.mode);
  if (!corpusId || !queryText || (mode !== 'one_shot' && mode !== 'continuous')) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'corpus_id, query_text, and a valid mode are required.');
  }
  const expiresAt = asOptionalString(record.expires_at);
  const maxDeliveryAttempts = asOptionalNumber(record.max_delivery_attempts, 'max_delivery_attempts');
  return {
    corpusId,
    queryText,
    mode,
    ...(expiresAt ? { expiresAt } : {}),
    ...(maxDeliveryAttempts !== undefined ? { maxDeliveryAttempts } : {}),
  };
}

async function parseSourceWatchesRequest(request: Request): Promise<{ limit?: number; cursor?: string }> {
  const record = await parseObjectBody(request);
  assertOnlyRequestFields(record, ['limit', 'cursor']);
  const limit = asOptionalNumber(record.limit, 'limit');
  const cursor = asOptionalString(record.cursor);
  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

async function parseSourceWatchCancelRequest(request: Request): Promise<{ watchId: string; reason?: string }> {
  const record = await parseObjectBody(request);
  assertOnlyRequestFields(record, ['watch_id', 'reason']);
  const watchId = asOptionalString(record.watch_id);
  if (!watchId) throw new EmailSourceWorkerError(400, 'invalid_request', 'watch_id is required.');
  const reason = asOptionalString(record.reason);
  return { watchId, ...(reason ? { reason } : {}) };
}

function assertOnlyRequestFields(record: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedFields = new Set(allowed);
  const unsupported = Object.keys(record).find((field) => !allowedFields.has(field));
  if (unsupported) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `Request field ${unsupported} is not supported.`);
  }
}

function authenticatedWatchOwner(request: Request) {
  try {
    return trustedSourceWatchOwnerFromRequest(request);
  } catch {
    throw new EmailSourceWorkerError(
      403,
      'source_watch_owner_context_required',
      'Source watch route requires authenticated OpenClaw owner and delivery context.',
    );
  }
}

function sourceWatchNotSupported(): EmailSourceWorkerError {
  return new EmailSourceWorkerError(
    501,
    'source_watch_not_supported',
    'Private source worker does not have the durable watch control plane configured.',
  );
}



function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function asOptionalNarrowingString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      `${key} must be a non-empty string when provided.`,
    );
  }
  return value.trim();
}

function asOptionalTrustDomainConsistency(
  record: Readonly<Record<string, unknown>>,
  expectedTrustDomain: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, 'trust_domain')) return undefined;
  const value = record.trust_domain;
  if (typeof value !== 'string' || value !== expectedTrustDomain) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      'trust_domain does not exactly match the selected corpus trust domain.',
    );
  }
  return value;
}

function asOptionalExactNarrowingString(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EmailSourceWorkerError(
      400,
      'invalid_request',
      `${key} must be a non-empty string when provided.`,
    );
  }
  return value;
}

function parseDashboardOAuthSource(value: unknown): DashboardOAuthSource {
  const source = asOptionalString(value);
  if (source === 'google' || source === 'gmail' || source === 'google-drive' || source === 'dropbox' || source === 'x') {
    return source;
  }
  throw new EmailSourceWorkerError(400, 'invalid_request', 'source must be google, gmail, google-drive, dropbox, or x.');
}

function parseDashboardApiKeySource(value: unknown): DashboardApiKeySource {
  const source = asOptionalString(value);
  if (source === 'venice' || source === 'readwise') return source;
  throw new EmailSourceWorkerError(400, 'invalid_request', 'source must be venice or readwise.');
}

function parseDashboardSyncSource(value: unknown): DashboardConnectSource {
  const source = asOptionalString(value);
  if (source && isDashboardSyncSource(source)) return source;
  throw new EmailSourceWorkerError(400, 'invalid_request', 'source must be gmail, google-drive, dropbox, x, or readwise.');
}

function parseDashboardDisconnectSource(value: unknown): V04PublicSourceId {
  const source = asOptionalString(value);
  if (
    source === 'gmail.email'
    || source === 'google_drive.docs'
    || source === 'dropbox.files'
    || source === 'x.bookmarks'
    || source === 'telegram.messages'
    || source === 'whatsapp.personal.messages'
    || source === 'readwise.library'
  ) return source;
  throw new EmailSourceWorkerError(400, 'invalid_request', 'source_id must name one declared v0.4 source.');
}

/**
 * What a previous attempt left owing for these sources.
 *
 * An Unpair is not one act but several — delete each artifact, remove the
 * stored reference, drop the registry handle — and any of them can fail on its
 * own. The record is where the unfinished ones live between attempts, so a
 * retry starts from what is still owed rather than from what it happens to be
 * able to see.
 */
function dashboardUnpairObligations(
  existing: UnpairedSourcesRead,
  sourceIds: ReadonlySet<V04PublicSourceId>,
): { paths: string[]; steps: string[] } {
  if (existing.status !== 'ok') return { paths: [], steps: [] };
  const relevant = existing.records.filter((record) =>
    sourceIds.has(record.source_id as V04PublicSourceId));
  return {
    paths: [...new Set(relevant.flatMap((record) => record.unremoved_paths ?? []))],
    steps: [...new Set(relevant.flatMap((record) => record.failed_steps ?? []))],
  };
}

/** The two v0.4 sources that are paired as a local session, not brokered. */
type DashboardUnpairSource = 'telegram.messages' | 'whatsapp.personal.messages';

function parseDashboardUnpairSource(value: unknown): DashboardUnpairSource {
  const source = asOptionalString(value);
  if (source === 'telegram.messages' || source === 'whatsapp.personal.messages') return source;
  throw new EmailSourceWorkerError(
    400,
    'invalid_request',
    'source_id must be telegram.messages or whatsapp.personal.messages. Other sources use Disconnect.',
  );
}

interface DashboardPairingSession {
  /** The artifacts Unpair may delete for this source, and nothing else. */
  paths: string[];
  /** Every stored reference that pointed at this pairing, for removal. */
  credentialKeys: string[];
}

/**
 * Where this source's pairing session actually lives, and what points at it.
 *
 * The path the owner REGISTERED wins whenever there is one.
 * `olympus connect telegram|whatsapp --session-path <path>` stores an arbitrary
 * location, so deriving from env/defaults alone meant a custom-path pairing had
 * its handle and stored reference deleted while the login itself stayed on disk
 * and the card said unpaired — a false completion in the one direction that
 * matters.
 *
 * The stored value is found WITHOUT going through the handle registry. A paired
 * session commonly owns no handle at all, and the handle-derived key list is
 * then empty, which is exactly the case that fell back to the default path and
 * missed a custom one. The secret store is asked directly instead, so the
 * registered path is found whether or not a handle survives to name it.
 *
 * An explicit env override that names a DIFFERENT session refuses rather than
 * guessing which one the live reader opens, and so do two stored values that
 * disagree. Both derivations run through the shared module the export/delete
 * custody path uses, so the narrow Unpair list and the wider lifecycle list can
 * never drift onto two different resolutions of the same session.
 */
async function dashboardPairingSession(
  sourceId: DashboardUnpairSource,
  handleCredentialKeys: readonly string[],
  secretStore: SecretStore,
  context: OlympusPathContext | undefined,
): Promise<DashboardPairingSession> {
  const resolved = context ?? { env: process.env };
  const source = sourceId === 'telegram.messages' ? 'telegram' as const : 'whatsapp' as const;
  const derived = source === 'telegram'
    ? telegramPairingSessionPaths(resolved)
    : whatsappPairingSessionPaths(resolved);
  const sessionKeys = await dashboardSessionPathSecretKeys(source, handleCredentialKeys, secretStore);
  const fromStored = await dashboardStoredSessionPaths(sourceId, source, sessionKeys, secretStore);
  const credentialKeys = [...new Set([
    ...handleCredentialKeys,
    ...sessionKeys.filter((candidate) => candidate.stored).map((candidate) => candidate.key),
  ])].sort();
  if (fromStored === undefined) return { paths: derived, credentialKeys };
  if (pairingSessionPathOverridden(source, resolved) && !samePathList(fromStored, derived)) {
    throw new EmailSourceWorkerError(
      409,
      'unpair_session_path_conflict',
      'The registered session path and the configured environment override name different pairing sessions, so Unpair cannot tell which one this computer actually uses. Reconcile OLYMPUS_TELEGRAM_SESSION_PATH or OLYMPUS_WHATSAPP_STATE_DIR with the path this source was connected with, then retry.',
    );
  }
  return { paths: fromStored, credentialKeys };
}

interface DashboardSessionPathKey {
  key: string;
  /** Whether the store actually holds a value under it. */
  stored: boolean;
}

/**
 * Every secret key that could hold this source's registered session path.
 *
 * The canonical key is always considered, and the store is listed so a pairing
 * registered under a non-default account role is still found. Listing is best
 * effort: a store that cannot enumerate falls back to the canonical key and the
 * handle-derived ones rather than failing the whole operation.
 */
async function dashboardSessionPathSecretKeys(
  source: 'telegram' | 'whatsapp',
  handleCredentialKeys: readonly string[],
  secretStore: SecretStore,
): Promise<DashboardSessionPathKey[]> {
  const prefix = `${source === 'telegram' ? 'telegram' : 'whatsapp'}.`;
  const canonical = source === 'telegram'
    ? 'telegram.personal.session_path'
    : 'whatsapp.personal_local.session_path';
  const candidates = new Set<string>([canonical]);
  for (const key of handleCredentialKeys) {
    if (key.startsWith(prefix) && key.endsWith('.session_path')) candidates.add(key);
  }
  try {
    for (const key of await secretStore.list()) {
      if (key.startsWith(prefix) && key.endsWith('.session_path')) candidates.add(key);
    }
  } catch {
    // Enumeration is an optimization over the canonical key, never a gate.
  }
  const keys: DashboardSessionPathKey[] = [];
  for (const key of [...candidates].sort()) {
    const value = (await secretStore.get(key))?.trim();
    keys.push({ key, stored: value !== undefined && value !== '' });
  }
  return keys;
}

/**
 * The artifact list this source was connected with, if the stored references
 * agree about which session that is.
 *
 * Every stored value is NORMALIZED to its artifact list first, and the dedupe
 * happens on those lists. Comparing the raw strings made `/data/tg` and
 * `/data/tg.session` — one session, two documented spellings, e.g. after a
 * re-connect that used the other form — look like two different pairings and
 * refuse. A conflict now means genuinely different sessions.
 */
async function dashboardStoredSessionPaths(
  sourceId: DashboardUnpairSource,
  source: 'telegram' | 'whatsapp',
  sessionKeys: readonly DashboardSessionPathKey[],
  secretStore: SecretStore,
): Promise<string[] | undefined> {
  const bySession = new Map<string, string[]>();
  for (const candidate of sessionKeys) {
    if (!candidate.stored) continue;
    const value = (await secretStore.get(candidate.key))?.trim();
    if (!value) continue;
    const paths = pairingSessionPathsFromStoredValue(source, value);
    if (paths.length === 0) continue;
    bySession.set(sessionPathListKey(paths), paths);
  }
  if (bySession.size === 0) return undefined;
  if (bySession.size > 1) {
    throw new EmailSourceWorkerError(
      409,
      'unpair_session_path_conflict',
      `Unpair found more than one registered pairing session for ${sourceId}. Resolve the duplicate handles with the CLI first.`,
    );
  }
  return [...bySession.values()][0];
}

/** One comparable identity for an artifact list, independent of spelling. */
function sessionPathListKey(paths: readonly string[]): string {
  return [...new Set(paths.map((path) => resolve(path)))].sort().join('\0');
}

function samePathList(left: readonly string[], right: readonly string[]): boolean {
  const normalize = (paths: readonly string[]) => [...new Set(paths.map((path) => resolve(path)))].sort();
  const a = normalize(left);
  const b = normalize(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * One refused pairing path, turned into the answer the dashboard shows.
 *
 * Every reason is a 409: none of them is a malformed request, and all of them
 * mean the same thing to a reader — Olympus will not delete this, do it
 * yourself. The offending component is named because a symlinked ancestor is
 * otherwise invisible from the path the card knows about.
 */
function dashboardUnpairPathError(refusal: PairingPathRefusal): EmailSourceWorkerError {
  if (refusal.reason === 'outside_root') {
    return new EmailSourceWorkerError(
      409,
      'unpair_session_path_external',
      'The configured pairing-session directory is outside every Olympus-owned root, so Unpair will not delete it. Check OLYMPUS_TELEGRAM_SESSION_PATH or OLYMPUS_WHATSAPP_STATE_DIR, then remove the session by hand.',
    );
  }
  if (refusal.reason === 'symlink_component') {
    return new EmailSourceWorkerError(
      409,
      'unpair_session_path_external',
      `The pairing-session path reaches outside Olympus through a symbolic link at ${refusal.component}, so Unpair will not delete it. Remove the session by hand.`,
    );
  }
  if (refusal.reason === 'inspection_failed') {
    // An artifact that cannot be inspected is an unknown, and reporting an
    // unknown as an absent one is how a skipped session became a completed
    // removal. Refuse the whole operation instead.
    return new EmailSourceWorkerError(
      409,
      'unpair_session_path_unreadable',
      `Unpair could not inspect ${refusal.component}, so it cannot say what is there. Check the permissions on the pairing-session directory, then retry.`,
    );
  }
  return new EmailSourceWorkerError(
    409,
    'unpair_session_path_not_a_file',
    `Refusing to delete a pairing artifact that is not a regular file: ${refusal.component}`,
  );
}

/**
 * The unpaired sources the dashboard should still be told about.
 *
 * READ ONLY. This runs on every render of a page that polls every few seconds,
 * and it used to rewrite the record to drop re-paired sources. That write held
 * no grant-custody lease, so a render could land between an Unpair's read and
 * its commit and overwrite the fact Unpair had just recorded. Dropping a source
 * on re-pair happens in the connect path that registers the new pairing, under
 * the same lease that writes the handle.
 *
 * The durable record is authoritative when it can be read. There is
 * deliberately NO "but a usable handle exists" filter any more: a teardown that
 * deleted the session files and then failed to remove the handle left exactly
 * that handle behind, and the filter turned it into a card claiming a live
 * session over a session that was already gone.
 *
 * An unreadable record is its own answer, never an absent one. Reporting a
 * parse failure as "nothing has been unpaired" is the failure mode that let a
 * card go back to inferring connectedness from sync evidence after a restart,
 * so both paired-session cards say the state cannot be read — the record could
 * name either — and Unpair and connect refuse to mutate until it is repaired.
 */
function dashboardUnpairedSourceStates(
  unpaired: Set<V04PublicSourceId>,
  registryPath: string,
): DashboardUnpairedSourceState[] {
  const read = readReconciledUnpairedSources(registryPath);
  if (read.status === 'unreadable') {
    return DASHBOARD_UNPAIR_SOURCE_IDS.map((source_id) => ({ source_id, state: 'unpair_state_unreadable' as const }));
  }
  const records = new Map<string, UnpairedSourceRecord>();
  // Only where the file is absent does this process's own memory stand in for
  // it: a record deleted out from under a running worker is still a fact this
  // worker performed, and forgetting it would hand the card back to inference.
  if (read.status === 'missing') {
    for (const sourceId of unpaired) records.set(sourceId, { source_id: sourceId, state: 'unpaired' });
  } else {
    for (const record of read.records) {
      if (!isDashboardUnpairSourceId(record.source_id)) continue;
      records.set(record.source_id, record);
    }
  }
  return [...records.values()]
    .sort((a, b) => a.source_id.localeCompare(b.source_id))
    // The view model is served to the read-only dash_ token, which is promised
    // no filesystem paths. Only whether cleanup is outstanding crosses this
    // line; the paths themselves stay in the CSRF-authorized POST response that
    // the person who pressed the button is already reading.
    .map((record) => ({
      source_id: record.source_id,
      state: record.state === 'unpaired' ? 'unpaired' as const : 'unpair_incomplete' as const,
    }));
}

const DASHBOARD_UNPAIR_SOURCE_IDS: DashboardUnpairSource[] = [
  'telegram.messages',
  'whatsapp.personal.messages',
];

function isDashboardUnpairSourceId(value: string): value is DashboardUnpairSource {
  return value === 'telegram.messages' || value === 'whatsapp.personal.messages';
}

function dashboardProvidersForSource(source: DashboardOAuthSource | DashboardApiKeySource | V04PublicSourceId): string[] {
  if (source === 'google') return ['gmail', 'google_drive'];
  if (source === 'gmail' || source === 'gmail.email') return ['gmail'];
  if (source === 'google-drive' || source === 'google_drive.docs') return ['google_drive'];
  if (source === 'dropbox' || source === 'dropbox.files') return ['dropbox'];
  if (source === 'x' || source === 'x.bookmarks') return ['x'];
  if (source === 'telegram.messages') return ['telegram'];
  if (source === 'whatsapp.personal.messages') return ['whatsapp_personal'];
  if (source === 'readwise' || source === 'readwise.library') return ['readwise'];
  return [source];
}

function assertDashboardAccountCardinality(
  registry: ConnectedHandleRegistry,
  source: DashboardOAuthSource | DashboardApiKeySource,
): void {
  const providers = new Set(dashboardProvidersForSource(source));
  const handles = registry.handles.filter((handle) => providers.has(handle.provider));
  try {
    assertOneConnectedAccountPerProvider({ version: 1, handles });
  } catch {
    throw new EmailSourceWorkerError(
      409,
      'dashboard_account_cardinality_violation',
      'The dashboard supports one connected account per provider. Disconnect the existing account before connecting another.',
    );
  }
}

interface DashboardDisconnectPlan {
  handles: ConnectedCredentialHandle[];
  credentialKeys: string[];
  sourceIds: Set<V04PublicSourceId>;
}

function dashboardDisconnectHasRunningRead(
  status: ReturnType<SourceScheduler['status']>,
  sourceIds: ReadonlySet<V04PublicSourceId>,
): boolean {
  const selected = new Set<string>(sourceIds);
  return status.sources.some((source) =>
    (selected.has(source.source_id) || selected.has(source.corpus_id))
    && source.tasks.some((task) => task.running)
  );
}

function dashboardDisconnectPlan(
  registry: ConnectedHandleRegistry,
  sourceId: V04PublicSourceId,
): DashboardDisconnectPlan {
  const providers = new Set(dashboardProvidersForSource(sourceId));
  const initial = registry.handles.filter((handle) => providers.has(handle.provider));
  const selected = new Map(initial.map((handle) => [handle.handle, handle]));
  const credentialRefs = new Set(initial.flatMap(dashboardCredentialRefs));
  // A combined Google consent writes one refresh token behind both handles.
  // Disconnecting that selected account grant therefore closes both readers;
  // leaving the sibling handle behind would falsely render it connected.
  let expanded = true;
  while (expanded) {
    expanded = false;
    for (const handle of registry.handles) {
      if (selected.has(handle.handle)) continue;
      const refs = dashboardCredentialRefs(handle);
      if (!refs.some((ref) => credentialRefs.has(ref))) continue;
      selected.set(handle.handle, handle);
      for (const ref of refs) credentialRefs.add(ref);
      expanded = true;
    }
  }
  const handles = [...selected.values()];
  try {
    assertOneConnectedAccountPerProvider({ version: 1, handles });
  } catch {
    throw new EmailSourceWorkerError(
      409,
      'dashboard_account_cardinality_violation',
      'Disconnect refused ambiguous multi-account state. Use the CLI to resolve the exact account handles first.',
    );
  }
  const credentialKeys = [...credentialRefs]
    .map((ref) => normalizeSecretRef(ref))
    .filter((ref): ref is { kind: 'store'; key: string } => ref?.kind === 'store')
    .map((ref) => ref.key)
    .sort();
  return {
    handles,
    credentialKeys,
    sourceIds: new Set(handles.flatMap(dashboardSourceIdsForHandle)),
  };
}

function dashboardCredentialRefs(handle: ConnectedCredentialHandle): string[] {
  const legacySessionPathRef = handle.tokenSecretRefs?.length
    ? []
    : handle.provider === 'telegram'
      ? [`store:telegram.${handle.accountRole ?? 'personal'}.session_path`]
      : handle.provider === 'whatsapp_personal'
        ? [`store:whatsapp.${handle.accountRole ?? 'personal_local'}.session_path`]
        : [];
  return [
    ...(handle.tokenSecretRefs ?? []),
    ...(handle.oauth2Refresh ? [handle.oauth2Refresh.refreshTokenSecretRef] : []),
    ...legacySessionPathRef,
  ];
}

function dashboardSourceIdsForHandle(handle: ConnectedCredentialHandle): V04PublicSourceId[] {
  if (handle.provider === 'gmail') return ['gmail.email'];
  if (handle.provider === 'google_drive') return ['google_drive.docs'];
  if (handle.provider === 'dropbox') return ['dropbox.files'];
  if (handle.provider === 'x') return ['x.bookmarks'];
  if (handle.provider === 'telegram') return ['telegram.messages'];
  if (handle.provider === 'whatsapp_personal') return ['whatsapp.personal.messages'];
  if (handle.provider === 'readwise') return ['readwise.library'];
  return [];
}

function dashboardOAuthSourcesForDisconnected(sourceIds: Set<V04PublicSourceId>): DashboardOAuthSource[] {
  const output: DashboardOAuthSource[] = [];
  if (sourceIds.has('gmail.email')) output.push('gmail', 'google');
  if (sourceIds.has('google_drive.docs')) output.push('google-drive', 'google');
  if (sourceIds.has('dropbox.files')) output.push('dropbox');
  if (sourceIds.has('x.bookmarks')) output.push('x');
  return [...new Set(output)];
}

function assertDashboardSourceMayRead(
  source: DashboardConnectSource,
  sourceDashboard: NonNullable<EmailSourceWorkerOptions['sourceDashboard']>,
  disconnected: Set<V04PublicSourceId>,
): void {
  const sourceId = dashboardPublicSourceIdForConnectSource(source);
  if (!sourceId) return;
  const registryPath = sourceDashboard.registryPath ?? defaultHandleRegistryPath();
  if (disconnected.has(sourceId)) {
    // The latch is only this process's memory of a Disconnect, and the
    // documented headless reconnect — `olympus connect gmail` — runs in
    // another process with no channel into this one. The registry is the
    // state both surfaces actually write, so a latch it contradicts is stale,
    // not authoritative: the same page already renders the card connected off
    // that registry and the scheduler has already re-adopted the source, which
    // left Sync now as the one control still refusing until a restart —
    // contradicting Disconnect's own `restart_required: false`.
    if (!dashboardSourceHasConnectedHandle(sourceId, registryPath)) {
      throw new EmailSourceWorkerError(409, 'source_disconnected', 'Reconnect this source before starting a manual read.');
    }
    disconnected.delete(sourceId);
  }
  if (sourceDashboard.enforceConnectedSourceReads !== true) return;
  if (!dashboardSourceHasConnectedHandle(sourceId, registryPath)) {
    throw new EmailSourceWorkerError(409, 'source_disconnected', 'Reconnect this source before starting a manual read.');
  }
}

/**
 * Whether the durable registry still holds a usable grant for this source.
 *
 * Read tolerantly: a registry that cannot be parsed proves no reconnect, so
 * the honest answer is the same "reconnect this source" refusal the caller
 * already gives — never a 500 out of a manual read.
 */
/**
 * A cheap fingerprint of the handle registry: modification time and size.
 *
 * Enough to notice that another process rewrote it, which is all the scheduler
 * refresh needs. An absent registry is its own stamp, so removing the file is a
 * change like any other.
 */
function dashboardRegistryStamp(registryPath: string): string {
  try {
    const stat = statSync(registryPath);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'absent';
  }
}

function dashboardSourceHasConnectedHandle(sourceId: V04PublicSourceId, registryPath: string): boolean {
  const providers = new Set(dashboardProvidersForSource(sourceId));
  return readDashboardRegistry(registryPath).handles.some((handle) =>
    providers.has(handle.provider) && handle.backendState?.status !== 'reauth_required');
}

function dashboardPublicSourceIdForConnectSource(source: DashboardConnectSource): V04PublicSourceId | undefined {
  if (source === 'gmail') return 'gmail.email';
  if (source === 'google-drive') return 'google_drive.docs';
  if (source === 'dropbox') return 'dropbox.files';
  if (source === 'x') return 'x.bookmarks';
  if (source === 'readwise') return 'readwise.library';
  return undefined;
}

function markDashboardSourceConnected(
  source: DashboardOAuthSource | DashboardApiKeySource,
  disconnected: Set<V04PublicSourceId>,
): void {
  if (source === 'google' || source === 'gmail') disconnected.delete('gmail.email');
  if (source === 'google' || source === 'google-drive') disconnected.delete('google_drive.docs');
  if (source === 'dropbox') disconnected.delete('dropbox.files');
  if (source === 'x') disconnected.delete('x.bookmarks');
  if (source === 'readwise') disconnected.delete('readwise.library');
}

function isDashboardSyncSource(source: DashboardConnectSource | string): source is DashboardConnectSource {
  return source === 'gmail' || source === 'google-drive' || source === 'dropbox' || source === 'x' || source === 'readwise';
}

function dashboardSchedulerSourceId(source: DashboardConnectSource): string | undefined {
  if (source === 'gmail') return 'gmail.email';
  if (source === 'google-drive') return 'google_drive.docs';
  if (source === 'dropbox') return 'dropbox.files';
  if (source === 'readwise') return 'readwise.library';
  if (source === 'x') return 'x.bookmarks';
  return undefined;
}

interface DashboardOAuthAttempt {
  source: DashboardOAuthSource;
  pending: Awaited<ReturnType<typeof startExternalOAuthSourceConnection>>;
  returnTo: string;
  startedAt: string;
  expiresAt: string;
  /**
   * The provider's refusal, if its callback carried `error=`.
   *
   * Recorded rather than discarded so the dashboard can say what was refused.
   * Deleting the attempt here left the card with nothing to show and the flow
   * looking merely unfinished; keeping it costs nothing, because the record
   * still expires on exactly the same clock.
   */
  error?: { code: string; at: string };
}

function dashboardPendingConnects(attempts: Map<DashboardOAuthSource, DashboardOAuthAttempt>): DashboardPendingConnect[] {
  return [...attempts.values()].map((attempt) => ({
    source: attempt.source,
    started_at: attempt.startedAt,
    expires_at: attempt.expiresAt,
    ...(attempt.error ? { error: { code: attempt.error.code, at: attempt.error.at } } : {}),
  }));
}

function pruneDashboardOAuthAttempts(attempts: Map<DashboardOAuthSource, DashboardOAuthAttempt>, now: Date): void {
  for (const [source, attempt] of attempts) {
    if (dashboardOAuthAttemptExpired(attempt, now)) attempts.delete(source);
  }
}

/**
 * Clears one source's attempt only if the map still holds the attempt the caller
 * captured. The callback handler awaits the provider token exchange between the
 * lookup and the delete, and a Connect pressed inside that window replaces the
 * entry; deleting by key alone erased that newer attempt and answered its valid
 * callback with the expired page.
 */
function clearDashboardOAuthAttempt(
  attempts: Map<DashboardOAuthSource, DashboardOAuthAttempt>,
  source: DashboardOAuthSource,
  attempt: DashboardOAuthAttempt,
): void {
  if (attempts.get(source) === attempt) attempts.delete(source);
}

/**
 * Whether a callback's `state` is the one this attempt generated.
 *
 * Compared over SHA-256 digests with `timingSafeEqual`: fixed-width inputs, so
 * neither the value nor its length leaks through the comparison, and a wrong
 * guess costs the same time as a right one.
 */
function dashboardOAuthStateMatches(attempt: DashboardOAuthAttempt, state: string): boolean {
  const expected = attempt.pending.state;
  if (typeof expected !== 'string' || expected.length === 0) return false;
  return timingSafeEqual(
    createHash('sha256').update(expected).digest(),
    createHash('sha256').update(state).digest(),
  );
}

function dashboardOAuthAttemptExpired(attempt: DashboardOAuthAttempt, now: Date): boolean {
  const expiresAt = Date.parse(attempt.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now.getTime();
}

/**
 * The link the callback tab offers back to the dashboard: one fixed relative
 * path, computed from nothing.
 *
 * It takes no argument because there is no input it could safely use. The
 * submitted `return_to` was the calling page's own `window.location.href`,
 * which on a read-only view carries the `dash_` token — a live credential
 * written into unauthenticated HTML that a provider redirect lands on, into
 * that tab's history, and into anything that saw the URL. And the REQUEST
 * ORIGIN is no safer to echo: it is attacker-controlled input (a Host header),
 * and interpolating it into a page is how a header becomes markup or a link to
 * somewhere else. A relative path needs neither, resolves against whatever
 * origin the reader is actually on, and cannot be poisoned by either one.
 *
 * The result is only ever rendered as an href; no caller redirects to it.
 */
function dashboardReturnTo(): string {
  return '/dashboard';
}

function dashboardSecretStore(sourceDashboard: NonNullable<EmailSourceWorkerOptions['sourceDashboard']>): SecretStore {
  return sourceDashboard.secretStore ?? createDefaultSecretStore();
}

/**
 * The owner's exclusion gates, read for one dashboard render.
 *
 * Same runtime the picker opens, and closed again immediately: the purge-debt
 * counts are read here, while its stores are open, and nothing else in the
 * ledger snapshot needs a handle. A worker with no picker configured reports
 * an empty list, which the ledger renders as an all-zero section rather than
 * an absent one.
 */
async function dashboardExclusionSources(
  sourceDashboard: NonNullable<EmailSourceWorkerOptions['sourceDashboard']>,
  cache: DashboardExclusionDebtCache,
): Promise<SourceIngestionLedgerExclusionSource[]> {
  if (!sourceDashboard.ingestionDispositions) return [];
  const runtime = await sourceDashboard.ingestionDispositions();
  // One reading for the whole render, so two sources counted in the same page
  // can never straddle the reuse window's edge.
  const nowMs = Date.now();
  try {
    return runtime.sources.map((source) => ({
      matcher: source.matcher,
      // Attribution for the per-source split. `corpus_ids` is the join key a
      // reader can use; `source_id` is carried for display only, because the
      // picker's source ids are not the dashboard's card ids.
      sourceId: source.source_id,
      corpusIds: [...source.corpus_ids],
      ...resolveDashboardExclusionDebt(cache, source, nowMs),
    }));
  } finally {
    runtime.close?.();
  }
}

/**
 * How stale a source's stored-exclusion debt may be before the dashboard counts
 * it again.
 *
 * Both counts are a full walk of every locator in the source's stores, put
 * through the owner's gate one row at a time — measured at 270ms per source on
 * a 262k-item store, and the page re-renders on every load and re-polls itself
 * every few seconds. They are debt figures: they move when a purge or a strip
 * runs, or as new items land, never at page-load pace. Same allowance the
 * readiness ladder takes, for the same reason.
 *
 * Deliberately a plain reuse window with no background revalidation, unlike the
 * readiness ladder's. The ladder was seconds of work, so a caller landing on an
 * expired copy was a visible stall worth engineering around; this is a quarter
 * of a second on a poll the reader never watches, and paying it inline once a
 * window keeps the counts on one code path that a test can actually reach.
 */
export const DASHBOARD_EXCLUSION_DEBT_MAX_AGE_MS = 120_000;

/**
 * Both halves are independently optional, because a source may expose one
 * accessor and not the other, and the ledger's two counts are separate answers.
 */
interface DashboardExclusionDebt {
  present?: { items: number; unevaluable: number };
  metadataOnlyContentPresent?: { items: number; unevaluable: number };
}

interface DashboardExclusionDebtCacheEntry {
  debt: DashboardExclusionDebt;
  computed_at_ms: number;
}

type DashboardExclusionDebtCache = Map<string, DashboardExclusionDebtCacheEntry>;

/**
 * Keyed by the source AND by the gate it was counted under.
 *
 * The rules are editable from this very page, and a count taken under the old
 * rules answers a different question than the same count under the new ones. So
 * an edit changes the key and the next render counts again rather than showing
 * the owner a number their change should already have moved.
 */
function dashboardExclusionDebtCacheKey(source: SourceDispositionsSource): string {
  return JSON.stringify([source.source_id, [...source.corpus_ids].sort(), source.matcher.criteria]);
}

function readDashboardExclusionDebt(source: SourceDispositionsSource): DashboardExclusionDebt | undefined {
  if (!source.excludedItemsPresent && !source.metadataOnlyContentPresent) return undefined;
  return {
    ...(source.excludedItemsPresent ? { present: source.excludedItemsPresent() } : {}),
    ...(source.metadataOnlyContentPresent
      ? { metadataOnlyContentPresent: source.metadataOnlyContentPresent() }
      : {}),
  };
}

function resolveDashboardExclusionDebt(
  cache: DashboardExclusionDebtCache,
  source: SourceDispositionsSource,
  nowMs: number,
): DashboardExclusionDebt {
  // No store mounted for this source: the rules are still reported, and the
  // counts are absent rather than zero, exactly as before.
  if (!source.excludedItemsPresent && !source.metadataOnlyContentPresent) return {};
  const key = dashboardExclusionDebtCacheKey(source);
  const cached = cache.get(key);
  const ageMs = cached ? nowMs - cached.computed_at_ms : undefined;
  // A negative age means the clock moved, not that the count is fresh.
  if (cached && ageMs !== undefined && ageMs >= 0 && ageMs <= DASHBOARD_EXCLUSION_DEBT_MAX_AGE_MS) {
    return cached.debt;
  }
  const debt = readDashboardExclusionDebt(source);
  if (!debt) return {};
  cache.set(key, { debt, computed_at_ms: nowMs });
  return debt;
}

function readDashboardRegistry(registryPath: string | undefined): ConnectedHandleRegistry {
  return readDashboardRegistryOutcome(registryPath).registry;
}

/**
 * The handle registry as the read-only dashboard paths must take it: an answer
 * plus whether that answer is knowledge or a stand-in.
 *
 * The reader throws on the whole file — a truncated write, a hand-edit, an
 * unsupported `version` — and this page is the one surface that could tell the
 * owner a source needs reconnecting or that the registry needs repair. Letting
 * that throw out took the entire dashboard to a 500 over one bad file. The
 * empty stand-in keeps the page up; `unreadable` is what stops the page from
 * then reporting every source as plainly not connected, which would be a
 * different untruth.
 */
function readDashboardRegistryOutcome(
  registryPath: string | undefined,
): { registry: ConnectedHandleRegistry; unreadable: boolean } {
  try {
    return {
      registry: readConnectedHandleRegistry(registryPath ?? defaultHandleRegistryPath()),
      unreadable: false,
    };
  } catch {
    return { registry: { version: 1, handles: [] }, unreadable: true };
  }
}

function dashboardGoogleCloudProjectId(): string | undefined {
  try {
    const raw = readFileSync(join(homedir(), '.olympus', 'google-bootstrap.json'), 'utf8');
    const parsed = JSON.parse(raw) as { projectId?: unknown };
    if (typeof parsed.projectId !== 'string') return undefined;
    const projectId = parsed.projectId.trim();
    return /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) ? projectId : undefined;
  } catch {
    return undefined;
  }
}

async function dashboardOAuthClientIds(
  registry: ConnectedHandleRegistry,
  secretStore: SecretStore,
): Promise<Partial<Record<DashboardOAuthSource | 'google', string>>> {
  const output: Partial<Record<DashboardOAuthSource | 'google', string>> = {};
  await readConfiguredDashboardOAuthClientIds(output, secretStore);
  for (const handle of registry.handles) {
    const ref = handle.oauth2Refresh?.clientIdSecretRef;
    if (!ref) continue;
    const parsed = normalizeSecretRef(ref);
    if (parsed?.kind !== 'store') continue;
    const clientId = await secretStore.get(parsed.key);
    if (!clientId) continue;
    if (handle.provider === 'gmail') output.gmail = clientId;
    if (handle.provider === 'google_drive') output['google-drive'] = clientId;
    if (handle.provider === 'dropbox') output.dropbox = clientId;
    if (handle.provider === 'x') output.x = clientId;
    if (ref.startsWith('store:google.')) output.google = clientId;
  }
  return output;
}

async function readConfiguredDashboardOAuthClientIds(
  output: Partial<Record<DashboardOAuthSource | 'google', string>>,
  secretStore: SecretStore,
): Promise<void> {
  const sources: Array<DashboardOAuthSource | 'google'> = ['google', 'gmail', 'google-drive', 'dropbox', 'x'];
  for (const source of sources) {
    const clientId = await secretStore.get(dashboardOAuthClientIdConfigKey(source));
    if (clientId) output[source] = clientId;
  }
  const pilotClientId = process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_ID?.trim();
  const packagedClientId = packagedGooglePilotClientId();
  if (!output.google && pilotClientId) output.google = pilotClientId;
  if (!output.google && packagedClientId) output.google = packagedClientId;
}

async function dashboardOAuthClientSecretAvailability(
  secretStore: SecretStore,
): Promise<Partial<Record<DashboardOAuthSource | 'google', boolean>>> {
  const output: Partial<Record<DashboardOAuthSource | 'google', boolean>> = {};
  const sources: Array<DashboardOAuthSource | 'google'> = ['google', 'gmail', 'google-drive', 'x'];
  for (const source of sources) {
    output[source] = Boolean(await secretStore.get(dashboardOAuthClientSecretConfigKey(source)));
  }
  if (process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_SECRET?.trim()) output.google = true;
  return output;
}

async function dashboardOAuthClientSecret(
  source: DashboardOAuthSource,
  secretStore: SecretStore,
  fallback: string | undefined,
  clientId: string,
): Promise<string | undefined> {
  // Google's packaged pilot client is a public client and needs no secret, so
  // starting a Google flow no longer REQUIRES one. That is not the same as
  // having none: an install that connected under the earlier bring-your-own-
  // client instructions registered its own confidential client and has that
  // client's secret in the store, and Google's token endpoint expects the pair
  // it issued. Discarding the stored secret failed the exchange after the
  // owner had already burned a consent round — and the dashboard no longer
  // collects a secret, so there was no way back.
  if (dashboardGoogleOAuthSource(source)) {
    return await dashboardGoogleOAuthClientSecret(source, secretStore, fallback, clientId);
  }
  if (!dashboardOAuthClientSecretRequired(source)) return undefined;
  // X's secret is its own credential — the Google chain above must never
  // answer for it. The old Google-only gate returned undefined here for X
  // before even reading the fallback, silently discarding the very secret the
  // owner supplied; the exchange then went out without an Authorization header
  // and X refused it with 401 unauthorized_client (live, 2026-08-19).
  return fallback ?? await secretStore.get(dashboardOAuthClientSecretConfigKey(source));
}

/**
 * The Google client secret that belongs to the client id this flow is going
 * out with — and only that one.
 *
 * A secret is half of a pair, so an unpaired one is worse than none: sending a
 * leftover secret alongside the packaged pilot client, or alongside a client
 * the owner re-registered since, earns a flat `invalid_client` from Google.
 * Every store namespace keeps a registration's id and secret under matching
 * keys, so requiring the stored id to equal the id in use is what proves the
 * two halves came from the same registration.
 */
async function dashboardGoogleOAuthClientSecret(
  source: DashboardOAuthSource,
  secretStore: SecretStore,
  fallback: string | undefined,
  clientId: string,
): Promise<string | undefined> {
  if (fallback) return fallback;
  if (clientId === dashboardGooglePilotClientId()) {
    // The pilot client's own secret, for an operator who packaged a
    // confidential client. Absent is the ordinary case and is not an error:
    // an installed-app client exchanges on client id plus PKCE.
    return process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_SECRET?.trim();
  }
  const namespaces = new Set<DashboardOAuthSource | 'google'>([source, 'google', 'gmail', 'google-drive']);
  for (const namespace of namespaces) {
    const storedClientId = await secretStore.get(dashboardOAuthClientIdConfigKey(namespace));
    if (storedClientId !== clientId) continue;
    const secret = await secretStore.get(dashboardOAuthClientSecretConfigKey(namespace));
    if (secret) return secret;
  }
  return undefined;
}

function dashboardGooglePilotClientId(): string | undefined {
  return process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_ID?.trim() || packagedGooglePilotClientId();
}

function dashboardGooglePilotClientConfigured(): boolean {
  return dashboardGooglePilotClientId() !== undefined;
}

function dashboardOAuthClientIdConfigKey(source: DashboardOAuthSource | 'google'): string {
  return `${source}.personal.oauth.client_id`;
}

function dashboardOAuthClientSecretConfigKey(source: DashboardOAuthSource | 'google'): string {
  return `${source}.personal.oauth.client_secret`;
}

function dashboardGoogleOAuthSource(source: DashboardOAuthSource | 'google'): boolean {
  return source === 'google' || source === 'gmail' || source === 'google-drive';
}

// X is here because its app is a confidential client: the token exchange must
// authenticate with HTTP Basic (proven against the live endpoint 2026-08-19 —
// client_id in the body alone earns 401 "Missing valid authorization header").
// Starting an X flow without the secret would mint an authorize URL whose
// exchange is doomed, burning the owner's consent round; refusing at start is
// the honest failure.
function dashboardOAuthClientSecretRequired(source: DashboardOAuthSource | 'google'): boolean {
  return source === 'x';
}

/**
 * The origin a provider must call back on.
 *
 * A loopback request still derives `http://127.0.0.1`: that is the desktop-app
 * form every provider accepts on localhost, and it is the working local path.
 *
 * Everything else honors the proxy's declared scheme before the scheme this
 * process happened to be spoken to in. Behind `tailscale serve` the TLS
 * terminates at the proxy and the worker is reached over plain HTTP, so the
 * redirect came out as `http://<private-host>.<tailnet>.ts.net/oauth/callback/x` — a
 * non-loopback http callback, which X refuses outright, and the connect flow
 * died on the provider's error page (live, 2026-08-19).
 *
 * Only the SCHEME is taken from the headers, and only the two values a scheme
 * may be. The host stays the one the request carried, so a forged header can
 * never point a callback at another origin.
 */
function dashboardOAuthRedirectOrigin(url: URL, headers?: Headers): string {
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]')) {
    return `http://127.0.0.1${url.port ? `:${url.port}` : ''}`;
  }
  const forwardedProtocol = dashboardForwardedProto(headers);
  if (forwardedProtocol && `${forwardedProtocol}:` !== url.protocol) {
    const forwarded = new URL(url.toString());
    forwarded.protocol = `${forwardedProtocol}:`;
    return forwarded.origin;
  }
  return url.origin;
}

/**
 * The scheme a reverse proxy says the client used: `X-Forwarded-Proto` first —
 * the header tailscale serve, nginx and Caddy all set — then RFC 7239
 * `Forwarded: ...;proto=https`. Both may carry a chain, and the client-facing
 * hop is the first entry.
 */
function dashboardForwardedProto(headers: Headers | undefined): 'http' | 'https' | undefined {
  if (!headers) return undefined;
  const forwardedProto = dashboardScheme(headers.get('x-forwarded-proto')?.split(',')[0]);
  if (forwardedProto) return forwardedProto;
  const forwarded = headers.get('forwarded');
  if (!forwarded) return undefined;
  const firstHop = forwarded.split(',')[0] ?? '';
  return dashboardScheme(/(?:^|[;\s])proto\s*=\s*"?([A-Za-z]+)"?/.exec(firstHop)?.[1]);
}

/** Anything that is not one of the two schemes is no answer at all. */
function dashboardScheme(value: string | undefined): 'http' | 'https' | undefined {
  const scheme = value?.trim().toLowerCase();
  return scheme === 'http' || scheme === 'https' ? scheme : undefined;
}

function dashboardOAuthClientIdForSource(
  source: DashboardOAuthSource,
  clientIds: Partial<Record<DashboardOAuthSource | 'google', string>>,
): string | undefined {
  // The shared-app fallback chain is a Google-family affair; X requires a
  // secret too but its client id never comes from a Google registration.
  if (!dashboardGoogleOAuthSource(source)) return clientIds[source];
  return clientIds[source]
    ?? clientIds.google
    ?? clientIds.gmail
    ?? clientIds['google-drive'];
}

async function dashboardApiKeyAvailability(secretStore: SecretStore): Promise<Partial<Record<DashboardApiKeySource, boolean>>> {
  const readwiseToken = await secretStore.get('readwise.personal.token')
    ?? (PUBLIC_RUNTIME_BUILD ? undefined : await secretStore.get('readwise.castor_runtime.token'));
  return {
    venice: Boolean(await secretStore.get('venice.api_key')),
    readwise: Boolean(readwiseToken),
  };
}

/**
 * What the failure page may say about a callback error.
 *
 * The one variable message repeated verbatim is the exchange failure, whose
 * vocabulary connect.ts already bounds to an HTTP status plus an allowlisted
 * OAuth code. Anything else — connector text, cleanup errors, whatever an
 * injected completer throws — collapses to a fixed sentence: rendering
 * arbitrary Error text on a page is how credential material escapes, and no
 * redaction list is a complete guarantee (R61 through R61E). The earlier
 * value-based redaction layer is deleted with its last caller: a page that
 * only ever speaks bounded text has nothing to redact.
 */
function dashboardCallbackFailureReason(error: unknown, source: DashboardOAuthSource): string {
  const message = error instanceof Error ? error.message : '';
  const match = /^OAuth token exchange failed with status (\d{3})(?: \(([a-z_]+)\))?\.$/.exec(message);
  // The code inside the shape is re-checked against the allowlist: the shape
  // alone would admit arbitrary lowercase content from a crafted message.
  if (match && (match[2] === undefined || safeOAuthErrorCode(match[2]) !== undefined)) return message;
  return `Connecting ${source} failed partway through. Start connect again from the dashboard.`;
}

/**
 * The expiry the dashboard shows for a pending consent. The starter's own
 * expiry is honored only when it parses and sits inside (now, now+30min]; an
 * injectable starter's arbitrary string is otherwise replaced with the
 * authorize flow's honest ~10-minute default.
 */
function dashboardBoundedExpiry(claimed: string | undefined, now: Date): string {
  const ceiling = now.getTime() + 30 * 60_000;
  const parsed = claimed ? Date.parse(claimed) : Number.NaN;
  if (Number.isFinite(parsed) && parsed > now.getTime() && parsed <= ceiling) return new Date(parsed).toISOString();
  return new Date(now.getTime() + 10 * 60_000).toISOString();
}

function dashboardOAuthFailureHtml(options: {
  source: DashboardOAuthSource;
  reason: string;
  returnTo: string;
  status: number;
}): Response {
  return dashboardOAuthLandingHtml({
    title: 'Olympus connect failed',
    heading: `Could not connect ${options.source}`,
    paragraphs: [
      `Could not connect ${options.source}: ${options.reason}`,
      'You can close this tab and return to the Olympus dashboard.',
    ],
    returnTo: options.returnTo,
    status: options.status,
  });
}

/**
 * What the authorization tab says once the callback has been exchanged.
 *
 * This page is reached in the tab `window.open` created, not in the dashboard,
 * so it tells the reader the one thing that is true of that tab: it is finished
 * and can be closed. The link back is kept for the reader who opened the flow
 * in this tab anyway (an old bookmark, a copied authorization URL).
 */
function dashboardOAuthCompleteHtml(options: {
  source: DashboardOAuthSource;
  returnTo: string;
}): Response {
  return dashboardOAuthLandingHtml({
    title: 'Olympus connected',
    heading: `Connected ${options.source}`,
    // The more specific of the two sentences: it also says what happens next.
    paragraphs: ['You can close this tab and go back to the Olympus dashboard. It picks the new connection up on its own.'],
    returnTo: options.returnTo,
    status: 200,
  });
}

/**
 * The shared shell for both callback pages.
 *
 * The close-this-tab sentence belongs to the CALLER, not to this template. It
 * used to be hardcoded here on top of whatever the caller said, so the success
 * page printed two near-identical sentences in a row — "You can close this tab
 * and go back to the Olympus dashboard" followed by "You can close this tab and
 * return to the Olympus dashboard". Each page now says it once, in its own
 * words.
 */
function dashboardOAuthLandingHtml(options: {
  title: string;
  heading: string;
  paragraphs: readonly string[];
  returnTo: string;
  status: number;
}): Response {
  const paragraphs = options.paragraphs
    .map((paragraph) => `      <p>${escapeHtml(paragraph)}</p>`)
    .join('\n');
  return html(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(options.title)}</title>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(options.heading)}</h1>
${paragraphs}
      <p><a href="${escapeHtml(options.returnTo)}">Return to dashboard</a></p>
    </main>
  </body>
</html>`, options.status);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}


function asOptionalNumber(value: unknown, name = 'numeric field'): number | undefined {
  if (value === undefined || value === null) return undefined;
  const number = typeof value === 'number' ? value : Number(value);
  if (Number.isFinite(number)) return number;
  throw new EmailSourceWorkerError(400, 'invalid_request', `${name} must be numeric when provided.`);
}


function asOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  throw new EmailSourceWorkerError(400, 'invalid_request', 'boolean fields must be true or false when provided.');
}

function asOptionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `${name} must be an array of strings.`);
  }
  return value
    .map((item, index) => {
      if (typeof item !== 'string') {
        throw new EmailSourceWorkerError(400, 'invalid_request', `${name}.${index} must be a string.`);
      }
      return item.trim();
    })
    .filter(Boolean);
}

function asOptionalSourceAnswerSelectedItems(value: unknown): SourceAnswerSelectedItem[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'selected_items must be an array.');
  }
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new EmailSourceWorkerError(400, 'invalid_request', `selected_items.${index} must be an object.`);
    }
    const initialRecord = item as Record<string, unknown>;
    const forbiddenPath = selectedItemContentFieldPath(initialRecord);
    if (forbiddenPath) {
      throw new EmailSourceWorkerError(400, 'invalid_request', `selected_items.${index} must not include source content field ${forbiddenPath}.`);
    }
    const selectedItem = initialRecord.selected_item;
    const record = selectedItem && typeof selectedItem === 'object' && !Array.isArray(selectedItem)
      ? selectedItem as Record<string, unknown>
      : initialRecord;
    return {
      corpus_id: requiredSelectedItemString(record.corpus_id, `selected_items.${index}.corpus_id`),
      family: requiredSelectedItemString(record.family, `selected_items.${index}.family`),
      provider: requiredSelectedItemString(record.provider, `selected_items.${index}.provider`),
      account_scope: requiredSelectedItemString(record.account_scope, `selected_items.${index}.account_scope`),
      provider_item_id: requiredSelectedItemString(record.provider_item_id, `selected_items.${index}.provider_item_id`),
      local_item_id: requiredSelectedItemString(record.local_item_id, `selected_items.${index}.local_item_id`),
      ...optionalSelectedItemString(record.provider_thread_id, 'provider_thread_id'),
      ...optionalSelectedItemString(record.provider_conversation_id, 'provider_conversation_id'),
      ...optionalSelectedItemString(record.provider_file_id, 'provider_file_id'),
      ...optionalSelectedItemString(record.source_version, 'source_version'),
      ...optionalSelectedItemString(record.conversation_label, 'conversation_label'),
      ...optionalSelectedItemString(record.author_label, 'author_label'),
      ...optionalSelectedItemString(record.authored_at, 'authored_at'),
    };
  });
}

function addSelectedItemToSearchHit<T extends { sourceItem: {
  family: string;
  provider: string;
  accountScope: string;
  providerItemId: string;
  localItemId: string;
  providerThreadId?: string;
  providerConversationId?: string;
  providerFileId?: string;
  sourceVersion?: string;
}; provenance?: { citation?: {
  title?: string;
  conversationLabel?: string;
  authorLabel?: string;
  uri?: string;
  authoredAt?: string;
  updatedAt?: string;
} } }>(corpusId: string, hit: T): T & { selected_item: SourceAnswerSelectedItem } {
  const citation = hit.provenance?.citation;
  return {
    ...hit,
    selected_item: {
      corpus_id: corpusId,
      family: hit.sourceItem.family,
      provider: hit.sourceItem.provider,
      account_scope: hit.sourceItem.accountScope,
      provider_item_id: hit.sourceItem.providerItemId,
      local_item_id: hit.sourceItem.localItemId,
      ...(hit.sourceItem.providerThreadId ? { provider_thread_id: hit.sourceItem.providerThreadId } : {}),
      ...(hit.sourceItem.providerConversationId ? { provider_conversation_id: hit.sourceItem.providerConversationId } : {}),
      ...(hit.sourceItem.providerFileId ? { provider_file_id: hit.sourceItem.providerFileId } : {}),
      ...(hit.sourceItem.sourceVersion ? { source_version: hit.sourceItem.sourceVersion } : {}),
      ...(citation?.title ? { title: citation.title } : {}),
      ...(citation?.conversationLabel ? { conversation_label: citation.conversationLabel } : {}),
      ...(citation?.authorLabel ? { author_label: citation.authorLabel } : {}),
      ...(citation?.uri ? { uri: citation.uri } : {}),
      ...(citation?.authoredAt ? { authored_at: citation.authoredAt } : {}),
      ...(citation?.updatedAt ? { updated_at: citation.updatedAt } : {}),
    },
  };
}

function requiredSelectedItemString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 500) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `${name} must be a non-empty safe identifier string.`);
  }
  return value.trim();
}

function optionalSelectedItemString(value: unknown, key: keyof SourceAnswerSelectedItem): Partial<SourceAnswerSelectedItem> {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value !== 'string' || value.length > 1_000) {
    throw new EmailSourceWorkerError(400, 'invalid_request', `selected_items.${key} must be a safe string.`);
  }
  return { [key]: value.trim() };
}

function asOptionalRetrievalMode(value: unknown): 'keyword' | 'hybrid' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'keyword' || value === 'hybrid') return value;
  throw new EmailSourceWorkerError(400, 'invalid_request', 'retrieval_mode must be keyword or hybrid.');
}

function asOptionalSourceAnswerAnalystProvider(value: unknown): 'default' | 'local' | 'venice' | 'cloud' | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (value === 'default' || value === 'local' || value === 'venice' || value === 'cloud') return value;
  throw new EmailSourceWorkerError(400, 'invalid_request', 'analyst_provider must be default, local, venice, or cloud.');
}

function asOptionalAnalystModel(
  value: unknown,
  analystProvider?: 'default' | 'local' | 'venice' | 'cloud',
): string | undefined {
  const model = asOptionalString(value)?.trim();
  if (model === undefined) return undefined;
  const normalized = analystProvider === 'venice' || analystProvider === undefined
    ? normalizeVeniceAnalystModelId(model)
    : model;
  if (normalized.length > 160 || !/^[A-Za-z0-9._:/@+-]+$/.test(normalized)) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'analyst_model must be a provider model id using safe identifier characters.');
  }
  return normalized;
}




function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function isDeepHealthRequest(url: URL): boolean {
  const value = (url.searchParams.get('deep') ?? url.searchParams.get('dependencies') ?? '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes';
}

function cheapWorkerHealth(
  connector: EmailSourceConnector,
  degradedCredentials: WorkerCredentialDegradation[] = [],
): EmailSourceHealth {
  const configured = !(connector instanceof GogcliEmailConnectorStub);
  return {
    reachable: true,
    configured,
    connector: connector.name,
    status: degradedCredentials.length > 0 ? 'degraded' : 'ok',
    ...(degradedCredentials.length > 0 ? { degraded_credentials: degradedCredentials } : {}),
    raw_email_exposed: false,
    dependency_check: 'not_run',
    detail: configured
      ? 'Worker process is alive; connector dependency health was not checked on this cheap liveness path.'
      : 'gogcli is not wired yet. Configure the Gateway-side connector before enabling email answers.',
  };
}

function withCredentialDegradations<T extends { degraded_credentials?: WorkerCredentialDegradation[] }>(
  result: T,
  degradedCredentials: WorkerCredentialDegradation[],
): T {
  if (degradedCredentials.length === 0) return result;
  const withCredentials = {
    ...result,
    degraded_credentials: [
      ...(result.degraded_credentials ?? []),
      ...degradedCredentials,
    ],
  };
  const embeddingLane = embeddingLaneDisabledState(withCredentials.degraded_credentials);
  const withStatus = ('status' in result || 'reachable' in result) && embeddingLane
    ? { ...withCredentials, status: 'degraded' }
    : withCredentials;
  if (!embeddingLane || !isSourceIndexStatusResult(withStatus)) return withStatus as T;
  return {
    ...withStatus,
    embedding_lane: embeddingLane,
    corpora: withStatus.corpora.map((corpus) => ({
      ...corpus,
      ...(corpusEmbeddingCanUseDegradedCredentials(corpus.embedding_policy) ? { embedding_lane: embeddingLane } : {}),
    })),
  } as T;
}

function embeddingLaneDisabledState(
  degradedCredentials: readonly WorkerCredentialDegradation[],
): SourceIndexEmbeddingLaneState | undefined {
  const embeddingCredentials = degradedCredentials.filter((credential) =>
    credential.affected_capabilities?.includes('embedding')
    && (
      credential.state === 'retrying'
      || credential.state === 'stopped'
      || credential.state === 'resolved_restart_required'
    )
  );
  if (embeddingCredentials.length === 0) return undefined;
  const affectedProfiles = uniqueStrings(embeddingCredentials.flatMap((credential) => credential.affected_profiles ?? []));
  const affectedCapabilities = uniqueStrings(embeddingCredentials.flatMap((credential) => credential.affected_capabilities ?? []));
  return {
    state: 'embedding_lane_disabled',
    reason: 'embedding_provider_unavailable',
    affected_credentials: uniqueStrings(embeddingCredentials.map((credential) => credential.display_name)),
    ...(affectedProfiles.length > 0 ? { affected_profiles: affectedProfiles } : {}),
    ...(affectedCapabilities.length > 0 ? { affected_capabilities: affectedCapabilities } : {}),
    hint: 'Fix the affected credential, POST /v1/source/credentials/recheck, then restart the worker if the route reports resolved_restart_required.',
  };
}

function corpusEmbeddingCanUseDegradedCredentials(embeddingPolicy: string): boolean {
  return embeddingPolicy.includes('cloud') || embeddingPolicy.includes('allowed') || embeddingPolicy.includes('embedding');
}

function isSourceIndexStatusResult(value: unknown): value is SourceIndexStatusResult {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.kind === 'source_index_status' && Array.isArray(record.corpora);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** ?embedding-ledger serves the embedding decision ledger. Same path, same auth. */
const DASHBOARD_EMBEDDING_LEDGER_QUERY_PARAM = 'embedding-ledger';

/**
 * The prefix the ledger page builds its own links from.
 *
 * A browser reaches this page with a dash_ token in the query string, because
 * an address bar cannot send an Authorization header. Its one link — back to
 * Background — has to carry that token or the first click dead-ends on a 401.
 * This mirrors withTokenBasePath in dashboard/index.ts, which does the same job
 * for the pages that route through there; undefined means no token was
 * presented, and the page falls back to a bare /dashboard prefix.
 */
function embeddingLedgerBasePath(url: URL): string | undefined {
  const token = url.searchParams.get('token');
  if (token === null || token === '') return undefined;
  return `/dashboard?token=${encodeURIComponent(token)}`;
}

function html(value: string, status = 200): Response {
  return new Response(value, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

export {
  GogcliEmailConnector,
  SpawnCommandRunner,
  type CommandRunner,
  type GogcliAuthMode,
  type GogcliEmailConnectorOptions,
} from './gogcli.ts';

export {
  GMAIL_SECURE_LOCAL_CORPUS_ID,
  INTERNAL_EMAIL_CORPUS_ID,
  defineGmailSecureLocalCorpus,
  defineInternalEmailCorpus,
  gmailEmailCorpusTrustDomainForCorpusId,
  type GmailEmailCorpusId,
} from '../google-connectors/corpora.ts';
