import { describe, expect, test } from 'bun:test';
import type { AnalystModelRequest } from '../src/core/analyst.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import type {
  SourceIndexDocumentMatch,
  SourceIndexDocumentMatchRequest,
  SourceIndexDocumentMatchResponse,
} from '../src/core/source-index/router.ts';
import { defineSourceIndexCorpus } from '../src/core/source-index/corpus.ts';
import {
  prepareDocumentDigest,
  type DocumentDigestLane,
} from '../src/workers/source-index/document-digest.ts';

const corpus = defineSourceIndexCorpus({
  corpusId: 'secure_local.fixture.documents',
  family: 'file',
  trustDomain: 'secure_local',
  activationMode: 'lexical_only',
  description: 'fixture',
});

describe('source document digest orchestration', () => {
  test('live approval or account revocation invalidates unchanged stored rows during local extraction', async () => {
    let authorized = true;
    const lane = fixtureLane([reference('one')], { one: ['invented source data'] });
    const result = await prepareDocumentDigest({
      request: { question: 'Review', context: { allowedTrustDomains: ['secure_local'] } },
      lanesFactory: () => [lane],
      authorized: () => authorized,
      model: { name: 'built_in', async complete() { authorized = false; return { text: JSON.stringify({ fits: true, identifiers: [], facts: [{ observation: 'invented fact' }] }), modelId: 'built_in/fixture' }; } },
    });
    expect(result).toMatchObject({ kind: 'refused', reason: 'source_changed' });
    expect(result.current()).toBe(false);
  });
  test('collects every paged full document before the built-in reducer and preserves coverage', async () => {
    const documents = [reference('one'), reference('two'), reference('three')];
    const calls: AnalystModelRequest[] = [];
    const lane = fixtureLane(documents, {
      one: ['one-first ', 'one-second'],
      two: ['two-only'],
      three: ['three-only'],
    });
    const result = await prepareDocumentDigest({
      request: {
        question: 'Summarize every orchard record.',
        context: { allowedTrustDomains: ['secure_local'] },
      },
      lanesFactory: async () => [lane],
      authorized: () => true,
      model: {
        name: 'built_in',
        async complete(request) {
          calls.push(request);
          return {
            text: JSON.stringify({ fits: true, identifiers: [], facts: [{ observation: 'synthetic fact' }] }),
            modelId: 'built_in/fixture',
          };
        },
      },
    });

    expect(result.kind).toBe('digest');
    if (result.kind !== 'digest') throw new Error(result.reason);
    expect(result.refs.map((entry) => entry.document.sourceItem.providerItemId)).toEqual(['one', 'two', 'three']);
    expect(result.pack.coverage.searchedCorpora).toEqual([corpus.corpusId]);
    expect(result.pack.coverage.matchCounts).toEqual([{
      corpusId: corpus.corpusId,
      family: 'file',
      matchedItems: 3,
      contentMatchedItems: 3,
      atLeast: false,
      inEvidence: 3,
    }]);
    expect(result.pack.candidates).toHaveLength(3);
    expect(result.snapshot.candidates.map((candidate) => candidate.chunks.join('')))
      .toEqual(['one-first one-second', 'two-only', 'three-only']);
    expect(result.pack.candidates.every((candidate) => (
      candidate.trustTier === 'S4' && candidate.trustDomain === 'secure_local'
    ))).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.localOnly)).toBe(true);
    expect(result.current()).toBe(true);
  });

  test('fails closed when any reference changes after an awaited content window', async () => {
    const document = reference('moving');
    let current = true;
    let modelCalls = 0;
    const lane = fixtureLane([document], { moving: ['never sent'] }, {
      current: () => current,
      afterWindow: () => { current = false; },
    });
    const result = await prepareDocumentDigest({
      request: { question: 'Summarize moving record.', context: { allowedTrustDomains: ['secure_local'] } },
      lanesFactory: () => [lane],
      authorized: () => true,
      model: {
        name: 'built_in',
        async complete() {
          modelCalls += 1;
          return { text: '{}', modelId: 'built_in/fixture' };
        },
      },
    });
    expect(result).toMatchObject({ kind: 'refused', reason: 'source_changed' });
    expect(result.current()).toBe(false);
    expect(modelCalls).toBe(0);
  });

  test('does not claim completeness or read content when a lane cannot enumerate exactly', async () => {
    let reads = 0;
    const lane = fixtureLane([], {});
    lane.adapter.documentMatches = async () => ({
      status: 'unsupported', reason: 'document_match_limit_exceeded', rawExposed: false,
    });
    lane.contentProvider.fetchDocumentWindow = async () => {
      reads += 1;
      return undefined;
    };
    const result = await prepareDocumentDigest({
      request: { question: 'Summarize all.', context: { allowedTrustDomains: ['secure_local'] } },
      lanesFactory: () => [lane],
      authorized: () => true,
      model: { name: 'built_in', async complete() { throw new Error('must not run'); } },
    });
    expect(result).toMatchObject({ kind: 'refused', reason: 'document_match_limit_exceeded' });
    expect(reads).toBe(0);
  });
});

function reference(id: string): SourceIndexDocumentMatch {
  const sourceItem = {
    family: 'file' as const,
    provider: 'fixture',
    accountScope: 'personal',
    providerItemId: id,
    localItemId: `personal:${id}`,
  };
  return { sourceItem, provenance: { sourceItem }, revision: `revision-${id}` };
}

function fixtureLane(
  documents: readonly SourceIndexDocumentMatch[],
  windows: Readonly<Record<string, readonly string[]>>,
  hooks: { current?: () => boolean; afterWindow?: () => void } = {},
): DocumentDigestLane {
  const indexes = new Map<string, number>();
  const adapter = Object.assign(
    async () => ({ hits: [], latencyMs: 0, rawExposed: false as const }),
    {
      async documentMatches(request: SourceIndexDocumentMatchRequest): Promise<SourceIndexDocumentMatchResponse> {
        const offset = request.cursor ? Number(request.cursor) : 0;
        const page = documents.slice(offset, offset + 2);
        const next = offset + page.length;
        return {
          status: 'ok',
          documents: page,
          ...(next < documents.length ? { nextCursor: String(next) } : {}),
          done: next >= documents.length,
          rawExposed: false,
        };
      },
    },
  );
  return {
    corpus,
    adapter,
    contentProvider: {
      async fetchLocalContent() { return undefined; },
      documentCurrent() { return hooks.current?.() ?? true; },
      async fetchDocumentWindow(request) {
        const id = request.document.sourceItem.providerItemId;
        const chunks = windows[id] ?? [];
        const index = indexes.get(id) ?? 0;
        const text = chunks[index];
        if (text === undefined) return undefined;
        indexes.set(id, index + 1);
        hooks.afterWindow?.();
        return {
          content: {
            sensitivity: buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' }),
            chunks: [text],
          },
          ...(index + 1 < chunks.length ? { nextCursor: String(index + 1) } : {}),
          done: index + 1 >= chunks.length,
        };
      },
    },
  };
}
