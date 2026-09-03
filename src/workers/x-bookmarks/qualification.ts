// Thin X loopback for the source-generic qualification runner.
//
// This deliberately bypasses ordinary read-authority selection without
// changing it: pre-activation evaluation can exercise the mounted connector
// store in process while Castor continues to read the legacy index. Grading,
// gap semantics, receipts, and post-flip HTTP execution remain generic in
// eval/qualification.ts.

import type { Analyst } from '../../core/contracts.ts';
import { buildSourceIndexCorpusRegistry } from '../../core/source-index/corpus.ts';
import {
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  type LocalConnectorStore,
} from '../connector-store/index.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import {
  createAnalystSourceIndexAnswerHandler,
  type AnalystSourceIndexAnswerHandlerOptions,
} from '../source-index/analyst-answer.ts';
import type { SourceIndexAnswerHandler } from '../source-index/answer-types.ts';
import { defineXBookmarksCorpus, X_BOOKMARKS_CORPUS_ID } from './corpus-adapter.ts';

export function createXBookmarksQualificationLoopback(options: {
  store: LocalConnectorStore;
  analyst: Analyst;
  account?: string;
  embeddingProvider?: SourceEmbeddingProvider;
  defaultMaxResults?: number;
  maxCharsPerCandidate?: number;
}): SourceIndexAnswerHandler {
  const answerOptions: AnalystSourceIndexAnswerHandlerOptions = {
    analyst: options.analyst,
    ...(options.defaultMaxResults !== undefined
      ? { defaultMaxResults: options.defaultMaxResults }
      : {}),
    ...(options.maxCharsPerCandidate !== undefined
      ? { maxCharsPerCandidate: options.maxCharsPerCandidate }
      : {}),
    lanes(request) {
      const accountScope = request.account?.trim() || options.account?.trim();
      return {
        registry: buildSourceIndexCorpusRegistry([defineXBookmarksCorpus()]),
        adapters: {
          [X_BOOKMARKS_CORPUS_ID]: createConnectorStoreCorpusAdapter({
            store: options.store,
            retrievalMode: request.retrieval_mode ?? 'keyword',
            ...(accountScope ? { accountScope } : {}),
            ...(options.embeddingProvider
              ? { embeddingProvider: options.embeddingProvider }
              : {}),
          }),
        },
        contentProviders: {
          [X_BOOKMARKS_CORPUS_ID]: createConnectorStoreContentProvider({
            store: options.store,
          }),
        },
      };
    },
  };
  return createAnalystSourceIndexAnswerHandler(answerOptions);
}
