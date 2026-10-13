// A message Olympus judges Secret is stored nowhere, so the capture spools it
// was read from must not keep it either. These tests drive the real Telegram
// and WhatsApp pulls over real spool files and prove that once an item is
// judged Secrets its text (and saved audio) is gone from the spool, while
// every line keeps its place: cursors, line counts, file sizes and identities
// are unchanged, and a replay into fresh stores still judges the item Secrets.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createLaneTieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { clearCaptureSpoolSecrets } from '../src/workers/connector-store/capture-spool-secrets.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  TELEGRAM_MESSAGES_SOURCE_ID,
  createTelegramConnectorStoreSyncHandler,
  readTelegramCaptureSpool,
} from '../src/workers/telegram-messages/index.ts';
import { redactTelegramCaptureSpoolSecrets } from '../src/workers/telegram-messages/capture-spool-connector.ts';
import {
  WHATSAPP_LIVE_CORPUS_ID,
  createWhatsAppConnectorStoreSyncHandler,
  createWhatsAppTierLane,
} from '../src/workers/whatsapp/store-sync.ts';
import { redactWhatsAppLiveSpoolSecrets } from '../src/workers/whatsapp/live-connector.ts';

// Key-shaped fixtures are assembled at run time so no literal key sits in
// the repository.
const join2 = (...parts: string[]): string => parts.join('');
const STRIPE_LIVE_KEY = join2('sk', '_live_', 'k9Xp2LmQ7vRt4WzY8bNc3HdF');
const GITHUB_TOKEN = join2('gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8');

const TELEGRAM_ACCOUNT = 'telegram.personal';
const TELEGRAM_FILE = '2026-10-13.jsonl';
const WHATSAPP_FILE = '2026-10-13.jsonl';

const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

// --- Telegram -----------------------------------------------------------------

function telegramLine(messageId: string, text: string, options: { version?: string; conversationId?: string } = {}): string {
  const conversationId = options.conversationId ?? 'porto';
  const sourceVersion = `${TELEGRAM_ACCOUNT}:${conversationId}:${messageId}:${options.version ?? 'v1'}`;
  return JSON.stringify({
    schema_version: 1,
    capture_id: createHash('sha256')
      .update([TELEGRAM_ACCOUNT, conversationId, messageId, sourceVersion].join('\x1f'))
      .digest('hex'),
    captured_at: '2026-10-13T10:01:00.000Z',
    provider: 'telegram',
    account: TELEGRAM_ACCOUNT,
    chat_scope: `${TELEGRAM_ACCOUNT}:chat:${conversationId}`,
    conversation_id: conversationId,
    corpus_id: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
    trust_domain: 'internal',
    classification: { trust_domain: 'internal', reason: 'fixture' },
    sync_direction: 'forward',
    message: {
      id: messageId,
      conversationId,
      chatTitle: 'Porto trip',
      senderId: 'sender-1',
      senderDisplayName: 'Sam',
      senderIsOwner: true,
      chatType: 'group',
      boundedText: text,
      sentAt: '2026-10-13T10:00:00.000Z',
      sourceVersion,
    },
  });
}

function openTelegram(root: string) {
  const spoolDir = join(root, 'spool');
  mkdirSync(spoolDir, { recursive: true });
  const internalDbPath = join(root, 'internal.sqlite');
  const secureDbPath = join(root, 'secure-local.sqlite');
  const stores = {
    internal: new LocalConnectorStore({
      dbPath: internalDbPath,
      corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
      family: 'chat',
      trustDomain: 'internal',
    }),
    secureLocal: new LocalConnectorStore({
      dbPath: secureDbPath,
      corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
      family: 'chat',
      trustDomain: 'secure_local',
    }),
  };
  const tierSet = createLaneTieredStoreSet({
    setId: TELEGRAM_MESSAGES_SOURCE_ID,
    internalStore: stores.internal,
    secureStore: stores.secureLocal,
    splitLayers: false,
  });
  closers.push(() => {
    stores.secureLocal.close();
    stores.internal.close();
  });
  const sync = createTelegramConnectorStoreSyncHandler({ stores, spoolDir, tierSet });
  return { spoolDir, stores, tierSet, sync, file: join(spoolDir, TELEGRAM_FILE) };
}

function storedTexts(store: LocalConnectorStore, query: string): string[] {
  return store.searchItems(query, 10).map((row) => row.sourceItem.providerItemId ?? '');
}

