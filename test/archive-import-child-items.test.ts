// Archive sync with child items, through the real import, tier set and ledger
// and the fixture connector (no format): a child is listed by name after its
// parent with the means to read its bytes later and is never read while
// syncing; its names are routed at listing; a page that ends inside a parent's
// children resumes there; and replaying a page after a crash counts nothing
// twice.

import { afterEach, describe, expect, test } from 'bun:test';
import { getArchiveFormat } from '../src/core/archive-formats.ts';
import { childItemsArchiveHarness } from './support/child-items-archive-harness.ts';
import { childProviderItemId, type FixtureParentSpec } from './helpers/child-items-fixture.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function parents(): FixtureParentSpec[] {
  return [
    {
      id: 'm1', subject: 'Flat', sender: 'Alice', sentAt: '2024-03-03T10:00:00.000Z', body: 'Please find the lease attached.',
      children: [
        { key: 'p1', name: 'lease.pdf', mimeType: 'application/pdf', text: 'The lease term is thirty-seven months.' },
        { key: 'p2', name: 'plan.jpg', mimeType: 'image/jpeg', text: 'jpeg bytes' },
        { key: 'p3', name: 'gone.jpg', mimeType: 'image/jpeg', text: 'jpeg bytes', available: false },
        { key: 'p4', name: 'notes.txt', mimeType: 'text/plain', text: 'Remember the deposit.' },
        { key: 'p5', name: 'memo.m4a', mimeType: 'audio/mp4', text: 'audio bytes' },
      ],
    },
    { id: 'm2', subject: 'Garden', sender: 'Bo', sentAt: '2024-03-04T10:00:00.000Z', body: 'Weekly notes about the compost bins.', children: [] },
    {
      id: 'm3', subject: 'Trip', sender: 'Cy', sentAt: '2024-03-05T10:00:00.000Z', body: 'Tickets are attached.',
      children: [{ key: 'p1', name: 'tickets.pdf', mimeType: 'application/pdf', text: 'Gate 12.' }],
    },
  ];
}

const TOTAL = 3 + 5 + 1;

describe('archive sync with child items', () => {
  test('children are listed by name after their parents and none is read while syncing', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    const outcome = await h.importAll(archiveId, parents());
    expect(outcome.receipt.counts.traversal_complete).toBe(1);

    const rows = h.rows(archiveId);
    const ids = [...new Set(rows.map((row) => row.providerItemId))].sort();
    expect(ids).toEqual([
      'm1', 'm1#child:p1', 'm1#child:p2', 'm1#child:p3', 'm1#child:p4', 'm1#child:p5',
      'm2', 'm3', 'm3#child:p1',
    ]);
    expect(ids).toHaveLength(TOTAL);

    // The connector was never asked for a child's bytes, nor for anything at all.
    expect(h.log.fetches).toEqual([]);

    // Every child row carries its parent, its locator, its availability and its stated size, and no text.
    for (const row of rows.filter((entry) => entry.providerItemId.includes('#child:'))) {
      expect(row.parent).toBe(`${archiveId}:${row.providerItemId.split('#child:')[0]}`);
      expect(row.locator).toStartWith('fixture-locator:');
      expect(row.available).toBe(row.providerItemId.endsWith('#child:p3') ? 0 : 1);
      expect(row.size).toBeGreaterThan(0);
      expect(row.chunks).toBe(0);
    }
    // A parent keeps the text it was listed with and no child columns.
    for (const row of rows.filter((entry) => !entry.providerItemId.includes('#child:'))) {
      expect(row).toMatchObject({ parent: null, locator: null, available: null, size: null });
    }
  });

  test('a page that ends inside a parent\'s children resumes there and nothing is stored or counted twice', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    // maxItems 2 and a page of 2: the passes end after the parent and its first child, then inside its children.
    const first = await h.pull(archiveId, parents(), { maxItems: 2, pageSize: 2 });
    expect(first.continueSoon).toBe(true);
    expect(first.receipt.counts.traversal_complete).toBe(0);
    const last = await h.importAll(archiveId, parents(), { maxItems: 2, pageSize: 2 });
    expect(last.receipt.counts.traversal_complete).toBe(1);

    const ids = h.rows(archiveId).map((row) => row.providerItemId);
    expect(new Set(ids).size).toBe(TOTAL);
    // Each item sits in exactly one store (names-only copies aside, which carry the same ids).
    const record = h.runtime.state.get(archiveId)!;
    expect(record.status).toBe('imported');
    expect(record.findings.skipped['item_repeated'] ?? 0).toBe(0);
    // The pages the connector cut: never more than the budget, and the cut fell between children.
    expect(Math.max(...h.log.pages)).toBeLessThanOrEqual(2);
  });

  test('replaying a page after a crash inside a parent\'s children counts nothing twice', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    let crashed = false;
    const crashing = h.factory(parents(), {
      pageSize: 2,
      beforePage: (firstItem) => {
        if (firstItem === 4 && !crashed) {
          crashed = true;
          throw new Error('synthetic crash');
        }
      },
    });
    await expect(h.pull(archiveId, parents(), { maxItems: 100, pageSize: 2, connectorFactory: crashing }))
      .rejects.toThrow('synthetic crash');
    const done = await h.importAll(archiveId, parents(), { maxItems: 100, pageSize: 2 });
    expect(done.receipt.counts.traversal_complete).toBe(1);
    expect(new Set(h.rows(archiveId).map((row) => row.providerItemId)).size).toBe(TOTAL);
    const record = h.runtime.state.get(archiveId)!;
    expect(record.findings.skipped['item_repeated'] ?? 0).toBe(0);
  });

  test('names are routed at listing: a child is findable by name before any byte is read', async () => {
    const h = childItemsArchiveHarness(cleanups);
    const archiveId = h.start();
    await h.importAll(archiveId, parents());
    const childId = childProviderItemId('m1', 'p1');
    const copies = h.runtime.lane('email').ledger.getCurrent({
      provider: getArchiveFormat('mbox')!.provider,
      accountScope: archiveId,
      providerItemId: childId,
    });
    expect(copies).toBeDefined();
    // Names are Personal by rule; the content is unread and held until the private model judges it,
    // and the names alone are placed in their tier's store at listing.
    expect(copies).toMatchObject({
      metadataTier: 'private',
      contentRead: false,
      contentPending: true,
      state: 'pending',
      reasons: expect.arrayContaining(['content:unread', 'content:held_until_judged']),
    });
    const placed = h.rows(archiveId).filter((row) => row.providerItemId === childId);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ domain: 'internal', chunks: 0 });
  });
});
