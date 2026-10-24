// The unchecked-overlap finding at the engines that open zips: a zip too large
// to check for members that share bytes is reported once, by the shared helper,
// at the first place in its file, and an ordinary zip reports nothing. The big
// zips are real files (more members than ZIP_OVERLAP_SORT_MAX_ENTRIES, the
// directory in the reverse of the file's order), read through the scope-safe
// reader the way a pass reads them.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARCHIVE_COMMON_FINDINGS, REFLECT_MARKDOWN_ARCHIVE_FORMAT, WHATSAPP_ARCHIVE_FORMAT, type ArchiveImportFinding } from '../src/core/archive-formats.ts';
import { archiveContinuations } from '../src/workers/archive-import/continuation-cache.ts';
import { createReflectMarkdownArchiveConnector } from '../src/workers/archive-import/reflect/connector.ts';
import { createWhatsAppArchiveConnector } from '../src/workers/archive-import/whatsapp/connector.ts';
import { ZIP_OVERLAP_SORT_MAX_ENTRIES } from '../src/workers/archive-import/zip-reader.ts';
import { referenceCrc32 } from './helpers/zip-fixture.ts';
import { reflectDailyName, reflectMarkdown, reflectMarkdownZip } from './support/archive-fixtures-reflect.ts';
import { chatText, chatZip, mediaNames, syntheticChat } from './support/archive-fixtures-whatsapp.ts';
import { listAll, openConnector, tempFolder, writeExport } from './support/archive-notes-harness.ts';

// Writing a zip of more than 262,144 members takes a few seconds.
setDefaultTimeout(120_000);

const cleanups: Array<() => void> = [];
afterEach(() => {
  archiveContinuations.clear();
  while (cleanups.length) cleanups.pop()!();
});

/**
 * A stored zip with zip64 end records: the `real` members first, then `fillers` one-byte members that are
 * neither notes nor chats. Written straight into one array (a zip this big built member by member from the
 * shared fixture takes gigabytes). `reversed` writes the directory in the opposite order to the file's, the
 * members staying where they are.
 */
function bigZip(real: ReadonlyArray<{ name: string; data: string }>, fillers: number, reversed: boolean): Uint8Array {
  const encoder = new TextEncoder();
  const fillerCrc = referenceCrc32(encoder.encode('x'));
  const members = [
    ...real.map((member) => {
      const data = encoder.encode(member.data);
      return { name: encoder.encode(member.name), data, crc: referenceCrc32(data) };
    }),
  ];
  const nameOf = (index: number): Uint8Array => encoder.encode(`files/f${String(index).padStart(7, '0')}.bin`);
  const fillerName = nameOf(0).length;
  const total = members.length + fillers;
  const bytes = (index: number): number => (index < members.length ? members[index]!.name.length + members[index]!.data.length : fillerName + 1);
  let filesSize = 0;
  let directorySize = 0;
  for (let index = 0; index < total; index += 1) {
    filesSize += 30 + bytes(index);
    directorySize += 46 + (index < members.length ? members[index]!.name.length : fillerName);
  }
  const out = new Uint8Array(filesSize + directorySize + 56 + 20 + 22);
  const view = new DataView(out.buffer);
  const starts: number[] = [];
  let at = 0;
  const memberAt = (index: number) => {
    if (index < members.length) return members[index]!;
    return { name: nameOf(index - members.length), data: encoder.encode('x'), crc: fillerCrc };
  };
  for (let index = 0; index < total; index += 1) {
    const member = memberAt(index);
    starts.push(at);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 12, 0x21, true);
    view.setUint32(at + 14, member.crc, true);
    view.setUint32(at + 18, member.data.length, true);
    view.setUint32(at + 22, member.data.length, true);
    view.setUint16(at + 26, member.name.length, true);
    out.set(member.name, at + 30);
    out.set(member.data, at + 30 + member.name.length);
    at += 30 + member.name.length + member.data.length;
  }
  const directoryAt = at;
  for (let slot = 0; slot < total; slot += 1) {
    const index = reversed ? total - 1 - slot : slot;
    const member = memberAt(index);
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 14, 0x21, true);
    view.setUint32(at + 16, member.crc, true);
    view.setUint32(at + 20, member.data.length, true);
    view.setUint32(at + 24, member.data.length, true);
    view.setUint16(at + 28, member.name.length, true);
    view.setUint32(at + 42, starts[index]!, true);
    out.set(member.name, at + 46);
    at += 46 + member.name.length;
  }
  const recordAt = at;
  view.setUint32(at, 0x06064b50, true);
  view.setBigUint64(at + 4, 44n, true);
  view.setUint16(at + 12, 45, true);
  view.setUint16(at + 14, 45, true);
  view.setBigUint64(at + 24, BigInt(total), true);
  view.setBigUint64(at + 32, BigInt(total), true);
  view.setBigUint64(at + 40, BigInt(directorySize), true);
  view.setBigUint64(at + 48, BigInt(directoryAt), true);
  view.setUint32(at + 56, 0x07064b50, true);
  view.setBigUint64(at + 56 + 8, BigInt(recordAt), true);
  view.setUint32(at + 56 + 16, 1, true);
  view.setUint32(at + 76, 0x06054b50, true);
  view.setUint16(at + 76 + 8, 0xffff, true);
  view.setUint16(at + 76 + 10, 0xffff, true);
  view.setUint32(at + 76 + 12, 0xffffffff, true);
  view.setUint32(at + 76 + 16, 0xffffffff, true);
  return out;
}

