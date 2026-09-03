import { describe, expect, test } from 'bun:test';
import type { SensitivityMap } from '../src/core/sensitivity-map.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import {
  GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
  GMAIL_SECURE_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
  createGmailConnectorStoreSyncHandler,
  createGoogleDriveConnectorStoreSyncHandler,
  type GmailApiClient,
  type GoogleDriveApiClient,
} from '../src/workers/google-connectors/index.ts';
import type {
  SourceEmbeddingInput,
  SourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';

const SENSITIVITY_MAP: SensitivityMap = {
  schemaVersion: 1,
  userFacingTiers: {
    public: { targetTrustTier: 'S0', targetTrustDomain: 'public_safe' },
    private: { targetTrustTier: 'S3', targetTrustDomain: 'internal' },
    secure: { targetTrustTier: 'S4', targetTrustDomain: 'secure_local' },
    secrets: { targetTrustTier: 'S5', targetTrustDomain: 'secure_local' },
  },
  categories: [
    {
      id: 'therapy',
      label: 'Therapy',
      targetTierName: 'secure',
      targetTrustTier: 'S4',
      targetTrustDomain: 'secure_local',
      examples: ['therapy notes'],
      notes: '',
      match: {
        keywords: ['therapy'],
        senderPatterns: [],
        pathPatterns: [],
      },
    },
    {
      id: 'password-manager-export',
      label: 'Password Manager Export',
      targetTierName: 'secrets',
      targetTrustTier: 'S5',
      targetTrustDomain: 'secure_local',
      examples: ['password-manager-export.csv'],
      notes: '',
      match: {
        keywords: [],
        senderPatterns: [],
        pathPatterns: ['password-manager-export'],
      },
    },
  ],
};

describe('Google connector-store ingestion', () => {
  test('syncs Gmail messages into internal and secure lanes according to per-item classification', async () => {
    const internalStore = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: GMAIL_INTERNAL_CONNECTOR_CORPUS_ID,
      family: 'email',
      trustDomain: 'internal',
    });
    const secureStore = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: GMAIL_SECURE_CONNECTOR_CORPUS_ID,
      family: 'email',
      trustDomain: 'secure_local',
    });
    const client = fakeGmailClient();
    const sync = createGmailConnectorStoreSyncHandler({
      internalStore,
      secureStore,
      account: 'personal',
      sensitivityMap: SENSITIVITY_MAP,
      apiClient: client,
    });

    const result = await sync.sync({ max_messages: 10 });

    // Both stores are filled from ONE provider traversal: two connectors used
    // to list and re-get the same messages independently, doubling every Gmail
    // request for identical pages.
    expect(client.listCalls).toBe(1);
    expect(client.getCalls).toEqual(['msg-plain', 'msg-therapy']);

    expect(result.internal.itemsSeen).toBe(2);
    expect(result.internal.itemsIndexed).toBe(1);
    expect(result.internal.itemsRejected).toBe(1);
    expect(result.secure.itemsSeen).toBe(2);
    expect(result.secure.itemsIndexed).toBe(1);
    expect(result.secure.itemsRejected).toBe(1);

    const plain = await localContent(internalStore, 'personal:msg-plain');
    const secure = await localContent(secureStore, 'personal:msg-therapy');
    expect(plain?.sensitivity).toMatchObject({ trustTier: 'S3', trustDomain: 'internal' });
    expect(secure?.sensitivity).toMatchObject({ trustTier: 'S4', trustDomain: 'secure_local' });

    const internalHits = await searchStore(internalStore, 'Apollo');
    const secureHits = await searchStore(secureStore, 'therapy');
    expect(internalHits.map((hit) => hit.sourceItem.providerItemId)).toEqual(['msg-plain']);
    expect(secureHits.map((hit) => hit.sourceItem.providerItemId)).toEqual(['msg-therapy']);

    const cloud = fakeEmbeddingProvider('cloud');
    await internalStore.embedChunks({ provider: cloud });
    await expect(secureStore.embedChunks({ provider: cloud })).rejects.toThrow('local/private');
    const embeddedText = cloud.embedCalls.flat().map((input) => `${input.title ?? ''}\n${input.text}`).join('\n');
    expect(embeddedText).toContain('Apollo launch plan');
    expect(embeddedText).not.toContain('therapy');
    internalStore.close();
    secureStore.close();
  });

  test('syncs Drive files into internal and secure lanes according to per-item classification', async () => {
    const internalStore = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
      family: 'file',
      trustDomain: 'internal',
    });
    const secureStore = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
    });
    const client = fakeDriveClient();
    const sync = createGoogleDriveConnectorStoreSyncHandler({
      internalStore,
      secureStore,
      account: 'personal',
      sensitivityMap: SENSITIVITY_MAP,
      apiClient: client,
    });

    const result = await sync.sync({ max_files: 10, max_content_files: 10 });

    // Both stores are filled from ONE provider traversal: two connectors used
    // to list the same pages independently, doubling every Drive request.
    expect(client.listCalls).toBe(1);
    expect(client.contentCalls).toEqual(['file-plain', 'file-therapy', 'file-passwords']);

    expect(result.internal.itemsSeen).toBe(3);
    expect(result.internal.itemsIndexed).toBe(1);
    expect(result.internal.itemsRejected).toBe(2);
    expect(result.secure.itemsSeen).toBe(3);
    expect(result.secure.itemsIndexed).toBe(1);
    expect(result.secure.itemsRejected).toBe(1);
    expect(result.secure.itemsTombstoned).toBe(1);
    expect(result.secure.gaps).toContainEqual(expect.stringContaining('secrets_tier_excluded'));

    const plain = await localContent(internalStore, 'personal:file-plain');
    const secure = await localContent(secureStore, 'personal:file-therapy');
    expect(plain?.sensitivity).toMatchObject({ trustTier: 'S3', trustDomain: 'internal' });
    expect(secure?.sensitivity).toMatchObject({ trustTier: 'S4', trustDomain: 'secure_local' });

    const internalHits = await searchStore(internalStore, 'Apollo');
    const secureHits = await searchStore(secureStore, 'therapy');
    expect(internalHits.map((hit) => hit.sourceItem.providerItemId)).toEqual(['file-plain']);
    expect(secureHits.map((hit) => hit.sourceItem.providerItemId)).toEqual(['file-therapy']);
    expect(secureStore.searchItems('password', 10)).toEqual([]);

    const cloud = fakeEmbeddingProvider('cloud');
    await internalStore.embedChunks({ provider: cloud });
    await expect(secureStore.embedChunks({ provider: cloud })).rejects.toThrow('local/private');
    const embeddedText = cloud.embedCalls.flat().map((input) => `${input.title ?? ''}\n${input.text}`).join('\n');
    expect(embeddedText).toContain('Apollo roadmap');
    expect(embeddedText).not.toContain('Therapy worksheet');
    expect(embeddedText).not.toContain('password');
    internalStore.close();
    secureStore.close();
  });
});

