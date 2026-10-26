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
import {
  bridgeMediaCall,
  runWhatsAppMediaFetch,
  WhatsAppMediaFetchState,
  type WhatsAppMediaAnswer,
  type WhatsAppMediaRequest,
} from '../src/workers/whatsapp/media-fetch.ts';
import { createServer, type Server } from 'node:net';
import { tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';
import { withFileLease } from '../src/core/file-lease.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { createHash } from 'node:crypto';
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

function lane(options: { secretLocations?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'whatsapp-media-children-'));
  roots.push(root);
  const spoolDir = join(root, 'spool');
  const images = join(root, 'media', 'images');
  const video = join(root, 'media', 'video');
  const audio = join(root, 'media', 'audio');
  for (const dir of [spoolDir, images, video, audio]) mkdirSync(dir, { recursive: true });
  const store = new LocalConnectorStore({ dbPath: join(root, 'whatsapp.db'), corpusId: WHATSAPP_LIVE_CORPUS_ID, family: 'chat', trustDomain: 'secure_local' });
  const secretLocations = options.secretLocations ? new SecretLocationsIndex({ dbPath: join(root, 'secret-locations.db') }) : undefined;
  const tier = createWhatsAppTierLane({
    store,
    env: { OLYMPUS_SOURCE_INDEX_WHATSAPP_INTERNAL_CONNECTOR_STORE_DB_PATH: join(root, 'whatsapp-internal.db') },
    ...(secretLocations ? { secretLocations } : {}),
  });
  closers.push(() => {
    secretLocations?.close();
    tier.newStores.internal?.current()?.close();
    store.close();
  });
  const fetched = join(root, 'media', 'olympus');
  const readChild = createWhatsAppChildReader({ mediaRoots: [images, video, audio, fetched] });
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
    mediaRoots: [audio, fetched],
    candidates: connectorStoreExtractionCandidateReader(store),
    locators: store,
    deferredBytes: (ref) => deferredBytesAnswerFor(store.deferredBytesStateOfLocalItem(ref.localItemId, ref.sourceVersion)),
    readChild,
  });
  return { root, spoolDir, images, video, audio, fetched, store, readChild, pull, extraction, ledger: tier.set.ledger, set: tier.set };
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

