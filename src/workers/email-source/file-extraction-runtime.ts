/**
 * Wiring for the source-neutral extraction factory.
 *
 * The factory itself may not name a connector family — its whole directory is
 * enrolled in the architecture guard's source-agnostic list. This module is
 * where the family-shaped half lives: which store holds a corpus, how a family
 * turns a lane key into bytes, and which credential it needs to do it.
 *
 * Everything the factory needs arrives from here as data:
 *
 *   - the corpus roster, from one JSON env key, the way the connector-store
 *     roster already arrives;
 *   - the sink, the trust-tier reader and the candidate reader, all of them the
 *     corpus's own connector store, which already implements every shape they
 *     need;
 *   - the source, built LAZILY. Extraction runs are long and the family
 *     credential is a bearer token issued by the broker, so the source is
 *     constructed on first use inside a run rather than at boot.
 *
 * The egress policy is opt-IN. A corpus with no `max_trust_tier_for_remote`
 * carries no policy at all, and the runner's gate refuses every approved-remote
 * extractor for it. That is how a corpus is kept off the remote lane: by the
 * gate, not by leaving a kind out of a registry.
 */

import {
  createEnvCredentialBroker,
  type CredentialBroker,
} from '../credential-broker/index.ts';
import {
  buildSourceSensitivity,
  type SourceTrustTier,
} from '../../core/source-index/types.ts';
import type { ExtractionCandidateReader } from '../../core/file-extraction-source.ts';
import type { RawItem } from '../../core/contracts.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import { DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID } from '../dropbox-files/connector-store.ts';
import {
  DropboxExtractionSource,
  type DropboxExtractionLocalRootConfig,
} from '../dropbox-files/extraction-source.ts';
import { parseDropboxLocalFileRootsFromEnv } from '../dropbox-files/local-file-resolver.ts';
import {
  createGoogleDriveDailyRequestBudget,
  createRestGoogleDriveApiClient,
  GOOGLE_DRIVE_PROVIDER,
} from '../google-connectors/drive.ts';
import { GoogleDriveExtractionSource } from '../google-connectors/drive-extraction-source.ts';
import type { GoogleDailyRequestBudget } from '../google-connectors/request-budget.ts';
import { WhatsAppExtractionSource } from '../whatsapp/extraction-source.ts';
import {
  WHATSAPP_EXTRACTION_SCOPE_KEY,
  WHATSAPP_LIVE_CORPUS_ID,
  WHATSAPP_PERSONAL_ACCOUNT_SCOPE,
  WHATSAPP_PRODUCT_CONNECTOR_ID,
  defaultWhatsAppMediaDir,
} from '../whatsapp/store-sync.ts';
import {
  LocalFileExtractionJobStore,
  defaultFileExtractionJobsDbPath,
} from '../file-extraction/job-store.ts';
import {
  createDefaultExtractorRegistry,
  defaultTerminalReclassificationRules,
  extractorHealthProbes,
} from '../file-extraction/registry.ts';
import {
  createFileExtractionRunner,
  type ExtractionRunnerCorpus,
  type FileExtractionRunner,
} from '../file-extraction/runner.ts';
import { createConnectorStoreExtractionSink } from '../file-extraction/store-sink.ts';
import type {
  ExtractorRegistryConfig,
  FileExtractionSource,
} from '../file-extraction/types.ts';

export const FILE_EXTRACTION_ENABLED_ENV = 'OLYMPUS_FILE_EXTRACTION_ENABLED';
export const FILE_EXTRACTION_CORPORA_ENV = 'OLYMPUS_FILE_EXTRACTION_CORPORA_JSON';
export const FILE_EXTRACTION_WORKER_ID_ENV = 'OLYMPUS_FILE_EXTRACTION_WORKER_ID';

/**
 * The connector id the factory records as the pass that ran, distinct from the
 * connector that OWNS the item. The factory enriches; it never owns.
 */
export const FILE_EXTRACTION_SYNC_CONNECTOR_ID = 'file-extraction-factory';

/**
 * One corpus of the roster, as it appears in the env JSON.
 */
