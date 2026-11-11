import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createLaneTieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import type { SourceConnector } from '../src/core/contracts.ts';
import {
  LocalConnectorStore,
  type ConnectorStoreSyncOptions,
  type ConnectorStoreSyncSummary,
} from '../src/workers/connector-store/index.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  TELEGRAM_MALFORMED_SPOOL_WARNING,
  TELEGRAM_TRUST_CONFLICT_WARNING,
  createTelegramConnectorStoreSyncHandler,
  type TelegramConnectorStoreSyncHandler,
  type TelegramConnectorStores,
} from '../src/workers/telegram-messages/index.ts';
import { AMPLE_DISK_SPACE } from './helpers/disk-space.ts';

const ACCOUNT = 'telegram.personal';
const SECRET_TEXT = 'TELEGRAM_SOURCE_SURFACE_SECRET_DO_NOT_LEAK';
const RAW_CURSOR = '2026-08-26.jsonl:2';

describe('Telegram connector-store operational surfaces', () => {
  test('sync, status, and search expose counts and identities but never source text or cursors', async () => {
    const fixture = createFixture([
      JSON.stringify(spoolRecord('porto', '100', 'internal', 'surface sync proof ' + SECRET_TEXT)),
      JSON.stringify(spoolRecord('lawyer', '200', 'secure_local', 'protected proof ' + SECRET_TEXT)),
    ]);
    try {
      const receipt = await fixture.sync.pull();
      const worker = createWorker(fixture.stores);
      const status = await postJson(worker, '/v1/source/index/status', {
        corpus_id: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
        include_items: false,
      });
      const search = await postJson(worker, '/v1/source/index/search', {
        corpus_id: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
        query: 'surface',
        account: ACCOUNT,
        max_results: 5,
      });
      const serialized = JSON.stringify({ receipt, status, search });

      expect(receipt).toMatchObject({
        status: 'progress',
        counts: {
          items_seen: 2,
          items_indexed: 2,
          items_changed: 2,
          chunks_indexed: 2,
          malformed_spool_records: 0,
        },
        policy: {
          counts_only: true,
          raw_source_exposed: false,
          source_text_returned: false,
          provider_cursor_exposed: false,
          local_only: true,
        },
      });
      expect(status).toMatchObject({
        kind: 'source_index_status',
        corpora: [{
          corpus_id: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
          trust_domain: 'internal',
          provider: 'telegram',
          configured: true,
          read_authority: 'connector_store',
          counts: {
            indexed_items: 1,
            tombstoned_items: 0,
            chunks: 1,
            sync_runs: 1,
          },
          item_metadata_returned: false,
          skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
        }],
        policy: {
          raw_source_exposed: false,
          source_text_returned: false,
          secure_local_item_metadata_exposed: false,
        },
      });
      expect(status.corpora[0]).not.toHaveProperty('items');
      expect(search).toMatchObject({
        kind: 'source_index_search',
        corpus_id: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
        retrieval_source: 'local_index',
        audit: {
          raw_source_exposed: false,
          source_text_returned: false,
          items_returned: 1,
        },
        policy: {
          raw_source_exposed: false,
          source_text_returned: false,
          source_packets_exposed: false,
          trust_domain: 'internal',
        },
      });
      expect(search.hits).toHaveLength(1);
      expect(search.hits[0].sourceItem).toMatchObject({
        family: 'chat',
        provider: 'telegram',
        accountScope: ACCOUNT,
        providerItemId: '100',
        providerConversationId: 'porto',
      });
      expect(serialized).not.toContain(SECRET_TEXT);
      expect(serialized).not.toContain(RAW_CURSOR);
      expect(serialized).not.toContain('"chat_scope"');
      expect(serialized).not.toContain('boundedText');
    } finally {
      fixture.close();
    }
  });

  test('keeps internal and secure-local stores separated on the shared HTTP search surface', async () => {
    const fixture = createFixture([
      JSON.stringify(spoolRecord('ordinary', '1', 'internal', 'ordinary lane marker')),
      JSON.stringify(spoolRecord('protected', '2', 'secure_local', 'protected lane marker')),
    ]);
    try {
      await fixture.sync.pull();
      const worker = createWorker(fixture.stores);
      const internalQuery = await postJson(worker, '/v1/source/index/search', {
        corpus_id: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
        query: 'ordinary',
        account: ACCOUNT,
      });
      const protectedQuery = await postJson(worker, '/v1/source/index/search', {
        corpus_id: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
        query: 'protected',
        account: ACCOUNT,
      });

      expect(internalQuery.hits).toHaveLength(1);
      expect(internalQuery.hits[0].sourceItem.providerConversationId).toBe('ordinary');
      expect(protectedQuery.hits).toHaveLength(1);
      expect(protectedQuery.hits[0].sourceItem.providerConversationId).toBe('protected');
      expect(protectedQuery.policy).toMatchObject({
        trust_domain: 'secure_local',
        local_only: true,
        source_text_returned: false,
      });
      expect(JSON.stringify(internalQuery)).not.toContain('protected lane marker');
      expect(JSON.stringify(protectedQuery)).not.toContain('protected lane marker');
    } finally {
      fixture.close();
    }
  });

  test('skips malformed captures, advances past them, and resumes newly appended records', async () => {
    const fixture = createFixture([
      JSON.stringify(spoolRecord('ordinary', '1', 'internal', 'first valid')),
      '{broken json}',
      JSON.stringify(spoolRecord('protected', '2', 'secure_local', 'second valid')),
    ]);
    try {
      const first = await fixture.sync.pull();
      expect(first).toMatchObject({
        status: 'progress',
        counts: {
          items_seen: 2,
          malformed_spool_records: 1,
        },
        warnings: [TELEGRAM_MALFORMED_SPOOL_WARNING],
      });
      expect(fixture.stores.internal.status().counts.items).toBe(1);
      expect(fixture.stores.secureLocal.status().counts.items).toBe(1);

      appendFileSync(
        fixture.spoolPath,
        JSON.stringify(spoolRecord('protected', '3', 'secure_local', 'later valid')) + '\n',
      );
      const resumed = await fixture.sync.pull();
      expect(resumed).toMatchObject({
        status: 'progress',
        counts: { items_seen: 1, items_changed: 1 },
      });
      expect(fixture.stores.secureLocal.status().counts.items).toBe(2);
      expect(fixture.sync.lastStoreRunCompletedAt()).toBeDefined();

      const idle = await fixture.sync.pull();
      expect(idle).toMatchObject({
        status: 'idle',
        counts: { items_seen: 0, items_changed: 0 },
      });
    } finally {
      fixture.close();
    }
  });

  for (const [label, order] of [
    ['internal first', ['internal', 'secure_local']],
    ['secure-local first', ['secure_local', 'internal']],
  ] as const) {
    test(`mixed historical domains keep a Personal message searchable (${label})`, async () => {
      const fixture = createFixture([
        JSON.stringify(spoolRecord('ordinary', '1', 'internal', 'ordinary lane marker')),
        ...order.map(domain => JSON.stringify(spoolRecord('reclassified', '9', domain, 'reclassified marker'))),
      ]);
      try {
        const receipt = await fixture.sync.pull();
        expect(receipt.counts).toMatchObject({ trust_conflict_items: 1, trust_conflict_evictions: 0 });
        expect(receipt.warnings).toContain(TELEGRAM_TRUST_CONFLICT_WARNING);
        expect(fixture.stores.internal.status().counts.items).toBe(2);
        expect(fixture.stores.secureLocal.status().counts.items).toBe(0);
        const worker = createWorker(fixture.stores);
        const found = await postJson(worker, '/v1/source/index/search', {
          corpus_id: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, query: 'reclassified', account: ACCOUNT,
        });
        expect(found.hits.map((hit: any) => hit.sourceItem.providerItemId)).toContain('9');
        expect(await fixture.sync.pull()).toMatchObject({ status: 'idle', counts: { items_seen: 0 } });
      } finally { fixture.close(); }
    });

    test(`a later historical domain cannot hide a Personal message (${label})`, async () => {
      const fixture = createFixture([JSON.stringify(spoolRecord('reclassified', '9', order[0], 'reclassified marker'))]);
      try {
        await fixture.sync.pull();
        appendFileSync(fixture.spoolPath, JSON.stringify(spoolRecord('reclassified', '9', order[1], 'reclassified marker')) + '\n');
        const receipt = await fixture.sync.pull();
        expect(receipt.counts.trust_conflict_evictions).toBe(0);
        expect(fixture.stores.internal.localContent(`${ACCOUNT}:reclassified:9`)?.chunks.join(' ')).toBe('reclassified marker');
        expect(fixture.stores.secureLocal.status().counts.items).toBe(0);
      } finally { fixture.close(); }
    });

    test(`a record appended mid-pull waits for the next bounded window (${label})`, async () => {
      const fixture = createFixture([JSON.stringify(spoolRecord('reclassified', '9', order[0], 'reclassified marker'))]);
      try {
        await fixture.sync.pull();
        const lane = order[1] === 'internal' ? fixture.stores.internal : fixture.stores.secureLocal;
        const sync = lane.syncFromConnector.bind(lane);
        let appended = false;
        lane.syncFromConnector = (connector: SourceConnector, options?: ConnectorStoreSyncOptions): Promise<ConnectorStoreSyncSummary> => {
          if (!appended) {
            appended = true;
            appendFileSync(fixture.spoolPath, JSON.stringify(spoolRecord('reclassified', '10', order[1], 'later marker')) + '\n');
          }
          return sync(connector, options);
        };
        expect((await fixture.sync.pull()).counts.items_seen).toBe(0);
        expect(fixture.stores.internal.localContent(`${ACCOUNT}:reclassified:10`)).toBeUndefined();
        await fixture.sync.pull();
        expect(fixture.stores.internal.localContent(`${ACCOUNT}:reclassified:10`)?.chunks.join(' ')).toBe('later marker');
        expect(fixture.stores.secureLocal.status().counts.items).toBe(0);
        expect(await fixture.sync.pull()).toMatchObject({ status: 'idle', counts: { items_seen: 0 } });
      } finally { fixture.close(); }
    });
  }

  test('a one-record budget consumes both domains without hiding the Personal item', async () => {
    const fixture = createFixture([
      JSON.stringify(spoolRecord('reclassified', '9', 'internal', 'reclassified marker')),
      JSON.stringify(spoolRecord('ordinary', '1', 'internal', 'ordinary marker')),
      JSON.stringify(spoolRecord('reclassified', '9', 'secure_local', 'reclassified marker')),
    ]);
    try {
      for (let pull = 0; pull < 3; pull++) {
        expect((await fixture.sync.pull({ max_items: 1 })).counts.trust_conflict_evictions).toBe(0);
      }
      expect(fixture.stores.internal.status().counts.items).toBe(2);
      expect(fixture.stores.secureLocal.status().counts.items).toBe(0);
    } finally { fixture.close(); }
  });
});

