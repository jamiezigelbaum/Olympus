// Contract 1 (SourceConnector) conformance tests for the Reflect archive
// connector. Everything runs against fixture export files: snake_case and
// camelCase key styles, markdown and editor-JSON bodies, a generated bulk
// export for offset-cursor pagination, and an in-test zip archive (stored +
// deflated entries plus macOS junk) for the zip import path.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { createReflectSourceConnector } from '../src/workers/reflect/index.ts';

const ACCOUNT = 'personal';
const FIXTURES_DIR = join(import.meta.dir, 'fixtures', 'reflect');
const SNAKE_EXPORT = join(FIXTURES_DIR, 'export-snake.json');
const CAMEL_EXPORT = join(FIXTURES_DIR, 'export-camel.json');

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'reflect-connector-'));
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function connectorFor(exportPath: string, trustDomain?: 'secure_local' | 'internal'): SourceConnector {
  return createReflectSourceConnector({
    exportPath,
    account: ACCOUNT,
    ...(trustDomain !== undefined ? { trustDomain } : {}),
  });
}

async function drain(pages: AsyncIterable<SourceConnectorListPage>): Promise<SourceConnectorListPage[]> {
  const collected: SourceConnectorListPage[] = [];
  for await (const page of pages) collected.push(page);
  return collected;
}

async function allItems(connector: SourceConnector): Promise<RawItem[]> {
  const pages = await drain(connector.listItems());
  return pages.flatMap((page) => [...page.items]);
}

function writeTempExport(name: string, contents: string | Uint8Array): string {
  const path = join(tempDir, name);
  writeFileSync(path, contents);
  return path;
}

// Minimal store/deflate zip builder for fixtures. The connector's reader uses
// central-directory sizes and never verifies CRCs, so CRC fields stay zero.
interface TestZipEntry {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
}