export interface FileExtractionCorpusConfig {
  corpusId: string;
  provider: string;
  scopes: readonly string[];
  credentialHandle?: string;
  /**
   * Resolves the credential handle at RUN time, from whatever the connected
   * handle registry holds then.
   *
   * Never parsed from the roster JSON — a roster entry is data, and this is the
   * live read that keeps a corpus from being pinned to whatever happened to be
   * connected when the process booted. An account connected through the
   * dashboard an hour after boot is a supported state, not a restart.
   *
   * Consulted only when `credentialHandle` is absent, so an operator pin still
   * wins over the registry.
   */
  resolveCredentialHandle?: () => string | undefined;
  ownerConnectorId?: string;
  maxTrustTierForRemote?: 'S3' | 'S4';
  allowDefaultDeferred?: boolean;
}

export interface FileExtractionRuntimeOptions {
  env?: Record<string, string | undefined>;
  /** Product wiring may enable the shared factory without an operator env gate. */
  enabled?: boolean;
  connectorStores: readonly LocalConnectorStore[];
  extractors?: ExtractorRegistryConfig;
  /**
   * Overrides the roster parsed from the environment. Tests supply this; the
   * runtime reads the env key.
   */
  corpora?: readonly FileExtractionCorpusConfig[];
  /**
   * Builds a family's source for one corpus. Supplied by tests, and by any
   * family this module does not know how to construct.
   */
  sourceFactories?: ReadonlyMap<
    string,
    (input: { config: FileExtractionCorpusConfig; store: LocalConnectorStore })
      => FileExtractionSource | Promise<FileExtractionSource>
  >;
  /**
   * The broker a family factory issues its download credential from. Injected
   * by tests; the runtime builds one over its own `env`.
   */
  credentialBroker?: CredentialBroker;
  /** Where a dropped corpus is reported. Defaults to `console.warn`. */
  warn?: (message: string) => void;
  jobsDbPath?: string;
}

export interface FileExtractionRuntime {
  runner: FileExtractionRunner;
  jobs: LocalFileExtractionJobStore;
  corpusIds: readonly string[];
  close(): void;
}

/**
 * Build the runtime, or return undefined when the factory is switched off or
 * has no corpus it can actually serve.
 *
 * A corpus in the roster with no connector store, or with a provider nothing
 * knows how to build a source for, is DROPPED rather than half-registered. A
 * lane that accepts requests and cannot fetch bytes reports orderly failures
 * for ever, which is worse than answering "that corpus is not served here".
 *
 * A drop is always LOGGED. Dropping silently made a mistyped provider and a
 * corpus whose store is not mounted look identical to a corpus nobody
 * configured, and the operator's only symptom was text that never appeared.
 */
export function createFileExtractionRuntime(
  options: FileExtractionRuntimeOptions,
): FileExtractionRuntime | undefined {
  const env = options.env ?? process.env;
  if (
    options.enabled !== true
    && (env[FILE_EXTRACTION_ENABLED_ENV] ?? '').trim().toLowerCase() !== 'true'
  ) return undefined;

  const roster = options.corpora ?? parseFileExtractionCorporaEnv(env[FILE_EXTRACTION_CORPORA_ENV]);
  if (roster.length === 0) return undefined;

  const warn = options.warn ?? ((message: string) => console.warn(message));
  const storesByCorpusId = new Map(options.connectorStores.map((store) => [store.corpusId, store]));
  const sourceFactories = options.sourceFactories ?? defaultSourceFactories(
    env,
    options.credentialBroker ? { credentialBroker: options.credentialBroker } : {},
  );

  // Opened BEFORE the roster loop, because each sink needs it: the lease fence
  // asks the queue whether this worker still holds the job in the statement
  // before it mutates the corpus, and a sink is built once per corpus rather
  // than once per job. The cost is that a roster where nothing resolves now
  // opens the queue before it bails, so that path closes it explicitly.
  const jobs = new LocalFileExtractionJobStore(
    options.jobsDbPath ?? defaultFileExtractionJobsDbPath(env),
  );

  const corpora: ExtractionRunnerCorpus[] = [];
  for (const config of roster) {
    const store = storesByCorpusId.get(config.corpusId);
    if (!store) {
      warn(fileExtractionCorpusDropped(config, 'no_connector_store'));
      continue;
    }
    const buildSource = sourceFactories.get(config.provider);
    if (!buildSource) {
      warn(fileExtractionCorpusDropped(config, 'no_source_factory'));
      continue;
    }
    corpora.push({
      corpusId: config.corpusId,
      trustDomain: store.trustDomain,
      source: () => buildSource({ config, store }),
      sink: createConnectorStoreExtractionSink({
        store,
        classify: (item: RawItem) => buildSourceSensitivity({
          // The item's OWN stored tier, read live. A constant here would either
          // downgrade an item on every enrichment pass or make the store refuse
          // one it already holds.
          trustTier: storedTrustTier(store, item) ?? 'S4',
          trustDomain: store.trustDomain,
        }),
        syncConnectorId: FILE_EXTRACTION_SYNC_CONNECTOR_ID,
        ownerConnectorId: config.ownerConnectorId ?? `${config.provider}-connector`,
        ownershipKind: 'observed',
        claims: jobs,
      }),
      ...(config.maxTrustTierForRemote
        ? {
            egressPolicy: {
              maxTrustTierForRemote: config.maxTrustTierForRemote,
              allowDefaultDeferred: config.allowDefaultDeferred === true,
            },
          }
        : {}),
      trustTiers: {
        itemTrustTier: (ref) => store.localContent(ref.localItemId, 1)?.trustTier,
      },
    });
  }
  if (corpora.length === 0) {
    jobs.close();
    return undefined;
  }

  const extractorConfig = options.extractors ?? {};
  const registry = createDefaultExtractorRegistry(extractorConfig);
  const workerId = env[FILE_EXTRACTION_WORKER_ID_ENV]?.trim();

  const runner = createFileExtractionRunner({
    jobs,
    registry,
    corpora,
    healthProbes: extractorHealthProbes(extractorConfig),
    reclassificationRules: defaultTerminalReclassificationRules(registry),
    ...(workerId ? { workerId } : {}),
  });

  return {
    runner,
    jobs,
    corpusIds: corpora.map((corpus) => corpus.corpusId),
    close() {
      jobs.close();
    },
  };
}

