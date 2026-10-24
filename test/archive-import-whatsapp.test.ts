// WhatsApp chat exports as an archive import: detection among the shapes an
// export arrives in, the connector over plain text files and zips (streamed,
// resumable at any page and bounded at every byte it reads, exact about what it
// left out), identities that make overlapping exports of one chat one set of
// messages, and the import's life on the shared spine: held Private until
// judged, counted once across a crash, removed without touching live WhatsApp
// capture. Synthetic chats only.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import {
  ARCHIVE_COMMON_FINDINGS,
  ARCHIVE_FORMATS,
  ARCHIVE_LOOK_INCOMPLETE_ADVICE,
  ARCHIVE_PROBE_MAX_CHILDREN,
  ARCHIVE_PROBE_MAX_NAMED,
  ArchiveImportStoppedError,
  WHATSAPP_ARCHIVE_FORMAT,
  archiveFormatForProvider,
  archiveFamilyProvider,
  detectArchiveFormat,
  getArchiveFormat,
  type ArchiveConnectorFactory,
  type ArchiveImportFinding,
} from '../src/core/archive-formats.ts';
import { REMOTE_SOURCE_LABELS } from '../src/core/remote-result.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { archiveContinuations } from '../src/workers/archive-import/continuation-cache.ts';
import { archiveFileEntries, archiveManifestSha256, buildArchiveManifest, probeArchivePath } from '../src/workers/archive-import/manifest.ts';
import { requestArchiveRemoval, runArchiveRemoval } from '../src/workers/archive-import/removal.ts';
import { createArchiveImportRuntime, type ArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import { archiveConnectorStoreDbPath, archiveConnectorStoreDbPaths } from '../src/workers/archive-import/store.ts';
import { pullArchiveImport, type ArchiveImportPullOptions } from '../src/workers/archive-import/sync.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { secretLocationsPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import {
  WHATSAPP_FINDINGS,
  createWhatsAppArchiveConnector,
} from '../src/workers/archive-import/whatsapp/connector.ts';
import { WHATSAPP_MAX_ITEM_TEXT_CHARS } from '../src/workers/archive-import/whatsapp/messages.ts';
import { ZIP_INFLATE_PUSH_BYTES, ZipMemberReader } from '../src/workers/archive-import/zip-reader.ts';
import { referenceCrc32 } from './helpers/zip-fixture.ts';
import {
  chatText,
  chatZip,
  mediaNames,
  messageLine,
  notice,
  syntheticChat,
  type SyntheticMessage,
} from './support/archive-fixtures-whatsapp.ts';
import { buildZip } from './helpers/zip-fixture.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function workDir(prefix = 'archive-whatsapp-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function put(dir: string, name: string, content: string | Uint8Array): string {
  const path = join(dir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function localIso(at: string): string {
  const [date, time] = at.split('T') as [string, string];
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi, s] = time.split(':').map(Number) as [number, number, number];
  return new Date(y, mo - 1, d, h, mi, s).toISOString();
}

// --- Detection ----------------------------------------------------------------

/** `listedByName`: the folder is listed in name order (code units), as some systems list it, so where a name falls in the listing does not depend on the machine the test runs on. */
function detect(dir: string, chosen = '', options: { listedByName?: boolean } = {}) {
  const root = ScopeRoot.open(dir);
  const listed = options.listedByName
    ? Object.assign(Object.create(root) as ScopeRoot, { list: (relDir: string) => root.list(relDir).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) })
    : root;
  try {
    const probe = probeArchivePath(listed, chosen);
    return detectArchiveFormat(probe);
  } finally {
    root.close();
  }
}

describe('whatsapp export detection', () => {
  const chat = chatText(syntheticChat(4), { style: 'ios-24-dmy' });
  const androidChat = chatText(syntheticChat(4), { style: 'android-12-mdy' });

  test('the format is registered once, in the chat family, with its own provider and an existing citation label', () => {
    expect(getArchiveFormat('whatsapp_chat')).toBe(WHATSAPP_ARCHIVE_FORMAT);
    expect(WHATSAPP_ARCHIVE_FORMAT).toMatchObject({ family: 'chat', provider: 'whatsapp_export', label: 'WhatsApp chat export' });
    expect(REMOTE_SOURCE_LABELS).toContain(WHATSAPP_ARCHIVE_FORMAT.citationLabel!);
    expect(archiveFormatForProvider('whatsapp_export')).toBe(WHATSAPP_ARCHIVE_FORMAT);
    // Live capture's provider is not an archive's.
    expect(archiveFormatForProvider('whatsapp')).toBeUndefined();
    expect(ARCHIVE_FORMATS.filter((format) => format.family === 'chat').map((format) => format.provider)).toContain('whatsapp_export');
    expect(['whatsapp_export', 'archive']).toContain(archiveFamilyProvider('chat'));
  });

  test('a chosen text file: iOS _chat.txt, an Android file named for the chat, a renamed copy', () => {
    for (const [name, text] of [['_chat.txt', chat], ['WhatsApp Chat with Sam Example.txt', androidChat], ['harbour talk.txt', chat]] as const) {
      const dir = workDir();
      put(dir, name, text);
      const found = detect(dir, name);
      expect(found).toMatchObject({ kind: 'match', files: [''] });
      if (found.kind === 'match') expect(found.format.id).toBe('whatsapp_chat');
    }
  });

  test('a chosen zip with the chat inside and its media beside it, whichever phone made it', () => {
    for (const textName of ['_chat.txt', 'WhatsApp Chat with Sam Example.txt', 'Export/_chat.txt']) {
      const dir = workDir();
      put(dir, 'WhatsApp Chat with Sam Example.zip', chatZip(chat, { textName, media: mediaNames(5), macNoise: true }));
      expect(detect(dir, 'WhatsApp Chat with Sam Example.zip')).toMatchObject({ kind: 'match', files: [''] });
    }
  });

  test('not a chat: a zip of pictures, prose, JSON, an empty text file', () => {
    const dir = workDir();
    put(dir, 'pictures.zip', buildZip([{ name: 'a.jpg', data: 'x' }, { name: 'b.jpg', data: 'y' }]));
    put(dir, 'diary.txt', 'Dear diary, today was a long synthetic day.\nNothing happened.\n');
    put(dir, 'export.json', '{"name":"Synthetic","chats":{"list":[]}}');
    put(dir, 'empty.txt', '');
    for (const name of ['pictures.zip', 'diary.txt', 'export.json', 'empty.txt']) {
      expect(detect(dir, name)).toMatchObject({ kind: 'none' });
    }
  });

  test('a file the person chose is taken on its first line alone: any name, a zip holding any text file that starts like a chat', () => {
    const dir = workDir();
    put(dir, 'notes.zip', buildZip([{ name: 'notes.txt', data: chat }]));
    put(dir, 'build.txt', chat);
    for (const name of ['notes.zip', 'build.txt']) {
      expect(detect(dir, name)).toMatchObject({ kind: 'match', files: [''] });
    }
  });

  test('found in a folder, a file needs more than a first line shaped like a header: a build log is not a chat', () => {
    const dir = workDir();
    const buildLog = '2026-10-24, 10:00 - build: succeeded\n2026-10-24, 10:01 - tests: passed\n';
    put(dir, '_chat.txt', chat);
    put(dir, 'build.txt', buildLog);
    put(dir, 'whatsapp-notes.txt', chat);
    put(dir, 'whatsapp-debug.zip', buildZip([{ name: 'whatsapp-debug.txt', data: buildLog }]));
    const root = ScopeRoot.open(dir);
    try {
      const probe = probeArchivePath(root, '');
      const found = detectArchiveFormat(probe);
      expect(found).toMatchObject({ kind: 'match' });
      if (found.kind === 'match') expect([...found.files]).toEqual(['_chat.txt']);
      // The three that look like exports and are not named as one are told, not silently left out.
      expect(WHATSAPP_ARCHIVE_FORMAT.unconfirmed!(probe)).toBe(3);
    } finally {
      root.close();
    }
    // With nothing else in the folder, there is no export in it.
    const lonely = workDir();
    put(lonely, 'build.txt', buildLog);
    put(lonely, 'whatsapp-debug.zip', buildZip([{ name: 'whatsapp-debug.txt', data: buildLog }]));
    expect(detect(lonely)).toMatchObject({ kind: 'none' });
  });

  test('a zip found in a folder is an export by the chat file inside it, whatever the zip is called', () => {
    const dir = workDir();
    put(dir, 'Harbour talk.zip', chatZip(chat, { media: mediaNames(2) }));
    put(dir, 'plain.zip', buildZip([{ name: 'a.jpg', data: 'x' }]));
    const found = detect(dir);
    expect(found).toMatchObject({ kind: 'match' });
    if (found.kind === 'match') expect([...found.files]).toEqual(['Harbour talk.zip']);
  });

  test('a folder of 130 chat zips lists every one of them, not the first 128', () => {
    const dir = workDir();
    const small = chatText(syntheticChat(2), { style: 'android-24-dmy' });
    for (let index = 0; index < 130; index += 1) {
      put(dir, `WhatsApp Chat with Friend ${String(index).padStart(3, '0')}.zip`, chatZip(small, { textName: `WhatsApp Chat with Friend ${index}.txt` }));
    }
    const found = detect(dir);
    expect(found).toMatchObject({ kind: 'match' });
    if (found.kind === 'match') {
      expect(found.files).toHaveLength(130);
      expect(found.files).toContain('WhatsApp Chat with Friend 129.zip');
    }
  });

  test('exports named in no particular way are found too, however far down a long listing they are', () => {
    const dir = workDir();
    for (let index = 0; index < ARCHIVE_PROBE_MAX_CHILDREN + 300; index += 1) put(dir, `IMG-${String(index).padStart(5, '0')}.jpg`, 'x');
    for (let index = 0; index < 6; index += 1) {
      put(dir, `export ${index}.zip`, chatZip(chatText(syntheticChat(2, { label: `n${index}` }), { style: 'android-24-dmy' }), { textName: `WhatsApp Chat with Friend ${index}.txt` }));
      put(dir, `WhatsApp Chat with Pal ${index}.txt`, chatText(syntheticChat(2, { label: `p${index}` }), { style: 'android-24-dmy' }));
    }
    const found = detect(dir);
    expect(found).toMatchObject({ kind: 'match' });
    if (found.kind === 'match') {
      expect(found.files).toHaveLength(12);
      for (let index = 0; index < 6; index += 1) {
        expect(found.files).toContain(`export ${index}.zip`);
        expect(found.files).toContain(`WhatsApp Chat with Pal ${index}.txt`);
      }
    }
  });

  test('a folder of exports lists each chat in it, text files and zips together, and not the rest', () => {
    const dir = workDir();
    put(dir, '_chat.txt', chat);
    put(dir, 'WhatsApp Chat with Alex Example.txt', androidChat);
    put(dir, 'WhatsApp Chat with Harbour crew.zip', chatZip(chat, { media: mediaNames(3) }));
    put(dir, 'notes.txt', 'shopping list\nmilk\n');
    put(dir, 'photo.jpg', 'not a chat');
    put(dir, 'other.zip', buildZip([{ name: 'a.jpg', data: 'x' }]));
    const found = detect(dir);
    expect(found).toMatchObject({ kind: 'match' });
    if (found.kind === 'match') {
      expect(found.format.id).toBe('whatsapp_chat');
      expect([...found.files]).toEqual(['WhatsApp Chat with Alex Example.txt', 'WhatsApp Chat with Harbour crew.zip', '_chat.txt']);
    }
  });

  test('a folder full of media still finds the chat file and the chat zips named for WhatsApp', () => {
    const dir = workDir();
    for (const name of mediaNames(1500, 'android')) put(dir, name, 'x');
    put(dir, '_chat.txt', chat);
    for (let index = 0; index < 6; index += 1) {
      put(dir, `WhatsApp Chat with Friend ${index}.zip`, chatZip(chatText(syntheticChat(3, { label: `friend ${index}` }), { style: 'android-24-dmy' }), { textName: `WhatsApp Chat with Friend ${index}.txt`, media: mediaNames(2) }));
    }
    const found = detect(dir);
    expect(found).toMatchObject({ kind: 'match' });
    if (found.kind === 'match') {
      expect(found.files).toHaveLength(7);
      expect(found.files).toContain('_chat.txt');
      expect(found.files).toContain('WhatsApp Chat with Friend 5.zip');
    }
  });

  test('a zip with thousands of members finds the chat member by its name, wherever it is in the directory', () => {
    const dir = workDir();
    const media = Array.from({ length: 1800 }, (_, index) => ({ name: `media/IMG-${String(index).padStart(5, '0')}.jpg`, data: 'x' }));
    put(dir, 'WhatsApp Chat with Big.zip', buildZip([...media, { name: '_chat.txt', data: chat, method: 'deflate' as const }]));
    expect(detect(dir, 'WhatsApp Chat with Big.zip')).toMatchObject({ kind: 'match', files: [''] });
  });

  test('ordinary text files ahead of the chat in a zip do not hide it: the names that say what an export is are read first', () => {
    const dir = workDir();
    const notes = Array.from({ length: 40 }, (_, index) => ({ name: `attachments/note-${String(index).padStart(2, '0')}.txt`, data: `shopping list ${index}\nmilk\n` }));
    put(dir, 'Notes from the trip.zip', buildZip([...notes, { name: '_chat.txt', data: chat, method: 'deflate' as const }]));
    expect(detect(dir, 'Notes from the trip.zip')).toMatchObject({ kind: 'match', files: [''] });
    // The same zip found in a folder.
    expect(detect(dir)).toMatchObject({ kind: 'match', files: ['Notes from the trip.zip'] });
    // And with more ordinary text files ahead of the chat than the probe lists past its usual bound.
    const many = workDir();
    const memos = Array.from({ length: ARCHIVE_PROBE_MAX_CHILDREN + ARCHIVE_PROBE_MAX_NAMED + 20 }, (_, index) => ({ name: `memos/memo-${String(index).padStart(5, '0')}.txt`, data: 'x\n' }));
    put(many, 'Memos.zip', buildZip([...memos, { name: 'WhatsApp Chat with Pal.txt', data: chat, method: 'deflate' as const }]));
    expect(detect(many, 'Memos.zip')).toMatchObject({ kind: 'match', files: [''] });
  });

  test('a folder with more ordinary text files than the probe lists still finds the exports named for WhatsApp', () => {
    const dir = workDir();
    for (let index = 0; index < ARCHIVE_PROBE_MAX_CHILDREN + ARCHIVE_PROBE_MAX_NAMED + 20; index += 1) put(dir, `Aaa-memo-${String(index).padStart(5, '0')}.txt`, 'x\n');
    put(dir, '_chat.txt', chat);
    put(dir, 'WhatsApp Chat with Pal.txt', androidChat);
    // Listed by name, the two exports come last: past the probe's usual bound and past the room for more ordinary names.
    const found = detect(dir, '', { listedByName: true });
    expect(found).toMatchObject({ kind: 'match' });
    if (found.kind === 'match') expect([...found.files]).toEqual(['WhatsApp Chat with Pal.txt', '_chat.txt']);
  });

  test('mail is still mail, and a text file that starts with From is not a chat', () => {
    const dir = workDir();
    put(dir, 'Inbox.mbox', 'From sender@example.invalid Mon Jan  5 10:00:00 2015\nSubject: x\n\nbody\n');
    const found = detect(dir, 'Inbox.mbox');
    expect(found).toMatchObject({ kind: 'match' });
    if (found.kind === 'match') expect(found.format.id).toBe('mbox');
  });
});

