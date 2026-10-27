// Reading Telegram's media children (docs/design/archive-live-one-dataset.md, section 5): a file the capture helper kept and a
// file an export carries are both read by the one Telegram media lane, their text landing on the child, never on the message.
// Synthetic records and bytes only.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FileExtractionSourceError } from '../src/core/file-extraction-source.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { EXTRACTION_SINK_SKIPPED_TIER_MOVE_QUEUED } from '../src/workers/file-extraction/store-sink.ts';
import { forgetSpoolOffsets } from '../src/workers/telegram-messages/spool-lines.ts';
import { telegramMediaConnector, telegramMediaLanes } from '../src/workers/telegram-messages/media-extraction.ts';
import { telegramChat, telegramFullExport, telegramPhoto } from './support/archive-fixtures-telegram.ts';
import { telegramOneDatasetHarness, type TelegramOneDatasetHarness } from './support/telegram-one-dataset-harness.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  forgetSpoolOffsets();
  while (cleanups.length) cleanups.pop()!();
});

const ACCOUNT = 'telegram.personal';
const LIVE_TEXT = 'fixturequayword: the ferry leaves the quay at seven.';
const EXPORT_TEXT = 'fixtureleaseword: the lease runs for two years.';

async function readMedia(h: TelegramOneDatasetHarness, maxBytes?: number) {
  const runtime = h.live.mediaExtraction({
    imports: () => ({ state: h.runtime.state, bindings: h.runtime.media }),
    env: h.env,
    jobsDbPath: join(h.home, 'file-extraction-jobs.sqlite'),
    warn: () => {},
  })!;
  cleanups.unshift(() => runtime.close());
  let candidates = 0;
  let indexed = 0;
  let tooLarge = 0;
  let queued = 0;
  for (const lane of telegramMediaLanes([h.stores.internal.corpusId, h.stores.secureLocal.corpusId], ACCOUNT)) {
    const plan = await runtime.runner.plan({ ...lane, limit: 50, policyDecision: 'index_allowed' });
    candidates += plan.candidates;
    const run = await runtime.runner.run({ ...lane, limit: 10, ...(maxBytes !== undefined ? { maxBytes } : {}) });
    indexed += run.counts.indexed;
    tooLarge += run.counts.skipped_too_large;
    queued += run.records.filter((record) => record.errorKind === EXTRACTION_SINK_SKIPPED_TIER_MOVE_QUEUED).length;
  }
  return { candidates, indexed, tooLarge, queued };
}

