import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { OlympusConfig } from '../src/core/config.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createTelegramSchedulerSource } from '../src/workers/source-scheduler.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  TELEGRAM_CAPTURE_CONNECTOR_IDS,
  TELEGRAM_MALFORMED_SPOOL_WARNING,
  createTelegramConnectorStoreSyncHandler,
  type TelegramConnectorStores,
} from '../src/workers/telegram-messages/index.ts';

const ACCOUNT = 'telegram.personal';

describe('Telegram canonical product runtime', () => {
  test('uses only canonical capture cursor identities', () => {
    expect(TELEGRAM_CAPTURE_CONNECTOR_IDS).toEqual({
      internal: 'telegram_capture_spool_internal',
      secure_local: 'telegram_capture_spool_secure_local',
    });
    expect(Object.values(TELEGRAM_CAPTURE_CONNECTOR_IDS).join(',')).not.toContain('replay');
  });

  test('syncs mixed trust lanes resumably through the shared scheduler spine', async () => {
    const fixture = createFixture();
    try {
      const reactions = [{ key: '👍', count: 1, actors: [{ providerActorId: '7' }] }];
      writeFileSync(join(fixture.spoolDir, '2026-08-26.jsonl'), [
        JSON.stringify(spoolRecord('ordinary', '1', 'internal', 'project note', ['roadmap.pdf'])),
        JSON.stringify(spoolRecord('protected', '2', 'secure_local', 'private note')),
        JSON.stringify(spoolRecord('ordinary', '1', 'internal', 'project note', ['roadmap.pdf'], reactions)),
        '',
      ].join('\n'));

      const sync = createTelegramConnectorStoreSyncHandler({
        stores: fixture.stores,
        spoolDir: fixture.spoolDir,
      });
      const source = createTelegramSchedulerSource({ config: schedulerConfig(), sync });
      expect(source).toMatchObject({
        sourceId: 'telegram.messages',
        corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
        cadence: 'continuous',
        tasks: [{ id: 'telegram.messages_store_pull', kind: 'sync', writer: true }],
      });

      const first = await source!.tasks[0]!.run();
      expect(first).toMatchObject({
        status: 'progress',
        counts: { items_seen: 3, items_indexed: 3, items_changed: 3 },
      });
      expect(JSON.stringify(first)).not.toContain('project note');
      expect(fixture.stores.internal.status().counts.items).toBe(1);
      expect(fixture.stores.secureLocal.status().counts.items).toBe(1);
      expect(fixture.stores.internal.searchItems('roadmap', 5)).toHaveLength(1);
      expect(fixture.stores.secureLocal.searchItems('private', 5)).toHaveLength(1);
      expect(fixture.stores.internal.itemReactions(`${ACCOUNT}:ordinary:1`)).toEqual(reactions);
      expect(fixture.stores.internal.lastCompletedSyncRun(
        TELEGRAM_CAPTURE_CONNECTOR_IDS.internal,
      )?.cursor).toBe('2026-08-26.jsonl:3');
      expect(fixture.stores.secureLocal.lastCompletedSyncRun(
        TELEGRAM_CAPTURE_CONNECTOR_IDS.secure_local,
      )?.cursor).toBe('2026-08-26.jsonl:3');
      expect(source!.lastSyncCompletedAt?.()).toBeDefined();

      const idle = await source!.tasks[0]!.run();
      expect(idle).toMatchObject({ status: 'idle', counts: { items_seen: 0, items_changed: 0 } });

      appendFileSync(
        join(fixture.spoolDir, '2026-08-26.jsonl'),
        `${JSON.stringify(spoolRecord('ordinary', '3', 'internal', 'new ordinary note'))}\n`,
      );
      const internalOnly = await source!.tasks[0]!.run();
      expect(internalOnly).toMatchObject({ status: 'progress', counts: { items_seen: 1, items_changed: 1 } });
      expect(fixture.stores.internal.status().counts.items).toBe(2);
      expect(fixture.stores.secureLocal.status().counts.items).toBe(1);
      expect(fixture.stores.secureLocal.lastCompletedSyncRun(
        TELEGRAM_CAPTURE_CONNECTOR_IDS.secure_local,
      )?.cursor).toBe('2026-08-26.jsonl:4');

      appendFileSync(
        join(fixture.spoolDir, '2026-08-26.jsonl'),
        `${JSON.stringify(spoolRecord('protected', '4', 'secure_local', 'new protected note'))}\n`,
      );
      await source!.tasks[0]!.run();
      expect(fixture.stores.internal.status().counts.items).toBe(2);
      expect(fixture.stores.secureLocal.status().counts.items).toBe(2);
    } finally {
      fixture.close();
    }
  });

  test('skips and counts malformed records without wedging later capture', async () => {
    const fixture = createFixture();
    try {
      const valid = spoolRecord('ordinary', '1', 'internal', 'valid content');
      const corrupt = spoolRecord('protected', '2', 'secure_local', 'must not land');
      corrupt.capture_id = '0'.repeat(64);
      writeFileSync(join(fixture.spoolDir, '2026-08-26.jsonl'), [
        JSON.stringify(valid),
        JSON.stringify(corrupt),
        '{broken json}',
        JSON.stringify(spoolRecord('protected', '3', 'secure_local', 'later valid content')),
        '',
      ].join('\n'));
      const sync = createTelegramConnectorStoreSyncHandler({
        stores: fixture.stores,
        spoolDir: fixture.spoolDir,
      });

      const receipt = await sync.pull();
      expect(receipt).toMatchObject({
        status: 'progress',
        counts: {
          items_seen: 2,
          malformed_spool_records: 2,
        },
        warnings: [TELEGRAM_MALFORMED_SPOOL_WARNING],
      });
      expect(JSON.stringify(receipt)).not.toContain('must not land');
      expect(fixture.stores.internal.status().counts.items).toBe(1);
      expect(fixture.stores.secureLocal.status().counts.items).toBe(1);
      expect(sync.lastStoreRunCompletedAt()).toBeDefined();
    } finally {
      fixture.close();
    }
  });
});

