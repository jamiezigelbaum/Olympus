/** Runtime-only, seeded synthetic archives. No fixture files belong in the checkout. */
import { fixtureToken, FIXTURE_FOLDER, type LegFixture } from './archive-fixtures.ts';
import { reflectJson, reflectMarkdown, reflectMarkdownZip } from '../../test/support/archive-fixtures-reflect.ts';
import { roamJson } from '../../test/support/archive-fixtures-roam.ts';
import type { ReadwiseExportBook, ReadwiseReaderDocument } from '../../src/workers/readwise/api.ts';

export const SCALE_FORMATS = ['mbox', 'roam', 'reflect-json', 'reflect-markdown', 'readwise'] as const;
export type ScaleFormat = typeof SCALE_FORMATS[number];
export const SCALE_COUNTS = { mbox: 20_000, roam: 5_000, 'reflect-json': 3_000, 'reflect-markdown': 3_000, books: 1_500, documents: 800 } as const;
export const SCALE_FIRST = '1994-01-01';
export const SCALE_LAST = '2024-12-31';
const FIRST = Date.parse(`${SCALE_FIRST}T12:00:00Z`);
const LAST = Date.parse(`${SCALE_LAST}T12:00:00Z`);
/** Evenly spaced days, including both endpoints; no local timezone or clock dependence. */
export const scaleDate = (index: number, count: number): string => new Date(FIRST + Math.floor((LAST - FIRST) / 86_400_000 * index / (count - 1)) * 86_400_000).toISOString();
const utf8 = (text: string): Uint8Array => Buffer.from(text, 'utf8');

/** Known non-ASCII bytes, independently checkable after MIME decoding. */
export const SCALE_ENCODINGS = [
  { charset: 'UTF-8', bytes: Buffer.from('Vexli Numo at Zorava quay — café', 'utf8'), decoded: 'Vexli Numo at Zorava quay — café' },
  { charset: 'ISO-8859-1', bytes: Buffer.from('Vexli Numo at Zorava caf\u00e9', 'latin1'), decoded: 'Vexli Numo at Zorava café' },
  { charset: 'windows-1252', bytes: Buffer.from([0x56, 0x65, 0x78, 0x6c, 0x69, 0x20, 0x96, 0x20, 0x80]), decoded: 'Vexli – €' },
  { charset: 'Shift_JIS', bytes: Buffer.from([0x83, 0x65, 0x83, 0x58, 0x83, 0x67]), decoded: 'テスト' },
] as const;
const qp = (bytes: Uint8Array): string => Array.from(bytes, byte => `=${byte.toString(16).padStart(2, '0').toUpperCase()}`).join('').match(/.{1,60}/g)!.join('=\n');

export function scaleMbox(token: string): Uint8Array {
  const chunks: string[] = [];
  const readable = SCALE_COUNTS.mbox - 5;
  for (let i = 0; i < SCALE_COUNTS.mbox; i++) {
    const day = scaleDate(Math.min(i, readable - 1), readable);
    const date = new Date(day);
    const [weekday, month, dayOfMonth, year] = [date.toUTCString().slice(0, 3), date.toUTCString().slice(8, 11), date.getUTCDate(), date.getUTCFullYear()];
    const separator = `From scale@example.test ${weekday} ${month} ${String(dayOfMonth).padStart(2, ' ')} 12:00:00 ${year}`;
    if (i >= readable) {
      // A malformed header exceeding postal-mime's 1 MiB header bound. Five exact message_unreadable gaps.
      chunks.push(`${separator}\nX-Malformed: ${'x'.repeat(1024 * 1024 + 1)}\n\nMalformed synthetic message ${i}.\n\n`);
      continue;
    }
    const encoding = SCALE_ENCODINGS[i % SCALE_ENCODINGS.length]!;
    const transfer = i % 3 === 0 ? '7bit' : i % 3 === 1 ? 'quoted-printable' : 'base64';
    const charset = transfer === '7bit' ? 'UTF-8' : encoding.charset;
    const bodyBytes = Buffer.concat([Buffer.from(`Synthetic Zorava trip log ${i}, ${token}. Bring bread and a blue tent. `), transfer === '7bit' ? Buffer.from('Vexli Numo') : encoding.bytes]);
    const body = transfer === 'base64' ? bodyBytes.toString('base64').match(/.{1,76}/g)!.join('\n') : transfer === 'quoted-printable' ? qp(bodyBytes) : `${bodyBytes.toString('utf8')}\n>From a remembered ferry log\n>>From an older log`;
    // RFC 822 two-digit years, and both obsolete named and unknown-offset zones.
    const zone = ['EST', 'GMT', '-0000'][i % 3]!;
    let headerDate = date.toUTCString().replace('GMT', zone);
    if (i % 4 === 0) headerDate = headerDate.replace(String(date.getUTCFullYear()), String(date.getUTCFullYear()).slice(-2));
    const id = i >= 300 && i < 320 ? `pair-${Math.floor((i - 300) / 2)}` : String(i);
    const word = `=?${encoding.charset}?B?${encoding.bytes.toString('base64')}?=`;
    const text = [separator, ...(i >= 200 && i < 220 ? [] : [`Message-ID: <${token}-${id}@example.test>`]),
      `From: ${word} <vexli@example.test>`, 'To: Nuvlo Zemi <nuvlo@example.test>', `Subject: ${word} log ${i}`,
      ...(i >= 100 && i < 105 ? [] : [`Date: ${headerDate}`]), 'MIME-Version: 1.0',
      `Content-Type: text/plain; charset="${charset}"`, `Content-Transfer-Encoding: ${transfer}`, '', body, '', ''].join('\n');
    chunks.push(i % 7 === 0 ? text.replaceAll('\n', '\r\n') : text);
  }
  return utf8(chunks.join(''));
}