function fakeGmailClient(): GmailApiClient & { listCalls: number; getCalls: string[] } {
  const client = {
    listCalls: 0,
    getCalls: [] as string[],
    async listMessages() {
      client.listCalls += 1;
      return {
        messages: [
          { id: 'msg-plain', threadId: 'thread-plain' },
          { id: 'msg-therapy', threadId: 'thread-therapy' },
        ],
      };
    },
    async getMessage(id: string) {
      client.getCalls.push(id);
      if (id === 'msg-plain') {
        return gmailMessage({
          id,
          threadId: 'thread-plain',
          subject: 'Apollo launch plan',
          from: 'Alex <alex@example.com>',
          body: 'Apollo launch plan moved to Thursday.',
          labels: ['CATEGORY_UPDATES'],
        });
      }
      return gmailMessage({
        id,
        threadId: 'thread-therapy',
        subject: 'Therapy appointment',
        from: 'Clinic <care@example.com>',
        body: 'Therapy appointment notes for next week.',
        labels: ['INBOX'],
      });
    },
  };
  return client;
}

type CountingDriveApiClient = GoogleDriveApiClient & {
  listCalls: number;
  contentCalls: string[];
};

function fakeDriveClient(): CountingDriveApiClient {
  const text = new Map([
    ['file-plain', 'Apollo roadmap notes for the connector-store launch.'],
    ['file-therapy', 'Therapy worksheet and private care notes.'],
    ['file-passwords', 'account,username,password\nexample,alice,secret'],
  ]);
  return {
    listCalls: 0,
    contentCalls: [],
    async listFiles() {
      this.listCalls += 1;
      return {
        files: [
          {
            id: 'file-plain',
            name: 'apollo-roadmap.txt',
            mimeType: 'text/plain',
            modifiedTime: '2026-07-07T12:00:00.000Z',
            size: '52',
            webViewLink: 'https://drive.google.com/file/d/file-plain/view',
          },
          {
            id: 'file-therapy',
            name: 'therapy-notes.txt',
            mimeType: 'text/plain',
            modifiedTime: '2026-07-07T12:01:00.000Z',
            size: '43',
            webViewLink: 'https://drive.google.com/file/d/file-therapy/view',
          },
          {
            id: 'file-passwords',
            name: 'password-manager-export.csv',
            mimeType: 'text/csv',
            modifiedTime: '2026-07-07T12:02:00.000Z',
            size: '46',
            webViewLink: 'https://drive.google.com/file/d/file-passwords/view',
            parents: ['Exports'],
          },
        ],
      };
    },
    async exportGoogleDocText(id: string) {
      this.contentCalls.push(id);
      return text.get(id) ?? '';
    },
    async downloadTextFile(id: string) {
      this.contentCalls.push(id);
      return text.get(id) ?? '';
    },
    // The connector's own sync never reaches the byte lane; it exists so this
    // fake is a complete client rather than one that compiles by omission.
    async downloadFileBytes(id: string) {
      this.contentCalls.push(id);
      const bytes = new TextEncoder().encode(text.get(id) ?? '');
      return { bytes, sizeBytes: bytes.byteLength };
    },
  };
}

