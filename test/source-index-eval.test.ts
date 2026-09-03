import { describe, expect, test } from 'bun:test';
import {
  runSourceIndexEval,
  type SourceIndexEvalCase,
  type SourceIndexEvalSearchResponse,
} from '../src/core/source-index/eval.ts';

describe('source-index eval harness', () => {
  test('runs a non-email fixture with source identity and provenance metrics', async () => {
    const cases: SourceIndexEvalCase[] = [{
      id: 'file_policy_note',
      family: 'file',
      query: 'policy note',
      filters: { folder: '/docs' },
      k: 2,
      expected: {
        sourceItem: {
          provider: 'local-files',
          providerFileId: 'sha256:policy',
          localItemId: 'file-1',
        },
        provenance: {
          providerIds: { file_id: 'sha256:policy' },
          localIds: { path_id: 'local-path-1' },
          syncRunId: 'sync-files-1',
          citationRequired: true,
        },
      },
    }];

    const summary = await runSourceIndexEval({
      cases,
      search: async (): Promise<SourceIndexEvalSearchResponse> => ({
        items: [{
          sourceItem: {
            family: 'file',
            provider: 'local-files',
            accountScope: 'personal',
            providerItemId: 'sha256:policy',
            providerFileId: 'sha256:policy',
            localItemId: 'file-1',
          },
          provenance: {
            sourceItem: {
              family: 'file',
              provider: 'local-files',
              accountScope: 'personal',
              providerItemId: 'sha256:policy',
              providerFileId: 'sha256:policy',
              localItemId: 'file-1',
            },
            providerIds: { file_id: 'sha256:policy' },
            localIds: { path_id: 'local-path-1' },
            syncRunId: 'sync-files-1',
            citation: { title: 'Policy note', uri: 'file:///safe/path' },
          },
          rawExposed: false,
        }],
        latencyMs: 12.4,
        laneAudits: [{
          laneName: 'metadata',
          laneType: 'metadata',
          candidateCount: 1,
          returnedCount: 1,
          backend: 'fixture',
          localOnly: true,
          rawExposed: false,
        }],
        rawExposed: false,
      }),
    });

    expect(summary).toEqual({
      caseCount: 1,
      recallAtK: 1,
      topResultCorrectRate: 1,
      provenanceCorrectRate: 1,
      rawExposed: false,
      avgLatencyMs: 12,
      results: [{
        caseId: 'file_policy_note',
        family: 'file',
        foundExpected: true,
        topResultCorrect: true,
        provenanceCorrect: true,
        itemCount: 1,
        latencyMs: 12,
        rawExposed: false,
        laneAudits: [{
          laneName: 'metadata',
          laneType: 'metadata',
          candidateCount: 1,
          returnedCount: 1,
          backend: 'fixture',
          localOnly: true,
          rawExposed: false,
        }],
      }],
    });
    expect(JSON.stringify(summary)).not.toContain('policy note body');
    expect(JSON.stringify(summary)).not.toContain('snippet');
  });

  test('rejects adapters that expose raw source fields', async () => {
    await expect(runSourceIndexEval({
      cases: [{
        id: 'unsafe_file',
        family: 'file',
        query: 'unsafe',
        expected: { sourceItem: { providerItemId: 'file-1' } },
      }],
      search: async () => ({
        items: [{
          sourceItem: {
            family: 'file',
            provider: 'local-files',
            accountScope: 'personal',
            providerItemId: 'file-1',
            localItemId: 'file-1',
          },
          rawExposed: false,
          snippet: 'unsafe text',
        }],
        latencyMs: 1,
        rawExposed: false,
      } as unknown as SourceIndexEvalSearchResponse),
    })).rejects.toThrow('forbidden raw field');
  });

  test('rejects normalized raw and credential-like fields in eval output', async () => {
    const forbiddenKeys = [
      'sourceText',
      'source_text',
      'rawSourceText',
      'approvedScopeKey',
      'accessToken',
    ];
    for (const key of forbiddenKeys) {
      await expect(runSourceIndexEval({
        cases: [{
          id: `unsafe_${key}`,
          family: 'file',
          query: 'unsafe',
          expected: { sourceItem: { providerItemId: 'file-1' } },
        }],
        search: async () => ({
          items: [{
            sourceItem: {
              family: 'file',
              provider: 'local-files',
              accountScope: 'personal',
              providerItemId: 'file-1',
              localItemId: 'file-1',
            },
            rawExposed: false,
            [key]: 'unsafe value',
          }],
          latencyMs: 1,
          rawExposed: false,
        } as unknown as SourceIndexEvalSearchResponse),
      })).rejects.toThrow(`forbidden raw field "items.0.${key}"`);
    }
  });

  test('scores recall against the requested top-k window', async () => {
    const summary = await runSourceIndexEval({
      cases: [{
        id: 'top_k_boundary',
        family: 'file',
        query: 'target',
        k: 2,
        expected: {
          sourceItem: {
            providerItemId: 'target-file',
          },
        },
      }],
      search: async () => ({
        items: ['first-file', 'second-file', 'target-file'].map((providerItemId) => ({
          sourceItem: {
            family: 'file' as const,
            provider: 'local-files',
            accountScope: 'personal',
            providerItemId,
            localItemId: providerItemId,
          },
          provenance: {
            sourceItem: {
              family: 'file' as const,
              provider: 'local-files',
              accountScope: 'personal',
              providerItemId,
              localItemId: providerItemId,
            },
          },
          rawExposed: false as const,
        })),
        latencyMs: 1,
        rawExposed: false,
      }),
    });

    expect(summary.recallAtK).toBe(0);
    expect(summary.results[0]?.itemCount).toBe(2);
  });
});
