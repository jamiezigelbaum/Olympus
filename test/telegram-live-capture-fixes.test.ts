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
  TELEGRAM_TRUST_CLAIM_KEPT_NEWER_WARNING,
  createTelegramConnectorStoreSyncHandler,
  readTelegramCaptureSpool,
  telegramCaptureLiveness,
  telegramCaptureSpoolCursorState,
  telegramMessageItem,
} from '../src/workers/telegram-messages/index.ts';
import { redactTelegramCaptureSpoolSecrets } from '../src/workers/telegram-messages/capture-spool-connector.ts';
import { forgetSpoolOffsets } from '../src/workers/telegram-messages/spool-lines.ts';
import { createLaneTieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';

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

describe('review fixes (Astra, #545)', () => {
  const editedRecord = (text: string, editedAt: string): string => {
    const line = JSON.parse(record('A', { text }));
    const sourceVersion = `${ACCOUNT}:chat-1:A:${editedAt}`;
    line.message.editedAt = editedAt;
    line.message.sourceVersion = sourceVersion;
    line.capture_id = sha256([ACCOUNT, 'chat-1', 'A', sourceVersion].join('\x1f'));
    return `${JSON.stringify(line)}\n`;
  };

  test('a cursor read again from the start never puts back an older version of a message', async () => {
    const dir = spool({
      '2026-10-01.jsonl': editedRecord('A as first written', '2026-10-01T09:00:00Z'),
      '2026-10-02.jsonl': editedRecord('A after its edit', '2026-10-02T09:00:00Z'),
    });
    const s = stores(dir);
    try {
      const sync = createTelegramConnectorStoreSyncHandler({ stores: s, spoolDir: dir });
      await sync.pull();
      const text = () => s.internal.localContent(`${ACCOUNT}:chat-1:A`)?.chunks.join(' ');
      expect(text()).toBe('A after its edit');
      unlinkSync(join(dir, '2026-10-02.jsonl'));
      writeFileSync(join(dir, '2026-10-03.jsonl'), record('B'));
      const receipt = await sync.pull();
      expect(receipt.counts.spool_cursor_resets).toBe(2);
      // Day 1's first version was read again, and did not replace the newer one.
      expect(text()).toBe('A after its edit');
      expect(s.internal.localContent(`${ACCOUNT}:chat-1:B`)?.chunks.join(' ')).toBe('message B');
      await sync.pull();
      expect(text()).toBe('A after its edit');
    } finally {
      s.close();
    }
  });

  test('a forward\'s origin and attachment names are judged as the item\'s names', async () => {
    const key = '-----BEGIN RSA ' + 'PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
    const dir = spool({
      '2026-10-01.jsonl': record('1', { text: 'an ordinary note', extra: { forwardSource: 'telegram_forward', forwardFromName: key } })
        + record('2', { text: 'another ordinary note', extra: { attachments: [{ attachmentId: 'document:1', type: 'file', name: key }] } })
        + record('3', { text: 'a plain note' }),
    });
    const s = stores(dir);
    const set = createLaneTieredStoreSet({ setId: 'telegram.messages', internalStore: s.internal, secureStore: s.secureLocal, splitLayers: false });
    try {
      const sync = createTelegramConnectorStoreSyncHandler({ stores: s, spoolDir: dir, tierSet: set });
      await sync.pull();
      const tierOf = (id: string) => set.ledger.getCurrent({ provider: 'telegram', accountScope: ACCOUNT, providerConversationId: 'chat-1', providerItemId: id });
      expect(tierOf('1')?.metadataTier).toBe('secrets');
      expect(tierOf('2')?.metadataTier).toBe('secrets');
      expect(tierOf('3')?.metadataTier).not.toBe('secrets');
      // Nothing of the key is searchable in either store.
      expect(s.internal.searchItems('MIIEowIBAAKCAQEA', 5)).toHaveLength(0);
      expect(s.secureLocal.searchItems('MIIEowIBAAKCAQEA', 5)).toHaveLength(0);
    } finally {
      s.close();
    }
  });

  test('a Secrets rewrite reads a spool file in chunks and stays inside its window', () => {
    // Records of about 300 KB each, so the window crosses the reader's 1 MB chunks.
    let text = '';
    for (let id = 1; id <= 10; id += 1) text += record(String(id), { text: `${id} ${'z'.repeat(300_000)}` });
    const dir = spool({ '2026-10-01.jsonl': text });
    const before = readFileSync(join(dir, '2026-10-01.jsonl'));
    const judged: string[] = [];
    const result = redactTelegramCaptureSpoolSecrets({
      spoolDir: dir,
      from: '2026-10-01.jsonl:3',
      through: '2026-10-01.jsonl:7',
      judge: (identity) => { judged.push(identity.providerItemId); return identity.providerItemId === '5' ? 'content' : undefined; },
    });
    // Only lines 4 to 7 were judged; only record 5 lost its text, in place, at its own length.
    expect(judged).toEqual(['4', '5', '6', '7']);
    expect(result).toEqual({ recordsRedacted: 1, recordsBlanked: 0 });
    const after = readFileSync(join(dir, '2026-10-01.jsonl'));
    expect(after.length).toBe(before.length);
    const lines = after.toString('utf8').split('\n');
    const original = before.toString('utf8').split('\n');
    expect(lines[4]).not.toContain('zzz');
    expect(JSON.parse(lines[4]!).message.secretRedacted).toBe(true);
    for (const index of [0, 1, 2, 3, 5, 6, 7, 8, 9]) expect(lines[index]).toBe(original[index]);
  });
});

describe('review fixes, round 2 (Astra, #545)', () => {
  /** A record of message A in chat-1, with its own version time, trust and fields. */
  const versioned = (options: { text?: string; at: string; trust?: 'internal' | 'secure_local'; reactions?: unknown[]; extra?: Record<string, unknown> }): string => {
    const line = JSON.parse(record('A', { text: options.text ?? 'x' }));
    const digest = options.reactions ? `:r${sha256(JSON.stringify(options.reactions)).slice(0, 8)}` : '';
    const sourceVersion = `${ACCOUNT}:chat-1:A:${options.at}${digest}`;
    line.message.editedAt = options.at;
    line.message.sourceVersion = sourceVersion;
    if (options.text === undefined) delete line.message.boundedText;
    if (options.reactions) line.message.reactions = options.reactions;
    Object.assign(line.message, options.extra ?? {});
    if (options.trust === 'secure_local') {
      line.trust_domain = 'secure_local';
      line.corpus_id = PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID;
      line.classification = { trust_domain: 'secure_local', reason: 'fixture' };
    }
    line.capture_id = sha256([ACCOUNT, 'chat-1', 'A', sourceVersion].join('\x1f'));
    return `${JSON.stringify(line)}\n`;
  };
  const contentOf = (store: LocalConnectorStore) => store.localContent(`${ACCOUNT}:chat-1:A`)?.chunks.join(' ') ?? '';

  test('a protected record older than the copy already captured moves the newest version into the protected lane', async () => {
    const dir = spool({ '2026-10-22.jsonl': versioned({ text: 'A as edited on the 22nd', at: '2026-10-22T09:00:00Z' }) });
    const s = stores(dir);
    try {
      const sync = createTelegramConnectorStoreSyncHandler({ stores: s, spoolDir: dir });
      await sync.pull();
      expect(contentOf(s.internal)).toBe('A as edited on the 22nd');
      // The chat is protected now, and the backfill brings the 21st's version under that claim.
      writeFileSync(join(dir, '2026-10-23.jsonl'), versioned({ text: 'A as written on the 21st', at: '2026-10-21T09:00:00Z', trust: 'secure_local' }));
      const receipt = await sync.pull();
      // One lane holds it, the protected one, with its newest version.
      expect(contentOf(s.internal)).toBe('');
      expect(contentOf(s.secureLocal)).toBe('A as edited on the 22nd');
      expect(receipt.counts.trust_claims_kept_newer).toBe(0);
      await sync.pull();
      expect(contentOf(s.secureLocal)).toBe('A as edited on the 22nd');
    } finally {
      s.close();
    }
  });

  test('when the spool no longer has the newer version, the newer copy stays rather than give way to the older', async () => {
    const dir = spool({ '2026-10-22.jsonl': versioned({ text: 'A as edited on the 22nd', at: '2026-10-22T09:00:00Z' }) });
    const s = stores(dir);
    try {
      const sync = createTelegramConnectorStoreSyncHandler({ stores: s, spoolDir: dir });
      await sync.pull();
      unlinkSync(join(dir, '2026-10-22.jsonl'));
      writeFileSync(join(dir, '2026-10-23.jsonl'), versioned({ text: 'A as written on the 21st', at: '2026-10-21T09:00:00Z', trust: 'secure_local' }));
      const receipt = await sync.pull();
      expect(contentOf(s.internal)).toBe('A as edited on the 22nd');
      expect(contentOf(s.secureLocal)).toBe('');
      expect(receipt.counts.trust_claims_kept_newer).toBe(1);
      expect(receipt.warnings).toContain(TELEGRAM_TRUST_CLAIM_KEPT_NEWER_WARNING);
    } finally {
      s.close();
    }
  });

  test('a captionless photo takes a new reaction count at the same version time', async () => {
    const photo = { attachments: [{ attachmentId: 'photo:1', type: 'image' }] };
    const one = [{ key: '👍', count: 1 }];
    const two = [{ key: '👍', count: 2 }];
    const dir = spool({ '2026-10-20.jsonl': versioned({ at: '2026-10-20T09:00:00Z', reactions: one, extra: photo }) });
    const s = stores(dir);
    try {
      const sync = createTelegramConnectorStoreSyncHandler({ stores: s, spoolDir: dir });
      await sync.pull();
      expect(s.internal.itemReactions(`${ACCOUNT}:chat-1:A`)).toEqual(one);
      writeFileSync(join(dir, '2026-10-21.jsonl'), versioned({ at: '2026-10-20T09:00:00Z', reactions: two, extra: photo }));
      await sync.pull();
      expect(s.internal.itemReactions(`${ACCOUNT}:chat-1:A`)).toEqual(two);
    } finally {
      s.close();
    }
  });
});
