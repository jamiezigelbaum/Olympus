import { describe, expect, test } from 'bun:test';
import type { Analyst, AnalystResult, EvidencePack } from '../src/core/contracts.ts';
import type { LocalContentProvider, LocalContentProviderMap } from '../src/core/evidence-pack.ts';
import {
  buildSourceIndexCorpusRegistry,
  defineSourceIndexCorpus,
} from '../src/core/source-index/corpus.ts';
import type { SourceIndexRouterAdapterMap } from '../src/core/source-index/router.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { createAnalystSourceIndexAnswerHandler } from '../src/workers/source-index/analyst-answer.ts';

const CORPUS_ID = 'secure_local.dropbox.files';
const QUESTION = 'What is the retainer amount?';

describe('corpus-level readability on canonical answers', () => {
  test('adds counts-only readability context to a zero-evidence answer', async () => {
    const result = await handler({
      provider: {
        async fetchLocalContent() { return undefined; },
        async corpusReadability() {
          return { partialDocuments: 1, unreadDocuments: 2 };
        },
      },
      hits: [],
    }).answer({
      question: QUESTION,
      corpus_id: CORPUS_ID,
      include_secure_local: true,
    });

    expect(result.evidence).toEqual([]);
    expect(result.answer).toContain('Not everything in the searched corpora could be read');
    expect(result.answer).toContain(
      `${CORPUS_ID} (1 with unread pages, 2 with no extracted text)`,
    );
    expect(result.audit.corpus_readability).toEqual([{
      corpus_id: CORPUS_ID,
      partial_documents: 1,
      unread_documents: 2,
    }]);
    expect(JSON.stringify(result)).not.toContain('private-document-name');
  });

  test('never computes corpus-wide readability after evidence is selected', async () => {
    let consulted = 0;
    const result = await handler({
      provider: {
        async fetchLocalContent() {
          return {
            sensitivity: buildSourceSensitivity({
              trustTier: 'S0',
              trustDomain: 'public_safe',
            }),
            chunks: ['The retainer is EUR 4,000.'],
          };
        },
        async corpusReadability() {
          consulted += 1;
          return { partialDocuments: 3, unreadDocuments: 9 };
        },
      },
      hits: [hit()],
      analyst: (pack) => ({
        answer: 'The retainer is EUR 4,000.',
        citations: [{
          provenance: pack.candidates[0]!.provenance,
          claim: 'The retainer is EUR 4,000.',
        }],
        unanswered: [],
      }),
    }).answer({
      question: QUESTION,
      corpus_id: CORPUS_ID,
      include_secure_local: true,
    });

    expect(consulted).toBe(0);
    expect(result.answer).not.toContain('Not everything in the searched corpora');
  });

  test('keeps the answer available when readability reporting fails', async () => {
    const result = await handler({
      provider: {
        async fetchLocalContent() { return undefined; },
        async corpusReadability() { throw new Error('store unavailable'); },
      },
      hits: [],
    }).answer({
      question: QUESTION,
      corpus_id: CORPUS_ID,
      include_secure_local: true,
    });

    expect(result.answer).toContain('could not find');
    expect(result.audit.corpus_readability).toBeUndefined();
  });

  test('omits a zero-valued readability signal', async () => {
    const result = await handler({
      provider: {
        async fetchLocalContent() { return undefined; },
        async corpusReadability() {
          return { partialDocuments: 0, unreadDocuments: 0 };
        },
      },
      hits: [],
    }).answer({
      question: QUESTION,
      corpus_id: CORPUS_ID,
      include_secure_local: true,
    });

    expect(result.audit.corpus_readability).toBeUndefined();
    expect(result.answer).not.toContain('Not everything in the searched corpora');
  });
});

function handler(input: {
  provider: LocalContentProvider;
  hits: ReturnType<typeof hit>[];
  analyst?: (pack: EvidencePack) => AnalystResult;
}) {
  return createAnalystSourceIndexAnswerHandler({
    analyst: scriptedAnalyst(input.analyst ?? (() => ({
      answer: 'I could not find a retainer amount in the searched material.',
      citations: [],
      unanswered: [],
    }))),
    lanes: () => ({
      registry: buildSourceIndexCorpusRegistry([
        defineSourceIndexCorpus({
          corpusId: CORPUS_ID,
          family: 'file',
          trustDomain: 'public_safe',
        }),
      ]),
      adapters: {
        [CORPUS_ID]: () => ({
          hits: input.hits,
          latencyMs: 1,
          rawExposed: false,
        }),
      } as SourceIndexRouterAdapterMap,
      contentProviders: {
        [CORPUS_ID]: input.provider,
      } as LocalContentProviderMap,
    }),
  });
}

function hit() {
  const sourceItem = {
    family: 'file' as const,
    provider: 'dropbox',
    accountScope: 'personal',
    providerItemId: 'id:retainer-memo',
    providerFileId: 'id:retainer-memo',
    localItemId: 'personal:id:retainer-memo',
  };
  return {
    sourceItem,
    provenance: {
      sourceItem,
      citation: { title: 'Retainer Memo.txt' },
    },
    score: 1,
    rawExposed: false,
  };
}

function scriptedAnalyst(respond: (pack: EvidencePack) => AnalystResult): Analyst {
  return {
    async analyze(pack) {
      return respond(pack);
    },
  };
}
