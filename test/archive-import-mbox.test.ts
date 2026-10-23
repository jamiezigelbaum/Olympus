// The mbox reader: splitting a mail file into messages by byte offset, and
// the thin connector that turns each message into an item. Synthetic mail
// built here, never a real export.

import { afterEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem } from '../src/core/contracts.ts';
import {
  ArchiveImportStoppedError,
  MBOX_ARCHIVE_FORMAT,
  type ArchiveImportFinding,
} from '../src/core/archive-formats.ts';
import { ScopeRoot } from '../src/core/scope-safe-fs.ts';
import { archiveFileEntries, archiveManifestSha256, buildArchiveManifest } from '../src/workers/archive-import/manifest.ts';
import { MBOX_FINDINGS, createMboxArchiveConnector } from '../src/workers/archive-import/mbox/connector.ts';
import { MboxFormatError, MboxSplitter, type MboxMessageSpan } from '../src/workers/archive-import/mbox/split.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

interface MailInput {
  id?: string;
  subject: string;
  body: string;
  headers?: string[];
  contentType?: string;
}

function mail(input: MailInput, eol = '\n'): string {
  return [
    'From: Sam Example <sam@example.invalid>',
    'To: Alex Example <alex@example.invalid>',
    `Subject: ${input.subject}`,
    'Date: Mon, 05 Jan 2015 10:00:00 +0000',
    ...(input.id ? [`Message-ID: <${input.id}>`] : []),
    ...(input.headers ?? []),
    `Content-Type: ${input.contentType ?? 'text/plain; charset=utf-8'}`,
    '',
    input.body,
  ].join(eol);
}

/** Messages in mbox form: a `From ` line before each, a blank line after each. */
function mbox(messages: readonly string[], options: { eol?: string; trailingNewline?: boolean } = {}): string {
  const eol = options.eol ?? '\n';
  const text = messages.map((message) => `From sender@example.invalid Mon Jan  5 10:00:00 2015${eol}${message}${eol}${eol}`).join('');
  return options.trailingNewline === false ? text.slice(0, -2 * eol.length) : text;
}

function memorySource(text: string | Uint8Array) {
  const bytes = typeof text === 'string' ? Buffer.from(text, 'latin1') : Buffer.from(text);
  return { size: bytes.length, readAt: (offset: number, length: number) => bytes.subarray(offset, offset + length) };
}

function split(text: string | Uint8Array, options: { start?: number; maxMessageBytes?: number } = {}): MboxMessageSpan[] {
  const splitter = new MboxSplitter(memorySource(text), options);
  const spans: MboxMessageSpan[] = [];
  for (let span = splitter.next(); span; span = splitter.next()) spans.push(span);
  return spans;
}

function rawText(span: MboxMessageSpan): string {
  return Buffer.from(span.raw!).toString('latin1');
}

