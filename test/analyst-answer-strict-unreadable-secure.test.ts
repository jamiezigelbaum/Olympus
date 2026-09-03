// Strict posture and the unreadable-match append path. A matched secure_local
// file with no extractable text never reaches the release gate as a fact, so
// its name and locator have to be withheld by the append path itself.

import { describe, expect, test } from 'bun:test';
import type { Analyst, AnalystResult, EvidencePack } from '../src/core/contracts.ts';
import type { LocalContentProviderMap } from '../src/core/evidence-pack.ts';
import {
  buildSourceIndexCorpusRegistry,
  defineSourceIndexCorpus,
} from '../src/core/source-index/corpus.ts';
import type { SourceIndexRouterAdapterMap } from '../src/core/source-index/router.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { createAnalystSourceIndexAnswerHandler } from '../src/workers/source-index/analyst-answer.ts';

const SECURE = 'secure_local.dropbox.files';
const TITLE = 'PT COMPANY | Pat Example.pdf';
const URI = 'https://example.invalid/files/pt-company.pdf';

describe('strict posture unreadable secure_local matches', () => {
  test('withholds the file title and locator while keeping the count-only gap', async () => {
    const handler = unreadableSecureHandler('approval');

    const result = await handler.answer({
      question: 'Find the Lexidy engagement document.',
      corpus_id: SECURE,
      include_secure_local: true,
    });

    expect(result.evidence).toEqual([]);
    expect(result.answer).toContain('1 source item could not be read or extracted in this pass.');
    expect(result.policy.secure_local_content_exposed).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TITLE);
    expect(serialized).not.toContain(URI);
  });

  test('the usability-forward default still surfaces the unreadable match by name', async () => {
    const handler = unreadableSecureHandler('allow');

    const result = await handler.answer({
      question: 'Find the Lexidy engagement document.',
      corpus_id: SECURE,
      include_secure_local: true,
    });

    expect(result.evidence).toEqual([expect.objectContaining({
      corpus_id: SECURE,
      trust_domain: 'secure_local',
      title: TITLE,
      uri: URI,
    })]);
  });
});

function unreadableSecureHandler(secureDerivativeDefault: 'allow' | 'approval') {
  const identity = {
    family: 'file' as const,
    provider: 'dropbox',
    accountScope: 'personal',
    providerItemId: 'id:lexidy-engagement',
    providerFileId: 'id:lexidy-engagement',
    localItemId: 'personal:id:lexidy-engagement',
  };
  return createAnalystSourceIndexAnswerHandler({
    analyst: scriptedAnalyst((pack) => ({
      answer: 'I could not answer because the matched document has no readable extracted text.',
      citations: [],
      unanswered: pack.coverage.extractionGaps,
    })),
    secureDerivativeDefault,
    lanes: () => {
      const registry = buildSourceIndexCorpusRegistry([
        defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
      ]);
      return {
        registry,
        adapters: {
          [SECURE]: () => ({
            hits: [{
              sourceItem: identity,
              provenance: {
                sourceItem: identity,
                citation: { title: TITLE, uri: URI },
              },
              score: 1,
              rawExposed: false,
            }],
            latencyMs: 1,
            rawExposed: false,
          }),
        } as SourceIndexRouterAdapterMap,
        contentProviders: {
          [SECURE]: {
            async fetchLocalContent() {
              return {
                sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
                chunks: [],
                coverageGaps: ['content extraction failed.'],
              };
            },
          },
        } as LocalContentProviderMap,
      };
    },
  });
}

function scriptedAnalyst(respond: (pack: EvidencePack) => AnalystResult): Analyst {
  return {
    async analyze(pack) {
      return respond(pack);
    },
  };
}
