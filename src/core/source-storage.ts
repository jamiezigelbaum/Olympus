/**
 * The storage service: the only code that constructs an account's stores and
 * tier sidecars (docs/design/source-storage.md, "Storage service").
 *
 * Every open reads the account registry first. An account whose state is not
 * `active` (being deleted, or deleted) is never opened: the caller gets
 * `SourceStorageUnavailableError`, the same answer as a lane that is not
 * mounted, and never a stand-in store. Paths are the caller's, exactly as
 * they resolve today; nothing here moves a file.
 *
 * Adoption: the worker turns it on once at boot. From then on a writable open
 * of an account with no registry entry records one (`layout: 'legacy'`, the
 * files at today's paths), and an open of a corpus the entry does not list
 * yet adds it. Read-only opens, and every open while adoption is off (the
 * CLI, scripts, tests), never write the registry.
 *
 * No instance cache: callers share the objects they open, as before.
 */
import { SecretLocationsIndex } from '../workers/classification/secret-locations.ts';
import { TierSnifferStore } from '../workers/classification/sniffer-store.ts';
import { TierLedger, type TierLedgerOptions } from '../workers/classification/tier-ledger.ts';
import { LocalConnectorStore, type LocalConnectorStoreOptions } from '../workers/connector-store/local-index.ts';
import type { LayoutEnv } from './olympus-layout.ts';
import { defaultSourceCorpusRegistryConfig } from './source-corpus-registry.ts';
import {
  findRegistryAccount,
  readSourceRegistry,
  updateSourceRegistry,
  type SourceRegistry,
  type SourceRegistryAccountState,
} from './source-registry.ts';

/** One connected account of a source. Every source has one slot today. */
export interface StorageAccount {
  sourceId: string;
  slot?: string;
}

export const DEFAULT_STORAGE_SLOT = '1';

export class SourceStorageUnavailableError extends Error {
  readonly code = 'source_storage_unavailable';
  readonly sourceId: string;
  readonly slot: string;
  readonly state: Exclude<SourceRegistryAccountState, 'active'>;

  constructor(sourceId: string, slot: string, state: Exclude<SourceRegistryAccountState, 'active'>) {
    const account = slot === DEFAULT_STORAGE_SLOT ? sourceId : `${sourceId} (account ${slot})`;
    super(`${account} is not available: ${unavailableStateReason(state)}.`);
    this.name = 'SourceStorageUnavailableError';
    this.sourceId = sourceId;
    this.slot = slot;
    this.state = state;
  }
}

let adoptionEnabled = false;

/** Record accounts on their first writable open. The worker's `main()` calls this once, before any lane mounts. */
export function enableSourceRegistryAdoption(): void {
  adoptionEnabled = true;
}

export function openConnectorStore(
  account: StorageAccount,
  options: LocalConnectorStoreOptions,
  env: LayoutEnv = process.env,
): LocalConnectorStore {
  const slot = account.slot ?? DEFAULT_STORAGE_SLOT;
  const registry = readSourceRegistry(env);
  assertOpenable(registry, account.sourceId, slot);
  if (adoptionEnabled && options.readOnly !== true) {
    const entry = findRegistryAccount(registry, account.sourceId, slot);
    if (!entry?.corpus_ids.includes(options.corpusId)) adopt(env, account.sourceId, slot, options.corpusId);
  }
  return new LocalConnectorStore(options);
}

export function openTierLedger(account: StorageAccount, options: TierLedgerOptions, env: LayoutEnv = process.env): TierLedger {
  assertOpenable(readSourceRegistry(env), account.sourceId, account.slot ?? DEFAULT_STORAGE_SLOT);
  return new TierLedger(options);
}

export function openSecretLocations(
  account: StorageAccount,
  options: ConstructorParameters<typeof SecretLocationsIndex>[0],
  env: LayoutEnv = process.env,
): SecretLocationsIndex {
  assertOpenable(readSourceRegistry(env), account.sourceId, account.slot ?? DEFAULT_STORAGE_SLOT);
  return new SecretLocationsIndex(options);
}

export function openTierSniffer(
  account: StorageAccount,
  options: ConstructorParameters<typeof TierSnifferStore>[0],
  env: LayoutEnv = process.env,
): TierSnifferStore {
  assertOpenable(readSourceRegistry(env), account.sourceId, account.slot ?? DEFAULT_STORAGE_SLOT);
  return new TierSnifferStore(options);
}

/**
 * Why an account's stores may not be opened now, or undefined when they may.
 * An unreadable registry closes every account (it may hold a delete marker).
 */
export function sourceAccountUnavailableReason(account: StorageAccount, env: LayoutEnv = process.env): string | undefined {
  let registry: SourceRegistry;
  try {
    registry = readSourceRegistry(env);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const state = findRegistryAccount(registry, account.sourceId, account.slot ?? DEFAULT_STORAGE_SLOT)?.state;
  if (state === undefined || state === 'active') return undefined;
  return unavailableStateReason(state);
}

/** Whether an account's stores may be opened now: the mount decision at worker boot. */
export function isSourceAccountOpenable(account: StorageAccount, env: LayoutEnv = process.env): boolean {
  return sourceAccountUnavailableReason(account, env) === undefined;
}

/**
 * The account of a store declared only by its corpus (a connector-store JSON
 * mount, an operator script's `--db`): the corpus registry's source for that
 * corpus, else the corpus id without its trust-domain prefix
 * (`secure_local.reflect.notes` is `reflect.notes`, the id the data
 * lifecycle names it by).
 */
export function storageAccountForCorpus(
  corpus: { corpusId: string; trustDomain: string },
  registered: ReadonlyArray<{ corpusId: string; sourceId: string }> = [],
): StorageAccount {
  const known = [...registered, ...defaultSourceCorpusRegistryConfig().corpora]
    .find((entry) => entry.corpusId === corpus.corpusId);
  if (known) return { sourceId: known.sourceId };
  const prefix = `${corpus.trustDomain}.`;
  const unprefixed = corpus.corpusId.startsWith(prefix) ? corpus.corpusId.slice(prefix.length) : '';
  return { sourceId: unprefixed || corpus.corpusId };
}

function unavailableStateReason(state: Exclude<SourceRegistryAccountState, 'active'>): string {
  return state === 'deleting' ? 'its data is being deleted' : 'its data was deleted';
}

function assertOpenable(registry: SourceRegistry, sourceId: string, slot: string): void {
  const state = findRegistryAccount(registry, sourceId, slot)?.state;
  if (state !== undefined && state !== 'active') throw new SourceStorageUnavailableError(sourceId, slot, state);
}

function adopt(env: LayoutEnv, sourceId: string, slot: string, corpusId: string): void {
  updateSourceRegistry(env, (registry) => {
    // Read again under the lease: a delete marked since the first read wins.
    assertOpenable(registry, sourceId, slot);
    const entry = findRegistryAccount(registry, sourceId, slot);
    if (!entry) {
      registry.accounts.push({
        source_id: sourceId,
        slot,
        state: 'active',
        layout: 'legacy',
        corpus_ids: [corpusId],
        created_at: new Date().toISOString(),
      });
    } else if (!entry.corpus_ids.includes(corpusId)) {
      entry.corpus_ids.push(corpusId);
    }
  });
}

export const __sourceStorageTestHooks = {
  disableAdoption(): void {
    adoptionEnabled = false;
  },
};
