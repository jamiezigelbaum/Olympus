import type { ExtractionCandidateReader } from '../../core/file-extraction-source.ts';
import type { ConnectorStoreSearchFilters, LocalConnectorStore } from './local-index.ts';

/**
 * The store, as a source reads candidates.
 *
 * An adapter is needed and the design implied one would not be: the store
 * returns a nested `identity` while the shared reader port wants the join key
 * and its parts flat. The shapes are otherwise identical, options included, so
 * this is the whole of the distance between them — and it belongs in its own
 * small module, rather than in either of the two it joins.
 */
export function connectorStoreExtractionCandidateReader(
  store: Pick<LocalConnectorStore, 'extractionCandidates'>,
  filters?: ConnectorStoreSearchFilters,
): ExtractionCandidateReader {
  return {
    extractionCandidates(options) {
      const page = store.extractionCandidates({ ...options, ...(filters ? { filters } : {}) });
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
          ...(candidate.sizeBytes !== undefined ? { sizeBytes: candidate.sizeBytes } : {}),
        })),
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        done: page.done,
      };
    },
  };
}
