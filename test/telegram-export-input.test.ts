// A Telegram Desktop export as an input of the Telegram connector
// (docs/design/archive-live-one-dataset.md, step 4): the export and live
// capture make one dataset with nothing stored twice, through the real archive
// import, dashboard approval, tier store set and intake rule. Every export
// here is synthetic (test/support/archive-fixtures-telegram.ts), with the
// shapes checked on 2026-10-25 against a real whole-account export.

import { afterEach, describe, expect, test } from 'bun:test';
import { TELEGRAM_SOURCE_ID } from '../src/core/olympus-layout.ts';
import { findRegistryAccount, readSourceRegistry } from '../src/core/source-registry.ts';
import { HELD_UNTIL_JUDGED_REASON } from '../src/workers/classification/tier-classifier.ts';
import { compareTelegramVersions } from '../src/workers/telegram-messages/record-builder.ts';
import {
  telegramExportMessageRecord,
  telegramExportReactions,
  telegramExportSenderId,
  telegramMarkedChatId,
} from '../src/workers/telegram-messages/export-records.ts';
import { telegramProviderAccountId } from '../src/workers/telegram-messages/archive-target.ts';
import {
  telegramChat,
  telegramFileLeftOut,
  telegramFixtureIso,
  telegramFullExport,
  telegramPhoto,
  telegramService,
  telegramSingleChatExport,
  telegramText,
} from './support/archive-fixtures-telegram.ts';
import { telegramOneDatasetHarness, type TelegramOneDatasetHarness } from './support/telegram-one-dataset-harness.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const GROUP_ID = 1_000_001;
/** The group's chat as live capture keys it: a basic group's id, negated. */
const GROUP = `-${GROUP_ID}`;
const ACCOUNT = 'telegram.personal';
const ITEM = (conversation: string, id: string | number) => ({
  provider: 'telegram', accountScope: ACCOUNT, providerItemId: String(id), providerConversationId: conversation,
});

const ids = (h: TelegramOneDatasetHarness): string[] =>
  h.rows().filter((row) => row.parent === null).map((row) => `${row.conversation}/${row.id}`).sort();
const duplicates = (h: TelegramOneDatasetHarness): string[] => {
  const seen = new Map<string, number>();
  for (const row of h.rows()) seen.set(`${row.conversation}/${row.id}`, (seen.get(`${row.conversation}/${row.id}`) ?? 0) + 1);
  return [...seen].filter(([, count]) => count > 1).map(([key]) => key);
};

async function importExport(h: TelegramOneDatasetHarness, name: string, value: unknown, media?: Record<string, string>, answer: { confirmAccount?: true } = {}) {
  const started = await h.startImport(h.writeExport(name, value, media), answer);
  if (!started.ok || started.status !== 'started') throw new Error(`expected a start, got ${JSON.stringify(started)}`);
  const outcome = await h.importAll(started.archive_id);
  return { archiveId: started.archive_id, outcome, record: h.runtime.state.get(started.archive_id)! };
}

