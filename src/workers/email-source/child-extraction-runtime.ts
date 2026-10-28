/**
 * Reading a source's child items (docs/design/child-items.md, "Reading
 * later"): an attachment, a photo or a file a message carries is listed by
 * name with a locator, and its bytes are read here, later and on its own, by
 * the shared extraction factory over the source's own stores.
 *
 * One runtime per source: its stores are the corpora (each a home of its own,
 * since a child's names may rest in any of them), its tier set places what is
 * read, and its one connector takes a child's bytes from wherever the
 * locator says they are. Only children are candidates; a message is read with
 * its listing, never here. Nothing here names a source.
 */
import { CHILD_ITEM_ID_SEPARATOR } from '../../core/child-item-id.ts';
import type { SourceConnector } from '../../core/contracts.ts';
import type { ExtractionCandidateReader } from '../../core/file-extraction-source.ts';
import { tierLedgerIdentityKey } from '../classification/tier-ledger.ts';
import { hiddenByParentIdentity, itemVerdicts, type ChildProbe, type ChildVisibilityLane } from '../connector-store/child-visibility.ts';
import { connectorStoreExtractionCandidateReader } from '../connector-store/extraction-candidate-reader.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import type { TieredExtractionView } from '../connector-store/tiered-extraction.ts';
import type { TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import { createFileExtractionRuntime, type FileExtractionRuntime } from './file-extraction-runtime.ts';
import { createConnectorFileExtractionSource, deferredBytesAnswerFor } from '../file-extraction/connector-source.ts';
import type { ExtractorRegistryConfig } from '../file-extraction/types.ts';

/**
 * Whether a child may still be read and landed: its own row is not gone (not
 * tombstoned in every store) and its parent may be seen (child visibility: a
 * deleted or hidden parent hides it). Asked before its bytes are fetched and
 * again before its text is accepted; a queued job for a child that fails it is
 * closed and its text dropped.
 */
export function childStillServed(lane: ChildVisibilityLane, child: ChildProbe): boolean {
  const own = itemVerdicts(lane, [child]).get(tierLedgerIdentityKey(child));
  if (!own || own.gone) return false;
  return hiddenByParentIdentity(lane, [child]).size === 0;
}

/** Only child items are candidates (their ids carry the child separator). */
export function childItemCandidates(reader: ExtractionCandidateReader): ExtractionCandidateReader {
  return {
    async extractionCandidates(options) {
      const page = await reader.extractionCandidates(options);
      return { ...page, candidates: page.candidates.filter((row) => (row.providerItemId ?? row.localItemId).includes(CHILD_ITEM_ID_SEPARATOR)) };
    },
  };
}

/**
 * A source's child extraction runtime: the shared factory over the source's
 * stores, with its one reader, its tier set to place what is read, and the
 * product's extractors and jobs file.
 */
export function createChildExtractionRuntime(input: {
  /** The roster's key for the source's children (the factory registry is keyed by it). */
  provider: string;
  /** The one approved scope of the children's lanes. */
  scopeKey: string;
  corpusIds: readonly string[];
  stores: readonly LocalConnectorStore[];
  set: TieredStoreSet;
  accountScope: () => string;
  connector: (accountScope: string) => SourceConnector | undefined;
  extractors?: ExtractorRegistryConfig;
  env?: Record<string, string | undefined>;
  jobsDbPath?: string;
  warn?: (message: string) => void;
}): FileExtractionRuntime | undefined {
  return createFileExtractionRuntime({
    ...(input.env ? { env: input.env } : {}),
    enabled: true,
    connectorStores: [...input.stores],
    corpora: input.corpusIds.map((corpusId) => ({
      corpusId,
      provider: input.provider,
      scopes: [input.scopeKey],
      ownerConnectorId: input.provider,
      resolveAccountScope: input.accountScope,
    })),
    extraSourceFactories: new Map([[
      input.provider,
      ({ config, store, view }: { config: { corpusId: string; provider: string }; store: LocalConnectorStore; view?: TieredExtractionView }) => {
        const reader = view ?? store;
        return createConnectorFileExtractionSource({
          id: `${config.corpusId}:children`,
          corpusId: config.corpusId,
          provider: config.provider,
          connector: input.connector,
          deferredBytes: (ref) => deferredBytesAnswerFor(reader.deferredBytesStateOfLocalItem(ref.localItemId, ref.sourceVersion)),
          candidates: childItemCandidates(connectorStoreExtractionCandidateReader(reader)),
          lanes: [{ approvedScopeKey: input.scopeKey }],
        });
      },
    ]]),
    tierSets: new Map(input.corpusIds.map((corpusId) => [corpusId, input.set] as const)),
    // Rechecked before candidates are listed, before bytes are fetched and before text is accepted: a child
    // whose parent was deleted (or which was removed itself) while its job waited is never read or landed.
    scopeGuard: {
      assertAuthorized: () => {},
      allowsRef: ({ ref }) => {
        const stores = input.set.openStores();
        // A chat child's identity carries its conversation (the ledger keys by it); the row says which. No row
        // anywhere: the child is gone, and the ledger alone answers.
        const conversation = stores.map((store) => store.activeLocalItemRow(ref.localItemId)?.identity.providerConversationId).find(Boolean);
        return childStillServed(
          { ledger: () => input.set.ledger, stores: () => stores },
          { provider: ref.provider, accountScope: ref.accountScope, providerItemId: ref.providerItemId, ...(conversation ? { providerConversationId: conversation } : {}) },
        );
      },
    },
    ...(input.extractors ? { extractors: input.extractors } : {}),
    ...(input.jobsDbPath ? { jobsDbPath: input.jobsDbPath } : {}),
    ...(input.warn ? { warn: input.warn } : {}),
  });
}
