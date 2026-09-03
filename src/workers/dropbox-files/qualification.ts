// Thin Dropbox loopback for the source-generic qualification runner.
//
// This deliberately bypasses ordinary read-authority selection without
// changing it: pre-flip evaluation can exercise the mounted connector store in
// process while Castor continues to read the legacy Dropbox index. Grading,
// gap semantics, receipts, and post-flip HTTP execution remain generic in
// eval/qualification.ts.
//
// Dropbox is a secure_local corpus, so the caller's request owns
// include_secure_local / include_secure_local_content: this file mounts the
// lane, it does not widen release policy.

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
import { defineDropboxFilesCorpus, DROPBOX_FILES_CORPUS_ID } from './corpus-adapter.ts';

export function createDropboxQualificationLoopback(options: {
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
        registry: buildSourceIndexCorpusRegistry([defineDropboxFilesCorpus()]),
        adapters: {
          // Keyword by default: the Dropbox embedding backfill is a D6 runtime
          // step, so a qualification run before it must not silently claim a
          // hybrid lane it does not have.
          [DROPBOX_FILES_CORPUS_ID]: createConnectorStoreCorpusAdapter({
            store: options.store,
            retrievalMode: request.retrieval_mode ?? 'keyword',
            ...(accountScope ? { accountScope } : {}),
            ...(options.embeddingProvider
              ? { embeddingProvider: options.embeddingProvider }
              : {}),
          }),
        },
        contentProviders: {
          [DROPBOX_FILES_CORPUS_ID]: createConnectorStoreContentProvider({
            store: options.store,
          }),
        },
      };
    },
  };
  return createAnalystSourceIndexAnswerHandler(answerOptions);
}