describe('the export carries the live item\'s exact key', () => {
  test('chat ids take Telethon\'s marked form from the chat\'s type; unknown types are kept apart', () => {
    expect(telegramMarkedChatId('personal_chat', '4242')).toBe('4242');
    expect(telegramMarkedChatId('bot_chat', '4243')).toBe('4243');
    expect(telegramMarkedChatId('saved_messages', '1001')).toBe('1001');
    expect(telegramMarkedChatId('private_group', '1000001')).toBe('-1000001');
    expect(telegramMarkedChatId('private_supergroup', '1500000001')).toBe('-1001500000001');
    expect(telegramMarkedChatId('public_supergroup', '1500000002')).toBe('-1001500000002');
    expect(telegramMarkedChatId('private_channel', '1500000003')).toBe('-1001500000003');
    expect(telegramMarkedChatId('public_channel', '1500000004')).toBe('-1001500000004');
    // An id already marked is kept; a type this does not know never joins a live chat.
    expect(telegramMarkedChatId('private_group', '-1000001')).toBe('-1000001');
    expect(telegramMarkedChatId('something_new', '77')).toBe('export:something_new:77');
    expect(telegramMarkedChatId('private_group', 'not-a-number')).toBeUndefined();
  });

  test('senders take Telethon\'s marked form: users as is, channels behind -100', () => {
    expect(telegramExportSenderId('user1001')).toBe('1001');
    expect(telegramExportSenderId('channel1500000004')).toBe('-1001500000004');
    expect(telegramExportSenderId('chat1000001')).toBe('-1000001');
    expect(telegramExportSenderId('someone')).toBeUndefined();
  });

  test('a message becomes the spool\'s message, with the live version form and edits and reactions', () => {
    const message = telegramText(3, 'see you at the quay', {
      extra: {
        edited: '2015-01-05T15:00:00', edited_unixtime: '1420470000',
        reactions: [
          { type: 'emoji', count: 2, emoji: '👍', recent: [{ from: 'Robin', from_id: 'user2002', date: '2015-01-05T15:01:00' }] },
          { type: 'custom_emoji', count: 1, document_id: '5368324170671202286' },
          { type: 'paid', count: 3 },
        ],
      },
    });
    const outcome = telegramExportMessageRecord({ account: ACCOUNT, fetchedAt: '2026-10-25T00:00:00.000Z', ownUserId: '1001' }, { name: 'Harbour', type: 'private_group', id: String(GROUP_ID) }, message);
    if (outcome.kind !== 'record') throw new Error(outcome.kind);
    const item = outcome.record.capturedItem.item;
    expect(item.identity).toMatchObject({ provider: 'telegram', accountScope: ACCOUNT, providerConversationId: GROUP, providerItemId: '1003', localItemId: `${ACCOUNT}:${GROUP}:1003` });
    expect(item.identity.sourceVersion).toMatch(new RegExp(`^${ACCOUNT}:${GROUP}:1003:2015-01-05T15:00:00Z:r[0-9a-f]{8}$`));
    expect(item.metadata).toMatchObject({ senderId: '1001', senderDisplayName: 'Sam Example', senderIsOwner: true, editedAt: '2015-01-05T15:00:00.000Z', chatType: 'group', title: 'Harbour' });
    expect(item.metadata.reactions).toEqual([
      { key: '👍', count: 2, actors: [{ providerActorId: '2002' }] },
      { key: 'custom:5368324170671202286', count: 1 },
    ]);
    // Reactions say nothing of order; the edit time does.
    expect(compareTelegramVersions(item.identity.sourceVersion!, `${ACCOUNT}:${GROUP}:1003:2015-01-05T15:00:00Z`)).toBe(0);
    expect(compareTelegramVersions(item.identity.sourceVersion!, `${ACCOUNT}:${GROUP}:1003:2015-01-05T16:00:00Z:rabcdef01`)).toBe(-1);
    expect(telegramExportReactions(undefined)).toBeUndefined();
  });
});

