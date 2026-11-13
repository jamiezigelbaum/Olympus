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
import { createReleaseManifestSink, runWithReleaseManifestSink } from '../src/core/release-manifest.ts';

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

  test('an unreadable match cited by name is in the release manifest, even when no leg read it', async () => {
    // Prompt fitting leaves the nameless-text file out of what the analyst reads.
    const handler = unreadableSecureHandler('allow', { localAnalystPromptByteBudget: 1, readableFirst: 4 });
    const sink = createReleaseManifestSink();
    const result = await runWithReleaseManifestSink(sink, () => handler.answer({
      question: 'Find the Lexidy engagement document.',
      corpus_id: SECURE,
      include_secure_local: true,
    }));
    expect(result.evidence).toHaveLength(1);
    const inputs = sink.manifests.flatMap((manifest) => manifest.inputs);
    expect(inputs).toContainEqual(expect.objectContaining({ corpusId: SECURE, providerItemId: 'id:lexidy-engagement', layer: 'names' }));
  });
});

function unreadableSecureHandler(secureDerivativeDefault: 'allow' | 'approval', options: { localAnalystPromptByteBudget?: number; readableFirst?: number } = {}) {
  const { readableFirst = 0, ...extra } = options;
  const identity = {
    family: 'file' as const,
    provider: 'dropbox',
    accountScope: 'personal',
    providerItemId: 'id:lexidy-engagement',
    providerFileId: 'id:lexidy-engagement',
    localItemId: 'personal:id:lexidy-engagement',
  };
  const readable = Array.from({ length: readableFirst }, (_, n) => ({ ...identity, providerItemId: `id:readable-${n}`, providerFileId: `id:readable-${n}`, localItemId: `personal:id:readable-${n}` }));
  return createAnalystSourceIndexAnswerHandler({
    analyst: scriptedAnalyst((pack) => ({
      answer: 'I could not answer because the matched document has no readable extracted text.',
      citations: [],
      unanswered: pack.coverage.extractionGaps,
    })),
    secureDerivativeDefault,
    ...extra,
    lanes: () => {
      const registry = buildSourceIndexCorpusRegistry([
        defineSourceIndexCorpus({ corpusId: SECURE, family: 'file', trustDomain: 'secure_local' }),
      ]);
      return {
        registry,
        adapters: {
          [SECURE]: () => ({
            hits: [...readable.map((item, n) => ({
              sourceItem: item,
              provenance: { sourceItem: item, citation: { title: `Readable ${n}.pdf` } },
              score: 2,
              rawExposed: false as const,
            })), {
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
            async fetchLocalContent(request: { provenance: { sourceItem: { providerItemId: string } } }) {
              if (request.provenance.sourceItem.providerItemId.startsWith('id:readable-')) {
                return {
                  sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
                  chunks: ['The engagement letter is with Lexidy. '.repeat(40)],
                };
              }
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