function createFixture(): { spoolDir: string; stores: TelegramConnectorStores; close(): void } {
  const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-canonical-'));
  const spoolDir = join(root, 'spool');
  mkdirSync(spoolDir);
  const internal = new LocalConnectorStore({
    dbPath: join(root, 'internal.sqlite'),
    corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    family: 'chat',
    trustDomain: 'internal',
  });
  const secureLocal = new LocalConnectorStore({
    dbPath: join(root, 'protected.sqlite'),
    corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
    family: 'chat',
    trustDomain: 'secure_local',
  });
  return {
    spoolDir,
    stores: { internal, secureLocal },
    close() {
      secureLocal.close();
      internal.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function spoolRecord(
  conversationId: string,
  messageId: string,
  trustDomain: 'internal' | 'secure_local',
  text: string,
  attachmentNames: string[] = [],
  reactions?: ReadonlyArray<Record<string, unknown>>,
): Record<string, unknown> {
  const captured = `${ACCOUNT}:${conversationId}:${messageId}:2026-08-26T10:00:00.000Z`;
  const sourceVersion = reactions === undefined
    ? captured
    : `${captured}:r${sha256(JSON.stringify(reactions)).slice(0, 8)}`;
  return {
    schema_version: 1,
    capture_id: sha256([ACCOUNT, conversationId, messageId, sourceVersion].join('\x1f')),
    captured_at: '2026-08-26T10:01:00.000Z',
    provider: 'telegram',
    account: ACCOUNT,
    chat_scope: `${ACCOUNT}:chat:${conversationId}`,
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
      chatTitle: `Chat ${conversationId}`,
      senderId: 'sender-1',
      senderDisplayName: 'Sam',
      senderIsOwner: true,
      boundedText: text,
      attachments: attachmentNames.map((name, index) => ({
        attachmentId: `attachment-${index}`,
        type: 'file',
        name,
      })),
      ...(reactions === undefined ? {} : { reactions }),
      sentAt: '2026-08-26T10:00:00.000Z',
      sourceVersion,
    },
  };
}

function schedulerConfig(): OlympusConfig {
  return {
    worker: {
      scheduler: {
        enabled: true,
        sourceIds: ['telegram.messages'],
        tickSeconds: 1,
        syncIntervalSeconds: 300,
        freshnessThresholdHours: 24,
        errorBackoffSeconds: 30,
        maxTransientRetries: 1,
      },
    },
  } as OlympusConfig;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