// --- The connector -------------------------------------------------------------

interface Built {
  connector: SourceConnector;
  findings: ArchiveImportFinding[];
  files: ReturnType<typeof buildArchiveManifest>;
  root: ScopeRoot;
}

function connectorFor(
  dir: string,
  names: readonly string[],
  options: { pageSize?: number; shouldContinue?: () => boolean; manifestSha256?: string; maxBytesPerListing?: number; archiveId?: string; findings?: ArchiveImportFinding[] } = {},
): Built {
  const root = ScopeRoot.open(dir);
  cleanups.push(() => root.close());
  const files = buildArchiveManifest(root, names);
  const findings = options.findings ?? [];
  const archiveId = options.archiveId ?? 'synthetic-archive';
  const connector = createWhatsAppArchiveConnector({
    archiveId,
    connectorId: `archive.${archiveId}`,
    accountScope: archiveId,
    format: WHATSAPP_ARCHIVE_FORMAT,
    root,
    files: archiveFileEntries(files),
    manifestSha256: options.manifestSha256 ?? archiveManifestSha256(files),
    report: (finding) => { findings.push(finding); },
    shouldContinue: options.shouldContinue ?? (() => true),
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    ...(options.maxBytesPerListing !== undefined ? { maxBytesPerListing: options.maxBytesPerListing } : {}),
  });
  return { connector, findings, files, root };
}

async function listAll(connector: SourceConnector, options: { cursor?: string; limit?: number } = {}) {
  const items: RawItem[] = [];
  const cursors: string[] = [];
  const pages: SourceConnectorListPage[] = [];
  let done = false;
  for await (const page of connector.listItems({
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
  })) {
    items.push(...page.items);
    pages.push(page);
    if (page.nextCursor) cursors.push(page.nextCursor);
    done = page.done;
  }
  return { items, cursors, pages, done };
}

/** Passes of `limit` items, each a new connector (a restart) from the last cursor, until done. */
async function listInPasses(
  dir: string,
  names: readonly string[],
  limit: number,
  options: { pageSize?: number; maxBytesPerListing?: number; dropParked?: boolean | 'once' } = {},
) {
  const items: RawItem[] = [];
  const findings: ArchiveImportFinding[] = [];
  const parked: number[] = [];
  let cursor: string | undefined;
  let passes = 0;
  let manifest: string | undefined;
  for (;;) {
    const built = connectorFor(dir, names, { findings, ...(manifest ? { manifestSha256: manifest } : {}), ...options });
    manifest = archiveManifestSha256(built.files);
    const listed = await listAll(built.connector, { limit, ...(cursor ? { cursor } : {}) });
    items.push(...listed.items);
    passes += 1;
    parked.push(archiveContinuations.size);
    // A restart loses what was parked: after every pass, or once (after the first).
    if (options.dropParked === true || (options.dropParked === 'once' && passes === 1)) archiveContinuations.clear();
    if (listed.done) return { items, findings, passes, parked };
    cursor = listed.cursors.at(-1);
    if (!cursor || passes > 400) throw new Error('the listing did not finish');
  }
}

/**
 * Adds up what every zip member reader inflated and threw away to reach the place it was entered at, from now until `stop()`.
 * Each reader is counted once, when it is suspended or closed.
 */
function trackReplay(): { total(): number; stop(): void } {
  const proto = ZipMemberReader.prototype as unknown as { suspend(): unknown; close(): void };
  const realSuspend = proto.suspend;
  const realClose = proto.close;
  const counted = new WeakSet<object>();
  let total = 0;
  const count = (reader: ZipMemberReader): void => {
    if (counted.has(reader)) return;
    counted.add(reader);
    total += reader.replayedBytes;
  };
  proto.suspend = function (this: ZipMemberReader): unknown {
    count(this);
    return realSuspend.call(this);
  };
  proto.close = function (this: ZipMemberReader): void {
    count(this);
    realClose.call(this);
  };
  return { total: () => total, stop: () => { proto.suspend = realSuspend; proto.close = realClose; } };
}

function textOf(item: RawItem): string {
  return item.content.kind === 'text' ? item.content.text : '';
}

function kinds(findings: readonly ArchiveImportFinding[], cls?: 'gap' | 'skipped'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const finding of findings) {
    if (cls && finding.class !== cls) continue;
    out[finding.kind] = (out[finding.kind] ?? 0) + (finding.count ?? 1);
  }
  return out;
}

/** A resume point's fields: file, member, byte offset, how the next read enters, and a stored member's checksum so far. */
function cursorState(cursor: string): { f: number; m: number; o: number; k: string; d: string; c?: number; w?: unknown } {
  const match = /^wa1:[0-9a-f]{16}:(\{.*\})$/s.exec(cursor);
  if (!match) throw new Error('not a resume point');
  return JSON.parse(match[1]!);
}

