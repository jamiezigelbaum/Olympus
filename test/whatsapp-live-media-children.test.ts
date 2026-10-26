// Live WhatsApp pictures and videos as children of their message
// (docs/design/archive-live-one-dataset.md, step 8): the bridge saves them,
// the connector lists each as its message's child with a locator, the
// extraction source reads it through the account's one child reader, and
// Secrets clearing deletes the saved file. Voice notes keep their one row.
// Every name and text here is made up.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { archiveInputZipMediaLocator } from '../src/workers/archive-import/input-media.ts';
import type { ArchiveImportRecord, ArchiveImportStateStore } from '../src/workers/archive-import/state.ts';
import { ZipArchive } from '../src/workers/archive-import/zip-reader.ts';
import { buildZip } from './helpers/zip-fixture.ts';
import { join } from 'node:path';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { connectorStoreExtractionCandidateReader } from '../src/workers/connector-store/extraction-candidate-reader.ts';
import { deferredBytesAnswerFor } from '../src/workers/file-extraction/connector-source.ts';
import { WHATSAPP_LANE_SYNC, whatsAppConnectorWithInputs } from '../src/workers/whatsapp/archive-target.ts';
import { WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX, createWhatsAppChildReader } from '../src/workers/whatsapp/child-media.ts';
import { WhatsAppExtractionSource } from '../src/workers/whatsapp/extraction-source.ts';
import {
  createWhatsAppLiveSourceConnector,
  emptyWhatsAppSpoolPassFindings,
  redactWhatsAppLiveSpoolSecrets,
  whatsAppBootNonce,
  whatsAppMediaFileStem,
} from '../src/workers/whatsapp/live-connector.ts';
import { runWhatsAppMediaFetch } from '../src/workers/whatsapp/media-fetch.ts';
import { whatsAppExtractionSourceFactory } from '../src/workers/whatsapp/extraction-factory.ts';
import type { RawItem } from '../src/core/contracts.ts';
import {
  WHATSAPP_LIVE_CORPUS_ID,
  WHATSAPP_MEDIA_WAITING_FOR_DISK_WARNING,
  createWhatsAppConnectorStoreSyncHandler,
  createWhatsAppTierLane,
  defaultWhatsAppMediaRoots,
} from '../src/workers/whatsapp/store-sync.ts';

const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CHAT = '15550001111@s.whatsapp.net';

function spoolLine(fields: Record<string, unknown>): string {
  return `${JSON.stringify({
    chat_jid: CHAT,
    chat_name: 'Rowan Hale',
    sender_jid: CHAT,
    sender_name: 'Rowan Hale',
    from_me: false,
    timestamp: '2026-07-01T13:00:00Z',
    text: '',
    ...fields,
  })}\n`;
}

function lane() {
  const root = mkdtempSync(join(tmpdir(), 'whatsapp-media-children-'));
  roots.push(root);
  const spoolDir = join(root, 'spool');
  const images = join(root, 'media', 'images');
  const video = join(root, 'media', 'video');
  const audio = join(root, 'media', 'audio');
  for (const dir of [spoolDir, images, video, audio]) mkdirSync(dir, { recursive: true });
  const store = new LocalConnectorStore({ dbPath: join(root, 'whatsapp.db'), corpusId: WHATSAPP_LIVE_CORPUS_ID, family: 'chat', trustDomain: 'secure_local' });
  const tier = createWhatsAppTierLane({
    store,
    env: { OLYMPUS_SOURCE_INDEX_WHATSAPP_INTERNAL_CONNECTOR_STORE_DB_PATH: join(root, 'whatsapp-internal.db') },
  });
  closers.push(() => {
    tier.newStores.internal?.current()?.close();
    store.close();
  });
  const readChild = createWhatsAppChildReader({ mediaRoots: [images, video, audio] });
  const connector = whatsAppConnectorWithInputs({ spoolDir, readChild });
  const pull = async () => {
    const cursor = tier.set.committedCursor(connector.id)?.cursor ?? undefined;
    await tier.set.sync(connector, { ...WHATSAPP_LANE_SYNC, ...(cursor ? { cursor } : {}) });
  };
  const extraction = new WhatsAppExtractionSource({
    id: 'whatsapp-test-extraction',
    corpusId: WHATSAPP_LIVE_CORPUS_ID,
    provider: 'whatsapp',
    accountScope: 'personal',
    approvedScopeKey: 'whatsapp.personal.messages',
    mediaRoots: [audio],
    candidates: connectorStoreExtractionCandidateReader(store),
    locators: store,
    deferredBytes: (ref) => deferredBytesAnswerFor(store.deferredBytesStateOfLocalItem(ref.localItemId, ref.sourceVersion)),
    readChild,
  });
  return { root, spoolDir, images, video, audio, store, readChild, pull, extraction, ledger: tier.set.ledger, set: tier.set };
}

interface Row {
  id: string;
  parent: string | null;
  locator: string | null;
  mime: string | null;
}

function rows(root: string): Row[] {
  const db = new Database(join(root, 'whatsapp.db'), { readonly: true });
  try {
    return db.query(`
      SELECT provider_item_id AS id, parent_local_item_id AS parent, deferred_locator AS locator, mime_type AS mime
      FROM items WHERE tombstoned = 0 ORDER BY item_pk
    `).all() as Row[];
  } finally {
    db.close();
  }
}

