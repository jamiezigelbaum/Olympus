import { resolvedRawPath, resolvedStorePath } from '../../../core/source-placement.ts';
import { EmailSourceWorkerError } from '../http/worker-responses.ts';
import { GogcliEmailConnector } from '../../email-source/gogcli.ts';
import type { EmailSourceConnector } from '../../email-source/email-connector.ts';
import {
  READWISE_SOURCE_ID,
  ReadwiseDailyRequestBudget,
  createReadwiseConnectorStore,
  createReadwiseConnectorStoreSyncHandler,
  createReadwiseDailyRequestBudget,
  type ReadwiseConnectorStoreSyncHandler,
} from '../../readwise/index.ts';
import {
  LocalXBookmarksApiUsageStore,
  LocalXBookmarksReconcileStateStore,
  X_BOOKMARKS_SOURCE_ID,
  createXBookmarksConnectorStore,
  createXBookmarksConnectorStoreSyncHandler,
  createXBookmarksContentRecoveryHandler,
  type XBookmarksConnectorStoreSyncHandler,
  type XBookmarksContentRecoveryHandler,
} from '../../x-bookmarks/index.ts';
import {
  type LocalConnectorStore,
} from '../../connector-store/index.ts';
import {
  type TieredStoreSet,
} from '../../connector-store/tiered-store-set.ts';
import { createEnvCredentialBroker } from '../../credential-broker/index.ts';
import {
  type SourceEmbeddingProvider,
} from '../../source-index/embeddings.ts';
import {
  type ConnectedCredentialHandle,
} from '../../credential-broker/connected-handles.ts';
import {
  SourceAccountChangedError,
  runGuarded,
  type SourceAccountGuard,
} from '../../source-account-guard.ts';

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
