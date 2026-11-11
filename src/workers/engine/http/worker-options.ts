import type { JudgeChoice } from '../../classification/judge-spending.ts';
import type { DashboardPeopleBackend } from '../../email-source/dashboard-people.ts';
import type {
  LocalModelDiscoveryResult,
  LocalModelSelection,
  LocalModelTestResult,
} from '../../../core/local-model-discovery.ts';
import { privateAnswerMode } from '../../../core/first-run-privacy.ts';
import { type SettingsProposalHolder, createSettingsProposalHolder } from '../../settings-proposal-holder.ts';
import { PRIVACY_PRESET_LABELS } from '../../../core/privacy-language.ts';
import type { ReleaseCheck } from '../../../core/release-manifest.ts';
import type { UpdateAvailable } from '../../../core/update-check.ts';
import type { SelfUpdateStart, SelfUpdateStatus } from '../../../core/self-update.ts';
import type { ModelSetupView } from '../../../core/model-setup.ts';
import type { SourceIndexVisibilityGate } from '../../../core/source-index/router.ts';
import type { SecretLocationNote } from '../../../core/evidence-pack.ts';
import type {
  startOAuthSourceConnection,
  startExternalOAuthSourceConnection,
  OAuthFetch,
  connectPublicApiKeySource,
} from '../../../core/connect.ts';
import type { SecretStore } from '../../../core/secret-store.ts';
import type { SourceCorpusRegistry } from '../../../core/source-corpus-registry.ts';
import type { SourceIngestionPolicy } from '../../../core/source-ingestion-policy.ts';
import type { ArchiveImportAgent } from '../../archive-import/agent.ts';
import type { ArchiveImportDashboard } from '../../archive-import/dashboard.ts';
import type { OwnerTierItems } from '../../classification/tier-owner-items.ts';
import type { JudgeCheck } from '../../classification/judge-check.ts';
import type { OlympusPathContext } from '../../../core/pairing-session-paths.ts';
import type { ExtractionLaneKey } from '../../file-extraction/job-store.ts';
import type { FileExtractionRunner } from '../../file-extraction/runner.ts';
import type { SourceIndexAnswerHandler } from '../../source-index/answer-types.ts';
import type { SourceAnswerLatencyLog } from '../../source-index/answer-latency-log.ts';
import type { SourceIndexStatusHandler } from '../../source-index/status.ts';
import type { ReadwiseConnectorStoreSyncHandler } from '../../readwise/index.ts';
import type { XBookmarksConnectorStoreSyncHandler, XBookmarksContentRecoveryHandler } from '../../x-bookmarks/index.ts';
import type { DropboxEvalShardExportHandler, DropboxSourceExportHandler } from '../../dropbox-files/index.ts';
import type { SourceEmbeddingProvider } from '../../source-index/embeddings.ts';
import type { SourceScheduler, SourceSchedulerSource } from '../../source-scheduler.ts';
import type { SovereigntyEngine, SovereigntyPresetName } from '../../../core/sovereignty.ts';
import type { LocalSourceWatchStore } from '../../../core/source-watch.ts';
import type { DashboardPanelTools } from '../../email-source/dashboard-panel-tools.ts';
import type { SystemSupportFacts } from '../../dashboard/source-failure.ts';
import type { DashboardConsultBackend } from '../../email-source/dashboard-consult.ts';
import type { LocalPrivateAnswers } from '../../email-source/local-private-answers.ts';
import type {
  OlympusFolderScopeSourceId,
  OlympusFolderScopeBrowseResult,
  OlympusSourceScopeSelection,
  OlympusMailScopeDraft,
} from '../../../control-ui-contract.ts';
import type { DashboardAgentConnectionsBackend } from '../../agent-connections.ts';
import type {
  SourceDashboardHistory,
  DashboardCaptureRuntime,
  DashboardSyncSource,
  DashboardLivePass,
} from '../../source-dashboard.ts';
import type { SourceFolderScopeSummary } from '../../source-dispositions.ts';
import type { ConnectedCredentialHandle, removeConnectedHandles } from '../../credential-broker/connected-handles.ts';
import type { CredentialOAuth2StateStore } from '../../credential-broker/index.ts';
import type {
  LocalConnectorStore,
  ConnectorStoreSearchFilters,
  ConnectorStoreFilterCapabilityRegistry,
} from '../../connector-store/index.ts';
import type { LifecyclePathContext } from '../../../data-lifecycle.ts';
import type { ModelKeyReloadRequest } from '../../../core/model-key-reload.ts';
import type { BackupService } from '../../backup-service.ts';
import type { WorkerCredentialDegradation, WorkerCredentialReadiness } from '../../credential-degradation.ts';
import type { EmailSourceConnector } from '../../email-source/email-connector.ts';
import type { ConsultAskWireRequest } from './source-index-requests.ts';
import type { ConnectorStoreDeclaredPrincipal } from './connector-store-search-request.ts';
import type { DashboardSourceSyncRequest } from './dashboard-source-requests.ts';
import type { SourceDispositionsRuntime } from './dashboard-dispositions.ts';

