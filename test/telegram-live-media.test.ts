// Live Telegram media as children (docs/design/archive-live-one-dataset.md, step 8): the capture helper keeps a message's photo or file
// beside its spool, and the connector lists it as the message's `media` child, the same child an export brings, so both inputs bring the
// same media. Synthetic records and bytes only.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTelegramCaptureSpoolConnector } from '../src/workers/telegram-messages/capture-spool-connector.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  createTelegramConnectorStoreSyncHandler,
  sanitizeTelegramCaptureCursor,
} from '../src/workers/telegram-messages/index.ts';
import { telegramSpoolPosition } from '../src/workers/telegram-messages/store-sync.ts';
import { telegramLiveMediaChild, telegramMediaDiskFloor, telegramMediaDiskLow } from '../src/workers/telegram-messages/media-child.ts';
import { readdirSync } from 'node:fs';
import { forgetSpoolOffsets } from '../src/workers/telegram-messages/spool-lines.ts';
import { liveSpoolLine } from './support/telegram-spool-fixtures.ts';
import { telegramChat, telegramFullExport, telegramPhoto } from './support/archive-fixtures-telegram.ts';
import { telegramOneDatasetHarness } from './support/telegram-one-dataset-harness.ts';
import { telegramFixtureIso } from './support/archive-fixtures-telegram.ts';

const cleanups: Array<() => void> = [];
const roots: string[] = [];
afterEach(() => {
  forgetSpoolOffsets();
  while (cleanups.length) cleanups.pop()!();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const ACCOUNT = 'telegram.personal';
const photo = (mediaFile?: string) => ({ attachments: [{ attachmentId: 'photo:77', type: 'image', ...(mediaFile ? { mediaFile, sizeBytes: 21 } : {}) }] });

describe('a live message\'s media is its child', () => {
  test('a kept file is a readable child, keyed media, and its bytes are fetched from the file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-media-'));
    roots.push(root);
    const spoolDir = join(root, 'spool');
    mkdirSync(join(spoolDir, 'media', '-1000001'), { recursive: true });
    writeFileSync(join(spoolDir, 'media', '-1000001', '1000.a1b2c3d4e5f6.jpg'), 'synthetic jpeg bytes!');
    writeFileSync(join(spoolDir, '2026-10-20.jsonl'), liveSpoolLine({ chat: '-1000001', id: '1000', text: 'the quay', sentAt: '2026-10-20T09:00:00Z', extra: photo('media/-1000001/1000.a1b2c3d4e5f6.jpg') }));
    const connector = createTelegramCaptureSpoolConnector({ spoolDir, trustDomain: 'internal' });
    const items = [];
    for await (const page of connector.listItems()) items.push(...page.items);
    expect(items.map((item) => item.identity.providerItemId)).toEqual(['1000', '1000#child:media']);
    const child = items[1]!;
    expect(child.identity.parent).toEqual({ providerItemId: '1000', localItemId: `${ACCOUNT}:-1000001:1000` });
    expect(child.deferredBytes).toEqual({ locator: 'telegram-live-media:v1:media/-1000001/1000.a1b2c3d4e5f6.jpg', available: true, sizeBytes: 21 });
    expect(child.metadata).toMatchObject({ name: 'Photo', mediaKind: 'photo' });
    const fetched = await connector.fetchItem(child.identity.localItemId, { deferredBytes: { locator: child.deferredBytes!.locator } });
    expect(fetched.content.kind).toBe('bytes');
    expect(new TextDecoder().decode((fetched.content as { bytes: Uint8Array }).bytes)).toBe('synthetic jpeg bytes!');
  });

  test('a file the helper did not keep is a named child at the version without the capture mark, and a locator out of the media folder reads nothing', () => {
    const parent = {
      identity: { family: 'chat' as const, provider: 'telegram', accountScope: ACCOUNT, providerItemId: '1000', providerConversationId: '-1000001', localItemId: `${ACCOUNT}:-1000001:1000`, sourceVersion: `${ACCOUNT}:-1000001:1000:2026-10-20T09:00:00Z~at:2026-10-20T09:00:01.000Z:0000000000000001:2026-10-20.jsonl:0000000001` },
      mimeType: 'text/plain', content: { kind: 'text' as const, text: 'x' }, metadata: { title: 'Chat', ...photo() }, fetchedAt: '2026-10-20T09:00:00Z',
    };
    const named = telegramLiveMediaChild(parent, '/nowhere')!;
    expect(named.deferredBytes).toEqual({ locator: '', available: false });
    expect(named.identity.sourceVersion).toBe(`${ACCOUNT}:-1000001:1000:2026-10-20T09:00:00Z`);
    const escaping = telegramLiveMediaChild({ ...parent, metadata: { title: 'Chat', ...photo('media/../../etc/passwd') } }, '/nowhere')!;
    expect(escaping.deferredBytes?.available).toBe(false);
  });
});