function createWorker(stores: TelegramConnectorStores): ReturnType<typeof createEmailSourceWorker> {
  const connectorStores = [stores.internal, stores.secureLocal];
  return createEmailSourceWorker({
    connectorStores,
    sourceIndexStatus: createSourceIndexStatusHandler({ connectorStores }),
  });
}

function createFixture(lines: string[]): {
  stores: TelegramConnectorStores;
  sync: TelegramConnectorStoreSyncHandler;
  spoolPath: string;
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-source-surface-'));
  const spoolDir = join(root, 'spool');
  const spoolPath = join(spoolDir, '2026-08-26.jsonl');
  mkdirSync(spoolDir);
  writeFileSync(spoolPath, lines.join('\n') + '\n');
  const internal = new LocalConnectorStore({
    dbPath: join(root, 'internal.sqlite'),
    corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    family: 'chat',
    trustDomain: 'internal',
  });
  const secureLocal = new LocalConnectorStore({
    dbPath: join(root, 'secure-local.sqlite'),
    corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
    family: 'chat',
    trustDomain: 'secure_local',
  });
  const stores = { internal, secureLocal };
  return {
    stores,
    sync: createTelegramConnectorStoreSyncHandler({ stores, spoolDir, diskSpace: AMPLE_DISK_SPACE, tierSet: createLaneTieredStoreSet({
      setId: 'telegram.messages', internalStore: internal, secureStore: secureLocal, splitLayers: false,
      tierClassification: { rules: ['lawyer', 'protected'].map(chat => ({
        id: `owner.${chat}`, match: { kind: 'chat' as const, value: chat }, tier: 'secure' as const, strength: 'prior' as const,
      })) },
    }) }),
    spoolPath,
    close() {
      secureLocal.close();
      internal.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function postJson(
  worker: ReturnType<typeof createEmailSourceWorker>,
  path: string,
  body: Record<string, unknown>,
): Promise<Record<string, any>> {
  const response = await worker.fetch(new Request('http://worker.test' + path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }));
  const payload = await response.json() as Record<string, any>;
  expect(response.status).toBe(200);
  return payload;
}

function spoolRecord(
  conversationId: string,
  messageId: string,
  trustDomain: 'internal' | 'secure_local',
  boundedText: string,
): Record<string, unknown> {
  const sourceVersion = ACCOUNT + ':' + conversationId + ':' + messageId + ':v1';
  return {
    schema_version: 1,
    capture_id: sha256([ACCOUNT, conversationId, messageId, sourceVersion].join('\x1f')),
    captured_at: '2026-08-26T10:01:00.000Z',
    provider: 'telegram',
    account: ACCOUNT,
    chat_scope: ACCOUNT + ':chat:' + conversationId,
    conversation_id: conversationId,
    corpus_id: trustDomain === 'secure_local'
      ? PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID
      : INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    trust_domain: trustDomain,
    classification: { trust_domain: trustDomain, reason: 'fixture' },
    sync_direction: 'forward',
    message: {
      id: messageId,
      conversationId,
      chatTitle: 'Chat ' + conversationId,
      senderId: 'sender-1',
      senderDisplayName: 'Sam',
      senderIsOwner: true,
      chatType: 'group',
      boundedText,
      sentAt: '2026-08-26T10:00:00.000Z',
      sourceVersion,
    },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
