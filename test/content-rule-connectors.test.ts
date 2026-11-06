import { expect, test } from 'bun:test';
import { itemHasNonTextContent, classifyItemTiers, type TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { telegramMessageItem } from '../src/workers/telegram-messages/capture-spool-connector.ts';
import { telegramClassificationSignals } from '../src/workers/telegram-messages/record-builder.ts';
import { telegramExportMessageRecord } from '../src/workers/telegram-messages/export-records.ts';
import { createWhatsAppRecordBuilder, parseWhatsAppSpoolRecord } from '../src/workers/whatsapp/live-connector.ts';
import { gmailMailRecordFromMessage, type GmailMessage } from '../src/workers/google-connectors/gmail.ts';
import { gmailMessageItem } from '../src/workers/google-connectors/gmail-mail-record.ts';
import { INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID } from '../src/workers/telegram-messages/corpus-adapter.ts';

const sniffer: TierSniffer = { id: 'fixture', judge: () => ({ verdict: 'undecided', queued: true }) };
const fetchedAt = '2026-11-06T00:00:00Z';

test('Telegram capture requires upstream completeness and keeps chat names separate', () => {
  const make = (extra: Record<string, unknown>) => telegramMessageItem({ account: 'test', conversationId: '1',
    trustDomain: 'internal', corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, fetchedAt,
    message: { id: '1', boundedText: '+', chatTitle: 'Chat', senderDisplayName: 'Alex', ...extra } }).item;
  const complete = make({ textComplete: true });
  expect(itemHasNonTextContent(complete)).toBe(false);
  const signals = telegramClassificationSignals(complete);
  expect(signals.title).toBeUndefined();
  expect(signals.labels).toContain('Chat');
  expect(classifyItemTiers({ signals, text: '+', hasNonTextContent: itemHasNonTextContent(complete) }, { sniffer }).decidedBy).toBe('content_rule');
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
    expect(signals.title).toBeUndefined();
    expect(signals.labels).toContain('Chat');
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
