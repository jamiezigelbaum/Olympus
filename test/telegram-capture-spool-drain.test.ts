// The capture spool is append-only and can hold a backlog far larger than one
// page. A connector that yields a single page per run turns a 200k-message
// backfill into weeks of scheduler intervals, and a max-items budget larger
// than one page silently delivers one page. Both are proven here against the
// connector itself, and once end to end through a store pull.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { SourceConnectorListPage } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  createTelegramCaptureSpoolConnector,
  createTelegramConnectorStoreSyncHandler,
  DEFAULT_TELEGRAM_PULL_MAX_ITEMS,
  readTelegramCaptureSpool,
} from '../src/workers/telegram-messages/index.ts';

const ACCOUNT = 'telegram.personal';
const MAX_PAGE_LIMIT = 10_000;

describe('Telegram capture spool drain', () => {
  test('yields every page of a backlog larger than one page, across spool files', async () => {
    const fixture = spoolFixture({
      '2026-08-26.jsonl': backlog(0, 300),
      '2026-08-27.jsonl': backlog(300, 620),
    });
    try {
      const connector = createTelegramCaptureSpoolConnector({
        spoolDir: fixture.spoolDir,
        trustDomain: 'internal',
      });
      const pages = await collect(connector.listItems());

      expect(pages.length).toBeGreaterThan(1);
      expect(pages.slice(0, -1).every((page) => page.done === false)).toBe(true);
      expect(pages.slice(0, -1).every((page) => page.nextCursor !== undefined)).toBe(true);
      expect(pages[pages.length - 1]!.done).toBe(true);
      const ids = pages.flatMap((page) => page.items.map((item) => item.identity.providerItemId));
      expect(ids).toHaveLength(620);
      expect(new Set(ids).size).toBe(620);
      expect(ids[0]).toBe('msg-0');
      expect(ids[619]).toBe('msg-619');
    } finally {
      fixture.close();
    }
  });

  test('honours a max-items budget larger than one page instead of stopping at the page cap', async () => {
    const budget = MAX_PAGE_LIMIT + 10;
    const fixture = spoolFixture({ '2026-08-26.jsonl': backlog(0, budget + 5) });
    try {
      const connector = createTelegramCaptureSpoolConnector({
        spoolDir: fixture.spoolDir,
        trustDomain: 'internal',
      });
      const pages = await collect(connector.listItems({ limit: budget }));

      const items = pages.flatMap((page) => page.items);
      expect(items).toHaveLength(budget);
      expect(pages.every((page) => page.items.length <= MAX_PAGE_LIMIT)).toBe(true);
      // The budget ran out before the spool did, so the traversal must stay
      // resumable rather than claiming the spool is exhausted.
      expect(pages[pages.length - 1]!.done).toBe(false);
      expect(pages[pages.length - 1]!.nextCursor).toBe('2026-08-26.jsonl:' + budget);
    } finally {
      fixture.close();
    }
  });

  test('each pull advances one bounded window and drains the remainder next time', async () => {
    const fixture = storeFixture({ '2026-08-26.jsonl': backlog(0, 620) });
    try {
      const receipt = await fixture.sync.pull();

      expect(receipt.counts.items_seen).toBe(DEFAULT_TELEGRAM_PULL_MAX_ITEMS);
      expect(fixture.stores.internal.status().counts.items).toBe(DEFAULT_TELEGRAM_PULL_MAX_ITEMS);
      const remainder = await fixture.sync.pull();
      expect(remainder.counts.items_seen).toBe(120);
      expect(fixture.stores.internal.status().counts.items).toBe(620);
      const idle = await fixture.sync.pull();
      expect(idle.status).toBe('idle');
    } finally {
      fixture.close();
    }
  }, 120_000);

  test('passes the same explicit bound to the trust preflight', async () => {
    const fixture = storeFixture({ '2026-08-26.jsonl': backlog(0, 5) });
    const limits: Array<number | undefined> = [];
    try {
      const sync = createTelegramConnectorStoreSyncHandler({
        stores: fixture.stores,
        spoolDir: fixture.spoolDir,
        preflightRead(options) {
          limits.push(options.limit);
          return readTelegramCaptureSpool(options);
        },
      });
      await sync.pull({ max_items: 2 });
      expect(limits).toEqual([2]);
    } finally {
      fixture.close();
    }
  });
});

async function collect(
  pages: AsyncIterable<SourceConnectorListPage>,
): Promise<SourceConnectorListPage[]> {
  const collected: SourceConnectorListPage[] = [];
  for await (const page of pages) collected.push(page);
  return collected;
}

function backlog(from: number, to: number): string[] {
  const lines: string[] = [];
  for (let index = from; index < to; index += 1) {
    lines.push(JSON.stringify(spoolRecord('backlog', 'msg-' + index, 'internal')));
  }
  return lines;
}

function spoolFixture(files: Record<string, string[]>): { spoolDir: string; close(): void } {
  const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-drain-'));
  const spoolDir = join(root, 'spool');
  mkdirSync(spoolDir);
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(spoolDir, name), lines.join('\n') + '\n');
  }
  return {
    spoolDir,
    close() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function storeFixture(files: Record<string, string[]>): {
  spoolDir: string;
  stores: { internal: LocalConnectorStore; secureLocal: LocalConnectorStore };
  sync: ReturnType<typeof createTelegramConnectorStoreSyncHandler>;
  close(): void;
} {
  const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-drain-store-'));
  const spoolDir = join(root, 'spool');
  mkdirSync(spoolDir);
  for (const [name, lines] of Object.entries(files)) {
    writeFileSync(join(spoolDir, name), lines.join('\n') + '\n');
  }
  const stores = {
    internal: new LocalConnectorStore({
      dbPath: join(root, 'internal.sqlite'),
      corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
      family: 'chat',
      trustDomain: 'internal',
    }),
    secureLocal: new LocalConnectorStore({
      dbPath: join(root, 'secure-local.sqlite'),
      corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
      family: 'chat',
      trustDomain: 'secure_local',
    }),
  };
  return {
    spoolDir,
    stores,
    sync: createTelegramConnectorStoreSyncHandler({ stores, spoolDir }),
    close() {
      stores.secureLocal.close();
      stores.internal.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function spoolRecord(
  conversationId: string,
  messageId: string,
  trustDomain: 'internal' | 'secure_local',
): Record<string, unknown> {
  const sourceVersion = messageId + ':v1';
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
      chatTitle: 'Backlog chat',
      chatType: 'group',
      boundedText: 'backlog ' + messageId,
      sentAt: '2026-08-26T10:00:00.000Z',
      sourceVersion,
    },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
