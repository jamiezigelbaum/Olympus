import { createSpoolChangeSubscription } from '../messaging-spool-wake.ts';
import { hasFolderLayout, resolvedRawPath, resolvedStorePath, retiredPathSettings } from '../../core/source-placement.ts';
import { DASHBOARD_PRIVATE_ANSWERS_COPY as PRIVATE_ANSWERS_COPY } from '../dashboard/vocabulary.ts';
import { anonymousInboxConnectionId, localInboxLabel, askWithAnonymousInbox } from './local-private-answers.ts';
import { installWorkerShutdownSignals } from '../../core/worker-shutdown.ts';
import { connectLinuxOwnerBridgeHost, OWNER_BRIDGE_HOST_ENV } from '../../core/linux-owner-bridge-host.ts';
import { createUpdateChecker, runningOlympusVersion } from '../../core/update-check.ts';
import { parseOlympusOpenUrl, openTargetToken } from '../../core/open-targets.ts';
import { manageLinuxOwnerBridge, DESKTOP_OWNER_OPEN_PATH } from '../../core/linux-owner-bridge.ts';
import { linuxGraphicalSessionReadinessAsync, openLinuxDesktopPath } from '../../core/linux-desktop-opener.ts';
import { mintDashboardOpeningUrl } from '../../core/dashboard-opening.ts';
import { workerFetch } from '../../core/worker-transport.ts';
import { linuxModelReadiness } from '../../core/linux-model-readiness.ts';
import { withEngineWorkerAdmission, EngineMaintenanceInProgressError } from '../../core/engine-maintenance.ts';
import { prepareWorkerSocket, bindWorkerSocket, workerSocketPath } from '../../core/worker-transport.ts';
import { modelInstallFailedReason, modelInstallSpaceToFree } from '../../core/model-install-failure.ts';
import { accountFromGoogleHandle } from '../google-connectors/classification.ts';
import { olympusPackageRoot } from '../../core/package-root.ts';
import {
  MessagingCaptureSupervisor,
  NativeMessagingCaptureOwnerError,
  defaultMessagingCaptureGrantPath,
  effectiveMessagingCaptureStatus,
  readMessagingCaptureGrantFacts,
  revokeMessagingCaptureGrant,
  type MessagingCaptureLiveness,
  type MessagingCaptureStatus,
} from '../../core/messaging-capture.ts';
import { whatsappBridgePathForPackage } from '../../core/messaging-pairing.ts';
import { NATIVE_CAPTURE_OWNER_ENV_NAMES } from '../../core/native-worker-service.ts';
import { ModelSetupService, requiredModelProfiles, type ModelCredentialState } from '../../core/model-setup.ts';
import { workerRestartsItself, type ModelKeyReloadRequest, type WorkerLaunch } from '../../core/model-key-reload.ts';
import { connectGeminiApiKey, connectPublicApiKeySource } from '../../core/connect.ts';
import { environmentWithWorkerSetupEnv, readWorkerSetupEnv } from '../../core/worker-auth.ts';
import { resolveServerMode, resolveAgentApprovalHost } from '../../core/remote-open.ts';
import { loadOrCreateDashboardSessionSecret } from '../../core/dashboard-session-secret.ts';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  createFileExtractionRuntime,
  pdfExtractionLanes,
  fileExtractionCorporaRoster,
  connectorStoreExtractionCandidateReader,
  parseFileExtractionCorporaEnv,
} from './file-extraction-runtime.ts';
import { createExtractionReadinessLedger } from '../file-extraction/readiness-ledger.ts';
import { createUnreadableFiles, createUnreadableVerdict } from '../file-extraction/unreadable-files.ts';
import { VeniceVlmClient } from '../file-extraction/extractors/venice-client.ts';
import { OpenAICompatibleVlmClient } from '../file-extraction/extractors/openai-compatible-client.ts';
import { parseOcrEnginePreference } from '../file-extraction/extractors/apple-vision-ocr.ts';
import {
  EmailSourceWorkerError,
  createEmailSourceWorker,
  dashboardSourceSyncNotSupportedError,
  defineGmailSecureLocalCorpus,
  defineInternalEmailCorpus,
  GMAIL_SECURE_LOCAL_CORPUS_ID,
  INTERNAL_EMAIL_CORPUS_ID,
  GogcliEmailConnector,
  type EmailSourceConnector,
  type ConnectorStoreChatPrincipal,
  type ConnectorStoreDeclaredPrincipal,
  type GmailEmailCorpusId,
} from './index.ts';
import {
  createAnalystSourceIndexAnswerHandler,
  readPrivateEvidenceItem,
  checkPrivateEvidenceItems,
  guardSourceAnswerEvidence,
  probePrivateMatch,
  searchPrivateEvidence,
  searchReleasedEvidence,
  type AnalystAnswerLanes,
  type SecureLocalAnalystRouteStatus,
  type SovereigntyAnalystRoutePlan,
  type SovereigntyAnalystRouteStep,
} from '../source-index/analyst-answer.ts';
import { SecureAnalystPoolState, parseSecureAnalystPoolLastLegTimeoutMs } from '../source-index/analyst-pool.ts';
import {
  createFileSourceAnswerLatencyLog,
  resolveSourceAnswerLatencyLogPath,
} from '../source-index/answer-latency-log.ts';
import type { EvidencePackBuildDetail } from '../../core/evidence-pack.ts';
import type { SourceIndexAnswerRequest } from '../source-index/answer-types.ts';
import {
  createSourceIndexStatusHandler,
  resolveStatusRetrievalAvailability,
  type SourceIndexStatusRetrievalAvailability,
} from '../source-index/status.ts';
import {
  resolveWorkerBindHost,
  warnIfWorkerAuthDisabled,
  withWorkerBearerAuth,
  workerAuthTokenFromEnv,
} from '../http.ts';
import { createAnalyst } from '../../core/analyst.ts';
import {
  builtInTranscriptionDashboardState,
  builtInTranscriptionEnabled,
  readBuiltInTranscriptionStatusFile,
} from '../source-index/built-in-reasoning/transcription-model.ts';
import { runningBuiltInTranscriber, sharedBuiltInTranscriber, wireBuiltInTranscriptionAtBoot } from '../file-extraction/extractors/built-in-transcriber.ts';
import {
  answerPrivately,
  builtInAnalystEnabled,
  builtInPrivateModelStatus,
  createBuiltInAnalystModel,
  resolveBuiltInReasoningModel,
  withBuiltInFallback,
  type BuiltInAnalystModel,
} from '../../core/analyst-built-in.ts';
import { createDelphiAnalystModel } from '../../core/analyst-delphi.ts';
import { createAnthropicAnalystModel } from '../../core/analyst-anthropic.ts';
import { createOpenClawInferAnalystModel } from '../../core/analyst-openclaw-infer.ts';
import {
  approvedVeniceAnalystBaseUrl,
  createVeniceAnalystModel,
  type VeniceThinkingMode,
} from '../../core/analyst-venice.ts';
import {
  createVenicePrivacyCategoryResolver,
  type VeniceModelCatalogOptions,
} from '../../core/venice-model-catalog.ts';
import {
  assertVeniceAnalystModelAllowed,
  assertVeniceEmbeddingModelAllowed,
} from '../../core/venice-models.ts';
import { createOpenAICompatibleAnalystModel, type OpenAIReasoningEffort } from '../../core/analyst-openai.ts';
import { createAnalystQueryPlanner } from '../../core/query-planner.ts';
import { defaultConfig, loadConfig, loadWorkerConfig, parseLane, readOpenClawPluginRemote, parseModelProfile, parseOptionalBooleanEnv } from '../../core/config.ts';
import { DelphiClient } from '../../core/delphi.ts';
import {
  describeSovereigntyPolicy,
  isPublicTierRetired,
  isStandaloneEngineProcess,
  loadSovereigntyEngine,
  type SovereigntyEngine,
  type LoadSovereigntyOptions,
  type SovereigntyModelProfile,
  type SovereigntyResolvedProfile,
} from '../../core/sovereignty.ts';
import { createSourceCorpusRegistry } from '../../core/source-corpus-registry.ts';
import {
  dropboxPolicyFullExtractionScopeKeys,
  loadDropboxIngestionPolicy,
} from '../../core/source-ingestion-policy.ts';
import { OperationError } from '../../core/operation-error.ts';
import {
  buildSourceIndexCorpusRegistry,
} from '../../core/source-index/corpus.ts';
import {
  GOOGLE_DRIVE_DOCS_CORPUS_ID,
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_SOURCE_ID,
  GOOGLE_DRIVE_SOURCE_ID,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_ENFORCEABLE_EXCLUSION_CRITERIA,
  GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE,
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
  GoogleDailyRequestBudget,
  GoogleGmailSourceConnector,
  createGmailConnectorStoreSyncHandler,
  gmailCursorConnectorId,
  createGmailDailyRequestBudget,
  createGoogleDriveConnectorStoreSyncHandler,
  createGoogleDriveDailyRequestBudget,
  createGoogleDriveLaneTierSet,
  googleDriveIngestionExclusionMatcher,
  defineGoogleDriveDocsCorpus,
  GMAIL_PUBLIC_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_PUBLIC_CONNECTOR_CORPUS_ID,
  type GoogleDriveConnectorStoreSyncHandler,
} from '../google-connectors/index.ts';
import {
  READWISE_LIBRARY_CORPUS_ID,
  READWISE_SOURCE_ID,
  ReadwiseDailyRequestBudget,
  createReadwiseConnectorStore,
  createReadwiseConnectorStoreSyncHandler,
  createReadwiseDailyRequestBudget,
  defineReadwiseLibraryCorpus,
  type ReadwiseConnectorStoreSyncHandler,
} from '../readwise/index.ts';
import {
  LocalXBookmarksApiUsageStore,
  LocalXBookmarksReconcileStateStore,
  X_BOOKMARKS_CORPUS_ID,
  X_BOOKMARKS_SOURCE_ID,
  createXBookmarksConnectorStore,
  createXBookmarksConnectorStoreSyncHandler,
  createXBookmarksContentRecoveryHandler,
  defineXBookmarksCorpus,
  type XBookmarksConnectorStoreSyncHandler,
  type XBookmarksContentRecoveryHandler,
} from '../x-bookmarks/index.ts';
import {
  DROPBOX_APPROVED_SCOPE_FILTER_CODEC,
  DROPBOX_ENFORCEABLE_EXCLUSION_CRITERIA,
  DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
  DROPBOX_INGESTION_EXCLUSION_SOURCE,
  DROPBOX_FILES_CORPUS_ID,
  DROPBOX_FILES_SOURCE_ID,
  createDropboxEvalShardExportHandler,
  createDropboxSourceExportHandler,
  defineDropboxFilesCorpus,
  createDropboxConnectorStore,
  dropboxIngestionExclusionMatcher,
} from '../dropbox-files/index.ts';
import { createDropboxProviderStoreSyncHandler } from '../dropbox-files/provider-store-sync.ts';
import { createDropboxTierLane } from '../dropbox-files/tier-set.ts';
import {
  LOCAL_FILES_ACCOUNT_SCOPE,
  LOCAL_FILES_POLICY_SOURCE,
  LOCAL_FILES_PROVIDER,
  LOCAL_FILES_SOURCE_ID,
  createScopeBoundLocalFilesContentScope,
  fileSourceScopeLocalFilesPolicy,
  localFilesRoots,
} from '../local-files/scope.ts';
import {
  LOCAL_FILES_CORPUS_ID,
  LOCAL_FILES_INGESTION_EXCLUSION_SOURCE,
  LOCAL_FILES_ENFORCEABLE_EXCLUSION_CRITERIA,
  createLocalFilesConnectorStore,
  createLocalFilesTierLane,
  defineLocalFilesCorpus,
  localFilesIngestionExclusionMatcher,
  localFilesWatchDir,
} from '../local-files/store.ts';
import { createLocalFilesOwnRootsCleanup } from '../local-files/own-roots-cleanup.ts';
import { createLocalFilesProviderStoreSyncHandler } from '../local-files/provider-store-sync.ts';
import { createLocalFilesSchedulerSource } from '../local-files/scheduler-source.ts';
import { createArchiveImportRuntime } from '../archive-import/runtime.ts';
import { archiveSourceTargets } from '../archive-import/source-targets.ts';
import {
  archiveImportScheduling,
  archivePrivateModelFromSniffer,
  createArchiveImportDashboard,
  type ArchivePrivateModelState,
} from '../archive-import/dashboard.ts';
import { archiveLaneLegs } from '../archive-import/lane.ts';
import { withArchiveImportCorpora } from '../archive-import/store.ts';
import { ARCHIVE_IMPORTS_SOURCE_ID } from '../archive-import/state.ts';
import { createArchiveExtractionRuntime } from '../archive-import/extraction-runtime.ts';
import { createArchiveImportsSchedulerSource } from '../archive-import/scheduler-source.ts';
import type { ExtractorRegistryConfig } from '../file-extraction/types.ts';
import { createLocalFilesSourceConnector } from '../local-files/connector.ts';
import { LOCAL_FILES_APPROVED_SCOPE_FILTER_CODEC } from '../local-files/approved-scope-filter.ts';
import { LOCAL_FILES_LOCATOR_RESULT_PROJECTOR_CODEC } from '../local-files/locator-result-projector.ts';
import { createLocalFilesOpenTargets, localFilesOpenRoots } from '../local-files/open-target.ts';
import { defaultExclusionContext, scopePathIsWithin } from '../local-files/paths.ts';
import { defaultLocalFilesIngestionPolicy } from '../../core/source-ingestion-policy.ts';
import { VolumeResolver } from '../local-files/volume-identity.ts';
import { WatchHub, watchIgnoreGlobs } from '../local-files/watch-hub.ts';
import { localOpenArguments } from '../../core/local-open.ts';
import { createConnectorFileExtractionSource } from '../file-extraction/connector-source.ts';
import { createArchivePathResolver } from '../local-files/scope-browser.ts';
import { tieredExtractionView } from '../connector-store/tiered-extraction.ts';
import {
  createSourceExclusionMatcherFromPrefixes,
  sourceExclusionDescendantPrefixes,
  type SourceExclusionCriterionKind,
  type SourceExclusionMatcher,
} from '../../core/source-ingestion-exclusions.ts';
import type { SourceDispositionsSource } from '../source-dispositions.ts';
import type { SourceDispositionItem } from '../../core/source-disposition-tree.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  TELEGRAM_MESSAGES_SOURCE_ID,
  TELEGRAM_PERSONAL_ACCOUNT_SCOPE,
  defaultTelegramCaptureSpoolDir,
  createTelegramConnectorStores,
  createTelegramConnectorStoreSyncHandler,
  defineInternalTelegramMessagesCorpus,
  defineProtectedTelegramMessagesCorpus,
  type TelegramConnectorStoreSyncHandler,
} from '../telegram-messages/index.ts';
import {
  DEFAULT_SEMANTIC_RELEVANCE_BAR,
  type LocalConnectorStore,
  connectorStoreFilterCapabilityRegistry,
  defineConnectorCorpus,
  type ConnectorStoreConversationTitleCandidates,
  type ConnectorStoreFilterCapabilityRegistry,
  type ConnectorStoreSearchFilters,
} from '../connector-store/index.ts';
import { canonicalConnectorStoreChatPrincipal } from '../connector-store/principal.ts';
import { createSourceAnswerLanes } from './source-answer-lanes.ts';
import type { ConnectorStoreStatusScope } from '../connector-store/local-index.ts';
import { gmailInternalStoreStatusScope, gmailPrivateStoreStatusScope } from './gmail-status-scope.ts';
import {
  onDemandTierStore,
  rehomeChatLaneOverrides,
  type ExistingStoreTierLane,
  type OnDemandTierStore,
  type TieredStoreSet,
} from '../connector-store/tiered-store-set.ts';
import { EVERNOTE_SOURCE_ID } from '../evernote/connector.ts';
import { EVERNOTE_SYNC_CAPABILITY, EVERNOTE_TIER_CORPUS_IDS } from '../evernote/live-sync.ts';
import { createEvernoteRuntime } from '../evernote/runtime.ts';
import {
  READWISE_SECURE_LIBRARY_CORPUS_ID,
  createReadwiseTierLane,
} from '../readwise/tier-set.ts';
import {
  X_BOOKMARKS_SECURE_CORPUS_ID,
  createXBookmarksTierLane,
} from '../x-bookmarks/tier-set.ts';
import { createParentLabelResolver } from '../connector-store/parent-label.ts';
import { createUnreadableLocators } from '../connector-store/unreadable-locators.ts';
import { hiddenProbesByParentIdentity } from '../connector-store/child-visibility.ts';
import { createReleaseTierCheck, createTierVisibilityGate, type TierVisibilityScope } from '../connector-store/tier-visibility.ts';
import { secretLocationsPathForStore, type SecretLocationsIndex } from '../classification/secret-locations.ts';
import {
  enableSourceRegistryAdoption,
  openConnectorStore,
  openSecretLocations,
  recordAccountPlacement,
  recordProviderAccount,
  replaceEmptyLegacyAccounts,
  sourceAccountUnavailableReason,
  storageAccountForCorpus,
  type StorageAccount,
  type StoreFileOwner,
} from '../../core/source-storage.ts';
import { recordedProviderAccount } from '../../core/provider-account-history.ts';
import { accountFolderMigrationEnabled, migrateAccountFolders, type AccountMigrationOptions, type AccountMigrationReport } from '../../core/source-account-migration.ts';
import { messagingMoveFacts, repointMovedMessagingAccounts } from '../../core/messaging-account-move.ts';
import { takeWorkerDataOwnerLock, type HeldDataOwnerLock } from '../../core/data-owner-lock.ts';
import { deleteMarkedAccounts, lifecycleStoreFileOwner, type DeleteMarkedAccountsReport } from '../../data-lifecycle.ts';
import type { TierLedger } from '../classification/tier-ledger.ts';
import { CHAT_SCOPE_FILTER_CODEC } from '../chat/chat-scope-filter.ts';
import { createEnvCredentialBroker } from '../credential-broker/index.ts';
import {
  withSourceIndexHybridAvailability,
} from '../../core/source-index/router.ts';
import {
  isSecureSensitivity,
  SOURCE_FAMILIES,
  SOURCE_TRUST_DOMAINS,
  type SecureSensitivityInput,
  type SourceFamily,
  type SourceTrustDomain,
} from '../../core/source-index/types.ts';
import { createDefaultSecretStore, resolveSecretRefValueSync, type SecretStore } from '../../core/secret-store.ts';
import {
  credentialConfigFingerprint,
  WorkerBootSecretResolver,
  type CredentialReadinessBinding,
} from '../credential-degradation.ts';
import {
  DEFAULT_VENICE_SOURCE_EMBEDDING_BASE_URL,
  DEFAULT_VENICE_SOURCE_EMBEDDING_DIMENSION,
  DEFAULT_VENICE_SOURCE_EMBEDDING_MODEL,
  VENICE_SOURCE_EMBEDDING_QUERY_INSTRUCTION,
  builtInEmbeddingOnly,
  GeminiSourceEmbeddingProvider,
  isApprovedSecureSourceEmbeddingProvider,
  OpenAICompatibleSourceEmbeddingProvider,
  type SourceEmbeddingProvider,
} from '../source-index/embeddings.ts';
import { canonicalEmbeddingDimension } from '../source-index/embedding-identity.ts';
import {
  BuiltInSourceEmbeddingProvider,
  builtInEmbeddingDashboardState,
  loadedBuiltInEmbedding,
  sharedBuiltInSourceEmbeddingProvider,
} from '../source-index/built-in-embedding/provider.ts';
import { readBuiltInEmbeddingStatus } from '../source-index/built-in-embedding/assets.ts';
import { BUILT_IN_EMBEDDING_ENV_DEFAULT_MODEL, builtInEmbeddingModel } from '../source-index/built-in-embedding/manifest.ts';
import {
  createGmailConnectorStoreSchedulerSource,
  createGmailImportedHistorySchedulerSource,
  fileExtractionSchedulerTask,
  createGoogleDriveConnectorStoreSchedulerSource,
  createCanonicalDropboxSchedulerSource,
  createReadwiseSchedulerSource,
  createSourceSchedulerFromConfig,
  createTelegramSchedulerSource,
  createWhatsAppSchedulerSource,
  createXBookmarksSchedulerSource,
  attachSourceWatchSchedulerTask,
  withEmbeddingSweep,
  sourceSchedulerConstructionLogLines,
  sourceSchedulerEnabledLogLine,
  SCHEDULER_SOURCE_IDS,
  type SourceSchedulerConstructionDecision,
  type SourceSchedulerSource,
  type SourceScheduler,
} from '../source-scheduler.ts';
import {
  createSourceWatchExecutorCapability,
  LocalSourceWatchStore,
} from '../../core/source-watch.ts';
import {
  createSourceWatchSearchFromAnalystLanes,
  createOpenClawSourceWatchDeliveryTransport,
  runSourceWatchSchedulerPass,
} from '../source-watch-runtime.ts';
import {
  WHATSAPP_LIVE_CORPUS_ID,
  WHATSAPP_PERSONAL_ACCOUNT_SCOPE,
  WHATSAPP_PERSONAL_SOURCE_ID,
  defaultWhatsAppSpoolDir,
  createWhatsAppConnectorStore,
  createWhatsAppTierLane,
  createWhatsAppConnectorStoreSyncHandler,
  type WhatsAppConnectorStoreSyncHandler,
} from '../whatsapp/index.ts';
import { createWhatsAppArchiveTarget } from '../whatsapp/archive-target.ts';
import { whatsAppChildReader, whatsAppExtractionSourceFactory } from '../whatsapp/extraction-factory.ts';
import {
  TELEGRAM_MEDIA_EXTRACTION_BATCH_SIZE,
  TELEGRAM_MEDIA_EXTRACTION_PLAN_LIMIT,
  telegramMediaLanes,
} from '../telegram-messages/media-extraction.ts';
import { readArchiveInputMedia } from '../archive-import/input-media.ts';
import { SqliteSourceDashboardHistory, type DashboardCaptureRuntime, type SourceDashboardViewModel } from '../source-dashboard.ts';
import type { DashboardPanelTools } from './dashboard-panel-tools.ts';
import { readEmbeddingRuntime } from '../dashboard/embedding-runtime.ts';
import {
  SqliteSourceIngestionLedgerStore,
  buildSourceIngestionLedgerSnapshot,
} from '../source-ingestion-ledger.ts';
import type { Analyst } from '../../core/contracts.ts';
import type { AnalystBackend } from '../source-index/answer-types.ts';
import {
  handleRegistryPathFromEnv,
  readConnectedHandleRegistry,
  type ConnectedCredentialHandle,
} from '../credential-broker/connected-handles.ts';
import {
  FileSourceScopeAuthority,
  createScopeBoundGoogleDriveContentScope,
  createScopeBoundDropboxContentScope,
  fileSourceScopeContentFilters,
  fileSourceScopeDropboxPolicy,
  fileSourceScopeMetadataEnabled,
  fileSourceScopeMetadataFilters,
  isMailSourceScopePolicyRef,
  scopeBoundEmbeddingProvider,
  scopeBoundSchedulerSource,
  gmailConnectorScopeFromApproval,
  type FileSourceScopePolicyRef,
  type SourceScopePolicyRef,
} from '../source-scope-runtime.ts';
import {
  getFileScopeSource,
  listFileScopeSources,
  requireFileScopeSource,
  type FileScopeSourceDefinition,
} from '../../core/file-scope-sources.ts';
import { fileSourceScopeAllowsContent, fileSourceScopeAllowsMetadata, fileSourceScopeIdForProvider } from '../../core/source-scope-approval.ts';
import { createGmailMailScopeBrowser, createGmailPickerRequestBudget } from '../google-connectors/gmail-scope-browser.ts';
import {
  GMAIL_IMPORT_CONNECTOR_PREFIX,
  gmailArchiveTarget,
  GMAIL_IMPORTED_FILTERS,
  gmailHoldsImportedHistory,
  gmailItemAccountScope,
} from '../google-connectors/gmail-archive-target.ts';
import { gmailHeaderMatch } from '../google-connectors/gmail-header-match.ts';
import { planStoreEmbedding, type StoreEmbeddingScope } from '../connector-store/embedding-plan.ts';
import {
  GMAIL_IMPORT_LABELS_COST,
  GMAIL_IMPORT_MAX_RETRIES,
  GmailImportWaitError,
  gmailImportAllowance,
  gmailImportBudget,
  gmailImportWait,
} from '../google-connectors/gmail-import-allowance.ts';
import type { GmailApiClient } from '../google-connectors/gmail.ts';
import { readSourceRegistry } from '../../core/source-registry.ts';
import { gmailContentArrivesLater, gmailLaneSyncOptions } from '../google-connectors/gmail-live-sync.ts';
import {
  GMAIL_ATTACHMENT_EXTRACTION_BATCH_SIZE,
  GMAIL_ATTACHMENT_EXTRACTION_PLAN_LIMIT,
  createGmailAttachmentExtractionRuntime,
  gmailAttachmentConnector,
  gmailAttachmentLanes,
} from '../google-connectors/gmail-attachment-extraction.ts';
import { createLaneTieredStoreSet } from '../connector-store/tiered-store-set.ts';
import {
  SourceAccountChangedError,
  guardAccountBoundLanes,
  createSourceAccountGuard,
  runExclusiveForSource,
  runGuarded,
  type SourceAccountGuard,
  type SourceAccountGuardOptions,
} from '../source-account-guard.ts';
import { compareProviderAccounts, dropboxOwnRootFolderIds, dropboxOwnsOneOfFolders, googleAccountIdFromAddress, type AccountBoundProvider } from '../../core/provider-account-identity.ts';
import type { AccountBoundSourceId } from '../../core/source-account-binding.ts';
import { GoogleRequestBudgetError } from '../google-connectors/request-budget.ts';
import { defaultGmailRequestBudgetStatePath } from '../google-connectors/gmail.ts';
import { MAIL_SCOPE_WINDOW_LABELS, mailScopeDraftView, mailScopeFromDraft } from '../../core/mail-source-scope.ts';
import type { OlympusMailScopeDraft } from '../../control-ui-contract.ts';
import { gmailDailyRequestBudgetFromEnv } from '../google-connectors/gmail.ts';
import { defaultGmailLiveSyncConfig } from '../google-connectors/gmail-live-control.ts';
import {
  createEvernoteNotebookScopeBrowser,
  createFileScopeBrowser,
  registerFileScopeBrowserFactory,
  unregisterFileScopeBrowserFactory,
  type SourceFolderScopeBrowser,
} from '../source-scope-browser.ts';
import { withoutUnpairedLaneHandles } from '../credential-broker/unpaired-sources.ts';
import { configureInstalledTierClassification } from '../classification/installed-tier-classification.ts';
import { type SnifferLane } from '../classification/sniffer-lane.ts';
import { registerBuiltInPrivateModel, registeredBuiltInPrivateModel, resolveTierSnifferRuntime } from '../classification/built-in-sniffer.ts';
import { createAnswerActivity, createLocalModelActivity, runBackgroundInference, runClassificationInference, localModelResourceKey, type LocalModelActivity } from '../answer-activity.ts';
import { privacyOwnerContext } from '../classification/privacy-profile.ts';
import { TierSnifferService, tierSnifferServiceEnv } from '../classification/sniffer-service.ts';
import { resolveClassificationLedgerPath } from '../classification-ledger.ts';
import type { AnalystModel } from '../../core/analyst.ts';
import { resolveTierMigrationPaths, tierMigrationStatusSummary } from '../classification/tier-migration.ts';
import { resolveEmbeddingLedgerPath } from '../embedding-ledger.ts';
import { remoteAccessFromStatus, type DashboardAgentConnectionsBackend } from '../agent-connections.ts';
import { createDashboardRemoteAccessControl, createGatewayRemoteAccessConfigWriter } from '../remote-access-control.ts';

const DROPBOX_SOURCE_ANSWER_SELF_HEAL_RETRY_AFTER_MS = 5_000;
const DROPBOX_SOURCE_ANSWER_SELF_HEAL_PRIORITY = 1_000_000;
/** How long one live Gmail attachment reader (and the messages it fetched) serves before a fresh one is made. */
const GMAIL_ATTACHMENT_READER_REUSE_MS = 5 * 60_000;

type MessagingCaptureSource = 'telegram' | 'whatsapp';
type WorkerMessagingCaptureSupervisor = Pick<MessagingCaptureSupervisor, 'reconcile' | 'stop'>
  & Partial<Pick<MessagingCaptureSupervisor, 'liveness'>>;

export function createWorkerMessagingCaptureOwnership(options: {
  env?: Record<string, string | undefined>;
  registryPath: string;
  packageRoot: string;
  createSupervisor?: (source: MessagingCaptureSource) => WorkerMessagingCaptureSupervisor;
  revokeGrant?: (path: string) => void;
}): {
  captures: Partial<Record<MessagingCaptureSource, WorkerMessagingCaptureSupervisor>>;
  nativeOwners: Record<MessagingCaptureSource, boolean>;
  stopForUnpair(source: MessagingCaptureSource): Promise<void>;
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
  for (const source of ['telegram', 'whatsapp'] as const) {
    if (!nativeOwners[source]) captures[source] = createSupervisor(source);
  }
  const revokeGrant = options.revokeGrant ?? revokeMessagingCaptureGrant;
  return {
    captures,
    nativeOwners,
    async stopForUnpair(source) {
      if (nativeOwners[source]) {
        throw new NativeMessagingCaptureOwnerError(source);
      }
      const capture = captures[source];
      if (!capture) throw new Error(`Worker ${source} capture ownership is unavailable.`);
      await capture.stop();
      revokeGrant(defaultMessagingCaptureGrantPath(source, options.registryPath));
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
      input.failures[source] = true;
      warn('An Olympus messaging capture process needs attention. Check pairing and its approved scope.');
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

/**
 * Per-item tier overrides of a chat lane written before identities carried
 * their conversation: re-homed at boot where the conversation is derivable,
 * otherwise kept (applying to nothing) and reported as orphaned. Counts only.
 */
function reportRehomedChatOverrides(lane: string, result: { rehomed: number; orphaned: number }): void {
  if (result.rehomed === 0 && result.orphaned === 0) return;
  console.warn(
    `[tier] ${lane}: ${result.rehomed} per-item override(s) re-homed under their conversation; `
    + `${result.orphaned} orphaned (conversation not derivable; kept, applying to nothing, until reset).`,
  );
}

export function registerConnectorStoreEmbeddingLane(options: {
  store: LocalConnectorStore;
  provider: SourceEmbeddingProvider;
  providers: Map<string, SourceEmbeddingProvider>;
  retrievalAvailability: Record<string, SourceIndexStatusRetrievalAvailability>;
}): void {
  if (options.store.trustDomain === 'secure_local' && !isApprovedSecureSourceEmbeddingProvider(options.provider)) {
    throw new Error('Connector store secure_local embeddings require a local/private or approved Venice embedding provider.');
  }
  options.providers.set(options.store.corpusId, options.provider);
  options.retrievalAvailability[options.store.corpusId] = () => {
    const servable = options.store.hasEmbeddings(options.provider.modelId);
    return {
      servable,
      ...(!servable ? { reason: 'no_current_embedding_artifacts' as const } : {}),
      modelId: options.provider.modelId,
      embeddingEpoch: options.provider.epochId,
      backend: options.provider.backend,
      provider: options.provider.provider,
    };
  };
}

export function createEmailSourceConnectorFromEnv(env: Record<string, string | undefined> = process.env): EmailSourceConnector | undefined {
  return env.OLYMPUS_EMAIL_SOURCE_CONNECTOR === 'gogcli'
    ? new GogcliEmailConnector({
      ...(env.OLYMPUS_EMAIL_SOURCE_GOG_COMMAND
        ? { command: env.OLYMPUS_EMAIL_SOURCE_GOG_COMMAND }
        : {}),
      ...(env.OLYMPUS_EMAIL_SOURCE_ACCOUNT
        ? { account: env.OLYMPUS_EMAIL_SOURCE_ACCOUNT }
        : {}),
      // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START
      ...(env.OLYMPUS_EMAIL_SOURCE_AUTH_MODE === 'service-account'
        ? { authMode: 'service-account' as const }
        : {}),
      // OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END
    })
    : undefined;
}

function requireSourceEmbeddingDimension(options: {
  env: Record<string, string | undefined>;
  envKeys: readonly string[];
  lane: string;
  model: string;
}): number {
  const configuredKey = options.envKeys.find((key) => Boolean(options.env[key]?.trim()));
  // Shipped models already have authoritative dimensions in the identity
  // registry. Use those only when unset; an explicit invalid value must refuse.
  if (options.envKeys.every((key) => options.env[key] === undefined)) {
    const canonicalDimension = canonicalEmbeddingDimension(options.model);
    if (canonicalDimension !== undefined) return canonicalDimension;
  }
  const envKey = configuredKey ?? options.envKeys[options.envKeys.length - 1]!;
  const raw = options.env[envKey]?.trim();
  const dimension = raw === undefined || raw.length === 0 ? Number.NaN : Number(raw);
  if (Number.isSafeInteger(dimension) && dimension >= 1) return dimension;
  throw new OperationError(
    'config_error',
    `Source embedding ${options.lane} model ${options.model} requires a positive safe-integer dimension from ${envKey}.`,
    `Set ${envKey} to the model's authoritative output dimension before starting this lane.`,
  );
}

function createVeniceSourceEmbeddingProvider(options: {
  apiKey: string;
  model: string;
  baseUrl: string;
  dimension?: number;
  timeoutMs?: number;
  epochId?: string;
}): SourceEmbeddingProvider {
  const baseUrl = approvedVeniceAnalystBaseUrl(options.baseUrl);
  const resolvePrivacyCategory = createVenicePrivacyCategoryResolver({
    apiKey: options.apiKey,
    baseUrl,
    catalog: { type: 'embedding' },
  });
  return new OpenAICompatibleSourceEmbeddingProvider({
    provider: 'venice',
    backend: 'cloud',
    baseUrl,
    model: options.model,
    apiKeyProvider: () => options.apiKey,
    dimension: options.dimension ?? DEFAULT_VENICE_SOURCE_EMBEDDING_DIMENSION,
    queryInstructionPrefix: VENICE_SOURCE_EMBEDDING_QUERY_INSTRUCTION,
    sendDimensions: true,
    requireIndexedResponses: true,
    requireDimension: true,
    preflight: (signal) => assertVeniceEmbeddingModelAllowed(
      options.model,
      resolvePrivacyCategory,
      signal,
    ),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.epochId ? { epochId: options.epochId } : {}),
  });
}

export function createSourceIndexEmbeddingProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
): SourceEmbeddingProvider | undefined {
  const provider = env.OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER;
  if (provider === undefined || provider.trim().length === 0) return undefined;
  if (provider !== 'google-gemini' && provider !== 'local-openai-compatible' && provider !== 'venice' && provider !== 'built-in') {
    throw new Error('OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER must be google-gemini, local-openai-compatible, venice, or built-in.');
  }
  if (provider === 'built-in') {
    return sharedBuiltInSourceEmbeddingProvider({
      modelId: env.OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL?.trim() || BUILT_IN_EMBEDDING_ENV_DEFAULT_MODEL.modelId,
      env,
    });
  }
  const timeoutMs = parseOptionalTimeoutSeconds(
    env.OLYMPUS_SOURCE_INDEX_EMBEDDING_TIMEOUT_SECONDS,
    'OLYMPUS_SOURCE_INDEX_EMBEDDING_TIMEOUT_SECONDS',
  );
  const mediaFetchTimeoutMs = parseOptionalTimeoutSeconds(
    env.OLYMPUS_SOURCE_INDEX_EMBEDDING_MEDIA_TIMEOUT_SECONDS,
    'OLYMPUS_SOURCE_INDEX_EMBEDDING_MEDIA_TIMEOUT_SECONDS',
  );
  if (provider === 'local-openai-compatible') {
    const baseUrl = env.OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL?.trim();
    const model = env.OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL?.trim();
    if (!baseUrl || !model) {
      throw new Error('OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL and OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL are required for local-openai-compatible source embeddings.');
    }
    const outputDimensionality = requireSourceEmbeddingDimension({
      env,
      envKeys: ['OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY'],
      lane: 'source-index env lane',
      model,
    });
    return new OpenAICompatibleSourceEmbeddingProvider({
      baseUrl,
      model,
      dimension: outputDimensionality,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(env.OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH
        ? { epochId: env.OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH }
        : {}),
    });
  }
  if (provider === 'venice') {
    const apiKey = firstNonEmptyEnv(env, [
      'OLYMPUS_SOURCE_INDEX_VENICE_API_KEY',
      'VENICE_API_KEY',
      'API_KEY_VENICE',
      'Venice-API-Key',
    ]);
    if (!apiKey) {
      throw new Error('OLYMPUS_SOURCE_INDEX_VENICE_API_KEY or VENICE_API_KEY is required for Venice source-index embeddings.');
    }
    const model = env.OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL?.trim() || DEFAULT_VENICE_SOURCE_EMBEDDING_MODEL;
    const outputDimensionality = requireSourceEmbeddingDimension({
      env,
      envKeys: ['OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY'],
      lane: 'Venice source-index env lane',
      model,
    });
    return createVeniceSourceEmbeddingProvider({
      apiKey,
      model,
      baseUrl: env.OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL?.trim() || DEFAULT_VENICE_SOURCE_EMBEDDING_BASE_URL,
      dimension: outputDimensionality,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH
        ? { epochId: env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH }
        : {}),
    });
  }
  const apiKey = firstNonEmptyEnv(env, ['OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY', 'GEMINI_API_KEY']);
  if (!apiKey) {
    throw new Error('OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY or GEMINI_API_KEY is required for Gemini source-index embeddings.');
  }
  const model = env.OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL?.trim() || 'gemini-embedding-2';
  const outputDimensionality = requireSourceEmbeddingDimension({
    env,
    envKeys: ['OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY'],
    lane: 'source-index env lane',
    model,
  });
  return new GeminiSourceEmbeddingProvider({
    apiKey,
    model,
    ...(env.OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL
      ? { baseUrl: env.OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL }
      : {}),
    outputDimensionality,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(mediaFetchTimeoutMs !== undefined ? { mediaFetchTimeoutMs } : {}),
    // Cloud override only — the shared epoch var belongs to the local lane
    // (see the sovereignty gemini branch below for the incident this guards).
    ...(env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH
      ? { epochId: env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH }
      : {}),
  });
}

/**
 * Whether a store is indexed for meaning at all: its corpus is served hybrid
 * with embedding not disabled (the full definition and the registry's both),
 * and its tier's retrieval policy does not keep it to keywords.
 */
export function storeServedByMeaning(input: {
  store: Pick<LocalConnectorStore, 'corpusId' | 'trustDomain'>;
  sovereigntyEngine: SovereigntyEngine;
  sourceCorpusRegistry: ReturnType<typeof createSourceCorpusRegistry>;
  fullCorpusDefinitions: readonly import('../../core/source-index/corpus.ts').SourceIndexCorpusDefinition[];
}): boolean {
  const { store, sourceCorpusRegistry } = input;
  // A tier store opened after boot has no full definition yet; the
  // registry's declaration of the same corpus stands in for it.
  const registered = sourceCorpusRegistry.definitions().find((entry) => entry.corpusId === store.corpusId);
  const definition = input.fullCorpusDefinitions.find((entry) => entry.corpusId === store.corpusId) ?? registered;
  const served = (entry: typeof definition) => entry === undefined
    || (entry.activationMode !== 'lexical_only' && entry.embeddingPolicy !== 'disabled');
  if (!definition || !served(definition) || !served(registered)) return false;
  const domain = store.trustDomain === 'public_safe' || store.trustDomain === 'internal' || store.trustDomain === 'secure_local'
    ? input.sovereigntyEngine.config.retrieval.trustDomains[store.trustDomain]?.activationMode
    : undefined;
  return domain !== 'lexical_only' && domain !== 'metadata_only';
}

/**
 * Whether any of these corpora would be indexed for meaning once its store
 * opens: served by meaning, with an identity for its tier. Shared with
 * startup-wiring tests.
 */
export function sourceStoresCouldEmbed(input: Omit<Parameters<typeof storeServedByMeaning>[0], 'store'> & {
  corpusIds: ReadonlySet<string>;
  providerFor: (trustDomain: string) => SourceEmbeddingProvider | undefined;
}): boolean {
  return input.sourceCorpusRegistry.list().some((corpus) => input.corpusIds.has(corpus.corpusId)
    && input.providerFor(corpus.trustDomain) !== undefined
    && storeServedByMeaning({ ...input, store: corpus }));
}

/** Sources whose stores are read only under the owner's current scope approval. */
const SCOPE_APPROVED_SOURCE_IDS: ReadonlySet<string> = new Set([
  SCHEDULER_SOURCE_IDS.gmail, SCHEDULER_SOURCE_IDS.googleDrive, SCHEDULER_SOURCE_IDS.dropbox, SCHEDULER_SOURCE_IDS.localFiles,
]);

/**
 * What a store's embedding may read now, from the scope authority: the same
 * population the store's status counts as owed. Shared with startup-wiring tests.
 *   - Gmail with no current mail approval: only what its imports brought,
 *     which the owner approved one by one. Live approval governs live reads.
 *   - Gmail's Private store under an approval: the approval's observations
 *     and the imports'.
 *   - A file source's store: the approved folders' content scope.
 * Every scoped store's provider is bound to the approval, so a pass stops
 * the moment it changes. Other stores carry no scope.
 */
export function storeEmbeddingScope(input: {
  store: LocalConnectorStore;
  sourceId: string;
  scopeRef: SourceScopePolicyRef | undefined;
  authority: FileSourceScopeAuthority | undefined;
  readScope: (store: LocalConnectorStore) => { allowed: false } | {
    allowed: true; contentAllowed: boolean; accountScope?: string; contentFilters?: ConnectorStoreSearchFilters;
  };
  gmailAccountScope?: string | undefined;
  /** The account scope Gmail's imported mail is kept under. */
  gmailImportAccountScope?: string | undefined;
}): StoreEmbeddingScope {
  const { store, sourceId, scopeRef: ref, authority } = input;
  if (!SCOPE_APPROVED_SOURCE_IDS.has(sourceId)) return { allowed: true };
  if (sourceId === SCHEDULER_SOURCE_IDS.gmail && (!ref || !authority)) {
    if (!input.gmailImportAccountScope) return { allowed: false };
    return { allowed: true, accountScope: input.gmailImportAccountScope, filters: GMAIL_IMPORTED_FILTERS };
  }
  if (!ref || !authority) return { allowed: false };
  const bind = (provider: SourceEmbeddingProvider) => scopeBoundEmbeddingProvider(provider, authority, ref);
  if (isMailSourceScopePolicyRef(ref)) {
    // A superseded approval leaves only the queue; the next build carries the new one.
    try {
      authority.assertCurrentMail(ref);
    } catch {
      return { allowed: false };
    }
    if (store.trustDomain !== 'secure_local') return { allowed: true, bind };
    const accountScope = input.gmailAccountScope?.trim() || 'personal';
    return {
      allowed: true,
      bind,
      accountScope,
      filters: {
        provider: 'gmail',
        observedConnectorId: gmailCursorConnectorId(accountScope, { generation: ref.accountGeneration, revision: ref.revision }),
        observedConnectorIdPrefix: GMAIL_IMPORT_CONNECTOR_PREFIX,
      },
    };
  }
  const scope = input.readScope(store);
  if (!scope.allowed || !scope.contentAllowed) return { allowed: false };
  return {
    allowed: true,
    bind,
    ...(scope.accountScope ? { accountScope: scope.accountScope } : {}),
    ...(scope.contentFilters ? { filters: scope.contentFilters } : {}),
  };
}

/** Worker startup policy loading; hosted paths stay read-only. */
export function loadSourceWorkerSovereignty(
  config: Pick<ReturnType<typeof loadConfig>, 'sovereignty'>,
  env: Record<string, string | undefined>,
): SovereigntyEngine {
  const options: LoadSovereigntyOptions = {
    env, migratePrivateMeaning: true,
    ...(config.sovereignty?.policy ? { inlineConfig: config.sovereignty.policy } : {}),
    ...(config.sovereignty?.configPath ? { configPath: config.sovereignty.configPath } : {}),
  };
  return loadSovereigntyEngine(options);
}

export function createSourceIndexEmbeddingProviderFromSovereignty(
  engine: SovereigntyEngine,
  trustDomain: Extract<SourceTrustDomain, 'public_safe' | 'internal' | 'secure_local'>,
  env: Record<string, string | undefined> = process.env,
  bootSecretResolver?: WorkerBootSecretResolver,
): SourceEmbeddingProvider | undefined {
  const resolved = engine.resolveEmbeddingProfile(trustDomain);
  if (!resolved) return undefined;
  const profile = resolved.profile;
  if (profile.provider === 'built-in') {
    // In-process: no endpoint, no credential, no timeout knob, and no epoch
    // override (the shared epoch variables belong to the HTTP lanes).
    return sharedBuiltInSourceEmbeddingProvider({ modelId: profile.model, env });
  }
  const timeoutMs = parseOptionalTimeoutSeconds(
    env.OLYMPUS_SOURCE_INDEX_EMBEDDING_TIMEOUT_SECONDS,
    'OLYMPUS_SOURCE_INDEX_EMBEDDING_TIMEOUT_SECONDS',
  );
  if (profile.provider === 'local-openai-compatible') {
    if (!profile.baseUrl?.trim()) {
      throw new Error(`Sovereignty embedding profile "${resolved.id}" requires baseUrl.`);
    }
    const apiKey = profile.secretRef
      ? resolveSecretRefSync(
        profile.secretRef,
        env,
        `Sovereignty embedding profile "${resolved.id}"`,
        bootSecretOptions(bootSecretResolver, [resolved.id], ['embedding'], resolved),
      )
      : undefined;
    if (profile.secretRef && !apiKey) return undefined;
    const outputDimensionality = requireSourceEmbeddingDimension({
      env,
      envKeys: ['OLYMPUS_SOURCE_INDEX_EMBEDDING_OUTPUT_DIMENSIONALITY'],
      lane: `sovereignty ${trustDomain} lane`,
      model: profile.model,
    });
    return new OpenAICompatibleSourceEmbeddingProvider({
      baseUrl: profile.baseUrl,
      model: profile.model,
      ...(apiKey ? { apiKeyProvider: () => apiKey } : {}),
      dimension: outputDimensionality,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(env.OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH
        ? { epochId: env.OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH }
        : {}),
    });
  }
  if (profile.provider === 'venice') {
    const apiKey = resolveSecretRefSync(
      profile.secretRef,
      env,
      `Sovereignty embedding profile "${resolved.id}"`,
      bootSecretOptions(bootSecretResolver, [resolved.id], ['embedding']),
    );
    if (!apiKey) return undefined;
    const outputDimensionality = requireSourceEmbeddingDimension({
      env,
      envKeys: ['OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_OUTPUT_DIMENSIONALITY'],
      lane: `sovereignty ${trustDomain} Venice lane`,
      model: profile.model,
    });
    return createVeniceSourceEmbeddingProvider({
      apiKey,
      model: profile.model,
      baseUrl: profile.baseUrl ?? DEFAULT_VENICE_SOURCE_EMBEDDING_BASE_URL,
      dimension: outputDimensionality,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH
        ? { epochId: env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH }
        : {}),
    });
  }
  if (profile.provider === 'google-gemini') {
    const apiKey = resolveSecretRefSync(
      profile.secretRef,
      env,
      `Sovereignty embedding profile "${resolved.id}"`,
      bootSecretOptions(bootSecretResolver, [resolved.id], ['embedding'], resolved),
    );
    if (!apiKey) return undefined;
    const outputDimensionality = requireSourceEmbeddingDimension({
      env,
      envKeys: ['OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_OUTPUT_DIMENSIONALITY'],
      lane: `sovereignty ${trustDomain} lane`,
      model: profile.model,
    });
    return new GeminiSourceEmbeddingProvider({
      apiKey,
      model: profile.model,
      ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
      outputDimensionality,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      // The CLOUD lane's override only. Threading the shared
      // OLYMPUS_SOURCE_INDEX_EMBEDDING_EPOCH here is what stamped the local
      // qwen3 epoch onto five gemini write authorities (the private host, found
      // 2026-08-24); the identity module now refuses it at construction, which
      // took the worker down at boot on the first deploy of the gate. With no
      // override the canonical gemini epoch is derived.
      ...(env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH
        ? { epochId: env.OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH }
        : {}),
    });
  }
  throw new Error(`Sovereignty embedding profile "${resolved.id}" provider ${profile.provider} is not an embedding provider.`);
}

export function createCloudSourceIndexEmbeddingProviderFromEnv(
  env: Record<string, string | undefined> = process.env,
  envPrefix?: string,
): SourceEmbeddingProvider | undefined {
  const apiKey = firstNonEmptyEnv(env, [
    ...(envPrefix ? [`${envPrefix}_GEMINI_API_KEY`] : []),
    'OLYMPUS_SOURCE_INDEX_CLOUD_GEMINI_API_KEY',
    'OLYMPUS_SOURCE_INDEX_GEMINI_API_KEY',
    'GEMINI_API_KEY',
  ]);
  if (!apiKey) return undefined;

  const model = firstNonEmptyEnv(env, [
    ...(envPrefix ? [`${envPrefix}_EMBEDDING_MODEL`] : []),
    'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_MODEL',
  ]) ?? 'gemini-embedding-2';
  const outputDimensionality = requireSourceEmbeddingDimension({
    env,
    envKeys: [
      ...(envPrefix ? [`${envPrefix}_EMBEDDING_OUTPUT_DIMENSIONALITY`] : []),
      'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_OUTPUT_DIMENSIONALITY',
    ],
    lane: envPrefix ? `per-lane cloud ${envPrefix}` : 'default cloud source-index lane',
    model,
  });
  const timeoutMs = parseOptionalTimeoutSeconds(
    firstNonEmptyEnv(env, [
      ...(envPrefix ? [`${envPrefix}_EMBEDDING_TIMEOUT_SECONDS`] : []),
      'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_TIMEOUT_SECONDS',
    ]),
    envPrefix ? `${envPrefix}_EMBEDDING_TIMEOUT_SECONDS` : 'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_TIMEOUT_SECONDS',
  );
  const mediaFetchTimeoutMs = parseOptionalTimeoutSeconds(
    firstNonEmptyEnv(env, [
      ...(envPrefix ? [`${envPrefix}_EMBEDDING_MEDIA_TIMEOUT_SECONDS`] : []),
      'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_MEDIA_TIMEOUT_SECONDS',
    ]),
    envPrefix ? `${envPrefix}_EMBEDDING_MEDIA_TIMEOUT_SECONDS` : 'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_MEDIA_TIMEOUT_SECONDS',
  );
  const baseUrl = firstNonEmptyEnv(env, [
    ...(envPrefix ? [`${envPrefix}_EMBEDDING_BASE_URL`] : []),
    'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_BASE_URL',
  ]);
  const epochId = firstNonEmptyEnv(env, [
    ...(envPrefix ? [`${envPrefix}_EMBEDDING_EPOCH`] : []),
    'OLYMPUS_SOURCE_INDEX_CLOUD_EMBEDDING_EPOCH',
  ]);

  return new GeminiSourceEmbeddingProvider({
    apiKey,
    model,
    ...(baseUrl ? { baseUrl } : {}),
    outputDimensionality,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(mediaFetchTimeoutMs !== undefined ? { mediaFetchTimeoutMs } : {}),
    ...(epochId ? { epochId } : {}),
  });
}

// Selects the Dropbox VLM transport. `openai` (default) keeps the historical
// OpenAI-compatible `/v1/chat/completions` path so non-Ollama installs are
// unchanged; `ollama` uses the native `/api/chat` client (native `images`
// field, base URL `/v1`-normalized) which is the maintained path on the
// inference appliance.

/**
 * The file-storage sources the folder-disposition picker offers, and the ONLY
 * place in that feature that names a provider.
 *
 * This is the bootstrap adapter's job by the architecture rule: the picker, the
 * tree engine and the gate are all source-neutral, and each source arrives here
 * carrying its own exclusion key, its own declared enforceable criteria, and
 * its own stores. A new file source becomes editable in the picker by adding a
 * row here — no change to the engine, the page, or the routes.
 *
 * A source may span several stores. Drive is two trust bands over one corpus
 * family, and folding both into one tree is what makes the counts on the page
 * equal what the purge would report.
 */
const INGESTION_DISPOSITION_SOURCES: ReadonlyArray<{
  sourceId: string;
  /** The source whose stores these are (`sourceId` is its exclusion key). */
  account: StorageAccount;
  label: string;
  enforceable: readonly SourceExclusionCriterionKind[];
  matcher: (env: Record<string, string | undefined>) => SourceExclusionMatcher;
  stores: (env: Record<string, string | undefined>) => Array<{
    dbPath: string;
    corpusId: string;
    trustDomain: SourceTrustDomain;
  }>;
}> = [
  {
    sourceId: DROPBOX_INGESTION_EXCLUSION_SOURCE,
    account: { sourceId: DROPBOX_FILES_SOURCE_ID },
    label: 'Dropbox',
    enforceable: DROPBOX_ENFORCEABLE_EXCLUSION_CRITERIA,
    matcher: (env) => dropboxIngestionExclusionMatcher(env),
    stores: (env) => [{
      dbPath: resolvedStorePath(DROPBOX_FILES_SOURCE_ID, 'secure_local', env),
      corpusId: DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
      trustDomain: 'secure_local',
    }],
  },
  {
    sourceId: LOCAL_FILES_INGESTION_EXCLUSION_SOURCE,
    account: { sourceId: LOCAL_FILES_SOURCE_ID },
    label: 'Files on this computer',
    enforceable: LOCAL_FILES_ENFORCEABLE_EXCLUSION_CRITERIA,
    matcher: (env) => localFilesIngestionExclusionMatcher(env),
    stores: (env) => [{
      dbPath: resolvedStorePath(LOCAL_FILES_SOURCE_ID, 'secure_local', env),
      corpusId: LOCAL_FILES_CORPUS_ID,
      trustDomain: 'secure_local',
    }],
  },
  {
    sourceId: GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE,
    account: { sourceId: GOOGLE_DRIVE_SOURCE_ID },
    label: 'Google Drive',
    enforceable: GOOGLE_DRIVE_ENFORCEABLE_EXCLUSION_CRITERIA,
    matcher: (env) => googleDriveIngestionExclusionMatcher(env),
    stores: (env) => [
      {
        dbPath: resolvedStorePath(GOOGLE_DRIVE_SOURCE_ID, 'internal', env),
        corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
        trustDomain: 'internal',
      },
      {
        dbPath: resolvedStorePath(GOOGLE_DRIVE_SOURCE_ID, 'secure_local', env),
        corpusId: GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
        trustDomain: 'secure_local',
      },
    ],
  },
];

/**
 * Open the picker's inputs for one request, read-only, and hand back the way to
 * close them.
 *
 * Read-only opens throughout: this page must never be able to create a store
 * file as a side effect of being looked at, and it must never hold a writer's
 * lock. A store whose file does not exist is reported as absent rather than
 * created, exactly as the purge script does.
 *
 * A source whose gate REFUSES to compile is carried as an error rather than
 * thrown. That refusal means the owner has a rule naming a source that cannot
 * enforce it, and this page is the tool they would use to fix it.
 */
type StoredExclusionDebt = ReturnType<LocalConnectorStore['exclusionDebtPresent']>;

/**
 * Both debts across a source's stores, walked once however many of the two
 * numbers the caller ends up reading.
 *
 * The runtime hands the page two separate accessors, and the page calls both;
 * without the memo that is two full walks of every store per render, for one
 * decision per row that already answers both. The memo is scoped to a runtime
 * that is opened and closed inside a single request, so it can never serve a
 * count from an earlier render.
 */
function storedExclusionDebtReader(handles: readonly LocalConnectorStore[]): () => StoredExclusionDebt {
  let walked: StoredExclusionDebt | undefined;
  return () => {
    if (walked) return walked;
    const total: StoredExclusionDebt = {
      excluded: { items: 0, unevaluable: 0 },
      metadataOnlyContent: { items: 0, unevaluable: 0 },
    };
    for (const handle of handles) {
      const debt = handle.exclusionDebtPresent();
      total.excluded.items += debt.excluded.items;
      total.excluded.unevaluable += debt.excluded.unevaluable;
      total.metadataOnlyContent.items += debt.metadataOnlyContent.items;
      total.metadataOnlyContent.unevaluable += debt.metadataOnlyContent.unevaluable;
    }
    walked = total;
    return total;
  };
}

export function openIngestionDispositionsRuntime(
  env: Record<string, string | undefined> = process.env,
): { sources: SourceDispositionsSource[]; close: () => void } {
  const opened: LocalConnectorStore[] = [];
  const sources: SourceDispositionsSource[] = [];
  for (const definition of INGESTION_DISPOSITION_SOURCES) {
    let stores: ReturnType<typeof definition.stores> = [];
    const handles: LocalConnectorStore[] = [];
    const readDebt = storedExclusionDebtReader(handles);
    try {
      stores = definition.stores(env);
      const matcher = definition.matcher(env);
      for (const store of stores) {
        if (!existsSync(store.dbPath)) continue;
        const handle = openConnectorStore(definition.account, {
          dbPath: store.dbPath,
          corpusId: store.corpusId,
          family: 'file',
          trustDomain: store.trustDomain,
          exclusions: matcher,
          readOnly: true,
        }, env);
        handles.push(handle);
        opened.push(handle);
      }
      sources.push({
        source_id: definition.sourceId,
        label: definition.label,
        corpus_ids: stores.map((store) => store.corpusId),
        enforceable: definition.enforceable,
        matcher,
        store_present: handles.length > 0,
        ...(handles.length > 0
          ? {
            items: function* (): Generator<SourceDispositionItem> {
              for (const handle of handles) yield* handle.itemLocatorCensus();
            },
            excludedItemsPresent: () => readDebt().excluded,
            metadataOnlyContentPresent: () => readDebt().metadataOnlyContent,
          }
          : {}),
      });
    } catch (error) {
      // A store that refuses to open is carried as data like a gate that
      // refuses to compile — but the handles this source already opened would
      // otherwise be orphaned, because the caller's `finally` only ever sees a
      // runtime this function returned.
      for (const handle of handles) {
        const index = opened.indexOf(handle);
        if (index >= 0) opened.splice(index, 1);
        try {
          handle.close();
        } catch {
          // Closing a handle we are already discarding cannot change the entry.
        }
      }
      sources.push({
        source_id: definition.sourceId,
        label: definition.label,
        corpus_ids: stores.map((store) => store.corpusId),
        enforceable: definition.enforceable,
        matcher: createSourceExclusionMatcherFromPrefixes([]),
        store_present: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    sources,
    close: () => {
      for (const handle of opened.reverse()) {
        try {
          handle.close();
        } catch {
          // A close failure must not mask the response that already rendered.
        }
      }
    },
  };
}

export function parseOptionalTimeoutSeconds(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${name} must be a positive number of seconds.`);
  }
  return Math.round(seconds * 1000);
}

export function parseOptionalTimeoutSecondsOrNone(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'none' || normalized === 'unbounded' || normalized === 'disabled') return 0;
  return parseOptionalTimeoutSeconds(value, name);
}

export function trustedAnalystAssistTimeoutMs(input: {
  explicitTrustedAnalystTimeoutMs: number | undefined;
  veniceAnalystTimeoutMs: number | undefined;
}): number | undefined {
  if (input.explicitTrustedAnalystTimeoutMs !== undefined) return input.explicitTrustedAnalystTimeoutMs;
  if (input.veniceAnalystTimeoutMs === undefined) return undefined;
  return Math.min(input.veniceAnalystTimeoutMs + 5_000, 20_000);
}

async function createSovereigntyAnalystMap(input: {
  engine: SovereigntyEngine;
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  defaultLocal: Analyst;
  veniceAnalystTimeoutMs: number | undefined;
  veniceReasoningHeadroomTokens: number | undefined;
  bootSecretResolver?: WorkerBootSecretResolver;
  builtInAnalyst?: Analyst;
  localModelActivity?: LocalModelActivity;
}): Promise<Map<string, {
  profile: SovereigntyResolvedProfile;
  backend: AnalystBackend;
  analyst: Analyst;
}>> {
  const map = new Map<string, {
    profile: SovereigntyResolvedProfile;
    backend: AnalystBackend;
    analyst: Analyst;
  }>();
  const securePoolMemberIds = (() => {
    try {
      return new Set(
        input.engine.resolveAnalystPool({ trustDomain: 'secure_local' })
          .members.map((member) => member.id),
      );
    } catch {
      return new Set<string>();
    }
  })();
  for (const [id, profile] of Object.entries(input.engine.config.modelProfiles)) {
    const resolved = { id, profile };
    if (profile.purpose && profile.purpose !== 'analyst') continue;
    const backend = analystBackendForSovereigntyProfile(profile);
    if (!backend) continue;
    if (profile.provider === 'venice' && securePoolMemberIds.has(id)) {
      const apiKey = resolveSecretRefSync(
        profile.secretRef,
        input.env,
        'Sovereignty Venice analyst profile',
        bootSecretOptions(input.bootSecretResolver, [id], ['analyst'], resolved),
      );
      if (!apiKey) continue;
      await validateSecureVeniceAnalystProfileAtConstruction({ profile, apiKey });
    }
    const analyst = input.engine.source === 'env_bridge' && id === 'local-source-answer'
      ? input.defaultLocal
      : createAnalystForSovereigntyProfile({
          profile,
          profileId: id,
          ...(input.localModelActivity ? { localModelActivity: input.localModelActivity } : {}),
          olympusConfig: input.olympusConfig,
          env: input.env,
          veniceAnalystTimeoutMs: input.veniceAnalystTimeoutMs,
          veniceReasoningHeadroomTokens: input.veniceReasoningHeadroomTokens,
          ...(input.bootSecretResolver ? { bootSecretResolver: input.bootSecretResolver } : {}),
        });
    if (!analyst) continue;
    map.set(id, { profile: resolved, backend, analyst });
  }
  applyBuiltInPrivateAnalyst(map, securePoolMemberIds, input.builtInAnalyst);
  return map;
}

/**
 * The built-in private model backs the Private lane when no other private
 * analyst is configured: with no constructible Venice member in the secure
 * pool, each local secure-pool member falls back to the built-in model when
 * its own model service is not running. A configured, running local service
 * is always used first, and a configured Venice member leaves the pool as is.
 * Returns whether the built-in model was wired in.
 */
export function applyBuiltInPrivateAnalyst(
  map: Map<string, { profile: SovereigntyResolvedProfile; backend: AnalystBackend; analyst: Analyst }>,
  securePoolMemberIds: ReadonlySet<string>,
  builtInAnalyst: Analyst | undefined,
): boolean {
  if (!builtInAnalyst) return false;
  const members = [...securePoolMemberIds].flatMap((id) => {
    const entry = map.get(id);
    return entry ? [[id, entry] as const] : [];
  });
  if (members.some(([, entry]) => entry.backend === 'venice')) return false;
  let wired = false;
  for (const [id, entry] of members) {
    if (entry.backend !== 'local') continue;
    map.set(id, { ...entry, analyst: withBuiltInFallback(entry.analyst, builtInAnalyst) });
    wired = true;
  }
  return wired;
}

/**
 * Whether the built-in model answers for this Private-pool analyst when its
 * server is down, as applyBuiltInPrivateAnalyst wires it: a local member of a
 * pool without Venice. Judged by install state, not by "prepared in this
 * process": boot re-verifies the model while the first readiness check runs,
 * and that check locked every source (#591).
 */
export function builtInBacksPrivateAnalyst(
  id: string,
  state: ReturnType<BuiltInAnalystModel['status']>['state'] | undefined,
  members: readonly { id: string; profile: SovereigntyModelProfile }[],
): boolean {
  if (!state || state === 'failed') return false;
  return members.some((member) => member.id === id) && !members.some((member) => member.profile.provider === 'venice');
}

/** Whether this computer's configured local answer model answers /models within a few seconds. */
async function probeLocalAnalystService(olympusConfig: ReturnType<typeof loadConfig>): Promise<boolean> {
  try {
    await new DelphiClient(olympusConfig).listModelsForProfile('source_answer', AbortSignal.timeout(3_000));
    return true;
  } catch {
    return false;
  }
}

/**
 * The built-in analyst for this worker, or undefined when it is switched off,
 * unsupported here, or the machine has too little memory. Under the test
 * runner it is never created: a test must not fetch model weights.
 */
function createWorkerBuiltInAnalystModel(env: Record<string, string | undefined>): BuiltInAnalystModel | undefined {
  if (env.NODE_ENV === 'test' || !builtInAnalystEnabled(env)) return undefined;
  if (!resolveBuiltInReasoningModel(env)) return undefined;
  return createBuiltInAnalystModel({ env });
}

/**
 * Worker shutdown stops the built-in model's server process (SIGTERM, then
 * SIGKILL; bounded at about 10 s), so a clean shutdown never leaves it running
 * or holding the worker open. A failure is swallowed: shutdown goes on.
 */
export function stopBuiltInModelOnShutdown(model: Pick<BuiltInAnalystModel, 'stop'> | undefined): void {
  if (!model) return;
  try {
    void model.stop().catch(() => undefined);
  } catch {
    // Shutdown continues whatever the model does.
  }
}

/**
 * The worker's one built-in private model, with `available()`: downloaded,
 * verified and prepared in this process, so a caller (the sniffer, the
 * private answer panel) never asks it while a first-time download runs. A
 * model already installed on disk is prepared at boot (a checksum pass, no
 * download); a fresh install is started by the answer pool when the local
 * model service is down.
 */
const BUILT_IN_MODEL_RETRY_MS = 10 * 60_000;

function createWorkerSharedBuiltInModel(
  env: Record<string, string | undefined>,
): { model: BuiltInAnalystModel; available: () => boolean; startIfIdle: () => void } | undefined {
  const base = createWorkerBuiltInAnalystModel(env);
  if (!base) return undefined;
  let prepared = false;
  const installedOnDisk = (): boolean => {
    try {
      const state = base.status().state;
      return state === 'loading' || state === 'ready';
    } catch {
      return false;
    }
  };
  const model: BuiltInAnalystModel = {
    ...base,
    async prepare() {
      await base.prepare();
      prepared = installedOnDisk();
    },
  };
  // Any install this computer has started is re-checked at boot, whatever
  // its status file says: a status file is one process's last word, not a
  // fact about the disk. "verifying" or "downloading" left behind by a
  // process that is gone (or a models directory copied mid-install) used to
  // be trusted and stay there forever. prepare() re-verifies the pinned
  // checksums, resumes or restarts a download, and ends ready or failed.
  if (base.status().state !== 'not_started') void model.prepare();
  // A fresh install's first download, started by the tier sniffer when it
  // has items waiting for this model (prepare() is shared and deduplicated).
  // A verified install (prepared in this process) whose server later failed
  // to start is re-armed too, at most once per BUILT_IN_MODEL_RETRY_MS:
  // otherwise `failed` would keep the sniffer and the private panel off this
  // model until the engine restarts. A failed install is never re-run here.
  let lastRetryMs = 0;
  const startIfIdle = (): void => {
    const status = base.status();
    if (status.state === 'not_started') {
      void model.prepare();
      return;
    }
    if (prepared && status.state === 'failed' && status.failure?.reason === 'runtime_load_failed'
      && Date.now() - lastRetryMs >= BUILT_IN_MODEL_RETRY_MS) {
      lastRetryMs = Date.now();
      void model.prepare();
    }
  };
  return { model, available: () => prepared && installedOnDisk(), startIfIdle };
}

/**
 * Turn one resolved sovereignty pool into the route plan the answer path
 * dispatches over.
 *
 * A pool member whose secret does not resolve is deliberately absent from the
 * analyst map — `WorkerBootSecretResolver` records `worker_credential_degraded`
 * and keeps the worker serving, so one dead credential must not take the pool's
 * healthy members with it. Only a pool with nothing constructible refuses, and
 * it refuses as the typed `config_error` the answer path converts into a
 * metadata-only gap rather than a 500.
 */
export function sovereigntyAnalystRoutePlan(input: {
  trustDomain: SourceTrustDomain;
  pool: {
    members: readonly SovereigntyResolvedProfile[];
    explicitOrder?: readonly SovereigntyResolvedProfile[];
  };
  analysts: ReadonlyMap<string, SovereigntyAnalystRouteStep>;
}): SovereigntyAnalystRoutePlan {
  const profiles = input.pool.explicitOrder ?? input.pool.members;
  const steps = profiles.flatMap((profile) => {
    const entry = input.analysts.get(profile.id);
    return entry ? [entry] : [];
  });
  if (steps.length === 0) {
    throw new OperationError(
      'config_error',
      `Sovereignty analyst route for ${input.trustDomain} is disabled: no configured analyst profile is constructible by this worker (${profiles.map((profile) => profile.id).join(', ')}).`,
      'Restore the analyst credential for one of these profiles and restart the Olympus worker.',
    );
  }
  return {
    poolId: input.trustDomain,
    trustDomain: input.trustDomain,
    selection: input.pool.explicitOrder ? 'explicit_order' : 'health_latency',
    steps,
  };
}

/**
 * Whether secure_local evidence has an approved, constructible private analyst
 * under the active sovereignty policy — the same resolution the answer path
 * dispatches through, asked before retrieval so the handler can decide whether
 * secure_local is searched by default. A disabled route (no-sensitive), a
 * metadata-only secure handling policy, a pool with no member matching the
 * requested provider, or a pool whose every credential failed to resolve all
 * answer "not approved"; any other failure is a real error.
 */
export function secureLocalAnalystRouteStatus(input: {
  engine: Pick<SovereigntyEngine, 'config' | 'resolveAnalystPool'>;
  analysts: ReadonlyMap<string, SovereigntyAnalystRouteStep>;
  requestedProvider: 'default' | 'local' | 'cloud' | 'venice';
}): SecureLocalAnalystRouteStatus {
  if (input.engine.config.retrieval.trustDomains.secure_local?.secureHandling === 'metadata_only_gap') {
    return { approved: false, reason: 'secure_local_metadata_only_policy' };
  }
  try {
    sovereigntyAnalystRoutePlan({
      trustDomain: 'secure_local',
      pool: input.engine.resolveAnalystPool({
        trustDomain: 'secure_local',
        requestedProvider: input.requestedProvider,
      }),
      analysts: input.analysts,
    });
    return { approved: true };
  } catch (error) {
    if (error instanceof OperationError && error.code === 'config_error') {
      return { approved: false, reason: 'no_approved_private_analyst' };
    }
    throw error;
  }
}

export async function validateSecureVeniceAnalystProfileAtConstruction(input: {
  profile: SovereigntyModelProfile;
  apiKey: string;
  catalog?: VeniceModelCatalogOptions;
}): Promise<void> {
  const baseUrl = approvedVeniceAnalystBaseUrl(
    input.profile.baseUrl ?? 'https://api.venice.ai/api/v1',
  );
  await assertVeniceAnalystModelAllowed(
    input.profile.model ?? '',
    true,
    createVenicePrivacyCategoryResolver({
      apiKey: input.apiKey,
      baseUrl,
      ...(input.catalog ? { catalog: input.catalog } : {}),
    }),
  );
}

function analystBackendForSovereigntyProfile(profile: SovereigntyModelProfile): AnalystBackend | undefined {
  if (profile.provider === 'venice') return 'venice';
  if (profile.trust === 'local') return 'local';
  if (profile.trust === 'standard_cloud') return 'cloud';
  if (profile.provider === 'openai-compatible') return 'cloud';
  return undefined;
}

export function createAnalystForSovereigntyProfile(input: {
  profile: SovereigntyModelProfile;
  profileId?: string;
  localModelActivity?: LocalModelActivity;
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  veniceAnalystTimeoutMs: number | undefined;
  veniceReasoningHeadroomTokens: number | undefined;
}): Analyst;
export function createAnalystForSovereigntyProfile(input: {
  profile: SovereigntyModelProfile;
  profileId?: string;
  localModelActivity?: LocalModelActivity;
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  veniceAnalystTimeoutMs: number | undefined;
  veniceReasoningHeadroomTokens: number | undefined;
  bootSecretResolver: WorkerBootSecretResolver;
}): Analyst | undefined;
export function createAnalystForSovereigntyProfile(input: {
  profile: SovereigntyModelProfile;
  profileId?: string;
  localModelActivity?: LocalModelActivity;
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  veniceAnalystTimeoutMs: number | undefined;
  veniceReasoningHeadroomTokens: number | undefined;
  bootSecretResolver?: WorkerBootSecretResolver;
}): Analyst | undefined {
  const { profile } = input;
  const profileId = input.profileId ?? profile.model ?? profile.provider;
  if (profile.provider === 'local-openai-compatible') {
    if (!profile.baseUrl?.trim()) {
      throw new Error('Local sovereignty analyst profiles require baseUrl.');
    }
    const apiKey = profile.secretRef
      ? resolveSecretRefSync(
        profile.secretRef,
        input.env,
        'Sovereignty local analyst profile',
        bootSecretOptions(input.bootSecretResolver, [profileId], ['analyst'], { id: profileId, profile }),
      )
      : undefined;
    if (profile.secretRef && !apiKey) return undefined;
    const config = structuredClone(input.olympusConfig);
    config.argus.modelProfiles.source_answer = {
      ...config.argus.modelProfiles.source_answer,
      baseUrl: profile.baseUrl,
      model: profile.model,
      ...(profile.secretRef ? { secretRef: profile.secretRef } : {}),
      purpose: 'text_reasoning',
    };
    const model = createDelphiAnalystModel(new DelphiClient(config, undefined, {
      resolveSecretRef: () => apiKey,
    }), { profile: 'source_answer', preflightTimeoutMs: 0 });
    return createAnalyst(input.localModelActivity
      ? input.localModelActivity.track(localModelResourceKey(profile), model, { serialize: false }) : model,
    { auditSuspiciousDrafts: true });
  }
  if (profile.provider === 'openclaw-infer') {
    return createAnalyst(createOpenClawInferAnalystModel({
      model: profile.model,
      ...(input.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_THINKING?.trim()
        ? { thinking: input.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_THINKING.trim() }
        : { thinking: 'low' }),
      ...(input.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_COMMAND?.trim()
        ? { command: input.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_COMMAND.trim() }
        : {}),
    }));
  }
  if (profile.provider === 'venice') {
    const apiKey = resolveSecretRefSync(
      profile.secretRef,
      input.env,
      'Sovereignty Venice analyst profile',
      bootSecretOptions(input.bootSecretResolver, [profileId], ['analyst'], { id: profileId, profile }),
    );
    if (!apiKey) return undefined;
    // Construct the catalog-gated adapter once with the pool member. Every
    // dispatch validates its configured model against the authoritative
    // catalog before chat fetch, using the dispatch AbortSignal.
    return createAnalyst(createVeniceAnalystModel({
      apiKey,
      model: profile.model,
      ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
      ...(input.veniceAnalystTimeoutMs !== undefined ? { timeoutMs: input.veniceAnalystTimeoutMs } : {}),
      ...(input.veniceReasoningHeadroomTokens !== undefined
        ? { reasoningHeadroomTokens: input.veniceReasoningHeadroomTokens }
        : {}),
    }));
  }
  if (profile.provider === 'openai-compatible') {
    const apiKey = resolveSecretRefSync(
      profile.secretRef,
      input.env,
      'Sovereignty OpenAI-compatible analyst profile',
      bootSecretOptions(input.bootSecretResolver, [profileId], ['analyst'], { id: profileId, profile }),
    );
    if (!apiKey) return undefined;
    return {
      async analyze(pack, options) {
        return createAnalyst(createOpenAICompatibleAnalystModel({
          apiKey,
          model: profile.model,
          ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
          providerLabel: 'Sovereignty cloud analyst',
        })).analyze(pack, options);
      },
    };
  }
  if (profile.provider === 'anthropic') {
    const apiKey = resolveSecretRefSync(
      profile.secretRef,
      input.env,
      'Sovereignty Anthropic analyst profile',
      bootSecretOptions(input.bootSecretResolver, [profileId], ['analyst'], { id: profileId, profile }),
    );
    if (!apiKey) return undefined;
    return {
      async analyze(pack, options) {
        return createAnalyst(createAnthropicAnalystModel({
          apiKey,
          model: profile.model,
          ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
        })).analyze(pack, options);
      },
    };
  }
  throw new Error(`Sovereignty analyst provider ${profile.provider} is not supported by this worker.`);
}

/**
 * The completion model behind the privacy-safe tier sniffer. Only the two
 * lanes the sniffer lane resolver admits are built here: a loopback local
 * model, or catalog-gated Venice Private (every dispatch re-checks the model's
 * privacy category). Short, cheap, no thinking: it answers one JSON verdict
 * per item.
 */
function createTierSnifferModel(input: {
  lane: SnifferLane;
  olympusConfig: ReturnType<typeof loadConfig>;
  env: Record<string, string | undefined>;
  bootSecretResolver: WorkerBootSecretResolver;
}): AnalystModel | undefined {
  const { lane } = input;
  const profile = lane.profile;
  if (lane.kind === 'local' && profile.provider === 'local-openai-compatible') {
    if (!profile.baseUrl?.trim()) return undefined;
    const apiKey = profile.secretRef
      ? resolveSecretRefSync(
        profile.secretRef,
        input.env,
        'Tier sniffer local model profile',
        bootSecretOptions(input.bootSecretResolver, [lane.profileId], ['classification'], { id: lane.profileId, profile }),
      )
      : undefined;
    if (profile.secretRef && !apiKey) return undefined;
    const config = structuredClone(input.olympusConfig);
    config.argus.modelProfiles.source_answer = {
      ...config.argus.modelProfiles.source_answer,
      baseUrl: profile.baseUrl,
      model: profile.model,
      ...(profile.secretRef ? { secretRef: profile.secretRef } : {}),
      purpose: 'text_reasoning',
    };
    return createDelphiAnalystModel(new DelphiClient(config, undefined, { resolveSecretRef: () => apiKey }), {
      profile: 'source_answer',
      preflightTimeoutMs: 5_000,
    });
  }
  if (lane.kind === 'venice' && profile.provider === 'venice') {
    const apiKey = resolveSecretRefSync(
      profile.secretRef,
      input.env,
      'Tier sniffer Venice model profile',
      bootSecretOptions(input.bootSecretResolver, [lane.profileId], ['classification'], { id: lane.profileId, profile }),
    );
    if (!apiKey) return undefined;
    return createVeniceAnalystModel({
      apiKey,
      model: profile.model,
      ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
      thinking: 'disabled',
      reasoningEffort: 'low',
      reasoningHeadroomTokens: 0,
      timeoutMs: 60_000,
    });
  }
  return undefined;
}

export function analystRouteTrustDomain(pack: { candidates: readonly SecureSensitivityInput[] }, localOnly: boolean): SourceTrustDomain {
  // Secure by domain or by tier selects the secure pool.
  if (localOnly || pack.candidates.some((candidate) => isSecureSensitivity(candidate))) {
    return 'secure_local';
  }
  // Public only when a Public candidate is actually in the pack. An empty pack
  // (nothing matched, or every match was Private on a policy with no Private
  // answer route) takes the Personal route: the Analyst answers it without a
  // model call, and a policy with no Public tier (every shipped preset) has no
  // public_safe route to resolve.
  if (pack.candidates.some((candidate) => candidate.trustDomain === 'public_safe')
    && !pack.candidates.some((candidate) => candidate.trustDomain === 'internal')) {
    return 'public_safe';
  }
  return 'internal';
}


function parseRequiredTimeoutSeconds(value: string, name: string): number {
  return parseOptionalTimeoutSeconds(value, name) ?? (() => {
    throw new Error(`${name} must be a positive number of seconds.`);
  })();
}

function parseVeniceReasoningEffort(value: string): OpenAIReasoningEffort {
  const normalized = value.trim();
  if ([
    'none',
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
  ].includes(normalized)) {
    return normalized as OpenAIReasoningEffort;
  }
  throw new Error('OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_REASONING_EFFORT must be one of none, minimal, low, medium, high, xhigh, max.');
}

function parseVeniceThinkingMode(value: string): VeniceThinkingMode {
  const normalized = value.trim();
  if (normalized === 'enabled' || normalized === 'on' || normalized === 'true') return 'enabled';
  if (normalized === 'disabled' || normalized === 'off' || normalized === 'false') return 'disabled';
  throw new Error('OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_THINKING must be enabled or disabled.');
}

function parseOptionalTokenCount(value: string | undefined, name: string): number | undefined {
  return parseOptionalPositiveInteger(value, name);
}

export function parseOptionalPositiveInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function parseOptionalNonNegativeInteger(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
  return parsed;
}

export function sourceIndexSemanticRelevanceBarFromEnv(
  env: Record<string, string | undefined>,
): number {
  const name = 'OLYMPUS_SOURCE_INDEX_SEMANTIC_RELEVANCE_BAR';
  const value = env[name];
  if (value === undefined) return DEFAULT_SEMANTIC_RELEVANCE_BAR;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
    throw new Error(`${name} must be a finite number greater than 0 and less than 1.`);
  }
  return parsed;
}

export function parseSecureDerivativeDefault(value: string | undefined): 'allow' | 'approval' | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'allow' || normalized === 'approval') return normalized;
  throw new Error('OLYMPUS_SECURE_DERIVATIVE_DEFAULT must be allow or approval.');
}

export function sourceIndexTelegramAccountFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return optionalEnv(env, 'OLYMPUS_SOURCE_INDEX_TELEGRAM_ACCOUNT');
}

export function sourceAnswerAccountForCorpus(
  request: { account?: string; corpus_id?: string },
  defaults: { sourceIndexAccount?: string | undefined; telegramMessagesAccount?: string | undefined },
  corpusId?: string,
): string | undefined {
  const requested = request.account?.trim();
  if (requested) return requested;
  const effectiveCorpusId = corpusId ?? request.corpus_id;
  if (effectiveCorpusId === INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID) {
    return defaults.telegramMessagesAccount;
  }
  return defaults.sourceIndexAccount;
}

// The narrowing filters a connector-store corpus can honour on the answer
// lane, resolved through the same codecs `/source/index/search` resolves them
// with. Only the two `source_answer` wire fields are listed: folder filters and
// locator release are search-only surfaces.
const CONNECTOR_STORE_ANSWER_FILTER_CAPABILITIES = connectorStoreFilterCapabilityRegistry([
  [{ family: 'chat' }, { chatScope: CHAT_SCOPE_FILTER_CODEC }],
  [{ family: 'file', provider: 'dropbox' }, { approvedScope: DROPBOX_APPROVED_SCOPE_FILTER_CODEC }],
  [{ family: 'file', provider: LOCAL_FILES_PROVIDER }, { approvedScope: LOCAL_FILES_APPROVED_SCOPE_FILTER_CODEC }],
]);

export interface ConnectorStoreAnswerScopeStore {
  corpusId: string;
  family: SourceFamily;
  conversationTitleCandidates(
    lookupTerms: readonly string[],
    accountScope?: string,
    provider?: string,
  ): ConnectorStoreConversationTitleCandidates;
}

export type ConnectorStoreAnswerScope =
  | Readonly<{ kind: 'search'; accountScope?: string; filters?: ConnectorStoreSearchFilters }>
  | Readonly<{ kind: 'skip'; reason: string }>;

/**
 * Resolve one connector-store corpus's share of a `source_answer` request into
 * the account scope and filters its adapter must carry.
 *
 * `chat_scope` and `approved_scope_key` are narrowing filters that
 * `/source/index/search` resolves through the capability codecs and refuses
 * (400 `unsupported_filter` / `invalid_request`) when it cannot honour them.
 * The answer lane fans out instead of refusing, so the same unhonourable state
 * skips the corpus — audited `no_adapter` — rather than searching it whole. A
 * corpus whose family has no codec for a filter is not scoped BY that filter
 * (chat scope does not narrow Dropbox), which is what the legacy per-source
 * adapters did and what the wire contract describes.
 */
export function connectorStoreAnswerScope(input: {
  store: ConnectorStoreAnswerScopeStore;
  request: SourceIndexAnswerRequest;
  principal?: ConnectorStoreDeclaredPrincipal;
  capabilities?: ConnectorStoreFilterCapabilityRegistry;
}): ConnectorStoreAnswerScope {
  const { store, principal, request } = input;
  const capabilities = (input.capabilities ?? CONNECTOR_STORE_ANSWER_FILTER_CAPABILITIES).resolve({
    family: store.family,
    ...(principal ? { provider: principal.provider } : {}),
  });
  const requestedAccount = request.account?.trim() || undefined;
  const approvedScopeKey = request.approved_scope_key?.trim() || undefined;
  const chatScope = request.chat_scope?.trim() || undefined;
  const conversationId = request.conversation_id?.trim() || undefined;

  let accountScope: string | undefined;
  let provider: string | undefined;
  let locatorPathScope: string | undefined;
  let scopedConversationId = conversationId;

  if (approvedScopeKey && capabilities?.approvedScope) {
    if (!principal) return { kind: 'skip', reason: 'approved_scope_key_no_principal' };
    const resolution = capabilities.approvedScope.resolveLocatorPath(approvedScopeKey, principal);
    if (resolution.kind !== 'path') return { kind: 'skip', reason: 'approved_scope_key_invalid' };
    if (requestedAccount !== undefined && requestedAccount !== resolution.accountScope) {
      return { kind: 'skip', reason: 'approved_scope_key_account_mismatch' };
    }
    accountScope = resolution.accountScope;
    provider = principal.provider;
    locatorPathScope = resolution.locatorPath;
  }

  if (chatScope && capabilities?.chatScope) {
    if (!principal) return { kind: 'skip', reason: 'chat_scope_no_principal' };
    if (requestedAccount !== undefined && requestedAccount !== principal.accountScope) {
      return { kind: 'skip', reason: 'chat_scope_account_mismatch' };
    }
    const resolution = capabilities.chatScope.resolveConversationId(
      chatScope,
      (lookupTerms) => store.conversationTitleCandidates(
        lookupTerms,
        principal.accountScope,
        principal.provider,
      ),
    );
    if (resolution.kind === 'invalid') return { kind: 'skip', reason: 'chat_scope_invalid' };
    if (resolution.kind === 'structured') {
      if (resolution.provider !== undefined && resolution.provider !== principal.provider) {
        return { kind: 'skip', reason: 'chat_scope_provider_mismatch' };
      }
      if (resolution.accountScope !== principal.accountScope) {
        return { kind: 'skip', reason: 'chat_scope_account_mismatch' };
      }
    }
    if (conversationId && (!resolution.resolved || resolution.conversationId !== conversationId)) {
      return { kind: 'skip', reason: 'chat_scope_conversation_id_conflict' };
    }
    accountScope = principal.accountScope;
    provider = principal.provider;
    // An unresolved title keeps the codec's sentinel conversation id, which
    // matches no row: an unresolvable scope narrows to nothing, never to all.
    scopedConversationId = resolution.conversationId;
  }

  const senderId = request.sender_id?.trim() || undefined;
  const senderLabel = request.sender_label?.trim() || undefined;
  const authoredAfter = request.authored_after?.trim() || undefined;
  const authoredBefore = request.authored_before?.trim() || undefined;
  const filters: ConnectorStoreSearchFilters = {
    ...(provider ? { provider } : {}),
    ...(locatorPathScope ? { locatorPathScope } : {}),
    ...(scopedConversationId ? { conversationId: scopedConversationId } : {}),
    ...(senderId ? { senderId } : {}),
    ...(senderLabel ? { senderLabel } : {}),
    ...(authoredAfter ? { authoredAfter } : {}),
    ...(authoredBefore ? { authoredBefore } : {}),
  };
  return {
    kind: 'search',
    ...(accountScope ? { accountScope } : {}),
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
  };
}



/** The analyst's own test for a candidate it matched but could not read. */




export function accountFromDropboxCredentialHandle(value: string | undefined): string | undefined {
  const handle = value?.trim();
  if (!handle) return undefined;
  const match = /^dropbox\.([a-z0-9_-]+)(?:\.|$)/i.exec(handle);
  return match?.[1];
}


/**
 * The local VLM client for file extraction, from the
 * OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_* settings, or undefined when that lane is
 * off. The client refuses a model id with a reserved cloud-style tag.
 */
export function createFileExtractionLocalVlmClientFromEnv(
  env: Record<string, string | undefined>,
): OpenAICompatibleVlmClient | undefined {
  const fileExtractionLocalVlmEnabled = parseOptionalBooleanEnv(
    env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_ENABLED,
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_ENABLED',
  );
  const fileExtractionLocalVlmConfigured = [
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_BASE_URL',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_MODEL',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_API_KEY',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_TIMEOUT_SECONDS',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_MAX_PAGES',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRIES',
    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRY_DELAY_MS',
  ].some((name) => Boolean(env[name]?.trim()));
  if (fileExtractionLocalVlmConfigured && !fileExtractionLocalVlmEnabled) {
    throw new Error(
      'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_ENABLED=true is required when local VLM settings are present.',
    );
  }
  return fileExtractionLocalVlmEnabled
    ? new OpenAICompatibleVlmClient({
        baseUrl: requiredFileExtractionEnv(
          env,
          'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_BASE_URL',
        ),
        model: requiredFileExtractionEnv(
          env,
          'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_MODEL',
        ),
        ...(env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_API_KEY?.trim()
          ? { apiKey: env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_API_KEY.trim() }
          : {}),
        ...(parseOptionalTimeoutSecondsOrNone(
          env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_TIMEOUT_SECONDS,
          'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_TIMEOUT_SECONDS',
        ) !== undefined
          ? {
              timeoutMs: parseOptionalTimeoutSecondsOrNone(
                env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_TIMEOUT_SECONDS,
                'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_TIMEOUT_SECONDS',
              )!,
            }
          : {}),
      })
    : undefined;
}

/** How this process was launched; set only by startWorkerWithLaunch from the validated entry point. */
let workerLaunch: WorkerLaunch = {};

/**
 * The CLI's entry: the launch state runWorkerForeground validated (never an
 * ambient variable) rides into main() for the restart decision.
 */
export async function startWorkerWithLaunch(launch: WorkerLaunch): Promise<void> {
  workerLaunch = { ...launch };
  await main();
}

/**
 * The data owner lock, held from boot until the process exits (the kernel
 * releases it then). Module state so it stays referenced: a collected lock
 * would close its connection and let go.
 */
let dataOwnerLock: HeldDataOwnerLock | undefined;

/**
 * Under the owner lock, first, before anything mounts or any capture starts
 * (docs/design/source-storage.md, "Delete"): removes each account a Delete
 * marked `deleting` (data-lifecycle.ts, `deleteMarkedAccounts`). An account
 * that cannot be removed stays marked, and closed, until a later boot; the
 * other accounts and the worker start as always.
 */
export function deleteMarkedAccountsAtBoot(env: Record<string, string | undefined>): DeleteMarkedAccountsReport | undefined {
  try {
    const report = deleteMarkedAccounts({ env });
    for (const { sourceId, removed } of report.deleted) console.log(`[storage] ${sourceId}'s data was deleted (${removed} files and folders).`);
    for (const { sourceId, message } of report.failed) console.warn(`[storage] ${sourceId}'s data could not be deleted yet (${message}); it stays closed and the next start tries again.`);
    return report;
  } catch (error) {
    console.warn(`[storage] Could not check which accounts are being deleted (${error instanceof Error ? error.message : 'unknown error'}); every account stays closed until the registry is repaired.`);
    return undefined;
  }
}

/**
 * Under the owner lock and before anything mounts (core/source-storage.ts,
 * `replaceEmptyLegacyAccounts`). A failure here changes nothing and does not
 * stop the worker: the accounts stay where the registry has them.
 */
export function replaceEmptyAccountsAtBoot(env: Record<string, string | undefined>): string[] {
  try {
    const replaced = replaceEmptyLegacyAccounts(env);
    for (const sourceId of replaced) console.log(`[storage] ${sourceId} holds nothing yet; its files will live in its account folder.`);
    return replaced;
  } catch (error) {
    console.warn(`[storage] Could not check which empty accounts to place in folders (${error instanceof Error ? error.message : 'unknown error'}); they stay as recorded.`);
    return [];
  }
}

/**
 * Under the owner lock, after the empty accounts are placed and before
 * adoption is on and anything mounts (core/source-account-migration.ts): moves
 * each existing account's files into its folder unless
 * `OLYMPUS_MIGRATE_ACCOUNT_FOLDERS=0`, and finishes or undoes a move an earlier
 * boot left part way whatever the switch says. A registry that cannot be read
 * leaves every account where it is and the worker boots as it always did.
 */
export function migrateAccountFoldersAtBoot(env: Record<string, string | undefined>, options: AccountMigrationOptions = {}): AccountMigrationReport | undefined {
  if (!accountFolderMigrationEnabled(env)) {
    console.log(`[storage] Moving accounts into their folders is off (OLYMPUS_MIGRATE_ACCOUNT_FOLDERS=${env.OLYMPUS_MIGRATE_ACCOUNT_FOLDERS?.trim()}); a move already under way is still finished or undone.`);
  }
  try {
    const report = migrateAccountFolders(env, options);
    for (const sourceId of report.moved) console.log(`[storage] ${sourceId} moved into its account folder.`);
    for (const { sourceId, reason } of report.movedBack) console.warn(`[storage] ${sourceId} could not be moved (${reason}); its files were put back where they were.`);
    for (const { sourceId, reason } of report.skipped) console.log(`[storage] ${sourceId} stays where it is (${reason}).`);
    for (const { sourceId, detail } of report.stuck) console.warn(`[storage] ${sourceId} is part way through a move and stays closed until a restart finishes it: ${detail}`);
    for (const sourceId of report.deferred) console.log(`[storage] ${sourceId} will be moved at a later start; this one ran out of time.`);
    for (const { sourceId, message } of report.errors) console.warn(`[storage] ${sourceId} was not moved (${message}).`);
    return report;
  } catch (error) {
    console.warn(`[storage] Could not check which accounts to move into folders (${error instanceof Error ? error.message : 'unknown error'}); they stay as recorded.`);
    return undefined;
  }
}

/**
 * The boot's whole account-folder step for the messaging sources too
 * (core/messaging-account-move.ts): with the switch on, what each Telegram and
 * WhatsApp account's records outside the data folder say is gathered first, so
 * the pass can weigh them; after it, every record that still names the old
 * place of an account a move finished is rewritten (switch or no switch, like
 * a plan left part way). Before any capture child or service starts: the
 * worker's capture supervisors are made after this, and the Gateway-run
 * services wait for the worker's readiness.
 */
export async function moveAccountsAtBoot(env: Record<string, string | undefined>, secretStore: SecretStore = lazySecretStore(env)): Promise<AccountMigrationReport | undefined> {
  const messaging = accountFolderMigrationEnabled(env) ? await messagingMoveFacts(env, secretStore) : undefined;
  const report = migrateAccountFoldersAtBoot(env, messaging ? { messaging } : {});
  const repointed = await repointMovedMessagingAccounts(env, secretStore);
  for (const record of repointed.rewritten) console.log(`[storage] ${record} now names the account folder.`);
  for (const { sourceId, message } of repointed.errors) console.warn(`[storage] ${sourceId} still has a record that names its old place (${message}); the next start tries again.`);
  return report;
}

/** The secret store, made only if a boot step reads it (most boots do not). */
function lazySecretStore(env: Record<string, string | undefined>): SecretStore {
  let store: SecretStore | undefined;
  const real = (): SecretStore => (store ??= createDefaultSecretStore({ env }));
  return {
    get label() { return real().label; },
    get: (key) => real().get(key),
    set: (key, value) => real().set(key, value),
    delete: (key) => real().delete(key),
    list: () => real().list(),
  };
}

export async function main(): Promise<void> {
  // First, before anything mounts or opens a store: this worker owns the data
  // root. A second worker on it waits a short while (restarts overlap), then
  // exits without mounting anything (core/data-owner-lock.ts).
  dataOwnerLock = takeWorkerDataOwnerLock(process.env);
  // A retired per-store path setting would open empty stores beside the
  // account's real files: refuse to start, naming each, before anything opens
  // or moves (the lock goes with the process).
  const retired = retiredPathSettings(process.env);
  if (retired.length > 0) {
    throw new Error(
      `[storage] These path settings are no longer read (source storage step 6): ${retired.join('; ')}. `
      + 'Move each file to where Olympus keeps it, or remove the setting if it named the usual place, then start again.',
    );
  }
  // An account a Delete marked is removed before anything else looks at it.
  deleteMarkedAccountsAtBoot(process.env);
  // An account recorded as legacy that holds nothing is placed in a folder instead.
  replaceEmptyAccountsAtBoot(process.env);
  // With the switch on, existing accounts move into their folders; a move under way is finished or undone.
  await moveAccountsAtBoot(process.env);
  // From here on, a writable store open records its account in the registry
  // (core/source-storage.ts). Before any lane mounts.
  enableSourceRegistryAdoption();
  // Startup signals can close only this instance's listener/client. A second
  // foreground worker never revokes the engine host's epoch or runtime path.
  let closeDesktopBridge = () => {};
  const shutdownSignals = installWorkerShutdownSignals({ closeOwnerBridge: () => closeDesktopBridge(), exit: code => process.exit(code) });
  const port = parsePort(process.env.OLYMPUS_EMAIL_SOURCE_PORT ?? '8010');
  const xBookmarksSemanticRelevanceBar = sourceIndexSemanticRelevanceBarFromEnv(process.env);
  const hostname = resolveEmailSourceBindHostFromEnv(process.env);
  const authToken = workerAuthTokenFromEnv(process.env);
  // The dashboard control-session signing secret: its own owner-only file
  // beside the worker token, created on first start, never the bearer.
  const dashboardSessionSecret = loadOrCreateDashboardSessionSecret({ env: process.env });
  if (dashboardSessionSecret.source !== 'file') {
    console.log(`[dashboard] control-session secret ${dashboardSessionSecret.source} at ${dashboardSessionSecret.path}${dashboardSessionSecret.source === 'memory' ? ' (could not be written; sessions end with this worker)' : ''}`);
  }
  // A Gateway- or engine-supervised child takes `remote` from the plugin config
  // its supervisor handed over and never from anything else. Any other launch
  // (a systemd or launchd worker unit, `olympus worker run`) never reads that
  // handoff; on an OpenClaw host it reads the plugin's `remote` from openclaw.json.
  const olympusConfig = loadWorkerConfig(workerLaunch, process.env);
  if (workerLaunch.nativeServiceSupervised !== true) {
    const openClawRemote = readOpenClawPluginRemote(process.env);
    if (openClawRemote.hosted && 'unreadable' in openClawRemote) {
      console.warn(`[remote] ${openClawRemote.path} could not be read or parsed; remote access and demo sign-in are off for this worker.`);
    }
  }
  // Imported archives' stores are served here although they are not yet on
  // the public plugin-config roster (archive-import/store.ts).
  const sourceCorpusRegistry = createSourceCorpusRegistry(withArchiveImportCorpora(olympusConfig.sourceIndex.corpusRegistry));
  const dropboxIngestionPolicy = loadDropboxIngestionPolicy({
    inlinePolicy: olympusConfig.sourceIndex.ingestionPolicies.dropboxPersonal?.policy,
    policyPath: olympusConfig.sourceIndex.ingestionPolicies.dropboxPersonal?.policyPath,
    env: process.env,
  });
  const sovereigntyEngine = loadSourceWorkerSovereignty(olympusConfig, process.env);
  const bootSecretResolver = new WorkerBootSecretResolver({
    resolveSecretRefValueSync: (secretRef, env) => resolveSecretRefValueSync(secretRef, { env }),
  });
  // The built-in private model: one instance per worker, shared by the tier
  // sniffer, the Private answer pool's fallback and ChatGPT's private answer
  // panel, so at most one local model server runs. Registered for the
  // sniffer before its runtime is resolved below.
  const localModelActivity = createLocalModelActivity();
  const workerBuiltInModel = createWorkerSharedBuiltInModel(process.env);
  const answerBuiltInModel = workerBuiltInModel
    ? localModelActivity.track('built_in', workerBuiltInModel.model) : undefined;
  registerBuiltInPrivateModel(workerBuiltInModel
    ? { cacheModelId: `${workerBuiltInModel.model.spec.modelId}:${workerBuiltInModel.model.spec.revision}:${workerBuiltInModel.model.spec.file.sha256}`, model: workerBuiltInModel.model, available: workerBuiltInModel.available, startIfIdle: workerBuiltInModel.startIfIdle }
    : undefined);
  // Four-tier classification inputs for every lane: the owner's map, tier
  // rules, their own words about privacy, and the privacy-safe sniffer. The
  // sniffer only ever runs on a local model or Venice Private, else on the
  // built-in private model when this machine has one (it registers itself
  // with registerBuiltInPrivateModel before this point); without any,
  // flagged items stay pending and unflagged items are Personal at once.
  const snifferRuntime = resolveTierSnifferRuntime({
    engine: sovereigntyEngine,
    ...(registeredBuiltInPrivateModel() ? { builtIn: registeredBuiltInPrivateModel()! } : {}),
    standaloneEngine: isStandaloneEngineProcess(process.env),
  });
  const snifferLane: SnifferLane | undefined = snifferRuntime.source === 'off' ? undefined : snifferRuntime.lane;
  if (snifferRuntime.source === 'off') {
    console.warn(`Olympus tier sniffer is off (${snifferRuntime.reason}): items whose names look private stay pending, held Private; every other item is Personal.`);
  }
  // A policy with no Public tier (fresh installs): Public verdicts are Personal.
  const publicTierRetired = isPublicTierRetired(sovereigntyEngine.config);
  const privacyOwnerWords = (): string | undefined => privacyOwnerContext({ env: process.env });
  const installedTierClassification = configureInstalledTierClassification({
    env: process.env,
    ...(snifferLane ? { lane: snifferLane } : {}),
    ...(publicTierRetired ? { retirePublic: true } : {}),
    ownerContext: privacyOwnerWords,
  });
  // Shared with the answer handler so the sniffer reads the private pool's
  // breakers, and counts answers in flight so it never competes with one.
  const secureAnalystPoolState = new SecureAnalystPoolState();
  // UI answer leases coordinate owner/background jobs. Actual local model
  // dispatches have separate leases; cloud searches never preempt sorting.
  const answerActivity = createAnswerActivity(() => undefined, {
    onExpired: (openMs) => console.warn(`Olympus answer activity: an answer still open after ${Math.round(openMs / 60_000)} min stopped holding background work.`),
  });
  // Set once the sniffer runs: its backlog, for the status surface.
  let classificationBusy = () => false;
  let tierSnifferBacklog: (() => ReturnType<TierSnifferService['backlog']>) | undefined;
  // Set once the sniffer is built: whether it can judge imported items now.
  let archivePrivateModelState: () => ArchivePrivateModelState = () => 'waiting';
  const connector = createEmailSourceConnectorFromEnv();
  const sourceIndexAnswerEnabled = parseOptionalBooleanEnv(
    process.env.OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED,
    'OLYMPUS_SOURCE_INDEX_ANSWER_ENABLED',
  );
  const sourceIndexReadEnabled = olympusConfig.sourceIndex.enabled || sourceIndexAnswerEnabled;
  const sourceIndexAccount = process.env.OLYMPUS_SOURCE_INDEX_ACCOUNT
    ?? process.env.OLYMPUS_EMAIL_SOURCE_ACCOUNT;
  const dropboxFilesAccount =
    process.env.OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_ACCOUNT?.trim()
    || accountFromDropboxCredentialHandle(process.env.OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE);
  const connectedHandles = readActiveConnectedHandles(process.env);
  const connectedHandleRegistryPath = handleRegistryPathFromEnv(process.env, true);
  const packageRoot = olympusPackageRoot();
  const captureOwnership = createWorkerMessagingCaptureOwnership({
    registryPath: connectedHandleRegistryPath!,
    packageRoot,
  });
  const captures = captureOwnership.captures;
  let captureReconcileRunning = false;
  let capturesClosed = false;
  // What each supervisor last reported, for the dashboard. Absent for a source
  // whose capture the native service owns: this worker runs nothing there.
  const captureStatuses: Partial<Record<'telegram' | 'whatsapp', MessagingCaptureStatus>> = {};
  // Sources whose last reconcile threw: their old status is no fact about the helper.
  const captureFailures: Partial<Record<'telegram' | 'whatsapp', true>> = {};
  const captureEntries = () => Object.entries(captures) as Array<['telegram' | 'whatsapp', WorkerMessagingCaptureSupervisor]>;
  const reconcileCaptures = async () => {
    if (capturesClosed || captureReconcileRunning) return;
    captureReconcileRunning = true;
    try {
      await reconcileWorkerCaptures({
        captures,
        statuses: captureStatuses,
        failures: captureFailures,
      });
    } finally { captureReconcileRunning = false; }
  };
  const dashboardCaptureRuntime = () => workerCaptureRuntime({
    sources: captureEntries().map(([source]) => source),
    statuses: captureStatuses,
    registryPath: connectedHandleRegistryPath,
    liveness: Object.fromEntries(captureEntries().map(([source, capture]) => [source, capture.liveness?.()])),
    failures: captureFailures,
  });
  const stopMessagingCapture = async (source: 'telegram' | 'whatsapp') => {
    await captureOwnership.stopForUnpair(source);
  };

  const fileSourceScopeAuthority = connectedHandleRegistryPath
    ? new FileSourceScopeAuthority({
        registryPath: connectedHandleRegistryPath,
        // The mail scope binds to the handle the Gmail lane reads, so a pinned
        // second mailbox never inherits the first one's approval.
        mailPinnedHandle: () => process.env.OLYMPUS_SOURCE_INDEX_GMAIL_CREDENTIAL_HANDLE,
      })
    : undefined;
  const dropboxHandle = selectedSourceCredentialHandle({
    env: process.env,
    pinEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE',
    provider: 'dropbox',
    capability: 'dropbox.files.sync',
    handles: connectedHandles,
  });
  // Gmail and Drive deliberately have no boot-time handle binding: their lanes
  // select a handle per scheduler build. X and Readwise follow the same rule
  // below: their canonical stores exist independently, while provider reads
  // bind only to a currently usable handle.
  const xBookmarksCredentialHandle = selectedSourceCredentialHandle({
    env: process.env,
    pinEnvName: 'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CREDENTIAL_HANDLE',
    provider: 'x',
    capability: 'x.bookmarks.sync',
    handles: connectedHandles,
  });
  const xBookmarksHandle = sourceIndexLaneEnabled(
    process.env,
    'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_ENABLED',
    xBookmarksCredentialHandle !== undefined,
  ) ? xBookmarksCredentialHandle : undefined;
  const envPolicyFallback = sovereigntyEngine.source === 'env_bridge';
  const internalPolicyEmbeddingProvider = createSourceIndexEmbeddingProviderFromSovereignty(
    sovereigntyEngine,
    'internal',
    process.env,
    bootSecretResolver,
  );
  const secureLocalPolicyEmbeddingProvider = createSourceIndexEmbeddingProviderFromSovereignty(
    sovereigntyEngine,
    'secure_local',
    process.env,
    bootSecretResolver,
  );
  const sourceIndexEmbeddingProvider = internalPolicyEmbeddingProvider
    ?? (envPolicyFallback ? createSourceIndexEmbeddingProviderFromEnv() : undefined);
  // The built-in model downloads once, on first use. Start that at boot so a
  // new install shows "installing" right away instead of at its first index,
  // and run one query through it so the first question after a start is not
  // the one that waits for the model to load and warm up.
  // Never under the test runner: a test must not fetch model weights.
  if (process.env.NODE_ENV !== 'test') {
    for (const provider of new Set([internalPolicyEmbeddingProvider, secureLocalPolicyEmbeddingProvider])) {
      if (provider instanceof BuiltInSourceEmbeddingProvider) void provider.warm().catch(() => undefined);
    }
  }
  const readwiseEmbeddingProvider = envPolicyFallback
    ? createCloudSourceIndexEmbeddingProviderFromEnv(
      process.env,
      'OLYMPUS_SOURCE_INDEX_READWISE',
    ) ?? sourceIndexEmbeddingProvider
    : sourceIndexEmbeddingProvider;
  const xBookmarksEmbeddingProvider = envPolicyFallback
    ? createCloudSourceIndexEmbeddingProviderFromEnv(
      process.env,
      'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS',
    ) ?? sourceIndexEmbeddingProvider
    : sourceIndexEmbeddingProvider;
  const localFilesEmbeddingProvider = secureLocalPolicyEmbeddingProvider
    ?? (sourceIndexEmbeddingProvider && isApprovedSecureSourceEmbeddingProvider(sourceIndexEmbeddingProvider)
      ? sourceIndexEmbeddingProvider
      : undefined);
  const dropboxFilesEmbeddingProvider = secureLocalPolicyEmbeddingProvider
    ?? (sourceIndexEmbeddingProvider && isApprovedSecureSourceEmbeddingProvider(sourceIndexEmbeddingProvider)
      ? sourceIndexEmbeddingProvider
      : undefined);
  // Telegram chunks are local-only (internal + secure_local lanes): never hand
  // them to a cloud embedding backend.
  // Frontier-max doctrine: the telegram index gates per trust domain itself —
  // cloud providers are accepted and used ONLY for the internal corpus;
  // protected/secure_local lanes skip semantic until a local provider exists.
  // Prefer the cloud (Gemini) factory like readwise/x — the global source
  // provider on the runtime is the LOCAL lane (dropbox/email depend on it).
  const telegramMessagesEmbeddingProvider = envPolicyFallback
    ? createCloudSourceIndexEmbeddingProviderFromEnv(
      process.env,
      'OLYMPUS_SOURCE_INDEX_TELEGRAM',
    ) ?? sourceIndexEmbeddingProvider
    : sourceIndexEmbeddingProvider;
  // Drive/Docs is INTERNAL only (there is no secure drive corpus), so the
  // cloud (Gemini) source-index provider rides directly — NO local-only gate.
  const googleDriveDocsEmbeddingProvider = sourceIndexEmbeddingProvider;
  const requiredProfiles = requiredModelProfiles(sovereigntyEngine.config);
  const safeModelCredential = (profile: typeof requiredProfiles[number]['profile'], env: Record<string, string | undefined>): string | undefined => {
    if (!profile.secretRef) return undefined;
    try { return resolveSecretRefValueSync(profile.secretRef, { env })?.trim() || undefined; }
    catch { return undefined; }
  };
  // Only used inside this process to distinguish stored from applied keys.
  const bootModelCredentials = new Map(requiredProfiles.map(({ id, profile }) => [id, safeModelCredential(profile, process.env)]));
  const modelCredentialState = (id: string, profile: typeof requiredProfiles[number]['profile']): ModelCredentialState => {
    if (!profile.secretRef) return bootSecretResolver.status().some((failure) => failure.affected_profiles?.includes(id)) ? 'missing' : 'ready';
    const storedEnv = { ...process.env, ...(readWorkerSetupEnv() ?? {}) };
    const current = safeModelCredential(profile, storedEnv);
    if (!current) return 'missing';
    if (current !== bootModelCredentials.get(id)
      || bootSecretResolver.status().some((failure) => failure.affected_profiles?.includes(id))) return 'applying';
    return 'ready';
  };
  let requestModelReload: (request?: ModelKeyReloadRequest) => boolean = () => false;
  // Set once the real reload is installed (after startup): until then a
  // request is a no-op, so Delete indexed data must refuse rather than leave
  // open handles serving deleted rows (PR #455 review).
  let modelReloadInstalled = false;
  let modelReloadUnavailable = false;
  const modelSetup = new ModelSetupService({
    config: sovereigntyEngine.config,
    credentialState: modelCredentialState,
    localApiKey: (id) => bootModelCredentials.get(id),
    expectedEmbeddingDimension: (id) => {
      const secure = sovereigntyEngine.resolveEmbeddingProfile('secure_local');
      if (secure?.id === id) return secureLocalPolicyEmbeddingProvider?.dimension;
      const internal = sovereigntyEngine.resolveEmbeddingProfile('internal');
      if (internal?.id === id) return internalPolicyEmbeddingProvider?.dimension;
      return undefined;
    },
    builtInAnswers: (id) => {
      try {
        return builtInBacksPrivateAnalyst(id, workerBuiltInModel?.model.status().state, sovereigntyEngine.resolveAnalystPool({ trustDomain: 'secure_local' }).members);
      } catch {
        return false;
      }
    },
  });
  const getModelSetup = () => {
    const view = modelSetup.getStatus();
    if (!modelReloadUnavailable) return view;
    return { ...view, ready: false, cards: view.cards.map((card) => card.state === 'applying'
      ? { ...card, state: 'needs_attention' as const, detail: 'Key saved. Ask your agent to restart the managed Olympus worker to apply it; this foreground worker cannot restart itself.' }
      : card) };
  };
  const connectModelKey = async (provider: 'gemini' | 'venice', apiKey: string): Promise<void> => {
    if (provider === 'gemini') await connectGeminiApiKey({ apiKey });
    else await connectPublicApiKeySource({ source: 'venice', apiKey });
    const credentials = requiredProfiles.map(({ id, profile }) => modelCredentialState(id, profile));
    if (!credentials.includes('missing') && credentials.includes('applying')) {
      modelReloadUnavailable = !requestModelReload();
    }
  };

  const fileExtractionPdfTextCommandEnv = process.env.OLYMPUS_FILE_EXTRACTION_PDF_TEXT_COMMAND?.trim();
  const fileExtractionPdfTextCommand = fileExtractionPdfTextCommandEnv === 'off'
    ? undefined
    : (fileExtractionPdfTextCommandEnv || 'pdftotext');
  const fileExtractionPdfTextTimeoutMs = parseOptionalTimeoutSecondsOrNone(
    process.env.OLYMPUS_FILE_EXTRACTION_PDF_TEXT_TIMEOUT_SECONDS,
    'OLYMPUS_FILE_EXTRACTION_PDF_TEXT_TIMEOUT_SECONDS',
  );
  const fileExtractionPdfRenderTimeoutMs = parseOptionalTimeoutSecondsOrNone(
    process.env.OLYMPUS_FILE_EXTRACTION_PDF_RENDER_TIMEOUT_SECONDS,
    'OLYMPUS_FILE_EXTRACTION_PDF_RENDER_TIMEOUT_SECONDS',
  );
  const fileExtractionOcrTimeoutMs = parseOptionalTimeoutSecondsOrNone(
    process.env.OLYMPUS_FILE_EXTRACTION_OCR_TIMEOUT_SECONDS,
    'OLYMPUS_FILE_EXTRACTION_OCR_TIMEOUT_SECONDS',
  );
  // `auto` reads scans with the Mac's built-in Vision engine and with
  // tesseract elsewhere; `tesseract` keeps the installed commands on a Mac.
  const fileExtractionOcrEngine = parseOcrEnginePreference(process.env.OLYMPUS_FILE_EXTRACTION_OCR_ENGINE);
  const fileExtractionOcrMaxPages = parseOptionalPositiveInteger(
    process.env.OLYMPUS_FILE_EXTRACTION_OCR_MAX_PAGES,
    'OLYMPUS_FILE_EXTRACTION_OCR_MAX_PAGES',
  );
  const fileExtractionMaxBoundedTextChars = parseOptionalPositiveInteger(
    process.env.OLYMPUS_FILE_EXTRACTION_MAX_BOUNDED_TEXT_CHARS,
    'OLYMPUS_FILE_EXTRACTION_MAX_BOUNDED_TEXT_CHARS',
  );
  const fileExtractionRemoteEnabled = parseOptionalBooleanEnv(
    process.env.OLYMPUS_FILE_EXTRACTION_REMOTE_ENABLED,
    'OLYMPUS_FILE_EXTRACTION_REMOTE_ENABLED',
  );
  const fileExtractionRemoteConfigured = [
    'OLYMPUS_FILE_EXTRACTION_REMOTE_BASE_URL',
    'OLYMPUS_FILE_EXTRACTION_REMOTE_MODEL',
    'OLYMPUS_FILE_EXTRACTION_REMOTE_API_KEY',
    'OLYMPUS_FILE_EXTRACTION_REMOTE_TIMEOUT_SECONDS',
  ].some((name) => Boolean(process.env[name]?.trim()));
  if (fileExtractionRemoteConfigured && !fileExtractionRemoteEnabled) {
    throw new Error(
      'OLYMPUS_FILE_EXTRACTION_REMOTE_ENABLED=true is required when remote file-extraction settings are present.',
    );
  }
  const fileExtractionRemoteClient = fileExtractionRemoteEnabled
    ? new VeniceVlmClient({
        apiKey: requireFileExtractionVeniceApiKey(process.env),
        baseUrl: requiredFileExtractionEnv(
          process.env,
          'OLYMPUS_FILE_EXTRACTION_REMOTE_BASE_URL',
        ),
        ...(process.env.OLYMPUS_FILE_EXTRACTION_REMOTE_MODEL?.trim()
          ? { model: process.env.OLYMPUS_FILE_EXTRACTION_REMOTE_MODEL.trim() }
          : {}),
        ...(parseOptionalTimeoutSecondsOrNone(
          process.env.OLYMPUS_FILE_EXTRACTION_REMOTE_TIMEOUT_SECONDS,
          'OLYMPUS_FILE_EXTRACTION_REMOTE_TIMEOUT_SECONDS',
        ) !== undefined
          ? {
              timeoutMs: parseOptionalTimeoutSecondsOrNone(
                process.env.OLYMPUS_FILE_EXTRACTION_REMOTE_TIMEOUT_SECONDS,
                'OLYMPUS_FILE_EXTRACTION_REMOTE_TIMEOUT_SECONDS',
              )!,
            }
          : {}),
      })
    : undefined;
  const fileExtractionLocalVlmClient = createFileExtractionLocalVlmClientFromEnv(process.env);
  // Tiered store sets (P1b). Every lane with per-tier stores registers here:
  // its set ledger (the secure store's own co-located ledger) is the one
  // visibility authority for its stores, bound to every leg at boot so no
  // reader ever consults a different ledger; its secret-locations index sits
  // beside the same store.
  const tierLanes: Array<{
    ledger: TierLedger;
    secureCorpusId: string;
    corpusIds: Set<string>;
    secrets?: SecretLocationsIndex;
    publicStore?: OnDemandTierStore;
    /** Every store of the lane created on first need (Public, and P1c's new stores). */
    onDemand: OnDemandTierStore[];
  }> = [];
  // `embeddingProvider`: the store's own canonical identity. Omitted, the
  // sibling's (a Public store shares its Personal sibling's cloud identity);
  // null, no embedding lane (the store is served by keyword only).
  // A lane can open a tier store while it is being built, before the stores below are wired (its file
  // already exists at boot, as after Delete indexed data restarts the worker). Such a store waits here and
  // is registered once wiring finishes; throwing instead left the worker in a crash loop.
  type TierLegRegistration = [store: LocalConnectorStore, siblingCorpusId: string, embeddingProvider?: SourceEmbeddingProvider | null];
  const tierLegsOpenedEarly: TierLegRegistration[] = [];
  let registerTierLegStore: (...registration: TierLegRegistration) => void = (...registration) => {
    tierLegsOpenedEarly.push(registration);
  };
  const openTierSecretLocations = (account: StorageAccount, secureDbPath: string, label: string): SecretLocationsIndex | undefined => {
    try {
      return openSecretLocations(account, { dbPath: secretLocationsPathForStore(secureDbPath) });
    } catch (error) {
      console.warn(`[tier] secret-locations index unavailable for ${label}: ${error instanceof Error ? error.name : 'error'}`);
      return undefined;
    }
  };
  // P1c: a lane whose tier set its own module builds (Dropbox, Readwise, X,
  // WhatsApp) registers its ledger and its on-demand stores here.
  const adoptTierLane = (input: {
    ledger: TierLedger;
    /** The lane's Private corpus: its Secrets are located only when it was searched. */
    secureCorpusId: string;
    corpusIds: readonly string[];
    onDemand: readonly OnDemandTierStore[];
    secrets?: SecretLocationsIndex;
  }): void => {
    tierLanes.push({
      ledger: input.ledger,
      secureCorpusId: input.secureCorpusId,
      corpusIds: new Set(input.corpusIds),
      onDemand: [...input.onDemand],
      ...(input.secrets ? { secrets: input.secrets } : {}),
    });
  };
  const tierLane = (input: {
    account: StorageAccount;
    internal: LocalConnectorStore;
    secure: LocalConnectorStore;
    publicStore?: OnDemandTierStore;
  }) => {
    const ledger = input.secure.tierLedger();
    if (!ledger) return undefined;
    input.internal.useTierLedger(ledger);
    let secrets: SecretLocationsIndex | undefined;
    try {
      secrets = openSecretLocations(input.account, { dbPath: secretLocationsPathForStore(input.secure.dbPath) });
    } catch (error) {
      console.warn(`[tier] secret-locations index unavailable for ${input.secure.corpusId}: ${error instanceof Error ? error.name : 'error'}`);
    }
    const lane = {
      ledger,
      secureCorpusId: input.secure.corpusId,
      corpusIds: new Set([
        input.internal.corpusId,
        input.secure.corpusId,
        ...(input.publicStore ? [input.publicStore.corpusId] : []),
      ]),
      ...(secrets ? { secrets } : {}),
      ...(input.publicStore ? { publicStore: input.publicStore } : {}),
      onDemand: input.publicStore ? [input.publicStore] : [],
    };
    tierLanes.push(lane);
    return lane;
  };
  // A lane's Secrets are located only when its Private (secure_local) corpus
  // was actually searched — which is what include_secure_local, corpus
  // selection and a file source's scope approval decide — and only within the
  // account and filters that search ran under.
  const tierSecretLocations = (
    query: string,
    searched: ReadonlyArray<{ corpusId: string; accountScope?: string; filters?: ConnectorStoreSearchFilters }>,
  ) => tierLanes.flatMap((lane) => {
    const scope = searched.find((entry) => entry.corpusId === lane.secureCorpusId);
    if (!scope || !lane.secrets) return [];
    try {
      return lane.secrets.search(query, {
        ...(scope.accountScope ? { accountScope: scope.accountScope } : {}),
        ...(scope.filters ? { filters: scope.filters } : {}),
      }, {
        limit: 5,
        // A Secret child's location is its name: it is shown only while its parent is.
        hide: (identities) => hiddenProbesByParentIdentity({
          ledger: () => lane.ledger,
          stores: () => connectorStores.filter((store) => lane.corpusIds.has(store.corpusId)),
        }, identities),
      });
    } catch {
      return [];
    }
  });
  // Each lane's ledger, its corpora and its stores that exist now: the stores
  // let a child item be judged by its parent where the gate and the release
  // check read (tier-visibility.ts).
  const tierScopes = (): TierVisibilityScope[] => tierLanes.map((lane) => ({
    ledger: lane.ledger,
    corpusIds: lane.corpusIds,
    stores: () => connectorStores.filter((store) => lane.corpusIds.has(store.corpusId)),
  }));
  const tierVisibilityGate = createTierVisibilityGate(tierScopes);
  // A child item's parent: its names, judged against the ledger that governs its lane (answers and the unreadable list).
  const parentLabelResolver = createParentLabelResolver({
    stores: () => connectorStores,
    scopes: tierScopes,
  });
  const onDemandCorpusAbsent = (corpusId: string): boolean => {
    for (const lane of tierLanes) {
      const store = lane.onDemand.find((candidate) => candidate.corpusId === corpusId);
      if (store) return store.current() === undefined;
    }
    return sourceCorpusRegistry.list().some((corpus) => corpus.corpusId === corpusId && corpus.createdOnDemand === true);
  };
  const telegramMessagesAccount = sourceIndexTelegramAccountFromEnv(process.env);
  const telegramConnectorAccountScope = telegramMessagesAccount ?? TELEGRAM_PERSONAL_ACCOUNT_SCOPE;
  const readwiseConnectorStoreLane = sourceIndexLaneAccountDecision(sourceIndexLaneStorageDecision(
    process.env,
    'OLYMPUS_SOURCE_INDEX_READWISE_CONNECTOR_STORE_ENABLED',
    sourceIndexReadEnabled,
  ), { sourceId: READWISE_SOURCE_ID });
  // A Private store for a lane whose own store is not Private embeds with the
  // approved private identity, or not at all (keyword only).
  const tierSecureEmbeddingProvider = secureLocalPolicyEmbeddingProvider
    && isApprovedSecureSourceEmbeddingProvider(secureLocalPolicyEmbeddingProvider)
    ? secureLocalPolicyEmbeddingProvider
    : undefined;
  // Per-tier stores (P1c) of a lane that has had one store: that store keeps
  // every existing item, and each new store is created on first need.
  const existingStoreTierSet = (
    lane: ExistingStoreTierLane,
    input: { store: LocalConnectorStore; secrets?: SecretLocationsIndex },
  ): TieredStoreSet => {
    const newStores = Object.values(lane.newStores).filter((store): store is OnDemandTierStore => store !== undefined);
    adoptTierLane({
      ledger: lane.ledger,
      secureCorpusId: lane.set.legSpec('secure_local')!.corpusId,
      corpusIds: [input.store.corpusId, ...newStores.map((store) => store.corpusId)],
      onDemand: newStores,
      ...(input.secrets ? { secrets: input.secrets } : {}),
    });
    return lane.set;
  };
  const refreshableReadwiseRuntime = createRefreshableReadwiseConnectorStoreRuntime({
    enabled: readwiseConnectorStoreLane.enabled,
    ...(readwiseEmbeddingProvider ? { embeddingProvider: readwiseEmbeddingProvider } : {}),
    ...(sourceIndexAccount ? { account: sourceIndexAccount } : {}),
    env: process.env,
    tierSetFor: (store) => {
      const secrets = openTierSecretLocations(
        { sourceId: READWISE_SOURCE_ID },
        resolvedStorePath(READWISE_SOURCE_ID, 'secure_local', process.env),
        READWISE_SECURE_LIBRARY_CORPUS_ID,
      );
      return existingStoreTierSet(createReadwiseTierLane({
        store,
        env: process.env,
        ...(readwiseEmbeddingProvider ? { embeddingProvider: readwiseEmbeddingProvider } : {}),
        ...(tierSecureEmbeddingProvider ? { secureEmbeddingProvider: tierSecureEmbeddingProvider } : {}),
        ...(secrets ? { secretLocations: secrets } : {}),
        onStoreOpened: (opened) => registerTierLegStore(opened, store.corpusId, tierSecureEmbeddingProvider ?? null),
      }), { store, ...(secrets ? { secrets } : {}) });
    },
  });
  const readwiseConnectorStore = refreshableReadwiseRuntime?.store;
  const xBookmarksConnectorStoreLane = sourceIndexLaneAccountDecision(sourceIndexLaneStorageDecision(
    process.env,
    'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_ENABLED',
    sourceIndexReadEnabled,
  ), { sourceId: X_BOOKMARKS_SOURCE_ID });
  // The X lane's tier stores beyond its own, for the account guard's
  // "does this source hold items" check.
  let xBookmarksTierStores: OnDemandTierStore[] = [];
  const refreshableXBookmarksRuntime = createRefreshableXBookmarksConnectorStoreRuntime({
    enabled: xBookmarksConnectorStoreLane.enabled,
    ...(xBookmarksEmbeddingProvider ? { embeddingProvider: xBookmarksEmbeddingProvider } : {}),
    ...(sourceIndexAccount ? { account: sourceIndexAccount } : {}),
    env: process.env,
    tierSetFor: (store) => {
      const secrets = openTierSecretLocations(
        { sourceId: X_BOOKMARKS_SOURCE_ID },
        resolvedStorePath(X_BOOKMARKS_SOURCE_ID, 'secure_local', process.env),
        X_BOOKMARKS_SECURE_CORPUS_ID,
      );
      const lane = createXBookmarksTierLane({
        store,
        env: process.env,
        ...(xBookmarksEmbeddingProvider ? { embeddingProvider: xBookmarksEmbeddingProvider } : {}),
        ...(tierSecureEmbeddingProvider ? { secureEmbeddingProvider: tierSecureEmbeddingProvider } : {}),
        ...(secrets ? { secretLocations: secrets } : {}),
        onStoreOpened: (opened) => registerTierLegStore(opened, store.corpusId, tierSecureEmbeddingProvider ?? null),
      });
      xBookmarksTierStores = Object.values(lane.newStores).filter((leg): leg is OnDemandTierStore => leg !== undefined);
      return existingStoreTierSet(lane, { store, ...(secrets ? { secrets } : {}) });
    },
  });
  const xBookmarksConnectorStore = refreshableXBookmarksRuntime?.store;
  const gmailConnectorStoreLane = sourceIndexLaneAccountDecision(
    sourceIndexLaneStorageDecision(process.env, 'OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_ENABLED', sourceIndexReadEnabled),
    { sourceId: GMAIL_SOURCE_ID },
  );
  const googleDriveConnectorStoreLane = sourceIndexLaneAccountDecision(
    sourceIndexLaneStorageDecision(process.env, 'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CONNECTOR_STORE_ENABLED', sourceIndexReadEnabled),
    { sourceId: GOOGLE_DRIVE_SOURCE_ID },
  );
  // Exactly one Gmail day counter per runtime, durable across restart.
  // Constructing it before the stores also keeps an invalid budget env from
  // creating the store files at all.
  const gmailRequestBudget = gmailConnectorStoreLane.enabled
    ? createGmailDailyRequestBudget({ env: process.env })
    : undefined;
  const gmailInternalConnectorStore = gmailConnectorStoreLane.enabled
    ? openConnectorStore({ sourceId: GMAIL_SOURCE_ID }, {
      dbPath: resolvedStorePath(GMAIL_SOURCE_ID, 'internal', process.env),
      corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
      family: 'email',
      trustDomain: 'internal',
    })
    : undefined;
  const gmailSecureConnectorStore = gmailInternalConnectorStore
    ? openConnectorStore({ sourceId: GMAIL_SOURCE_ID }, {
      dbPath: resolvedStorePath(GMAIL_SOURCE_ID, 'secure_local', process.env),
      corpusId: GMAIL_SECURE_CONNECTOR_CORPUS_ID,
      family: 'email',
      trustDomain: 'secure_local',
    })
    : undefined;
  // Per-tier stores (design per-item-four-tier-classification.md, 3.2): the
  // lane's two stores plus a Public store created only when a message is
  // routed there, all governed by ONE ledger — the secure store's own.
  const gmailTierLane = gmailInternalConnectorStore && gmailSecureConnectorStore
    ? tierLane({
        account: { sourceId: GMAIL_SOURCE_ID },
        internal: gmailInternalConnectorStore,
        secure: gmailSecureConnectorStore,
        publicStore: onDemandTierStore({
          corpusId: GMAIL_PUBLIC_CONNECTOR_CORPUS_ID,
          dbPath: resolvedStorePath(GMAIL_SOURCE_ID, 'public_safe', process.env),
          create: () => openConnectorStore({ sourceId: GMAIL_SOURCE_ID }, {
            dbPath: resolvedStorePath(GMAIL_SOURCE_ID, 'public_safe', process.env),
            corpusId: GMAIL_PUBLIC_CONNECTOR_CORPUS_ID,
            family: 'email',
            trustDomain: 'public_safe',
          }),
          onOpened: (store) => registerTierLegStore(store, GMAIL_INTERNAL_CONNECTOR_CORPUS_ID),
        }),
      })
    : undefined;
  // The account scope Gmail's items are kept under (gmail-archive-target.ts
  // `gmailItemAccountScope`): the handle's role, unless the stores already
  // hold the account's mail under one other scope (an import made before the
  // connect), which every reader and writer then keeps using.
  const gmailItemScopeFor = (handle: { accountRole?: string; handle?: string } | undefined): string => {
    const role = handle?.accountRole?.trim() || accountFromGoogleHandle(handle?.handle);
    return gmailInternalConnectorStore && gmailSecureConnectorStore
      ? gmailItemAccountScope([gmailInternalConnectorStore, gmailSecureConnectorStore], role)
      : role;
  };
  // An mbox export of a Gmail account is an input of the Gmail connector
  // (docs/design/archive-live-one-dataset.md, step 6): its mail joins the
  // Gmail stores, matched by Gmail's own ids, under the account it proves and
  // the owner confirms. Without the Gmail lane, every mbox stays under
  // Archives, as before.
  if (gmailInternalConnectorStore && gmailSecureConnectorStore) {
    let gmailArchiveSet: { key: string; set: ReturnType<typeof createLaneTieredStoreSet> } | undefined;
    // Every Gmail request an import makes passes one gate: imports keep to their share of the day.
    const gmailImportGate = gmailImportAllowance({ usage: () => gmailRequestBudget?.status() });
    // The account's labels, read once a day while the owner's rules stay the same.
    let gmailLabelCache: { key: string; map: ReadonlyMap<string, string> } | undefined;
    archiveSourceTargets.register(gmailArchiveTarget({
      concurrencyKey: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
      exclusive: (task) => connectedHandleRegistryPath
        ? runExclusiveForSource(connectedHandleRegistryPath, GMAIL_SOURCE_ID, task)
        : task(),
      lane: () => {
        const handle = selectedSourceCredentialHandle({
          env: process.env, pinEnvName: 'OLYMPUS_SOURCE_INDEX_GMAIL_CREDENTIAL_HANDLE',
          provider: 'gmail', capability: 'gmail.email.sync', handles: readActiveConnectedHandles(process.env),
        });
        // The owner's "always Private" rules of the current mail approval, as the live lane applies them.
        const scopeRef = handle && fileSourceScopeAuthority ? fileSourceScopeAuthority.mailPolicyRef() : undefined;
        let ownerRules: NonNullable<ReturnType<typeof gmailConnectorScopeFromApproval>['ownerTierRules']> = [];
        let approved = false;
        try {
          const approval = scopeRef && fileSourceScopeAuthority ? fileSourceScopeAuthority.assertCurrentMail(scopeRef) : undefined;
          if (approval) {
            ownerRules = gmailConnectorScopeFromApproval(approval).ownerTierRules ?? [];
            approved = true;
          }
        } catch {
          // No current approval: no owner rules apply, as live reads nothing without one.
        }
        // The imports' one Gmail client for the pass: every attempt, retries included, is charged at its transport
        // to the imports' allowance, then to the lane's day counter. Undefined without a current mail approval.
        let importClientPromise: Promise<GmailApiClient> | undefined;
        const importClient = (): Promise<GmailApiClient> | undefined => {
          if (!handle || !approved || !gmailRequestBudget || !scopeRef || !fileSourceScopeAuthority) return undefined;
          fileSourceScopeAuthority.assertCurrentMail(scopeRef);
          importClientPromise ??= new GoogleGmailSourceConnector({
            credentialHandle: handle.handle,
            ...(handle.accountRole ? { account: handle.accountRole } : {}),
            requestBudget: gmailImportBudget(gmailRequestBudget, gmailImportGate),
            maxRetries: GMAIL_IMPORT_MAX_RETRIES,
          }).apiClientForTooling();
          return importClientPromise;
        };
        // An import embeds what it writes as live does: under the live scope binding when there is an approval,
        // else with the lane's own providers (the owner approved the import itself).
        const bound = (provider: SourceEmbeddingProvider | undefined): SourceEmbeddingProvider | undefined => provider && approved && scopeRef && fileSourceScopeAuthority
          ? scopeBoundEmbeddingProvider(provider, fileSourceScopeAuthority, scopeRef)
          : provider;
        const internalEmbedder = bound(sourceIndexEmbeddingProvider);
        const secureEmbedder = secureLocalPolicyEmbeddingProvider && isApprovedSecureSourceEmbeddingProvider(secureLocalPolicyEmbeddingProvider)
          ? bound(secureLocalPolicyEmbeddingProvider)
          : undefined;
        const key = JSON.stringify([ownerRules, approved ? scopeRef?.revision ?? null : null]);
        if (gmailArchiveSet?.key !== key) {
          gmailArchiveSet = {
            key,
            set: createLaneTieredStoreSet({
              setId: GMAIL_SOURCE_ID,
              internalStore: gmailInternalConnectorStore,
              secureStore: gmailSecureConnectorStore,
              ...(gmailTierLane?.publicStore ? { publicLeg: gmailTierLane.publicStore } : {}),
              ...(gmailTierLane?.secrets ? { secretLocations: gmailTierLane.secrets } : {}),
              tierClassification: { ...(ownerRules.length > 0 ? { rules: [...ownerRules] } : {}) },
              ...(internalEmbedder ? { internalEmbeddingProvider: internalEmbedder } : {}),
              ...(secureEmbedder ? { secureEmbeddingProvider: secureEmbedder } : {}),
              contentArrivesLaterFor: gmailContentArrivesLater,
            }),
          };
        }
        return {
          set: gmailArchiveSet.set,
          sync: gmailLaneSyncOptions(ownerRules),
          // The account scope live Gmail writes under, so both inputs name one item.
          account: gmailItemScopeFor(handle),
          // The same children live Gmail lists, so both inputs name one child.
          build: { children: true },
          // Takeout names user labels; the account's list gives their ids, so an owner rule on a label id applies.
          labelIds: async () => {
            const cacheKey = `${new Date().toISOString().slice(0, 10)}\n${key}`;
            if (gmailLabelCache?.key === cacheKey) return gmailLabelCache.map;
            const client = importClient();
            if (!client) return { unavailable: 'gmail_labels_unavailable' };
            // Begun only when the allowance holds the list at its worst; a refusal spends nothing.
            const room = gmailImportGate.check(GMAIL_IMPORT_LABELS_COST);
            if (room !== true) {
              const wait = gmailImportWait(room);
              return { unavailable: wait.later, ...(wait.minimum !== undefined ? { minimum: wait.minimum } : {}) };
            }
            const api = await client;
            if (!api.listLabels) return { unavailable: 'gmail_labels_unavailable' };
            try {
              const map = new Map((await api.listLabels()).map((label) => [label.name.trim().toLowerCase(), label.id] as const));
              gmailLabelCache = { key: cacheKey, map };
              return map;
            } catch (error) {
              if (error instanceof GmailImportWaitError) {
                const wait = gmailImportWait(error.reason);
                return { unavailable: wait.later, ...(wait.minimum !== undefined ? { minimum: wait.minimum } : {}) };
              }
              if (error instanceof GoogleRequestBudgetError) return { unavailable: 'gmail_requests_spent' };
              throw error;
            }
          },
          // A message without Takeout's id is matched by asking Gmail, under the live lane's day budget, and only
          // while the owner's mail approval is current: nothing of the mailbox is read without one.
          match: gmailHeaderMatch(async () => importClient(), {
            allowance: gmailImportGate,
            // The token's mailbox must not be another account than the one the registry names for Gmail.
            sameAccount: (address) => {
              const named = readSourceRegistry(process.env).accounts.find((entry) => entry.source_id === GMAIL_SOURCE_ID)?.provider_account_hash;
              return named === undefined || compareProviderAccounts(named, googleAccountIdFromAddress(address)) !== 'different';
            },
          }),
        };
      },
    }));
  }
  // Exactly one Drive day counter per runtime, durable across restart.
  // Constructing it before the stores also keeps an invalid budget env from
  // creating the store files at all.
  const googleDriveRequestBudget = googleDriveConnectorStoreLane.enabled
    ? createGoogleDriveDailyRequestBudget({ env: process.env })
    : undefined;
  // Both Drive stores carry the owner's folder-exclusion gate. Omitting it was
  // the defect: the stores were constructed bare, so even a rule that named
  // Drive had nothing to enforce it, and the corpus filled unconditionally.
  // Built once and shared, so the two trust bands can never drift onto
  // different rules.
  const googleDriveExclusions = googleDriveConnectorStoreLane.enabled
    ? googleDriveIngestionExclusionMatcher(process.env)
    : undefined;
  const googleDriveInternalConnectorStore = googleDriveConnectorStoreLane.enabled
    ? openConnectorStore({ sourceId: GOOGLE_DRIVE_SOURCE_ID }, {
      dbPath: resolvedStorePath(GOOGLE_DRIVE_SOURCE_ID, 'internal', process.env),
      corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
      family: 'file',
      trustDomain: 'internal',
      ...(googleDriveExclusions ? { exclusions: googleDriveExclusions } : {}),
    })
    : undefined;
  const googleDriveSecureConnectorStore = googleDriveInternalConnectorStore
    ? openConnectorStore({ sourceId: GOOGLE_DRIVE_SOURCE_ID }, {
      dbPath: resolvedStorePath(GOOGLE_DRIVE_SOURCE_ID, 'secure_local', process.env),
      corpusId: GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
      ...(googleDriveExclusions ? { exclusions: googleDriveExclusions } : {}),
    })
    : undefined;
  // The Public Drive store carries the same exclusion gate and the same
  // approved-scope read filter as its siblings (connectorStoreReadScope).
  const googleDriveTierLane = googleDriveInternalConnectorStore && googleDriveSecureConnectorStore
    ? tierLane({
        account: { sourceId: GOOGLE_DRIVE_SOURCE_ID },
        internal: googleDriveInternalConnectorStore,
        secure: googleDriveSecureConnectorStore,
        publicStore: onDemandTierStore({
          corpusId: GOOGLE_DRIVE_PUBLIC_CONNECTOR_CORPUS_ID,
          dbPath: resolvedStorePath(GOOGLE_DRIVE_SOURCE_ID, 'public_safe', process.env),
          create: () => openConnectorStore({ sourceId: GOOGLE_DRIVE_SOURCE_ID }, {
            dbPath: resolvedStorePath(GOOGLE_DRIVE_SOURCE_ID, 'public_safe', process.env),
            corpusId: GOOGLE_DRIVE_PUBLIC_CONNECTOR_CORPUS_ID,
            family: 'file',
            trustDomain: 'public_safe',
            ...(googleDriveExclusions ? { exclusions: googleDriveExclusions } : {}),
          }),
          onOpened: (store) => registerTierLegStore(store, GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID),
        }),
      })
    : undefined;
  // Dropbox product state: the lane's original store, secure_local. Every
  // file stored before per-item routing stays here; the lane's tier set
  // (below) adds Personal and Public stores on first need.
  const dropboxConnectorStoreLane = sourceIndexLaneAccountDecision(
    sourceIndexLaneStorageDecision(process.env, 'OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_ENABLED', sourceIndexReadEnabled),
    { sourceId: DROPBOX_FILES_SOURCE_ID },
  );
  const dropboxConnectorStore = dropboxConnectorStoreLane.enabled
    ? createDropboxConnectorStore(process.env, { policy: dropboxIngestionPolicy })
    : undefined;
  const dropboxProviderAccount = dropboxHandle?.accountRole?.trim()
    || dropboxFilesAccount
    || 'personal';
  // Per-tier stores (P1c, design per-item-four-tier-classification.md): the
  // lane's original secure store keeps every existing file where it is; a new
  // file's names go to the Personal store (by default) when it is listed, and
  // its text to the store its content tier decides once extraction reads it.
  // The Personal and Public stores are created on first need.
  const dropboxSecretLocations = dropboxConnectorStore
    ? openTierSecretLocations({ sourceId: DROPBOX_FILES_SOURCE_ID }, dropboxConnectorStore.dbPath, DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID)
    : undefined;
  const dropboxTierLane = dropboxConnectorStore
    ? createDropboxTierLane({
        secureStore: dropboxConnectorStore,
        env: process.env,
        policy: dropboxIngestionPolicy,
        ...(dropboxSecretLocations ? { secretLocations: dropboxSecretLocations } : {}),
        onStoreOpened: (store) => registerTierLegStore(
          store,
          DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
          sourceIndexEmbeddingProvider ?? null,
        ),
      })
    : undefined;
  // The Dropbox set declares no embedder on its legs; the Private store's real
  // one is chosen here and handed to the scheduler. Tell the set, so the Private
  // row re-home pass knows whether it is local (it moves only when it is).
  if (dropboxTierLane && dropboxFilesEmbeddingProvider && isApprovedSecureSourceEmbeddingProvider(dropboxFilesEmbeddingProvider)) {
    dropboxTierLane.set.declarePrivateEmbedder(dropboxFilesEmbeddingProvider, {
      // Rows moved into the Private store embed under the current scope binding, as the lane's own pass does.
      embedWith: () => (dropboxScopeRef && fileSourceScopeAuthority
        ? scopeBoundEmbeddingProvider(dropboxFilesEmbeddingProvider, fileSourceScopeAuthority, dropboxScopeRef)
        : undefined),
    });
  }
  if (dropboxTierLane && dropboxConnectorStore) {
    adoptTierLane({
      ledger: dropboxTierLane.ledger,
      secureCorpusId: dropboxConnectorStore.corpusId,
      corpusIds: [dropboxConnectorStore.corpusId, dropboxTierLane.internal.corpusId, dropboxTierLane.public.corpusId],
      onDemand: [dropboxTierLane.internal, dropboxTierLane.public],
      ...(dropboxSecretLocations ? { secrets: dropboxSecretLocations } : {}),
    });
  }
  const dropboxExtractionView = dropboxTierLane ? tieredExtractionView(dropboxTierLane.set) : undefined;
  /** Whether a store is one of the Dropbox lane's tier stores. */
  const isDropboxTierStore = (store: LocalConnectorStore): boolean => store === dropboxConnectorStore
    || (dropboxTierLane !== undefined
      && (store === dropboxTierLane.internal.current() || store === dropboxTierLane.public.current()));
  const dropboxScopeRef = dropboxHandle && fileSourceScopeAuthority
    ? fileSourceScopeAuthority.policyRef('dropbox.files')
    : undefined;
  const dropboxProviderStoreSync = dropboxConnectorStore && dropboxTierLane && dropboxHandle && dropboxScopeRef && fileSourceScopeAuthority
    ? createDropboxProviderStoreSyncHandler({
        tierSet: dropboxTierLane.set,
        store: dropboxConnectorStore,
        account: dropboxProviderAccount,
        credentialHandle: dropboxHandle.handle,
        scope: createScopeBoundDropboxContentScope({ authority: fileSourceScopeAuthority, ref: dropboxScopeRef }),
        ...(dropboxFilesEmbeddingProvider && isApprovedSecureSourceEmbeddingProvider(dropboxFilesEmbeddingProvider)
          ? { embeddingProvider: scopeBoundEmbeddingProvider(dropboxFilesEmbeddingProvider, fileSourceScopeAuthority, dropboxScopeRef) }
          : {}),
      })
    : undefined;
  // Local files: the folders the owner chose on this computer. No credential;
  // the lane exists once the owner connects it and approves folders. Same three
  // per-tier stores, exclusion gate and tier set as Dropbox.
  const localFilesConnectorStoreLane = sourceIndexLaneAccountDecision(
    sourceIndexLaneStorageDecision(process.env, 'OLYMPUS_SOURCE_INDEX_LOCAL_FILES_CONNECTOR_STORE_ENABLED', sourceIndexReadEnabled),
    { sourceId: LOCAL_FILES_SOURCE_ID },
  );
  const localFilesIngestionPolicy = defaultLocalFilesIngestionPolicy();
  const localFilesConnectorStore = localFilesConnectorStoreLane.enabled
    ? createLocalFilesConnectorStore(process.env, { policy: localFilesIngestionPolicy })
    : undefined;
  const localFilesSecretLocations = localFilesConnectorStore
    ? openTierSecretLocations({ sourceId: LOCAL_FILES_SOURCE_ID }, localFilesConnectorStore.dbPath, LOCAL_FILES_CORPUS_ID)
    : undefined;
  const localFilesTierLane = localFilesConnectorStore
    ? createLocalFilesTierLane({
        secureStore: localFilesConnectorStore,
        env: process.env,
        policy: localFilesIngestionPolicy,
        ...(localFilesSecretLocations ? { secretLocations: localFilesSecretLocations } : {}),
        onStoreOpened: (store) => registerTierLegStore(
          store,
          LOCAL_FILES_CORPUS_ID,
          sourceIndexEmbeddingProvider ?? null,
        ),
      })
    : undefined;
  const localFilesScopeRef = fileSourceScopeAuthority
    ? fileSourceScopeAuthority.policyRef(LOCAL_FILES_SOURCE_ID)
    : undefined;
  if (localFilesTierLane && localFilesConnectorStore && localFilesEmbeddingProvider
    && isApprovedSecureSourceEmbeddingProvider(localFilesEmbeddingProvider)) {
    localFilesTierLane.set.declarePrivateEmbedder(localFilesEmbeddingProvider, {
      embedWith: () => {
        const ref = fileSourceScopeAuthority?.policyRef(LOCAL_FILES_SOURCE_ID);
        return ref && fileSourceScopeAuthority
          ? scopeBoundEmbeddingProvider(localFilesEmbeddingProvider, fileSourceScopeAuthority, ref)
          : undefined;
      },
    });
  }
  if (localFilesTierLane && localFilesConnectorStore) {
    adoptTierLane({
      ledger: localFilesTierLane.ledger,
      secureCorpusId: localFilesConnectorStore.corpusId,
      corpusIds: [localFilesConnectorStore.corpusId, localFilesTierLane.internal.corpusId, localFilesTierLane.public.corpusId],
      onDemand: [localFilesTierLane.internal, localFilesTierLane.public],
      ...(localFilesSecretLocations ? { secrets: localFilesSecretLocations } : {}),
    });
  }
  const localFilesExtractionView = localFilesTierLane ? tieredExtractionView(localFilesTierLane.set) : undefined;
  const isLocalFilesTierStore = (store: LocalConnectorStore): boolean => store === localFilesConnectorStore
    || (localFilesTierLane !== undefined
      && (store === localFilesTierLane.internal.current() || store === localFilesTierLane.public.current()));
  // The watcher and the disk-identity resolver live as long as the worker; the
  // content scope and sync handler are rebuilt whenever the approval changes.
  const localFilesWatchHub = new WatchHub();
  const localFilesVolumes = new VolumeResolver();
  // Case handling is read from each volume (a case-sensitive disk on a Mac, a
  // case-insensitive stick on Linux); the platform's usual format fills gaps.
  const localFilesExclusionContext = {
    ...defaultExclusionContext(),
    volumeIgnoresCase: (volumeId: string | undefined, path?: string) => localFilesVolumes.ignoresCase(volumeId, path),
  };
  const localFilesWatchIgnore = watchIgnoreGlobs(localFilesExclusionContext);
  // Olympus's own folders are never indexed, and what an earlier version indexed
  // inside one (a folder the person had chosen by name) is removed here: before
  // the worker answers anything, and again with each pass until none is left.
  const localFilesOwnRootsCleanup = localFilesConnectorStore && localFilesTierLane
    ? createLocalFilesOwnRootsCleanup({
        tierSet: localFilesTierLane.set,
        context: localFilesExclusionContext,
        log: (message) => console.warn(`[local-files] ${message}`),
      })
    : undefined;
  let localFilesSyncCache: { key: string; handler: ReturnType<typeof createLocalFilesProviderStoreSyncHandler> } | undefined;
  const localFilesSyncFor = (ref: SourceScopePolicyRef) => {
    if (!localFilesConnectorStore || !localFilesTierLane || !fileSourceScopeAuthority) return undefined;
    const key = `${ref.accountGeneration}:${ref.revision}`;
    if (localFilesSyncCache?.key === key) return localFilesSyncCache.handler;
    // The watch folder is the account's raw state, written only from here on. The store is open
    // (the guard above), so the account is already placed; this keeps that true by construction.
    recordAccountPlacement({ sourceId: LOCAL_FILES_SOURCE_ID }, localFilesWatchDir(process.env));
    const handler = createLocalFilesProviderStoreSyncHandler({
      tierSet: localFilesTierLane.set,
      store: localFilesConnectorStore,
      scope: createScopeBoundLocalFilesContentScope({ authority: fileSourceScopeAuthority, ref, context: localFilesExclusionContext }),
      volumes: localFilesVolumes,
      hub: localFilesWatchHub,
      snapshotDir: localFilesWatchDir(process.env),
      ignore: localFilesWatchIgnore,
      // A pass writes the same stores: it starts only once no clean-up batch is still in flight.
      ...(localFilesOwnRootsCleanup
        ? { beforePull: async () => { await localFilesOwnRootsCleanup.run(); await localFilesOwnRootsCleanup.idle(); } }
        : {}),
      ...(localFilesEmbeddingProvider && isApprovedSecureSourceEmbeddingProvider(localFilesEmbeddingProvider)
        ? { embeddingProvider: scopeBoundEmbeddingProvider(localFilesEmbeddingProvider, fileSourceScopeAuthority, ref) }
        : {}),
    });
    localFilesSyncCache = { key, handler };
    return handler;
  };
  const localFilesApprovedScopePaths = (): string[] => {
    const approval = fileSourceScopeAuthority?.snapshot(LOCAL_FILES_SOURCE_ID);
    return approval && approval.status === 'approved' ? localFilesRoots(approval, localFilesExclusionContext).map((root) => root.scopePath) : [];
  };
  const localFilesOpenTarget = createLocalFilesOpenTargets({
    volumes: localFilesVolumes,
    approvedScopePaths: localFilesApprovedScopePaths,
  });
  const localFilesOpenableRoots = (): string[] => localFilesOpenRoots(localFilesVolumes, localFilesApprovedScopePaths);
  // Opens a file this engine resolved for a cited or unreadable source, on a
  // path re-checked now (core/local-open.ts; the Linux adapter checks it again).
  const openLocalFile = async (
    path: string,
    eligible: () => Promise<boolean>,
    roots: readonly string[],
  ): Promise<void> => {
    if (process.platform === 'linux') {
      await openLinuxDesktopPath({ path, roots, revalidateEligibility: eligible });
      return;
    }
    if (!(await eligible())) throw new Error('open refused');
    await new Promise<void>((resolve, reject) => {
      const args = localOpenArguments(path, roots);
      if (!args) {
        reject(new Error('open refused'));
        return;
      }
      execFile('/usr/bin/open', args, { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()));
    });
  };
  // WhatsApp's store is product state, not a private deployment mount. Opening
  // the long-standing default path preserves captured history; the scheduler
  // below advances its connector cursor without replaying or replacing it.
  const whatsappConnectorStoreLane = sourceIndexLaneAccountDecision(sourceIndexLaneStorageDecision(
    process.env,
    'OLYMPUS_SOURCE_INDEX_WHATSAPP_CONNECTOR_STORE_ENABLED',
    sourceIndexReadEnabled,
  ), { sourceId: WHATSAPP_PERSONAL_SOURCE_ID });
  const whatsappConnectorStore = whatsappConnectorStoreLane.enabled
    ? createWhatsAppConnectorStore(process.env)
    : undefined;
  // Per-tier stores (P1c): each message is tiered by its own content; Private
  // ones rest in the lane's own store and Personal ones in the Personal store.
  const whatsappSecretLocations = whatsappConnectorStore
    ? openTierSecretLocations({ sourceId: WHATSAPP_PERSONAL_SOURCE_ID }, whatsappConnectorStore.dbPath, WHATSAPP_LIVE_CORPUS_ID)
    : undefined;
  const whatsappTierSet = whatsappConnectorStore
    ? existingStoreTierSet(createWhatsAppTierLane({
        store: whatsappConnectorStore,
        env: process.env,
        ...(sourceIndexEmbeddingProvider ? { internalEmbeddingProvider: sourceIndexEmbeddingProvider } : {}),
        ...(whatsappSecretLocations ? { secretLocations: whatsappSecretLocations } : {}),
        onStoreOpened: (opened) => registerTierLegStore(opened, WHATSAPP_LIVE_CORPUS_ID, sourceIndexEmbeddingProvider ?? null),
      }), {
        store: whatsappConnectorStore,
        ...(whatsappSecretLocations ? { secrets: whatsappSecretLocations } : {}),
      })
    : undefined;
  if (whatsappTierSet && tierSecureEmbeddingProvider) whatsappTierSet.declarePrivateEmbedder(tierSecureEmbeddingProvider);
  if (whatsappTierSet && whatsappConnectorStore) {
    reportRehomedChatOverrides('whatsapp', rehomeChatLaneOverrides(whatsappTierSet.ledger, 'whatsapp', [whatsappConnectorStore]));
  }
  // A WhatsApp chat export is an input of the WhatsApp connector: it writes this
  // account's own stores (docs/design/archive-live-one-dataset.md). With no
  // live lane open yet (the export creates the account), the import opens the
  // account's stores the way the live lane does.
  let whatsappImportTierSet: TieredStoreSet | undefined = whatsappTierSet;
  // The account's one child reader: what the bridge saved, and an imported export's files (read at each call: the
  // archive imports open later in boot).
  const whatsappArchiveMedia = () => ({ state: archiveImports.state, bindings: archiveImports.media });
  const whatsappReadChild = whatsAppChildReader(process.env, whatsappArchiveMedia);
  const whatsappExtraction = whatsAppExtractionSourceFactory(process.env, whatsappArchiveMedia);
  archiveSourceTargets.register(createWhatsAppArchiveTarget({
    env: process.env,
    set: () => {
      if (whatsappImportTierSet) return whatsappImportTierSet;
      const store = createWhatsAppConnectorStore(process.env);
      const secrets = openTierSecretLocations({ sourceId: WHATSAPP_PERSONAL_SOURCE_ID }, store.dbPath, WHATSAPP_LIVE_CORPUS_ID);
      registerTierLegStore(store, WHATSAPP_LIVE_CORPUS_ID, tierSecureEmbeddingProvider ?? null);
      whatsappImportTierSet = existingStoreTierSet(createWhatsAppTierLane({
        store,
        env: process.env,
        ...(sourceIndexEmbeddingProvider ? { internalEmbeddingProvider: sourceIndexEmbeddingProvider } : {}),
        ...(secrets ? { secretLocations: secrets } : {}),
        onStoreOpened: (opened) => registerTierLegStore(opened, WHATSAPP_LIVE_CORPUS_ID, sourceIndexEmbeddingProvider ?? null),
      }), { store, ...(secrets ? { secrets } : {}) });
      if (tierSecureEmbeddingProvider) whatsappImportTierSet.declarePrivateEmbedder(tierSecureEmbeddingProvider);
      return whatsappImportTierSet;
    },
    readChild: whatsappReadChild,
  }));
  const whatsappConnectorStoreSync: WhatsAppConnectorStoreSyncHandler | undefined = whatsappConnectorStore && whatsappTierSet
    ? createWhatsAppConnectorStoreSyncHandler({
        tierSet: whatsappTierSet,
        store: whatsappConnectorStore,
        account: WHATSAPP_PERSONAL_ACCOUNT_SCOPE,
        env: process.env,
        readChild: whatsappReadChild,
      })
    : undefined;
  const whatsappLiveMaxItems = parseOptionalPositiveInteger(
    process.env.OLYMPUS_WHATSAPP_LIVE_DRAIN_MAX_ITEMS,
    'OLYMPUS_WHATSAPP_LIVE_DRAIN_MAX_ITEMS',
  );
  // Product-owned canonical Telegram stores at the paths already populated by
  // convergence. The scheduler advances their existing connector cursors; it
  // never replaces the databases or requires a private mount declaration.
  const telegramConnectorStoreLane = sourceIndexLaneAccountDecision(sourceIndexLaneStorageDecision(
    process.env,
    'OLYMPUS_SOURCE_INDEX_TELEGRAM_CONNECTOR_STORES_ENABLED',
    sourceIndexReadEnabled,
  ), { sourceId: TELEGRAM_MESSAGES_SOURCE_ID });
  const telegramConnectorStores = telegramConnectorStoreLane.enabled
    ? createTelegramConnectorStores(process.env)
    : undefined;
  const telegramTierLane = telegramConnectorStores
    ? tierLane({
        account: { sourceId: TELEGRAM_MESSAGES_SOURCE_ID },
        internal: telegramConnectorStores.internal,
        secure: telegramConnectorStores.secureLocal,
      })
    : undefined;
  if (telegramTierLane && telegramConnectorStores) {
    reportRehomedChatOverrides('telegram', rehomeChatLaneOverrides(
      telegramTierLane.ledger,
      'telegram',
      [telegramConnectorStores.internal, telegramConnectorStores.secureLocal],
    ));
  }
  const telegramConnectorStoreSync: TelegramConnectorStoreSyncHandler | undefined = telegramConnectorStores
    ? createTelegramConnectorStoreSyncHandler({
        stores: telegramConnectorStores,
        env: process.env,
        ...(telegramTierLane?.secrets ? { secretLocations: telegramTierLane.secrets } : {}),
        ...(tierSecureEmbeddingProvider ? { privateEmbedder: tierSecureEmbeddingProvider } : {}),
      })
    : undefined;
  // A Telegram Desktop export of this account is one more input of the Telegram connector, read into
  // these stores beside live capture (docs/design/archive-live-one-dataset.md). Without the live lane
  // an export stays under Archives, as before.
  if (telegramConnectorStoreSync) archiveSourceTargets.register(telegramConnectorStoreSync.archiveTarget());
  const telegramSpoolChanges = createSpoolChangeSubscription(defaultTelegramCaptureSpoolDir(process.env));
  const whatsappSpoolChanges = createSpoolChangeSubscription(defaultWhatsAppSpoolDir(process.env));
  const telegramCaptureMaxItems = parseOptionalPositiveInteger(
    process.env.OLYMPUS_TELEGRAM_SPOOL_DRAIN_MAX_ITEMS,
    'OLYMPUS_TELEGRAM_SPOOL_DRAIN_MAX_ITEMS',
  );
  const laneConnectorStores = [
    ...(dropboxConnectorStore ? [dropboxConnectorStore] : []),
    ...(localFilesConnectorStore ? [localFilesConnectorStore] : []),
    ...(gmailInternalConnectorStore ? [gmailInternalConnectorStore] : []),
    ...(gmailSecureConnectorStore ? [gmailSecureConnectorStore] : []),
    ...(googleDriveInternalConnectorStore ? [googleDriveInternalConnectorStore] : []),
    ...(googleDriveSecureConnectorStore ? [googleDriveSecureConnectorStore] : []),
    ...(readwiseConnectorStore ? [readwiseConnectorStore] : []),
    ...(xBookmarksConnectorStore ? [xBookmarksConnectorStore] : []),
    ...(telegramConnectorStores
      ? [telegramConnectorStores.internal, telegramConnectorStores.secureLocal]
      : []),
    ...(whatsappConnectorStore ? [whatsappConnectorStore] : []),
  ];
  // Connector-store declarations (Reflect, WhatsApp, Roam, ...) arrive via one
  // JSON env. A declaration may name a corpus whose lane already constructed a
  // richer handle with ingestion exclusions or budgets. Reconcile those
  // identities before opening any declared store so the declaration can add a
  // principal without replacing the lane handle or opening the SQLite file a
  // second time.
  const configuredConnectorStoreMounts = parseConnectorStoreMountsFromEnv(
    process.env.OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON,
    {
      collidingStores: laneConnectorStores,
      registeredCorpora: sourceCorpusRegistry.list(),
      storeOwner: lifecycleStoreFileOwner(process.env),
    },
  );
  const configuredConnectorStores = configuredConnectorStoreMounts.map((mount) => mount.store);
  const connectorStores = mergeConnectorStores([
    ...configuredConnectorStores,
    ...laneConnectorStores,
  ]);
  const readConnectorStores = connectorStores;

  // The source-neutral extraction factory. Off unless its roster names a corpus
  // whose connector store is also configured here, so it cannot half-exist: a
  // lane that accepts requests and has nowhere to put text is worse than a lane
  // that says it is not served. The extractor knobs are the same values the
  // family-scoped lane already reads, renamed off the family.
  const configuredFileExtractionCorpora = parseFileExtractionCorporaEnv(
    process.env.OLYMPUS_FILE_EXTRACTION_CORPORA_JSON,
  );
  const dropboxExtractionScopes = dropboxPolicyFullExtractionScopeKeys(dropboxIngestionPolicy);
  // The roster follows the stores and the policy, never the credentials that
  // happen to be connected at boot. `refreshSchedulerSources` rebuilds the
  // Dropbox lane the moment the owner connects an account, and it hands that
  // lane THIS runtime — so a roster frozen around a missing boot handle meant
  // the lane emitted no extract task until the process restarted.
  const selectedGoogleDriveExtractionHandle = () => selectedSourceCredentialHandle({
    env: process.env,
    pinEnvName: 'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CREDENTIAL_HANDLE',
    provider: 'google_drive',
    capability: 'google_drive.docs.sync',
    handles: readActiveConnectedHandles(process.env),
  });
  const fileExtractionCorpora = fileExtractionCorporaRoster({
    configured: configuredFileExtractionCorpora,
    ...(dropboxConnectorStore
      ? {
          dropbox: {
            extractionScopes: dropboxExtractionScopes,
            resolveExtractionScopes: () => {
              const ref = fileSourceScopeAuthority?.policyRef('dropbox.files');
              if (!ref || !fileSourceScopeAuthority) return [];
              return dropboxPolicyFullExtractionScopeKeys(fileSourceScopeDropboxPolicy(
                dropboxIngestionPolicy,
                fileSourceScopeAuthority.assertCurrent(ref),
              ));
            },
            resolveCandidateFilters: () => {
              const approval = fileSourceScopeAuthority?.snapshot('dropbox.files');
              const scope = approval ? fileSourceScopeContentFilters(approval) : { allowed: false as const };
              if (!scope.allowed || !scope.filters) {
                throw new OperationError(
                  'source_index_policy_violation',
                  'Current Dropbox full-ingestion scope is required before candidate enumeration.',
                );
              }
              return scope.filters;
            },
            resolveCredentialHandle: () => selectedSourceCredentialHandle({
              env: process.env,
              pinEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE',
              provider: 'dropbox',
              capability: 'dropbox.files.sync',
              handles: readActiveConnectedHandles(process.env),
            })?.handle,
          },
        }
      : {}),
    ...(localFilesConnectorStore
      ? {
          localFiles: {
            resolveExtractionScopes: () => {
              const ref = fileSourceScopeAuthority?.policyRef(LOCAL_FILES_SOURCE_ID);
              if (!ref || !fileSourceScopeAuthority) return [];
              return fileSourceScopeLocalFilesPolicy(
                localFilesIngestionPolicy,
                fileSourceScopeAuthority.assertCurrent(ref),
                localFilesExclusionContext,
              ).roots.filter((root) => root.default_action === 'full_extract').map((root) => root.approved_scope_key);
            },
            resolveCandidateFilters: () => {
              const approval = fileSourceScopeAuthority?.snapshot(LOCAL_FILES_SOURCE_ID);
              const scope = approval ? fileSourceScopeContentFilters(approval) : { allowed: false as const };
              if (!scope.allowed || !scope.filters) {
                throw new OperationError(
                  'source_index_policy_violation',
                  'Current local files full-ingestion scope is required before candidate enumeration.',
                );
              }
              return scope.filters;
            },
          },
        }
      : {}),
    ...(whatsappConnectorStore ? { whatsapp: true } : {}),
    ...(googleDriveInternalConnectorStore && googleDriveSecureConnectorStore
      ? {
          googleDrive: {
            corpusIds: [googleDriveInternalConnectorStore.corpusId, googleDriveSecureConnectorStore.corpusId],
            resolveCredentialHandle: () => selectedGoogleDriveExtractionHandle()?.handle,
            resolveAccountScope: () => {
              const handle = selectedGoogleDriveExtractionHandle();
              return handle?.accountRole?.trim() || accountFromGoogleHandle(handle?.handle);
            },
          },
        }
      : {}),
  });
  // The extraction lane resolves its handle lazily on every pass, so the
  // boot-time snapshot is not the last word: ask the same way the lane does
  // before saying anything, and say it as plain information, not a warning.
  if (dropboxConnectorStore && dropboxExtractionScopes.length > 0 && !dropboxHandle
    && !selectedSourceCredentialHandle({
      env: process.env,
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE',
      provider: 'dropbox',
      capability: 'dropbox.files.sync',
      handles: readActiveConnectedHandles(process.env),
      warn: () => {},
    })) {
    console.log('[file-extraction] Dropbox extraction waits for Dropbox to be connected.');
  }
  const assertFileSourceScopeCurrent = (provider: string): void => {
    const sourceId = fileSourceScopeIdForProvider(provider);
    if (!sourceId) return;
    const ref = fileSourceScopeAuthority?.policyRef(sourceId);
    if (!ref || !fileSourceScopeAuthority) {
      throw new OperationError('source_index_policy_violation', 'File-source scope approval is required.');
    }
    fileSourceScopeAuthority.assertCurrent(ref);
  };
  // The Drive lane's pictures are read by the factory, not its listing: the
  // factory lands their content by the same routing as the lane's sync, over
  // the same stores and ledger. The sync's own set stays the one the ledger's
  // background passes find.
  const googleDriveExtractionTierSet = googleDriveInternalConnectorStore && googleDriveSecureConnectorStore
    ? createGoogleDriveLaneTierSet({
        setId: 'google_drive.extraction',
        internalStore: googleDriveInternalConnectorStore,
        secureStore: googleDriveSecureConnectorStore,
        ...(googleDriveTierLane?.publicStore
          ? {
              publicLeg: {
                corpusId: GOOGLE_DRIVE_PUBLIC_CONNECTOR_CORPUS_ID,
                open: () => googleDriveTierLane.publicStore!.open(),
                exists: () => googleDriveTierLane.publicStore!.exists(),
              },
            }
          : {}),
        ...(googleDriveTierLane?.secrets ? { secretLocations: googleDriveTierLane.secrets } : {}),
        registerWithLedger: false,
      })
    : undefined;
  const fileExtractionTierSets = new Map<string, TieredStoreSet>([
    // The Dropbox lane reads and lands text across its tier stores.
    ...(dropboxTierLane ? [[DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID, dropboxTierLane.set] as const] : []),
    ...(localFilesTierLane ? [[LOCAL_FILES_CORPUS_ID, localFilesTierLane.set] as const] : []),
    // WhatsApp's media children (and voice notes) are read and land across its tier stores.
    ...(whatsappTierSet ? [[WHATSAPP_LIVE_CORPUS_ID, whatsappTierSet] as const] : []),
    // Each Drive store's corpus lists its own store (and the Private one the
    // routed-only Public store too).
    ...(googleDriveExtractionTierSet && googleDriveInternalConnectorStore && googleDriveSecureConnectorStore
      ? [
          [googleDriveInternalConnectorStore.corpusId, googleDriveExtractionTierSet] as const,
          [googleDriveSecureConnectorStore.corpusId, googleDriveExtractionTierSet] as const,
        ]
      : []),
  ]);
  // The extractor configuration the main runtime and the imported archives' runtime share.
  const fileExtractionExtractors: ExtractorRegistryConfig = {
    // An owner-configured command wins; otherwise audio is read by the
    // built-in on-device transcriber where it runs (Mac and Linux by default).
    ...(process.env.OLYMPUS_TRANSCRIBE_COMMAND?.trim()
      ? { transcription: { command: process.env.OLYMPUS_TRANSCRIBE_COMMAND.trim() } }
      : sharedBuiltInTranscriber(process.env)
        ? { transcription: { builtIn: sharedBuiltInTranscriber(process.env)! } }
        : {}),
    ...(fileExtractionPdfTextCommand !== undefined || fileExtractionPdfTextTimeoutMs !== undefined
      || fileExtractionMaxBoundedTextChars !== undefined
      ? {
          text: {
            ...(fileExtractionPdfTextCommand ? { pdfTextCommand: fileExtractionPdfTextCommand } : {}),
            ...(fileExtractionPdfTextTimeoutMs !== undefined
              ? { pdfTextTimeoutMs: fileExtractionPdfTextTimeoutMs }
              : {}),
            ...(fileExtractionMaxBoundedTextChars !== undefined
              ? { maxBoundedTextChars: fileExtractionMaxBoundedTextChars }
              : {}),
          },
        }
      : {}),
    ...(fileExtractionOcrTimeoutMs !== undefined || fileExtractionPdfRenderTimeoutMs !== undefined
      || fileExtractionOcrEngine !== undefined || fileExtractionOcrMaxPages !== undefined
      ? {
          ocr: {
            ...(fileExtractionOcrTimeoutMs !== undefined ? { ocrTimeoutMs: fileExtractionOcrTimeoutMs } : {}),
            ...(fileExtractionOcrEngine !== undefined ? { engine: fileExtractionOcrEngine } : {}),
            ...(fileExtractionOcrMaxPages !== undefined ? { maxPages: fileExtractionOcrMaxPages } : {}),
            ...(fileExtractionPdfRenderTimeoutMs !== undefined
              ? { pdfRenderTimeoutMs: fileExtractionPdfRenderTimeoutMs }
              : {}),
          },
        }
      : {}),
    ...(fileExtractionRemoteClient
      ? {
          remote: {
            client: fileExtractionRemoteClient,
            ...(process.env.OLYMPUS_FILE_EXTRACTION_REMOTE_MODEL?.trim()
              ? { model: process.env.OLYMPUS_FILE_EXTRACTION_REMOTE_MODEL.trim() }
              : {}),
          },
        }
      : {}),
    ...(fileExtractionLocalVlmClient
      ? {
          vlm: { client: fileExtractionLocalVlmClient },
          vlmPdf: {
            client: fileExtractionLocalVlmClient,
            ...(parseOptionalPositiveInteger(
              process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_MAX_PAGES,
              'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_MAX_PAGES',
            ) !== undefined
              ? {
                  maxPages: parseOptionalPositiveInteger(
                    process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_MAX_PAGES,
                    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_MAX_PAGES',
                  )!,
                }
              : {}),
            ...(parseOptionalNonNegativeInteger(
              process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRIES,
              'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRIES',
            ) !== undefined
              ? {
                  pageRetries: parseOptionalNonNegativeInteger(
                    process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRIES,
                    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRIES',
                  )!,
                }
              : {}),
            ...(parseOptionalNonNegativeInteger(
              process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRY_DELAY_MS,
              'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRY_DELAY_MS',
            ) !== undefined
              ? {
                  pageRetryDelayMs: parseOptionalNonNegativeInteger(
                    process.env.OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRY_DELAY_MS,
                    'OLYMPUS_FILE_EXTRACTION_LOCAL_VLM_PDF_PAGE_RETRY_DELAY_MS',
                  )!,
                }
              : {}),
          },
        }
      : {}),
  };
  const fileExtractionRuntime = createFileExtractionRuntime({
    env: process.env,
    enabled: fileExtractionCorpora.length > 0,
    connectorStores,
    corpora: fileExtractionCorpora,
    extraSourceFactories: new Map([
      [LOCAL_FILES_PROVIDER, ({ config, store, view }) => {
        const ref = fileSourceScopeAuthority?.policyRef(LOCAL_FILES_SOURCE_ID);
        if (!ref || !fileSourceScopeAuthority) throw new OperationError('source_index_policy_violation', 'File-source scope approval is required.');
        const reader = view ?? store;
        const connector = createLocalFilesSourceConnector({
          connectorId: 'local.files.extraction',
          root: '/',
          scope: createScopeBoundLocalFilesContentScope({ authority: fileSourceScopeAuthority, ref, context: localFilesExclusionContext }),
          volumes: localFilesVolumes,
          locate: (localItemId) => reader.localContent(localItemId)?.locatorUri,
        });
        return createConnectorFileExtractionSource({
          id: `${config.corpusId}:extraction`,
          corpusId: config.corpusId,
          provider: config.provider,
          connector,
          candidates: connectorStoreExtractionCandidateReader(reader, config.resolveCandidateFilters?.()),
          lanes: (config.resolveScopes?.() ?? config.scopes).map((approvedScopeKey) => ({
            approvedScopeKey,
            matches: (row) => row.locatorUri !== undefined
              && scopePathIsWithin(row.locatorUri, approvedScopeKey.slice(LOCAL_FILES_POLICY_SOURCE.length + 1), localFilesExclusionContext),
          })),
        });
      }],
      // WhatsApp's media, its children an export brought included.
      ['whatsapp', ({ config, store, view }) => whatsappExtraction({ config, store, ...(view ? { view } : {}) })],
    ]),
    ...(fileExtractionTierSets.size > 0 ? { tierSets: fileExtractionTierSets } : {}),
    scopeGuard: {
      assertAuthorized({ config }) {
        assertFileSourceScopeCurrent(config.provider);
      },
      allowsRef({ config, reader, ref }) {
        const sourceId = fileSourceScopeIdForProvider(config.provider);
        if (!sourceId) return true;
        const approval = fileSourceScopeAuthority?.snapshot(sourceId);
        if (!approval) return false;
        const scope = fileSourceScopeContentFilters(approval);
        // The row may sit in any of the lane's tier stores: the corpus reads it through its view.
        return scope.allowed && reader.itemMatchesSearchFilters(ref.localItemId, ref.accountScope, scope.filters);
      },
    },
    extractors: fileExtractionExtractors,
  });
  const connectorStoreEmbeddingProviders = new Map<string, SourceEmbeddingProvider>();
  const connectorStoreAccountScopes = new Map<string, string>();
  const connectorStorePrincipals = new Map<string, ConnectorStoreDeclaredPrincipal>();
  if (dropboxConnectorStore) {
    connectorStoreAccountScopes.set(
      DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
      dropboxProviderAccount,
    );
    connectorStorePrincipals.set(DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID, {
      provider: 'dropbox',
      accountScope: dropboxProviderAccount,
    });
  }
  if (localFilesConnectorStore) {
    connectorStoreAccountScopes.set(LOCAL_FILES_CORPUS_ID, LOCAL_FILES_ACCOUNT_SCOPE);
    connectorStorePrincipals.set(LOCAL_FILES_CORPUS_ID, {
      provider: LOCAL_FILES_PROVIDER,
      accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
    });
  }
  if (whatsappConnectorStore) {
    connectorStoreAccountScopes.set(WHATSAPP_LIVE_CORPUS_ID, WHATSAPP_PERSONAL_ACCOUNT_SCOPE);
    connectorStorePrincipals.set(
      WHATSAPP_LIVE_CORPUS_ID,
      canonicalConnectorStoreChatPrincipal('whatsapp', WHATSAPP_PERSONAL_ACCOUNT_SCOPE),
    );
  }
  if (telegramConnectorStores) {
    for (const corpusId of [
      INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
      PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
    ]) {
      connectorStoreAccountScopes.set(corpusId, telegramConnectorAccountScope);
      connectorStorePrincipals.set(
        corpusId,
        canonicalConnectorStoreChatPrincipal('telegram', telegramConnectorAccountScope),
      );
    }
  }
  for (const mount of configuredConnectorStoreMounts) {
    if (mount.principal && !connectorStorePrincipals.has(mount.store.corpusId)) {
      connectorStorePrincipals.set(mount.store.corpusId, mount.principal);
    }
    if (mount.store.family !== 'chat' || !mount.chatPrincipal) continue;
    if (!connectorStoreAccountScopes.has(mount.store.corpusId)) {
      connectorStoreAccountScopes.set(mount.store.corpusId, mount.chatPrincipal.accountScope);
    }
  }
  const connectorStoreReadScope = (store: LocalConnectorStore):
    { allowed: false } | {
      allowed: true;
      accountScope?: string;
      filters?: import('../connector-store/index.ts').ConnectorStoreSearchFilters;
      contentAllowed: boolean;
      contentFilters?: import('../connector-store/index.ts').ConnectorStoreSearchFilters;
    } => {
    const sourceId = isDropboxTierStore(store)
      ? 'dropbox.files' as const
      : isLocalFilesTierStore(store)
        ? LOCAL_FILES_SOURCE_ID
      : store === googleDriveInternalConnectorStore || store === googleDriveSecureConnectorStore
        || (store.corpusId === GOOGLE_DRIVE_PUBLIC_CONNECTOR_CORPUS_ID && store === googleDriveTierLane?.publicStore?.current())
        ? 'google_drive.docs' as const
      : Object.values(EVERNOTE_TIER_CORPUS_IDS).includes(store.corpusId)
        ? EVERNOTE_SOURCE_ID
        : undefined;
    if (!sourceId) return { allowed: true, contentAllowed: true };
    const approval = fileSourceScopeAuthority?.snapshot(sourceId);
    if (!approval || approval.status !== 'approved') return { allowed: false };
    const metadataScope = fileSourceScopeMetadataFilters(approval);
    if (!metadataScope.allowed) return { allowed: false };
    const contentScope = fileSourceScopeContentFilters(approval);
    const scopeAccount = fileScopeAccount(sourceId);
    if (!scopeAccount) return { allowed: false };
    return {
      allowed: true,
      accountScope: scopeAccount.accountScope,
      filters: metadataScope.filters,
      contentAllowed: contentScope.allowed,
      ...(contentScope.allowed && contentScope.filters ? { contentFilters: contentScope.filters } : {}),
    };
  };
  const connectorStoreStatusScope = (store: LocalConnectorStore):
    ConnectorStoreStatusScope | undefined => {
    // Mail older than the approved window is kept as names only on purpose,
    // so neither Gmail store counts it as owed reading (gmail-status-scope.ts).
    if (store === gmailSecureConnectorStore) {
      const handle = selectedSourceCredentialHandle({
        env: process.env, pinEnvName: 'OLYMPUS_SOURCE_INDEX_GMAIL_CREDENTIAL_HANDLE',
        provider: 'gmail', capability: 'gmail.email.sync', handles: readActiveConnectedHandles(process.env),
      });
      return gmailPrivateStoreStatusScope({
        authority: fileSourceScopeAuthority,
        handle: handle ? { accountRole: gmailItemScopeFor(handle) } : undefined,
        // Mail an import brought in counts whether or not live Gmail is connected and approved.
        importAccountScope: gmailItemScopeFor(handle),
      });
    }
    if (store === gmailInternalConnectorStore) return gmailInternalStoreStatusScope(fileSourceScopeAuthority);
    const readScope = connectorStoreReadScope(store);
    if (!readScope.allowed) return { itemsAllowed: false, contentAllowed: false };
    if (!readScope.filters && !readScope.contentFilters) return undefined;
    return {
      ...(readScope.filters?.sourceScopeRevision
        ? { scopeRevision: readScope.filters.sourceScopeRevision }
        : {}),
      ...(readScope.accountScope ? { accountScope: readScope.accountScope } : {}),
      ...(readScope.filters ? { itemFilters: readScope.filters } : {}),
      contentAllowed: readScope.contentAllowed,
      ...(readScope.contentFilters ? { contentFilters: readScope.contentFilters } : {}),
    };
  };
  // Policy truth is independent of credential readiness: a selected Venice
  // profile stays visible as the intended secure embedding lane even when its
  // secret is currently missing and the runtime provider is unavailable.
  const secureEmbeddingProfile = sovereigntyEngine.resolveEmbeddingProfile('secure_local');
  const secureEmbeddingCloudApproved = secureEmbeddingProfile?.profile.provider === 'venice'
    && secureEmbeddingProfile.profile.trust === 'encrypted_cloud';
  const fullCorpusDefinitions = [
    defineGmailSecureLocalCorpus(),
    defineInternalEmailCorpus(),
    defineGoogleDriveDocsCorpus(),
    defineReadwiseLibraryCorpus(),
    defineXBookmarksCorpus(),
    defineDropboxFilesCorpus(),
    defineLocalFilesCorpus(),
    defineInternalTelegramMessagesCorpus(),
    defineProtectedTelegramMessagesCorpus(),
  ].map((definition) => secureEmbeddingCloudApproved && definition.trustDomain === 'secure_local'
    ? { ...definition, embeddingPolicy: 'cloud_allowed_by_policy' as const }
    : definition);
  const registeredCorpusDefinitions = new Map(
    sourceCorpusRegistry.definitions().map((definition) => [definition.corpusId, definition]),
  );
  const fullyDefinedCorpusIds = new Set(fullCorpusDefinitions.map((definition) => definition.corpusId));
  for (const store of connectorStores) {
    if (fullyDefinedCorpusIds.has(store.corpusId)) continue;
    const registeredDefinition = registeredCorpusDefinitions.get(store.corpusId);
    fullCorpusDefinitions.push(defineConnectorCorpus({
      corpusId: store.corpusId,
      family: store.family,
      trustDomain: store.trustDomain,
      ...(registeredDefinition ? { activationMode: registeredDefinition.activationMode } : {}),
      ...(secureEmbeddingCloudApproved && store.trustDomain === 'secure_local'
        ? { embeddingPolicy: 'cloud_allowed_by_policy' as const }
        : {}),
    }));
    fullyDefinedCorpusIds.add(store.corpusId);
  }
  const retrievalAvailability: Record<string, SourceIndexStatusRetrievalAvailability> = {};
  // A tier store its set opens (at boot when its file exists, or when its
  // first item is routed there) is served like its sibling: same account
  // scope and principal. Its embedding identity is its own trust domain's: a
  // Public store shares its Personal sibling's cloud identity; a lane's new
  // Private or Personal store is handed the identity for its domain.
  registerTierLegStore = (store, siblingCorpusId, embeddingProvider) => {
    if (!connectorStores.includes(store)) connectorStores.push(store);
    const accountScope = connectorStoreAccountScopes.get(siblingCorpusId);
    if (accountScope) connectorStoreAccountScopes.set(store.corpusId, accountScope);
    const principal = connectorStorePrincipals.get(siblingCorpusId);
    if (principal) connectorStorePrincipals.set(store.corpusId, principal);
    const provider = embeddingProvider === null
      ? undefined
      : embeddingProvider ?? connectorStoreEmbeddingProviders.get(siblingCorpusId) ?? sourceIndexEmbeddingProvider;
    if (provider && !connectorStoreEmbeddingProviders.has(store.corpusId)) {
      registerConnectorStoreEmbeddingLane({
        store,
        provider,
        providers: connectorStoreEmbeddingProviders,
        retrievalAvailability,
      });
    }
  };
  for (const registration of tierLegsOpenedEarly.splice(0)) registerTierLegStore(...registration);
  // Imported archives: one tier lane per family, adopted like every other
  // lane's, and built only once an archive of that family exists (an install
  // that never imported anything creates no file). Every store is created on
  // first need and served under its own trust domain's embedding identity.
  const archiveImports = createArchiveImportRuntime({
    env: process.env,
    openSecretLocations: (secureDbPath) => openTierSecretLocations({ sourceId: ARCHIVE_IMPORTS_SOURCE_ID }, secureDbPath, 'imported archives'),
    onLane: (lane) => {
      if (tierSecureEmbeddingProvider) lane.set.declarePrivateEmbedder(tierSecureEmbeddingProvider);
      adoptTierLane({
        ledger: lane.ledger,
        secureCorpusId: lane.secure.corpusId,
        corpusIds: archiveLaneLegs(lane).map((leg) => leg.corpusId),
        onDemand: archiveLaneLegs(lane),
        ...(lane.secretLocations ? { secrets: lane.secretLocations } : {}),
      });
    },
    onStoreOpened: (store) => registerTierLegStore(
      store,
      store.corpusId,
      store.trustDomain === 'secure_local' ? tierSecureEmbeddingProvider ?? null : sourceIndexEmbeddingProvider ?? null,
    ),
  });
  try {
    if (sourceAccountMountable({ sourceId: ARCHIVE_IMPORTS_SOURCE_ID })) archiveImports.existingLanes();
  } catch (error) {
    console.warn(`[archive-import] imported archives are not served this run: ${error instanceof Error ? error.name : 'error'}`);
  }
  // Evernote's account, read in passes over its MCP server (workers/evernote/):
  // its lane opens when an account is connected or a previous one left stores,
  // and is adopted like every other lane's.
  const evernote = createEvernoteRuntime({
    env: process.env,
    secretStore: () => lazySecretStore(process.env),
    registryPath: connectedHandleRegistryPath!,
    extractors: fileExtractionExtractors,
    openSecretLocations: (secureDbPath) => openTierSecretLocations({ sourceId: EVERNOTE_SOURCE_ID }, secureDbPath, 'Evernote'),
    onLane: (lane) => {
      if (tierSecureEmbeddingProvider) lane.set.declarePrivateEmbedder(tierSecureEmbeddingProvider);
      adoptTierLane({
        ledger: lane.ledger,
        secureCorpusId: lane.secure.corpusId,
        corpusIds: [lane.secure.corpusId, lane.internal.corpusId],
        onDemand: [lane.secure, lane.internal],
      });
    },
    onStoreOpened: (store) => registerTierLegStore(
      store,
      store.corpusId,
      store.trustDomain === 'secure_local' ? tierSecureEmbeddingProvider ?? null : sourceIndexEmbeddingProvider ?? null,
    ),
  });
  // The notebook picker lists this account's notebooks through the same sign-in (replaced, not
  // added, when the worker starts again in one process).
  unregisterFileScopeBrowserFactory(EVERNOTE_SOURCE_ID);
  registerFileScopeBrowserFactory(EVERNOTE_SOURCE_ID, (context) => createEvernoteNotebookScopeBrowser({
    listNotebooks: () => {
      const handle = readActiveConnectedHandles(process.env).find((entry) => entry.handle === context.credentialHandle);
      if (!handle) throw new OperationError('source_index_policy_violation', 'The connected Evernote account is unavailable.');
      return evernote.notebooks(handle);
    },
  }));
  try {
    if (sourceAccountMountable({ sourceId: EVERNOTE_SOURCE_ID })) evernote.existingLane();
  } catch (error) {
    console.warn(`[evernote] the Evernote stores are not served this run: ${error instanceof Error ? error.name : 'error'}`);
  }
  // Reading the child items an import listed by name (an attachment, a photo): the shared
  // extraction factory over the archive lanes' stores, built on first use and again when a
  // lane's stores change, with the same extractor configuration as the main runtime.
  const archiveExtraction = createArchiveExtractionRuntime({
    runtime: archiveImports,
    env: process.env,
    extractors: fileExtractionExtractors,
  });
  // Gmail's attachment children, live and imported alike: one extraction roster entry over the Gmail stores whose
  // one reader takes a part's bytes from where its locator says (gmail-attachment-extraction.ts). Built on first
  // use, and again once the Public store exists. Live parts are read only while the mail approval is current.
  let gmailAttachments: { key: string; runtime: ReturnType<typeof createGmailAttachmentExtractionRuntime> } | undefined;
  const gmailAttachmentRuntime = () => {
    if (!gmailInternalConnectorStore || !gmailSecureConnectorStore) return undefined;
    const publicStore = gmailTierLane?.publicStore?.exists() ? gmailTierLane.publicStore.open() : undefined;
    const key = publicStore ? 'with-public' : 'two-stores';
    if (gmailAttachments?.key === key) return gmailAttachments.runtime;
    const previous = gmailAttachments?.runtime;
    const currentHandle = () => selectedSourceCredentialHandle({
      env: process.env, pinEnvName: 'OLYMPUS_SOURCE_INDEX_GMAIL_CREDENTIAL_HANDLE',
      provider: 'gmail', capability: 'gmail.email.sync', handles: readActiveConnectedHandles(process.env),
    });
    // One live reader per account, handle and approval revision, reused for a few minutes: a message with several
    // attachments is fetched once, not once per part; a new approval or a stale reader gets a fresh one.
    let liveReader: { key: string; at: number; reader: GoogleGmailSourceConnector } | undefined;
    const runtime = createGmailAttachmentExtractionRuntime({
      stores: [gmailInternalConnectorStore, gmailSecureConnectorStore, ...(publicStore ? [publicStore] : [])],
      set: createLaneTieredStoreSet({
        setId: GMAIL_SOURCE_ID,
        internalStore: gmailInternalConnectorStore,
        secureStore: gmailSecureConnectorStore,
        ...(gmailTierLane?.publicStore ? { publicLeg: gmailTierLane.publicStore } : {}),
        ...(gmailTierLane?.secrets ? { secretLocations: gmailTierLane.secrets } : {}),
        contentArrivesLaterFor: gmailContentArrivesLater,
      }),
      accountScope: () => gmailItemScopeFor(currentHandle()),
      connector: (accountScope) => gmailAttachmentConnector({
        account: accountScope,
        imports: archiveImports.state,
        live: () => {
          const handle = currentHandle();
          const scopeRef = handle && fileSourceScopeAuthority ? fileSourceScopeAuthority.mailPolicyRef() : undefined;
          if (!handle || !scopeRef || !fileSourceScopeAuthority || !gmailRequestBudget) return undefined;
          let approval;
          try {
            approval = fileSourceScopeAuthority.assertCurrentMail(scopeRef);
          } catch {
            return undefined;
          }
          const readerKey = [handle.handle, accountScope, scopeRef.accountGeneration, scopeRef.revision].join('\u0000');
          if (liveReader?.key === readerKey && Date.now() - liveReader.at < GMAIL_ATTACHMENT_READER_REUSE_MS) return liveReader.reader;
          // The scope as it stands now: the parent is re-checked against it before a part is read, and the
          // approval is asked again before every provider call.
          const reader = new GoogleGmailSourceConnector({
            credentialHandle: handle.handle,
            account: accountScope,
            requestBudget: gmailRequestBudget,
            build: { children: true },
            scope: gmailConnectorScopeFromApproval(approval),
            beforeEachRequest: () => { fileSourceScopeAuthority.assertCurrentMail(scopeRef); },
          });
          liveReader = { key: readerKey, at: Date.now(), reader };
          return reader;
        },
      }),
      env: process.env,
      extractors: fileExtractionExtractors,
    });
    gmailAttachments = { key, runtime };
    try {
      previous?.close();
    } catch {
      // Closing an old connection never decides whether the new one serves.
    }
    return runtime;
  };
  // Telegram's media children, kept by live capture or carried by an export: one extraction roster entry over the
  // Telegram stores whose one reader takes a file from where its locator says (telegram-messages/media-extraction.ts).
  // Built on first use.
  let telegramMedia: ReturnType<TelegramConnectorStoreSyncHandler['mediaExtraction']> | undefined;
  const telegramMediaRuntime = () => telegramMedia ??= telegramConnectorStoreSync?.mediaExtraction({
    imports: () => ({ state: archiveImports.state, bindings: archiveImports.media }),
    env: process.env,
    extractors: fileExtractionExtractors,
  });
  // Every constructed canonical store gets its embedding and retrieval lane.
  if (xBookmarksConnectorStore && xBookmarksEmbeddingProvider) {
    registerConnectorStoreEmbeddingLane({
      store: xBookmarksConnectorStore,
      provider: xBookmarksEmbeddingProvider,
      providers: connectorStoreEmbeddingProviders,
      retrievalAvailability,
    });
  }
  if (readwiseConnectorStore && readwiseEmbeddingProvider) {
    registerConnectorStoreEmbeddingLane({
      store: readwiseConnectorStore,
      provider: readwiseEmbeddingProvider,
      providers: connectorStoreEmbeddingProviders,
      retrievalAvailability,
    });
  }
  for (const store of connectorStores) {
    if (connectorStoreEmbeddingProviders.has(store.corpusId)) continue;
    const provider = store.trustDomain === 'secure_local'
      ? secureLocalPolicyEmbeddingProvider
      : sourceIndexEmbeddingProvider;
    if (!provider || (store.trustDomain === 'secure_local' && !isApprovedSecureSourceEmbeddingProvider(provider))) continue;
    registerConnectorStoreEmbeddingLane({
      store,
      provider,
      providers: connectorStoreEmbeddingProviders,
      retrievalAvailability,
    });
  }
  if (xBookmarksConnectorStore) {
    const principalXAccount = sourceIndexAccount?.trim() || xBookmarksHandle?.accountRole?.trim();
    if (principalXAccount) connectorStoreAccountScopes.set(xBookmarksConnectorStore.corpusId, principalXAccount);
  }
  if (readwiseConnectorStore) {
    // The handle's own account role, when it has one, replaces this default on
    // every scheduler build (first one below, before the worker serves).
    connectorStoreAccountScopes.set(
      readwiseConnectorStore.corpusId,
      sourceIndexAccount?.trim() || 'personal',
    );
  }
  // A Public store that already exists from an earlier run is served from
  // boot; one that does not is created by its tier set on first need.
  for (const lane of tierLanes) {
    for (const store of lane.onDemand) {
      if (store.exists()) store.open();
    }
  }
  // No handle, no handler. The stores and the budget exist at boot whatever the
  // registry says, so without this guard an enabled lane would build a sync
  // handler that falls back to the connector's default credential handle and
  // reads a mailbox nobody selected.
  //
  // No approved mail scope, no handler either (design §2.5): a connected
  // mailbox waits for the owner's mail selection exactly as a folder source
  // waits for its folders, and nothing — not even metadata — is read before
  // it. The handler is bound to the approval it was built under; a new
  // revision builds a new one on the next scheduler pass.
  const createGmailConnectorStoreSyncForHandle = (
    handle: ConnectedCredentialHandle | undefined,
  ) => {
    const scopeRef = handle && fileSourceScopeAuthority ? fileSourceScopeAuthority.mailPolicyRef() : undefined;
    const approval = scopeRef && fileSourceScopeAuthority ? fileSourceScopeAuthority.assertCurrentMail(scopeRef) : undefined;
    const privateDefinition = gmailSecureConnectorStore && sourceCorpusRegistry.definitions().find(entry => entry.corpusId === gmailSecureConnectorStore.corpusId);
    return handle && scopeRef && approval && fileSourceScopeAuthority
      && gmailInternalConnectorStore && gmailSecureConnectorStore && gmailRequestBudget
    ? createGmailConnectorStoreSyncHandler({
      internalStore: gmailInternalConnectorStore,
      secureStore: gmailSecureConnectorStore,
      requestBudget: gmailRequestBudget,
      scope: gmailConnectorScopeFromApproval(approval),
      scopeApproval: { generation: scopeRef.accountGeneration, revision: scopeRef.revision },
      confirmStoredPrivateScope: !!privateDefinition && secureLocalPolicyEmbeddingProvider?.provider === 'built-in'
        && secureLocalPolicyEmbeddingProvider.backend === 'local'
        && privateDefinition?.activationMode !== 'lexical_only' && privateDefinition?.embeddingPolicy !== 'disabled'
        && (sovereigntyEngine.config.retrieval.trustDomains.secure_local?.activationMode === 'hybrid_shadow'
          || sovereigntyEngine.config.retrieval.trustDomains.secure_local?.activationMode === 'hybrid_primary'),
      assertScopeCurrent: () => {
        fileSourceScopeAuthority.assertCurrentMail(scopeRef);
      },
      ...(gmailTierLane?.publicStore ? { publicStore: gmailTierLane.publicStore } : {}),
      ...(gmailTierLane?.secrets ? { secretLocations: gmailTierLane.secrets } : {}),
      // A fresh provider traversal is a bounded, resumable history walk.
      // Legacy replay is explicit one-time convergence tooling and is never
      // auto-wired into the product server.
      // In-run embedding, the same provider choice the Drive lane makes.
      // Without it the pull fills both stores with chunks and no embeddings,
      // and the corpus can never become servable.
      ...(sourceIndexEmbeddingProvider
        ? { internalEmbeddingProvider: scopeBoundEmbeddingProvider(sourceIndexEmbeddingProvider, fileSourceScopeAuthority, scopeRef) }
        : {}),
      ...(secureLocalPolicyEmbeddingProvider && isApprovedSecureSourceEmbeddingProvider(secureLocalPolicyEmbeddingProvider)
        ? { secureEmbeddingProvider: scopeBoundEmbeddingProvider(secureLocalPolicyEmbeddingProvider, fileSourceScopeAuthority, scopeRef) }
        : {}),
      ...(handle?.handle ? { credentialHandle: handle.handle } : {}),
      account: gmailItemScopeFor(handle),
      // Attachments are children of their message (2.1.0), read later by the attachment extraction lane.
      build: { children: true },
    })
    : undefined;
  };
  const createGoogleDriveConnectorStoreSyncForHandle = (
    handle: ConnectedCredentialHandle | undefined,
  ): GoogleDriveConnectorStoreSyncHandler | undefined => {
    const scopeRef = handle && fileSourceScopeAuthority
      ? fileSourceScopeAuthority.policyRef('google_drive.docs')
      : undefined;
    const scopeSnapshot = scopeRef && fileSourceScopeAuthority
      ? fileSourceScopeAuthority.assertCurrent(scopeRef)
      : undefined;
    return handle && scopeRef && fileSourceScopeAuthority
      && scopeSnapshot && fileSourceScopeMetadataEnabled(scopeSnapshot)
      && googleDriveInternalConnectorStore && googleDriveSecureConnectorStore && googleDriveRequestBudget
      ? createGoogleDriveConnectorStoreSyncHandler({
        internalStore: googleDriveInternalConnectorStore,
        secureStore: googleDriveSecureConnectorStore,
        requestBudget: googleDriveRequestBudget,
        ...(googleDriveTierLane?.publicStore ? { publicStore: googleDriveTierLane.publicStore } : {}),
        ...(googleDriveTierLane?.secrets ? { secretLocations: googleDriveTierLane.secrets } : {}),
        scope: createScopeBoundGoogleDriveContentScope({ authority: fileSourceScopeAuthority, ref: scopeRef }),
        // The same gate the stores hold, handed to the traversal so an excluded
        // file is refused before its content is downloaded rather than after.
        ...(googleDriveExclusions ? { exclusions: googleDriveExclusions } : {}),
        // A fresh runtime traverses provider history directly. Legacy replay
        // is an explicit one-time convergence tool and is never auto-wired
        // into the product server.
        // In-run embedding, the same provider choice the generic connector-store
        // lane makes. Without it the pull fills both stores with chunks and no
        // embeddings, and the corpus can never become servable.
        ...(googleDriveDocsEmbeddingProvider
          ? { internalEmbeddingProvider: scopeBoundEmbeddingProvider(googleDriveDocsEmbeddingProvider, fileSourceScopeAuthority, scopeRef) }
          : {}),
        ...(secureLocalPolicyEmbeddingProvider && isApprovedSecureSourceEmbeddingProvider(secureLocalPolicyEmbeddingProvider)
          ? { secureEmbeddingProvider: scopeBoundEmbeddingProvider(secureLocalPolicyEmbeddingProvider, fileSourceScopeAuthority, scopeRef) }
          : {}),
        ...(handle?.handle ? { credentialHandle: handle.handle } : {}),
        ...(handle?.accountRole ? { account: handle.accountRole } : {}),
      })
      : undefined;
  };
  // The analyst-backed contracts path is THE source answer path (the template
  // handler was deleted at the Lane F deletion milestone, 2026-06-10).
  const sourceIndexAnswerMaxResults = parseOptionalPositiveInteger(
    process.env.OLYMPUS_SOURCE_INDEX_ANSWER_MAX_RESULTS,
    'OLYMPUS_SOURCE_INDEX_ANSWER_MAX_RESULTS',
  );
  // Total prompt bytes a local analyst leg may receive. Set it only when the
  // local model's served context is known to hold more than the conservative
  // default.
  const sourceIndexLocalAnalystPromptBytes = parseOptionalPositiveInteger(
    process.env.OLYMPUS_SOURCE_INDEX_LOCAL_ANALYST_PROMPT_BYTES,
    'OLYMPUS_SOURCE_INDEX_LOCAL_ANALYST_PROMPT_BYTES',
  );
  const sourceIndexAnswerMaxCharsPerCandidate = parseOptionalPositiveInteger(
    process.env.OLYMPUS_SOURCE_INDEX_ANSWER_MAX_CHARS_PER_CANDIDATE,
    'OLYMPUS_SOURCE_INDEX_ANSWER_MAX_CHARS_PER_CANDIDATE',
  );
  const sourceIndexTrustedAnalystTimeoutMs = parseOptionalPositiveInteger(
    process.env.OLYMPUS_SOURCE_INDEX_TRUSTED_ANALYST_TIMEOUT_MS,
    'OLYMPUS_SOURCE_INDEX_TRUSTED_ANALYST_TIMEOUT_MS',
  );
  // Local Argus analyst ceiling — decoupled from the OpenClaw tool watchdog
  // budget (request.timeout_ms) and from the trusted-cloud bound. Generous by
  // design; unset falls back to the handler default (DEFAULT_LOCAL_ANALYST_TIMEOUT_MS).
  const sourceAnswerLocalAnalystTimeoutMs = parseOptionalPositiveInteger(
    process.env.OLYMPUS_SOURCE_ANSWER_ANALYST_TIMEOUT_MS,
    'OLYMPUS_SOURCE_ANSWER_ANALYST_TIMEOUT_MS',
  );
  const sourceAnswerLastLegTimeoutMs = parseSecureAnalystPoolLastLegTimeoutMs(
    process.env.OLYMPUS_SOURCE_ANSWER_LAST_LEG_TIMEOUT_MS,
  );
  const veniceAnalystTimeoutMs = process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_TIMEOUT_SECONDS?.trim()
    ? parseRequiredTimeoutSeconds(
      process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_TIMEOUT_SECONDS,
      'OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_TIMEOUT_SECONDS',
    )
    : undefined;
  const veniceReasoningHeadroomTokens = parseOptionalTokenCount(
    process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_REASONING_HEADROOM_TOKENS,
    'OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_REASONING_HEADROOM_TOKENS',
  );
  const effectiveTrustedAnalystTimeoutMs = trustedAnalystAssistTimeoutMs({
    explicitTrustedAnalystTimeoutMs: sourceIndexTrustedAnalystTimeoutMs,
    veniceAnalystTimeoutMs,
  });
  const sourceIndexAnalystPreflightTimeoutMs = parseOptionalTimeoutSecondsOrNone(
    process.env.OLYMPUS_SOURCE_INDEX_ANALYST_PREFLIGHT_TIMEOUT_SECONDS,
    'OLYMPUS_SOURCE_INDEX_ANALYST_PREFLIGHT_TIMEOUT_SECONDS',
  ) ?? 0;
  const secureDerivativeDefault = parseSecureDerivativeDefault(
    process.env.OLYMPUS_SECURE_DERIVATIVE_DEFAULT,
  );
  // `embedding: 'built_in_only'` builds the same lanes for answers on this
  // computer alone (source-index/local-answer.ts, source-answer-lanes.ts).
  let sourceAnswerLanes: ReturnType<typeof createSourceAnswerLanes> | undefined;
  const analystSourceAnswer = sourceIndexAnswerEnabled
    ? await (async () => {
      const analystLane = process.env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE
        ? parseLane(process.env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE)
        : olympusConfig.argus.defaultLane;
      const analystProfile = process.env.OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE
        ? parseModelProfile(process.env.OLYMPUS_SOURCE_INDEX_ANALYST_PROFILE)
        : 'source_answer';
      // Frontier cloud analyst for INTERNAL/PUBLIC packs. secure_local never
      // reaches this standard-cloud lane; its configured secure pool contains
      // only loopback local and approved Venice members.
      // OpenClaw-native cloud analyst: reaches GPT-5.5 through `openclaw infer`
      // (the host's OAuth provider — the user's subscription, no metered API
      // key). secure_local packs never reach it (the membrane in the handler).
      const cloudAnalystEnabled = parseOptionalBooleanEnv(
        process.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED,
        'OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_ENABLED',
        { invalid: 'warn-false' },
      );
      const cloudAnalyst = cloudAnalystEnabled
        ? createAnalyst(
          createOpenClawInferAnalystModel({
            ...(process.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL?.trim()
              ? { model: process.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_MODEL.trim() }
              : {}),
            ...(process.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_THINKING?.trim()
              ? { thinking: process.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_THINKING.trim() }
              : { thinking: 'low' }),
            ...(process.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_COMMAND?.trim()
              ? { command: process.env.OLYMPUS_SOURCE_INDEX_CLOUD_ANALYST_COMMAND.trim() }
              : {}),
          }),
        )
        : undefined;
      const secureLocalAnalystProvider =
        process.env.OLYMPUS_SOURCE_INDEX_SECURE_ANALYST_PROVIDER?.trim() || 'local';
      if (secureLocalAnalystProvider !== 'local') {
        throw new Error(
          'OLYMPUS_SOURCE_INDEX_SECURE_ANALYST_PROVIDER is retired; configure routes.secure_local.pool in sovereignty.json.',
        );
      }
      const veniceModelOptionsFromRequest = (request: { analyst_model?: string }) => ({
        apiKey: requireVeniceApiKey(process.env),
        ...(request.analyst_model?.trim()
          ? { model: request.analyst_model.trim() }
          : process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_MODEL?.trim()
            ? { model: process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_MODEL.trim() }
            : {}),
        ...(process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_BASE_URL?.trim()
          ? { baseUrl: process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_BASE_URL.trim() }
          : {}),
        ...(process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_REASONING_EFFORT?.trim()
          ? { reasoningEffort: parseVeniceReasoningEffort(process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_REASONING_EFFORT) }
          : {}),
        ...(process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_THINKING?.trim()
          ? { thinking: parseVeniceThinkingMode(process.env.OLYMPUS_SOURCE_INDEX_VENICE_ANALYST_THINKING) }
          : {}),
        ...(veniceReasoningHeadroomTokens !== undefined
          ? { reasoningHeadroomTokens: veniceReasoningHeadroomTokens }
          : {}),
        ...(veniceAnalystTimeoutMs !== undefined
          ? { timeoutMs: veniceAnalystTimeoutMs }
          : {}),
      });
      const localSourceAnswerModel = localModelActivity.track(localModelResourceKey(process.env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE
        ? olympusConfig.argus.lanes[analystLane]
        : olympusConfig.argus.modelProfiles[analystProfile]), createDelphiAnalystModel(
        new DelphiClient(olympusConfig),
        process.env.OLYMPUS_SOURCE_INDEX_ANALYST_LANE
          ? { lane: analystLane, preflightTimeoutMs: sourceIndexAnalystPreflightTimeoutMs }
          : { profile: analystProfile, preflightTimeoutMs: sourceIndexAnalystPreflightTimeoutMs },
      ), { serialize: false });
      const builtInAnalystModel = answerBuiltInModel;
      const sovereigntyAnalysts = await createSovereigntyAnalystMap({
        localModelActivity,
        engine: sovereigntyEngine,
        olympusConfig,
        env: process.env,
        defaultLocal: createAnalyst(localSourceAnswerModel, { auditSuspiciousDrafts: true }),
        veniceAnalystTimeoutMs,
        veniceReasoningHeadroomTokens,
        bootSecretResolver,
        ...(builtInAnalystModel
          ? { builtInAnalyst: createAnalyst(builtInAnalystModel, { auditSuspiciousDrafts: true }) }
          : {}),
      });
      if (builtInAnalystModel) {
        // Start the one-time download at boot when this computer's configured
        // local model service is not answering, so the dashboard shows the
        // install right away instead of at the first Private question.
        void probeLocalAnalystService(olympusConfig).then((up) => {
          if (!up) void builtInAnalystModel.prepare();
        });
      }
      const defaultLocalAnalyst = sovereigntyAnalysts.get('local-source-answer')?.analyst
        ?? createAnalyst(localSourceAnswerModel, { auditSuspiciousDrafts: true });
      return createAnalystSourceIndexAnswerHandler({
        inferenceGuard: (pack, request, corpusIds) => guardSourceAnswerEvidence({ lanes: sourceAnswerLanes!, pack, request, corpusIds }),
        analyst: defaultLocalAnalyst,
        releaseCheck: createReleaseTierCheck(
          tierScopes,
          () => secureDerivativeDefault ?? 'allow',
        ),
        queryPlanner: createAnalystQueryPlanner(localSourceAnswerModel),
        ...(cloudAnalyst ? { cloudAnalyst } : {}),
        veniceAnalyst: (request) => {
          const requestedProvider = request.analyst_provider ?? (request.analyst_model ? 'venice' : 'default');
          if (requestedProvider !== 'venice') return undefined;
          return createAnalyst(createVeniceAnalystModel(veniceModelOptionsFromRequest(request)));
        },
        sovereigntyAnalystRoute: ({ pack, localOnly, requestedProvider }) => {
          const trustDomain = analystRouteTrustDomain(pack, localOnly);
          const pool = sovereigntyEngine.resolveAnalystPool({
            trustDomain,
            requestedProvider,
          });
          return sovereigntyAnalystRoutePlan({
            trustDomain,
            pool,
            analysts: sovereigntyAnalysts,
          });
        },
        secureLocalAnalystRoute: ({ requestedProvider }) => secureLocalAnalystRouteStatus({
          engine: sovereigntyEngine,
          analysts: sovereigntyAnalysts,
          requestedProvider,
        }),
        ...(sourceIndexAnswerMaxResults !== undefined
          ? { defaultMaxResults: sourceIndexAnswerMaxResults }
          : {}),
        ...(sourceIndexLocalAnalystPromptBytes !== undefined
          ? { localAnalystPromptByteBudget: sourceIndexLocalAnalystPromptBytes }
          : {}),
        ...(sourceIndexAnswerMaxCharsPerCandidate !== undefined
          ? { maxCharsPerCandidate: sourceIndexAnswerMaxCharsPerCandidate }
          : {}),
        ...(effectiveTrustedAnalystTimeoutMs !== undefined
          ? { trustedAnalystTimeoutMs: effectiveTrustedAnalystTimeoutMs }
          : {}),
        ...(sourceAnswerLocalAnalystTimeoutMs !== undefined
          ? { localAnalystTimeoutMs: sourceAnswerLocalAnalystTimeoutMs }
          : {}),
        secureAnalystPool: {
          lastLegTimeoutMs: sourceAnswerLastLegTimeoutMs,
        },
        secureAnalystPoolState,
        ...(secureDerivativeDefault !== undefined
          ? { secureDerivativeDefault }
          : {}),
        // Every configured corpus answers through the Analyst: the canonical
        // answer-capable corpus registry, the same adapters the previous
        // handler used, and a LocalContentProvider per mounted corpus feeding
        // real bounded content. A registered corpus without a mounted adapter
        // is audited as skipped/no_adapter instead of silently disappearing
        // from unified fan-out.
        lanes: sourceAnswerLanes = createSourceAnswerLanes({
          stores: () => readConnectorStores,
          registry: () => buildSourceIndexCorpusRegistry(
            sourceCorpusRegistry.definitions('answer', fullCorpusDefinitions)
              .filter((definition) => !onDemandCorpusAbsent(definition.corpusId)),
          ),
          embeddingProvider: (store) => connectorStoreEmbeddingProviders.get(store.corpusId) ?? sourceIndexEmbeddingProvider,
          localEmbedding: loadedBuiltInEmbedding,
          readScope: connectorStoreReadScope,
          answerScope: (store, request) => {
            const principal = connectorStorePrincipals.get(store.corpusId);
            return connectorStoreAnswerScope({ store, request, ...(principal ? { principal } : {}) });
          },
          accountScope: (store) => connectorStoreAccountScopes.get(store.corpusId),
          semanticRelevanceBar: (store) => (store.corpusId === X_BOOKMARKS_CORPUS_ID ? xBookmarksSemanticRelevanceBar : undefined),
          visibilityGate: tierVisibilityGate,
          // A child item's citation names its parent when the parent's names may go where the child goes.
          parentLabels: parentLabelResolver,
          secretLocations: tierSecretLocations,
          heldItems: (corpusId) => tierLanes.find((candidate) => candidate.corpusIds.has(corpusId))?.ledger.corpusCopyCounts(corpusId).held ?? 0,
        }),
      });
    })()
    : undefined;
  const sourceAnswer = analystSourceAnswer
    ? {
        async answer(request: Parameters<typeof analystSourceAnswer.answer>[0], local?: Parameters<typeof analystSourceAnswer.answer>[1]) {
          // The sniffer shares the private pool: an answer takes it at once.
          // A background agent's answer does not hold back queued background
          // answers the way the owner's own work does (core/source-answer-jobs.ts).
          const kind = request.caller?.surface === 'remote' && isBackgroundConnection(request.caller.connection_id) ? 'background' : 'owner';
          return answerActivity.run(() => analystSourceAnswer.answer(request, local), kind);
        },
      }
    : undefined;
  const sourceWatchStore = new LocalSourceWatchStore();
  const sourceWatchExecutor = createSourceWatchExecutorCapability({ executorId: 'source-watch-scheduler' });
  const sourceWatchSearch = sourceAnswerLanes
    ? createSourceWatchSearchFromAnalystLanes(sourceAnswerLanes)
    : undefined;
  const sourceWatchDeliveryTransport = createOpenClawSourceWatchDeliveryTransport({
    ...(authToken ? { authToken } : {}),
  });
  const sourceWatchPass = sourceWatchSearch
    ? {
        run: () => runSourceWatchSchedulerPass({
            store: sourceWatchStore,
            search: sourceWatchSearch,
            transport: sourceWatchDeliveryTransport,
            executor: sourceWatchExecutor,
          }),
      }
    : undefined;
  // An item extraction gave up on is named on the dashboard only when it is
  // really unreadable: a Secrets item (by its tier ledger row, or located as a
  // secret) counts with the policy exit and is never named or counted as
  // unreadable, on any host; an item no store serves any more is left out of
  // both the count and the list. Source-neutral: every lane's ledger and
  // secret index, by corpus.
  const unreadableLocators = createUnreadableLocators({
    stores: () => connectorStores,
    lanes: () => tierLanes,
    parentLabels: parentLabelResolver,
  });
  const locateUnreadableItem = unreadableLocators.locate;
  // A file that came inside another item names it (label and route) in the computer's own list.
  const unreadableParentOfItem = unreadableLocators.parentOf;
  const unreadableVerdict = createUnreadableVerdict({
    locate: locateUnreadableItem,
    lanes: () => tierLanes,
  });
  const extractionReadinessLedger = fileExtractionRuntime
    ? createExtractionReadinessLedger(fileExtractionRuntime.jobs, {
        terminalRetryPaths: fileExtractionRuntime.terminalRetryPaths,
        classifyUnreadable: unreadableVerdict,
        currentItem(ref) {
          if (ref.corpusId === LOCAL_FILES_CORPUS_ID && localFilesConnectorStore) {
            const readScope = connectorStoreReadScope(localFilesConnectorStore);
            return readScope.allowed
              && readScope.contentAllowed
              && (localFilesExtractionView ?? localFilesConnectorStore).itemMatchesExtractionRef(ref, readScope.contentFilters);
          }
          if (ref.corpusId !== DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID || !dropboxConnectorStore) {
            return false;
          }
          const readScope = connectorStoreReadScope(dropboxConnectorStore);
          return readScope.allowed
            && readScope.contentAllowed
            && (dropboxExtractionView ?? dropboxConnectorStore).itemMatchesExtractionRef(ref, readScope.contentFilters);
        },
        lanesForCorpus(corpusId) {
          if (corpusId === LOCAL_FILES_CORPUS_ID) {
            const ref = fileSourceScopeAuthority?.policyRef(LOCAL_FILES_SOURCE_ID);
            if (!ref || !fileSourceScopeAuthority) return [];
            return fileSourceScopeLocalFilesPolicy(localFilesIngestionPolicy, fileSourceScopeAuthority.assertCurrent(ref), localFilesExclusionContext)
              .roots.filter((root) => root.default_action === 'full_extract').map((root) => ({
                corpusId,
                provider: LOCAL_FILES_PROVIDER,
                accountScope: LOCAL_FILES_ACCOUNT_SCOPE,
                approvedScopeKey: root.approved_scope_key,
              }));
          }
          if (corpusId !== DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID) return undefined;
          const ref = fileSourceScopeAuthority?.policyRef('dropbox.files');
          if (!ref || !fileSourceScopeAuthority) return [];
          const approval = fileSourceScopeAuthority.assertCurrent(ref);
          const scopes = dropboxPolicyFullExtractionScopeKeys(
            fileSourceScopeDropboxPolicy(dropboxIngestionPolicy, approval),
          );
          const handle = selectedSourceCredentialHandle({
            env: process.env,
            pinEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE',
            provider: 'dropbox',
            capability: 'dropbox.files.sync',
            handles: readActiveConnectedHandles(process.env),
          });
          const accountScope = handle?.accountRole?.trim() || dropboxFilesAccount || 'personal';
          return scopes.map((approvedScopeKey) => ({
            corpusId,
            provider: 'dropbox',
            accountScope,
            approvedScopeKey,
          }));
        },
      })
    : undefined;
  // Which files can't be read, and opening one on this computer (the panel's
  // See why): the ledger's own list, so the names are the files its count
  // counted. A file opens where its provider says: a Dropbox file's synced
  // copy here, else its web page.
  const { createDropboxOpenTargets: unreadableDropboxTargets, localDropboxRoots: unreadableDropboxRoots } = await import('../dropbox-files/open-target.ts');
  const unreadableOpenTargets: Record<string, (locator: string) => { url?: string; localPath?: string } | undefined> = {
    dropbox: unreadableDropboxTargets(),
    [LOCAL_FILES_PROVIDER]: localFilesOpenTarget,
  };
  const unreadableFiles = createUnreadableFiles({
        items: (corpusId) => {
          const items = [...(extractionReadinessLedger?.unreadableItems(corpusId) ?? []),
            ...connectorStores.filter(store => store.corpusId === corpusId)
              .flatMap(store => store.settledUnreadableItems(connectorStoreStatusScope(store)))];
          return Array.from(new Map(items.map(item => [item.ref.localItemId, item])).values());
        },
        verdict: unreadableVerdict,
        locate: locateUnreadableItem,
        parentOf: unreadableParentOfItem,
        // The provider's own resolver, else a Drive file's own Google page.
        // Nothing else opens: a locator is provider data, not a link to trust.
        openTarget: (provider, locator) => (Object.hasOwn(unreadableOpenTargets, provider)
          ? unreadableOpenTargets[provider]!(locator)
          : provider === 'google_drive' && googleFilePage(locator) ? { url: locator }
          : provider === 'gmail' && /^https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/[A-Za-z0-9_-]+$/.test(locator)
            ? { url: locator } : undefined),
        ...(process.platform === 'darwin' || process.platform === 'linux'
          ? {
              openFile: (path: string, eligible: () => Promise<boolean>) =>
                openLocalFile(path, eligible, [...unreadableDropboxRoots(), ...localFilesOpenableRoots()]),
            }
          : {}),
      });
  const sourceIndexStatus = sourceIndexReadEnabled
    ? createSourceIndexStatusHandler({
      // Read per request: a per-tier store its tier set creates while the
      // runtime is up is reported from that moment, with no restart.
      corpusDefinitions: () => sourceCorpusRegistry.definitions('status', fullCorpusDefinitions)
        .filter((definition) => !onDemandCorpusAbsent(definition.corpusId)),
      connectorStores,
      connectorStoreStatusScope,
      ...(unreadableFiles ? { unreadableCount: (corpusId: string) => unreadableFiles.recheck(corpusId).unreadable } : {}),
      retrievalPolicy: (domain) => sovereigntyEngine.config.retrieval.trustDomains[domain as keyof typeof sovereigntyEngine.config.retrieval.trustDomains],
      retrievalAvailability,
      tierClassification: () => {
        const backlog = tierSnifferBacklog?.();
        return backlog
          ? {
              checking_items: backlog.checkingItems,
              remaining_questions: backlog.remainingQuestions,
              summary: backlog.summary,
              awaiting_owner_approval: backlog.awaitingOwnerApproval,
              ...(backlog.waiting
                ? { waiting_reason: backlog.waiting.reason, waiting_label: backlog.waiting.label, waiting_since: backlog.waiting.since }
                : {}),
            }
          : undefined;
      },
      // The owner's tier migration, content-free: lets the doctor and the
      // dashboard say "migration in progress" instead of reading its expected
      // parity lag as a failure.
      tierMigration: () => tierMigrationStatusSummary(
        resolveTierMigrationPaths(process.env, resolveEmbeddingLedgerPath(process.env)).statePath,
      ),
      // The policy and queue half of the readiness counts, from the shared
      // extraction queue rather than from any source's own index. Absent when
      // the factory is switched off, which leaves the coverage math on the
      // store's own per-item count alone.
      ...(extractionReadinessLedger ? { readinessLedger: extractionReadinessLedger } : {}),
    })
    : undefined;
  const sourceDashboardHistory = sourceIndexReadEnabled
    ? new SqliteSourceDashboardHistory()
    : undefined;
  const sourceIngestionLedger = sourceIndexReadEnabled
    ? new SqliteSourceIngestionLedgerStore()
    : undefined;
  const currentXBookmarksRuntime = (): XBookmarksConnectorStoreRuntime | undefined => {
    const handle = connectorStoreLaneHandle({
      env: process.env,
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CREDENTIAL_HANDLE',
      provider: 'x',
      capability: 'x.bookmarks.sync',
      handles: readActiveConnectedHandles(process.env),
    });
    const runtime = refreshableXBookmarksRuntime?.runtimeForHandle(handle);
    if (!runtime) return undefined;
    connectorStoreAccountScopes.set(
      runtime.store.corpusId,
      sourceIndexAccount?.trim() || handle?.accountRole?.trim() || 'personal',
    );
    // The operator routes reach the runtime without the scheduler, so they
    // pass the same account check its lane does before reading or writing.
    const guard = sourceAccountGuardFor(xBookmarksGuardLane(handle?.handle, runtime.providerUserId));
    return guard ? accountCheckedXBookmarksRuntime(runtime, guard) : runtime;
  };
  const readwiseSyncForHandle = (handle: ConnectedCredentialHandle | undefined) => {
    const sync = refreshableReadwiseRuntime?.syncForHandle(handle);
    if (sync && readwiseConnectorStore) {
      connectorStoreAccountScopes.set(
        readwiseConnectorStore.corpusId,
        sourceIndexAccount?.trim() || handle?.accountRole?.trim() || 'personal',
      );
    }
    return sync;
  };
  const currentReadwiseSync = () => readwiseSyncForHandle(connectorStoreLaneHandle({
    env: process.env,
    laneEnvName: 'OLYMPUS_SOURCE_INDEX_READWISE_CONNECTOR_STORE_ENABLED',
    pinEnvName: 'OLYMPUS_SOURCE_INDEX_READWISE_CREDENTIAL_HANDLE',
    provider: 'readwise',
    capability: 'readwise.sync',
    handles: readActiveConnectedHandles(process.env),
  }));
  // One provider account per file source (source-account-guard.ts): every
  // task of the Dropbox, Drive and Gmail lanes first checks that the token it
  // reads with, the connected grant and the stored items name one account.
  // Kept across scheduler rebuilds so a token is looked up once, not per pass.
  const sourceAccountGuards = new Map<string, SourceAccountGuard>();
  // The guards of the lanes being assembled, applied once every task of the
  // lane is attached: an embedding sweep or watch task appended later writes
  // the same stores and must not run past the guard (independent review
  // round 10).
  const laneGuards = new Map<string, SourceAccountGuard>();
  const laneStores = (
    stores: ReadonlyArray<LocalConnectorStore | undefined>,
    onDemand: ReadonlyArray<OnDemandTierStore | undefined>,
  ) => ({
    laneHoldsItems: (): boolean => stores.some((store) => store?.holdsAnyItem() === true)
      // A tier store not opened this run counts as holding items when its file
      // exists: guessing "empty" could bind a new account over a previous
      // account's rows.
      || onDemand.some((leg) => leg ? leg.current()?.holdsAnyItem() ?? leg.exists() : false),
    // A `data delete --source` while the worker stayed up leaves these
    // handles on deleted files (PR review): only a restart reopens them.
    laneStoresStale: (): boolean => stores.some((store) => store?.fileReplacedOrRemoved() === true)
      || onDemand.some((leg) => leg?.current()?.fileReplacedOrRemoved() === true),
  });
  type AccountGuardLane = {
    sourceId: AccountBoundSourceId;
    provider: AccountBoundProvider;
    capability: string;
    handle: string | undefined;
    laneHoldsItems: () => boolean;
    laneStoresStale: () => boolean;
    ownAccountEvidence?: SourceAccountGuardOptions['ownAccountEvidence'];
    // For a lane that reads as a fixed account id (X): the id this task's
    // runtime reads as. Part of the guard's key, so a task is always checked
    // against the runtime it holds, never one an operator route built since
    // (PR #264 review).
    readsAs?: { accountId: string | undefined };
  };
  const sourceAccountGuardFor = (lane: AccountGuardLane): SourceAccountGuard | undefined => {
    if (!lane.handle || !connectedHandleRegistryPath) return undefined;
    const key = `${lane.sourceId}\n${lane.handle}${lane.readsAs ? `\n${lane.readsAs.accountId ?? ''}` : ''}`;
    let guard = sourceAccountGuards.get(key);
    if (!guard) {
      guard = createSourceAccountGuard({
        sourceId: lane.sourceId,
        provider: lane.provider,
        handle: lane.handle,
        capability: lane.capability,
        registryPath: connectedHandleRegistryPath,
        laneHoldsItems: lane.laneHoldsItems,
        laneStoresStale: lane.laneStoresStale,
        requestStoreReopen: () => requestModelReload(),
        // The registry entry's account: what an import established, and what imports are matched against.
        historyAccount: {
          read: () => recordedProviderAccount({ sourceId: lane.sourceId }),
          record: (providerAccountId, { historyEmpty }) =>
            recordProviderAccount({ sourceId: lane.sourceId }, providerAccountId, process.env, { historyEmpty }),
        },
        ...(lane.ownAccountEvidence ? { ownAccountEvidence: lane.ownAccountEvidence } : {}),
        // Every guard of a source runs its tasks one at a time (scheduler
        // tasks, the Dropbox dashboard hook and the X operator routes alike):
        // the guard shares one runner per source by itself.
        ...(lane.readsAs ? { readAccountId: () => lane.readsAs?.accountId } : {}),
      });
      sourceAccountGuards.set(key, guard);
    }
    return guard;
  };
  const withSourceAccountGuard = (
    source: SourceSchedulerSource | undefined,
    lane: AccountGuardLane,
  ): SourceSchedulerSource | undefined => {
    if (!source) return source;
    const guard = sourceAccountGuardFor(lane);
    if (guard) laneGuards.set(source.sourceId, guard);
    return source;
  };
  // The X lane as the account guard sees it, shared by the scheduler lane and
  // the operator routes (Sync now, content recovery) that call the runtime
  // directly. Every X bookmarks read is addressed to the runtime's user id,
  // and X refuses it for another account's token: no identity call needed.
  const xBookmarksGuardLane = (handle: string | undefined, readsAs: string | undefined): AccountGuardLane => ({
    sourceId: 'x.bookmarks',
    provider: 'x',
    capability: 'x.bookmarks.sync',
    handle,
    ...laneStores(
      refreshableXBookmarksRuntime ? [refreshableXBookmarksRuntime.store] : [],
      xBookmarksTierStores,
    ),
    readsAs: { accountId: readsAs },
  });
  const schedulerSourcesForHandles = (handles: readonly ConnectedCredentialHandle[]): {
    sources: SourceSchedulerSource[];
    decisions: SourceSchedulerConstructionDecision[];
  } => {
    const decisions: SourceSchedulerConstructionDecision[] = [];
    laneGuards.clear();
    // Every lane reports why it did or did not build. A constructed source is
    // recorded under its OWN sourceId rather than the id expected here, so an
    // id that cannot be selected is visible in the boot log instead of showing
    // up hours later as an absence on the status surface.
    const recordLane = (
      expectedSourceId: string,
      skipReason: SourceSchedulerConstructionDecision['reason'] | undefined,
      build: () => SourceSchedulerSource | undefined,
    ): SourceSchedulerSource | undefined => {
      if (skipReason) {
        decisions.push({ sourceId: expectedSourceId, outcome: 'skipped', reason: skipReason });
        return undefined;
      }
      const source = build();
      decisions.push(source
        ? { sourceId: source.sourceId, outcome: 'constructed', reason: 'lane_ready' }
        : { sourceId: expectedSourceId, outcome: 'skipped', reason: 'no_tasks' });
      return source;
    };
    // Gmail and Drive select explicitly rather than by first match: a second
    // handle registered tomorrow must not silently rebind the lane to another
    // mailbox. The gate folds the lane enable in, so no handle means no source.
    const currentGmailHandle = connectorStoreLaneHandle({
      env: process.env,
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_GMAIL_CONNECTOR_STORE_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_GMAIL_CREDENTIAL_HANDLE',
      provider: 'gmail',
      capability: 'gmail.email.sync',
      handles,
    });
    const currentGoogleDriveHandle = connectorStoreLaneHandle({
      env: process.env,
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CONNECTOR_STORE_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CREDENTIAL_HANDLE',
      provider: 'google_drive',
      capability: 'google_drive.docs.sync',
      handles,
    });
    const currentDropboxHandle = connectorStoreLaneHandle({
      env: process.env,
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_DROPBOX_FILES_CREDENTIAL_HANDLE',
      provider: 'dropbox',
      capability: 'dropbox.files.sync',
      handles,
    });
    const currentReadwiseHandle = connectorStoreLaneHandle({
      env: process.env,
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_READWISE_CONNECTOR_STORE_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_READWISE_CREDENTIAL_HANDLE',
      provider: 'readwise',
      capability: 'readwise.sync',
      handles,
    });
    const currentXBookmarksHandle = connectorStoreLaneHandle({
      env: process.env,
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CREDENTIAL_HANDLE',
      provider: 'x',
      capability: 'x.bookmarks.sync',
      handles,
    });
    const currentWhatsAppHandle = connectorStoreLaneHandle({
      env: process.env,
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_WHATSAPP_CONNECTOR_STORE_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_WHATSAPP_CREDENTIAL_HANDLE',
      provider: 'whatsapp_personal',
      capability: 'whatsapp.personal.messages.sync',
      handles,
    });
    const currentTelegramHandle = connectorStoreLaneHandle({
      env: process.env,
      laneEnvName: 'OLYMPUS_SOURCE_INDEX_TELEGRAM_CONNECTOR_STORES_ENABLED',
      pinEnvName: 'OLYMPUS_SOURCE_INDEX_TELEGRAM_CREDENTIAL_HANDLE',
      provider: 'telegram',
      capability: 'telegram.messages.sync',
      handles,
    });
    const currentGmailConnectorStoreSync = createGmailConnectorStoreSyncForHandle(currentGmailHandle);
    const currentGmailScopeRef = currentGmailHandle && fileSourceScopeAuthority
      ? fileSourceScopeAuthority.mailPolicyRef()
      : undefined;
    const currentGoogleDriveScopeRef = currentGoogleDriveHandle && fileSourceScopeAuthority
      ? fileSourceScopeAuthority.policyRef('google_drive.docs')
      : undefined;
    const currentGoogleDriveConnectorStoreSync = createGoogleDriveConnectorStoreSyncForHandle(currentGoogleDriveHandle);
    const currentDropboxScopeRef = currentDropboxHandle && fileSourceScopeAuthority
      ? fileSourceScopeAuthority.policyRef('dropbox.files')
      : undefined;
    const currentDropboxProviderStoreSync = currentDropboxHandle && currentDropboxScopeRef
      && fileSourceScopeAuthority && dropboxConnectorStore && dropboxTierLane
      ? currentDropboxHandle.handle === dropboxHandle?.handle
        && currentDropboxScopeRef.sourceId === dropboxScopeRef?.sourceId
        && currentDropboxScopeRef.accountGeneration === dropboxScopeRef?.accountGeneration
        && currentDropboxScopeRef.revision === dropboxScopeRef?.revision
        && dropboxProviderStoreSync
        ? dropboxProviderStoreSync
        : createDropboxProviderStoreSyncHandler({
            tierSet: dropboxTierLane.set,
            store: dropboxConnectorStore,
            account: currentDropboxHandle.accountRole?.trim() || dropboxFilesAccount || 'personal',
            credentialHandle: currentDropboxHandle.handle,
            scope: createScopeBoundDropboxContentScope({ authority: fileSourceScopeAuthority, ref: currentDropboxScopeRef }),
            ...(dropboxFilesEmbeddingProvider && isApprovedSecureSourceEmbeddingProvider(dropboxFilesEmbeddingProvider)
              ? { embeddingProvider: scopeBoundEmbeddingProvider(dropboxFilesEmbeddingProvider, fileSourceScopeAuthority, currentDropboxScopeRef) }
              : {}),
          })
      : undefined;
    const currentLocalFilesScopeRef = fileSourceScopeAuthority
      ? fileSourceScopeAuthority.policyRef(LOCAL_FILES_SOURCE_ID)
      : undefined;
    const currentLocalFilesSync = currentLocalFilesScopeRef ? localFilesSyncFor(currentLocalFilesScopeRef) : undefined;
    const currentLocalFilesPolicy = currentLocalFilesScopeRef && fileSourceScopeAuthority
      ? fileSourceScopeLocalFilesPolicy(
          localFilesIngestionPolicy,
          fileSourceScopeAuthority.assertCurrent(currentLocalFilesScopeRef),
          localFilesExclusionContext,
        )
      : undefined;
    const currentXBookmarksConnectorStoreRuntime = refreshableXBookmarksRuntime
      ?.runtimeForHandle(currentXBookmarksHandle);
    if (currentXBookmarksConnectorStoreRuntime) {
      connectorStoreAccountScopes.set(
        currentXBookmarksConnectorStoreRuntime.store.corpusId,
        sourceIndexAccount?.trim() || currentXBookmarksHandle?.accountRole?.trim() || 'personal',
      );
    }
    const currentDropboxPolicy = currentDropboxScopeRef && fileSourceScopeAuthority
      ? fileSourceScopeDropboxPolicy(
          dropboxIngestionPolicy,
          fileSourceScopeAuthority.assertCurrent(currentDropboxScopeRef),
        )
      : fileSourceScopeDropboxPolicy(dropboxIngestionPolicy, {
          sourceId: 'dropbox.files',
          status: 'scope_pending',
          revision: 'pending',
          selections: [],
          wholeAccount: false,
        });
    // Bound to the handle current on THIS build, so a key connected after boot
    // constructs the lane on the next scheduler pass without a restart.
    const currentReadwiseConnectorStoreSync = readwiseSyncForHandle(currentReadwiseHandle);
    const xBookmarksSkipReason = !currentXBookmarksHandle
      ? 'no_handle' as const
      : !currentXBookmarksConnectorStoreRuntime
        ? 'no_store_sync' as const
        : undefined;
    const sources = [
      recordLane(
        SCHEDULER_SOURCE_IDS.gmail,
        !currentGmailHandle ? 'no_handle' : !currentGmailScopeRef ? 'scope_pending' : undefined,
        () => {
          const source = createGmailConnectorStoreSchedulerSource({
          config: olympusConfig,
          ...(currentGmailConnectorStoreSync ? { sync: currentGmailConnectorStoreSync } : {}),
          ...(gmailInternalConnectorStore ? { internalStore: gmailInternalConnectorStore } : {}),
          ...(gmailSecureConnectorStore ? { secureStore: gmailSecureConnectorStore } : {}),
          });
          // Keyed to the mail scope revision like the folder lanes: a new
          // revision is a new task id and so a fresh scheduler checkpoint.
          return withSourceAccountGuard(source && currentGmailScopeRef && fileSourceScopeAuthority
            ? scopeBoundSchedulerSource({ source, authority: fileSourceScopeAuthority, ref: currentGmailScopeRef })
            : undefined, {
            sourceId: 'gmail.email',
            provider: 'gmail',
            capability: 'gmail.email.sync',
            handle: currentGmailHandle?.handle,
            ...laneStores([gmailInternalConnectorStore, gmailSecureConnectorStore], [gmailTierLane?.publicStore]),
          });
        },
      ),
      recordLane(
        SCHEDULER_SOURCE_IDS.googleDrive,
        !currentGoogleDriveHandle ? 'no_handle' : !currentGoogleDriveScopeRef ? 'scope_pending' : undefined,
        () => {
          const source = createGoogleDriveConnectorStoreSchedulerSource({
          config: olympusConfig,
          ...(currentGoogleDriveConnectorStoreSync ? { liveSync: currentGoogleDriveConnectorStoreSync } : {}),
          ...(googleDriveInternalConnectorStore ? { internalStore: googleDriveInternalConnectorStore } : {}),
          ...(googleDriveSecureConnectorStore ? { secureStore: googleDriveSecureConnectorStore } : {}),
          ...(fileExtractionRuntime ? { fileExtraction: fileExtractionRuntime.runner } : {}),
          extractionAccountScope: currentGoogleDriveHandle?.accountRole?.trim()
            || accountFromGoogleHandle(currentGoogleDriveHandle?.handle),
          });
          return withSourceAccountGuard(source && currentGoogleDriveScopeRef && fileSourceScopeAuthority
            ? scopeBoundSchedulerSource({ source, authority: fileSourceScopeAuthority, ref: currentGoogleDriveScopeRef })
            : undefined, {
            sourceId: 'google_drive.docs',
            provider: 'google_drive',
            capability: 'google_drive.docs.sync',
            handle: currentGoogleDriveHandle?.handle,
            ...laneStores(
              [googleDriveInternalConnectorStore, googleDriveSecureConnectorStore],
              [googleDriveTierLane?.publicStore],
            ),
          });
        },
      ),
      recordLane(
        SCHEDULER_SOURCE_IDS.dropbox,
        !currentDropboxHandle
          ? 'no_handle'
          : !currentDropboxScopeRef
            ? 'scope_pending'
          : !currentDropboxProviderStoreSync || !dropboxConnectorStore
            ? 'no_store_sync'
            : undefined,
        () => {
          const source = createCanonicalDropboxSchedulerSource({
          policy: currentDropboxPolicy,
          config: olympusConfig,
          ...(currentDropboxProviderStoreSync ? { providerSync: currentDropboxProviderStoreSync } : {}),
          ...(dropboxConnectorStore ? { store: dropboxConnectorStore } : {}),
          ...(fileExtractionRuntime ? { fileExtraction: fileExtractionRuntime.runner } : {}),
          });
          return withSourceAccountGuard(source && currentDropboxScopeRef && fileSourceScopeAuthority
            ? scopeBoundSchedulerSource({ source, authority: fileSourceScopeAuthority, ref: currentDropboxScopeRef })
            : undefined, {
            sourceId: 'dropbox.files',
            provider: 'dropbox',
            capability: 'dropbox.files.sync',
            handle: currentDropboxHandle?.handle,
            ...laneStores(
              [dropboxConnectorStore],
              dropboxTierLane ? [dropboxTierLane.internal, dropboxTierLane.public] : [],
            ),
            // Grants from before account_info.read have no readable account;
            // folders only that account can open stand in for it.
            ownAccountEvidence: {
              record: (accessToken) => dropboxOwnRootFolderIds({ accessToken }),
              check: (accessToken, folderIds) => dropboxOwnsOneOfFolders({ accessToken, folderIds }),
            },
          });
        },
      ),
      recordLane(
        SCHEDULER_SOURCE_IDS.localFiles,
        !localFilesConnectorStore
          ? 'no_store_sync'
          : !currentLocalFilesScopeRef
            ? 'scope_pending'
            : !currentLocalFilesSync
              ? 'no_store_sync'
              : undefined,
        () => {
          if (!currentLocalFilesPolicy || !currentLocalFilesScopeRef || !fileSourceScopeAuthority) return undefined;
          const source = createLocalFilesSchedulerSource({
            policy: currentLocalFilesPolicy,
            config: olympusConfig,
            ...(currentLocalFilesSync ? { providerSync: currentLocalFilesSync } : {}),
            ...(localFilesConnectorStore ? { store: localFilesConnectorStore } : {}),
            ...(fileExtractionRuntime ? { fileExtraction: fileExtractionRuntime.runner } : {}),
            watch: { hub: localFilesWatchHub, volumes: localFilesVolumes, ignore: localFilesWatchIgnore },
          });
          return source
            ? scopeBoundSchedulerSource({ source, authority: fileSourceScopeAuthority, ref: currentLocalFilesScopeRef })
            : undefined;
        },
      ),
      recordLane(
        SCHEDULER_SOURCE_IDS.readwise,
        !currentReadwiseHandle
          ? 'no_handle'
          : !currentReadwiseConnectorStoreSync
            ? 'no_store_sync'
            : undefined,
        () => createReadwiseSchedulerSource({
          config: olympusConfig,
          ...(currentReadwiseConnectorStoreSync ? { liveSync: currentReadwiseConnectorStoreSync } : {}),
          ...(sourceIndexAccount ? { account: sourceIndexAccount } : currentReadwiseHandle?.accountRole ? { account: currentReadwiseHandle.accountRole } : {}),
        }),
      ),
      recordLane(
        SCHEDULER_SOURCE_IDS.xBookmarks,
        xBookmarksSkipReason,
        () => withSourceAccountGuard(currentXBookmarksConnectorStoreRuntime
          ? createXBookmarksSchedulerSource({
            config: olympusConfig,
            liveSync: currentXBookmarksConnectorStoreRuntime.sync,
          })
          : undefined, xBookmarksGuardLane(
            currentXBookmarksHandle?.handle,
            currentXBookmarksConnectorStoreRuntime?.providerUserId,
          )),
      ),
      recordLane(
        SCHEDULER_SOURCE_IDS.telegram,
        !currentTelegramHandle
          ? 'no_handle'
          : !telegramConnectorStoreSync
            ? 'no_store_sync'
            : undefined,
        () => createTelegramSchedulerSource({
          config: olympusConfig,
          subscribeChanges: telegramSpoolChanges,
          ...(telegramConnectorStoreSync ? { sync: telegramConnectorStoreSync } : {}),
          ...(telegramCaptureMaxItems !== undefined ? { maxItems: telegramCaptureMaxItems } : {}),
        }),
      ),
      recordLane(
        SCHEDULER_SOURCE_IDS.whatsapp,
        !currentWhatsAppHandle
          ? 'no_handle'
          : !whatsappConnectorStoreSync
            ? 'no_store_sync'
            : undefined,
        () => createWhatsAppSchedulerSource({
          config: olympusConfig,
          subscribeChanges: whatsappSpoolChanges,
          ...(whatsappConnectorStoreSync ? { sync: whatsappConnectorStoreSync } : {}),
          ...(fileExtractionRuntime ? { fileExtraction: fileExtractionRuntime.runner } : {}),
          ...(whatsappLiveMaxItems !== undefined ? { maxItems: whatsappLiveMaxItems } : {}),
        }),
      ),
      (() => {
        const handle = selectedSourceCredentialHandle({
          env: process.env,
          pinEnvName: 'OLYMPUS_SOURCE_INDEX_EVERNOTE_CREDENTIAL_HANDLE',
          provider: 'evernote',
          capability: EVERNOTE_SYNC_CAPABILITY,
          handles,
        });
        // A sign-in the provider refused waits for Reconnect rather than failing every hour.
        const usable = handle && handle.backendState?.status !== 'reauth_required' ? handle : undefined;
        // Nothing is read until the person has chosen notebooks; each pass reads the choice it was bound to.
        const scopeRef = usable ? fileSourceScopeAuthority?.policyRef(EVERNOTE_SOURCE_ID) : undefined;
        return recordLane(
          SCHEDULER_SOURCE_IDS.evernote,
          !usable ? 'no_handle' : !scopeRef ? 'scope_pending' : undefined,
          () => {
            if (!usable || !scopeRef || !fileSourceScopeAuthority) return undefined;
            const authority = fileSourceScopeAuthority;
            const source = evernote.schedulerSource({
              config: olympusConfig,
              handle: usable,
              notebookGate: () => {
                const approval = authority.assertCurrent(scopeRef);
                return (notebook) => fileSourceScopeAllowsContent(approval, [notebook.id])
                  ? 'ingest'
                  : fileSourceScopeAllowsMetadata(approval, [notebook.id]) ? 'metadata_only' : 'exclude';
              },
              assertNotebookChoiceCurrent: () => { authority.assertCurrent(scopeRef); },
              scope: { accountGeneration: scopeRef.accountGeneration, scopeRevision: scopeRef.revision },
            });
            return scopeBoundSchedulerSource({ source, authority, ref: scopeRef });
          },
        );
      })(),
      recordLane(
        SCHEDULER_SOURCE_IDS.archiveImports,
        undefined,
        () => {
          let lanes: ReturnType<typeof archiveImports.existingLanes>;
          try {
            lanes = archiveImports.existingLanes();
          } catch {
            lanes = [];
          }
          return createArchiveImportsSchedulerSource({
            runtime: archiveImports,
            config: olympusConfig,
            extraction: archiveExtraction,
            holdsStores: lanes.length > 0,
          });
        },
      ),
    ].filter((source): source is SourceSchedulerSource => source !== undefined);
    // Gmail with no live lane (not connected, or no mail approval) whose stores hold mail an import brought in: a
    // source with no sync of its own, so the embedding sweep and the private meaning backfill below still drain
    // the imported history. Live approval governs live reads, not the account's own stores.
    // Only mail an import brought in counts: kept live mail waits for its own lane's approval.
    let gmailImportedHistory: SourceSchedulerSource | undefined;
    if (!sources.some((source) => source.sourceId === SCHEDULER_SOURCE_IDS.gmail) && gmailInternalConnectorStore && gmailSecureConnectorStore
      && gmailHoldsImportedHistory([gmailInternalConnectorStore, gmailSecureConnectorStore, gmailTierLane?.publicStore?.current()])) {
      gmailImportedHistory = createGmailImportedHistorySchedulerSource({ config: olympusConfig });
      sources.push(gmailImportedHistory);
    }
    // Gmail's attachment children are read by its source (live, or the one with no sync of its own).
    const gmailSourceAt = sources.findIndex((source) => source.sourceId === SCHEDULER_SOURCE_IDS.gmail);
    const attachmentRunner = gmailSourceAt >= 0 ? gmailAttachmentRuntime()?.runner : undefined;
    if (gmailSourceAt >= 0 && attachmentRunner) {
      const gmailSource = sources[gmailSourceAt]!;
      sources[gmailSourceAt] = {
        ...gmailSource,
        tasks: [...gmailSource.tasks, ...gmailAttachmentLanes(gmailItemScopeFor(currentGmailHandle)).map((lane) => fileExtractionSchedulerTask({
          id: `gmail.email_attachments.${lane.corpusId}`,
          runner: attachmentRunner,
          lane,
          planLimit: GMAIL_ATTACHMENT_EXTRACTION_PLAN_LIMIT,
          batchSize: GMAIL_ATTACHMENT_EXTRACTION_BATCH_SIZE,
        }))],
      };
    }
    // Telegram's media children are read by its source.
    const telegramSourceAt = sources.findIndex((source) => source.sourceId === SCHEDULER_SOURCE_IDS.telegram);
    const telegramMediaRunner = telegramSourceAt >= 0 ? telegramMediaRuntime()?.runner : undefined;
    if (telegramSourceAt >= 0 && telegramMediaRunner && telegramConnectorStores) {
      const telegramSource = sources[telegramSourceAt]!;
      const corpusIds = [telegramConnectorStores.internal.corpusId, telegramConnectorStores.secureLocal.corpusId];
      sources[telegramSourceAt] = {
        ...telegramSource,
        tasks: [...telegramSource.tasks, ...telegramMediaLanes(corpusIds, TELEGRAM_PERSONAL_ACCOUNT_SCOPE).map((lane) => fileExtractionSchedulerTask({
          id: `telegram.media.${lane.corpusId}`,
          runner: telegramMediaRunner,
          lane,
          planLimit: TELEGRAM_MEDIA_EXTRACTION_PLAN_LIMIT,
          batchSize: TELEGRAM_MEDIA_EXTRACTION_BATCH_SIZE,
        }))],
      };
    }
    // One embedding sweep per source that embeds, built once here from the
    // worker's own store registry: every mounted store of the source's corpora
    // (tier legs included, resolved per pass), each planned by the one
    // store-level rule whatever filled it. See withEmbeddingSweep.
    const scopeRefs = new Map<string, SourceScopePolicyRef>();
    for (const ref of [currentGmailScopeRef, currentGoogleDriveScopeRef, currentDropboxScopeRef, currentLocalFilesScopeRef]) {
      if (ref) scopeRefs.set(ref.sourceId, ref);
    }
    const sweptSources = withEmbeddingSweep(sources, (source) => {
      const corpusIds = new Set(sourceCorpusRegistry.list()
        .filter((corpus) => corpus.sourceId === source.sourceId)
        .map((corpus) => corpus.corpusId));
      corpusIds.add(source.corpusId);
      const targets = () => connectorStores.flatMap((store) => {
        if (!corpusIds.has(store.corpusId)) return [];
        const target = planStoreEmbedding({
          store,
          provider: connectorStoreEmbeddingProviders.get(store.corpusId),
          servedByMeaning: storeServedByMeaning({ store, sovereigntyEngine, sourceCorpusRegistry, fullCorpusDefinitions }),
          scope: storeEmbeddingScope({
            store,
            sourceId: source.sourceId,
            scopeRef: scopeRefs.get(source.sourceId),
            authority: fileSourceScopeAuthority,
            readScope: connectorStoreReadScope,
            gmailAccountScope: currentGmailHandle ? gmailItemScopeFor(currentGmailHandle) : undefined,
            gmailImportAccountScope: gmailItemScopeFor(currentGmailHandle),
          }),
        });
        return target ? [target] : [];
      });
      // A tier store opens on its first routed or imported item, after this
      // build: a source whose stores could embed gets its sweep up front, so
      // that first item is indexed without waiting for a rebuild. A source
      // with no store that could embed (a keyword-only lane) gets no sweep.
      const couldEmbed = sourceStoresCouldEmbed({
        corpusIds, sovereigntyEngine, sourceCorpusRegistry, fullCorpusDefinitions,
        providerFor: (trustDomain) => trustDomain === 'secure_local' ? tierSecureEmbeddingProvider : sourceIndexEmbeddingProvider,
      });
      return couldEmbed || targets().length > 0 ? targets : undefined;
    });
    // Guarded with its sweep; the watch task attached next rides on one host
    // lane but serves every source, so it stays outside any one lane's guard.
    const guardedSources = guardAccountBoundLanes(sweptSources, laneGuards);
    return {
      decisions,
      sources: sourceWatchPass
        ? attachSourceWatchSchedulerTask({
            sources: guardedSources,
            selectedSourceIds: olympusConfig.worker.scheduler.sourceIds,
            intervalMs: olympusConfig.worker.scheduler.syncIntervalSeconds * 1_000,
            pass: sourceWatchPass,
          })
        : guardedSources,
    };
  };
  const schedulerAssembly = schedulerSourcesForHandles(connectedHandles);
  const schedulerSources = schedulerAssembly.sources;
  const sourceScheduler = olympusConfig.worker.scheduler.enabled
    ? createSourceSchedulerFromConfig({
      config: olympusConfig,
      sources: schedulerSources,
      ...(sourceIndexStatus && sourceIngestionLedger
        ? {
            afterTick: async (schedulerStatus) => {
              const status = await sourceIndexStatus.status({ include_items: false });
              sourceIngestionLedger.record(buildSourceIngestionLedgerSnapshot(status, {
                schedulerStatus,
                sourceCorpusRegistry,
                safeForCastor: true,
              }));
            },
          }
        : {}),
    })
    : undefined;
  // Importing an archive from the dashboard (archive-import/dashboard.ts):
  // what the person drops is uploaded into Olympus's own storage, only the
  // dashboard's own routes approve, and every started or removed import is
  // handed to the scheduler at once. How the private model stands is read off the
  // sniffer, bound once it runs further down.
  const archiveImportDashboard = createArchiveImportDashboard({
    runtime: archiveImports,
    resolver: createArchivePathResolver(),
    refreshScheduler: () => {
      sourceScheduler?.updateSources(schedulerSourcesForHandles(
        activeLaneHandles(readActiveConnectedHandles(process.env), process.env),
      ).sources);
    },
    privateModel: () => archivePrivateModelState(),
    // Without the scheduler, or with a source list that leaves archives out,
    // nothing runs an import or a removal: approving one is refused, and one
    // already waiting says which setting under Needs you.
    scheduling: () => (sourceScheduler ? archiveImportScheduling(olympusConfig.worker.scheduler) : 'disabled'),
  });
  archiveImportDashboard.resume();
  // Built-in transcription installs only when the chosen sources contain
  // audio (each approved extraction lane checks at scheduler start, and each
  // plan pass after a sync), and once ready wakes every extraction task so
  // unread audio is read within seconds.
  wireBuiltInTranscriptionAtBoot({
    env: process.env,
    engine: process.env.OLYMPUS_TRANSCRIBE_COMMAND?.trim() ? undefined : sharedBuiltInTranscriber(process.env),
    ...(sourceScheduler ? { wake: () => { sourceScheduler.wakeTasksOfKind('extract'); } } : {}),
  });
  // Content-free latency ledger: on by default so the next "why was that answer
  // slow?" is answerable from the host. Only wired when the answer path exists.
  const sourceAnswerLatencyLogPath = sourceAnswer
    ? resolveSourceAnswerLatencyLogPath(process.env)
    : undefined;
  const sourceAnswerLatencyLog = sourceAnswerLatencyLogPath
    ? createFileSourceAnswerLatencyLog(sourceAnswerLatencyLogPath)
    : undefined;
  // The mail picker's summary costs up to ~108 Gmail requests, so one load is
  // reused for a few minutes per mailbox and draft rather than re-spent on
  // every reopen or estimate refresh.
  const mailScopeSummaryCache = new Map<string, { at: number; value: Promise<unknown> }>();
  const MAIL_SCOPE_SUMMARY_CACHE_MAX = 16;
  let gmailPickerRequestBudget: GoogleDailyRequestBudget | undefined;
  const MAIL_SCOPE_SUMMARY_TTL_MS = 10 * 60_000;
  const gmailScopeHandle = () => selectedSourceCredentialHandle({
    env: process.env,
    pinEnvName: 'OLYMPUS_SOURCE_INDEX_GMAIL_CREDENTIAL_HANDLE',
    provider: 'gmail',
    capability: 'gmail.email.sync',
    handles: readActiveConnectedHandles(process.env),
  });
  const mailScopeSummary = () => {
    const snapshot = fileSourceScopeAuthority!.mailSnapshot();
    return {
      kind: 'mail' as const,
      source_id: 'gmail.email' as const,
      disposition_source_id: 'gmail.email',
      label: 'Gmail',
      connected: snapshot.accountGeneration !== undefined,
      status: snapshot.status,
      ...(snapshot.accountGeneration ? { account_generation: snapshot.accountGeneration } : {}),
      scope_revision: snapshot.revision,
      // Approved mail always reads something (at least the window's metadata).
      ingestion_enabled: snapshot.status === 'approved',
      mail_scope: mailScopeDraftView(snapshot.mailScope),
      ...(snapshot.mailScope?.contentAfter ? { content_after: snapshot.mailScope.contentAfter } : {}),
      ...(snapshot.reason === 'malformed'
        ? { error: 'Saved mail scope is unreadable. Review and save the scope again.' }
        : {}),
    };
  };
  // The credential a registered file source reads, or none for a source that
  // binds to this computer instead of an account. Function declarations, so
  // they are hoisted: the connector-store read scope (assembled with the
  // scheduler, earlier in main) calls them before this point is reached.
  function fileScopeCredentialHandle(definition: FileScopeSourceDefinition): ConnectedCredentialHandle | undefined {
    return definition.account === 'this_computer'
      ? undefined
      : selectedSourceCredentialHandle({
          env: process.env,
          pinEnvName: definition.pinEnvName ?? '',
          provider: definition.provider as ConnectedCredentialHandle['provider'],
          capability: definition.credentialCapability!,
          handles: readActiveConnectedHandles(process.env),
        });
  }
  function fileScopeAccount(sourceId: string): { accountScope: string } | undefined {
    const definition = getFileScopeSource(sourceId);
    if (!definition) return undefined;
    if (definition.account === 'this_computer') return { accountScope: 'this_computer' };
    const handle = fileScopeCredentialHandle(definition);
    return handle ? { accountScope: handle.accountRole?.trim() || 'personal' } : undefined;
  }
  const fileScopeBrowserFor = (sourceId: string): SourceFolderScopeBrowser => {
    const definition = requireFileScopeSource(sourceId);
    const handle = fileScopeCredentialHandle(definition);
    if (definition.account !== 'this_computer' && !handle) {
      throw new OperationError('source_index_policy_violation', 'The connected source credential is unavailable.');
    }
    return createFileScopeBrowser(sourceId, {
      ...(handle ? { credentialHandle: handle.handle } : {}),
      ...(handle?.accountRole ? { account: handle.accountRole } : {}),
      ...(googleDriveRequestBudget ? { googleDriveRequestBudget } : {}),
    });
  };
  const fileSourceScopes = fileSourceScopeAuthority ? {
    summaries: () => [...listFileScopeSources().map(({ sourceId, dispositionSourceId, label }) => {
      const snapshot = fileSourceScopeAuthority.snapshot(sourceId);
      return {
        kind: 'folders' as const,
        source_id: sourceId,
        disposition_source_id: dispositionSourceId,
        label,
        connected: snapshot.accountGeneration !== undefined,
        status: snapshot.status,
        ...(snapshot.accountGeneration ? { account_generation: snapshot.accountGeneration } : {}),
        scope_revision: snapshot.revision,
        selections: snapshot.selections.map((selection) => ({
          key: selection.key,
          state: selection.state,
          ...(selection.ancestorKeys ? { ancestor_keys: selection.ancestorKeys } : {}),
        })),
        whole_account_selected: snapshot.wholeAccount,
        ...(snapshot.reason === 'malformed'
          ? { error: 'Saved scope state is unreadable. Review and save the scope again.' }
          : {}),
      };
    }), mailScopeSummary()],
    /**
     * The mail picker's data: labels, categories, sender suggestions and the
     * estimate for `draft`. Refused unless the mailbox is connected; reads no
     * message body and changes no state.
     */
    browseMail: async (input: { draft: OlympusMailScopeDraft }) => {
      const before = fileSourceScopeAuthority.mailSnapshot();
      const accountGeneration = before.accountGeneration;
      if (!accountGeneration) {
        throw new OperationError('source_index_policy_violation', 'Connect Gmail before choosing which mail Olympus may use.');
      }
      const handle = gmailScopeHandle();
      if (!handle) throw new OperationError('source_index_policy_violation', 'The connected Gmail credential is unavailable.');
      const scope = mailScopeFromDraft(input.draft);
      const key = JSON.stringify([accountGeneration, scope, process.env.OLYMPUS_SOURCE_INDEX_GMAIL_QUERY ?? '']);
      const now = Date.now();
      // Expired entries are evicted on every load, and the map is capped, so
      // a long-running worker never accumulates stale mailbox summaries.
      for (const [entryKey, entry] of mailScopeSummaryCache) {
        if (now - entry.at > MAIL_SCOPE_SUMMARY_TTL_MS) mailScopeSummaryCache.delete(entryKey);
      }
      while (mailScopeSummaryCache.size >= MAIL_SCOPE_SUMMARY_CACHE_MAX) {
        const oldest = mailScopeSummaryCache.keys().next().value;
        if (oldest === undefined) break;
        mailScopeSummaryCache.delete(oldest);
      }
      const cached = mailScopeSummaryCache.get(key);
      if (!cached) {
        const operatorQuery = process.env.OLYMPUS_SOURCE_INDEX_GMAIL_QUERY?.trim();
        gmailPickerRequestBudget ??= createGmailPickerRequestBudget({
          laneStatePath: defaultGmailRequestBudgetStatePath(process.env),
        });
        const value = createGmailMailScopeBrowser({
          credentialHandle: handle.handle,
          ...(handle.accountRole ? { account: handle.accountRole } : {}),
          requestBudget: gmailPickerRequestBudget,
        }).summarize({
          scope,
          ...(operatorQuery ? { operatorQuery } : {}),
        });
        // A failed load is never cached; the next open retries.
        value.catch(() => mailScopeSummaryCache.delete(key));
        mailScopeSummaryCache.set(key, { at: now, value });
      }
      let summary: unknown;
      try {
        summary = await mailScopeSummaryCache.get(key)!.value;
      } catch (error) {
        if (error instanceof GoogleRequestBudgetError) {
          throw new OperationError(
            'source_index_policy_violation',
            'The mail picker has used today\'s Gmail request allowance, which is kept separate from syncing. Try again after midnight UTC.',
          );
        }
        throw error;
      }
      const after = fileSourceScopeAuthority.mailSnapshot();
      if (after.accountGeneration !== accountGeneration || after.revision !== before.revision) {
        throw new OperationError('source_index_policy_violation', 'The mailbox or saved mail scope changed while it was being read. Reload the picker.');
      }
      return {
        ok: true,
        kind: 'mail_scope_browse',
        source_id: 'gmail.email',
        account_generation: accountGeneration,
        scope_revision: before.revision,
        status: before.status,
        draft: mailScopeDraftView(scope),
        window_labels: MAIL_SCOPE_WINDOW_LABELS,
        summary,
      };
    },
    approveMailAndStart: async (input: {
      accountGeneration: string;
      expectedRevision: string;
      draft: OlympusMailScopeDraft;
    }) => {
      const approval = fileSourceScopeAuthority.approveMail({
        accountGeneration: input.accountGeneration,
        expectedRevision: input.expectedRevision,
        scope: mailScopeFromDraft(input.draft),
      });
      let started = false;
      if (sourceScheduler) {
        sourceScheduler.updateSources(schedulerSourcesForHandles(readActiveConnectedHandles(process.env)).sources);
        if (sourceScheduler.status().sources.some((source) => source.source_id === 'gmail.email')) {
          startApprovedSourceRun(sourceScheduler, 'gmail.email');
          started = true;
        }
      }
      return {
        ok: true,
        kind: 'mail_source_scope_approved',
        source_id: 'gmail.email',
        status: approval.status,
        scope_revision: approval.revision,
        ...(approval.mailScope?.contentAfter ? { content_after: approval.mailScope.contentAfter } : {}),
        owner_tier_rules: approval.ownerTierRules?.length ?? 0,
        ingestion_started: started,
      };
    },
    browse: async (input: {
      sourceId: string;
      parentKey?: string;
      cursor?: string;
    }) => {
      const before = fileSourceScopeAuthority.snapshot(input.sourceId);
      const accountGeneration = before.accountGeneration;
      if (!accountGeneration) {
        throw new OperationError('source_index_policy_violation', 'Connect this source before browsing folders.');
      }
      const browser = fileScopeBrowserFor(input.sourceId);
      const page = await browser.browse({
        ...(input.parentKey ? { parentKey: input.parentKey } : {}),
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      const after = fileSourceScopeAuthority.snapshot(input.sourceId);
      if (after.accountGeneration !== accountGeneration || after.revision !== before.revision) {
        throw new OperationError(
          'source_index_policy_violation',
          'The account or saved scope changed while folders were being listed. Reload the picker.',
        );
      }
      return {
        source_id: input.sourceId,
        account_generation: accountGeneration,
        scope_revision: before.revision,
        status: before.status,
        nodes: page.nodes,
        ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
        ...(page.access ? { access: page.access } : {}),
        selections: before.selections.map((selection) => ({
          key: selection.key,
          state: selection.state,
          ...(selection.ancestorKeys ? { ancestor_keys: selection.ancestorKeys } : {}),
        })),
        whole_account_selected: before.wholeAccount,
      };
    },
    approveAndStart: async (input: {
      sourceId: string;
      accountGeneration: string;
      expectedRevision: string;
      selections: Array<{ key: string; state: 'ingest' | 'metadata_only' | 'exclude'; ancestor_keys?: string[] }>;
      wholeAccount: boolean;
      explicitWholeAccountConfirmation: boolean;
    }) => {
      const definition = requireFileScopeSource(input.sourceId);
      const selections = input.selections.map((selection) => ({
        key: definition.normalizeKey(selection.key),
        state: selection.state,
      }));
      const browser = fileScopeBrowserFor(input.sourceId);
      try {
        browser.checkApproval?.({ selections, wholeAccount: input.wholeAccount });
      } catch (error) {
        // A choice the computer cannot read yet: a refusal with its own code, so the picker says why instead of "try again".
        throw new EmailSourceWorkerError(409, 'folder_needs_helper', error instanceof Error ? error.message : String(error));
      }
      const verifiedSelections = await browser.validateSelections(selections);
      const approval = fileSourceScopeAuthority.approve({
        sourceId: input.sourceId,
        accountGeneration: input.accountGeneration,
        expectedRevision: input.expectedRevision,
        selections: verifiedSelections,
        wholeAccount: input.wholeAccount,
        explicitWholeAccountConfirmation: input.explicitWholeAccountConfirmation,
      });
      if (approval.replayed !== true && browser.afterApproval) {
        // Best effort: the choice is saved either way.
        try { await browser.afterApproval({ wholeAccount: input.wholeAccount }); } catch { /* nothing to undo */ }
      }
      let invalidatedJobs = 0;
      // A replayed save (the same request delivered twice) changed nothing:
      // re-invalidating would cancel the jobs its first delivery just queued.
      if (fileExtractionRuntime && approval.replayed !== true) {
        invalidatedJobs = definition.corpusIdsToInvalidate.reduce(
          (total, corpusId) => total + fileExtractionRuntime.jobs.invalidateUnsettledForCorpus(corpusId),
          0,
        );
      }
      let started = false;
      if (sourceScheduler) {
        sourceScheduler.updateSources(schedulerSourcesForHandles(readActiveConnectedHandles(process.env)).sources);
        if (fileSourceScopeMetadataEnabled(approval)
          && sourceScheduler.status().sources.some((source) => source.source_id === input.sourceId)) {
          if (approval.replayed !== true) startApprovedSourceRun(sourceScheduler, input.sourceId);
          started = true;
        }
      }
      return {
        ok: true,
        kind: 'file_source_scope_approved',
        source_id: input.sourceId,
        status: approval.status,
        scope_revision: approval.revision,
        ingestion_started: started,
        invalidated_queued_jobs: invalidatedJobs,
      };
    },
  } : undefined;
  // Assigned once the remote agent routes are built below, so the Setup
  // page's agent panel reads the very store handle `/mcp` and OAuth use.
  let dashboardAgentStore: DashboardAgentConnectionsBackend['store'] | undefined;
  let dashboardRemoteAccess: DashboardAgentConnectionsBackend['remoteAccess'] = () => ({ state: 'off' });
  let dashboardRemoteAccessControl: DashboardAgentConnectionsBackend['remoteAccessControl'];
  // Where a sign-in started from ChatGPT returns (the relay's origin and this
  // install's id); assigned once the relay URL source exists below.
  let chatgptOAuthHandback: () => { origin: string; installId: string } | undefined = () => undefined;
  // Built further down, once the ChatGPT surface exists; the worker only
  // calls it per request.
  let dashboardPanelTools: DashboardPanelTools | undefined;
  // Private answers on this computer (local-private-answers.ts); built below,
  // beside the waiting-question store and the built-in model.
  let localPrivateAnswers: import('./local-private-answers.ts').LocalPrivateAnswers | undefined;
  let desktopBridge: ReturnType<typeof manageLinuxOwnerBridge> | ReturnType<typeof connectLinuxOwnerBridgeHost> | undefined;
  closeDesktopBridge = () => desktopBridge?.close();
  let desktopPoll: ReturnType<typeof setInterval> | undefined;
  let desktopPollingClosed = false;
  const agentApprovalHost = () => resolveAgentApprovalHost({ env: process.env, fileEnv: readWorkerSetupEnv(), port, desktopBridgeReady: () => desktopBridge?.status().state === 'listening' });
  const updateChecker = createUpdateChecker({
    runningVersion: runningOlympusVersion(), platform: process.platform,
    env: process.env, fileEnv: () => readWorkerSetupEnv(),
  });
  const worker = createEmailSourceWorker({
    updateAvailable: () => updateChecker.available(),
    ...(process.platform === 'linux' ? { localModelReadiness: () => linuxModelReadiness(process.env) } : {}),
    agentConnectHost: agentApprovalHost,
    agentConnections: {
      store: (options) => dashboardAgentStore?.(options),
      ...(process.platform === 'linux' ? { relayInstallId: () => remotePublicUrls()?.installId } : {}),
      remoteAccess: () => dashboardRemoteAccess(),
      get remoteAccessControl() { return dashboardRemoteAccessControl; },
    },
    ...(connector ? { connector } : {}),
    ...(sourceAnswer ? { sourceAnswer } : {}),
    sourceAnswerReleaseCheck: createReleaseTierCheck(
      tierScopes,
      () => secureDerivativeDefault ?? 'allow',
    ),
    // Asking for an import or a removal, and reading the list: nothing else (archive-import/agent.ts).
    archiveImportAgent: archiveImportDashboard.agent,
    // Bound late: the consult block below sets askAnonymouslyNow.
    consultAsk: async ({ caller, ...input }, signal) => (askAnonymouslyNow
      ? askWithAnonymousInbox({ ...input, ...(caller?.provider ? { callerProvider: caller.provider } : {}), signal }, {
        store: waitingQuestionStore, connectionId: anonymousInboxConnectionId(caller), isActive: connectionActive, ask: askAnonymouslyNow,
      })
      : Promise.resolve({ ok: false as const, code: 'ask_unavailable', message: 'Asking anonymously is not available in this worker.' })),
    ...(sourceAnswerLatencyLog ? { sourceAnswerLatencyLog } : {}),
    ...(sourceIndexStatus ? { sourceIndexStatus } : {}),
    ...(unreadableFiles
      ? {
          unreadableFileNames: (corpusIds: readonly string[], limit: number) => unreadableFiles.names(corpusIds, limit),
          unreadableRecheck: (corpusId: string) => unreadableFiles.recheck(corpusId),
        }
      : {}),
    currentReadwiseSync,
    currentXBookmarksRuntime,
    dropboxIngestionPolicy,
    ...(sourceIndexEmbeddingProvider ? { sourceIndexEmbeddingProvider } : {}),
    ...(fileExtractionRuntime ? { fileExtraction: fileExtractionRuntime.runner } : {}),
    ...(fileExtractionRuntime
      ? {
          pdfExtractionLanes: () => pdfExtractionLanes(fileExtractionCorpora, fileExtractionRuntime.corpusIds),
          pdfExtractionLaneScopeApproved: (lane: { provider: string }) => {
            try {
              assertFileSourceScopeCurrent(lane.provider);
              return true;
            } catch (error) {
              if (error instanceof OperationError && error.code === 'source_index_policy_violation') return false;
              throw error;
            }
          },
        }
      : {}),
    ...(connectorStores.length > 0 ? { connectorStores } : {}),
    ...(tierLanes.length > 0
      ? {
          connectorStoreTierSiblings: (corpusId: string) => [
            ...(tierLanes.find((lane) => lane.corpusIds.has(corpusId))?.corpusIds ?? []),
          ].filter((sibling) => sibling !== corpusId),
          sourceIndexVisibilityGate: tierVisibilityGate,
          secretLocationSearch: tierSecretLocations,
        }
      : {}),
    ...(connectorStoreEmbeddingProviders.size > 0 ? { connectorStoreEmbeddingProviders } : {}),
    ...(connectorStoreAccountScopes.size > 0 ? { connectorStoreAccountScopes } : {}),
    ...(connectorStorePrincipals.size > 0 ? { connectorStorePrincipals } : {}),
    connectorStoreReadScope,
    ...(sourceScheduler ? { sourceScheduler } : {}),
    ...(sourceWatchPass
      ? {
          sourceWatch: {
            store: sourceWatchStore,
          },
        }
      : {}),
    ...(sourceIndexReadEnabled
      ? {
          sourceDashboard: {
            sovereigntyEngine,
            modelSetup: getModelSetup,
            checkModelSetup: () => modelSetup.checkLocalModels(),
            connectModelKey,
            // The panel's tools on the computer; bound late (set up further
            // down; called only per request).
            panelTools: {
              allows: (name) => dashboardPanelTools?.allows(name) === true,
              call: (name, args, context) => {
                if (!dashboardPanelTools) throw new Error('dashboard panel tools are not ready');
                return dashboardPanelTools.call(name, args, context);
              },
            },
            // Private answers on this computer; bound late like the panel's tools.
            ...(sourceAnswerLanes
              ? {
                  privateAnswers: {
                    destinations: () => localPrivateAnswers?.destinations() ?? { computer: 'not_set_up', venice: 'not_set_up' },
                    waiting: () => localPrivateAnswers?.waiting(),
                    waitingCount: () => localPrivateAnswers?.waitingCount() ?? 0,
                    handle: (body, session) => (localPrivateAnswers
                      ? localPrivateAnswers.handle(body, session)
                      : Promise.resolve({ status: 503, body: { ok: false, error: { code: 'unavailable', message: 'Olympus is still starting. Try again in a moment.' } } })),
                  },
                }
              : {}),
            // Outside help (consults): the Mac dashboard card's backend, the
            // one caller of the settings writer; bound late like the panel's tools.
            consult: {
              status: () => dashboardConsult.status(),
              setEnabled: (update) => dashboardConsult.setEnabled(update),
              saveRoute: (update) => dashboardConsult.saveRoute(update),
              addRoute: (update) => dashboardConsult.addRoute(update),
              recover: (update) => dashboardConsult.recover(update),
              abandon: (update) => dashboardConsult.abandon(update),
              installTools: (update) => dashboardConsult.installTools(update),
              saveWriter: (update) => dashboardConsult.saveWriter(update),
              testWriter: (update) => dashboardConsult.testWriter(update),
              saveStandard: (update) => dashboardConsult.saveStandard(update),
            },
            stopMessagingCapture,
            captureRuntime: dashboardCaptureRuntime,
            // Delete indexed data: the same supervised restart a model-key
            // change uses. `canRestart` has no side effect, so the route can
            // check it before deleting anything.
            workerRestart: {
              canRestart: () => modelReloadInstalled && workerRestartsItself(workerLaunch, process.env),
              request: (reload) => requestModelReload(reload),
            },
            corpusRegistry: sourceCorpusRegistry,
            registryPath: handleRegistryPathFromEnv(process.env, true)!,
            ...(sourceDashboardHistory ? { history: sourceDashboardHistory } : {}),
            ingestionDispositions: () => openIngestionDispositionsRuntime(process.env),
            oauthHandback: () => chatgptOAuthHandback(),
            loopbackPort: port,
            ...(fileSourceScopes ? { fileSourceScopes } : {}),
            archiveImports: archiveImportDashboard,
            livePasses: () => {
              const pass = evernote.dashboardPass();
              return pass ? { 'evernote.notes': pass } : {};
            },
            enforceConnectedSourceReads: true,
            // The filter applies to the override too. An override is a caller
            // saying which handles changed, never a claim that an unpaired
            // source may start reading again — and routing it around the check
            // is exactly how an outstanding obligation honoured at boot got
            // bypassed on the next unrelated registry change.
            refreshSchedulerSources: (connectedHandlesOverride) => schedulerSourcesForHandles(
              activeLaneHandles(connectedHandlesOverride ?? readActiveConnectedHandles(process.env), process.env),
            ).sources,
            // The hook below is the Dropbox lane and nothing else; every other
            // source reaches it only to be refused. Saying so keeps a Sync now
            // button off the cards it could only 501 for.
            triggerSourceSyncSources: ['dropbox'],
            triggerSourceSync: async (request) => {
              // This hook is the Dropbox lane only. Every other source reaches
              // it after its own dispatch paths declined, so the honest answer
              // is the typed 501 the route already speaks — not a bare Error
              // the generic handler would report as a 500 worker crash.
              if (request.source !== 'dropbox') {
                throw dashboardSourceSyncNotSupportedError(request.source);
              }
              const source = schedulerSourcesForHandles(activeLaneHandles(
                readActiveConnectedHandles(process.env),
                process.env,
              )).sources.find((candidate) => candidate.sourceId === SCHEDULER_SOURCE_IDS.dropbox);
              if (!source) throw new Error('Dropbox sync is not configured.');
              const tasks = [];
              for (const task of source.tasks) {
                tasks.push({ id: task.id, result: await task.run() });
              }
              return {
                kind: 'dashboard_source_sync',
                source: request.source,
                tasks,
                policy: {
                  raw_source_exposed: false,
                  source_text_returned: false,
                  counts_only: true,
                },
              };
            },
          },
    }
      : {}),
    credentialDegradations: () => bootSecretResolver.status(),
    credentialReadiness: () => bootSecretResolver.readiness(),
    ...(process.env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID?.trim()
      ? { serviceInstanceId: process.env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID.trim() }
      : {}),
    recheckCredentials: () => bootSecretResolver.recheckNow(),
  });
  warnIfWorkerAuthDisabled('private email source worker', authToken, hostname);
  // Loaded here rather than at module scope: other bundles import helpers from
  // this module (the embedding drain), and the MCP SDK is not tree-shakeable.
  const {
    createInProcessOperationContext,
    createRemoteMcpHandler,
    lazyRemoteConnectionStore,
    withRemoteFailureBoundary,
    withRemoteMcpRoute,
  } = await import('../remote-mcp.ts');
  const { resolveRemoteConnectionsDbPath, openRemoteConnectionStore } = await import('../../core/remote-connections.ts');
  const { resolveRemotePublicUrls } = await import('../../core/remote-public-url.ts');
  const { carriesRelayMarker, createRemotePublicUrlSource, isRelayedRequest } = await import('../../core/remote-access.ts');
  const { withRequestPeer } = await import('../../core/request-peer.ts');
  const { createRelaySurfacesHandler, withRelaySurfacesRoute } = await import('../relay-surfaces.ts');
  const { isChatGptGrant } = await import('../remote-oauth/pinned-clients.ts');
  const { isDemoGrant } = await import('../remote-oauth/demo-consent.ts');
  const { createRemoteOAuthHandler, withRemoteOAuthRoutes } = await import('../remote-oauth/handler.ts');
  const { resolveDemoConsent } = await import('../remote-oauth/demo-consent.ts');
  // OAuth for hosted agents is on only with a public base URL: a manual
  // OLYMPUS_PUBLIC_BASE_URL (fixed for this process), else what the relay
  // service reports in status.json, followed live without a restart.
  const remotePublic = resolveRemotePublicUrls(process.env);
  if (!remotePublic.enabled && remotePublic.reason === 'invalid') {
    console.warn(`[olympus] remote agent OAuth is off: ${remotePublic.detail ?? 'invalid public base URL'}`);
  }
  const remotePublicSource = createRemotePublicUrlSource(process.env);
  const remotePublicUrls = () => remotePublicSource.current();
  chatgptOAuthHandback = () => {
    const urls = remotePublicUrls();
    return urls?.installId ? { origin: urls.origin, installId: urls.installId } : undefined;
  };
  const remoteConnections = lazyRemoteConnectionStore(
    () => resolveRemoteConnectionsDbPath(process.env),
    openRemoteConnectionStore,
  );
  dashboardAgentStore = remoteConnections;
  // Questions waiting on a Private answer (core/waiting-private-questions.ts):
  // beside the connection store, owner-only, opened on first use (retried a
  // minute after a failed open). The connection store is the authority on
  // which connections are active: a recording for any other is refused, and
  // records of a connection revoked while this worker was down, or whose
  // revoking process could not clean up, are dropped on open and on every
  // re-check pass.
  const { openWaitingPrivateQuestionStore, waitingPrivateQuestionsDbPath } = await import('../../core/waiting-private-questions.ts');
  const connectionActive = (connectionId: string): boolean => {
    if (connectionId.startsWith('@local:')) return true;
    const connections = remoteConnections();
    if (!connections) throw new Error('remote connection store unavailable');
    return connections.list().some((connection) => connection.id === connectionId && connection.revokedAt === null);
  };
  let waitingStore: import('../../core/waiting-private-questions.ts').WaitingQuestionStore | undefined;
  let waitingStoreRetryAt = 0;
  let waitingStoreClosed = false;
  const waitingQuestionStore = () => {
    if (waitingStore || waitingStoreClosed || Date.now() < waitingStoreRetryAt) return waitingStore;
    try {
      const store = openWaitingPrivateQuestionStore(
        waitingPrivateQuestionsDbPath(resolveRemoteConnectionsDbPath(process.env)),
        { isActive: connectionActive },
      );
      try {
        store.reconcileConnections(connectionActive);
      } catch {
        // Retried on the next re-check pass.
      }
      waitingStore = store;
    } catch {
      waitingStoreRetryAt = Date.now() + 60_000;
      console.warn('[olympus] waiting private questions store unavailable');
    }
    return waitingStore;
  };
  // The panel's remote-access line: the address this worker serves right now,
  // explained by the relay status `olympus connections status` prints.
  const { demoInstallMarked, readRemoteAccessStatus, remoteAccessDir, remoteAccessStatusView, resolveRemoteAccessUrls } = await import('../../core/remote-access.ts');
  // Which commands the owner is told to run: the standalone engine's
  // LaunchAgent sets OLYMPUS_ENGINE_HOST=1 (engine-service.ts); otherwise the
  // OpenClaw Gateway runs this worker.
  const remoteAccessHostKind: 'openclaw' | 'standalone' = process.env.OLYMPUS_ENGINE_HOST === '1' ? 'standalone' : 'openclaw';
  dashboardRemoteAccess = () => {
    let status: ReturnType<typeof remoteAccessStatusView> | undefined;
    try {
      const dir = remoteAccessDir(process.env);
      const file = readRemoteAccessStatus(dir);
      status = remoteAccessStatusView({
        status: file,
        hostKind: remoteAccessHostKind,
        urls: resolveRemoteAccessUrls({ layeredEnv: process.env, env: process.env, status: file, configuredWorkerBaseUrl: olympusConfig.email.baseUrl }),
      });
    } catch {
      status = undefined;
    }
    return remoteAccessFromStatus({ live: remotePublicUrls(), status, liveOrigin: remotePublicSource.origin });
  };
  // Turn on / Turn off remote access: the config change through the host's
  // own config write.
  if (authToken) {
    // Under OpenClaw the Gateway writes. The standalone engine has no
    // config writer yet: the panel says how to change engine.json instead of
    // offering a button that could only be refused.
    dashboardRemoteAccessControl = remoteAccessHostKind === 'standalone'
      ? { manual: (enabled: boolean) => `To turn remote access ${enabled ? 'on' : 'off'}, set "remote": {"enabled": ${enabled}} in ~/.olympus/engine.json, then run: olympus engine restart` }
      : createDashboardRemoteAccessControl({ setEnabled: createGatewayRemoteAccessConfigWriter({ authToken, env: process.env }) });
  }
  // A background connection: a live remote agent that is not ChatGPT (the
  // owner's ChatGPT is the owner's own work). An unknown id is not one.
  function isBackgroundConnection(connectionId: string | undefined): boolean {
    if (!connectionId) return false;
    try {
      const record = remoteConnections()?.list().find((connection) => connection.id === connectionId);
      return record !== undefined && !isChatGptGrant(record);
    } catch {
      return false;
    }
  }
  // Slow source_answer calls from remote agents hand off to in-memory jobs
  // bound to the connection; see core/source-answer-jobs.ts.
  const { SourceAnswerJobRegistry, sourceAnswerJobLimitsFromEnv } = await import('../../core/source-answer-jobs.ts');
  const sourceAnswerJobs = new SourceAnswerJobRegistry({
    limits: sourceAnswerJobLimitsFromEnv(process.env, 'remote'),
    // A revoked connection's jobs are aborted and dropped. Revocation can come
    // from the CLI (another process), so the store is the authority.
    isOwnerRevoked: (owner) => {
      if (!owner.startsWith('remote:')) return false;
      const id = owner.slice('remote:'.length);
      const record = remoteConnections()?.list().find((connection) => connection.id === id);
      return record === undefined || record.revokedAt !== null;
    },
    // Remote agents that are not ChatGPT wait behind the owner's own answers,
    // one running per connection, in a small fair queue
    // (docs/design/background-agents.md section E).
    priority: {
      isBackground: (owner) => owner.startsWith('remote:') && isBackgroundConnection(owner.slice('remote:'.length)),
      interactive: {
        busy: () => answerActivity.interactiveInFlight > 0,
        onIdle: (listener) => answerActivity.onInteractiveIdle(listener),
      },
    },
  });
  const sourceAnswerJobSweep = setInterval(() => sourceAnswerJobs.sweep(), 30_000);
  sourceAnswerJobSweep.unref?.();
  // One-time private answers for ChatGPT's private answer panel
  // (docs/design/chatgpt-plugin.md, "Private answer panel"), answered by the
  // built-in private model. Without it on this machine every private match
  // reports `no_model` with counts only.
  const { PrivateAnswerJobs, createPrivateAnswerHandler, withPrivateAnswerRoute } = await import('../chatgpt/private-answer-jobs.ts');
  const { readConsultSettings, DEFAULT_CONSULT_SETTINGS, consultStandardBinding } = await import('../../core/consult-settings.ts');
  const { PrivateQuestionJobs } = await import('../chatgpt/private-question-jobs.ts');
  const { consultAskLevelFromSettings, consultAskLevelOrSaved } = await import('../../core/consult-ask.ts');
  const { createBuiltInPrivateAnswerModel, embeddingPanelRelevance } = await import('../chatgpt/private-answer-model.ts');
  const { DASHBOARD_UI_DOMAIN } = await import('../chatgpt/dashboard-resource.ts');
  const { createDropboxOpenTargets, localDropboxRoots } = await import('../dropbox-files/open-target.ts');
  // Where each cited source opens, by the connector that holds it: the
  // provider's own resolver turns the item's locator into a web address and,
  // when the file is synced to this Mac, its local path (kept here; the
  // panel gets a one-time open token for it).
  const sourceOpenTargets: Record<string, (locator: string) => { url?: string; localPath?: string } | undefined> = {
    dropbox: createDropboxOpenTargets(),
    [LOCAL_FILES_PROVIDER]: localFilesOpenTarget,
  };
  // Whether each Private item may be read by a model right now, from live
  // store, ledger and scope state: asked before every model submission and
  // before an answer is sealed. Without the answer lanes nothing is eligible.
  const privateEvidenceEligible = async (items: readonly Readonly<Record<string, unknown>>[]) => (sourceAnswerLanes
    ? checkPrivateEvidenceItems({ lanes: sourceAnswerLanes, items })
    : items.map(() => false));
  // "Open on this Mac" for a cited file: macOS `open`, on a path this engine
  // resolved for a cited source (never a path from the request), checked
  // again now: no symlink, still inside a Dropbox folder, and only a
  // document type opens; anything else is revealed in Finder.
  const openCitedFile = process.platform === 'darwin' || process.platform === 'linux'
    ? (path: string, eligible: () => Promise<boolean>) =>
        openLocalFile(path, eligible, [...localDropboxRoots(), ...localFilesOpenableRoots()])
    : undefined;
  const privateAnswerModel = createBuiltInPrivateAnswerModel({
    model: answerBuiltInModel,
    eligible: privateEvidenceEligible,
    available: () => workerBuiltInModel?.available() ?? false,
    answer: answerPrivately,
    // The panel reads its few most relevant items, ranked by the Private
    // corpora's own embedding model when it runs on this computer.
    relevance: embeddingPanelRelevance(() => (
      secureLocalPolicyEmbeddingProvider?.backend === 'local' ? secureLocalPolicyEmbeddingProvider : undefined
    )),
    // An item that clearly leads is read again, in depth, from its own store.
    ...(sourceAnswerLanes
      ? { readItem: (item, request) => readPrivateEvidenceItem({ lanes: sourceAnswerLanes!, item, ...request }) }
      : {}),
    sourceLinks: (item) => {
      const provenance = item.provenance as { sourceItem?: { provider?: unknown }; citation?: { uri?: unknown } } | undefined;
      const provider = provenance?.sourceItem?.provider;
      const locator = provenance?.citation?.uri;
      if (typeof provider !== 'string' || typeof locator !== 'string') return undefined;
      return Object.hasOwn(sourceOpenTargets, provider) ? sourceOpenTargets[provider]!(locator) : undefined;
    },
  });
  // "Ask anonymously" (the ask_anonymously agent tool: the only way a
  // question goes to zkAPI), wired inside the consult block below.
  let askAnonymouslyNow: ((input: import('../../core/consult-ask.ts').ConsultAskInput) => Promise<import('../../core/consult-ask.ts').ConsultAskResult>) | undefined;
  const localAnonymousAsk = (input: import('../../core/consult-ask.ts').ConsultAskInput) => {
    return askWithAnonymousInbox({ ...input, level: consultAskLevelOrSaved(input.level, readConsultSettings()) }, {
      store: waitingQuestionStore, connectionId: '@local:You', isActive: connectionActive,
      ask: request => askAnonymouslyNow ? askAnonymouslyNow(request) : Promise.resolve({ ok: false, code: 'transport_unavailable', message: PRIVATE_ANSWERS_COPY.anonymousNotSetUp }),
    });
  };
  // The zkAPI route's daily limit (a demo grant's private questions need one set), wired inside the consult block below.
  let zkapiDailyLimitNow: (() => import('../../core/consult-transport-zkapi.ts').ZkapiDailyLimitState) | undefined;
  // The last time the ChatGPT model was missing from the live zkAPI listing (for the card); cleared by a reply.
  let chatgptModelProblem: { at: string; message: string } | undefined;
  const privateAnswers = new PrivateAnswerJobs({
    model: () => privateAnswerModel,
    eligible: privateEvidenceEligible,
    installId: () => remotePublicUrls()?.installId,
    // While an analysis runs (from the search) and from a claim to
    // ready/failed, the sniffer stays off the shared model.
    activity: answerActivity,
    // The panel's seen ack clears the waiting question it answered (same
    // id, generation and connection; a re-asked question survives).
    acknowledge: (ref) => {
      const store = waitingQuestionStore();
      if (!store) return false;
      store.acknowledge(ref);
      const remaining = store.get(ref.id);
      // Missing/advanced means the old generation has no debt. A newer
      // duplicate is never deleted by an older panel acknowledgment.
      return !remaining || remaining.generation !== ref.generation || remaining.connectionId !== ref.connectionId;
    },
    ...(openCitedFile ? { openFile: openCitedFile } : {}),
  });
  // The same ledgers and the same derivative posture the answer handler
  // uses, read when a remote agent collects an answer: an item the answer
  // read that was reclassified since it was written is caught there.
  const remoteReleaseCheck = createReleaseTierCheck(
    tierScopes,
    () => secureDerivativeDefault ?? 'allow',
  );
  // Private answers on this computer (design background-agents.md, section
  // B): Ask privately, and Answer on a question waiting here. Planning none,
  // retrieval through the same scoped adapters with only the built-in
  // embedding model, synthesis by the built-in model; no connector query, no
  // cloud route, and never zkAPI.
  if (sourceAnswerLanes) {
    const { createLocalAnswerPath, createLocalPrivateAnswers } = await import('./local-private-answers.ts');
    const { privateVeniceMembers, createVeniceInboxAnswer } = await import('./venice-inbox-answer.ts');
    const { DASHBOARD_SUPPORTED_SOURCES } = await import('../source-dashboard.ts');
    // "Left out: Gmail": a corpus named by the dashboard card it belongs to.
    const sourceName = (corpusId: string): string | undefined => {
      const sourceId = sourceCorpusRegistry.list().find((corpus) => corpus.corpusId === corpusId)?.sourceId;
      if (!sourceId) return undefined;
      return DASHBOARD_SUPPORTED_SOURCES.find((source) => source.corpus_source_ids.includes(sourceId))?.label;
    };
    const local = createLocalAnswerPath({
      releaseCheck: remoteReleaseCheck,
      lanes: sourceAnswerLanes,
      model: answerBuiltInModel,
      available: () => workerBuiltInModel?.available() ?? false,
      relevanceEmbedding: () => builtInEmbeddingOnly(secureLocalPolicyEmbeddingProvider ?? sourceIndexEmbeddingProvider, loadedBuiltInEmbedding),
      sourceLinks: (item) => {
        const provenance = item.provenance as { sourceItem?: { provider?: unknown }; citation?: { uri?: unknown } } | undefined;
        const provider = provenance?.sourceItem?.provider;
        const locator = provenance?.citation?.uri;
        if (typeof provider !== 'string' || typeof locator !== 'string') return undefined;
        return Object.hasOwn(sourceOpenTargets, provider) ? sourceOpenTargets[provider]!(locator) : undefined;
      },
      sourceName,
    });
    const destinations = (): import('./venice-inbox-answer.ts').AskDestinationStates => {
      let venice: import('./venice-inbox-answer.ts').AskDestinationState = 'not_allowed';
      try {
        const members = privateVeniceMembers(loadSourceWorkerSovereignty(olympusConfig, process.env));
        const bootMembers = privateVeniceMembers(sovereigntyEngine);
        if (members.length) {
          venice = members.length === bootMembers.length && members.every(member => bootMembers.some(boot => boot.id === member.id && JSON.stringify(boot.profile) === JSON.stringify(member.profile)) && modelCredentialState(member.id, member.profile) === 'ready') && sourceAnswer ? 'ready' : 'not_set_up';
        } else {
          // A saved key does not grant permission for Private: policy stays explicit.
          const storedEnv = { ...process.env, ...(readWorkerSetupEnv() ?? {}) };
          venice = safeModelCredential({ provider: 'venice', trust: 'encrypted_cloud', model: 'unused', secretRef: 'store:venice.api_key' }, storedEnv) ? 'not_allowed' : 'not_set_up';
        }
      } catch { venice = 'not_allowed'; }
      const modelState = answerBuiltInModel?.status().state;
      return { computer: workerBuiltInModel?.available() ? 'ready' : 'not_set_up', venice, ...(['downloading', 'verifying', 'loading'].includes(modelState ?? '') ? { computerReason: PRIVATE_ANSWERS_COPY.downloading } : {}) };
    };
    const veniceAnswer = sourceAnswer ? createVeniceInboxAnswer({
      state: () => destinations().venice, handler: sourceAnswer, sourceName,
      corpusIds: () => sourceAnswerLanes!({ question: 'scope', retrieval_mode: 'keyword' }).registry.list().filter(corpus => corpus.trustDomain === 'internal' || corpus.trustDomain === 'secure_local').map(corpus => corpus.corpusId),
      eligible: local.eligible,
    }) : undefined;
    localPrivateAnswers = createLocalPrivateAnswers({
      destinations, ...(veniceAnswer ? { veniceAnswer } : {}),
      localConnectionId: '@local:You',
      anonymousAsk: localAnonymousAsk,
      // The built-in model serves one question at once: an answer preempts the sniffer.
      answer: (input) => answerActivity.run(() => local.answer(input)),
      backgroundAnswer: (input) => runBackgroundInference(() => answerActivity.run(() => local.answer(input), 'background')),
      interactiveBusy: () => answerActivity.interactiveInFlight > 0,
      backgroundBusy: () => classificationBusy(),
      panelClaimed: (ref) => privateAnswers.hasClaimedWaiting(ref),
      isActive: connectionActive,
      store: waitingQuestionStore,
      connectionName: (connectionId) => localInboxLabel(connectionId) ?? remoteConnections()?.list().find((connection) => connection.id === connectionId)?.displayName,
      eligible: local.eligible,
      ...(openCitedFile ? { openFile: openCitedFile } : {}),
      ...(process.platform === 'darwin' ? {
        openUrl: async (url: string, eligible: () => Promise<boolean>) => {
          if (!(await eligible())) throw new Error('open refused');
          await new Promise<void>((resolve, reject) => execFile('/usr/bin/open', [url], { timeout: 10_000 }, error => error ? reject(error) : resolve()));
        },
      } : {}),
    });
    localPrivateAnswers.start();
  } else {
    const { createLocalPrivateAnswers } = await import('./local-private-answers.ts');
    localPrivateAnswers = createLocalPrivateAnswers({
      destinations: () => ({ computer: 'not_set_up', venice: 'not_set_up' }),
      store: waitingQuestionStore, isActive: connectionActive,
      connectionName: (id) => localInboxLabel(id) ?? remoteConnections()?.list().find(c => c.id === id)?.displayName,
      answer: async () => ({ status: 'no_model' }),
      eligible: async items => items.map(() => false),
      anonymousAsk: localAnonymousAsk,
    });
    localPrivateAnswers.start();
  }
  // The private question panel's jobs (chatgpt/private-question-jobs.ts):
  // the sealed question runs the same ask lane as the ask_anonymously tool,
  // with the caller placed as OpenAI-hosted, since ChatGPT opened the panel.
  const privateQuestions = new PrivateQuestionJobs({
    installId: () => remotePublicUrls()?.installId,
    ask: (input) => (askAnonymouslyNow
      ? askWithAnonymousInbox({
        question: input.question,
        level: input.level,
        ...(input.cleanup !== undefined ? { cleanup: input.cleanup } : {}),
        callerProvider: 'openai',
        signal: input.signal,
        stillAuthorized: input.stillAuthorized,
      }, { deliveredToPanel: true, store: waitingQuestionStore, connectionId: '@local:ChatGPT', ask: askAnonymouslyNow })
      : Promise.resolve({ ok: false as const, code: 'transport_unavailable', message: 'Anonymous answers are not set up on this computer.' })),
    // The panel's default choice: the dashboard's saved level and Standard preparation (consult.json, read at every open).
    choice: () => {
      const read = readConsultSettings();
      const settings = read.state === 'valid' ? read.settings : DEFAULT_CONSULT_SETTINGS;
      const standard = consultStandardBinding(settings);
      return { level: consultAskLevelFromSettings(settings.level), cleanup: standard.mode, customInstruction: standard.mode === 'custom' };
    },
    // A job asks, and mints a successor, only while the connection that opened it is not revoked.
    connectionActive: (connectionId) => remoteConnections()?.list().some((connection) => connection.id === connectionId && connection.revokedAt === null) === true,
    dailyLimit: () => zkapiDailyLimitNow?.() ?? 'unset',
  });
  const privateAnswerSweep = setInterval(() => {
    privateAnswers.sweep();
    privateQuestions.sweep();
  }, 30_000);
  privateAnswerSweep.unref?.();
  {
    const { CONSULT_WRITER_LIMITS, createConsultWriterServer, defaultConsultMemoryProbe, runConsultWriter, runOwnConsultWriter } = await import('../../core/consult-writer.ts');
    const { defaultZkapiStatePath, openZkapiConsultSession, resolveZkapiConsultTransport, zkapiDailyLimitState } = await import('../../core/consult-transport-zkapi.ts');
    type WriterServer = import('../../core/consult-writer.ts').ConsultWriterServer;
    // The writer's own llama-server on the answer model's verified files,
    // created once those files are installed in this process; started on
    // demand and killed after each call (SIGKILL; the answer server is never
    // touched). The memory rule decides before every start.
    let writerServer: WriterServer | undefined;
    const writerServerFor = (): WriterServer | undefined => {
      if (writerServer) return writerServer;
      const runtime = workerBuiltInModel?.model.installedRuntime?.();
      if (!runtime) return undefined;
      writerServer = createConsultWriterServer(runtime, { env: process.env });
      return writerServer;
    };
    const memory = defaultConsultMemoryProbe();
    // The zkAPI route: the one `zkapi` sovereignty profile, if any. Without
    // one the transport is unavailable and no consult is sent. The key is
    // read per call from the same environment the outside-help card checks
    // (worker.env under a non-empty process value), so the card never says a key is present
    // that the send cannot use. The model arrives already chosen by the
    // caller's hosting provider (consult-ask.ts: never the provider that
    // holds the conversation), or named by the caller.
    const { consultChatgptFrontierModel, consultChatgptModelUnavailableMessage } = await import('../../core/consult-settings.ts');
    const chatgptModel = (): string => consultChatgptFrontierModel(readConsultSettings().settings);
    const transport = (model: string) => resolveZkapiConsultTransport(
      sovereigntyEngine.config.modelProfiles,
      (secretRef) => resolveSecretRefValueSync(secretRef, { env: environmentWithWorkerSetupEnv() }),
      { env: process.env, model },
    );
    // The route's settings and today's record only: no key is resolved for this check.
    zkapiDailyLimitNow = () => {
      const route = resolveZkapiConsultTransport(sovereigntyEngine.config.modelProfiles, () => undefined, { env: process.env });
      return route ? zkapiDailyLimitState(route.settings, route.statePath ?? defaultZkapiStatePath(), new Date()) : 'unset';
    };
    // The owner's own writer model (consult.json `writer`) arrives as the Ask
    // read it (control.writer; null: the built-in model writes), never reread
    // here, so the writer that runs is the one whose gate net applies. Its key
    // is resolved per call from the same environment as the route's and
    // never logged.
    type WriterControl = { kill: AbortSignal; deadlineMs: number; level: import('../../core/consult-settings.ts').ConsultLevel; writer: import('../../core/consult-settings.ts').ConsultWriterChoice | null };
    const runChosenWriter = (input: import('../../core/consult-writer.ts').ConsultWriterInput, control: WriterControl) => {
      const choice = control.writer;
      if (choice) {
        let apiKey: string | undefined;
        try {
          apiKey = choice.secretRef ? resolveSecretRefValueSync(choice.secretRef, { env: environmentWithWorkerSetupEnv() }) : undefined;
        } catch {
          apiKey = undefined;
        }
        // A key reference that does not resolve: no consult (never a keyless request to a server that wants one).
        if (choice.secretRef && !apiKey) return Promise.resolve({ kind: 'failed' as const, reason: 'start_failed' as const });
        return runOwnConsultWriter(input, {
          endpoint: { baseUrl: choice.baseUrl, model: choice.model, ...(apiKey ? { apiKey } : {}) },
          kill: control.kill,
          deadlineMs: control.deadlineMs,
          level: control.level,
        });
      }
      return runConsultWriter(input, {
        server: writerServerFor(),
        memory,
        kill: control.kill,
        deadlineMs: control.deadlineMs,
        level: control.level,
      });
    };
    {
      const { askAnonymously } = await import('../../core/consult-ask.ts');
      const { CONSULT_OWN_WRITER_DEFAULT_TIMEOUT_MS } = await import('../../core/consult-settings.ts');
      const admittedAsk: NonNullable<typeof askAnonymouslyNow> = async (input) => {
        const result = await askAnonymously(input, {
          settings: () => readConsultSettings(),
          prepare: (writerInput, writer, level, signal) => runChosenWriter(writerInput, {
            kill: signal ?? new AbortController().signal,
            deadlineMs: writer ? writer.timeoutMs ?? CONSULT_OWN_WRITER_DEFAULT_TIMEOUT_MS : CONSULT_WRITER_LIMITS.deadlineMs,
            level,
            writer,
          }),
          // Open, send with final authorization, then wait for settlement:
          // the one-shot path's steps, with the Ask's settings check at the
          // transport's authorization boundary (review of PR #209), on the
          // model set for the caller's hosting provider (or the one-off model
          // it named). The authorization is handed the model this route
          // resolved, so the same-provider rule is checked on the model that
          // is actually sent.
          send: async (text, authorize, { model, signal }) => {
            const route = transport(model);
            if (!route) return undefined;
            const opened = await openZkapiConsultSession(route, signal ? { signal } : {});
            if (!opened.ok) return { ok: false, error: opened.error };
            await opened.session.send(text, { authorize: () => authorize(route.model), ...(signal ? { signal } : {}) });
            return opened.session.finished;
          },
          // The agent's "remember" goes through the dashboard adapter: the
          // only caller allowed to write consult.json (consult-settings-writer).
          remember: (choice) => dashboardConsult.rememberLevel(choice),
        });
        // The card's "model missing from the listing" note: only for the
        // ChatGPT setting, when the question used it.
        if (!input.model && input.callerProvider !== 'anthropic') {
          if (!result.ok && result.code === 'model_unavailable') chatgptModelProblem = { at: new Date().toISOString(), message: consultChatgptModelUnavailableMessage(chatgptModel()) };
          else if (result.ok) chatgptModelProblem = undefined;
        }
        return result;
      };
      askAnonymouslyNow = async (input) => {
        try { return await withEngineWorkerAdmission(defaultZkapiStatePath(), () => admittedAsk(input), { acquireTimeoutMs: 50 }); }
        catch (error) {
          if (error instanceof EngineMaintenanceInProgressError || (error as { code?: string }).code === 'file_lease_busy') return { ok: false, code: 'engine_maintenance_in_progress', message: 'Olympus engine maintenance or another consult is in progress; try again after it finishes.' };
          throw error;
        }
      };
    }
  }
  // The Private part of a remote agent's answer (core/remote-private-part.ts):
  // when the answer left Private out, a metadata-only local probe over the
  // same selectors decides whether the question waits on this computer.
  // "Couldn't check yet" records are re-probed here every ten minutes.
  const { createRemotePrivateParts } = await import('../../core/remote-private-part.ts');
  const remotePrivateParts = createRemotePrivateParts({
    probe: (request, timeoutMs) => (sourceAnswerLanes
      ? probePrivateMatch({ lanes: sourceAnswerLanes, request: request as unknown as SourceIndexAnswerRequest, timeoutMs })
      : Promise.resolve('unknown' as const)),
    store: waitingQuestionStore,
    isActive: connectionActive,
    // The re-check is background work: it waits on the model's keyword
    // translation as long as it needs, and starts no probe while the owner's
    // own answer is in flight.
    interactiveBusy: () => answerActivity.interactiveInFlight > 0,
  });
  const uncheckedRetry = setInterval(() => {
    void remotePrivateParts.retryUnchecked().catch(() => undefined);
  }, 10 * 60_000);
  uncheckedRetry.unref?.();
  const remoteAgentOptions = {
    connections: remoteConnections,
    // A demo sign-in grant gets only the read-only tools, on /mcp and OpenAPI alike.
    demoGrant: isDemoGrant,
    publicUrls: remotePublicUrls,
    makeOperationContext: (caller: Parameters<typeof createInProcessOperationContext>[0]['caller'], signal: AbortSignal) => ({
      ...createInProcessOperationContext({
        config: olympusConfig,
        sourceIndexReadEnabled,
        workerFetch: worker.fetch,
        caller,
        signal,
        sourceAnswerJobs,
      }),
      // The remote output boundary revalidates a collected answer's release
      // manifest against the tier ledgers and release rules as they are now
      // (core/remote-result.ts).
      releaseCheck: remoteReleaseCheck,
      // Summary-rule agents only: the ChatGPT surface records through its own path (chatgpt/mcp-surface.ts).
      ...(caller.connectionId ? { remotePrivatePart: remotePrivateParts.forConnection(caller.connectionId) } : {}),
    }),
  };
  // `/openapi.json` and `/api/v1/tools/<name>`: the same remote surface as
  // `/mcp`, as REST for agents that take an OpenAPI spec (Muse).
  const { createRemoteOpenApiHandler, withRemoteOpenApiRoutes } = await import('../remote-openapi.ts');
  const remoteOpenApi = createRemoteOpenApiHandler({
    ...remoteAgentOptions,
    publicBaseUrl: () => remotePublicUrls()?.origin,
  });

  // Setup from ChatGPT (workers/chatgpt): one-time sign-in links, the
  // picker and model switching through the dashboard's own routes, and
  // retrieval-only search for ChatGPT's model to answer from.
  const { createChatGptHandoffs, createChatGptHandoffHandler, withChatGptHandoffRoutes } = await import('../chatgpt/handoff.ts');
  const { createChatGptSetupBackend, readChatGptPrivacySettings } = await import('../chatgpt/setup-backend.ts');
  const chatgptHandoffs = createChatGptHandoffs();
  // Items held for the privacy check (pending, Private, not embedded), every
  // tier ledger counted once per corpus. Counts only.
  const pendingClassificationCount = (): number => {
    let total = 0;
    for (const lane of tierLanes) {
      for (const corpusId of lane.corpusIds) {
        try {
          total += lane.ledger.corpusCopyCounts(corpusId).held;
        } catch {
          // An unreadable ledger contributes nothing to a count.
        }
      }
    }
    return total;
  };
  const chatgptSetup = createChatGptSetupBackend({
    pendingClassificationCount,
    workerFetch: worker.fetch,
    handoffs: chatgptHandoffs,
    publicUrls: remotePublicUrls,
    ...(fileSourceScopes ? { scopeSummaries: () => fileSourceScopes.summaries() as ReadonlyArray<Record<string, unknown>> } : {}),
    sovereignty: {
      config: sovereigntyEngine.config,
      source: sovereigntyEngine.source,
      ...(sovereigntyEngine.path ? { path: sovereigntyEngine.path } : {}),
    },
    credentialPresent: (_id, profile) => profile.secretRef === undefined
      || safeModelCredential(profile, { ...process.env, ...(readWorkerSetupEnv() ?? {}) }) !== undefined,
    requestReload: () => requestModelReload(),
    retryModel: (model) => {
      if (model === 'transcription') {
        // Download now (or again) for the built-in transcriber; the local
        // dashboard's /dashboard/models/retry route does the same.
        const engine = process.env.OLYMPUS_TRANSCRIBE_COMMAND?.trim() ? undefined : sharedBuiltInTranscriber(process.env);
        return (engine?.downloadNow?.() ?? 'unavailable') !== 'unavailable';
      }
      if (model === 'answers') {
        if (!workerBuiltInModel) return false;
        void workerBuiltInModel.model.prepare();
        return true;
      }
      const builtIn = [...new Set([internalPolicyEmbeddingProvider, secureLocalPolicyEmbeddingProvider])]
        .filter((provider): provider is BuiltInSourceEmbeddingProvider => provider instanceof BuiltInSourceEmbeddingProvider);
      for (const provider of builtIn) void provider.retry().catch(() => undefined);
      return builtIn.length > 0;
    },
  });
  // Outside help (consults, stage C5): the Mac dashboard card's backend
  // (dashboard-consult.ts) and, through it, the only caller of the
  // outside-help settings writer. Wired here at the composition root so the
  // worker module itself never imports the writer; its routes are served
  // only inside an authenticated local control session (workers/http.ts).
  const { createDashboardConsultAdapter } = await import('./dashboard-consult.ts');
  const consultRouteKey = (secretRef: string | undefined): string | undefined => {
    if (!secretRef) return undefined;
    try {
      return resolveSecretRefValueSync(secretRef, { env: environmentWithWorkerSetupEnv() })?.trim() || undefined;
    } catch {
      return undefined;
    }
  };
  const dashboardConsult = createDashboardConsultAdapter({
    sovereignty: {
      config: sovereigntyEngine.config,
      source: sovereigntyEngine.source,
      ...(sovereigntyEngine.path ? { path: sovereigntyEngine.path } : {}),
    },
    // Presence from the same environment the Models row reads, so a key just
    // written to worker.env reads as present before the restart applies it.
    // The adapter gets a yes/no; the key itself is resolved only here, for
    // the recovery session, and handed straight to the transport.
    secretPresent: (secretRef) => consultRouteKey(secretRef) !== undefined,
    recoverSession: async (route, secretRef) => {
      const { recoverZkapiSession } = await import('../../core/consult-transport-zkapi.ts');
      const apiKey = consultRouteKey(secretRef);
      return recoverZkapiSession({ ...route, ...(apiKey ? { apiKey } : {}) });
    },
    requestReload: () => requestModelReload(),
    env: process.env,
    chatgptModelProblem: () => chatgptModelProblem,
    // The writer capability check, on the owner's click only: the writer
    // chosen now, its key resolved here, the level and languages saved now.
    // It sends nothing to zkAPI (core/consult-writer-check.ts).
    writerCheck: async ({ onCase }) => {
      const { readConsultSettings, CONSULT_OWN_WRITER_DEFAULT_TIMEOUT_MS } = await import('../../core/consult-settings.ts');
      const { checkOwnConsultWriter } = await import('../../core/consult-writer-check.ts');
      const read = readConsultSettings();
      const choice = read.state === 'valid' ? read.settings.writer : undefined;
      if (read.state !== 'valid' || !choice) throw new Error('Choose your model and save it first.');
      const apiKey = consultRouteKey(choice.secretRef);
      if (choice.secretRef && !apiKey) throw new Error(`The key reference ${choice.secretRef} is not set on this computer.`);
      const { consultStandardInstruction } = await import('../../core/consult-settings.ts');
      // Standard: the instruction the user chose (as written has no model step to test: light cleanup is tested).
      const instruction = read.settings.level === 'unnamed'
        ? consultStandardInstruction(read.settings) ?? consultStandardInstruction({ ...read.settings, standardMode: 'light_cleanup' })
        : undefined;
      return checkOwnConsultWriter({
        endpoint: { baseUrl: choice.baseUrl, model: choice.model, ...(apiKey ? { apiKey } : {}) },
        level: read.settings.level,
        ...(instruction !== undefined ? { instruction } : {}),
        languages: read.settings.languages,
        deadlineMs: choice.timeoutMs ?? CONSULT_OWN_WRITER_DEFAULT_TIMEOUT_MS,
        onCase,
      });
    },
  });
  const engineHosted = process.env.OLYMPUS_ENGINE_HOST === '1';
  // source_answer needs an Analyst the Mac can actually run; without one,
  // ChatGPT answers from olympus_search alone.
  const chatgptAnswerModelAvailable = (): boolean => {
    if (!sourceAnswer || !getModelSetup().ready) return false;
    return (['public_safe', 'internal'] as const).some((domain) => {
      const route = sovereigntyEngine.config.routes[domain];
      if (!route || route.mode === 'disabled') return false;
      return (route.pool?.members ?? route.analyst ?? []).some((id) => {
        const profile = sovereigntyEngine.config.modelProfiles[id];
        return profile !== undefined && profile.provider !== 'built-in'
          && !(profile.provider === 'openclaw-infer' && engineHosted);
      });
    });
  };
  const chatgptEvidenceSearch = sourceAnswerLanes
    ? async (input: { question: string; limit?: number }) => {
        // Not an answer: no answerActivity lease, so it never preempts the
        // sniffer. It does ask the built-in model, once per new wording, to
        // translate the question's words (core/source-index/keyword-expansion.ts),
        // on the model directly, so that call queues behind what the model runs.
        return searchReleasedEvidence({
          lanes: sourceAnswerLanes!,
          question: input.question,
          ...(input.limit ? { maxResults: input.limit } : {}),
          releaseCheck: remoteReleaseCheck,
        });
      }
    : undefined;
  // The same search for every other remote agent, with the tiers read once
  // more right before the result leaves (workers/remote-search.ts).
  const remoteEvidenceSearch = sourceAnswerLanes
    ? async (input: { question: string; limit?: number }) => searchReleasedEvidence({
        lanes: sourceAnswerLanes!,
        question: input.question,
        ...(input.limit ? { maxResults: input.limit } : {}),
        releaseCheck: remoteReleaseCheck,
      })
    : undefined;
  // Which Private items match, for the private answer panel: the shared
  // EvidencePack build over Private corpora only, so each item carries its
  // own passages, read from the local store. The candidates go only to the
  // private answer job (and the built-in model on this computer); only their
  // count leaves the engine. The claim-time refresh runs the same search.
  const chatgptPrivateMatchProbe = sourceAnswerLanes
    ? async (question: string) => {
        const result = await searchPrivateEvidence({ lanes: sourceAnswerLanes!, question });
        return { count: result.matched, evidence: result.candidates as unknown as readonly Record<string, unknown>[] };
      }
    : undefined;
  // The dashboard's install progress follows the built-in model's download.
  const chatgptPrivateModelState = () => {
    if (!workerBuiltInModel) return undefined;
    const status = builtInPrivateModelStatus(process.env);
    if (!status.enabled) return undefined;
    const spaceToFree = status.state === 'failed' && modelInstallFailedReason(status.failure) === 'disk_full'
      ? modelInstallSpaceToFree(status)
      : undefined;
    return {
      state: status.state,
      percent: status.percent,
      bytesDone: status.bytesDone,
      bytesTotal: status.bytesTotal,
      ...(status.state === 'failed' ? { failedReason: modelInstallFailedReason(status.failure) } : {}),
      ...(spaceToFree !== undefined ? { spaceToFreeBytes: spaceToFree } : {}),
    };
  };
  // The built-in transcription model, where it is this machine's transcriber
  // (no owner command, enabled here): its status file, read without starting
  // anything. A model never started reads "not needed" (no audio chosen).
  const dashboardTranscriptionState = () => {
    if (process.env.OLYMPUS_TRANSCRIBE_COMMAND?.trim() || !builtInTranscriptionEnabled(process.env)) return undefined;
    try {
      const engine = sharedBuiltInTranscriber(process.env);
      return builtInTranscriptionDashboardState(readBuiltInTranscriptionStatusFile(process.env), {
        installing: engine?.installing?.() === true,
      });
    } catch {
      return undefined;
    }
  };
  const chatgptEmbeddingState = () => {
    const builtIn = (['public_safe', 'internal', 'secure_local'] as const)
      .map((domain) => sovereigntyEngine.resolveEmbeddingProfile(domain)?.profile)
      .find((profile) => profile?.provider === 'built-in');
    // The configured model's install, which is not the new-install default on an older install.
    const model = builtIn?.model ? builtInEmbeddingModel(builtIn.model) : undefined;
    return model ? builtInEmbeddingDashboardState(readBuiltInEmbeddingStatus(process.env, model)) : undefined;
  };

  // ChatGPT's dashboard and setup tools, as /mcp runs them. The same options
  // serve the panel on Olympus's own hosts (dashboard-panel-tools.ts): the
  // computer's /dashboard and the OpenClaw Control UI tab.
  const chatgptSurface = {
    privateAnswers,
    privateQuestions,
    dashboardView: async (signal?: AbortSignal) => {
      const response = await worker.fetch(new Request(
        'http://olympus-worker.internal/dashboard.json',
        signal ? { signal } : {},
      ));
      if (!response.ok) throw new Error(`dashboard view unavailable (${response.status})`);
      return await response.json() as SourceDashboardViewModel;
    },
    setup: chatgptSetup,
    ...(chatgptEvidenceSearch ? { evidenceSearch: chatgptEvidenceSearch } : {}),
    ...(chatgptPrivateMatchProbe ? { privateMatchProbe: chatgptPrivateMatchProbe } : {}),
    waitingQuestions: waitingQuestionStore,
    answerModelAvailable: chatgptAnswerModelAvailable,
    embedding: chatgptEmbeddingState,
    privateModel: chatgptPrivateModelState,
    transcription: dashboardTranscriptionState,
    // Remote mode (core/remote-open.ts): read per dashboard read, so
    // `olympus server-mode on` needs no restart. `agent`: the OpenClaw
    // Gateway supervises this worker (its native service, not the standalone
    // engine host), so the owner's assistant can open Olympus on their
    // computer for them; anywhere else (a hand-run worker, or a Hermes
    // install that turned the route off) the panel shows the by-hand lines only.
    remote: () => {
      const mode = resolveServerMode({ env: process.env, fileEnv: readWorkerSetupEnv(), desktopReady: () => agentApprovalHost().headless === false });
      const underOpenClaw = !!process.env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID?.trim() && remoteAccessHostKind === 'openclaw';
      return mode.remote
        ? { port, ...(process.platform === 'linux' ? { socketPath: workerSocketPath()! } : {}), ...(mode.sshTarget ? { sshTarget: mode.sshTarget } : {}), agent: underOpenClaw && mode.agentRoute }
        : undefined;
    },
    privacy: () => {
      const settings = readChatGptPrivacySettings(process.env, pendingClassificationCount());
      return {
        configured: settings.configured, pendingCount: settings.pendingCount, ruleCount: settings.rules.length,
        classifierAwaitingApproval: tierSnifferBacklog?.().awaitingOwnerApproval === true,
      };
    },
  };
  const { withEngineBriefRoute } = await import('../engine-brief-route.ts');
  const { dashboardViewModel: engineBriefView } = await import('../chatgpt/mcp-surface.ts');
  const { createDashboardPanelTools } = await import('./dashboard-panel-tools.ts');
  dashboardPanelTools = createDashboardPanelTools({
    surface: () => chatgptSurface,
    setup: chatgptSetup,
    workerFetch: worker.fetch,
    makeContext: (signal) => remoteAgentOptions.makeOperationContext({ surface: 'native', displayName: 'Olympus dashboard' }, signal),
    indexFasterState: async () => {
      const runtime = await readEmbeddingRuntime({ env: process.env });
      return runtime.state === 'unknown' ? undefined : runtime.overrideOn;
    },
    unreadableFiles: () => unreadableFiles,
    waitingPrivateQuestions: () => localPrivateAnswers?.waitingCount() ?? 0,
    archives: () => archiveImportDashboard.view(),
    sourceImports: () => archiveImportDashboard.sourceImports(),
    archiveSources: () => archiveImportDashboard.archiveSources(),
    archiveCards: () => archiveImportDashboard.cardViews(),
  });

  const socketPath = prepareWorkerSocket();
  const serverOptions = {
    // Remote agent routes authenticate connection credentials only (bearer
    // connection tokens, or OAuth access tokens bound to this resource); the
    // OAuth metadata and `/connect/*` routes serve the approval flow; every
    // other route keeps the worker bearer. See workers/remote-mcp.ts,
    // workers/remote-openapi.ts and workers/remote-oauth/handler.ts. One-time
    // `/go/<id>` sign-in links answer their stored redirect once
    // (workers/chatgpt/handoff.ts); `/private/<id>` is the private answer
    // panel's one-time sealed collection (workers/chatgpt/private-answer-jobs.ts).
    // Each request's peer address is recorded for the routes that check it
    // (relay-mode OAuth approval: core/request-peer.ts).
    // The relay child reads the offline tool-list mapping it keeps the relay
    // in step with (workers/relay-surfaces.ts), by its per-boot secret.
    fetch: withRequestPeer(withRelaySurfacesRoute(createRelaySurfacesHandler({
      connections: () => remoteConnections(),
      publicUrls: remotePublicUrls,
      isRelayed: isRelayedRequest,
    }), withChatGptHandoffRoutes(createChatGptHandoffHandler(chatgptHandoffs, { isRelayed: carriesRelayMarker }), withPrivateAnswerRoute(createPrivateAnswerHandler({
      jobs: privateAnswers,
      questions: privateQuestions,
      isRelayed: isRelayedRequest,
      extraOrigins: () => [DASHBOARD_UI_DOMAIN],
    }), withRemoteOAuthRoutes(
      createRemoteOAuthHandler({
        publicUrls: remotePublicUrls,
        requireOwnerSocket: !!socketPath,
        // Any marker, verified or not, refuses approval (fails closed).
        isRelayed: carriesRelayMarker,
        // Demo installs only: inert without remote.demoConsent AND the demo marker.
        demoConsent: () => resolveDemoConsent(olympusConfig.remote, () => demoInstallMarked(remoteAccessDir(process.env))),
        connections: () => remoteConnections({ create: true })!,
      }),
      // Each remote agent route sits inside its own exception boundary, so a
      // failure there is a fixed JSON error, never the runtime's error page;
      // the worker-bearer routes keep their own handling.
      withRemoteOpenApiRoutes(withRemoteFailureBoundary(remoteOpenApi), withRemoteMcpRoute(
        withRemoteFailureBoundary(createRemoteMcpHandler({
          ...remoteAgentOptions,
          anonymousAnswersEnabled: () => {
            const read = readConsultSettings();
            return read.state === 'valid' && read.settings.enabled;
          },
          // Relayed requests get the ChatGPT surface (docs/design/chatgpt-plugin.md):
          // the hosted relay is the ChatGPT path, and the relay marker must
          // carry the relay child's per-boot secret (isRelayedRequest), from
          // an OAuth grant to a pinned ChatGPT client. Direct, bearer and
          // self-registered connections keep the remote operation surface; a
          // demo sign-in grant gets the read-only tools. The dashboard tool
          // reads the view `/dashboard.json` serves, in-process.
          // Every other caller (Claude, Grok, Grok Bot or Cursor, keys)
          // gets the same evidence search, so it can answer on an install
          // with no answer model (workers/remote-search.ts).
          ...(remoteEvidenceSearch
            ? { search: { evidenceSearch: remoteEvidenceSearch, answerModelAvailable: chatgptAnswerModelAvailable } }
            : {}),
          chatgpt: {
            servesRequest: (request: Request, connection: { clientId?: string | null }) => isRelayedRequest(request) && isChatGptGrant(connection),
            readOnlyFor: isDemoGrant,
            ...chatgptSurface,
          },
        })),
        // The brief route must pass both bearer and owner-socket authorization.
        withWorkerBearerAuth(withEngineBriefRoute(worker.fetch, { view: (signal) => engineBriefView(chatgptSurface, signal) }), { authToken, requireOwnerSocket: !!socketPath, sessionSecret: dashboardSessionSecret.secret }),
      )),
    )))), !!socketPath),
  };
  // Nothing is answered from the local files index before what an earlier version
  // indexed inside Olympus's own folders is gone (own-roots-cleanup.ts).
  await localFilesOwnRootsCleanup?.run();
  const startServer = () => socketPath
    ? Bun.serve({ unix: socketPath, fetch(request, server) {
        server.timeout(request, 0);
        if (new URL(request.url).pathname === DESKTOP_OWNER_OPEN_PATH) {
          if (request.method !== 'POST' || !authToken || request.headers.get('authorization') !== `Bearer ${authToken}`) return new Response(null, { status: 403 });
          return (async () => {
            const status = desktopBridge?.status();
            if (!status || status.state === 'headless') return Response.json({ state: 'headless' });
            if (status.state !== 'listening') return Response.json(status, { status: 503 });
            try {
              const base = `http://127.0.0.1:${port}`;
              const open = new URL(await mintDashboardOpeningUrl(base, authToken));
              const requestedTarget = new URL(request.url).searchParams.get('target');
              const target = requestedTarget ? parseOlympusOpenUrl(`olympus://open/${requestedTarget}`) : undefined;
              if (requestedTarget && !target) return new Response(null, { status: 400 });
              if (target) open.hash += `&olympus_open=${openTargetToken(target)}`;
              const origin = await desktopBridge!.open(open.pathname + open.search + open.hash);
              return Response.json({ state: 'listening', opened: true, url: origin + '/dashboard', hint: 'A private owner ticket was opened in your desktop browser. If *.localhost resolution fails, use the owner SSH socket forward; never use the fixed origin.' });
            } catch { return Response.json({ error: 'Owner ticket could not open. Wait ten seconds and retry, or use the owner SSH socket forward.' }, { status: 503 }); }
          })();
        }
        const response = serverOptions.fetch(request, server);
        const path = new URL(request.url).pathname;
        if (path === '/v1/health' || path === '/health') return Promise.resolve(response).then(async value => {
          if (!value.ok) return value;
          return Response.json({ ...await value.json() as object, built_in_models: linuxModelReadiness(process.env), desktop_bridge: desktopBridge?.status() }, { status: value.status, headers: value.headers });
        });
        return response;
      } })
    : Bun.serve({ hostname, port, idleTimeout: 0, ...serverOptions });
  const server = socketPath ? bindWorkerSocket(socketPath, startServer) : startServer();
  updateChecker.start();
  if (socketPath && process.env[OWNER_BRIDGE_HOST_ENV]) {
    const client = connectLinuxOwnerBridgeHost(process.env[OWNER_BRIDGE_HOST_ENV]!);
    desktopBridge = client;
    await client.refresh();
    desktopPoll = setInterval(() => { void client.refresh(); }, 2_000); desktopPoll.unref();
  } else if (socketPath) {
    let ready = false;
    let probing = false;
    const probeDesktop = async () => {
      if (probing || desktopPollingClosed) return;
      probing = true;
      try {
        // Coalesce bounded asynchronous probes; unauthenticated HTTP traffic
        // only reads the current snapshot and cannot spawn systemctl.
        const desktop = await linuxGraphicalSessionReadinessAsync();
        if (desktopPollingClosed) return;
        ready = desktop.ready && !resolveServerMode({ env: process.env, fileEnv: readWorkerSetupEnv(), desktopReady: () => desktop.ready }).remote;
      } catch { ready = false; }
      finally { probing = false; if (!desktopPollingClosed) desktopBridge?.refresh(); }
    };
    await probeDesktop();
    desktopBridge = manageLinuxOwnerBridge({ port, socketPath, ready: () => ready,
      fetchSocket: request => workerFetch(request, { redirect: 'manual' }),
      establishDashboard: async () => {
        const base = `http://127.0.0.1:${port}`;
        const response = await workerFetch(`${base}/dashboard/control/session`, { method: 'POST',
          headers: { Authorization: `Bearer ${authToken ?? ''}`, Origin: base }, redirect: 'error', signal: AbortSignal.timeout(5_000) });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (response.status === 503) throw new Error('Owner dashboard session is restarting.');
          return null;
        }
        await response.body?.cancel();
        return response.headers.getSetCookie();
      },
    });
    desktopPoll = setInterval(() => { void probeDesktop(); }, 2_000); desktopPoll.unref();
  }
  sourceScheduler?.start();
  await reconcileCaptures();
  const captureTick = setInterval(() => { void reconcileCaptures(); }, 10_000);
  captureTick.unref?.();

  // The privacy-safe sniffer's bounded background pass over pending items.
  const snifferEnv = tierSnifferServiceEnv(process.env);
  const snifferModel = !snifferEnv.enabled || snifferRuntime.source === 'off'
    ? undefined
    : snifferRuntime.source === 'built_in'
      ? snifferRuntime.builtIn.model
      : createTierSnifferModel({ lane: snifferRuntime.lane, olympusConfig, env: process.env, bootSecretResolver });
  const snifferResource = snifferRuntime.source === 'built_in' ? 'built_in'
    : snifferLane?.kind === 'local' ? localModelResourceKey(snifferLane.profile) : undefined;
  const tierSniffer = snifferLane && snifferModel
    ? new TierSnifferService({
        installed: installedTierClassification,
        lane: snifferLane,
        model: snifferResource ? {
          ...snifferModel,
          complete: request => runClassificationInference(() => localModelActivity.track(snifferResource, snifferModel).complete(request)),
        } : snifferModel,
        stores: () => connectorStores,
        classificationLedgerPath: resolveClassificationLedgerPath(process.env),
        ...(snifferRuntime.source === 'built_in'
          ? {
              modelAvailable: () => snifferRuntime.builtIn.available(),
              startModel: () => snifferRuntime.builtIn.startIfIdle?.(),
              modelState: () => workerBuiltInModel?.model.status().state,
            }
          : {}),
        ...(fileExtractionRuntime ? { extractionState: identity => fileExtractionRuntime.jobs.itemExtractionState(identity) } : {}),
        ownerContext: privacyOwnerWords,
        budgetStatePath: join(dirname(resolveClassificationLedgerPath(process.env)), 'tier-sniffer-budget.json'),
        intervalMs: snifferEnv.intervalMs,
        ...(snifferEnv.maxCallsPerPass !== undefined ? { maxCallsPerPass: snifferEnv.maxCallsPerPass } : {}),
        maxCallsPerDay: snifferEnv.maxCallsPerDay,
        answersInFlight: () => snifferResource !== undefined && localModelActivity.busy(snifferResource),
        // A waiting Inbox question past its deferral stops the pass, so its answer runs, then classification resumes.
        shouldYield: () => localPrivateAnswers?.overdue() ?? false,
        breakerOpen: () => secureAnalystPoolState.isBreakerOpen('secure_local', snifferLane.profileId),
        log: (line) => console.log(line),
        // Owner defaults 2026-10-01: the built-in private model is approved
        // for the sniffer by default, and a Personal verdict's queued move
        // runs at once while every embedding is the built-in local model.
        ...(snifferRuntime.source === 'built_in' ? { autoApproveBuiltIn: true } : {}),
        autoMoves: {
          localEmbeddingsOnly: () => (['public_safe', 'internal', 'secure_local'] as const).every((domain) => {
            const resolved = sovereigntyEngine.resolveEmbeddingProfile(domain);
            return resolved === undefined || resolved.profile.provider === 'built-in';
          }),
          embeddingLedgerPath: resolveEmbeddingLedgerPath(process.env),
        },
      })
    : undefined;
  if (tierSniffer && snifferResource) {
    localModelActivity.onBusy(snifferResource, () => tierSniffer.preempt());
    localModelActivity.onIdle(snifferResource, () => tierSniffer.wake());
  }
  classificationBusy = () => tierSniffer?.hasPriority ?? false;
  tierSnifferBacklog = tierSniffer ? () => tierSniffer.backlog() : undefined;
  archivePrivateModelState = () => archivePrivateModelFromSniffer(tierSniffer);
  tierSniffer?.start();

  // The worker owns a background tick that outlives any request, so the process
  // needs a way to put it down. Without this the only shutdown was the process
  // dying, which is not a shutdown so much as an interruption.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    // The host keeps its listener; a foreground worker closes only its own.
    closeDesktopBridge();
    if (shuttingDown) return;
    shuttingDown = true;
    updateChecker.stop();
    capturesClosed = true;
    desktopPollingClosed = true;
    if (desktopPoll) clearInterval(desktopPoll);
    clearInterval(captureTick);
    tierSniffer?.stop();
    archiveImportDashboard.close();
    installedTierClassification.close();
    void Promise.all(Object.values(captures).map((capture) => capture.stop())).catch(() => undefined);
    stopBuiltInModelOnShutdown(workerBuiltInModel?.model);
    // The built-in transcriber's server, if this process started one.
    stopBuiltInModelOnShutdown(runningBuiltInTranscriber());
    console.log(`Olympus private email source worker shutting down on ${signal}.`);
    // The re-check timer, any pass or settle in flight, then the store.
    clearInterval(uncheckedRetry);
    remotePrivateParts.close();
    localPrivateAnswers?.close();
    waitingStoreClosed = true;
    waitingStore?.close();
    waitingStore = undefined;
    worker.close();
    sourceScheduler?.stop();
    void server.stop();
    // The data owner lock stays held: the teardown above is still running, and
    // the kernel releases the lock when this process exits.
  };
  shutdownSignals.setShutdown(shutdown);
  requestModelReload = shutdownSignals.modelReload({
    managed: workerRestartsItself(workerLaunch, process.env),
    drain: async () => { await Promise.all(Object.values(captures).map((capture) => capture.stop())); await server.stop(true); },
    exit: (code) => process.exit(code),
  });
  modelReloadInstalled = true;

  console.log(socketPath ? `Olympus private email source worker listening on owner Unix socket` : `Olympus private email source worker listening on http://${hostname}:${port}/v1`);
  console.log(sourceIndexLaneStartupLog('Dropbox connector-store storage', dropboxConnectorStoreLane));
  console.log(sourceIndexLaneStartupLog('WhatsApp connector-store storage', whatsappConnectorStoreLane));
  console.log(sourceIndexLaneStartupLog('Telegram connector-store storage', telegramConnectorStoreLane));
  if (sourceScheduler) {
    // Constructed and selected are separate numbers and are printed as such.
    // The old single count read "enabled for 5 source(s)" while one of the five
    // carried an id no allowlist could select, so the number agreed with the
    // allowlist size and the lane was dead.
    for (const line of sourceSchedulerConstructionLogLines({
      decisions: schedulerAssembly.decisions,
      selectedSourceIds: olympusConfig.worker.scheduler.sourceIds,
    })) {
      console.log(line);
    }
    console.log(sourceSchedulerEnabledLogLine({
      constructedSourceIds: schedulerSources.map((source) => source.sourceId),
      selectedSourceIds: olympusConfig.worker.scheduler.sourceIds,
    }));
    if (schedulerSources.length === 0) {
      // The state a fresh install boots into. Without this line the only
      // evidence was "constructed=0", which reads like a failure rather than
      // the correct idle state before the first source is connected.
      console.log(
        '[source-scheduler] idle: no source is connected yet; '
        + 'the scheduler is running and will adopt each source as you connect it in the dashboard.',
      );
    }
  }
  console.log(describeSovereigntyPolicy(sovereigntyEngine));
  console.log(
    connector
      ? `Connector: gogcli command adapter with Argus local/private reasoning${parseOptionalBooleanEnv(process.env.OLYMPUS_EMAIL_SOURCE_ENABLE_PLANNER, 'OLYMPUS_EMAIL_SOURCE_ENABLE_PLANNER') ? ' and retrieval planning' : ''}.`
      : 'Connector: gogcli stub, not configured. Set OLYMPUS_EMAIL_SOURCE_CONNECTOR=gogcli to use the command adapter.',
  );
}

export function resolveEmailSourceBindHostFromEnv(env: Record<string, string | undefined> = process.env): string {
  return resolveWorkerBindHost(env, ['OLYMPUS_EMAIL_SOURCE_HOST']);
}

export function sourceIndexLaneEnabled(
  env: Record<string, string | undefined>,
  envName: string,
  handlePresent: boolean,
): boolean {
  return sourceIndexLaneDecision(env, envName, handlePresent).enabled;
}

export function sourceIndexLaneStorageEnabled(
  env: Record<string, string | undefined>,
  envName: string,
  sourceIndexReadEnabled: boolean,
): boolean {
  return sourceIndexLaneStorageDecision(env, envName, sourceIndexReadEnabled).enabled;
}

/**
 * The X legacy bookmarks index is retired (2026-07-28): reads are served by the
 * connector store, its vectors were imported there, and the database is deleted
 * on the host. This lane alone must not inherit the source-index read-surface
 * fallback every other lane uses, because opening the index recreates the file
 * that was just deleted — an absent env would silently resurrect an empty
 * legacy database. The mount now requires an explicit opt-in.
 */

/**
 * Readwise now follows X onto the canonical connector store. The legacy index
 * remains available only for an explicit, one-time convergence operation; an
 * absent flag must not recreate or schedule it during normal product runtime.
 */


export interface SourceIndexLaneDecision {
  enabled: boolean;
  envName: string;
  decidedBy: string;
}

export function sourceIndexLaneDecision(
  env: Record<string, string | undefined>,
  envName: string,
  handlePresent: boolean,
): SourceIndexLaneDecision {
  if (env[envName]?.trim()) {
    return {
      enabled: parseOptionalBooleanEnv(env[envName], envName),
      envName,
      decidedBy: envName,
    };
  }
  return {
    enabled: handlePresent,
    envName,
    decidedBy: handlePresent ? 'connected handle fallback' : 'no connected handle',
  };
}

export function sourceIndexLaneStorageDecision(
  env: Record<string, string | undefined>,
  envName: string,
  sourceIndexReadEnabled: boolean,
): SourceIndexLaneDecision {
  if (env[envName]?.trim()) {
    return {
      enabled: parseOptionalBooleanEnv(env[envName], envName),
      envName,
      decidedBy: envName,
    };
  }
  return {
    enabled: sourceIndexReadEnabled,
    envName,
    decidedBy: 'source-index read surface fallback',
  };
}

/**
 * Whether an account's stores may be mounted at worker boot. One that may not
 * (its data being deleted or deleted, or an unreadable registry) is left
 * unmounted exactly like a lane that is switched off, with one line saying
 * so; every other source mounts as usual. The throw in `openConnectorStore`
 * is the backstop.
 */
export function sourceAccountMountable(
  account: StorageAccount,
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = console.warn,
): boolean {
  const reason = sourceAccountUnavailableReason(account, env);
  if (reason === undefined) return true;
  log(`[storage] ${account.sourceId} is not mounted: ${reason.endsWith('.') ? reason.slice(0, -1) : reason}.`);
  return false;
}

/** A lane's storage decision, switched off when its account may not be mounted. */
export function sourceIndexLaneAccountDecision(
  decision: SourceIndexLaneDecision,
  account: StorageAccount,
  env: Record<string, string | undefined> = process.env,
  log: (line: string) => void = console.warn,
): SourceIndexLaneDecision {
  if (!decision.enabled || sourceAccountMountable(account, env, log)) return decision;
  return { ...decision, enabled: false, decidedBy: 'the source registry' };
}

export function sourceIndexLaneStartupLog(label: string, decision: SourceIndexLaneDecision): string {
  return `${label}: ${decision.enabled ? 'enabled' : 'disabled'} (decided by ${decision.decidedBy}).`;
}

export function activeCredentialHandle(
  handles: readonly ConnectedCredentialHandle[],
  match: {
    provider: ConnectedCredentialHandle['provider'];
    capability: string;
  },
): ConnectedCredentialHandle | undefined {
  return handles.find((handle) =>
    handle.provider === match.provider
    && handle.allowedCapabilities.includes(match.capability)
    && handle.backendState?.status !== 'reauth_required'
  );
}

export type CredentialHandleSelectionReason =
  | 'selected'
  | 'none'
  | 'ambiguous'
  | 'pinned_missing';

export interface CredentialHandleSelection {
  handle?: ConnectedCredentialHandle;
  reason: CredentialHandleSelectionReason;
  /** Eligible handle names, so an ambiguous refusal can name what it saw. */
  candidates: string[];
}

/**
 * Explicit, order-independent handle selection.
 *
 * `activeCredentialHandle` is a first-match `find`, and the registry is written
 * back sorted by handle name, so with two eligible handles the alphabetically
 * first one wins. That is how registering `gmail.business_ocu.delegated`
 * alongside `gmail.personal.delegated` silently rebound the Gmail lane from the
 * 73,212-message mailbox to the 25-message one: registration order, not
 * configuration, chose the mailbox.
 *
 * This selector never picks by order. Exactly one eligible handle is selected;
 * more than one is refused as ambiguous until an operator pins the one the lane
 * must read. A pin that names an unregistered handle is also refused rather
 * than falling back, because a silent fallback is the same defect wearing a
 * different hat.
 */
export function selectCredentialHandle(
  handles: readonly ConnectedCredentialHandle[],
  match: {
    provider: ConnectedCredentialHandle['provider'];
    capability: string;
    /** Operator pin naming the exact handle this lane must read. */
    pinnedHandle?: string;
  },
): CredentialHandleSelection {
  const eligible = handles.filter((handle) =>
    handle.provider === match.provider
    && handle.allowedCapabilities.includes(match.capability)
    && handle.backendState?.status !== 'reauth_required'
  );
  const candidates = eligible.map((handle) => handle.handle);
  const pinnedHandle = match.pinnedHandle?.trim();
  if (pinnedHandle) {
    const pinned = eligible.find((handle) => handle.handle === pinnedHandle);
    return pinned
      ? { handle: pinned, reason: 'selected', candidates }
      : { reason: 'pinned_missing', candidates };
  }
  if (eligible.length === 0) return { reason: 'none', candidates };
  if (eligible.length > 1) return { reason: 'ambiguous', candidates };
  return { handle: eligible[0]!, reason: 'selected', candidates };
}

/**
 * The single gate a connector-store lane passes before it may construct: the
 * lane enable must be on AND exactly one handle must be selected.
 *
 * Both halves matter. The lane enable alone is not enough, because the sync
 * handler is built from stores that exist at boot regardless of credentials —
 * so an enabled lane with no handle would construct a source that cannot run,
 * and the activation gate reads presence as readiness.
 */
export function connectorStoreLaneHandle(input: {
  env: Record<string, string | undefined>;
  laneEnvName: string;
  pinEnvName: string;
  provider: ConnectedCredentialHandle['provider'];
  capability: string;
  handles: readonly ConnectedCredentialHandle[];
  warn?: (message: string) => void;
}): ConnectedCredentialHandle | undefined {
  const handle = selectedSourceCredentialHandle(input);
  // Evaluated unconditionally so a malformed lane enable still fails the boot
  // even when no eligible credential handle exists.
  const laneEnabled = sourceIndexLaneEnabled(
    input.env,
    input.laneEnvName,
    handle !== undefined,
  );
  return handle && laneEnabled ? handle : undefined;
}

/** Select a source credential independently from any storage-lane enable. */
/**
 * Starts the first read after a scope approval without holding the approval's
 * response open for it. That read is a whole sync pass (minutes for a large
 * Dropbox), and awaiting it outlived the ChatGPT tool call: the picker saw the
 * save fail, saved again with the revision the first save had just replaced,
 * and got "The source scope changed" (owner live test, 2026-10-01). The
 * scheduler owns the run from here; its status and the dashboard report it.
 */
export function startApprovedSourceRun(scheduler: { runSource: SourceScheduler['runSource'] }, sourceId: string): void {
  void scheduler.runSource(sourceId, undefined, 'operator').catch(() => {
    console.warn(`[source-scheduler] source=${sourceId} first run after scope approval failed; the next scheduled pass retries.`);
  });
}

export function selectedSourceCredentialHandle(input: {
  env: Record<string, string | undefined>;
  pinEnvName: string;
  provider: ConnectedCredentialHandle['provider'];
  capability: string;
  handles: readonly ConnectedCredentialHandle[];
  warn?: (message: string) => void;
}): ConnectedCredentialHandle | undefined {
  const selection = selectCredentialHandle(input.handles, {
    provider: input.provider,
    capability: input.capability,
    ...(input.env[input.pinEnvName]?.trim()
      ? { pinnedHandle: input.env[input.pinEnvName]!.trim() }
      : {}),
  });
  const warn = input.warn ?? ((message: string) => console.warn(message));
  if (selection.reason === 'ambiguous') {
    warn(
      `${input.provider} lane refused to construct: ${selection.candidates.length} handles carry ${input.capability} `
      + `(${selection.candidates.join(', ')}). Set ${input.pinEnvName} to the handle this lane must read.`,
    );
  }
  if (selection.reason === 'pinned_missing') {
    warn(
      `${input.provider} lane refused to construct: ${input.pinEnvName} names a handle that is not registered with `
      + `${input.capability} (registered: ${selection.candidates.join(', ') || 'none'}).`,
    );
  }
  return selection.handle;
}

export interface XBookmarksConnectorStoreRuntime {
  store: LocalConnectorStore;
  /** The X user id every read of this runtime is addressed to. */
  providerUserId: string;
  sync: XBookmarksConnectorStoreSyncHandler;
  contentRecovery: XBookmarksContentRecoveryHandler;
}

/**
 * The X runtime as the operator routes see it: Sync now and content recovery
 * pass the lane's account check first, as every scheduler task does. The
 * window diagnostic writes nothing to the stores and stays unchecked, so it
 * can still look at a source that is stopped.
 */
export function accountCheckedXBookmarksRuntime(
  runtime: XBookmarksConnectorStoreRuntime,
  guard: SourceAccountGuard,
): XBookmarksConnectorStoreRuntime {
  const checked = <T>(run: () => Promise<T>): Promise<T> => runGuarded(guard, run).catch((error: unknown) => {
    // Only the check throws this; a run's own errors pass through unchanged.
    if (error instanceof SourceAccountChangedError) {
      throw new EmailSourceWorkerError(409, error.code, error.message);
    }
    throw error;
  });
  const { sync, contentRecovery } = runtime;
  return {
    ...runtime,
    sync: {
      syncHead: (request) => checked(() => sync.syncHead(request)),
      reconcile: (request) => checked(() => sync.reconcile(request)),
      ...(sync.diagnoseWindow ? { diagnoseWindow: sync.diagnoseWindow.bind(sync) } : {}),
      lastCompleteReconcileAt: () => sync.lastCompleteReconcileAt(),
      completeReconcileWatermark: () => sync.completeReconcileWatermark(),
      apiUsageStatus: () => sync.apiUsageStatus(),
    },
    contentRecovery: {
      recover: (request) => checked(() => contentRecovery.recover(request)),
    },
  };
}

export interface RefreshableXBookmarksConnectorStoreRuntime {
  store: LocalConnectorStore;
  runtimeForHandle(handle: ConnectedCredentialHandle | undefined): XBookmarksConnectorStoreRuntime | undefined;
}

export interface ReadwiseConnectorStoreRuntime {
  store: LocalConnectorStore;
  sync: ReadwiseConnectorStoreSyncHandler;
}

export interface RefreshableReadwiseConnectorStoreRuntime {
  store: LocalConnectorStore;
  /** The handler for the current usable handle; undefined without one. */
  syncForHandle(handle: ConnectedCredentialHandle | undefined): ReadwiseConnectorStoreSyncHandler | undefined;
  /** Unconditional build, kept for the boot-bound compatibility constructor. */
  syncFor(handle: ConnectedCredentialHandle | undefined): ReadwiseConnectorStoreSyncHandler;
}

export function createReadwiseConnectorStoreRuntime(options: {
  enabled: boolean;
  handle?: ConnectedCredentialHandle;
  embeddingProvider?: SourceEmbeddingProvider;
  account?: string;
  dbPath?: string;
  /** Test/owner injection; the runtime otherwise derives one durable counter. */
  requestBudget?: ReadwiseDailyRequestBudget;
  requestBudgetStatePath?: string;
  env?: Record<string, string | undefined>;
  /** The lane's per-tier stores over its store: every item is judged on its own. */
  tierSetFor: (store: LocalConnectorStore) => TieredStoreSet;
}): ReadwiseConnectorStoreRuntime | undefined {
  if (!options.enabled || !options.embeddingProvider) return undefined;
  const handle = options.handle;
  if (handle && !readwiseHandleUsable(handle)) return undefined;
  const lane = createRefreshableReadwiseConnectorStoreRuntime(options);
  if (!lane) return undefined;
  return { store: lane.store, sync: lane.syncFor(handle) };
}

/**
 * Keep the canonical Readwise store mounted independently of the API-key
 * grant, and bind the sync handler to whichever handle is current.
 *
 * The runtime used to be built once at boot from the handle registered then,
 * and the scheduler lane was enabled only while that boot handle was still
 * the current one, so a Readwise key connected after the worker started
 * logged `lane_disabled` on every pass until a restart (first install,
 * 2026-09-23). The scheduler now asks for the current handle's handler on
 * each registry refresh, as X does; the store and the durable day counter
 * stay singular across rebinds.
 */
export function createRefreshableReadwiseConnectorStoreRuntime(options: {
  enabled: boolean;
  embeddingProvider?: SourceEmbeddingProvider;
  account?: string;
  dbPath?: string;
  requestBudget?: ReadwiseDailyRequestBudget;
  requestBudgetStatePath?: string;
  env?: Record<string, string | undefined>;
  /** The lane's per-tier stores over its store, built once (P1c). */
  tierSetFor: (store: LocalConnectorStore) => TieredStoreSet;
}): RefreshableReadwiseConnectorStoreRuntime | undefined {
  const embeddingProvider = options.embeddingProvider;
  if (!options.enabled || !embeddingProvider) return undefined;
  const env = options.env ?? process.env;
  // Exactly one day counter per runtime, durable across restart. Constructing
  // it here (before the store) also keeps an invalid budget env from creating
  // the store file at all.
  const requestBudget = options.requestBudget
    ?? createReadwiseDailyRequestBudget({
      env,
      ...(options.requestBudgetStatePath ? { statePath: options.requestBudgetStatePath } : {}),
    });
  const store = createReadwiseConnectorStore(
    options.dbPath ?? resolvedStorePath(READWISE_SOURCE_ID, 'internal', env),
    env,
  );
  const tierSet = options.tierSetFor(store);
  const buildSync = (handle: ConnectedCredentialHandle | undefined): ReadwiseConnectorStoreSyncHandler =>
    createReadwiseConnectorStoreSyncHandler({
      store,
      embeddingProvider,
      tierSet,
      account: options.account?.trim() || handle?.accountRole?.trim() || 'personal',
      requestBudget,
      ...(env.OLYMPUS_SOURCE_INDEX_READWISE_CREDENTIAL_HANDLE?.trim()
        ? { credentialHandle: env.OLYMPUS_SOURCE_INDEX_READWISE_CREDENTIAL_HANDLE.trim() }
        : handle?.handle
          ? { credentialHandle: handle.handle }
          : {}),
      ...(env.OLYMPUS_SOURCE_INDEX_READWISE_API_V2_BASE_URL?.trim()
        ? { apiV2BaseUrl: env.OLYMPUS_SOURCE_INDEX_READWISE_API_V2_BASE_URL.trim() }
        : {}),
      ...(env.OLYMPUS_SOURCE_INDEX_READWISE_READER_API_V3_BASE_URL?.trim()
        ? { readerApiV3BaseUrl: env.OLYMPUS_SOURCE_INDEX_READWISE_READER_API_V3_BASE_URL.trim() }
        : {}),
      env,
    });
  let cachedKey: string | undefined;
  let cachedSync: ReadwiseConnectorStoreSyncHandler | undefined;
  return {
    store,
    syncFor: buildSync,
    syncForHandle(handle) {
      if (!handle || !readwiseHandleUsable(handle)) {
        cachedKey = undefined;
        cachedSync = undefined;
        return undefined;
      }
      const key = [handle.handle, handle.accountRole ?? ''].join('\0');
      if (cachedKey === key && cachedSync) return cachedSync;
      cachedSync = buildSync(handle);
      cachedKey = key;
      return cachedSync;
    },
  };
}

function readwiseHandleUsable(handle: ConnectedCredentialHandle): boolean {
  return handle.provider === 'readwise'
    && handle.allowedCapabilities.includes('readwise.sync')
    && handle.backendState?.status !== 'reauth_required';
}

export function createXBookmarksConnectorStoreRuntime(options: {
  enabled: boolean;
  handle?: ConnectedCredentialHandle;
  embeddingProvider?: SourceEmbeddingProvider;
  account?: string;
  dbPath?: string;
  usageStore?: LocalXBookmarksApiUsageStore;
  env?: Record<string, string | undefined>;
  /** The lane's per-tier stores over its store: every item is judged on its own. */
  tierSetFor: (store: LocalConnectorStore) => TieredStoreSet;
}): XBookmarksConnectorStoreRuntime | undefined {
  if (!xBookmarksRuntimeBinding(options)) return undefined;
  return createRefreshableXBookmarksConnectorStoreRuntime(options)?.runtimeForHandle(options.handle);
}

/**
 * Keep the canonical X store mounted independently of the OAuth grant while
 * binding every provider-reading capability to the current usable handle.
 * The scheduler calls runtimeForHandle on each registry refresh, so a renewed
 * grant can activate without a process restart and a removed/expired grant
 * produces no task. The cached runtime also preserves X's single-minter rule
 * across dashboard renders and adoption ticks.
 */
export function createRefreshableXBookmarksConnectorStoreRuntime(options: {
  enabled: boolean;
  embeddingProvider?: SourceEmbeddingProvider;
  account?: string;
  dbPath?: string;
  usageStore?: LocalXBookmarksApiUsageStore;
  reconcileStateStore?: LocalXBookmarksReconcileStateStore;
  env?: Record<string, string | undefined>;
  /** The lane's per-tier stores over its store, built once (P1c). */
  tierSetFor: (store: LocalConnectorStore) => TieredStoreSet;
}): RefreshableXBookmarksConnectorStoreRuntime | undefined {
  const embeddingProvider = options.embeddingProvider;
  if (!options.enabled || !embeddingProvider) return undefined;
  const env = options.env ?? process.env;
  const store = createXBookmarksConnectorStore(
    options.dbPath ?? resolvedStorePath(X_BOOKMARKS_SOURCE_ID, 'internal', env),
    env,
  );
  const tierSet = options.tierSetFor(store);
  let usageStore = options.usageStore;
  let reconcileStateStore = options.reconcileStateStore;
  let cachedKey: string | undefined;
  let cachedRuntime: XBookmarksConnectorStoreRuntime | undefined;
  return {
    store,
    runtimeForHandle(handle) {
      const binding = xBookmarksRuntimeBinding({
        enabled: options.enabled,
        ...(handle ? { handle } : {}),
        embeddingProvider,
        ...(options.account ? { account: options.account } : {}),
        env,
      });
      if (!binding) {
        cachedKey = undefined;
        cachedRuntime = undefined;
        return undefined;
      }
      const key = [binding.handle.handle, binding.principalAccount, binding.providerUserId].join('\0');
      if (cachedKey === key && cachedRuntime) return cachedRuntime;
      usageStore ??= new LocalXBookmarksApiUsageStore();
      reconcileStateStore ??= new LocalXBookmarksReconcileStateStore(
        resolvedRawPath(X_BOOKMARKS_SOURCE_ID, 'x-reconcile.sqlite', env, { usageDbPath: usageStore.dbPath }),
        env,
      );
      cachedRuntime = bindXBookmarksConnectorStoreRuntime({
        ...binding,
        store,
        usageStore,
        reconcileStateStore,
        env,
        tierSet,
      });
      cachedKey = key;
      return cachedRuntime;
    },
  };
}

function xBookmarksRuntimeBinding(options: {
  enabled: boolean;
  handle?: ConnectedCredentialHandle;
  embeddingProvider?: SourceEmbeddingProvider;
  account?: string;
  env?: Record<string, string | undefined>;
}): {
  handle: ConnectedCredentialHandle;
  embeddingProvider: SourceEmbeddingProvider;
  principalAccount: string;
  providerUserId: string;
} | undefined {
  const handle = options.handle;
  const env = options.env ?? process.env;
  const providerUserId = env.OLYMPUS_SOURCE_INDEX_X_USER_ID?.trim()
    || handle?.providerAccountId?.trim();
  if (
    !options.enabled
    || !handle
    || handle.provider !== 'x'
    || !handle.allowedCapabilities.includes('x.bookmarks.sync')
    || handle.backendState?.status === 'reauth_required'
    || !options.embeddingProvider
    || !providerUserId
  ) return undefined;
  return {
    handle,
    embeddingProvider: options.embeddingProvider,
    principalAccount: options.account?.trim() || handle.accountRole?.trim() || 'personal',
    providerUserId,
  };
}

function bindXBookmarksConnectorStoreRuntime(options: {
  handle: ConnectedCredentialHandle;
  embeddingProvider: SourceEmbeddingProvider;
  principalAccount: string;
  providerUserId: string;
  store: LocalConnectorStore;
  usageStore: LocalXBookmarksApiUsageStore;
  reconcileStateStore: LocalXBookmarksReconcileStateStore;
  env: Record<string, string | undefined>;
  tierSet: TieredStoreSet;
}): XBookmarksConnectorStoreRuntime {
  const env = options.env;
  // One broker instance owns both scheduled acquisition and operator recovery.
  // X rotates refresh tokens, so separate minters in separate processes can
  // revoke the worker's live session; keeping both paths inside this runtime
  // makes the single-minter rule structural.
  const credentialBroker = createEnvCredentialBroker({ env });
  const sync = createXBookmarksConnectorStoreSyncHandler({
    store: options.store,
    embeddingProvider: options.embeddingProvider,
    tierSet: options.tierSet,
    credentialHandle: options.handle.handle,
    account: options.principalAccount,
    userId: options.providerUserId,
    credentialBroker,
    ...(env.OLYMPUS_SOURCE_INDEX_X_API_BASE_URL?.trim()
      ? { apiBaseUrl: env.OLYMPUS_SOURCE_INDEX_X_API_BASE_URL.trim() }
      : {}),
    usageStore: options.usageStore,
    reconcileStateStore: options.reconcileStateStore,
    env,
  });
  const contentRecovery = createXBookmarksContentRecoveryHandler({
    store: options.store,
    tierLedger: options.tierSet.ledger,
    usageStore: options.usageStore,
    reconcileStateStore: options.reconcileStateStore,
    embeddingProvider: options.embeddingProvider,
    credentialHandle: options.handle.handle,
    credentialBroker,
    account: options.principalAccount,
    userId: options.providerUserId,
    ...(env.OLYMPUS_SOURCE_INDEX_X_API_BASE_URL?.trim()
      ? { apiBaseUrl: env.OLYMPUS_SOURCE_INDEX_X_API_BASE_URL.trim() }
      : {}),
    env,
  });
  return { store: options.store, providerUserId: options.providerUserId, sync, contentRecovery };
}

/**
 * The single gate every lane-building path passes through.
 *
 * Boot, the adoption tick and the dashboard's refresh callback all end up here,
 * including when a caller supplies its own handle list: one choke point is what
 * makes "a source the owner unpaired does not get a lane" true of every path
 * rather than of the one that happened to remember.
 */
function activeLaneHandles(
  handles: readonly ConnectedCredentialHandle[],
  env: Record<string, string | undefined>,
): ConnectedCredentialHandle[] {
  const registryPath = handleRegistryPathFromEnv(env, true);
  if (!registryPath) return [...handles];
  try {
    return withoutUnpairedLaneHandles(handles, registryPath);
  } catch (error) {
    console.warn(`Could not read the Olympus unpaired-source record: ${error instanceof Error ? error.message : String(error)}`);
    return [...handles];
  }
}

function readActiveConnectedHandles(env: Record<string, string | undefined>): ConnectedCredentialHandle[] {
  const registryPath = handleRegistryPathFromEnv(env, true);
  if (!registryPath) return [];
  try {
    // The registry alone is not the whole answer. A handle an Unpair could not
    // remove is still in this file, and building its lane at boot would quietly
    // undo the teardown; the unpaired record is what says so.
    return activeLaneHandles(
      readConnectedHandleRegistry(registryPath).handles
        .filter((handle) => handle.backendState?.status !== 'reauth_required'),
      env,
    );
  } catch (error) {
    console.warn(`Could not read Olympus handle registry for source activation: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('OLYMPUS_EMAIL_SOURCE_PORT must be an integer from 1 to 65535.');
  }
  return port;
}

function firstNonEmptyEnv(env: Record<string, string | undefined>, names: string[]): string | undefined {
  for (const name of names) {
    const value = optionalEnv(env, name);
    if (value) return value;
  }
  return undefined;
}

function requireVeniceApiKey(env: Record<string, string | undefined>): string {
  const apiKey = firstNonEmptyEnv(env, [
    'OLYMPUS_SOURCE_INDEX_VENICE_API_KEY',
    'VENICE_API_KEY',
    'API_KEY_VENICE',
    'Venice-API-Key',
  ]);
  if (!apiKey) {
    throw new Error('Venice analyst requires OLYMPUS_SOURCE_INDEX_VENICE_API_KEY, VENICE_API_KEY, API_KEY_VENICE, or Venice-API-Key in the assistant runtime.');
  }
  return apiKey;
}

function requireFileExtractionVeniceApiKey(
  env: Record<string, string | undefined>,
): string {
  const apiKey = firstNonEmptyEnv(env, [
    'OLYMPUS_FILE_EXTRACTION_REMOTE_API_KEY',
    'OLYMPUS_SOURCE_INDEX_VENICE_API_KEY',
    'VENICE_API_KEY',
    'API_KEY_VENICE',
    'Venice-API-Key',
  ]);
  if (!apiKey) {
    throw new Error(
      'Remote file extraction requires OLYMPUS_FILE_EXTRACTION_REMOTE_API_KEY or an approved shared Venice API-key environment reference.',
    );
  }
  return apiKey;
}

function requiredFileExtractionEnv(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when remote file extraction is enabled.`);
  return value;
}

async function resolveSecretRef(
  secretRef: string | undefined,
  env: Record<string, string | undefined>,
  label: string,
): Promise<string> {
  return resolveSecretRefSync(secretRef, env, label) ?? (() => {
    throw new Error(`${label} secretRef did not resolve.`);
  })();
}

function resolveSecretRefSync(
  secretRef: string | undefined,
  env: Record<string, string | undefined>,
  label: string,
  options: {
    bootSecretResolver?: WorkerBootSecretResolver;
    affectedProfiles?: string[];
    affectedCapabilities?: string[];
    profileBindings?: CredentialReadinessBinding[];
  } = {},
): string | undefined {
  const ref = secretRef?.trim();
  if (!ref) {
    if (options.bootSecretResolver) {
      return options.bootSecretResolver.resolveSync(undefined, env, {
        displayName: label,
        ...(options.affectedProfiles ? { affectedProfiles: options.affectedProfiles } : {}),
        ...(options.affectedCapabilities ? { affectedCapabilities: options.affectedCapabilities } : {}),
        ...(options.profileBindings ? { profileBindings: options.profileBindings } : {}),
      });
    }
    throw new Error(`${label} requires a secretRef; inline secrets are not allowed in sovereignty.json.`);
  }
  if (options.bootSecretResolver) {
    return options.bootSecretResolver.resolveSync(ref, env, {
      displayName: label,
      ...(options.affectedProfiles ? { affectedProfiles: options.affectedProfiles } : {}),
      ...(options.affectedCapabilities ? { affectedCapabilities: options.affectedCapabilities } : {}),
      ...(options.profileBindings ? { profileBindings: options.profileBindings } : {}),
    });
  }
  const value = resolveSecretRefValueSync(ref, { env });
  if (!value) {
    throw new Error(`${label} secretRef did not resolve.`);
  }
  return value;
}

function bootSecretOptions(
  bootSecretResolver: WorkerBootSecretResolver | undefined,
  affectedProfiles: string[],
  affectedCapabilities: string[],
  profile?: { id: string; profile: SovereigntyModelProfile },
): {
  bootSecretResolver?: WorkerBootSecretResolver;
  affectedProfiles: string[];
  affectedCapabilities: string[];
  profileBindings?: CredentialReadinessBinding[];
} {
  return {
    ...(bootSecretResolver ? { bootSecretResolver } : {}),
    affectedProfiles,
    affectedCapabilities,
    ...(profile
      ? {
          profileBindings: [{
            profileId: profile.id,
            configFingerprint: credentialConfigFingerprint(profile.id, profile.profile),
          }],
        }
      : {}),
  };
}


function optionalEnv(env: Record<string, string | undefined>, name: string): string | undefined {
  const value = env[name]?.trim();
  return value || undefined;
}




export function commaSeparatedEnv(value: string | undefined): string[] {
  return (value ?? '')
    .split(/,|\|\|/)
    .map((item) => item.trim())
    .filter(Boolean);
}

if (import.meta.main) {
  await main();
}

export interface ConnectorStoreMount {
  store: LocalConnectorStore;
  principal?: ConnectorStoreDeclaredPrincipal;
  chatPrincipal?: ConnectorStoreChatPrincipal;
}

export interface ConnectorStoreMountParsingOptions {
  reportFailure?: (message: string) => void;
  collidingStores?: readonly LocalConnectorStore[];
  /**
   * The corpus registry's corpora: a declaration names no source, so its
   * account is the source registered for its corpus (`storageAccountForCorpus`).
   */
  registeredCorpora?: ReadonlyArray<{ corpusId: string; sourceId: string }>;
  /**
   * The source each known store file belongs to (the data lifecycle's
   * inventory), found by the file rather than the path's spelling. A
   * declaration over another source's file opens under that source's account,
   * so a lane withheld because its account is being deleted cannot be
   * reopened under another corpus id or another spelling of its path.
   */
  storeOwner?: StoreFileOwner;
}

interface ValidatedConnectorStoreMountDeclaration {
  /** Absent, or ignored, for a source whose stores the engine places (core/source-placement.ts `hasFolderLayout`). */
  dbPath?: string;
  corpusId: string;
  family: Parameters<typeof defineConnectorCorpus>[0]['family'];
  trustDomain: Parameters<typeof defineConnectorCorpus>[0]['trustDomain'];
  principal?: ConnectorStoreDeclaredPrincipal;
  chatPrincipal?: ConnectorStoreChatPrincipal;
}

export function parseConnectorStoreMountsFromEnv(
  raw: string | undefined,
  options: ConnectorStoreMountParsingOptions = {},
): ConnectorStoreMount[] {
  const value = raw?.trim();
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON must be valid JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON must be a JSON array.');
  }

  const reportFailure = options.reportFailure ?? ((message: string) => console.error(message));
  const collidingStoresByCorpusId = new Map(
    (options.collidingStores ?? []).map((store) => [store.corpusId, store]),
  );
  // The resource being fenced is the SQLite file, and corpusId is the field an
  // operator varies when adding a mount. Keyed on corpusId alone, a new id over
  // an existing dbPath skips the identity check entirely and opens a second
  // handle that relabels the same rows with a different family/trustDomain.
  const ownerCorpusIdByDbPath = new Map(
    (options.collidingStores ?? []).map((store) => [store.dbPath, store.corpusId]),
  );
  const declarations: ValidatedConnectorStoreMountDeclaration[] = [];
  // Validate every declaration before opening any SQLite store. A malformed
  // later entry therefore cannot strand a handle opened for an earlier one.
  for (const [index, entry] of parsed.entries()) {
    const declaredCorpusIdValue = entry && typeof entry === 'object'
      ? (entry as Record<string, unknown>).corpusId
      : undefined;
    const declaredCorpusId = typeof declaredCorpusIdValue === 'string'
      ? declaredCorpusIdValue.trim()
      : '';
    try {
      declarations.push(validateConnectorStoreMountDeclaration(entry));
    } catch (error) {
      const label = declaredCorpusId || `entry #${index + 1}`;
      const detail = error instanceof Error ? error.message : String(error);
      reportFailure(`Connector-store mount ${label} skipped: ${detail}`);
    }
  }

  const mounts: ConnectorStoreMount[] = [];
  for (const declaration of declarations) {
    try {
      const collidingStore = collidingStoresByCorpusId.get(declaration.corpusId);
      // A source whose stores the engine places names no path here (source
      // storage step 6): its declaration only adds a principal to the store
      // its lane opened, and a dbPath it carries is ignored.
      if (hasFolderLayout(storageAccountForCorpus(declaration, options.registeredCorpora).sourceId)) {
        if (!collidingStore) {
          throw new Error('its source keeps its stores where Olympus places them; a declaration can only add a principal to the store its lane opened, and that lane is not open.');
        }
        const { dbPath: _ignored, ...placed } = declaration;
        assertConnectorStoreMountIdentity(placed, collidingStore);
        mounts.push({
          store: collidingStore,
          ...(declaration.principal ? { principal: declaration.principal } : {}),
          ...(declaration.chatPrincipal ? { chatPrincipal: declaration.chatPrincipal } : {}),
        });
        continue;
      }
      if (!declaration.dbPath) throw new Error('Connector store entries require dbPath, corpusId, family, trustDomain.');
      if (collidingStore) assertConnectorStoreMountIdentity(declaration, collidingStore);
      const pathOwnerCorpusId = ownerCorpusIdByDbPath.get(declaration.dbPath);
      if (pathOwnerCorpusId !== undefined && pathOwnerCorpusId !== declaration.corpusId) {
        throw new Error(
          `dbPath ${JSON.stringify(declaration.dbPath)} is already mounted as corpus ${JSON.stringify(pathOwnerCorpusId)}.`,
        );
      }
      // An account that may not be opened throws here, and the declaration
      // is skipped and reported like any other that cannot mount.
      const owner = options.storeOwner?.(declaration.dbPath);
      const account = owner ? { sourceId: owner } : storageAccountForCorpus(declaration, options.registeredCorpora);
      const store = collidingStore ?? openConnectorStore(account, {
        dbPath: declaration.dbPath,
        corpusId: declaration.corpusId,
        family: declaration.family,
        trustDomain: declaration.trustDomain,
      });
      ownerCorpusIdByDbPath.set(declaration.dbPath, declaration.corpusId);
      mounts.push({
        store,
        ...(declaration.principal ? { principal: declaration.principal } : {}),
        ...(declaration.chatPrincipal ? { chatPrincipal: declaration.chatPrincipal } : {}),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      reportFailure(`Connector-store mount ${declaration.corpusId} skipped: ${detail}`);
    }
  }
  return mounts;
}

// Exact string equality on dbPath is deliberate (R49). Normalizing
// (realpath/resolve) could silently ACCEPT a declaration for a different
// file behind a symlink or `..` variant — the exact defect this reconcile
// exists to prevent. A lexically divergent path to the same file fails
// closed and loud: the declaration is skipped whole and its principal
// never registers.
function assertConnectorStoreMountIdentity(
  declaration: ValidatedConnectorStoreMountDeclaration,
  store: LocalConnectorStore,
): void {
  const mismatches = [
    ...(declaration.dbPath === undefined || declaration.dbPath === store.dbPath
      ? []
      : [`dbPath ${JSON.stringify(declaration.dbPath)} does not match lane ${JSON.stringify(store.dbPath)}`]),
    ...(declaration.family === store.family
      ? []
      : [`family ${JSON.stringify(declaration.family)} does not match lane ${JSON.stringify(store.family)}`]),
    ...(declaration.trustDomain === store.trustDomain
      ? []
      : [`trustDomain ${JSON.stringify(declaration.trustDomain)} does not match lane ${JSON.stringify(store.trustDomain)}`]),
  ];
  if (mismatches.length > 0) {
    throw new Error(`declaration conflicts with the lane store: ${mismatches.join('; ')}.`);
  }
}

function validateConnectorStoreMountDeclaration(entry: unknown): ValidatedConnectorStoreMountDeclaration {
  if (!entry || typeof entry !== 'object') {
    throw new Error('Each connector store entry must be an object.');
  }
  const record = entry as Record<string, unknown>;
  const dbPath = typeof record.dbPath === 'string' ? record.dbPath.trim() : '';
  const corpusId = typeof record.corpusId === 'string' ? record.corpusId.trim() : '';
  const family = typeof record.family === 'string' ? record.family.trim() : '';
  const trustDomain = typeof record.trustDomain === 'string' ? record.trustDomain.trim() : '';
  if (!corpusId || !family || !trustDomain) {
    throw new Error('Connector store entries require dbPath, corpusId, family, trustDomain.');
  }
  if (dbPath && !isAbsolute(dbPath)) {
    throw new Error('Connector store dbPath must be absolute.');
  }
  // Both enums are checked before the casts below. Every secure gate in this
  // worker is exact equality against 'secure_local', so a typo'd domain does
  // not degrade the mount — it silently leaves the secure band entirely.
  if (!isDeclarableSourceFamily(family)) {
    throw new Error(
      `Connector store family must be one of: ${SOURCE_FAMILIES.join(', ')} (or an "x-" extension id).`,
    );
  }
  if (!isDeclarableSourceTrustDomain(trustDomain)) {
    throw new Error(
      `Connector store trustDomain must be one of: ${SOURCE_TRUST_DOMAINS.join(', ')} (or an "x-" extension id).`,
    );
  }
  const hasPrincipalProvider = Object.prototype.hasOwnProperty.call(record, 'principalProvider');
  const hasPrincipalAccountScope = Object.prototype.hasOwnProperty.call(record, 'principalAccountScope');
  if (hasPrincipalProvider !== hasPrincipalAccountScope) {
    throw new Error('Connector store principal identity requires both principalProvider and principalAccountScope.');
  }
  let chatPrincipal: ConnectorStoreChatPrincipal | undefined;
  let principal: ConnectorStoreDeclaredPrincipal | undefined;
  if (hasPrincipalProvider && hasPrincipalAccountScope) {
    principal = canonicalConnectorStoreChatPrincipal(
      record.principalProvider,
      record.principalAccountScope,
    );
    if (family === 'chat') chatPrincipal = principal;
  }
  return {
    ...(dbPath ? { dbPath } : {}),
    corpusId,
    family: family as Parameters<typeof defineConnectorCorpus>[0]['family'],
    trustDomain: trustDomain as Parameters<typeof defineConnectorCorpus>[0]['trustDomain'],
    ...(principal ? { principal } : {}),
    ...(chatPrincipal ? { chatPrincipal } : {}),
  };
}

function isSourceIndexExtensionId(value: string): boolean {
  return value.startsWith('x-') && value.length > 2;
}

function isDeclarableSourceFamily(value: string): boolean {
  return (SOURCE_FAMILIES as readonly string[]).includes(value) || isSourceIndexExtensionId(value);
}

function isDeclarableSourceTrustDomain(value: string): boolean {
  return (SOURCE_TRUST_DOMAINS as readonly string[]).includes(value) || isSourceIndexExtensionId(value);
}

function mergeConnectorStores(stores: readonly LocalConnectorStore[]): LocalConnectorStore[] {
  const byCorpusId = new Map<string, LocalConnectorStore>();
  for (const store of stores) {
    if (!byCorpusId.has(store.corpusId)) {
      byCorpusId.set(store.corpusId, store);
    }
  }
  return [...byCorpusId.values()];
}

/** A Google Drive file's own page: https on drive.google.com or docs.google.com, nothing else. */
function googleFilePage(locator: string): boolean {
  try {
    const url = new URL(locator);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (url.hostname === 'drive.google.com' || url.hostname === 'docs.google.com');
  } catch {
    return false;
  }
}