/**
 * The roster the product runtime serves: the operator's configured entries,
 * plus the canonical corpora the product owns outright.
 *
 * Credential state is deliberately NOT an input. A corpus is registered
 * whenever its connector store and its approved scopes exist, and the handle is
 * resolved per run — so an account connected through the dashboard after boot
 * starts extracting on the next scheduler tick instead of at the next restart.
 * Gating registration on the boot-time handle was the defect: the roster froze
 * before the owner had connected anything, and every later rebuild of the
 * scheduler source inherited that frozen answer.
 *
 * A canonical corpus REPLACES a configured entry for the same corpus id, since
 * its scopes come from the ingestion policy rather than from the JSON. The
 * configured entry still carries the remote-egress opt-in, which is the one
 * field an operator owns.
 */
export function fileExtractionCorporaRoster(input: {
  configured: readonly FileExtractionCorpusConfig[];
  /** Present when the Dropbox connector store and its extraction scopes exist. */
  dropbox?: {
    extractionScopes: readonly string[];
    resolveCredentialHandle: () => string | undefined;
  };
  /** True when the WhatsApp connector store exists. */
  whatsapp?: boolean;
}): FileExtractionCorpusConfig[] {
  const configuredDropbox = input.configured.find(
    (corpus) => corpus.corpusId === DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
  );
  const canonicalIds = new Set<string>();
  const canonical: FileExtractionCorpusConfig[] = [];
  if (input.dropbox && input.dropbox.extractionScopes.length > 0) {
    canonicalIds.add(DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID);
    canonical.push({
      corpusId: DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
      provider: 'dropbox',
      scopes: input.dropbox.extractionScopes,
      resolveCredentialHandle: input.dropbox.resolveCredentialHandle,
      ownerConnectorId: 'dropbox',
      ...(configuredDropbox?.maxTrustTierForRemote
        ? {
            maxTrustTierForRemote: configuredDropbox.maxTrustTierForRemote,
            allowDefaultDeferred: configuredDropbox.allowDefaultDeferred === true,
          }
        : {}),
    });
  }
  if (input.whatsapp === true) {
    canonicalIds.add(WHATSAPP_LIVE_CORPUS_ID);
    canonical.push({
      corpusId: WHATSAPP_LIVE_CORPUS_ID,
      provider: 'whatsapp',
      scopes: [WHATSAPP_EXTRACTION_SCOPE_KEY],
      ownerConnectorId: WHATSAPP_PRODUCT_CONNECTOR_ID,
    });
  }
  return [
    ...input.configured.filter((corpus) => !canonicalIds.has(corpus.corpusId)),
    ...canonical,
  ];
}

