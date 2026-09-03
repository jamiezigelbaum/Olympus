// A page whose every candidate is already settled must still move the scan.
// Terminal body-less/unavailable items keep qualifying as zero-chunk
// candidates forever, so a sweep that does not advance past them re-reads the
// same settled prefix on every later run and never reaches newer items.

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListPage,
} from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  repairConnectorStoreContent,
  type ConnectorStoreContentRepairReceipt,
} from '../src/workers/connector-store/content-repair.ts';
import type {
  SourceEmbeddingInput,
  SourceEmbeddingProvider,
  SourceEmbeddingTaskType,
} from '../src/workers/source-index/embeddings.ts';

const ACCOUNT = 'personal';
const CORPUS_ID = 'internal.fake.mail';

function item(id: string, content: RawItem['content'] = { kind: 'metadata_only' }): RawItem {
  return {
    identity: {
      family: 'email',
      provider: 'fake_mail',
      accountScope: ACCOUNT,
      providerItemId: id,
      providerThreadId: `thread-${id}`,
      localItemId: `${ACCOUNT}:${id}`,
      sourceVersion: 'v1',
    },
    mimeType: 'message/rfc822',
    content,
    metadata: Object.freeze({
      title: `Fixture ${id}`,
      authoredAt: '2026-08-01T08:00:00.000Z',
    }),
    fetchedAt: '2026-08-01T09:00:00.000Z',
  };
}

function connectorFor(
  ids: () => readonly string[],
  bodies: Readonly<Record<string, string>>,
  fetched: string[],
): SourceConnector {
  return {
    id: 'fake_mail_live',
    family: 'email',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items: ids().map((id) => item(id)), done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const id = localItemId.slice(localItemId.indexOf(':') + 1);
      fetched.push(id);
      const text = bodies[id];
      return item(id, text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text });
    },
    classify: () => buildSourceSensitivity({
      trustTier: 'S3',
      trustDomain: 'internal',
      cloudEmbeddingEligible: true,
    }),
  };
}

function embeddingProvider(): SourceEmbeddingProvider {
  return {
    provider: 'fixture-embedding',
    modelId: 'fixture-v1',
    dimension: 3,
    configHash: 'fixture-config',
    epochId: 'fixture-epoch',
    backend: 'cloud',
    async embed(
      inputs: SourceEmbeddingInput[],
      _options: { taskType: SourceEmbeddingTaskType },
    ): Promise<number[][]> {
      return inputs.map((input, index) => [input.text.length + 1, index + 1, 1]);
    },
  };
}

describe('connector-store content repair scan progress', () => {
  test('a fully settled page still advances so later items stay reachable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-content-repair-settled-'));
    const store = new LocalConnectorStore({
      dbPath: join(dir, 'store.sqlite'),
      corpusId: CORPUS_ID,
      family: 'email',
      trustDomain: 'internal',
    });
    const fetched: string[] = [];
    let listed: readonly string[] = ['bodyless-1', 'bodyless-2', 'bodyless-3'];
    const connector = connectorFor(() => listed, { arrived: 'new body reachable behind the wall' }, fetched);
    const statePath = join(dir, 'repair-state.sqlite');
    const repair = async (): Promise<ConnectorStoreContentRepairReceipt> => repairConnectorStoreContent({
      store,
      connector,
      statePath,
      limit: 2,
      dryRun: false,
      embeddingProvider: embeddingProvider(),
    });
    try {
      await store.syncFromConnector(connector, { fetchContent: false });

      // Settle the whole terminal residue: two pages of body-less items.
      expect((await repair()).counts).toMatchObject({ selected: 2, still_bodyless: 2 });
      expect((await repair()).counts).toMatchObject({ selected: 1, still_bodyless: 1 });

      listed = ['bodyless-1', 'bodyless-2', 'bodyless-3', 'arrived'];
      await store.syncFromConnector(connector, { fetchContent: false });

      // The scan restarts at the head, which is now an entirely settled page.
      // Each run must step one page forward until the new item is selected.
      const selections: number[] = [];
      for (let run = 0; run < 3; run += 1) selections.push((await repair()).counts.selected);

      expect(selections).toContain(1);
      expect(fetched).toContain('arrived');
      expect(store.searchItems('reachable', 10)[0]?.sourceItem.providerItemId).toBe('arrived');
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