describe('Telegram capture spool: Secrets leave the spool', () => {
  test('after the pull judges a message Secret its text is gone from the spool, and every line keeps its place', async () => {
    const root = workspace('olympus-telegram-spool-secrets-');
    const telegram = openTelegram(root);
    const lines = [
      telegramLine('1', 'Lunch at the market on Saturday, the one by the river.'),
      telegramLine('2', `Here is the deploy key ${STRIPE_LIVE_KEY} keep it safe`),
      telegramLine('3', 'Bring the umbrella, rain all weekend.'),
    ];
    writeFileSync(telegram.file, `${lines.join('\n')}\n`);
    const sizeBefore = statSync(telegram.file).size;

    const receipt = await telegram.sync.pull();
    expect(receipt.counts.spool_records_redacted).toBe(1);
    expect(receipt.warnings ?? []).not.toContain('telegram_spool_secret_redaction_failed');

    const spool = readFileSync(telegram.file, 'utf8');
    expect(spool).not.toContain(STRIPE_LIVE_KEY);
    expect(spool).not.toContain('deploy key');
    // Ordinary messages are untouched, byte for byte.
    expect(spool.split('\n')[0]).toBe(lines[0]!);
    expect(spool.split('\n')[2]).toBe(lines[2]!);
    // Same size, same line count: every cursor still points where it did.
    expect(statSync(telegram.file).size).toBe(sizeBefore);
    expect(spool.split('\n')).toHaveLength(lines.length + 1);
    // The redacted record is still a valid record for the same message.
    const redacted = JSON.parse(spool.split('\n')[1]!);
    expect(redacted.capture_id).toBe(JSON.parse(lines[1]!).capture_id);
    expect(redacted.message).toMatchObject({ id: '2', secretRedacted: true });

    // Nothing Secret in either store, and the ordinary messages were indexed.
    expect(storedTexts(telegram.stores.internal, 'umbrella')).toEqual(['3']);
    for (const store of [telegram.stores.internal, telegram.stores.secureLocal]) {
      expect(storedTexts(store, 'deploy')).toEqual([]);
    }

    // A later pull has nothing new to clear.
    const again = await telegram.sync.pull();
    expect(again.counts.spool_records_redacted).toBe(0);
  });

  test('a replay of the redacted spool into fresh stores still judges the message Secret', async () => {
    const root = workspace('olympus-telegram-spool-replay-');
    const first = openTelegram(root);
    writeFileSync(first.file, `${[
      telegramLine('1', 'Ferry leaves at nine.'),
      telegramLine('2', `token ${GITHUB_TOKEN} for the CI box`),
    ].join('\n')}\n`);
    await first.sync.pull();
    expect(readFileSync(first.file, 'utf8')).not.toContain(GITHUB_TOKEN);

    const replayRoot = workspace('olympus-telegram-spool-replay-fresh-');
    const replay = openTelegram(replayRoot);
    writeFileSync(replay.file, readFileSync(first.file));
    await replay.sync.pull();
    const identity = { provider: 'telegram', accountScope: TELEGRAM_ACCOUNT, providerItemId: '2', providerConversationId: 'porto' };
    expect(replay.tierSet.ledger.getCurrent(identity)).toMatchObject({ contentTier: 'secrets' });
    expect(storedTexts(replay.stores.internal, 'ferry')).toEqual(['1']);
    expect(replay.stores.internal.status().counts.items + replay.stores.secureLocal.status().counts.items).toBe(1);
  });

  test('an earlier version of an edited message that carried a key is cleared too', async () => {
    const root = workspace('olympus-telegram-spool-edit-');
    const telegram = openTelegram(root);
    writeFileSync(telegram.file, `${[
      telegramLine('7', `oops ${STRIPE_LIVE_KEY}`, { version: 'v1' }),
      telegramLine('7', 'oops, wrong paste, ignore that', { version: 'v2' }),
    ].join('\n')}\n`);
    await telegram.sync.pull();
    const spool = readFileSync(telegram.file, 'utf8');
    expect(spool).not.toContain(STRIPE_LIVE_KEY);
  });

  test('a message the owner later marks Secret is cleared on the next pull', async () => {
    const root = workspace('olympus-telegram-spool-flip-');
    const telegram = openTelegram(root);
    writeFileSync(telegram.file, `${[
      telegramLine('1', 'The door code for the flat is the year we met.'),
      telegramLine('2', 'Dinner at eight.'),
    ].join('\n')}\n`);
    await telegram.sync.pull();
    expect(readFileSync(telegram.file, 'utf8')).toContain('door code');

    const identity = { provider: 'telegram', accountScope: TELEGRAM_ACCOUNT, providerItemId: '1', providerConversationId: 'porto' };
    const current = telegram.tierSet.ledger.getCurrent(identity)!;
    telegram.tierSet.ledger.flipToSecrets(identity, { expectedGeneration: current.generation });

    const receipt = await telegram.sync.pull();
    expect(receipt.counts.spool_records_redacted).toBe(1);
    const spool = readFileSync(telegram.file, 'utf8');
    expect(spool).not.toContain('door code');
    expect(spool).toContain('Dinner at eight.');
    // The reader still reads every record, the redacted one included.
    const read = readTelegramCaptureSpool({ spoolDir: telegram.spoolDir, malformedPolicy: 'skip' });
    expect(read.records).toHaveLength(2);
  });
});

