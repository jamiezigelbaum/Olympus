// Drains un-embedded connector-store chunks through the source-index
// embedding provider configured in the environment (the same
// OLYMPUS_SOURCE_INDEX_EMBEDDING_* seam the Dropbox secure-local lane uses).
//
//   bun run connector-store:embed --db <path> [--limit N]
//
// The store's corpus identity (corpusId / family / trustDomain) is resolved
// from the matching dbPath entry in OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON,
// or passed explicitly via --corpus-id / --family / --trust-domain.
//
// Output is counts-only: no chunk text, titles, or locators ever print.
// secure_local stores refuse non-local providers inside embedChunks (the
// trust rule is enforced by the store, not this script).

import { loadConfig } from '../src/core/config.ts';
import { SOURCE_FAMILIES, SOURCE_TRUST_DOMAINS } from '../src/core/source-index/types.ts';
import type {
  ConnectorStoreEmbedSummary,
  LocalConnectorStoreOptions,
} from '../src/workers/connector-store/index.ts';
import { withDataOwnerLock } from '../src/core/data-owner-lock.ts';
import { openConnectorStore, storageAccountForCorpus } from '../src/core/source-storage.ts';
import { defaultExclusionContext } from '../src/workers/local-files/paths.ts';
import { LOCAL_FILES_ACCOUNT_SCOPE, LOCAL_FILES_PROVIDER, LOCAL_FILES_SOURCE_ID } from '../src/workers/local-files/scope.ts';
import { FileSourceScopeAuthority } from '../src/workers/source-scope-runtime.ts';
import { gmailItemAccountScope } from '../src/workers/google-connectors/gmail-archive-target.ts';
import { accountFromGoogleHandle } from '../src/workers/google-connectors/classification.ts';
import { readGmailRetainedAccountScope } from '../src/workers/email-source/gmail-status-scope.ts';
import { handleRegistryPathFromEnv } from '../src/workers/credential-broker/connected-handles.ts';
import { recordedProviderAccount } from '../src/core/provider-account-history.ts';
import { scopedEmbeddingOptions } from '../src/workers/connector-store/embedding-plan.ts';
import { createSourceIndexEmbeddingProviderFromEnv } from '../src/workers/engine/runtime/embedding-providers.ts';
import { createStoreEmbeddingScopeFor, registeredStoreReadScope } from '../src/workers/engine/runtime/store-scope-policies.ts';

interface ConnectorStoreEmbedCliArgs {
  db: string;
  limit?: number;
  corpusId?: string;
  family?: string;
  trustDomain?: string;
}

export function parseConnectorStoreEmbedCliArgs(argv: readonly string[]): ConnectorStoreEmbedCliArgs {
  let db: string | undefined;
  let limit: number | undefined;
  let corpusId: string | undefined;
  let family: string | undefined;
  let trustDomain: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    const value = (): string => {
      const next = argv[index + 1];
      if (next === undefined) throw new Error(`${flag} requires a value.`);
      index += 1;
      return next;
    };
    if (flag === '--db') db = value();
    else if (flag === '--limit') {
      const parsed = Number.parseInt(value(), 10);
      if (!Number.isSafeInteger(parsed) || parsed < 1) {
        throw new Error('--limit must be a positive integer.');
      }
      limit = parsed;
    } else if (flag === '--corpus-id') corpusId = value();
    else if (flag === '--family') family = value();
    else if (flag === '--trust-domain') trustDomain = value();
    else throw new Error(`Unknown flag ${flag}. Usage: --db <path> [--limit N] [--corpus-id <id> --family <family> --trust-domain <domain>]`);
  }

  if (!db?.trim()) {
    throw new Error('Usage: bun run connector-store:embed --db <path> [--limit N]');
  }
  return {
    db: db.trim(),
    ...(limit !== undefined ? { limit } : {}),
    ...(corpusId?.trim() ? { corpusId: corpusId.trim() } : {}),
    ...(family?.trim() ? { family: family.trim() } : {}),
    ...(trustDomain?.trim() ? { trustDomain: trustDomain.trim() } : {}),
  };
}

