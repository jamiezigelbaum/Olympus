/**
 * Telegram's pull receipt says how fresh the live capture behind it is.
 *
 * A pull of the capture spool can succeed on schedule while the helper has
 * captured nothing for days. The receipt carries the same capture_* counts
 * WhatsApp's does, read from the newest `captured_at` in the spool (the field
 * the helper's own gateway report reads), against the same default threshold.
 * Synthetic spool files only; no helper, no network.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  captureFreshnessFromCounts,
  DEFAULT_CAPTURE_STALE_THRESHOLD_SECONDS,
} from '../src/workers/connector-store/capture-freshness.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  createTelegramConnectorStoreSyncHandler,
  readTelegramCaptureSpoolNewestCapturedAt,
} from '../src/workers/telegram-messages/index.ts';

const ACCOUNT = 'telegram.personal';
const CAPTURED_AT = '2026-10-20T10:00:00.000Z';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function record(messageId: string, capturedAt: string | undefined): string {
  const sourceVersion = `${ACCOUNT}:chat-1:${messageId}:v1`;
  return JSON.stringify({
    schema_version: 1,
    capture_id: sha256([ACCOUNT, 'chat-1', messageId, sourceVersion].join('\x1f')),
    ...(capturedAt === undefined ? {} : { captured_at: capturedAt }),
    provider: 'telegram',
    account: ACCOUNT,
    chat_scope: `${ACCOUNT}:chat:chat-1`,
    conversation_id: 'chat-1',
    corpus_id: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    trust_domain: 'internal',
    classification: { trust_domain: 'internal', reason: 'fixture' },
    sync_direction: 'forward',
    message: {
      id: messageId,
      conversationId: 'chat-1',
      chatTitle: 'Chat one',
      senderId: 'sender-1',
      senderDisplayName: 'Sam',
      senderIsOwner: true,
      chatType: 'group',
      boundedText: `message ${messageId}`,
      sentAt: '2026-10-20T09:59:00.000Z',
      sourceVersion,
    },
  }) + '\n';
}

function fixture(files: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-capture-freshness-'));
  const spoolDir = join(root, 'spool');
  mkdirSync(spoolDir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(spoolDir, name), text);
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
  return {
    root,
    spoolDir,
    stores: { internal, secureLocal },
    close() {
      secureLocal.close();
      internal.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const at = (iso: string) => () => new Date(iso);

describe('Telegram receipt: capture freshness', () => {
  test('a capture inside the threshold is fresh, with its age and the threshold', async () => {
    const f = fixture({ '2026-10-20.jsonl': record('1', CAPTURED_AT) });
    try {
      const sync = createTelegramConnectorStoreSyncHandler({
        stores: f.stores,
        spoolDir: f.spoolDir,
        spoolStaleThresholdSeconds: 3_600,
        now: at('2026-10-20T10:30:00.000Z'),
      });
      const receipt = await sync.pull();
      expect(receipt.capture).toEqual({ status: 'fresh', threshold_seconds: 3_600, age_seconds: 1_800 });
      expect(receipt.counts).toMatchObject({
        capture_fresh: 1,
        capture_stale: 0,
        capture_unavailable: 0,
        capture_stale_threshold_seconds: 3_600,
        capture_age_seconds: 1_800,
      });
    } finally {
      f.close();
    }
  });

  test('a capture older than the threshold is stale, from the NEWEST record, not the first', async () => {
    const f = fixture({
      '2026-10-18.jsonl': record('1', '2026-10-18T08:00:00.000Z'),
      '2026-10-20.jsonl': record('2', CAPTURED_AT) + record('3', '2026-10-20T10:05:00.000Z'),
    });
    try {
      const sync = createTelegramConnectorStoreSyncHandler({
        stores: f.stores,
        spoolDir: f.spoolDir,
        spoolStaleThresholdSeconds: 60,
        now: at('2026-10-20T12:05:00.000Z'),
      });
      const receipt = await sync.pull();
      expect(receipt.capture).toEqual({ status: 'stale', threshold_seconds: 60, age_seconds: 7_200 });
      expect(receipt.counts).toMatchObject({ capture_fresh: 0, capture_stale: 1, capture_unavailable: 0, capture_age_seconds: 7_200 });
    } finally {
      f.close();
    }
  });

  test('an empty spool is unavailable: no age is invented', async () => {
    const f = fixture();
    try {
      const sync = createTelegramConnectorStoreSyncHandler({
        stores: f.stores,
        spoolDir: f.spoolDir,
        now: at('2026-10-20T12:00:00.000Z'),
      });
      const receipt = await sync.pull();
      expect(receipt.capture).toEqual({ status: 'unavailable', threshold_seconds: DEFAULT_CAPTURE_STALE_THRESHOLD_SECONDS });
      expect(receipt.counts.capture_unavailable).toBe(1);
      expect(receipt.counts).not.toHaveProperty('capture_age_seconds');
    } finally {
      f.close();
    }
  });

  test('records without a readable captured_at leave the feed unavailable, not fresh', async () => {
    const f = fixture({ '2026-10-20.jsonl': record('1', undefined) + record('2', 'not a time') });
    try {
      const sync = createTelegramConnectorStoreSyncHandler({
        stores: f.stores,
        spoolDir: f.spoolDir,
        now: at('2026-10-20T12:00:00.000Z'),
      });
      expect((await sync.pull()).capture.status).toBe('unavailable');
    } finally {
      f.close();
    }
  });

  test('the threshold is the helper\'s own variable and default (18 hours)', async () => {
    const f = fixture({ '2026-10-20.jsonl': record('1', CAPTURED_AT) });
    try {
      const byDefault = createTelegramConnectorStoreSyncHandler({
        stores: f.stores,
        spoolDir: f.spoolDir,
        env: {},
        now: at('2026-10-21T04:01:00.000Z'),
      });
      expect((await byDefault.pull()).capture).toMatchObject({ status: 'stale', threshold_seconds: 64_800 });
      const byEnv = createTelegramConnectorStoreSyncHandler({
        stores: f.stores,
        spoolDir: f.spoolDir,
        env: { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_STALE_THRESHOLD_SECONDS: '172800' },
        now: at('2026-10-21T04:01:00.000Z'),
      });
      expect((await byEnv.pull()).capture).toMatchObject({ status: 'fresh', threshold_seconds: 172_800 });
    } finally {
      f.close();
    }
  });

  test('a threshold that is not a positive whole number is refused when the handler is made', () => {
    const f = fixture();
    try {
      for (const bad of ['0', '-5', '1.5', 'soon']) {
        expect(() => createTelegramConnectorStoreSyncHandler({
          stores: f.stores,
          spoolDir: f.spoolDir,
          env: { OLYMPUS_TELEGRAM_GATEWAY_SPOOL_STALE_THRESHOLD_SECONDS: bad },
        })).toThrow('Telegram capture stale threshold must be a positive integer.');
      }
    } finally {
      f.close();
    }
  });

  test('the receipt carries counts and a verdict, never the captured time', async () => {
    const f = fixture({ '2026-10-20.jsonl': record('1', CAPTURED_AT) });
    try {
      const sync = createTelegramConnectorStoreSyncHandler({
        stores: f.stores,
        spoolDir: f.spoolDir,
        now: at('2026-10-20T12:00:00.000Z'),
      });
      const serialized = JSON.stringify(await sync.pull());
      expect(serialized).not.toContain(CAPTURED_AT);
      expect(serialized).not.toContain('captured_at');
    } finally {
      f.close();
    }
  });

  test('the dashboard reads back exactly the verdict the receipt made, from its counts alone', async () => {
    const f = fixture({ '2026-10-20.jsonl': record('1', CAPTURED_AT) });
    try {
      const sync = createTelegramConnectorStoreSyncHandler({
        stores: f.stores,
        spoolDir: f.spoolDir,
        spoolStaleThresholdSeconds: 600,
        now: at('2026-10-20T11:00:00.000Z'),
      });
      const receipt = await sync.pull();
      expect(captureFreshnessFromCounts(receipt.counts)).toEqual(receipt.capture);
    } finally {
      f.close();
    }
  });

  test('a new message moves the verdict on the next pull, and a half-written line does not', async () => {
    const f = fixture({ '2026-10-20.jsonl': record('1', CAPTURED_AT) });
    try {
      const sync = createTelegramConnectorStoreSyncHandler({
        stores: f.stores,
        spoolDir: f.spoolDir,
        spoolStaleThresholdSeconds: 3_600,
        now: at('2026-10-20T13:00:00.000Z'),
      });
      expect((await sync.pull()).capture.status).toBe('stale');
      const spool = join(f.spoolDir, '2026-10-20.jsonl');
      // The helper is mid-write: no newline yet. Not a capture.
      appendFileSync(spool, record('2', '2026-10-20T12:55:00.000Z').trimEnd());
      expect((await sync.pull()).capture.status).toBe('stale');
      appendFileSync(spool, '\n');
      expect((await sync.pull()).capture).toMatchObject({ status: 'fresh', age_seconds: 300 });
    } finally {
      f.close();
    }
  });
});

describe('readTelegramCaptureSpoolNewestCapturedAt', () => {
  test('is undefined for a spool that is missing or has no records', () => {
    expect(readTelegramCaptureSpoolNewestCapturedAt(join(tmpdir(), 'olympus-no-such-spool-dir-for-freshness'))).toBeUndefined();
    const f = fixture();
    try {
      expect(readTelegramCaptureSpoolNewestCapturedAt(f.spoolDir)).toBeUndefined();
    } finally {
      f.close();
    }
  });

  test('skips a damaged record and a record that is not Telegram\'s, and returns the newest good one', () => {
    const f = fixture({
      '2026-10-20.jsonl': record('1', CAPTURED_AT)
        + '{broken json}\n'
        + JSON.stringify({ provider: 'whatsapp', captured_at: '2026-10-25T00:00:00.000Z' }) + '\n',
    });
    try {
      expect(readTelegramCaptureSpoolNewestCapturedAt(f.spoolDir)).toBe(CAPTURED_AT);
    } finally {
      f.close();
    }
  });

  // The importer skips a record its own validation rejects, so such a record
  // must not make a feed that imports nothing read fresh. Each of these parses
  // as JSON and carries a current captured_at.
  const withChange = (change: (value: Record<string, any>) => void, messageId = '9'): string => {
    const value = JSON.parse(record(messageId, '2026-10-20T12:55:00.000Z')) as Record<string, any>;
    change(value);
    return JSON.stringify(value) + '\n';
  };
  const invalidRecords: Record<string, string> = {
    'no message at all': withChange((value) => { delete value.message; }),
    'a message with no id': withChange((value) => { delete value.message.id; }),
    'a capture identity that does not match its message': withChange((value) => { value.capture_id = 'f'.repeat(64); }),
    'a conversation that is not the one it declares': withChange((value) => { value.chat_scope = `${ACCOUNT}:chat:other`; }),
    'an unsupported schema version': withChange((value) => { value.schema_version = 2; }),
    'a classification that disagrees with its trust domain': withChange((value) => { value.classification.trust_domain = 'secure_local'; }),
  };

  for (const [name, line] of Object.entries(invalidRecords)) {
    test(`a record with ${name} is not a capture, whatever its timestamp says`, () => {
      const f = fixture({ '2026-10-20.jsonl': line });
      try {
        expect(readTelegramCaptureSpoolNewestCapturedAt(f.spoolDir)).toBeUndefined();
      } finally {
        f.close();
      }
    });

    test(`a spool of nothing but records with ${name} reads unavailable on the receipt, not fresh`, async () => {
      const f = fixture({ '2026-10-20.jsonl': line + line.replace('"9"', '"10"') });
      try {
        const sync = createTelegramConnectorStoreSyncHandler({
          stores: f.stores,
          spoolDir: f.spoolDir,
          now: at('2026-10-20T13:00:00.000Z'),
        });
        const receipt = await sync.pull();
        expect(receipt.capture).toEqual({ status: 'unavailable', threshold_seconds: DEFAULT_CAPTURE_STALE_THRESHOLD_SECONDS });
        expect(receipt.counts).toMatchObject({ capture_fresh: 0, capture_unavailable: 1 });
      } finally {
        f.close();
      }
    });
  }

  test('a newer invalid record does not hide an older good one: the age is the good one\'s', () => {
    const f = fixture({
      '2026-10-20.jsonl': record('1', CAPTURED_AT) + invalidRecords['no message at all'],
      '2026-10-21.jsonl': invalidRecords['a message with no id']!,
    });
    try {
      expect(readTelegramCaptureSpoolNewestCapturedAt(f.spoolDir)).toBe(CAPTURED_AT);
    } finally {
      f.close();
    }
  });

  test('repeated invalid records keep a broken feed stale rather than fresh', async () => {
    const f = fixture({
      '2026-10-20.jsonl': record('1', CAPTURED_AT) + Object.values(invalidRecords).join(''),
    });
    try {
      const sync = createTelegramConnectorStoreSyncHandler({
        stores: f.stores,
        spoolDir: f.spoolDir,
        spoolStaleThresholdSeconds: 3_600,
        now: at('2026-10-20T13:00:00.000Z'),
      });
      expect((await sync.pull()).capture).toEqual({ status: 'stale', threshold_seconds: 3_600, age_seconds: 10_800 });
    } finally {
      f.close();
    }
  });
});