describe('whatsapp connector over text files', () => {
  test('one item per message, shaped like a live message, with the wall time read in this zone', async () => {
    const dir = workDir();
    const messages: SyntheticMessage[] = [
      { at: '2026-05-14T21:08:07', sender: 'Sam Example', text: 'Meet at the harbour: bring the log' },
      { at: '2026-05-14T21:09:00', sender: 'Alex Example', text: 'first line\nsecond line' },
    ];
    put(dir, 'WhatsApp Chat with Harbour crew.txt', chatText(messages, { style: 'ios-24-dmy', bom: true }));
    const { connector, findings } = connectorFor(dir, ['WhatsApp Chat with Harbour crew.txt']);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items).toHaveLength(2);
    const [first, second] = items as [RawItem, RawItem];
    expect(first.identity).toMatchObject({ family: 'chat', provider: 'whatsapp_export', accountScope: 'synthetic-archive' });
    expect(first.identity.localItemId).toBe(`synthetic-archive:${first.identity.providerItemId}`);
    expect(first.mimeType).toBe('text/plain');
    expect(textOf(first)).toBe('Meet at the harbour: bring the log');
    expect(textOf(second)).toBe('first line\nsecond line');
    expect(first.metadata).toMatchObject({ chat: 'Harbour crew', sender: 'Sam Example', senderLabel: 'Sam Example', authoredAt: localIso('2026-05-14T21:08:07') });
    expect(first.metadata.contentHash).toBe(createHash('sha256').update(textOf(first)).digest('hex'));
    // Both messages are one thread, the chat; the name itself is not in an id.
    expect(first.identity.providerThreadId).toBe(second.identity.providerThreadId);
    expect(first.identity.providerConversationId).toBe(first.identity.providerThreadId);
    expect(JSON.stringify(first.identity)).not.toContain('Harbour');
    expect(first.identity.providerItemId).not.toBe(second.identity.providerItemId);
    // The zone is said once for the archive, at its start; this file's dates say day first, so no other assumption.
    expect(kinds(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.timeZoneAssumed]: 1 });
    expect(findings[0]).toMatchObject({ kind: ARCHIVE_COMMON_FINDINGS.timeZoneAssumed, class: 'gap', fileIndex: 0, offset: 0 });
  });

  test('every style reads to the same times', async () => {
    const messages = syntheticChat(6).map((message, index) => ({ ...message, at: `2026-05-${14 + index}T1${index}:0${index}:00` }));
    const times: string[][] = [];
    for (const style of ['ios-24-dmy', 'ios-12-mdy', 'android-24-dmy', 'android-12-mdy', 'android-dot-dmy', 'iso'] as const) {
      const dir = workDir();
      put(dir, '_chat.txt', chatText(messages, { style, crlf: style === 'iso' }));
      const { connector } = connectorFor(dir, ['_chat.txt']);
      const { items } = await listAll(connector);
      times.push(items.map((item) => String(item.metadata.authoredAt)));
    }
    for (const row of times) expect(row).toEqual(messages.map((message) => localIso(message.at)));
  });

  test('a file whose dates never say which part is the day is read day first, and says so once', async () => {
    const dir = workDir();
    put(dir, '_chat.txt', '03/04/2026, 10:00 - Sam Example: one\n04/05/2026, 10:00 - Alex Example: two\n');
    const { connector, findings } = connectorFor(dir, ['_chat.txt']);
    const { items } = await listAll(connector);
    expect(items.map((item) => item.metadata.authoredAt)).toEqual([localIso('2026-04-03T10:00:00'), localIso('2026-05-04T10:00:00')]);
    // The zone, and the order, each said as itself.
    expect(kinds(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.timeZoneAssumed]: 1, [ARCHIVE_COMMON_FINDINGS.dateOrderAssumed]: 1 });
  });

  test('the date order is per file: a month-first file and a day-first file in one archive', async () => {
    const dir = workDir();
    put(dir, 'a.txt', '5/14/26, 9:08 PM - Sam Example: month first\n');
    put(dir, 'b.txt', '14/05/2026, 21:08 - Alex Example: day first\n');
    const { connector } = connectorFor(dir, ['a.txt', 'b.txt']);
    const { items } = await listAll(connector);
    expect(items.map((item) => item.metadata.authoredAt)).toEqual([localIso('2026-05-14T21:08:00'), localIso('2026-05-14T21:08:00')]);
    expect(items.map((item) => item.metadata.chat)).toEqual(['a', 'b']);
  });

  test('notices, empty messages and the status updates chat are skipped and counted, never items', async () => {
    const dir = workDir();
    const messages: SyntheticMessage[] = [
      notice('2026-05-14T10:00:00'),
      { at: '2026-05-14T10:01:00', sender: 'Sam Example', text: 'a real message' },
      notice('2026-05-14T10:02:00', 'Sam Example added Alex Example'),
      { at: '2026-05-14T10:03:00', sender: 'Alex Example', text: '' },
      notice('2026-05-14T10:04:00', 'The subject changed'),
      { at: '2026-05-14T10:05:00', sender: 'Alex Example', text: 'another' },
    ];
    put(dir, 'WhatsApp Chat with Harbour crew.txt', chatText(messages, { style: 'android-24-dmy' }));
    put(dir, 'WhatsApp Chat with status@broadcast.txt', chatText(syntheticChat(4, { label: 'status' }), { style: 'android-24-dmy' }));
    const { connector, findings } = connectorFor(dir, ['WhatsApp Chat with Harbour crew.txt', 'WhatsApp Chat with status@broadcast.txt']);
    const { items } = await listAll(connector);
    expect(items.map(textOf)).toEqual(['a real message', 'another']);
    expect(kinds(findings, 'skipped')).toEqual({
      [WHATSAPP_FINDINGS.systemMessage]: 3,
      [WHATSAPP_FINDINGS.messageEmpty]: 1,
      [WHATSAPP_FINDINGS.statusUpdates]: 4,
    });
    // Each skip says where, in the file it is in.
    const status = findings.filter((finding) => finding.kind === WHATSAPP_FINDINGS.statusUpdates);
    expect(status.every((finding) => finding.fileIndex === 1 && finding.class === 'skipped')).toBe(true);
  });

  test('media stays in the text as the marker and is counted as not imported, once per file named', async () => {
    const dir = workDir();
    const names = mediaNames(3);
    const messages: SyntheticMessage[] = [
      { at: '2026-05-14T10:00:00', sender: 'Sam Example', text: `<attached: ${names[0]}>` },
      { at: '2026-05-14T10:01:00', sender: 'Alex Example', text: `look at these\n<attached: ${names[1]}>\n<attached: ${names[2]}>` },
      { at: '2026-05-14T10:02:00', sender: 'Sam Example', text: '<Media omitted>' },
      { at: '2026-05-14T10:03:00', sender: 'Sam Example', text: 'IMG-20260214-WA0001.jpg (file attached)' },
      { at: '2026-05-14T10:04:00', sender: 'Sam Example', text: 'no media here' },
    ];
    put(dir, '_chat.txt', chatText(messages, { style: 'ios-24-dmy' }));
    const { connector, findings } = connectorFor(dir, ['_chat.txt']);
    const { items } = await listAll(connector);
    expect(items).toHaveLength(5);
    expect(textOf(items[0]!)).toBe(`<attached: ${names[0]}>`);
    expect(textOf(items[1]!)).toContain(names[2]!);
    expect(kinds(findings, 'gap')[ARCHIVE_COMMON_FINDINGS.mediaNotImported]).toBe(1 + 2 + 1 + 1);
    // Each is told where its message starts.
    const media = findings.filter((finding) => finding.kind === ARCHIVE_COMMON_FINDINGS.mediaNotImported);
    expect(media.map((finding) => finding.count)).toEqual([1, 2, 1, 1]);
    expect(new Set(media.map((finding) => finding.offset)).size).toBe(4);
  });

  test('a message over the bound is kept to the bound and reported with its place', async () => {
    const dir = workDir();
    const messages: SyntheticMessage[] = [
      { at: '2026-05-14T10:00:00', sender: 'Sam Example', text: 'short' },
      { at: '2026-05-14T10:01:00', sender: 'Alex Example', text: `${'z'.repeat(WHATSAPP_MAX_ITEM_TEXT_CHARS - 10)}\n${'z'.repeat(100)}\n${'z'.repeat(100)}` },
      { at: '2026-05-14T10:02:00', sender: 'Sam Example', text: 'after' },
    ];
    const text = chatText(messages, { style: 'android-24-dmy' });
    put(dir, '_chat.txt', text);
    const { connector, findings } = connectorFor(dir, ['_chat.txt']);
    const { items } = await listAll(connector);
    expect(items.map((item) => textOf(item).length)).toEqual([5, WHATSAPP_MAX_ITEM_TEXT_CHARS, 5]);
    const cut = findings.filter((finding) => finding.kind === ARCHIVE_COMMON_FINDINGS.itemTruncated);
    expect(cut).toHaveLength(1);
    expect(cut[0]).toMatchObject({ class: 'gap', fileIndex: 0, offset: Buffer.byteLength(text.slice(0, text.indexOf('14/05/2026, 10:01')), 'utf8') });
  });

  test('two messages alike in everything, in the same minute, are two items', async () => {
    const dir = workDir();
    put(dir, '_chat.txt', chatText([
      { at: '2026-05-14T10:00:00', sender: 'Sam Example', text: 'ok' },
      { at: '2026-05-14T10:00:00', sender: 'Sam Example', text: 'ok' },
      { at: '2026-05-14T10:00:00', sender: 'Sam Example', text: 'ok' },
    ], { style: 'android-24-dmy' }));
    const { connector } = connectorFor(dir, ['_chat.txt']);
    const { items } = await listAll(connector);
    expect(new Set(items.map((item) => item.identity.providerItemId)).size).toBe(3);
    // And the same file read again gives the same identities.
    const again = await listAll(connectorFor(dir, ['_chat.txt']).connector);
    expect(again.items.map((item) => item.identity.providerItemId)).toEqual(items.map((item) => item.identity.providerItemId));
  });

  test('a header typed or pasted into a message still starts a message, is counted as a line taken for the start of one, and does not decide the date order', async () => {
    const dir = workDir();
    put(dir, '_chat.txt', [
      '03/04/2026, 10:00 - Sam Example: opening line',
      '03/25/2026, 10:01 - Pat: pasted from a month first chat',
      '20/04/2026, 11:00 - Alex Example: written for real',
      '21/04/2026, 11:01 - Sam Example: and again',
      '[1/2/23, 10:00] Lee: pasted from a phone that writes brackets',
      '22/04/2026, 11:02 - Alex Example: and once more',
      '',
    ].join('\n'));
    const { connector, findings } = connectorFor(dir, ['_chat.txt']);
    const { items } = await listAll(connector);
    // The format cannot tell a pasted header from a real one: both pasted lines are messages, and their senders are named in them.
    expect(items.map((item) => item.metadata.sender)).toEqual(['Sam Example', 'Pat', 'Alex Example', 'Sam Example', 'Lee', 'Alex Example']);
    // The headers that say which part is the day outvote the pasted one: day first, not "the first to say".
    expect(items[0]!.metadata.authoredAt).toBe(localIso('2026-04-03T10:00:00'));
    expect(items[2]!.metadata.authoredAt).toBe(localIso('2026-04-20T11:00:00'));
    // The zone, once; and the two lines that cannot belong (dated before the one above, written in another style), counted as what they are.
    expect(kinds(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.timeZoneAssumed]: 1, [ARCHIVE_COMMON_FINDINGS.itemStartAssumed]: 2 });
    // Nothing else about the pasted lines is hidden: each carries where it was read from.
    expect(items.every((item) => item.metadata.sourceFile === '_chat.txt')).toBe(true);
  });

  test('a clean export counts no line taken for a message start or date order: only the zone, said once', async () => {
    const dir = workDir();
    put(dir, '_chat.txt', chatText(syntheticChat(30), { style: 'ios-24-dmy' }));
    const { connector, findings } = connectorFor(dir, ['_chat.txt']);
    await listAll(connector);
    expect(kinds(findings, 'gap')).toEqual({ [ARCHIVE_COMMON_FINDINGS.timeZoneAssumed]: 1 });
  });

  test('each item says which export file, and which member of it, it was read from', async () => {
    const dir = workDir();
    put(dir, 'WhatsApp Chat with Harbour crew.txt', chatText(syntheticChat(2), { style: 'android-24-dmy' }));
    put(dir, 'WhatsApp Chat with Harbour crew.zip', chatZip(chatText(syntheticChat(2), { style: 'android-24-dmy' })));
    const { items } = await listAll(connectorFor(dir, ['WhatsApp Chat with Harbour crew.txt', 'WhatsApp Chat with Harbour crew.zip']).connector);
    expect(items.map((item) => [item.metadata.sourceFile, item.metadata.sourceMember])).toEqual([
      ['WhatsApp Chat with Harbour crew.txt', undefined],
      ['WhatsApp Chat with Harbour crew.txt', undefined],
      ['WhatsApp Chat with Harbour crew.zip', '_chat.txt'],
      ['WhatsApp Chat with Harbour crew.zip', '_chat.txt'],
    ]);
  });

  test('a chat called _chat.txt takes its name from the folder it came in, else a plain one', async () => {
    const dir = workDir();
    put(dir, 'WhatsApp Chat - Harbour crew/_chat.txt', chatText(syntheticChat(1), { style: 'ios-24-dmy' }));
    put(dir, '_chat.txt', chatText(syntheticChat(1), { style: 'ios-24-dmy' }));
    const named = await listAll(connectorFor(dir, ['WhatsApp Chat - Harbour crew/_chat.txt']).connector);
    expect(named.items[0]!.metadata.chat).toBe('Harbour crew');
    const plain = await listAll(connectorFor(dir, ['_chat.txt']).connector);
    expect(plain.items[0]!.metadata.chat).toBe('WhatsApp chat');
  });

  test('classification signals carry the chat and the sender, and no trust prior', async () => {
    const dir = workDir();
    put(dir, '_chat.txt', chatText(syntheticChat(1), { style: 'ios-24-dmy' }));
    const { connector } = connectorFor(dir, ['_chat.txt']);
    const { items } = await listAll(connector);
    expect(connector.classificationSignals(items[0]!)).toEqual({ title: 'WhatsApp chat', sender: 'Sam Example' });
    await expect(connector.fetchItem('x')).rejects.toThrow();
  });
});

