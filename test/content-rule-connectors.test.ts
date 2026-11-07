import { expect, test } from 'bun:test';
import { itemHasNonTextContent, classifyItemTiers, contentNamesReason, tierSnifferInputHash, type TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { telegramMessageItem } from '../src/workers/telegram-messages/capture-spool-connector.ts';
import { telegramClassificationSignals } from '../src/workers/telegram-messages/record-builder.ts';
import { telegramExportMessageRecord } from '../src/workers/telegram-messages/export-records.ts';
import { createWhatsAppRecordBuilder, parseWhatsAppSpoolRecord } from '../src/workers/whatsapp/live-connector.ts';
import { gmailMailRecordFromMessage, type GmailMessage } from '../src/workers/google-connectors/gmail.ts';
import { gmailMessageItem } from '../src/workers/google-connectors/gmail-mail-record.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { decideItemTiers } from '../src/workers/connector-store/tier-placement.ts';
import type { RawItem, SourceClassificationSignals } from '../src/core/contracts.ts';
import { INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID } from '../src/workers/telegram-messages/corpus-adapter.ts';

const sniffer: TierSniffer = { id: 'fixture', judge: () => ({ verdict: 'undecided', queued: true }) };
const fetchedAt = '2026-11-06T00:00:00Z';

test('Telegram capture requires upstream completeness and preserves chat title signals', () => {
  const make = (extra: Record<string, unknown>) => telegramMessageItem({ account: 'test', conversationId: '1',
    trustDomain: 'internal', corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, fetchedAt,
    message: { id: '1', boundedText: '+', chatTitle: 'Chat', senderDisplayName: 'Alex', ...extra } }).item;
  const complete = make({ textComplete: true });
  expect(itemHasNonTextContent(complete)).toBe(false);
  const signals = telegramClassificationSignals(complete);
  expect(signals.title).toBe('Chat');
  expect(complete.metadata.titleIsConversation).toBe(true);
  expect(classifyItemTiers({ signals, titleIsConversation: complete.metadata.titleIsConversation === true, text: '+', hasNonTextContent: itemHasNonTextContent(complete) }, { sniffer }).decidedBy).toBe('content_rule');
  for (const extra of [{}, { textComplete: true, attachments: [{ type: 'image', name: 'photo' }] },
    { textComplete: true, service: { action: 'new_action' } }]) {
    expect(itemHasNonTextContent(make(extra))).toBe(true);
  }
  const child = { ...complete, identity: { ...complete.identity, parent: { providerItemId: '1', localItemId: '1' } }, metadata: { title: 'test-result.pdf' } };
  expect(telegramClassificationSignals(child).title).toBe('test-result.pdf');
});

test('Telegram export attests only fully read messages, never unsupported content or media', () => {
  for (const [extra, complete] of [[{}, true], [{ photo: 'photos/a.jpg' }, false],
    [{ rich_message: { text: 'not read' } }, false], [{ type: 'unsupported' }, false]] as const) {
    const outcome = telegramExportMessageRecord({ account: 'test', fetchedAt }, { id: '1', type: 'personal_chat', name: 'Chat' },
      { id: 1, type: 'message', text: '+', ...extra });
    if (outcome.kind !== 'record') throw new Error(outcome.kind);
    expect(outcome.record.capturedItem.item.metadata.textComplete === true).toBe(complete);
    expect(itemHasNonTextContent(outcome.record.capturedItem.item)).toBe(!complete);
  }
});

test('WhatsApp attests plain messages, never captioned or unsupported media', async () => {
  const builder = createWhatsAppRecordBuilder({ spoolDir: '/not-used', account: 'test' });
  for (const mediaType of [undefined, 'image', 'audio', 'unknown']) {
    const record = parseWhatsAppSpoolRecord(JSON.stringify({ id: '1', chat_jid: 'chat@s.whatsapp.net', chat_name: 'Chat',
      sender_jid: 'person@s.whatsapp.net', from_me: false, timestamp: fetchedAt, text: '+', ...(mediaType ? { media_type: mediaType } : {}) }));
    if (!record) throw new Error('fixture did not parse');
    const entries = await builder.entriesOf(record);
    const items = await builder.build(record, new Set(entries.map(e => e.identity.localItemId)));
    const item = items[0]!;
    expect(item.metadata.textComplete === true).toBe(mediaType === undefined);
    expect(itemHasNonTextContent(item)).toBe(mediaType !== undefined);
    const signals = builder.classificationSignals(item);
    expect(signals.title).toBe('Chat');
    expect(item.metadata.titleIsConversation).toBe(true);
  }
});

test('Gmail attests complete plain MIME only, including with legacy attachment listing', () => {
  const plain: NonNullable<GmailMessage['payload']> = { mimeType: 'text/plain', body: { data: Buffer.from('+').toString('base64url') } };
  const cases: Array<[GmailMessage['payload'], boolean]> = [[plain, true],
    [{ mimeType: 'multipart/mixed', parts: [plain, { mimeType: 'image/png', body: { data: 'AA' } }] }, false],
    [{ mimeType: 'text/html', body: { data: Buffer.from('<img src="cid:x">+').toString('base64url') } }, false],
    [{ mimeType: 'text/plain', body: { attachmentId: 'unread', size: 4 } }, false],
    [{ mimeType: 'application/x-unknown' }, false], [undefined, false]];
  for (const children of [true, false]) {
    for (const [payload, complete] of cases) {
      const record = gmailMailRecordFromMessage({ id: '1', ...(payload ? { payload } : {}) }, { children });
      const item = gmailMessageItem(record, 'test', fetchedAt);
      expect(item.metadata.textComplete === true).toBe(complete);
      expect(itemHasNonTextContent(item)).toBe(!complete);
    }
  }
});

// Pinned origin/main signal shapes: neither completeness nor the conversation
// fact may change the material of an already-judged message.
function unchangedReplay(item: RawItem, signals: SourceClassificationSignals, baseline: SourceClassificationSignals) {
  expect(signals).toEqual(baseline);
  for (const pass of ['metadata', 'content'] as const) {
    expect(tierSnifferInputHash(pass, signals, 'A longer ordinary message.'))
      .toBe(tierSnifferInputHash(pass, baseline, 'A longer ordinary message.'));
  }
  expect(contentNamesReason(signals)).toBe(contentNamesReason(baseline));
  const ledger = new TierLedger({ dbPath: ':memory:' });
  try {
    const text = 'A longer ordinary message.';
    const judged = classifyItemTiers({ signals: baseline, text }, {
      sniffer: { id: 'fixture', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary' }) },
    });
    ledger.recordRoutedPlacement(item.identity, judged, {
      copies: [{ corpusId: 'fixture', trustDomain: 'internal', layers: 'both' }], embedHold: false,
    });
    let questions = 0;
    const replayed = decideItemTiers({ classificationSignals: () => signals }, item, text, {
      sniffer: { id: 'fixture', judge: () => { questions++; return { verdict: 'undecided', queued: true }; } },
    }, ledger);
    expect(replayed.contentPending).toBe(false);
    expect(replayed.state).toBe('current');
    expect(questions).toBe(0);
  } finally { ledger.close(); }
}

test('unchanged Telegram replay keeps origin/main hashes, names reason and final judgment', () => {
  const item = telegramMessageItem({ account: 'test', conversationId: '1', trustDomain: 'internal',
    corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, fetchedAt,
    message: { id: '1', boundedText: '+', chatTitle: 'Chat', senderDisplayName: 'Alex', textComplete: true } }).item;
  expect(contentNamesReason(telegramClassificationSignals(item))).toBe('content:names:4998a381de6fe243');
  expect(tierSnifferInputHash('content', telegramClassificationSignals(item), 'A longer ordinary message.'))
    .toBe('05eceebf5a124da31250078520d4824c2047c442eec9b809cef0eed495e3b609');
  unchangedReplay(item, telegramClassificationSignals(item), {
    title: 'Chat', sender: 'Alex', folderKeys: ['1'],
  });
});

test('unchanged WhatsApp replay keeps origin/main hashes, names reason and final judgment', async () => {
  const builder = createWhatsAppRecordBuilder({ spoolDir: '/not-used', account: 'test' });
  const record = parseWhatsAppSpoolRecord(JSON.stringify({ id: '1', chat_jid: 'chat@s.whatsapp.net', chat_name: 'Chat',
    sender_jid: 'person@s.whatsapp.net', from_me: false, timestamp: fetchedAt, text: '+' }));
  if (!record) throw new Error('fixture did not parse');
  const entries = await builder.entriesOf(record);
  const [item] = await builder.build(record, new Set(entries.map(e => e.identity.localItemId)));
  expect(contentNamesReason(builder.classificationSignals(item!))).toBe('content:names:44b7fba7694714d8');
  expect(tierSnifferInputHash('content', builder.classificationSignals(item!), 'A longer ordinary message.'))
    .toBe('bbb04b24c85a2a18a06340c4af17b12a94993af7bd5f44d6119b4c0a1cff01c6');
  unchangedReplay(item!, builder.classificationSignals(item!), {
    title: 'Chat', sender: 'person@s.whatsapp.net', folderKeys: ['chat@s.whatsapp.net'],
  });
});