export function scaleFixture(format: Exclude<ScaleFormat, 'readwise'>, seed: string): LegFixture {
  const token = fixtureToken(seed, 'scale', format);
  let bytes: Uint8Array;
  let productFormat: string;
  let label: string;
  let extension = '.json';
  const count = SCALE_COUNTS[format];
  if (format === 'mbox') {
    bytes = scaleMbox(token); productFormat = 'mbox'; label = 'Mail (mbox)'; extension = '.mbox';
  } else if (format === 'roam') {
    productFormat = 'roam-json'; label = 'Roam notes (JSON)';
    bytes = utf8(roamJson(Array.from({ length: count }, (_, i) => {
      const at = Date.parse(scaleDate(i, count));
      return { title: i % 10 === 0 ? new Date(at).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' }).replace(/(\d+),/, '$1th,') : `Zorava field page ${i}`, uid: `${token}-${i}`,
        'create-time': at, 'edit-time': at + 3_600_000,
        children: [{ string: `Vexli Numo packs a tent for Zorava. ${token} entry ${i}.`, uid: `${token}-${i}-a`, 'create-time': at + 60_000,
          children: [{ string: `Nested ferry detail ${i}`, uid: `${token}-${i}-b`, 'edit-time': at + 3_600_000 }] }] };
    })));
  } else {
    productFormat = 'reflect-json'; label = 'Reflect notes (JSON)';
    const notes = Array.from({ length: count }, (_, i) => ({ id: `${token}-${i}`, title: `Zorava field note ${i}`,
      body: `Vexli Numo packs bread and a blue tent for Zorava. ${token} entry ${i}.`, created: scaleDate(i, count), updated: new Date(Date.parse(scaleDate(i, count)) + 3_600_000).toISOString() }));
    if (format === 'reflect-json') bytes = utf8(reflectJson(notes, { wrap: true }));
    else { productFormat = 'reflect-markdown'; label = 'Reflect notes (Markdown zip)'; extension = '.zip'; bytes = reflectMarkdownZip(notes.map((note, i) => ({ name: `reflect-${i}.md`, text: reflectMarkdown(note) }))); }
  }
  const fileName = `rc-scale-${format}${extension}`;
  return { role: 'agent', format: productFormat, fileName, token, relPath: `${FIXTURE_FOLDER}/${fileName}`, bytes,
    expect: { label, citationLabel: format === 'mbox' ? 'Imported mail' : format === 'roam' ? 'Roam' : 'Reflect', family: format === 'mbox' ? 'email' : 'note',
      messages: format === 'mbox' ? count - 5 : count, earliest: SCALE_FIRST, latest: SCALE_LAST,
      notImported: format === 'mbox' ? [{ kind: 'message_unreadable', count: 5 }] : [], howRead: [] } };
}

export function scaleReadwise(seed: string): { documents: ReadwiseReaderDocument[]; books: ReadwiseExportBook[]; items: number; token: string } {
  const token = fixtureToken(seed, 'scale', 'readwise');
  const documents = Array.from({ length: SCALE_COUNTS.documents }, (_, i) => ({ id: `${token}-doc-${i}`, title: `Zorava reading ${i}`,
    author: 'Vexli Numo', category: 'article', location: 'new', url: `https://example.test/${token}/${i}`, html_content: `<p>${token} Ferry plans for Zorava, entry ${i}.</p>`,
    created_at: scaleDate(i, SCALE_COUNTS.documents), updated_at: '2025-01-01T12:00:00Z' }));
  const books = Array.from({ length: SCALE_COUNTS.books }, (_, i) => ({ id: `${token}-book-${i}`, title: `Zorava field book ${i}`, author: 'Nuvlo Zemi', category: 'books',
    highlights: [0, 1].map(j => ({ id: `${token}-highlight-${i}-${j}`, text: `${token} Pack a blue tent for the Zorava ferry, entry ${i}/${j}.`,
      highlighted_at: scaleDate(i, SCALE_COUNTS.books), updated_at: '2025-01-01T12:00:00Z' })) }));
  return { documents, books, items: documents.length + books.length * 2, token };
}
