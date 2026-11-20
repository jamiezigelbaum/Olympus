import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { SourceScopeApprovalRequiredError } from '../src/core/operation-error.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import type { SourceEmbeddingInput, SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const ACCOUNT = 'personal';
const MODEL_ID = 'read-authority-model';

function item(): RawItem {
  return {
    identity: {
      family: 'file', provider: 'fixture', accountScope: ACCOUNT,
      providerItemId: 'one', localItemId: `${ACCOUNT}:one`, sourceVersion: 'v1',
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: 'retrospective roadmap decision' },
    metadata: Object.freeze({ name: 'one.txt' }),
    fetchedAt: '2026-09-01T00:00:00.000Z',
  };
}

function connector(): SourceConnector {
  return {
    id: 'fixture', family: 'file', async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* () { yield { items: [item()], done: true }; })();
    },
    async fetchItem() { return item(); },
    classificationSignals() { return {}; },
  };
}

function provider(configHash: string, onQuery?: () => Promise<void>): SourceEmbeddingProvider {
  return {
    provider: 'fixture', modelId: MODEL_ID, dimension: 3, configHash,
    epochId: `epoch:${configHash}`, backend: 'local',
    async embed(inputs: SourceEmbeddingInput[], options?: { taskType?: string }) {
      if (options?.taskType === 'RETRIEVAL_QUERY' && onQuery) await onQuery();
      return inputs.map(() => [1, 0, 0]);
    },
  };
}

async function store(): Promise<LocalConnectorStore> {
  const result = new LocalConnectorStore({
    dbPath: ':memory:', corpusId: 'secure_local.fixture.files', family: 'file', trustDomain: 'secure_local',
  });
  await result.syncFromConnector(connector(), { fetchContent: true });
  await result.embedChunks({ provider: provider('one') });
  return result;
}

describe('connector-store vector authority fence', () => {
  test.each(['ordinary sweep', 'maintenance journal'])('a revoked rebind probe leaves old vectors current through the %s', async (path) => {
    const fixture = await store();
    const before = fixture.exportItemCopy(item().identity)?.vectors;
    expect(before).toHaveLength(1);
    let approved = true;
    let probes = 0;
    const replacement = {
      ...provider('two'),
      assertBindingCurrent() {
        if (!approved) throw new SourceScopeApprovalRequiredError('The scope was revoked.');
      },
      async embed(inputs: SourceEmbeddingInput[]) {
        probes++;
        expect(inputs.map(({ text }) => text)).toEqual(['olympus connector store embedding rebind probe']);
        approved = false;
        return [[1, 0, 0]];
      },
    };
    try {
      await expect(fixture.embedChunks({
        provider: replacement,
        ...(path === 'maintenance journal' ? { journalId: 'fixture-embedding-maintenance', journalLeaseGeneration: 1 } : {}),
      })).rejects.toBeInstanceOf(SourceScopeApprovalRequiredError);
      expect(probes).toBe(1);
      expect(fixture.exportItemCopy(item().identity)?.vectors).toEqual(before);
      expect((await fixture.vectorSearchLane('retrospective', provider('one'), 5)).rows).toHaveLength(1);
    } finally {
      fixture.close();
    }
  });

  test('refuses a rebind that lands on another provider identity during query embedding', async () => {
    const fixture = await store();
    const lane = await fixture.vectorSearchLane('retrospective', provider('one', async () => {
      await fixture.embedChunks({ provider: provider('two') });
    }), 5);
    expect(lane.rows).toEqual([]);
    expect(lane.skippedReason).toBe('embedding_authority_provider_mismatch');
    fixture.close();
  });

  test('refuses an away-and-back epoch move during the query await', async () => {
    const fixture = await store();
    const lane = await fixture.vectorSearchLane('retrospective', provider('one', async () => {
      await fixture.embedChunks({ provider: provider('two') });
      await fixture.embedChunks({ provider: provider('one') });
    }), 5);
    expect(lane.rows).toEqual([]);
    expect(lane.skippedReason).toBe('embedding_authority_changed_during_query');
    fixture.close();
  });
});