function buildTestZip(entries: TestZipEntry[]): Uint8Array {
  const u16 = (value: number): number[] => [value & 0xff, (value >>> 8) & 0xff];
  const u32 = (value: number): number[] => [
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ];
  const local: number[] = [];
  const central: number[] = [];
  for (const entry of entries) {
    const nameBytes = [...new TextEncoder().encode(entry.name)];
    const method = entry.method ?? 0;
    const payload = method === 8 ? [...new Uint8Array(deflateRawSync(entry.data))] : [...entry.data];
    const localHeaderOffset = local.length;
    local.push(
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(method),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(payload.length), ...u32(entry.data.length),
      ...u16(nameBytes.length), ...u16(0),
      ...nameBytes, ...payload,
    );
    central.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(method),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(payload.length), ...u32(entry.data.length),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(localHeaderOffset),
      ...nameBytes,
    );
  }
  const eocd = [
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(entries.length), ...u16(entries.length),
    ...u32(central.length), ...u32(local.length),
    ...u16(0),
  ];
  return Uint8Array.from([...local, ...central, ...eocd]);
}

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('Reflect SourceConnector (Contract 1)', () => {
  test('exposes the frozen contract identity', () => {
    const connector = connectorFor(SNAKE_EXPORT);
    expect(connector.id).toBe('reflect');
    expect(connector.family).toBe('note');
  });

  test('authenticate resolves when the export exists and parses', async () => {
    await expect(connectorFor(SNAKE_EXPORT).authenticate()).resolves.toBeUndefined();
    await expect(connectorFor(CAMEL_EXPORT).authenticate()).resolves.toBeUndefined();
  });

  test('authenticate surfaces a missing export file clearly', async () => {
    const missing = join(tempDir, 'no-such-export.json');
    await expect(connectorFor(missing).authenticate()).rejects.toThrow(/could not be read.*no-such-export\.json/);
  });

  test('authenticate rejects malformed JSON and non-export shapes', async () => {
    const malformed = writeTempExport('malformed.json', 'this is not json');
    await expect(connectorFor(malformed).authenticate()).rejects.toThrow(/not valid JSON/);

    const wrongShape = writeTempExport('wrong-shape.json', '{"items": []}');
    await expect(connectorFor(wrongShape).authenticate()).rejects.toThrow(/top-level array of notes|"notes" array/);
  });

  test('listItems maps snake_case notes to contract RawItems', async () => {
    const pages = await drain(connectorFor(SNAKE_EXPORT).listItems());

    expect(pages).toHaveLength(1);
    expect(pages[0]?.done).toBe(true);
    expect(pages[0]?.nextCursor).toBeUndefined();
    expect(pages[0]?.items).toHaveLength(3);

    const alpha = pages[0]?.items[0] as RawItem;
    expect(alpha.identity).toEqual({
      family: 'note',
      provider: 'reflect',
      accountScope: ACCOUNT,
      providerItemId: 'note-alpha',
      localItemId: 'personal:note-alpha',
      sourceVersion: '2026-02-01T09:30:00Z',
    });
    expect(alpha.mimeType).toBe('text/markdown');
    expect(alpha.content).toEqual({ kind: 'text', text: '# Alpha\n\nMarkdown body for alpha.' });
    expect(alpha.metadata).toEqual({
      title: 'Alpha note',
      tags: ['olympus', 'ideas'],
      createdAt: '2026-01-05T08:00:00Z',
      updatedAt: '2026-02-01T09:30:00Z',
    });

    const untagged = pages[0]?.items[2] as RawItem;
    expect(untagged.identity.sourceVersion).toBeUndefined();
    expect(untagged.metadata).toEqual({ tags: [] });
    expect(untagged.content).toEqual({ kind: 'text', text: 'Untagged body.' });
  });

  test('listItems accepts camelCase keys and a top-level array export', async () => {
    const items = await allItems(connectorFor(CAMEL_EXPORT));

    // The id-less note is dropped; the numeric id is coerced to a string.
    expect(items.map((item) => item.identity.providerItemId)).toEqual(['note-camel', 'note-editor', '42']);

    const camel = items[0] as RawItem;
    expect(camel.identity.localItemId).toBe('personal:note-camel');
    expect(camel.identity.sourceVersion).toBe('2026-03-02T10:00:00Z');
    expect(camel.content).toEqual({ kind: 'text', text: 'Camel markdown body.' });
    expect(camel.metadata).toEqual({
      title: 'Camel note',
      tags: ['exports', 'reflect'],
      createdAt: '2026-03-01T10:00:00Z',
      updatedAt: '2026-03-02T10:00:00Z',
    });

    const numeric = items[2] as RawItem;
    expect(numeric.identity.localItemId).toBe('personal:42');
  });

  test('editor-JSON bodies are flattened to text best-effort', async () => {
    const items = await allItems(connectorFor(CAMEL_EXPORT));
    const editor = items.find((item) => item.identity.providerItemId === 'note-editor') as RawItem;

    expect(editor.content).toEqual({
      kind: 'text',
      text: 'Hello world.\nFirst item\nSecond item',
    });
  });

  test('listItems pages by array offset cursor and resumes mid-archive', async () => {
    const connector = connectorFor(SNAKE_EXPORT);

    const pages = await drain(connector.listItems({ limit: 2 }));
    expect(pages).toHaveLength(2);
    expect(pages[0]?.items.map((item) => item.identity.providerItemId)).toEqual(['note-alpha', 'note-beta']);
    expect(pages[0]?.nextCursor).toBe('2');
    expect(pages[0]?.done).toBe(false);
    expect(pages[1]?.items.map((item) => item.identity.providerItemId)).toEqual(['note-untagged']);
    expect(pages[1]?.nextCursor).toBeUndefined();
    expect(pages[1]?.done).toBe(true);

    const resumed = await drain(connector.listItems({ cursor: '2', limit: 2 }));
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.items.map((item) => item.identity.providerItemId)).toEqual(['note-untagged']);
    expect(resumed[0]?.done).toBe(true);
  });

  test('listItems defaults to ~200 notes per page', async () => {
    const bulk = Array.from({ length: 450 }, (_, index) => ({
      id: `bulk-${index}`,
      title: `Bulk ${index}`,
      content: `Body ${index}`,
      updated_at: '2026-05-01T00:00:00Z',
    }));
    const bulkPath = writeTempExport('bulk.json', JSON.stringify(bulk));
    const connector = connectorFor(bulkPath);

    const pages = await drain(connector.listItems());
    expect(pages.map((page) => page.items.length)).toEqual([200, 200, 50]);
    expect(pages.map((page) => page.nextCursor)).toEqual(['200', '400', undefined]);
    expect(pages.map((page) => page.done)).toEqual([false, false, true]);

    const resumed = await drain(connector.listItems({ cursor: '400' }));
    expect(resumed).toHaveLength(1);
    expect(resumed[0]?.items).toHaveLength(50);
    expect(resumed[0]?.items[0]?.identity.providerItemId).toBe('bulk-400');
  });

  test('listItems rejects malformed cursors', () => {
    const connector = connectorFor(SNAKE_EXPORT);
    expect(() => connector.listItems({ cursor: 'not-an-offset' })).toThrow(/array offsets/);
  });

  test('fetchItem returns the note by local item id', async () => {
    const item = await connectorFor(SNAKE_EXPORT).fetchItem('personal:note-beta');

    expect(item.identity.providerItemId).toBe('note-beta');
    expect(item.identity.localItemId).toBe('personal:note-beta');
    expect(item.identity.sourceVersion).toBe('2026-01-07T08:00:00Z');
    expect(item.mimeType).toBe('text/markdown');
    expect(item.content).toEqual({ kind: 'text', text: 'Beta body.' });
  });

  test('fetchItem rejects foreign accounts and unknown notes', async () => {
    const connector = connectorFor(SNAKE_EXPORT);
    await expect(connector.fetchItem('work:note-beta')).rejects.toThrow(/personal:<note id>/);
    await expect(connector.fetchItem('personal:note-missing')).rejects.toThrow(/note-missing.*not found/);
  });

  test('classify defaults to the S4/secure_local floor', async () => {
    const connector = connectorFor(SNAKE_EXPORT);
    const [item] = await allItems(connector);

    expect(connector.classify(item as RawItem)).toEqual({
      trustTier: 'S4',
      trustDomain: 'secure_local',
      localOnly: true,
      cloudEmbeddingEligible: false,
    });
  });

  test('classify honors the configured internal trust domain', async () => {
    const connector = connectorFor(SNAKE_EXPORT, 'internal');
    const [item] = await allItems(connector);

    expect(connector.classify(item as RawItem)).toEqual({
      trustTier: 'S3',
      trustDomain: 'internal',
      localOnly: false,
      cloudEmbeddingEligible: false,
    });
  });

  test('zip exports are read across JSON entries, skipping junk and duplicates', async () => {
    const partOne = { notes: [{ id: 'zip-one', subject: 'Zip one', content: 'Zip body one.' }] };
    const partTwo = [
      { id: 'zip-two', title: 'Zip two', body: 'Zip body two.', updatedAt: '2026-04-01T00:00:00Z' },
      { id: 'zip-one', title: 'Duplicate of zip one', body: 'Dropped: first occurrence wins.' },
    ];
    const zipPath = writeTempExport('export.zip', buildTestZip([
      { name: 'notes/part-1.json', data: utf8(JSON.stringify(partOne)), method: 0 },
      { name: '__MACOSX/notes/._part-1.json', data: utf8('macOS resource fork junk') },
      { name: 'notes/part-2.json', data: utf8(JSON.stringify(partTwo)), method: 8 },
      { name: 'readme.txt', data: utf8('not json at all') },
    ]));
    const connector = connectorFor(zipPath);

    await connector.authenticate();
    const items = await allItems(connector);

    expect(items.map((item) => item.identity.providerItemId)).toEqual(['zip-one', 'zip-two']);
    expect(items[0]?.content).toEqual({ kind: 'text', text: 'Zip body one.' });
    expect(items[1]?.content).toEqual({ kind: 'text', text: 'Zip body two.' });
    expect(items[1]?.identity.sourceVersion).toBe('2026-04-01T00:00:00Z');

    const fetched = await connector.fetchItem('personal:zip-two');
    expect(fetched.metadata).toEqual({
      title: 'Zip two',
      tags: [],
      updatedAt: '2026-04-01T00:00:00Z',
    });
  });

  test('zip exports without JSON entries fail authentication clearly', async () => {
    const zipPath = writeTempExport('no-json.zip', buildTestZip([
      { name: 'readme.txt', data: utf8('nothing to import') },
    ]));

    await expect(connectorFor(zipPath).authenticate()).rejects.toThrow(/contains no JSON entries/);
  });

  test('connector stays thin: no storage or cross-worker imports', () => {
    const source = Bun.file(join(import.meta.dir, '..', 'src', 'workers', 'reflect', 'connector.ts'));
    return source.text().then((text) => {
      expect(text.includes('local-index')).toBe(false);
      expect(text.includes("from '../dropbox-files")).toBe(false);
    });
  });
});
describe('Reflect real-export shape (document_json)', () => {
  test('parses the double-encoded ProseMirror document_json field', async () => {
    const exportPath = join(tempDir, 'real-shape.json');
    writeFileSync(exportPath, JSON.stringify({
      export_version: 1,
      notes: [{
        id: 'note-pm',
        subject: 'PM Note',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-02T00:00:00.000Z',
        document_json: JSON.stringify({
          type: 'doc',
          content: [
            { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Heading text' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Body line one.' }] },
            { type: 'paragraph', content: [{ type: 'text', text: 'Body line two.' }] },
          ],
        }),
      }],
    }));
    const connector = connectorFor(exportPath);
    await connector.authenticate();
    const items = await allItems(connector);
    const item = items[0]!;
    if (item.content.kind !== 'text') throw new Error('expected text content');
    expect(item.content.text).toContain('Heading text');
    expect(item.content.text).toContain('Body line one.');
    expect(item.content.text).toContain('Body line two.');
  });
});