describe('a pass that cannot hold a message and its child', () => {
  test('with a one-item budget the spine cuts inside the record, the lane keeps that cursor, and the child lands next pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-media-cut-'));
    roots.push(root);
    const spoolDir = join(root, 'spool');
    mkdirSync(join(spoolDir, 'media', '-1000001'), { recursive: true });
    writeFileSync(join(spoolDir, 'media', '-1000001', '1000.a1b2c3d4e5f6.jpg'), 'synthetic jpeg bytes!');
    writeFileSync(join(spoolDir, '2026-10-20.jsonl'), liveSpoolLine({ chat: '-1000001', id: '1000', text: 'the quay', sentAt: '2026-10-20T09:00:00Z', extra: photo('media/-1000001/1000.a1b2c3d4e5f6.jpg') }));
    const internal = new LocalConnectorStore({ dbPath: join(root, 'i.sqlite'), corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, family: 'chat', trustDomain: 'internal' });
    const secureLocal = new LocalConnectorStore({ dbPath: join(root, 's.sqlite'), corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID, family: 'chat', trustDomain: 'secure_local' });
    cleanups.push(() => { internal.close(); secureLocal.close(); });
    const sync = createTelegramConnectorStoreSyncHandler({ stores: { internal, secureLocal }, spoolDir, maxItems: 1 });
    await sync.pull();
    // Cut inside the record: the message is stored, and the lane resumes at its child.
    expect(internal.lastCompletedSyncRun('telegram_capture_spool_internal')?.cursor).toBe('~in1~0~1~');
    expect(sanitizeTelegramCaptureCursor('~in1~0~1~')).toBe('~in1~0~1~');
    expect(telegramSpoolPosition('~in1~3~1~2026-10-20.jsonl:7')).toBe('2026-10-20.jsonl:7');
    const second = await sync.pull();
    expect(second.counts.spool_cursor_resets).toBe(0);
    expect(internal.lastCompletedSyncRun('telegram_capture_spool_internal')?.cursor).toBe('2026-10-20.jsonl:1');
    expect(internal.itemPresence({ provider: 'telegram', accountScope: ACCOUNT, providerItemId: '1000#child:media', providerConversationId: '-1000001' }).active).toBe(true);
  });
});

describe('both inputs bring the same media', () => {
  test('an export\'s readable photo and a live record of the message that kept none are one child, and it stays readable', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    h.pairLive('1001');
    const message = telegramPhoto(0, 'the quay at dawn');
    const dir = h.writeExport('Telegram Desktop', telegramFullExport({ chats: [telegramChat({ id: 1_000_001, messages: [message] })], withoutPersonalSections: true }), { [String(message.photo)]: 'synthetic jpeg bytes' });
    const started = await h.startImport(dir, { confirmAccount: true });
    if (!started.ok || started.status !== 'started') throw new Error(JSON.stringify(started));
    await h.importAll(started.archive_id);
    h.capture([{ chat: '-1000001', id: '1000', text: 'the quay at dawn', sentAt: telegramFixtureIso(0), extra: photo() }]);
    await h.live.pull();
    const children = h.rows().filter((row) => row.parent !== null);
    expect(children.map((row) => row.id)).toEqual(['1000#child:media']);
    expect(children[0]!.available).toBe(1);
    expect(children[0]!.locator).toMatch(/^archive-input-media:v1:/);
  });

  test('a child judged Secrets loses the file the helper kept', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    h.pairLive('1001');
    mkdirSync(join(h.spoolDir, 'media', '-1000001'), { recursive: true });
    const kept = join(h.spoolDir, 'media', '-1000001', '1000.a1b2c3d4e5f6.jpg');
    writeFileSync(kept, 'synthetic jpeg bytes!');
    h.capture([{ chat: '-1000001', id: '1000', text: 'see the photo', sentAt: '2026-10-20T09:00:00Z', extra: photo('media/-1000001/1000.a1b2c3d4e5f6.jpg') }]);
    await h.live.pull();
    expect(existsSync(kept)).toBe(true);
    const ledger = h.live.archiveTarget().lane({ sourceId: 'telegram.messages', slot: 'default' } as never, h.env).set.ledger;
    ledger.setOverride({ provider: 'telegram', accountScope: ACCOUNT, providerItemId: '1000#child:media', providerConversationId: '-1000001' }, { kind: 'tier', tier: 'secrets' });
    await h.live.pull();
    expect(existsSync(kept)).toBe(false);
  });
});

