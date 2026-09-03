// Contract 1 (SourceConnector) conformance tests for the Roam Research
// archive connector. Everything runs against fixture JSON exports written to
// a temp directory — no live Roam access. Documented choice under test: empty
// pages are SURFACED as metadata_only RawItems (blockCount 0), not skipped,
// so pages emptied between exports cannot silently vanish from the index.

import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { createRoamSourceConnector, type RoamTrustDomain } from '../src/workers/roam/index.ts';

const ACCOUNT = 'personal';

const fixtureDir = mkdtempSync(join(tmpdir(), 'roam-export-'));
afterAll(() => rmSync(fixtureDir, { recursive: true, force: true }));

function writeFixture(name: string, contents: unknown): string {
  const path = join(fixtureDir, name);
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return path;
}

const MAIN_EXPORT = [
  {
    title: 'Project Olympus',
    uid: 'uid-olympus',
    children: [
      {
        string: 'Top priority: ship the connector',
        uid: 'b1',
        'create-time': 1_717_200_000_000,
        'edit-time': 1_717_300_000_000,
        children: [
          {
            string: 'Nested detail A with [[Argus]] and **markup**',
            uid: 'b1a',
            'create-time': 1_717_210_000_000,
            'edit-time': 1_717_400_000_000,
            children: [
              {
                string: 'Deep grandchild {{[[TODO]]}} kept verbatim',
                uid: 'b1a1',
                'create-time': 1_717_220_000_000,
                'edit-time': 1_717_250_000_000,
              },
            ],
          },
          {
            string: 'Nested detail B',
            uid: 'b1b',
            'create-time': 1_717_230_000_000,
            'edit-time': 1_717_260_000_000,
          },
        ],
      },
      {
        string: 'Second top-level block',
        uid: 'b2',
        'create-time': 1_717_100_000_000,
        'edit-time': 1_717_350_000_000,
      },
    ],
  },
  {
    title: 'Daily Notes! (June 10th, 2026)',
    children: [
      {
        string: 'A note on a title-only page',
        uid: 'b3',
        'create-time': 1_717_000_000_000,
        'edit-time': 1_717_050_000_000,
      },
    ],
  },
  { title: 'Empty Page', uid: 'uid-empty', children: [] },
  { title: 'Stub Page' },
];

const MAIN_EXPORT_PATH = writeFixture('main-export.json', MAIN_EXPORT);

const PAGINATION_EXPORT = Array.from({ length: 5 }, (_, index) => ({
  title: `Page ${index + 1}`,
  uid: `p${index + 1}`,
  children: [{ string: `Body of page ${index + 1}`, uid: `p${index + 1}-b1`, 'edit-time': 1_717_000_000_000 + index }],
}));

const PAGINATION_EXPORT_PATH = writeFixture('pagination-export.json', PAGINATION_EXPORT);