/**
 * The roster, from one JSON key.
 *
 * A malformed roster is a configuration error and throws at boot, where it is
 * visible, rather than degrading into an empty roster that would look like the
 * factory simply being off.
 */
export function parseFileExtractionCorporaEnv(
  raw: string | undefined,
): readonly FileExtractionCorpusConfig[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${FILE_EXTRACTION_CORPORA_ENV} must be a JSON array of corpus objects.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${FILE_EXTRACTION_CORPORA_ENV} must be a JSON array of corpus objects.`);
  }
  return parsed.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`${FILE_EXTRACTION_CORPORA_ENV} entries must be objects.`);
    }
    const record = entry as Record<string, unknown>;
    const corpusId = requiredString(record.corpus_id, 'corpus_id');
    const provider = requiredString(record.provider, 'provider');
    const scopes = Array.isArray(record.scopes)
      ? record.scopes.map((scope) => requiredString(scope, 'scopes[]'))
      : [];
    if (scopes.length === 0) {
      throw new Error(`${FILE_EXTRACTION_CORPORA_ENV} entry ${corpusId} needs at least one approved scope key.`);
    }
    const maxTier = optionalString(record.max_trust_tier_for_remote);
    if (maxTier !== undefined && maxTier !== 'S3' && maxTier !== 'S4') {
      throw new Error(`${FILE_EXTRACTION_CORPORA_ENV} entry ${corpusId} max_trust_tier_for_remote must be S3 or S4.`);
    }
    return {
      corpusId,
      provider,
      scopes,
      ...(optionalString(record.credential_handle) !== undefined
        ? { credentialHandle: optionalString(record.credential_handle)! }
        : {}),
      ...(optionalString(record.owner_connector_id) !== undefined
        ? { ownerConnectorId: optionalString(record.owner_connector_id)! }
        : {}),
      ...(maxTier !== undefined ? { maxTrustTierForRemote: maxTier } : {}),
      ...(record.allow_default_deferred === true ? { allowDefaultDeferred: true } : {}),
    };
  });
}

/**
 * The families this module can construct a source for.
 *
 * Deliberately a map rather than a switch: a family that is not here is a
 * corpus that gets dropped from the roster, which is the honest outcome, and
 * adding one is a registration rather than an edit to the loop.
 */
function defaultSourceFactories(
  env: Record<string, string | undefined>,
  deps: { credentialBroker?: CredentialBroker } = {},
): FileExtractionRuntimeOptions['sourceFactories'] & object {
  const localRoots = parseDropboxLocalFileRootsFromEnv(env) as DropboxExtractionLocalRootConfig[];
  // Both of these are built on first use and reused after. Lazily, because this
  // function runs at boot and neither belongs there: a runtime whose roster
  // never reaches a credentialed family should not construct a broker, and a
  // runtime with no Drive corpus should not open a request-budget ledger.
  let sharedBroker = deps.credentialBroker;
  const broker = (): CredentialBroker => (sharedBroker ??= createEnvCredentialBroker({ env }));
  let driveRequestBudget: GoogleDailyRequestBudget | undefined;
  const factories = new Map<string, (
    input: { config: FileExtractionCorpusConfig; store: LocalConnectorStore },
  ) => FileExtractionSource | Promise<FileExtractionSource>>([
    ['dropbox', async (input: { config: FileExtractionCorpusConfig; store: LocalConnectorStore }) => {
      const token = await issueDropboxExtractionToken(broker(), extractionCredentialHandle(input.config));
      return new DropboxExtractionSource({
        id: `${input.config.corpusId}:extraction`,
        corpusId: input.config.corpusId,
        provider: input.config.provider,
        candidates: connectorStoreExtractionCandidateReader(input.store),
        locators: input.store,
        scopes: input.config.scopes.map((approvedScopeKey) => ({ approvedScopeKey })),
        token,
        ...(localRoots.length > 0 ? { localRoots } : {}),
      });
    }],
    ['google_drive', async (input: { config: FileExtractionCorpusConfig; store: LocalConnectorStore }) => {
      const handle = extractionCredentialHandle(input.config)
        || env.OLYMPUS_SOURCE_INDEX_GOOGLE_DRIVE_CREDENTIAL_HANDLE?.trim()
        || 'google_drive.personal';
      const session = await broker().issueSession({
        handle,
        provider: GOOGLE_DRIVE_PROVIDER,
        capability: 'google_drive.docs.sync',
        trustDomain: 'internal',
        purpose: 'file.extraction.download',
      });
      if (session.kind !== 'bearer_token') {
        throw new Error(`Credential handle ${handle} did not issue a bearer token session.`);
      }
      driveRequestBudget ??= createGoogleDriveDailyRequestBudget({ env });
      return new GoogleDriveExtractionSource({
        id: `${input.config.corpusId}:extraction`,
        corpusId: input.config.corpusId,
        provider: input.config.provider,
        approvedScopeKey: input.config.scopes[0]!,
        candidates: connectorStoreExtractionCandidateReader(input.store),
        client: createRestGoogleDriveApiClient({
          token: session.token,
          fetch,
          requestBudget: driveRequestBudget,
        }),
      });
    }],
    ['whatsapp', (input: { config: FileExtractionCorpusConfig; store: LocalConnectorStore }) => {
      return new WhatsAppExtractionSource({
        id: `${input.config.corpusId}:extraction`,
        corpusId: input.config.corpusId,
        provider: input.config.provider,
        accountScope: WHATSAPP_PERSONAL_ACCOUNT_SCOPE,
        approvedScopeKey: input.config.scopes[0]!,
        candidates: connectorStoreExtractionCandidateReader(input.store),
        locators: input.store,
        mediaRoots: [defaultWhatsAppMediaDir(env)],
      });
    }],
  ]);
  return factories;
}

/**
 * The store, as a source reads candidates.
 *
 * An adapter is needed and the design implied one would not be: the store
 * returns a nested `identity` while the shared reader port wants the join key
 * and its parts flat. The shapes are otherwise identical, options included, so
 * this is the whole of the distance between them — and it belongs here, in the
 * wiring, rather than in either of the two modules it joins.
 */
export function connectorStoreExtractionCandidateReader(
  store: LocalConnectorStore,
): ExtractionCandidateReader {
  return {
    extractionCandidates(options) {
      const page = store.extractionCandidates(options);
      return {
        candidates: page.candidates.map((candidate) => ({
          localItemId: candidate.identity.localItemId,
          providerItemId: candidate.identity.providerItemId,
          accountScope: candidate.identity.accountScope,
          provider: candidate.identity.provider,
          ...(candidate.identity.sourceVersion !== undefined
            ? { sourceVersion: candidate.identity.sourceVersion }
            : {}),
          ...(candidate.mimeType !== undefined ? { mimeType: candidate.mimeType } : {}),
          ...(candidate.locatorUri !== undefined ? { locatorUri: candidate.locatorUri } : {}),
          ...(candidate.contentHash !== undefined ? { contentHash: candidate.contentHash } : {}),
          ...(candidate.name !== undefined ? { name: candidate.name } : {}),
        })),
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        done: page.done,
      };
    },
  };
}

/**
 * The handle a family factory should ask the broker for.
 *
 * An explicit pin wins; otherwise the corpus resolves one from the live handle
 * registry at the moment the run needs it. Undefined means the family's own
 * default handle name, which is the pre-connection state and fails at the
 * broker with a credential error rather than pretending to extract.
 */
function extractionCredentialHandle(config: FileExtractionCorpusConfig): string | undefined {
  return config.credentialHandle ?? config.resolveCredentialHandle?.();
}

function fileExtractionCorpusDropped(
  config: FileExtractionCorpusConfig,
  reason: 'no_connector_store' | 'no_source_factory',
): string {
  return `[file-extraction] corpus=${config.corpusId} provider=${config.provider} dropped reason=${reason}`;
}

async function issueDropboxExtractionToken(
  broker: CredentialBroker,
  credentialHandle: string | undefined,
): Promise<string> {
  const handle = credentialHandle ?? 'dropbox.personal';
  const session = await broker.issueSession({
    handle,
    provider: 'dropbox',
    capability: 'dropbox.files.sync',
    trustDomain: 'secure_local',
    purpose: 'file.extraction.download',
  });
  if (session.kind !== 'bearer_token') {
    throw new Error(`Credential handle ${handle} did not issue a bearer token session.`);
  }
  return session.token;
}

function storedTrustTier(store: LocalConnectorStore, item: RawItem): SourceTrustTier | undefined {
  return store.localContent(item.identity.localItemId, 1)?.trustTier;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${FILE_EXTRACTION_CORPORA_ENV} ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0) return undefined;
  return value.trim();
}