describe('whatsapp connector resumes', () => {
  test('page by page: each cursor lists the rest once, and a new connector continues where the last stopped', async () => {
    const dir = workDir();
    put(dir, '_chat.txt', chatText(syntheticChat(11), { style: 'ios-24-dmy' }));
    const { connector } = connectorFor(dir, ['_chat.txt'], { pageSize: 3 });
    const all = await listAll(connector);
    expect(all.items).toHaveLength(11);
    expect(all.pages.map((page) => page.items.length)).toEqual([3, 3, 3, 2]);
    expect(all.pages.at(-1)!.done).toBe(true);
    for (let index = 0; index < all.cursors.length - 1; index += 1) {
      const rest = await listAll(connectorFor(dir, ['_chat.txt'], { pageSize: 3 }).connector, { cursor: all.cursors[index]! });
      expect(rest.items.map((item) => item.identity.providerItemId))
        .toEqual(all.items.slice((index + 1) * 3).map((item) => item.identity.providerItemId));
    }
    const finished = await listAll(connector, { cursor: all.cursors.at(-1)! });
    expect(finished).toMatchObject({ items: [], done: true });
  });

  test('passes of a few items cover a long chat exactly once, in order, in every style and in a zip', async () => {
    const messages = syntheticChat(900).map((message, index) => index % 40 === 7
      ? { ...message, text: `${message.text}\ncontinued on a second line\nand a third` }
      : message);
    const whole = chatText(messages, { style: 'ios-12-mdy' });
    for (const layout of ['text', 'zip-deflate', 'zip-stored'] as const) {
      const dir = workDir();
      const name = layout === 'text' ? '_chat.txt' : 'WhatsApp Chat with Harbour crew.zip';
      put(dir, name, layout === 'text' ? whole : chatZip(whole, { method: layout === 'zip-stored' ? 'stored' : 'deflate', media: mediaNames(4) }));
      const single = await listAll(connectorFor(dir, [name]).connector);
      expect(single.items).toHaveLength(900);
      archiveContinuations.clear();
      const passes = await listInPasses(dir, [name], 130, { pageSize: 50 });
      expect(passes.passes).toBeGreaterThan(5);
      expect(passes.items.map((item) => item.identity.providerItemId)).toEqual(single.items.map((item) => item.identity.providerItemId));
      expect(passes.items.map(textOf)).toEqual(single.items.map(textOf));
      archiveContinuations.clear();
      const cold = await listInPasses(dir, [name], 130, { pageSize: 50, dropParked: true });
      expect(cold.items.map((item) => item.identity.providerItemId)).toEqual(single.items.map((item) => item.identity.providerItemId));
    }
  });

  test('a deflated member is parked at the page it stopped at and taken up by the next pass', async () => {
    const dir = workDir();
    const text = chatText(syntheticChat(2500), { style: 'android-24-dmy' });
    put(dir, 'WhatsApp Chat with Harbour crew.zip', chatZip(text, { textName: 'WhatsApp Chat with Harbour crew.txt' }));
    archiveContinuations.clear();
    const passes = await listInPasses(dir, ['WhatsApp Chat with Harbour crew.zip'], 400, { pageSize: 100 });
    expect(passes.items).toHaveLength(2500);
    // Every pass that stopped inside the member left its inflater for the next.
    expect(passes.parked.slice(0, -1).every((size) => size === 1)).toBe(true);
    expect(passes.parked.at(-1)).toBe(0);
  });

  test('a stored member resumes with its checksum so far, and a damaged one is told at its end', async () => {
    const dir = workDir();
    const text = chatText(syntheticChat(400), { style: 'android-24-dmy' });
    put(dir, 'good.zip', chatZip(text, { method: 'stored' }));
    const good = await listInPasses(dir, ['good.zip'], 90, { pageSize: 30 });
    expect(good.items).toHaveLength(400);
    expect(kinds(good.findings, 'gap')[ARCHIVE_COMMON_FINDINGS.fileDamaged]).toBeUndefined();
    // The cursor in the middle of a stored member names the checksum before it.
    const built = connectorFor(dir, ['good.zip'], { pageSize: 30 });
    const first = await listAll(built.connector, { limit: 90 });
    const middle = cursorState(first.cursors.at(-1)!);
    expect(middle).toMatchObject({ k: 'message' });
    expect(typeof middle.c).toBe('number');

    // The same text with a wrong checksum recorded: the whole member is read, in passes, and the end says so, once.
    put(dir, 'bad.zip', buildZip([{ name: '_chat.txt', data: text, method: 'stored', badCrc: referenceCrc32(new TextEncoder().encode(text)) ^ 0x5a5a5a5a }]));
    const bad = await listInPasses(dir, ['bad.zip'], 90, { pageSize: 30 });
    expect(bad.items).toHaveLength(400);
    expect(bad.findings.filter((finding) => finding.kind === ARCHIVE_COMMON_FINDINGS.fileDamaged)).toHaveLength(1);
  });

  test('a deflated member with a wrong checksum is told at its end after a restart too', async () => {
    const dir = workDir();
    const text = chatText(syntheticChat(300), { style: 'android-24-dmy' });
    put(dir, 'bad.zip', buildZip([{ name: '_chat.txt', data: text, method: 'deflate', badCrc: 12345 }]));
    archiveContinuations.clear();
    const cold = await listInPasses(dir, ['bad.zip'], 70, { pageSize: 20, dropParked: true });
    expect(cold.items).toHaveLength(300);
    expect(cold.findings.filter((finding) => finding.kind === ARCHIVE_COMMON_FINDINGS.fileDamaged)).toHaveLength(1);
    const warm = await listInPasses(dir, ['bad.zip'], 70, { pageSize: 20 });
    expect(warm.findings.filter((finding) => finding.kind === ARCHIVE_COMMON_FINDINGS.fileDamaged)).toHaveLength(1);
  });

  test('the byte budget pauses a listing at a message too, and the next pass goes on', async () => {
    const dir = workDir();
    // About 6 MB of text, read a megabyte at a time: a 2 MB budget takes several passes.
    const messages = syntheticChat(60).map((message, index) => ({ ...message, text: `${index} ${'z'.repeat(100_000)}` }));
    put(dir, '_chat.txt', chatText(messages, { style: 'ios-24-dmy' }));
    const single = await listAll(connectorFor(dir, ['_chat.txt']).connector);
    expect(single.items).toHaveLength(60);
    const passes = await listInPasses(dir, ['_chat.txt'], 10_000, { pageSize: 1000, maxBytesPerListing: 2_000_000 });
    expect(passes.passes).toBeGreaterThanOrEqual(3);
    expect(passes.items.map((item) => item.identity.providerItemId)).toEqual(single.items.map((item) => item.identity.providerItemId));
  });

  test('one message of many megabytes cannot make a pass read all of it: each pass stops at its budget and the next goes on inside the message', async () => {
    const dir = workDir();
    const line = 'z'.repeat(100_000);
    const big = Array.from({ length: 220 }, (_, index) => `${index} ${line}`).join('\n');
    const path = put(dir, '_chat.txt', chatText([
      { at: '2026-05-14T10:00:00', sender: 'Sam Example', text: 'before' },
      { at: '2026-05-14T10:01:00', sender: 'Alex Example', text: big },
      { at: '2026-05-14T10:02:00', sender: 'Sam Example', text: 'after' },
      { at: '2026-05-14T10:03:00', sender: 'Alex Example', text: 'and last' },
    ], { style: 'android-24-dmy' }));
    const size = statSync(path).size;
    expect(size).toBeGreaterThan(20_000_000);
    const budget = 3_000_000;
    const findings: ArchiveImportFinding[] = [];
    const items: RawItem[] = [];
    const advances: number[] = [];
    let cursor: string | undefined;
    let last = 0;
    let manifest: string | undefined;
    let passes = 0;
    for (; passes < 60; passes += 1) {
      const built = connectorFor(dir, ['_chat.txt'], { findings, maxBytesPerListing: budget, ...(manifest ? { manifestSha256: manifest } : {}) });
      manifest = archiveManifestSha256(built.files);
      const listed = await listAll(built.connector, cursor ? { cursor } : {});
      items.push(...listed.items);
      if (listed.done) break;
      cursor = listed.cursors.at(-1)!;
      const state = cursorState(cursor);
      advances.push(state.o - last);
      last = state.o;
    }
    expect(passes).toBeLessThan(60);
    expect(items.map((item) => textOf(item).slice(0, 8))).toEqual(['before', '0 zzzzzz', 'after', 'and last']);
    // The long message is kept to the text bound and said to be cut, once however many passes drop the rest of it.
    expect(textOf(items[1]!).length).toBe(WHATSAPP_MAX_ITEM_TEXT_CHARS);
    expect(findings.filter((finding) => finding.kind === ARCHIVE_COMMON_FINDINGS.itemTruncated)).toHaveLength(1);
    // No pass read much more than its budget, whatever the size of the message it was inside: a pass is
    // the budget, plus one message at most (kept to its bounds), plus the read it stopped in.
    const chunk = 1024 * 1024;
    expect(Math.max(...advances)).toBeLessThanOrEqual(budget + WHATSAPP_MAX_ITEM_TEXT_CHARS + 2 * chunk);
    // The dropped part was read in budget-sized passes.
    expect(advances.filter((advance) => advance >= budget).length).toBeGreaterThanOrEqual(5);
    expect(passes).toBeGreaterThanOrEqual(6);
  }, 60_000);

  test('a stop inside a cut message names a place inside the lines being dropped, and the next pass goes on from it', async () => {
    const dir = workDir();
    const line = 'z'.repeat(1000);
    put(dir, '_chat.txt', chatText([
      { at: '2026-05-14T10:00:00', sender: 'Sam Example', text: Array.from({ length: 4000 }, (_, index) => `${index} ${line}`).join('\n') },
      { at: '2026-05-14T10:01:00', sender: 'Alex Example', text: 'after' },
    ], { style: 'android-24-dmy' }));
    const states: Array<ReturnType<typeof cursorState>> = [];
    const items: RawItem[] = [];
    let cursor: string | undefined;
    let manifest: string | undefined;
    for (let pass = 0; pass < 20; pass += 1) {
      const built = connectorFor(dir, ['_chat.txt'], { maxBytesPerListing: 2_500_000, ...(manifest ? { manifestSha256: manifest } : {}) });
      manifest = archiveManifestSha256(built.files);
      const listed = await listAll(built.connector, cursor ? { cursor } : {});
      items.push(...listed.items);
      if (listed.done) break;
      cursor = listed.cursors.at(-1)!;
      states.push(cursorState(cursor));
    }
    expect(items.map((item) => textOf(item).slice(0, 3))).toEqual(['0 z', 'aft']);
    // At least one stop was inside the dropped lines, past the text that was kept.
    const inside = states.filter((state) => (state.k === 'skip' || state.k === 'mid') && state.o > WHATSAPP_MAX_ITEM_TEXT_CHARS);
    expect(inside.length).toBeGreaterThan(0);
    // Every place names the date order the first pass read, so it is not read again.
    expect(states.every((state) => state.d !== '?')).toBe(true);
  }, 60_000);

  test('a deflated member entered cold pays for the bytes the inflater runs through, and the budget counts them', async () => {
    const dir = workDir();
    // Text that does not compress to nothing, so the inflater hands out its output in reads of a size the budget can count.
    let seed = 12345;
    const noise = (length: number): string => {
      let out = '';
      while (out.length < length) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        out += (seed >>> 8).toString(16).padStart(6, '0');
      }
      return out.slice(0, length);
    };
    const messages = syntheticChat(100).map((message, index) => ({
      ...message,
      text: `${index}\n${Array.from({ length: 1000 }, () => noise(100)).join('\n')}`,
    }));
    put(dir, 'WhatsApp Chat with Harbour crew.zip', chatZip(chatText(messages, { style: 'android-24-dmy' }), { textName: 'WhatsApp Chat with Harbour crew.txt' }));
    const names = ['WhatsApp Chat with Harbour crew.zip'];
    const options = { pageSize: 1000, maxBytesPerListing: 6_000_000 };
    archiveContinuations.clear();
    const warmReplay = trackReplay();
    const warm = await listInPasses(dir, names, 10_000, options).finally(() => warmReplay.stop());
    archiveContinuations.clear();
    // A restart after the first pass loses the parked inflater: the next pass runs through the member again.
    const coldReplay = trackReplay();
    const cold = await listInPasses(dir, names, 10_000, { ...options, dropParked: 'once' }).finally(() => coldReplay.stop());
    expect(cold.items.map((item) => item.identity.providerItemId)).toEqual(warm.items.map((item) => item.identity.providerItemId));
    expect(cold.items).toHaveLength(100);
    // The parked inflater means a pass reads only new bytes; without it, a pass runs through the member to where it was,
    // and what it ran through is what its budget was spent on.
    expect(warm.passes).toBeLessThan(10);
    expect(coldReplay.total()).toBeGreaterThan(warmReplay.total() + 1_000_000);
    expect(cold.passes).toBeGreaterThanOrEqual(warm.passes);
    expect(cold.passes).toBeLessThanOrEqual(warm.passes + 3);
  }, 120_000);

  test('a deflated member resumed cold is caught up to over several passes, no step of it larger than the budget, and the messages are the same', async () => {
    const dir = workDir();
    let seed = 4242;
    const noise = (length: number): string => {
      let out = '';
      while (out.length < length) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        out += (seed >>> 8).toString(16).padStart(6, '0');
      }
      return out.slice(0, length);
    };
    const messages = syntheticChat(40).map((message, index) => ({
      ...message,
      text: `${index}\n${Array.from({ length: 500 }, () => noise(100)).join('\n')}`,
    }));
    put(dir, 'WhatsApp Chat with Harbour crew.zip', chatZip(chatText(messages, { style: 'android-24-dmy' }), { textName: 'WhatsApp Chat with Harbour crew.txt' }));
    const names = ['WhatsApp Chat with Harbour crew.zip'];
    archiveContinuations.clear();
    const whole = await listAll(connectorFor(dir, names).connector);
    expect(whole.items).toHaveLength(40);
    // A resume point deep in the member, as an earlier pass left it; then the process restarts and nothing is parked.
    archiveContinuations.clear();
    const early = await listAll(connectorFor(dir, names).connector, { limit: 34 });
    const deep = early.cursors.at(-1)!;
    expect(cursorState(deep).o).toBeGreaterThan(1_500_000);
    archiveContinuations.clear();

    const budget = 400_000;
    const proto = ZipMemberReader.prototype as unknown as { next(): unknown; catchUp(): unknown };
    const realNext = proto.next;
    const realCatchUp = proto.catchUp;
    let worstCall = 0;
    let calls = 0;
    const measured = (real: () => unknown) => function (this: ZipMemberReader): unknown {
      const before = this.replayedBytes;
      try {
        return real.call(this);
      } finally {
        calls += 1;
        worstCall = Math.max(worstCall, this.replayedBytes - before);
      }
    };
    proto.next = measured(realNext);
    proto.catchUp = measured(realCatchUp);
    const items: RawItem[] = [];
    const perPass: number[] = [];
    let cursor = deep;
    let manifest: string | undefined;
    let passes = 0;
    try {
      for (; passes < 60; passes += 1) {
        const built = connectorFor(dir, names, { maxBytesPerListing: budget, ...(manifest ? { manifestSha256: manifest } : {}) });
        manifest = archiveManifestSha256(built.files);
        const listed = await listAll(built.connector, { cursor });
        items.push(...listed.items);
        perPass.push(listed.items.length);
        if (listed.done) break;
        cursor = listed.cursors.at(-1)!;
      }
    } finally {
      proto.next = realNext;
      proto.catchUp = realCatchUp;
    }
    expect(calls).toBeGreaterThan(0);
    expect(items.map((item) => item.identity.providerItemId)).toEqual(whole.items.slice(34).map((item) => item.identity.providerItemId));
    // Getting back to the place took several passes, the first of them with no message to give.
    expect(passes).toBeGreaterThanOrEqual(4);
    expect(perPass[0]).toBe(0);
    // No single read inflated more than a step of the budget and the push that was in progress.
    expect(worstCall).toBeLessThanOrEqual(budget + 4 * ZIP_INFLATE_PUSH_BYTES);
  }, 120_000);

  test('a deflated member of lines longer than the reads that inflate it still stops at its budget', async () => {
    const dir = workDir();
    let seed = 777;
    const noise = (length: number): string => {
      let out = '';
      while (out.length < length) {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        out += (seed >>> 8).toString(16).padStart(6, '0');
      }
      return out.slice(0, length);
    };
    // Each message is one line of 100 KB: its header begins in an earlier read than the one its end is found in.
    const messages = syntheticChat(30).map((message, index) => ({ ...message, text: `${index} ${noise(100_000)}` }));
    put(dir, 'WhatsApp Chat with Harbour crew.zip', chatZip(chatText(messages, { style: 'android-24-dmy' }), { textName: 'WhatsApp Chat with Harbour crew.txt' }));
    const names = ['WhatsApp Chat with Harbour crew.zip'];
    const whole = await listAll(connectorFor(dir, names).connector);
    expect(whole.items).toHaveLength(30);
    const budget = 1_000_000;
    const items: RawItem[] = [];
    const advances: number[] = [];
    let cursor: string | undefined;
    let manifest: string | undefined;
    let last = 0;
    let passes = 0;
    for (; passes < 100; passes += 1) {
      const built = connectorFor(dir, names, { maxBytesPerListing: budget, ...(manifest ? { manifestSha256: manifest } : {}) });
      manifest = archiveManifestSha256(built.files);
      const listed = await listAll(built.connector, cursor ? { cursor } : {});
      items.push(...listed.items);
      if (listed.done) break;
      cursor = listed.cursors.at(-1)!;
      const state = cursorState(cursor);
      advances.push(state.o - last);
      last = state.o;
    }
    expect(items.map((item) => item.identity.providerItemId)).toEqual(whole.items.map((item) => item.identity.providerItemId));
    // A pass is its budget, plus the message it was in and the one it ended with: never the rest of the member.
    expect(Math.max(...advances)).toBeLessThanOrEqual(budget + 2 * 100_100 + 100_000);
    expect(passes).toBeGreaterThan(4);
  }, 120_000);

  test('a stored member whose headers straddle reads is resumed with its checksum at every page, and a wrong checksum is told once', async () => {
    const dir = workDir();
    const read = 1024 * 1024;
    const prefix = messageLine({ at: '2026-05-14T10:00:00', sender: 'Sam Example', text: '' }, { style: 'android-24-dmy' });
    // Each message is one read long less 20 bytes, so a header begins 20 bytes before the end of a read in every pass.
    const messages = Array.from({ length: 4 }, (_, index) => ({
      at: `2026-05-14T10:0${index}:00`,
      sender: 'Sam Example',
      text: `${index}${'x'.repeat(read - 20 - Buffer.byteLength(prefix, 'utf8') - 2)}`,
    }));
    const text = chatText(messages, { style: 'android-24-dmy' });
    put(dir, 'good.zip', chatZip(text, { method: 'stored' }));
    const good = await listInPasses(dir, ['good.zip'], 1);
    expect(good.items).toHaveLength(4);
    expect(good.passes).toBeGreaterThanOrEqual(4);
    expect(kinds(good.findings, 'gap')[ARCHIVE_COMMON_FINDINGS.fileDamaged]).toBeUndefined();
    put(dir, 'bad.zip', buildZip([{ name: '_chat.txt', data: text, method: 'stored', badCrc: referenceCrc32(new TextEncoder().encode(text)) ^ 0x5a5a5a5a }]));
    const bad = await listInPasses(dir, ['bad.zip'], 1);
    expect(bad.items).toHaveLength(4);
    expect(bad.findings.filter((finding) => finding.kind === ARCHIVE_COMMON_FINDINGS.fileDamaged)).toHaveLength(1);
  }, 60_000);

  test('messages alike in everything keep their numbers across pages and restarts: a time with seven of them is seven items', async () => {
    const dir = workDir();
    const same: SyntheticMessage = { at: '2026-05-14T10:00:00', sender: 'Sam Example', text: 'ok' };
    put(dir, '_chat.txt', chatText([
      { at: '2026-05-14T09:59:00', sender: 'Alex Example', text: 'before' },
      same, same, same, same, same, same, same,
      { at: '2026-05-14T10:01:00', sender: 'Alex Example', text: 'after' },
    ], { style: 'android-24-dmy' }));
    const single = await listAll(connectorFor(dir, ['_chat.txt']).connector);
    const ids = single.items.map((item) => item.identity.providerItemId);
    expect(ids).toHaveLength(9);
    expect(new Set(ids).size).toBe(9);
    for (const limit of [1, 2, 3]) {
      const passes = await listInPasses(dir, ['_chat.txt'], limit, { pageSize: 2 });
      expect(passes.items.map((item) => item.identity.providerItemId)).toEqual(ids);
    }
  });

  test('two real messages alike in everything, a pasted older header between them, keep their own identities; overlapping copies still import each once', async () => {
    const dir = workDir();
    const lines = [
      '14/05/2026, 10:00 - Sam Example: ok',
      '14/05/2026, 10:00 - Pat Example: here is what she wrote last spring',
      '12/03/2026, 09:00 - Alex Example: pasted from an older chat',
      '14/05/2026, 10:00 - Sam Example: ok',
      '14/05/2026, 10:01 - Sam Example: after',
    ];
    const text = `${lines.join('\n')}\n`;
    put(dir, 'WhatsApp Chat with Harbour crew.txt', text);
    const single = await listAll(connectorFor(dir, ['WhatsApp Chat with Harbour crew.txt']).connector);
    const ids = single.items.map((item) => item.identity.providerItemId);
    expect(single.items.map(textOf)).toEqual(['ok', 'here is what she wrote last spring', 'pasted from an older chat', 'ok', 'after']);
    expect(new Set(ids).size).toBe(5);
    // Pages and restarts change nothing.
    for (const limit of [1, 2]) {
      const passes = await listInPasses(dir, ['WhatsApp Chat with Harbour crew.txt'], limit, { pageSize: 1 });
      expect(passes.items.map((item) => item.identity.providerItemId)).toEqual(ids);
    }
    // A zip of the same export: the real messages share their identities with the text file's, so each is imported once.
    put(dir, 'WhatsApp Chat with Harbour crew.zip', chatZip(text, { textName: 'WhatsApp Chat with Harbour crew.txt' }));
    const both = await listAll(connectorFor(dir, ['WhatsApp Chat with Harbour crew.txt', 'WhatsApp Chat with Harbour crew.zip']).connector);
    const fromZip = both.items.slice(5).map((item) => item.identity.providerItemId);
    for (const index of [0, 1, 3, 4]) expect(fromZip[index]).toBe(ids[index]);
  });

  test('a resume point belongs to these files only and to a place where a message starts', async () => {
    const dir = workDir();
    put(dir, '_chat.txt', chatText(syntheticChat(6), { style: 'ios-24-dmy' }));
    const built = connectorFor(dir, ['_chat.txt'], { pageSize: 2 });
    const all = await listAll(built.connector);
    const cursor = all.cursors[0]!;
    const other = connectorFor(dir, ['_chat.txt'], { manifestSha256: 'f'.repeat(64) });
    await expect(listAll(other.connector, { cursor })).rejects.toMatchObject({ code: 'resume_point_invalid' });
    const state = cursorState(cursor);
    const prefix = cursor.slice(0, cursor.indexOf('{'));
    const withState = (change: Record<string, unknown>) => `${prefix}${JSON.stringify({ ...state, ...change })}`;
    for (const bad of [
      withState({ o: state.o + 7 }),
      withState({ f: 9 }),
      withState({ k: 'start' }),
      withState({ k: 'sideways' }),
      withState({ d: 'x' }),
      withState({ o: 999_999_999 }),
      withState({ o: -1 }),
      withState({ c: 5 }),
      withState({ w: [1, 2, 3] }),
      `${prefix}{"f":0}`,
      `${prefix}not json`,
      `${prefix}[]`,
    ]) {
      await expect(listAll(connectorFor(dir, ['_chat.txt']).connector, { cursor: bad })).rejects.toBeInstanceOf(ArchiveImportStoppedError);
    }
  });

  test('asked to stop, a listing hands over what it read with a resume point at the next message', async () => {
    const dir = workDir();
    put(dir, '_chat.txt', chatText(syntheticChat(8), { style: 'ios-24-dmy' }));
    let calls = 0;
    const first = await listAll(connectorFor(dir, ['_chat.txt'], { shouldContinue: () => ++calls <= 4 }).connector);
    expect(first.done).toBe(false);
    // The asks go to the date scan, to each read of the first bytes, and to each message.
    expect(first.items.length).toBeGreaterThan(0);
    expect(first.items.length).toBeLessThan(8);
    const rest = await listAll(connectorFor(dir, ['_chat.txt']).connector, { cursor: first.cursors.at(-1)! });
    expect(first.items.length + rest.items.length).toBe(8);
    expect([...first.items, ...rest.items].map((item) => textOf(item).match(/entry (\d+)/)![1])).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
  });

  test('a file that changed, was replaced or went missing stops the listing instead of reading other bytes', async () => {
    const dir = workDir();
    const path = put(dir, '_chat.txt', chatText(syntheticChat(6), { style: 'ios-24-dmy' }));
    const { connector } = connectorFor(dir, ['_chat.txt']);
    appendFileSync(path, chatText(syntheticChat(1, { label: 'late' }), { style: 'ios-24-dmy' }));
    await expect(listAll(connector)).rejects.toMatchObject({ code: 'file_changed', relPath: '_chat.txt' });
    unlinkSync(path);
    await expect(listAll(connector)).rejects.toMatchObject({ code: 'file_missing', relPath: '_chat.txt' });
  });

  test('a file changed after the first page stops the listing, though its messages were already read', async () => {
    const dir = workDir();
    const path = put(dir, '_chat.txt', chatText(syntheticChat(6), { style: 'ios-24-dmy' }));
    const { connector } = connectorFor(dir, ['_chat.txt'], { pageSize: 2 });
    let caught: unknown;
    let pages = 0;
    try {
      for await (const page of connector.listItems({})) {
        pages += 1;
        if (page.items.length > 0 && pages === 1) appendFileSync(path, 'x');
      }
    } catch (error) {
      caught = error;
    }
    expect(pages).toBe(1);
    expect(caught).toMatchObject({ code: 'file_changed' });
  });
});