describe('mbox split', () => {
  test('messages come back without their From line or the blank line after them', () => {
    const one = mail({ id: 'one@example.invalid', subject: 'One', body: 'first body' });
    const two = mail({ id: 'two@example.invalid', subject: 'Two', body: 'second body' });
    const spans = split(mbox([one, two]));
    expect(spans.map(rawText)).toEqual([`${one}\n`, `${two}\n`]);
    expect(spans[0]!.offset).toBe(0);
    expect(spans[1]!.offset).toBe(spans[0]!.length);
  });

  test('>From quoting is undone one level; a From inside a line is left alone', () => {
    const body = ['>From the harbour, a note.', '>>From deeper quoting.', 'Not a separator: From here.', '> From with a space stays.'].join('\n');
    const [span] = split(mbox([mail({ subject: 'Quoted', body })]));
    const text = rawText(span!);
    expect(text).toContain('\nFrom the harbour, a note.\n');
    expect(text).toContain('\n>From deeper quoting.\n');
    expect(text).toContain('\nNot a separator: From here.\n');
    expect(text).toContain('\n> From with a space stays.\n');
  });

  test('CRLF files split the same way and keep their bytes', () => {
    const one = mail({ subject: 'One', body: 'first body' }, '\r\n');
    const two = mail({ subject: 'Two', body: 'second body' }, '\r\n');
    const spans = split(mbox([one, two], { eol: '\r\n' }));
    expect(spans.map(rawText)).toEqual([`${one}\r\n`, `${two}\r\n`]);
  });

  test('a file without a trailing newline ends with its last message', () => {
    const one = mail({ subject: 'One', body: 'first body' });
    const two = mail({ subject: 'Two', body: 'last body' });
    const spans = split(mbox([one, two], { trailingNewline: false }));
    expect(spans).toHaveLength(2);
    expect(rawText(spans[1]!)).toBe(two);
  });

  test('a message over the bound is reported as a gap, not read, and the next one is', () => {
    const small = mail({ subject: 'Small', body: 'small body' });
    const huge = mail({ subject: 'Huge', body: `${'x'.repeat(1023)}\n`.repeat(3 * 1024) });
    const after = mail({ subject: 'After', body: 'after body' });
    const spans = split(mbox([small, huge, after]), { maxMessageBytes: 1024 * 1024 });
    expect(spans.map((span) => span.tooLarge)).toEqual([false, true, false]);
    expect(spans[1]!.raw).toBeUndefined();
    expect(spans[1]!.length).toBeGreaterThan(3 * 1024 * 1024);
    expect(rawText(spans[2]!)).toBe(`${after}\n`);
    // A huge last message is a gap too, and the file ends there.
    const tail = split(mbox([small, huge]), { maxMessageBytes: 1024 * 1024 });
    expect(tail.map((span) => span.tooLarge)).toEqual([false, true]);
  });

  test('it resumes at a message offset and refuses one inside a message', () => {
    const text = mbox([mail({ subject: 'One', body: 'a' }), mail({ subject: 'Two', body: 'b' }), mail({ subject: 'Three', body: 'c' })]);
    const all = split(text);
    const resumed = split(text, { start: all[1]!.offset });
    expect(resumed.map(rawText)).toEqual(all.slice(1).map(rawText));
    expect(() => split(text, { start: all[1]!.offset + 3 })).toThrow(MboxFormatError);
    expect(split(text, { start: Buffer.byteLength(text, 'latin1') })).toEqual([]);
  });
});

// --- The connector, over real files through the scope-safe reader ------------

function mailFile(name: string, text: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'archive-mbox-')));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, name);
  writeFileSync(path, text, 'latin1');
  return { dir, path };
}

function connectorFor(dir: string, name: string, options: { pageSize?: number; shouldContinue?: () => boolean; manifestSha256?: string } = {}) {
  const root = ScopeRoot.open(dir);
  cleanups.push(() => root.close());
  const files = buildArchiveManifest(root, [name]);
  const findings: ArchiveImportFinding[] = [];
  const connector = createMboxArchiveConnector({
    archiveId: 'synthetic-archive',
    connectorId: 'archive.synthetic-archive',
    accountScope: 'synthetic-archive',
    format: MBOX_ARCHIVE_FORMAT,
    root,
    files: archiveFileEntries(files),
    manifestSha256: options.manifestSha256 ?? archiveManifestSha256(files),
    report: (finding) => { findings.push(finding); },
    shouldContinue: options.shouldContinue ?? (() => true),
    ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
  });
  return { connector, findings, files };
}

async function listAll(connector: ReturnType<typeof createMboxArchiveConnector>, cursor?: string) {
  const items: RawItem[] = [];
  const cursors: string[] = [];
  let done = false;
  for await (const page of connector.listItems(cursor ? { cursor } : {})) {
    items.push(...page.items);
    if (page.nextCursor) cursors.push(page.nextCursor);
    done = page.done;
  }
  return { items, cursors, done };
}

function textOf(item: RawItem): string {
  return item.content.kind === 'text' ? item.content.text : '';
}