export interface EmailSourceWorkerOptions {
  /** Content-free, in-memory installer version; local surfaces only. */
  updateAvailable?: () => UpdateAvailable | undefined;
  /**
   * Update now (core/self-update.ts): the standalone engine updates itself.
   * Reached only by a local-grade dashboard session (workers/http.ts), never
   * by the bearer, a remote browser or an agent, and never as a tool.
   */
  selfUpdate?: { start(): SelfUpdateStart; status(): SelfUpdateStatus };
  platform?: string;
  /** Local Linux notices, outside the frozen ChatGPT panel bundle. */
  localModelReadiness?: () => readonly import('../../../core/linux-model-readiness.ts').LocalModelReadiness[];
  connector?: EmailSourceConnector;
  sourceAnswer?: SourceIndexAnswerHandler;
  sourceAnswerReleaseCheck?: ReleaseCheck;
  /**
   * How many items wait for their privacy judgment (the tier sniffer's
   * pending count), read per request. A local caller's source answer and
   * search carry the local note (core/privacy-backlog-coverage.ts); a remote
   * caller's output gets the remote note at its own boundary instead.
   */
  pendingPrivacyItems?: () => number | undefined;
  /**
   * "Ask anonymously" (core/consult-ask.ts), bound by the composition root:
   * one typed question prepared at the chosen level and sent through zkAPI.
   * Absent: `/consult/ask` answers 501.
   */
  consultAsk?: (input: ConsultAskWireRequest, signal: AbortSignal) => Promise<unknown>;
  /**
   * What an agent may do about archive imports (archive-import/agent.ts):
   * ask for an import or a removal, and read the list. Absent:
   * `/archive-import/*` answers 501.
   */
  archiveImportAgent?: ArchiveImportAgent;
  /**
   * The owner's one-item privacy change (classification/tier-owner-items.ts).
   * An agent finds items whose names are Personal and raises one to Private
   * (`/privacy-item/*`); the dashboard on this computer finds any item and
   * sets it Personal or Private, or back to the judge
   * (`/dashboard/privacy/items/*`). Absent: those routes answer 501.
   */
  ownerTierItems?: OwnerTierItems;
  /**
   * "Check how Olympus labelled your items" on Privacy › Your items (classification/judge-check.ts):
   * a round of items the owner labels before seeing the judge's label. Local
   * dashboard session only (`/dashboard/privacy/judge-check`). Absent: 501.
   */
  judgeCheck?: JudgeCheck;
  // Optional content-free latency ledger. When present, one JSON line per
  // answered source_answer request is appended (phase timings, corpus ids, skip
  // reasons, analyst backend/fallback, release decision — never query/content).
  sourceAnswerLatencyLog?: SourceAnswerLatencyLog;
  sourceIndexStatus?: SourceIndexStatusHandler;
  /**
   * The names of the newest unreadable files across corpora (the extraction
   * readiness ledger's own list), stamped on the dashboard's source cards.
   */
  unreadableFileNames?: (corpusIds: readonly string[], limit: number) => readonly string[];
  /** One corpus's unreadable count checked again now (SourceDashboardBuildOptions.unreadableRecheck). */
  unreadableRecheck?: (corpusId: string) => { unreadable: number; blocked: number } | undefined;
  readwiseConnectorStoreSync?: ReadwiseConnectorStoreSyncHandler;
  /**
   * Resolves the current Readwise handler after registry changes. When present
   * it is authoritative, as `currentXBookmarksRuntime` is for X.
   */
  currentReadwiseSync?: () => ReadwiseConnectorStoreSyncHandler | undefined;
  xBookmarksConnectorStoreSync?: XBookmarksConnectorStoreSyncHandler;
  xBookmarksContentRecovery?: XBookmarksContentRecoveryHandler;
  /**
   * Resolves the one current X runtime after registry changes. When present it
   * is authoritative: an absent result means no provider read is allowed, and
   * the boot-time compatibility handlers above are not consulted.
   */
  currentXBookmarksRuntime?: () => {
    sync?: XBookmarksConnectorStoreSyncHandler;
    contentRecovery?: XBookmarksContentRecoveryHandler;
  } | undefined;
  /**
   * The source-neutral extraction factory. Serves the generic
   * `/source/index/files/*` routes, and serves a family-scoped extraction path
   * too once that family's own legacy handler is no longer wired — see
   * `fileExtractionAliasFor`.
   */
  fileExtraction?: FileExtractionRunner;
  /** Apply current lane policy before any extraction route reads jobs or items. */
  authorizeFileExtractionLane?: (lane: ExtractionLaneKey) => void;
  /** The file lanes whose PDFs `/source/index/files/extract-pdfs` drains, resolved per call. */
  pdfExtractionLanes?: () => readonly ExtractionLaneKey[];
  /** False for a drain lane whose file source has no current scope approval. */
  pdfExtractionLaneScopeApproved?: (lane: ExtractionLaneKey) => boolean;
  dropboxEvalShardExport?: DropboxEvalShardExportHandler;
  dropboxSourceExport?: DropboxSourceExportHandler;
  sourceIndexEmbeddingProvider?: SourceEmbeddingProvider;
  dropboxIngestionPolicy?: SourceIngestionPolicy;
  connectorStores?: LocalConnectorStore[];
  /** Discover stores that ingestion created after boot; never creates an absent store. */
  refreshConnectorStores?: () => void;
  /**
   * Per-tier stores (P1b): the sibling corpora of a corpus in a tiered store
   * set. `source_index_search` searches every tier of the named source unless
   * the request says `all_tiers: false`.
   */
  connectorStoreTierSiblings?: (corpusId: string) => readonly string[];
  /** One tier-ledger snapshot over every hit a tiered search gathered. */
  sourceIndexVisibilityGate?: SourceIndexVisibilityGate;
  /**
   * Location-only Secret matches for a query, returned beside the hits,
   * confined to the corpora this search covered and the account and filters
   * each was searched under.
   */
  secretLocationSearch?: (
    query: string,
    searched: ReadonlyArray<{ corpusId: string; accountScope?: string; filters?: ConnectorStoreSearchFilters }>,
  ) => readonly SecretLocationNote[];
  /** Generic corpus-keyed overrides for connector-store retrieval providers. */
  connectorStoreEmbeddingProviders?: ReadonlyMap<string, SourceEmbeddingProvider>;
  /** Generic corpus-keyed principal account boundaries for connector-store reads. */
  connectorStoreAccountScopes?: ReadonlyMap<string, string>;
  /** Declared mounted-corpus identities consulted by narrower capability scopes. */
  connectorStorePrincipals?: ReadonlyMap<string, ConnectorStoreDeclaredPrincipal>;
  /** Test/integration override; shipped declarations use the module registry above. */
  connectorStoreFilterCapabilities?: ConnectorStoreFilterCapabilityRegistry;
  /** Mandatory account-bound retrieval scope for mounted file corpora. */
  connectorStoreReadScope?: (
    store: LocalConnectorStore,
  ) => { allowed: false } | {
    allowed: true;
    accountScope?: string;
    filters?: ConnectorStoreSearchFilters;
    contentAllowed?: boolean;
    contentFilters?: ConnectorStoreSearchFilters;
  };
  sourceScheduler?: SourceScheduler;
  sourceWatch?: {
    store: LocalSourceWatchStore;
    /**
     * The id a create writes under, when the request was forwarded by the
     * engine split's front (engine-split/commands.ts): the same on every retry
     * of one command, so a retry finds the watch instead of making another.
     */
    recordId?: (request: Request) => string | undefined;
  };
  sourceDashboard?: {
    sovereigntyEngine: SovereigntyEngine;
    /** Pause the native capture reader while pairing or changing its capture grant. */
    withMessagingCapturePaused?<T>(source: 'telegram' | 'whatsapp', operation: () => Promise<T>): Promise<T>;
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
    /**
     * Test seam: the Evernote MCP server signed in to and the hosts its
     * authorization page may be on (default Evernote's own,
     * workers/evernote/connector.ts).
     */
    evernoteSignIn?: { serverUrl: string; authorizationHosts: readonly string[] };
    apiKeyFetch?: OAuthFetch;
    connectApiKey?: typeof connectPublicApiKeySource;
    systemReport?: () => SystemSupportFacts;
    /**
     * The setup checklist (#1077, core/setup-checklist.ts), built from the
     * dashboard view and the facts beside it. For `olympus setup status` and
     * the agent tool, through the `setup-status` CLI route. Names and states only.
     */
    setupStatus?: () => Promise<import('../../../core/setup-checklist.ts').SetupChecklist>;
    judgeSetup?: {
      status: () => import('../../dashboard/pages/local.ts').DashboardJudgeSetup;
      pageStatus?: () => import('../../dashboard/pages/local.ts').DashboardJudgeSetup;
      save: (choice: JudgeChoice, capDollars: number) => Promise<{ ok: true; status_message: string }>;
    };
    /** The model pickers on Privacy rules (model-choices-backend.ts). */
    modelChoices?: import('../../email-source/model-choices-backend.ts').ModelChoicesBackend;
    /** Go easy on this computer (#922, local-pacing.ts): shown under the judge choice. */
    goEasy?: { on: () => boolean; save: (on: boolean) => { ok: true; status_message: string } };
    modelSetup?: () => ModelSetupView;
    checkModelSetup?: () => Promise<ModelSetupView>;
    discoverLocalModels?: (baseUrl?: string) => Promise<LocalModelDiscoveryResult[]>;
    testLocalModels?: (selection: LocalModelSelection) => Promise<LocalModelTestResult>;
    saveLocalAnswerModel?: (selection: LocalModelSelection) => Promise<{ ok: boolean; detail?: string }>;
    computerSetup?: () => Pick<ModelSetupView, 'computer_use_pending' | 'engine_server_mode'>;
    saveComputerUseChoice?: (choice: 'everyday' | 'server') => { ok: true; status_message: string };
    saveFirstRunPrivacyChoice?: (choice: SovereigntyPresetName) => boolean;
    /** Change the Private-answer mode after the first run (an applied settings proposal, #1050). */
    savePrivateAnswerMode?: (choice: SovereigntyPresetName) => { ok: true; message?: string } | { ok: false; message: string };
    /** Hold the reloads the writers request until a whole settings proposal is saved. */
    deferReloads?: <T>(writes: () => Promise<T>) => Promise<T>;
    connectModelKey?: (source: 'gemini' | 'venice', apiKey: string) => Promise<void>;
    /**
     * Outside help (consults): the Mac dashboard card's backend
     * (dashboard-consult.ts), the one caller of the settings writer. Absent:
     * no Outside help row, the page says it is unavailable, and the routes
     * answer 501. Its routes are served only inside an authenticated local
     * control session (workers/http.ts), never to the Gateway bearer.
     */
    consult?: DashboardConsultBackend;
    /**
     * The panel's tools on the computer (dashboard-panel-tools.ts): the same
     * in-process handlers ChatGPT's /mcp reaches, for POST /dashboard/tools/call
     * and the locked read. Absent: the route answers 501.
     */
    panelTools?: DashboardPanelTools;
    /**
     * Private answers on this computer (local-private-answers.ts): Ask
     * privately, and the automatic private inbox with Delete. Its route
     * and the page's list are served only inside a local control session
     * (workers/http.ts). Absent: the page says it is unavailable and the route
     * answers 501.
     */
    privateAnswers?: Pick<LocalPrivateAnswers, 'destinations' | 'waiting' | 'waitingCount' | 'handle'>;
    /** Settings › Back up and restore (backup-service.ts); its routes take the local grade only. */
    backup?: BackupService;
    /**
     * What AI apps received (workers/apps-received.ts): served only through
     * DASHBOARD_APPS_RECEIVED_ROUTE to a locally minted control session.
     */
    appsReceived?: Pick<import('../../apps-received.ts').AppsReceived, 'handle'>;
    /**
     * People (#1076; dashboard-people.ts): the people index as the People page
     * shows it, and the owner's corrections. The list is Private: the page
     * shows it and the route answers only inside a local control session
     * (workers/http.ts). Absent: the page says it is not ready and the route
     * answers 501.
     */
    people?: DashboardPeopleBackend;
    stopMessagingCapture?: (source: 'telegram' | 'whatsapp') => Promise<void>;
    /**
     * Logs this computer's WhatsApp linked device out (the bridge's `--unlink`
     * against that state folder), which removes it from the phone's Linked
     * devices (#761). Unpair runs it after capture has stopped and before the
     * session is deleted. Absent: the phone keeps its entry.
     */
    unlinkWhatsAppDevice?: (stateDir: string) => Promise<'removed' | 'offline' | 'failed'>;
    /**
     * How live capture runs on this computer, by source id: the supervisor's
     * last report and what the grant approved (counts only). Absent for a
     * source another process owns capture for; the cards then say nothing of it.
     */
    captureRuntime?: () => Readonly<Record<string, DashboardCaptureRuntime>>;
    triggerSourceSync?: (request: DashboardSourceSyncRequest) => Promise<unknown>;
    /**
     * The sources `triggerSourceSync` actually serves.
     *
     * One callback carries every source, and the product server's hook serves
     * Dropbox and raises `source_sync_not_supported` for the rest. Treating the
     * hook's mere existence as "this source is syncable" is what put a Sync now
     * button on a Google Drive card that could only answer 501 (owner,
     * 2026-09-04). Absent means the hook makes no claim, and every source it is
     * asked about is assumed served -- today's behaviour for hosts and tests
     * that wire a hook serving everything.
     */
    triggerSourceSyncSources?: readonly DashboardSyncSource[];
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
     * Where Delete indexed data resolves the source's stores: the same
     * resolvers `olympus data delete --source` uses. Production leaves it
     * undefined (process.env, real home); a test points it at a temporary home.
     */
    dataLifecyclePathContext?: LifecyclePathContext;
    /**
     * How Delete indexed data gets the worker to reopen its stores. Deleting a
     * source's files while the worker runs leaves its open SQLite handles on
     * deleted files, and search would keep serving the deleted rows until the
     * worker restarts. `canRestart` says whether a supervisor restarts this
     * worker (no side effect; checked BEFORE anything is deleted); `request`
     * schedules the restart after the response is sent. Absent: the route
     * refuses with `delete_reopen_unavailable` rather than leave stale handles.
     */
    workerRestart?: { canRestart: () => boolean; request: (reload?: ModelKeyReloadRequest) => boolean };
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
    ingestionDispositions?: (options?: { lazyStores?: boolean }) => Promise<SourceDispositionsRuntime> | SourceDispositionsRuntime;
    /**
     * Where a sign-in started for ChatGPT returns: the relay's public origin
     * and this install's relay id (docs/design/chatgpt-plugin.md, "Setup from
     * ChatGPT"). Read only when the start request asks for `handback: 'relay'`;
     * the origin is never taken from the request. Absent or undefined: no
     * relay hand-back on this worker.
     */
    oauthHandback?: () => { origin: string; installId: string } | undefined;
    /**
     * The port this engine listens on, for a Google sign-in started from a
     * dashboard that is not itself on loopback (`dashboardGoogleLoopbackOrigin`).
     * Absent: 8010, the engine's default.
     */
    loopbackPort?: number;
    /**
     * Imported archives (archive-import/dashboard.ts): the picker, approval,
     * Decline, Remove and the Archives row. Absent: the archive routes say
     * importing is not set up here.
     */
    archiveImports?: ArchiveImportDashboard;
    /** Each pass-read source's last pass (Evernote's), by card source id. Read on every render; a throw shows none. */
    livePasses?: () => Readonly<Record<string, DashboardLivePass>>;
    fileSourceScopes?: {
      summaries(): SourceFolderScopeSummary[];
      browse(input: {
        sourceId: OlympusFolderScopeSourceId;
        parentKey?: string;
        cursor?: string;
      }): Promise<OlympusFolderScopeBrowseResult>;
      approveAndStart(input: {
        sourceId: OlympusFolderScopeSourceId;
        accountGeneration: string;
        expectedRevision: string;
        selections: OlympusSourceScopeSelection[];
        wholeAccount: boolean;
        explicitWholeAccountConfirmation: boolean;
      }): Promise<Record<string, unknown>>;
      /** The mail picker's labels, categories, sender suggestions and estimate. Absent: no mail picker. */
      browseMail?(input: { draft: OlympusMailScopeDraft }): Promise<Record<string, unknown>>;
      /** The only act that starts a connected mailbox's ingestion. */
      approveMailAndStart?(input: {
        accountGeneration: string;
        expectedRevision: string;
        draft: OlympusMailScopeDraft;
      }): Promise<Record<string, unknown>>;
    };
  };
  credentialDegradations?: () => WorkerCredentialDegradation[];
  /** Positive, secret-free proof for policy credentials resolved by this worker. */
  credentialReadiness?: () => WorkerCredentialReadiness[];
  /** Instance nonce supplied by the managed service supervisor. */
  serviceInstanceId?: string;
  recheckCredentials?: () => WorkerCredentialDegradation[];
  /** Remote agent connections behind the Setup page's "Connect an agent" panel. */
  agentConnections?: DashboardAgentConnectionsBackend;
  agentConnectHost?: () => import('../../dashboard/agents.ts').AgentConnectHost;
  basePath?: string;
}

