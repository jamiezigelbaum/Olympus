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
import type { SourceConnector } from '../src/core/contracts.ts';
import {
  LocalConnectorStore,
  type ConnectorStoreSyncOptions,
  type ConnectorStoreSyncSummary,
} from '../src/workers/connector-store/index.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
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
            // The lane's traversal run plus the reconciliation sweep's
            // one-time completion marker.
            sync_runs: 2,
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

  // A reclassified conversation puts the same message in the append-only spool
  // under both trust domains. The spool cannot be edited to repair it, so a
  // refusal wedges BOTH lanes forever. The disagreement resolves to the more
  // restrictive domain instead: the message lands in exactly one lane, the
  // restrictive one, and the receipt counts it.
  for (const [label, order] of [
    ['internal first', ['internal', 'secure_local']],
    ['secure-local first', ['secure_local', 'internal']],
  ] as const) {
    test(`resolves a trust-domain disagreement to the restrictive lane (${label})`, async () => {
      const fixture = createFixture([
        JSON.stringify(spoolRecord('ordinary', '1', 'internal', 'ordinary lane marker')),
        JSON.stringify(spoolRecord('reclassified', '9', order[0], 'reclassified marker')),
        JSON.stringify(spoolRecord('reclassified', '9', order[1], 'reclassified marker')),
      ]);
      try {
        const receipt = await fixture.sync.pull();
        expect(receipt).toMatchObject({
          status: 'progress',
          counts: { trust_conflict_items: 1, malformed_spool_records: 0 },
          warnings: [TELEGRAM_TRUST_CONFLICT_WARNING],
        });
        expect(fixture.stores.internal.status().counts.items).toBe(1);
        expect(fixture.stores.secureLocal.status().counts.items).toBe(1);

        const worker = createWorker(fixture.stores);
        const internalQuery = await postJson(worker, '/v1/source/index/search', {
          corpus_id: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
          query: 'reclassified',
          account: ACCOUNT,
        });
        const protectedQuery = await postJson(worker, '/v1/source/index/search', {
          corpus_id: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
          query: 'reclassified',
          account: ACCOUNT,
        });
        expect(internalQuery.hits.map((hit: any) => hit.sourceItem.providerItemId)).not.toContain('9');
        expect(protectedQuery.hits.map((hit: any) => hit.sourceItem.providerItemId)).toContain('9');

        // The lanes stay live: the wedge was the whole defect.
        const idle = await fixture.sync.pull();
        expect(idle).toMatchObject({ status: 'idle', counts: { items_seen: 0 } });
      } finally {
        fixture.close();
      }
    });
  }

  // A scan window can never prove a negative. Once the internal lane has
  // indexed a message, the reclassified record the helper appends later is
  // BEHIND both lane cursors relative to that copy, so no future window ever
  // holds both records. Resolution therefore has to happen at the store
  // boundary: the identity is either in the internal lane or it is not.
  test('evicts an already-indexed internal copy when a later window reclassifies the identity as secure_local', async () => {
    const fixture = createFixture([
      JSON.stringify(spoolRecord('ordinary', '1', 'internal', 'ordinary lane marker')),
      JSON.stringify(spoolRecord('reclassified', '9', 'internal', 'reclassified marker')),
    ]);
    try {
      const first = await fixture.sync.pull();
      expect(first.counts.trust_conflict_items).toBe(0);
      expect(first.counts.trust_conflict_evictions).toBe(0);
      expect(fixture.stores.internal.status().counts.items).toBe(2);

      appendFileSync(
        fixture.spoolPath,
        JSON.stringify(spoolRecord('reclassified', '9', 'secure_local', 'reclassified marker')) + '\n',
      );
      const second = await fixture.sync.pull();
      expect(second.counts.trust_conflict_items).toBe(1);
      expect(second.counts.trust_conflict_evictions).toBe(1);
      expect(second.warnings).toContain(TELEGRAM_TRUST_CONFLICT_WARNING);

      expect(fixture.stores.internal.status().counts.items).toBe(1);
      expect(fixture.stores.internal.status().counts.tombstonedItems).toBe(1);
      expect(fixture.stores.secureLocal.status().counts.items).toBe(1);

      const worker = createWorker(fixture.stores);
      const internalQuery = await postJson(worker, '/v1/source/index/search', {
        corpus_id: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
        query: 'reclassified',
        account: ACCOUNT,
      });
      const protectedQuery = await postJson(worker, '/v1/source/index/search', {
        corpus_id: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
        query: 'reclassified',
        account: ACCOUNT,
      });
      // The chat recency lane answers every query with recent items, so the
      // proof is that the evicted identity is gone, not that nothing matched.
      expect(internalQuery.hits.map((hit: any) => hit.sourceItem.providerItemId)).not.toContain('9');
      expect(JSON.stringify(internalQuery)).not.toContain('reclassified');
      expect(protectedQuery.hits.map((hit: any) => hit.sourceItem.providerItemId)).toContain('9');

      // Both lanes stay live, and a repeat pull re-evicts nothing.
      const idle = await fixture.sync.pull();
      expect(idle).toMatchObject({
        status: 'idle',
        counts: { items_seen: 0, trust_conflict_items: 0, trust_conflict_evictions: 0 },
      });
      expect(idle).not.toHaveProperty('warnings');
    } finally {
      fixture.close();
    }
  });

  // The mirror of the same defect: the stricter lane indexed the identity in an
  // earlier window, and only the looser record falls inside this one. Without
  // the store boundary the internal lane would index a second, readable copy.
  test('keeps a later internal record out of the internal lane when the secure lane already holds the identity', async () => {
    const fixture = createFixture([
      JSON.stringify(spoolRecord('reclassified', '9', 'secure_local', 'reclassified marker')),
    ]);
    try {
      await fixture.sync.pull();
      expect(fixture.stores.secureLocal.status().counts.items).toBe(1);

      appendFileSync(
        fixture.spoolPath,
        JSON.stringify(spoolRecord('reclassified', '9', 'internal', 'reclassified marker')) + '\n',
      );
      const second = await fixture.sync.pull();
      expect(second.counts.trust_conflict_items).toBe(1);
      expect(second.counts.trust_conflict_evictions).toBe(0);
      expect(second.warnings).toContain(TELEGRAM_TRUST_CONFLICT_WARNING);

      expect(fixture.stores.internal.status().counts.items).toBe(0);
      expect(fixture.stores.secureLocal.status().counts.items).toBe(1);

      const worker = createWorker(fixture.stores);
      const internalQuery = await postJson(worker, '/v1/source/index/search', {
        corpus_id: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
        query: 'reclassified',
        account: ACCOUNT,
      });
      expect(internalQuery.hits).toHaveLength(0);
    } finally {
      fixture.close();
    }
  });

  // Trust is resolved against ONE spool read, and then each lane reads the
  // spool again. A record appended between those two reads has been resolved
  // against nothing: admitting it is exactly how both lanes end up holding the
  // same identity, with no conflicting record left in any later window to say
  // so. The lane read is bounded by the position the resolution covered, so a
  // late record waits for the pull whose preflight can see it.
  test('refuses a record appended after its window was resolved, and resolves it on the next pull', async () => {
    const fixture = createFixture([
      JSON.stringify(spoolRecord('reclassified', '9', 'secure_local', 'reclassified marker')),
    ]);
    try {
      await fixture.sync.pull();
      expect(fixture.stores.secureLocal.status().counts.items).toBe(1);

      // The lane's own spool read happens inside this call, strictly after the
      // preflight resolution the pull has already performed.
      const laneSync = fixture.stores.internal.syncFromConnector.bind(fixture.stores.internal);
      let appended = false;
      fixture.stores.internal.syncFromConnector = (
        connector: SourceConnector,
        options?: ConnectorStoreSyncOptions,
      ): Promise<ConnectorStoreSyncSummary> => {
        if (!appended) {
          appended = true;
          appendFileSync(
            fixture.spoolPath,
            JSON.stringify(spoolRecord('reclassified', '9', 'internal', 'reclassified marker')) + '\n',
          );
        }
        return laneSync(connector, options);
      };

      const raced = await fixture.sync.pull();
      expect(appended).toBe(true);
      expect(raced.counts.items_seen).toBe(0);
      expect(fixture.stores.internal.status().counts.items).toBe(0);

      const resolved = await fixture.sync.pull();
      expect(resolved.counts.trust_conflict_items).toBe(1);
      expect(resolved.warnings).toContain(TELEGRAM_TRUST_CONFLICT_WARNING);
      expect(fixture.stores.internal.status().counts.items).toBe(0);
      expect(fixture.stores.secureLocal.status().counts.items).toBe(1);

      const worker = createWorker(fixture.stores);
      const internalQuery = await postJson(worker, '/v1/source/index/search', {
        corpus_id: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
        query: 'reclassified',
        account: ACCOUNT,
      });
      expect(internalQuery.hits).toHaveLength(0);

      // The deferral is a deferral, not a hole: the lanes stay live and the
      // late record's position is behind both cursors once it is resolved.
      const idle = await fixture.sync.pull();
      expect(idle).toMatchObject({ status: 'idle', counts: { items_seen: 0, trust_conflict_items: 0 } });
    } finally {
      fixture.close();
    }
  });

  // The same bound on the stricter lane, where deferring is what preserves the
  // eviction: an unresolved secure-local record admitted mid-pull would sit in
  // the secure store beside the internal copy nothing had evicted.
  test('defers a secure-local record appended mid-pull and evicts the internal copy on the next pull', async () => {
    const fixture = createFixture([
      JSON.stringify(spoolRecord('reclassified', '9', 'internal', 'reclassified marker')),
    ]);
    try {
      await fixture.sync.pull();
      expect(fixture.stores.internal.status().counts.items).toBe(1);

      const laneSync = fixture.stores.secureLocal.syncFromConnector.bind(fixture.stores.secureLocal);
      let appended = false;
      fixture.stores.secureLocal.syncFromConnector = (
        connector: SourceConnector,
        options?: ConnectorStoreSyncOptions,
      ): Promise<ConnectorStoreSyncSummary> => {
        if (!appended) {
          appended = true;
          appendFileSync(
            fixture.spoolPath,
            JSON.stringify(spoolRecord('reclassified', '9', 'secure_local', 'reclassified marker')) + '\n',
          );
        }
        return laneSync(connector, options);
      };

      const raced = await fixture.sync.pull();
      expect(appended).toBe(true);
      expect(raced.counts.trust_conflict_evictions).toBe(0);
      expect(fixture.stores.secureLocal.status().counts.items).toBe(0);
      expect(fixture.stores.internal.status().counts.items).toBe(1);

      const resolved = await fixture.sync.pull();
      expect(resolved.counts.trust_conflict_items).toBe(1);
      expect(resolved.counts.trust_conflict_evictions).toBe(1);
      expect(resolved.counts.items_tombstoned).toBe(1);
      expect(fixture.stores.internal.status().counts.items).toBe(0);
      expect(fixture.stores.secureLocal.status().counts.items).toBe(1);
    } finally {
      fixture.close();
    }
  });

  test('resolves a conflicted message when its stricter claim reaches the bounded window', async () => {
    const fixture = createFixture([
      JSON.stringify(spoolRecord('reclassified', '9', 'internal', 'reclassified marker')),
      JSON.stringify(spoolRecord('ordinary', '1', 'internal', 'ordinary lane marker')),
      JSON.stringify(spoolRecord('reclassified', '9', 'secure_local', 'reclassified marker')),
    ]);
    try {
      // The preflight and both lanes share the one-record budget. The first two
      // pulls advance to the stricter claim without scanning the whole tail;
      // the third resolves that claim against the stored internal copy before
      // admitting it to the secure-local lane.
      const first = await fixture.sync.pull({ max_items: 1 });
      const second = await fixture.sync.pull({ max_items: 1 });
      expect(first.counts.trust_conflict_items).toBe(0);
      expect(second.counts.trust_conflict_items).toBe(0);
      expect(fixture.stores.internal.status().counts.items).toBe(2);
      expect(fixture.stores.secureLocal.status().counts.items).toBe(0);

      const receipt = await fixture.sync.pull({ max_items: 1 });
      expect(receipt.counts.trust_conflict_items).toBe(1);
      expect(receipt.counts.trust_conflict_evictions).toBe(1);
      expect(fixture.stores.internal.status().counts.items).toBe(1);
      expect(fixture.stores.secureLocal.status().counts.items).toBe(1);

      const worker = createWorker(fixture.stores);
      const internalQuery = await postJson(worker, '/v1/source/index/search', {
        corpus_id: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
        query: 'reclassified',
        account: ACCOUNT,
      });
      expect(internalQuery.hits.map((hit: any) => hit.sourceItem.providerItemId)).not.toContain('9');
    } finally {
      fixture.close();
    }
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
    sync: createTelegramConnectorStoreSyncHandler({ stores, spoolDir }),
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