describe('Capture spool clearing: retries and later decisions', () => {
  test('a window that failed is cleared again by the next pull, though ingestion moved past it', () => {
    const root = workspace('olympus-spool-clear-retry-');
    const ledger = new TierLedger({ dbPath: join(root, 'ledger.sqlite') });
    closers.push(() => ledger.close());
    const windows: Array<{ from?: string; through: string }> = [];
    let fail = true;
    const redact = (window: { from?: string; through: string }) => {
      windows.push(window);
      if (fail && window.from !== undefined) throw new Error('disk full');
      return { recordsRedacted: 0, recordsBlanked: 0 };
    };
    // First pull: the first-run sweep is due, so pass it once cleanly.
    clearCaptureSpoolSecrets({ ledger, stateKey: 'lane', from: 'a.jsonl:0', through: 'a.jsonl:5', redact: (w) => { fail = false; const r = redact(w); fail = true; return r; } });
    expect(() => clearCaptureSpoolSecrets({ ledger, stateKey: 'lane', from: 'a.jsonl:5', through: 'a.jsonl:9', redact })).toThrow('disk full');
    fail = false;
    windows.length = 0;
    // The next pull's own window starts at 9, but the failed one ended at 5.
    clearCaptureSpoolSecrets({ ledger, stateKey: 'lane', from: 'a.jsonl:9', through: 'a.jsonl:12', redact });
    expect(windows[0]).toEqual({ from: 'a.jsonl:5', through: 'a.jsonl:12' });
    windows.length = 0;
    clearCaptureSpoolSecrets({ ledger, stateKey: 'lane', from: 'a.jsonl:12', through: 'a.jsonl:14', redact });
    expect(windows[0]).toEqual({ from: 'a.jsonl:12', through: 'a.jsonl:14' });
  });

  test('a Telegram record cleared of its text loses its names too once the names are judged Secrets', () => {
    const root = workspace('olympus-telegram-spool-upgrade-');
    const spoolDir = join(root, 'spool');
    mkdirSync(spoolDir);
    const file = join(spoolDir, TELEGRAM_FILE);
    writeFileSync(file, `${telegramLine('4', `see ${GITHUB_TOKEN}`)}\n`);
    redactTelegramCaptureSpoolSecrets({ spoolDir, judge: () => 'content' });
    let message = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]!).message;
    expect(message).toMatchObject({ secretRedacted: true, chatTitle: 'Porto trip', senderDisplayName: 'Sam' });
    expect(message).not.toHaveProperty('boundedText');
    // A content-level judgment again changes nothing.
    expect(redactTelegramCaptureSpoolSecrets({ spoolDir, judge: () => 'content' }).recordsRedacted).toBe(0);
    expect(redactTelegramCaptureSpoolSecrets({ spoolDir, judge: () => 'names' }).recordsRedacted).toBe(1);
    message = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]!).message;
    expect(message).not.toHaveProperty('chatTitle');
    expect(message).not.toHaveProperty('senderDisplayName');
    expect(message).toMatchObject({ id: '4', secretRedacted: true });
  });

  test('a later names-level Secrets decision changes the sweep state, so the sweep runs again', async () => {
    const root = workspace('olympus-telegram-spool-names-later-');
    const telegram = openTelegram(root);
    writeFileSync(telegram.file, `${telegramLine('1', 'The door code for the flat is the year we met.')}\n`);
    await telegram.sync.pull();
    const identity = { provider: 'telegram', accountScope: TELEGRAM_ACCOUNT, providerItemId: '1', providerConversationId: 'porto' };
    telegram.tierSet.ledger.recordContentDecision(identity, {
      contentTier: 'secrets',
      decidedBy: 'secret_detector',
      reasons: ['content:secret_fixture'],
      contentPending: false,
      engineVersion: 'fixture',
      mapRevision: 'fixture',
      snifferId: 'fixture',
    });
    await telegram.sync.pull();
    let message = JSON.parse(readFileSync(telegram.file, 'utf8').split('\n')[0]!).message;
    expect(message).not.toHaveProperty('boundedText');
    expect(message.chatTitle).toBe('Porto trip');

    const current = telegram.tierSet.ledger.getCurrent(identity)!;
    expect(current.metadataTier).not.toBe('secrets');
    telegram.tierSet.ledger.flipToSecrets(identity, { expectedGeneration: current.generation });
    await telegram.sync.pull();
    message = JSON.parse(readFileSync(telegram.file, 'utf8').split('\n')[0]!).message;
    expect(message).not.toHaveProperty('chatTitle');
    expect(message).not.toHaveProperty('senderDisplayName');
  });
});