describe('review round 9 on #558: Olympus asks the bridge for the exact version, and owns every write', () => {
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
  // The bridge's call, in process: it answers `bytes` (or `answer`), running `during` first, as a download would take time.
  const bridge = (options: { bytes?: string; answer?: WhatsAppMediaAnswer; during?: () => void } = {}) => {
    const asked: WhatsAppMediaRequest[] = [];
    const call = async (request: WhatsAppMediaRequest, part: string, fits: (size: number) => boolean): Promise<WhatsAppMediaAnswer> => {
      asked.push(request);
      options.during?.();
      if (options.answer) return options.answer;
      const bytes = options.bytes ?? 'jpeg bytes';
      if (!fits(bytes.length)) return { status: 'failed', permanent: false, reason: 'waiting_for_disk' };
      writeFileSync(part, bytes);
      return { status: 'ok', size: bytes.length };
    };
    return { asked, call };
  };
  // One pull's media pass: the listing (which records what waits as it reads), then the pass.
  const pass = async (target: ReturnType<typeof lane>, call = bridge().call, extra: { room?: boolean; set?: typeof target.set } = {}) => {
    const state = WhatsAppMediaFetchState.open(target.spoolDir);
    try {
      const findings = emptyWhatsAppSpoolPassFindings();
      findings.onWaitingMedia = (media) => state.note(media);
      for await (const _page of createWhatsAppLiveSourceConnector({ spoolDir: target.spoolDir, account: 'personal', findings }).listItems()) { /* listed */ }
      return await runWhatsAppMediaFetch({
        state,
        spoolDir: target.spoolDir,
        account: 'personal',
        folder: target.fetched,
        tierSet: extra.set ?? target.set,
        findings,
        sync: WHATSAPP_LANE_SYNC,
        call,
        readChild: target.readChild,
        space: () => (extra.room === false ? { free: 2 ** 30, total: 1_000 * 2 ** 30 } : { free: 1_000 * 2 ** 30, total: 1_000 * 2 ** 30 }),
      });
    } finally {
      state.close();
    }
  };
  const digest = (version: string) => createHash('sha256').update(version, 'utf8').digest('hex').slice(0, 16);
  const fetchedPath = (target: ReturnType<typeof lane>, id: string, version = '2026-07-01T13:00:00Z', ext = '.jpg') =>
    join(target.fetched, `${whatsAppMediaFileStem(CHAT, id)}~${digest(version)}${ext}`);
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
  const folderFiles = (target: ReturnType<typeof lane>) => (existsSync(target.fetched) ? readdirSync(target.fetched) : []);

  test('an uncaptioned picture is fetched for its stored version into Olympus\'s folder and fills its child, once', async () => {
    const target = lane();
    append(target, waitingLine('U1'));
    await target.pull();
    const { asked, call } = bridge();
    const result = await pass(target, call);
    expect(result.filled).toBe(1);
    expect(asked).toEqual([{
      chat_jid: CHAT,
      id: 'U1',
      version: '2026-07-01T13:00:00Z',
      media_type: 'image',
      media_mime: 'image/jpeg',
      media_key: 'a2V5',
      media_direct_path: '/mms/image/U1',
      media_file_sha256: 'ZmlsZQ==',
      media_file_enc_sha256: 'ZW5j',
    }]);
    const path = fetchedPath(target, 'U1');
    expect(childLocator(target, 'U1')).toBe(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${path}`);
    expect(new TextDecoder().decode(target.readChild(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${path}`, {}))).toBe('jpeg bytes');
    expect(folderFiles(target)).toEqual([path.slice(target.fetched.length + 1)]);
    // Done: nothing is asked again, even when the line is read again.
    await pass(target, call);
    expect(asked.length).toBe(1);
  });

  test('what waits is recorded as the listing reads the line, before any pull commits past it', async () => {
    const target = lane();
    append(target, waitingLine('L1'));
    const state = WhatsAppMediaFetchState.open(target.spoolDir);
    try {
      const findings = emptyWhatsAppSpoolPassFindings();
      findings.onWaitingMedia = (media) => state.note(media);
      for await (const _page of createWhatsAppLiveSourceConnector({ spoolDir: target.spoolDir, account: 'personal', findings }).listItems()) { /* listed, never committed */ }
    } finally {
      state.close();
    }
    const reopened = WhatsAppMediaFetchState.open(target.spoolDir);
    try {
      expect(reopened.all().map((row) => row.id)).toEqual(['L1']);
    } finally {
      reopened.close();
    }
  });

  test('a message not stored yet is not asked for', async () => {
    const target = lane();
    append(target, waitingLine('N1'));
    const { asked, call } = bridge();
    await pass(target, call);
    expect(asked).toEqual([]);
  });

  test('a Secret message is never asked for, nor a Secret picture', async () => {
    const target = lane();
    append(target, waitingLine('S1', { text: `deploy key ${KEY}` }));
    append(target, waitingLine('S2', { text: 'the harbour' }));
    await target.pull();
    judgeSecret(target, 'S2#child:media');
    const { asked, call } = bridge();
    await pass(target, call);
    expect(asked).toEqual([]);
  });

  test('a newer clean version never authorizes the older Secret version\'s media', async () => {
    const target = lane();
    append(target, waitingLine('V1', { text: `deploy key ${KEY}`, media_direct_path: '/mms/image/V1-old' }));
    append(target, waitingLine('V1', { text: 'all clear now', timestamp: '2026-07-01T14:00:00Z', media_direct_path: '/mms/image/V1-new' }));
    await target.pull();
    const { asked, call } = bridge();
    await pass(target, call);
    expect(asked.map((request) => [request.version, request.media_direct_path])).not.toContainEqual(['2026-07-01T13:00:00Z', '/mms/image/V1-old']);
    expect(existsSync(fetchedPath(target, 'V1'))).toBe(false);
  });

  test('a voice note stored at a newer version is never fetched for the older one', async () => {
    const target = lane();
    append(target, waitingLine('V2', { media_type: 'audio', media_mime: 'audio/ogg', media_direct_path: '/mms/audio/V2-old' }));
    append(target, waitingLine('V2', { media_type: 'audio', media_mime: 'audio/ogg', timestamp: '2026-07-01T14:00:00Z', media_direct_path: '/mms/audio/V2-new' }));
    await target.pull();
    const { asked, call } = bridge({ bytes: 'ogg bytes' });
    await pass(target, call);
    expect(asked.map((request) => request.media_direct_path)).toEqual(['/mms/audio/V2-new']);
  });

  test('a message turning Secret while its bytes come in never keeps them', async () => {
    const target = lane();
    append(target, waitingLine('R1', { text: 'see you at eight' }));
    await target.pull();
    const { call } = bridge({ during: () => judgeSecret(target, 'R1') });
    await pass(target, call);
    expect(folderFiles(target)).toEqual([]);
    expect(childLocator(target, 'R1')).toBe('');
  });

  test('a fetched and filled picture whose message turns Secret later loses its file on the next pass', async () => {
    const target = lane();
    append(target, waitingLine('T1', { text: 'see you at eight' }));
    await target.pull();
    await pass(target);
    expect(existsSync(fetchedPath(target, 'T1'))).toBe(true);
    judgeSecret(target, 'T1');
    const { asked, call } = bridge();
    await pass(target, call);
    expect(folderFiles(target)).toEqual([]);
    expect(asked).toEqual([]);
  });

  test('a fill the sync did not land is not done: the next pass fills it from the file it has, without asking again', async () => {
    const target = lane();
    append(target, waitingLine('F1', { text: 'the harbour at dusk' }));
    await target.pull();
    const lost = new Proxy(target.set, {
      get: (set, key) => (key === 'sync' ? async () => undefined : Reflect.get(set, key, set)),
    });
    const { asked, call } = bridge();
    expect((await pass(target, call, { set: lost })).filled).toBe(0);
    expect(childLocator(target, 'F1')).toBe('');
    expect((await pass(target, call)).filled).toBe(1);
    expect(asked.length).toBe(1);
    expect(childLocator(target, 'F1')).toBe(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${fetchedPath(target, 'F1')}`);
  });

  test('the fill is built from the stored version\'s own line, not a later replay of an older one', async () => {
    const target = lane();
    append(target, waitingLine('P1', { text: 'second', timestamp: '2026-07-01T14:00:00Z' }));
    await target.pull();
    // An older version of the message, replayed after it: the physically last line, never the stored one.
    append(target, waitingLine('P1', { text: 'first', timestamp: '2026-07-01T12:00:00Z' }));
    await target.pull();
    expect((await pass(target)).filled).toBe(1);
    expect(childLocator(target, 'P1')).toBe(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${fetchedPath(target, 'P1', '2026-07-01T14:00:00Z')}`);
  });

  test('a voice note waiting for disk space is fetched and filled as itself', async () => {
    const target = lane();
    append(target, waitingLine('A1', { media_type: 'audio', media_mime: 'audio/ogg' }));
    await target.pull();
    expect((await pass(target, bridge({ bytes: 'ogg bytes' }).call)).filled).toBe(1);
    const path = fetchedPath(target, 'A1', '2026-07-01T13:00:00Z', '.ogg');
    const db = new Database(join(target.root, 'whatsapp.db'), { readonly: true });
    try {
      const row = db.query("SELECT locator_uri AS locator FROM items WHERE provider_item_id = 'A1'").get() as { locator: string | null };
      expect(row.locator).toBe(path);
    } finally {
      db.close();
    }
    expect(readFileSync(path, 'utf8')).toBe('ogg bytes');
  });

  test('a passing failure is asked again next pass; a permanent one never again', async () => {
    const target = lane();
    append(target, waitingLine('X1'));
    await target.pull();
    const passing = bridge({ answer: { status: 'failed', permanent: false, reason: 'network' } });
    await pass(target, passing.call);
    await pass(target, passing.call);
    expect(passing.asked.length).toBe(2);
    const permanent = bridge({ answer: { status: 'failed', permanent: true, reason: 'gone' } });
    await pass(target, permanent.call);
    await pass(target, permanent.call);
    expect(permanent.asked.length).toBe(1);
    expect(folderFiles(target)).toEqual([]);
    expect(childLocator(target, 'X1')).toBe('');
  });

  test('below the floor nothing is asked, and the pass says media waits', async () => {
    const target = lane();
    append(target, waitingLine('D1'));
    await target.pull();
    const { asked, call } = bridge();
    expect((await pass(target, call, { room: false })).waitingForDisk).toBe(true);
    expect(asked).toEqual([]);
    expect((await pass(target, call)).waitingForDisk).toBe(false);
  });

  test('a bridge that is not running is asked once a pass, and the media keeps waiting', async () => {
    const target = lane();
    append(target, waitingLine('B1'));
    append(target, waitingLine('B2'));
    await target.pull();
    const down = bridge({ answer: { status: 'unavailable' } });
    await pass(target, down.call);
    expect(down.asked.length).toBe(1);
    expect((await pass(target)).filled).toBe(2);
  });

  test('a file in Olympus\'s folder that no row names is deleted, and a part a dead pass left', async () => {
    const target = lane();
    mkdirSync(target.fetched, { recursive: true });
    const strays = [join(target.fetched, 'stray-0123456789abcdef~0123456789abcdef.jpg'), join(target.fetched, 'x.jpg.part')];
    for (const stray of strays) writeFileSync(stray, 'left');
    await pass(target);
    expect(folderFiles(target)).toEqual([]);
  });

  test('a fetched picture later judged Secret is deleted by the clearing, though no line names it', async () => {
    const target = lane();
    append(target, waitingLine('C1', { text: 'the harbour' }));
    await target.pull();
    await pass(target);
    const path = fetchedPath(target, 'C1');
    expect(existsSync(path)).toBe(true);
    redactWhatsAppLiveSpoolSecrets({
      spoolDir: target.spoolDir,
      account: 'personal',
      judge: (identity) => (identity.providerItemId === 'C1#child:media' ? 'content' : undefined),
      mediaDirs: [target.images, target.video, target.audio, target.fetched],
    });
    expect(existsSync(path)).toBe(false);
  });

  test('a message whose id holds a dot is fetched and kept', async () => {
    const target = lane();
    append(target, waitingLine('3EB0.42'));
    await target.pull();
    expect((await pass(target)).filled).toBe(1);
    await pass(target);
    expect(existsSync(fetchedPath(target, '3EB0.42'))).toBe(true);
  });

  describe('review round 10: a fill is fenced, and a Secret takes back what it made searchable', () => {
    const childIdentity = (id: string) => ({ provider: 'whatsapp', accountScope: 'personal', providerItemId: `${id}#child:media`, providerConversationId: CHAT });
    const childLocal = (id: string) => `personal:${CHAT}:${id}#child:media`;
    // What extraction lands for a filled picture: its text, judged and indexed as any child's.
    const extract = async (target: ReturnType<typeof lane>, id: string, text: string) => {
      const sink = createTieredStoreExtractionSink({ set: target.set, syncConnectorId: 'extraction', ownerConnectorId: 'whatsapp-live', ownershipKind: 'observed' });
      return sink.accept({
        ref: {
          corpusId: WHATSAPP_LIVE_CORPUS_ID, provider: 'whatsapp', accountScope: 'personal', approvedScopeKey: 'whatsapp.personal.messages',
          providerItemId: `${id}#child:media`, localItemId: childLocal(id), sourceVersion: '2026-07-01T13:00:00Z',
        },
        text, extractorKind: 'local_text', extractorVersion: 'test', fetchedAt: '2026-07-01T14:00:00.000Z',
      });
    };
    const searchable = (target: ReturnType<typeof lane>, marker: string) => target.set.openStores().flatMap((store) => [
      ...store.searchItems(marker, 10).map((row) => row.sourceItem.providerItemId),
      ...((store.localContent(childLocal('A1'))?.chunks ?? []).filter((chunk) => chunk.includes(marker)).map(() => 'chunk')),
    ]);

    test('a Secret landing for one picture while another downloads: the first is never published, the second is', async () => {
      const target = lane();
      append(target, waitingLine('A1', { text: 'see you at eight' }));
      append(target, waitingLine('B1', { text: 'the harbour' }));
      await target.pull();
      let calls = 0;
      const call = async (request: WhatsAppMediaRequest, part: string): Promise<WhatsAppMediaAnswer> => {
        calls += 1;
        // A's bytes came and were checked; while B's come, A's message is judged Secret.
        if (request.id === 'B1') judgeSecret(target, 'A1');
        writeFileSync(part, 'jpeg bytes');
        return { status: 'ok', size: 10 };
      };
      // Every fill synced, by the message it fills: A's must never reach the stores.
      const synced: string[] = [];
      const counting = new Proxy(target.set, {
        get: (set, key) => (key === 'sync'
          ? async (connector: Parameters<typeof set.sync>[0], options: Parameters<typeof set.sync>[1]) => {
            for await (const page of connector.listItems()) synced.push(...page.items.map((item) => item.identity.providerItemId));
            return set.sync(connector, options);
          }
          : Reflect.get(set, key, set)),
      });
      await pass(target, call, { set: counting });
      expect(calls).toBe(2);
      expect(synced).toEqual(['B1#child:media']);
      expect(childLocator(target, 'A1')).toBe('');
      expect(existsSync(fetchedPath(target, 'A1'))).toBe(false);
      expect(childLocator(target, 'B1')).toBe(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${fetchedPath(target, 'B1')}`);
    });

    test('a decision this process makes while a fill commits is seen before the hold ends, and the fill taken back at once', async () => {
      const target = lane();
      append(target, waitingLine('A1', { text: 'see you at eight' }));
      await target.pull();
      const racing = new Proxy(target.set, {
        get: (set, key) => (key === 'sync'
          ? async (...args: Parameters<typeof set.sync>) => {
            const run = await set.sync(...args);
            judgeSecret(target, 'A1');
            return run;
          }
          : Reflect.get(set, key, set)),
      });
      expect((await pass(target, bridge().call, { set: racing })).filled).toBe(0);
      expect(target.ledger.getCurrent(childIdentity('A1'))?.contentTier).toBe('secrets');
      expect(childLocator(target, 'A1')).toBe('');
      expect(existsSync(fetchedPath(target, 'A1'))).toBe(false);
    });

    test('while a fill commits, another process cannot write a decision: it waits for the hold', async () => {
      const target = lane();
      append(target, waitingLine('A1', { text: 'see you at eight' }));
      await target.pull();
      let blocked = false;
      const watched = new Proxy(target.set, {
        get: (set, key) => (key === 'sync'
          ? async (...args: Parameters<typeof set.sync>) => {
            const other = new Database(tieredStoreSetLedgerPath(join(target.root, 'whatsapp.db')));
            try {
              other.exec('PRAGMA busy_timeout = 50');
              other.exec('BEGIN IMMEDIATE');
              other.exec('ROLLBACK');
            } catch {
              blocked = true;
            } finally {
              other.close();
            }
            return set.sync(...args);
          }
          : Reflect.get(set, key, set)),
      });
      expect((await pass(target, bridge().call, { set: watched })).filled).toBe(1);
      expect(blocked).toBe(true);
    });

    test('a Secret decision after a fill leaves no searchable chunk: the child goes through the one Secrets path', async () => {
      const target = lane();
      append(target, waitingLine('A1', { text: 'see you at eight' }));
      await target.pull();
      expect((await pass(target)).filled).toBe(1);
      expect((await extract(target, 'A1', 'Lighthousemarker on the quay')).accepted).toBe(true);
      expect(searchable(target, 'Lighthousemarker').length).toBeGreaterThan(0);
      judgeSecret(target, 'A1');
      await pass(target);
      expect(searchable(target, 'Lighthousemarker')).toEqual([]);
      expect(target.ledger.getCurrent(childIdentity('A1'))?.contentTier).toBe('secrets');
      expect(existsSync(fetchedPath(target, 'A1'))).toBe(false);
    });

    test('review round 11: a take-back cut off before its tombstone is taken up again; nothing stays searchable', async () => {
      const target = lane();
      append(target, waitingLine('A1', { text: 'see you at eight' }));
      await target.pull();
      // The fill lands and is extracted, and its message turns Secret before the fill is done; the first tombstone
      // write of the take-back then fails.
      let failures = 1;
      const failingStore = (store: ReturnType<typeof target.set.openStores>[number]) => new Proxy(store, {
        get: (inner, key) => (key === 'tombstoneCopy' && failures > 0
          ? () => {
            failures -= 1;
            throw new Error('disk I/O error');
          }
          : Reflect.get(inner, key, inner)),
      });
      const racing = new Proxy(target.set, {
        get: (set, key) => {
          if (key === 'sync') {
            return async (...args: Parameters<typeof set.sync>) => {
              const run = await set.sync(...args);
              await extract(target, 'A1', 'Lighthousemarker on the quay');
              judgeSecret(target, 'A1');
              return run;
            };
          }
          if (key === 'openStores') return () => set.openStores().map(failingStore);
          if (key === 'store') return (...args: Parameters<typeof set.store>) => {
            const store = set.store(...args);
            return store ? failingStore(store) : store;
          };
          return Reflect.get(set, key, set);
        },
      });
      await expect(pass(target, bridge().call, { set: racing })).rejects.toThrow('disk I/O error');
      // Nothing was deleted ahead of the settlement: the file is still there, and the take-back is owed.
      expect(existsSync(fetchedPath(target, 'A1'))).toBe(true);
      expect(searchable(target, 'Lighthousemarker').length).toBeGreaterThan(0);
      const { asked, call } = bridge();
      await pass(target, call);
      expect(searchable(target, 'Lighthousemarker')).toEqual([]);
      expect(target.ledger.getCurrent(childIdentity('A1'))?.contentTier).toBe('secrets');
      expect(existsSync(fetchedPath(target, 'A1'))).toBe(false);
      expect(asked).toEqual([]);
      const state = WhatsAppMediaFetchState.open(target.spoolDir);
      try {
        expect(state.all()).toEqual([]);
      } finally {
        state.close();
      }
    });

    test('review round 11: the hold covers one record\'s publication only, never a wait for the embedding lease', async () => {
      const target = lane();
      append(target, waitingLine('E1', { text: 'the harbour' }));
      await target.pull();
      // Another embedder holds the store's embedding lease for the whole pass.
      let release!: () => void;
      const released = new Promise<void>((resolve) => { release = resolve; });
      let leased!: () => void;
      const holding = new Promise<void>((resolve) => { leased = resolve; });
      const lease = withFileLease(`${join(target.root, 'whatsapp.db')}.embedding`, async () => {
        leased();
        await released;
      });
      await holding;
      try {
        const started = Date.now();
        expect((await pass(target)).filled).toBe(1);
        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        release();
        await lease;
      }
    }, 30_000);

    test('review round 11: inside the hold, only the fill is synced: no embedding, no other settlement, sweeps before', async () => {
      const target = lane();
      append(target, waitingLine('E2', { text: 'the harbour' }));
      await target.pull();
      const order: string[] = [];
      const logged = new Proxy(target.set, {
        get: (set, key) => {
          if (key === 'finishWritesCutOff' || key === 'sweepOrphanedChildren') {
            return async () => {
              order.push(String(key));
              return (set[key] as () => Promise<unknown>).call(set);
            };
          }
          if (key === 'sync') {
            return async (...args: Parameters<typeof set.sync>) => {
              order.push(`sync ${JSON.stringify(args[2] ?? {})}`);
              return set.sync(...args);
            };
          }
          if (key === 'ledger') {
            return new Proxy(set.ledger, {
              get: (ledger, member) => (member === 'holdingWrites'
                ? async <T>(work: () => Promise<T>) => {
                  order.push('hold');
                  try {
                    return await ledger.holdingWrites(work);
                  } finally {
                    order.push('released');
                  }
                }
                : Reflect.get(ledger, member, ledger)),
            });
          }
          return Reflect.get(set, key, set);
        },
      });
      expect((await pass(target, bridge().call, { set: logged })).filled).toBe(1);
      expect(order).toEqual(['finishWritesCutOff', 'sweepOrphanedChildren', 'hold', 'sync {"embed":false,"settle":false}', 'released']);
    });

    // A member of the set, its methods bound to the set itself (so they read the set's own state, not a proxy's).
    const bound = (set: ReturnType<typeof lane>['set'], key: string | symbol) => {
      const value = Reflect.get(set, key, set) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(set) : value;
    };
    // A take-back owed from a pass that died right after it marked the row.
    const owe = (target: ReturnType<typeof lane>, id: string) => {
      const state = WhatsAppMediaFetchState.open(target.spoolDir);
      try {
        const row = state.all().find((each) => each.id === id)!;
        state.markRevoking(row.key);
      } finally {
        state.close();
      }
    };
    const rowsOf = (target: ReturnType<typeof lane>) => {
      const state = WhatsAppMediaFetchState.open(target.spoolDir);
      try {
        return state.all().map((row) => ({ id: row.id, revoking: row.revoking }));
      } finally {
        state.close();
      }
    };

    test('review round 12: an owed take-back whose Secret was cleared before it ran settles nothing and deletes nothing', async () => {
      const target = lane();
      append(target, waitingLine('A1', { text: 'see you at eight' }));
      await target.pull();
      await pass(target);
      await extract(target, 'A1', 'Lighthousemarker on the quay');
      // The pass that marked it died; the message's Secret was then restored to what it was.
      owe(target, 'A1');
      await pass(target);
      expect(searchable(target, 'Lighthousemarker').length).toBeGreaterThan(0);
      expect(target.ledger.getCurrent(childIdentity('A1'))?.contentTier).not.toBe('secrets');
      expect(existsSync(fetchedPath(target, 'A1'))).toBe(true);
      expect(rowsOf(target)).toEqual([{ id: 'A1', revoking: false }]);
    });

    test('review round 12: an owed take-back never touches a newer version stored meanwhile; only its own file goes', async () => {
      const target = lane();
      append(target, waitingLine('A1', { text: 'see you at eight' }));
      await target.pull();
      await pass(target);
      judgeSecret(target, 'A1');
      owe(target, 'A1');
      // A newer version, its picture saved by the bridge itself, is stored before the take-back runs again.
      const photo = join(target.images, 'A1-new.jpg');
      writeFileSync(photo, 'a newer picture');
      append(target, spoolLine({ id: 'A1', media_type: 'image', media_mime: 'image/jpeg', media_path: photo, download_status: 'ok', text: 'see you at nine', timestamp: '2026-07-01T14:00:00Z' }));
      await target.pull();
      expect(childLocator(target, 'A1')).toBe(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${photo}`);
      // The message is (still) Secret when the take-back runs again.
      judgeSecret(target, 'A1');
      await pass(target);
      expect(childLocator(target, 'A1')).toBe(`${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${photo}`);
      expect(target.ledger.getCurrent(childIdentity('A1'))?.contentTier).not.toBe('secrets');
      expect(existsSync(photo)).toBe(true);
      expect(existsSync(fetchedPath(target, 'A1'))).toBe(false);
      expect(rowsOf(target)).toEqual([]);
    });

    for (const [label, withLocations] of [['an older row resumes from the location it recorded first', true], ['without a location index, the decision goes first', false]] as const) {
      test(`review round 12: a settlement cut off at its last write is finished by the next pass (${label})`, async () => {
        const target = lane({ secretLocations: withLocations });
        append(target, waitingLine('A1', { text: 'see you at eight' }));
        await target.pull();
        await pass(target);
        await extract(target, 'A1', 'Lighthousemarker on the quay');
        judgeSecret(target, 'A1');
        // The settlement's last write, its decision, fails once.
        let failures = 1;
        const failing = new Proxy(target.set, {
          get: (set, key) => (key === 'ledger'
            ? new Proxy(set.ledger, {
              get: (ledger, member) => (member === 'recordDecision' && failures > 0
                ? () => {
                  failures -= 1;
                  throw new Error('disk I/O error');
                }
                : Reflect.get(ledger, member, ledger)),
            })
            : bound(set, key)),
        });
        await expect(pass(target, bridge().call, { set: failing })).rejects.toThrow('disk I/O error');
        expect(target.ledger.getCurrent(childIdentity('A1'))?.contentTier).not.toBe('secrets');
        expect(existsSync(fetchedPath(target, 'A1'))).toBe(true);
        if (withLocations) {
          // Stranded as the review found it: every copy already tombstoned, the decision never written.
          expect(target.set.secrets()?.get(childIdentity('A1'))).toBeDefined();
          expect(target.set.storedItem(childIdentity('A1'), () => 0)?.tombstoned).toBe(true);
        }
        await pass(target);
        expect(target.ledger.getCurrent(childIdentity('A1'))?.contentTier).toBe('secrets');
        expect(searchable(target, 'Lighthousemarker')).toEqual([]);
        expect(existsSync(fetchedPath(target, 'A1'))).toBe(false);
        expect(rowsOf(target)).toEqual([]);
      });
    }

    test('a picture whose own names are still being judged waits', async () => {
      const target = lane();
      append(target, waitingLine('M1'));
      await target.pull();
      const pendingNames = new Proxy(target.set, {
        get: (set, key) => (key === 'ledger'
          ? new Proxy(set.ledger, {
            get: (ledger, member) => (member === 'getCurrent'
              ? (identity: { providerItemId: string }) => {
                const record = ledger.getCurrent(identity as never);
                return identity.providerItemId === 'M1#child:media' && record ? { ...record, metadataPending: true } : record;
              }
              : Reflect.get(ledger, member, ledger)),
          })
          : Reflect.get(set, key, set)),
      });
      const { asked, call } = bridge();
      await pass(target, call, { set: pendingNames });
      expect(asked).toEqual([]);
    });

    test('a spool recovered with the waiting line elsewhere: the line read again gives its new place, and the fill finds it', async () => {
      const target = lane();
      append(target, waitingLine('O1', { text: 'the harbour' }));
      await target.pull();
      await pass(target, bridge({ answer: { status: 'failed', permanent: false, reason: 'network' } }).call);
      // The spool comes back with another line before it: every offset moved.
      const day = join(target.spoolDir, DAY);
      writeFileSync(day, spoolLine({ id: 'O0', text: 'a line before it' }) + readFileSync(day, 'utf8'));
      expect((await pass(target)).filled).toBe(1);
    });
  });

  describe('the bridge\'s call, over its socket', () => {
    const servers: Server[] = [];
    afterEach(() => {
      for (const server of servers.splice(0)) server.close();
    });
    // A stand-in for the bridge's socket (media_serve.go): one request line, one answer.
    const serve = async (respond: (request: WhatsAppMediaRequest) => Buffer) => {
      const stateDir = mkdtempSync(join(tmpdir(), 'wa-call-'));
      roots.push(stateDir);
      const socket = join(stateDir, 'media.sock');
      const server = createServer((conn) => {
        let buffered = '';
        conn.on('data', (data) => {
          buffered += data.toString('utf8');
          const newline = buffered.indexOf('\n');
          if (newline === -1) return;
          conn.end(respond(JSON.parse(buffered.slice(0, newline)) as WhatsAppMediaRequest));
        });
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(socket, resolve));
      writeFileSync(join(stateDir, 'media-download.json'), JSON.stringify({ socket }));
      return { stateDir, part: join(stateDir, 'out.part') };
    };
    const request: WhatsAppMediaRequest = { chat_jid: CHAT, id: 'K1', version: 'v', media_type: 'image', media_direct_path: '/mms/image/K1' };

    test('the bytes after an ok answer are written to the part, whole; the newlines a running download sends before it are skipped', async () => {
      const bytes = Buffer.alloc(200_000, 7);
      const { stateDir, part } = await serve(() => Buffer.concat([Buffer.from(`\n\n${JSON.stringify({ status: 'ok', size: bytes.length })}\n`), bytes]));
      expect(await bridgeMediaCall(stateDir)(request, part, () => true)).toEqual({ status: 'ok', size: bytes.length });
      expect(readFileSync(part).equals(bytes)).toBe(true);
    });

    test('a failure is told as passing or permanent; a cut-off answer is a passing failure', async () => {
      const permanent = await serve(() => Buffer.from(`${JSON.stringify({ status: 'failed', permanent: true, reason: 'gone' })}\n`));
      expect(await bridgeMediaCall(permanent.stateDir)(request, permanent.part, () => true)).toEqual({ status: 'failed', permanent: true, reason: 'gone' });
      const short = await serve(() => Buffer.from(`${JSON.stringify({ status: 'ok', size: 10 })}\nabc`));
      expect(await bridgeMediaCall(short.stateDir)(request, short.part, () => true)).toEqual({ status: 'failed', permanent: false, reason: 'cut_off' });
    });

    test('media that does not fit above the floor is never written', async () => {
      const { stateDir, part } = await serve(() => Buffer.concat([Buffer.from(`${JSON.stringify({ status: 'ok', size: 3 })}\n`), Buffer.from('abc')]));
      expect(await bridgeMediaCall(stateDir)(request, part, () => false)).toEqual({ status: 'failed', permanent: false, reason: 'waiting_for_disk' });
      expect(existsSync(part)).toBe(false);
    });

    test('a bridge that is not running is unavailable', async () => {
      const stateDir = mkdtempSync(join(tmpdir(), 'wa-call-'));
      roots.push(stateDir);
      expect(await bridgeMediaCall(stateDir)(request, join(stateDir, 'out.part'), () => true)).toEqual({ status: 'unavailable' });
      writeFileSync(join(stateDir, 'media-download.json'), JSON.stringify({ socket: join(stateDir, 'gone.sock') }));
      expect(await bridgeMediaCall(stateDir)(request, join(stateDir, 'out.part'), () => true)).toEqual({ status: 'unavailable' });
    });
  });
});
