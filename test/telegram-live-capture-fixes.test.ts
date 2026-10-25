/**
 * Live Telegram capture fixes (docs/design/archive-live-one-dataset.md,
 * "Best of both", step 3 for Telegram):
 *
 * - the spool is read a bounded pass at a time, never whole, and a backlog of
 *   any size is read in passes instead of failing;
 * - a cursor that names no place in the spool any more is read again from the
 *   start (and said so) instead of stopping the lane for good;
 * - a quiet account with a running helper reads fresh, told apart from a
 *   stopped capture;
 * - the live item carries the archive's richer text: service messages as
 *   sentences, sender, chat and forward names in its search context.
 *
 * Synthetic spool files only; no helper, no network.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  TELEGRAM_CAPTURE_CONNECTOR_IDS,
  TELEGRAM_CAPTURE_HEARTBEAT_FILE,
  TELEGRAM_SPOOL_CURSOR_RESET_WARNING,
  createTelegramConnectorStoreSyncHandler,
  readTelegramCaptureSpool,
  telegramCaptureLiveness,
  telegramCaptureSpoolCursorState,
  telegramMessageItem,
} from '../src/workers/telegram-messages/index.ts';
import { redactTelegramCaptureSpoolSecrets } from '../src/workers/telegram-messages/capture-spool-connector.ts';
import { forgetSpoolOffsets } from '../src/workers/telegram-messages/spool-lines.ts';

const ACCOUNT = 'telegram.personal';
const CAPTURED_AT = '2026-10-20T10:00:00.000Z';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function record(messageId: string, options: { capturedAt?: string; text?: string; extra?: Record<string, unknown> } = {}): string {
  const sourceVersion = `${ACCOUNT}:chat-1:${messageId}:v1`;
  return JSON.stringify({
    schema_version: 1,
    capture_id: sha256([ACCOUNT, 'chat-1', messageId, sourceVersion].join('\x1f')),
    captured_at: options.capturedAt ?? CAPTURED_AT,
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
      chatType: 'group',
      boundedText: options.text ?? `message ${messageId}`,
      sentAt: '2026-10-20T09:59:00.000Z',
      sourceVersion,
      ...(options.extra ?? {}),
    },
  }) + '\n';
}

const records = (from: number, to: number): string => {
  let out = '';
  for (let id = from; id <= to; id += 1) out += record(String(id));
  return out;
};

const roots: string[] = [];
afterEach(() => {
  forgetSpoolOffsets();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function spool(files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-live-fixes-'));
  roots.push(root);
  const dir = join(root, 'spool');
  mkdirSync(dir);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

function stores(spoolDir: string) {
  const root = join(spoolDir, '..');
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
  return { internal, secureLocal, close() { internal.close(); secureLocal.close(); } };
}

const ids = (result: ReturnType<typeof readTelegramCaptureSpool>): string[] =>
  result.records.map((entry) => entry.capturedItem.item.identity.providerItemId);

describe('the spool is read in bounded passes', () => {
  test('a read stops at its byte bound with a resume point, and passes from it read every record once', () => {
    const dir = spool({ '2026-10-01.jsonl': records(1, 30), '2026-10-02.jsonl': records(31, 60) });
    const lineBytes = Buffer.byteLength(record('10'));
    const seen: string[] = [];
    let cursor: string | undefined;
    let passes = 0;
    for (;;) {
      passes += 1;
      const result = readTelegramCaptureSpool({
        spoolDir: dir,
        malformedPolicy: 'skip',
        maxReadBytes: lineBytes * 7,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...ids(result));
      if (result.exhausted) break;
      expect(result.resumeCursor).not.toBe(cursor);
      cursor = result.resumeCursor;
      expect(passes).toBeLessThan(50);
    }
    expect(seen).toEqual(Array.from({ length: 60 }, (_, index) => String(index + 1)));
    // About seven records a pass, never the whole spool at once.
    expect(passes).toBeGreaterThanOrEqual(8);
  });

  test('a resume point read cold (no remembered offsets) gives the same records as one read warm', () => {
    const dir = spool({ '2026-10-01.jsonl': records(1, 20) });
    const first = readTelegramCaptureSpool({ spoolDir: dir, limit: 5 });
    expect(first.resumeCursor).toBe('2026-10-01.jsonl:5');
    const warm = ids(readTelegramCaptureSpool({ spoolDir: dir, cursor: first.resumeCursor!, limit: 3 }));
    forgetSpoolOffsets();
    const cold = ids(readTelegramCaptureSpool({ spoolDir: dir, cursor: first.resumeCursor!, limit: 3 }));
    expect(warm).toEqual(['6', '7', '8']);
    expect(cold).toEqual(['6', '7', '8']);
  });

  test('a remembered offset of a file that was replaced is not trusted', () => {
    const dir = spool({ '2026-10-01.jsonl': records(1, 10) });
    const first = readTelegramCaptureSpool({ spoolDir: dir, limit: 4 });
    expect(first.resumeCursor).toBe('2026-10-01.jsonl:4');
    // A different file under the same name: longer records, so line 4 starts elsewhere.
    const path = join(dir, '2026-10-01.jsonl');
    unlinkSync(path);
    let replaced = '';
    for (let id = 101; id <= 110; id += 1) replaced += record(String(id), { text: `a much longer message body ${'x'.repeat(200)} ${id}` });
    writeFileSync(path, replaced);
    expect(ids(readTelegramCaptureSpool({ spoolDir: dir, cursor: first.resumeCursor!, limit: 2 }))).toEqual(['105', '106']);
  });

  test('a record longer than the record bound is counted as damaged and passed, never held', () => {
    const dir = spool({ '2026-10-01.jsonl': record('1') + record('2', { text: 'y'.repeat(5_000) }) + record('3') });
    const result = readTelegramCaptureSpool({ spoolDir: dir, malformedPolicy: 'skip', maxRecordBytes: 2_000 });
    expect(ids(result)).toEqual(['1', '3']);
    expect(result.malformedRecords).toBe(1);
    expect(result.exhausted).toBe(true);
    expect(() => readTelegramCaptureSpool({ spoolDir: dir, malformedPolicy: 'reject', maxRecordBytes: 2_000 }))
      .toThrow('Telegram capture spool found a malformed record.');
  });

  test('a torn final record (no newline yet) is left for the next read', () => {
    const dir = spool({ '2026-10-01.jsonl': record('1') + record('2').slice(0, 40) });
    const result = readTelegramCaptureSpool({ spoolDir: dir, malformedPolicy: 'skip' });
    expect(ids(result)).toEqual(['1']);
    expect(result.resumeCursor).toBe('2026-10-01.jsonl:1');
    expect(result.malformedRecords).toBe(0);
  });

  test('a pull over a backlog larger than one read finishes it over several pulls', async () => {
    const dir = spool({ '2026-10-01.jsonl': records(1, 40) });
    const s = stores(dir);
    try {
      const sync = createTelegramConnectorStoreSyncHandler({ stores: s, spoolDir: dir, maxItems: 15 });
      let indexed = 0;
      for (let pull = 0; pull < 5; pull += 1) indexed += (await sync.pull()).counts.items_indexed;
      expect(indexed).toBe(40);
      expect(s.internal.lastCompletedSyncRun(TELEGRAM_CAPTURE_CONNECTOR_IDS.internal)?.cursor).toBe('2026-10-01.jsonl:40');
    } finally {
      s.close();
    }
  });
});

describe('a cursor that names no place in the spool', () => {
  test('its file gone while older files remain: read again from the start, not a stop', () => {
    const dir = spool({ '2026-10-01.jsonl': records(1, 2), '2026-10-03.jsonl': records(5, 6) });
    expect(telegramCaptureSpoolCursorState(dir, '2026-10-02.jsonl:7')).toBe('reset');
    const result = readTelegramCaptureSpool({ spoolDir: dir, cursor: '2026-10-02.jsonl:7' });
    expect(result.cursorReset).toBe(true);
    expect(ids(result)).toEqual(['1', '2', '5', '6']);
  });

  test('its file shorter than the cursor says: read again from the start', () => {
    const dir = spool({ '2026-10-01.jsonl': records(1, 3) });
    expect(telegramCaptureSpoolCursorState(dir, '2026-10-01.jsonl:9')).toBe('reset');
    expect(ids(readTelegramCaptureSpool({ spoolDir: dir, cursor: '2026-10-01.jsonl:9' }))).toEqual(['1', '2', '3']);
  });

  test('a cursor past every file (an emptied spool) and one at a file\'s end are still places', () => {
    const dir = spool({ '2026-10-01.jsonl': records(1, 3) });
    expect(telegramCaptureSpoolCursorState(dir, '2026-10-01.jsonl:3')).toBe('ok');
    expect(telegramCaptureSpoolCursorState(spool(), '2026-10-05.jsonl:2')).toBe('ok');
    expect(readTelegramCaptureSpool({ spoolDir: dir, cursor: '2026-10-01.jsonl:3' }).records).toEqual([]);
  });

  test('a pull whose stored cursor\'s file was removed keeps capturing and says so', async () => {
    const dir = spool({ '2026-10-01.jsonl': records(1, 2), '2026-10-02.jsonl': records(3, 4) });
    const s = stores(dir);
    try {
      const sync = createTelegramConnectorStoreSyncHandler({ stores: s, spoolDir: dir });
      expect((await sync.pull()).counts.items_indexed).toBe(4);
      // The file the lanes stopped in is pruned; the next day's capture lands after it.
      unlinkSync(join(dir, '2026-10-02.jsonl'));
      writeFileSync(join(dir, '2026-10-03.jsonl'), records(5, 6));
      const receipt = await sync.pull();
      expect(receipt.warnings).toContain(TELEGRAM_SPOOL_CURSOR_RESET_WARNING);
      expect(receipt.counts.spool_cursor_resets).toBe(2);
      // Read again from the start: the two it held are seen again and stay as they were.
      expect(receipt.counts.items_seen).toBe(4);
      expect(receipt.counts.items_changed).toBe(2);
      expect(s.internal.itemPresence({ provider: 'telegram', accountScope: ACCOUNT, providerItemId: '6', providerConversationId: 'chat-1' }).active).toBe(true);
      // Back in step: the next pull has nothing to reset.
      const next = await sync.pull();
      expect(next.warnings ?? []).not.toContain(TELEGRAM_SPOOL_CURSOR_RESET_WARNING);
      expect(next.counts.spool_cursor_resets).toBe(0);
    } finally {
      s.close();
    }
  });
});

describe('a quiet account is told apart from a stopped capture', () => {
  const now = Date.parse('2026-10-21T12:00:00.000Z');
  const old = '2026-10-19T12:00:00.000Z';

  test('the rule: age from the newer of record and heartbeat; quiet when only the heartbeat is fresh', () => {
    expect(telegramCaptureLiveness(old, '2026-10-21T11:55:00.000Z', now, 3_600))
      .toEqual({ status: 'fresh', threshold_seconds: 3_600, age_seconds: 300, quiet: true });
    expect(telegramCaptureLiveness(old, undefined, now, 3_600))
      .toEqual({ status: 'stale', threshold_seconds: 3_600, age_seconds: 172_800, quiet: false });
    expect(telegramCaptureLiveness(old, '2026-10-20T12:00:00.000Z', now, 3_600))
      .toEqual({ status: 'stale', threshold_seconds: 3_600, age_seconds: 86_400, quiet: false });
    expect(telegramCaptureLiveness('2026-10-21T11:59:00.000Z', '2026-10-21T11:00:00.000Z', now, 3_600))
      .toEqual({ status: 'fresh', threshold_seconds: 3_600, age_seconds: 60, quiet: false });
    expect(telegramCaptureLiveness(undefined, '2026-10-21T11:59:00.000Z', now, 3_600))
      .toEqual({ status: 'fresh', threshold_seconds: 3_600, age_seconds: 60, quiet: true });
    // A heartbeat from the future (a clock moved back) is not believed.
    expect(telegramCaptureLiveness(old, '2026-10-22T12:00:00.000Z', now, 3_600))
      .toEqual({ status: 'stale', threshold_seconds: 3_600, age_seconds: 172_800, quiet: false });
  });

  test('a pull reads the helper\'s heartbeat beside the spool', async () => {
    const dir = spool({ '2026-10-19.jsonl': record('1', { capturedAt: old }) });
    const s = stores(dir);
    try {
      const sync = createTelegramConnectorStoreSyncHandler({
        stores: s,
        spoolDir: dir,
        spoolStaleThresholdSeconds: 3_600,
        now: () => new Date(now),
      });
      const before = await sync.pull();
      expect(before.capture.status).toBe('stale');
      expect(before.counts.capture_quiet).toBe(0);
      writeFileSync(join(dir, TELEGRAM_CAPTURE_HEARTBEAT_FILE), JSON.stringify({
        kind: 'telegram_capture_heartbeat', schema_version: 1, cycle_completed_at: '2026-10-21T11:50:00Z',
      }));
      const after = await sync.pull();
      expect(after.capture).toEqual({ status: 'fresh', threshold_seconds: 3_600, age_seconds: 600 });
      expect(after.counts).toMatchObject({ capture_fresh: 1, capture_stale: 0, capture_quiet: 1 });
      // A heartbeat that does not read is no heartbeat.
      writeFileSync(join(dir, TELEGRAM_CAPTURE_HEARTBEAT_FILE), '{"kind":"something_else","cycle_completed_at":"2026-10-21T11:50:00Z"}');
      expect((await sync.pull()).capture.status).toBe('stale');
    } finally {
      s.close();
    }
  });
});

describe('the live item carries the richer text', () => {
  const build = (message: Record<string, unknown>) => telegramMessageItem({
    account: ACCOUNT,
    conversationId: 'chat-1',
    trustDomain: 'internal',
    corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    message: { id: '9', conversationId: 'chat-1', ...message },
    fetchedAt: CAPTURED_AT,
  }).item;

  test('a service message is a sentence naming who did it, not an empty item', () => {
    const call = build({ senderDisplayName: 'Ada', service: { action: 'phone_call', duration_seconds: 65 } });
    expect(call.content).toEqual({ kind: 'text', text: 'Ada made a phone call that lasted 1 minute 5 seconds.' });
    expect(call.metadata).toMatchObject({ serviceMessage: true, serviceAction: 'phone_call' });
    const pin = build({ senderDisplayName: 'Ada', replyToMessageId: '4', service: { action: 'pin_message' } });
    expect(pin.content).toEqual({ kind: 'text', text: 'Ada pinned message 4.' });
    const title = build({ service: { action: 'edit_group_title', title: 'Trip planning' } });
    expect(title.content).toEqual({ kind: 'text', text: 'Someone changed the group name to "Trip planning".' });
    // Fields the export does not name are not read into the text.
    const smuggled = build({ senderDisplayName: 'Ada', service: { action: 'clear_history', note: 'hidden words' } });
    expect(smuggled.content).toEqual({ kind: 'text', text: 'Ada cleared the chat history.' });
  });

  test('the search context names the chat, the sender and who a forward came from', () => {
    const item = build({
      boundedText: 'see this',
      chatTitle: 'Chat one',
      senderDisplayName: 'Sam',
      forwardSource: 'telegram_forward',
      forwardFromName: 'News Channel',
      attachments: [{ attachmentId: 'document:1', type: 'file', name: 'plan.pdf' }],
    });
    expect(item.content).toEqual({ kind: 'text', text: 'see this' });
    expect(item.metadata.searchText).toBe('see this\nplan.pdf\nForwarded from News Channel\nSam\nChat one');
    expect(item.metadata).toMatchObject({ forwardedFrom: 'News Channel', forwardSource: 'telegram_forward', senderLabel: 'Sam' });
  });

  test('a Secrets rewrite takes the forward name with the names, and a service event\'s words with the text', () => {
    const dir = spool({
      '2026-10-01.jsonl': record('1', { extra: { forwardFromName: 'Origin Name', participantDisplayNames: { 'sender-1': 'Sam' } } })
        + record('2', { text: '', extra: { boundedText: undefined, service: { action: 'edit_group_title', title: 'Secret title words' } } }),
    });
    const result = redactTelegramCaptureSpoolSecrets({
      spoolDir: dir,
      judge: (identity) => (identity.providerItemId === '1' ? 'names' : 'content'),
    });
    expect(result.recordsRedacted).toBe(2);
    const [named, service] = readFileSync(join(dir, '2026-10-01.jsonl'), 'utf8').split('\n');
    expect(named).not.toContain('Origin Name');
    expect(named).not.toContain('"Sam"');
    expect(service).not.toContain('Secret title words');
    const read = readTelegramCaptureSpool({ spoolDir: dir });
    expect(read.records.map((entry) => entry.capturedItem.item.content)).toEqual([
      { kind: 'metadata_only' },
      { kind: 'text', text: 'Sam changed the group name.' },
    ]);
  });
});
