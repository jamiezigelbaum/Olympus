// Telegram content reaches EvidencePack through the shared connector store.
// The only Telegram-specific component below is the capture-spool connector;
// hydration is the same generic LocalContentProvider every corpus uses.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { SourceIndexProvenance } from '../src/core/source-index/types.ts';
import {
  LocalConnectorStore,
  createConnectorStoreContentProvider,
} from '../src/workers/connector-store/index.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  createTelegramCaptureSpoolConnector,
} from '../src/workers/telegram-messages/index.ts';

const ACCOUNT = 'telegram.personal';

describe('Telegram connector-store content provider', () => {
  test('hydrates both trust lanes without allowing cross-lane reads', async () => {
    const fixture = await createFixture([
      spoolRecord('porto', 'msg-internal', 'internal', 'Porto dinner is at 19:30 by the riverside.'),
      spoolRecord('lawyer', 'msg-protected', 'secure_local', 'Protected counsel note.'),
    ]);
    try {
      const internalProvider = createConnectorStoreContentProvider({ store: fixture.internal });
      const protectedProvider = createConnectorStoreContentProvider({ store: fixture.secureLocal });

      const internal = await internalProvider.fetchLocalContent({
        provenance: provenance('porto', 'msg-internal'),
        trustDomain: 'internal',
      });
      expect(internal).toMatchObject({
        chunks: ['Porto dinner is at 19:30 by the riverside.'],
        sensitivity: { trustDomain: 'internal', trustTier: 'S3' },
      });

      const protectedBlock = await protectedProvider.fetchLocalContent({
        provenance: provenance('lawyer', 'msg-protected'),
        trustDomain: 'secure_local',
      });
      expect(protectedBlock).toMatchObject({
        chunks: ['Protected counsel note.'],
        sensitivity: { trustDomain: 'secure_local', trustTier: 'S4', localOnly: true },
      });

      expect(await internalProvider.fetchLocalContent({
        provenance: provenance('lawyer', 'msg-protected'),
        trustDomain: 'internal',
      })).toBeUndefined();
      expect(await protectedProvider.fetchLocalContent({
        provenance: provenance('porto', 'msg-internal'),
        trustDomain: 'secure_local',
      })).toBeUndefined();
      await expect(internalProvider.fetchLocalContent({
        provenance: provenance('porto', 'msg-internal'),
        trustDomain: 'secure_local',
      })).rejects.toThrow('refused a secure_local content request');
    } finally {
      fixture.close();
    }
  });

  test('uses shared truncation and honest metadata-only coverage', async () => {
    const fixture = await createFixture([
      spoolRecord('porto', 'msg-long', 'internal', 'x'.repeat(500)),
      spoolRecord('porto', 'msg-attachment', 'internal', undefined, ['receipt.jpg']),
    ]);
    try {
      const provider = createConnectorStoreContentProvider({ store: fixture.internal });
      const bounded = await provider.fetchLocalContent({
        provenance: provenance('porto', 'msg-long'),
        trustDomain: 'internal',
        maxChars: 80,
      });
      expect(bounded!.chunks.join('')).toHaveLength(80);
      expect(bounded!.truncated).toBe(true);
      expect(bounded!.coverageGaps).toContain('stored text was truncated to fit the evidence budget.');

      const metadataOnly = await provider.fetchLocalContent({
        provenance: provenance('porto', 'msg-attachment'),
        trustDomain: 'internal',
      });
      expect(metadataOnly!.chunks).toEqual([]);
      expect(metadataOnly!.coverageGaps).toContain('the item is stored without extracted text yet.');

      expect(await provider.fetchLocalContent({
        provenance: provenance('porto', 'missing'),
        trustDomain: 'internal',
      })).toBeUndefined();
    } finally {
      fixture.close();
    }
  });
});

async function createFixture(records: Record<string, unknown>[]): Promise<{
  internal: LocalConnectorStore;
  secureLocal: LocalConnectorStore;
  close(): void;
}> {
  const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-content-provider-'));
  const spoolDir = join(root, 'spool');
  mkdirSync(spoolDir);
  writeFileSync(
    join(spoolDir, '2026-08-26.jsonl'),
    records.map((record) => JSON.stringify(record)).join('\n') + '\n',
  );
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
  try {
    await internal.syncFromConnector(createTelegramCaptureSpoolConnector({
      spoolDir,
      trustDomain: 'internal',
    }), { fetchContent: true });
    await secureLocal.syncFromConnector(createTelegramCaptureSpoolConnector({
      spoolDir,
      trustDomain: 'secure_local',
    }), { fetchContent: true });
  } catch (error) {
    secureLocal.close();
    internal.close();
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    internal,
    secureLocal,
    close() {
      secureLocal.close();
      internal.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function provenance(conversationId: string, messageId: string): SourceIndexProvenance {
  return {
    sourceItem: {
      family: 'chat',
      provider: 'telegram',
      accountScope: ACCOUNT,
      providerItemId: messageId,
      providerConversationId: conversationId,
      localItemId: ACCOUNT + ':' + conversationId + ':' + messageId,
    },
  };
}

function spoolRecord(
  conversationId: string,
  messageId: string,
  trustDomain: 'internal' | 'secure_local',
  boundedText?: string,
  attachmentNames: string[] = [],
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
      chatType: 'group',
      ...(boundedText === undefined ? {} : { boundedText }),
      attachments: attachmentNames.map((name, index) => ({
        attachmentId: 'attachment-' + index,
        type: 'file',
        name,
      })),
      sentAt: '2026-08-26T10:00:00.000Z',
      sourceVersion,
    },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