describe('whatsapp connector over zips', () => {
  test('the chat member is read, the media beside it and the Finder noise are not, and the chat is named for the zip', async () => {
    const dir = workDir();
    put(dir, 'WhatsApp Chat - Harbour crew.zip', chatZip(chatText(syntheticChat(5), { style: 'ios-24-dmy' }), { media: mediaNames(8), macNoise: true }));
    const { connector, findings } = connectorFor(dir, ['WhatsApp Chat - Harbour crew.zip']);
    const { items } = await listAll(connector);
    expect(items).toHaveLength(5);
    expect(items.every((item) => item.metadata.chat === 'Harbour crew')).toBe(true);
    expect(findings.map((finding) => finding.kind)).toEqual([ARCHIVE_COMMON_FINDINGS.timeZoneAssumed]);
  });

  test('a zip of several chats: each member is its own chat, named for itself', async () => {
    const dir = workDir();
    put(dir, 'all chats.zip', buildZip([
      { name: 'WhatsApp Chat with Sam Example.txt', data: chatText(syntheticChat(3, { label: 'sam' }), { style: 'android-24-dmy' }), method: 'deflate' },
      { name: 'pic.jpg', data: 'x' },
      { name: 'WhatsApp Chat with Alex Example.txt', data: chatText(syntheticChat(2, { label: 'alex' }), { style: 'android-24-dmy' }), method: 'stored' },
    ]));
    const { connector } = connectorFor(dir, ['all chats.zip'], { pageSize: 2 });
    const { items, cursors } = await listAll(connector);
    expect(items.map((item) => item.metadata.chat)).toEqual(['Sam Example', 'Sam Example', 'Sam Example', 'Alex Example', 'Alex Example']);
    expect(new Set(items.map((item) => item.identity.providerThreadId)).size).toBe(2);
    const passes = await listInPasses(dir, ['all chats.zip'], 2, { pageSize: 2 });
    expect(passes.items.map((item) => item.identity.providerItemId)).toEqual(items.map((item) => item.identity.providerItemId));
    expect(cursors.length).toBeGreaterThan(1);
  });

  test('a zip of iOS exports in their own folders: each _chat.txt is the chat its folder names, and alike messages in two chats are two items', async () => {
    const dir = workDir();
    // The same lines in both chats: one identity per chat, so neither chat's messages are taken for repeats of the other's.
    const same = chatText(syntheticChat(3, { label: 'same' }), { style: 'ios-24-dmy' });
    put(dir, 'chats.zip', buildZip([
      { name: 'WhatsApp Chat - Alice Example/_chat.txt', data: same, method: 'deflate' },
      { name: 'WhatsApp Chat - Bob Example/_chat.txt', data: same, method: 'stored' },
      { name: 'Carol/_chat.txt', data: same, method: 'deflate' },
      { name: 'Dan/_chat.txt', data: same, method: 'deflate' },
    ]));
    const { connector, findings } = connectorFor(dir, ['chats.zip']);
    const { items } = await listAll(connector);
    expect([...new Set(items.map((item) => item.metadata.chat))]).toEqual(['Alice Example', 'Bob Example', 'Carol', 'Dan']);
    expect(items).toHaveLength(12);
    expect(new Set(items.map((item) => item.identity.providerThreadId)).size).toBe(4);
    expect(new Set(items.map((item) => item.identity.providerItemId)).size).toBe(12);
    expect(kinds(findings, 'skipped')[ARCHIVE_COMMON_FINDINGS.itemRepeated]).toBeUndefined();
  });

  test('one iOS export in a folder of a zip named for its chat keeps the zip\'s chat name', async () => {
    const dir = workDir();
    put(dir, 'WhatsApp Chat - Harbour crew.zip', buildZip([{ name: 'Export/_chat.txt', data: chatText(syntheticChat(2), { style: 'ios-24-dmy' }), method: 'deflate' }]));
    const { connector } = connectorFor(dir, ['WhatsApp Chat - Harbour crew.zip']);
    const { items } = await listAll(connector);
    expect(items.map((item) => item.metadata.chat)).toEqual(['Harbour crew', 'Harbour crew']);
  });

  test('a chosen zip whose _chat.txt is not a chat still reads the chat beside it that made it an export', async () => {
    const dir = workDir();
    put(dir, 'export.zip', buildZip([
      { name: '_chat.txt', data: 'Shopping list\nmilk\neggs\n', method: 'deflate' },
      { name: 'renamed.txt', data: chatText(syntheticChat(4), { style: 'ios-24-dmy' }), method: 'deflate' },
    ]));
    expect(detect(dir, 'export.zip').kind).toBe('match');
    const { connector } = connectorFor(dir, ['export.zip']);
    const { items } = await listAll(connector);
    expect(items).toHaveLength(4);
    expect(items.every((item) => item.metadata.sourceMember === 'renamed.txt')).toBe(true);
  });

  test('a member that cannot be read is told as a gap and the others are read', async () => {
    const dir = workDir();
    const good = chatText(syntheticChat(3), { style: 'android-24-dmy' });
    put(dir, 'mixed.zip', buildZip([
      { name: 'WhatsApp Chat with Locked.txt', data: good, method: 'deflate', encrypted: true },
      { name: 'WhatsApp Chat with Odd.txt', data: good, method: 'stored', methodNumber: 99 },
      { name: 'WhatsApp Chat with Fine.txt', data: good, method: 'deflate' },
      { name: 'WhatsApp Chat with Cut.txt', data: good, method: 'deflate', rawCompressed: new Uint8Array([0xff, 0xff, 0xff, 0xff]) },
    ]));
    const { connector, findings } = connectorFor(dir, ['mixed.zip']);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items).toHaveLength(3);
    expect(items.every((item) => item.metadata.chat === 'Fine')).toBe(true);
    const gaps = kinds(findings, 'gap');
    expect(gaps[ARCHIVE_COMMON_FINDINGS.sectionNotImported]).toBe(2);
    expect(gaps[ARCHIVE_COMMON_FINDINGS.fileDamaged]).toBe(1);
  });

  test('a zip whose members changed since it was approved stops the listing', async () => {
    const dir = workDir();
    const path = put(dir, 'chat.zip', chatZip(chatText(syntheticChat(3), { style: 'ios-24-dmy' })));
    const built = connectorFor(dir, ['chat.zip']);
    // Same size, different member table: the version check or the table check stops it.
    writeFileSync(path, chatZip(chatText(syntheticChat(3, { label: 'other' }), { style: 'ios-24-dmy' })));
    await expect(listAll(built.connector)).rejects.toBeInstanceOf(ArchiveImportStoppedError);
  });

  test('an archive whose last file holds no chat still ends with a done page', async () => {
    const dir = workDir();
    put(dir, 'a_chat.txt', chatText(syntheticChat(2), { style: 'ios-24-dmy' }));
    put(dir, 'b.zip', buildZip([{ name: 'x.jpg', data: 'x' }]));
    const { connector } = connectorFor(dir, ['a_chat.txt', 'b.zip']);
    const { items, done } = await listAll(connector);
    expect(items).toHaveLength(2);
    expect(done).toBe(true);
    const resumed = await listInPasses(dir, ['a_chat.txt', 'b.zip'], 1);
    expect(resumed.items).toHaveLength(2);
  });
});

