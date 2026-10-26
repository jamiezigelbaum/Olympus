// Live WhatsApp pictures and videos as children of their message
// (docs/design/archive-live-one-dataset.md, step 8): the bridge saves them,
// the connector lists each as its message's child with a locator, the
// extraction source reads it through the account's one child reader, and
// Secrets clearing deletes the saved file. Voice notes keep their one row.
// Every name and text here is made up.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { connectorStoreExtractionCandidateReader } from '../src/workers/connector-store/extraction-candidate-reader.ts';
import { deferredBytesAnswerFor } from '../src/workers/file-extraction/connector-source.ts';
import { WHATSAPP_LANE_SYNC, whatsAppConnectorWithInputs } from '../src/workers/whatsapp/archive-target.ts';
import { WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX, createWhatsAppChildReader } from '../src/workers/whatsapp/child-media.ts';
import { WhatsAppExtractionSource } from '../src/workers/whatsapp/extraction-source.ts';
import { createWhatsAppLiveSourceConnector, redactWhatsAppLiveSpoolSecrets, whatsAppBootNonce, whatsAppMediaFileStem } from '../src/workers/whatsapp/live-connector.ts';
import { whatsAppExtractionSourceFactory } from '../src/workers/whatsapp/extraction-factory.ts';
import type { RawItem } from '../src/core/contracts.ts';
import { WHATSAPP_LIVE_CORPUS_ID, createWhatsAppTierLane, defaultWhatsAppMediaRoots } from '../src/workers/whatsapp/store-sync.ts';

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
  return { root, spoolDir, images, video, audio, store, readChild, pull, extraction };
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