const overlapFindings = (findings: readonly ArchiveImportFinding[]) => findings.filter((finding) => finding.kind === ARCHIVE_COMMON_FINDINGS.zipOverlapUnchecked);

/** Each big zip is built once for the whole file. */
function once<T>(make: () => T): () => T {
  let made: T | undefined;
  return () => (made ??= make());
}

describe('a zip too large to check for shared bytes is reported once, by the engines that open zips', () => {
  const chat = chatText(syntheticChat(3), { style: 'ios-24-dmy' });
  const bigChat = once(() => bigZip([{ name: '_chat.txt', data: chat }], ZIP_OVERLAP_SORT_MAX_ENTRIES, true));
  const bigChatInOrder = once(() => bigZip([{ name: '_chat.txt', data: chat }], ZIP_OVERLAP_SORT_MAX_ENTRIES, false));
  const daily = reflectDailyName(new Date(Date.UTC(2023, 2, 21)));
  const bigNotes = once(() => bigZip([{ name: daily, data: reflectMarkdown({ body: 'A day', bare: true }) }], ZIP_OVERLAP_SORT_MAX_ENTRIES, true));

  test('a chat zip over the bound, directory out of order: one finding at the start of the file, and the chat still reads', async () => {
    const file = writeExport(cleanups, 'WhatsApp Chat with Sam Example.zip', bigChat());
    const { connector, findings } = openConnector(cleanups, file.dir, ['WhatsApp Chat with Sam Example.zip'], WHATSAPP_ARCHIVE_FORMAT, createWhatsAppArchiveConnector);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items.length).toBe(3);
    expect(overlapFindings(findings)).toEqual([{ kind: 'zip_overlap_unchecked', class: 'gap', fileIndex: 0, offset: 0, count: 1 }]);
  });

  test('a chat zip that is checked reports nothing: small, and over the bound but in file order', async () => {
    const small = writeExport(cleanups, 'WhatsApp Chat with Sam Example.zip', chatZip(chat, { media: mediaNames(20) }));
    const first = openConnector(cleanups, small.dir, ['WhatsApp Chat with Sam Example.zip'], WHATSAPP_ARCHIVE_FORMAT, createWhatsAppArchiveConnector);
    await listAll(first.connector);
    expect(overlapFindings(first.findings)).toEqual([]);
    const inOrder = writeExport(cleanups, 'WhatsApp Chat with Sam Example.zip', bigChatInOrder());
    const second = openConnector(cleanups, inOrder.dir, ['WhatsApp Chat with Sam Example.zip'], WHATSAPP_ARCHIVE_FORMAT, createWhatsAppArchiveConnector);
    const { items } = await listAll(second.connector);
    expect(items.length).toBe(3);
    expect(overlapFindings(second.findings)).toEqual([]);
  });

  test('two zips in one import: each reports its own, at its own file', async () => {
    const dir = tempFolder(cleanups);
    const names = ['WhatsApp Chat with Sam Example.zip', 'WhatsApp Chat with Robin Example.zip'];
    writeFileSync(join(dir, names[0]!), chatZip(chat));
    writeFileSync(join(dir, names[1]!), bigChat());
    const { connector, findings } = openConnector(cleanups, dir, names, WHATSAPP_ARCHIVE_FORMAT, createWhatsAppArchiveConnector);
    await listAll(connector);
    expect(overlapFindings(findings).map((finding) => finding.fileIndex)).toEqual([1]);
  });

  test('a notes zip over the bound, directory out of order: one finding at the start of the file, and its notes still read', async () => {
    const file = writeExport(cleanups, 'Reflect export.zip', bigNotes());
    const { connector, findings } = openConnector(cleanups, file.dir, ['Reflect export.zip'], REFLECT_MARKDOWN_ARCHIVE_FORMAT, createReflectMarkdownArchiveConnector);
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items.length).toBe(1);
    expect(overlapFindings(findings)).toEqual([{ kind: 'zip_overlap_unchecked', class: 'gap', fileIndex: 0, offset: 0, count: 1 }]);
  });

  test('a notes zip that is checked reports nothing', async () => {
    const file = writeExport(cleanups, 'Reflect export.zip', reflectMarkdownZip([{ name: daily, text: reflectMarkdown({ body: 'A day', bare: true }) }, { name: 'Ideas.md', text: reflectMarkdown({ body: 'x', bare: true }) }]));
    const { connector, findings } = openConnector(cleanups, file.dir, ['Reflect export.zip'], REFLECT_MARKDOWN_ARCHIVE_FORMAT, createReflectMarkdownArchiveConnector);
    const { items } = await listAll(connector);
    expect(items.length).toBe(2);
    expect(overlapFindings(findings)).toEqual([]);
  });
});