// Resolves the store's corpus identity: explicit flags win; otherwise the
// dbPath is looked up in the same env JSON the worker uses to declare its
// connector-store corpora.
export function resolveConnectorStoreOptions(
  args: ConnectorStoreEmbedCliArgs,
  env: Record<string, string | undefined> = process.env,
): LocalConnectorStoreOptions {
  if (args.corpusId && args.family && args.trustDomain) {
    return {
      dbPath: args.db,
      corpusId: args.corpusId,
      ...assertDeclarableCorpusIdentity(args.family, args.trustDomain),
    };
  }
  const raw = env.OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON?.trim();
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON must be valid JSON.');
    }
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (!entry || typeof entry !== 'object') continue;
        const record = entry as Record<string, unknown>;
        if (typeof record.dbPath === 'string' && record.dbPath.trim() === args.db) {
          return {
            dbPath: args.db,
            corpusId: String(record.corpusId ?? ''),
            ...assertDeclarableCorpusIdentity(
              String(record.family ?? ''),
              String(record.trustDomain ?? ''),
            ),
          };
        }
      }
    }
  }
  throw new Error(
    'Connector store identity not found: pass --corpus-id/--family/--trust-domain or declare the '
    + 'dbPath in OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON.',
  );
}

// Both enums are checked before the casts. Every secure gate is exact equality
// against 'secure_local', so a typo'd domain does not degrade the store — it
// silently opens (or creates) it outside the secure band entirely.
function assertDeclarableCorpusIdentity(
  family: string,
  trustDomain: string,
): Pick<LocalConnectorStoreOptions, 'family' | 'trustDomain'> {
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
  return {
    family: family as LocalConnectorStoreOptions['family'],
    trustDomain: trustDomain as LocalConnectorStoreOptions['trustDomain'],
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

async function runConnectorStoreEmbed(argv: readonly string[]): Promise<{
  kind: 'connector_store_embed';
  embed: ConnectorStoreEmbedSummary;
  embedded_chunks_total: number;
  chunks_total: number;
}> {
  const args = parseConnectorStoreEmbedCliArgs(argv);
  const provider = createSourceIndexEmbeddingProviderFromEnv();
  if (!provider) {
    throw new Error(
      'No source-index embedding provider configured: set OLYMPUS_SOURCE_INDEX_EMBEDDING_PROVIDER '
      + '(local-openai-compatible for secure_local stores) plus OLYMPUS_SOURCE_INDEX_EMBEDDING_BASE_URL '
      + 'and OLYMPUS_SOURCE_INDEX_EMBEDDING_MODEL.',
    );
  }
  const options = resolveConnectorStoreOptions(args);
  // Held for the whole run: it refuses while Olympus runs (core/data-owner-lock.ts).
  return withDataOwnerLock(process.env, async () => {
    const account = storageAccountForCorpus(options, loadConfig().sourceIndex.corpusRegistry.corpora);
    const store = openConnectorStore(account, options);
    try {
      const registryPath = handleRegistryPathFromEnv(process.env, true)!;
      const authority = new FileSourceScopeAuthority({ registryPath, mailPinnedHandle: () => process.env.OLYMPUS_SOURCE_INDEX_GMAIL_CREDENTIAL_HANDLE });
      // With the worker stopped, prove this store is clear of Olympus-owned
      // folders using the same locator index the worker's cleanup walks.
      const localFilesReady = () => store.locatorIdentityIndexReady()
        && (defaultExclusionContext().ownRoots ?? []).every((locatorUri) => store.pageActiveItemsUnderLocatorIfIndexed({
          provider: LOCAL_FILES_PROVIDER, accountScope: LOCAL_FILES_ACCOUNT_SCOPE, locatorUri, limit: 1,
        }).items.length === 0);
      const embeddingScopeFor = createStoreEmbeddingScopeFor({
        sourceIdForStore: () => account.sourceId, authority,
        readScope: () => account.sourceId === LOCAL_FILES_SOURCE_ID && !localFilesReady()
          ? { allowed: false }
          : registeredStoreReadScope(account.sourceId, authority),
        gmailRetainedAccountScope: () => readGmailRetainedAccountScope({
          registryPath, historyAccountId: () => recordedProviderAccount(account),
          itemScope: (handle) => gmailItemAccountScope([store], handle?.accountRole?.trim() || accountFromGoogleHandle(handle?.handle)),
        }),
      });
      const scope = embeddingScopeFor(store, provider);
      if (!scope.allowed) throw new Error('This store has no verified content scope for offline embedding.');
      const embed = await store.embedChunks({
        ...scopedEmbeddingOptions(scope, provider),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      const status = store.status();
      return {
        kind: 'connector_store_embed' as const,
        embed,
        embedded_chunks_total: status.counts.embeddedChunks,
        chunks_total: status.counts.chunks,
      };
    } finally {
      store.close();
    }
  });
}

if (import.meta.main) {
  runConnectorStoreEmbed(process.argv.slice(2))
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
