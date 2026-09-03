// Shared connector ingest spine tests (src/workers/connector-store/).
//
// Everything runs against an in-memory fake SourceConnector: the point of the
// spine is that ANY Contract 1 connector becomes a searchable, analyst-served
// corpus with zero new storage code, so the tests exercise the full loop —
// sync (cursor resume, tombstones, trust-domain rejection), the membrane-safe
// routed search adapter, the local content provider, and finally
// buildEvidencePack -> createAnalyst over the store.

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAnalyst, type AnalystModel } from '../src/core/analyst.ts';
import type { RawItem, SourceConnector, SourceConnectorListOptions, SourceConnectorListPage } from '../src/core/contracts.ts';
import { buildEvidencePack } from '../src/core/evidence-pack.ts';
import { SourceReactionValidationError } from '../src/core/source-index/reactions.ts';
import type { SensitivityMap } from '../src/core/sensitivity-map.ts';
import { createSourceExclusionMatcher } from '../src/core/source-ingestion-exclusions.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import {
  routeSourceIndexSearch,
  type SourceIndexCorpusSearchRequest,
  type SourceIndexSearchContext,
} from '../src/core/source-index/router.ts';
import {
  buildSourceSensitivity,
  type SourceFamily,
  type SourceTrustDomain,
  type SourceTrustTier,
} from '../src/core/source-index/types.ts';
import {
  LocalConnectorStore,
  connectorStoreCurrentEmbeddingModelId,
  connectorStoreCurrentEmbeddingRows,
  connectorStoreQualificationFingerprint,
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
  syncAndEmbedFromConnector,
  verifyConnectorStoreCorpusIntegrity,
} from '../src/workers/connector-store/index.ts';
import type {
  SourceEmbeddingInput,
  SourceEmbeddingProvider,
} from '../src/workers/source-index/embeddings.ts';

const CORPUS_ID = 'secure_local.fake.files';
const ACCOUNT = 'personal';

// --- In-memory fake SourceConnector -----------------------------------------

interface FakeItemSpec {
  id: string;
  name?: string;
  /** Content served by fetchItem as utf8 text bytes. */
  text?: string;
  /** Content present directly on the listed item (content kind "text"). */
  inlineText?: string;
  /** Raw bytes served by fetchItem (binary fixtures). */
  bytes?: { mimeType: string; bytes: Uint8Array };
  fetchError?: string;
  deleted?: boolean;
  trustDomain?: SourceTrustDomain;
  trustTier?: SourceTrustTier;
  locatorUri?: string;
}

interface FakeConnectorCounters {
  authenticateCalls: number;
  pagesServed: number;
  fetchedItemIds: string[];
}

interface FakeConnectorOptions {
  accountScope?: string;
  provider?: string;
  connectorId?: string;
}

function createFakeConnector(
  pages: readonly (readonly FakeItemSpec[])[],
  counters?: FakeConnectorCounters,
  options: FakeConnectorOptions = {},
): SourceConnector {
  const accountScope = options.accountScope ?? ACCOUNT;
  const provider = options.provider ?? 'fake';
  const connectorId = options.connectorId ?? 'fake';
  const specsById = new Map<string, FakeItemSpec>();
  for (const page of pages) {
    for (const spec of page) specsById.set(spec.id, spec);
  }

  const listedRawItem = (spec: FakeItemSpec): RawItem => ({
    identity: {
      family: 'file',
      provider,
      accountScope,
      providerItemId: spec.id,
      providerFileId: spec.id,
      localItemId: `${accountScope}:${spec.id}`,
      sourceVersion: 'rev-1',
    },
    mimeType: 'text/markdown',
    content: spec.inlineText !== undefined ? { kind: 'text', text: spec.inlineText } : { kind: 'metadata_only' },
    metadata: Object.freeze({
      deleted: spec.deleted === true,
      ...(spec.name ? { name: spec.name } : {}),
      ...(spec.locatorUri ? { locatorUri: spec.locatorUri, pathDisplay: spec.locatorUri } : {}),
      clientModifiedAt: '2026-06-01T10:00:00.000Z',
      serverModifiedAt: '2026-06-02T10:00:00.000Z',
    }),
    fetchedAt: '2026-06-10T00:00:00.000Z',
  });

  return {
    id: connectorId,
    family: 'file',
    async authenticate(): Promise<void> {
      if (counters) counters.authenticateCalls += 1;
    },
    listItems(options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      const startPage = options?.cursor ? Number.parseInt(options.cursor.slice('cursor-'.length), 10) : 0;
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        for (let index = startPage; index < pages.length; index += 1) {
          if (counters) counters.pagesServed += 1;
          const done = index === pages.length - 1;
          yield {
            items: pages[index]!.map(listedRawItem),
            ...(done ? {} : { nextCursor: `cursor-${index + 1}` }),
            done,
          };
        }
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const prefix = `${accountScope}:`;
      if (!localItemId.startsWith(prefix)) throw new Error(`fake connector cannot fetch ${localItemId}`);
      const providerItemId = localItemId.slice(prefix.length);
      if (counters) counters.fetchedItemIds.push(providerItemId);
      const spec = specsById.get(providerItemId);
      if (!spec) throw new Error(`fake connector has no item ${providerItemId}`);
      if (spec.fetchError) throw new Error(spec.fetchError);
      const listed = listedRawItem(spec);
      const content = spec.bytes
        ? { kind: 'bytes' as const, mimeType: spec.bytes.mimeType, bytes: spec.bytes.bytes }
        : spec.text !== undefined
          ? { kind: 'bytes' as const, mimeType: 'text/plain; charset=utf-8', bytes: new TextEncoder().encode(spec.text) }
          : { kind: 'metadata_only' as const };
      return { ...listed, content };
    },
    classify(item: RawItem) {
      const spec = specsById.get(item.identity.providerItemId);
      return buildSourceSensitivity({
        trustTier: spec?.trustTier ?? 'S4',
        trustDomain: spec?.trustDomain ?? 'secure_local',
      });
    },
  };
}

/** Commits one whole page, then loses the provider mid-traversal. */
function failsAfterOnePage(complete: SourceConnector): SourceConnector {
  return {
    ...complete,
    listItems(options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        for await (const page of complete.listItems(options)) {
          yield page;
          throw new Error('provider went away');
        }
      })();
    },
  };
}

/**
 * A traversal the connector's own ceiling cut short: the last page is NOT done
 * and still carries a resume cursor. This is what every Google connector emits
 * when its bound is reached with a provider page token still in hand.
 */
function truncatedConnector(specs: readonly FakeItemSpec[]): SourceConnector {
  const complete = createFakeConnector([specs]);
  return {
    ...complete,
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        for await (const page of complete.listItems()) {
          yield { ...page, nextCursor: 'cursor-truncated', done: false };
        }
      })();
    },
  };
}

interface GoogleFixtureItem {
  family: Extract<SourceFamily, 'email' | 'file'>;
  provider: 'gmail' | 'google_drive';
  id: string;
  title: string;
  text: string;
  metadata: Readonly<Record<string, unknown>>;
}

function googleFixtureItem(input: GoogleFixtureItem): RawItem {
  const identity = {
    family: input.family,
    provider: input.provider,
    accountScope: ACCOUNT,
    providerItemId: input.id,
    ...(input.family === 'email' ? { providerThreadId: `thread-${input.id}` } : { providerFileId: input.id }),
    localItemId: `${ACCOUNT}:${input.id}`,
    sourceVersion: 'fixture-v1',
  };
  return {
    identity,
    mimeType: 'text/plain',
    content: { kind: 'text', text: input.text },
    metadata: Object.freeze({
      title: input.title,
      ...input.metadata,
    }),
    fetchedAt: '2026-07-07T12:00:00.000Z',
  };
}

test('an email item embeds its envelope, not only its subject', async () => {
  // The legacy email index embedded Subject/From/To/Date. The shared recipe
  // carried sender context only for chat items, so mail from a named person
  // would have semantically degraded below the legacy baseline - caught
  // 2026-07-29 minutes before the first full Gmail embed run.
  const store = new LocalConnectorStore({
    dbPath: ':memory:',
    corpusId: 'secure_local.email.private',
    family: 'email',
    trustDomain: 'secure_local',
  });
  const item = googleFixtureItem({
    family: 'email',
    provider: 'gmail',
    id: 'envelope-1',
    title: 'Lease renewal',
    text: 'The lease renews in September.',
    metadata: { from: 'Sarah Example <sarah@example.com>', to: 'pat@owner-example.test' },
  });
  await store.syncFromConnector(
    createGoogleFixtureConnector('gmail-envelope', 'email', [item]),
    { fetchContent: true },
  );
  // The envelope lives in search_text, so terms that appear nowhere in the
  // body or title are findable - and therefore embedded.
  expect(store.searchItems('sarah@example.com', 10)[0]?.sourceItem.providerItemId).toBe('envelope-1');
  expect(store.searchItems('owner-example', 10)[0]?.sourceItem.providerItemId).toBe('envelope-1');
  store.close();
});

function createGoogleFixtureConnector(
  connectorId: string,
  family: Extract<SourceFamily, 'email' | 'file'>,
  fetchedItems: readonly RawItem[],
): SourceConnector {
  const itemsByLocalId = new Map(fetchedItems.map((item) => [item.identity.localItemId, item]));
  return {
    id: connectorId,
    family,
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield {
          items: fetchedItems.map((item) => ({
            ...item,
            content: { kind: 'metadata_only' as const },
          })),
          done: true,
        };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const found = itemsByLocalId.get(localItemId);
      if (!found) throw new Error(`missing fixture item ${localItemId}`);
      return found;
    },
    classify() {
      // Deliberately too broad: the test proves the shared sync classifier,
      // not the connector default, controls item routing when configured.
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}

function newStore(dbPath = ':memory:', now?: () => Date): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath,
    corpusId: CORPUS_ID,
    family: 'file',
    trustDomain: 'secure_local',
    ...(now ? { now } : {}),
  });
}

function newChatStore(dbPath = ':memory:'): LocalConnectorStore {
  return new LocalConnectorStore({
    dbPath,
    corpusId: 'secure_local.fake.chat',
    family: 'chat',
    trustDomain: 'secure_local',
  });
}

function createChatConnector(items: readonly RawItem[]): SourceConnector {
  return {
    id: 'fake-chat',
    family: 'chat',
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        yield { items, done: true };
      })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const found = items.find((item) => item.identity.localItemId === localItemId);
      if (!found) throw new Error(`missing chat item ${localItemId}`);
      return found;
    },
    classify() {
      return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
    },
  };
}

function chatItem(input: {
  id: string;
  conversationId: string;
  chat: string;
  sender: string;
  senderId?: string;
  senderIsOwner?: boolean;
  sentAt?: string;
  text: string;
  /**
   * Deliberately unknown: this is exactly what a connector puts on
   * RawItem.metadata, so malformed aggregates have to be expressible here.
   * Omitting the field entirely is the "this emit says nothing about
   * reactions" case.
   */
  reactions?: unknown;
}): RawItem {
  return {
    identity: {
      family: 'chat',
      provider: 'whatsapp',
      accountScope: ACCOUNT,
      providerItemId: input.id,
      providerConversationId: input.conversationId,
      localItemId: `${ACCOUNT}:${input.id}`,
      sourceVersion: '2026-07-09T09:00:00Z',
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text: input.text },
    metadata: Object.freeze({
      chat: input.chat,
      sender: input.sender,
      ...(input.senderId ? { senderId: input.senderId } : {}),
      ...(input.senderIsOwner !== undefined ? { senderIsOwner: input.senderIsOwner } : {}),
      ...('reactions' in input ? { reactions: input.reactions } : {}),
      sentAt: input.sentAt ?? '2026-07-09T09:00:00Z',
    }),
    fetchedAt: '2026-07-09T09:00:01Z',
  };
}

function corpusRequest(store: LocalConnectorStore, query: string): SourceIndexCorpusSearchRequest {
  return {
    query,
    maxResults: 10,
    corpus: defineConnectorCorpus({ corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain }),
    context: { allowedTrustDomains: [store.trustDomain] },
  };
}

// Same recursive posture as the router membrane: routed output must never
// carry a raw-content key, whatever the nesting.
const FORBIDDEN_KEYS = new Set([
  'body', 'bodies', 'content', 'contents', 'message', 'messages',
  'raw', 'raw_packet', 'rawPacket', 'raw_source', 'rawSource',
  'sanitized_text', 'sanitizedText', 'snippet', 'snippets', 'text',
]);

function assertNoForbiddenKeys(value: unknown, path: string[] = []): void {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoForbiddenKeys(item, [...path, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`forbidden raw field "${[...path, key].join('.')}" in routed output`);
    }
    assertNoForbiddenKeys(child, [...path, key]);
  }
}

const RETRO: FakeItemSpec = {
  id: 'id:retro',
  name: '2026-04-22_retro-notes.md',
  text: 'The retro decided to adopt LanceDB for unified search across corpora.',
  locatorUri: '/Approved/2026-04-22_retro-notes.md',
};
const GROCERIES: FakeItemSpec = {
  id: 'id:groceries',
  name: 'groceries.txt',
  text: 'milk and eggs and bread',
  locatorUri: '/Approved/groceries.txt',
};
const ROADMAP: FakeItemSpec = {
  id: 'id:roadmap',
  name: 'roadmap.md',
  inlineText: 'Q3 roadmap: ship the connector spine milestone.',
  locatorUri: '/Approved/roadmap.md',
};

