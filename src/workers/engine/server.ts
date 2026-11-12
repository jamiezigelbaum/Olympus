import { createDashboardPeople } from './dashboard/dashboard-people.ts';
import { PeopleIndexRefresher } from '../../core/people-index.ts';
import { adoptExistingCloudApproval, carryCloudJudgeApproval, createJudgeSetup } from '../classification/judge-setup.ts';
import { createOwnerTierItems, getOwnerTierItem, type OwnerTierItemsContext } from '../classification/tier-owner-items.ts';
import { createJudgeCheck } from '../classification/judge-check.ts';
import { prepareBuiltInRerankerFromEnv } from '../source-index/built-in-reranker.ts';
import { JudgeSpending, judgeSpendingPath } from '../classification/judge-spending.ts';
import { JudgeObservations, SecondRoundConfirmed, SecondRoundSweep, judgeObservationsPath, judgeSecondRoundConfirmedPath, judgeSecondRoundStatePath, observedJudge, secondRoundJudge } from '../classification/judge-second-round.ts';
import { DEFAULT_VENICE_JUDGE_CONCURRENT_CALLS } from '../classification/judge-pacing.ts';
import { type SnifferModel } from '../classification/sniffer-decision.ts';
import { macComputerSetupView, saveMacComputerUseChoice } from '../../core/engine-service.ts';
import { release, totalmem } from 'node:os';
import { createPrivacyQuestionEngine } from '../classification/privacy-questions.ts';
import { snifferDecisionBar, snifferPromptVersions } from '../classification/sniffer.ts';
import { withFirstRunPrivacyGate } from '../first-run-privacy-gate.ts';
import { engineServicePaths, setEngineRemoteAccessEnabled, readEngineLogs, restartEngine, inspectEngine, waitForQuietEngine } from '../../core/engine-service.ts';
import { privacyChoicePending } from '../../core/first-run-privacy.ts';
import { LocalModelDiscovery, saveLocalAnswerModel } from '../../core/local-model-discovery.ts';
import { saveFirstRunPrivacyChoice, savePrivateAnswerMode } from '../../core/first-run-privacy.ts';
import { createSpoolChangeSubscription } from '../messaging-spool-wake.ts';
import { resolvedStorePath, retiredPathSettings } from '../../core/source-placement.ts';
import { DASHBOARD_PRIVATE_ANSWERS_COPY as PRIVATE_ANSWERS_COPY } from '../dashboard/vocabulary.ts';
import { anonymousInboxConnectionId, localInboxLabel, askWithAnonymousInbox } from './runtime/local-private-answers.ts';
import { installWorkerShutdownSignals } from '../../core/worker-shutdown.ts';
import { connectLinuxOwnerBridgeHost, OWNER_BRIDGE_HOST_ENV } from '../../core/linux-owner-bridge-host.ts';
import { createUpdateChecker, runningOlympusVersion } from '../../core/update-check.ts';
import { createSelfUpdater } from '../../core/self-update.ts';
import { parseOlympusOpenUrl, openTargetToken } from '../../core/open-targets.ts';
import { manageLinuxOwnerBridge, DESKTOP_OWNER_OPEN_PATH } from '../../core/linux-owner-bridge.ts';
import { linuxGraphicalSessionReadinessAsync, openLinuxDesktopPath } from '../../core/linux-desktop-opener.ts';
import { mintDashboardOpeningUrl } from '../../core/dashboard-opening.ts';
import { workerFetch } from '../../core/worker-transport.ts';
import { linuxModelReadiness } from '../../core/linux-model-readiness.ts';
import { withEngineWorkerAdmission, EngineMaintenanceInProgressError } from '../../core/engine-maintenance.ts';
import { prepareWorkerSocket, bindWorkerSocket, releaseSystemdWorkerSocket, workerSocketPath, workerSocketServe } from '../../core/worker-transport.ts';
import { modelInstallFailedReason, modelInstallSpaceToFree } from '../../core/model-install-failure.ts';
import { accountFromGoogleHandle } from '../google-connectors/classification.ts';
import { olympusPackageRoot } from '../../core/package-root.ts';
import {
  type MessagingCaptureStatus,
} from '../../core/messaging-capture.ts';
import { whatsappBridgePathForPackage } from '../../core/messaging-pairing.ts';
import { unlinkHelper } from './dashboard/dashboard-messaging-service.ts';
import { ModelSetupService, requiredModelProfiles, type ModelCredentialState } from '../../core/model-setup.ts';
import { workerRestartsItself, type ModelKeyReloadRequest, type WorkerLaunch } from '../../core/model-key-reload.ts';
import { connectGeminiApiKey, connectPublicApiKeySource } from '../../core/connect.ts';
import { environmentWithWorkerSetupEnv, readWorkerSetupEnv } from '../../core/worker-auth.ts';
import { remoteOpenInstructions, resolveServerMode, resolveAgentApprovalHost } from '../../core/remote-open.ts';
import { loadOrCreateDashboardSessionSecret } from '../../core/dashboard-session-secret.ts';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createFileExtractionRuntime,
  createRefreshableFileExtractionRuntime,
  pdfExtractionLanes,
  fileExtractionCorporaRoster,
  connectorStoreExtractionCandidateReader,
  parseFileExtractionCorporaEnv,
} from './runtime/file-extraction-runtime.ts';
import { createExtractionReadinessLedger } from '../file-extraction/readiness-ledger.ts';
import { NO_EXTRACTION_JOB_OUTCOME, createUnreadableFiles, createUnreadableVerdict } from '../file-extraction/unreadable-files.ts';
import { VeniceVlmClient } from '../file-extraction/extractors/venice-client.ts';
import { parseOcrEnginePreference } from '../file-extraction/extractors/apple-vision-ocr.ts';
import { EmailSourceWorkerError } from './http/worker-responses.ts';
import { createEmailSourceWorker } from './index.ts';
import { dashboardSourceSyncNotSupportedError } from './http/dashboard-source-requests.ts';
import { defineGmailSecureLocalCorpus, defineInternalEmailCorpus } from '../google-connectors/corpora.ts';
import type { ConnectorStoreDeclaredPrincipal } from './http/connector-store-search-request.ts';
import {
  createAnalystSourceIndexAnswerHandler,
  readPrivateEvidenceItem,
  checkPrivateEvidenceItems,
  guardSourceAnswerEvidence,
  probePrivateMatch,
  searchPrivateEvidence,
  searchReleasedEvidence,
} from '../source-index/analyst-answer.ts';
import { SecureAnalystPoolState, parseSecureAnalystPoolLastLegTimeoutMs } from '../source-index/analyst-pool.ts';
import {
  createFileSourceAnswerLatencyLog,
  resolveSourceAnswerLatencyLogPath,
} from '../source-index/answer-latency-log.ts';
import type { SourceIndexAnswerRequest } from '../source-index/answer-types.ts';
import {
  createSourceIndexStatusHandler,
  DASHBOARD_READINESS_LEDGER_MAX_AGE_MS,
  type SourceIndexStatusRetrievalAvailability,
} from '../source-index/status.ts';
import {
  dashboardOwnerSessionCheck,
  resolveWorkerBindHost,
  warnIfWorkerAuthDisabled,
  withWorkerBearerAuth,
  workerAuthTokenFromEnv,
} from '../http.ts';
import { createAnalyst, type AnalystModelRequest } from '../../core/analyst.ts';
import {
  builtInTranscriptionDashboardState,
  builtInTranscriptionEnabled,
  readBuiltInTranscriptionStatusFile,
} from '../source-index/built-in-reasoning/transcription-model.ts';
import { runningBuiltInTranscriber, sharedBuiltInTranscriber, wireBuiltInTranscriptionAtBoot } from '../file-extraction/extractors/built-in-transcriber.ts';
import {
  answerPrivately,
  builtInPrivateModelStatus,
  BUILT_IN_ANALYST_MODEL_ENV,
  withBuiltInFallback,
} from '../../core/analyst-built-in.ts';
import { createDelphiAnalystModel } from '../../core/analyst-delphi.ts';
import { createOpenClawInferAnalystModel } from '../../core/analyst-openclaw-infer.ts';
import {
  createVeniceAnalystModel,
} from '../../core/analyst-venice.ts';
import {
  createVenicePrivacyCategoryResolver,
  readVeniceTextCatalogModels,
} from '../../core/venice-model-catalog.ts';
import { builtInModelEnvValue, readModelChoices, resolveVeniceStrongest } from '../../core/model-choices.ts';
import { CONSULT_CHATGPT_FRONTIER_MODEL_DEFAULT } from '../../core/consult-settings.ts';
import { createModelChoicesBackend, LOCAL_PROFILE_ID, VENICE_PROFILE_ID } from './runtime/model-choices-backend.ts';
import { createAnalystQueryPlanner } from '../../core/query-planner.ts';
import {
  claudeAppEnabled,
  loadWorkerConfig,
  parseLane,
  readOpenClawPluginRemote,
  parseModelProfile,
  parseOptionalBooleanEnv,
} from '../../core/config.ts';
import { DelphiClient } from '../../core/delphi.ts';
import {
  describeSovereigntyPolicy,
  isPublicTierRetired,
  isStandaloneEngineProcess,
  validateSovereigntyConfig,
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
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_SOURCE_ID,
  GOOGLE_DRIVE_SOURCE_ID,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
  GoogleDailyRequestBudget,
  GoogleGmailSourceConnector,
  createGmailConnectorStoreSyncHandler,
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
  READWISE_SOURCE_ID,
  defineReadwiseLibraryCorpus,
} from '../readwise/index.ts';
import {
  X_BOOKMARKS_CORPUS_ID,
  X_BOOKMARKS_SOURCE_ID,
  defineXBookmarksCorpus,
} from '../x-bookmarks/index.ts';
import {
  DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
  DROPBOX_FILES_SOURCE_ID,
  defineDropboxFilesCorpus,
  createDropboxConnectorStore,
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
  createLocalFilesConnectorStore,
  createLocalFilesTierLane,
  defineLocalFilesCorpus,
  localFilesWatchDir,
} from '../local-files/store.ts';
import { createLocalFilesOwnRootsCleanup, createLocalFilesOwnRootsRecovery } from '../local-files/own-roots-cleanup.ts';
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
import { accountStoreNames } from '../../core/olympus-layout.ts';
import { ARCHIVE_IMPORTS_SOURCE_ID } from '../archive-import/state.ts';
import { createArchiveExtractionRuntime } from '../archive-import/extraction-runtime.ts';
import { createArchiveImportsSchedulerSource } from '../archive-import/scheduler-source.ts';
import type { ExtractorRegistryConfig } from '../file-extraction/types.ts';
import { createLocalFilesSourceConnector } from '../local-files/connector.ts';
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
  STATUS_COUNTS_MAX_AGE_MS,
  type LocalConnectorStore,
  connectorStoreReadableNow,
  defineConnectorCorpus,
  type ConnectorStoreSearchFilters,
} from '../connector-store/index.ts';
import { canonicalConnectorStoreChatPrincipal } from '../connector-store/principal.ts';
import { createSourceAnswerLanes } from './runtime/source-answer-lanes.ts';
import type { ConnectorStoreStatusScope } from '../connector-store/local-index.ts';
import type { ExtractionUnreadableItem } from '../file-extraction/job-store.ts';
import { gmailInternalStoreStatusScope, gmailPrivateStoreStatusScope } from '../email-source/gmail-status-scope.ts';
import {
  TIER_DOMAIN_ORDER,
  onDemandTierStore,
  tieredStoreSetLedgerPath,
  rehomeChatLaneOverrides,
  type ExistingStoreTierLane,
  type OnDemandTierStore,
  type TieredStoreSet,
} from '../connector-store/tiered-store-set.ts';
import { telegramArchiveTarget } from '../telegram-messages/archive-target.ts';
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
import { createPendingGovernance, createReleaseTierCheck, createTierVisibilityGate, type TierVisibilityScope } from '../connector-store/tier-visibility.ts';
import { judgeBoosts } from '../classification/judge-boost.ts';
import { secretLocationsPathForStore, type SecretLocationsIndex } from '../classification/secret-locations.ts';
import {
  enableSourceRegistryAdoption,
  openConnectorStore,
  openSecretLocations,
  recordAccountPlacement,
  recordProviderAccount,
  type StorageAccount,
} from '../../core/source-storage.ts';
import { recordedProviderAccount } from '../../core/provider-account-history.ts';
import { takeWorkerDataOwnerLock, type HeldDataOwnerLock } from '../../core/data-owner-lock.ts';
import { exportOlympusData, lifecycleStoreFileOwner } from '../../data-lifecycle.ts';
import { TierLedger, TierLedgerSchemaError, type TierLedgerIdentity } from '../classification/tier-ledger.ts';
import { resolveSecretRefValueSync } from '../../core/secret-store.ts';
import {
  WorkerBootSecretResolver,
} from '../credential-degradation.ts';
import {
  builtInEmbeddingOnly,
  isApprovedSecureSourceEmbeddingProvider,
  type SourceEmbeddingProvider,
} from '../source-index/embeddings.ts';
import {
  BuiltInSourceEmbeddingProvider,
  builtInEmbeddingDashboardState,
  loadedBuiltInEmbedding,
} from '../source-index/built-in-embedding/provider.ts';
import { readBuiltInEmbeddingStatus } from '../source-index/built-in-embedding/assets.ts';
import { LocalWorkPacer, embedsOnThisComputer, systemIdlePowerProbe } from '../local-pacing.ts';
import { builtInEmbeddingModel } from '../source-index/built-in-embedding/manifest.ts';
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
import { defaultSourceDashboardHistoryDbPath, type SourceDashboardViewModel } from '../source-dashboard.ts';
import type { DashboardPanelTools } from './dashboard/dashboard-panel-tools.ts';
import { readEmbeddingRuntime } from '../dashboard/embedding-runtime.ts';
import {
  SqliteSourceIngestionLedgerStore,
  buildSourceIngestionLedgerSnapshot,
} from '../source-ingestion-ledger.ts';
import {
  handleRegistryPathFromEnv,
  type ConnectedCredentialHandle,
} from '../credential-broker/connected-handles.ts';
import {
  FileSourceScopeAuthority,
  createScopeBoundGoogleDriveContentScope,
  createScopeBoundDropboxContentScope,
  dropboxNamesOnlyByOwner,
  fileSourceScopeContentFilters,
  fileSourceScopeDropboxPolicy,
  fileSourceScopeMetadataEnabled,
  fileSourceScopeMetadataFilters,
  rebindRestoredFileScope,
  scopeBoundEmbeddingProvider,
  scopeBoundSchedulerSource,
  gmailConnectorScopeFromApproval,
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
  gmailArchiveTarget,
  gmailHoldsImportedHistory,
  gmailItemAccountScope,
} from '../google-connectors/gmail-archive-target.ts';
import { gmailHeaderMatch } from '../google-connectors/gmail-header-match.ts';
import { planStoreEmbedding } from '../connector-store/embedding-plan.ts';
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
  guardAccountBoundLanes,
  createSourceAccountGuard,
  runExclusiveForSource,
  type SourceAccountGuard,
  type SourceAccountGuardOptions,
} from '../source-account-guard.ts';
import { compareProviderAccounts, dropboxOwnRootFolderIds, dropboxOwnsOneOfFolders, googleAccountIdFromAddress, type AccountBoundProvider } from '../../core/provider-account-identity.ts';
import type { AccountBoundSourceId } from '../../core/source-account-binding.ts';
import { GoogleRequestBudgetError } from '../google-connectors/request-budget.ts';
import { defaultGmailRequestBudgetStatePath } from '../google-connectors/gmail.ts';
import { MAIL_SCOPE_WINDOW_LABELS, defaultMailScopeSelection, mailScopeDraftView, mailScopeFromDraft } from '../../core/mail-source-scope.ts';
import type { OlympusMailScopeDraft } from '../../control-ui-contract.ts';
import {
  createEvernoteNotebookScopeBrowser,
  createFileScopeBrowser,
  registerFileScopeBrowserFactory,
  unregisterFileScopeBrowserFactory,
  type SourceFolderScopeBrowser,
} from '../source-scope-browser.ts';
import { configureInstalledTierClassification } from '../classification/installed-tier-classification.ts';
import { type SnifferLane } from '../classification/sniffer-lane.ts';
import { registerBuiltInPrivateModel, registeredBuiltInPrivateModel, resolveJudgeChoiceRuntime } from '../classification/built-in-sniffer.ts';
import {
  createAnswerActivity,
  createLocalModelActivity,
  runBackgroundInference,
  runClassificationInference,
  localModelResourceKey,
} from '../answer-activity.ts';
import { privacyOwnerContext } from '../classification/privacy-profile.ts';
import { TierSnifferService, tierSnifferServiceEnv } from '../classification/sniffer-service.ts';
import { SNIFFER_MAX_CONCURRENT_CALLS, completeAfterSlot } from '../classification/sniffer-resolver.ts';
import { approveClassifier, resolveClassificationLedgerPath, readClassificationLedger, isClassifierApproved } from '../classification-ledger.ts';
import { resolveTierMigrationPaths, tierMigrationStatusSummary } from '../classification/tier-migration.ts';
import { resolveEmbeddingLedgerPath } from '../embedding-ledger.ts';
import { ingestionTurn, startCpuSampleLog } from '../control-path-headroom.ts';
import { beginBootProgress, finishBootProgress, reportBootStep } from '../../core/boot-progress.ts';
import { ENGINE_BACKGROUND_INSTANCE_ENV, engineRoleFromEnv } from '../../core/engine-split.ts';
import { forbidWritableStoreOpens } from '../../core/store-write-guard.ts';
import {
  createEngineFront,
  createEngineFrontRoutes,
  createFrontGate,
  OwnerBusyMarks,
  engineBackgroundSocketFromEnv,
  engineStatusSnapshotPath,
  startEngineBackgroundServer,
  restartAfterFront,
  startEngineBackgroundStatus,
  waitForEngineBackground,
  type EngineFront,
} from '../engine-split/runtime.ts';
import { forwardedRecordId, forwardedRequestToRequest, responseToForwarded, tagForwardedRequest, type EngineForwardedRequest } from '../engine-split/commands.ts';
import { frontCaptureRuntime, frontCaptureStop, frontDataExport, frontJudgeBoost, frontJudgeState, frontModelReload, frontSetItemPrivate, frontUnreadableFiles } from '../engine-split/front-state.ts';
import { readEngineStatusSnapshot, type EngineManualSyncRun } from '../engine-split/snapshot.ts';
import { engineRssRestartsFrom, startEngineRssRestart } from '../engine-split/rss-restart.ts';
import { createFrontScheduler } from '../engine-split/front-scheduler.ts';
import { createFrontDashboardHistory, openWritableDashboardHistory } from '../engine-split/front-history.ts';
import { tierSetForLedger } from '../connector-store/tier-set-registry.ts';
import { startSupersededSweepTicker } from '../connector-store/tier-auto-prune-sweep.ts';
import { remoteAccessFromStatus, type DashboardAgentConnectionsBackend } from '../agent-connections.ts';
import { applyPendingRestoreAtBoot, createBackupService, defaultBackupServicePaths } from '../backup-service.ts';
import { createDashboardRemoteAccessControl, createGatewayRemoteAccessConfigWriter, createStandaloneRemoteAccessControl, createDashboardEngineRestart } from '../remote-access-control.ts';
import {
  deleteMarkedAccountsAtBoot,
  replaceEmptyAccountsAtBoot,
  moveAccountsAtBoot,
  workerTierLedgerProblem,
  reportRehomedChatOverrides,
  openPeopleIndexOrUndefined,
  PEOPLE_INDEX_FIRST_REFRESH_MS,
  PEOPLE_INDEX_CHECK_MS,
  lazySecretStore,
  GMAIL_ATTACHMENT_READER_REUSE_MS,
  SOURCE_STATUS_PUBLISH_MIN_INTERVAL_MS,
} from './runtime/boot-storage.ts';
import {
  parsePort,
  sourceIndexSemanticRelevanceBarFromEnv,
  accountFromDropboxCredentialHandle,
  parseOptionalTimeoutSecondsOrNone,
  parseOptionalPositiveInteger,
  requireFileExtractionVeniceApiKey,
  requiredFileExtractionEnv,
  createFileExtractionLocalVlmClientFromEnv,
  sourceIndexTelegramAccountFromEnv,
  parseOptionalNonNegativeInteger,
  parseRequiredTimeoutSeconds,
  parseOptionalTokenCount,
  parseSecureDerivativeDefault,
  requireVeniceApiKey,
  parseVeniceReasoningEffort,
  parseVeniceThinkingMode,
} from './runtime/environment.ts';
import {
  loadSourceWorkerSovereignty,
  createSourceIndexEmbeddingProviderFromSovereignty,
  createSourceIndexEmbeddingProviderFromEnv,
  createCloudSourceIndexEmbeddingProviderFromEnv,
  registerConnectorStoreEmbeddingLane,
  storeServedByMeaning,
  storeEmbeddingScope,
  sourceStoresCouldEmbed,
} from './runtime/embedding-providers.ts';
import { createWorkerSharedBuiltInModel, createTierSnifferModel, stopBuiltInModelOnShutdown } from './runtime/judging-models.ts';
import {
  createEmailSourceConnectorFromEnv,
  createRefreshableReadwiseConnectorStoreRuntime,
  createRefreshableXBookmarksConnectorStoreRuntime,
  type XBookmarksConnectorStoreRuntime,
  accountCheckedXBookmarksRuntime,
} from './runtime/source-runtimes.ts';
import {
  readActiveConnectedHandles,
  selectedSourceCredentialHandle,
  sourceIndexLaneEnabled,
  sourceIndexLaneAccountDecision,
  sourceIndexLaneStorageDecision,
  activeCredentialHandle,
  sourceAccountMountable,
  connectorStoreLaneHandle,
  activeLaneHandles,
  startApprovedSourceRun,
  sourceIndexLaneStartupLog,
} from './runtime/source-lanes.ts';
import {
  createWorkerMessagingCaptureOwnership,
  type WorkerMessagingCaptureSupervisor,
  reconcileWorkerCaptures,
  workerCaptureRuntime,
} from './runtime/messaging-capture.ts';
import {
  builtInBacksPrivateAnalyst,
  probeLocalAnalystService,
  trustedAnalystAssistTimeoutMs,
  createSovereigntyAnalystMap,
  analystRouteTrustDomain,
  workerSovereigntyAnalystRoutePlan,
  secureLocalAnalystRouteStatus,
} from './runtime/private-analysts.ts';
import { createConnectorStoreMountDiscovery, mergeConnectorStores, type ConnectorStoreMount } from './runtime/connector-mounts.ts';
import { connectorStoreAnswerScope, googleFilePage } from './runtime/answer-scope.ts';
import { openIngestionDispositionsRuntime } from './runtime/ingestion-dispositions.ts';

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
 * How often every engine role brings each store's hidden-copy set up to date:
 * the front between Asks, and the background (or the single worker) so the
 * set it saves stays within this much of the ledger's visibility feed, and a
 * front start applies a small delta instead of rebuilding.
 */
