import { describe, expect, test } from 'bun:test';
import {
  buildSourceIndexCorpusRegistry,
  defineSourceIndexCorpus,
} from '../src/core/source-index/corpus.ts';
import {
  runSourceIndexEval,
  type SourceIndexEvalCase,
  type SourceIndexEvalSearchResponse,
} from '../src/core/source-index/eval.ts';
import {
  routeSourceIndexSearch,
  type SourceIndexCorpusSearchResponse,
} from '../src/core/source-index/router.ts';
import type { SourceFamily, SourceItemIdentity } from '../src/core/source-index/types.ts';

describe('source-index router eval proof', () => {
  test('scores a two-domain fixture through the policy-aware router', async () => {
    const secureEmail = defineSourceIndexCorpus({
      corpusId: 'secure_local.email.private',
      family: 'email',
      trustDomain: 'secure_local',
    });
    const internalDrive = defineSourceIndexCorpus({
      corpusId: 'internal.drive.docs',
      family: 'file',
      trustDomain: 'internal',
      activationMode: 'hybrid_primary',
      storageProfileInput: {
        cloudEmbeddingApproved: true,
        cloudQueryApproved: true,
      },
    });
    const registry = buildSourceIndexCorpusRegistry([secureEmail, internalDrive]);
    const evalCases: SourceIndexEvalCase[] = [
      {
        id: 'secure_email_visit',
        family: 'email',
        query: 'school visit',
        k: 2,
        expected: {
          sourceItem: {
            provider: 'gmail',
            providerItemId: 'gmail-message-visit',
            localItemId: 'gmail-message-visit',
          },
          provenance: {
            providerIds: { gmail_message_id: 'gmail-message-visit' },
            localIds: { corpus_id: 'secure_local.email.private' },
            citationRequired: true,
          },
        },
      },
      {
        id: 'internal_drive_policy',
        family: 'file',
        query: 'policy note',
        k: 2,
        expected: {
          sourceItem: {
            provider: 'gog-drive',
            providerItemId: 'drive-doc-policy',
            localItemId: 'drive-doc-policy',
          },
          provenance: {
            providerIds: { drive_file_id: 'drive-doc-policy' },
            localIds: { corpus_id: 'internal.drive.docs' },
            citationRequired: true,
          },
        },
      },
    ];

    const summary = await runSourceIndexEval({
      cases: evalCases,
      search: async (evalCase): Promise<SourceIndexEvalSearchResponse> => {
        const routed = await routeSourceIndexSearch({
          registry,
          adapters: {
            'secure_local.email.private': async (): Promise<SourceIndexCorpusSearchResponse> => ({
              hits: [hit('email', 'gmail', 'gmail-message-visit', 'gmail_message_id', 'secure_local.email.private')],
              latencyMs: 2,
              rawExposed: false,
            }),
            'internal.drive.docs': async (): Promise<SourceIndexCorpusSearchResponse> => ({
              hits: [hit('file', 'gog-drive', 'drive-doc-policy', 'drive_file_id', 'internal.drive.docs')],
              latencyMs: 2,
              rawExposed: false,
            }),
          },
          request: {
            query: evalCase.query,
            maxResults: evalCase.maxResults ?? evalCase.k ?? 5,
            families: [evalCase.family],
            context: {
              allowedTrustDomains: ['secure_local', 'internal'],
              allowCloudQueries: true,
            },
          },
        });

        return {
          items: routed.hits.map((routedHit) => ({
            sourceItem: routedHit.sourceItem,
            ...(routedHit.provenance ? { provenance: routedHit.provenance } : {}),
            ...(routedHit.laneAudits ? { laneAudits: routedHit.laneAudits } : {}),
            rawExposed: false,
          })),
          latencyMs: routed.latencyMs,
          laneAudits: routed.laneAudits,
          rawExposed: false,
        };
      },
    });

    expect(summary.recallAtK).toBe(1);
    expect(summary.topResultCorrectRate).toBe(1);
    expect(summary.provenanceCorrectRate).toBe(1);
    expect(JSON.stringify(summary)).not.toContain('school visit body');
    expect(JSON.stringify(summary)).not.toContain('policy note body');
  });
});

function hit(
  family: SourceFamily,
  provider: string,
  providerItemId: string,
  providerIdKey: string,
  corpusId: string,
) {
  const sourceItem: SourceItemIdentity = {
    family,
    provider,
    accountScope: 'personal',
    providerItemId,
    localItemId: providerItemId,
  };
  return {
    sourceItem,
    provenance: {
      sourceItem,
      providerIds: { [providerIdKey]: providerItemId },
      localIds: { corpus_id: corpusId },
      citation: { title: `Safe citation for ${providerItemId}` },
    },
    rawExposed: false as const,
  };
}