// --- WhatsApp -----------------------------------------------------------------

function whatsappLine(fields: Record<string, unknown>): string {
  return JSON.stringify({
    chat_jid: '15550001111@s.whatsapp.net',
    chat_name: 'Alex',
    sender_jid: '15550001111@s.whatsapp.net',
    sender_name: 'Alex',
    from_me: false,
    timestamp: '2026-10-13T09:00:00Z',
    ...fields,
  });
}

function openWhatsApp(root: string) {
  const spoolDir = join(root, 'spool');
  const mediaDir = join(root, 'media', 'audio');
  mkdirSync(spoolDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });
  const store = new LocalConnectorStore({
    dbPath: join(root, 'whatsapp.db'),
    corpusId: WHATSAPP_LIVE_CORPUS_ID,
    family: 'chat',
    trustDomain: 'secure_local',
  });
  const lane = createWhatsAppTierLane({
    store,
    env: { OLYMPUS_SOURCE_INDEX_WHATSAPP_INTERNAL_CONNECTOR_STORE_DB_PATH: join(root, 'whatsapp-internal.db') },
  });
  closers.push(() => {
    lane.newStores.internal?.current()?.close();
    store.close();
  });
  // A fresh lane: nothing stored before routing, so nothing to adopt.
  const tierSet = lane.set;
  const sync = createWhatsAppConnectorStoreSyncHandler({
    store,
    spoolDir,
    mediaDir,
    tierSet,
    now: () => new Date('2026-10-13T10:00:00Z'),
  });
  return { spoolDir, mediaDir, store, tierSet, sync, file: join(spoolDir, WHATSAPP_FILE) };
}