describe('the export and live capture make one dataset', () => {
  const groupMessages = () => [
    telegramText(0, 'live and export both hold this'),
    telegramText(1, 'only the export holds this'),
    telegramService(2, 'pin_message', { extra: { message_id: 1000 } }),
  ];
  const liveOf = (id: number, text: string, extra: Partial<Parameters<TelegramOneDatasetHarness['capture']>[0][number]> = {}) => ({
    chat: GROUP, id: String(1000 + id), text, sentAt: telegramFixtureIso(id), chatTitle: 'Synthetic Harbour Group', sender: { id: '1001', name: 'Sam Example' }, ...extra,
  });

  test('live first, then the export: each message once, live\'s copy kept on a tie, the rest added under the live chat', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    h.pairLive('1001');
    h.capture([liveOf(0, 'live and export both hold this (live copy)')]);
    await h.live.pull();
    const { record } = await importExport(h, 'Telegram Desktop', telegramFullExport({ chats: [telegramChat({ id: GROUP_ID, messages: groupMessages() })], omit: ['contacts', 'frequent_contacts', 'sessions', 'web_sessions', 'profile_pictures', 'other_data'] }));
    expect(record.status).toBe('imported');
    // The export names the paired account, so it joined without a question.
    expect(record.target?.source_id).toBe(TELEGRAM_SOURCE_ID);
    expect(ids(h)).toEqual([`${GROUP}/1000`, `${GROUP}/1001`, `${GROUP}/1002`, 'account:personal_information/personal_information'].sort());
    expect(duplicates(h)).toEqual([]);
    expect(h.textOf(GROUP, '1000')).toBe('live and export both hold this (live copy)');
    expect(h.textOf(GROUP, '1001')).toBe('only the export holds this');
    // The service message is the sentence live capture writes for the same event.
    expect(h.textOf(GROUP, '1002')).toBe('Sam Example pinned message 1000.');
    // What the import counts: three messages and the profile read, one of them already there.
    expect(record.intake?.read).toBe(4);
    expect(record.intake?.already_there).toBe(1);
  });

  test('the export first, then live: a newer live edit applies, an older queued record does not undo the export\'s edit', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    h.pairLive('1001');
    const edited = telegramText(1, 'edited in the export', { extra: { edited: '2015-01-05T20:00:00', edited_unixtime: String(Date.parse('2015-01-05T20:00:00Z') / 1000) } });
    await importExport(h, 'Telegram Desktop', telegramFullExport({ chats: [telegramChat({ id: GROUP_ID, messages: [telegramText(0, 'first'), edited] })], withoutPersonalSections: true }), undefined, { confirmAccount: true });
    expect(h.textOf(GROUP, '1001')).toBe('edited in the export');
    // A live record of the original (older) text, then a later live edit of message 1000.
    h.capture([
      liveOf(1, 'the original, before the edit'),
      liveOf(0, 'first, edited live later', { editedAt: '2026-10-20T09:00:00.000Z' }),
    ]);
    await h.live.pull();
    expect(h.textOf(GROUP, '1001')).toBe('edited in the export');
    // The imported item was held Private until judged; the live edit still lands on it.
    expect(h.textOf(GROUP, '1000')).toBe('first, edited live later');
    expect(duplicates(h)).toEqual([]);
  });

  test('imported items are held Private until judged; a live-only item is not', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    h.pairLive('1001');
    h.capture([liveOf(5, 'only live has this')]);
    await h.live.pull();
    await importExport(h, 'Telegram Desktop', telegramFullExport({ chats: [telegramChat({ id: GROUP_ID, messages: [telegramText(1, 'only the export has this')] })], withoutPersonalSections: true }), undefined, { confirmAccount: true });
    const ledger = h.live.archiveTarget().lane({ sourceId: TELEGRAM_SOURCE_ID, slot: 'default' } as never, h.env).set.ledger;
    expect(ledger.getCurrent(ITEM(GROUP, 1001))?.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
    expect(ledger.getCurrent(ITEM(GROUP, 1005))?.reasons ?? []).not.toContain(HELD_UNTIL_JUDGED_REASON);
  });
});