describe('live pictures and videos are children of their message', () => {
  test('a saved picture is its message\'s child, read by its locator through extraction', async () => {
    const target = lane();
    const photo = join(target.images, 'P1.jpg');
    writeFileSync(photo, 'jpeg bytes');
    writeFileSync(join(target.spoolDir, '2026-07-01.jsonl'), spoolLine({
      id: 'P1', media_type: 'image', media_mime: 'image/jpeg', media_path: photo, download_status: 'ok', media_size_bytes: 10,
    }));
    await target.pull();
    const all = rows(target.root);
    const child = all.find((row) => row.id === 'P1#child:media');
    expect(child?.parent).toContain(':P1');
    expect(child?.locator).toBe(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${photo}`);
    // The message is one row of its own, and the file is the child's to read, not the message's.
    expect(all.filter((row) => row.id === 'P1')).toHaveLength(1);
    const page = await target.extraction.listCandidates({ limit: 10 });
    const ref = page.candidates.find((candidate) => candidate.providerItemId === 'P1#child:media');
    expect(ref?.mimeType).toBe('image/jpeg');
    expect(new TextDecoder().decode((await target.extraction.fetch(ref!, {})).bytes)).toBe('jpeg bytes');
  });

  test('a captioned video: the message is its caption, the video its child', async () => {
    const target = lane();
    const clip = join(target.video, 'V1.mp4');
    writeFileSync(clip, 'mp4 bytes');
    writeFileSync(join(target.spoolDir, '2026-07-01.jsonl'), spoolLine({
      id: 'V1', media_type: 'video', media_mime: 'video/mp4', media_path: clip, download_status: 'ok', text: 'the harbour at dusk',
    }));
    await target.pull();
    expect(rows(target.root).find((row) => row.id === 'V1#child:media')?.mime).toBe('video/mp4');
    const items = [];
    for await (const page of createWhatsAppLiveSourceConnector({ spoolDir: target.spoolDir, account: 'personal' }).listItems()) items.push(...page.items);
    const message = items.find((item) => item.identity.providerItemId === 'V1');
    expect(message?.content).toEqual({ kind: 'text', text: 'the harbour at dusk' });
    // The saved file is the child's to read, never the message's.
    expect(message?.metadata).not.toHaveProperty('mediaPath');
  });

  test('a picture the bridge could not save is a child that cannot be read, never offered to extraction', async () => {
    const target = lane();
    writeFileSync(join(target.spoolDir, '2026-07-01.jsonl'), spoolLine({ id: 'P2', media_type: 'image', media_mime: 'image/jpeg', download_status: 'failed' }));
    await target.pull();
    const child = rows(target.root).find((row) => row.id === 'P2#child:media');
    expect(child).toBeDefined();
    expect(child?.locator ?? '').toBe('');
    const page = await target.extraction.listCandidates({ limit: 10 });
    expect(page.candidates.some((candidate) => candidate.providerItemId === 'P2#child:media')).toBe(false);
  });

  test('a spool line naming a file outside the media folders is never read', async () => {
    const target = lane();
    const outside = join(target.root, 'outside.jpg');
    writeFileSync(outside, 'not the bridge\'s');
    writeFileSync(join(target.spoolDir, '2026-07-01.jsonl'), spoolLine({ id: 'P3', media_type: 'image', media_mime: 'image/jpeg', media_path: outside, download_status: 'ok' }));
    await target.pull();
    expect(() => target.readChild(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${outside}`, {})).toThrow('source_permission_denied');
    const page = await target.extraction.listCandidates({ limit: 10 });
    const ref = page.candidates.find((candidate) => candidate.providerItemId === 'P3#child:media');
    if (ref) await expect(target.extraction.fetch(ref, {})).rejects.toMatchObject({ errorKind: 'source_permission_denied' });
  });

  test('a voice note keeps its one row', async () => {
    const target = lane();
    const voice = join(target.audio, 'A1.ogg');
    writeFileSync(voice, 'ogg bytes');
    writeFileSync(join(target.spoolDir, '2026-07-01.jsonl'), spoolLine({ id: 'A1', media_type: 'audio', media_mime: 'audio/ogg', media_path: voice, download_status: 'ok' }));
    await target.pull();
    expect(rows(target.root).map((row) => row.id)).toEqual(['A1']);
  });

  test('clearing a Secret picture deletes the file the bridge saved in its picture folder', () => {
    const target = lane();
    const photo = join(target.images, 'S1.jpg');
    writeFileSync(photo, 'secret picture');
    const day = join(target.spoolDir, '2026-07-01.jsonl');
    writeFileSync(day, spoolLine({ id: 'S1', media_type: 'image', media_mime: 'image/jpeg', media_path: photo, download_status: 'ok', text: 'the door code' }));
    redactWhatsAppLiveSpoolSecrets({
      spoolDir: target.spoolDir,
      account: 'personal',
      judge: () => 'content',
      mediaDir: target.audio,
      mediaDirs: [target.images, target.video],
    });
    expect(existsSync(photo)).toBe(false);
    expect(readFileSync(day, 'utf8')).not.toContain('S1.jpg');
  });

  test('a Secret picture under an ordinary caption loses its file and download keys; the caption stays', () => {
    const target = lane();
    const photo = join(target.images, 'C1.jpg');
    writeFileSync(photo, 'secret picture');
    const day = join(target.spoolDir, '2026-07-01.jsonl');
    writeFileSync(day, spoolLine({
      id: 'C1', media_type: 'image', media_mime: 'image/jpeg', media_path: photo, download_status: 'ok', text: 'lunch at the harbour',
      media_key: 'a2V5', media_direct_path: '/v/t62/fixture',
    }));
    redactWhatsAppLiveSpoolSecrets({
      spoolDir: target.spoolDir,
      account: 'personal',
      judge: (identity) => (identity.providerItemId === 'C1#child:media' ? 'content' : undefined),
      mediaDirs: [target.images, target.video, target.audio],
    });
    expect(existsSync(photo)).toBe(false);
    const line = JSON.parse(readFileSync(day, 'utf8')) as Record<string, unknown>;
    expect(line['text']).toBe('lunch at the harbour');
    expect(line).not.toHaveProperty('media_path');
    expect(line).not.toHaveProperty('media_key');
    expect(line).not.toHaveProperty('media_direct_path');
    expect(line).not.toHaveProperty('secret_redacted');
  });

  test('a Secret caption over an ordinary picture loses its words; the picture and its child stay', async () => {
    const target = lane();
    const photo = join(target.images, 'C2.jpg');
    writeFileSync(photo, 'an ordinary picture');
    const day = join(target.spoolDir, '2026-07-01.jsonl');
    writeFileSync(day, spoolLine({ id: 'C2', media_type: 'image', media_mime: 'image/jpeg', media_path: photo, download_status: 'ok', text: 'the door code is 4411' }));
    redactWhatsAppLiveSpoolSecrets({
      spoolDir: target.spoolDir,
      account: 'personal',
      judge: (identity) => (identity.providerItemId === 'C2' ? 'content' : undefined),
      mediaDirs: [target.images, target.video, target.audio],
    });
    expect(existsSync(photo)).toBe(true);
    const line = JSON.parse(readFileSync(day, 'utf8')) as Record<string, unknown>;
    expect(line['text']).toBe('');
    expect(line['media_path']).toBe(photo);
    expect(line['secret_redacted']).toBe(true);
    await target.pull();
    expect(rows(target.root).find((row) => row.id === 'C2#child:media')?.locator).toBe(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${photo}`);
  });

  test('clearing a Secret picture removes every temp of it; temps a killed bridge left are swept, a stalled live download\'s kept', () => {
    const target = lane();
    const photo = join(target.images, 'T1.jpg');
    writeFileSync(photo, 'secret picture');
    const boot = whatsAppBootNonce();
    const temp = (pid: number, nonce: string, id: string, n: number) => join(target.images, `.olympus-media-${pid}-${nonce}-${whatsAppMediaFileStem(CHAT, id)}-${n}.tmp`);
    // The Secret message's own temp, even of a writer still running; a dead writer's; a live pid of another boot;
    // an older build's past the age; and a live writer's download that stalled for hours.
    const own = temp(process.pid, boot, 'T1', 1);
    const dead = temp(4194305, boot, 'other', 2);
    const otherBoot = temp(process.pid, boot === 'ffffffff' ? 'eeeeeeee' : 'ffffffff', 'other', 3);
    const older = join(target.images, '.audio-4.tmp');
    const stalled = temp(process.pid, boot, 'other', 5);
    for (const path of [own, dead, otherBoot, older, stalled]) writeFileSync(path, 'partial');
    const hoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000);
    utimesSync(older, hoursAgo, hoursAgo);
    utimesSync(stalled, hoursAgo, hoursAgo);
    writeFileSync(join(target.spoolDir, '2026-07-01.jsonl'), spoolLine({ id: 'T1', media_type: 'image', media_mime: 'image/jpeg', media_path: photo, download_status: 'ok' }));
    redactWhatsAppLiveSpoolSecrets({
      spoolDir: target.spoolDir,
      account: 'personal',
      judge: (identity) => (identity.providerItemId === 'T1#child:media' ? 'content' : undefined),
      mediaDirs: [target.images, target.video, target.audio],
    });
    for (const gone of [photo, own, dead, otherBoot, older]) expect(existsSync(gone)).toBe(false);
    expect(existsSync(stalled)).toBe(true);
  });

  test('in a folder account the temps under the media folder\'s picture folder are found from its one root', () => {
    const target = lane();
    const mediaRoot = join(target.root, 'media');
    const photo = join(target.images, 'F1.jpg');
    writeFileSync(photo, 'secret picture');
    const own = join(target.images, `.olympus-media-${process.pid}-${whatsAppBootNonce()}-${whatsAppMediaFileStem(CHAT, 'F1')}-1.tmp`);
    const dead = join(target.video, `.olympus-media-4194305-${whatsAppBootNonce()}-${whatsAppMediaFileStem(CHAT, 'x')}-2.tmp`);
    for (const path of [own, dead]) writeFileSync(path, 'partial');
    writeFileSync(join(target.spoolDir, '2026-07-01.jsonl'), spoolLine({ id: 'F1', media_type: 'image', media_mime: 'image/jpeg', media_path: photo, download_status: 'ok' }));
    // The folder account's media roots are the media folder alone (defaultWhatsAppMediaRoots).
    redactWhatsAppLiveSpoolSecrets({
      spoolDir: target.spoolDir,
      account: 'personal',
      judge: (identity) => (identity.providerItemId === 'F1#child:media' ? 'content' : undefined),
      mediaDirs: [mediaRoot],
    });
    for (const gone of [photo, own, dead]) expect(existsSync(gone)).toBe(false);
  });

  test('a temp that cannot be removed fails the cleanup: the keys stay and the next pull tries again', () => {
    const target = lane();
    const photo = join(target.images, 'E1.jpg');
    writeFileSync(photo, 'secret picture');
    // The temp sits where only it cannot be removed; the saved picture itself could be.
    const own = join(target.video, `.olympus-media-${process.pid}-${whatsAppBootNonce()}-${whatsAppMediaFileStem(CHAT, 'E1')}-1.tmp`);
    writeFileSync(own, 'partial');
    const day = join(target.spoolDir, '2026-07-01.jsonl');
    const original = spoolLine({ id: 'E1', media_type: 'image', media_mime: 'image/jpeg', media_path: photo, download_status: 'ok', media_key: 'a2V5' });
    writeFileSync(day, original);
    const clear = () => redactWhatsAppLiveSpoolSecrets({
      spoolDir: target.spoolDir,
      account: 'personal',
      judge: (identity) => (identity.providerItemId === 'E1#child:media' ? 'content' : undefined),
      mediaDirs: [target.images, target.video, target.audio],
    });
    chmodSync(target.video, 0o500);
    try {
      expect(clear).toThrow();
      // Not certified: the line keeps its path and keys.
      expect(readFileSync(day, 'utf8')).toBe(original);
    } finally {
      chmodSync(target.video, 0o700);
    }
    // Retried once removing works: cleared.
    clear();
    expect(existsSync(own)).toBe(false);
    expect(existsSync(photo)).toBe(false);
    expect(JSON.parse(readFileSync(day, 'utf8'))).not.toHaveProperty('media_key');
  });

  test('a media folder that cannot be read fails a Secret picture\'s cleanup: never certified past it', () => {
    const target = lane();
    const photo = join(target.images, 'U1.jpg');
    writeFileSync(photo, 'secret picture');
    const day = join(target.spoolDir, '2026-07-01.jsonl');
    const original = spoolLine({ id: 'U1', media_type: 'image', media_mime: 'image/jpeg', media_path: photo, download_status: 'ok', media_key: 'a2V5' });
    writeFileSync(day, original);
    const clear = () => redactWhatsAppLiveSpoolSecrets({
      spoolDir: target.spoolDir,
      account: 'personal',
      judge: (identity) => (identity.providerItemId === 'U1#child:media' ? 'content' : undefined),
      mediaDirs: [join(target.root, 'media')],
    });
    // The video folder can be written and entered, never listed: a temp of U1 there could not be found.
    chmodSync(target.video, 0o300);
    try {
      expect(clear).toThrow();
      expect(readFileSync(day, 'utf8')).toBe(original);
    } finally {
      chmodSync(target.video, 0o700);
    }
    clear();
    expect(JSON.parse(readFileSync(day, 'utf8'))).not.toHaveProperty('media_key');
  });

  test('a live media child is held until its own judgment', async () => {
    const target = lane();
    const photo = join(target.images, 'H1.jpg');
    writeFileSync(photo, 'jpeg bytes');
    writeFileSync(join(target.spoolDir, '2026-07-01.jsonl'), spoolLine({ id: 'H1', media_type: 'image', media_mime: 'image/jpeg', media_path: photo, download_status: 'ok' }));
    const items: RawItem[] = [];
    for await (const page of createWhatsAppLiveSourceConnector({ spoolDir: target.spoolDir, account: 'personal' }).listItems()) items.push(...page.items);
    expect(items.find((item) => item.identity.providerItemId === 'H1#child:media')?.holdContentUntilJudged).toBe(true);
    // The message itself is not held by this.
    expect(items.find((item) => item.identity.providerItemId === 'H1')?.holdContentUntilJudged).toBeUndefined();
  });

  test('the child reader reads only the file it checked: no link at the end, never past the bound', () => {
    const target = lane();
    const photo = join(target.images, 'R1.jpg');
    writeFileSync(photo, 'jpeg bytes');
    const link = join(target.images, 'R1-link.jpg');
    symlinkSync(photo, link);
    expect(() => target.readChild(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${link}`, {})).toThrow('source_permission_denied');
    expect(() => target.readChild(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${photo}`, { maxBytes: 4 })).toThrow('source_too_large');
    expect(new TextDecoder().decode(target.readChild(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${photo}`, {}))).toBe('jpeg bytes');
  });

  test('extraction lists children across the lane\'s tier stores, not only the Private one', async () => {
    // The picture's row is in one store (another tier's); the corpus's own store holds nothing.
    const holding = lane();
    const photo = join(holding.images, 'P9.jpg');
    writeFileSync(photo, 'jpeg bytes');
    writeFileSync(join(holding.spoolDir, '2026-07-01.jsonl'), spoolLine({ id: 'P9', media_type: 'image', media_mime: 'image/jpeg', media_path: photo, download_status: 'ok' }));
    await holding.pull();
    const empty = lane();
    const factory = whatsAppExtractionSourceFactory({});
    type View = NonNullable<Parameters<typeof factory>[0]['view']>;
    const withView = factory({
      config: { corpusId: WHATSAPP_LIVE_CORPUS_ID, provider: 'whatsapp', scopes: ['whatsapp.personal.messages'] },
      store: empty.store,
      view: holding.store as unknown as View,
    });
    expect((await withView.listCandidates({ limit: 10 })).candidates.map((candidate) => candidate.providerItemId)).toContain('P9#child:media');
    // Without the lane's view, only the corpus's own store is listed.
    const withoutView = factory({ config: { corpusId: WHATSAPP_LIVE_CORPUS_ID, provider: 'whatsapp', scopes: ['whatsapp.personal.messages'] }, store: empty.store });
    expect((await withoutView.listCandidates({ limit: 10 })).candidates).toEqual([]);
  });

  test('the media folders a read may touch are the audio folder and the bridge\'s picture and video folders', () => {
    const state = join(tmpdir(), 'olympus-wa-state-fixture');
    const roots = defaultWhatsAppMediaRoots({ OLYMPUS_WHATSAPP_STATE_DIR: state });
    expect(roots).toEqual(expect.arrayContaining([join(state, 'media', 'images'), join(state, 'media', 'video')]));
  });
});