/** Where the Settings page's Apply all and Discard post (local control session only, workers/http.ts). */
export const DASHBOARD_SETTINGS_PROPOSAL_APPLY_PATH = '/dashboard/settings/proposal/apply';

export const DASHBOARD_SETTINGS_PROPOSAL_DISCARD_PATH = '/dashboard/settings/proposal/discard';

/** Agent-proposed settings (#1050), bound to the same writers the dashboard's own controls use. */
export function settingsProposalHolderFor(dashboard: NonNullable<EmailSourceWorkerOptions['sourceDashboard']>): SettingsProposalHolder {
  const judge = dashboard.judgeSetup;
  const models = dashboard.modelChoices;
  const saveComputerUse = dashboard.saveComputerUseChoice;
  return createSettingsProposalHolder({
    answerMode: () => {
      const id = privateAnswerMode(dashboard.sovereigntyEngine.config);
      return { id, label: id === 'custom' ? 'Custom Private-answer mode' : PRIVACY_PRESET_LABELS[id] };
    },
    ...(dashboard.savePrivateAnswerMode ? { saveAnswerMode: dashboard.savePrivateAnswerMode } : {}),
    ...(dashboard.deferReloads ? { deferReloads: dashboard.deferReloads } : {}),
    ...(dashboard.computerSetup ? { computerSetup: dashboard.computerSetup } : {}),
    ...(saveComputerUse ? { saveComputerUse: (choice: 'everyday' | 'server') => ({ ok: true as const, message: saveComputerUse(choice).status_message }) } : {}),
    ...(judge ? {
      judge: judge.status,
      saveJudge: async (choice: 'local' | 'venice', cap: number) => ({ ok: true as const, message: (await judge.save(choice, cap)).status_message }),
    } : {}),
    ...(models ? {
      modelChoices: () => models.status(),
      saveModel: async (provider: 'local' | 'venice' | 'zkapi', value: string) => {
        const saved = await models.save(provider, value);
        return saved.ok ? { ok: true as const, message: saved.status_message } : { ok: false as const, message: saved.message };
      },
    } : {}),
  });
}