describe('what a real export holds', () => {
  test('history from before a supergroup migration (negative ids) becomes items of its own under the supergroup', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    h.pairLive('1001');
    const supergroup = 1_500_000_001;
    const before = { ...telegramText(0, 'said in the old group'), id: -5 };
    const after = telegramText(1, 'said in the supergroup');
    await importExport(h, 'Telegram Desktop', telegramFullExport({ chats: [telegramChat({ type: 'private_supergroup', id: supergroup, messages: [before, after] })], withoutPersonalSections: true }), undefined, { confirmAccount: true });
    expect(ids(h)).toEqual([`-100${supergroup}/-5`, `-100${supergroup}/1001`]);
    expect(h.textOf(`-100${supergroup}`, '-5')).toBe('said in the old group');
  });

  test('a left chat that repeats messages byte for byte is imported once', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    h.pairLive('1001');
    const chat = telegramChat({ id: GROUP_ID, messages: [telegramText(0, 'a'), telegramText(1, 'b')] });
    const { record } = await importExport(h, 'Telegram Desktop', telegramFullExport({ chats: [chat], leftChats: [chat], withoutPersonalSections: true }), undefined, { confirmAccount: true });
    expect(ids(h)).toEqual([`${GROUP}/1000`, `${GROUP}/1001`]);
    expect(duplicates(h)).toEqual([]);
    expect(record.intake?.read).toBe(4);
    expect(record.intake?.already_there).toBe(2);
  });

  test('contacts, sessions and the profile are records of their own kinds, in a conversation per part', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    h.pairLive('1001');
    await importExport(h, 'Telegram Desktop', telegramFullExport({ chats: [], contacts: 2 }));
    const parts = h.rows().map((row) => row.conversation);
    expect(parts.filter((part) => part === 'account:contacts')).toHaveLength(2);
    expect(parts).toContain('account:sessions');
    expect(parts).toContain('account:personal_information');
    expect(parts).toContain('account:frequent_contacts');
    const contacts = h.rows().filter((row) => row.conversation === 'account:contacts');
    expect(contacts.map((row) => h.textOf('account:contacts', row.id)).join('\n')).toContain('Contact1');
  });

  test('a photo in the export\'s folder is a child of its message, listed by name and bound for reading; one the export left out is named, not readable', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    h.pairLive('1001');
    const photo = telegramPhoto(0, 'the quay at dawn');
    const missing = telegramFileLeftOut(1);
    await importExport(
      h,
      'Telegram Desktop',
      telegramFullExport({ chats: [telegramChat({ id: GROUP_ID, messages: [photo, missing] })], withoutPersonalSections: true }),
      { [String(photo.photo)]: 'synthetic jpeg bytes' },
      { confirmAccount: true },
    );
    const children = h.rows().filter((row) => row.parent !== null);
    expect(children).toHaveLength(2);
    const bound = children.find((row) => row.parent === `${ACCOUNT}:${GROUP}:1000`)!;
    expect(bound.id).toMatch(/^1000#child:photo:[0-9a-f]{24}$/);
    expect(bound.locator).toMatch(/^archive-input-media:v1:.+:b:.+$/);
    expect(bound.available).toBe(1);
    const left = children.find((row) => row.parent === `${ACCOUNT}:${GROUP}:1001`)!;
    expect(left.available).toBe(0);
    // The message keeps its own words.
    expect(h.textOf(GROUP, '1000')).toContain('the quay at dawn');
  });
});

describe('which account an export joins', () => {
  test('an export of another account than the paired one stays under Archives', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    h.pairLive('9999');
    const started = await h.startImport(h.writeExport('Telegram Desktop', telegramFullExport({ chats: [telegramChat({ id: GROUP_ID, messages: [telegramText(0, 'x')] })] })));
    if (!started.ok || started.status !== 'started') throw new Error(JSON.stringify(started));
    expect(h.runtime.state.get(started.archive_id)?.target).toBeUndefined();
  });

  test('an export with no profile asks the owner, and joins on a yes', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    h.pairLive('1001');
    const path = h.writeExport('One chat', telegramSingleChatExport(telegramChat({ type: 'personal_chat', id: 4242, messages: [telegramText(0, 'hello')] })));
    const asked = await h.startImport(path);
    expect(asked).toMatchObject({ ok: true, status: 'confirm_account', source: { id: TELEGRAM_SOURCE_ID } });
    const confirmed = await h.startImport(path, { confirmAccount: true });
    if (!confirmed.ok || confirmed.status !== 'started') throw new Error(JSON.stringify(confirmed));
    await h.importAll(confirmed.archive_id);
    expect(ids(h)).toEqual(['4242/1000']);
  });

  test('the account hash is pairing\'s: sha256 of the user id, first 16 hex', () => {
    expect(telegramProviderAccountId('1001')).toMatch(/^telegram:[0-9a-f]{16}$/);
    const registry = readSourceRegistry({});
    expect(findRegistryAccount(registry, 'nothing', 'default')).toBeUndefined();
  });
});