describe('whatsapp overlapping exports', () => {
  test('a .txt and a .zip of one chat give a message the same identity, so it is one item; an edited message is its own', async () => {
    const dir = workDir();
    const base = syntheticChat(12);
    // The later export has one message that reads differently, and two more at the end.
    const later = base.map((message, index) => index === 5 ? { ...message, text: `${message.text} (edited)` } : message)
      .concat(syntheticChat(2, { start: '2026-03-01T10:00:00', label: 'new' }));
    const files = ['WhatsApp Chat with Harbour crew.txt', 'WhatsApp Chat with Harbour crew.zip'];
    put(dir, files[0]!, chatText(base, { style: 'android-24-dmy' }));
    put(dir, files[1]!, chatZip(chatText(later, { style: 'android-24-dmy' }), { media: mediaNames(2) }));
    const { items } = await listAll(connectorFor(dir, files).connector);
    // The listing still yields every message of both files; the import stores each identity once.
    expect(items).toHaveLength(12 + 14);
    const fromText = items.slice(0, 12);
    const fromZip = items.slice(12);
    for (let index = 0; index < 12; index += 1) {
      if (index === 5) {
        expect(fromZip[index]!.identity.providerItemId).not.toBe(fromText[index]!.identity.providerItemId);
      } else {
        expect(fromZip[index]!.identity.providerItemId).toBe(fromText[index]!.identity.providerItemId);
        expect(fromZip[index]!.identity.localItemId).toBe(fromText[index]!.identity.localItemId);
      }
    }
    // 12 messages of the first export, the edited one, and the two new ones: the other 11 are shared.
    expect(new Set(items.map((item) => item.identity.providerItemId)).size).toBe(15);
    // Both versions of the edited message are items, with the export each was read from.
    const fives = items.filter((item) => textOf(item).includes('entry 5.'));
    expect(fives.map(textOf).sort()).toEqual(['The synthetic harbour log, entry 5.', 'The synthetic harbour log, entry 5. (edited)'].sort());
    expect(fives.map((item) => item.metadata.sourceFile).sort()).toEqual([...files].sort());
    // One chat: one thread.
    expect(new Set(items.map((item) => item.identity.providerThreadId)).size).toBe(1);
    // A pass-by-pass listing keeps the same identities.
    const passes = await listInPasses(dir, files, 7, { pageSize: 5 });
    expect(passes.items.map((item) => item.identity.providerItemId)).toEqual(items.map((item) => item.identity.providerItemId));
  });

  test('alike messages at one time are numbered the same way in each export, so they pair off one to one', async () => {
    const dir = workDir();
    const same: SyntheticMessage = { at: '2026-05-14T10:00:00', sender: 'Sam Example', text: 'ok' };
    const text = chatText([same, same, same, { at: '2026-05-14T10:05:00', sender: 'Alex Example', text: 'later' }], { style: 'android-24-dmy' });
    const files = ['WhatsApp Chat with Harbour crew.txt', 'WhatsApp Chat with Harbour crew.zip'];
    put(dir, files[0]!, text);
    put(dir, files[1]!, chatZip(text));
    const { items } = await listAll(connectorFor(dir, files).connector);
    const ids = items.map((item) => item.identity.providerItemId);
    expect(ids.slice(0, 4)).toEqual(ids.slice(4));
    expect(new Set(ids).size).toBe(4);
  });

  test('a message is the same whichever export it came in, but a different chat, sender or time is another message', async () => {
    const dir = workDir();
    const line = { at: '2026-05-14T10:00:00', sender: 'Sam Example', text: 'ok' };
    const otherChat = 'WhatsApp Chat with Other crew.txt';
    put(dir, 'WhatsApp Chat with Harbour crew.txt', chatText([line, { ...line, sender: 'Alex Example' }, { ...line, at: '2026-05-14T10:01:00' }], { style: 'android-24-dmy' }));
    put(dir, otherChat, chatText([line], { style: 'android-24-dmy' }));
    const { items } = await listAll(connectorFor(dir, ['WhatsApp Chat with Harbour crew.txt', otherChat]).connector);
    expect(new Set(items.map((item) => item.identity.providerItemId)).size).toBe(4);
  });
});

// --- On the shared spine --------------------------------------------------------

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'archive-whatsapp-life-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const env = { HOME: base, XDG_DATA_HOME: join(base, 'xdg'), OPENCLAW_STATE_DIR: join(base, 'openclaw'), OLYMPUS_WHATSAPP_STATE_DIR: join(base, 'whatsapp-live') };
  const exports = join(base, 'exports');
  mkdirSync(exports);
  const runtime = createArchiveImportRuntime({
    env,
    statePath: join(base, 'xdg', 'archive-imports.json'),
    waitingQuestionsDbPath: join(base, 'waiting-private-questions.sqlite'),
    openSecretLocations: (secureDbPath) => new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(secureDbPath) }),
  });
  cleanups.push(() => {
    for (const lane of runtime.existingLanes()) {
      for (const store of lane.set.openStores()) store.close();
      lane.secretLocations?.close();
      lane.ledger.close();
    }
  });
  const start = (path: string): string => {
    const started = runtime.start(path);
    if (started.kind !== 'started') throw new Error(`expected a start, got ${started.kind}`);
    return started.archive.archive_id;
  };
  return { base, env, exports, runtime, start };
}

function pull(runtime: ArchiveImportRuntime, archiveId: string, options: Partial<ArchiveImportPullOptions> = {}) {
  return pullArchiveImport({ state: runtime.state, lane: runtime.lane('chat'), archiveId, ...options });
}

async function importAll(runtime: ArchiveImportRuntime, archiveId: string, options: Partial<ArchiveImportPullOptions> = {}) {
  for (let pass = 0; pass < 80; pass += 1) {
    const outcome = await pull(runtime, archiveId, options);
    if (!outcome.continueSoon) return outcome;
  }
  throw new Error('the import did not finish');
}

/** Distinct items an archive holds across the chat family's stores (an item may be in more than one). */
function rowsOf(env: Record<string, string>, scope: string): Array<{ provider: string; id: string; conversation: string | null; authoredAt: string | null }> {
  const rows = new Map<string, { provider: string; id: string; conversation: string | null; authoredAt: string | null }>();
  for (const domain of ['public_safe', 'internal', 'secure_local'] as const) {
    const path = archiveConnectorStoreDbPath(domain, 'chat', env);
    if (!existsSync(path)) continue;
    const db = new Database(path, { readonly: true });
    try {
      const found = db.query('SELECT provider, provider_item_id, provider_conversation_id, authored_at FROM items WHERE account_scope = ?').all(scope) as Array<{ provider: string; provider_item_id: string; provider_conversation_id: string | null; authored_at: string | null }>;
      for (const row of found) {
        rows.set(row.provider_item_id, { provider: row.provider, id: row.provider_item_id, conversation: row.provider_conversation_id, authoredAt: row.authored_at });
      }
    } finally {
      db.close();
    }
  }
  return [...rows.values()];
}