function connectorFor(exportPath: string, trustDomain?: RoamTrustDomain): SourceConnector {
  return createRoamSourceConnector({
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

describe('Roam SourceConnector (Contract 1)', () => {
  test('exposes the frozen contract identity', () => {
    const connector = connectorFor(MAIN_EXPORT_PATH);
    expect(connector.id).toBe('roam');
    expect(connector.family).toBe('note');
  });

  test('authenticate accepts an export that exists and parses as an array', async () => {
    await expect(connectorFor(MAIN_EXPORT_PATH).authenticate()).resolves.toBeUndefined();
  });

  test('authenticate rejects a missing export file', async () => {
    const connector = connectorFor(join(fixtureDir, 'does-not-exist.json'));
    await expect(connector.authenticate()).rejects.toThrow(/not readable/);
  });

  test('authenticate rejects invalid JSON', async () => {
    const connector = connectorFor(writeFixture('broken.json', '{ not json ]'));
    await expect(connector.authenticate()).rejects.toThrow(/not valid JSON/);
  });

  test('authenticate rejects JSON that is not an array of pages', async () => {
    const connector = connectorFor(writeFixture('object.json', { pages: [] }));
    await expect(connector.authenticate()).rejects.toThrow(/array of pages/);
  });

  test('authenticate rejects exports with duplicate page identities', async () => {
    const connector = connectorFor(writeFixture('duplicates.json', [
      { title: 'Same Page', children: [] },
      { title: 'same page', children: [] },
    ]));
    await expect(connector.authenticate()).rejects.toThrow(/duplicate page identity same-page/);
  });

  test('flattens the nested block tree in order with two-space indentation, text verbatim', async () => {
    const items = await allItems(connectorFor(MAIN_EXPORT_PATH));
    const olympus = items[0] as RawItem;

    expect(olympus.mimeType).toBe('text/markdown');
    expect(olympus.content).toEqual({
      kind: 'text',
      text: [
        '- Top priority: ship the connector',
        '  - Nested detail A with [[Argus]] and **markup**',
        '    - Deep grandchild {{[[TODO]]}} kept verbatim',
        '  - Nested detail B',
        '- Second top-level block',
      ].join('\n'),
    });
  });

  test('uses the page uid as providerItemId when present, with sourceVersion from max edit-time', async () => {
    const items = await allItems(connectorFor(MAIN_EXPORT_PATH));
    const olympus = items[0] as RawItem;

    expect(olympus.identity).toEqual({
      family: 'note',
      provider: 'roam',
      accountScope: ACCOUNT,
      providerItemId: 'uid-olympus',
      localItemId: 'personal:uid-olympus',
      sourceVersion: new Date(1_717_400_000_000).toISOString(),
    });
  });

  test('falls back to the slugified title when the page has no uid', async () => {
    const items = await allItems(connectorFor(MAIN_EXPORT_PATH));
    const daily = items[1] as RawItem;

    expect(daily.identity.providerItemId).toBe('daily-notes-june-10th-2026');
    expect(daily.identity.localItemId).toBe('personal:daily-notes-june-10th-2026');
    expect(daily.metadata.title).toBe('Daily Notes! (June 10th, 2026)');
  });

  test('metadata carries title, blockCount, and createdAt/updatedAt from min create-time/max edit-time', async () => {
    const items = await allItems(connectorFor(MAIN_EXPORT_PATH));
    const olympus = items[0] as RawItem;

    expect(olympus.metadata).toEqual({
      title: 'Project Olympus',
      blockCount: 5,
      createdAt: new Date(1_717_100_000_000).toISOString(),
      updatedAt: new Date(1_717_400_000_000).toISOString(),
    });
  });

  test('paginates by array offset cursor and respects { cursor, limit }', async () => {
    const connector = connectorFor(PAGINATION_EXPORT_PATH);

    const pages = await drain(connector.listItems({ limit: 2 }));

    expect(pages).toHaveLength(3);
    expect(pages.map((page) => page.items.length)).toEqual([2, 2, 1]);
    expect(pages[0]?.nextCursor).toBe('2');
    expect(pages[0]?.done).toBe(false);
    expect(pages[1]?.nextCursor).toBe('4');
    expect(pages[1]?.done).toBe(false);
    expect(pages[2]?.nextCursor).toBeUndefined();
    expect(pages[2]?.done).toBe(true);
    expect(pages.flatMap((page) => page.items.map((item) => item.identity.providerItemId)))
      .toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
  });

  test('resumes listing from a provided cursor', async () => {
    const connector = connectorFor(PAGINATION_EXPORT_PATH);

    const pages = await drain(connector.listItems({ cursor: '2', limit: 2 }));

    expect(pages.map((page) => page.items.length)).toEqual([2, 1]);
    expect(pages[0]?.items[0]?.identity.providerItemId).toBe('p3');
    expect(pages[1]?.done).toBe(true);
  });

  test('a cursor past the end of the archive yields one empty done page', async () => {
    const connector = connectorFor(PAGINATION_EXPORT_PATH);

    const pages = await drain(connector.listItems({ cursor: '99' }));

    expect(pages).toHaveLength(1);
    expect(pages[0]?.items).toEqual([]);
    expect(pages[0]?.done).toBe(true);
  });

  test('rejects cursors that are not array offsets', () => {
    const connector = connectorFor(PAGINATION_EXPORT_PATH);
    expect(() => connector.listItems({ cursor: 'not-a-number' })).toThrow(/non-negative page-array offsets/);
  });

  test('empty pages are surfaced as metadata_only items, not skipped (documented choice)', async () => {
    const items = await allItems(connectorFor(MAIN_EXPORT_PATH));
    const empty = items[2] as RawItem;
    const stub = items[3] as RawItem;

    expect(items).toHaveLength(4);
    expect(empty.content).toEqual({ kind: 'metadata_only' });
    expect(empty.metadata).toEqual({ title: 'Empty Page', blockCount: 0 });
    expect(empty.identity.sourceVersion).toBeUndefined();
    expect(stub.content).toEqual({ kind: 'metadata_only' });
    expect(stub.identity.providerItemId).toBe('stub-page');
  });

  test('fetchItem returns the same RawItem shape by localItemId', async () => {
    const connector = connectorFor(MAIN_EXPORT_PATH);

    const byUid = await connector.fetchItem('personal:uid-olympus');
    const bySlug = await connector.fetchItem('personal:daily-notes-june-10th-2026');

    expect(byUid.identity.providerItemId).toBe('uid-olympus');
    expect(byUid.content.kind).toBe('text');
    if (byUid.content.kind !== 'text') throw new Error('expected text content');
    expect(byUid.content.text).toContain('- Second top-level block');
    expect(bySlug.metadata.title).toBe('Daily Notes! (June 10th, 2026)');
    expect(bySlug.identity.sourceVersion).toBe(new Date(1_717_050_000_000).toISOString());
  });

  test('fetchItem rejects local item ids outside the connector account', async () => {
    const connector = connectorFor(MAIN_EXPORT_PATH);
    await expect(connector.fetchItem('work:uid-olympus')).rejects.toThrow(/personal:<provider item id>/);
  });

  test('fetchItem rejects unknown page ids', async () => {
    const connector = connectorFor(MAIN_EXPORT_PATH);
    await expect(connector.fetchItem('personal:uid-missing')).rejects.toThrow(/no page with provider item id uid-missing/);
  });

  test('classify defaults to the conservative S4/secure_local floor', async () => {
    const connector = connectorFor(MAIN_EXPORT_PATH);
    const items = await allItems(connector);

    expect(connector.classify(items[0] as RawItem)).toEqual({
      trustTier: 'S4',
      trustDomain: 'secure_local',
      localOnly: true,
      cloudEmbeddingEligible: false,
    });
  });

  test('classify honors an explicitly configured internal trust domain as S3/internal', async () => {
    const connector = connectorFor(MAIN_EXPORT_PATH, 'internal');
    const items = await allItems(connector);

    expect(connector.classify(items[0] as RawItem)).toEqual({
      trustTier: 'S3',
      trustDomain: 'internal',
      localOnly: false,
      cloudEmbeddingEligible: false,
    });
  });
});