describe('mbox connector', () => {
  test('one Message-ID with two different bodies is two items; the same message twice is one identity', async () => {
    const first = mail({ id: 'dup@example.invalid', subject: 'Same id', body: 'first version' });
    const second = mail({ id: 'dup@example.invalid', subject: 'Same id', body: 'second version' });
    const reply = mail({ id: 'reply@example.invalid', subject: 'Re: Same id', body: 'a reply', headers: ['In-Reply-To: <dup@example.invalid>'] });
    const file = mailFile('Inbox.mbox', mbox([first, second, first, reply]));
    const { connector } = connectorFor(file.dir, 'Inbox.mbox');
    const { items, done } = await listAll(connector);
    expect(done).toBe(true);
    expect(items).toHaveLength(4);
    const ids = items.map((item) => item.identity.providerItemId);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[2]).toBe(ids[0]);
    expect(items[0]!.metadata.messageId).toBe('dup@example.invalid');
    expect(items[1]!.metadata.messageId).toBe('dup@example.invalid');
    expect(items[3]!.identity.providerThreadId).toBe(items[0]!.identity.providerThreadId);
    for (const item of items) {
      expect(item.identity).toMatchObject({ family: 'email', provider: 'mbox', accountScope: 'synthetic-archive' });
      expect(item.identity.localItemId).toBe(`synthetic-archive:${item.identity.providerItemId}`);
    }
    expect(textOf(items[1]!)).toContain('second version');
    expect(items[0]!.metadata).toMatchObject({ subject: 'Same id', from: 'Sam Example <sam@example.invalid>', authoredAt: '2015-01-05T10:00:00.000Z' });
  });

  test('gaps and skips are reported where they are; malformed MIME is read as far as it goes', async () => {
    let nested = '';
    for (let depth = 0; depth < 70; depth += 1) nested += `--b${depth}\nContent-Type: multipart/mixed; boundary="b${depth + 1}"\n\n`;
    const overNested = mail({ subject: 'Too deep', contentType: 'multipart/mixed; boundary="b0"', body: `${nested}--b70\nContent-Type: text/plain\n\ndeep\n` });
    const broken = mail({ subject: 'Broken boundary', contentType: 'multipart/mixed; boundary="q"', body: '--q\nContent-Type: text/plain\n\nunterminated part' });
    const spam = mail({ subject: 'Synthetic offer', body: 'buy now', headers: ['X-Gmail-Labels: Inbox,Spam'] });
    const withAttachment = mail({
      subject: 'With attachment',
      contentType: 'multipart/mixed; boundary="att"',
      body: [
        '--att', 'Content-Type: text/plain', '', 'see attached', '',
        '--att', 'Content-Type: application/pdf; name="synthetic.pdf"', 'Content-Disposition: attachment; filename="synthetic.pdf"',
        'Content-Transfer-Encoding: base64', '', Buffer.from('%PDF-synthetic').toString('base64'), '--att--',
      ].join('\n'),
    });
    const oddCharset = mail({ subject: 'Odd charset', contentType: 'text/plain; charset=x-synthetic-unknown', body: 'bytes' });
    const file = mailFile('Inbox.mbox', mbox([overNested, broken, spam, withAttachment, oddCharset]));
    const { connector, findings } = connectorFor(file.dir, 'Inbox.mbox');
    const { items } = await listAll(connector);
    expect(items.map((item) => item.metadata.subject)).toEqual(['Broken boundary', 'With attachment', 'Odd charset']);
    expect(textOf(items[0]!)).toContain('unterminated part');
    expect(textOf(items[1]!)).toContain('Attachment: synthetic.pdf (application/pdf, 14 bytes)');
    expect(items[1]!.metadata.attachmentsNotIngested).toBe(1);
    expect(findings.map((finding) => [finding.kind, finding.class])).toEqual([
      [MBOX_FINDINGS.unreadable, 'gap'],
      [MBOX_FINDINGS.spamOrTrash, 'skipped'],
      [MBOX_FINDINGS.attachments, 'gap'],
      [MBOX_FINDINGS.charset, 'gap'],
    ]);
    expect(findings[0]!.offset).toBe(0);
    expect(new Set(findings.map((finding) => finding.offset)).size).toBe(4);
  });

  test('>From lines read as From in the item text', async () => {
    const file = mailFile('Inbox', mbox([mail({ subject: 'Quoted', body: '>From the harbour, a note.' })]));
    const { connector } = connectorFor(file.dir, 'Inbox');
    const { items } = await listAll(connector);
    expect(textOf(items[0]!)).toContain('\nFrom the harbour, a note.');
    expect(textOf(items[0]!)).not.toContain('>From');
  });

  test('a resume point lists the rest, once, and belongs to these files only', async () => {
    const messages = Array.from({ length: 5 }, (_, index) => mail({ id: `m${index}@example.invalid`, subject: `Message ${index}`, body: `body ${index}` }));
    const file = mailFile('Inbox.mbox', mbox(messages));
    const { connector } = connectorFor(file.dir, 'Inbox.mbox', { pageSize: 2 });
    const all = await listAll(connector);
    expect(all.items).toHaveLength(5);
    expect(all.cursors).toHaveLength(3);
    const rest = await listAll(connector, all.cursors[0]);
    expect(rest.items.map((item) => item.metadata.subject)).toEqual(['Message 2', 'Message 3', 'Message 4']);
    const finished = await listAll(connector, all.cursors.at(-1));
    expect(finished).toMatchObject({ items: [], done: true });

    const other = connectorFor(file.dir, 'Inbox.mbox', { manifestSha256: 'f'.repeat(64) });
    await expect(listAll(other.connector, all.cursors[0])).rejects.toMatchObject({ code: 'resume_point_invalid' });
    await expect(listAll(connector, `${all.cursors[0]!.split(':').slice(0, 2).join(':')}:0:7`)).rejects.toBeInstanceOf(ArchiveImportStoppedError);
  });

  test('stopping between messages leaves a resume point at the next one', async () => {
    const messages = Array.from({ length: 4 }, (_, index) => mail({ subject: `Message ${index}`, body: `body ${index}` }));
    const file = mailFile('Inbox.mbox', mbox(messages));
    let calls = 0;
    const { connector } = connectorFor(file.dir, 'Inbox.mbox', { shouldContinue: () => ++calls <= 2 });
    const first = await listAll(connector);
    expect(first.done).toBe(false);
    expect(first.items).toHaveLength(2);
    const { connector: resumed } = connectorFor(file.dir, 'Inbox.mbox');
    const rest = await listAll(resumed, first.cursors.at(-1));
    expect(rest.items.map((item) => item.metadata.subject)).toEqual(['Message 2', 'Message 3']);
  });

  test('a file that changed or went missing stops the listing instead of reading other bytes', async () => {
    const file = mailFile('Inbox.mbox', mbox([mail({ subject: 'One', body: 'a' })]));
    const { connector } = connectorFor(file.dir, 'Inbox.mbox');
    appendFileSync(file.path, mbox([mail({ subject: 'Two', body: 'b' })]));
    await expect(listAll(connector)).rejects.toMatchObject({ code: 'file_changed', relPath: 'Inbox.mbox' });
    unlinkSync(file.path);
    await expect(listAll(connector)).rejects.toMatchObject({ code: 'file_missing', relPath: 'Inbox.mbox' });
  });

  test('a file changed after the first page stops the listing, though its messages were already read', async () => {
    const text = mbox([1, 2, 3].map((index) => mail({ subject: `Note ${index}`, body: `entry ${index}` })));
    // Each change happens once the first page is out; the whole file was read into the buffer by then.
    const changes: Record<string, (path: string) => void> = {
      grown: (path) => appendFileSync(path, mbox([mail({ subject: 'Four', body: 'd' })])),
      replaced: (path) => {
        writeFileSync(`${path}.new`, text, 'latin1');
        renameSync(`${path}.new`, path);
      },
      removed: (path) => unlinkSync(path),
    };
    const expected: Record<string, string> = { grown: 'file_changed', replaced: 'file_changed', removed: 'file_missing' };
    for (const [name, change] of Object.entries(changes)) {
      const file = mailFile('Inbox.mbox', text);
      const { connector } = connectorFor(file.dir, 'Inbox.mbox', { pageSize: 1 });
      const pages: boolean[] = [];
      let caught: unknown;
      try {
        for await (const page of connector.listItems({})) {
          pages.push(page.done);
          if (pages.length === 1) change(file.path);
        }
      } catch (error) {
        caught = error;
      }
      expect({ name, pages }).toEqual({ name, pages: [false] });
      expect(caught).toBeInstanceOf(ArchiveImportStoppedError);
      expect({ name, code: (caught as ArchiveImportStoppedError).code as string }).toEqual({ name, code: expected[name]! });
    }
  });
});