function gmailMessage(input: {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  body: string;
  labels: string[];
}) {
  return {
    id: input.id,
    threadId: input.threadId,
    labelIds: input.labels,
    snippet: input.body,
    historyId: `history-${input.id}`,
    internalDate: String(Date.parse('2026-07-07T12:00:00.000Z')),
    payload: {
      mimeType: 'text/plain',
      headers: [
        { name: 'Subject', value: input.subject },
        { name: 'From', value: input.from },
        { name: 'Date', value: 'Tue, 07 Jul 2026 12:00:00 +0000' },
      ],
      body: { data: base64Url(input.body), size: input.body.length },
    },
  };
}

async function searchStore(store: LocalConnectorStore, query: string) {
  const adapter = createConnectorStoreCorpusAdapter({ store });
  const result = await adapter({
    query,
    maxResults: 10,
    corpus: defineConnectorCorpus({
      corpusId: store.corpusId,
      family: store.family,
      trustDomain: store.trustDomain,
    }),
    context: { allowedTrustDomains: [store.trustDomain], allowedCorpusIds: [store.corpusId] },
  });
  return result.hits;
}

async function localContent(store: LocalConnectorStore, localItemId: string) {
  const provider = createConnectorStoreContentProvider({ store });
  return provider.fetchLocalContent({
    provenance: {
      sourceItem: {
        family: store.family,
        provider: providerFromCorpus(store.corpusId),
        accountScope: 'personal',
        providerItemId: localItemId.slice('personal:'.length),
        localItemId,
      },
      citation: { title: localItemId },
    },
    trustDomain: store.trustDomain,
  });
}

function providerFromCorpus(corpusId: string): string {
  if (corpusId.includes('email')) return 'gmail';
  return 'google_drive';
}

function base64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type FakeEmbeddingProvider = SourceEmbeddingProvider & { embedCalls: SourceEmbeddingInput[][] };

function fakeEmbeddingProvider(backend: 'local' | 'cloud'): FakeEmbeddingProvider {
  const embedCalls: SourceEmbeddingInput[][] = [];
  return {
    provider: 'fake-google-ingest-test',
    modelId: 'fake-google-ingest-model',
    dimension: 2,
    configHash: 'fake-google-ingest-test-config',
    epochId: `${backend}:fake-google-ingest-model`,
    backend,
    embedCalls,
    async embed(inputs: SourceEmbeddingInput[]): Promise<number[][]> {
      embedCalls.push(inputs);
      return inputs.map(() => [1, 0]);
    },
  };
}
