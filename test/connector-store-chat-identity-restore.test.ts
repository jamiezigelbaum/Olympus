// A chat repeats message ids across its conversations. An extraction that
// names its item's conversation must reach that item's row, not be refused
// as ambiguous because another conversation holds the same id (Sparta,
// 2026-11-04: 548 Telegram media items never got their text).

import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildSourceSensitivity } from '../src/core/source-index/types.ts';
import {
  LocalConnectorStore,
  connectorStoreChunkText,
  connectorStoreHashString,
  CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS,
} from '../src/workers/connector-store/index.ts';

const CORPUS_ID = 'secure_local.fakechat.messages';
const PROVIDER = 'fakechat';
const ACCOUNT = 'personal';
const MESSAGE_ID = '42';

function message(conversation: string | undefined): RawItem {
  return {
    identity: {
      family: 'chat',
      provider: PROVIDER,
      accountScope: ACCOUNT,
      providerItemId: MESSAGE_ID,
      ...(conversation ? { providerConversationId: conversation } : {}),
      localItemId: `${ACCOUNT}:${conversation ?? 'none'}:${MESSAGE_ID}`,
      sourceVersion: 'rev-1',
    },
    mimeType: 'image/jpeg',
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({ name: 'photo.jpg' }),
    fetchedAt: '2026-11-04T00:00:00.000Z',
  };
}

async function storeWith(items: RawItem[]): Promise<LocalConnectorStore> {
  const connector: SourceConnector = {
    id: 'chat-connector',
    family: 'chat',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items, done: true };
      })();
    },
    async fetchItem(): Promise<RawItem> {
      return items[0]!;
    },
    classificationSignals() {
      return {};
    },
  };
  const store = new LocalConnectorStore({
    dbPath: join(mkdtempSync(join(tmpdir(), 'chat-identity-')), 'store.sqlite'),
    corpusId: CORPUS_ID,
    family: 'chat',
    trustDomain: 'secure_local',
  });
  await store.syncFromConnector(connector, { fetchContent: false });
  return store;
}

function restore(store: LocalConnectorStore, item: RawItem, text: string) {
  const identity = item.identity;
  return store.restoreItemRepresentations({
    syncConnectorId: 'extraction-factory-pass',
    ownerConnectorId: 'chat-connector',
    ownershipKind: 'observed',
    classify: () => buildSourceSensitivity({ trustTier: 'S2', trustDomain: 'secure_local' }),
    items: [{
      item: { ...item, content: { kind: 'text', text } },
      expectation: {
        sourceItem: identity,
        sourceVersion: identity.sourceVersion!,
        contentHash: connectorStoreHashString(text),
        chunkContentHashes: connectorStoreChunkText(text, CONNECTOR_STORE_DEFAULT_MAX_CHUNK_CHARS).map(connectorStoreHashString),
      },
    }],
  });
}

describe('restoring text to a chat item whose message id another conversation repeats', () => {
  test('an identity naming its conversation reaches its own row', async () => {
    const inA = message('chat-a');
    const store = await storeWith([inA, message('chat-b')]);
    try {
      const result = restore(store, inA, 'text read off the photo');
      expect(result.counts.itemsRestored).toBe(1);
      expect(store.localContent(inA.identity.localItemId)!.chunks).toEqual(['text read off the photo']);
      expect(store.localContent(message('chat-b').identity.localItemId)?.chunks ?? []).toEqual([]);
    } finally {
      store.close();
    }
  });

  test('an identity with no conversation is still refused when the id is held twice', async () => {
    const unscoped = message(undefined);
    const store = await storeWith([unscoped, message('chat-b')]);
    try {
      expect(() => restore(store, unscoped, 'text')).toThrow('matches multiple store rows');
    } finally {
      store.close();
    }
  });
});