const VISIBILITY_REFRESH_MS = 30_000;
/**
 * The longest the front waits on those sets before it listens; the rest
 * finishes after, in turns. Well inside the verified install's 60 s health
 * deadline (engine-service.ts ENGINE_HEALTH_TIMEOUT_MS), which also covers the
 * background's start. A rebuild from the ledger took about 59 s on Sparta
 * (gate 1, ops#151); from a saved set the background keeps current, a start
 * applies a delta of at most a refresh period.
 */
const FRONT_VISIBILITY_READY_BOUND_MS = 15_000;

export async function main(): Promise<void> {
  // First, before anything mounts or opens a store: this worker owns the data
  // root. A second worker on it waits a short while (restarts overlap), then
  // exits without mounting anything (core/data-owner-lock.ts). The engine
  // split's front (core/engine-split.ts) takes no lock: its background holds it.
  dataOwnerLock = takeWorkerDataOwnerLock(process.env, { engineRole: engineRoleFromEnv(process.env) });
  const engineRole = engineRoleFromEnv(process.env);
  // The waits on this boot read its progress, not a fixed ceiling (#1494). The
  // front does not own the data root and never writes it.
  if (engineRole !== 'front') beginBootProgress(process.env);
  const engineSocketPath = engineRole === 'single' ? undefined : engineBackgroundSocketFromEnv(process.env);
  let engineFront: EngineFront | undefined;
  if (engineRole === 'front') {
    // The front does none of the boot work that needs the data root to
    // itself: it waits until the background has done it, and from then on
    // opens no background-owned store for writing.
    const frontToken = workerAuthTokenFromEnv(process.env);
    if (!frontToken) throw new Error('The engine front needs the worker auth token.');
    forbidWritableStoreOpens();
    await waitForEngineBackground({ socketPath: engineSocketPath!, authToken: frontToken });
    engineFront = createEngineFront({ env: process.env, socketPath: engineSocketPath!, authToken: frontToken });
  }
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
  if (engineRole !== 'front') {
  // An account a Delete marked is removed before anything else looks at it.
  reportBootStep(process.env, { phase: 'starting' });
  deleteMarkedAccountsAtBoot(process.env);
  // An account recorded as legacy that holds nothing is placed in a folder instead.
  replaceEmptyAccountsAtBoot(process.env);
  // With the switch on, existing accounts move into their folders; a move under way is finished or undone.
  reportBootStep(process.env, { phase: 'starting' });
  await moveAccountsAtBoot(process.env);
  reportBootStep(process.env, { phase: 'starting' });
  // A restore the dashboard asked for runs now: under the owner lock, before
  // any store opens (backup-service.ts, #1065).
  applyPendingRestoreAtBoot(defaultBackupServicePaths(process.env), process.env);
  // From here on, a writable store open records its account in the registry
  // (core/source-storage.ts). Before any lane mounts.
  enableSourceRegistryAdoption();
  }
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
  // The owner's built-in size from Privacy rules; an operator's env pin wins.
  if (sovereigntyEngine.source === 'file' && sovereigntyEngine.path) {
    const builtInChoice = builtInModelEnvValue(process.env, readModelChoices(sovereigntyEngine.path));
    if (builtInChoice) process.env[BUILT_IN_ANALYST_MODEL_ENV] = builtInChoice;
  }
  // With the engine split, only the background holds the built-in model (one
  // server per computer); the front's completions run there (judging-models.ts).
  const workerBuiltInModel = createWorkerSharedBuiltInModel(process.env, engineFront ? {
    complete: (request) => engineFront!.completeModel(request),
    prepare: () => { void engineFront!.client.post({ kind: 'model_prepare' }).catch(() => undefined); },
  } : undefined);
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
  const judgeSpending = new JudgeSpending(judgeSpendingPath(process.env));
  // Go easy on this computer (#922): local judging and embedding trickle
  // while the owner works; full speed when away or plugged in overnight.
  let localWorkPending: () => boolean = () => false;
  const localPacer = new LocalWorkPacer({
    probe: systemIdlePowerProbe(),
    settingPath: join(dirname(resolveClassificationLedgerPath(process.env)), 'go-easy.json'),
    pendingLocalWork: () => localWorkPending(),
    log: (line) => console.log(line),
  });
  const judgeRuntimeInput = {
    engine: sovereigntyEngine,
    ...(registeredBuiltInPrivateModel() ? { builtIn: registeredBuiltInPrivateModel()! } : {}),
    standaloneEngine: isStandaloneEngineProcess(process.env),
  };
  const cloudJudgeRuntime = resolveJudgeChoiceRuntime(judgeRuntimeInput, { choice: 'venice', stop: null, remainingDollars: 1 });
  await adoptExistingCloudApproval(judgeSpending, judgeRuntimeInput, resolveClassificationLedgerPath(process.env), snifferPromptVersions(privacyOwnerContext({ env: process.env })).approval);
  await carryCloudJudgeApproval(judgeSpending, cloudJudgeRuntime, resolveClassificationLedgerPath(process.env), snifferPromptVersions(privacyOwnerContext({ env: process.env })).approval);
  const snifferRuntime = resolveJudgeChoiceRuntime(judgeRuntimeInput, judgeSpending.status());
  // The local judge's own speed and held share on this install, for the setup estimates (#891).
  const judgeObservations = new JudgeObservations(judgeObservationsPath(process.env));
  const snifferLane: SnifferLane | undefined = snifferRuntime.source === 'off' ? undefined : snifferRuntime.lane;
  // Set once the judge's model is built (below): a lane whose model cannot be
  // built queues questions nothing answers, the same as no judge (#1316).
  let snifferModelBuilt: boolean | undefined;
  const judgeMissing = (): 'no_model' | 'turned_off' | undefined => (
    !tierSnifferServiceEnv(process.env).enabled ? 'turned_off'
      : snifferRuntime.source === 'off' || snifferModelBuilt === false ? 'no_model'
        : undefined);
  if (snifferRuntime.source === 'off') {
    console.warn(`Olympus tier sniffer is off (${snifferRuntime.reason}): items whose names look private stay pending, held Private; every other item is Personal.`);
  }
  // A policy with no Public tier (fresh installs): Public verdicts are Personal.
  const publicTierRetired = isPublicTierRetired(sovereigntyEngine.config);
  const privacyOwnerWords = (): string | undefined => privacyOwnerContext({ env: process.env });
  const automaticMoveContext = {
    localEmbeddingsOnly: () => (['public_safe', 'internal', 'secure_local'] as const).every((domain) => {
      const resolved = sovereigntyEngine.resolveEmbeddingProfile(domain);
      return resolved === undefined || resolved.profile.provider === 'built-in';
    }),
    embeddingLedgerPath: resolveEmbeddingLedgerPath(process.env),
  };
  const installedTierClassification = configureInstalledTierClassification({
    automaticMoveContext,
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
  let capturesClosed = false;
  const captureFailures: Partial<Record<'telegram' | 'whatsapp', true>> = {};
  // What each supervisor last reported, for the dashboard. Absent for a source
  // whose capture the native service owns: this worker runs nothing there.
  const captureStatuses: Partial<Record<'telegram' | 'whatsapp', MessagingCaptureStatus>> = {};
  const captureOwnership = createWorkerMessagingCaptureOwnership({
    shouldResumeCapture: () => !capturesClosed,
    onResumeFailure: (source) => { captureFailures[source] = true; },
    onResumeSuccess: (source, status) => { delete captureFailures[source]; captureStatuses[source] = status; },
    registryPath: connectedHandleRegistryPath!,
    packageRoot,
  });
  const captures = captureOwnership.captures;
  let captureReconcileRunning = false;
  // Sources whose last reconcile threw: their old status is no fact about the helper.
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
  // In the split the background runs capture; the front's supervisors are
  // empty. Disconnect and Unpair tear credentials down only after the
  // background says the capture stopped.
  const stopMessagingCapture = engineFront
    ? frontCaptureStop(engineFront.client)
    : async (source: 'telegram' | 'whatsapp') => { await captureOwnership.stopForUnpair(source); };
  const unlinkWhatsAppDevice = (stateDir: string) => unlinkHelper(
    whatsappBridgePathForPackage(packageRoot, { env: process.env }),
    { ...process.env, OLYMPUS_WHATSAPP_STATE_DIR: stateDir },
  );

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
  // The restart a source-data delete asks for. In the split's background, a
  // delete the front forwarded waits for the front to end first.
  let restartForDelete: (request?: ModelKeyReloadRequest) => boolean = (request) => requestModelReload(request);
  let deferredReloads: ModelKeyReloadRequest[] | undefined;
  // The front's own restart without the background (after a forwarded delete).
  let restartFrontOnly: (request?: ModelKeyReloadRequest) => boolean = () => false;
  /** Run `writes` with every reload they request held until they finish, then requested once (#1050). */
  const withDeferredReloads = async <T>(writes: () => Promise<T>): Promise<T> => {
    if (deferredReloads) return writes();
    deferredReloads = [];
    try { return await writes(); }
    finally {
      const held = deferredReloads;
      deferredReloads = undefined;
      for (const request of held) requestModelReload(request);
    }
  };
  // Set once the real reload is installed (after startup): until then a
  // request is a no-op, so Delete indexed data must refuse rather than leave
  // open handles serving deleted rows (PR #455 review).
  let modelReloadInstalled = false;
  let modelReloadUnavailable = false;
  // Settings › Back up and restore (#1065): this worker owns the data, so it
  // writes the export a backup packs, as `olympus data export` does through it.
  const backupService = createBackupService({
    paths: defaultBackupServicePaths(process.env),
    env: process.env,
    // With the switch on the background writes it, between its own writes, so
    // the stores and ledgers agree; this process packs it (#1224).
    exportInto: engineFront ? frontDataExport(engineFront.client) : (destination) => exportOlympusData({ destination }),
    canRestart: () => workerRestartsItself(workerLaunch, process.env),
    requestRestart: () => modelReloadInstalled && requestModelReload(),
  });
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
        const members = sovereigntyEngine.resolveAnalystPool({ trustDomain: 'secure_local' }).members;
        const available = new Set(members.filter(member => member.profile.provider !== 'venice' || bootModelCredentials.get(member.id)).map(member => member.id));
        return builtInBacksPrivateAnalyst(id, workerBuiltInModel?.model.status().state, members, available);
      } catch {
        return false;
      }
    },
  });
  const localModelDiscovery = new LocalModelDiscovery();
  const getModelSetup = () => {
    const status = workerBuiltInModel ? builtInPrivateModelStatus(process.env) : undefined;
    const view = { ...modelSetup.getStatus(), ...macComputerSetupView(), ...(status?.enabled ? { private_model: { state: status.state, bytesDone: status.bytesDone, bytesTotal: status.bytesTotal ?? status.downloadBytes } } : {}) };
    if (!modelReloadUnavailable) return view;
    return { ...view, ready: false, cards: view.cards.map((card) => card.state === 'applying'
      ? { ...card, state: 'needs_attention' as const, detail: 'Key saved. Ask your agent to restart the managed Olympus worker to apply it; this foreground worker cannot restart itself.' }
      : card) };
  };
  const modelChoices = createModelChoicesBackend({
    ...(sovereigntyEngine.source === 'file' && sovereigntyEngine.path ? { policyPath: sovereigntyEngine.path } : {}),
    config: () => sovereigntyEngine.config,
    // The owner's model server is tried first and the built-in model only
    // covers for it when it is down (withBuiltInFallback), so ask the server.
    builtInAnswers: async () => workerBuiltInModel !== undefined && modelSetup.getStatus().cards.some(card => card.id === 'local')
      && (() => { try { const members = sovereigntyEngine.resolveAnalystPool({ trustDomain: 'secure_local' }).members; return builtInBacksPrivateAnalyst(LOCAL_PROFILE_ID, workerBuiltInModel?.model.status().state, members, new Set(members.map(member => member.id))); } catch { return false; } })()
      && !await probeLocalAnalystService(olympusConfig),
    builtInSize: () => workerBuiltInModel?.model.spec.sizeClass,
    totalMemoryBytes: totalmem(),
    // zkAPI questions use the consult settings' model (consult.json), which
    // Outside help also edits; the write goes through its adapter, bound late.
    zkapi: {
      available: () => sovereigntyEngine.config.modelProfiles['zkapi-consult'] !== undefined,
      strongest: CONSULT_CHATGPT_FRONTIER_MODEL_DEFAULT,
      read: () => { const read = readConsultSettings(); return read.state === 'valid' ? read.settings.chatgptFrontierModel : undefined; },
      write: async (model) => {
        if (!saveZkapiModel) return { ok: false as const, message: 'Olympus is still starting. Try again in a moment.' };
        return saveZkapiModel(model);
      },
    },
    venice: {
      strongest: async () => {
        const apiKey = bootModelCredentials.get(VENICE_PROFILE_ID);
        const profile = sovereigntyEngine.config.modelProfiles[VENICE_PROFILE_ID];
        if (!apiKey || !profile) return undefined;
        const baseUrl = ('baseUrl' in profile && profile.baseUrl) || 'https://api.venice.ai/api/v1';
        return resolveVeniceStrongest({ apiKey, baseUrl, category: createVenicePrivacyCategoryResolver({ apiKey, baseUrl }) });
      },
      catalog: async () => {
        const apiKey = bootModelCredentials.get(VENICE_PROFILE_ID);
        const profile = sovereigntyEngine.config.modelProfiles[VENICE_PROFILE_ID];
        if (!apiKey || !profile) return {};
        const baseUrl = ('baseUrl' in profile && profile.baseUrl) || 'https://api.venice.ai/api/v1';
        // One resolve refreshes a stale cache; the list is then read from it.
        await createVenicePrivacyCategoryResolver({ apiKey, baseUrl })('model' in profile && typeof profile.model === 'string' ? profile.model : 'kimi-k3').catch(() => undefined);
        return readVeniceTextCatalogModels();
      },
    },
    requestReload: () => requestModelReload(),
  });
  // Set once Outside help's adapter exists: the one writer of consult.json.
  let saveZkapiModel: ((model: string | undefined) => Promise<{ ok: true } | { ok: false; message: string }>) | undefined;
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
  let sourceRuntimeClosed = false;
  let sourceLaneGeneration = 0;
  let mountConfiguredSourceStores = (): void => {};
  const earlySourceStores: LocalConnectorStore[][] = [];
  let sourceLaneMounted = (stores: LocalConnectorStore[]): void => {
    sourceLaneGeneration += 1;
    earlySourceStores.push(stores);
  };
  const sourceHasStores = (sourceId: string): boolean => accountStoreNames(sourceId)
    .some((domain) => {
      const path = resolvedStorePath(sourceId, domain, process.env);
      return existsSync(path) || existsSync(tieredStoreSetLedgerPath(path)) || existsSync(secretLocationsPathForStore(path));
    });
  const tierLedgerProblems = new Map<string, string>();
  const sourceTierLedgerReady = (sourceId: string): boolean => {
    const problem = workerTierLedgerProblem(accountStoreNames(sourceId).map((name) => resolvedStorePath(sourceId, name, process.env)), !!engineFront);
    if (problem) {
      if (tierLedgerProblems.get(sourceId) !== problem) console.warn(`[privacy] ${sourceId}: ${problem}`);
      tierLedgerProblems.set(sourceId, problem);
      return false;
    }
    tierLedgerProblems.delete(sourceId);
    return true;
  };
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
  // Which SQLite failure it was (busy, cannot open, corrupt): the name alone left a
  // release check unable to tell a lock from a missing file. SQLite's own codes
  // and messages name no path and no content.
  const sqliteFailure = (error: unknown): string => {
    if (!(error instanceof Error)) return 'error';
    const code = (error as { code?: unknown }).code;
    return `${error.name}${typeof code === 'string' ? ` ${code}` : ''}: ${error.message.slice(0, 120)}`;
  };
  const openTierSecretLocations = (account: StorageAccount, secureDbPath: string, label: string): SecretLocationsIndex | undefined => {
    try {
      return openSecretLocations(account, { dbPath: secretLocationsPathForStore(secureDbPath) });
    } catch (error) {
      console.warn(`[tier] secret-locations index unavailable for ${label}: ${sqliteFailure(error)}`);
      return undefined;
    }
  };
  // A lane's Private store, its secret-locations index and the tier lane over them (which opens the ledger) are kept
  // together or not at all. The split's front mounts a lane while the background is still creating it: the store
  // first, then its index, then the ledger. A part that fails to open leaves nothing behind, so frontMountRetry tries
  // the whole lane again, and by the time the ledger opens the index is there too. Release check run 43043603156 kept
  // the store of a mount that failed on its ledger: the lane never mounted and its source read 0 items for the rest of
  // the run.
  const openPrivateLane = <Lane>(
    sourceId: string,
    label: string,
    create: () => LocalConnectorStore,
    lane: (store: LocalConnectorStore, secrets: SecretLocationsIndex | undefined) => Lane,
  ): { store: LocalConnectorStore; secrets: SecretLocationsIndex | undefined; lane: Lane } => {
    const store = create();
    let secrets: SecretLocationsIndex | undefined;
    try {
      secrets = openTierSecretLocations({ sourceId }, store.dbPath, label);
      return { store, secrets, lane: lane(store, secrets) };
    } catch (error) {
      secrets?.close();
      store.close();
      throw error;
    }
  };
  // The same for a lane whose tier set this file builds (Gmail, Google Drive, Telegram): its stores are closed again
  // when the tier lane over them fails to open, and the lane is kept only once both opened.
  const closedOnThrow = <T>(stores: readonly LocalConnectorStore[], open: () => T): T => {
    try {
      return open();
    } catch (error) {
      for (const store of stores) store.close();
      throw error;
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
    // The split's front opens these stores read-only while the background may still be creating them: a ledger or
    // secret-locations index not there yet throws, so closedOnThrow closes the stores and frontMountRetry mounts the
    // whole lane later. Mounting without them left Telegram with no tier lane for the rest of release check run
    // 43078655631 (no item menu, search or delete).
    const ledger = input.secure.tierLedger();
    if (!ledger) {
      if (engineFront) throw new Error(`the tier ledger for ${input.secure.corpusId} is not there yet`);
      return undefined;
    }
    let secrets: SecretLocationsIndex | undefined;
    try {
      secrets = openSecretLocations(input.account, { dbPath: secretLocationsPathForStore(input.secure.dbPath) });
    } catch (error) {
      if (engineFront) throw error;
      console.warn(`[tier] secret-locations index unavailable for ${input.secure.corpusId}: ${sqliteFailure(error)}`);
    }
    input.internal.useTierLedger(ledger);
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
  const checkTierSecretLocations = (
    locations: readonly import('../../core/evidence-pack.ts').SavedSecretLocation[],
    searched: ReadonlyArray<{ corpusId: string; accountScope?: string; filters?: ConnectorStoreSearchFilters }>,
  ): boolean => locations.every((location) => tierLanes.some((lane) => {
    const scope = searched.find((entry) => entry.corpusId === lane.secureCorpusId);
    if (!scope || !lane.secrets) return false;
    try {
      return lane.secrets.recheck(location, scope, {
        hide: (identities) => hiddenProbesByParentIdentity({
          ledger: () => lane.ledger,
          stores: () => connectorStores.filter((store) => lane.corpusIds.has(store.corpusId)),
        }, identities),
      });
    } catch { return false; }
  }));
  // Each lane's ledger, its corpora and its stores that exist now: the stores
  // let a child item be judged by its parent where the gate and the release
  // check read (tier-visibility.ts).
  // Configured stores waiting for their ledger (#1224): retried on every
  // scope read, so a ledger that appears later governs at once, whatever
  // mount discovery reports.
  const pendingGovernance = createPendingGovernance(
    tierLanes,
    (store, ledger) => ({ ledger, secureCorpusId: store.corpusId, corpusIds: new Set([store.corpusId]), onDemand: [] }),
    (line) => console.warn(line),
  );
  const tierScopes = (): TierVisibilityScope[] => (pendingGovernance.retry(), tierLanes).map((lane) => ({
    ledger: lane.ledger,
    corpusIds: lane.corpusIds,
    stores: () => connectorStores.filter((store) => lane.corpusIds.has(store.corpusId)),
  }));
  // A query's matches still waiting for their privacy judgment are judged next (#1062).
  // The judge runs in the background in the split: raise its boosts there.
  const raiseJudgeBoosts = engineFront ? frontJudgeBoost(engineFront.client) : (identities: Parameters<typeof judgeBoosts.raise>[0]) => judgeBoosts.raise(identities);
  const tierVisibilityGate = createTierVisibilityGate(tierScopes, (identities) => raiseJudgeBoosts(identities));
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
  let refreshableReadwiseRuntime: ReturnType<typeof createRefreshableReadwiseConnectorStoreRuntime> | undefined;
  let readwiseConnectorStore: LocalConnectorStore | undefined;
  const mountReadwise = (): void => {
    if (sourceRuntimeClosed) throw new Error('Source runtime is closed.');
    if (refreshableReadwiseRuntime) return;
    if (!sourceTierLedgerReady(READWISE_SOURCE_ID)) return;
    refreshableReadwiseRuntime = createRefreshableReadwiseConnectorStoreRuntime({
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
    readwiseConnectorStore = refreshableReadwiseRuntime?.store;
    if (readwiseConnectorStore) sourceLaneMounted([readwiseConnectorStore]);
  };
  const xBookmarksConnectorStoreLane = sourceIndexLaneAccountDecision(sourceIndexLaneStorageDecision(
    process.env,
    'OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_CONNECTOR_STORE_ENABLED',
    sourceIndexReadEnabled,
  ), { sourceId: X_BOOKMARKS_SOURCE_ID });
  // The X lane's tier stores beyond its own, for the account guard's
  // "does this source hold items" check.
  let xBookmarksTierStores: OnDemandTierStore[] = [];
  let refreshableXBookmarksRuntime: ReturnType<typeof createRefreshableXBookmarksConnectorStoreRuntime> | undefined;
  let xBookmarksConnectorStore: LocalConnectorStore | undefined;
  const mountXBookmarks = (): void => {
    if (sourceRuntimeClosed) throw new Error('Source runtime is closed.');
    if (refreshableXBookmarksRuntime) return;
    if (!sourceTierLedgerReady(X_BOOKMARKS_SOURCE_ID)) return;
    refreshableXBookmarksRuntime = createRefreshableXBookmarksConnectorStoreRuntime({
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
    xBookmarksConnectorStore = refreshableXBookmarksRuntime?.store;
    if (xBookmarksConnectorStore) sourceLaneMounted([xBookmarksConnectorStore]);
  };
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
  let gmailInternalConnectorStore: LocalConnectorStore | undefined;
  let gmailSecureConnectorStore: LocalConnectorStore | undefined;
  let gmailTierLane: ReturnType<typeof tierLane> | undefined;
  const mountGmail = (): void => {
    if (sourceRuntimeClosed) throw new Error('Source runtime is closed.');
    if (gmailInternalConnectorStore) return;
    if (!sourceTierLedgerReady(GMAIL_SOURCE_ID)) return;
    const internal = gmailConnectorStoreLane.enabled
      ? openConnectorStore({ sourceId: GMAIL_SOURCE_ID }, {
        dbPath: resolvedStorePath(GMAIL_SOURCE_ID, 'internal', process.env),
        corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
        family: 'email',
        trustDomain: 'internal',
      })
      : undefined;
    const secure = internal
      ? closedOnThrow([internal], () => openConnectorStore({ sourceId: GMAIL_SOURCE_ID }, {
        dbPath: resolvedStorePath(GMAIL_SOURCE_ID, 'secure_local', process.env),
        corpusId: GMAIL_SECURE_CONNECTOR_CORPUS_ID,
        family: 'email',
        trustDomain: 'secure_local',
      }))
      : undefined;
    // Per-tier stores (design per-item-four-tier-classification.md, 3.2): the
    // lane's two stores plus a Public store created only when a message is
    // routed there, all governed by ONE ledger — the secure store's own.
    const lane = internal && secure
      ? closedOnThrow([internal, secure], () => tierLane({
          account: { sourceId: GMAIL_SOURCE_ID },
          internal,
          secure,
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
        }))
      : undefined;
    gmailInternalConnectorStore = internal;
    gmailSecureConnectorStore = secure;
    gmailTierLane = lane;
    if (gmailInternalConnectorStore && gmailSecureConnectorStore) sourceLaneMounted([gmailInternalConnectorStore, gmailSecureConnectorStore]);
  };
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
  if (gmailConnectorStoreLane.enabled) {
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
        mountGmail();
        if (!gmailInternalConnectorStore || !gmailSecureConnectorStore) throw new Error('Gmail stores are unavailable.');
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
  let googleDriveInternalConnectorStore: LocalConnectorStore | undefined;
  let googleDriveSecureConnectorStore: LocalConnectorStore | undefined;
  let googleDriveTierLane: ReturnType<typeof tierLane> | undefined;
  const mountGoogleDrive = (): void => {
    if (sourceRuntimeClosed) throw new Error('Source runtime is closed.');
    if (googleDriveInternalConnectorStore) return;
    if (!sourceTierLedgerReady(GOOGLE_DRIVE_SOURCE_ID)) return;
    const internal = googleDriveConnectorStoreLane.enabled
      ? openConnectorStore({ sourceId: GOOGLE_DRIVE_SOURCE_ID }, {
        dbPath: resolvedStorePath(GOOGLE_DRIVE_SOURCE_ID, 'internal', process.env),
        corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
        family: 'file',
        trustDomain: 'internal',
        ...(googleDriveExclusions ? { exclusions: googleDriveExclusions } : {}),
      })
      : undefined;
    const secure = internal
      ? closedOnThrow([internal], () => openConnectorStore({ sourceId: GOOGLE_DRIVE_SOURCE_ID }, {
        dbPath: resolvedStorePath(GOOGLE_DRIVE_SOURCE_ID, 'secure_local', process.env),
        corpusId: GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
        family: 'file',
        trustDomain: 'secure_local',
        ...(googleDriveExclusions ? { exclusions: googleDriveExclusions } : {}),
      }))
      : undefined;
    // The Public Drive store carries the same exclusion gate and the same
    // approved-scope read filter as its siblings (connectorStoreReadScope).
    const lane = internal && secure
      ? closedOnThrow([internal, secure], () => tierLane({
          account: { sourceId: GOOGLE_DRIVE_SOURCE_ID },
          internal,
          secure,
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
        }))
      : undefined;
    googleDriveInternalConnectorStore = internal;
    googleDriveSecureConnectorStore = secure;
    googleDriveTierLane = lane;
    if (googleDriveInternalConnectorStore && googleDriveSecureConnectorStore) sourceLaneMounted([googleDriveInternalConnectorStore, googleDriveSecureConnectorStore]);
  };
  // Dropbox product state: the lane's original store, secure_local. Every
  // file stored before per-item routing stays here; the lane's tier set
  // (below) adds Personal and Public stores on first need.
  const dropboxConnectorStoreLane = sourceIndexLaneAccountDecision(
    sourceIndexLaneStorageDecision(process.env, 'OLYMPUS_SOURCE_INDEX_DROPBOX_CONNECTOR_STORE_ENABLED', sourceIndexReadEnabled),
    { sourceId: DROPBOX_FILES_SOURCE_ID },
  );
  const dropboxProviderAccount = dropboxHandle?.accountRole?.trim()
    || dropboxFilesAccount
    || 'personal';
  let dropboxConnectorStore: LocalConnectorStore | undefined;
  let dropboxSecretLocations: SecretLocationsIndex | undefined;
  let dropboxTierLane: ReturnType<typeof createDropboxTierLane> | undefined;
  let dropboxExtractionView: ReturnType<typeof tieredExtractionView> | undefined;
  const mountDropbox = (): void => {
    if (sourceRuntimeClosed) throw new Error('Source runtime is closed.');
    if (dropboxConnectorStore) return;
    if (!sourceTierLedgerReady(DROPBOX_FILES_SOURCE_ID)) return;
    // Per-tier stores (P1c, design per-item-four-tier-classification.md): the
    // lane's original secure store keeps every existing file where it is; a new
    // file's names go to the Personal store (by default) when it is listed, and
    // its text to the store its content tier decides once extraction reads it.
    // The Personal and Public stores are created on first need.
    const opened = dropboxConnectorStoreLane.enabled
      ? openPrivateLane(
          DROPBOX_FILES_SOURCE_ID,
          DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
          () => createDropboxConnectorStore(process.env, { policy: dropboxIngestionPolicy }),
          (secureStore, secretLocations) => createDropboxTierLane({
            secureStore,
            env: process.env,
            policy: dropboxIngestionPolicy,
            ...(secretLocations ? { secretLocations } : {}),
            // The owner's folder choice (names only) reaches the tier set, which the
            // store's own ingestion rules never carry (#1295).
            ...(fileSourceScopeAuthority ? { namesOnlyByOwner: dropboxNamesOnlyByOwner(fileSourceScopeAuthority) } : {}),
            onStoreOpened: (store) => registerTierLegStore(
              store,
              DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
              sourceIndexEmbeddingProvider ?? null,
            ),
          }),
        )
      : undefined;
    dropboxConnectorStore = opened?.store;
    dropboxSecretLocations = opened?.secrets;
    dropboxTierLane = opened?.lane;
    // The Dropbox set declares no embedder on its legs; the Private store's real
    // one is chosen here and handed to the scheduler. Tell the set, so the Private
    // row re-home pass knows whether it is local (it moves only when it is).
    if (dropboxTierLane && dropboxFilesEmbeddingProvider && isApprovedSecureSourceEmbeddingProvider(dropboxFilesEmbeddingProvider)) {
      dropboxTierLane.set.declarePrivateEmbedder(dropboxFilesEmbeddingProvider, {
        // Rows moved into the Private store embed under the current scope binding, as the lane's own pass does.
        embedWith: () => {
          const ref = fileSourceScopeAuthority?.policyRef('dropbox.files');
          return ref && fileSourceScopeAuthority ? scopeBoundEmbeddingProvider(dropboxFilesEmbeddingProvider, fileSourceScopeAuthority, ref) : undefined;
        },
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
    dropboxExtractionView = dropboxTierLane ? tieredExtractionView(dropboxTierLane.set) : undefined;
    if (dropboxConnectorStore) sourceLaneMounted([dropboxConnectorStore]);
  };
  /** Whether a store is one of the Dropbox lane's tier stores. */
  const isDropboxTierStore = (store: LocalConnectorStore): boolean => store === dropboxConnectorStore
    || (dropboxTierLane !== undefined
      && (store === dropboxTierLane.internal.current() || store === dropboxTierLane.public.current()));
  // Local files: the folders the owner chose on this computer. No credential;
  // the lane exists once the owner connects it and approves folders. Same three
  // per-tier stores, exclusion gate and tier set as Dropbox.
  const localFilesConnectorStoreLane = sourceIndexLaneAccountDecision(
    sourceIndexLaneStorageDecision(process.env, 'OLYMPUS_SOURCE_INDEX_LOCAL_FILES_CONNECTOR_STORE_ENABLED', sourceIndexReadEnabled),
    { sourceId: LOCAL_FILES_SOURCE_ID },
  );
  const localFilesIngestionPolicy = defaultLocalFilesIngestionPolicy();
  const localFilesScopeRef = fileSourceScopeAuthority
    ? fileSourceScopeAuthority.policyRef(LOCAL_FILES_SOURCE_ID)
    : undefined;
  let localFilesOwnRootsCleanup: ReturnType<typeof createLocalFilesOwnRootsCleanup> | undefined;
  let localFilesInitialCleanup: Promise<void> | undefined;
  let localFilesCleanupRecovery: ReturnType<typeof createLocalFilesOwnRootsRecovery> | undefined;
  let localFilesConnectorStore: LocalConnectorStore | undefined;
  let localFilesSecretLocations: SecretLocationsIndex | undefined;
  let localFilesTierLane: ReturnType<typeof createLocalFilesTierLane> | undefined;
  let localFilesExtractionView: ReturnType<typeof tieredExtractionView> | undefined;
  const mountLocalFiles = (): void => {
    if (sourceRuntimeClosed) throw new Error('Source runtime is closed.');
    if (localFilesConnectorStore) return;
    if (!sourceTierLedgerReady(LOCAL_FILES_SOURCE_ID)) return;
    const opened = localFilesConnectorStoreLane.enabled
      ? openPrivateLane(
          LOCAL_FILES_SOURCE_ID,
          LOCAL_FILES_CORPUS_ID,
          () => createLocalFilesConnectorStore(process.env, { policy: localFilesIngestionPolicy }),
          (secureStore, secretLocations) => createLocalFilesTierLane({
            secureStore,
            env: process.env,
            policy: localFilesIngestionPolicy,
            ...(secretLocations ? { secretLocations } : {}),
            onStoreOpened: (store) => registerTierLegStore(
              store,
              LOCAL_FILES_CORPUS_ID,
              sourceIndexEmbeddingProvider ?? null,
            ),
          }),
        )
      : undefined;
    localFilesConnectorStore = opened?.store;
    localFilesSecretLocations = opened?.secrets;
    localFilesTierLane = opened?.lane;
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
    localFilesExtractionView = localFilesTierLane ? tieredExtractionView(localFilesTierLane.set) : undefined;
    if (localFilesTierLane) {
      localFilesOwnRootsCleanup = createLocalFilesOwnRootsCleanup({ tierSet: localFilesTierLane.set, context: localFilesExclusionContext, log: (message) => console.warn(`[local-files] ${message}`) });
      // An incomplete bounded pass never opens reads; upgraded indexes and remaining
      // batches recover independently of the scheduler, without holding startup.
      const lane = localFilesTierLane;
      localFilesCleanupRecovery = createLocalFilesOwnRootsRecovery({ cleanup: localFilesOwnRootsCleanup, stores: () => lane.set.openStores(), log: (message) => console.warn(`[local-files] ${message}`) });
      localFilesInitialCleanup = localFilesCleanupRecovery.initial;
    }
    if (localFilesConnectorStore) sourceLaneMounted([localFilesConnectorStore]);
  };
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
  let localFilesSyncCache: { key: string; handler: ReturnType<typeof createLocalFilesProviderStoreSyncHandler> } | undefined;
  const localFilesSyncFor = (ref: SourceScopePolicyRef) => {
    if (!localFilesConnectorStore || !localFilesTierLane || !fileSourceScopeAuthority) return undefined;
    const ownRootsCleanup = localFilesOwnRootsCleanup;
    if (!ownRootsCleanup) return undefined;
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
      beforePull: async () => { await ownRootsCleanup.run(); await ownRootsCleanup.idle(); },
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
  let whatsappConnectorStore: LocalConnectorStore | undefined;
  let whatsappSecretLocations: SecretLocationsIndex | undefined;
  let whatsappTierSet: TieredStoreSet | undefined;
  const mountWhatsApp = (): void => {
    if (sourceRuntimeClosed) throw new Error('Source runtime is closed.');
    if (whatsappConnectorStore) return;
    if (!sourceTierLedgerReady(WHATSAPP_PERSONAL_SOURCE_ID)) return;
    // Per-tier stores (P1c): each message is tiered by its own content; Private
    // ones rest in the lane's own store and Personal ones in the Personal store.
    const opened = whatsappConnectorStoreLane.enabled
      ? openPrivateLane(
          WHATSAPP_PERSONAL_SOURCE_ID,
          WHATSAPP_LIVE_CORPUS_ID,
          () => createWhatsAppConnectorStore(process.env),
          (store, secretLocations) => existingStoreTierSet(createWhatsAppTierLane({
            store,
            env: process.env,
            ...(sourceIndexEmbeddingProvider ? { internalEmbeddingProvider: sourceIndexEmbeddingProvider } : {}),
            ...(secretLocations ? { secretLocations } : {}),
            onStoreOpened: (leg) => registerTierLegStore(leg, WHATSAPP_LIVE_CORPUS_ID, sourceIndexEmbeddingProvider ?? null),
          }), {
            store,
            ...(secretLocations ? { secrets: secretLocations } : {}),
          }),
        )
      : undefined;
    whatsappConnectorStore = opened?.store;
    whatsappSecretLocations = opened?.secrets;
    whatsappTierSet = opened?.lane;
    if (whatsappTierSet && tierSecureEmbeddingProvider) whatsappTierSet.declarePrivateEmbedder(tierSecureEmbeddingProvider);
    if (whatsappTierSet && whatsappConnectorStore) {
      reportRehomedChatOverrides('whatsapp', rehomeChatLaneOverrides(whatsappTierSet.ledger, 'whatsapp', [whatsappConnectorStore]));
    }
    if (whatsappConnectorStore) sourceLaneMounted([whatsappConnectorStore]);
  };
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
      mountWhatsApp();
      whatsappImportTierSet ??= whatsappTierSet;
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
  let whatsappConnectorStoreSync: WhatsAppConnectorStoreSyncHandler | undefined = whatsappConnectorStore && whatsappTierSet
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
  let telegramConnectorStores: ReturnType<typeof createTelegramConnectorStores> | undefined;
  let telegramTierLane: ReturnType<typeof tierLane> | undefined;
  let telegramConnectorStoreSync: TelegramConnectorStoreSyncHandler | undefined;
  const mountTelegram = (): void => {
    if (sourceRuntimeClosed) throw new Error('Source runtime is closed.');
    if (telegramConnectorStores) return;
    if (!sourceTierLedgerReady(TELEGRAM_MESSAGES_SOURCE_ID)) return;
    const stores = telegramConnectorStoreLane.enabled
      ? createTelegramConnectorStores(process.env)
      : undefined;
    telegramTierLane = stores
      ? closedOnThrow([stores.internal, stores.secureLocal], () => tierLane({
          account: { sourceId: TELEGRAM_MESSAGES_SOURCE_ID },
          internal: stores.internal,
          secure: stores.secureLocal,
        }))
      : undefined;
    telegramConnectorStores = stores;
    if (telegramTierLane && telegramConnectorStores) {
      reportRehomedChatOverrides('telegram', rehomeChatLaneOverrides(
        telegramTierLane.ledger,
        'telegram',
        [telegramConnectorStores.internal, telegramConnectorStores.secureLocal],
      ));
    }
    telegramConnectorStoreSync = telegramConnectorStores
      ? createTelegramConnectorStoreSyncHandler({
          stores: telegramConnectorStores,
          env: process.env,
          ...(telegramTierLane?.secrets ? { secretLocations: telegramTierLane.secrets } : {}),
          ...(tierSecureEmbeddingProvider ? { privateEmbedder: tierSecureEmbeddingProvider } : {}),
        })
      : undefined;
    if (telegramConnectorStores) sourceLaneMounted([telegramConnectorStores.internal, telegramConnectorStores.secureLocal]);
  };
  // Register source knowledge before pairing or mounting: preview and saved-import resumption
  // can find the target without creating stores. An approved import opens the same canonical lane.
  if (telegramConnectorStoreLane.enabled) archiveSourceTargets.register(telegramArchiveTarget({
    account: TELEGRAM_PERSONAL_ACCOUNT_SCOPE,
    lane: () => {
      mountTelegram();
      if (!telegramConnectorStoreSync) throw new Error('Telegram stores are unavailable.');
      return telegramConnectorStoreSync.archiveTarget().lane({ sourceId: TELEGRAM_MESSAGES_SOURCE_ID, slot: '1' }, process.env);
    },
    liveSince: () => telegramConnectorStoreSync?.archiveTarget().liveSince?.({ sourceId: TELEGRAM_MESSAGES_SOURCE_ID, slot: '1' }, process.env),
  }));
  const telegramSpoolChanges = createSpoolChangeSubscription(defaultTelegramCaptureSpoolDir(process.env));
  const whatsappSpoolChanges = createSpoolChangeSubscription(defaultWhatsAppSpoolDir(process.env));
  const telegramCaptureMaxItems = parseOptionalPositiveInteger(
    process.env.OLYMPUS_TELEGRAM_SPOOL_DRAIN_MAX_ITEMS,
    'OLYMPUS_TELEGRAM_SPOOL_DRAIN_MAX_ITEMS',
  );
  // The engine split's front opens every store read-only and never creates one
  // (core/store-write-guard.ts). A source connected before the background has
  // created its stores, or while it is still writing their schema, waits here
  // unmounted and reads as connected with nothing synced yet; frontMountRetry
  // mounts it once every store the lane opens is readable.
  const storeAt = (sourceId: string, domain: 'internal' | 'secure_local'): string =>
    resolvedStorePath(sourceId, domain, process.env);
  const frontCanMount = (paths: readonly string[]): boolean => paths.every(connectorStoreReadableNow);
  const mountSourceLanes = (handles: readonly ConnectedCredentialHandle[]): void => {
    if (sourceRuntimeClosed) return;
    const connected = (provider: ConnectedCredentialHandle['provider'], capability: string): boolean =>
      activeCredentialHandle(handles, { provider, capability }) !== undefined;
    // `paths`: the stores the lane's mount opens. The background (or a worker
    // without the split) creates them; the front mounts only readable ones.
    const wanted = (sourceId: string, connectedNow: boolean, paths: readonly string[]): boolean => {
      if (!sourceHasStores(sourceId) && !connectedNow) return false;
      return !engineFront || frontCanMount(paths);
    };
    const both = (sourceId: string): string[] => [storeAt(sourceId, 'internal'), storeAt(sourceId, 'secure_local')];
    // In the front a lane the background is still creating fails to mount (its ledger or index is not there yet).
    // That lane waits for frontMountRetry; it never stops the other lanes, or the front's own start.
    const mount = (open: () => void): void => {
      if (!engineFront) { open(); return; }
      try { open(); } catch (error) {
        console.warn(`[olympus] the front could not open a source's stores yet: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    if (!gmailInternalConnectorStore && gmailConnectorStoreLane.enabled && wanted(GMAIL_SOURCE_ID, connected('gmail', 'gmail.email.sync'), both(GMAIL_SOURCE_ID))) mount(mountGmail);
    if (!googleDriveInternalConnectorStore && googleDriveConnectorStoreLane.enabled && wanted(GOOGLE_DRIVE_SOURCE_ID, connected('google_drive', 'google_drive.docs.sync'), both(GOOGLE_DRIVE_SOURCE_ID))) mount(mountGoogleDrive);
    if (!dropboxConnectorStore && dropboxConnectorStoreLane.enabled && wanted(DROPBOX_FILES_SOURCE_ID, connected('dropbox', 'dropbox.files.sync'), [storeAt(DROPBOX_FILES_SOURCE_ID, 'secure_local')])) mount(mountDropbox);
    if (!localFilesConnectorStore && localFilesConnectorStoreLane.enabled && wanted(LOCAL_FILES_SOURCE_ID, fileSourceScopeAuthority?.policyRef(LOCAL_FILES_SOURCE_ID) !== undefined, [storeAt(LOCAL_FILES_SOURCE_ID, 'secure_local')])) mount(mountLocalFiles);
    if (!whatsappConnectorStore && whatsappConnectorStoreLane.enabled && wanted(WHATSAPP_PERSONAL_SOURCE_ID, connected('whatsapp_personal', 'whatsapp.personal.messages.sync'), [storeAt(WHATSAPP_PERSONAL_SOURCE_ID, 'secure_local')])) mount(mountWhatsApp);
    if (!telegramConnectorStores && telegramConnectorStoreLane.enabled && wanted(TELEGRAM_MESSAGES_SOURCE_ID, connected('telegram', 'telegram.messages.sync'), both(TELEGRAM_MESSAGES_SOURCE_ID))) mount(mountTelegram);
    if (!readwiseConnectorStore && readwiseConnectorStoreLane.enabled && wanted(READWISE_SOURCE_ID, connected('readwise', 'readwise.sync'), [storeAt(READWISE_SOURCE_ID, 'internal')])) mount(mountReadwise);
    if (!xBookmarksConnectorStore && xBookmarksConnectorStoreLane.enabled && wanted(X_BOOKMARKS_SOURCE_ID, connected('x', 'x.bookmarks.sync'), [storeAt(X_BOOKMARKS_SOURCE_ID, 'internal')])) mount(mountXBookmarks);
    mountConfiguredSourceStores();
  };
  mountSourceLanes(connectedHandles);
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
  let configuredMountStores: readonly LocalConnectorStore[] = laneConnectorStores;
  const discoverConfiguredStores = createConnectorStoreMountDiscovery(process.env.OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON, {
    stores: () => configuredMountStores,
    registeredCorpora: () => sourceCorpusRegistry.list(),
    storeOwner: () => lifecycleStoreFileOwner(process.env),
  });
  const configuredConnectorStoreMounts = discoverConfiguredStores();
  const configuredConnectorStores = configuredConnectorStoreMounts.map((mount) => mount.store);
  // A configured mount (Reflect, Roam, ...) whose store is ledger-backed is
  // governed by that ledger: register it, so the visibility gate and every
  // release check read its items' tiers instead of treating them as legacy.
  // One whose ledger does not exist yet, or cannot be opened now, waits in
  // pendingGovernance, which every scope read retries (tierScopes).
  const registerConfiguredTierStore = (store: LocalConnectorStore): void => pendingGovernance.add(store);
  for (const store of configuredConnectorStores) registerConfiguredTierStore(store);
  const connectorStores = mergeConnectorStores([
    ...configuredConnectorStores,
    ...laneConnectorStores,
  ]);
  configuredMountStores = connectorStores;
  const readConnectorStores = connectorStores;
  // Every store's hidden-copy set, built and then kept current on a timer.
  // The front does it before it reports ready, so an Ask (the first included)
  // applies a small delta at most instead of building a set on its thread.
  // The background (or the single worker) does it after it starts and saves
  // each set, so the front's start reads from a saved set inside the ledger's
  // feed. A store mounted later is built on the next tick.
  let visibilityKeeping = false;
  async function keepVisibilityCurrent(when: string): Promise<void> {
    if (visibilityKeeping || sourceRuntimeClosed) return;
    visibilityKeeping = true;
    const started = performance.now();
    try {
      for (const store of [...connectorStores]) {
        try { await store.keepVisibilityCurrentInTurns(); }
        catch (error) { console.warn(`[olympus] ${engineRole}: a store's hidden-copy set could not be built yet: ${error instanceof Error ? error.message : String(error)}`); }
      }
    } finally {
      visibilityKeeping = false;
    }
    if (when !== 'refresh') {
      console.log(`[olympus] ${engineRole}: built ${connectorStores.length} stores' hidden-copy sets in ${Math.round(performance.now() - started)} ms`);
    }
  }
  // One person across sources (#1076): the shared people index, Private and
  // on this computer, rebuilt from every authored store's senders. Without
  // it, answers keep each item's own sender label and filters match labels.
  // In the engine split the background rebuilds it; the front reads each rebuild.
  let peopleIndex = openPeopleIndexOrUndefined(engineFront ? { readOnly: true } : {});
  const peopleRefresher = !engineFront && peopleIndex ? new PeopleIndexRefresher(peopleIndex, () => connectorStores) : undefined;
  // After every scheduler tick (below) and on a one-minute check: a
  // rebuild only after a sync or a tier visibility change, at most once a
  // minute (the markers are cheap to read), reading only the stores that
  // moved, off this thread (#1305); `force` reads every store again now.
  // No timer forces a rebuild after startup: the markers cover every change
  // a rebuild could pick up (#1305; the 15-minute one froze the worker).
  const refreshPeople = (force = false): void => {
    if (engineFront) {
      peopleIndex ??= openPeopleIndexOrUndefined({ readOnly: true });
      if (!peopleIndex) return;
      try {
        peopleIndex.reload();
        const people = peopleIndex;
        const resolver = (provider: string, senderId: string | undefined, senderLabel: string | undefined) =>
          people.citationName(provider, senderId, senderLabel);
        for (const store of connectorStores) store.setPeopleNames?.(resolver);
      } catch (error) {
        console.warn(`[olympus] people index reload failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (!peopleRefresher) return;
    const failed = (error: unknown): void => {
      console.warn(`[olympus] people index refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    };
    try {
      void (force ? peopleRefresher.refresh() : peopleRefresher.refreshIfChanged()).catch(failed);
    } catch (error) {
      failed(error);
    }
  };
  // An owner's correction or contact card: link again at once from the
  // senders already read; the one-minute check picks up store changes.
  const relinkPeople = (): void => {
    if (!peopleRefresher) {
      refreshPeople(true);
      return;
    }
    try {
      if (peopleRefresher.relink() === undefined) refreshPeople(true);
    } catch (error) {
      console.warn(`[olympus] people index refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const peopleFirstRefresh = setTimeout(() => refreshPeople(true), PEOPLE_INDEX_FIRST_REFRESH_MS);
  peopleFirstRefresh.unref?.();
  const peopleCheck = setInterval(() => refreshPeople(), PEOPLE_INDEX_CHECK_MS);
  peopleCheck.unref?.();

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
  const fileExtractionCorpora = () => fileExtractionCorporaRoster({
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
    if (provider === LOCAL_FILES_PROVIDER && !localFilesCleanupRecovery?.ready()) {
      throw new OperationError('source_index_policy_violation', 'Local-file cleanup is still in progress.');
    }
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
  let googleDriveExtractionTierSet: TieredStoreSet | undefined;
  const driveExtractionSet = () => googleDriveExtractionTierSet ??= googleDriveInternalConnectorStore && googleDriveSecureConnectorStore
    ? createGoogleDriveLaneTierSet({
        setId: 'google_drive.extraction',
        internalStore: googleDriveInternalConnectorStore,
        secureStore: googleDriveSecureConnectorStore,
        ...(googleDriveTierLane?.publicStore
          ? {
              publicLeg: {
                corpusId: GOOGLE_DRIVE_PUBLIC_CONNECTOR_CORPUS_ID,
                open: () => googleDriveTierLane!.publicStore!.open(),
                exists: () => googleDriveTierLane!.publicStore!.exists(),
              },
            }
          : {}),
        ...(googleDriveTierLane?.secrets ? { secretLocations: googleDriveTierLane.secrets } : {}),
        registerWithLedger: false,
      })
    : undefined;
  const fileExtractionTierSets = () => {
    const googleDriveExtractionTierSet = driveExtractionSet();
    return new Map<string, TieredStoreSet>([
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
  };
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
  const buildFileExtractionRuntime = () => createFileExtractionRuntime({
    env: process.env,
    // The split's front reads the queue; the background owns it and runs the jobs.
    ...(engineRole === 'front' ? { readOnly: true } : {}),
    enabled: fileExtractionCorpora().length > 0 || dropboxConnectorStoreLane.enabled || localFilesConnectorStoreLane.enabled
      || whatsappConnectorStoreLane.enabled || googleDriveConnectorStoreLane.enabled,
    allowEmpty: true,
    connectorStores,
    corpora: fileExtractionCorpora(),
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
    tierSets: fileExtractionTierSets(),
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
  const fileExtractionRuntime = createRefreshableFileExtractionRuntime({
    build: buildFileExtractionRuntime,
    generation: () => sourceLaneGeneration,
    beforeCurrent: () => mountSourceLanes(readActiveConnectedHandles(process.env)),
  });
  // Every store reads its unread holds' outcomes from the extraction ledger
  // (LocalConnectorStore.setExtractionOutcomeProbe): Gmail attachments and chat
  // media are extracted there too. A file store queues every file, so a file
  // with no job yet is still waiting; elsewhere an item with no job was never
  // going to be read. A tier store opened later gets it in registerTierLegStore.
  const extractionOutcomeFor = (family: string | undefined, identity: TierLedgerIdentity, localItemId: string | undefined) =>
    fileExtractionRuntime?.jobs.itemExtractionOutcome({ ...identity, ...(localItemId === undefined ? {} : { localItemId }) },
      family === 'file' ? {} : { whenNoJob: NO_EXTRACTION_JOB_OUTCOME });
  const probeExtractionEnded = (store: LocalConnectorStore): void => {
    if (!fileExtractionRuntime) return;
    store.setExtractionOutcomeProbe((identity, localItemId) => extractionOutcomeFor(store.family, identity, localItemId));
  };
  for (const store of connectorStores) probeExtractionEnded(store);
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
  const adoptConfiguredPrincipal = (mount: ConnectorStoreMount): void => {
    if (mount.principal && !connectorStorePrincipals.has(mount.store.corpusId)) {
      connectorStorePrincipals.set(mount.store.corpusId, mount.principal);
    }
    if (mount.store.family === 'chat' && mount.chatPrincipal && !connectorStoreAccountScopes.has(mount.store.corpusId)) {
      connectorStoreAccountScopes.set(mount.store.corpusId, mount.chatPrincipal.accountScope);
    }
  };
  for (const mount of configuredConnectorStoreMounts) adoptConfiguredPrincipal(mount);
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
    if (sourceId === LOCAL_FILES_SOURCE_ID && !localFilesCleanupRecovery?.ready()) return { allowed: false };
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
    if (readScope.contentAllowed && !readScope.filters && !readScope.contentFilters) return undefined;
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
    probeExtractionEnded(store);
    if (!fullyDefinedCorpusIds.has(store.corpusId)) {
      const definition = registeredCorpusDefinitions.get(store.corpusId);
      fullCorpusDefinitions.push(defineConnectorCorpus({
        corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain,
        ...(definition ? { activationMode: definition.activationMode } : {}),
        ...(secureEmbeddingCloudApproved && store.trustDomain === 'secure_local' ? { embeddingPolicy: 'cloud_allowed_by_policy' as const } : {}),
      }));
      fullyDefinedCorpusIds.add(store.corpusId);
    }
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
        personalProvider: sourceIndexEmbeddingProvider,
        providers: connectorStoreEmbeddingProviders,
        retrievalAvailability,
      });
    }
  };
  sourceLaneMounted = (stores): void => {
    if (stores.some((store) => !connectorStores.includes(store))) sourceLaneGeneration += 1;
    for (const store of stores) {
      const provider = store === readwiseConnectorStore ? readwiseEmbeddingProvider
        : store === xBookmarksConnectorStore ? xBookmarksEmbeddingProvider
        : store.trustDomain === 'secure_local' ? tierSecureEmbeddingProvider : sourceIndexEmbeddingProvider;
      registerTierLegStore(store, store.corpusId, provider ?? null);
      if (store === dropboxConnectorStore) {
        connectorStoreAccountScopes.set(store.corpusId, dropboxProviderAccount);
        connectorStorePrincipals.set(store.corpusId, { provider: 'dropbox', accountScope: dropboxProviderAccount });
      } else if (store === localFilesConnectorStore) {
        connectorStoreAccountScopes.set(store.corpusId, LOCAL_FILES_ACCOUNT_SCOPE);
        connectorStorePrincipals.set(store.corpusId, { provider: LOCAL_FILES_PROVIDER, accountScope: LOCAL_FILES_ACCOUNT_SCOPE });
      } else if (store === whatsappConnectorStore || store === telegramConnectorStores?.internal || store === telegramConnectorStores?.secureLocal) {
        const telegram = store !== whatsappConnectorStore;
        const accountScope = telegram ? telegramConnectorAccountScope : WHATSAPP_PERSONAL_ACCOUNT_SCOPE;
        connectorStoreAccountScopes.set(store.corpusId, accountScope);
        connectorStorePrincipals.set(store.corpusId, canonicalConnectorStoreChatPrincipal(telegram ? 'telegram' : 'whatsapp', accountScope));
      }
    }
  };
  for (const stores of earlySourceStores.splice(0)) sourceLaneMounted(stores);
  mountConfiguredSourceStores = (): void => {
    if (sourceRuntimeClosed) return;
    const mounts = discoverConfiguredStores();
    for (const mount of mounts) {
      if (!connectorStores.includes(mount.store)) sourceLaneMounted([mount.store]);
      adoptConfiguredPrincipal(mount);
      registerConfiguredTierStore(mount.store);
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
  // Startup and the split front's mount refresh both mount archives here, so a
  // ledger problem is cleared once the background has migrated the ledger.
  const mountArchiveLanes = (): void => {
    try {
      if (sourceAccountMountable({ sourceId: ARCHIVE_IMPORTS_SOURCE_ID })) archiveImports.existingLanes();
      tierLedgerProblems.delete(ARCHIVE_IMPORTS_SOURCE_ID);
    } catch (error) {
      if (error instanceof TierLedgerSchemaError) tierLedgerProblems.set(ARCHIVE_IMPORTS_SOURCE_ID, error.message);
      throw error;
    }
  };
  try {
    mountArchiveLanes();
  } catch (error) {
    console.warn(`[archive-import] imported archives are not served this run: ${error instanceof Error ? error.message : 'error'}`);
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
    if (sourceAccountMountable({ sourceId: EVERNOTE_SOURCE_ID }) && sourceTierLedgerReady(EVERNOTE_SOURCE_ID)) evernote.existingLane();
  } catch (error) {
    console.warn(`[evernote] the Evernote stores are not served this run: ${error instanceof Error ? error.message : 'error'}`);
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
      personalProvider: sourceIndexEmbeddingProvider,
      providers: connectorStoreEmbeddingProviders,
      retrievalAvailability,
    });
  }
  if (readwiseConnectorStore && readwiseEmbeddingProvider) {
    registerConnectorStoreEmbeddingLane({
      store: readwiseConnectorStore,
      provider: readwiseEmbeddingProvider,
      personalProvider: sourceIndexEmbeddingProvider,
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
      personalProvider: sourceIndexEmbeddingProvider,
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
  // boot; one that does not is created by its tier set on first need. The
  // front never creates one: it opens each store once the background has
  // (frontMountRetry), and until then reads the tier as empty.
  const openTierStoresThatExist = (): void => {
    for (const lane of tierLanes) {
      for (const store of lane.onDemand) {
        if (store.current()) continue;
        if (engineFront ? connectorStoreReadableNow(store.dbPath) : store.exists()) store.open();
      }
    }
  };
  openTierStoresThatExist();
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
    const privateCorpusId = gmailSecureConnectorStore?.corpusId;
    const privateDefinition = privateCorpusId && sourceCorpusRegistry.definitions().find(entry => entry.corpusId === privateCorpusId);
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
        defaultLocal: createAnalyst(localSourceAnswerModel, { auditSuspiciousDrafts: true, evidenceFormat: 'compact' }),
        veniceAnalystTimeoutMs,
        veniceReasoningHeadroomTokens,
        bootSecretResolver,
        ...(builtInAnalystModel
          ? { builtInAnalyst: createAnalyst(builtInAnalystModel, { auditSuspiciousDrafts: true, evidenceFormat: 'compact' }) }
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
        ?? createAnalyst(localSourceAnswerModel, { auditSuspiciousDrafts: true, evidenceFormat: 'compact' });
      // Off unless the owner set OLYMPUS_SOURCE_RERANKER=built-in (issue #921).
      const sourceReranker = await prepareBuiltInRerankerFromEnv();
      return createAnalystSourceIndexAnswerHandler({
        inferenceGuard: (pack, request, corpusIds) => guardSourceAnswerEvidence({ lanes: sourceAnswerLanes!, pack, request, corpusIds }),
        analyst: defaultLocalAnalyst,
        releaseCheck: createReleaseTierCheck(
          tierScopes,
          () => secureDerivativeDefault ?? 'allow',
        ),
        queryPlanner: createAnalystQueryPlanner(localSourceAnswerModel),
        ...(sourceReranker ? { reranker: sourceReranker } : {}),
        ...(cloudAnalyst ? { cloudAnalyst } : {}),
        veniceAnalyst: (request) => {
          const requestedProvider = request.analyst_provider ?? (request.analyst_model ? 'venice' : 'default');
          if (requestedProvider !== 'venice') return undefined;
          return createAnalyst(createVeniceAnalystModel(veniceModelOptionsFromRequest(request)));
        },
        sovereigntyAnalystRoute: ({ pack, localOnly, requestedProvider }) => {
          const trustDomain = analystRouteTrustDomain(pack, localOnly);
          return workerSovereigntyAnalystRoutePlan({
            engine: sovereigntyEngine,
            env: process.env,
            trustDomain,
            requestedProvider,
            analysts: sovereigntyAnalysts,
            defaultLocal: builtInAnalystModel
              ? withBuiltInFallback(defaultLocalAnalyst, createAnalyst(builtInAnalystModel, { auditSuspiciousDrafts: true, evidenceFormat: 'compact' }))
              : defaultLocalAnalyst,
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
          limitStops: () => sourceScheduler?.status().limit_stops ?? [],
          stores: () => { mountConfiguredSourceStores(); return readConnectorStores; },
          registry: () => buildSourceIndexCorpusRegistry(
            sourceCorpusRegistry.definitions('answer', fullCorpusDefinitions)
              .filter((definition) => !onDemandCorpusAbsent(definition.corpusId)),
          ),
          embeddingProvider: (store) => connectorStoreEmbeddingProviders.get(store.corpusId) ?? sourceIndexEmbeddingProvider,
          localEmbedding: loadedBuiltInEmbedding,
          readScope: connectorStoreReadScope,
          answerScope: (store, request) => {
            const principal = connectorStorePrincipals.get(store.corpusId);
            return connectorStoreAnswerScope({
              store,
              request,
              ...(principal ? { principal } : {}),
              ...(peopleIndex ? { people: peopleIndex } : {}),
            });
          },
          accountScope: (store) => connectorStoreAccountScopes.get(store.corpusId),
          semanticRelevanceBar: (store) => (store.corpusId === X_BOOKMARKS_CORPUS_ID ? xBookmarksSemanticRelevanceBar : undefined),
          visibilityGate: tierVisibilityGate,
          // A child item's citation names its parent when the parent's names may go where the child goes.
          parentLabels: parentLabelResolver,
          secretLocations: tierSecretLocations,
          checkSecretLocations: checkTierSecretLocations,
          heldItems: (corpusId) => tierLanes.find((candidate) => candidate.corpusIds.has(corpusId))?.ledger.corpusHeldCopyCount(corpusId) ?? 0,
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
  // The background owns source watches and runs their passes; the front lists them.
  const sourceWatchStore = engineFront ? new LocalSourceWatchStore(undefined, { readOnly: true }) : new LocalSourceWatchStore();
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
        currentItems(refs) {
          // One batched check per store for the whole queue (the per-job
          // check below held the worker for seconds on a large Dropbox queue).
          const answers = refs.map(() => false);
          const check = (
            corpusId: string,
            store: LocalConnectorStore | undefined,
            view: { itemsMatchingExtractionRefs: LocalConnectorStore['itemsMatchingExtractionRefs'] } | undefined,
          ): void => {
            if (!store) return;
            const indexes = refs.flatMap((ref, index) => (ref.corpusId === corpusId ? [index] : []));
            if (indexes.length === 0) return;
            const readScope = connectorStoreReadScope(store);
            if (!readScope.allowed || !readScope.contentAllowed) return;
            const matched = (view ?? store).itemsMatchingExtractionRefs(indexes.map((index) => refs[index]!), readScope.contentFilters);
            indexes.forEach((index, position) => { answers[index] = matched[position] === true; });
          };
          check(LOCAL_FILES_CORPUS_ID, localFilesConnectorStore, localFilesExtractionView);
          check(DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID, dropboxConnectorStore, dropboxExtractionView);
          return answers;
        },
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
  // Each store's list of files kept Private before they were read, built in
  // turns off the request path and reused for the readiness window: built on
  // each read it was about a quarter of Sparta's sampled freezes
  // (2026-11-05). Until the first build lands a store lists none of them.
  // Each entry is keyed by the source scope it was built under: a folder the
  // owner takes out of scope must leave the list on the next read, not at the
  // next rebuild, and a build that started under the old scope never serves.
  const settledUnreadableByCorpus = new Map<string, { at: number; key: string; items: readonly ExtractionUnreadableItem[] }>();
  const settledUnreadableBuilding = new Set<string>();
  const settledUnreadableFor = (corpusId: string): readonly ExtractionUnreadableItem[] => {
    const scoped = connectorStores.filter(store => store.corpusId === corpusId)
      .map(store => ({ store, scope: connectorStoreStatusScope(store) }));
    const key = JSON.stringify(scoped.map(({ scope }) => scope ?? null));
    const built = settledUnreadableByCorpus.get(corpusId);
    const usable = built?.key === key ? built : undefined;
    const buildKey = `${corpusId}\0${key}`;
    if ((!usable || Date.now() - usable.at >= DASHBOARD_READINESS_LEDGER_MAX_AGE_MS) && !settledUnreadableBuilding.has(buildKey)) {
      settledUnreadableBuilding.add(buildKey);
      void (async () => {
        try {
          const items: ExtractionUnreadableItem[] = [];
          // A file store leaves out files still waiting for extraction (setExtractionOutcomeProbe).
          for (const { store, scope } of scoped) {
            items.push(...await store.settledUnreadableItemsInTurns(scope));
          }
          settledUnreadableByCorpus.set(corpusId, { at: Date.now(), key, items });
        } catch {
          // A closed or busy store: the older list stands until the next read.
        } finally {
          settledUnreadableBuilding.delete(buildKey);
        }
      })();
    }
    return usable?.items ?? [];
  };
  const localUnreadableFiles = createUnreadableFiles({
        items: (corpusId) => {
          const items = [...(extractionReadinessLedger?.unreadableItems(corpusId) ?? []), ...settledUnreadableFor(corpusId)];
          return Array.from(new Map(items.map(item => [item.ref.localItemId, item])).values());
        },
        verdict: unreadableVerdict,
        locate: locateUnreadableItem,
        parentOf: unreadableParentOfItem,
        // Counts are recounted off the request path, in turns: asking every
        // listed file's verdict on each poll froze the dashboard for 23 s on a
        // large list (Sparta, 2026-11-04). Names and opening still ask each file.
        countsMaxAgeMs: DASHBOARD_READINESS_LEDGER_MAX_AGE_MS,
        turn: ingestionTurn,
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
  // The split's front shows the counts the background last counted (engine-split/front-state.ts).
  const unreadableFiles = engineFront ? frontUnreadableFiles(localUnreadableFiles, () => engineFront!.status()) : localUnreadableFiles;
  const sourceIndexStatus = sourceIndexReadEnabled
    ? createSourceIndexStatusHandler({
      // Read per request: a per-tier store its tier set creates while the
      // runtime is up is reported from that moment, with no restart.
      corpusDefinitions: () => {
        mountConfiguredSourceStores();
        return sourceCorpusRegistry.definitions('status', fullCorpusDefinitions)
          .filter((definition) => !onDemandCorpusAbsent(definition.corpusId));
      },
      connectorStores,
      connectorStoreStatusScope,
      ...(unreadableFiles ? { unreadableCount: (corpusId: string) => unreadableFiles.recheck(corpusId)?.unreadable } : {}),
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
  // The split's background owns source-dashboard.sqlite: the front reads
  // progress read-only and sends its samples to be recorded.
  const sourceDashboardHistory = !sourceIndexReadEnabled ? undefined
    : engineFront ? createFrontDashboardHistory({ path: defaultSourceDashboardHistoryDbPath(), client: engineFront.client })
    : openWritableDashboardHistory();
  // Written by the scheduler's ticks, which run in the background only.
  const sourceIngestionLedger = sourceIndexReadEnabled && !engineFront
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
    // The front mounts only stores the background has created (mountSourceLanes).
    if (handle && (!engineFront || frontCanMount([storeAt(X_BOOKMARKS_SOURCE_ID, 'internal')]))) mountXBookmarks();
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
    // The front mounts only stores the background has created (mountSourceLanes).
    if (handle && (!engineFront || frontCanMount([storeAt(READWISE_SOURCE_ID, 'internal')]))) mountReadwise();
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
    mountSourceLanes(handles);
    if (whatsappConnectorStore && whatsappTierSet) whatsappConnectorStoreSync ??= createWhatsAppConnectorStoreSyncHandler({ tierSet: whatsappTierSet, store: whatsappConnectorStore, account: WHATSAPP_PERSONAL_ACCOUNT_SCOPE, env: process.env, readChild: whatsappReadChild });
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
      ? createDropboxProviderStoreSyncHandler({
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
            if (!sourceTierLedgerReady(EVERNOTE_SOURCE_ID)) return undefined;
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
    }, {
      trickle: (target) => embedsOnThisComputer(target.provider) && localPacer.trickle(),
      onProgress: (target) => { if (embedsOnThisComputer(target.provider)) localPacer.noteLocalWork(); },
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
  // The split's front runs no scheduler: a stand-in answers from the
  // background's snapshot and turns each wake into a command.
  const sourceScheduler = engineFront
    ? createFrontScheduler({ client: engineFront.client, snapshot: () => engineFront!.status(), sourcesChanged: () => refreshFrontMounts() }) as unknown as SourceScheduler
    : olympusConfig.worker.scheduler.enabled
    ? createSourceSchedulerFromConfig({
      config: olympusConfig,
      sources: schedulerSources,
      ...(!(sourceIndexStatus && sourceIngestionLedger)
        ? {
            afterTickMinIntervalMs: SOURCE_STATUS_PUBLISH_MIN_INTERVAL_MS,
            afterTick: () => refreshPeople(),
          }
        : {}),
      ...(sourceIndexStatus && sourceIngestionLedger
        ? {
            // Each delivery reads every store's status; at most one every 30 s.
            afterTickMinIntervalMs: SOURCE_STATUS_PUBLISH_MIN_INTERVAL_MS,
            afterTick: async (schedulerStatus) => {
              // A sync that just completed brings new senders: link them now.
              refreshPeople();
              const status = await sourceIndexStatus.status({ include_items: false }, { countsMaxAgeMs: STATUS_COUNTS_MAX_AGE_MS });
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
  // Re-read disk even with no credential change: an archive can create a source's
  // first stores in the background after this front started.
  const refreshFrontMounts = (): void => {
    const reads = [
      () => mountSourceLanes(activeLaneHandles(readActiveConnectedHandles(process.env), process.env)),
      mountArchiveLanes,
      openTierStoresThatExist,
    ];
    for (const read of reads) {
      try { read(); }
      catch (error) {
        // A partial schema is ordinary while the background creates a lane.
        // It must not stop an archive/source change from reaching that writer.
        console.warn(`[olympus] the front could not open a source's stores yet: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };
  const archiveImportDashboard = createArchiveImportDashboard({
    runtime: archiveImports,
    resolver: createArchivePathResolver(),
    ownsUploads: engineRole !== 'background',
    refreshScheduler: () => {
      // The split's front writes the request and state files only; the
      // background resumes checks and runs imports.
      if (engineFront) { refreshFrontMounts(); void engineFront.client.post({ kind: 'archive_changed' }).catch(() => undefined); return; }
      sourceScheduler?.updateSources(schedulerSourcesForHandles(
        activeLaneHandles(readActiveConnectedHandles(process.env), process.env),
      ).sources);
    },
    ...(engineFront ? { checksElsewhere: () => { refreshFrontMounts(); void engineFront!.client.post({ kind: 'archive_changed' }).catch(() => undefined); } } : {}),
    privateModel: () => archivePrivateModelState(),
    // Without the scheduler, or with a source list that leaves archives out,
    // nothing runs an import or a removal: approving one is refused, and one
    // already waiting says which setting under Needs you.
    scheduling: () => (sourceScheduler ? archiveImportScheduling(olympusConfig.worker.scheduler) : 'disabled'),
  });
  if (!engineFront) archiveImportDashboard.resume();
  // Both roles read archive records, requests and ledger counts directly.
  const archiveViews = archiveImportDashboard;
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
      // No approved scope yet: the picker opens with the owner's "always
      // Private" senders a restore carried back, as they set them.
      mail_scope: mailScopeDraftView(snapshot.mailScope ?? (snapshot.carriedAlwaysPrivateSenders
        ? { ...defaultMailScopeSelection(), alwaysPrivateSenders: snapshot.carriedAlwaysPrivateSenders }
        : undefined)),
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
      if (approval.replayed !== true) {
        // A source restored from a backup: its items are carried over to this
        // approval, under its folders, when it is for the account they came
        // from. Best effort: they are listed again by the run started below.
        try {
          const sets = fileExtractionTierSets();
          rebindRestoredFileScope({
            approval,
            providerAccountId: fileSourceScopeAuthority.approvedProviderAccount(approval),
            sets: [...new Set(definition.corpusIdsToInvalidate.flatMap((corpusId) => sets.get(corpusId) ?? []))].map((set) => {
              const secretLocations = set.secrets();
              return {
                stores: TIER_DOMAIN_ORDER.flatMap((domain) => set.store(domain) ?? []),
                ...(secretLocations ? { secretLocations } : {}),
              };
            }),
          });
        } catch { /* the run lists them again */ }
      }
      let invalidatedJobs = 0;
      // A replayed save (the same request delivered twice) changed nothing:
      // re-invalidating would cancel the jobs its first delivery just queued.
      if (engineFront && approval.replayed !== true) {
        // The background owns the queue: it invalidates these corpora's unsettled jobs.
        await engineFront.client.send({ kind: 'reload', target: 'scope', corpora: [...definition.corpusIdsToInvalidate] }, { timeoutMs: 30_000 });
      } else if (fileExtractionRuntime && approval.replayed !== true) {
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
  let privateAgentListeners: import('../private-agent-listeners.ts').PrivateAgentListeners | undefined;
  let dashboardAgentStore: DashboardAgentConnectionsBackend['store'] | undefined;
  let dashboardRemoteAccess: DashboardAgentConnectionsBackend['remoteAccess'] = () => ({ state: 'off' });
  let dashboardRemoteAccessControl: DashboardAgentConnectionsBackend['remoteAccessControl'];
  // Where a sign-in started from ChatGPT returns (the relay's origin and this
  // install's id); assigned once the relay URL source exists below.
  let chatgptOAuthHandback: () => { origin: string; installId: string } | undefined = () => undefined;
  // Built further down, once the ChatGPT surface exists; the worker only
  // calls it per request.
  let dashboardPanelTools: DashboardPanelTools | undefined;
  // The setup checklist (#1077): bound once the worker exists (it reads the
  // dashboard view through the worker), called only per request.
  let setupStatusNow: (() => Promise<import('../../core/setup-checklist.ts').SetupChecklist>) | undefined;
  // Private answers on this computer (local-private-answers.ts); built below,
  // beside the waiting-question store and the built-in model.
  let localPrivateAnswers: import('./runtime/local-private-answers.ts').LocalPrivateAnswers | undefined;
  // What AI apps received (apps-received.ts); built below, beside the waiting questions.
  let appsReceived: import('../apps-received.ts').AppsReceived | undefined;
  let desktopBridge: ReturnType<typeof manageLinuxOwnerBridge> | ReturnType<typeof connectLinuxOwnerBridgeHost> | undefined;
  closeDesktopBridge = () => { desktopBridge?.close(); privateAgentListeners?.close(); };
  let desktopPoll: ReturnType<typeof setInterval> | undefined;
  let desktopPollingClosed = false;
  const agentApprovalHost = () => resolveAgentApprovalHost({ env: process.env, fileEnv: readWorkerSetupEnv(), port, desktopBridgeReady: () => desktopBridge?.status().state === 'listening' });
  const updateChecker = createUpdateChecker({
    runningVersion: runningOlympusVersion(), platform: process.platform,
    env: process.env, fileEnv: () => readWorkerSetupEnv(),
  });
  // One item's privacy label (issue #1060): the same stores and ledgers `olympus tier set` reaches in this worker.
  const ownerTierItemsContext: OwnerTierItemsContext = {
    // The same outcome, and the same no-job rule, the store's status counts use.
    extractionOutcome: extractionOutcomeFor,
    contentAllowed: (identity, localItemId, locator) => {
      for (const store of connectorStores) {
        if (!store.itemPresence(identity).active) continue;
        if (store.metadataOnlyRuleForLocator(locator ?? undefined) !== undefined) return false;
        const scope = connectorStoreStatusScope(store);
        if (scope?.itemsAllowed === false || scope?.contentAllowed === false) return false;
        if (localItemId && !store.itemMatchesSearchFilters(localItemId, scope?.accountScope, scope?.contentFilters)) return false;
      }
      return true;
    },
  };
  const ownerTierItemsEngine = createOwnerTierItems(ownerTierItemsContext);
  // Update now (#1063): only the standalone engine the installer put in place updates itself.
  const selfUpdater = createSelfUpdater({
    platform: process.platform, runningVersion: runningOlympusVersion(),
    stateDir: join(engineServicePaths().logDir, 'updates'),
    standaloneEngine: isStandaloneEngineProcess(process.env),
    available: () => updateChecker.available(),
  });
  // In-process callers (remote agents' operations over MCP and OpenAPI, the
  // ChatGPT surface, the dashboard panel tools) reach routes as the listener
  // does: in the split's front that is through the forwarding layer, so a
  // write the background owns (a privacy item raise, a watch) goes there.
  // Bound to the front's routes once they exist, below.
  let inProcessFetch: (request: Request) => Promise<Response> = (request) => worker.fetch(request);
  const workerFetchInProcess = (request: Request): Promise<Response> => inProcessFetch(request);
  const worker = createEmailSourceWorker({
    updateAvailable: () => updateChecker.available(),
    ...(isStandaloneEngineProcess(process.env) ? { selfUpdate: selfUpdater } : {}),
    ...(process.platform === 'linux' ? { localModelReadiness: () => linuxModelReadiness(process.env) } : {}),
    agentConnectHost: agentApprovalHost,
    agentConnections: {
      store: (options) => dashboardAgentStore?.(options),
      get privateListeners() { return privateAgentListeners; },
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
    // Local callers read Private, so only items still waiting for their
    // judgment (found by words, not yet by meaning) are counted for them.
    pendingPrivacyItems: () => tierSnifferBacklog?.().pendingItems,
    // Asking for an import or a removal, and reading the list: nothing else (archive-import/agent.ts).
    archiveImportAgent: archiveImportDashboard.agent,
    // One item's privacy label (issue #1060): the same stores and ledgers
    // `olympus tier set` reaches in this worker (cli-operations.ts tierForCli).
    ownerTierItems: ownerTierItemsEngine,
    // "Check the judge" (issue #887): its round file sits beside the owner's privacy profile.
    judgeCheck: createJudgeCheck({ items: ownerTierItemsEngine, get: (itemId) => getOwnerTierItem(itemId, ownerTierItemsContext, { withPreview: true }) }),
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
    authorizeFileExtractionLane: (lane) => {
      if (lane.provider === LOCAL_FILES_PROVIDER && !localFilesCleanupRecovery?.ready()) {
        throw new OperationError('source_index_policy_violation', 'Local-file cleanup is still in progress.');
      }
    },
    ...(fileExtractionRuntime
      ? {
          pdfExtractionLanes: () => pdfExtractionLanes(fileExtractionCorpora(), fileExtractionRuntime.corpusIds),
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
    connectorStores,
    refreshConnectorStores: () => mountConfiguredSourceStores(),
    connectorStoreTierSiblings: (corpusId: string) => [
      ...(tierLanes.find((lane) => lane.corpusIds.has(corpusId))?.corpusIds ?? []),
    ].filter((sibling) => sibling !== corpusId),
    sourceIndexVisibilityGate: tierVisibilityGate,
    secretLocationSearch: tierSecretLocations,
    connectorStoreEmbeddingProviders,
    connectorStoreAccountScopes,
    connectorStorePrincipals,
    connectorStoreReadScope,
    ...(sourceScheduler ? { sourceScheduler } : {}),
    ...(sourceWatchPass
      ? {
          sourceWatch: {
            store: sourceWatchStore,
            recordId: forwardedRecordId,
          },
        }
      : {}),
    ...(sourceIndexReadEnabled
      ? {
          sourceDashboard: {
            sovereigntyEngine,
            systemReport: () => ({
              version: runningOlympusVersion(), os: process.platform, osVersion: release(),
              host: process.env.OLYMPUS_ENGINE_HOST === '1' ? 'standalone' : 'openclaw', engine: 'running',
              model: workerBuiltInModel ? builtInPrivateModelStatus(process.env).state : 'disabled',
              downloads: { search: chatgptEmbeddingState()?.state ?? 'custom', transcription: dashboardTranscriptionState()?.state ?? 'disabled' },
              remote: dashboardRemoteAccess?.().state ?? 'off',
              logs: process.env.OLYMPUS_ENGINE_HOST === '1' ? (() => { const logs = readEngineLogs({ lines: 30 }); return [...logs.stdout, ...logs.stderr]; })() : [],
            }),
            modelChoices,
            backup: backupService,
            goEasy: {
              on: () => localPacer.goEasy(),
              // In the split the background does the local work: it reads the saved choice again.
              save: (on: boolean) => {
                const saved = localPacer.save(on);
                if (engineFront) void engineFront.client.post({ kind: 'reload', target: 'pacing' }).catch(() => undefined);
                return saved;
              },
            },
            judgeSetup: createJudgeSetup({
              spending: judgeSpending, cloud: cloudJudgeRuntime,
              local: () => resolveJudgeChoiceRuntime(judgeRuntimeInput, { choice: 'local', stop: null, remainingDollars: 0 }),
              ledgerPath: resolveClassificationLedgerPath(process.env), promptVersion: () => snifferPromptVersions(privacyOwnerWords()).approval,
              credentialReady: lane => Boolean(safeModelCredential(lane.profile, { ...process.env, ...(readWorkerSetupEnv() ?? {}) })),
              requestReload: () => requestModelReload(),
              observed: () => judgeObservations.observed(),
              secondRoundStatePath: judgeSecondRoundStatePath(process.env),
            }),
            modelSetup: getModelSetup,
            setupStatus: async () => {
              if (!setupStatusNow) throw new Error('the setup checklist is not ready');
              return await setupStatusNow();
            },
            computerSetup: macComputerSetupView,
            saveComputerUseChoice: saveMacComputerUseChoice,
            checkModelSetup: () => {
              if (workerBuiltInModel && builtInPrivateModelStatus(process.env).state === 'failed') void workerBuiltInModel.model.prepare();
              return modelSetup.checkLocalModels();
            },
            discoverLocalModels: (baseUrl) => localModelDiscovery.discover(baseUrl),
            testLocalModels: (selection) => localModelDiscovery.test(selection),
            saveLocalAnswerModel: async (selection) => {
              if (sovereigntyEngine.source !== 'file' || !sovereigntyEngine.path || !modelReloadInstalled || !workerRestartsItself(workerLaunch, process.env)) return { ok: false, detail: 'Olympus cannot apply this change automatically. Restart support and a writable policy are required.' };
              const result = await saveLocalAnswerModel({ path: sovereigntyEngine.path, expected: sovereigntyEngine.config, selection, discovery: localModelDiscovery });
              if (!result.ok) return result;
              if (!requestModelReload()) return { ok: false, detail: 'The model was saved but could not be applied. Restart Olympus and check readiness.' };
              return result;
            },
            saveFirstRunPrivacyChoice: (choice) => {
              if (sovereigntyEngine.source !== 'file' || !sovereigntyEngine.path) return false;
              const result = saveFirstRunPrivacyChoice(sovereigntyEngine.path, choice);
              if (!result.ok || !result.changed) return false;
              requestModelReload();
              return true;
            },
            deferReloads: withDeferredReloads,
            savePrivateAnswerMode: (choice) => {
              if (sovereigntyEngine.source !== 'file' || !sovereigntyEngine.path) return { ok: false, message: 'This Olympus has no policy file to change.' };
              // The policy on disk, not the boot copy: an earlier change may already be saved.
              let current;
              try { current = validateSovereigntyConfig(JSON.parse(readFileSync(sovereigntyEngine.path, 'utf8'))); }
              catch { return { ok: false, message: 'The privacy policy file cannot be read.' }; }
              let result;
              try { result = savePrivateAnswerMode(sovereigntyEngine.path, choice, current); }
              catch (error) { return { ok: false, message: error instanceof Error ? error.message : 'The Private-answer mode could not be saved.' }; }
              if (!result.ok) return { ok: false, message: 'The privacy policy changed while saving. Refresh and try again.' };
              if (!result.changed) return { ok: true, message: 'Already in use.' };
              return { ok: true, message: requestModelReload() ? 'Saved. Olympus is applying it.' : 'Saved. Restart Olympus to apply it.' };
            },
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
            // People (#1076): the people index and the owner's corrections.
            ...(peopleIndex
              ? { people: createDashboardPeople({ index: peopleIndex, refresh: relinkPeople }) }
              : {}),
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
            appsReceived: {
              handle: (body) => (appsReceived
                ? appsReceived.handle(body)
                : Promise.resolve({ status: 503, body: { ok: false, error: { code: 'unavailable', message: 'Olympus is still starting. Try again in a moment.' } } })),
            },
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
            unlinkWhatsAppDevice,
            withMessagingCapturePaused: captureOwnership.withMessagingCapturePaused,
            // In the split the background runs capture: the dashboard shows its snapshot (#1224).
            captureRuntime: engineFront ? frontCaptureRuntime(dashboardCaptureRuntime, () => engineFront!.status()) : dashboardCaptureRuntime,
            // Delete indexed data: the same supervised restart a model-key
            // change uses. `canRestart` has no side effect, so the route can
            // check it before deleting anything.
            workerRestart: {
              canRestart: () => modelReloadInstalled && workerRestartsItself(workerLaunch, process.env),
              request: (reload) => restartForDelete(reload),
            },
            corpusRegistry: sourceCorpusRegistry,
            registryPath: handleRegistryPathFromEnv(process.env, true)!,
            ...(sourceDashboardHistory ? { history: sourceDashboardHistory } : {}),
            ingestionDispositions: (options?: { lazyStores?: boolean }) => openIngestionDispositionsRuntime(process.env, options),
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
  const { resolveRemotePublicUrls, currentRemotePublicUrls, claudeAppOrigin } = await import('../../core/remote-public-url.ts');
  const { carriesRelayMarker, createRemotePublicUrlSource, isRelayedRequest } = await import('../../core/remote-access.ts');
  const { withRequestPeer } = await import('../../core/request-peer.ts');
  const { createRelaySurfacesHandler, withRelaySurfacesRoute } = await import('../relay-surfaces.ts');
  const { isChatGptGrant, grantMcpSurface, pinnedGrantProvider } = await import('../remote-oauth/pinned-clients.ts');
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
  // The waiting questions belong to the process that serves the panel and the
  // agents (the front, or the single worker). A background in the split runs
  // no queue consumer: it has none of the panel's claims, and two consumers
  // could answer one question twice.
  const frontOwnsPrivateAnswerQueue = engineRole !== 'background';
  {
    // Every request an AI app or agent makes, recorded where its result leaves (core/app-release-capture.ts).
    const { createAppsReceived } = await import('../apps-received.ts');
    const { appReleaseLogDbPath } = await import('../../core/app-release-log.ts');
    const { runTierSetOnRecordedItem } = await import('../classification/tier-cli.ts');
    appsReceived = createAppsReceived({
      dbPath: appReleaseLogDbPath(resolveRemoteConnectionsDbPath(process.env)),
      // The per-item override (`olympus tier set <item> private`) on exactly the recorded item:
      // its locator must still name the same provider, item and conversation, or nothing is written.
      // In the split the background owns the tier ledgers and writes the override.
      setItemPrivate: engineFront
        ? frontSetItemPrivate(engineFront.client)
        : async ({ locator, ...expected }) => runTierSetOnRecordedItem(locator, 'private', expected),
    });
  }
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
  let remoteAccessRestartFailed = false;
  dashboardRemoteAccess = () => {
    if (remoteAccessRestartFailed) return { state: 'invalid', detail: 'Olympus saved the setting but could not restart. Remote access may still be on. Try the switch again; if it keeps failing, copy the system report from Help and contact support.' };
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
    const requestEngineRestart = createDashboardEngineRestart({
      restart: () => { restartEngine({ quietWaitMs: 0 }); },
      failed: () => { remoteAccessRestartFailed = true; console.warn('[olympus] remote_access_restart_failed'); },
    });
    dashboardRemoteAccessControl = remoteAccessHostKind === 'standalone'
      ? createStandaloneRemoteAccessControl({
            write: enabled => setEngineRemoteAccessEnabled(engineServicePaths().configPath, enabled),
            ...(process.platform !== 'darwin' ? { unsupportedReason: 'Changing remote access from this dashboard is not available on Linux yet. Copy the system report from Help and contact support.' } : {}),
            canRestart: () => {
              try { waitForQuietEngine({ quietWaitMs: 0 }); return inspectEngine().state === 'running'; }
              catch { return false; }
            },
            requestRestart: () => { remoteAccessRestartFailed = false; return requestEngineRestart(); },
          })
      : createDashboardRemoteAccessControl({ setEnabled: createGatewayRemoteAccessConfigWriter({ authToken, env: process.env }) });
  }
  // App connections are the owner's interactive work; other live remote
  // agents are background connections. An unknown id is not one.
  function isBackgroundConnection(connectionId: string | undefined): boolean {
    if (!connectionId) return false;
    try {
      const record = remoteConnections()?.list().find((connection) => connection.id === connectionId);
      return record !== undefined && grantMcpSurface(record, claudeAppEnabled(olympusConfig)) === 'remote';
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
    inboxRemote: () => {
      const mode = resolveServerMode({ env: process.env, fileEnv: readWorkerSetupEnv(), desktopReady: () => agentApprovalHost().headless === false });
      return mode.remote ? remoteOpenInstructions({ port, ...(mode.sshTarget ? { sshTarget: mode.sshTarget } : {}),
        ...(process.platform === 'linux' ? { socketPath: workerSocketPath()! } : {}), target: { kind: 'private_answers' } }) : undefined;
    },
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
    const { createLocalAnswerPath, createLocalPrivateAnswers } = await import('./runtime/local-private-answers.ts');
    const { privateVeniceMembers, createVeniceInboxAnswer } = await import('./runtime/venice-inbox-answer.ts');
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
    const destinations = (): import('./runtime/venice-inbox-answer.ts').AskDestinationStates => {
      let venice: import('./runtime/venice-inbox-answer.ts').AskDestinationState = 'not_allowed';
      let veniceModel: string | undefined;
      try {
        const members = privateVeniceMembers(loadSourceWorkerSovereignty(olympusConfig, process.env));
        veniceModel = members[0]?.profile.model;
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
      const computerModel = workerBuiltInModel?.model.spec.displayName;
      return { computer: workerBuiltInModel?.available() ? 'ready' : 'not_set_up', venice, ...(computerModel ? { computerModel } : {}), ...(veniceModel ? { veniceModel } : {}), ...(['downloading', 'verifying', 'loading'].includes(modelState ?? '') ? { computerReason: PRIVATE_ANSWERS_COPY.downloading } : {}) };
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
      eligibleSecrets: local.eligibleSecrets,
      resolveSecretInbox: handle => privateAnswers.resolveSecretInbox(handle),
      panelSecretNotice: ref => privateAnswers.hasSecretInbox(ref),
      panelSecretOnlyNotice: ref => privateAnswers.hasSecretInbox(ref, true),
      secretSources: local.secretSources,
      ...(openCitedFile ? { openFile: openCitedFile } : {}),
      ...(process.platform === 'darwin' ? {
        openUrl: async (url: string, eligible: () => Promise<boolean>) => {
          if (!(await eligible())) throw new Error('open refused');
          await new Promise<void>((resolve, reject) => execFile('/usr/bin/open', [url], { timeout: 10_000 }, error => error ? reject(error) : resolve()));
        },
      } : {}),
    });
    if (frontOwnsPrivateAnswerQueue) localPrivateAnswers.start();
  } else {
    const { createLocalPrivateAnswers } = await import('./runtime/local-private-answers.ts');
    localPrivateAnswers = createLocalPrivateAnswers({
      destinations: () => ({ computer: 'not_set_up', venice: 'not_set_up' }),
      store: waitingQuestionStore, isActive: connectionActive,
      connectionName: (id) => localInboxLabel(id) ?? remoteConnections()?.list().find(c => c.id === id)?.displayName,
      answer: async () => ({ status: 'no_model' }),
      eligible: async items => items.map(() => false),
      anonymousAsk: localAnonymousAsk,
    });
    if (frontOwnsPrivateAnswerQueue) localPrivateAnswers.start();
  }
  // The private question panel's jobs (chatgpt/private-question-jobs.ts):
  // the sealed question runs the same ask lane as the ask_anonymously tool,
  // with the caller placed by the host that opened the panel: Anthropic for a
  // Claude grant (so the same-provider refusal and claudeFrontierModel apply),
  // otherwise OpenAI-hosted, since ChatGPT opened it.
  const panelHost = (connectionId: string | undefined): { provider: 'openai' | 'anthropic'; label: string } => {
    const connection = connectionId ? remoteConnections()?.list().find((record) => record.id === connectionId) : undefined;
    return connection && pinnedGrantProvider(connection) === 'anthropic'
      ? { provider: 'anthropic', label: '@local:Claude' }
      : { provider: 'openai', label: '@local:ChatGPT' };
  };
  const privateQuestions = new PrivateQuestionJobs({
    installId: () => remotePublicUrls()?.installId,
    ask: (input) => {
      if (!askAnonymouslyNow) return Promise.resolve({ ok: false as const, code: 'transport_unavailable', message: 'Anonymous answers are not set up on this computer.' });
      const host = panelHost(input.connectionId);
      return askWithAnonymousInbox({
        question: input.question,
        level: input.level,
        ...(input.cleanup !== undefined ? { cleanup: input.cleanup } : {}),
        callerProvider: host.provider,
        signal: input.signal,
        stillAuthorized: input.stillAuthorized,
      }, { deliveredToPanel: true, store: waitingQuestionStore, connectionId: host.label, ask: askAnonymouslyNow });
    },
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
    // The funding date follows the policy file (`olympus zkapi funding-date`) without a restart.
    const { zkapiFundingDateRefresher } = await import('../../core/zkapi-funding-date.ts');
    const zkapiProfiles = zkapiFundingDateRefresher(sovereigntyEngine.source === 'file' ? sovereigntyEngine.path : undefined);
    const transport = (model: string) => resolveZkapiConsultTransport(
      zkapiProfiles(sovereigntyEngine.config.modelProfiles),
      (secretRef) => resolveSecretRefValueSync(secretRef, { env: environmentWithWorkerSetupEnv() }),
      { env: process.env, model },
    );
    // The route's settings and today's record only: no key is resolved for this check.
    zkapiDailyLimitNow = () => {
      const route = resolveZkapiConsultTransport(zkapiProfiles(sovereigntyEngine.config.modelProfiles), () => undefined, { env: process.env });
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
      ? probePrivateMatch({ lanes: sourceAnswerLanes, request: request as unknown as SourceIndexAnswerRequest, timeoutMs, distinguishSecret: true })
      : Promise.resolve('unknown' as const)),
    store: waitingQuestionStore,
    isActive: connectionActive,
    // The re-check is background work: it waits on the model's keyword
    // translation as long as it needs, and starts no probe while the owner's
    // own answer is in flight.
    interactiveBusy: () => answerActivity.interactiveInFlight > 0,
  });
  const uncheckedRetry = frontOwnsPrivateAnswerQueue ? setInterval(() => {
    void remotePrivateParts.retryUnchecked().catch(() => undefined);
  }, 10 * 60_000) : undefined;
  uncheckedRetry?.unref?.();
  const remoteAgentOptions = {
    connections: remoteConnections,
    // A demo sign-in grant gets only the read-only tools, on /mcp and OpenAPI alike.
    demoGrant: isDemoGrant,
    publicUrls: remotePublicUrls,
    makeOperationContext: (caller: Parameters<typeof createInProcessOperationContext>[0]['caller'], signal: AbortSignal) => ({
      ...createInProcessOperationContext({
        config: olympusConfig,
        sourceIndexReadEnabled,
        workerFetch: workerFetchInProcess,
        caller,
        signal,
        sourceAnswerJobs,
      }),
      // The remote output boundary revalidates a collected answer's release
      // manifest against the tier ledgers and release rules as they are now
      // (core/remote-result.ts).
      releaseCheck: remoteReleaseCheck,
      // An agent outside this computer reads no Private store: an item
      // waiting for its judgment, and one judged lower whose move out of
      // Private is still queued, are both out of its reach until then.
      pendingPrivacyItems: () => {
        const backlog = tierSnifferBacklog?.();
        return backlog ? backlog.pendingItems + backlog.lowerMovesQueued : undefined;
      },
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
  // Items held for the privacy check (pending, Private, not embedded), each
  // item once per tier ledger (heldItemCount). Counts only.
  // Reused for a minute: each count reads every copy the tier ledgers hold,
  // and the dashboard's privacy panel asks on every poll (Sparta, 2026-11-05:
  // about a tenth of the sampled freezes).
  let pendingClassificationCounted: { at: number; total: number } | undefined;
  const pendingClassificationCount = (): number => {
    if (pendingClassificationCounted && Date.now() - pendingClassificationCounted.at < 60_000) return pendingClassificationCounted.total;
    const total = countPendingClassification();
    pendingClassificationCounted = { at: Date.now(), total };
    return total;
  };
  const countPendingClassification = (): number => {
    let total = 0;
    for (const lane of tierLanes) {
      try {
        // Each item once, also one recorded Personal-first before #1316.
        total += lane.ledger.heldItemCount([...lane.corpusIds]);
      } catch {
        // An unreadable ledger contributes nothing to a count.
      }
    }
    return total;
  };
  const chatgptSetup = createChatGptSetupBackend({
    privacyQuestionEngine: createPrivacyQuestionEngine({ runtime: async () => {
      if (!snifferModel || !snifferLane || !snifferEnv.enabled || snifferRuntime.source === 'off') return undefined;
      if (snifferRuntime.source === 'built_in' && !snifferRuntime.builtIn.available()) return undefined;
      const ledger = await readClassificationLedger(resolveClassificationLedgerPath(process.env));
      const approved = isClassifierApproved(ledger.entries, {
        lane: snifferLane.kind, profileId: snifferLane.profileId, modelId: snifferLane.modelId,
        promptVersion: snifferPromptVersions(privacyOwnerWords()).approval,
      }, { builtInDefault: snifferRuntime.source === 'built_in' });
      return { lane: snifferLane, approved, model: {
        complete: request => runClassificationInference(() => (snifferResource
          ? localModelActivity.track(snifferResource, snifferModel) : snifferModel).complete(request)),
      } };
    } }),
    pendingClassificationCount,
    workerFetch: workerFetchInProcess,
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
  const { createDashboardConsultAdapter } = await import('./dashboard/dashboard-consult.ts');
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
  saveZkapiModel = async (model) => {
    const current = readConsultSettings();
    const revision = current.state === 'valid' ? current.settings.revision : 0;
    const result = await dashboardConsult.saveWriter({ revision, chatgpt_frontier_model: model ?? null });
    return result.ok ? { ok: true as const } : { ok: false as const, message: 'message' in result && typeof result.message === 'string' ? result.message : 'Olympus could not save the zkAPI model.' };
  };
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
  // count leaves the engine. The claim refresh also follows original matches
  // that have moved to a lower tier; those still go only to the private job.
  const chatgptPrivateMatchProbe = sourceAnswerLanes
    ? async (question: string, _ctx: import('../../core/operations.ts').OperationContext, originalMatches?: readonly Readonly<Record<string, unknown>>[]) => {
        const result = await searchPrivateEvidence({ lanes: sourceAnswerLanes!, question, ...(originalMatches ? { originalMatches } : {}) });
        return { count: result.matched, evidence: result.candidates as unknown as readonly Record<string, unknown>[], ...(result.secretMatch ? { secretMatch: true as const } : {}) };
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
    limitStops: () => sourceScheduler?.status().limit_stops ?? [],
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
      const backlog = tierSnifferBacklog?.();
      const missing = judgeMissing();
      return {
        configured: settings.configured, pendingCount: settings.pendingCount, ruleCount: settings.rules.length,
        classifierAwaitingApproval: backlog?.awaitingOwnerApproval === true,
        // No judge: every new item waits, held, until one is set up (#1316).
        ...(missing ? { judgeMissing: missing } : {}),
        ...(backlog?.awaitingApproval ? { classifierWaiting: { lane: backlog.awaitingApproval.lane, modelId: backlog.awaitingApproval.modelId } } : {}),
      };
    },
  };
  const { withEngineBriefRoute } = await import('../engine-brief-route.ts');
  const { dashboardViewModel: engineBriefView } = await import('../chatgpt/mcp-surface.ts');
  const { createDashboardPanelTools } = await import('./dashboard/dashboard-panel-tools.ts');
  const { readSetupWorkerFacts, setupChecklistFromView } = await import('../setup-status.ts');
  const setupWorkerFacts = () => readSetupWorkerFacts({
    version: runningOlympusVersion(),
    policy: { config: sovereigntyEngine.config, ...(sovereigntyEngine.source === 'file' && sovereigntyEngine.path ? { path: sovereigntyEngine.path } : {}) },
    ...(sourceIndexReadEnabled ? { judge: judgeSpending } : {}),
    connections: () => dashboardAgentStore?.(),
    // Only positive evidence counts: the OpenClaw Gateway supervising this
    // worker as its native service (as `remote` above). A hand-run worker or
    // the standalone engine host has no AI app until one is connected.
    ...(process.env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID?.trim() && remoteAccessHostKind === 'openclaw' ? { hostAgent: 'OpenClaw' } : {}),
  });
  setupStatusNow = async () => {
    const response = await worker.fetch(new Request('http://olympus-worker.internal/dashboard.json'));
    const view = response.ok ? await response.json() as SourceDashboardViewModel : undefined;
    return setupChecklistFromView(view, setupWorkerFacts());
  };
  dashboardPanelTools = createDashboardPanelTools({
    setupChecklist: (view) => setupChecklistFromView(view, setupWorkerFacts()),
    surface: () => chatgptSurface,
    setup: chatgptSetup,
    workerFetch: workerFetchInProcess,
    makeContext: (signal) => remoteAgentOptions.makeOperationContext({ surface: 'native', displayName: 'Olympus dashboard' }, signal),
    indexFasterState: async () => {
      const runtime = await readEmbeddingRuntime({ env: process.env });
      return runtime.state === 'unknown' ? undefined : runtime.overrideOn;
    },
    unreadableFiles: () => unreadableFiles,
    waitingPrivateQuestions: () => localPrivateAnswers?.waitingCount() ?? 0,
    archives: () => archiveViews.view(),
    sourceImports: () => archiveViews.sourceImports(),
    archiveSources: () => archiveViews.archiveSources(),
    archiveCards: () => archiveViews.cardViews(),
    // Exactly the local model the check reports waiting, as the CLI's approve
    // records it. In the split the background reads the ledger on its next tick.
    approveWaitingClassifier: async () => {
      const waiting = tierSnifferBacklog?.()?.awaitingApproval;
      if (!waiting) return 'nothing_waiting';
      if (waiting.lane !== 'local') return 'not_local';
      await approveClassifier(resolveClassificationLedgerPath(process.env),
        { kind: waiting.lane, profileId: waiting.profileId, modelId: waiting.modelId }, waiting.promptVersion,
        'Owner approved this local model in the dashboard on this computer.');
      tierSniffer?.wake();
      return 'approved';
    },
  });

  const sharedRemoteMcpOptions = {
    ...remoteAgentOptions,
    anonymousAnswersEnabled: () => {
      const read = readConsultSettings();
      return read.state === 'valid' && read.settings.enabled;
    },
    ...(remoteEvidenceSearch
      ? { search: { evidenceSearch: remoteEvidenceSearch, answerModelAvailable: chatgptAnswerModelAvailable } }
      : {}),
  };
  // A socket left by the unit's previous run, which systemd has already
  // stopped (worker-transport.ts).
  // The split's background serves no HTTP: the worker socket and port are the front's.
  const listens = engineRole !== 'background';
  // The split's front: owner actions that write background-owned data are
  // forwarded behind the front's own authorization (engine-split/runtime.ts),
  // and a source-data delete closes the gate on every read first.
  const frontGate = engineFront ? createFrontGate() : undefined;
  const frontRoutes = engineFront ? createEngineFrontRoutes({
    client: engineFront.client,
    gate: frontGate!,
    restartFront: () => {
      // Only the front: the background is already restarting for the delete.
      if (!restartFrontOnly()) console.warn('[engine-split] the front could not restart after a source-data delete; it answers "restarting" until it is restarted.');
    },
    // People's corrections rebuilt the background's index: the front reads it now (#1224).
    afterAnswer: (kind) => { if (kind === 'people') refreshPeople(true); },
  }) : undefined;
  const frontWorkerFetch = frontRoutes
    ? async (request: Request): Promise<Response> => (await frontRoutes(request)) ?? worker.fetch(request)
    : worker.fetch;
  inProcessFetch = frontWorkerFetch;
  if (listens && releaseSystemdWorkerSocket()) console.warn('[olympus:worker] removed the socket left by the previous worker run');
  const socketPath = listens ? prepareWorkerSocket() : undefined;
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
    fetch: withRequestPeer(withFirstRunPrivacyGate(withRelaySurfacesRoute(createRelaySurfacesHandler({
      connections: () => remoteConnections(),
      publicUrls: remotePublicUrls,
      claudeAppEnabled: () => claudeAppEnabled(olympusConfig),
      isRelayed: isRelayedRequest,
    }), withChatGptHandoffRoutes(createChatGptHandoffHandler(chatgptHandoffs, { isRelayed: carriesRelayMarker }), withPrivateAnswerRoute(createPrivateAnswerHandler({
      jobs: privateAnswers,
      questions: privateQuestions,
      isRelayed: isRelayedRequest,
      extraOrigins: () => {
        const urls = currentRemotePublicUrls(remotePublicUrls);
        return [DASHBOARD_UI_DOMAIN, ...(claudeAppEnabled(olympusConfig) && urls
          ? [claudeAppOrigin(urls)] : [])];
      },
    }), withRemoteOAuthRoutes(
      createRemoteOAuthHandler({
        publicUrls: remotePublicUrls,
        requireOwnerSocket: !!socketPath,
        // Any marker, verified or not, refuses approval (fails closed).
        isRelayed: carriesRelayMarker,
        // Approving from a browser off the owner socket needs the owner's
        // dashboard session, checked with the same keys that sign it (#1186).
        ownerSession: dashboardOwnerSessionCheck({ authToken, sessionSecret: dashboardSessionSecret.secret }),
        // Demo installs only: inert without remote.demoConsent AND the demo marker.
        demoConsent: () => resolveDemoConsent(olympusConfig.remote, () => demoInstallMarked(remoteAccessDir(process.env))),
        connections: () => remoteConnections({ create: true })!,
      }),
      // Each remote agent route sits inside its own exception boundary, so a
      // failure there is a fixed JSON error, never the runtime's error page;
      // the worker-bearer routes keep their own handling.
      withRemoteOpenApiRoutes(withRemoteFailureBoundary(remoteOpenApi), withRemoteMcpRoute(
        withRemoteFailureBoundary(createRemoteMcpHandler({
          ...sharedRemoteMcpOptions,
          claudeApp: { enabled: () => claudeAppEnabled(olympusConfig) },
          // Only the public relay route can select the pinned ChatGPT surface.
          chatgpt: {
            servesRequest: (request: Request, connection: { clientId?: string | null }) => isRelayedRequest(request) && isChatGptGrant(connection),
            readOnlyFor: isDemoGrant,
            ...chatgptSurface,
          },
        })),
        // The brief route must pass both bearer and owner-socket authorization.
        withWorkerBearerAuth(withEngineBriefRoute(frontWorkerFetch, { view: (signal) => engineBriefView(chatgptSurface, signal) }), { authToken, requireOwnerSocket: !!socketPath, sessionSecret: dashboardSessionSecret.secret }),
      )),
    )))), { pending: () => privacyChoicePending(sovereigntyEngine), isRelayed: carriesRelayMarker }), !!socketPath),
  };
  const fetchWithTierLedgerStatus = serverOptions.fetch;
  serverOptions.fetch = (async (request, server) => {
    const response = await fetchWithTierLedgerStatus(request, server);
    const path = new URL(request.url).pathname;
    if ((path === '/v1/health' || path === '/health') && response?.ok && tierLedgerProblems.size) {
      return Response.json({ ...await response.json() as object, privacy_ledger_problems: Object.fromEntries(tierLedgerProblems) }, { status: response.status, headers: response.headers });
    }
    return response;
  }) as typeof serverOptions.fetch;
  if (engineFront) {
    // Every request passes the read gate a source-data delete closes.
    serverOptions.fetch = frontGate!.wrap(serverOptions.fetch) as typeof serverOptions.fetch;
  }
  // Nothing is answered from the local files index before what an earlier version
  // indexed inside Olympus's own folders is gone (own-roots-cleanup.ts).
  await localFilesInitialCleanup;
  const startServer = () => socketPath
    ? Bun.serve(workerSocketServe({ unix: socketPath, fetch(request, server) {
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
      } }))
    : Bun.serve({ hostname, port, idleTimeout: 0, ...serverOptions });
  // Bounded: a set that has to be rebuilt from the ledger (a retention gap)
  // finishes after the front listens, in turns, rather than hold readiness.
  if (engineFront) {
    const warming = keepVisibilityCurrent('before ready');
    let bound: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([warming, new Promise<void>((resolve) => { bound = setTimeout(resolve, FRONT_VISIBILITY_READY_BOUND_MS); })]);
    clearTimeout(bound);
  }
  const server = !listens ? undefined : socketPath ? bindWorkerSocket(socketPath, startServer) : startServer();
  // The single worker's boot work ends when it listens; the background's when it is ready on its socket.
  if (engineRole === 'single') finishBootProgress();
  if (listens) {
  // This Bun worker owns listener lifecycle on standalone Mac/Linux and
  // OpenClaw-hosted installs alike. Dashboard-only backends without this
  // capability omit privateListeners and hide the choices.
  const { createPrivateAgentListeners } = await import('../private-agent-listeners.ts');
  privateAgentListeners = createPrivateAgentListeners({
    connections: remoteConnections,
    mcp: sharedRemoteMcpOptions,
    privacyPending: () => privacyChoicePending(sovereigntyEngine),
    ...(frontGate ? { gate: (handler: (request: Request) => Promise<Response>) => frontGate.wrap(handler) } : {}),
  });
  updateChecker.start();
  }
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
        // The cookies, and the unlock key the browser's storage keeps (#1187).
        const body = (await response.json().catch(() => undefined) ?? {}) as { unlock_key?: unknown };
        return { cookies: response.headers.getSetCookie(), ...(typeof body.unlock_key === 'string' ? { unlockKey: body.unlock_key } : {}) };
      },
    });
    desktopPoll = setInterval(() => { void probeDesktop(); }, 2_000); desktopPoll.unref();
  }
  sourceScheduler?.start();
  // Captures are background work; the split's front runs none.
  if (!engineFront) await reconcileCaptures();
  const captureTick = setInterval(() => { if (!engineFront) void reconcileCaptures(); }, 10_000);
  captureTick.unref?.();
  // The one-time superseded-copy sweep's own clock; the split's front runs none.
  const stopSupersededSweep = startSupersededSweepTicker({ active: () => !engineFront });

  // The privacy-safe sniffer's bounded background pass over pending items.
  const snifferEnv = tierSnifferServiceEnv(process.env);
  const rawSnifferModel: SnifferModel | undefined = !snifferEnv.enabled || snifferRuntime.source === 'off'
    ? undefined
    : snifferRuntime.source === 'built_in'
      ? snifferRuntime.builtIn.model
      : createTierSnifferModel({ lane: snifferRuntime.lane, configuredProfile: judgeRuntimeInput.engine.config.modelProfiles[snifferRuntime.lane.profileId], olympusConfig, env: process.env, bootSecretResolver, judgeStatus: () => judgeSpending.status(), judgeFetch: judgeSpending.fetch(fetch), judgeOnStop: () => { requestModelReload(); } });
  snifferModelBuilt = rawSnifferModel !== undefined;
  // The local judge's answers are read at its own lane's Private bar, as the resolver reads them.
  const localDecisionBar = snifferLane ? snifferDecisionBar(snifferLane) : undefined;
  const snifferModel: SnifferModel | undefined = rawSnifferModel && snifferLane?.kind === 'local' ? observedJudge(rawSnifferModel, judgeObservations, localDecisionBar) : rawSnifferModel;
  const snifferResource = snifferRuntime.source === 'built_in' ? 'built_in'
    : snifferLane?.kind === 'local' ? localModelResourceKey(snifferLane.profile) : undefined;
  // The owner's own call on the shared model, as the split's front reported it
  // (owner_busy / owner_idle), until it says idle or ten minutes pass.
  const remoteOwnerMarks = new OwnerBusyMarks();
  const remoteOwnerBusy = (resource: string): boolean => remoteOwnerMarks.busy(resource);
  // This computer, then Venice double-checks (#891): the local judge sorts everything, and
  // Venice re-reads only what it held Private, on the same lane, consent and spending limit.
  const judgeChoice = judgeSpending.status();
  // The front judges nothing, so it runs no double-check either.
  const secondRoundVenice = !engineFront && snifferModel && snifferLane?.kind === 'local' && judgeChoice.choice === 'local-then-venice'
    && !judgeChoice.stop && (judgeChoice.uncapped === true || judgeChoice.remainingDollars > 0) && cloudJudgeRuntime.source !== 'off'
    && isClassifierApproved((await readClassificationLedger(resolveClassificationLedgerPath(process.env))).entries, {
      lane: cloudJudgeRuntime.lane.kind, profileId: cloudJudgeRuntime.lane.profileId, modelId: cloudJudgeRuntime.lane.modelId,
      promptVersion: snifferPromptVersions(privacyOwnerWords()).approval,
    })
    ? createTierSnifferModel({ lane: cloudJudgeRuntime.lane, configuredProfile: judgeRuntimeInput.engine.config.modelProfiles[cloudJudgeRuntime.lane.profileId], olympusConfig, env: process.env, bootSecretResolver, judgeStatus: () => judgeSpending.status(), judgeFetch: judgeSpending.fetch(fetch), judgeOnStop: () => { requestModelReload(); } })
    : undefined;
  if (!engineFront && judgeChoice.choice === 'local-then-venice' && snifferModel && !secondRoundVenice) {
    console.warn('Olympus privacy judge: the Venice double-check is paused (no approved Venice judge, or its spending limit stopped it); items stay Private as this computer judged them.');
  }
  const secondRoundSweep = secondRoundVenice ? new SecondRoundSweep({
    statePath: judgeSecondRoundStatePath(process.env),
    setFor: tierSetForLedger,
    unanswered: (ledgerPath, id) => installedTierClassification.snifferStoreForLedger(ledgerPath).questionWorkCounts(id).unanswered,
  }) : undefined;
  const secondRoundCounts = { asked: 0, released: 0, kept: 0, failed: 0, stopped: 0 };
  let lastSecondRoundLog = '';
  const secondRoundConfirmed = secondRoundVenice ? new SecondRoundConfirmed(judgeSecondRoundConfirmedPath(process.env)) : undefined;
  const withSecondRound = (model: SnifferModel): SnifferModel => secondRoundVenice ? secondRoundJudge(model, secondRoundVenice, secondRoundCounts, secondRoundConfirmed, localDecisionBar) : model;
  // The front judges nothing: the background is the only judge.
  const tierSniffer = !engineFront && snifferLane && snifferModel
    ? new TierSnifferService({
        installed: installedTierClassification,
        lane: snifferLane,
        model: withSecondRound(snifferResource ? {
          ...snifferModel,
          ...(snifferModel.prepareSniffer ? {
            prepareSniffer: (signal?: AbortSignal) => runClassificationInference(() => localModelActivity.track(snifferResource, snifferModel, { tag: 'tier_sniffer' }).prepareSniffer!(signal)),
          } : {}),
          // The completion says how long it waited for the model slot (#893).
          complete: request => completeAfterSlot(snifferModel, timed => runClassificationInference(() => localModelActivity.track(snifferResource, timed, { concurrency: Math.min(SNIFFER_MAX_CONCURRENT_CALLS, snifferEnv.concurrentCalls ?? 1), tag: 'tier_sniffer' }).complete(request))),
        } : snifferModel),
        ...(secondRoundSweep ? { secondRound: async (ledgerPaths, autoMovesFor) => {
          const reopened = await secondRoundSweep.run(ledgerPaths, autoMovesFor, ingestionTurn);
          const counts = JSON.stringify(secondRoundCounts);
          if (reopened > 0 || counts !== lastSecondRoundLog) {
            lastSecondRoundLog = counts;
            console.log(`Olympus privacy judge: Venice double-check: ${reopened} held item(s) re-opened this tick; ${secondRoundCounts.asked} asked, ${secondRoundCounts.released} released to Personal, ${secondRoundCounts.kept} kept Private, ${secondRoundCounts.failed} failed and ${secondRoundCounts.stopped} stopped (kept Private).`);
          }
        } } : {}),
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
        ...(snifferEnv.concurrentCalls !== undefined ? { concurrentCalls: snifferEnv.concurrentCalls }
          : snifferLane.kind === 'venice' ? { concurrentCalls: DEFAULT_VENICE_JUDGE_CONCURRENT_CALLS } : {}),
        ...(snifferEnv.maxCallsPerDay !== undefined ? { maxCallsPerDay: snifferEnv.maxCallsPerDay } : snifferLane.kind === 'venice' && !judgeSpending.status().uncapped ? { maxCallsPerDay: Number.MAX_SAFE_INTEGER } : {}),
        // Its own parallel calls are not answers: only someone else's call holds it back.
        answersInFlight: () => snifferResource !== undefined && (localModelActivity.busyExcept(snifferResource, 'tier_sniffer') || remoteOwnerBusy(snifferResource)),
        ownerInFlight: () => snifferResource !== undefined && (localModelActivity.ownerInFlight(snifferResource) || remoteOwnerBusy(snifferResource)),
        // A ready Inbox question stops the pass, so its answer runs, then classification resumes.
        shouldYield: () => localPrivateAnswers?.overdue() ?? false,
        // The service applies it to the built-in judge only, never Venice or a remote judge.
        pacing: localPacer,
        breakerOpen: () => secureAnalystPoolState.isBreakerOpen('secure_local', snifferLane.profileId),
        log: (line) => console.log(line),
        // Owner defaults 2026-10-01: the built-in private model is approved
        // for the sniffer by default, and a Personal verdict's queued move
        // runs at once while every embedding is the built-in local model.
        ...(snifferRuntime.source === 'built_in' ? { autoApproveBuiltIn: true } : {}),
        autoMoves: automaticMoveContext,
      })
    : undefined;
  if (tierSniffer && snifferResource) {
    localModelActivity.onBusy(snifferResource, () => tierSniffer.preempt());
    localModelActivity.onIdle(snifferResource, () => tierSniffer.wake());
  }
  if (engineFront && snifferResource) {
    // The judge runs in the background: carry the owner's own call to it.
    const relay = engineFront.ownerBusy;
    localModelActivity.onBusy(snifferResource, () => relay.busy(snifferResource));
    localModelActivity.onIdle(snifferResource, () => relay.idle(snifferResource));
  }
  // A source connected before the background created its stores: mounted here
  // as soon as they exist, including sources with no handle or stores at boot.
  // A tier store the background creates later (a lane's Private or Public
  // store, on its first item) is opened here too.
  const frontMountRetry = engineFront ? setInterval(refreshFrontMounts, 2_000) : undefined;
  frontMountRetry?.unref?.();
  // Keeps each store's set current, and saved by a writer; see keepVisibilityCurrent.
  if (!engineFront) void keepVisibilityCurrent('after start');
  const visibilityRefresh = setInterval(() => { void keepVisibilityCurrent('refresh'); }, VISIBILITY_REFRESH_MS);
  visibilityRefresh.unref?.();
  if (engineFront) {
    // The judge runs in the background: the front shows what it last published.
    const judge = frontJudgeState(() => engineFront!.status());
    classificationBusy = judge.busy;
    tierSnifferBacklog = judge.backlog as typeof tierSnifferBacklog;
    archivePrivateModelState = judge.archivePrivateModel;
  } else {
    classificationBusy = () => tierSniffer?.hasPriority ?? false;
    tierSnifferBacklog = tierSniffer ? () => tierSniffer.backlog() : undefined;
    archivePrivateModelState = () => archivePrivateModelFromSniffer(tierSniffer);
  }
  tierSniffer?.start();
  // The split's background: its private command socket, then the status
  // snapshot, then ready. The front waits for ready before it serves.
  let engineBackground: { stop(): void } | undefined;
  if (engineRole === 'background') {
    if (!authToken) throw new Error('The engine background needs the worker auth token.');
    const refreshSchedulerSources = () => {
      sourceScheduler?.updateSources(schedulerSourcesForHandles(
        activeLaneHandles(readActiveConnectedHandles(process.env), process.env),
      ).sources);
    };
    // A forwarded owner action runs as the route that served it before, behind
    // the front's authorization: the route's handler checks the body itself.
    const runForwarded = async (request: EngineForwardedRequest, commandId?: string) => {
      const built = forwardedRequestToRequest('http://olympus-worker.internal', request);
      return responseToForwarded(await worker.fetch(commandId ? tagForwardedRequest(built, commandId) : built));
    };
    let deleteFromFront: number | undefined;
    // Sync now runs the front asked for, published in the snapshot (front-scheduler.ts follows them).
    const manualSyncRuns = new Map<string, EngineManualSyncRun>();
    const commands = startEngineBackgroundServer({
      socketPath: engineSocketPath!,
      authToken,
      ...((process.env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID || process.env[ENGINE_BACKGROUND_INSTANCE_ENV])
        ? { instanceId: (process.env.OLYMPUS_NATIVE_SERVICE_INSTANCE_ID || process.env[ENGINE_BACKGROUND_INSTANCE_ENV])! } : {}),
      log: (line) => console.warn(line),
      // The front's built-in model completions, tracked like this process's
      // own answers so the judge steps aside for them on the one server.
      ...(answerBuiltInModel ? { modelComplete: (request: AnalystModelRequest) => answerBuiltInModel.complete(request) } : {}),
      handlers: {
        model_prepare: () => {
          if (workerBuiltInModel) void workerBuiltInModel.model.prepare();
          return { preparing: workerBuiltInModel !== undefined };
        },
        // A config file the front wrote: re-read it and wake what it governs.
        reload: ({ target, corpora, frontPid }) => {
          // A model, judge or policy change: this process read them at boot, so
          // it restarts, after the front that asked has ended (as a delete does).
          // Go easy on this computer, saved by the front.
          if (target === 'pacing') { localPacer.reloadSetting(); return { reloaded: target }; }
          if (target === 'models') {
            if (!modelReloadInstalled || !workerRestartsItself(workerLaunch, process.env)) return { reloaded: target, restarting: false };
            if (frontPid === undefined) return { reloaded: target, restarting: requestModelReload() };
            // Fenced like a delete: no new front passes readiness against this background (a restore runs at its boot).
            return { reloaded: target, restarting: restartAfterFront({ frontPid, markStopping: () => commands.markStopping(), restart: () => requestModelReload(), log: (line) => console.warn(line) }) };
          }
          // A scope approval cancels the unsettled jobs it no longer covers.
          const invalidated = target === 'scope' && fileExtractionRuntime
            ? (corpora ?? []).reduce((total, corpusId) => total + fileExtractionRuntime.jobs.invalidateUnsettledForCorpus(corpusId), 0)
            : 0;
          refreshSchedulerSources();
          if (target === 'scope' || target === 'extraction') sourceScheduler?.wakeTasksOfKind('extract');
          return { reloaded: target, ...(target === 'scope' ? { invalidated_jobs: invalidated } : {}) };
        },
        // The front changed an archive request or state file: resume checks, hand the scheduler the tasks, and wake it for a removal.
        archive_changed: () => {
          archiveImportDashboard.frontChanged();
          return { resumed: true };
        },
        // The front's render samples, recorded by the file's one writer.
        dashboard_samples: ({ samples }) => {
          sourceDashboardHistory?.record(samples as unknown as Parameters<NonNullable<typeof sourceDashboardHistory>['record']>[0]);
          return { recorded: samples.length };
        },
        // Starts the pass and answers; the pass reports through the scheduler status.
        sync_now: ({ source, manual }) => {
          if (!sourceScheduler) return { outcome: 'scheduler_disabled' };
          const started_at = new Date().toISOString();
          if (manual) manualSyncRuns.set(source, { started_at, state: 'running' });
          void sourceScheduler.runSource(source, undefined, manual ? 'operator' : 'scheduled').then(() => {
            if (manual) manualSyncRuns.set(source, { started_at, state: 'done' });
          }, (error: unknown) => {
            const code = (error as { code?: unknown } | null | undefined)?.code;
            if (manual) manualSyncRuns.set(source, { started_at, state: 'failed', ...(typeof code === 'string' ? { failure_code: code } : {}) });
            console.warn(`[source-scheduler] source=${source} sync requested by the front failed; the next scheduled pass retries.`);
          }).finally(() => status.publish());
          return { outcome: 'started' };
        },
        start_approved: ({ source }) => {
          if (!sourceScheduler) return { outcome: 'scheduler_disabled' };
          startApprovedSourceRun(sourceScheduler, source);
          return { outcome: 'ingestion_started' };
        },
        tier_set_recorded: async ({ locator, expected }) => {
          const { runTierSetOnRecordedItem } = await import('../classification/tier-cli.ts');
          return runTierSetOnRecordedItem(locator, 'private', expected);
        },
        // A backup's export. exportOlympusData is synchronous, so none of this
        // process's writes runs between its snapshots (#1224).
        export_data: ({ destination }) => {
          exportOlympusData({ destination });
          return { exported: destination };
        },
        capture_stop: async ({ source }) => {
          await captureOwnership.stopForUnpair(source);
          return { stopped: source };
        },
        // A stale change (older than the last applied for that resource) changes nothing.
        owner_busy: (change) => {
          if (!remoteOwnerMarks.apply(change)) return { busy: remoteOwnerMarks.busy(change.resource), stale: true };
          if (change.resource === snifferResource) tierSniffer?.preempt();
          return { busy: true };
        },
        owner_idle: (change) => {
          if (!remoteOwnerMarks.apply(change)) return { busy: remoteOwnerMarks.busy(change.resource), stale: true };
          if (change.resource === snifferResource) tierSniffer?.wake();
          return { busy: false };
        },
        delete_source_data: async ({ request, frontPid }) => {
          deleteFromFront = frontPid;
          try { return await runForwarded(request); }
          finally { deleteFromFront = undefined; }
        },
        tier_override: ({ request }) => runForwarded(request),
        storage_registry: ({ request }) => runForwarded(request),
        capture: ({ request }) => runForwarded(request),
        embed_chunks: ({ request }) => runForwarded(request),
        // A create writes under an id made from the command id, so a resubmission finds it.
        source_watch: ({ request }, { id }) => runForwarded(request, id),
        extraction_queue: ({ request }) => runForwarded(request),
        people: ({ request }) => runForwarded(request),
        source_sync: ({ request }) => runForwarded(request),
        data_export: ({ request }) => runForwarded(request),
        // Matched-first judging (#1062, PR #1115) is not in this build yet.
        // A question the front answered matched these pending items: the judge here asks about them first.
        judge_boost: ({ identities }) => {
          judgeBoosts.raise(identities);
          return { applied: true, raised: identities.length };
        },
      },
    });
    // Memory past the threshold: a supervised restart between judge passes
    // (#957). Created before the first snapshot is written, so it carries the
    // count the last background left in it.
    const rssRestart = startEngineRssRestart({
      thresholdMb: olympusConfig.worker.engineSplitRssRestartMb,
      batchRunning: () => (tierSniffer?.passRunning ?? false) || (sourceScheduler?.anyTaskRunning ?? false),
      restart: () => requestModelReload(),
      record: () => status.publish(),
      previous: engineRssRestartsFrom(readEngineStatusSnapshot(engineStatusSnapshotPath(process.env))),
    });
    const status = startEngineBackgroundStatus({
      env: process.env,
      instanceId: commands.instanceId,
      collect: () => ({
        scheduler: sourceScheduler?.status() ?? null,
        judge: (() => {
          const backlog = tierSniffer?.backlog();
          return {
            backlog: backlog ?? null,
            pending: backlog?.pendingItems ?? null,
            spending: judgeSpending.status(),
            busy: tierSniffer?.hasPriority ?? false,
            archive_private_model: archivePrivateModelState(),
          };
        })(),
        captures: dashboardCaptureRuntime(),
        ...(localUnreadableFiles ? {
          unreadable: Object.fromEntries(sourceCorpusRegistry.definitions('status', fullCorpusDefinitions).flatMap((definition) => {
            const counted = localUnreadableFiles.recheck(definition.corpusId);
            return counted ? [[definition.corpusId, counted]] : [];
          })),
        } : {}),
        manual_syncs: Object.fromEntries(manualSyncRuns),
        rss_restarts: rssRestart.restarts(),
      }),
    });
    // A delete the front forwarded: stop answering ready (so no new front
    // starts against this background), wait out the front that asked, which
    // restarts and so closes every connection it held on the account's
    // files, then restart; the boot deletes the marked account.
    restartForDelete = (request) => {
      const frontPid = deleteFromFront;
      if (frontPid === undefined) return requestModelReload(request);
      return restartAfterFront({ frontPid, markStopping: () => commands.markStopping(), restart: () => requestModelReload(request), log: (line) => console.warn(line) });
    };
    commands.markReady();
    finishBootProgress();
    engineBackground = { stop: () => { rssRestart.stop(); status.stop(); commands.stop(); } };
    console.log('Olympus engine background ready on its private command socket.');
  }
  localWorkPending = () => (snifferRuntime.source === 'built_in' && (tierSniffer?.backlog().remainingQuestions ?? 0) > 0)
    || connectorStores.some((store) => embedsOnThisComputer(connectorStoreEmbeddingProviders.get(store.corpusId)) && store.queuedEmbeddingItemIds(1).length > 0);
  localPacer.start();
  const stopCpuSampleLog = await startCpuSampleLog(process.env);

  // The worker owns a background tick that outlives any request, so the process
  // needs a way to put it down. Without this the only shutdown was the process
  // dying, which is not a shutdown so much as an interruption.
  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    // The host keeps its listener; a foreground worker closes only its own.
    closeDesktopBridge();
    if (shuttingDown) return;
    shuttingDown = true;
    privateAgentListeners?.close();
    sourceRuntimeClosed = true;
    localFilesCleanupRecovery?.close();
    sourceScheduler?.stop();
    worker.close();
    updateChecker.stop();
    capturesClosed = true;
    desktopPollingClosed = true;
    if (desktopPoll) clearInterval(desktopPoll);
    clearInterval(captureTick);
    stopSupersededSweep();
    stopCpuSampleLog?.();
    tierSniffer?.stop();
    localPacer.stop();
    archiveImportDashboard.close();
    installedTierClassification.close();
    void Promise.all(Object.values(captures).map((capture) => capture.stop())).catch(() => undefined);
    stopBuiltInModelOnShutdown(workerBuiltInModel?.model);
    // The built-in transcriber's server, if this process started one.
    stopBuiltInModelOnShutdown(runningBuiltInTranscriber());
    console.log(`Olympus private email source worker shutting down on ${signal}.`);
    // The re-check timer, any pass or settle in flight, then the store.
    if (uncheckedRetry) clearInterval(uncheckedRetry);
    remotePrivateParts.close();
    localPrivateAnswers?.close();
    waitingStoreClosed = true;
    waitingStore?.close();
    waitingStore = undefined;
    fileExtractionRuntime?.close();
    engineBackground?.stop();
    if (frontMountRetry) clearInterval(frontMountRetry);
    clearInterval(visibilityRefresh);
    engineFront?.stop();
    void server?.stop();
    // The data owner lock stays held: the teardown above is still running, and
    // the kernel releases the lock when this process exits.
  };
  shutdownSignals.setShutdown(shutdown);
  const reloadNow = shutdownSignals.modelReload({
    managed: workerRestartsItself(workerLaunch, process.env),
    drain: async () => { await Promise.all(Object.values(captures).map((capture) => capture.stop())); await server?.stop(true); },
    // Last before the exit, even when the drain failed: a pass still running
    // is recorded as interrupted, not left pending for the next process to
    // back off on (#803).
    beforeExit: () => { sourceScheduler?.settleInterruptedAttempts(); },
    exit: (code) => process.exit(code),
  });
  // In the split a model change restarts the background too, and the front
  // restarts once the background has acknowledged (front-state.ts).
  const reloadModels = engineFront
    ? frontModelReload({ client: engineFront.client, restartSelf: reloadNow, managed: workerRestartsItself(workerLaunch, process.env), log: (line) => console.warn(line) })
    : reloadNow;
  restartFrontOnly = reloadNow;
  requestModelReload = (request) => {
    // While a settings proposal is being applied, every writer's reload waits
    // for the last write, so the restart cannot cut the batch short.
    if (deferredReloads) { deferredReloads.push(request ?? {}); return workerRestartsItself(workerLaunch, process.env); }
    return reloadModels(request);
  };
  modelReloadInstalled = true;
  // After the reload handler, so a newer strongest model found at boot is
  // applied; then daily, so a long-running worker follows new releases too.
  void modelChoices.refreshStrongest().catch(() => false);
  setInterval(() => { void modelChoices.refreshStrongest().catch(() => false); }, 24 * 60 * 60 * 1000).unref();
  // Nightly or weekly backups: checked every quarter hour, run when due (backup-service.ts).
  // Scheduled backups run in the process that serves Back up now (the front, or
  // the single worker), so one exporter keeps one running state; the export
  // reads every store read-only.
  if (engineRole !== 'background') setInterval(() => { void backupService.tick().catch(() => false); }, 15 * 60 * 1000).unref();

  if (listens) console.log(socketPath ? `Olympus private email source worker listening on owner Unix socket` : `Olympus private email source worker listening on http://${hostname}:${port}/v1`);
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

if (import.meta.main) {
  await main();
}