describe('WhatsApp capture spool: Secrets leave the spool', () => {
  test('a message carrying a key loses its text and preview from the spool after the pull', async () => {
    const root = workspace('olympus-whatsapp-spool-secrets-');
    const whatsapp = openWhatsApp(root);
    const lines = [
      whatsappLine({ id: 'A1', text: 'Are we still on for the climbing gym tomorrow?' }),
      whatsappLine({ id: 'A2', text: `prod key ${STRIPE_LIVE_KEY}`, preview_title: 'Stripe dashboard' }),
    ];
    writeFileSync(whatsapp.file, `${lines.join('\n')}\n`);
    const sizeBefore = statSync(whatsapp.file).size;

    const receipt = await whatsapp.sync.pull();
    expect(receipt.counts.spool_records_redacted).toBe(1);

    const spool = readFileSync(whatsapp.file, 'utf8');
    expect(spool).not.toContain(STRIPE_LIVE_KEY);
    expect(spool).not.toContain('Stripe dashboard');
    expect(spool.split('\n')[0]).toBe(lines[0]!);
    expect(statSync(whatsapp.file).size).toBe(sizeBefore);
    expect(JSON.parse(spool.split('\n')[1]!)).toMatchObject({ id: 'A2', text: '', secret_redacted: true });
    expect(whatsapp.store.searchItems('climbing', 5).map((row) => row.sourceItem.providerItemId)).toEqual(['A1']);
    expect(whatsapp.store.searchItems('prod', 5)).toEqual([]);
  });

  test('a voice note later judged Secret loses its saved audio and re-download keys', async () => {
    const root = workspace('olympus-whatsapp-spool-media-');
    const whatsapp = openWhatsApp(root);
    const audioPath = join(whatsapp.mediaDir, 'V1.ogg');
    writeFileSync(audioPath, 'fake ogg bytes');
    // A file outside the media directory that a line names must never be deleted.
    const outside = join(root, 'not-media.txt');
    writeFileSync(outside, 'keep me');
    writeFileSync(whatsapp.file, `${[
      whatsappLine({
        id: 'V1',
        text: '',
        media_type: 'audio',
        media_mime: 'audio/ogg',
        media_path: audioPath,
        media_key: 'bWVkaWEta2V5LWZpeHR1cmU=',
        media_direct_path: '/v/t62.7117-24/fixture',
        download_status: 'ok',
      }),
      whatsappLine({ id: 'V2', text: '', media_type: 'audio', media_path: outside }),
    ].join('\n')}\n`);
    await whatsapp.sync.pull();
    expect(existsSync(audioPath)).toBe(true);

    // What the extraction factory records when a transcript is judged Secrets.
    for (const id of ['V1', 'V2']) {
      const identity = { provider: 'whatsapp', accountScope: 'personal', providerItemId: id, providerConversationId: '15550001111@s.whatsapp.net' };
      expect(whatsapp.tierSet.ledger.recordContentDecision(identity, {
        contentTier: 'secrets',
        decidedBy: 'secret_detector',
        reasons: ['content:secret_fixture'],
        contentPending: false,
        engineVersion: 'fixture',
        mapRevision: 'fixture',
        snifferId: 'fixture',
      })).toBeDefined();
    }
    const receipt = await whatsapp.sync.pull();
    // V1 loses its re-download keys; V2 had nothing in its line to remove.
    expect(receipt.counts.spool_records_redacted).toBe(1);

    expect(existsSync(audioPath)).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('keep me');
    const [voice] = readFileSync(whatsapp.file, 'utf8').split('\n');
    const record = JSON.parse(voice!);
    expect(record).toMatchObject({ id: 'V1', secret_redacted: true });
    expect(record).not.toHaveProperty('media_key');
    expect(record).not.toHaveProperty('media_direct_path');
  });
  test('mentions go with the text, and audio another chat\'s message also names is kept', () => {
    const root = workspace('olympus-whatsapp-spool-mentions-');
    const spoolDir = join(root, 'spool');
    const mediaDir = join(root, 'media', 'audio');
    mkdirSync(spoolDir, { recursive: true });
    mkdirSync(mediaDir, { recursive: true });
    const shared = join(mediaDir, 'SAME.ogg');
    writeFileSync(shared, 'audio');
    const file = join(spoolDir, WHATSAPP_FILE);
    writeFileSync(file, `${[
      whatsappLine({ id: 'M1', text: `hi @111 ${STRIPE_LIVE_KEY}`, mentions: { '111': `Ops ${STRIPE_LIVE_KEY}` } }),
      whatsappLine({ id: 'SAME', text: '', media_type: 'audio', media_path: shared }),
      whatsappLine({ id: 'SAME', chat_jid: '15550002222@s.whatsapp.net', text: '', media_type: 'audio', media_path: shared }),
    ].join('\n')}\n`);
    const secret = new Set(['M1', '15550001111@s.whatsapp.net SAME']);
    const result = redactWhatsAppLiveSpoolSecrets({
      spoolDir,
      mediaDir,
      judge: (identity) => secret.has(identity.providerItemId)
        || secret.has(`${identity.providerConversationId} ${identity.providerItemId}`) ? 'content' : undefined,
    });
    // The voice note had no text to remove: only its audio is its content.
    expect(result).toEqual({ recordsRedacted: 1, recordsBlanked: 0 });
    const spool = readFileSync(file, 'utf8');
    expect(spool).not.toContain(STRIPE_LIVE_KEY);
    expect(JSON.parse(spool.split('\n')[0]!)).not.toHaveProperty('mentions');
    // Both chats name the same file: it is not this message's alone to delete.
    expect(existsSync(shared)).toBe(true);
  });
});