describe('Telegram media are read on their own', () => {
  test('a file live capture kept is read through the media lane, and only the child is a candidate', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    h.pairLive('1001');
    mkdirSync(join(h.spoolDir, 'media', '-1000001'), { recursive: true });
    writeFileSync(join(h.spoolDir, 'media', '-1000001', '1000.a1b2c3d4e5f6.txt'), LIVE_TEXT);
    h.capture([{
      chat: '-1000001', id: '1000', text: 'the timetable', sentAt: '2026-10-20T09:00:00Z',
      extra: { attachments: [{ attachmentId: 'document:77', type: 'file', name: 'timetable.txt', mimeType: 'text/plain', mediaFile: 'media/-1000001/1000.a1b2c3d4e5f6.txt', sizeBytes: LIVE_TEXT.length }] },
    }]);
    await h.live.pull();
    expect(h.textOf('-1000001', '1000#child:media')).toBe('');

    const counts = await readMedia(h);
    expect(counts.candidates).toBe(1);
    expect(counts.indexed).toBe(1);
    expect(h.textOf('-1000001', '1000#child:media')).toContain('fixturequayword');
    // The message keeps its own text; the file's text is the child's.
    expect(h.textOf('-1000001', '1000')).not.toContain('fixturequayword');
  });

  test('a file an export carries is read from the import, and a second pass reads nothing again', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    h.pairLive('1001');
    const message = telegramPhoto(0, 'the lease', { extra: { photo: undefined, photo_file_size: undefined, width: undefined, height: undefined, file: 'files/lease.txt', file_name: 'lease.txt', mime_type: 'text/plain', file_size: EXPORT_TEXT.length } });
    const dir = h.writeExport('Telegram Desktop', telegramFullExport({ chats: [telegramChat({ id: 1_000_001, messages: [message] })], withoutPersonalSections: true }), { 'files/lease.txt': EXPORT_TEXT });
    const started = await h.startImport(dir, { confirmAccount: true });
    if (!started.ok || started.status !== 'started') throw new Error(JSON.stringify(started));
    await h.importAll(started.archive_id);
    const child = h.rows().find((row) => row.parent !== null)!;
    expect(child.locator).toMatch(/^archive-input-media:v1:/);

    // An export's child is held Private until judged: its first read queues the move to the Private store and
    // lands nothing; the judge's move carries it there (as the sniffer service does), and the next pass lands it.
    const first = await readMedia(h);
    expect(first).toMatchObject({ indexed: 0, queued: 1 });
    expect(h.textOf(child.conversation, child.id)).toBe('');
    const { set } = h.live.archiveTarget().lane({ provider: 'telegram', accountScope: ACCOUNT } as never, h.env);
    const identity = { provider: 'telegram', accountScope: ACCOUNT, providerItemId: child.id, providerConversationId: child.conversation };
    const record = set.ledger.getCurrent(identity)!;
    expect(record).toMatchObject({ state: 'moving' });
    const localItemId = `${ACCOUNT}:${child.conversation}:${child.id}`;
    await moveTieredItem({
      set,
      identity: { ...identity, family: 'chat', localItemId },
      target: { metadataTier: record.targetMetadataTier!, contentTier: record.targetContentTier! },
      vectorIdentities: {},
      replaceOwnSupersededCopy: true,
    });

    const second = await readMedia(h);
    expect(second.indexed).toBe(1);
    expect(h.textOf(child.conversation, child.id)).toContain('fixtureleaseword');
    expect(h.stores.secureLocal.localContent(localItemId)?.chunks.join(' ')).toContain('fixtureleaseword');
    const again = await readMedia(h);
    expect(again.candidates).toBe(0);
  });

  test('the reader refuses what it must not read: no locator, a path out of the media folder, a gone file, over the bound', async () => {
    const h = telegramOneDatasetHarness(cleanups);
    mkdirSync(join(h.spoolDir, 'media', '-1000001'), { recursive: true });
    writeFileSync(join(h.spoolDir, 'media', '-1000001', '1000.a1b2c3d4e5f6.txt'), LIVE_TEXT);
    const reader = telegramMediaConnector({ account: ACCOUNT, spoolDir: h.spoolDir, imports: () => undefined });
    const id = `${ACCOUNT}:-1000001:1000#child:media`;
    const code = async (run: () => Promise<unknown>) => run().then(() => 'read', (error) => (error instanceof FileExtractionSourceError ? error.errorKind : String(error)));
    expect(await code(() => reader.fetchItemWithin(id, {}))).toBe('source_content_unavailable');
    expect(await code(() => reader.fetchItemWithin(id, { deferredBytes: { locator: 'telegram-live-media:v1:media/../../etc/passwd' } }))).toBe('source_item_not_found');
    expect(await code(() => reader.fetchItemWithin(id, { deferredBytes: { locator: 'telegram-live-media:v1:media/-1000001/1001.a1b2c3d4e5f6.txt' } }))).toBe('source_item_not_found');
    expect(await code(() => reader.fetchItemWithin(id, { maxBytes: 10, deferredBytes: { locator: 'telegram-live-media:v1:media/-1000001/1000.a1b2c3d4e5f6.txt' } }))).toBe('source_too_large');
    expect(await code(() => reader.fetchItemWithin(id, { deferredBytes: { locator: 'archive-input-media:v1:abc:b:def' } }))).toBe('source_unavailable');
    const kept = await reader.fetchItemToFile(id, { deferredBytes: { locator: 'telegram-live-media:v1:media/-1000001/1000.a1b2c3d4e5f6.txt' }, spoolDir: join(h.home, 'spool') });
    // A kept file is handed over as it is, never copied, and never removed by the reader.
    expect(kept).toMatchObject({ path: join(h.spoolDir, 'media', '-1000001', '1000.a1b2c3d4e5f6.txt'), spooled: false });
  });
});