const GOOGLE_ITEM_SENSITIVITY_MAP: SensitivityMap = {
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
      examples: ['therapy appointment notes'],
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

describe('LocalConnectorStore sync', () => {
  test('asserts the secure_local storage profile (local_private/sqlite/fts5)', () => {
    const store = newStore();
    expect(store.storageProfile.placement).toBe('local_private');
    expect(store.storageProfile.storageEngine).toBe('sqlite');
    expect(store.storageProfile.lexicalBackend).toBe('sqlite_fts5');
    expect(store.storageProfile.cloudQueryEligible).toBe(false);
    store.close();
  });

  test('rejects a connector whose family does not match the store', async () => {
    const store = newStore();
    const connector = { ...createFakeConnector([[RETRO]]), family: 'email' as const };
    await expect(store.syncFromConnector(connector)).rejects.toThrow('family');
    store.close();
  });

  test('keeps the HTTP event loop schedulable during large metadata pages', async () => {
    const specs = Array.from({ length: 33 }, (_, index): FakeItemSpec => ({
      id: `id:yield-${index + 1}`,
      inlineText: `bounded item ${index + 1}`,
    }));
    const base = createFakeConnector([specs]);
    let timerFired = false;
    let timerObservedByItem33 = false;
    const connector: SourceConnector = {
      ...base,
      classify(item) {
        if (item.identity.providerItemId === 'id:yield-1') {
          setTimeout(() => { timerFired = true; }, 0);
        }
        if (item.identity.providerItemId === 'id:yield-33') {
          timerObservedByItem33 = timerFired;
        }
        return base.classify(item);
      },
    };
    const store = newStore();
    const summary = await store.syncFromConnector(connector);
    expect(summary.itemsSeen).toBe(33);
    expect(timerObservedByItem33).toBe(true);
    store.close();
  });

  test('maintains and uses the normalized locator identity index on live writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connector-store-locator-'));
    const dbPath = join(dir, 'store.sqlite');
    const store = newStore(dbPath);
    expect(store.locatorIdentityIndexStatus()).toEqual({
      state: 'ready',
      cursorItemPk: 0,
      indexedItems: 0,
    });

    await store.syncFromConnector(createFakeConnector([[RETRO]]));
    expect(store.locatorIdentityIndexStatus().indexedItems).toBe(1);
    expect(store.activeIdentityForLocator({
      provider: 'fake',
      accountScope: ACCOUNT,
      locatorUri: '/APPROVED/2026-04-22_RETRO-NOTES.MD',
    })?.providerItemId).toBe(RETRO.id);

    const moved = { ...RETRO, locatorUri: '/Moved/retro-notes.md' };
    await store.syncFromConnector(createFakeConnector([[moved]]));
    expect(store.activeIdentityForLocator({
      provider: 'fake', accountScope: ACCOUNT, locatorUri: RETRO.locatorUri!,
    })).toBeUndefined();
    expect(store.activeIdentityForLocator({
      provider: 'fake', accountScope: ACCOUNT, locatorUri: '/MOVED/RETRO-NOTES.MD',
    })?.providerItemId).toBe(RETRO.id);

    await store.syncFromConnector(createFakeConnector([[{ ...moved, deleted: true }]]));
    expect(store.locatorIdentityIndexStatus().indexedItems).toBe(0);
    expect(store.activeIdentityForLocator({
      provider: 'fake', accountScope: ACCOUNT, locatorUri: moved.locatorUri!,
    })).toBeUndefined();
    store.close();

    const db = new Database(dbPath, { readonly: true });
    try {
      const plan = db.query(`
        EXPLAIN QUERY PLAN
        SELECT item_pk FROM item_locator_identities
        WHERE provider = ? AND account_scope = ?
          AND normalized_conversation = '' AND normalized_locator = LOWER(?)
        LIMIT 2
      `).all('fake', ACCOUNT, moved.locatorUri!) as Array<{ detail: string }>;
      expect(plan.some((row) => row.detail.includes('idx_connector_store_locator_identity'))).toBe(true);
    } finally {
      db.close();
    }
  });

  test('persists items, chunks, and a cursor checkpoint; resumes from the cursor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connector-store-test-'));
    const dbPath = join(dir, 'store.sqlite');
    const counters: FakeConnectorCounters = { authenticateCalls: 0, pagesServed: 0, fetchedItemIds: [] };
    const pages = [[RETRO, GROCERIES], [ROADMAP]] as const;

    const store = newStore(dbPath);
    const first = await store.syncFromConnector(createFakeConnector(pages, counters), {
      maxItems: 2,
      fetchContent: true,
    });

    expect(counters.authenticateCalls).toBe(1);
    expect(first.status).toBe('completed');
    expect(first.itemsSeen).toBe(2);
    expect(first.itemsIndexed).toBe(2);
    expect(first.chunksIndexed).toBe(2);
    expect(first.cursor).toBe('cursor-1');
    expect(first.gaps).toEqual([]);
    // The maxItems bound stopped the sync at the page boundary: page two was
    // never pulled from the connector.
    expect(counters.pagesServed).toBe(1);
    // metadata_only listings were fetched for content; inline-text never needs a fetch.
    expect(counters.fetchedItemIds.sort()).toEqual(['id:groceries', 'id:retro']);

    // The recorded sync run carries the checkpoint.
    const run = store.syncRun(first.syncRunId);
    expect(run?.status).toBe('completed');
    expect(run?.cursor).toBe('cursor-1');
    expect(run?.itemsSeen).toBe(2);

    // Resume from the cursor: only page two is consumed, nothing duplicates.
    const second = await store.syncFromConnector(createFakeConnector(pages, counters), {
      cursor: first.cursor!,
      fetchContent: true,
    });
    expect(second.itemsSeen).toBe(1);
    expect(second.itemsIndexed).toBe(1);
    expect(second.chunksIndexed).toBe(1);
    expect(second.cursor).toBeUndefined();
    expect(store.syncRun(second.syncRunId)?.cursor).toBeUndefined();
    expect(store.status().lastSyncRun?.cursor).toBeUndefined();
    store.close();

    // Persistence: a fresh store over the same db file still has everything.
    const reopened = newStore(dbPath);
    expect(reopened.status().counts.items).toBe(3);
    expect(reopened.status().counts.syncRuns).toBe(2);
    expect(reopened.searchItems('roadmap', 10)[0]?.sourceItem.providerItemId).toBe('id:roadmap');
    expect(reopened.searchItems('lancedb', 10)[0]?.sourceItem.providerItemId).toBe('id:retro');
    reopened.close();
  });

  test('re-syncing the same items upserts instead of duplicating', async () => {
    const store = newStore();
    const pages = [[RETRO, GROCERIES]] as const;
    await store.syncFromConnector(createFakeConnector(pages), { fetchContent: true });
    await store.syncFromConnector(createFakeConnector(pages), { fetchContent: true });
    expect(store.status().counts.items).toBe(2);
    expect(store.searchItems('lancedb', 10)).toHaveLength(1);
    store.close();
  });

  test('chat metadata becomes title and private search context without changing evidence chunks', async () => {
    const store = newChatStore();
    const item = chatItem({
      id: 'chat-1',
      conversationId: '98765430001111@lid',
      chat: 'Jane Doe',
      sender: 'Grace Hopper',
      text: 'please bring the school form tomorrow',
    });

    await store.syncFromConnector(createChatConnector([item]), { fetchContent: true });

    const chatHit = store.searchItems('Jane Doe', 10)[0];
    expect(chatHit?.sourceItem.providerItemId).toBe('chat-1');
    expect(chatHit?.title).toBe('Jane Doe');
    expect(store.searchItems('Grace Hopper', 10)[0]?.sourceItem.providerItemId).toBe('chat-1');
    expect(store.localContent(`${ACCOUNT}:chat-1`)?.chunks).toEqual(['please bring the school form tomorrow']);
    store.close();
  });

  test('composes conversation, sender, and authored filters in SQL and separates DM author from peer', async () => {
    const store = newChatStore();
    const items = [
      chatItem({
        id: 'owner-dm',
        conversationId: 'peer-dor',
        chat: 'Dor',
        sender: 'Sam',
        senderId: 'owner-1',
        senderIsOwner: true,
        sentAt: '2026-07-09T09:00:00.000Z',
        text: 'shared launch phrase from the owner',
      }),
      chatItem({
        id: 'peer-dm',
        conversationId: 'peer-dor',
        chat: 'Dor',
        sender: 'Dor',
        senderId: 'peer-1',
        senderIsOwner: false,
        sentAt: '2026-07-10T09:00:00.000Z',
        text: 'shared launch phrase from the peer',
      }),
      chatItem({
        id: 'other-chat',
        conversationId: 'group-other',
        chat: 'Other Group',
        sender: 'Sam',
        senderId: 'owner-1',
        senderIsOwner: true,
        sentAt: '2026-07-11T09:00:00.000Z',
        text: 'shared launch phrase elsewhere',
      }),
    ];
    await store.syncFromConnector(createChatConnector(items), { fetchContent: true });

    const composed = store.searchItems('shared launch phrase', 10, undefined, {
      conversationId: 'peer-dor',
      senderId: 'owner-1',
      authoredAfter: '2026-07-09T00:00:00Z',
      authoredBefore: '2026-07-09T23:59:59Z',
    });
    expect(composed.map((row) => row.sourceItem.providerItemId)).toEqual(['owner-dm']);
    expect(composed[0]).toMatchObject({
      conversationLabel: 'Dor',
      authorLabel: 'Sam',
      senderId: 'owner-1',
      senderIsOwner: true,
      authoredAt: '2026-07-09T09:00:00.000Z',
    });
    expect(store.searchItems('shared launch phrase', 10, undefined, {
      conversationId: 'peer-dor',
      // Equivalent instant expressed with a non-UTC offset; SQL time
      // comparison must not rely on lexicographic timestamp ordering.
      authoredAfter: '2026-07-09T10:00:00+01:00',
      authoredBefore: '2026-07-09T10:00:00+01:00',
    }).map((row) => row.sourceItem.providerItemId)).toEqual(['owner-dm']);
    expect(store.searchItems('shared launch phrase', 10, undefined, {
      conversationId: 'peer-dor',
      searchTextExactLines: ['Dor', 'Sam'],
    }).map((row) => row.sourceItem.providerItemId)).toEqual(['owner-dm']);

    const adapter = createConnectorStoreCorpusAdapter({
      store,
      filters: { conversationId: 'peer-dor', senderLabel: 'sam' },
    });
    const response = await adapter(corpusRequest(store, 'shared launch phrase'));
    expect(response.hits).toHaveLength(1);
    expect(response.hits[0]?.provenance?.citation).toMatchObject({
      title: 'Dor',
      sourceLabel: 'whatsapp',
      conversationLabel: 'Dor',
      authorLabel: 'Sam',
      authoredAt: '2026-07-09T09:00:00.000Z',
    });

    // Bound parameters and escaped LIKE wildcards make injection-shaped input
    // an ordinary label literal, never SQL or wildcard syntax.
    expect(store.searchItems('shared', 10, undefined, {
      senderLabel: "Sam%' OR 1=1 --",
    })).toEqual([]);
    expect(store.searchItems('shared', 10, undefined, { senderLabel: '%' })).toEqual([]);
    expect(() => store.searchItems('shared', 10, undefined, {
      senderId: 'owner-1',
      senderLabel: 'Sam',
    })).toThrow('senderId or senderLabel');
    expect(() => store.searchItems('shared', 10, undefined, {
      authoredAfter: '2026-07-12T00:00:00Z',
      authoredBefore: '2026-07-11T00:00:00Z',
    })).toThrow('must not be later');
    expect(() => store.searchItems('shared', 10, undefined, {
      authoredAfter: 'last Thursday',
    })).toThrow('ISO timestamp');
    expect(() => store.searchItems('shared', 10, undefined, {
      searchTextExactLines: ['Dor\nSam'],
    })).toThrow('safe string');
    store.close();
  });

  test('aggregates chat senders exactly within indexed rows and reports attribution gaps without source text', async () => {
    const store = newChatStore();
    await store.syncFromConnector(createChatConnector([
      chatItem({
        id: 'ada-1', conversationId: 'group-1', chat: 'Builders', sender: 'Ada',
        senderId: 'sender-ada', sentAt: '2026-07-01T09:00:00.000Z', text: 'PRIVATE ADA FIRST',
      }),
      chatItem({
        id: 'ada-2', conversationId: 'group-1', chat: 'Builders', sender: 'Ada Lovelace',
        senderId: 'sender-ada', sentAt: '2026-07-03T09:00:00.000Z', text: 'PRIVATE ADA SECOND',
      }),
      chatItem({
        id: 'grace-1', conversationId: 'group-1', chat: 'Builders', sender: 'Grace Hopper',
        senderId: 'sender-grace', sentAt: '2026-07-02T09:00:00.000Z', text: 'PRIVATE GRACE',
      }),
      chatItem({
        id: 'unknown-1', conversationId: 'group-1', chat: 'Builders', sender: 'Unattributed',
        sentAt: '2026-07-04T09:00:00.000Z', text: 'PRIVATE UNKNOWN',
      }),
      chatItem({
        id: 'elsewhere', conversationId: 'group-2', chat: 'Elsewhere', sender: 'Elsewhere',
        senderId: 'sender-elsewhere', sentAt: '2026-07-05T09:00:00.000Z', text: 'PRIVATE ELSEWHERE',
      }),
    ]), { fetchContent: true });

    const result = store.senderAggregation({
      accountScope: ACCOUNT,
      conversationId: 'group-1',
      provider: 'whatsapp',
      maxSenders: 1,
    });

    expect(result).toMatchObject({
      population: 'indexed_active_items',
      ranking: 'approximate',
      senders: [{
        senderId: 'sender-ada',
        displayLabel: 'Ada Lovelace',
        messageCount: 2,
        authoredAtFirst: '2026-07-01T09:00:00.000Z',
        authoredAtLast: '2026-07-03T09:00:00.000Z',
      }],
      coverage: {
        providerTraversal: 'not_asserted',
        senderAttribution: 'partial',
        dateCoverage: 'complete',
        indexedItems: 4,
        attributedItems: 3,
        unattributedItems: 1,
        distinctSenders: 2,
        omittedSenders: 1,
      },
      policy: { readOnly: true, rawSourceExposed: false, sourceTextReturned: false },
    });
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(() => store.senderAggregation({
      accountScope: ACCOUNT,
      conversationId: 'group-1',
      maxSenders: 101,
    })).toThrow('maxSenders must be an integer from 1 to 100');
    store.close();
  });

  test('sender repair is resumable and idempotent without rewriting content', async () => {
    const store = newChatStore();
    const item = chatItem({
      id: 'repair-me',
      conversationId: 'peer-dor',
      chat: 'Dor',
      sender: 'Wrong legacy label',
      text: 'content remains intact',
    });
    await store.syncFromConnector(createChatConnector([item]), { fetchContent: true });
    const records = [{
      sourceItem: item.identity,
      senderId: 'owner-1',
      senderLabel: 'Sam',
      senderIsOwner: true,
    }];

    const first = store.repairSenderMetadata({ records, maxItems: 1 });
    expect(first.counts).toEqual({
      itemsScanned: 1,
      itemsRepaired: 1,
      itemsUnchanged: 0,
      itemsMissing: 0,
    });
    expect(store.localContent(item.identity.localItemId)?.chunks).toEqual(['content remains intact']);
    expect(store.searchItems('content', 10, undefined, { senderId: 'owner-1' })[0]).toMatchObject({
      authorLabel: 'Sam',
      senderIsOwner: true,
    });

    const second = store.repairSenderMetadata({ records });
    expect(second.counts).toEqual({
      itemsScanned: 1,
      itemsRepaired: 0,
      itemsUnchanged: 1,
      itemsMissing: 0,
    });
    expect(second.inputDigestSha256).toBe(first.inputDigestSha256);

    const partial = store.repairSenderMetadata({
      records: [{ sourceItem: item.identity, senderLabel: 'Sam Owner' }],
    });
    expect(partial.counts.itemsRepaired).toBe(1);
    expect(store.searchItems('content', 10, undefined, { senderId: 'owner-1' })[0]).toMatchObject({
      authorLabel: 'Sam Owner',
      senderIsOwner: true,
    });
    store.close();
  });

  test('content fetch gaps include a safe error kind for isolated misses', async () => {
    const store = newStore();
    const summary = await store.syncFromConnector(createFakeConnector([[
      { id: 'id:missing-content', name: 'missing.md', fetchError: 'backend unavailable' },
      ROADMAP,
    ]]), { fetchContent: true });

    expect(summary.status).toBe('completed');
    expect(summary.itemsIndexed).toBe(2);
    expect(summary.chunksIndexed).toBe(1);
    expect(summary.gaps).toHaveLength(1);
    expect(summary.gaps[0]).toContain('content_fetch_failed');
    expect(summary.gaps[0]).toContain('error_kind=connector_fetch_failed');
    expect(summary.gaps[0]).not.toContain('backend unavailable');
    store.close();
  });

  test('one transient fetch failure cannot demote an accepted secure item from a baseline-internal lane', async () => {
    const store = newStore();
    const secureItem: FakeItemSpec = {
      id: 'id:secure-fetch-failure',
      name: 'secure-fetch-failure.md',
      text: 'Your bank statement for July is attached.',
      locatorUri: '/Approved/secure-fetch-failure.md',
    };
    const classification = {
      baselineTrustTier: 'S3' as const,
      baselineTrustDomain: 'internal' as const,
    };

    const accepted = await store.syncFromConnector(
      createFakeConnector([[secureItem]]),
      { fetchContent: true, classification },
    );
    expect(accepted).toMatchObject({ itemsIndexed: 1, itemsRejected: 0, itemsDemoted: 0 });
    await store.embedChunks({ provider: createFakeEmbeddingProvider() });
    expect(store.status().counts).toMatchObject({
      items: 1,
      tombstonedItems: 0,
      chunks: 1,
      embeddedChunks: 1,
    });

    const failed = await store.syncFromConnector(
      createFakeConnector([[{ ...secureItem, fetchError: 'transient provider failure' }]]),
      { fetchContent: true, classification },
    );

    expect(failed).toMatchObject({
      itemsDemoted: 0,
      itemsRejected: 1,
      itemsTombstoned: 0,
    });
    expect(failed.gaps).toContainEqual(expect.stringContaining('content_fetch_failed'));
    expect(store.status().counts).toMatchObject({
      items: 1,
      tombstonedItems: 0,
      chunks: 1,
      embeddedChunks: 1,
    });
    expect(store.searchItems('statement', 10)).toHaveLength(1);
    store.close();
  });

  test('a new metadata-only rule cannot demote an accepted secure item from a baseline-internal lane', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'olympus-connector-metadata-only-demotion-'));
    const dbPath = join(directory, 'connector.sqlite');
    const secureItem: FakeItemSpec = {
      id: 'id:secure-metadata-rule',
      name: 'secure-metadata-rule.md',
      text: 'Your bank statement for July is attached.',
      locatorUri: '/Approved/secure-metadata-rule.md',
    };
    const classification = {
      baselineTrustTier: 'S3' as const,
      baselineTrustDomain: 'internal' as const,
    };
    const initial = newStore(dbPath);
    await initial.syncFromConnector(
      createFakeConnector([[secureItem]]),
      { fetchContent: true, classification },
    );
    await initial.embedChunks({ provider: createFakeEmbeddingProvider() });
    initial.close();

    const governed = new LocalConnectorStore({
      dbPath,
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
      exclusions: createSourceExclusionMatcher({
        schemaVersion: 1,
        rules: [{
          id: 'metadata-only-approved',
          mode: 'metadata_only',
          sources: ['fake'],
          path_prefixes: ['/approved'],
          folder_ids: [],
          reason: 'synthetic regression rule',
        }],
      }, 'fake'),
    });
    const receipt = await governed.syncFromConnector(
      createFakeConnector([[secureItem]]),
      { fetchContent: true, classification },
    );

    expect(receipt).toMatchObject({
      itemsMetadataOnly: 1,
      itemsDemoted: 0,
      itemsRejected: 1,
      itemsTombstoned: 0,
    });
    expect(governed.status().counts).toMatchObject({
      items: 1,
      tombstonedItems: 0,
      chunks: 1,
      embeddedChunks: 1,
    });
    expect(governed.searchItems('statement', 10)).toHaveLength(1);
    governed.close();
  });

  test('an empty provider body cannot demote an accepted secure item from a baseline-internal lane', async () => {
    const store = newStore();
    const secureItem: FakeItemSpec = {
      id: 'id:secure-empty-body',
      name: 'secure-empty-body.md',
      text: 'Your bank statement for July is attached.',
      locatorUri: '/Approved/secure-empty-body.md',
    };
    const classification = {
      baselineTrustTier: 'S3' as const,
      baselineTrustDomain: 'internal' as const,
    };

    const accepted = await store.syncFromConnector(
      createFakeConnector([[secureItem]]),
      { fetchContent: true, classification },
    );
    expect(accepted).toMatchObject({ itemsIndexed: 1, itemsRejected: 0, itemsDemoted: 0 });
    await store.embedChunks({ provider: createFakeEmbeddingProvider() });

    // The provider answers 200 with an empty body: no throw, no fetch-failed
    // gap, content kind is not metadata_only. The shared classifier computes
    // its baseline from zero text, which is strictly less input than the
    // body this store accepted and chunked — so it can reject the
    // observation but must not delete the stored copy.
    const emptied = await store.syncFromConnector(
      createFakeConnector([[{ ...secureItem, text: '' }]]),
      { fetchContent: true, classification },
    );

    expect(emptied).toMatchObject({
      itemsDemoted: 0,
      itemsRejected: 1,
      itemsTombstoned: 0,
    });
    expect(emptied.gaps).toContainEqual(
      expect.stringContaining('demotion refused on degraded input'),
    );

    // A whitespace-only body is the same degraded input wearing non-empty
    // bytes: it decodes and trims to nothing, so it must refuse the same way.
    const blank = await store.syncFromConnector(
      createFakeConnector([[{ ...secureItem, text: '  \n\t  ' }]]),
      { fetchContent: true, classification },
    );
    expect(blank).toMatchObject({
      itemsDemoted: 0,
      itemsRejected: 1,
      itemsTombstoned: 0,
    });

    expect(store.status().counts).toMatchObject({
      items: 1,
      tombstonedItems: 0,
      chunks: 1,
      embeddedChunks: 1,
    });
    expect(store.searchItems('statement', 10)).toHaveLength(1);
    store.close();
  });

  test('consecutive content fetch failures fail the sync run', async () => {
    const store = newStore();
    await expect(store.syncFromConnector(createFakeConnector([[
      { id: 'id:missing-1', name: 'missing-1.md', fetchError: 'offline one' },
      { id: 'id:missing-2', name: 'missing-2.md', fetchError: 'offline two' },
      { id: 'id:missing-3', name: 'missing-3.md', fetchError: 'offline three' },
    ]]), { fetchContent: true })).rejects.toThrow('connector_fetch_failed');

    const lastRun = store.status().lastSyncRun;
    expect(lastRun?.status).toBe('failed');
    expect(lastRun?.itemsSeen).toBe(3);
    expect(store.status().counts.items).toBe(3);
    expect(store.status().counts.chunks).toBe(0);
    store.close();
  });

  test('tombstones drop items from search and content without resurrecting them', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES]]), { fetchContent: true });
    expect(store.searchItems('lancedb', 10)).toHaveLength(1);

    const tombstoned = await store.syncFromConnector(createFakeConnector([[{ ...RETRO, deleted: true }]]));
    expect(tombstoned.itemsTombstoned).toBe(1);
    expect(tombstoned.itemsIndexed).toBe(0);

    expect(store.searchItems('lancedb', 10)).toHaveLength(0);
    expect(store.localContent(`${ACCOUNT}:${RETRO.id}`)).toBeUndefined();
    expect(store.status().counts.tombstonedItems).toBe(1);
    expect(store.status().counts.items).toBe(1);
    store.close();
  });

  test('full-snapshot reconciliation tombstones omitted live items', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES]]), { fetchContent: true });

    const incremental = await store.syncFromConnector(createFakeConnector([[RETRO]]), { fetchContent: true });
    expect(incremental.itemsTombstoned).toBe(0);
    expect(store.searchItems('groceries', 10)).toHaveLength(1);

    const reconciled = await store.syncFromConnector(createFakeConnector([[RETRO]]), {
      fetchContent: true,
      reconcileFullSnapshot: true,
    });
    expect(reconciled.itemsTombstoned).toBe(1);
    expect(store.searchItems('groceries', 10)).toHaveLength(0);
    expect(store.localContent(`${ACCOUNT}:${GROCERIES.id}`)).toBeUndefined();
    expect(store.status().counts.items).toBe(1);
    expect(store.status().counts.tombstonedItems).toBe(1);
    store.close();
  });

  test('partial-window reconciliation preserves omitted items and reports typed coverage', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES]]), { fetchContent: true });

    const reconciled = await store.syncFromConnector(createFakeConnector([[RETRO]]), {
      fetchContent: true,
      reconcileFullSnapshot: true,
      reconcileAbsenceAuthority: 'partial_window',
    });

    expect(reconciled.itemsTombstoned).toBe(0);
    expect(reconciled.coverageGaps).toEqual([{
      kind: 'absence_not_authoritative',
      absenceAuthority: 'partial_window',
      reason: 'provider_coverage_window_partial',
    }]);
    expect(reconciled.gaps[0]).toContain('absence_not_authoritative');
    // The listing ran out on its own, so the run really did cover its window.
    expect(reconciled.traversalComplete).toBe(true);
    expect(store.searchItems('groceries', 10)).toHaveLength(1);
    store.close();
  });

  test('a truncated partial-window reconcile reports an incomplete traversal', async () => {
    // The partial_window arm clears the checkpoint by policy, so a caller that
    // derived "did this pass cover the window" from the cursor read every
    // truncated reconcile as a full traversal. Completion is a fact about the
    // listing, and the spine is the only layer that observes it.
    const store = newStore();

    const reconciled = await store.syncFromConnector(truncatedConnector([RETRO]), {
      fetchContent: true,
      reconcileFullSnapshot: true,
      reconcileAbsenceAuthority: 'partial_window',
    });

    expect(reconciled.cursor).toBeUndefined();
    expect(reconciled.traversalComplete).toBe(false);
    store.close();
  });

  test('a truncated partial-window reconcile never leaves its shallow cursor as the run position', async () => {
    // The defect this pins, seen on Drive: reconcile traverses from the start
    // under the connector's own hard ceiling, so it stops with a page token
    // still set. Every other reconcile arm clears the checkpoint; the
    // partial_window arm did not, so the run persisted a token pointing at the
    // FIRST ceiling-worth of the provider's listing. The incremental lane reads
    // the newest completed run's cursor, adopted that shallow token, and the
    // corpus could not grow past roughly one ceiling per reconcile interval.
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES]]), { fetchContent: true });

    const reconciled = await store.syncFromConnector(truncatedConnector([RETRO]), {
      fetchContent: true,
      reconcileFullSnapshot: true,
      reconcileAbsenceAuthority: 'partial_window',
    });

    expect(reconciled.cursor).toBeUndefined();
    // The durable half: the pull lane reads the run row, not the return value.
    expect(store.lastCompletedSyncRun('fake')?.cursor).toBeUndefined();
    // Preservation is unchanged — this is about the cursor, not the tombstones.
    expect(reconciled.itemsTombstoned).toBe(0);
    expect(store.searchItems('groceries', 10)).toHaveLength(1);
    store.close();
  });

  test('provider/account snapshot authority is generic and requires complete explicit scope', async () => {
    const store = newStore(':memory:', () => new Date('2026-07-18T22:59:00.000Z'));
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES]], undefined, {
      connectorId: 'archive-preservation',
    }), { fetchContent: true, ownershipKind: 'preservation' });
    await store.syncFromConnector(createFakeConnector([[ROADMAP]], undefined, {
      connectorId: 'provider-live',
    }), { fetchContent: true });

    await expect(store.syncFromConnector(createFakeConnector([[RETRO]], undefined, {
      connectorId: 'provider-live',
    }), {
      fetchContent: true,
      reconcileFullSnapshot: true,
      reconcileAbsenceAuthority: 'partial_window',
      reconcileFullSnapshotScope: { provider: 'fake', accountScope: ACCOUNT },
      reconcileCurrentMembershipAuthority: 'provider_account_snapshot',
      reconcileSnapshotObservedAt: '2026-07-18T23:00:00.000Z',
      reconcileSnapshotCompletedAt: '2026-07-18T23:00:01.000Z',
    })).rejects.toThrow('requires an explicit complete snapshot scope');

    const applied = await store.syncFromConnector(createFakeConnector([[RETRO]], undefined, {
      connectorId: 'provider-live',
    }), {
      fetchContent: true,
      reconcileFullSnapshot: true,
      reconcileAbsenceAuthority: 'complete_snapshot',
      reconcileFullSnapshotScope: { provider: 'fake', accountScope: ACCOUNT },
      reconcileCurrentMembershipAuthority: 'provider_account_snapshot',
      reconcileSnapshotObservedAt: '2026-07-18T23:00:00.000Z',
      reconcileSnapshotCompletedAt: '2026-07-18T23:00:01.000Z',
    });
    expect(applied.itemsTombstoned).toBe(1);
    expect(store.searchItems('groceries', 10)).toHaveLength(1);
    expect(store.searchItems('roadmap', 10)).toEqual([]);
    store.close();
  });

  test('full-snapshot reconciliation stays inside the observed account scope', async () => {
    const store = newStore();
    const workAccount = 'work';
    const workItem: FakeItemSpec = {
      id: 'id:work-plan',
      name: 'work-plan.md',
      text: 'work account planning document stays available',
      locatorUri: '/Work/work-plan.md',
    };

    await store.syncFromConnector(createFakeConnector([[RETRO]], undefined, { accountScope: ACCOUNT }), {
      fetchContent: true,
      reconcileFullSnapshot: true,
    });
    await store.syncFromConnector(createFakeConnector([[workItem]], undefined, { accountScope: workAccount }), {
      fetchContent: true,
      reconcileFullSnapshot: true,
    });

    const reconciled = await store.syncFromConnector(createFakeConnector([[ROADMAP]], undefined, { accountScope: ACCOUNT }), {
      fetchContent: true,
      reconcileFullSnapshot: true,
    });

    expect(reconciled.itemsTombstoned).toBe(1);
    expect(store.localContent(`${ACCOUNT}:${RETRO.id}`)).toBeUndefined();
    expect(store.localContent(`${ACCOUNT}:${ROADMAP.id}`)?.chunks.join(' ')).toContain('connector spine milestone');
    expect(store.localContent(`${workAccount}:${workItem.id}`)?.chunks.join(' ')).toContain('work account planning document');
    expect(store.status().counts.items).toBe(2);
    expect(store.status().counts.tombstonedItems).toBe(1);
    store.close();
  });

  test('full-snapshot reconciliation tombstones items reclassified out of the store trust domain', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'internal.fake.files',
      family: 'file',
      trustDomain: 'internal',
    });
    const internalMemo: FakeItemSpec = {
      id: 'id:internal-memo',
      name: 'internal-memo.md',
      text: 'internal planning memo',
      trustDomain: 'internal',
      trustTier: 'S3',
      locatorUri: '/Internal/internal-memo.md',
    };

    await store.syncFromConnector(createFakeConnector([[internalMemo]]), {
      fetchContent: true,
      reconcileFullSnapshot: true,
    });
    expect(store.searchItems('planning', 10).map((row) => row.sourceItem.providerItemId)).toEqual([internalMemo.id]);

    const reclassified = await store.syncFromConnector(createFakeConnector([[
      { ...internalMemo, trustDomain: 'secure_local', trustTier: 'S4' },
    ]]), {
      fetchContent: true,
      reconcileFullSnapshot: true,
      reconcileFullSnapshotScope: { provider: 'fake', accountScope: ACCOUNT },
    });

    expect(reclassified.itemsRejected).toBe(0);
    expect(reclassified.itemsDemoted).toBe(1);
    expect(reclassified.itemsTombstoned).toBe(1);
    expect(reclassified.gaps[0]).toContain('trust_domain_mismatch');
    expect(store.searchItems('planning', 10)).toEqual([]);
    expect(store.localContent(`${ACCOUNT}:${internalMemo.id}`)).toBeUndefined();
    expect(store.status().counts.items).toBe(0);
    expect(store.status().counts.tombstonedItems).toBe(1);
    store.close();
  });

  test('an item reclassified across trust domains is demoted from its former store immediately', async () => {
    const internalStore = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'internal.fake.files',
      family: 'file',
      trustDomain: 'internal',
    });
    const secureStore = newStore();
    const memo: FakeItemSpec = {
      id: 'id:cross-tier-memo',
      name: 'cross-tier-memo.md',
      text: 'classification moved this memo between trust domains',
      trustDomain: 'internal',
      trustTier: 'S3',
      locatorUri: '/Approved/cross-tier-memo.md',
    };

    const firstObservation = createFakeConnector([[memo]]);
    expect(await internalStore.syncFromConnector(firstObservation, { fetchContent: true }))
      .toMatchObject({ itemsIndexed: 1, itemsRejected: 0 });
    expect(await secureStore.syncFromConnector(createFakeConnector([[memo]]), { fetchContent: true }))
      .toMatchObject({ itemsIndexed: 0, itemsRejected: 1 });

    const reclassified = {
      ...memo,
      trustDomain: 'secure_local' as const,
      trustTier: 'S4' as const,
    };
    const internalReceipt = await internalStore.syncFromConnector(
      createFakeConnector([[reclassified]]),
      { fetchContent: true },
    );
    const secureReceipt = await secureStore.syncFromConnector(
      createFakeConnector([[reclassified]]),
      { fetchContent: true },
    );

    expect(internalReceipt).toMatchObject({
      itemsDemoted: 1,
      itemsRejected: 0,
      itemsTombstoned: 1,
    });
    expect(secureReceipt).toMatchObject({
      itemsDemoted: 0,
      itemsIndexed: 1,
      itemsRejected: 0,
    });
    expect(internalStore.searchItems('classification', 10)).toEqual([]);
    expect(internalStore.localContent(`${ACCOUNT}:${memo.id}`)).toBeUndefined();
    expect(internalStore.status().counts).toMatchObject({ items: 0, tombstonedItems: 1 });
    expect(secureStore.searchItems('classification', 10).map(
      (row) => row.sourceItem.providerItemId,
    )).toEqual([memo.id]);
    expect(secureStore.status().counts).toMatchObject({ items: 1, tombstonedItems: 0 });

    internalStore.close();
    secureStore.close();
  });

  test('cross-tier demotion preserves the classified trust tier on the tombstone', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'olympus-connector-demotion-tier-'));
    const dbPath = join(directory, 'connector.sqlite');
    const store = new LocalConnectorStore({
      dbPath,
      corpusId: 'internal.fake.files',
      family: 'file',
      trustDomain: 'internal',
    });
    const item: FakeItemSpec = {
      id: 'id:demotion-tier',
      name: 'demotion-tier.md',
      text: 'synthetic tier fixture',
      trustDomain: 'internal',
      trustTier: 'S3',
    };
    await store.syncFromConnector(createFakeConnector([[item]]), { fetchContent: true });
    const demoted = await store.syncFromConnector(createFakeConnector([[
      { ...item, trustDomain: 'secure_local', trustTier: 'S5' },
    ]]), { fetchContent: true });
    expect(demoted).toMatchObject({ itemsDemoted: 1, itemsTombstoned: 1 });
    store.close();

    const raw = new Database(dbPath, { readonly: true });
    const tombstone = raw.query(`
      SELECT trust_tier, tombstoned
      FROM items
      WHERE provider = 'fake' AND account_scope = ? AND provider_item_id = ?
    `).get(ACCOUNT, item.id) as { trust_tier: string; tombstoned: number };
    expect(tombstone).toEqual({ trust_tier: 'S5', tombstoned: 1 });
    raw.close();
  });

  test('reverse-direction demotion tombstones with the more sensitive stored tier', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'olympus-connector-demotion-tier-max-'));
    const dbPath = join(directory, 'connector.sqlite');
    const store = newStore(dbPath);
    const item: FakeItemSpec = {
      id: 'id:demotion-tier-max',
      name: 'demotion-tier-max.md',
      text: 'synthetic reverse-direction tier fixture',
      trustDomain: 'secure_local',
      trustTier: 'S4',
    };
    await store.syncFromConnector(createFakeConnector([[item]]), { fetchContent: true });

    // The item moves secure_local -> internal, so this secure store demotes
    // its copy. The tombstone must keep the S4 the store accepted, not the
    // S3 the new classification computed: the row being removed held an S4
    // body, and the audit trail must not understate what was deleted.
    const demoted = await store.syncFromConnector(createFakeConnector([[
      { ...item, trustDomain: 'internal', trustTier: 'S3' },
    ]]), { fetchContent: true });
    expect(demoted).toMatchObject({ itemsDemoted: 1, itemsTombstoned: 1 });
    store.close();

    const raw = new Database(dbPath, { readonly: true });
    const tombstone = raw.query(`
      SELECT trust_tier, tombstoned
      FROM items
      WHERE provider = 'fake' AND account_scope = ? AND provider_item_id = ?
    `).get(ACCOUNT, item.id) as { trust_tier: string; tombstoned: number };
    expect(tombstone).toEqual({ trust_tier: 'S4', tombstoned: 1 });
    raw.close();
  });

  test('rejected-only full snapshots do not tombstone trusted items without an explicit scope', async () => {
    const store = newStore();
    const offItem: FakeItemSpec = {
      id: 'id:internal-only',
      name: 'internal-only.md',
      text: 'this source item belongs in internal, not secure-local',
      trustDomain: 'internal',
      trustTier: 'S2',
      locatorUri: '/Internal/internal-only.md',
    };

    await store.syncFromConnector(createFakeConnector([[RETRO]]), {
      fetchContent: true,
      reconcileFullSnapshot: true,
    });

    const rejected = await store.syncFromConnector(createFakeConnector([[offItem]]), {
      fetchContent: true,
      reconcileFullSnapshot: true,
    });

    expect(rejected.itemsRejected).toBe(1);
    expect(rejected.itemsTombstoned).toBe(0);
    expect(rejected.gaps).toContain('full_snapshot_reconcile_skipped: no provider/account scope was observed or provided.');
    expect(store.localContent(`${ACCOUNT}:${RETRO.id}`)?.chunks.join(' ')).toContain('LanceDB');
    expect(store.status().counts.items).toBe(1);
    expect(store.status().counts.tombstonedItems).toBe(0);
    store.close();
  });

  test('full-snapshot reconciliation is skipped for partial cursorable syncs', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES], [ROADMAP]]), { fetchContent: true });

    const partial = await store.syncFromConnector(createFakeConnector([[RETRO], [ROADMAP]]), {
      maxItems: 1,
      fetchContent: true,
      reconcileFullSnapshot: true,
    });
    expect(partial.itemsTombstoned).toBe(0);
    expect(partial.gaps).toContain('full_snapshot_reconcile_skipped: sync was cursored, bounded, or did not reach a done page.');
    expect(store.searchItems('groceries', 10)).toHaveLength(1);
    store.close();
  });

  test('rejects trust-domain mismatches as gaps, fail closed, without leaking names', async () => {
    const store = newStore();
    const offItem: FakeItemSpec = {
      id: 'id:misrouted',
      name: 'internal-memo.md',
      text: 'this content belongs in a different trust domain',
      trustDomain: 'internal',
      trustTier: 'S2',
      locatorUri: '/Internal/internal-memo.md',
    };
    const summary = await store.syncFromConnector(createFakeConnector([[offItem, RETRO]]), { fetchContent: true });

    expect(summary.itemsRejected).toBe(1);
    expect(summary.itemsIndexed).toBe(1);
    expect(summary.gaps).toHaveLength(1);
    expect(summary.gaps[0]).toContain('trust_domain_mismatch');
    expect(summary.gaps[0]).toContain('fail closed');
    expect(summary.gaps[0]).toContain('"internal"');
    // Castor-safe: the gap references the item by hash only.
    expect(summary.gaps[0]).not.toContain('internal-memo');
    expect(summary.gaps[0]).not.toContain('/Internal');

    // The rejected item never crossed into the store.
    expect(store.searchItems('memo', 10)).toHaveLength(0);
    expect(store.localContent(`${ACCOUNT}:id:misrouted`)).toBeUndefined();
    expect(store.status().counts.items).toBe(1);
    store.close();
  });

  test('corpus integrity verification detects an FTS hole that unchanged replay cannot repair', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'olympus-connector-integrity-'));
    const dbPath = join(directory, 'connector.sqlite');
    const store = newStore(dbPath);
    const provider = createFakeEmbeddingProvider();
    await store.syncFromConnector(createFakeConnector([[RETRO]]), { fetchContent: true });
    await store.embedChunks({ provider });
    store.close();

    const raw = new Database(dbPath);
    raw.transaction(() => {
      raw.query(`
        DELETE FROM connector_store_fts_rows
        WHERE item_pk = (
          SELECT item_pk FROM items
          WHERE provider = 'fake' AND account_scope = ? AND provider_item_id = ?
        )
      `).run(ACCOUNT, RETRO.id);
      raw.query(`
        DELETE FROM connector_store_fts
        WHERE item_pk = (
          SELECT item_pk FROM items
          WHERE provider = 'fake' AND account_scope = ? AND provider_item_id = ?
        )
      `).run(ACCOUNT, RETRO.id);
    })();
    raw.close();

    const reopened = newStore(dbPath);
    const replay = await reopened.syncFromConnector(
      createFakeConnector([[RETRO]]),
      { fetchContent: true },
    );
    expect(replay).toMatchObject({ chunksIndexed: 0, itemsChanged: 0 });
    expect(reopened.searchItems('lancedb', 10)).toEqual([]);

    const report = verifyConnectorStoreCorpusIntegrity(reopened, {
      embeddingModelId: provider.modelId,
      sampleLimit: 1,
    });
    expect(report.counts).toEqual({
      itemsWithFtsDeficiency: 1,
      chunksWithoutCurrentEmbeddings: 0,
      itemsWithChunkHashDisagreement: 0,
    });
    expect(report.samples).toEqual({
      ftsDeficientLocalItemIds: [`${ACCOUNT}:${RETRO.id}`],
      missingEmbeddingLocalItemIds: [],
      chunkHashDisagreementLocalItemIds: [],
    });
    expect(report.policy).toMatchObject({
      countsOnly: true,
      sourceTextReturned: false,
    });
    expect(JSON.stringify(report)).not.toContain(RETRO.name!);
    expect(JSON.stringify(report)).not.toContain(RETRO.text!);
    expect(JSON.stringify(report)).not.toContain(RETRO.locatorUri!);
    reopened.close();
  });

  test('corpus integrity verification visits active zero-chunk items and detects a missing item-level FTS row', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'olympus-connector-zero-chunk-integrity-'));
    const dbPath = join(directory, 'connector.sqlite');
    const binary: FakeItemSpec = {
      id: 'id:zero-chunk',
      name: 'zero-chunk.jpg',
      bytes: { mimeType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]) },
    };
    const store = newStore(dbPath);
    await store.syncFromConnector(createFakeConnector([[binary]]), { fetchContent: true });
    expect(store.status().counts).toMatchObject({ items: 1, chunks: 0 });
    store.close();

    const raw = new Database(dbPath);
    raw.query(`
      DELETE FROM connector_store_fts_rows
      WHERE item_pk = (
        SELECT item_pk FROM items
        WHERE provider = 'fake' AND account_scope = ? AND provider_item_id = ?
      )
    `).run(ACCOUNT, binary.id);
    raw.query(`
      DELETE FROM connector_store_fts
      WHERE item_pk = (
        SELECT item_pk FROM items
        WHERE provider = 'fake' AND account_scope = ? AND provider_item_id = ?
      )
    `).run(ACCOUNT, binary.id);
    raw.close();

    const reopened = newStore(dbPath);
    expect(reopened.searchItems('zero', 10)).toEqual([]);
    const report = reopened.verifyCorpusIntegrity({
      embeddingModelId: 'fake-embed-v1',
      sampleLimit: 1,
    });
    expect(report.counts).toEqual({
      itemsWithFtsDeficiency: 1,
      chunksWithoutCurrentEmbeddings: 0,
      itemsWithChunkHashDisagreement: 0,
    });
    expect(report.samples.ftsDeficientLocalItemIds).toEqual([
      `${ACCOUNT}:${binary.id}`,
    ]);
    reopened.close();
  });

  test('corpus integrity verification treats duplicate real FTS rows as a deficiency', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'olympus-connector-duplicate-fts-'));
    const dbPath = join(directory, 'connector.sqlite');
    const store = newStore(dbPath);
    const provider = createFakeEmbeddingProvider();
    await store.syncFromConnector(createFakeConnector([[RETRO]]), { fetchContent: true });
    await store.embedChunks({ provider });
    store.close();

    const raw = new Database(dbPath);
    const existing = raw.query(`
      SELECT fts.title, fts.bounded_text, owned.item_pk, owned.chunk_pk
      FROM connector_store_fts_rows owned
      JOIN connector_store_fts fts ON fts.rowid = owned.fts_rowid
      WHERE owned.item_pk = (
        SELECT item_pk FROM items
        WHERE provider = 'fake' AND account_scope = ? AND provider_item_id = ?
      )
      LIMIT 1
    `).get(ACCOUNT, RETRO.id) as {
      title: string;
      bounded_text: string;
      item_pk: number;
      chunk_pk: number;
    };
    const duplicate = raw.query(`
      INSERT INTO connector_store_fts (title, bounded_text, item_pk, chunk_pk)
      VALUES (?, ?, ?, ?)
    `).run(existing.title, existing.bounded_text, existing.item_pk, existing.chunk_pk);
    raw.query(`
      INSERT INTO connector_store_fts_rows (fts_rowid, item_pk, chunk_pk)
      VALUES (?, ?, ?)
    `).run(Number(duplicate.lastInsertRowid), existing.item_pk, existing.chunk_pk);
    raw.close();

    const reopened = newStore(dbPath);
    const report = reopened.verifyCorpusIntegrity({
      embeddingModelId: provider.modelId,
      sampleLimit: 1,
    });
    expect(report.counts).toEqual({
      itemsWithFtsDeficiency: 1,
      chunksWithoutCurrentEmbeddings: 0,
      itemsWithChunkHashDisagreement: 0,
    });
    expect(report.samples.ftsDeficientLocalItemIds).toEqual([
      `${ACCOUNT}:${RETRO.id}`,
    ]);
    reopened.close();
  });

  test('corpus integrity verification detects FTS rows left dangling by a crash-window chunk replacement', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'olympus-connector-dangling-fts-'));
    const dbPath = join(directory, 'connector.sqlite');
    const store = newStore(dbPath);
    const provider = createFakeEmbeddingProvider();
    await store.syncFromConnector(createFakeConnector([[RETRO]]), { fetchContent: true });
    await store.embedChunks({ provider });
    store.close();

    // Crash window: a chunk rewrite committed (new chunk_pk, same
    // cardinality, self-consistent hashes, current embedding) but the FTS
    // refresh never ran. Every FTS row still exists, so count equality
    // holds — yet each mapping dangles at the deleted chunk and search
    // serves the pre-edit text.
    const raw = new Database(dbPath);
    const old = raw.query(`
      SELECT c.chunk_pk, c.item_pk, c.chunk_index, c.indexed_at
      FROM chunks c
      JOIN items i ON i.item_pk = c.item_pk
      WHERE i.provider = 'fake' AND i.account_scope = ? AND i.provider_item_id = ?
    `).get(ACCOUNT, RETRO.id) as {
      chunk_pk: number;
      item_pk: number;
      chunk_index: number;
      indexed_at: string;
    };
    const revised = 'The revised retro adopted sqlite-vec instead after the crash window.';
    const revisedHash = createHash('sha256').update(revised).digest('hex');
    const revisedEmbedHash = createHash('sha256').update(`embed:${revised}`).digest('hex');
    raw.transaction(() => {
      const inserted = raw.query(`
        INSERT INTO chunks (item_pk, chunk_index, bounded_text, content_hash, embedding_input_hash, indexed_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(old.item_pk, old.chunk_index + 1, revised, revisedHash, revisedEmbedHash, old.indexed_at);
      raw.query(`
        INSERT INTO chunk_embeddings (chunk_pk, model_id, item_pk, content_hash, embedding, embedded_at)
        SELECT ?, model_id, item_pk, ?, embedding, embedded_at
        FROM chunk_embeddings WHERE chunk_pk = ?
      `).run(Number(inserted.lastInsertRowid), revisedEmbedHash, old.chunk_pk);
      raw.query('DELETE FROM chunk_embeddings WHERE chunk_pk = ?').run(old.chunk_pk);
      raw.query('DELETE FROM chunks WHERE chunk_pk = ?').run(old.chunk_pk);
    })();
    raw.close();

    const reopened = newStore(dbPath);
    const report = reopened.verifyCorpusIntegrity({
      embeddingModelId: provider.modelId,
      sampleLimit: 1,
    });
    expect(report.counts).toEqual({
      itemsWithFtsDeficiency: 1,
      chunksWithoutCurrentEmbeddings: 0,
      itemsWithChunkHashDisagreement: 0,
    });
    expect(report.samples.ftsDeficientLocalItemIds).toEqual([
      `${ACCOUNT}:${RETRO.id}`,
    ]);
    reopened.close();
  });

  test('corpus integrity verification counts stale embeddings and incoherent chunk hashes', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'olympus-connector-integrity-'));
    const dbPath = join(directory, 'connector.sqlite');
    const store = newStore(dbPath);
    const provider = createFakeEmbeddingProvider();
    await store.syncFromConnector(
      createFakeConnector([[RETRO, GROCERIES, CAT]]),
      { fetchContent: true },
    );
    await store.embedChunks({ provider });
    store.close();

    const raw = new Database(dbPath);
    raw.transaction(() => {
      raw.query(`
        DELETE FROM chunk_embeddings
        WHERE item_pk = (
          SELECT item_pk FROM items
          WHERE provider = 'fake' AND account_scope = ? AND provider_item_id = ?
        )
      `).run(ACCOUNT, GROCERIES.id);
      raw.query(`
        UPDATE chunks SET content_hash = ?
        WHERE item_pk = (
          SELECT item_pk FROM items
          WHERE provider = 'fake' AND account_scope = ? AND provider_item_id = ?
        )
      `).run('0'.repeat(64), ACCOUNT, CAT.id);
    })();
    raw.close();

    const reopened = newStore(dbPath);
    const report = verifyConnectorStoreCorpusIntegrity(reopened, {
      embeddingModelId: provider.modelId,
      sampleLimit: 1,
    });
    expect(report.counts).toEqual({
      itemsWithFtsDeficiency: 0,
      chunksWithoutCurrentEmbeddings: 1,
      itemsWithChunkHashDisagreement: 1,
    });
    expect(report.samples).toEqual({
      ftsDeficientLocalItemIds: [],
      missingEmbeddingLocalItemIds: [`${ACCOUNT}:${GROCERIES.id}`],
      chunkHashDisagreementLocalItemIds: [`${ACCOUNT}:${CAT.id}`],
    });
    reopened.close();
  });

  test('classifies per item before content indexing and cloud embedding eligibility', async () => {
    const ordinaryEmail = googleFixtureItem({
      family: 'email',
      provider: 'gmail',
      id: 'msg-ordinary',
      title: 'Apollo launch plan',
      text: 'Apollo launch plan moved to Thursday.',
      metadata: {
        subject: 'Apollo launch plan',
        sender: 'Alex <alex@example.com>',
        authoredAt: '2026-07-07T12:00:00.000Z',
      },
    });
    const therapyEmail = googleFixtureItem({
      family: 'email',
      provider: 'gmail',
      id: 'msg-therapy',
      title: 'Therapy appointment',
      text: 'Therapy appointment notes for next week.',
      metadata: {
        subject: 'Therapy appointment',
        sender: 'Clinic <care@example.com>',
        authoredAt: '2026-07-07T12:01:00.000Z',
      },
    });
    const passwordExport = googleFixtureItem({
      family: 'file',
      provider: 'google_drive',
      id: 'file-passwords',
      title: 'password-manager-export.csv',
      text: 'account,username,password\nexample,alice,secret',
      metadata: {
        name: 'password-manager-export.csv',
        pathDisplay: '/Exports/password-manager-export.csv',
        updatedAt: '2026-07-07T12:02:00.000Z',
      },
    });

    const internalEmailStore = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'internal.email',
      family: 'email',
      trustDomain: 'internal',
    });
    const secureEmailStore = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'secure_local.email.private',
      family: 'email',
      trustDomain: 'secure_local',
    });
    const internalDriveStore = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'internal.drive.docs',
      family: 'file',
      trustDomain: 'internal',
    });
    const secureDriveStore = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'secure_local.drive.docs',
      family: 'file',
      trustDomain: 'secure_local',
    });
    const classification = { sensitivityMap: GOOGLE_ITEM_SENSITIVITY_MAP };

    const gmailConnector = createGoogleFixtureConnector('google:gmail', 'email', [ordinaryEmail, therapyEmail]);
    const driveConnector = createGoogleFixtureConnector('google:drive', 'file', [passwordExport]);
    const internalEmail = await internalEmailStore.syncFromConnector(gmailConnector, {
      fetchContent: true,
      classification,
    });
    const secureEmail = await secureEmailStore.syncFromConnector(gmailConnector, {
      fetchContent: true,
      classification,
    });
    const internalDrive = await internalDriveStore.syncFromConnector(driveConnector, {
      fetchContent: true,
      classification,
    });
    const secureDrive = await secureDriveStore.syncFromConnector(driveConnector, {
      fetchContent: true,
      classification,
    });

    expect(internalEmail.itemsIndexed).toBe(1);
    expect(internalEmail.itemsRejected).toBe(1);
    expect(secureEmail.itemsIndexed).toBe(1);
    expect(secureEmail.itemsRejected).toBe(1);
    expect(internalDrive.itemsIndexed).toBe(0);
    expect(internalDrive.itemsRejected).toBe(1);
    expect(secureDrive.itemsIndexed).toBe(0);
    expect(secureDrive.itemsTombstoned).toBe(1);
    expect(secureDrive.gaps).toContainEqual(expect.stringContaining('secrets_tier_excluded'));

    const internalHits = await createConnectorStoreCorpusAdapter({ store: internalEmailStore })({
      query: 'Apollo',
      maxResults: 10,
      corpus: defineConnectorCorpus({ corpusId: 'internal.email', family: 'email', trustDomain: 'internal' }),
      context: { allowedTrustDomains: ['internal'], allowedCorpusIds: ['internal.email'] },
    });
    const secureHits = await createConnectorStoreCorpusAdapter({ store: secureEmailStore })({
      query: 'therapy',
      maxResults: 10,
      corpus: defineConnectorCorpus({ corpusId: 'secure_local.email.private', family: 'email', trustDomain: 'secure_local' }),
      context: { allowedTrustDomains: ['secure_local'], allowedCorpusIds: ['secure_local.email.private'] },
    });

    expect(internalHits.hits.map((hit) => hit.sourceItem.providerItemId)).toEqual(['msg-ordinary']);
    expect(secureHits.hits.map((hit) => hit.sourceItem.providerItemId)).toEqual(['msg-therapy']);
    expect(secureDriveStore.searchItems('password', 10)).toEqual([]);
    expect(secureDriveStore.status().counts.tombstonedItems).toBe(1);
    expect(secureDriveStore.status().counts.chunks).toBe(0);

    const cloud = createFakeEmbeddingProvider({ backend: 'cloud' });
    const embeddedInternal = await internalEmailStore.embedChunks({ provider: cloud });
    expect(embeddedInternal.chunksEmbedded).toBe(1);
    await expect(secureEmailStore.embedChunks({ provider: cloud })).rejects.toThrow('local/private');
    const embeddedText = cloud.embedCalls.flat().map((input) => `${input.title ?? ''}\n${input.text}`).join('\n');
    expect(embeddedText).toContain('Apollo launch plan');
    expect(embeddedText).not.toContain('Therapy appointment');
    expect(embeddedText).not.toContain('password');

    internalEmailStore.close();
    secureEmailStore.close();
    internalDriveStore.close();
    secureDriveStore.close();
  });

  test('the shared classification policy runs the sensitive detectors, not only the sensitivity map', async () => {
    // The defect this pins: the policy consulted ONLY the sensitivity map and
    // then fell to its baseline, so on a lane whose baseline is internal —
    // every Google lane — the engine's conservative detectors never ran at
    // all. A bank statement filed as ordinary internal mail (and became cloud
    // embedding eligible), and a message carrying private key material was
    // STORED rather than tombstoned by the S5 rule directly below it.
    const ordinary = googleFixtureItem({
      family: 'email',
      provider: 'gmail',
      id: 'msg-plain',
      title: 'Apollo launch plan',
      text: 'Apollo launch plan moved to Thursday.',
      metadata: { subject: 'Apollo launch plan', sender: 'Alex <alex@example.com>' },
    });
    const financial = googleFixtureItem({
      family: 'email',
      provider: 'gmail',
      id: 'msg-statement',
      title: 'Your monthly statement',
      text: 'Your bank statement for July is attached.',
      metadata: { subject: 'Your monthly statement', sender: 'Bank <no-reply@example.com>' },
    });
    const secretBearing = googleFixtureItem({
      family: 'email',
      provider: 'gmail',
      id: 'msg-key',
      title: 'Deploy key',
      text: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
      metadata: { subject: 'Deploy key', sender: 'Ops <ops@example.com>' },
    });

    const internalStore = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'internal.email',
      family: 'email',
      trustDomain: 'internal',
    });
    const secureStore = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'secure_local.email.private',
      family: 'email',
      trustDomain: 'secure_local',
    });
    // No sensitivity map: the map is the operator's override, and the estate's
    // classification doctrine does not depend on one existing.
    const classification = { baselineTrustTier: 'S3' as const, baselineTrustDomain: 'internal' as const };
    const connector = createGoogleFixtureConnector('google:gmail', 'email', [ordinary, financial, secretBearing]);

    const internal = await internalStore.syncFromConnector(connector, { fetchContent: true, classification });
    const secure = await secureStore.syncFromConnector(connector, { fetchContent: true, classification });

    // Only the item with no sensitive signal belongs to the internal band.
    expect(internal.itemsIndexed).toBe(1);
    expect(internal.itemsRejected).toBe(2);
    expect(internalStore.searchItems('statement', 10)).toEqual([]);
    // The financial item is the secure band's; the S5 secret is tombstoned
    // rather than stored, in the store that accepted it.
    expect(secure.itemsIndexed).toBe(1);
    expect(secure.itemsTombstoned).toBe(1);
    expect(secure.itemsRejected).toBe(1);
    expect(secure.gaps).toContainEqual(expect.stringContaining('secrets_tier_excluded'));
    expect(secureStore.status().counts.chunks).toBeGreaterThan(0);
    expect(secureStore.searchItems('RSA', 10)).toEqual([]);

    // A detector hit must never ride a cloud embedding lane.
    const cloud = createFakeEmbeddingProvider({ backend: 'cloud' });
    await expect(secureStore.embedChunks({ provider: cloud })).rejects.toThrow('local/private');

    internalStore.close();
    secureStore.close();
  });

  test('non-text bytes index as metadata-only items with no chunks', async () => {
    const store = newStore();
    const binary: FakeItemSpec = {
      id: 'id:binary',
      name: 'photo.jpg',
      bytes: { mimeType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x12]) },
    };
    const summary = await store.syncFromConnector(createFakeConnector([[binary]]), { fetchContent: true });
    expect(summary.itemsIndexed).toBe(1);
    expect(summary.chunksIndexed).toBe(0);
    // Still findable by title, with honest empty content downstream.
    expect(store.searchItems('photo', 10)).toHaveLength(1);
    expect(store.localContent(`${ACCOUNT}:id:binary`)?.chunks).toEqual([]);
    store.close();
  });

  test('bounds chunk size via maxChunkChars', async () => {
    const store = newStore();
    const long: FakeItemSpec = { id: 'id:long', name: 'long.txt', text: 'x'.repeat(95) };
    const summary = await store.syncFromConnector(createFakeConnector([[long]]), {
      fetchContent: true,
      maxChunkChars: 40,
    });
    expect(summary.chunksIndexed).toBe(3);
    const content = store.localContent(`${ACCOUNT}:id:long`);
    expect(content?.chunks.map((chunk) => chunk.length)).toEqual([40, 40, 15]);
    store.close();
  });

  test('a page cannot claim to be both truncated and done', async () => {
    // Type-level half. If the union is ever loosened back to `done: boolean`
    // plus a free `truncated`, this stops being an error and `typecheck` fails
    // on the unused directive — so the guard cannot rot silently.
    // @ts-expect-error a truncated page is not a completed traversal
    const illegal: SourceConnectorListPage = { items: [], done: true, truncated: true };
    void illegal;

    // Runtime half, for a connector that reached the spine across a boundary
    // the compiler did not see.
    const store = newStore();
    const smuggled: SourceConnector = {
      id: 'smuggler',
      family: 'file',
      async authenticate(): Promise<void> {},
      listItems(): AsyncIterable<SourceConnectorListPage> {
        return (async function* (): AsyncGenerator<SourceConnectorListPage> {
          yield { items: [], done: true, truncated: true } as unknown as SourceConnectorListPage;
        })();
      },
      async fetchItem(): Promise<RawItem> { throw new Error('unused'); },
      classify: () => buildSourceSensitivity({ trustTier: 'S1', trustDomain: 'secure_local' }),
    };
    await expect(store.syncFromConnector(smuggled)).rejects.toThrow(/connector_page_invariant/);
    store.close();
  });

  test('re-indexing byte-identical rows reports zero items changed', async () => {
    const store = newStore();
    const connector = createFakeConnector(
      [[{ id: 'x1', inlineText: 'one' }, { id: 'x2', inlineText: 'two' }]],
      undefined,
      { connectorId: 'steady' },
    );

    const first = await store.syncFromConnector(connector);
    expect(first.itemsIndexed).toBe(2);
    expect(first.itemsChanged).toBe(2);

    // The same two items again. itemsIndexed still counts two writes — which is
    // exactly why it is useless as a health signal — but nothing changed.
    const second = await store.syncFromConnector(connector);
    expect(second.itemsIndexed).toBe(2);
    expect(second.itemsChanged).toBe(0);

    const moved = createFakeConnector(
      [[{ id: 'x1', inlineText: 'one' }, { id: 'x2', inlineText: 'two, edited' }]],
      undefined,
      { connectorId: 'steady' },
    );
    const third = await store.syncFromConnector(moved);
    expect(third.itemsIndexed).toBe(2);
    expect(third.itemsChanged).toBe(1);
    store.close();
  });

  test('a page bigger than the budget keeps its checkpoint and says so', async () => {
    const store = newStore();
    // A connector that hands back more than the limit it was given. The spine
    // stops mid-page, and it must NOT take that page's cursor: the tail was
    // never read, so advancing would skip it permanently. Holding the previous
    // checkpoint is correct — and, repeated, it is also a lane that can never
    // move, so the abandonment is reported instead of looking like a clean run.
    const overrun = createFakeConnector([[{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }], [{ id: 'a4' }]]);

    const first = await store.syncFromConnector(overrun, { maxItems: 2 });
    expect(first.itemsSeen).toBe(2);
    expect(first.cursor).toBeUndefined();
    expect(first.gaps).toEqual([
      'connector_page_abandoned: connector fake returned a page larger than the requested limit; '
      + 'the run stopped mid-page and kept its previous checkpoint, so this pass made no forward progress.',
    ]);

    // Repeating with the returned position re-reads the same prefix forever:
    // the checkpoint is honestly unmoved, and nothing about it is silent.
    const second = await store.syncFromConnector(overrun, { maxItems: 2 });
    expect(second.itemsSeen).toBe(2);
    expect(second.itemsChanged).toBe(0);
    expect(second.cursor).toBeUndefined();
    expect(second.gaps).toEqual(first.gaps);

    // A budget that clears the page moves normally: no gap, cursor advanced.
    const third = await store.syncFromConnector(overrun, { maxItems: 3 });
    expect(third.cursor).toBe('cursor-1');
    expect(third.gaps).toEqual([]);
    store.close();
  });

  test('a second connector sharing one store does not inherit the first lane cursor', async () => {
    const store = newStore();
    const laneA = createFakeConnector(
      [[{ id: 'a1' }], [{ id: 'a2' }], [{ id: 'a3' }], [{ id: 'a4' }]],
      undefined,
      { connectorId: 'lane-a', provider: 'lane-a', accountScope: 'a' },
    );
    const laneB = createFakeConnector(
      [[{ id: 'b1' }], [{ id: 'b2' }], [{ id: 'b3' }], [{ id: 'b4' }]],
      undefined,
      { connectorId: 'lane-b', provider: 'lane-b', accountScope: 'b' },
    );

    // Lane A gets two pages deep, then lane B — the newer run — stops after one.
    expect((await store.syncFromConnector(laneA, { maxItems: 2 })).cursor).toBe('cursor-2');
    expect((await store.syncFromConnector(laneB, { maxItems: 1 })).cursor).toBe('cursor-1');

    // The unscoped "what did this store do last" answer is lane B's shallower
    // position. Resuming lane A from it walks lane A backwards a page.
    expect(store.status().lastSyncRun?.cursor).toBe('cursor-1');
    expect(store.lastCompletedSyncRun('lane-a')?.cursor).toBe('cursor-2');
    expect(store.lastCompletedSyncRun('lane-b')?.cursor).toBe('cursor-1');
    store.close();
  });

  test('a run left behind by a killed process is never a resume point', async () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'connector-store-')), 'store.sqlite');
    const store = newStore(dbPath);
    const lane = createFakeConnector(
      [[{ id: 'a1' }], [{ id: 'a2' }], [{ id: 'a3' }], [{ id: 'a4' }]],
      undefined,
      { connectorId: 'lane-a' },
    );
    expect((await store.syncFromConnector(lane, { maxItems: 2 })).cursor).toBe('cursor-2');
    expect((await store.syncFromConnector(lane, { cursor: 'cursor-2', maxItems: 1 })).cursor)
      .toBe('cursor-3');

    // A process killed mid-run leaves a 'running' row behind. Its cursor column
    // still holds the position that run STARTED from — it is only overwritten
    // with the end position when the run terminates. It is also the newest row.
    const db = new Database(dbPath);
    db.query(`
      INSERT INTO sync_runs (sync_run_id, corpus_id, connector_id, status, cursor, items_seen, items_indexed, started_at)
      VALUES ('killed-mid-run', ?, 'lane-a', 'running', 'cursor-2', 0, 0, ?)
    `).run(CORPUS_ID, '2999-01-01T00:00:00.000Z');
    db.close();

    expect(store.status().lastSyncRun?.cursor).toBe('cursor-2');
    expect(store.lastCompletedSyncRun('lane-a')?.cursor).toBe('cursor-3');
    // The killed row is not terminal either: its cursor is a starting position.
    expect(store.lastTerminalSyncRun('lane-a')?.cursor).toBe('cursor-3');
    store.close();
  });

  test('a failed run keeps its position reachable, the completed-run accessor does not', async () => {
    // The defect this pins: the failure path writes how far the run actually
    // got, and `lastCompletedSyncRun` was the only accessor — so a lane whose
    // run threw had its progress sitting on disk and invisible to the code that
    // needed it, and resumed from its floor. Replaying a whole local backlog is
    // the visible cost; the silent one is that nothing says it happened.
    const dbPath = join(mkdtempSync(join(tmpdir(), 'connector-store-')), 'store.sqlite');
    const store = newStore(dbPath);
    const pages = [[{ id: 'a1' }], [{ id: 'a2' }], [{ id: 'a3' }], [{ id: 'a4' }]];
    const lane = createFakeConnector(pages, undefined, { connectorId: 'lane-a' });

    expect((await store.syncFromConnector(lane, { maxItems: 2 })).cursor).toBe('cursor-2');

    // A run that commits one more page and then loses the provider mid-traversal.
    await expect(store.syncFromConnector(
      failsAfterOnePage(createFakeConnector(pages, undefined, { connectorId: 'lane-a' })),
      { cursor: 'cursor-2' },
    )).rejects.toThrow('provider went away');

    expect(store.lastCompletedSyncRun('lane-a')?.cursor).toBe('cursor-2');
    expect(store.lastTerminalSyncRun('lane-a')?.cursor).toBe('cursor-3');
    store.close();
  });

  test('lastSyncRun breaks same-millisecond ties by insertion order, not run id', () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), 'connector-store-')), 'store.sqlite');
    const store = newStore(dbPath);
    // Two runs started in the same millisecond: sync run ids are random
    // UUIDs, so ordering by id would pick a winner at random. The
    // first-inserted run gets the lexically greater id on purpose — id
    // ordering and insertion ordering disagree.
    const startedAt = '2026-07-06T12:00:00.000Z';
    const db = new Database(dbPath);
    const insert = db.query(`
      INSERT INTO sync_runs (sync_run_id, corpus_id, connector_id, status, cursor, items_seen, items_indexed, started_at)
      VALUES (?, ?, ?, 'completed', NULL, 0, 0, ?)
    `);
    insert.run('connector-sync-zzz-first', CORPUS_ID, 'fake', startedAt);
    insert.run('connector-sync-aaa-latest', CORPUS_ID, 'fake', startedAt);
    db.close();
    expect(store.status().lastSyncRun?.syncRunId).toBe('connector-sync-aaa-latest');
    store.close();
  });
});

// --- Reactions ----------------------------------------------------------------
//
// Owner ruling (2026-07-24): an emoji reaction can confirm a message, so it is
// evidence attached to the REACTED item. These tests cover the source-neutral
// half: how the shared store represents, searches, and serves reactions, and
// the proof that a reaction landing on an old message refreshes the whole
// representation without disturbing what the message actually said.

const REACTED_MESSAGE = 'please bring the school form tomorrow';

function reactedChatItem(reactions?: unknown): RawItem {
  return chatItem({
    id: 'chat-1',
    conversationId: '98765430001111@lid',
    chat: 'Jane Doe',
    sender: 'Grace Hopper',
    text: REACTED_MESSAGE,
    ...(reactions === undefined ? {} : { reactions }),
  });
}

const THUMBS_UP_BY_TWO = [
  { key: '👍', count: 2, actors: [{ providerActorId: 'peer-9', label: 'Ada Lovelace' }, { providerActorId: 'owner-1' }] },
];

describe('LocalConnectorStore reactions', () => {
  test('a fresh store lands on the reaction schema and stores a normalized aggregate', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connector-store-reactions-'));
    const dbPath = join(dir, 'store.sqlite');
    const store = new LocalConnectorStore({
      dbPath,
      corpusId: 'secure_local.fake.chat',
      family: 'chat',
      trustDomain: 'secure_local',
    });
    await store.syncFromConnector(createChatConnector([reactedChatItem(THUMBS_UP_BY_TWO)]), { fetchContent: true });
    store.close();

    expect(connectorStoreQualificationFingerprint(dbPath).schemaVersion).toBe(11);

    const db = new Database(dbPath, { readonly: true });
    try {
      expect((db.query('PRAGMA table_info(items)').all() as Array<{ name: string }>).map((row) => row.name))
        .toContain('reactions_json');
      // Stored canonically, so the same reactions always serialize identically.
      expect(db.query('SELECT reactions_json FROM items').get()).toEqual({
        reactions_json: '[{"key":"👍","count":2,"actors":[{"providerActorId":"owner-1"},'
          + '{"providerActorId":"peer-9","label":"Ada Lovelace"}]}]',
      });
    } finally {
      db.close();
    }
  });

  test('a read-only open of a pre-reaction store still serves evidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connector-store-pre-reactions-'));
    const dbPath = join(dir, 'store.sqlite');
    const writer = new LocalConnectorStore({
      dbPath,
      corpusId: 'secure_local.fake.chat',
      family: 'chat',
      trustDomain: 'secure_local',
    });
    await writer.syncFromConnector(createChatConnector([reactedChatItem()]), { fetchContent: true });
    writer.close();

    // Rewind to the pre-reaction schema: this is what a live store looks like
    // between deploying a build that reads reactions and the writer that
    // migrates the file. A read-only open cannot migrate it, and refusing to
    // serve would take the answer path down for a purely additive column.
    const rewind = new Database(dbPath);
    try {
      rewind.exec('ALTER TABLE items DROP COLUMN reactions_json;');
      rewind.query("UPDATE schema_version SET version = 8 WHERE store_id = 'connector-store'").run();
    } finally {
      rewind.close();
    }

    const reader = new LocalConnectorStore({
      dbPath,
      corpusId: 'secure_local.fake.chat',
      family: 'chat',
      trustDomain: 'secure_local',
      readOnly: true,
    });
    expect(reader.localContent(`${ACCOUNT}:chat-1`)?.chunks).toEqual([REACTED_MESSAGE]);
    expect(reader.itemReactions(`${ACCOUNT}:chat-1`)).toEqual([]);
    reader.close();
  });

  test('projects reactions into search, the item aggregate, and the evidence context', async () => {
    const store = newChatStore();
    await store.syncFromConnector(createChatConnector([reactedChatItem(THUMBS_UP_BY_TWO)]), { fetchContent: true });

    expect(store.itemReactions(`${ACCOUNT}:chat-1`)).toEqual([{
      key: '👍',
      count: 2,
      actors: [{ providerActorId: 'owner-1' }, { providerActorId: 'peer-9', label: 'Ada Lovelace' }],
    }]);

    // The rendered line is in search_text, so both the word and an actor label
    // that appears nowhere else in the item are findable.
    expect(store.searchItems('reactions', 10)[0]?.sourceItem.providerItemId).toBe('chat-1');
    expect(store.searchItems('Ada Lovelace', 10)[0]?.sourceItem.providerItemId).toBe('chat-1');

    // Item-level evidence context: the reaction leads, the message text is
    // served unchanged behind it.
    expect(store.localContent(`${ACCOUNT}:chat-1`)?.chunks).toEqual([
      'Reactions: 👍 ×2 (Ada Lovelace)',
      REACTED_MESSAGE,
    ]);
    store.close();
  });

  test('a reaction landing on an old message refreshes the representation, chunks intact', async () => {
    const store = newChatStore();
    const provider = createFakeEmbeddingProvider();
    await store.syncFromConnector(createChatConnector([reactedChatItem()]), { fetchContent: true });
    const syncRunId = store.status().lastSyncRun?.syncRunId;
    expect(await store.embedChunks({ provider })).toMatchObject({ chunksEmbedded: 1 });
    expect(store.status().counts.embeddedChunks).toBe(1);
    expect(store.status().counts.syncRuns).toBe(1);
    expect(store.status().lastSyncRun?.syncRunId).toBe(syncRunId);
    expect(store.searchItems('reactions', 10)).toEqual([]);

    // Only the reactions changed: no new chunk work, but the item's derived
    // representation moves.
    const reacted = await store.syncFromConnector(
      createChatConnector([reactedChatItem(THUMBS_UP_BY_TWO)]),
      { fetchContent: true },
    );
    expect(reacted.itemsIndexed).toBe(1);
    expect(reacted.chunksIndexed).toBe(0);

    // FTS reflects the reaction line.
    expect(store.searchItems('reactions', 10)[0]?.sourceItem.providerItemId).toBe('chat-1');
    // The old vector is excluded by the currency rule rather than deleted.
    expect(store.status().counts.embeddedChunks).toBe(0);
    expect(store.hasEmbeddings('fake-embed-v1')).toBe(false);

    // The ordinary drain re-embeds it — no new scheduler.
    const drained = await store.embedChunks({ provider });
    expect(drained).toMatchObject({ chunksEmbedded: 1, chunksSkipped: 0 });
    expect(provider.embedCalls.at(-1)?.[0]?.text).toContain('Reactions: 👍 ×2 (Ada Lovelace)');
    expect(provider.embedCalls.at(-1)?.[0]?.text).toContain(REACTED_MESSAGE);
    expect(store.status().counts.embeddedChunks).toBe(1);

    // What the message SAID never changed, so its stored chunk did not either.
    expect(store.status().counts.chunks).toBe(1);
    expect(store.localContent(`${ACCOUNT}:chat-1`)?.chunks.at(-1)).toBe(REACTED_MESSAGE);

    // Duplicate delivery of the same reacted item is a no-op end to end.
    const replayed = await store.syncFromConnector(
      createChatConnector([reactedChatItem(THUMBS_UP_BY_TWO)]),
      { fetchContent: true },
    );
    expect(replayed).toMatchObject({ itemsIndexed: 1, chunksIndexed: 0 });
    expect(await store.embedChunks({ provider })).toMatchObject({ chunksEmbedded: 0, chunksSkipped: 1 });
    expect(store.status().counts).toMatchObject({ items: 1, chunks: 1, embeddedChunks: 1 });
    store.close();
  });

  test('add, change, and remove replace the aggregate; a silent emit preserves it', async () => {
    const store = newChatStore();
    const connector = (reactions?: unknown) => createChatConnector([reactedChatItem(reactions)]);

    await store.syncFromConnector(connector([{ key: '👍', count: 1 }]), { fetchContent: true });
    expect(store.itemReactions(`${ACCOUNT}:chat-1`)).toEqual([{ key: '👍', count: 1 }]);

    // Changed: the aggregate is replaced wholesale, never appended to.
    await store.syncFromConnector(
      connector([{ key: '👍', count: 2 }, { key: '❤️', count: 1 }]),
      { fetchContent: true },
    );
    expect(store.itemReactions(`${ACCOUNT}:chat-1`)).toEqual([
      { key: '👍', count: 2 },
      { key: '❤️', count: 1 },
    ]);
    expect(store.localContent(`${ACCOUNT}:chat-1`)?.chunks[0]).toBe('Reactions: 👍 ×2; ❤️ ×1');

    // An emit that says nothing about reactions leaves them alone: a connector
    // that knows nothing about reactions must not be able to erase them.
    await store.syncFromConnector(connector(), { fetchContent: true });
    expect(store.itemReactions(`${ACCOUNT}:chat-1`)).toHaveLength(2);

    // Removal is said explicitly, and takes the item back to its pre-reaction
    // representation everywhere.
    await store.syncFromConnector(connector([]), { fetchContent: true });
    expect(store.itemReactions(`${ACCOUNT}:chat-1`)).toEqual([]);
    expect(store.searchItems('reactions', 10)).toEqual([]);
    expect(store.localContent(`${ACCOUNT}:chat-1`)?.chunks).toEqual([REACTED_MESSAGE]);
    expect(store.searchItems('Jane Doe', 10)[0]?.sourceItem.providerItemId).toBe('chat-1');
    store.close();
  });

  test('reaction content is content tier: never in counts-only summaries or the routed membrane', async () => {
    const store = newChatStore();
    const summary = await store.syncFromConnector(
      createChatConnector([reactedChatItem(THUMBS_UP_BY_TWO)]),
      { fetchContent: true },
    );
    const embed = await store.embedChunks({ provider: createFakeEmbeddingProvider() });
    const response = await createConnectorStoreCorpusAdapter({ store })(corpusRequest(store, 'school form'));
    assertNoForbiddenKeys(response);
    expect(response.hits).toHaveLength(1);

    for (const [label, surface] of [
      ['sync summary', summary],
      ['embed summary', embed],
      ['routed search response', response],
    ] as const) {
      const serialized = JSON.stringify(surface);
      expect(`${label}: ${serialized.includes('👍')}`).toBe(`${label}: false`);
      expect(`${label}: ${serialized.includes('Ada Lovelace')}`).toBe(`${label}: false`);
      expect(`${label}: ${serialized.includes('Reactions')}`).toBe(`${label}: false`);
    }
    store.close();
  });

  test('refuses an unbounded or malformed aggregate on write without echoing content', async () => {
    const store = newChatStore();
    await store.syncFromConnector(createChatConnector([reactedChatItem([{ key: '👍', count: 1 }])]), {
      fetchContent: true,
    });

    const secretToken = 'custom:private-project-codename';
    let refusal: unknown;
    try {
      await store.syncFromConnector(
        createChatConnector([reactedChatItem([{ key: secretToken.padEnd(200, 'x'), count: 1 }])]),
        { fetchContent: true },
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(SourceReactionValidationError);
    expect((refusal as SourceReactionValidationError).refusal).toBe('key_too_long');
    expect((refusal as Error).message).not.toContain('private-project-codename');

    await expect(store.syncFromConnector(
      createChatConnector([reactedChatItem('👍👍')]),
      { fetchContent: true },
    )).rejects.toThrow('must be an array');

    // Refused writes never landed: the previously accepted aggregate stands.
    expect(store.itemReactions(`${ACCOUNT}:chat-1`)).toEqual([{ key: '👍', count: 1 }]);
    store.close();
  });
});

describe('createConnectorStoreCorpusAdapter', () => {
  test('finds items with operator-word and hyphenated-token queries, membrane-safe', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES]]), { fetchContent: true });
    const adapter = createConnectorStoreCorpusAdapter({ store });

    // FTS5 operator words in a natural query are matched as tokens, not syntax.
    const operatorResponse = await adapter(corpusRequest(store, 'retro AND lancedb'));
    expect(operatorResponse.hits.length).toBeGreaterThan(0);
    expect(operatorResponse.hits[0]!.sourceItem.providerItemId).toBe('id:retro');

    // Hyphen/underscore-ridden tokens (date-prefixed filenames) still match.
    const hyphenResponse = await adapter(corpusRequest(store, '2026-04-22_retro'));
    expect(hyphenResponse.hits).toHaveLength(1);
    expect(hyphenResponse.hits[0]!.sourceItem.providerItemId).toBe('id:retro');

    for (const response of [operatorResponse, hyphenResponse]) {
      // No raw text/snippet keys anywhere in the routed output, recursively.
      assertNoForbiddenKeys(response);
      expect(response.rawExposed).toBe(false);
      const hit = response.hits[0]!;
      expect(hit.rawExposed).toBe(false);
      // Citation carries the title; the locator uri stays OUT of the routed lane.
      expect(hit.provenance?.citation?.title).toBe('2026-04-22_retro-notes.md');
      expect(hit.provenance?.citation?.uri).toBeUndefined();
      expect(JSON.stringify(response)).not.toContain('/Approved');
      expect(JSON.stringify(response)).not.toContain('LanceDB for unified search');
      // Lane audit reflects the local FTS5 keyword lane.
      expect(response.laneAudits?.[0]?.laneType).toBe('keyword');
      expect(response.laneAudits?.[0]?.backend).toBe('sqlite_fts5');
      expect(response.laneAudits?.[0]?.localOnly).toBe(true);
    }
    store.close();
  });

  test('refuses requests for a different corpus or trust domain', () => {
    const store = newStore();
    const adapter = createConnectorStoreCorpusAdapter({ store });
    const otherCorpus = defineConnectorCorpus({ corpusId: 'internal.other.files', family: 'file', trustDomain: 'internal' });
    expect(() => adapter({
      query: 'q',
      maxResults: 5,
      corpus: otherCorpus,
      context: { allowedTrustDomains: ['internal'] },
    })).toThrow('cannot serve corpus');
    store.close();
  });

  // Regression for the 2026-07-05 "Test 15" miss: a chat message that
  // arrived seconds ago must reach the candidate cut even when many older
  // items outrank it lexically and no embedding exists for it yet.
  test('chat stores fuse a recency lane so the newest message always competes', async () => {
    const store = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'secure_local.fakechat.messages',
      family: 'chat',
      trustDomain: 'secure_local',
    });
    // sentAt (the chat-family metadata idiom) must map to authored_at so
    // recency ordering and citation times work for live chat connectors.
    const chatItem = (id: string, text: string, sentAt: string): RawItem => ({
      identity: {
        family: 'chat',
        provider: 'fakechat',
        accountScope: ACCOUNT,
        providerItemId: id,
        localItemId: `${ACCOUNT}:${id}`,
        sourceVersion: 'v1',
      },
      mimeType: 'text/plain',
      content: { kind: 'text', text },
      metadata: Object.freeze({ sentAt }),
      fetchedAt: sentAt,
    });
    const older = Array.from({ length: 12 }, (_, index) =>
      chatItem(`old-${index}`, `test message number ${index} about the test run`, `2026-07-01T10:${String(10 + index).padStart(2, '0')}:00.000Z`));
    const newest = chatItem('fresh', 'totally unrelated fresh arrival', '2026-07-05T22:08:31.000Z');
    // Newer than 'fresh' but chunk-less (media awaiting transcription): the
    // recency lane must skip it rather than pin an extraction gap.
    const chunkless: RawItem = {
      ...chatItem('voice-note', '', '2026-07-05T22:30:00.000Z'),
      content: { kind: 'metadata_only' },
    };
    const connector: SourceConnector = {
      id: 'fakechat',
      family: 'chat',
      async authenticate() {},
      listItems(): AsyncIterable<SourceConnectorListPage> {
        return (async function* (): AsyncGenerator<SourceConnectorListPage> {
          yield { items: [...older, newest, chunkless], done: true };
        })();
      },
      async fetchItem(localItemId: string): Promise<RawItem> {
        const all = [...older, newest, chunkless];
        const found = all.find((item) => item.identity.localItemId === localItemId);
        if (!found) throw new Error(`no item ${localItemId}`);
        return found;
      },
      classify() {
        return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
      },
    };
    await store.syncFromConnector(connector, { fetchContent: true });
    const adapter = createConnectorStoreCorpusAdapter({ store });

    // Query matches the 12 OLDER items strongly and the newest not at all.
    const response = await adapter({
      query: 'test',
      maxResults: 5,
      corpus: defineConnectorCorpus({ corpusId: store.corpusId, family: 'chat', trustDomain: 'secure_local' }),
      context: { allowedTrustDomains: ['secure_local'] },
    });
    const ids = response.hits.map((hit) => hit.sourceItem.providerItemId);
    expect(ids).toContain('fresh');
    const laneNames = (response.laneAudits ?? []).map((audit) => audit.laneName);
    expect(laneNames).toContain('secure_local.fakechat.messages:connector_store_recency');
    // sentAt reached authored_at: the fresh hit's citation carries the time
    // (temporal evidence ordering depends on it).
    const freshHit = response.hits.find((hit) => hit.sourceItem.providerItemId === 'fresh')!;
    expect(freshHit.provenance?.citation?.authoredAt).toBe('2026-07-05T22:08:31.000Z');
    // recentItems returns newest-first, skips chunk-less items, and is capped.
    const recent = store.recentItems(3);
    expect(recent[0]!.sourceItem.providerItemId).toBe('fresh');
    expect(recent.map((row) => row.sourceItem.providerItemId)).not.toContain('voice-note');
    expect(recent).toHaveLength(3);
    assertNoForbiddenKeys(response);
    store.close();

    // Non-chat families do NOT pay for the recency lane.
    const fileStore = newStore();
    await fileStore.syncFromConnector(createFakeConnector([[RETRO, GROCERIES]]), { fetchContent: true });
    const fileAdapter = createConnectorStoreCorpusAdapter({ store: fileStore });
    const fileResponse = await fileAdapter(corpusRequest(fileStore, 'retro'));
    const fileLanes = (fileResponse.laneAudits ?? []).map((audit) => audit.laneName);
    expect(fileLanes.some((name) => name.includes('recency'))).toBe(false);
    fileStore.close();
  });
});

describe('createConnectorStoreContentProvider', () => {
  test('returns bounded chunks, item sensitivity, locator, and truncation', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO]]), { fetchContent: true });
    const provider = createConnectorStoreContentProvider({ store });
    const provenance = {
      sourceItem: {
        family: 'file' as const,
        provider: 'fake',
        accountScope: ACCOUNT,
        providerItemId: RETRO.id,
        localItemId: `${ACCOUNT}:${RETRO.id}`,
      },
    };

    const full = await provider.fetchLocalContent({ provenance, trustDomain: 'secure_local' });
    expect(full?.chunks.join('')).toContain('LanceDB');
    expect(full?.sensitivity.trustDomain).toBe('secure_local');
    expect(full?.sensitivity.trustTier).toBe('S4');
    expect(full?.sensitivity.localOnly).toBe(true);
    expect(full?.locatorUri).toBe('/Approved/2026-04-22_retro-notes.md');
    expect(full?.truncated).toBeUndefined();

    const bounded = await provider.fetchLocalContent({ provenance, trustDomain: 'secure_local', maxChars: 10 });
    expect(bounded?.chunks.join('')).toHaveLength(10);
    expect(bounded?.truncated).toBe(true);

    // Unknown items yield undefined so the pack records an honest gap.
    const missing = await provider.fetchLocalContent({
      provenance: { sourceItem: { ...provenance.sourceItem, providerItemId: 'id:nope', localItemId: `${ACCOUNT}:id:nope` } },
      trustDomain: 'secure_local',
    });
    expect(missing).toBeUndefined();

    // Cross-domain content requests are refused outright (fail closed).
    await expect(provider.fetchLocalContent({ provenance, trustDomain: 'internal' })).rejects.toThrow('refused');
    store.close();
  });
});

// --- Fake embedding provider (deterministic planted vectors) ------------------

const EMBED_DIMENSION = 4;

// Concept axes: [LanceDB/unified-search, cats, groceries, everything-else].
// Patterns are checked in order; the first match wins.
const PLANTED_VECTORS: ReadonlyArray<{ pattern: RegExp; vector: number[] }> = [
  { pattern: /lancedb|unified search|vector database/i, vector: [1, 0, 0, 0] },
  { pattern: /\bcat\b|feline|kitten|purr/i, vector: [0, 1, 0, 0] },
  { pattern: /milk|eggs|bread|grocer/i, vector: [0, 0, 1, 0] },
];

function plantedVector(text: string): number[] {
  for (const planted of PLANTED_VECTORS) {
    if (planted.pattern.test(text)) return [...planted.vector];
  }
  return [0, 0, 0, 1];
}

type FakeEmbeddingProvider = SourceEmbeddingProvider & { embedCalls: SourceEmbeddingInput[][] };

function createFakeEmbeddingProvider(
  options: {
    backend?: 'local' | 'cloud';
    modelId?: string;
    vectorFor?: (text: string, taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY') => number[];
  } = {},
): FakeEmbeddingProvider {
  const embedCalls: SourceEmbeddingInput[][] = [];
  const backend = options.backend ?? 'local';
  const modelId = options.modelId ?? 'fake-embed-v1';
  return {
    provider: 'fake-test-embeddings',
    modelId,
    dimension: EMBED_DIMENSION,
    configHash: 'fake-test-embeddings-config',
    epochId: `${backend}:fake-test-embeddings:${modelId}:${EMBED_DIMENSION}`,
    backend,
    embedCalls,
    async embed(
      inputs: SourceEmbeddingInput[],
      embedOptions: { taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' },
    ): Promise<number[][]> {
      embedCalls.push(inputs);
      return inputs.map((input) => {
        const text = `${input.title ?? ''}\n${input.text}`;
        return options.vectorFor?.(text, embedOptions.taskType) ?? plantedVector(text);
      });
    },
  };
}

function createRelevanceEmbeddingProvider(): FakeEmbeddingProvider {
  return createFakeEmbeddingProvider({
    modelId: 'fake-relevance-v1',
    vectorFor(text, taskType) {
      if (taskType === 'RETRIEVAL_QUERY') return [1, 0, 0, 0];
      if (/high-semantic/i.test(text)) return [0.6, 0.8, 0, 0];
      return [1 / 3, Math.sqrt(8 / 9), 0, 0];
    },
  });
}

const LOW_SEMANTIC: FakeItemSpec = {
  id: 'id:low-semantic',
  name: 'low-semantic.md',
  text: 'apple orchard harvest notes',
};

const HIGH_SEMANTIC: FakeItemSpec = {
  id: 'id:high-semantic',
  name: 'high-semantic.md',
  text: 'high-semantic observatory notes',
};

// Semantically about cats, lexically disjoint from the query "feline companion".
const CAT: FakeItemSpec = {
  id: 'id:cat',
  name: 'pets.md',
  text: 'Our cat purrs on the sofa.',
  locatorUri: '/Approved/pets.md',
};
// Keyword-only hit for "unified search": shares tokens, planted off-concept.
const SEARCH_IDEAS: FakeItemSpec = {
  id: 'id:search-ideas',
  name: 'search-ideas.md',
  text: 'unified namespace search plans for the wiki',
  locatorUri: '/Approved/search-ideas.md',
};
// Vector-only hit for "unified search": no shared tokens, planted on-concept.
const LANCE_EVAL: FakeItemSpec = {
  id: 'id:lance-eval',
  name: 'db-eval.md',
  text: 'LanceDB evaluation notes',
  locatorUri: '/Approved/db-eval.md',
};

describe('LocalConnectorStore embeddings', () => {
  test('sync-and-embed batches more than 25,000 ids without advancing past unembedded items', async () => {
    const itemCount = 25_001;
    const finalItemId = `item-${itemCount - 1}`;
    const items: RawItem[] = Array.from({ length: itemCount }, (_, index) => {
      const admitted = index === itemCount - 1;
      return {
        identity: {
          family: 'file',
          provider: 'fake-cap',
          accountScope: ACCOUNT,
          providerItemId: `item-${index}`,
          localItemId: `${ACCOUNT}:item-${index}`,
        },
        mimeType: 'text/plain',
        content: { kind: 'text', text: `bounded item ${index}` },
        metadata: Object.freeze({
          pathDisplay: admitted ? `/admit/${finalItemId}` : `/skip/item-${index}`,
        }),
        fetchedAt: '2026-07-29T00:00:00.000Z',
      };
    });
    const connector: SourceConnector = {
      id: 'fake-cap',
      family: 'file',
      async authenticate() {},
      listItems(): AsyncIterable<SourceConnectorListPage> {
        return (async function* (): AsyncGenerator<SourceConnectorListPage> {
          yield { items, nextCursor: 'cursor-after-25001', done: true };
        })();
      },
      async fetchItem(localItemId: string) {
        const index = Number(localItemId.slice(`${ACCOUNT}:item-`.length));
        const found = items[index];
        if (!found) throw new Error('missing cap fixture item');
        return found;
      },
      classify() {
        return buildSourceSensitivity({ trustTier: 'S4', trustDomain: 'secure_local' });
      },
    };
    const directory = mkdtempSync(join(tmpdir(), 'olympus-connector-real-embed-cap-'));
    const dbPath = join(directory, 'connector.sqlite');
    const store = new LocalConnectorStore({
      dbPath,
      corpusId: CORPUS_ID,
      family: 'file',
      trustDomain: 'secure_local',
      exclusions: createSourceExclusionMatcher({
        schemaVersion: 1,
        rules: [{
          id: 'skip-cap-prefix',
          mode: 'exclude',
          sources: ['fake-cap'],
          path_prefixes: ['/skip'],
          folder_ids: [],
          reason: 'keep the real-store cap fixture bounded',
        }],
      }, 'fake-cap'),
    });
    const provider = createFakeEmbeddingProvider();

    const result = await syncAndEmbedFromConnector({
      store,
      connector,
      embeddingProvider: provider,
      sync: { fetchContent: true },
    });

    expect(result.sync.cursor).toBe('cursor-after-25001');
    expect(store.lastCompletedSyncRun('fake-cap')?.cursor).toBe('cursor-after-25001');
    expect(result.sync).toMatchObject({
      itemsSeen: itemCount,
      itemsIndexed: 1,
      itemsExcluded: 25_000,
    });
    expect(result.embed).toMatchObject({
      chunksSeen: 1,
      chunksEmbedded: 1,
      chunksSkipped: 0,
    });
    expect(store.status().counts).toMatchObject({
      items: 1,
      chunks: 1,
      embeddedChunks: 1,
    });
    expect(store.searchItems('bounded', 10).map(
      (row) => row.sourceItem.providerItemId,
    )).toEqual([finalItemId]);
    expect(provider.embedCalls).toHaveLength(1);
    store.close();
  }, 15_000);

  test('embeds un-embedded chunks, then re-embed is a no-op via the content_hash guard', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES, CAT]]), { fetchContent: true });
    expect(store.status().counts.embeddedChunks).toBe(0);

    const provider = createFakeEmbeddingProvider();
    const first = await store.embedChunks({ provider });
    expect(first.corpusId).toBe(CORPUS_ID);
    expect(first.modelId).toBe('fake-embed-v1');
    expect(first.embeddingBackend).toBe('local');
    expect(first.embeddingDimension).toBe(EMBED_DIMENSION);
    expect(first.chunksSeen).toBe(3);
    expect(first.chunksEmbedded).toBe(3);
    expect(first.chunksSkipped).toBe(0);
    expect(first.policy.trustDomain).toBe('secure_local');
    expect(store.status().counts.embeddedChunks).toBe(3);

    // Idempotent: unchanged content embeds nothing and never calls the provider.
    const second = await store.embedChunks({ provider });
    expect(second.chunksEmbedded).toBe(0);
    expect(second.chunksSkipped).toBe(3);
    expect(provider.embedCalls).toHaveLength(1);

    // Changed content re-embeds ONLY the changed item's chunks.
    await store.syncFromConnector(
      createFakeConnector([[{ ...CAT, text: 'Our cat naps near the kitten basket.' }]]),
      { fetchContent: true },
    );
    const third = await store.embedChunks({ provider });
    expect(third.chunksEmbedded).toBe(1);
    expect(third.chunksSkipped).toBe(2);
    expect(store.status().counts.embeddedChunks).toBe(3);
    store.close();
  });

  // The dashboard's embedding bar divides in FILES, not chunks. status() is
  // where that numerator has to come from, because only the store knows which
  // of an item's chunks still carry a current vector.
  test('status counts an item embedded only when every one of its chunks is current', async () => {
    const store = newStore();
    // maxChunkChars is what makes the two-chunk item deterministic: a
    // part-embedded multi-chunk file is the exact shape a chunk ratio hides.
    await store.syncFromConnector(createFakeConnector([[
      { id: 'id:whole', name: 'whole.md', text: 'aaaaa' },
      { id: 'id:partial', name: 'partial.md', text: 'bbbbbccccc' },
      { id: 'id:no-chunks', name: 'no-chunks.pdf' },
    ]]), { fetchContent: true, maxChunkChars: 5 });
    expect(store.status().counts).toMatchObject({
      items: 3,
      chunks: 3,
      embeddedChunks: 0,
      itemsWithText: 2,
    });
    // No model holds a vector here yet, so there is no per-model parity row.
    expect(store.status().embeddingByModel).toEqual([]);

    const provider = createFakeEmbeddingProvider();
    expect(await store.embedChunks({
      provider,
      localItemIds: [`${ACCOUNT}:id:whole`],
    })).toMatchObject({ chunksEmbedded: 1 });
    // One of the two-chunk item's chunks only: the file is now half embedded.
    expect(await store.embedChunks({
      provider,
      localItemIds: [`${ACCOUNT}:id:partial`],
      limit: 1,
    })).toMatchObject({ chunksEmbedded: 1 });

    expect(store.status().counts).toMatchObject({
      items: 3,
      chunks: 3,
      // Two of three chunks: the chunk ratio reads 67% embedded...
      embeddedChunks: 2,
      itemsWithText: 2,
    });
    // ...while exactly one of three files actually is, on the one model that
    // embedded anything. The half-embedded item and the item with no chunks
    // at all are both excluded.
    expect(store.status().embeddingByModel).toEqual([
      { modelId: 'fake-embed-v1', embeddedChunks: 2, itemsEmbedded: 1 },
    ]);
    store.close();
  });

  test('refreshes only embeddings whose metadata-seasoned input changed', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES]]), { fetchContent: true });
    const provider = createFakeEmbeddingProvider();
    expect(await store.embedChunks({ provider })).toMatchObject({ chunksEmbedded: 2 });

    const unchanged = await store.syncFromConnector(
      createFakeConnector([[RETRO, GROCERIES]]),
      { fetchContent: true },
    );
    expect(unchanged.chunksIndexed).toBe(0);
    expect(await store.embedChunks({ provider })).toMatchObject({
      chunksEmbedded: 0,
      chunksSkipped: 2,
    });

    const renamed = { ...RETRO, name: 'renamed-retro-context.md' };
    const metadataOnly = await store.syncFromConnector(
      createFakeConnector([[renamed]]),
      { fetchContent: true },
    );
    expect(metadataOnly.chunksIndexed).toBe(0);
    const refreshed = await store.embedChunks({ provider });
    expect(refreshed).toMatchObject({ chunksEmbedded: 1, chunksSkipped: 1 });
    expect(provider.embedCalls.at(-1)?.[0]?.text).toContain('renamed-retro-context.md');
    store.close();
  });

  test('honors the limit option and drains the rest on the next pass', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES, CAT]]), { fetchContent: true });
    const provider = createFakeEmbeddingProvider();

    const bounded = await store.embedChunks({ provider, limit: 1 });
    expect(bounded.chunksEmbedded).toBe(1);
    expect(store.status().counts.embeddedChunks).toBe(1);

    const drained = await store.embedChunks({ provider });
    expect(drained.chunksEmbedded).toBe(2);
    expect(drained.chunksSkipped).toBe(1);
    expect(store.status().counts.embeddedChunks).toBe(3);
    store.close();
  });

  test('embeds only explicitly selected local item ids for incremental source latency', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES, CAT]]), { fetchContent: true });
    const provider = createFakeEmbeddingProvider();

    const selected = await store.embedChunks({
      provider,
      localItemIds: [`${ACCOUNT}:id:cat`],
    });
    expect(selected).toMatchObject({ chunksSeen: 1, chunksEmbedded: 1, chunksSkipped: 0 });
    expect(provider.embedCalls).toHaveLength(1);
    expect(provider.embedCalls[0]?.[0]?.text).toContain('purrs on the sofa');
    expect(store.status().counts.embeddedChunks).toBe(1);

    const empty = await store.embedChunks({ provider, localItemIds: [] });
    expect(empty).toMatchObject({ chunksSeen: 0, chunksEmbedded: 0, chunksSkipped: 0 });
    expect(provider.embedCalls).toHaveLength(1);
    store.close();
  });

  test('rejects a model id mismatch', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO]]), { fetchContent: true });
    const provider = createFakeEmbeddingProvider();
    await expect(store.embedChunks({ provider, modelId: 'some-other-model' }))
      .rejects.toThrow('not requested model');
    store.close();
  });

  test('secure_local stores ONLY embed via a local provider; internal stores may use cloud', async () => {
    const cloud = createFakeEmbeddingProvider({ backend: 'cloud' });

    // secure_local: both the embed lane and the vector search lane fail closed.
    const secureStore = newStore();
    await secureStore.syncFromConnector(createFakeConnector([[RETRO]]), { fetchContent: true });
    await expect(secureStore.embedChunks({ provider: cloud })).rejects.toThrow('local/private');
    await expect(secureStore.vectorSearchItems('unified search', cloud, 5)).rejects.toThrow('local/private');
    expect(secureStore.status().counts.embeddedChunks).toBe(0);
    secureStore.close();

    // internal trust domain: cloud embedding is eligible (the x-bookmarks posture).
    const internalStore = new LocalConnectorStore({
      dbPath: ':memory:',
      corpusId: 'internal.fake.files',
      family: 'file',
      trustDomain: 'internal',
    });
    const internalItem: FakeItemSpec = { ...RETRO, trustDomain: 'internal', trustTier: 'S2' };
    await internalStore.syncFromConnector(createFakeConnector([[internalItem]]), { fetchContent: true });
    const summary = await internalStore.embedChunks({ provider: cloud });
    expect(summary.chunksEmbedded).toBe(1);
    expect(summary.embeddingBackend).toBe('cloud');
    internalStore.close();
  });

  // The availability probe asks "does model X hold any current vector" on
  // every dashboard poll. A model just switched to holds none, and without a
  // model-leading index that question is a scan of the OLD model's vectors.
  test('indexes chunk_embeddings by model so the availability probe is a point read', () => {
    const directory = mkdtempSync(join(tmpdir(), 'olympus-connector-model-index-'));
    const dbPath = join(directory, 'connector.sqlite');
    const store = newStore(dbPath);
    store.close();
    const raw = new Database(dbPath, { readonly: true });
    try {
      const index = raw.query(`
        SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'chunk_embeddings' AND name = ?
      `).get('idx_connector_store_chunk_embeddings_model') as { name: string; sql: string } | null;
      expect(index?.sql.replace(/\s+/g, ' ')).toContain('ON chunk_embeddings(model_id)');
      const plan = raw.query(`
        EXPLAIN QUERY PLAN
        SELECT 1 AS present
        FROM chunk_embeddings emb
        JOIN chunks c ON c.chunk_pk = emb.chunk_pk
        JOIN items i ON i.item_pk = emb.item_pk
        WHERE emb.model_id = ?
          AND i.tombstoned = 0
          AND emb.content_hash = c.embedding_input_hash
        LIMIT 1
      `).all('never-seen-model') as Array<{ detail: string }>;
      const embeddingStep = plan.find((step) => / emb\b/.test(step.detail));
      expect(embeddingStep?.detail).toMatch(/^SEARCH emb USING (COVERING )?INDEX idx_connector_store_chunk_embeddings_model \(model_id=\?\)/);
    } finally {
      raw.close();
    }
  });

  // Parity is a claim about ONE model. An item whose chunks carry vectors
  // from two different models is embedded for neither — retrieval serves a
  // single model — and a chunk ratio across models would hide exactly that.
  test('per-model parity never counts an item whose chunks are split across models', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[
      { id: 'id:whole', name: 'whole.md', text: 'aaaaa' },
      { id: 'id:split', name: 'split.md', text: 'bbbbbccccc' },
    ]]), { fetchContent: true, maxChunkChars: 5 });

    const modelA = createFakeEmbeddingProvider();
    const modelB = createFakeEmbeddingProvider({ modelId: 'fake-embed-v2' });
    // whole: fully on A. split: one chunk on A, then one chunk on B.
    expect(await store.embedChunks({ provider: modelA, localItemIds: [`${ACCOUNT}:id:whole`] }))
      .toMatchObject({ chunksEmbedded: 1 });
    expect(await store.embedChunks({ provider: modelA, localItemIds: [`${ACCOUNT}:id:split`], limit: 1 }))
      .toMatchObject({ chunksEmbedded: 1 });
    expect(await store.embedChunks({ provider: modelB, localItemIds: [`${ACCOUNT}:id:split`], limit: 1 }))
      .toMatchObject({ chunksEmbedded: 1 });

    const byModel = store.status().embeddingByModel;
    const forA = byModel.find((entry) => entry.modelId === 'fake-embed-v1');
    const forB = byModel.find((entry) => entry.modelId === 'fake-embed-v2');
    // A holds whole (1 chunk) and one chunk of split; only whole is complete.
    expect(forA).toMatchObject({ embeddedChunks: 2, itemsEmbedded: 1 });
    // B holds one chunk of split and nothing else: no item is complete on B.
    expect(forB).toMatchObject({ embeddedChunks: 1, itemsEmbedded: 0 });
    // The model-agnostic chunk count still sees three vectors, which is why
    // it cannot stand in for per-item, per-model parity.
    expect(store.status().counts.embeddedChunks).toBe(3);
    store.close();
  });
});

describe('LocalConnectorStore search-text repair', () => {
  // Inline text, so the store derives items.content_hash and
  // currentItemRepresentationCoverage can report on these items at all.
  const REPAIR_A: FakeItemSpec = {
    id: 'id:repair-a',
    name: 'repair-a.md',
    inlineText: 'unified namespace search plans for the wiki',
  };
  const REPAIR_B: FakeItemSpec = {
    id: 'id:repair-b',
    name: 'repair-b.md',
    inlineText: 'grocery run: olives, bread, and coffee',
  };
  const identityOf = (id: string) => ({
    family: 'file' as const,
    provider: 'fake',
    accountScope: ACCOUNT,
    providerItemId: id,
    localItemId: `${ACCOUNT}:${id}`,
  });

  // search_text is the `Context:` line of the embedding input, so a repair that
  // rewrites it changes what every chunk of that item would embed to. The
  // repair used to leave embedding_input_hash alone, which left the rewritten
  // chunks satisfying the currency rule against vectors computed over the old
  // string — the drain then skipped them forever.
  test('invalidates the embeddings of exactly the items it repaired', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[REPAIR_A, REPAIR_B]]), { fetchContent: true });

    // Settle search_text at its fixed point first, so the repair under test is
    // driven only by the supplemental text below.
    store.repairSearchTextFromChunks({ provider: 'fake' });
    const provider = createFakeEmbeddingProvider();
    expect(await store.embedChunks({ provider })).toMatchObject({ chunksEmbedded: 2 });
    for (const spec of [REPAIR_A, REPAIR_B]) {
      expect(store.currentItemRepresentationCoverage(identityOf(spec.id), provider.modelId))
        .toMatchObject({ chunksEmbeddingCurrent: 1, embeddingsComplete: true });
    }

    const repaired = store.repairSearchTextFromChunks({
      provider: 'fake',
      supplementalSearchText: (identity) =>
        identity.providerItemId === REPAIR_A.id ? ['attachment: quarterly-notes.pdf'] : [],
    });
    expect(repaired.counts).toMatchObject({
      itemsScanned: 2,
      itemsRepaired: 1,
      itemsUnchanged: 1,
      chunkEmbeddingInputsInvalidated: 1,
    });

    // The repaired item's vector no longer counts as current...
    expect(store.currentItemRepresentationCoverage(identityOf(REPAIR_A.id), provider.modelId))
      .toMatchObject({ chunksEmbeddingCurrent: 0, embeddingsComplete: false });
    // ...and the untouched item's still does. Over-invalidating here would bill
    // a real host for re-embedding a corpus that is fine.
    expect(store.currentItemRepresentationCoverage(identityOf(REPAIR_B.id), provider.modelId))
      .toMatchObject({ chunksEmbeddingCurrent: 1, embeddingsComplete: true });

    // The ordinary drain picks the repaired chunk up with no special handling,
    // and re-embeds only it.
    const drained = await store.embedChunks({ provider });
    expect(drained).toMatchObject({ chunksEmbedded: 1, chunksSkipped: 1 });
    expect(provider.embedCalls.at(-1)?.[0]?.text).toContain('quarterly-notes.pdf');
    for (const spec of [REPAIR_A, REPAIR_B]) {
      expect(store.currentItemRepresentationCoverage(identityOf(spec.id), provider.modelId))
        .toMatchObject({ embeddingsComplete: true });
    }
    store.close();
  });

  // A repair pass that rewrites nothing must book no re-embed at all.
  test('books no re-embed when the repair changes no search text', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[REPAIR_A, REPAIR_B]]), { fetchContent: true });
    store.repairSearchTextFromChunks({ provider: 'fake' });
    const provider = createFakeEmbeddingProvider();
    await store.embedChunks({ provider });

    const idempotent = store.repairSearchTextFromChunks({ provider: 'fake' });
    expect(idempotent.counts).toMatchObject({
      itemsRepaired: 0,
      itemsUnchanged: 2,
      chunkEmbeddingInputsInvalidated: 0,
    });
    expect(await store.embedChunks({ provider })).toMatchObject({
      chunksEmbedded: 0,
      chunksSkipped: 2,
    });
    store.close();
  });
});

describe('createConnectorStoreCorpusAdapter hybrid retrieval', () => {
  test('an exact generic provider filter constrains title, keyword, vector, and recency lanes', async () => {
    const store = newChatStore();
    const whatsapp = chatItem({
      id: 'provider-whatsapp',
      conversationId: 'conversation-whatsapp',
      chat: 'WhatsApp Provider Room',
      sender: 'Sam',
      sentAt: '2026-07-25T06:00:00.000Z',
      text: 'Generic provider lane fixture.',
    });
    const telegramBase = chatItem({
      id: 'provider-telegram',
      conversationId: 'conversation-telegram',
      chat: 'Telegram Provider Trap',
      sender: 'Sam',
      sentAt: '2026-07-25T07:00:00.000Z',
      text: 'Generic provider lane fixture.',
    });
    const telegram: RawItem = {
      ...telegramBase,
      identity: { ...telegramBase.identity, provider: 'telegram' },
    };
    await store.syncFromConnector(createChatConnector([whatsapp, telegram]), { fetchContent: true });
    const embeddingProvider = createFakeEmbeddingProvider();
    await store.embedChunks({ provider: embeddingProvider });
    const providerFilter = { provider: 'whatsapp' };

    expect(store.searchItems('Generic provider lane fixture', 10, ACCOUNT, providerFilter)
      .map((row) => row.sourceItem.provider)).toEqual(['whatsapp']);
    expect(store.recentItems(10, ACCOUNT, providerFilter)
      .map((row) => row.sourceItem.provider)).toEqual(['whatsapp']);
    expect((await store.vectorSearchItemsWithScores(
      'Generic provider lane fixture',
      embeddingProvider,
      10,
      ACCOUNT,
      providerFilter,
    )).map((row) => row.sourceItem.provider)).toEqual(['whatsapp']);
    expect(store.conversationTitleCandidates(
      ['telegram', 'trap'],
      ACCOUNT,
      'whatsapp',
    ).candidates).toEqual([]);

    expect(store.searchItems('Generic provider lane fixture', 10, ACCOUNT)
      .map((row) => row.sourceItem.provider).sort()).toEqual(['telegram', 'whatsapp']);
    expect(store.recentItems(10, ACCOUNT)[0]?.sourceItem.provider).toBe('telegram');
    store.close();
  });

  test('declared hybrid stays loud on keyword fallback, then reports hybrid when servable', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES]]), { fetchContent: true });
    const provider = createFakeEmbeddingProvider();
    const corpus = defineConnectorCorpus({
      corpusId: store.corpusId,
      family: store.family,
      trustDomain: store.trustDomain,
      activationMode: 'hybrid_shadow',
    });
    const registry = buildSourceIndexCorpusRegistry([corpus]);
    const adapter = createConnectorStoreCorpusAdapter({ store, embeddingProvider: provider });
    const route = () => routeSourceIndexSearch({
      registry,
      adapters: { [store.corpusId]: adapter },
      request: {
        query: 'retro AND lancedb',
        maxResults: 5,
        context: { allowedTrustDomains: ['secure_local'] },
      },
      laneTimeoutMs: 0,
    });

    expect(defineConnectorCorpus({
      corpusId: 'internal.unflipped.notes',
      family: 'note',
      trustDomain: 'internal',
    }).activationMode).toBe('lexical_only');
    expect(registry.require(store.corpusId).activationMode).toBe('hybrid_shadow');

    const backfill = await route();
    expect(backfill.hits).toHaveLength(1);
    expect(backfill.laneAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        laneName: `${store.corpusId}:connector_store_fts`,
        laneType: 'keyword',
        skippedReason: 'no_embedding_artifacts',
      }),
      expect.objectContaining({
        laneName: `${store.corpusId}:retrieval_mode_enforcement`,
        backend: 'keyword',
        skippedReason: 'declared_hybrid_shadow_unservable:no_current_embedding_artifacts',
        retrievalState: expect.objectContaining({
          declaredMode: 'hybrid_shadow',
          servableMode: 'keyword',
          health: 'degraded',
          reason: 'no_current_embedding_artifacts',
        }),
      }),
    ]));

    await store.embedChunks({ provider });
    const parity = await route();
    expect(parity.laneAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        laneName: `${store.corpusId}:connector_store_vector`,
        laneType: 'semantic',
      }),
      expect.objectContaining({
        laneName: `${store.corpusId}:retrieval_mode_enforcement`,
        backend: 'hybrid',
        retrievalState: expect.objectContaining({
          declaredMode: 'hybrid_shadow',
          servableMode: 'hybrid',
          health: 'ready',
        }),
      }),
    ]));
    store.close();
  });

  test('hybrid_shadow declaration leaves keyword-pinned serving unchanged while semantic stays shadow-ready', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES]]), { fetchContent: true });
    const provider = createFakeEmbeddingProvider();
    await store.embedChunks({ provider });
    const adapter = createConnectorStoreCorpusAdapter({
      store,
      embeddingProvider: provider,
      retrievalMode: 'keyword',
    });
    const route = (activationMode: 'lexical_only' | 'hybrid_shadow') => routeSourceIndexSearch({
      registry: buildSourceIndexCorpusRegistry([defineConnectorCorpus({
        corpusId: store.corpusId,
        family: store.family,
        trustDomain: store.trustDomain,
        activationMode,
      })]),
      adapters: { [store.corpusId]: adapter },
      request: {
        query: 'retro AND lancedb',
        maxResults: 5,
        context: { allowedTrustDomains: ['secure_local'] },
      },
      laneTimeoutMs: 0,
    });

    const lexical = await route('lexical_only');
    const shadow = await route('hybrid_shadow');

    expect(shadow.hits).toEqual(lexical.hits);
    expect(shadow.laneAudits.some((lane) => lane.laneType === 'semantic')).toBe(false);
    expect(shadow.laneAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        laneName: `${store.corpusId}:retrieval_mode_enforcement`,
        backend: 'hybrid',
        retrievalState: expect.objectContaining({
          declaredMode: 'hybrid_shadow',
          servableMode: 'hybrid',
          health: 'ready',
        }),
      }),
    ]));
    store.close();
  });

  test('vector lane finds a semantically relevant doc the keyword lane misses, membrane-safe', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES, CAT]]), { fetchContent: true });
    const provider = createFakeEmbeddingProvider();
    await store.embedChunks({ provider });

    // Keyword baseline: "feline companion" shares no tokens with any doc.
    const keywordOnly = createConnectorStoreCorpusAdapter({ store });
    const keywordResponse = await keywordOnly(corpusRequest(store, 'feline companion'));
    expect(keywordResponse.hits).toHaveLength(0);

    const adapter = createConnectorStoreCorpusAdapter({ store, embeddingProvider: provider });
    const response = await adapter(corpusRequest(store, 'feline companion'));
    expect(response.hits).toHaveLength(1);
    expect(response.hits[0]!.sourceItem.providerItemId).toBe('id:cat');
    expect(response.hits[0]!.provenance?.citation?.title).toBe('pets.md');

    // Per-lane audits: keyword / vector / fused candidate counts.
    expect(response.laneAudits).toHaveLength(3);
    const [keywordLane, vectorLane, fusedLane] = response.laneAudits!;
    expect(keywordLane!.laneType).toBe('keyword');
    expect(keywordLane!.candidateCount).toBe(0);
    expect(vectorLane!.laneType).toBe('semantic');
    expect(vectorLane!.candidateCount).toBe(1);
    expect(vectorLane!.modelId).toBe('fake-embed-v1');
    expect(vectorLane!.backend).toBe('exact_scan');
    expect(vectorLane!.localOnly).toBe(true);
    expect(fusedLane!.laneType).toBe('hybrid');
    expect(fusedLane!.candidateCount).toBe(1);
    expect(fusedLane!.returnedCount).toBe(1);

    // Same membrane as the keyword lane: no raw text, no locator.
    assertNoForbiddenKeys(response);
    expect(response.rawExposed).toBe(false);
    expect(JSON.stringify(response)).not.toContain('/Approved');
    expect(JSON.stringify(response)).not.toContain('purrs on the sofa');

    // Tombstoned items drop out of the vector lane with their embeddings.
    await store.syncFromConnector(createFakeConnector([[{ ...CAT, deleted: true }]]));
    expect(store.status().counts.embeddedChunks).toBe(2);
    const afterTombstone = await adapter(corpusRequest(store, 'feline companion'));
    expect(afterTombstone.hits).toHaveLength(0);
    store.close();
  });

  test('an exhausted vector deadline returns keyword evidence and an honest semantic skip', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'olympus-vector-deadline-'));
    const store = newStore(join(directory, 'connector.sqlite'));
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES]]), { fetchContent: true });
    const provider = createFakeEmbeddingProvider();
    await store.embedChunks({ provider });

    const request = {
      ...corpusRequest(store, 'retro lancedb'),
      deadlineAtMs: Date.now() - 1,
    };
    const response = await createConnectorStoreCorpusAdapter({
      store,
      embeddingProvider: provider,
      retrievalMode: 'hybrid',
    })(request);

    expect(response.hits.map((hit) => hit.sourceItem.providerItemId)).toContain(RETRO.id);
    expect(response.laneAudits).toContainEqual(expect.objectContaining({
      laneType: 'semantic',
      candidateCount: 0,
      returnedCount: 0,
      skippedReason: 'vector_scan_deadline_exceeded',
      rawExposed: false,
    }));
    store.close();
  });

  test('exact-vector scans yield between bounded pages', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'olympus-vector-pages-'));
    const store = newStore(join(directory, 'connector.sqlite'));
    const items: FakeItemSpec[] = Array.from({ length: 257 }, (_, index) => ({
      id: `id:paged-${index}`,
      name: `paged-${index}.md`,
      inlineText: `shared retrieval paging fixture ${index}`,
    }));
    await store.syncFromConnector(createFakeConnector([items]), { fetchContent: true });
    const provider = createFakeEmbeddingProvider();
    await store.embedChunks({ provider });

    let timerFired = false;
    const timer = setTimeout(() => {
      timerFired = true;
    }, 0);
    const response = await createConnectorStoreCorpusAdapter({
      store,
      embeddingProvider: provider,
      retrievalMode: 'hybrid',
    })({
      ...corpusRequest(store, 'shared retrieval'),
      deadlineAtMs: Date.now() + 5_000,
    });
    clearTimeout(timer);

    expect(timerFired).toBe(true);
    expect(response.laneAudits?.find((lane) => lane.laneType === 'semantic')?.skippedReason).toBeUndefined();
    expect(response.hits.length).toBeGreaterThan(0);
    store.close();
    // Building and embedding the 257-row fixture is the behavior under test,
    // not a five-second performance contract. Loaded main runners have taken
    // just over Bun's default timeout even though the bounded scan was healthy.
  }, 15_000);

  test('gate off preserves sub-bar semantic-only hits and reports best cosine', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[LOW_SEMANTIC]]), { fetchContent: true });
    const provider = createRelevanceEmbeddingProvider();
    await store.embedChunks({ provider });

    const response = await createConnectorStoreCorpusAdapter({
      store,
      embeddingProvider: provider,
    })(corpusRequest(store, 'sourdough hydration schedule'));

    expect(response.hits.map((hit) => hit.sourceItem.providerItemId)).toEqual(['id:low-semantic']);
    expect(response.laneAudits).toContainEqual(expect.objectContaining({
      laneType: 'semantic',
      candidateCount: 1,
      returnedCount: 1,
      bestCosine: 0.3333,
    }));
    expect(response.laneAudits?.find((lane) => lane.laneType === 'semantic'))
      .not.toHaveProperty('suppressedBelowBar');
    store.close();
  });

  test('multi-concept keyword queries require two matched concepts; single-word noise drops', async () => {
    // Live incident 2026-07-25: a bookmark was cited for a four-concept
    // question because it contained the lone word "schedule". A candidate
    // matching one concept of a multi-concept query is lexical noise.
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[
      { id: 'id:noise', name: 'noise.md', text: 'quarterly planning schedule for the studio' },
      { id: 'id:real', name: 'real.md', text: 'sourdough starter hydration schedule notes' },
    ]]), { fetchContent: true });

    const filtered = store.searchItems('sourdough starter hydration schedule', 5);
    expect(filtered.map((row) => row.sourceItem.providerItemId)).toEqual(['id:real']);

    // Single-concept queries keep single-token matches: one concept is all
    // the query expresses.
    const single = store.searchItems('schedule', 5);
    expect(single.map((row) => row.sourceItem.providerItemId).sort())
      .toEqual(['id:noise', 'id:real']);
    store.close();
  });

  test('a direct multi-concept title match survives body-only FTS saturation', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[
      { id: 'id:title', name: 'reference saffron orbit archive catalog.md', text: 'catalog index' },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `id:body-${index}`,
        name: `body-${index}.md`,
        text: `${'saffron orbit archive '.repeat(2)}saffron`,
      })),
    ]]), { fetchContent: true });

    const rows = store.searchItems('saffron orbit archive', 5);
    expect(rows).toHaveLength(5);
    expect(rows[0]?.sourceItem.providerItemId).toBe('id:title');
    store.close();
  });

  test('synonym variants of one query token count as a single concept', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[
      { id: 'id:syn-only', name: 'syn.md', text: 'monthly bill payment history' },
      { id: 'id:both', name: 'both.md', text: 'invoice reminder sent yesterday' },
    ]]), { fetchContent: true });

    // "invoice" expands to bill/payment/... synonyms — matching two of those
    // still expresses ONE concept; "reminder" is the second concept.
    const rows = store.searchItems('invoice reminder', 5);
    expect(rows.map((row) => row.sourceItem.providerItemId)).toEqual(['id:both']);
    store.close();
  });

  test('keyword-empty gate suppresses every below-bar vector row and returns honest zero hits', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[LOW_SEMANTIC]]), { fetchContent: true });
    const provider = createRelevanceEmbeddingProvider();
    await store.embedChunks({ provider });

    const response = await createConnectorStoreCorpusAdapter({
      store,
      embeddingProvider: provider,
      semanticRelevanceBar: 0.45,
    })(corpusRequest(store, 'sourdough hydration schedule'));

    expect(response.hits).toEqual([]);
    expect(response.laneAudits).toContainEqual(expect.objectContaining({
      laneType: 'semantic',
      candidateCount: 1,
      returnedCount: 0,
      bestCosine: 0.3333,
      suppressedBelowBar: 1,
      skippedReason: 'semantic_below_relevance_bar',
    }));
    assertNoForbiddenKeys(response);
    store.close();
  });

  test('keyword-empty gate admits only vector rows at or above the bar', async () => {
    const store = newStore();
    await store.syncFromConnector(
      createFakeConnector([[LOW_SEMANTIC, HIGH_SEMANTIC]]),
      { fetchContent: true },
    );
    const provider = createRelevanceEmbeddingProvider();
    await store.embedChunks({ provider });

    const response = await createConnectorStoreCorpusAdapter({
      store,
      embeddingProvider: provider,
      semanticRelevanceBar: 0.45,
    })(corpusRequest(store, 'sourdough hydration schedule'));

    expect(response.hits.map((hit) => hit.sourceItem.providerItemId)).toEqual(['id:high-semantic']);
    expect(response.laneAudits).toContainEqual(expect.objectContaining({
      laneType: 'semantic',
      candidateCount: 2,
      returnedCount: 1,
      bestCosine: 0.6,
      suppressedBelowBar: 1,
    }));
    store.close();
  });

  test('the bar drops sub-bar vector rows even when keyword hits exist; keyword evidence stands alone', async () => {
    // Live calibration 2026-07-25: common-token FTS saturation gives
    // off-domain questions nonzero keyword rows, so the bar must judge the
    // vector lane unconditionally. A keyword-matched item still surfaces
    // through its keyword row; sub-bar semantic similarity contributes
    // nothing to fusion.
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[LOW_SEMANTIC]]), { fetchContent: true });
    const provider = createRelevanceEmbeddingProvider();
    await store.embedChunks({ provider });

    const response = await createConnectorStoreCorpusAdapter({
      store,
      embeddingProvider: provider,
      semanticRelevanceBar: 0.45,
    })(corpusRequest(store, 'apple'));

    expect(response.hits.map((hit) => hit.sourceItem.providerItemId)).toEqual(['id:low-semantic']);
    const vectorAudit = response.laneAudits?.find((lane) => lane.laneType === 'semantic');
    expect(vectorAudit).toMatchObject({
      candidateCount: 1,
      returnedCount: 0,
      bestCosine: 0.3333,
      suppressedBelowBar: 1,
      skippedReason: 'semantic_below_relevance_bar',
    });
    store.close();
  });

  test('chat recency hits survive when the relevance bar empties the vector lane', async () => {
    const store = newChatStore();
    await store.syncFromConnector(createChatConnector([
      chatItem({
        id: 'fresh-low-semantic',
        conversationId: 'peer-one',
        chat: 'Peer one',
        sender: 'Alex',
        sentAt: '2026-07-25T06:00:00.000Z',
        text: 'apple orchard harvest notes',
      }),
    ]), { fetchContent: true });
    const provider = createRelevanceEmbeddingProvider();
    await store.embedChunks({ provider });

    const response = await createConnectorStoreCorpusAdapter({
      store,
      embeddingProvider: provider,
      semanticRelevanceBar: 0.45,
    })(corpusRequest(store, 'sourdough hydration schedule'));

    expect(response.hits.map((hit) => hit.sourceItem.providerItemId)).toEqual(['fresh-low-semantic']);
    expect(response.laneAudits).toEqual(expect.arrayContaining([
      expect.objectContaining({
        laneType: 'semantic',
        skippedReason: 'semantic_below_relevance_bar',
        suppressedBelowBar: 1,
      }),
      expect.objectContaining({
        laneName: `${store.corpusId}:connector_store_recency`,
        candidateCount: 1,
      }),
    ]));
    store.close();
  });

  test('shared current-embedding SQL keeps probe eligibility identical to vector search', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'olympus-relevance-sql-'));
    const dbPath = join(directory, 'connector.sqlite');
    const store = newStore(dbPath);
    const provider = createRelevanceEmbeddingProvider();
    await store.syncFromConnector(
      createFakeConnector([[LOW_SEMANTIC, HIGH_SEMANTIC]]),
      { fetchContent: true },
    );
    await store.syncFromConnector(
      createFakeConnector(
        [[{ ...LOW_SEMANTIC, id: 'id:other-account' }]],
        undefined,
        { accountScope: 'other-account' },
      ),
      { fetchContent: true },
    );
    await store.embedChunks({ provider });

    const db = new Database(dbPath, { readonly: true, create: false, strict: true });
    try {
      expect(connectorStoreCurrentEmbeddingModelId(db, ACCOUNT)).toBe(provider.modelId);
      expect(connectorStoreCurrentEmbeddingRows(db, {
        modelId: provider.modelId,
      })).toHaveLength(3);
      expect(connectorStoreCurrentEmbeddingRows(db, {
        modelId: provider.modelId,
        accountScope: ACCOUNT,
      }).map((row) => row.localItemId).sort()).toEqual([
        `${ACCOUNT}:id:high-semantic`,
        `${ACCOUNT}:id:low-semantic`,
      ]);

      await store.syncFromConnector(createFakeConnector([[
        LOW_SEMANTIC,
        { ...HIGH_SEMANTIC, text: 'changed high-semantic representation' },
      ]]), { fetchContent: true });
      const eligibleAfterChange = connectorStoreCurrentEmbeddingRows(db, {
        modelId: provider.modelId,
        accountScope: ACCOUNT,
      });
      expect(eligibleAfterChange.map((row) => row.localItemId)).toEqual([
        `${ACCOUNT}:id:low-semantic`,
      ]);
      expect((await store.vectorSearchItemsWithScores(
        'sourdough hydration schedule',
        provider,
        10,
        ACCOUNT,
      )).map((row) => row.sourceItem.localItemId)).toEqual(
        eligibleAfterChange.map((row) => row.localItemId),
      );
    } finally {
      db.close();
      store.close();
    }
  });

  test('fuses keyword and vector lanes with RRF: the both-lane hit ranks first', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, SEARCH_IDEAS, LANCE_EVAL]]), { fetchContent: true });
    const provider = createFakeEmbeddingProvider();
    await store.embedChunks({ provider });

    const adapter = createConnectorStoreCorpusAdapter({ store, embeddingProvider: provider });
    // RETRO hits BOTH lanes (tokens "unified search" + LanceDB concept);
    // SEARCH_IDEAS is keyword-only; LANCE_EVAL is vector-only.
    const response = await adapter(corpusRequest(store, 'unified search'));
    const ids = response.hits.map((hit) => hit.sourceItem.providerItemId);
    expect(ids[0]).toBe('id:retro');
    expect(ids).toContain('id:search-ideas');
    expect(ids).toContain('id:lance-eval');
    expect(ids).toHaveLength(3);

    const [keywordLane, vectorLane, fusedLane] = response.laneAudits!;
    expect(keywordLane!.candidateCount).toBe(2);
    expect(vectorLane!.candidateCount).toBe(2);
    expect(fusedLane!.candidateCount).toBe(3);

    // The both-lane hit carries a strictly larger fused score than either
    // single-lane hit (reciprocal-rank sum beats any single lane).
    const scoreById = new Map(response.hits.map((hit) => [hit.sourceItem.providerItemId, hit.score ?? 0]));
    expect(scoreById.get('id:retro')!).toBeGreaterThan(scoreById.get('id:search-ideas')!);
    expect(scoreById.get('id:retro')!).toBeGreaterThan(scoreById.get('id:lance-eval')!);
    store.close();
  });

  test('falls back to keyword-only parity when the store has no embeddings', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES]]), { fetchContent: true });
    const provider = createFakeEmbeddingProvider();

    const plain = createConnectorStoreCorpusAdapter({ store });
    const withProvider = createConnectorStoreCorpusAdapter({ store, embeddingProvider: provider });
    const baseline = await plain(corpusRequest(store, 'retro AND lancedb'));
    const fallback = await withProvider(corpusRequest(store, 'retro AND lancedb'));

    // Identical hits to the provider-less adapter; the provider never ran.
    expect(JSON.stringify(fallback.hits)).toBe(JSON.stringify(baseline.hits));
    expect(provider.embedCalls).toHaveLength(0);
    expect(fallback.laneAudits).toHaveLength(1);
    expect(fallback.laneAudits![0]!.laneType).toBe('keyword');
    expect(fallback.laneAudits![0]!.backend).toBe('sqlite_fts5');
    expect(fallback.laneAudits![0]!.skippedReason).toBe('no_embedding_artifacts');
    expect(fallback.laneAudits![0]!.modelId).toBe('fake-embed-v1');
    store.close();
  });

  test('secure_local store with a cloud provider serves keyword-only with an honest skip reason', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES]]), { fetchContent: true });
    await store.embedChunks({ provider: createFakeEmbeddingProvider() });

    const cloud = createFakeEmbeddingProvider({ backend: 'cloud' });
    const adapter = createConnectorStoreCorpusAdapter({ store, embeddingProvider: cloud });
    const response = await adapter(corpusRequest(store, 'lancedb'));

    expect(response.hits).toHaveLength(1);
    expect(response.hits[0]!.sourceItem.providerItemId).toBe('id:retro');
    expect(cloud.embedCalls).toHaveLength(0);
    expect(response.laneAudits).toHaveLength(1);
    expect(response.laneAudits![0]!.laneType).toBe('keyword');
    expect(response.laneAudits![0]!.skippedReason).toBe('secure_local_embedding_provider_not_local');
    store.close();
  });
});

describe('full loop: connector -> store -> evidence pack -> analyst', () => {
  test('a synced connector corpus yields a cited analyst answer', async () => {
    const store = newStore();
    await store.syncFromConnector(createFakeConnector([[RETRO, GROCERIES]]), { fetchContent: true });

    const corpus = defineConnectorCorpus({ corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
    const registry = buildSourceIndexCorpusRegistry([corpus]);
    const adapters = { [CORPUS_ID]: createConnectorStoreCorpusAdapter({ store }) };
    const contentProviders = { [CORPUS_ID]: createConnectorStoreContentProvider({ store }) };
    const searchContext: SourceIndexSearchContext = { allowedTrustDomains: ['secure_local'] };

    const pack = await buildEvidencePack({
      question: 'What did the retro decide to adopt for unified search?',
      maxResults: 5,
      searchContext,
      registry,
      adapters,
      contentProviders,
    });

    expect(pack.candidates.length).toBeGreaterThan(0);
    const top = pack.candidates[0]!;
    expect(top.chunks.join(' ')).toContain('LanceDB');
    expect(top.trustDomain).toBe('secure_local');
    // The locator entered through the LOCAL provider lane and was merged into
    // the citation for the gated answer.
    expect(top.provenance.citation?.uri).toBe('/Approved/2026-04-22_retro-notes.md');
    expect(pack.coverage.searchedCorpora).toEqual([CORPUS_ID]);

    const model: AnalystModel = {
      async complete(request) {
        // The analyst saw the actual stored evidence, not just locators.
        expect(request.prompt).toContain('LanceDB');
        expect(request.localOnly).toBe(true);
        return {
          text: JSON.stringify({
            answer: 'The retro decided to adopt LanceDB for unified search.',
            citations: [{ evidence: 1, claim: 'adopt LanceDB for unified search' }],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'scripted-local',
        };
      },
    };
    const result = await createAnalyst(model).analyze(pack, { localOnly: true });

    expect(result.answer).toContain('LanceDB');
    expect(result.escalation).toBeUndefined();
    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]!.provenance.sourceItem.providerItemId).toBe('id:retro');
    expect(result.citations[0]!.provenance.citation?.title).toBe('2026-04-22_retro-notes.md');
    store.close();
  });

  test('a reacted message reaches the analyst with its reaction, and the citation can carry it', async () => {
    const chatCorpusId = 'secure_local.fake.chat';
    const store = newChatStore();
    await store.syncFromConnector(
      createChatConnector([reactedChatItem([
        { key: '👍', count: 2, actors: [{ providerActorId: 'peer-9', label: 'Ada Lovelace' }, { providerActorId: 'owner-1' }] },
      ])]),
      { fetchContent: true },
    );

    const registry = buildSourceIndexCorpusRegistry([
      defineConnectorCorpus({ corpusId: chatCorpusId, family: 'chat', trustDomain: 'secure_local' }),
    ]);
    const pack = await buildEvidencePack({
      question: 'Did anyone acknowledge the school form message?',
      searchQuery: 'school form',
      maxResults: 5,
      searchContext: { allowedTrustDomains: ['secure_local'] },
      registry,
      adapters: { [chatCorpusId]: createConnectorStoreCorpusAdapter({ store }) },
      contentProviders: { [chatCorpusId]: createConnectorStoreContentProvider({ store }) },
    });

    const top = pack.candidates[0]!;
    expect(top.chunks).toEqual(['Reactions: 👍 ×2 (Ada Lovelace)', REACTED_MESSAGE]);

    const model: AnalystModel = {
      async complete(request) {
        // The reaction reached the model as evidence beside the message it
        // confirms — that is what makes the citation below honest.
        expect(request.prompt).toContain('Reactions: 👍 ×2 (Ada Lovelace)');
        expect(request.prompt).toContain(REACTED_MESSAGE);
        return {
          text: JSON.stringify({
            answer: 'Yes — the school form message was confirmed by 👍 ×2.',
            citations: [{ evidence: 1, claim: 'confirmed by 👍 ×2' }],
            unanswered: [],
            sufficient: true,
          }),
          modelId: 'scripted-local',
        };
      },
    };
    const result = await createAnalyst(model).analyze(pack, { localOnly: true });

    expect(result.citations).toHaveLength(1);
    expect(result.citations[0]!.claim).toBe('confirmed by 👍 ×2');
    expect(result.citations[0]!.provenance.sourceItem.providerItemId).toBe('chat-1');
    expect(result.escalation).toBeUndefined();
    store.close();
  });
});