describe('review fixes (#556)', () => {
  test('a Secret takes every file of its message: the current one, an earlier attachment\'s, and its downloads in progress', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    h.pairLive('1001');
    const folder = join(h.spoolDir, 'media', '-1000001');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, '1000.a1b2c3d4e5f6.jpg'), 'synthetic jpeg bytes!');
    writeFileSync(join(folder, '1000.0000000000aa.jpg'), 'an earlier photo');
    writeFileSync(join(folder, '.1000.ffffffffffff.jpg.tmp.999999999'), 'half written');
    writeFileSync(join(folder, `.1000.eeeeeeeeeeee.jpg.tmp.${process.pid}`), 'in flight');
    // Another message's file, and a stopped process's download of yet another, which the sweep removes.
    writeFileSync(join(folder, '10000.a1b2c3d4e5f6.jpg'), 'not this message');
    writeFileSync(join(folder, '.2000.a1b2c3d4e5f6.jpg.tmp.999999999'), 'orphan');
    h.capture([{ chat: '-1000001', id: '1000', text: 'see the photo', sentAt: '2026-10-20T09:00:00Z', extra: photo('media/-1000001/1000.a1b2c3d4e5f6.jpg') }]);
    await h.live.pull();
    const ledger = h.live.archiveTarget().lane({ sourceId: 'telegram.messages', slot: 'default' } as never, h.env).set.ledger;
    ledger.setOverride({ provider: 'telegram', accountScope: ACCOUNT, providerItemId: '1000#child:media', providerConversationId: '-1000001' }, { kind: 'tier', tier: 'secrets' });
    await h.live.pull();
    expect(readdirSync(folder)).toEqual(['10000.a1b2c3d4e5f6.jpg']);
  });

  test('media waiting for disk space says so on its child', () => {
    const parent = {
      identity: { family: 'chat' as const, provider: 'telegram', accountScope: ACCOUNT, providerItemId: '1000', providerConversationId: '-1000001', localItemId: `${ACCOUNT}:-1000001:1000`, sourceVersion: `${ACCOUNT}:-1000001:1000:2026-10-20T09:00:00Z` },
      mimeType: 'text/plain', content: { kind: 'text' as const, text: 'x' }, fetchedAt: '2026-10-20T09:00:00Z',
    };
    const child = telegramLiveMediaChild({ ...parent, metadata: { title: 'Chat', attachments: [{ attachmentId: 'photo:77', type: 'image', mediaLeftOut: 'waiting_for_disk' }] } }, '/nowhere')!;
    expect(child.deferredBytes?.available).toBe(false);
    expect(child.metadata['mediaLeftOut']).toBe('waiting_for_disk');
    // A reason this version does not give is not said.
    const old = telegramLiveMediaChild({ ...parent, metadata: { title: 'Chat', attachments: [{ attachmentId: 'photo:77', type: 'image', mediaLeftOut: 'storage_full' }] } }, '/nowhere')!;
    expect(old.metadata['mediaLeftOut']).toBeUndefined();
  });
});