describe('every piece of media is kept; the one safeguard is free disk space (owner, 2026-10-26)', () => {
  test('a picture waiting for disk space is a child that says so, and a later line with the file fills it', async () => {
    const target = lane();
    const day = join(target.spoolDir, '2026-07-01.jsonl');
    writeFileSync(day, spoolLine({ id: 'W1', media_type: 'image', media_mime: 'image/jpeg', download_status: 'waiting_for_disk', text: 'the harbour' }));
    await target.pull();
    expect(rows(target.root).find((row) => row.id === 'W1#child:media')?.locator ?? '').toBe('');
    const items: RawItem[] = [];
    for await (const page of createWhatsAppLiveSourceConnector({ spoolDir: target.spoolDir, account: 'personal' }).listItems()) items.push(...page.items);
    const child = items.find((item) => item.identity.providerItemId === 'W1#child:media');
    expect(child?.metadata['mediaState']).toBe('waiting_for_disk_space');
    expect(child?.deferredBytes?.available).toBe(false);
    // Space returned: the bridge spools the message again with its media.
    const photo = join(target.images, 'W1.jpg');
    writeFileSync(photo, 'jpeg bytes');
    writeFileSync(day, readFileSync(day, 'utf8') + spoolLine({ id: 'W1', media_type: 'image', media_mime: 'image/jpeg', media_path: photo, download_status: 'ok', text: 'the harbour' }));
    await target.pull();
    expect(rows(target.root).find((row) => row.id === 'W1#child:media')?.locator).toBe(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${photo}`);
  });

  test('a pull says media waits for disk space, as a flag and a warning, never a count', async () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsapp-media-disk-'));
    roots.push(root);
    const spoolDir = join(root, 'spool');
    mkdirSync(spoolDir, { recursive: true });
    writeFileSync(join(spoolDir, '2026-07-01.jsonl'), spoolLine({ id: 'D1', text: 'hello' }));
    writeFileSync(join(spoolDir, 'capture-status.json'), JSON.stringify({
      kind: 'whatsapp_capture_status', updated_at: '2026-07-01T13:00:00Z', connected: true, dropped_messages: 0, media_waiting_for_disk: true,
    }));
    const store = new LocalConnectorStore({ dbPath: join(root, 'whatsapp.db'), corpusId: WHATSAPP_LIVE_CORPUS_ID, family: 'chat', trustDomain: 'secure_local' });
    closers.push(() => store.close());
    const sync = createWhatsAppConnectorStoreSyncHandler({ store, spoolDir, now: () => new Date('2026-07-01T13:05:00Z') });
    const receipt = await sync.pull();
    expect(receipt.counts.capture_media_waiting_for_disk).toBe(1);
    expect(receipt.warnings).toContain(WHATSAPP_MEDIA_WAITING_FOR_DISK_WARNING);
    writeFileSync(join(spoolDir, 'capture-status.json'), JSON.stringify({
      kind: 'whatsapp_capture_status', updated_at: '2026-07-01T13:06:00Z', connected: true, dropped_messages: 0,
    }));
    const after = await sync.pull();
    expect(after.counts.capture_media_waiting_for_disk).toBe(0);
    expect(after.warnings ?? []).not.toContain(WHATSAPP_MEDIA_WAITING_FOR_DISK_WARNING);
  });

  test('a saved file is read whole however large: no content cap, only the caller\'s own bound', () => {
    const target = lane();
    const clip = join(target.video, 'V9.mp4');
    const size = 65 * 1024 * 1024; // past the old 64 MiB cap
    writeFileSync(clip, Buffer.alloc(size, 7));
    expect(target.readChild(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${clip}`, {}).byteLength).toBe(size);
    expect(() => target.readChild(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${clip}`, { maxBytes: 1024 })).toThrow('source_too_large');
  });
});

describe('review round 4 on #558: no Secret left in a waiting line, large media never read whole', () => {
  test('a large video is handed to a file reader as a file, copied a chunk at a time, never read whole', async () => {
    const target = lane();
    const clip = join(target.video, 'V7.mp4');
    const size = 70 * 1024 * 1024;
    writeFileSync(clip, Buffer.alloc(size, 9));
    writeFileSync(join(target.spoolDir, '2026-07-01.jsonl'), spoolLine({ id: 'V7', media_type: 'video', media_mime: 'video/mp4', media_path: clip, download_status: 'ok' }));
    await target.pull();
    // A reader that would load it into memory fails the test.
    const toFile = target.readChild.toFile;
    const guarded = Object.assign(() => { throw new Error('read into memory'); }, { toFile }) as unknown as typeof target.readChild;
    const source = new WhatsAppExtractionSource({
      id: 'whatsapp-test-extraction',
      corpusId: WHATSAPP_LIVE_CORPUS_ID,
      provider: 'whatsapp',
      accountScope: 'personal',
      approvedScopeKey: 'whatsapp.personal.messages',
      mediaRoots: [target.audio],
      candidates: connectorStoreExtractionCandidateReader(target.store),
      locators: target.store,
      deferredBytes: (ref) => deferredBytesAnswerFor(target.store.deferredBytesStateOfLocalItem(ref.localItemId, ref.sourceVersion)),
      readChild: guarded,
    });
    const ref = (await source.listCandidates({ limit: 10 })).candidates.find((candidate) => candidate.providerItemId === 'V7#child:media')!;
    const spoolDir = join(target.root, 'extraction-spool');
    const file = await source.fetchFile(ref, { spoolDir });
    expect(file.sizeBytes).toBe(size);
    expect(file.path.startsWith(spoolDir)).toBe(true);
    expect(readFileSync(file.path).byteLength).toBe(size);
    await file.dispose();
    expect(existsSync(file.path)).toBe(false);
  }, 60_000);

  test('a voice note is handed over as a file too, from under the media folders only', async () => {
    const target = lane();
    const voice = join(target.audio, 'A5.ogg');
    writeFileSync(voice, 'ogg bytes');
    writeFileSync(join(target.spoolDir, '2026-07-01.jsonl'), spoolLine({ id: 'A5', media_type: 'audio', media_mime: 'audio/ogg', media_path: voice, download_status: 'ok' }));
    await target.pull();
    const ref = (await target.extraction.listCandidates({ limit: 10 })).candidates.find((candidate) => candidate.providerItemId === 'A5')!;
    const file = await target.extraction.fetchFile(ref, { spoolDir: join(target.root, 'extraction-spool') });
    expect(readFileSync(file.path, 'utf8')).toBe('ogg bytes');
    await file.dispose();
  });
});

describe('an export\'s media of any size reaches extraction as a file (owner, 2026-10-26)', () => {
  test('a 65 MiB video in the export zip is copied to a file through the child reader, never refused', () => {
    const root = mkdtempSync(join(tmpdir(), 'whatsapp-export-video-'));
    roots.push(root);
    const size = 65 * 1024 * 1024;
    writeFileSync(join(root, 'WhatsApp Chat - Rowan.zip'), buildZip([
      { name: '_chat.txt', data: '[01/07/2026, 09:00:00] Rowan: VID-20260701-WA0003.mp4 (file attached)\n', method: 'deflate' },
      { name: 'VID-20260701-WA0003.mp4', data: new Uint8Array(size).fill(5), method: 'deflate' },
    ]));
    const scope = ScopeRoot.open(root);
    const reader = scope.openFile('WhatsApp Chat - Rowan.zip');
    const members = ZipArchive.open(reader).memberTable();
    reader.close();
    const version = scope.statRelative('WhatsApp Chat - Rowan.zip');
    scope.close();
    const record = {
      archive_id: 'arch-v', status: 'imported', root_path: root, chosen_rel_path: 'WhatsApp Chat - Rowan.zip',
      target: { source_id: 'whatsapp.personal.messages', slot: 'default' },
      files: [{ rel_path: 'WhatsApp Chat - Rowan.zip', dev: version.dev, ino: version.ino, size: version.size, mtime_ms: version.mtimeMs, fingerprint: { head_sha256: '', tail_sha256: '' }, members }],
    } as unknown as ArchiveImportRecord;
    const state = { get: (id: string) => (id === 'arch-v' ? record : undefined) } as unknown as ArchiveImportStateStore;
    const readChild = createWhatsAppChildReader({ mediaRoots: [root], archive: () => ({ state }) });
    const locator = archiveInputZipMediaLocator({ archiveId: 'arch-v', fileIndex: 0, memberIndex: 1 });
    const dest = join(root, 'out.mp4');
    expect(readChild.toFile(locator, {}, dest)).toBe(size);
    expect(readFileSync(dest).byteLength).toBe(size);
  }, 60_000);
});

describe('review round 8 on #558: Olympus alone asks for waiting media, and deletes what it no longer wants', () => {
  const DAY = '2026-07-01.jsonl';
  // Key-shaped text is assembled at run time so no literal key sits in the repository.
  const KEY = ['gh', 'p_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'].join('');
  const waitingLine = (id: string, fields: Record<string, unknown> = {}) => spoolLine({
    id,
    media_type: 'image',
    media_mime: 'image/jpeg',
    download_status: 'waiting_for_disk',
    media_key: 'a2V5',
    media_direct_path: `/mms/image/${id}`,
    media_file_sha256: 'ZmlsZQ==',
    media_file_enc_sha256: 'ZW5j',
    ...fields,
  });
  const append = (target: ReturnType<typeof lane>, line: string) => {
    const day = join(target.spoolDir, DAY);
    writeFileSync(day, (existsSync(day) ? readFileSync(day, 'utf8') : '') + line);
  };
  // One pull's media pass: what a listing of the spool finds, then the pass over it.
  const pass = async (target: ReturnType<typeof lane>, room = true) => {
    const findings = emptyWhatsAppSpoolPassFindings();
    for await (const _page of createWhatsAppLiveSourceConnector({ spoolDir: target.spoolDir, account: 'personal', findings }).listItems()) { /* listed */ }
    return runWhatsAppMediaFetch({
      spoolDir: target.spoolDir,
      account: 'personal',
      mediaRoot: join(target.root, 'media'),
      folders: { image: target.images, video: target.video, audio: target.audio },
      tierSet: target.set,
      findings,
      sync: WHATSAPP_LANE_SYNC,
      readChild: target.readChild,
      space: () => (room ? { free: 1_000 * 2 ** 30, total: 1_000 * 2 ** 30 } : { free: 2 ** 30, total: 1_000 * 2 ** 30 }),
    });
  };
  const paths = (target: ReturnType<typeof lane>, id: string, ext = '.jpg') => {
    const stem = whatsAppMediaFileStem(CHAT, id);
    return {
      stem,
      request: join(target.root, 'media', 'fetch', `${stem}.json`),
      answer: join(target.root, 'media', 'fetched', `${stem}${ext}`),
      placed: join(target.images, `${stem}-fetched${ext}`),
    };
  };
  const answer = (path: string, bytes = 'jpeg bytes') => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, bytes);
  };
  const judgeSecret = (target: ReturnType<typeof lane>, providerItemId: string) => {
    const identity = { provider: 'whatsapp', accountScope: 'personal', providerItemId, providerConversationId: CHAT };
    target.ledger.recordContentDecision(identity, {
      contentTier: 'secrets',
      decidedBy: 'secret_detector',
      reasons: ['content:secret_fixture'],
      contentPending: false,
      engineVersion: 'fixture',
      mapRevision: 'fixture',
      snifferId: 'fixture',
    });
  };
  const childLocator = (target: ReturnType<typeof lane>, id: string) => rows(target.root).find((row) => row.id === `${id}#child:media`)?.locator ?? '';

  test('an uncaptioned picture is asked for once its message is stored and not Secret; the request holds no words or names', async () => {
    const target = lane();
    append(target, waitingLine('U1'));
    await target.pull();
    expect((await pass(target)).requested).toBe(1);
    const request = JSON.parse(readFileSync(paths(target, 'U1').request, 'utf8')) as Record<string, unknown>;
    expect(request).toEqual({
      chat_jid: CHAT,
      id: 'U1',
      media_type: 'image',
      media_mime: 'image/jpeg',
      media_key: 'a2V5',
      media_direct_path: '/mms/image/U1',
      media_file_sha256: 'ZmlsZQ==',
      media_file_enc_sha256: 'ZW5j',
    });
    // Asked once: the next pass leaves it as it is.
    expect((await pass(target)).requested).toBe(0);
  });

  test('a request for a message whose id holds a dot is kept by the sweep', async () => {
    const target = lane();
    append(target, waitingLine('3EB0.42'));
    await target.pull();
    await pass(target);
    await pass(target);
    expect(existsSync(paths(target, '3EB0.42').request)).toBe(true);
  });

  test('a message not stored yet is not asked for', async () => {
    const target = lane();
    append(target, waitingLine('N1'));
    expect((await pass(target)).requested).toBe(0);
    expect(existsSync(paths(target, 'N1').request)).toBe(false);
  });

  test('a Secret message is never asked for, nor a Secret picture', async () => {
    const target = lane();
    append(target, waitingLine('S1', { text: `deploy key ${KEY}` }));
    append(target, waitingLine('S2', { text: 'the harbour' }));
    await target.pull();
    judgeSecret(target, 'S2#child:media');
    await pass(target);
    for (const id of ['S1', 'S2']) expect(existsSync(paths(target, id).request)).toBe(false);
  });

  test('fetched media fills the child alone, kept in the picture folder; the request and answer go', async () => {
    const target = lane();
    append(target, waitingLine('F1', { text: 'the harbour at dusk' }));
    await target.pull();
    await pass(target);
    const at = paths(target, 'F1');
    answer(at.answer);
    const result = await pass(target);
    expect(result.filled).toBe(1);
    expect(childLocator(target, 'F1')).toBe(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${at.placed}`);
    expect(readFileSync(at.placed, 'utf8')).toBe('jpeg bytes');
    for (const gone of [at.request, at.answer]) expect(existsSync(gone)).toBe(false);
    // The child reads through the same reader as any saved picture.
    expect(new TextDecoder().decode(target.readChild(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${at.placed}`, {}))).toBe('jpeg bytes');
    // Nothing more is asked for it.
    expect((await pass(target)).requested).toBe(0);
    expect(existsSync(at.request)).toBe(false);
  });

  test('a voice note waiting for disk space is asked for and filled as itself', async () => {
    const target = lane();
    append(target, waitingLine('A1', { media_type: 'audio', media_mime: 'audio/ogg' }));
    await target.pull();
    await pass(target);
    const at = paths(target, 'A1', '.ogg');
    expect(existsSync(at.request)).toBe(true);
    answer(at.answer, 'ogg bytes');
    expect((await pass(target)).filled).toBe(1);
    const placed = join(target.audio, `${at.stem}-fetched.ogg`);
    const db = new Database(join(target.root, 'whatsapp.db'), { readonly: true });
    try {
      const row = db.query("SELECT locator_uri AS locator FROM items WHERE provider_item_id = 'A1'").get() as { locator: string | null };
      expect(row.locator).toBe(placed);
    } finally {
      db.close();
    }
    expect(readFileSync(placed, 'utf8')).toBe('ogg bytes');
  });

  test('a message turning Secret mid-download: its request goes, and a download landing after is deleted', async () => {
    const target = lane();
    append(target, waitingLine('R1', { text: 'see you at eight' }));
    await target.pull();
    await pass(target);
    const at = paths(target, 'R1');
    expect(existsSync(at.request)).toBe(true);
    judgeSecret(target, 'R1');
    await pass(target);
    expect(existsSync(at.request)).toBe(false);
    // The bridge was already downloading: its answer lands after the request went.
    answer(at.answer);
    answer(join(target.root, 'media', 'fetched', `${at.stem}.part`), 'half');
    await pass(target);
    expect(existsSync(at.answer)).toBe(false);
    expect(existsSync(join(target.root, 'media', 'fetched', `${at.stem}.part`))).toBe(false);
    expect(existsSync(at.placed)).toBe(false);
    expect(childLocator(target, 'R1')).toBe('');
  });

  test('a crash after the fetched copy was kept but before the fill, then Secret: every copy is deleted', async () => {
    const target = lane();
    append(target, waitingLine('C1', { text: 'see you at eight' }));
    await target.pull();
    await pass(target);
    const at = paths(target, 'C1');
    answer(at.answer);
    // What a pass that died before its fill left: the copy kept, the answer and request still there.
    answer(at.placed);
    judgeSecret(target, 'C1#child:media');
    await pass(target);
    for (const gone of [at.request, at.answer, at.placed]) expect(existsSync(gone)).toBe(false);
    expect(childLocator(target, 'C1')).toBe('');
  });

  test('another version: a request for the old one is withdrawn, and its download never fills the new one', async () => {
    const target = lane();
    append(target, waitingLine('V1', { text: 'first' }));
    await target.pull();
    await pass(target);
    const at = paths(target, 'V1');
    expect(existsSync(at.request)).toBe(true);
    // The message comes again, newer, and the bridge could not save its media for good.
    append(target, spoolLine({ id: 'V1', media_type: 'image', media_mime: 'image/jpeg', download_status: 'failed:gone', text: 'second', timestamp: '2026-07-01T14:00:00Z' }));
    await target.pull();
    answer(at.answer);
    await pass(target);
    for (const gone of [at.request, at.answer, at.placed]) expect(existsSync(gone)).toBe(false);
    expect(childLocator(target, 'V1')).toBe('');
  });

  test('a newer waiting version replaces the request: the stale one is issued again for the version stored', async () => {
    const target = lane();
    append(target, waitingLine('W1', { text: 'first' }));
    await target.pull();
    await pass(target);
    const at = paths(target, 'W1');
    append(target, waitingLine('W1', { text: 'second', timestamp: '2026-07-01T14:00:00Z', media_direct_path: '/mms/image/W1-again' }));
    await target.pull();
    await pass(target);
    expect((JSON.parse(readFileSync(at.request, 'utf8')) as Record<string, unknown>)['media_direct_path']).toBe('/mms/image/W1-again');
  });

  test('media that can never be fetched leaves its child unreadable and nothing behind', async () => {
    const target = lane();
    append(target, waitingLine('X1'));
    await target.pull();
    await pass(target);
    const at = paths(target, 'X1');
    const failed = join(target.root, 'media', 'fetched', `${at.stem}.failed`);
    answer(failed, 'gone');
    await pass(target);
    for (const gone of [at.request, failed]) expect(existsSync(gone)).toBe(false);
    expect(childLocator(target, 'X1')).toBe('');
    expect((await pass(target)).requested).toBe(0);
  });

  test('below the floor nothing is asked for, and the pass says media waits', async () => {
    const target = lane();
    append(target, waitingLine('D1'));
    await target.pull();
    const result = await pass(target, false);
    expect(result.waitingForDisk).toBe(true);
    expect(existsSync(paths(target, 'D1').request)).toBe(false);
    expect((await pass(target)).waitingForDisk).toBe(false);
  });

  test('a request or answer for a message Olympus does not wait for is deleted', async () => {
    const target = lane();
    const fetch = join(target.root, 'media', 'fetch');
    const fetched = join(target.root, 'media', 'fetched');
    const strays = [join(fetch, 'stray-0123456789abcdef.json'), join(fetched, 'stray-0123456789abcdef.jpg'), join(fetched, 'stray-0123456789abcdef.part')];
    for (const stray of strays) answer(stray);
    await pass(target);
    for (const stray of strays) expect(existsSync(stray)).toBe(false);
  });

  test('a fetched picture later judged Secret is deleted by the clearing, though no line names it', async () => {
    const target = lane();
    append(target, waitingLine('L1', { text: 'the harbour' }));
    await target.pull();
    await pass(target);
    const at = paths(target, 'L1');
    answer(at.answer);
    await pass(target);
    expect(existsSync(at.placed)).toBe(true);
    redactWhatsAppLiveSpoolSecrets({
      spoolDir: target.spoolDir,
      account: 'personal',
      judge: (identity) => (identity.providerItemId === 'L1#child:media' ? 'content' : undefined),
      mediaDirs: [target.images, target.video, target.audio],
    });
    expect(existsSync(at.placed)).toBe(false);
  });
});
