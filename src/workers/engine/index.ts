import { currentRemoteReadAccess } from '../remote-access-recheck.ts';
import { sourceItemReadSelectedItem, sourceItemReadPage } from '../../core/source-index/selected-items.ts';
import { itemReadOnDemand } from '../file-extraction/on-demand-read.ts';
import { assertNoSourceIndexOperationalLeakFields } from '../../core/email.ts';
import { JUDGE_CHOICES, type JudgeChoice } from '../classification/judge-spending.ts';
import { type DashboardPeopleView, DASHBOARD_PEOPLE_PATH } from '../dashboard/pages/people.ts';
import { dashboardModelsOnComputer } from '../dashboard/models-on-computer.ts';
import {
  parseGoogleDesktopClient,
  readGoogleOwnAppRegistration,
  checkGoogleOwnApp,
} from '../../core/google-own-app.ts';
import { privateAnswerMode } from '../../core/first-run-privacy.ts';
import { parseSettingsProposalInput, parseProposalFrom, SettingsProposalError } from '../../core/settings-proposal.ts';
import { PRIVACY_PRESET_LABELS } from '../../core/privacy-language.ts';
import { createDashboardMessagingService } from './dashboard/dashboard-messaging-service.ts';
import { isFileSourceScopeId } from '../../core/source-scope-approval.ts';
import { type AgentAnswerReceipt, recordAgentAnswerReceipt, agentAnswerReceipt } from '../../core/app-release-agent.ts';
import { privacyBacklogCoverageNote, withCoverageNote } from '../../core/privacy-backlog-coverage.ts';
import {
  type ReleaseManifest,
  answerReleaseWithheldReasonOffThread,
  createReleaseManifestSink,
  runWithReleaseManifestSink,
  recordReleaseManifest,
} from '../../core/release-manifest.ts';
import { installerForPlatform } from '../../core/update-check.ts';
import { runWithAnalystAbortSignal } from '../../core/analyst.ts';
import { isSecureSensitivity } from '../../core/source-index/types.ts';
import { randomBytes } from 'node:crypto';
import { FileLeaseBusyError } from '../../core/file-lease.ts';
import { basename, dirname } from 'node:path';
import { WHATSAPP_SESSION_FILE } from '../../core/olympus-layout.ts';
import { assertNoRawEmailFields } from '../../core/email-policy.ts';
import {
  type OAuthRelayStateKeys,
  parseOAuthRelayStateKeys,
  createOAuthRelayStateKeys,
  serializeOAuthRelayStateKeys,
  verifyOAuthRelayState,
  OAUTH_RELAY_STATE_TTL_MS,
  createOAuthRelayNonce,
  signOAuthRelayState,
} from '../../core/oauth-relay.ts';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  safeOAuthErrorCode,
  startExternalOAuthSourceConnection,
  oauthAuthorizeOrigin,
  connectPublicApiKeySource,
} from '../../core/connect.ts';
import { OperationError } from '../../core/operation-error.ts';
import type { OperationCallerWire } from '../../core/operation-caller.ts';
import { dropboxContentExtractionStallHours } from '../../core/ingestion-throughput.ts';
import type { SecretStore } from '../../core/secret-store.ts';
import { workerRouteAllowed } from './http/write-routes.ts';
import type { OwnerItemChoice } from '../classification/tier-owner-items.ts';
import { JudgeCheckError } from '../classification/judge-check.ts';
import { ArchiveUploadError } from '../archive-import/staging.ts';
import { NativeMessagingCaptureOwnerError } from '../../core/messaging-capture.ts';
import {
  assertUnpairedRecordWritable,
  readUnpairedSources,
  recordUnpairedSources,
  artifactPresence,
  readReconciledUnpairedSources,
  withoutUnpairedLaneHandles,
} from '../credential-broker/unpaired-sources.ts';
import { planPairingSessionRemoval, removePlannedPairingSessionFile } from '../../core/pairing-session-paths.ts';
import type { V04PublicSourceId } from '../../core/public-source-capabilities.ts';
import { TEXT_EXTRACTOR_KIND } from '../file-extraction/extractors/text.ts';
import { TRANSCRIPTION_EXTRACTOR_KIND } from '../file-extraction/extractors/transcription.ts';
import { drainPdfExtraction } from '../file-extraction/runner.ts';
import { createSourceAnswerTrace, runWithSourceAnswerTrace } from '../source-index/answer-latency-trace.ts';
import { DASHBOARD_READINESS_LEDGER_MAX_AGE_MS } from '../source-index/status.ts';
import { READWISE_LIBRARY_CORPUS_ID } from '../readwise/index.ts';
import {
  X_BOOKMARKS_CORPUS_ID,
  XBookmarksArchiveImportError,
  XBookmarksLiveSyncError,
  defaultXBookmarksLiveSyncConfig,
} from '../x-bookmarks/index.ts';
import {
  type DropboxSourceExportResult,
  DropboxSourceExportDestinationError,
  DropboxSourceExportRequestError,
  type DropboxEvalShardManifest,
  DROPBOX_FILES_CORPUS_ID,
} from '../dropbox-files/index.ts';
import { isApprovedSecureSourceEmbeddingProvider } from '../source-index/embeddings.ts';
import { SOVEREIGNTY_PRESETS, type SovereigntyPresetName } from '../../core/sovereignty.ts';
import {
  createSourceWatchPublicView,
  SOURCE_WATCH_POLICY,
  listSourceWatchPublicViews,
  sourceWatchPublicView,
} from '../source-watch-runtime.ts';
import { INTERNAL_EMAIL_CORPUS_ID, GOOGLE_DRIVE_DOCS_CORPUS_ID } from '../google-connectors/corpora.ts';
import {
  dashboardHtmlRoutePage,
  dashboardLegacyRedirect,
  dashboardOutsideHelpRedirect,
  dashboardConnectorRedirect,
  COMPUTER_HOST_PAGE_CSP,
  renderComputerHostPage,
  dashboardReadToken,
  renderDashboardLocalPage,
  DASHBOARD_TOOLS_CALL_PATH,
} from '../dashboard/index.ts';
import { dashboardResourceHtml } from '../chatgpt/dashboard-resource.ts';
import { DASHBOARD_TOOL_NAME } from '../chatgpt/dashboard-contract.ts';
import {
  DASHBOARD_UPDATE_COPY,
  dashboardManualSyncBusyLine,
  dashboardManualSyncTooSoonLine,
  dashboardManualSyncPendingLine,
} from '../dashboard/vocabulary.ts';
import {
  sourceFailureKind,
  type SourceSupportState,
  type SystemSupportFacts,
  systemSupportReport,
} from '../dashboard/source-failure.ts';
import { parseMailScopeDraft } from '../../core/mail-source-scope.ts';
import {
  DASHBOARD_UNLOCK_SHELL_CONTEXT_HEADER,
  DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER,
  DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER,
  DASHBOARD_SELF_UPDATE_PATHS,
  DASHBOARD_SELF_UPDATE_LOCAL_ONLY,
  DASHBOARD_APPS_RECEIVED_ROUTE,
  DASHBOARD_PRIVATE_ANSWERS_PATH,
  DASHBOARD_CONSULT_CONTROL_PATHS,
} from '../http.ts';
import { DASHBOARD_UNLOCK_SHELL_HTML, dashboardUnlockShellHeaders } from '../../core/dashboard-launch.ts';
import { resolveEmbeddingOverridePath, writeEmbeddingOperatorOverride } from '../dashboard/embedding-runtime.ts';
import { handleDashboardAgentRequest, dashboardAgentsView } from '../agent-connections.ts';
import {
  type DashboardOAuthSource,
  type DashboardManualSync,
  type DashboardSyncSource,
  buildSourceDashboardViewModel,
  DASHBOARD_SAVED_SECRET_FIELD_VALUE,
  DASHBOARD_SUPPORTED_SOURCES,
  DASHBOARD_MANUAL_SYNC_MIN_INTERVAL_MS,
  dashboardManualSyncOutcome,
} from '../source-dashboard.ts';
import { readCredentialHealthReport, defaultCredentialHealthReportPath } from '../credential-health.ts';
import { resolveSourceIngestionExclusionsPath, saveSourceDispositions } from '../source-dispositions.ts';
import { buildSourceIngestionLedgerSnapshot } from '../source-ingestion-ledger.ts';
import {
  defaultHandleRegistryPath,
  readConnectedHandleRegistry,
  ConnectedHandleGrantMutationError,
  ConnectedHandleAccountCardinalityError,
  withConnectedHandleGrantCustody,
  removeConnectedHandles,
  type ConnectedCredentialHandle,
} from '../credential-broker/connected-handles.ts';
import {
  credentialOAuth2StateStoreFromEnv,
  isCredentialRefreshBusyError,
  CREDENTIAL_REFRESH_BUSY_RETRY_MS,
} from '../credential-broker/index.ts';
import {
  LocalConnectorStore,
  STATUS_COUNTS_MAX_AGE_MS,
  normalizeConnectorStoreSearchFilters,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../connector-store/index.ts';
import {
  connectThisComputerSource,
  disconnectThisComputerSource,
  readThisComputerHandles,
} from '../../core/this-computer.ts';
import {
  requireSource,
  type DataDeleteWithCustodyResult,
  type LifecyclePathContext,
  deleteOlympusDataWithCustody,
  dataDeleteCustody,
} from '../../data-lifecycle.ts';
import { WORKER_CLI_ROUTE_PREFIX, type WorkerCliOperation, WORKER_CLI_OPERATIONS } from '../../core/cli-via-worker.ts';
import { carriesRelayMarker } from '../../core/remote-access.ts';
import { DASHBOARD_BACKUP_PATHS, handleDashboardBackupRoute } from '../dashboard/backup-routes.ts';
import {
  cliDataRootMismatch,
  ingestionStatusForCli,
  exportForCli,
  tierForCli,
  pairingPlacementForCli,
  pairingAccountForCli,
  settingsForCli,
} from '../cli-operations.ts';
import {
  type EmailSourceWorkerOptions,
  settingsProposalHolderFor,
  DASHBOARD_SETTINGS_PROPOSAL_APPLY_PATH,
  DASHBOARD_SETTINGS_PROPOSAL_DISCARD_PATH,
} from './http/worker-options.ts';
import { GogcliEmailConnectorStub, cheapWorkerHealth } from '../email-source/email-connector.ts';
import {
  CONNECTOR_STORE_FILTER_CAPABILITIES,
  assertSourceIndexSearchQuery,
  parseConnectorStoreIndexSearchRequestRecord,
  requireCurrentFileEmbeddingScope,
} from './http/connector-store-search-request.ts';
import {
  type DashboardOAuthAttempt,
  DASHBOARD_OAUTH_RELAY_STATE_KEY,
  createDashboardOAuthCallbackRateLimiter,
  dashboardSecretStore,
  pruneDashboardOAuthAttempts,
  dashboardPendingConnects,
  CHATGPT_RETURN_TO,
  dashboardReturnTo,
  dashboardOAuthCallbackRateLimitKey,
  dashboardOAuthAttemptExpired,
  dashboardOAuthStateMatches,
  clearDashboardOAuthAttempt,
  startDashboardEvernoteSignIn,
} from './http/dashboard-oauth-attempts.ts';
import {
  type DashboardExclusionDebtCache,
  parseSourceDispositionsSave,
  dashboardExclusionSources,
} from './http/dashboard-dispositions.ts';
import {
  normalizeBasePath,
  workerRouteNotFound,
  json,
  isDeepHealthRequest,
  withCredentialDegradations,
  withCredentialReadiness,
  EmailSourceWorkerError,
  readPendingPrivacyItems,
  html,
} from './http/worker-responses.ts';
import {
  fileExtractionAliasFor,
  requireFileExtractionRunner,
  parseFileExtractionLaneRecord,
  optionalNumberField,
  optionalStringField,
  fileExtractionRunBody,
  DEFAULT_FILE_EXTRACTION_PLAN_LIMIT,
  parseExtractionPolicyDecision,
  fileExtractionPlanBody,
  fileExtractionReclassificationBody,
} from './http/file-extraction.ts';
import {
  parseConsultAskRequest,
  parseSourceIndexAnswerRequest,
  parseSourceIndexStatusRequest,
  addSelectedItemToSearchHit,
  mostPrivateTrustDomain,
  sourceIndexSearchCorpusIds,
} from './http/source-index-requests.ts';
import {
  parseObjectBody,
  asOptionalString,
  asOptionalBoolean,
  asOptionalNumber,
  parseDashboardMessagingBody,
  canonicalRequestCorpusId,
  asOptionalStringArray,
} from './http/request-fields.ts';
import {
  callerCancellationSignal,
  retrySqliteBusy,
  emitSourceAnswerLatencyRecords,
  classifySourceAnswerTraceOutcome,
  manualSyncFailureKind,
  logSourceWorkerInternalError,
  scrubSourceWorkerLogMessage,
} from './http/source-answer-runtime.ts';
import { parseDropboxSourceExportRequest, parseDropboxEvalShardExportRequest } from './http/dropbox-export-requests.ts';
import {
  sourceWatchNotSupported,
  authenticatedWatchOwner,
  parseSourceWatchCreateRequest,
  parseSourceWatchesRequest,
  parseSourceWatchCancelRequest,
} from './http/source-watch-requests.ts';
import {
  parseFolderScopeSourceId,
  parseSourceScopeSelections,
  parseDashboardOAuthSource,
  parseDashboardApiKeySource,
  parseDashboardSyncSource,
  parseDashboardDisconnectSource,
  sourceSchedulerSourceIdForCorpus,
  type DashboardSourceSyncRequest,
  dashboardSourceSyncNotSupportedError,
} from './http/dashboard-source-requests.ts';
import {
  dashboardOAuthRedirectOrigin,
  dashboardPanelCallContext,
  dashboardPanelOpener,
  dashboardOAuthCompleteHtml,
  dashboardOAuthFailureHtml,
  dashboardCallbackFailureReason,
  dashboardBoundedExpiry,
  safeVeniceCheckFailure,
} from './http/dashboard-oauth-pages.ts';
import {
  readDashboardRegistryOutcome,
  withThisComputerHandles,
  dashboardSourceAccountBindings,
  dashboardStorageNotices,
  dashboardImportedArchives,
  dashboardLivePasses,
  markDashboardSourceConnected,
  readDashboardRegistry,
  assertDashboardAccountCardinality,
  assertDashboardSourceMayRead,
  dashboardSchedulerSourceId,
  dashboardDisconnectHasRunningRead,
  dashboardDisconnectPlan,
  dashboardOAuthSourcesForDisconnected,
  dashboardRegistryStamp,
  isDashboardSyncSource,
} from './http/dashboard-connections.ts';
import {
  dashboardOAuthClientIdSets,
  dashboardGoogleCloudProjectId,
  dashboardOAuthClientSecretAvailability,
  dashboardGooglePilotClientConfigured,
  dashboardPublisherOAuthSources,
  dashboardApiKeyAvailability,
  dashboardGoogleOAuthSource,
  dashboardPublisherOAuthFlow,
  dashboardOAuthClientIdForSource,
  dashboardOAuthClientIdConfigKey,
  dashboardOAuthClientSecret,
  dashboardOAuthClientSecretRequired,
  dashboardOAuthClientSecretConfigKey,
  dashboardOAuthClientIdSourceKey,
  dashboardGoogleLoopbackOrigin,
} from './http/dashboard-oauth-clients.ts';
import {
  dashboardUnpairedSourceStates,
  parseDashboardUnpairSource,
  dashboardPairingSession,
  dashboardUnpairPathError,
  dashboardUnpairObligations,
} from './http/dashboard-pairing.ts';
import { xBookmarksLiveAdminResult } from './http/x-bookmarks-admin.ts';

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
  const agentConnections = options.agentConnections;
  const sourceAnswer = options.sourceAnswer;
  // Content-free manifests for stdio's delayed collection. Tickets never
  // appear on an assistant surface; missing/expired tickets fail closed.
  const releaseTickets = new Map<string, { expires: number; manifests: readonly ReleaseManifest[]; receipt?: AgentAnswerReceipt }>();
  const pruneReleaseTickets = () => {
    for (const [ticket, entry] of releaseTickets) if (entry.expires <= Date.now()) releaseTickets.delete(ticket);
  };
  const consultAsk = options.consultAsk;
  const ownerLimits = options.ownerLimits;
  const archiveImportAgent = options.archiveImportAgent;
  const ownerTierItems = options.ownerTierItems;
  const judgeCheck = options.judgeCheck;
  const sourceAnswerLatencyLog = options.sourceAnswerLatencyLog;
  const sourceIndexStatus = options.sourceIndexStatus;
  const currentReadwiseSync = options.currentReadwiseSync
    ?? (() => options.readwiseConnectorStoreSync);
  const xBookmarksConnectorStoreSync = options.xBookmarksConnectorStoreSync;
  const xBookmarksContentRecovery = options.xBookmarksContentRecovery;
  const currentXBookmarksRuntime = options.currentXBookmarksRuntime
    ?? (() => {
      if (!xBookmarksConnectorStoreSync && !xBookmarksContentRecovery) return undefined;
      return {
        ...(xBookmarksConnectorStoreSync ? { sync: xBookmarksConnectorStoreSync } : {}),
        ...(xBookmarksContentRecovery ? { contentRecovery: xBookmarksContentRecovery } : {}),
      };
    });
  const fileExtraction = options.fileExtraction;
  const pdfExtractionLanes = options.pdfExtractionLanes;
  const pdfExtractionLaneScopeApproved = options.pdfExtractionLaneScopeApproved;
  const dropboxEvalShardExport = options.dropboxEvalShardExport;
  const dropboxSourceExport = options.dropboxSourceExport;
  const sourceIndexEmbeddingProvider = options.sourceIndexEmbeddingProvider;
  const connectorStores = options.connectorStores ?? [];
  // Looked up live: a tiered store set opens its Public store on first need,
  // after this worker was created, and the runtime appends it to this list.
  const connectorStoresByCorpusId = {
    get: (corpusId: string): LocalConnectorStore | undefined => {
      options.refreshConnectorStores?.();
      return connectorStores.find((store) => store.corpusId === corpusId);
    },
  };
  const connectorStoreEmbeddingProviders = options.connectorStoreEmbeddingProviders ?? new Map();
  const connectorStoreAccountScopes = options.connectorStoreAccountScopes ?? new Map();
  const connectorStorePrincipals = options.connectorStorePrincipals ?? new Map();
  const connectorStoreFilterCapabilities = options.connectorStoreFilterCapabilities
    ?? CONNECTOR_STORE_FILTER_CAPABILITIES;
  const connectorStoreReadScope = options.connectorStoreReadScope;
  const sourceScheduler = options.sourceScheduler;
  const sourceWatch = options.sourceWatch;
  const sourceDashboard = options.sourceDashboard;
  const settingsProposal = sourceDashboard ? settingsProposalHolderFor(sourceDashboard) : undefined;
  const credentialDegradations = options.credentialDegradations;
  const credentialReadiness = options.credentialReadiness;
  const serviceInstanceId = options.serviceInstanceId?.trim() || undefined;
  const recheckCredentials = options.recheckCredentials;
  const dashboardOAuthAttempts = new Map<DashboardOAuthSource, DashboardOAuthAttempt>();
  // The HMAC key material the publisher-relay `state` is signed with:
  // `current`, and a `previous` key that still verifies for one flow TTL past
  // its own rotation (docs/ops/OAUTH_RELAY.md). Worker-local, kept in the same
  // secret store the worker's other local material lives in, minted once on
  // first use, and never handed to a browser or a provider. Cached in the
  // closure so an unauthenticated callback can never make this process read
  // the secret store on its own account: the key is only ever reached through
  // a pending attempt that an authenticated start route created.
  let dashboardRelayStateKeysCache: OAuthRelayStateKeys | undefined;
  const dashboardRelayStateKeys = async (secretStore: SecretStore): Promise<OAuthRelayStateKeys> => {
    if (dashboardRelayStateKeysCache) return dashboardRelayStateKeysCache;
    const parsed = parseOAuthRelayStateKeys(await secretStore.get(DASHBOARD_OAUTH_RELAY_STATE_KEY));
    if (parsed) {
      dashboardRelayStateKeysCache = parsed;
      return parsed;
    }
    const minted = createOAuthRelayStateKeys();
    await secretStore.set(DASHBOARD_OAUTH_RELAY_STATE_KEY, serializeOAuthRelayStateKeys(minted));
    dashboardRelayStateKeysCache = minted;
    return minted;
  };
  // A bounded, in-memory abuse control for the callback route's flood case
  // (docs/ops/OAUTH_RELAY.md, "Hygiene": "Rate-limit unsolicited callbacks").
  // Per worker instance, like `dashboardOAuthAttempts` above it, so unrelated
  // fixtures in the same test process never share a bucket.
  const dashboardOAuthCallbackRateLimiter = createDashboardOAuthCallbackRateLimiter();
  const dashboardDisconnectedSources = new Set<V04PublicSourceId>();
  // The last Sync now result per dashboard source id, so the row can say what
  // the press found after the page refreshes (2026-10-08). In memory beside
  // the Disconnect latch: the line lives ten minutes, a restart may drop it.
  const dashboardManualSyncs = new Map<string, DashboardManualSync>();
  // Sync now answers before its sync ends (2026-10-09): the runs still going,
  // and when each source was last started, for `busy` and the once-a-minute
  // limit. Keyed like `dashboardManualSyncs`, by the dashboard source id.
  const dashboardManualSyncRuns = new Map<string, Promise<void>>();
  const dashboardManualSyncStarts = new Map<string, number>();
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
  const dashboardPostConnectRuns = new Map<DashboardSyncSource, Promise<void>>();
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
  const dashboardMessaging = sourceDashboard?.withMessagingCapturePaused ? createDashboardMessagingService({
    ...(sourceDashboard.registryPath ? { registryPath: sourceDashboard.registryPath } : {}),
    secretStore: dashboardSecretStore(sourceDashboard),
    withMessagingCapturePaused: sourceDashboard.withMessagingCapturePaused,
    withGrantMutation: withDashboardGrantMutation,
  }) : undefined;
  /**
   * A confirmed Disconnect, Unpair or Delete indexed data of a chat source stops its pairing before taking the grant lock (the
   * pairing may itself wait for that lock), and no new pairing can start until the operation is done (#689).
   */
  const withMessagingPairingHeld = <T>(record: Record<string, unknown>, operation: () => Promise<T>): Promise<T> => {
    const source = record.acknowledge !== true ? undefined
      : record.source_id === 'telegram.messages' ? 'telegram' as const
        : record.source_id === 'whatsapp.personal.messages' ? 'whatsapp' as const : undefined;
    return source && dashboardMessaging ? dashboardMessaging.withPairingHeld(source, operation) : operation();
  };
  const basePath = normalizeBasePath(options.basePath ?? '/v1');

  return {
    close(): void {
      dashboardWorkerClosed = true;
      dashboardMessaging?.close();
      if (dashboardSchedulerAdoptionTick === undefined) return;
      clearInterval(dashboardSchedulerAdoptionTick);
      dashboardSchedulerAdoptionTick = undefined;
    },

    async fetch(request: Request): Promise<Response> {
      try {
        const url = new URL(request.url);
        // The dashboard's public routes, and the worker's writing routes
        // (write-routes.ts): any other writer is refused before a handler runs.
        if (!workerRouteAllowed(request.method, url.pathname, basePath)) {
          if (url.pathname.startsWith('/dashboard') || url.pathname.startsWith('/oauth/callback/')) {
            return new Response('Not Found', { status: 404 });
          }
          return workerRouteNotFound();
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

        if (request.method === 'GET' && url.pathname === `${basePath}/service/readiness`) {
          if (!serviceInstanceId) {
            return json({
              kind: 'worker_service_readiness',
              ready: false,
              reason: 'service_instance_id_unconfigured',
              policy: { raw_runtime_secrets_exposed: false, source_text_returned: false },
            }, 503);
          }
          return json({
            kind: 'worker_service_readiness',
            ready: true,
            instance_id: serviceInstanceId,
            policy: { raw_runtime_secrets_exposed: false, source_text_returned: false },
          });
        }

        if (request.method === 'GET' && url.pathname === `${basePath}/health`) {
          const degradedCredentials = credentialDegradations?.() ?? [];
          const health = isDeepHealthRequest(url)
            ? withCredentialDegradations(await connector.health(), degradedCredentials)
            : cheapWorkerHealth(connector, degradedCredentials);
          assertNoRawEmailFields(health);
          const update = options.updateAvailable?.();
          return json({ ...health, ...(update ? { update_available: update } : {}) });
        }

        if (request.method === 'GET' && url.pathname === `${basePath}/health/dependencies`) {
          const health = withCredentialReadiness(
            withCredentialDegradations(await connector.health(), credentialDegradations?.() ?? []),
            credentialReadiness?.(),
          );
          assertNoRawEmailFields(health);
          return json(health);
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/consult/ask`) {
          if (!consultAsk) {
            throw new EmailSourceWorkerError(501, 'consult_ask_not_supported', 'Private source worker does not support anonymous questions.');
          }
          // The outcome is a result, never an HTTP error: a refusal (no level
          // chosen, a secret, no route, a cap) is reported to the agent in
          // the body. The core validates every field again.
          // The request's signal (a remote caller gone, a job's deadline)
          // cancels the writer and the session before dispatch.
          return json(await consultAsk(await parseConsultAskRequest(request), request.signal));
        }

        // olympus_limits: the CLI, local MCP and Home list and continue stops here.
        // Refusals are OperationErrors (invalid_params), answered as 400s below.
        if (request.method === 'POST' && url.pathname === `${basePath}/limits`) {
          if (!ownerLimits) {
            throw new EmailSourceWorkerError(501, 'limits_not_supported', 'This engine does not report work stops.');
          }
          return json(await ownerLimits(await parseObjectBody(request)));
        }

        // An agent's side of importing an archive (archive-import/agent.ts): ask
        // for an import or a removal, and read the list. It records a request
        // and reads; it approves, imports and removes nothing. Those are the
        // dashboard's control routes below, which a local control session
        // alone reaches. The path is kept as text and never opened here.
        if (request.method === 'POST' && url.pathname.startsWith(`${basePath}/archive-import/`)) {
          if (!archiveImportAgent) {
            throw new EmailSourceWorkerError(501, 'archive_import_not_supported', 'Importing archives is not set up in this engine.');
          }
          const record = await parseObjectBody(request);
          const action = url.pathname.slice(`${basePath}/archive-import/`.length);
          if (action === 'start') return json(archiveImportAgent.start(record.path));
          if (action === 'status') return json(archiveImportAgent.status(record.archive_id));
          if (action === 'remove') return json(archiveImportAgent.remove(record.archive_id));
          throw new EmailSourceWorkerError(404, 'not_found', 'No such archive route.');
        }

        // An agent's side of the one-item privacy change (tier-owner-items.ts):
        // find items whose names are Personal, and raise one to Private. It
        // never lowers: Personal and the judge's label are the dashboard's
        // local routes below.
        if (request.method === 'POST' && url.pathname.startsWith(`${basePath}/privacy-item/`)) {
          if (!ownerTierItems) {
            throw new EmailSourceWorkerError(501, 'privacy_items_not_supported', 'Changing one item\'s privacy is not set up in this engine.');
          }
          const record = await parseObjectBody(request);
          const action = url.pathname.slice(`${basePath}/privacy-item/`.length);
          if (action === 'find') {
            const query = asOptionalString(record.query);
            const recent = asOptionalBoolean(record.recent);
            const limit = asOptionalNumber(record.limit, 'limit');
            return json(ownerTierItems.find({
              ...(query !== undefined ? { query } : {}),
              ...(recent !== undefined ? { recent } : {}),
              ...(limit !== undefined ? { limit } : {}),
              personalNamesOnly: true,
            }));
          }
          if (action === 'raise') {
            const itemId = asOptionalString(record.item_id);
            if (!itemId) throw new EmailSourceWorkerError(400, 'invalid_request', 'item_id is required.');
            return json(ownerTierItems.set({ itemId, choice: 'private', allowLower: false }));
          }
          throw new EmailSourceWorkerError(404, 'not_found', 'No such privacy item route.');
        }

        // An agent on this computer received this answer (its tool result,
        // core/app-release-agent.ts): record what the worker kept with the
        // ticket on the owner's list of what each AI app received, once. The
        // caller names only the ticket and whether it was withheld; the
        // question, app and items are the worker's own.
        if (request.method === 'POST' && url.pathname === `${basePath}/source/answer/received`) {
          const body = await parseObjectBody(request);
          const entry = typeof body.ticket === 'string' ? releaseTickets.get(body.ticket) : undefined;
          if (entry?.receipt && entry.expires > Date.now()) {
            const { receipt } = entry;
            delete entry.receipt;
            recordAgentAnswerReceipt(receipt, body.withheld !== false);
          }
          return json({ ok: true });
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/answer/release`) {
          const body = await request.json() as { ticket?: unknown };
          const entry = typeof body.ticket === 'string' ? releaseTickets.get(body.ticket) : undefined;
          // Look up before pruning so a late collection has an actionable reason.
          const reason = entry?.expires !== undefined && entry.expires <= Date.now()
            ? 'Olympus withheld this answer because its privacy release ticket expired after 15 minutes. Ask again.'
            : !entry
              ? 'Olympus withheld this answer because its privacy release ticket is no longer available (the engine may have restarted). Ask again.'
              : options.sourceAnswerReleaseCheck
                ? await answerReleaseWithheldReasonOffThread(entry.manifests, options.sourceAnswerReleaseCheck)
                : 'Olympus withheld this answer because the engine cannot check its current privacy classification. Update Olympus, then ask again.';
          pruneReleaseTickets();
          return json({ ...(reason ? { withheld: reason } : { allowed: true }) });
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
            let caller: OperationCallerWire | undefined;
            try {
              const sourceAnswerRequest = await parseSourceIndexAnswerRequest(request);
              requestParsed = true;
              caller = sourceAnswerRequest.caller;
              // The caller's cancellation reaches the analyst: a client that
              // disconnects (or a hand-off job's deadline, for remote agents)
              // stops the model call and frees the analyst lane.
              const manifests = createReleaseManifestSink();
              const result = await runWithReleaseManifestSink(manifests, () => runWithAnalystAbortSignal(
                callerCancellationSignal(request.signal),
                () => retrySqliteBusy(() => sourceAnswer.answer(sourceAnswerRequest)),
              ));
              // Forward the manifest to an in-process remote call's sink too.
              for (const manifest of manifests.manifests) recordReleaseManifest(manifest);
              assertNoRawEmailFields(result);
              // Not recorded on the owner's list of what each AI app received yet: a local agent's
              // answer is recorded when its tool result says it was received (/source/answer/received,
              // core/app-release-agent.ts), after collection and the release-ticket check. A remote call
              // is recorded where its own output leaves.
              const receipt = agentAnswerReceipt(sourceAnswerRequest.question, caller, result);
              let releaseTicket: string | undefined;
              if (caller?.surface !== 'remote') {
                pruneReleaseTickets();
                releaseTicket = randomBytes(32).toString('base64url');
                releaseTickets.set(releaseTicket, { expires: Date.now() + 15 * 60_000, manifests: manifests.manifests, ...(receipt ? { receipt } : {}) });
                while (releaseTickets.size > 256) releaseTickets.delete(releaseTickets.keys().next().value!);
              }
              // A remote caller's output adds its own note (core/remote-result.ts, chatgpt/response-builder.ts).
              const localNote = caller?.surface !== 'remote'
                ? privacyBacklogCoverageNote(readPendingPrivacyItems(options), 'local')
                : undefined;
              const answered = localNote && typeof result.answer === 'string'
                ? { ...result, answer: withCoverageNote(result.answer, localNote) }
                : result;
              const response = json({ ...answered, ...(releaseTicket ? { _release_ticket: releaseTicket } : {}) });
              await emitSourceAnswerLatencyRecords({
                log: sourceAnswerLatencyLog,
                trace,
                outcome: 'success',
                result,
                ...(caller ? { caller } : {}),
              });
              return response;
            } catch (error) {
              await emitSourceAnswerLatencyRecords({
                log: sourceAnswerLatencyLog,
                trace,
                outcome: classifySourceAnswerTraceOutcome(error, requestParsed, request.signal.aborted),
                error,
                ...(caller ? { caller } : {}),
              });
              throw error;
            }
          });
        }

        // The CLI's store-opening commands while this worker owns the data
        // (core/cli-via-worker.ts). Behind the worker bearer, like every route
        // the relay does not forward; a relayed request is refused outright.
        if (request.method === 'POST' && url.pathname.startsWith(`${basePath}${WORKER_CLI_ROUTE_PREFIX}`)) {
          if (carriesRelayMarker(request)) {
            throw new EmailSourceWorkerError(403, 'cli_route_not_relayed', 'CLI routes are not served to relayed requests.');
          }
          const operation: WorkerCliOperation | undefined = WORKER_CLI_OPERATIONS
            .find((name) => name === url.pathname.slice(`${basePath}${WORKER_CLI_ROUTE_PREFIX}`.length));
          if (operation) {
            const body = await parseObjectBody(request);
            const mismatch = cliDataRootMismatch(body, sourceDashboard?.dataLifecyclePathContext ?? { env: process.env });
            if (mismatch) throw new EmailSourceWorkerError(409, 'config_error', mismatch.message, mismatch.suggestion);
            switch (operation) {
              case 'ingestion-status': return json(await ingestionStatusForCli());
              case 'data-export': return json(exportForCli(body));
              case 'data-delete': return json(await deleteSourceDataForCli(body));
              case 'tier': return json(await tierForCli(body));
              case 'pairing-placement': return json(pairingPlacementForCli(body));
              case 'pairing-account': return json(pairingAccountForCli(body));
              case 'setup-status': {
                if (!sourceDashboard?.setupStatus) throw new EmailSourceWorkerError(501, 'source_dashboard_not_supported', 'This Olympus has no setup checklist to show.');
                return json(await sourceDashboard.setupStatus());
              }
              case 'settings-propose': {
                if (!settingsProposal) throw new EmailSourceWorkerError(501, 'source_dashboard_not_supported', 'This Olympus has no dashboard settings to change.');
                try {
                  const proposal = await settingsProposal.propose(parseSettingsProposalInput(body.proposal), parseProposalFrom(body.from));
                  return json({
                    kind: 'olympus_settings_proposal',
                    id: proposal.id,
                    changes: proposal.rows,
                    next: 'Nothing has changed yet. Ask the owner to open the dashboard on this computer, go to Settings, check the proposed changes and click Apply all.',
                  });
                } catch (error) {
                  if (error instanceof SettingsProposalError) throw new EmailSourceWorkerError(400, 'invalid_params', error.message, 'Run olympus settings schema and olympus settings show for what can be set.');
                  throw error;
                }
              }
              case 'settings': {
                if (!sourceDashboard) throw new EmailSourceWorkerError(501, 'source_dashboard_not_supported', 'This Olympus has no dashboard settings to show.');
                const dashboard = sourceDashboard;
                return json(await settingsForCli({
                  answerMode: () => {
                    const id = privateAnswerMode(dashboard.sovereigntyEngine.config);
                    return { id, label: id === 'custom' ? 'Custom Private-answer mode' : PRIVACY_PRESET_LABELS[id] };
                  },
                  ...(dashboard.computerSetup ? { computerSetup: dashboard.computerSetup } : {}),
                  ...(dashboard.judgeSetup ? { judge: dashboard.judgeSetup.status } : {}),
                  ...(dashboard.modelChoices ? { modelChoices: () => dashboard.modelChoices!.status() } : {}),
                  ...(dashboard.consult ? { outsideHelp: () => dashboard.consult!.status() } : {}),
                }));
              }
            }
          }
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
          options.refreshConnectorStores?.();
          const statusRequest = await parseSourceIndexStatusRequest(request, connectorStores);
          const result = withCredentialDegradations(
            // The same reuse window as the dashboard: a status command never
            // rebuilds every store's hidden-copy set in one go.
            await sourceIndexStatus.status(statusRequest, { countsMaxAgeMs: STATUS_COUNTS_MAX_AGE_MS }),
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
          const recordId = sourceWatch.recordId?.(request);
          const create = { ...(await parseSourceWatchCreateRequest(request)), ...(recordId ? { watchId: recordId } : {}) };
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

        const agentResponse = await handleDashboardAgentRequest(request, url.pathname, agentConnections);
        if (agentResponse) return agentResponse;

        if (request.method === 'GET' && url.pathname === '/dashboard/auth-check') {
          return json({ ok: true });
        }

        // The folder and mail pickers' data. Two routes, and NEITHER is in the
        // dash_ query-token allowlist in workers/http.ts: they are made of
        // folder names. The panel's picker reaches them in process through the
        // setup tools (chatgpt/setup-backend.ts); the strong credential is the
        // only other way in.
        if (request.method === 'POST' && url.pathname === '/dashboard/dispositions') {
          if (!sourceDashboard?.ingestionDispositions) {
            throw new EmailSourceWorkerError(
              501,
              'ingestion_dispositions_not_supported',
              'Private source worker does not have the ingestion-dispositions picker configured.',
            );
          }
          const postBody = await parseObjectBody(request);
          if (postBody.action === 'browse_folder_scope') {
            if (!sourceDashboard.fileSourceScopes) {
              throw new EmailSourceWorkerError(501, 'source_index_not_enabled', 'Folder scope browsing is not configured.');
            }
            const input = postBody;
            const sourceId = parseFolderScopeSourceId(input.source_id);
            const parentKey = asOptionalString(input.parent_key);
            const cursor = asOptionalString(input.cursor);
            const scopeBrowser = await sourceDashboard.fileSourceScopes.browse({
              sourceId,
              ...(parentKey ? { parentKey } : {}),
              ...(cursor ? { cursor } : {}),
            });
            return json({
              status: 200,
              title: 'Olympus / Choose folders',
              body: '<main></main>',
              controller: 'dispositions',
              can_write: true,
              signature: scopeBrowser.scope_revision,
              poll_interval_ms: 15_000,
              scope_browser: scopeBrowser,
            });
          }
          if (postBody.action === 'browse_mail_scope') {
            if (!sourceDashboard.fileSourceScopes?.browseMail) {
              throw new EmailSourceWorkerError(501, 'source_index_not_enabled', 'The mail scope picker is not configured.');
            }
            if (postBody.source_id !== 'gmail.email') {
              throw new EmailSourceWorkerError(400, 'invalid_request', 'source_id must be gmail.email.');
            }
            return json(await sourceDashboard.fileSourceScopes.browseMail({ draft: parseMailScopeDraft(postBody.draft) }));
          }
          if (postBody.action === 'approve_mail_scope_and_start') {
            assertDashboardModelsReady();
            if (!sourceDashboard.fileSourceScopes?.approveMailAndStart) {
              throw new EmailSourceWorkerError(501, 'source_index_not_enabled', 'Mail scope approval is not configured.');
            }
            if (postBody.source_id !== 'gmail.email') {
              throw new EmailSourceWorkerError(400, 'invalid_request', 'source_id must be gmail.email.');
            }
            const accountGeneration = asOptionalString(postBody.account_generation);
            const expectedRevision = asOptionalString(postBody.expected_scope_revision);
            if (!accountGeneration || !expectedRevision) {
              throw new EmailSourceWorkerError(400, 'invalid_request', 'account_generation and expected_scope_revision are required.');
            }
            return json(await sourceDashboard.fileSourceScopes.approveMailAndStart({
              accountGeneration,
              expectedRevision,
              draft: parseMailScopeDraft(postBody.scope),
            }));
          }
          if (postBody.action === 'approve_source_scope_and_start') {
            assertDashboardModelsReady();
            if (!sourceDashboard.fileSourceScopes) {
              throw new EmailSourceWorkerError(501, 'source_index_not_enabled', 'Folder scope approval is not configured.');
            }
            const sourceId = parseFolderScopeSourceId(postBody.source_id);
            const accountGeneration = asOptionalString(postBody.account_generation);
            const expectedRevision = asOptionalString(postBody.expected_scope_revision);
            if (!accountGeneration || !expectedRevision) {
              throw new EmailSourceWorkerError(400, 'invalid_request', 'account_generation and expected_scope_revision are required.');
            }
            return json(await sourceDashboard.fileSourceScopes.approveAndStart({
              sourceId,
              accountGeneration,
              expectedRevision,
              selections: parseSourceScopeSelections(postBody.selections),
              wholeAccount: postBody.whole_account === true,
              explicitWholeAccountConfirmation: postBody.explicit_whole_account_confirmation === true,
            }));
          }
          const runtime = await sourceDashboard.ingestionDispositions();
          try {
            const rulesPath = resolveSourceIngestionExclusionsPath(process.env, runtime.rulesPath);
            const save = saveSourceDispositions(rulesPath, parseSourceDispositionsSave(postBody, runtime.sources));
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
          } finally {
            runtime.close?.();
          }
        }


        // GET /dashboard: the computer's host page around the panel, its local
        // pages, the locked panel read, and redirects for every older page
        // (dashboard/index.ts). Only Keys and the JSON view build the view
        // model; the host page is the panel's own HTML and reads through the
        // panel's tools like ChatGPT does.
        if (request.method === 'GET' && (url.pathname === '/dashboard' || url.pathname === '/dashboard.json')) {
          const page = url.pathname === '/dashboard.json' ? 'json' as const : dashboardHtmlRoutePage(url);
          if (page === 'legacy') {
            return new Response(null, { status: 302, headers: { Location: dashboardLegacyRedirect(url), 'Cache-Control': 'no-store' } });
          }
          if (page === 'outside_help_moved') {
            return new Response(null, { status: 302, headers: { Location: dashboardOutsideHelpRedirect(url), 'Cache-Control': 'no-store' } });
          }
          // Before the shell: its fetch would follow this redirect and lose the #fragment.
          if (page === 'connector') {
            return new Response(null, { status: 302, headers: { Location: dashboardConnectorRedirect(url), 'Cache-Control': 'no-store' } });
          }
          // The cookie without this browser's stored proof (#1187, workers/http.ts): the
          // content-free shell, under the policy of the page it will write into its window.
          if (request.headers.has(DASHBOARD_UNLOCK_SHELL_CONTEXT_HEADER)) {
            return new Response(DASHBOARD_UNLOCK_SHELL_HTML, {
              status: 200,
              headers: dashboardUnlockShellHeaders(page === 'host' ? COMPUTER_HOST_PAGE_CSP : "frame-ancestors 'none'"),
            });
          }
          const controlSessionCsrfToken = request.headers.get(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) ?? undefined;
          if (page === 'host') {
            return new Response(renderComputerHostPage({
              panelHtml: dashboardResourceHtml(),
              updateAvailable: options.updateAvailable?.(),
              ...(options.selfUpdate ? { selfUpdate: true, updateStatus: options.selfUpdate.status() } : {}),
              platform: options.platform ?? process.platform,
              origin: dashboardOAuthRedirectOrigin(url, request.headers),
              ...(controlSessionCsrfToken ? { csrfToken: controlSessionCsrfToken } : {}),
              ...(controlSessionCsrfToken && request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) === 'local' ? { localSession: true } : {}),
              ...(dashboardReadToken(url) ? { readToken: dashboardReadToken(url)! } : {}),
            }), {
              status: 200,
              headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'Content-Security-Policy': COMPUTER_HOST_PAGE_CSP,
                'X-Frame-Options': 'DENY',
                'Referrer-Policy': 'no-referrer',
              },
            });
          }
          if (page === 'panel_read') {
            if (!sourceDashboard?.panelTools) {
              throw new EmailSourceWorkerError(501, 'source_dashboard_not_supported', 'The dashboard panel is not configured.');
            }
            // A locked reader: names, never an open token (no opener).
            return json(await sourceDashboard.panelTools.call(DASHBOARD_TOOL_NAME, {}, dashboardPanelCallContext(url, request)));
          }
          if (page === 'agents') {
            return html(renderDashboardLocalPage('agents', {
              url,
              options: {
                ...(controlSessionCsrfToken ? { controlSessionCsrfToken } : {}),
                ...(agentConnections ? { agents: dashboardAgentsView(agentConnections) } : {}),
                ...(options.agentConnectHost ? { agentConnectHost: options.agentConnectHost() } : {}),
              },
            }));
          }
          if (page === 'settings') {
            const installer = installerForPlatform(options.platform ?? process.platform);
            const update = installer ? options.updateAvailable?.() : undefined;
            // Settings › zkAPI (#1047): the card's facts only with the control session, as on Private questions before.
            const outsideHelp = sourceDashboard?.consult && controlSessionCsrfToken !== undefined
              ? await sourceDashboard.consult.status().catch(() => undefined)
              : undefined;
            return html(renderDashboardLocalPage('settings', {
              url,
              options: {
                ...(controlSessionCsrfToken ? { controlSessionCsrfToken } : {}),
                ...(outsideHelp ? { outsideHelp } : {}),
                outsideHelpLocalSession: request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) === 'local',
                ...(agentConnections ? { agents: dashboardAgentsView(agentConnections) } : {}),
                ...(options.agentConnectHost ? { agentConnectHost: options.agentConnectHost() } : {}),
                // The folder and the backups in it only for the unlocked session minted on this computer.
                ...(sourceDashboard?.backup && controlSessionCsrfToken !== undefined && request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) === 'local'
                  ? { backup: sourceDashboard.backup.status() } : {}),
                ...(settingsProposal ? { settingsProposal: { current: settingsProposal.current(), lastApplied: settingsProposal.lastApplied() } } : {}),
                settings: {
                  models: dashboardModelsOnComputer({
                    config: sourceDashboard?.sovereigntyEngine.config,
                    // The built-in model answers for the route's local member exactly when the local picker lists built-in sizes.
                    builtInAnswers: (await sourceDashboard?.modelChoices?.status().catch(() => undefined))?.local?.current.startsWith('builtin:') === true,
                    ...(options.localModelReadiness ? { readiness: options.localModelReadiness() } : {}),
                  }),
                  ...(update && installer ? { update: { version: update.version, command: installer.command } } : {}),
                  ...(installer ? { updater: { command: installer.command, selfUpdate: options.selfUpdate !== undefined, ...(options.selfUpdate ? { status: options.selfUpdate.status() } : {}) } } : {}),
                },
              },
            }));
          }
          if (page === 'apps_received') {
            // The page carries no request: its script reads the list through the local-only route.
            return html(renderDashboardLocalPage('apps_received', {
              url,
              options: {
                ...(controlSessionCsrfToken ? { controlSessionCsrfToken } : {}),
                outsideHelpLocalSession: request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) === 'local',
                appsReceivedAvailable: sourceDashboard?.appsReceived !== undefined,
              },
            }));
          }
          if (page === 'private_answers') {
            // Waiting questions and the outside help card's facts (a daemon
            // version call and two port probes) only with the control
            // session; the questions only when it was minted locally, the
            // only grade the Private answers and consult routes take.
            const localSession = request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) === 'local';
            const outsideHelp = sourceDashboard?.consult && controlSessionCsrfToken !== undefined
              ? await sourceDashboard.consult.status().catch(() => undefined)
              : undefined;
            const waiting = controlSessionCsrfToken !== undefined && localSession ? sourceDashboard?.privateAnswers?.waiting() : undefined;
            return html(renderDashboardLocalPage('private_answers', {
              url,
              options: {
                ...(controlSessionCsrfToken ? { controlSessionCsrfToken } : {}),
                ...(outsideHelp ? { outsideHelp } : {}),
                outsideHelpLocalSession: localSession,
                privateAnswers: {
                  available: sourceDashboard?.privateAnswers !== undefined,
                  ...(controlSessionCsrfToken !== undefined && localSession ? { destinations: sourceDashboard?.privateAnswers?.destinations() } : {}),
                  ...(waiting ? { waiting } : {}),
                },
              },
            }));
          }
          if (page === 'privacy_items') {
            // Privacy › Your items: the page reads its items through the
            // dashboard's local routes, so it carries no item here; it only
            // needs to know whether the session was minted on this computer.
            return html(renderDashboardLocalPage('privacy_items', {
              url,
              options: {
                ...(controlSessionCsrfToken ? { controlSessionCsrfToken } : {}),
                outsideHelpLocalSession: request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) === 'local',
              },
            }));
          }
          if (page === 'people') {
            // The people list only for a locally minted control session.
            const localSession = controlSessionCsrfToken !== undefined && request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) === 'local';
            let people: DashboardPeopleView | undefined;
            if (localSession && sourceDashboard?.people) {
              try {
                people = sourceDashboard.people.view();
              } catch {
                people = undefined;
              }
            }
            return html(renderDashboardLocalPage('people', {
              url,
              options: { ...(controlSessionCsrfToken ? { controlSessionCsrfToken } : {}) },
              ...(people ? { people } : {}),
              peopleLocalSession: localSession,
            }));
          }
          if (page === 'help' && (!controlSessionCsrfToken || request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local')) return renderHelp(request, url);
          if (page === 'json' || page === 'keys' || page === 'connect' || page === 'help') {
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
            const registry = withThisComputerHandles(registryRead.registry, sourceDashboard.registryPath);
            const secretStore = dashboardSecretStore(sourceDashboard);
            const dashboardOAuthOrigin = dashboardOAuthRedirectOrigin(url, request.headers);
            const dashboardClientIdSets = await dashboardOAuthClientIdSets(registry, secretStore);
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
              }, { countsMaxAgeMs: STATUS_COUNTS_MAX_AGE_MS }),
              credentialDegradations?.() ?? [],
            );
            const schedulerDashboardStatus = sourceScheduler?.status();
            // The owner's exclusion rules live behind the same runtime the picker
            // opens. Without them every count in the page's "excluded by
            // configuration" section is summarized from an empty list, so the
            // page reported zero excluded folders while the rules were enforced.
            const exclusionSources = await dashboardExclusionSources(sourceDashboard, dashboardExclusionDebt);
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
              ...(sourceDashboard.modelSetup ? { modelSetup: sourceDashboard.modelSetup() } : {}),
              ...(sourceDashboard.corpusRegistry ? { sourceCorpusRegistry: sourceDashboard.corpusRegistry } : {}),
              ...(sourceDashboard.history ? { history: sourceDashboard.history } : {}),
              connectedHandleRegistry: registry,
              ...(registryRead.unreadable ? { connectedHandleRegistryUnreadable: true } : {}),
              ...dashboardSourceAccountBindings(sourceDashboard.registryPath),
              ...dashboardStorageNotices(),
              unpairedSources: dashboardUnpairedSourceStates(
                dashboardUnpairedSources,
                sourceDashboard.registryPath ?? defaultHandleRegistryPath(),
              ),
              manualSyncs: Object.fromEntries(dashboardManualSyncs),
              ...(sourceDashboard.captureRuntime ? { captureRuntime: sourceDashboard.captureRuntime() } : {}),
              ...(options.unreadableFileNames ? { unreadableFileNames: options.unreadableFileNames } : {}),
              ...(options.unreadableRecheck ? { unreadableRecheck: options.unreadableRecheck } : {}),
              ...(credentialHealth ? { credentialHealth } : {}),
              oauthClientIds: dashboardClientIdSets.all,
              oauthClientSecretAvailability: await dashboardOAuthClientSecretAvailability(secretStore, dashboardClientIdSets.all),
              ...(googleCloudProjectId ? { googleCloudProjectId } : {}),
              googlePilotClientConfigured: dashboardGooglePilotClientConfigured(),
              oauthRedirectBaseUrl: dashboardOAuthOrigin,
              // Which sources connect through Olympus's own app, so their card can
              // offer one Connect button instead of a walkthrough for an app the
              // owner does not have to register. Names sources only — no client
              // id, no relay URL, no state: this rides on the read-only surface.
              // Which card a source gets depends on the publisher app, never on
              // the request's OAuth origin (beta.5, 2026-09-24).
              publisherOAuthSources: dashboardPublisherOAuthSources(dashboardClientIdSets.own),
              apiKeyAvailability: await dashboardApiKeyAvailability(secretStore),
              pendingConnects: dashboardPendingConnects(dashboardOAuthAttempts),
              contentExtractionStallThresholdHours: dropboxContentExtractionStallHours(process.env),
              ingestionDispositionsAvailable: sourceDashboard.ingestionDispositions !== undefined,
              ...dashboardImportedArchives(sourceDashboard.archiveImports),
              ...dashboardLivePasses(sourceDashboard.livePasses),
              // The dispatch chain is this worker's to know. Without it the card
              // offered Sync now for a source nothing here can sync.
              syncNowAvailable: dashboardSourceSyncAvailable,
              ...(sourceDashboard.fileSourceScopes
                ? {
                    fileSourceScopeStatus: Object.fromEntries(
                      sourceDashboard.fileSourceScopes.summaries()
                        .map((scope) => [scope.source_id, scope.status]),
                    ),
                    fileSourceScopeIngestionEnabled: Object.fromEntries(
                      sourceDashboard.fileSourceScopes.summaries().map((scope) => [
                        scope.source_id,
                        scope.ingestion_enabled ?? (scope.status === 'approved' && (
                          scope.whole_account_selected === true
                          || scope.selections?.some((selection) => selection.state !== 'exclude') === true
                        )),
                      ]),
                    ),
                  }
                : {}),
            });
            assertNoRawEmailFields(view);
            if (page === 'json') return json(view);
            if (page === 'help') return renderHelp(request, url, view.sources.map(source => ({
              sourceId: source.source_id, state: source.connection.state,
              failure: sourceFailureKind(source.schedule?.last_error_kind, source.schedule?.degraded_reason), ref: source.schedule?.last_error_hash,
            })));
            if (page === 'connect') {
              return html(renderDashboardLocalPage('connect', {
                url,
                view,
                options: {
                  ...(controlSessionCsrfToken ? { controlSessionCsrfToken } : {}),
                  messagingLocalSession: Boolean(controlSessionCsrfToken) && request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) === 'local',
                },
              }));
            }
            const answerModeId = privateAnswerMode(sourceDashboard.sovereigntyEngine.config);
            return html(renderDashboardLocalPage('keys', {
              url,
              view,
              options: {
                answerMode: { id: answerModeId, label: answerModeId === 'custom' ? 'Custom Private-answer mode' : PRIVACY_PRESET_LABELS[answerModeId] },
                ...(controlSessionCsrfToken ? { controlSessionCsrfToken } : {}),
                ...(sourceDashboard.judgeSetup ? { judgeSetup: sourceDashboard.judgeSetup.pageStatus?.() ?? sourceDashboard.judgeSetup.status() } : {}),
                ...(sourceDashboard.modelChoices ? { modelChoices: await sourceDashboard.modelChoices.status().catch(() => undefined) } : {}),
                ...(sourceDashboard.goEasy ? { goEasy: sourceDashboard.goEasy.on() } : {}),
                outsideHelpLocalSession: request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) === 'local',
                messagingLocalSession: Boolean(controlSessionCsrfToken) && request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) === 'local',
                ...(controlSessionCsrfToken && sourceDashboard.consult ? { outsideHelp: await sourceDashboard.consult.status().catch(() => undefined) } : {}),
              },
            }));
          }
        }

        // The panel page itself, for the OpenClaw Control UI tab's frame (the
        // Gateway serves it at its own path with the worker bearer). Static:
        // the same HTML ChatGPT loads, no data.
        if (request.method === 'GET' && url.pathname === '/dashboard/panel') {
          return new Response(dashboardResourceHtml(), {
            status: 200,
            headers: {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
              'X-Frame-Options': 'DENY',
            },
          });
        }

        // One panel tool call from the computer's /dashboard (the control
        // session and its CSRF token are checked at the boundary,
        // workers/http.ts) or from the OpenClaw Control UI tab's gateway method
        // (the worker bearer). The same in-process handlers ChatGPT's /mcp
        // reaches, and only the panel's own tools (dashboard-panel-tools.ts).
        if (request.method === 'POST' && url.pathname === DASHBOARD_TOOLS_CALL_PATH) {
          if (!sourceDashboard?.panelTools) {
            throw new EmailSourceWorkerError(501, 'source_dashboard_not_supported', 'The dashboard panel is not configured.');
          }
          const record = await parseObjectBody(request);
          const name = typeof record.name === 'string' ? record.name : '';
          const args = record.arguments === undefined ? {} : record.arguments;
          if (!args || typeof args !== 'object' || Array.isArray(args)) {
            throw new EmailSourceWorkerError(400, 'invalid_request', 'arguments must be an object.');
          }
          if (!sourceDashboard.panelTools.allows(name)) {
            throw new EmailSourceWorkerError(404, 'unknown_tool', 'That tool is not available to the dashboard.');
          }
          return json(await sourceDashboard.panelTools.call(name, args as Record<string, unknown>, {
            ...dashboardPanelCallContext(url, request),
            opener: dashboardPanelOpener(request),
            ...(request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) === 'local' ? { localSession: true } : {}),
          }));
        }

        // The query-free landing the successful callback redirects to (MINOR 2,
        // Codex round 2 on 7863a735): rendering the "Connected" page directly at
        // the URL the provider redirected to left `code` and `state` sitting in
        // this tab's browser history despite `Cache-Control: no-store`, which
        // only keeps a response out of the disk cache, not out of history. This
        // route reads no attempt and no credential — it exists only to be a
        // clean URL to redirect a browser to after the code is already spent —
        // so it matches on source alone, plus one fixed `return=chatgpt` flag.
        const oauthCallbackDone = /^\/oauth\/callback\/([^/]+)\/done$/.exec(url.pathname);
        if (request.method === 'GET' && oauthCallbackDone) {
          const source = parseDashboardOAuthSource(decodeURIComponent(oauthCallbackDone[1]!));
          // One fixed flag, never a URL: a sign-in ChatGPT handed to this
          // computer ends with "go back to ChatGPT" instead.
          const returnTo = url.searchParams.get('return') === 'chatgpt' ? CHATGPT_RETURN_TO : dashboardReturnTo();
          return dashboardOAuthCompleteHtml({ source, returnTo });
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
          // MINOR, Codex round 3 on e75598f7: docs/ops/OAUTH_RELAY.md step 8
          // calls for rate-limiting unsolicited callbacks. Checked before any
          // attempt lookup or relay verification, so a flood spends none of
          // that work, and tripping it returns the IDENTICAL refusal every
          // other invalid callback gets — never a distinguishable 429 — so an
          // unauthenticated caller learns nothing new by tripping it.
          if (!dashboardOAuthCallbackRateLimiter(dashboardOAuthCallbackRateLimitKey(source, request.headers), Date.now())) {
            return dashboardOAuthFailureHtml({
              source,
              reason: 'This connection attempt is no longer active. Start connect again from the Olympus dashboard.',
              returnTo: dashboardReturnTo(),
              status: 410,
            });
          }
          const attempt = dashboardOAuthAttempts.get(source);
          // THIS ROUTE IS UNAUTHENTICATED. A provider redirect is just a GET
          // anyone can make, so the `state` this flow generated is the ONLY
          // proof that a given callback belongs to the attempt in memory —
          // and nothing above may be mutated before that proof is checked.
          // Recording a refusal first meant any stranger's
          // `GET /oauth/callback/dropbox?error=access_denied` rewrote the
          // owner's live attempt and dropped their card out of "connecting".
          const state = asOptionalString(url.searchParams.get('state'));
          const callbackError = asOptionalString(url.searchParams.get('error'));
          const code = asOptionalString(url.searchParams.get('code'));
          // A relay-bounced callback carries the SIGNED state this worker
          // minted, so every field the contract names is re-verified here:
          // signature, version, nonce, origin as this worker derives it,
          // source, and freshness (docs/ops/OAUTH_RELAY.md, "What the worker
          // must verify"). The relay holds no key and checks none of this; it
          // decides only where to bounce. Single use is the attempt record
          // itself — a consumed or replaced attempt is gone, and a replay
          // therefore lands in the same refusal as a forgery.
          const relayAccepted = attempt?.relay === undefined || state === undefined
            ? true
            : verifyOAuthRelayState(state, {
              keys: await dashboardRelayStateKeys(dashboardSecretStore(sourceDashboard)),
              expectedOrigin: attempt.relay.handbackOrigin ?? dashboardOAuthRedirectOrigin(url, request.headers),
              expectedSource: source,
              expectedNonce: attempt.relay.nonce,
              now: new Date(),
              ttlMs: OAUTH_RELAY_STATE_TTL_MS,
            }).ok;
          // Fixed-response(MAJOR 1, Codex round 2 on 7863a735): a validly
          // signed, unexpired, unconsumed state carrying NEITHER `code` nor
          // `error` used to fall through to its own 400 that also deleted the
          // attempt — a different status, a different body, and a mutation, all
          // reachable by an unauthenticated caller who merely knew (or guessed)
          // a live state string with the result parameters stripped off. That
          // let such a caller distinguish "this attempt still exists" from
          // "it's gone" and cancel a live attempt by doing nothing more than
          // omitting the result. `hasResult` folds that case into the exact
          // same refusal every other invalid-callback shape gets, and
          // `attempt.consumed` (set once a terminal outcome has been recorded,
          // MINOR 1 below) does the same for a callback replayed after the
          // provider's result has already been read once.
          const hasResult = callbackError !== undefined || code !== undefined;
          const attemptUsable = attempt !== undefined
            && attempt.consumed !== true
            && !dashboardOAuthAttemptExpired(attempt, new Date())
            && state !== undefined
            && dashboardOAuthStateMatches(attempt, state)
            && relayAccepted
            && hasResult;
          if (!attemptUsable) {
            // Deliberately ONE answer for every fact — no attempt, an expired
            // one, a consumed one, no state, the wrong state, no result, and
            // every relay-state refusal (bad signature, wrong version, replayed
            // nonce, stale iat, foreign origin, crossed source). An
            // unauthenticated caller learns nothing about whether a connect is
            // in flight, and in every one of these cases the stored attempt is
            // left exactly as it was. Only a genuinely expired record is
            // dropped here, which the prune pass would have done anyway; a
            // merely consumed or mismatched one stays untouched so a stray
            // request can never end a live attempt it failed to prove it owns.
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
          if (callbackError !== undefined) {
            // The error param arrives on a provider-crafted redirect: only a
            // known OAuth code is repeated, never the raw value.
            const errorCode = safeOAuthErrorCode(callbackError);
            // Kept, not deleted. The dashboard reads this record to say what
            // the provider refused; without it the card sat in "connecting"
            // for the rest of the ten-minute window over a dead attempt
            // (owner, 2026-09-03). It still expires on the same clock, and the
            // next Connect replaces it outright.
            attempt.error = { code: errorCode ?? 'unrecognized_error', at: new Date().toISOString() };
            // MINOR 1 (Codex round 2): a provider error is a terminal outcome
            // for THIS state even though the attempt record survives for
            // display, so the state itself must stop verifying — otherwise the
            // identical signed state stays replayable, with a different `code`,
            // until its own ten-minute expiry. `consumed` is a fact about the
            // state's usability, kept separate from `error`, which is a fact
            // about what the dashboard should say.
            attempt.consumed = true;
            return dashboardOAuthFailureHtml({
              source,
              reason: source === 'dropbox' && errorCode === 'invalid_scope' && attempt.clientIdSource === 'byo'
                ? 'Dropbox needs more permissions. Redo the Enable permissions step and sign in again. No credentials were stored.'
                : `OAuth provider returned ${errorCode ?? 'an unrecognized error'}.`,
              returnTo: attempt.returnTo,
              status: 400,
            });
          }
          // `hasResult` guarantees one of `callbackError`/`code` is defined;
          // `callbackError` was just handled and returned above, so `code` is
          // the one left. The check stays explicit rather than a non-null
          // assertion: if that invariant is ever wrong, this must fail the same
          // way every other invalid shape does, not throw past the refusal.
          if (code === undefined) {
            return dashboardOAuthFailureHtml({
              source,
              reason: 'This connection attempt is no longer active. Start connect again from the Olympus dashboard.',
              returnTo: dashboardReturnTo(),
              status: 410,
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
              // Folder-capable sources stop at connected + scope_pending.
              // OAuth consent is credential consent, not corpus consent.
              if (source !== 'google-drive' && source !== 'dropbox') {
                await triggerDashboardPostConnectSync({
                  source,
                  reason: 'post_connect',
                });
              }
            });
          } catch (error) {
            // Keep a fixed, credential-free failure on the original sheet, but
            // never retain a usable callback state or overwrite a newer attempt.
            if (dashboardOAuthAttempts.get(source) === attempt) {
              attempt.consumed = true;
              attempt.error = { code: 'connection_check_failed', at: new Date().toISOString() };
            }
            return dashboardOAuthFailureHtml({
              source,
              reason: dashboardCallbackFailureReason(error, source, attempt.clientIdSource),
              returnTo: attempt.returnTo,
              status: 400,
            });
          }
          // A ChatGPT hand-back arrived through the relay, which can route this
          // tab's next request only by its state: say done here.
          if (attempt.relay?.handbackOrigin) {
            return dashboardOAuthCompleteHtml({ source, returnTo: CHATGPT_RETURN_TO });
          }
          const chatgptDone = attempt.returnTo === CHATGPT_RETURN_TO ? '?return=chatgpt' : '';
          // MINOR 2 (Codex round 2): redirect to the query-free `/done` route
          // above rather than rendering the "Connected" page at this URL, which
          // still carries the now-spent `code` and `state` in its own address —
          // and therefore in this tab's history — even though the code has
          // already been exchanged and cannot be replayed. The authorization
          // also runs in its OWN tab now, so redirecting it to the dashboard
          // produced a second dashboard tab beside the one the owner is already
          // watching; this tab says the work is done and that it can be closed,
          // and the dashboard tab's poll picks the connection up on its own.
          return new Response(null, {
            status: 303,
            headers: {
              Location: `/oauth/callback/${encodeURIComponent(source)}/done${chatgptDone}`,
              'Referrer-Policy': 'no-referrer',
            },
          });
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
          // A sign-in from ChatGPT (handback: relay) is not gated on model
          // setup: ChatGPT writes the answers, so the Mac's answer model is
          // irrelevant to it, and connecting stores a grant without reading
          // anything. What reads private data stays gated: the scope approval
          // and the first sync after connect both check readiness, so indexing
          // simply waits for the models (owner live test, 2026-10-01: a Venice
          // analyst without a key refused Connect from ChatGPT).
          //
          // A sign-in ChatGPT handed to this computer (handback: computer,
          // from the `/go/<id>` hand-off's loopback leg) is the same case.
          if (record.handback !== 'relay' && record.handback !== 'computer') assertDashboardModelsReady();
          const secretStore = dashboardSecretStore(sourceDashboard);
          const registry = readDashboardRegistry(sourceDashboard.registryPath);
          assertDashboardAccountCardinality(registry, source);
          const clientIdSets = await dashboardOAuthClientIdSets(registry, secretStore);
          let uploadedClient: { clientId: string; clientSecret: string } | undefined;
          const ownDesktop = dashboardGoogleOAuthSource(source) && record.google_desktop === true;
          if (ownDesktop && typeof record.google_client_json === 'string') {
            try { uploadedClient = parseGoogleDesktopClient(record.google_client_json); }
            catch (error) { throw new EmailSourceWorkerError(400, 'google_app_file_invalid', (error as Error).message); }
          }
          const submittedClientId = uploadedClient?.clientId ?? asOptionalString(record.client_id);
          // A sign-in started for ChatGPT returns through the relay to this
          // install (the state's nonce carries the install id the relay routes
          // on). Only the publisher apps' relay callback can do that.
          const handback = record.handback === 'relay' ? sourceDashboard.oauthHandback?.() : undefined;
          // A Google sign-in ChatGPT handed to this computer: it started on
          // loopback here and returns here, and only its last page differs.
          const computerHandback = record.handback === 'computer';
          if (record.handback !== undefined && !handback && !computerHandback) {
            throw new EmailSourceWorkerError(409, 'oauth_handback_unavailable', 'This sign-in cannot return through the relay on this install.');
          }
          const dashboardOrigin = handback?.origin ?? dashboardOAuthRedirectOrigin(url, request.headers);
          // Evernote's MCP server registers its own client at sign-in: no
          // client id, no relay, a callback on this dashboard's own origin.
          if (source === 'evernote') {
            if (handback || computerHandback) {
              throw new EmailSourceWorkerError(409, 'oauth_handback_unavailable', 'Evernote connects in the Olympus dashboard on this computer.');
            }
            const attempt = await startDashboardEvernoteSignIn({
              redirectUri: `${dashboardOrigin}/oauth/callback/evernote`,
              secretStore,
              registryPath: sourceDashboard.registryPath ?? defaultHandleRegistryPath(),
              ...(sourceDashboard.evernoteSignIn ?? {}),
              ...(sourceDashboard.oauthFetch ? { fetch: sourceDashboard.oauthFetch as FetchLike } : {}),
            });
            dashboardOAuthAttempts.set(source, {
              source,
              pending: attempt.pending,
              returnTo: dashboardReturnTo(),
              startedAt: attempt.pending.startedAt,
              expiresAt: attempt.pending.expiresAt,
            });
            return json({
              ok: true,
              source,
              authorization_url: attempt.pending.authorizationUrl,
              expires_at: attempt.pending.expiresAt,
              policy: { raw_runtime_secrets_exposed: false, client_secret_returned: false },
            });
          }
          // Publisher mode: Olympus's own registered app, so the owner presses
          // Connect and nothing else. It is chosen only when this install has
          // no registration of its own for the source — a submitted client id
          // is a bring-your-own registration and always wins, and so does one
          // already on file. X is never publisher-owned.
          const publisher = submittedClientId || ownDesktop
            ? undefined
            : dashboardPublisherOAuthFlow(
              source,
              dashboardOAuthClientIdForSource(source, clientIdSets.own),
            );
          if (handback && (submittedClientId || publisher?.relay !== true)) {
            throw new EmailSourceWorkerError(409, 'oauth_handback_unavailable', 'This source uses your own app registration; connect it in Olympus on your Mac.');
          }
          if (computerHandback && (submittedClientId || publisher?.loopback !== true)) {
            throw new EmailSourceWorkerError(409, 'oauth_handback_unavailable', 'This source does not sign in on this computer; connect it in the Olympus dashboard.');
          }
          const savedDesktop = ownDesktop ? await readGoogleOwnAppRegistration(secretStore) : undefined;
          const clientId = submittedClientId
            ?? (ownDesktop ? savedDesktop?.clientId : publisher?.clientId ?? dashboardOAuthClientIdForSource(source, clientIdSets.all));
          if (!clientId) {
            throw new EmailSourceWorkerError(409, 'oauth_client_id_missing', ownDesktop ? 'Choose the downloaded Desktop app file, or paste the Client ID and secret.' : `Missing OAuth client id: ${dashboardOAuthClientIdConfigKey(source)}.`);
          }
          // The saved-secret field's stand-in value means "keep what is stored";
          // it must never be sent to a provider or stored as a secret.
          const rawClientSecret = uploadedClient?.clientSecret ?? asOptionalString(record.client_secret);
          const submittedClientSecret = rawClientSecret === DASHBOARD_SAVED_SECRET_FIELD_VALUE ? undefined : rawClientSecret;
          // Resolved after the client id, because which stored secret may be
          // sent depends on which client this flow is going out with. The
          // publisher Google Web client's secret exists only at the publisher
          // exchange, so this path does not even probe local secret namespaces:
          // an old local value must never accompany the Web client, reach the
          // exchange request, or be persisted again.
          const clientSecret = publisher && dashboardGoogleOAuthSource(source)
            ? undefined
            : await dashboardOAuthClientSecret(source, secretStore, submittedClientSecret, clientId);
          if (dashboardOAuthClientSecretRequired(source) && !clientSecret) {
            throw new EmailSourceWorkerError(409, 'oauth_client_secret_missing', `Missing OAuth client secret: ${dashboardOAuthClientSecretConfigKey(source)}.`);
          }
          if (ownDesktop) {
            try { await checkGoogleOwnApp({ clientId, clientSecret: clientSecret ?? '' }, sourceDashboard.oauthFetch); }
            catch (error) { throw new EmailSourceWorkerError(400, 'google_app_check_failed', (error as Error).message); }
          }
          // A client id in the body is a registration, not one call's argument.
          // It used to reach the store only from a COMPLETED callback, so a
          // flow that died at the provider — as the live X flow did on
          // 2026-08-19 — left the next start call failing with
          // oauth_client_id_missing and the owner re-pasting the same id.
          if (submittedClientId && !ownDesktop) {
            await secretStore.set(dashboardOAuthClientIdConfigKey(source), submittedClientId);
            // Explicit, not inferred: an owner-pasted id is bring-your-own by
            // definition, and marking it here means a later render never has
            // to fall back to the value-match migration heuristic for it.
            await secretStore.set(dashboardOAuthClientIdSourceKey(source), 'byo');
          }
          // The secret is a registration for the same reason — and for X it is
          // the credential the token exchange itself authenticates with, so a
          // later Reconnect must find it without the owner re-pasting it.
          if (submittedClientSecret && dashboardOAuthClientSecretRequired(source)) {
            await secretStore.set(dashboardOAuthClientSecretConfigKey(source), submittedClientSecret);
          }
          // ONE redirect URI per flow, and the same string reaches the token
          // exchange: `startExternalOAuthSourceConnection` keeps it on the
          // prepared flow and sends it back at exchange time, which is what the
          // providers' exact-string matching requires. Google's Desktop client
          // returns to this engine on loopback (`dashboardGoogleLoopbackOrigin`).
          const redirectUri = publisher?.loopback || ownDesktop
            ? `${dashboardGoogleLoopbackOrigin(dashboardOrigin, sourceDashboard.loopbackPort)}/oauth/callback/${encodeURIComponent(source)}`
            : publisher?.redirectUri
              ?? `${dashboardOrigin}/oauth/callback/${encodeURIComponent(source)}`;
          // The relay bounces the browser to whatever origin the state names,
          // so a relay flow's state is signed and carries that origin. Minted
          // here, inside an authenticated control-session route, and never from
          // an inbound callback (OAUTH_RELAY.md, worker check 0).
          const relayNonce = publisher?.relay === true
            ? (handback ? `${handback.installId}_${createOAuthRelayNonce()}` : createOAuthRelayNonce())
            : undefined;
          const relayState = relayNonce === undefined
            ? undefined
            : signOAuthRelayState({
              origin: dashboardOrigin,
              source,
              nonce: relayNonce,
              iat: Math.floor(Date.now() / 1000),
            }, (await dashboardRelayStateKeys(secretStore)).current);
          const startOAuth = sourceDashboard.startExternalOAuthConnection ?? startExternalOAuthSourceConnection;
          const pending = await startOAuth({
            source,
            clientId,
            ...(clientSecret ? { clientSecret } : {}),
            registryPath: sourceDashboard.registryPath ?? defaultHandleRegistryPath(),
            secretStore,
            redirectUri,
            ...(relayState ? { state: relayState } : {}),
            openBrowser: false,
            ...(sourceDashboard.oauthFetch ? { fetch: sourceDashboard.oauthFetch } : {}),
            // Recorded alongside the persisted client id at completion (MAJOR,
            // Codex round 3 on e75598f7): "a client id is present" cannot tell a
            // publisher-owned id from an owner-pasted one once both are stored
            // under the identical key, and mistaking one for the other broke
            // reauthentication after the first successful publisher connect.
            clientIdSource: publisher ? 'publisher' : 'byo',
            ...(ownDesktop ? { googleOwnApp: true } : {}),
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
            clientIdSource: publisher ? 'publisher' : 'byo',
            returnTo: handback || computerHandback ? CHATGPT_RETURN_TO : dashboardReturnTo(),
            startedAt: startedAtDate.toISOString(),
            expiresAt,
            ...(relayNonce ? { relay: { nonce: relayNonce, ...(handback ? { handbackOrigin: handback.origin } : {}) } } : {}),
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

        if (request.method === 'POST' && (url.pathname === '/dashboard/models/choice' || url.pathname === '/dashboard/models/addable')) {
          if (!request.headers.has(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) || request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            return json({ ok: false, error: { code: 'local_dashboard_only', message: 'Choose this in an unlocked dashboard on this computer.' } }, 403);
          }
          if (!sourceDashboard?.modelChoices) throw new EmailSourceWorkerError(501, 'not_available', 'Model choices are unavailable.');
          const input = await parseObjectBody(request);
          if (url.pathname.endsWith('/addable')) {
            if (input.provider !== 'venice') throw new EmailSourceWorkerError(400, 'invalid_request', 'Choose a provider.');
            return json({ ok: true, models: await sourceDashboard.modelChoices.addable('venice') });
          }
          if ((input.provider !== 'local' && input.provider !== 'venice' && input.provider !== 'zkapi') || typeof input.model !== 'string' || input.model.trim() === '') {
            throw new EmailSourceWorkerError(400, 'invalid_request', 'Choose a model.');
          }
          const result = await sourceDashboard.modelChoices.save(input.provider, input.model.trim());
          return json(result.ok ? result : { ok: false, error: { code: 'model_choice_failed', message: result.message } }, result.ok ? 200 : 409);
        }

        // Settings › Back up and restore (#1065): the unlocked dashboard on this computer only.
        if (request.method === 'POST' && (DASHBOARD_BACKUP_PATHS as readonly string[]).includes(url.pathname)) {
          if (!request.headers.has(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) || request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            return json({ ok: false, error: { code: 'local_dashboard_only', message: 'Back up and restore only in an unlocked dashboard on this computer.' } }, 403);
          }
          if (!sourceDashboard?.backup) return json({ ok: false, error: { code: 'not_available', message: 'Backups are not available on this install.' } }, 501);
          const outcome = await handleDashboardBackupRoute(url.pathname, await parseObjectBody(request), { backup: sourceDashboard.backup });
          return new Response(JSON.stringify(outcome.body), { status: outcome.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
        }
        if (request.method === 'POST' && (url.pathname === DASHBOARD_SETTINGS_PROPOSAL_APPLY_PATH || url.pathname === DASHBOARD_SETTINGS_PROPOSAL_DISCARD_PATH)) {
          if (!request.headers.has(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) || request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            return json({ ok: false, error: { code: 'local_dashboard_only', message: 'Apply proposed settings in an unlocked dashboard on this computer.' } }, 403);
          }
          if (!settingsProposal) throw new EmailSourceWorkerError(501, 'not_available', 'Proposed settings are unavailable.');
          const input = await parseObjectBody(request);
          if (typeof input.id !== 'string' || input.id === '') throw new EmailSourceWorkerError(400, 'invalid_request', 'Refresh the page to see the current proposal.');
          if (url.pathname === DASHBOARD_SETTINGS_PROPOSAL_DISCARD_PATH) {
            return settingsProposal.discard(input.id)
              ? json({ ok: true, status_message: 'Discarded. Nothing was changed.' })
              : json({ ok: false, error: { code: 'proposal_changed', message: 'This proposal was replaced or already handled. Refresh the page.' } }, 409);
          }
          const applied = await settingsProposal.apply(input.id);
          if (!applied) return json({ ok: false, error: { code: 'proposal_changed', message: 'This proposal was replaced or already handled. Refresh the page.' } }, 409);
          const failed = applied.rows.filter((row) => !row.applied);
          return json({
            ok: true,
            rows: applied.rows,
            status_message: failed.length === 0
              ? `Applied ${applied.rows.length} ${applied.rows.length === 1 ? 'change' : 'changes'}.`
              : `Applied ${applied.rows.length - failed.length} of ${applied.rows.length}. Not applied: ${failed.map((row) => `${row.label} (${row.message ?? 'not saved'})`).join('; ')}.`,
          }, failed.length === 0 ? 200 : 409);
        }

        if (request.method === 'POST' && url.pathname === '/dashboard/models/judge') {
          if (!request.headers.has(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) || request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            return json({ ok: false, error: { code: 'local_dashboard_only', message: 'Choose this in an unlocked dashboard on this computer.' } }, 403);
          }
          const input = await parseObjectBody(request);
          if (!JUDGE_CHOICES.includes(input.choice as JudgeChoice) || typeof input.cap_dollars !== 'number' || !Number.isFinite(input.cap_dollars) || input.cap_dollars < 0) {
            throw new EmailSourceWorkerError(400, 'invalid_request', 'Choose a judge and enter a spending limit in dollars.');
          }
          if (!sourceDashboard?.judgeSetup) throw new EmailSourceWorkerError(501, 'not_available', 'Judge setup is unavailable.');
          try { return json(await sourceDashboard.judgeSetup.save(input.choice as JudgeChoice, input.cap_dollars)); }
          catch (error) { return json({ ok: false, error: { code: 'judge_setup_failed', message: error instanceof Error ? error.message : 'The judge choice could not be saved.' } }, 409); }
        }

        if (request.method === 'POST' && url.pathname === '/dashboard/engine/go-easy') {
          if (!request.headers.has(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) || request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            return json({ ok: false, error: { code: 'local_dashboard_only', message: 'Choose this in an unlocked dashboard on this computer.' } }, 403);
          }
          const input = await parseObjectBody(request);
          if (typeof input.on !== 'boolean') throw new EmailSourceWorkerError(400, 'invalid_request', 'Choose whether to go easy on this computer.');
          if (!sourceDashboard?.goEasy) throw new EmailSourceWorkerError(501, 'not_available', 'This setting is unavailable.');
          try { return json(sourceDashboard.goEasy.save(input.on)); }
          catch { return json({ ok: false, error: { code: 'go_easy_failed', message: 'The setting could not be saved. Try again.' } }, 409); }
        }

        if (request.method === 'POST' && (url.pathname === DASHBOARD_SELF_UPDATE_PATHS.start || url.pathname === DASHBOARD_SELF_UPDATE_PATHS.status)) {
          if (!request.headers.has(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) || request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            return json({ ok: false, error: { code: 'local_dashboard_only', message: DASHBOARD_SELF_UPDATE_LOCAL_ONLY } }, 403);
          }
          if (!options.selfUpdate) return json({ ok: false, error: { code: 'not_available', message: DASHBOARD_UPDATE_COPY.refusals.not_available } }, 409);
          if (url.pathname === DASHBOARD_SELF_UPDATE_PATHS.status) return json({ ok: true, update: options.selfUpdate.status() });
          const started = options.selfUpdate.start();
          return started.ok
            ? json({ ok: true, update: started.status })
            : json({ ok: false, error: { code: started.refusal, message: DASHBOARD_UPDATE_COPY.refusals[started.refusal] } }, 409);
        }

        if (request.method === 'POST' && url.pathname === '/dashboard/engine/computer-use') {
          if (!request.headers.has(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) || request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            return json({ ok: false, error: { code: 'mac_dashboard_only', message: 'Open dashboard controls on this Mac before changing how Olympus runs.' } }, 403);
          }
          const input = await parseObjectBody(request);
          if (typeof input.choice !== 'string' || !['everyday', 'server'].includes(input.choice)) throw new EmailSourceWorkerError(400, 'invalid_request', 'Choose how this computer will run.');
          if (!sourceDashboard?.saveComputerUseChoice || !sourceDashboard.computerSetup?.().engine_server_mode) {
            return json({ ok: false, error: { code: 'not_available', message: 'This setting is available in the standalone Olympus app on a Mac.' } }, 409);
          }
          try { return json(sourceDashboard.saveComputerUseChoice(input.choice as 'everyday' | 'server')); }
          catch (error) { return json({ ok: false, error: { code: 'server_mode_failed', message: error instanceof Error ? error.message : 'Olympus could not change this setting. Try again in Keys.' } }, 409); }
        }

        if (request.method === 'POST' && url.pathname === '/dashboard/models/first-run-privacy') {
          if (!request.headers.has(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) || request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            return json({ ok: false, error: { code: 'mac_dashboard_only', message: 'Choose this on the computer in an unlocked dashboard.' } }, 403);
          }
          if (sourceDashboard?.computerSetup?.().computer_use_pending) return json({ ok: false, error: { code: 'computer_choice_pending', message: 'Choose how this computer will run first.' } }, 409);
          const input = await parseObjectBody(request);
          if (typeof input.choice !== 'string' || !SOVEREIGNTY_PRESETS.includes(input.choice as SovereigntyPresetName)) {
            throw new EmailSourceWorkerError(400, 'invalid_request', 'Choose a Private-answer mode.');
          }
          if (!sourceDashboard?.saveFirstRunPrivacyChoice?.(input.choice as SovereigntyPresetName)) {
            return json({ ok: false, error: { code: 'privacy_choice_changed', message: 'This choice was already made or the policy changed. Refresh to see the current setting.' } }, 409);
          }
          return json({ ok: true, status_message: 'Choice saved. Olympus is applying it.' });
        }

        if (request.method === 'POST' && ['/dashboard/models/local/discover', '/dashboard/models/local/test', '/dashboard/models/local/save'].includes(url.pathname)) {
          if (!request.headers.has(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) || request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            return json({ ok: false, error: { code: 'mac_dashboard_only', message: 'Check local models in an unlocked dashboard on this computer.' } }, 403);
          }
          const input = await parseObjectBody(request);
          if (url.pathname.endsWith('/discover')) {
            if (!sourceDashboard?.discoverLocalModels) throw new EmailSourceWorkerError(501, 'model_setup_not_supported', 'Local model discovery is unavailable.');
            if (input.base_url !== undefined && typeof input.base_url !== 'string') throw new EmailSourceWorkerError(400, 'invalid_request', 'Enter a loopback URL.');
            const results = await sourceDashboard.discoverLocalModels(typeof input.base_url === 'string' && input.base_url.trim() ? input.base_url.trim() : undefined);
            return json({ ok: true, results });
          }
          if (typeof input.base_url !== 'string' || typeof input.answer_model !== 'string') throw new EmailSourceWorkerError(400, 'invalid_request', 'Choose a server and answer model.');
          if (url.pathname.endsWith('/save')) {
            if (!sourceDashboard?.saveLocalAnswerModel) throw new EmailSourceWorkerError(501, 'model_setup_not_supported', 'Local model saving is unavailable.');
            const result = await sourceDashboard.saveLocalAnswerModel({ baseUrl: input.base_url, answerModel: input.answer_model });
            return json(result.ok ? { ok: true, status_message: 'Model saved. Olympus is applying it; check readiness after restart.' } : { ok: false, error: { code: 'model_save_failed', message: result.detail } }, result.ok ? 200 : 409);
          }
          if (!sourceDashboard?.testLocalModels) throw new EmailSourceWorkerError(501, 'model_setup_not_supported', 'Local model testing is unavailable.');
          const result = await sourceDashboard.testLocalModels({ baseUrl: input.base_url, answerModel: input.answer_model });
          return json({ ok: true, result });
        }

        if (request.method === 'POST' && url.pathname === '/dashboard/models/check') {
          if (!sourceDashboard?.checkModelSetup) {
            throw new EmailSourceWorkerError(501, 'model_setup_not_supported', 'This worker does not support model setup checks.');
          }
          // Synthetic model checks are explicit operator work, never dashboard polling.
          // Return promptly; the authoritative Models card receives their result.
          void sourceDashboard.checkModelSetup().catch(() => undefined);
          return json({ ok: true, status_message: 'Readiness check requested. See the Models cards above for the result.' });
        }

        // Private answers (local-private-answers.ts): Ask privately, and
        // Answer, seen, Dismiss and open on a waiting question. Like the
        // consult routes below, it needs the control-session context header
        // of a locally minted session, which only the HTTP boundary sets.
        if (request.method === 'POST' && url.pathname.startsWith('/dashboard/messaging/')) {
          if (!request.headers.get(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) || request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            return json({ ok: false, error: { code: 'mac_dashboard_only', message: 'Pairing opens only in dashboard controls on this computer.' } }, 403);
          }
          const operation = url.pathname.slice('/dashboard/messaging/'.length);
          if (operation !== 'start' && operation !== 'status' && operation !== 'respond' && operation !== 'cancel' && operation !== 'chats' && operation !== 'scope') return json({ ok: false }, 404);
          if (!dashboardMessaging) return json({ ok: false, error: { code: 'messaging_unavailable', message: 'Pairing is unavailable on this computer.' } }, 501);
          try {
            const record = await parseDashboardMessagingBody(request);
            return new Response(JSON.stringify(await dashboardMessaging.handle(operation, record)), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
          } catch {
            return new Response(JSON.stringify({ ok: false, error: { code: 'messaging_request_failed', message: 'Could not complete this pairing step. Try again from this computer.' } }), { status: 400, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
          }
        }

        // What AI apps received: the questions apps asked and the titles they got. Like Private
        // answers, only with the context header of a locally minted control session.
        if (request.method === 'POST' && url.pathname === DASHBOARD_APPS_RECEIVED_ROUTE) {
          if (!request.headers.get(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) || request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            return json({ ok: false, error: { code: 'mac_dashboard_only', message: 'What AI apps received opens only in the dashboard on this computer, in an unlocked browser.' } }, 403);
          }
          if (!sourceDashboard?.appsReceived) {
            throw new EmailSourceWorkerError(501, 'apps_received_not_supported', 'What AI apps received is not available in this worker.');
          }
          const outcome = await sourceDashboard.appsReceived.handle(await parseObjectBody(request));
          return new Response(JSON.stringify(outcome.body), {
            status: outcome.status,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          });
        }

        // People (#1076): Same person, Not the same, Merge, Split, Rename.
        // Local control session only, like Private answers below.
        if (request.method === 'POST' && url.pathname === DASHBOARD_PEOPLE_PATH) {
          if (!request.headers.get(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) || request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            return json({ ok: false, error: { code: 'mac_dashboard_only', message: 'People opens only in the dashboard on this computer, in an unlocked browser.' } }, 403);
          }
          if (!sourceDashboard?.people) {
            throw new EmailSourceWorkerError(501, 'people_not_supported', 'People is not available in this worker yet.');
          }
          const record = await parseObjectBody(request);
          const outcome = sourceDashboard.people.handle(record);
          return new Response(JSON.stringify(outcome.body), { status: outcome.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
        }

        if (request.method === 'POST' && url.pathname === DASHBOARD_PRIVATE_ANSWERS_PATH) {
          const csrf = request.headers.get(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER);
          if (!csrf || request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            return json({ ok: false, error: { code: 'mac_dashboard_only', message: 'Private answers open only in the dashboard on this computer, in an unlocked browser.' } }, 403);
          }
          if (!sourceDashboard?.privateAnswers) {
            throw new EmailSourceWorkerError(501, 'private_answers_not_supported', 'Private answers are not available in this worker.');
          }
          const record = await parseObjectBody(request);
          const outcome = await sourceDashboard.privateAnswers.handle(record, dashboardPanelOpener(request));
          // Private text: never kept by a cache.
          return new Response(JSON.stringify(outcome.body), {
            status: outcome.status,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          });
        }

        // Outside help (consults), the Mac dashboard card's five routes. Every
        // one requires the control-session context header, which the HTTP
        // boundary strips from incoming requests and injects only for these
        // paths after proving the cookie, the origin and the CSRF token; the
        // Gateway bearer is refused there. So an agent tool, the relay, the
        // ChatGPT surface and a bare bearer holder can never reach the writer.
        if (request.method === 'POST' && (DASHBOARD_CONSULT_CONTROL_PATHS as readonly string[]).includes(url.pathname)) {
          if (!request.headers.has(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) || request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            return json({ ok: false, error: { code: 'mac_dashboard_only', message: 'Outside help can be changed only from the dashboard on this computer, in an unlocked browser.' } }, 403);
          }
          if (!sourceDashboard?.consult) {
            throw new EmailSourceWorkerError(501, 'consult_not_supported', 'This worker does not support outside help.');
          }
          const record = await parseObjectBody(request);
          const backend = sourceDashboard.consult;
          const outcome = url.pathname === '/dashboard/consult' ? await backend.setEnabled(record)
            : url.pathname === '/dashboard/consult/route' ? await backend.saveRoute(record)
            : url.pathname === '/dashboard/consult/route/add' ? await backend.addRoute(record)
            : url.pathname === '/dashboard/consult/recover' ? await backend.recover(record)
            : url.pathname === '/dashboard/consult/tools/install' ? await backend.installTools(record)
            : url.pathname === '/dashboard/consult/writer' ? await backend.saveWriter(record)
            : url.pathname === '/dashboard/consult/writer/test' ? await backend.testWriter(record)
            : url.pathname === '/dashboard/consult/standard' ? await backend.saveStandard(record)
            : await backend.abandon(record);
          if (!outcome.ok) {
            return json({ ok: false, error: { code: outcome.code, message: outcome.message }, ...(outcome.revision !== undefined ? { revision: outcome.revision } : {}) }, outcome.httpStatus);
          }
          return json({
            ok: true,
            status_message: outcome.status_message,
            ...(outcome.restarting !== undefined ? { restarting: outcome.restarting } : {}),
            ...(outcome.revision !== undefined ? { revision: outcome.revision } : {}),
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
            assertDashboardModelsReady();
            assertDashboardAccountCardinality(
              readConnectedHandleRegistry(sourceDashboard.registryPath ?? defaultHandleRegistryPath()),
              source,
            );
          }
          const apiKey = asOptionalString(record.api_key);
          if (!apiKey) throw new EmailSourceWorkerError(400, 'invalid_request', 'api_key is required.');
          if (source === 'gemini' || (source === 'venice' && sourceDashboard.connectModelKey)) {
            if (!sourceDashboard.connectModelKey) {
              throw new EmailSourceWorkerError(501, 'model_setup_not_supported', 'Upgrade the worker to connect model keys here.');
            }
            try { await sourceDashboard.connectModelKey(source, apiKey); }
            catch (error) { throw new EmailSourceWorkerError(400, 'model_key_setup_failed', source === 'venice' ? safeVeniceCheckFailure(error) : 'The model key could not be validated or applied. Check the Models card and retry.'); }
            const modelSetup = sourceDashboard.modelSetup?.();
            return json({ ok: true, source, status_message: modelSetup?.ready
              ? 'Model connection ready.'
              : 'Key saved. Finish the remaining model requirements; Olympus applies the keys automatically.' });
          }
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
              source === 'venice' ? safeVeniceCheckFailure(error) : `Validating the ${source} API key failed. Paste a current key and try again, or retry when the provider is reachable.`,
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
            status_message: source === 'readwise' ? 'Connected. Initial sync requested.' : 'Key connected.',
            handles: result.handles.filter((handle) => knownHandles.includes(handle)),
            policy: {
              raw_runtime_secrets_exposed: false,
              api_key_returned: false,
            },
          });
          });
        }

        if (request.method === 'POST' && url.pathname === '/dashboard/sync-now') {
          // Start, then answer at once (2026-10-09). The sync runs outside the
          // grant lock and outside this request: the ChatGPT panel gives up on
          // a tool after 20 s, and a whole library sync held every other
          // dashboard mutation behind it. What it finds is the card's
          // `last_manual_sync`, read on the next refresh.
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
          const schedulerSourceId = dashboardSchedulerSourceId(source);
          const key = schedulerSourceId ?? source;
          const definition = DASHBOARD_SUPPORTED_SOURCES.find((entry) => entry.source_id === schedulerSourceId);
          const label = definition?.sync_name ?? definition?.label ?? 'this source';
          const answer = (status: 'checking' | 'busy' | 'too_soon', statusMessage: string, lastManualSync?: DashboardManualSync) => json({
            ok: true,
            source,
            status,
            ...(lastManualSync ? { last_manual_sync: lastManualSync } : {}),
            status_message: statusMessage,
            policy: {
              raw_runtime_secrets_exposed: false,
              source_text_returned: false,
            },
          });
          // Our own refusals (scope not approved, worker stopping, no lane)
          // are known before anything is read, and answer now, ahead of busy
          // or too soon: a source that cannot sync says so.
          const run = await prepareDashboardSourceSync({ source, reason: 'manual' });
          if (dashboardManualSyncRuns.has(key)) {
            return answer('busy', dashboardManualSyncBusyLine(label));
          }
          const startedAt = Date.now();
          const previous = dashboardManualSyncStarts.get(key);
          if (previous !== undefined && startedAt - previous < DASHBOARD_MANUAL_SYNC_MIN_INTERVAL_MS && startedAt >= previous) {
            return answer('too_soon', dashboardManualSyncTooSoonLine(label));
          }
          const before = sourceScheduler?.status();
          const checking: DashboardManualSync = { at: new Date(startedAt).toISOString(), outcome: 'checking' };
          dashboardManualSyncStarts.set(key, startedAt);
          dashboardManualSyncs.set(key, checking);
          const work = Promise.resolve().then(run).then((result) => {
            assertNoRawEmailFields(result);
            // Stamped when the sync ends, so "Checked just now" is the check's
            // own time and the run's own last_sync_at never supersedes it.
            dashboardManualSyncs.set(key, dashboardManualSyncOutcome({
              result,
              ...(before ? { before } : {}),
              ...(schedulerSourceId ? { schedulerSourceId } : {}),
              at: new Date(),
            }));
          }).catch((error: unknown) => {
            // A provider's or a connector's words are never relayed: the row
            // says why as a closed word, and for a failure Olympus could not
            // classify, the reference the log keeps the rest under.
            const failureKind = manualSyncFailureKind(error);
            const failureRef = failureKind === 'unknown' ? randomBytes(8).toString('hex') : undefined;
            if (failureRef || (!(error instanceof EmailSourceWorkerError) && !(error instanceof OperationError))) {
              logSourceWorkerInternalError(request, error, failureRef);
            }
            dashboardManualSyncs.set(key, {
              at: new Date().toISOString(),
              outcome: 'failed',
              failure_kind: failureKind,
              ...(failureRef ? { failure_ref: failureRef } : {}),
            });
          }).finally(() => { dashboardManualSyncRuns.delete(key); });
          dashboardManualSyncRuns.set(key, work);
          return answer('checking', dashboardManualSyncPendingLine(label), checking);
          });
        }

        // A source on this computer has no sign-in: Connect records that the
        // owner turned it on, and the owner then picks folders. Nothing is
        // read until a folder is approved.
        if (request.method === 'POST' && url.pathname === '/dashboard/connect/this-computer') {
          return await withDashboardGrantMutation(async () => {
          if (!sourceDashboard) {
            throw new EmailSourceWorkerError(
              501,
              'source_dashboard_not_supported',
              'Private source worker does not have the source dashboard configured.',
            );
          }
          const record = await parseObjectBody(request);
          const source = asOptionalString(record.source);
          if (source !== 'local.files') {
            throw new EmailSourceWorkerError(400, 'invalid_request', 'source must name a source on this computer.');
          }
          connectThisComputerSource(sourceDashboard.registryPath ?? defaultHandleRegistryPath(), source);
          await refreshDashboardSchedulerSources();
          return json({
            ok: true,
            source,
            status_message: 'Connected. Choose the folders Olympus may read.',
            policy: { reads_started: false, folders_chosen_by_owner: true },
          });
          });
        }

        if (request.method === 'POST' && url.pathname === '/dashboard/disconnect') {
          const disconnectRecord = await parseObjectBody(request);
          return await withMessagingPairingHeld(disconnectRecord, () => withDashboardGrantMutation(async () => {
          if (!sourceDashboard) {
            throw new EmailSourceWorkerError(
              501,
              'source_dashboard_not_supported',
              'Private source worker does not have the source dashboard configured.',
            );
          }
          const record = disconnectRecord;
          if (record.source_id === 'local.files') {
            if (record.acknowledge !== true) {
              throw new EmailSourceWorkerError(
                400,
                'disconnect_confirmation_required',
                'Confirm that Disconnect keeps the files already indexed and only stops Olympus reading this computer.',
              );
            }
            if (sourceScheduler && !sourceDashboard.refreshSchedulerSources) {
              throw new EmailSourceWorkerError(
                501,
                'disconnect_scheduler_refresh_not_supported',
                'Disconnect cannot safely refresh the active scheduler in this worker.',
              );
            }
            // The same refusal as the account sources: an in-flight read is not
            // cancelled by a scheduler refresh, so Disconnect (and the delete
            // custody check that trusts it) waits until the read has ended.
            const localFilesBusy = () => dashboardManualSyncRuns.has('local.files')
              || (sourceScheduler !== undefined
                && dashboardDisconnectHasRunningRead(sourceScheduler, new Set(['local.files'] as V04PublicSourceId[])));
            const busyError = () => new EmailSourceWorkerError(
              409,
              'disconnect_source_busy',
              'This source is finishing a read. Retry Disconnect after the current read completes.',
            );
            if (localFilesBusy()) throw busyError();
            const registryPath = sourceDashboard.registryPath ?? defaultHandleRegistryPath();
            const wasConnected = disconnectThisComputerSource(registryPath, 'local.files');
            if (!wasConnected) {
              throw new EmailSourceWorkerError(409, 'source_not_connected', 'This source is not connected.');
            }
            if (sourceScheduler && sourceDashboard.refreshSchedulerSources) {
              const nextSources = await sourceDashboard.refreshSchedulerSources();
              // A read that started while the rebuild was awaited: put the
              // connection back (folder choices live with the machine id, which
              // Disconnect keeps) and refuse, as above.
              if (localFilesBusy()) {
                connectThisComputerSource(registryPath, 'local.files');
                throw busyError();
              }
              sourceScheduler.updateSources(nextSources);
            }
            return json({
              ok: true,
              source_id: 'local.files',
              disconnected_source_ids: ['local.files'],
              removed_handles: [],
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
          }
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
              // A Sync now no longer holds the grant lock while it reads
              // (2026-10-09), so its run is checked here the way a scheduled
              // read is below: refused, custody untouched, retry when it ends.
              if ([...plan.sourceIds].some((id) => dashboardManualSyncRuns.has(id))) {
                throw new EmailSourceWorkerError(
                  409,
                  'disconnect_source_busy',
                  'This source is finishing a read. Retry Disconnect after the current read completes.',
                );
              }
              if (sourceScheduler && sourceDashboard.refreshSchedulerSources) {
                const removedHandleIds = new Set(plan.handles.map((handle) => handle.handle));
                const remainingHandles = registry.handles.filter((handle) => !removedHandleIds.has(handle.handle));
                const nextSources = await sourceDashboard.refreshSchedulerSources(remainingHandles);
                if (dashboardDisconnectHasRunningRead(sourceScheduler, plan.sourceIds)) {
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
              if (sourceDashboard.stopMessagingCapture) {
                for (const [id, source] of [['telegram.messages', 'telegram'], ['whatsapp.personal.messages', 'whatsapp']] as const) {
                  if (!plan.sourceIds.has(id)) continue;
                  try { await sourceDashboard.stopMessagingCapture(source); }
                  catch { throw new EmailSourceWorkerError(409, 'capture_stop_unconfirmed', 'Capture has not confirmed it stopped. Credentials were retained; retry Disconnect.'); }
                }
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
          }));
        }

        // Delete indexed data: removes what Olympus indexed from a source that
        // is already disconnected (owner request, 2026-10-23). The custody rule is
        // the CLI's (`olympus data delete --source`): Disconnect first, which
        // takes the source out of the scheduler before any store byte goes.
        // Like Disconnect it refuses while a read for the source runs and runs
        // under the grant lock, so a concurrent Connect cannot interleave. The
        // worker holds the source's SQLite files open, so it marks the account
        // `deleting` and restarts, and the boot removes the files before
        // anything opens them; with no supervisor to restart it the route
        // refuses before marking anything.
        if (request.method === 'POST' && url.pathname === '/dashboard/delete-source-data') {
          const mutationRecord = await parseObjectBody(request);
          // A pairing attempt may itself be waiting for the grant lock. Stop it before taking that lock.
          return await withMessagingPairingHeld(mutationRecord, () => withDashboardGrantMutation(async () => {
          if (!sourceDashboard) {
            throw new EmailSourceWorkerError(
              501,
              'source_dashboard_not_supported',
              'Private source worker does not have the source dashboard configured.',
            );
          }
          const record = mutationRecord;
          const sourceId = record.source_id === 'local.files'
            ? 'local.files' as const
            : parseDashboardDisconnectSource(record.source_id);
          if (record.acknowledge !== true) {
            throw new EmailSourceWorkerError(
              400,
              'delete_confirmation_required',
              'Confirm that deleting indexed data cannot be undone and leaves the source\'s files and accounts untouched.',
            );
          }
          const outcome = await deleteSourceDataInWorker(sourceId, { dryRun: false });
          if (!outcome.ok) {
            throw new EmailSourceWorkerError(
              500,
              'delete_failed',
              'Olympus could not delete this source\'s indexed data; it is still there. Retry.',
            );
          }
          return json({
            ok: true,
            source_id: sourceId,
            removed_count: outcome.result.removed.length,
            worker_restarting: outcome.restarting,
            policy: {
              indexed_data_deleted: true,
              source_files_untouched: true,
              provider_grant_revoked: false,
              raw_runtime_secrets_exposed: false,
            },
          });
          }));
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
          const mutationRecord = await parseObjectBody(request);
          // A pairing attempt may itself be waiting for the grant lock. Stop it before taking that lock.
          return await withMessagingPairingHeld(mutationRecord, () => withDashboardGrantMutation(async () => {
          if (!sourceDashboard) {
            throw new EmailSourceWorkerError(
              501,
              'source_dashboard_not_supported',
              'Private source worker does not have the source dashboard configured.',
            );
          }
          const record = mutationRecord;
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
                if (dashboardDisconnectHasRunningRead(sourceScheduler, selectedSourceIds)) {
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
              if (sourceDashboard.stopMessagingCapture) {
                try { await sourceDashboard.stopMessagingCapture(sourceId === 'telegram.messages' ? 'telegram' : 'whatsapp'); }
                catch (error) {
                  if (error instanceof NativeMessagingCaptureOwnerError) {
                    throw new EmailSourceWorkerError(409, 'native_capture_owner_active', error.message);
                  }
                  throw new EmailSourceWorkerError(409, 'capture_stop_unconfirmed', 'Capture has not confirmed it stopped. Pairing files and credentials were retained; retry Unpair.');
                }
              }

              // WhatsApp only: sign this linked device out at WhatsApp while the
              // session still exists, so the phone's Linked devices loses the
              // entry instead of keeping one of its four slots (#761). Telegram's
              // session is a login the owner ends in Telegram's Active sessions.
              let phoneUnlinked: 'removed' | 'offline' | 'failed' | undefined;
              const whatsappSessionDb = sourceId === 'telegram.messages'
                ? undefined
                : session.paths.find((path) => basename(path) === WHATSAPP_SESSION_FILE && artifactPresence(path) !== 'gone');
              if (whatsappSessionDb && sourceDashboard.unlinkWhatsAppDevice) {
                phoneUnlinked = await sourceDashboard.unlinkWhatsAppDevice(dirname(whatsappSessionDb)).catch(() => 'failed' as const);
              }
              const phoneNote = phoneUnlinked === 'offline' || phoneUnlinked === 'failed'
                ? ' Olympus could not reach WhatsApp to remove itself from your phone: remove Olympus in WhatsApp → Settings → Linked devices.'
                : '';

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
                ...(phoneUnlinked ? { phone_unlinked: phoneUnlinked } : {}),
                status_message: complete
                  ? (phoneUnlinked === 'removed' ? 'Unpaired, and removed from your phone\'s linked devices. Waiting for the next refresh.' : 'Unpaired. Waiting for the next refresh.') + phoneNote
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
                  provider_device_still_linked: phoneUnlinked !== 'removed',
                  capture_service_stopped: false,
                  restart_required: false,
                  raw_runtime_secrets_exposed: false,
                },
              });
            },
          );
          }));
        }

        // Importing an archive (archive-import/dashboard.ts): the upload of
        // what the person dropped, their approval, Decline of an agent's
        // request, and Remove. Control routes only (workers/http.ts), never
        // the dash_ read token: only the person at the dashboard hands over,
        // approves or removes. Approve, Decline and Remove take
        // a local-grade session alone, whose grade the boundary injects and
        // nothing else can set: never the worker bearer, nor a session a
        // bearer minted. Every change runs under the grant guard, and hands
        // the scheduler its tasks at once.
        if (request.method === 'POST' && url.pathname.startsWith('/dashboard/archive-import/')) {
          const archiveImports = sourceDashboard?.archiveImports;
          if (!archiveImports) {
            throw new EmailSourceWorkerError(501, 'archive_import_not_supported', 'Importing archives is not set up in this engine.');
          }
          if (request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            throw new EmailSourceWorkerError(
              403,
              'mac_dashboard_only',
              'Archives are chosen, imported, declined and removed only in the dashboard on this computer, in an unlocked browser.',
            );
          }
          // One piece of a file of an upload (a file that fits in one piece is one request): the body IS the piece, streamed to
          // the staging folder as it arrives (archive-import/staging.ts). Same session, origin and CSRF proof as every route here.
          if (url.pathname === '/dashboard/archive-import/upload-file') {
            const header = (name: string): string => request.headers.get(name) ?? '';
            let relPath: string;
            try {
              relPath = decodeURIComponent(header('X-Olympus-Upload-Path'));
            } catch {
              throw new EmailSourceWorkerError(400, 'bad_path', 'The name of the file could not be read.');
            }
            const modified = Number(header('X-Olympus-Upload-Modified'));
            const declared = Number(header('Content-Length'));
            // A large file comes as pieces (staging.ts ARCHIVE_UPLOAD_CHUNK_BYTES): where this one begins, and whether it is the last.
            const offsetHeader = header('X-Olympus-Upload-Offset');
            const offset = offsetHeader === '' ? 0 : Number(offsetHeader);
            const final = header('X-Olympus-Upload-Final') !== '0';
            try {
              const received = await archiveImports.upload.receive(header('X-Olympus-Upload-Id'), relPath, request.body, {
                ...(Number.isFinite(modified) && modified > 0 ? { modified } : {}),
                ...(Number.isFinite(declared) && declared > 0 ? { declaredBytes: declared } : {}),
                offset,
                final,
                signal: request.signal,
              });
              return json({ ok: true, bytes: received.bytes });
            } catch (error) {
              if (error instanceof ArchiveUploadError) throw new EmailSourceWorkerError(error.status, error.code, error.message);
              throw error;
            }
          }
          const record = await parseObjectBody(request);
          if (url.pathname === '/dashboard/archive-import/upload-start') {
            return await withDashboardGrantMutation(async () => json({ ok: true, upload_id: archiveImports.upload.start().uploadId }));
          }
          if (url.pathname === '/dashboard/archive-import/upload-status' || url.pathname === '/dashboard/archive-import/upload-cancel') {
            const uploadId = asOptionalString(record.upload_id);
            if (!uploadId) throw new EmailSourceWorkerError(400, 'invalid_request', 'upload_id is required.');
            try {
              if (url.pathname.endsWith('-cancel')) return json({ ok: true, ...archiveImports.upload.cancel(uploadId) });
              return json({ ok: true, ...archiveImports.upload.status(uploadId) });
            } catch (error) {
              if (error instanceof ArchiveUploadError) throw new EmailSourceWorkerError(error.status, error.code, error.message);
              throw error;
            }
          }
          if (url.pathname === '/dashboard/archive-import/approve') {
            return await withDashboardGrantMutation(async () => {
              assertDashboardModelsReady();
              const uploadId = asOptionalString(record.upload_id);
              const requestId = asOptionalString(record.request_id);
              if ((uploadId === undefined) === (requestId === undefined)) {
                throw new EmailSourceWorkerError(400, 'invalid_request', 'Give either upload_id or request_id.');
              }
              // The owner's answer to "which account is this export of", when asked: at most one.
              const confirmAccount = asOptionalBoolean(record.confirm_account) === true;
              const keepApart = asOptionalBoolean(record.keep_apart) === true;
              if (confirmAccount && keepApart) {
                throw new EmailSourceWorkerError(400, 'invalid_request', 'Give either confirm_account or keep_apart.');
              }
              const answer = { ...(confirmAccount ? { confirmAccount: true as const } : {}), ...(keepApart ? { keepApart: true as const } : {}) };
              // A source's own Import an archive names its card: only that source's exports are taken.
              const sourceId = asOptionalString(record.source_id);
              if (sourceId !== undefined && uploadId === undefined) {
                throw new EmailSourceWorkerError(400, 'invalid_request', 'source_id goes with an upload.');
              }
              return json(await archiveImports.approve(uploadId !== undefined ? { uploadId, ...(sourceId !== undefined ? { sourceId } : {}), ...answer } : { requestId: requestId!, ...answer }));
            });
          }
          if (url.pathname === '/dashboard/archive-import/stop') {
            return await withDashboardGrantMutation(async () => {
              const archiveId = asOptionalString(record.archive_id);
              if (!archiveId) throw new EmailSourceWorkerError(400, 'invalid_request', 'archive_id is required.');
              return json(archiveImports.stop(archiveId));
            });
          }
          if (url.pathname === '/dashboard/archive-import/decline') {
            return await withDashboardGrantMutation(async () => {
              const requestId = asOptionalString(record.request_id);
              if (!requestId) throw new EmailSourceWorkerError(400, 'invalid_request', 'request_id is required.');
              return json(archiveImports.decline(requestId));
            });
          }
          if (url.pathname === '/dashboard/archive-import/remove') {
            return await withDashboardGrantMutation(async () => {
              // An archive, or an agent's request to remove one: either way the person's confirmation, and the same removal.
              const archiveId = asOptionalString(record.archive_id);
              const requestId = asOptionalString(record.request_id);
              if ((archiveId === undefined) === (requestId === undefined)) {
                throw new EmailSourceWorkerError(400, 'invalid_request', 'Give either archive_id or request_id.');
              }
              if (record.acknowledge !== true) {
                throw new EmailSourceWorkerError(
                  400,
                  'remove_confirmation_required',
                  'Confirm that Remove deletes everything Olympus made from this archive, and leaves the file itself where it is.',
                );
              }
              return json(archiveId !== undefined ? archiveImports.remove(archiveId) : archiveImports.approveRemoval(requestId!));
            });
          }
          throw new EmailSourceWorkerError(404, 'not_found', 'No such archive route.');
        }

        // "Check the judge" (judge-check.ts): the owner's answers stay on this
        // computer, and only a session minted here reaches them.
        if (request.method === 'POST' && url.pathname === '/dashboard/privacy/judge-check') {
          if (request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            throw new EmailSourceWorkerError(403, 'mac_dashboard_only', 'Checking the judge happens only in the dashboard on this computer, in an unlocked browser.');
          }
          if (!judgeCheck) {
            throw new EmailSourceWorkerError(501, 'judge_check_not_supported', 'Checking the judge is not set up in this engine.');
          }
          const record = await parseObjectBody(request);
          const action = asOptionalString(record.action);
          try {
            if (action === 'status') return json({ ok: true, round: judgeCheck.status() });
            if (action === 'start') return json({ ok: true, round: judgeCheck.start() });
            if (action === 'put_away') return json({ ok: true, round: judgeCheck.putAway() });
            if (action === 'resume') return json({ ok: true, round: judgeCheck.resume() });
            if (action === 'answer') {
              const itemId = asOptionalString(record.item_id);
              const answer = asOptionalString(record.answer);
              if (!itemId || (answer !== 'Personal' && answer !== 'Private' && answer !== 'not_sure')) {
                throw new EmailSourceWorkerError(400, 'invalid_request', 'item_id and an answer (Personal, Private or not_sure) are required.');
              }
              return json({ ok: true, round: judgeCheck.answer(itemId, answer) });
            }
          } catch (error) {
            if (error instanceof JudgeCheckError) throw new EmailSourceWorkerError(409, error.code, error.message);
            throw error;
          }
          throw new EmailSourceWorkerError(400, 'invalid_request', 'action must be status, start, answer, put_away or resume.');
        }

        // The owner's one-item privacy change on the dashboard's Privacy tab
        // (tier-owner-items.ts): find any item, and set it Personal or
        // Private, or back to the judge's label. Control routes held to a
        // local-grade session (workers/http.ts), never the worker bearer: only
        // the person at this computer lowers an item.
        if (request.method === 'POST' && url.pathname.startsWith('/dashboard/privacy/items/')) {
          if (!ownerTierItems) {
            throw new EmailSourceWorkerError(501, 'privacy_items_not_supported', 'Changing one item\'s privacy is not set up in this engine.');
          }
          if (request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) !== 'local') {
            throw new EmailSourceWorkerError(
              403,
              'mac_dashboard_only',
              'One item\'s privacy label is changed only in the dashboard on this computer, in an unlocked browser.',
            );
          }
          const record = await parseObjectBody(request);
          if (url.pathname === '/dashboard/privacy/items/find') {
            const query = asOptionalString(record.query);
            const recent = asOptionalBoolean(record.recent);
            const limit = asOptionalNumber(record.limit, 'limit');
            const filter = asOptionalString(record.filter);
            if (filter !== undefined && filter !== 'personal' && filter !== 'private' && filter !== 'changed') {
              throw new EmailSourceWorkerError(400, 'invalid_request', 'filter must be "personal", "private" or "changed".');
            }
            return json({ ok: true, ...ownerTierItems.find({
              ...(query !== undefined ? { query } : {}),
              ...(recent !== undefined ? { recent } : {}),
              ...(limit !== undefined ? { limit } : {}),
              ...(filter !== undefined ? { filter } : {}),
              // The owner reads what the item says before deciding, on this computer only.
              withPreview: true,
            }), ...(ownerTierItems.counts ? { counts: ownerTierItems.counts() } : {}) });
          }
          if (url.pathname === '/dashboard/privacy/items/read') {
            const itemId = asOptionalString(record.item_id);
            if (!itemId) throw new EmailSourceWorkerError(400, 'invalid_request', 'item_id is required.');
            if (!options.readOwnerItem) throw new EmailSourceWorkerError(501, 'read_unavailable', 'Reading this file is not available.');
            return json({ ok: true, ...await options.readOwnerItem(itemId) });
          }
          if (url.pathname === '/dashboard/privacy/items/set') {
            const itemId = asOptionalString(record.item_id);
            const tier = asOptionalString(record.tier);
            if (!itemId) throw new EmailSourceWorkerError(400, 'invalid_request', 'item_id is required.');
            if (tier !== 'personal' && tier !== 'private' && tier !== 'judge') {
              throw new EmailSourceWorkerError(400, 'invalid_request', 'tier must be "personal", "private" or "judge".');
            }
            return json(ownerTierItems.set({ itemId, choice: tier satisfies OwnerItemChoice, allowLower: true }));
          }
          throw new EmailSourceWorkerError(404, 'not_found', 'No such privacy item route.');
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
          const record = await parseObjectBody(request);
          const execute = asOptionalBoolean(record.execute);
          const limit = asOptionalNumber(record.limit);
          const contentRecovery = currentXBookmarksRuntime()?.contentRecovery;
          if (!contentRecovery) {
            throw new EmailSourceWorkerError(
              501,
              'x_bookmarks_content_recovery_not_supported',
              'Private source worker does not support X bookmark content recovery.',
            );
          }
          const result = await contentRecovery.recover({
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
          assertFileSourceSyncApproved(schedulerSourceId);
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
            const readwiseConnectorStoreSync = currentReadwiseSync();
            if (!readwiseConnectorStoreSync) {
              throw new EmailSourceWorkerError(501, 'source_index_sync_not_supported', 'Readwise connector-store sync is not configured.');
            }
            const result = await readwiseConnectorStoreSync.sync();
            assertNoRawEmailFields(result);
            return json(result);
          }
          if (corpusId === X_BOOKMARKS_CORPUS_ID) {
            const mode = asOptionalString(record.mode) ?? 'reconcile';
            if (mode !== 'head' && mode !== 'reconcile' && mode !== 'window_diagnostic' && mode !== 'import_archive') {
              throw new EmailSourceWorkerError(
                400,
                'invalid_request',
                'mode must be head, reconcile, window_diagnostic, or import_archive for X bookmarks sync.',
              );
            }
            const archivePath = asOptionalString(record.archive_path);
            if (mode === 'import_archive' && !archivePath) {
              throw new EmailSourceWorkerError(400, 'invalid_request', 'archive_path is required to import archived X bookmarks.');
            }
            const xSync = currentXBookmarksRuntime()?.sync;
            if (!xSync) {
              throw new EmailSourceWorkerError(501, 'source_index_sync_not_supported', 'X bookmarks connector-store sync is not configured.');
            }
            if (mode === 'import_archive' && !xSync.importArchive) {
              throw new EmailSourceWorkerError(501, 'source_index_sync_not_supported', 'X bookmarks archive import is not configured.');
            }
            if (mode === 'window_diagnostic' && !xSync.diagnoseWindow) {
              throw new EmailSourceWorkerError(501, 'source_index_sync_not_supported', 'X bookmarks window diagnostics are not configured.');
            }
            try {
              const result = mode === 'head'
                ? await xSync.syncHead({ provenance: 'operator' })
                : mode === 'reconcile'
                  ? await xSync.reconcile({ provenance: 'operator' })
                  : mode === 'import_archive'
                    ? await xSync.importArchive!({ archive_path: archivePath! })
                    : await xSync.diagnoseWindow!({ provenance: 'operator' });
              const safeResult = xBookmarksLiveAdminResult(mode, result);
              assertNoRawEmailFields(safeResult);
              return json(safeResult);
            } catch (error) {
              if (error instanceof XBookmarksArchiveImportError) {
                throw new EmailSourceWorkerError(400, 'invalid_request', error.message);
              }
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
                api_usage: xSync.apiUsageStatus(),
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
          options.authorizeFileExtractionLane?.(lane);
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

        if (request.method === 'POST' && url.pathname === `${basePath}/source/index/files/read-on-demand`) {
          const record = await parseObjectBody(request);
          const item = record.itemRef as Record<string, unknown> | undefined;
          const corpusId = item && asOptionalString(item.corpusId);
          const providerItemId = item && asOptionalString(item.providerItemId);
          const questionId = asOptionalString(record.questionId);
          const requester = record.requester;
          if (!corpusId || !providerItemId || (requester !== 'analyst' && requester !== 'remote_app')) {
            throw new EmailSourceWorkerError(400, 'invalid_request', 'A read requires an item reference and an analyst or remote_app requester.');
          }
          if (!options.requestOnDemandRead) return json({ state: 'refused', reason: 'read_unavailable' });
          return json(await options.requestOnDemandRead({ itemRef: { corpusId, providerItemId }, requester, ...(questionId ? { questionId } : {}) }));
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/index/files/plan`) {
          const runner = requireFileExtractionRunner(fileExtraction);
          const record = await parseObjectBody(request);
          const lane = parseFileExtractionLaneRecord(record, filesAliasLane, runner);
          options.authorizeFileExtractionLane?.(lane);
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
          options.authorizeFileExtractionLane?.(lane);
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
          options.authorizeFileExtractionLane?.(lane);
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
          options.authorizeFileExtractionLane?.(lane);
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

        // The owner's word to extract the PDF backlog now rather than at the
        // scheduler's trickle. Bounded per call; the CLI repeats it.
        if (request.method === 'POST' && url.pathname === `${basePath}/source/index/files/extract-pdfs`) {
          const runner = requireFileExtractionRunner(fileExtraction);
          const record = await parseObjectBody(request);
          const maxSeconds = Math.min(
            Math.max(1, Math.floor(asOptionalNumber(record.max_seconds, 'max_seconds') ?? 240)),
            900,
          );
          const lanes = await drainPdfExtraction({
            runner,
            lanes: pdfExtractionLanes?.() ?? [],
            ...(pdfExtractionLaneScopeApproved ? { laneScopeApproved: pdfExtractionLaneScopeApproved } : {}),
            requeue: record.requeue === true,
            deadlineMs: Date.now() + maxSeconds * 1_000,
            extractorKind: TEXT_EXTRACTOR_KIND,
          });
          const body = {
            kind: 'pdf_extraction_drain',
            lanes: lanes.map((lane) => ({
              corpus_id: lane.corpusId,
              provider: lane.provider,
              scope_key_hash: lane.scopeKeyHash,
              candidates_requeued: lane.candidatesRequeued,
              jobs_processed: lane.jobsProcessed,
              jobs_indexed: lane.jobsIndexed,
              jobs_metadata_only: lane.jobsMetadataOnly,
              jobs_failed: lane.jobsFailed,
              jobs_remaining: lane.jobsRemaining,
              paused: lane.paused,
              ...(lane.pauseReason ? { pause_reason: lane.pauseReason } : {}),
            })),
            policy: { worker_private_surface: true, source_text_returned: false },
          };
          assertNoRawEmailFields(body);
          return json(body);
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/index/files/status`) {
          const runner = requireFileExtractionRunner(fileExtraction);
          const record = await parseObjectBody(request);
          const lane = parseFileExtractionLaneRecord(record, filesAliasLane, runner);
          options.authorizeFileExtractionLane?.(lane);
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

        if (request.method === 'POST' && url.pathname === `${basePath}/source/item/read`) {
          const record = await parseObjectBody(request);
          const selected = sourceItemReadSelectedItem(record.selected_item);
          const page = sourceItemReadPage(record.page, 'page');
          const pages = sourceItemReadPage(record.pages, 'pages', 3);
          const store = connectorStoresByCorpusId.get(selected.corpus_id);
          const refused = { pages: [], totalPages: 0, totalChars: 0, couldNotRead: ['not_in_scope'] };
          if (!store || selected.family !== store.family) return json(refused);
          const identity = store.activeLocalItemRow(selected.local_item_id)?.identity;
          if (!identity || identity.provider !== selected.provider || identity.accountScope !== selected.account_scope
            || identity.providerItemId !== selected.provider_item_id
            || identity.providerConversationId !== selected.provider_conversation_id) return json(refused);
          const result = await store.readItemPages(selected.local_item_id, {
            page, pages, releaseCheck: options.sourceAnswerReleaseCheck,
            scope: () => {
              const scope = connectorStoreReadScope?.(store);
              if (scope?.allowed === false) return scope;
              const principal = connectorStorePrincipals.get(store.corpusId);
              return { allowed: true, ...scope,
                accountScope: scope?.accountScope ?? connectorStoreAccountScopes.get(store.corpusId) ?? principal?.accountScope,
                ...(principal ? { filters: { ...scope?.filters, provider: principal.provider } } : {}),
              };
            },
          });
          if (currentRemoteReadAccess() !== 'active') return json(refused);
          if (result.couldNotRead.length === 1 && result.couldNotRead[0] === 'names_only' && options.requestOnDemandRead) {
            Object.assign(result, await itemReadOnDemand(options.requestOnDemandRead, store.corpusId, selected.provider_item_id));
          }
          if (result.couldNotRead.includes('not_personal')) throw new EmailSourceWorkerError(403, 'not_personal', 'Private item: ask with source_answer');
          assertNoRawEmailFields(result);
          assertNoSourceIndexOperationalLeakFields(result);
          return json(result);
        }

        if (request.method === 'POST' && url.pathname === `${basePath}/source/index/search`) {
          const record = await parseObjectBody(request);
          assertSourceIndexSearchQuery(record.query);
          const corpusId = canonicalRequestCorpusId(record);
          const connectorStore = corpusId ? connectorStoresByCorpusId.get(corpusId) : undefined;
          if (connectorStore) {
            const searchConnectorStore = async (store: LocalConnectorStore) => {
              const mandatoryScope = connectorStoreReadScope?.(store);
              if (mandatoryScope?.allowed === false) return undefined;
              const searchRequest = parseConnectorStoreIndexSearchRequestRecord(
                // A sibling tier is searched under its own corpus id.
                store === connectorStore ? record : { ...record, corpus_id: store.corpusId },
                store,
                connectorStoreAccountScopes.get(store.corpusId),
                store.family === 'chat'
                  ? connectorStorePrincipals.get(store.corpusId)
                  : undefined,
                connectorStorePrincipals.get(store.corpusId),
                connectorStoreFilterCapabilities,
              );
              const connectorStoreEmbeddingProvider = connectorStoreEmbeddingProviders.get(store.corpusId)
                ?? sourceIndexEmbeddingProvider;
              const searchEmbeddingProvider = connectorStoreEmbeddingProvider
                && (store.trustDomain !== 'secure_local'
                  || isApprovedSecureSourceEmbeddingProvider(connectorStoreEmbeddingProvider))
                ? connectorStoreEmbeddingProvider
                : undefined;
              // An unpinned request gets hybrid exactly when this corpus can
              // serve it (an approved provider with current embeddings), so a
              // content match found semantically is not lost behind lexical
              // title noise. Without embeddings it stays keyword, with no
              // skipped-lane marker for a lane nobody asked for.
              const retrievalMode = searchRequest.retrievalMode
                ?? (searchEmbeddingProvider && store.vectorLaneServable(searchEmbeddingProvider.modelId)
                  ? 'hybrid'
                  : 'keyword');
              const combinedFilters = searchRequest.filters || mandatoryScope?.filters
                ? normalizeConnectorStoreSearchFilters({
                    ...searchRequest.filters,
                    ...mandatoryScope?.filters,
                  })
                : undefined;
              const adapter = createConnectorStoreCorpusAdapter({
                store,
                retrievalMode,
                ...(mandatoryScope?.allowed === true && mandatoryScope.accountScope
                  ? { accountScope: mandatoryScope.accountScope }
                  : searchRequest.accountScope ? { accountScope: searchRequest.accountScope } : {}),
                ...(combinedFilters ? { filters: combinedFilters } : {}),
                ...(searchRequest.resultProjector ? { resultProjector: searchRequest.resultProjector } : {}),
                ...(searchEmbeddingProvider ? { embeddingProvider: searchEmbeddingProvider } : {}),
              });
              const result = await retrySqliteBusy(() => adapter({
                query: searchRequest.query,
                maxResults: searchRequest.maxResults,
                corpus: defineConnectorCorpus({
                  corpusId: store.corpusId,
                  family: store.family,
                  trustDomain: store.trustDomain,
                }),
                context: {
                  allowedTrustDomains: [store.trustDomain],
                  allowedCorpusIds: [store.corpusId],
                },
              }));
              const accountScope = mandatoryScope?.allowed === true && mandatoryScope.accountScope
                ? mandatoryScope.accountScope
                : searchRequest.accountScope;
              return {
                store,
                searchRequest,
                result,
                scope: {
                  corpusId: store.corpusId,
                  ...(accountScope ? { accountScope } : {}),
                  ...(combinedFilters ? { filters: combinedFilters } : {}),
                },
              };
            };
            const primary = await searchConnectorStore(connectorStore);
            if (!primary) {
              throw new EmailSourceWorkerError(
                403,
                'source_index_policy_violation',
                'This file source is unavailable until its folder scope is approved for the connected account.',
              );
            }
            const searchRequest = primary.searchRequest;
            // Every tier of the named source (design section 5), unless the
            // caller pinned this one corpus with `all_tiers: false`. A sibling
            // that does not exist yet (an on-demand Public store) or whose
            // scope is not approved is simply not searched.
            // An explicit trust_domain is a single-corpus consistency check,
            // so it pins the search as `all_tiers: false` does.
            const siblings = record.all_tiers === false || record.trust_domain !== undefined
              ? []
              : (options.connectorStoreTierSiblings?.(connectorStore.corpusId) ?? [])
                .flatMap((siblingCorpusId) => {
                  const sibling = connectorStoresByCorpusId.get(siblingCorpusId);
                  return sibling && sibling !== connectorStore ? [sibling] : [];
                });
            const siblingRuns: Array<NonNullable<Awaited<ReturnType<typeof searchConnectorStore>>>> = [];
            for (const sibling of siblings) {
              const run = await searchConnectorStore(sibling);
              if (run) siblingRuns.push(run);
            }
            const runs = [primary, ...siblingRuns];
            const tiered = siblingRuns.length > 0;
            const tagged = runs.flatMap((run) => run.result.hits.map((hit) => ({
              ...hit,
              corpusId: run.store.corpusId,
              trustDomain: run.store.trustDomain,
            })));
            // One tier-ledger snapshot judges every tier's hits together, and
            // a single pinned corpus (`all_tiers: false`) too: an item whose
            // copy here is no longer current (re-tiered, Secret) is never
            // returned, whatever the store's own filter says.
            const visible = new Set(options.sourceIndexVisibilityGate
              ? options.sourceIndexVisibilityGate(tagged)
              : tagged);
            // A hit is Private by the one definition (isSecureSensitivity):
            // its store's domain or its row's own tier. A hit with no tier is
            // judged Private (every connector-store hit carries one).
            const hitIsPrivate = (hit: (typeof tagged)[number]): boolean => hit.trustTier === undefined
              || isSecureSensitivity({ trustDomain: hit.trustDomain, trustTier: hit.trustTier });
            // A search that read no secure_local store did not ask for Private
            // results, so a Personal store's row that is Private by its own
            // tier (an S4 row a lane placed there) is withheld from it, as
            // olympus_search withholds it: counted, never listed. A search
            // that did read a secure_local store already returns Private
            // titles under local_only, and returns this one the same way.
            const searchedSecureLocal = runs.some((run) => run.store.trustDomain === 'secure_local');
            let privateTierWithheld = 0;
            if (!searchedSecureLocal) {
              for (const hit of [...visible]) {
                if (!hitIsPrivate(hit)) continue;
                visible.delete(hit);
                privateTierWithheld += 1;
              }
            }
            // Round-robin across tiers, so a full page from one tier cannot
            // starve another, then the request's own bound.
            const perRun = runs.map((run) => tagged.filter((hit) => hit.corpusId === run.store.corpusId && visible.has(hit)));
            const merged: typeof tagged = [];
            for (let rank = 0; merged.length < searchRequest.maxResults && perRun.some((hits) => hits.length > rank); rank += 1) {
              for (const hits of perRun) {
                const hit = hits[rank];
                if (hit && merged.length < searchRequest.maxResults) merged.push(hit);
              }
            }
            const hits = tiered ? merged : tagged.filter((hit) => visible.has(hit));
            const secretLocations = tiered
              ? options.secretLocationSearch?.(searchRequest.query, runs.map((run) => run.scope)) ?? []
              : [];
            const locatorsExposed = hits.some((hit) => (
              Object.prototype.hasOwnProperty.call(hit, 'locator')
            ));
            const pendingPrivacy = readPendingPrivacyItems(options);
            const safeResult = {
              kind: 'source_index_search',
              corpus_id: connectorStore.corpusId,
              retrieval_source: 'local_index',
              // A hit's own tier is retrieval-internal (router.ts): not returned.
              hits: hits.map(({ corpusId: hitCorpusId, trustDomain: _hitTrustDomain, trustTier: _hitTrustTier, keywordLeader: _hitKeywordLeader, newestInStore: _hitNewestInStore, ...hit }) => (
                addSelectedItemToSearchHit(hitCorpusId, hit)
              )),
              ...(secretLocations.length > 0
                ? {
                    // Location only, beside the hits: never content.
                    secret_locations: secretLocations.map((location) => ({
                      source: location.source,
                      ref: location.ref,
                      ...(location.locator ? { locator: location.locator } : {}),
                      ...(location.title ? { title: location.title } : {}),
                      finding_kinds: [...location.findingKinds],
                    })),
                  }
                : {}),
              audit: {
                request_id: `${connectorStore.corpusId}:connector-store-search`,
                retrieval_source: 'local_index',
                queries_attempted: runs.length,
                metadata_hits: hits.length,
                items_returned: hits.length,
                latency_ms: runs.reduce((total, run) => total + run.result.latencyMs, 0),
                ...(tiered ? { searched_corpora: runs.map((run) => run.store.corpusId) } : {}),
                ...(searchRequest.explicitEmptyChatScope
                  ? {}
                  : { lane_audits: runs.flatMap((run) => run.result.laneAudits ?? []) }),
                raw_source_exposed: false,
                source_text_returned: false,
                ...(searchRequest.locatorsRequested ? { locators_requested: true } : {}),
                ...(privateTierWithheld > 0 ? { private_tier_withheld: privateTierWithheld } : {}),
                // A count only (local callers alone reach this route): the
                // plugin turns it into the local privacy-backlog note.
                ...(pendingPrivacy !== undefined && pendingPrivacy > 0 ? { pending_privacy_items: pendingPrivacy } : {}),
              },
              policy: {
                raw_source_exposed: false,
                source_text_returned: false,
                source_packets_exposed: false,
                // Decided from the hits' own sensitivity before their tier is
                // stripped, not from store domains alone.
                local_only: searchRequest.explicitEmptyChatScope
                  || searchedSecureLocal
                  || hits.some(hitIsPrivate),
                // The most private tier this search read, not the named
                // corpus's: a tiered result may carry Private hits.
                trust_domain: mostPrivateTrustDomain(runs.map((run) => run.store.trustDomain)),
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
            const embeddingScope = connectorStore.family === 'file'
              ? requireCurrentFileEmbeddingScope(connectorStore, connectorStoreReadScope)
              : undefined;
            const assertEmbeddingScopeCurrent = embeddingScope
              ? () => {
                  const current = requireCurrentFileEmbeddingScope(connectorStore, connectorStoreReadScope);
                  if (current.signature !== embeddingScope.signature) {
                    throw new EmailSourceWorkerError(
                      403,
                      'source_index_policy_violation',
                      'The approved file-content scope changed before embedding dispatch; retry under the current approval.',
                    );
                  }
                }
              : undefined;
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
            let result: Awaited<ReturnType<typeof connectorStore.embedChunks>>;
            try {
              result = await connectorStore.embedChunks({
                provider: embeddingProvider,
                ...(embeddingScope?.accountScope ? { accountScope: embeddingScope.accountScope } : {}),
                ...(embeddingScope?.filters ? { filters: embeddingScope.filters } : {}),
                ...(assertEmbeddingScopeCurrent ? { assertAuthorized: assertEmbeddingScopeCurrent } : {}),
                ...(modelId ? { modelId } : {}),
                ...(maxPendingChunks !== undefined ? { limit: maxPendingChunks } : {}),
              });
            } catch (error) {
              // Another embedder (the scheduler's sweep) holds this store's
              // embedding lease: a retryable wait, not a failure of the caller.
              if (error instanceof FileLeaseBusyError) {
                throw new EmailSourceWorkerError(
                  409,
                  'embedding_lane_busy',
                  `Another embedder is embedding ${connectorStore.corpusId}; retry shortly.`,
                );
              }
              throw error;
            }
            assertNoRawEmailFields(result);
            return json(result);
          }
          throw new EmailSourceWorkerError(
            501,
            'source_index_embedding_not_supported',
            `The connector store for ${corpusId} is not mounted.`,
          );
        }
        return workerRouteNotFound();
      } catch (error) {
        const failedUrl = new URL(request.url);
        if (request.method === 'GET' && failedUrl.pathname === '/dashboard' && dashboardHtmlRoutePage(failedUrl) === 'help') {
          console.warn('[olympus] support_source_status_unavailable');
          return renderHelp(request, failedUrl);
        }
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

  function renderHelp(request: Request, url: URL, sources: readonly SourceSupportState[] = []): Response {
    const csrf = request.headers.get(DASHBOARD_CONTROL_CSRF_CONTEXT_HEADER) ?? undefined;
    let system: SystemSupportFacts | undefined;
    if (csrf && request.headers.get(DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER) === 'local') {
      try { system = sourceDashboard?.systemReport?.(); } catch { /* Help remains usable when system facts cannot be read. */ }
    }
    return html(renderDashboardLocalPage('help', { url, options: {
      ...(csrf ? { controlSessionCsrfToken: csrf } : {}),
      ...(system ? { systemReport: systemSupportReport({ ...system, sources }) } : {}),
    } }));
  }

  function assertDashboardModelsReady(): void {
    if (sourceDashboard?.modelSetup && !sourceDashboard.modelSetup().ready) {
      throw new EmailSourceWorkerError(409, 'model_setup_required', 'Finish model setup at the top of Setup before connecting sources or starting ingestion.');
    }
  }

  /**
   * `olympus data delete --source` while this worker owns the data: the
   * dashboard's delete (below), by id and with `--dry-run`.
   */
  async function deleteSourceDataForCli(body: Record<string, unknown>): Promise<unknown> {
    const sourceId = requireSource(typeof body.source_id === 'string' ? body.source_id : undefined).sourceId;
    const dryRun = body.dry_run === true;
    const outcome = dryRun
      ? await deleteSourceDataInWorker(sourceId, { dryRun })
      : await withDashboardGrantMutation(() => deleteSourceDataInWorker(sourceId, { dryRun }));
    if (!outcome.ok) {
      // The delete's own refusal reads as it does at the command line.
      if (outcome.error instanceof OperationError) throw outcome.error;
      throw new EmailSourceWorkerError(
        500,
        'delete_failed',
        'Olympus could not delete this source\'s indexed data; it is still there. Retry.',
      );
    }
    return { ...outcome.result, worker_restarting: outcome.restarting };
  }

  /**
   * Delete one source's indexed data from inside the running worker, under the
   * custody rule of the CLI's `data delete --source`: Disconnect (or Unpair)
   * first. The one delete the dashboard's "Delete source data" and the CLI,
   * while Olympus runs, both go through. The worker holds the source's SQLite
   * files open, so a real delete forgets the account's shared rows, marks it
   * `deleting` and restarts the worker, whose boot removes its files before
   * anything mounts (data-lifecycle.ts, `deleteMarkedAccounts`); with no
   * supervisor to restart it this refuses before changing anything. A dry run
   * changes nothing, so it needs neither the restart nor an idle source.
   */
  async function deleteSourceDataInWorker(
    sourceId: string,
    options: { dryRun: boolean },
  ): Promise<
    | { ok: true; result: DataDeleteWithCustodyResult; restarting: boolean }
    | { ok: false; error: unknown; restarting: boolean }
  > {
    const registryPath = sourceDashboard?.registryPath ?? defaultHandleRegistryPath();
    const pathContext: LifecyclePathContext = {
      ...(sourceDashboard?.dataLifecyclePathContext ?? { env: process.env }),
      // The forget registry reads the config files beside this registry.
      handleRegistryPath: registryPath,
    };
    const custodyInputFor = () => ({
      sourceId,
      connectedRegistry: readConnectedHandleRegistry(registryPath),
      thisComputerSources: readThisComputerHandles(registryPath).map((handle) => handle.handle.replace(/\.this_computer$/, '')),
      // A paired-session source (Telegram, WhatsApp) is disconnected
      // only after a clean Unpair, which the durable record carries.
      unpairedSources: readReconciledUnpairedSources(registryPath),
    });
    if (options.dryRun) {
      return {
        ok: true,
        result: deleteOlympusDataWithCustody({ ...custodyInputFor(), ...pathContext, dryRun: true }),
        restarting: false,
      };
    }
    const restart = sourceDashboard?.workerRestart;
    if (!sourceDashboard || !restart || !restart.canRestart()) {
      throw new EmailSourceWorkerError(
        501,
        'delete_reopen_unavailable',
        'Olympus cannot restart its worker to reopen its stores here, so it will not delete indexed data while it is running. Nothing was deleted.',
      );
    }
    return await withConnectedHandleGrantCustody(registryPath, {}, async () => {
      const busy = () => dashboardManualSyncRuns.has(sourceId)
        || (sourceScheduler !== undefined
          && dashboardDisconnectHasRunningRead(sourceScheduler, new Set([sourceId] as V04PublicSourceId[])));
      if (busy()) {
        throw new EmailSourceWorkerError(
          409,
          'delete_source_busy',
          'This source is finishing a read. Retry deleting its indexed data after the current read completes.',
        );
      }
      const custodyInput = custodyInputFor();
      const custody = dataDeleteCustody({ ...custodyInput, ...pathContext });
      if (!custody.ready) {
        // A source with no public capability is deleted only with Olympus stopped.
        if (custody.requirement === 'worker_inactive') {
          throw new EmailSourceWorkerError(409, 'delete_unavailable', 'This source can be deleted only while Olympus is stopped. Stop it first, then retry.');
        }
        throw custody.observed === 'paired'
          ? new EmailSourceWorkerError(409, 'delete_source_paired', 'Unpair this source before deleting its indexed data.')
          : custody.observed === 'connected'
          ? new EmailSourceWorkerError(409, 'delete_source_connected', 'Disconnect this source before deleting its indexed data.')
          : custody.observed === 'unpair_incomplete' || custody.observed === 'unpair_state_unreadable'
            ? new EmailSourceWorkerError(409, 'delete_unavailable', 'Unpair for this source did not finish cleanly, so Olympus did not delete anything. Finish Unpair first.')
            : new EmailSourceWorkerError(409, 'delete_unavailable', 'Olympus cannot confirm this source is disconnected, so it did not delete anything.');
      }
      // A paired-session source's capture runs as a child of this worker.
      // Unpair stopped it; confirm that again now rather than assume it,
      // because a spool still being written while its store is deleted
      // would bring the deleted messages straight back.
      const captureKind = sourceId === 'telegram.messages' ? 'telegram' as const
        : sourceId === 'whatsapp.personal.messages' ? 'whatsapp' as const
        : undefined;
      if (captureKind && sourceDashboard.stopMessagingCapture) {
        try { await sourceDashboard.stopMessagingCapture(captureKind); }
        catch {
          throw new EmailSourceWorkerError(409, 'delete_unavailable', 'Capture has not confirmed it stopped, so Olympus did not delete anything. Retry once it has.');
        }
      }
      // This worker holds the account's stores open, so it removes nothing:
      // the account is marked `deleting` (the storage service opens none of its
      // files from here on) and the restart removes it at boot, before anything
      // mounts (deleteMarkedAccounts). A delete refused or failed before the mark
      // leaves the account as it was, with nothing to reopen.
      let deleted: DataDeleteWithCustodyResult;
      try {
        deleted = deleteOlympusDataWithCustody({ ...custodyInput, ...pathContext, applyAtRestart: true });
      } catch (error) {
        return { ok: false as const, error, restarting: false };
      }
      return { ok: true as const, result: deleted, restarting: restart.request() };
    });
  }

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

  function assertFileSourceSyncApproved(sourceId: string | undefined): void {
    if (sourceId === 'gmail.email') {
      // A worker that publishes a mail scope gates Gmail on it; one that does
      // not (no connected-handle registry) has no Gmail lane to start either.
      const scope = sourceDashboard?.fileSourceScopes?.summaries()
        .find((candidate) => candidate.source_id === sourceId);
      if (scope && (scope.status !== 'approved' || !scope.connected)) {
        throw new OperationError(
          'source_index_policy_violation',
          'Choose and approve which mail Olympus may use before starting ingestion.',
        );
      }
      return;
    }
    if (sourceId !== undefined && isFileSourceScopeId(sourceId)) {
      const scope = sourceDashboard?.fileSourceScopes?.summaries()
        .find((candidate) => candidate.source_id === sourceId);
      const hasSelectedFolders = scope?.whole_account_selected === true
        || scope?.selections?.some((selection) => selection.state !== 'exclude') === true;
      if (!scope || scope.status !== 'approved' || !scope.connected || !hasSelectedFolders) {
        throw new OperationError(
          'source_index_policy_violation',
          'Choose and approve this file source scope before starting ingestion.',
        );
      }
    }
  }

  async function runDashboardSourceSync(request: DashboardSourceSyncRequest): Promise<unknown> {
    return (await prepareDashboardSourceSync(request))();
  }

  /**
   * Every refusal a sync can meet before it reads anything (scope not
   * approved, worker stopping, no lane for the source), thrown here; on
   * success, the run itself, not yet started. Sync now answers between the
   * two: it refuses at once, or starts the run and answers without waiting
   * for it (2026-10-09).
   */
  async function prepareDashboardSourceSync(request: DashboardSourceSyncRequest): Promise<() => Promise<unknown>> {
    assertFileSourceSyncApproved(dashboardSchedulerSourceId(request.source));
    await refreshDashboardSchedulerSources();
    if (dashboardWorkerClosed) throw new EmailSourceWorkerError(503, 'worker_stopping', 'The worker is restarting.');
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
        const scheduler = sourceScheduler!;
        return request.reason === 'manual'
          ? () => scheduler.runSource(schedulerSourceId, undefined, 'operator')
          : () => scheduler.runSource(schedulerSourceId);
      }
    }

    // A connector-store sync wired into THIS worker outranks the host's
    // dashboard hook. The hook is a single callback shared by every source, so
    // a host that wires it for one source (the product server wires Dropbox)
    // would otherwise starve every fallback sitting behind it. This order is
    // the one `dashboardSourceSyncAvailable` already reports: a source is
    // syncable when either path exists, so neither may preempt the other.
    const readwiseSync = request.source === 'readwise' ? currentReadwiseSync() : undefined;
    if (readwiseSync) {
      return () => readwiseSync.sync();
    }

    const xSync = request.source === 'x' ? currentXBookmarksRuntime()?.sync : undefined;
    if (request.source === 'x' && xSync) {
      return async () => xBookmarksLiveAdminResult(
        'reconcile',
        await xSync.reconcile(
          request.reason === 'manual' ? { provenance: 'operator' } : {},
        ),
      );
    }

    // A hook that names the sources it serves is not asked for any other:
    // that refusal is known now, before Sync now answers.
    const hook = sourceDashboard?.triggerSourceSync;
    if (hook && dashboardSyncHookServes(request.source)) {
      return () => hook(request);
    }

    // A worker with no scheduler at all refuses every source for the same
    // reason, and that reason is a setting the reader can change. Reporting it
    // as "does not support Sync now for google-drive" sent the owner looking
    // for a missing Drive feature.
    throw dashboardSourceSyncNotSupportedError(
      request.source,
      sourceScheduler === undefined && hook === undefined ? 'scheduler_disabled' : 'no_lane',
    );
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
    if (!isDashboardSyncSource(request.source) || dashboardWorkerClosed) return;
    // A newly connected account was absent from the startup scheduler. Adopt
    // it before deciding whether its initial sync is available.
    try { await refreshDashboardSchedulerSources(); }
    catch {
      console.warn('Olympus connected the source; scheduler adoption will retry on its next tick.');
      return;
    }
    if (!dashboardSourceSyncAvailable(request.source) || dashboardPostConnectRuns.has(request.source)) return;
    try {
      assertDashboardModelsReady();
      assertFileSourceSyncApproved(dashboardSchedulerSourceId(request.source));
    } catch { return; } // File-source scope remains an explicit next step.
    const work = Promise.resolve().then(async () => {
      if (dashboardWorkerClosed) return;
      if (sourceDashboard) assertDashboardSourceMayRead(request.source, sourceDashboard, dashboardDisconnectedSources);
      await runDashboardSourceSync(request);
    }).catch((error) => {
      if (!dashboardWorkerClosed) console.warn(`Olympus initial sync needs attention for ${request.source}: ${scrubSourceWorkerLogMessage(error instanceof Error ? error.message : error)}`);
    }).finally(() => { dashboardPostConnectRuns.delete(request.source); });
    dashboardPostConnectRuns.set(request.source, work);
    // The HTTP connection acknowledgment must not wait for a whole library
    // import. Scheduler execution, budgets and failures stay authoritative.
  }

  /**
   * True when the host's dashboard hook serves this source, not merely when a
   * hook exists. See `triggerSourceSyncSources`.
   */
  function dashboardSyncHookServes(source: DashboardSyncSource): boolean {
    if (sourceDashboard?.triggerSourceSync === undefined) return false;
    const served = sourceDashboard.triggerSourceSyncSources;
    return served === undefined || served.includes(source);
  }

  function dashboardSourceSyncAvailable(source: DashboardSyncSource): boolean {
    const schedulerId = dashboardSchedulerSourceId(source);
    if (schedulerId && sourceScheduler?.status().sources.some((candidate) => candidate.source_id === schedulerId || candidate.corpus_id === schedulerId)) return true;

    if (source === 'gmail') {
      const schedulerStatus = sourceScheduler?.status();
      return schedulerStatus?.sources.some((candidate) => candidate.source_id === 'gmail.email' || candidate.corpus_id === INTERNAL_EMAIL_CORPUS_ID) === true
        || dashboardSyncHookServes(source);
    }
    if (source === 'google-drive') {
      const schedulerStatus = sourceScheduler?.status();
      return schedulerStatus?.sources.some((candidate) => candidate.source_id === 'google_drive.docs' || candidate.corpus_id === GOOGLE_DRIVE_DOCS_CORPUS_ID) === true
        || dashboardSyncHookServes(source);
    }
    if (source === 'readwise') return currentReadwiseSync() !== undefined || dashboardSyncHookServes(source);
    if (source === 'x') return currentXBookmarksRuntime()?.sync !== undefined || dashboardSyncHookServes(source);
    if (source === 'dropbox') {
      const schedulerStatus = sourceScheduler?.status();
      return schedulerStatus?.sources.some((candidate) => candidate.source_id === 'dropbox.files' || candidate.corpus_id === DROPBOX_FILES_CORPUS_ID) === true
        || dashboardSyncHookServes(source);
    }
    return false;
  }
}
