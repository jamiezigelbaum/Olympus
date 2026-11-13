import type { OlympusConfig } from '../src/core/config.ts';
import { BuiltInSourceEmbeddingProvider } from '../src/workers/source-index/built-in-embedding/provider.ts';
import { builtInEmbeddingPaths, installedBuiltInEmbedding } from '../src/workers/source-index/built-in-embedding/assets.ts';
import { builtInEmbeddingModel } from '../src/workers/source-index/built-in-embedding/manifest.ts';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolvedStorePath } from '../src/core/source-placement.ts';
import { buildSourceIndexCorpusRegistry, defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import type { SourceTrustDomain } from '../src/core/source-index/types.ts';
import type { SourceIndexCorpusSearchAdapter } from '../src/core/source-index/router.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { DROPBOX_APPROVED_SCOPE_FILTER_CODEC } from '../src/workers/dropbox-files/index.ts';
import { DROPBOX_TIER_CORPUS_IDS } from '../src/workers/dropbox-files/connector-store.ts';
import { assertTierLedgerInDirectory, tierLedgerIsWithin } from '../src/workers/classification/tier-set-binding.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import { createTierVisibilityGate, type TierVisibilityScope } from '../src/workers/connector-store/tier-visibility.ts';
import { createParentLabelResolver } from '../src/workers/connector-store/parent-label.ts';
import { createSourceAnswerLanes } from '../src/workers/engine/runtime/source-answer-lanes.ts';
import { loadedBuiltInEmbedding } from '../src/workers/source-index/built-in-embedding/provider.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { localAnswerRequest } from '../src/workers/source-index/local-answer.ts';
import type { AnalystAnswerLanes } from '../src/workers/source-index/analyst-answer.ts';
import { buildEvidencePackDetailed, type EvidencePackBuildDetail, type BuildEvidencePackInput } from '../src/core/evidence-pack.ts';
import type { AnalystQueryPlanner } from '../src/core/query-planner.ts';
import type { EvidenceReranker } from '../src/core/evidence-reranker.ts';
const DEFAULT_EMBEDDING_WARM_TIMEOUT_MS = 180_000;

export interface EvalStoreSearch { corpusId: string; providerItemIds: readonly string[] }
export function resolveEvalDropboxScope(
  account: string | undefined,
  approvedScopeKey: string | undefined,
): { accountScope?: string; locatorPathScope?: string } {
  if (!approvedScopeKey) return account ? { accountScope: account } : {};
  if (!account) {
    throw new Error('OLYMPUS_SOURCE_INDEX_ACCOUNT is required when OLYMPUS_EVAL_DROPBOX_APPROVED_SCOPE_KEY is set.');
  }
  const resolution = DROPBOX_APPROVED_SCOPE_FILTER_CODEC.resolveLocatorPath(approvedScopeKey, {
    provider: 'dropbox',
    accountScope: account,
  });
  if (resolution.kind !== 'path') {
    throw new Error('OLYMPUS_EVAL_DROPBOX_APPROVED_SCOPE_KEY must be a Dropbox path scope for the configured account.');
  }
  return {
    accountScope: resolution.accountScope,
    locatorPathScope: resolution.locatorPath,
  };
}

/** Where the eval finds each Dropbox tier store and the source's tier ledger. */
export interface EvalDropboxStorePaths {
  secure: string;
  personal?: string;
  public?: string;
  /** The set ledger; default beside the Private store, where the lane keeps it. */
  ledger?: string;
}

export function evalDropboxStorePaths(env: Record<string, string | undefined>): EvalDropboxStorePaths {
  const secure = env.OLYMPUS_EVAL_DROPBOX_STORE?.trim() || resolvedStorePath('dropbox.files', 'secure_local');
  return {
    secure,
    personal: env.OLYMPUS_EVAL_DROPBOX_PERSONAL_STORE?.trim() || resolvedStorePath('dropbox.files', 'internal', env),
    public: env.OLYMPUS_EVAL_DROPBOX_PUBLIC_STORE?.trim() || resolvedStorePath('dropbox.files', 'public_safe', env),
    ledger: env.OLYMPUS_EVAL_DROPBOX_LEDGER?.trim() || tieredStoreSetLedgerPath(secure),
  };
}

export interface EvalDropboxStores {
  /** Every tier store that exists, opened query-only. */
  stores: LocalConnectorStore[];
  /** The set ledger, read-only, when it exists. */
  ledger?: TierLedger;
  close(): void;
}

/** Refuse external ledgers before either the eval or probe starts reading stores. */
export function assertEvalDropboxStoreIsolation(paths: EvalDropboxStorePaths): void {
  const files = [paths.secure, paths.personal, paths.public];
  const directory = dirname(paths.secure);
  const ledgerPath = paths.ledger ?? tieredStoreSetLedgerPath(paths.secure);
  if (!tierLedgerIsWithin(directory, ledgerPath)) throw new Error(`Refusing privacy ledger outside the requested directory ${directory}: ${ledgerPath}`);
  for (const dbPath of files) {
    if (dbPath && existsSync(dbPath)) assertTierLedgerInDirectory(dbPath, directory);
  }
}

/**
 * Opens every Dropbox tier store that exists, query-only. A store bound to
 * the set ledger judges what it serves by that ledger itself; the ledger
 * opened here feeds the same visibility gate live Ask applies over the hits.
 */
export function openEvalDropboxStores(
  paths: EvalDropboxStorePaths,
  /** Filled with each open's milliseconds, keyed by corpus id or 'ledger' (store probe). */
  openMs?: Record<string, number>,
): EvalDropboxStores {
  const files: Array<[SourceTrustDomain, string | undefined]> = [
    ['secure_local', paths.secure],
    ['internal', paths.personal],
    ['public_safe', paths.public],
  ];
  assertEvalDropboxStoreIsolation(paths);
  const ledgerPath = paths.ledger ?? tieredStoreSetLedgerPath(paths.secure);
  const stores: LocalConnectorStore[] = [];
  let ledger: TierLedger | undefined;
  try {
    for (const [trustDomain, dbPath] of files) {
      const corpusId = DROPBOX_TIER_CORPUS_IDS[trustDomain];
      if (!corpusId || !dbPath || !existsSync(dbPath)) continue;
      const startedAt = performance.now();
      stores.push(new LocalConnectorStore({
        dbPath,
        corpusId,
        family: 'file',
        trustDomain,
        readOnly: true,
      }));
      if (openMs) openMs[corpusId] = Math.round(performance.now() - startedAt);
    }
    const ledgerStartedAt = performance.now();
    ledger = existsSync(ledgerPath) ? new TierLedger({ dbPath: ledgerPath, readOnly: true }) : undefined;
    if (openMs && ledger) openMs.ledger = Math.round(performance.now() - ledgerStartedAt);
  } catch (error) {
    for (const store of stores) store.close();
    ledger?.close();
    throw error;
  }
  return {
    stores,
    ...(ledger ? { ledger } : {}),
    close() {
      for (const store of stores) store.close();
      ledger?.close();
    },
  };
}

/**
 * The answer lanes over the eval's stores, built by the same factory live
 * answers use (engine/runtime/source-answer-lanes.ts) in its on-this-computer
 * mode: a store's vector lane runs only with the built-in model this process
 * holds loaded, and otherwise searches by keyword.
 */
export function createEvalDropboxLanes(input: {
  stores: readonly LocalConnectorStore[];
  ledger?: TierLedger;
  scopes?: readonly TierVisibilityScope[];
  scope: { accountScope?: string; locatorPathScope?: string };
  embeddingFor?: (trustDomain: SourceTrustDomain) => SourceEmbeddingProvider | undefined;
  localEmbedding?: (provider: SourceEmbeddingProvider) => SourceEmbeddingProvider | undefined;
  /** Told each store search's returned item ids, in order (the report's expectedStoreRanks). */
  onStoreSearch?: (search: EvalStoreSearch) => void;
}): (question: string) => AnalystAnswerLanes {
  const stores = () => input.stores;
  const scopes = () => input.scopes ?? (input.ledger
    ? [{ ledger: input.ledger, corpusIds: new Set(input.stores.map((store) => store.corpusId)), stores }]
    : []);
  const filters = input.scope.locatorPathScope
    ? { provider: 'dropbox', locatorPathScope: input.scope.locatorPathScope }
    : undefined;
  const lanes = createSourceAnswerLanes({
    stores,
    registry: () => buildSourceIndexCorpusRegistry(input.stores.map((store) => defineSourceIndexCorpus({
      corpusId: store.corpusId,
      family: store.family,
      trustDomain: store.trustDomain,
    }))),
    embeddingProvider: (store) => input.embeddingFor?.(store.trustDomain),
    localEmbedding: input.localEmbedding ?? loadedBuiltInEmbedding,
    readScope: () => ({
      allowed: true,
      contentAllowed: true,
      ...(input.scope.accountScope ? { accountScope: input.scope.accountScope } : {}),
      ...(filters ? { filters, contentFilters: filters } : {}),
    }),
    answerScope: () => ({ kind: 'search' }),
    accountScope: () => input.scope.accountScope,
    visibilityGate: createTierVisibilityGate(scopes),
    parentLabels: createParentLabelResolver({ stores, scopes }),
  });
  const onStoreSearch = input.onStoreSearch;
  if (!onStoreSearch) return (question) => lanes(localAnswerRequest(question), 'built_in_only');
  return (question) => {
    const built = lanes(localAnswerRequest(question), 'built_in_only');
    return {
      ...built,
      adapters: Object.fromEntries(Object.entries(built.adapters).flatMap(([corpusId, adapter]) => adapter ? [[
        corpusId,
        // The adapter's own preparation hooks ride along unchanged.
        Object.assign(async (...args: Parameters<SourceIndexCorpusSearchAdapter>) => {
          const response = await adapter(...args);
          onStoreSearch({ corpusId, providerItemIds: response.hits.map((hit) => hit.sourceItem.providerItemId) });
          return response;
        }, adapter) as SourceIndexCorpusSearchAdapter,
      ]] : [])),
    };
  };
}

export function createEvalSourceLanes(input: {
  stores: readonly LocalConnectorStore[];
  onStoreSearch?: (search: EvalStoreSearch) => void;
  scopes?: readonly TierVisibilityScope[];
  embeddingFor?: (trustDomain: SourceTrustDomain) => SourceEmbeddingProvider | undefined;
}): (question: string) => AnalystAnswerLanes {
  return createEvalDropboxLanes({ ...input, scope: {} });
}

/** One question's evidence pack, over the eval's lanes, as live Ask builds it. */
export function buildEvalPack(input: {
  question: string;
  lanes: (question: string) => AnalystAnswerLanes;
  queryPlanner?: AnalystQueryPlanner;
  reranker?: EvidenceReranker;
  maxResults: number;
  maxCharsPerCandidate: number;
} & Pick<BuildEvidencePackInput, 'onSeatingLanes' | 'onRerankScores' | 'poolAllocation' | 'storeSearchDepth'>): Promise<EvidencePackBuildDetail> {
  const lanes = input.lanes(input.question);
  return buildEvidencePackDetailed({
    question: input.question,
    ...(input.queryPlanner ? { queryPlanner: input.queryPlanner } : {}),
    ...(input.reranker ? { reranker: input.reranker } : {}),
    ...(input.onSeatingLanes ? { onSeatingLanes: input.onSeatingLanes } : {}),
    ...(input.onRerankScores ? { onRerankScores: input.onRerankScores } : {}),
    ...(input.poolAllocation ? { poolAllocation: input.poolAllocation } : {}),
    ...(input.storeSearchDepth !== undefined ? { storeSearchDepth: input.storeSearchDepth } : {}),
    maxResults: input.maxResults,
    maxCharsPerCandidate: input.maxCharsPerCandidate,
    searchContext: {
      allowedTrustDomains: ['public_safe', 'internal', 'secure_local'],
    },
    registry: lanes.registry,
    adapters: lanes.adapters,
    contentProviders: lanes.contentProviders,
    ...(lanes.visibilityGate ? { visibilityGate: lanes.visibilityGate } : {}),
    ...(lanes.secretLocations ? { secretLocations: lanes.secretLocations } : {}),
    ...(lanes.classificationCoverage ? { classificationCoverage: lanes.classificationCoverage } : {}),
    ...(lanes.parentLabels ? { parentLabels: lanes.parentLabels } : {}),
  });
}

export interface EvalRetrievalMode {
  mode: 'hybrid' | 'keyword';
  /** The built-in model that ran, when hybrid. */
  modelId?: string;
  /** One line for the run output and report. */
  note: string;
}

/**
 * The built-in embedding model, loaded, when the install has it; keyword
 * search otherwise, with the reason. Never downloads a model: a model that
 * was never installed leaves the eval on keyword search.
 */
export async function prepareEvalEmbedding(input: {
  configured: Partial<Record<SourceTrustDomain, SourceEmbeddingProvider>>;
  /** Thrown or unset configuration, said in the note. */
  configurationError?: string;
  warmTimeoutMs?: number;
  /** Where the built-in model's files are looked for. Default: this process's environment. */
  env?: Record<string, string | undefined>;
}): Promise<{ retrieval: EvalRetrievalMode; embeddingFor: (trustDomain: SourceTrustDomain) => SourceEmbeddingProvider | undefined }> {
  const keyword = (reason: string) => ({
    retrieval: { mode: 'keyword' as const, note: `keyword search only (${reason})` },
    embeddingFor: () => undefined,
  });
  if (input.configurationError) return keyword(`embedding configuration unreadable: ${input.configurationError}`);
  const configured = Object.values(input.configured).filter((provider): provider is SourceEmbeddingProvider => provider !== undefined);
  if (configured.length === 0) return keyword('no embedding model is configured');
  const builtIn = [...new Set(configured.filter((provider) => provider instanceof BuiltInSourceEmbeddingProvider))] as BuiltInSourceEmbeddingProvider[];
  if (builtIn.length === 0) return keyword('the configured embedding model is not the built-in one');
  for (const provider of builtIn) {
    const status = provider.status();
    if (status.state !== 'ready' && status.previouslyReady !== true) {
      return keyword(`built-in embedding model ${provider.modelId} is not installed (${status.state})`);
    }
    // Loading runs the installer, which downloads whatever is missing: a
    // status file that outlived its files must not start a download.
    if (!builtInEmbeddingFilesPresent(provider.modelId, input.env ?? process.env)) {
      return keyword(`built-in embedding model ${provider.modelId} files are missing`);
    }
    try {
      await withTimeout(provider.warm(), input.warmTimeoutMs ?? DEFAULT_EMBEDDING_WARM_TIMEOUT_MS, 'model load');
    } catch (error) {
      return keyword(`built-in embedding model ${provider.modelId} did not load: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const modelIds = [...new Set(builtIn.map((provider) => provider.modelId))].join(', ');
  return {
    retrieval: { mode: 'hybrid', modelId: modelIds, note: `hybrid search with the built-in embedding model ${modelIds}` },
    embeddingFor: (trustDomain) => input.configured[trustDomain],
  };
}

/** Whether every file the built-in model loads from is on disk (never downloads). */
export function builtInEmbeddingFilesPresent(modelId: string, env: Record<string, string | undefined>): boolean {
  const model = builtInEmbeddingModel(modelId);
  if (!model) return false;
  try {
    const paths = builtInEmbeddingPaths(env, model);
    const installed = installedBuiltInEmbedding(paths, model);
    return [installed.modelPath, installed.vocabularyPath, installed.libraryPath ?? installed.runtimeDir]
      .every((path) => path === undefined || existsSync(path));
  } catch {
    return false;
  }
}

/** Each tier's embedding model as this install configures it (the worker's own resolution). */
export async function configuredEvalEmbedding(
  config: OlympusConfig,
  env: Record<string, string | undefined>,
): Promise<Parameters<typeof prepareEvalEmbedding>[0]['configured']> {
  try {
    const { loadSourceWorkerSovereignty, createSourceIndexEmbeddingProviderFromSovereignty } = await import('../src/workers/engine/runtime/embedding-providers.ts');
    const engine = loadSourceWorkerSovereignty(config, env);
    const configured: Partial<Record<SourceTrustDomain, SourceEmbeddingProvider>> = {};
    for (const domain of ['public_safe', 'internal', 'secure_local'] as const) {
      const provider = createSourceIndexEmbeddingProviderFromSovereignty(engine, domain, env);
      if (provider) configured[domain] = provider;
    }
    return configured;
  } catch (error) {
    console.error(`eval retrieval: embedding configuration unreadable (${error instanceof Error ? error.message : String(error)})`);
    return {};
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