describe('whatsapp archive on the shared spine', () => {
  test('a folder of exports imports every chat in it through detection, held Private, with its dates and counts', async () => {
    const f = fixture();
    const folder = join(f.exports, 'WhatsApp exports');
    mkdirSync(folder);
    const messages: SyntheticMessage[] = [
      notice('2026-02-14T09:00:00'),
      ...syntheticChat(5, { start: '2026-02-14T09:01:00' }).map((message, index) => index === 2 ? { ...message, text: `<attached: ${mediaNames(1)[0]}>` } : message),
    ];
    put(folder, '_chat.txt', chatText(messages, { style: 'ios-24-dmy' }));
    put(folder, 'WhatsApp Chat with Alex Example.zip', chatZip(chatText(syntheticChat(4, { start: '2026-03-15T09:00:00', label: 'zip' }), { style: 'android-24-dmy' }), { media: mediaNames(3, 'android') }));
    put(folder, 'photo.jpg', 'not part of it');
    const archiveId = f.start(folder);
    const started = f.runtime.state.get(archiveId)!;
    expect(started).toMatchObject({ format: 'whatsapp_chat', provider: 'whatsapp_export', family: 'chat' });
    expect(started.files.map((file) => file.rel_path)).toEqual(['WhatsApp Chat with Alex Example.zip', '_chat.txt']);

    const outcome = await importAll(f.runtime, archiveId, { pageSize: 3, maxItems: 4 });
    expect(outcome.receipt.counts.traversal_complete).toBe(1);
    const record = f.runtime.state.get(archiveId)!;
    expect(record.status).toBe('imported');
    expect(record.findings.skipped).toEqual({ [WHATSAPP_FINDINGS.systemMessage]: 1 });
    expect(record.findings.gaps).toEqual({ [ARCHIVE_COMMON_FINDINGS.timeZoneAssumed]: 1, [ARCHIVE_COMMON_FINDINGS.mediaNotImported]: 1 });
    expect(record.date_range).toEqual({ earliest: localIso('2026-02-14T09:01:00'), latest: localIso('2026-03-15T09:21:00') });

    const rows = rowsOf(f.env, archiveId);
    expect(rows).toHaveLength(9);
    expect(new Set(rows.map((row) => row.provider))).toEqual(new Set(['whatsapp_export']));
    expect(new Set(rows.map((row) => row.conversation)).size).toBe(2);
    expect(rows.every((row) => row.authoredAt !== null)).toBe(true);
    // The private model is stopped here: every message's content waits in the Private store, none is in the others.
    const secure = new Database(archiveConnectorStoreDbPath('secure_local', 'chat', f.env), { readonly: true });
    try {
      const held = secure.query(`
        SELECT COUNT(DISTINCT i.item_pk) AS n FROM chunks c JOIN items i ON i.item_pk = c.item_pk
        WHERE i.account_scope = ? AND c.bounded_text LIKE '%synthetic%'
      `).get(archiveId) as { n: number };
      expect(held.n).toBe(8);
    } finally {
      secure.close();
    }
    for (const domain of ['internal', 'public_safe'] as const) {
      const path = archiveConnectorStoreDbPath(domain, 'chat', f.env);
      if (!existsSync(path)) continue;
      const db = new Database(path, { readonly: true });
      try {
        const chunks = db.query('SELECT c.bounded_text AS text FROM chunks c JOIN items i ON i.item_pk = c.item_pk WHERE i.account_scope = ?').all(archiveId) as Array<{ text: string }>;
        expect(chunks.filter((chunk) => chunk.text.includes('synthetic'))).toEqual([]);
        expect((db.query('SELECT COUNT(*) AS n FROM chunk_embeddings').get() as { n: number }).n).toBe(0);
      } finally {
        db.close();
      }
    }
    const lane = f.runtime.lane('chat');
    expect(lane.ledger.accountScopeCounts('whatsapp_export', archiveId)).toMatchObject({ items: 9, awaitingJudgment: 9 });
  });

  test('a crash between a page and the pass that records it counts every finding once and stores every message once', async () => {
    const f = fixture();
    const messages: SyntheticMessage[] = [];
    for (let index = 0; index < 30; index += 1) {
      messages.push(...syntheticChat(1, { start: `2026-02-${String(10 + (index % 18)).padStart(2, '0')}T0${index % 10}:00:00`, label: `n${index}` }));
      if (index % 5 === 0) messages.push(notice(`2026-02-${String(10 + (index % 18)).padStart(2, '0')}T0${index % 10}:00:30`));
      if (index % 7 === 0) messages.push({ at: `2026-02-${String(10 + (index % 18)).padStart(2, '0')}T0${index % 10}:00:40`, sender: 'Sam Example', text: '<Media omitted>' });
    }
    put(f.exports, '_chat.txt', chatText(messages, { style: 'android-24-dmy' }));
    const archiveId = f.start(join(f.exports, '_chat.txt'));

    const dying = (): ((formatId: string) => ArchiveConnectorFactory) => () => (input) => {
      const real = createWhatsAppArchiveConnector(input);
      const connector: SourceConnector = {
        ...real,
        listItems(options) {
          return (async function* (): AsyncGenerator<SourceConnectorListPage> {
            let pages = 0;
            for await (const page of real.listItems(options)) {
              if (pages > 1) throw new Error('synthetic crash');
              pages += 1;
              yield page;
            }
          })();
        },
      };
      return connector;
    };
    await expect(pull(f.runtime, archiveId, { pageSize: 4, connectorFactory: dying() })).rejects.toThrow('synthetic crash');
    await importAll(f.runtime, archiveId, { pageSize: 4, maxItems: 9 });
    const record = f.runtime.state.get(archiveId)!;
    expect(record.status).toBe('imported');
    expect(rowsOf(f.env, archiveId)).toHaveLength(30 + Math.ceil(30 / 7));
    expect(record.findings.skipped).toEqual({ [WHATSAPP_FINDINGS.systemMessage]: 6 });
    // The zone, and the one message dated before the message above it (the fixture's days wrap round at the 19th message).
    expect(record.findings.gaps).toEqual({
      [ARCHIVE_COMMON_FINDINGS.timeZoneAssumed]: 1,
      [ARCHIVE_COMMON_FINDINGS.itemStartAssumed]: 1,
      [ARCHIVE_COMMON_FINDINGS.mediaNotImported]: 5,
    });
  });

  test('a crash after a page of notices was counted, and a restart whose pages are longer, count every notice once', async () => {
    const f = fixture();
    // A notice before each of 24 messages: every page's notices are one tally, whatever the page is.
    const pad2 = (value: number) => String(value).padStart(2, '0');
    const clock = (minute: number) => `2026-02-14T${pad2(Math.floor(minute / 60))}:${pad2(minute % 60)}:00`;
    const messages: SyntheticMessage[] = [];
    for (let index = 0; index < 24; index += 1) {
      messages.push(notice(clock(480 + index * 10)));
      messages.push({ at: clock(485 + index * 10), sender: 'Sam Example', text: `The synthetic harbour log, entry ${index}.` });
    }
    put(f.exports, '_chat.txt', chatText(messages, { style: 'android-24-dmy' }));
    const archiveId = f.start(join(f.exports, '_chat.txt'));
    const dying = (): ((formatId: string) => ArchiveConnectorFactory) => () => (input) => {
      const real = createWhatsAppArchiveConnector(input);
      const connector: SourceConnector = {
        ...real,
        listItems(options) {
          return (async function* (): AsyncGenerator<SourceConnectorListPage> {
            let pages = 0;
            for await (const page of real.listItems(options)) {
              // The first page, four messages and the four notices before them, is counted; then the pass dies before its cursor is kept.
              if (pages > 0) throw new Error('synthetic crash');
              pages += 1;
              yield page;
            }
          })();
        },
      };
      return connector;
    };
    await expect(pull(f.runtime, archiveId, { pageSize: 4, connectorFactory: dying() })).rejects.toThrow('synthetic crash');
    expect(f.runtime.state.get(archiveId)!.findings.skipped).toEqual({ [WHATSAPP_FINDINGS.systemMessage]: 4 });
    // The restart lists the same messages in pages of eight: the first page holds the four counted notices and four that were not.
    await importAll(f.runtime, archiveId, { pageSize: 8 });
    const record = f.runtime.state.get(archiveId)!;
    expect(record.status).toBe('imported');
    expect(rowsOf(f.env, archiveId)).toHaveLength(24);
    expect(record.findings.skipped).toEqual({ [WHATSAPP_FINDINGS.systemMessage]: 24 });
  });

  test('an overlapping .txt and .zip of one chat import each message once, and the overlap is counted', async () => {
    const f = fixture();
    const folder = join(f.exports, 'both');
    mkdirSync(folder);
    const base = syntheticChat(10);
    const later = base.map((message, index) => index === 3 ? { ...message, text: `${message.text} (changed)` } : message);
    put(folder, 'WhatsApp Chat with Harbour crew.txt', chatText(base, { style: 'android-24-dmy' }));
    put(folder, 'WhatsApp Chat with Harbour crew.zip', chatZip(chatText(later, { style: 'android-24-dmy' })));
    const archiveId = f.start(folder);
    await importAll(f.runtime, archiveId, { pageSize: 3, maxItems: 6 });
    const rows = rowsOf(f.env, archiveId);
    // Ten messages, and the one the later export wrote differently.
    expect(rows).toHaveLength(11);
    expect(new Set(rows.map((row) => row.conversation)).size).toBe(1);
    const record = f.runtime.state.get(archiveId)!;
    expect(record.status).toBe('imported');
    expect(record.findings.skipped).toEqual({ [ARCHIVE_COMMON_FINDINGS.itemRepeated]: 9 });
    expect(f.runtime.lane('chat').ledger.accountScopeCounts('whatsapp_export', archiveId)).toMatchObject({ items: 11 });
  });

  test('one export alone counts no overlap, and the same archive imported in other page sizes counts the same', async () => {
    const f = fixture();
    const folder = join(f.exports, 'one');
    mkdirSync(folder);
    put(folder, 'WhatsApp Chat with Harbour crew.txt', chatText(syntheticChat(10), { style: 'android-24-dmy' }));
    const archiveId = f.start(folder);
    await importAll(f.runtime, archiveId, { pageSize: 4, maxItems: 5 });
    expect(f.runtime.state.get(archiveId)!.findings.skipped).toEqual({});
    expect(rowsOf(f.env, archiveId)).toHaveLength(10);
  });

  test('a crash after the overlap was met, and a restart, count it once and store every message once', async () => {
    const f = fixture();
    const folder = join(f.exports, 'both');
    mkdirSync(folder);
    const base = syntheticChat(10);
    put(folder, 'WhatsApp Chat with Harbour crew.txt', chatText(base, { style: 'android-24-dmy' }));
    put(folder, 'WhatsApp Chat with Harbour crew.zip', chatZip(chatText(base.concat(syntheticChat(2, { start: '2026-03-01T10:00:00', label: 'new' })), { style: 'android-24-dmy' })));
    const archiveId = f.start(folder);
    const dying = (): ((formatId: string) => ArchiveConnectorFactory) => () => (input) => {
      const real = createWhatsAppArchiveConnector(input);
      const connector: SourceConnector = {
        ...real,
        listItems(options) {
          return (async function* (): AsyncGenerator<SourceConnectorListPage> {
            let pages = 0;
            for await (const page of real.listItems(options)) {
              // The text file is three pages (4, 4, 2); the zip's first two pages are in the overlap.
              if (pages > 4) throw new Error('synthetic crash');
              pages += 1;
              yield page;
            }
          })();
        },
      };
      return connector;
    };
    await expect(pull(f.runtime, archiveId, { pageSize: 4, connectorFactory: dying() })).rejects.toThrow('synthetic crash');
    await importAll(f.runtime, archiveId, { pageSize: 4, maxItems: 9 });
    const record = f.runtime.state.get(archiveId)!;
    expect(record.status).toBe('imported');
    expect(rowsOf(f.env, archiveId)).toHaveLength(12);
    expect(record.findings.skipped).toEqual({ [ARCHIVE_COMMON_FINDINGS.itemRepeated]: 10 });
  });

  test('a crash after some of the overlap was counted, and a restart that cuts its pages differently, count each repeat once', async () => {
    const f = fixture();
    const folder = join(f.exports, 'both');
    mkdirSync(folder);
    const base = syntheticChat(10);
    put(folder, 'WhatsApp Chat with Harbour crew.txt', chatText(base, { style: 'android-24-dmy' }));
    put(folder, 'WhatsApp Chat with Harbour crew.zip', chatZip(chatText(base.concat(syntheticChat(2, { start: '2026-03-01T10:00:00', label: 'new' })), { style: 'android-24-dmy' })));
    const archiveId = f.start(folder);
    const dying = (): ((formatId: string) => ArchiveConnectorFactory) => () => (input) => {
      const real = createWhatsAppArchiveConnector(input);
      const connector: SourceConnector = {
        ...real,
        listItems(options) {
          return (async function* (): AsyncGenerator<SourceConnectorListPage> {
            let pages = 0;
            for await (const page of real.listItems(options)) {
              // The text file is three pages (4, 4, 2); the zip's first two pages, eight messages, are counted before the crash.
              if (pages > 4) throw new Error('synthetic crash');
              pages += 1;
              yield page;
            }
          })();
        },
      };
      return connector;
    };
    await expect(pull(f.runtime, archiveId, { pageSize: 4, connectorFactory: dying() })).rejects.toThrow('synthetic crash');
    expect(f.runtime.state.get(archiveId)!.findings.skipped).toEqual({ [ARCHIVE_COMMON_FINDINGS.itemRepeated]: 8 });
    // The restart cuts the same messages into pages of five: two more of the overlap are met, not five.
    // One pass with room for all of it, so no pass boundary happens to fall where the counted overlap ends.
    await importAll(f.runtime, archiveId, { pageSize: 5 });
    const record = f.runtime.state.get(archiveId)!;
    expect(record.status).toBe('imported');
    expect(rowsOf(f.env, archiveId)).toHaveLength(12);
    expect(record.findings.skipped).toEqual({ [ARCHIVE_COMMON_FINDINGS.itemRepeated]: 10 });
  });

  test('a zip whose text files the first look did not all read says how many it did not, when nothing there names the export', async () => {
    const f = fixture();
    // A chat saved under another name among 43 other text files: the first look reads 32 text files of a zip.
    const memos = (count: number, from: number) => Array.from({ length: count }, (_, index) => ({ name: `memos/memo-${String(from + index).padStart(2, '0')}.txt`, data: 'shopping list\nmilk\n' }));
    put(f.exports, 'Saved chats.zip', buildZip([...memos(3, 0), { name: 'my chat.txt', data: chatText(syntheticChat(4), { style: 'ios-24-dmy' }), method: 'deflate' as const }, ...memos(40, 3)]));
    const archiveId = f.start(join(f.exports, 'Saved chats.zip'));
    // 44 text files, 32 of them read.
    expect(f.runtime.state.get(archiveId)!.findings.skipped).toEqual({ [ARCHIVE_COMMON_FINDINGS.filesNotLookedAt]: 12 });
    // When the export is among those not read, the refusal says the look was not complete.
    put(f.exports, 'Hidden chat.zip', buildZip([...memos(40, 0), { name: 'my chat.txt', data: chatText(syntheticChat(4), { style: 'ios-24-dmy' }), method: 'deflate' as const }]));
    const refused = f.runtime.start(join(f.exports, 'Hidden chat.zip'));
    expect(refused.kind).toBe('unsupported');
    if (refused.kind === 'unsupported') expect(refused.advice).toContain(ARCHIVE_LOOK_INCOMPLETE_ADVICE);
    // A zip with the export named as WhatsApp names it says nothing of the files beside it.
    put(f.exports, 'Named chat.zip', buildZip([...memos(40, 0), { name: '_chat.txt', data: chatText(syntheticChat(4), { style: 'ios-24-dmy' }), method: 'deflate' as const }]));
    const named = f.start(join(f.exports, 'Named chat.zip'));
    expect(f.runtime.state.get(named)!.findings.skipped).toEqual({});
  });

  test('files that look like exports but are not named like one are left out and counted on the record', async () => {
    const f = fixture();
    const folder = join(f.exports, 'mixed');
    mkdirSync(folder);
    const buildLog = '2026-10-24, 10:00 - build: succeeded\n2026-10-24, 10:01 - tests: passed\n';
    put(folder, '_chat.txt', chatText(syntheticChat(3), { style: 'ios-24-dmy' }));
    put(folder, 'build.txt', buildLog);
    put(folder, 'whatsapp-debug.zip', buildZip([{ name: 'whatsapp-debug.txt', data: buildLog }]));
    const archiveId = f.start(folder);
    const started = f.runtime.state.get(archiveId)!;
    expect(started.files.map((file) => file.rel_path)).toEqual(['_chat.txt']);
    expect(started.findings.skipped).toEqual({ [ARCHIVE_COMMON_FINDINGS.filesUnconfirmed]: 2 });
    await importAll(f.runtime, archiveId);
    const record = f.runtime.state.get(archiveId)!;
    expect(record.findings.skipped).toEqual({ [ARCHIVE_COMMON_FINDINGS.filesUnconfirmed]: 2 });
    expect(rowsOf(f.env, archiveId)).toHaveLength(3);
  });

  test('a folder with more exports named for WhatsApp than the first look takes in says how many it did not look at', async () => {
    const f = fixture();
    const folder = join(f.exports, 'many');
    mkdirSync(folder);
    const total = ARCHIVE_PROBE_MAX_CHILDREN + ARCHIVE_PROBE_MAX_NAMED + 5;
    const one = chatText(syntheticChat(1), { style: 'android-24-dmy' });
    for (let index = 0; index < total; index += 1) put(folder, `WhatsApp Chat with Friend ${String(index).padStart(4, '0')}.txt`, one);
    const archiveId = f.start(folder);
    const started = f.runtime.state.get(archiveId)!;
    expect(started.files).toHaveLength(ARCHIVE_PROBE_MAX_CHILDREN + ARCHIVE_PROBE_MAX_NAMED);
    expect(started.findings.skipped).toEqual({ [ARCHIVE_COMMON_FINDINGS.filesNotLookedAt]: 5 });
  }, 60_000);

  test('a file that changed mid-import stops it and says which', async () => {
    const f = fixture();
    const path = put(f.exports, '_chat.txt', chatText(syntheticChat(30), { style: 'ios-24-dmy' }));
    const archiveId = f.start(path);
    expect((await pull(f.runtime, archiveId, { pageSize: 5, maxItems: 5 })).continueSoon).toBe(true);
    appendFileSync(path, chatText(syntheticChat(1, { label: 'late' }), { style: 'ios-24-dmy' }));
    const stopped = await pull(f.runtime, archiveId);
    expect(stopped.receipt.counts.import_stopped).toBe(1);
    expect(f.runtime.state.get(archiveId)).toMatchObject({ status: 'stopped', stop: { code: 'file_changed', rel_path: '_chat.txt' } });
  });

  test('removing an archive leaves another archive, and live WhatsApp capture, as they were; the import never opens live capture', async () => {
    const f = fixture();
    // Live capture's own store, written by the live sync from a spool, before and apart from any import.
    const liveState = f.env.OLYMPUS_WHATSAPP_STATE_DIR;
    const liveDb = join(liveState, 'connector-store.db');
    mkdirSync(join(liveState, 'spool'), { recursive: true });
    writeFileSync(join(liveState, 'spool', '2026-07-05.jsonl'), ['l1', 'l2', 'l3'].map((id) => `${JSON.stringify({
      id, chat_jid: 'chat-1@s.whatsapp.net', chat_name: 'Ada', sender_jid: 'sender-1@s.whatsapp.net', sender_name: 'Ada',
      from_me: false, timestamp: '2026-07-05T10:00:00Z', text: `live message ${id}`,
    })}\n`).join(''));
    const live = Bun.spawnSync([process.execPath, join(import.meta.dir, '..', 'scripts', 'whatsapp-live-sync.ts'), '--db', liveDb, '--account', 'personal'], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, ...f.env },
    });
    expect(live.exitCode).toBe(0);
    const liveFiles = (): string[] => readdirSync(liveState, { recursive: true }).map(String).sort();
    const liveBefore = { files: liveFiles(), digest: createHash('sha256').update(readFileSync(liveDb)).digest('hex'), size: statSync(liveDb).size };
    const liveCount = (): number => {
      const db = new Database(liveDb, { readonly: true });
      try {
        return (db.query("SELECT COUNT(*) AS n FROM items WHERE provider = 'whatsapp'").get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    expect(liveCount()).toBe(3);

    const removed = f.start(put(f.exports, 'WhatsApp Chat with Removed.txt', chatText(syntheticChat(6, { label: 'removed' }), { style: 'android-24-dmy' })));
    const kept = f.start(put(f.exports, 'WhatsApp Chat with Kept.txt', chatText(syntheticChat(5, { label: 'kept' }), { style: 'android-24-dmy' })));
    await importAll(f.runtime, removed);
    await importAll(f.runtime, kept);
    expect(rowsOf(f.env, removed)).toHaveLength(6);
    expect(rowsOf(f.env, kept)).toHaveLength(5);
    // The import wrote nothing in live capture's folder and its store is byte for byte as it was.
    expect(liveFiles()).toEqual(liveBefore.files);
    expect(createHash('sha256').update(readFileSync(liveDb)).digest('hex')).toBe(liveBefore.digest);

    requestArchiveRemoval(f.runtime.state, removed);
    const lane = f.runtime.lane('chat');
    let outcome = await runArchiveRemoval({ state: f.runtime.state, lane, archiveId: removed, openWaitingQuestions: () => f.runtime.openWaitingQuestions() });
    for (let run = 0; run < 30 && outcome.kind === 'progress'; run += 1) {
      outcome = await runArchiveRemoval({ state: f.runtime.state, lane, archiveId: removed, openWaitingQuestions: () => f.runtime.openWaitingQuestions() });
    }
    expect(outcome.kind).toBe('removed');
    expect(lane.ledger.accountScopeCounts('whatsapp_export', removed).items).toBe(0);
    expect(rowsOf(f.env, removed)).toHaveLength(0);
    expect(rowsOf(f.env, kept)).toHaveLength(5);
    expect(lane.ledger.accountScopeCounts('whatsapp_export', kept).items).toBe(5);
    // Live capture still has its three messages, in the same store, untouched.
    expect(liveCount()).toBe(3);
    expect(liveFiles()).toEqual(liveBefore.files);
    expect(createHash('sha256').update(readFileSync(liveDb)).digest('hex')).toBe(liveBefore.digest);
    expect(statSync(liveDb).size).toBe(liveBefore.size);
    // The archive's stores are its own: the lane's paths are the archive family's, not the live ones
    // (the legacy archive-chat store, or the archive account's own folder on a fresh install).
    for (const path of archiveConnectorStoreDbPaths(['chat'], f.env)) {
      expect(/archive-chat|[\\/]archive\.imports[\\/]/.test(path)).toBe(true);
      expect(resolve(path)).not.toBe(resolve(liveDb));
    }
  }, 60_000);

  test('the archive import code reaches no live capture code: no import of the live folder, store or spool', () => {
    const root = join(import.meta.dir, '..', 'src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) files.push(path);
      }
    };
    walk(join(root, 'workers', 'archive-import'));
    const live = join(root, 'workers', 'whatsapp');
    const reached: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
        const specifier = match[1]!;
        if (!specifier.startsWith('.')) continue;
        const target = resolve(dirname(file), specifier);
        if (target === live || target.startsWith(`${live}/`)) reached.push(`${relative(root, file)} -> ${specifier}`);
      }
      expect(source).not.toContain('whatsapp-live');
      expect(source).not.toContain('defaultWhatsAppConnectorStoreDbPath');
      expect(source).not.toContain('OLYMPUS_WHATSAPP_STATE_DIR');
    }
    expect(reached).toEqual([]);
  });

  test('the format grammar lives with the connector: core holds no WhatsApp parser and imports no worker', () => {
    const root = join(import.meta.dir, '..', 'src');
    expect(existsSync(join(root, 'core', 'whatsapp-export-grammar.ts'))).toBe(false);
    expect(existsSync(join(root, 'workers', 'archive-import', 'whatsapp', 'grammar.ts'))).toBe(true);
    const definitions = readFileSync(join(root, 'core', 'archive-formats.ts'), 'utf8');
    for (const grammar of ['matchWhatsAppHeader', 'resolveWhatsAppHeader', 'splitWhatsAppSender', 'whatsAppOrderEvidence', 'whatsAppMediaMarkerCount']) {
      expect(definitions).not.toContain(grammar);
    }
    const reached: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts')) {
          for (const match of readFileSync(path, 'utf8').matchAll(/(?:from|import\()\s*['"]([^'"]+)['"]/g)) {
            if (/workers\/archive-import\/whatsapp/.test(match[1]!)) reached.push(`${relative(root, path)} -> ${match[1]}`);
          }
        }
      }
    };
    walk(join(root, 'core'));
    expect(reached).toEqual([]);
  });
});
