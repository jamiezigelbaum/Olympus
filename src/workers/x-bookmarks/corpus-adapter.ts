import { defineSourceIndexCorpus, type SourceIndexCorpusDefinition } from '../../core/source-index/corpus.ts';

export const X_BOOKMARKS_CORPUS_ID = 'internal.x.bookmarks';

export function defineXBookmarksCorpus(): SourceIndexCorpusDefinition {
  return defineSourceIndexCorpus({
    corpusId: X_BOOKMARKS_CORPUS_ID,
    family: 'x',
    trustDomain: 'internal',
    activationMode: 'hybrid_shadow',
    storageProfileInput: {
      cloudEmbeddingApproved: true,
      cloudQueryApproved: false,
    },
    description: 'S1 X bookmarks with folder membership preserved for source indexing.',
  });
}