describe('the computer\'s disk floor (owner, 2026-10-26)', () => {
  const GB = 1024 ** 3;
  const setup = (space: { free: number; total: number }) => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-telegram-media-disk-'));
    roots.push(root);
    const spoolDir = join(root, 'spool');
    mkdirSync(join(spoolDir, 'media', '-1000001'), { recursive: true });
    const internal = new LocalConnectorStore({ dbPath: join(root, 'i.sqlite'), corpusId: INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID, family: 'chat', trustDomain: 'internal' });
    const secureLocal = new LocalConnectorStore({ dbPath: join(root, 's.sqlite'), corpusId: PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID, family: 'chat', trustDomain: 'secure_local' });
    cleanups.push(() => { internal.close(); secureLocal.close(); });
    const sync = createTelegramConnectorStoreSyncHandler({ stores: { internal, secureLocal }, spoolDir, diskSpace: () => space });
    return { spoolDir, internal, sync };
  };

  test('the floor is the larger of 5 GB and 5% of the disk', () => {
    expect(telegramMediaDiskFloor(40 * GB)).toBe(5 * GB);
    expect(telegramMediaDiskFloor(1000 * GB)).toBe(50 * GB);
    expect(telegramMediaDiskLow('/nowhere', () => ({ free: 4 * GB, total: 100 * GB }))).toBe(true);
    expect(telegramMediaDiskLow('/nowhere', () => ({ free: 40 * GB, total: 1000 * GB }))).toBe(true);
    expect(telegramMediaDiskLow('/nowhere', () => ({ free: 60 * GB, total: 1000 * GB }))).toBe(false);
    // A volume that cannot be read says nothing.
    expect(telegramMediaDiskLow('/nowhere', () => { throw new Error('gone'); })).toBe(false);
  });

  test('a nearly full disk is on the sync receipt, as a flag and a warning with no counts, and goes once space is freed', async () => {
    const space = { free: 4 * GB, total: 100 * GB };
    const { spoolDir, sync } = setup(space);
    writeFileSync(join(spoolDir, '2026-10-20.jsonl'), liveSpoolLine({ chat: '-1000001', id: '1000', text: 'hello', sentAt: '2026-10-20T09:00:00Z' }));
    const low = await sync.pull();
    expect(low.counts.media_disk_low).toBe(1);
    expect(low.warnings).toContain('telegram_media_disk_low');
    expect(Object.keys(low.counts).filter((key) => key.startsWith('media_'))).toEqual(['media_disk_low']);
    space.free = 80 * GB;
    const freed = await sync.pull();
    expect(freed.counts.media_disk_low).toBe(0);
    expect(freed.warnings ?? []).not.toContain('telegram_media_disk_low');
  });

  test('the message is ingested while its media waits, and the media child is filled in when the helper captures it again with its file', async () => {
    const { spoolDir, internal, sync } = setup({ free: 80 * GB, total: 100 * GB });
    const waiting = { attachments: [{ attachmentId: 'photo:77', type: 'image', mediaLeftOut: 'waiting_for_disk' }] };
    writeFileSync(join(spoolDir, '2026-10-20.jsonl'), liveSpoolLine({ chat: '-1000001', id: '1000', text: 'the quay', sentAt: '2026-10-20T09:00:00Z', extra: waiting }, '2026-10-20T10:00:00Z'));
    await sync.pull();
    const childId = { provider: 'telegram', accountScope: ACCOUNT, providerItemId: '1000#child:media', providerConversationId: '-1000001' };
    expect(internal.itemPresence({ provider: 'telegram', accountScope: ACCOUNT, providerItemId: '1000', providerConversationId: '-1000001' }).active).toBe(true);
    expect(internal.itemPresence(childId).active).toBe(true);
    const childRow = () => {
      const db = new Database(internal.dbPath, { readonly: true });
      try {
        return db.query(`SELECT deferred_locator AS locator, bytes_available AS available FROM items WHERE provider_item_id = ? AND tombstoned = 0`)
          .get('1000#child:media') as { locator: string | null; available: number | null } | null;
      } finally {
        db.close();
      }
    };
    expect(childRow()?.available ?? 0).toBe(0);
    // Space returned: the helper downloaded the file and captured the message again with it.
    writeFileSync(join(spoolDir, 'media', '-1000001', '1000.a1b2c3d4e5f6.jpg'), 'synthetic jpeg bytes!');
    appendFileSync(join(spoolDir, '2026-10-20.jsonl'), liveSpoolLine({ chat: '-1000001', id: '1000', text: 'the quay', sentAt: '2026-10-20T09:00:00Z', extra: photo('media/-1000001/1000.a1b2c3d4e5f6.jpg') }, '2026-10-20T11:00:00Z'));
    await sync.pull();
    expect(childRow()).toEqual({ locator: 'telegram-live-media:v1:media/-1000001/1000.a1b2c3d4e5f6.jpg', available: 1 });
  });
});
