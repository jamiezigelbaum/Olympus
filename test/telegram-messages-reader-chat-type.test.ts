// The canonical Telethon gateway writes its chat-type vocabulary directly
// into the append-only capture spool. There is no family index boundary left
// that may remap dm/bot to private or silently drop them.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  createTelegramCaptureSpoolConnector,
  readTelegramCaptureSpool,
} from '../src/workers/telegram-messages/index.ts';

const ACCOUNT = 'telegram.personal';

describe('Telethon capture-spool chat-type vocabulary', () => {
  test('preserves dm, bot, group, and channel without a legacy private remap', () => {
    const fixture = spoolFixture(['dm', 'bot', 'group', 'channel']);
    try {
      const result = readTelegramCaptureSpool({
        spoolDir: fixture.spoolDir,
        trustDomain: 'internal',
      });
      expect(result.records.map((record) => record.capturedItem.item.metadata.chatType))
        .toEqual(['dm', 'bot', 'group', 'channel']);
      expect(result.records.map((record) => record.capturedItem.item.metadata.chatType))
        .not.toContain('private');
    } finally {
      fixture.close();
    }
  });

  test('the SourceConnector carries the same vocabulary and omits a missing value', async () => {
    const fixture = spoolFixture(['dm', undefined]);
    try {
      const connector = createTelegramCaptureSpoolConnector({
        spoolDir: fixture.spoolDir,
        trustDomain: 'internal',
      });
      const pages = [];
      for await (const page of connector.listItems({ limit: 10 })) pages.push(page);

      expect(pages).toHaveLength(1);
      expect(pages[0]!.done).toBe(true);
      expect(pages[0]!.items[0]!.metadata.chatType).toBe('dm');
      expect(pages[0]!.items[1]!.metadata.chatType).toBeUndefined();
      expect(connector.classify(pages[0]!.items[0]!)).toMatchObject({
        trustDomain: 'internal',
        trustTier: 'S3',
      });
    } finally {
      fixture.close();
    }
  });
});

function spoolFixture(chatTypes: Array<string | undefined>): {
  spoolDir: string;
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-chat-types-'));
  const spoolDir = join(root, 'spool');
  mkdirSync(spoolDir);
  writeFileSync(
    join(spoolDir, '2026-08-26.jsonl'),
    chatTypes.map((chatType, index) => JSON.stringify(spoolRecord(index + 1, chatType))).join('\n') + '\n',
  );
  return {
    spoolDir,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function spoolRecord(index: number, chatType: string | undefined): Record<string, unknown> {
  const conversationId = 'chat-' + index;
  const messageId = 'msg-' + index;
  const sourceVersion = messageId + ':v1';
  return {
    schema_version: 1,
    capture_id: sha256([ACCOUNT, conversationId, messageId, sourceVersion].join('\x1f')),
    captured_at: '2026-08-26T10:01:00.000Z',
    provider: 'telegram',
    account: ACCOUNT,
    chat_scope: ACCOUNT + ':chat:' + conversationId,
    conversation_id: conversationId,
    corpus_id: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    trust_domain: 'internal',
    classification: { trust_domain: 'internal', reason: 'fixture' },
    sync_direction: 'forward',
    message: {
      id: messageId,
      conversationId,
      boundedText: 'hello',
      ...(chatType === undefined ? {} : { chatType }),
      sentAt: '2026-08-26T10:00:00.000Z',
      sourceVersion,
    },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
