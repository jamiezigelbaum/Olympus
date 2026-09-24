import { defineSourceIndexCorpus, type SourceIndexCorpusDefinition } from '../../core/source-index/corpus.ts';
import {
  LEGACY_READWISE_LIBRARY_CORPUS_ID,
  READWISE_LIBRARY_CORPUS_ID,
} from '../../core/source-corpus-registry.ts';

export { LEGACY_READWISE_LIBRARY_CORPUS_ID, READWISE_LIBRARY_CORPUS_ID };

export function defineReadwiseLibraryCorpus(): SourceIndexCorpusDefinition {
  return defineSourceIndexCorpus({
    corpusId: READWISE_LIBRARY_CORPUS_ID,
    family: 'readwise',
    trustDomain: 'internal',
    // Owner decision 2026-09-24: hybrid on the vectors the lane already stores.
    activationMode: 'hybrid_primary',
    storageProfileInput: {
      cloudEmbeddingApproved: true,
      cloudQueryApproved: false,
    },
    defaultSensitivity: {
      trustTier: 'S1',
      trustDomain: 'internal',
      cloudEmbeddingEligible: true,
    },
    description: 'S1/internal Readwise Reader documents and highlights; saved/read context is owner-private.',
  });
}
