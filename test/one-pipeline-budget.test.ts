// A source's records expand into items (a record's own item and its children),
// so a pass's item budget cuts a page of records inside a record. The listing
// yields what fits, as a `truncated` page with a cursor that resumes inside
// the page; nothing is `done` or complete until the store has consumed every
// item of the last page (contract 2.2.0, docs/design/archive-live-one-dataset.md).
// Run through the real archive import and a real tiered store set; synthetic data.

import { afterEach, describe, expect, test } from 'bun:test';
import { fixtureChildId, onePipelineHarness, type FxChild, type FxRecord, type OnePipelineHarness } from './support/one-pipeline-harness.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const child = (key: string): FxChild => ({ key, name: `${key}.pdf`, text: `bytes of ${key}` });
const rec = (id: string, children: readonly FxChild[] = []): FxRecord => ({
  id, version: 1, subject: `Subject ${id}`, body: `body of ${id}`, children,
});
const itemsOf = (record: FxRecord): string[] => [record.id, ...(record.children ?? []).map((entry) => fixtureChildId(record.id, entry.key))];

describe('a record with children, against a small item budget', () => {
  test('one record with children, one item a pass: every child is stored, and the import is imported only after the last', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    const record = rec('p', [child('c1'), child('c2'), child('c3')]);
    const id = await h.startImport('children.mbox', [record]);
    const statuses: string[] = [];
    const stored: number[] = [];
    for (let pass = 0; pass < 8; pass += 1) {
      const outcome = await h.pull(id, { maxItems: 1 });
      statuses.push(h.runtime.state.get(id)!.status);
      stored.push(h.ids().length);
      if (!outcome.continueSoon) break;
    }
    // Parent, then each child: one more item every pass, imported only with the last.
    expect(stored).toEqual([1, 2, 3, 4]);
    expect(statuses).toEqual(['importing', 'importing', 'importing', 'imported']);
    expect(h.ids()).toEqual(itemsOf(record).sort());
    expect(h.duplicates()).toEqual([]);
    // The record is counted once, not once a pass.
    expect(h.runtime.state.get(id)?.intake?.read).toBe(1);
    // Each child is stored with its parent's link and the means to read its bytes later.
    for (const entry of record.children!) {
      const row = h.rows().find((candidate) => candidate.providerItemId === fixtureChildId('p', entry.key) && candidate.tombstoned === 0)!;
      expect(row.parent).toBe('fixture-account:p');
      expect(row.locator).not.toBeNull();
    }
  });

  test('a large page never stalls: every pass moves on, and the whole page is stored', async () => {
    const h = onePipelineHarness(cleanups, { pageSize: 5 });
    h.connectLive();
    const records = ['a', 'b', 'c', 'd', 'e'].map((name) => rec(name, [child('x'), child('y')]));
    const id = await h.startImport('large.mbox', records);
    const stored: number[] = [];
    let passes = 0;
    for (; passes < 10; passes += 1) {
      const outcome = await h.pull(id, { maxItems: 4 });
      stored.push(h.ids().length);
      if (!outcome.continueSoon) break;
    }
    // 15 items at 4 a pass: four passes, each storing more than the one before it.
    expect(stored).toEqual([4, 8, 12, 15]);
    expect(h.runtime.state.get(id)?.status).toBe('imported');
    expect(h.ids()).toEqual(records.flatMap(itemsOf).sort());
    expect(h.duplicates()).toEqual([]);
    expect(h.runtime.state.get(id)?.intake?.read).toBe(5);
  });

  test('a live pull cut inside a record goes on from there, and does not store the record\'s own item again every pass', async () => {
    const h = onePipelineHarness(cleanups, { pageSize: 4 });
    h.connectLive();
    h.live.records = ['a', 'b', 'c'].map((name) => rec(name, [child('x'), child('y')]));
    const stored: number[] = [];
    for (let pass = 0; pass < 10; pass += 1) {
      await h.pullLive({ maxItems: 2 });
      stored.push(h.ids().length);
      if (h.ids().length === 9) break;
    }
    expect(stored).toEqual([2, 4, 6, 8, 9]);
    expect(h.ids()).toEqual(h.live.records.flatMap(itemsOf).sort());
    expect(h.duplicates()).toEqual([]);
  });

  test('the budget is in items, whatever the page size of the input', async () => {
    for (const pageSize of [1, 3, 50]) {
      const h = onePipelineHarness(cleanups, { pageSize });
      h.connectLive();
      const records = ['a', 'b', 'c', 'd'].map((name) => rec(name, [child('x'), child('y'), child('z')]));
      const id = await h.startImport('sizes.mbox', records);
      for (let pass = 0; pass < 20; pass += 1) {
        const before = h.ids().length;
        const outcome = await h.pull(id, { maxItems: 5 });
        // Never more than the budget in a pass, and never a pass that stores nothing before the end.
        expect(h.ids().length - before, `page size ${pageSize}`).toBeLessThanOrEqual(5);
        if (!outcome.continueSoon) break;
        expect(h.ids().length, `page size ${pageSize}`).toBeGreaterThan(before);
      }
      expect(h.runtime.state.get(id)?.status, `page size ${pageSize}`).toBe('imported');
      expect(h.ids(), `page size ${pageSize}`).toEqual(records.flatMap(itemsOf).sort());
    }
  });
});

describe('a pass that stops inside a record', () => {
  test('a crash after the cut resumes from the cut, with every item stored once', async () => {
    const h = onePipelineHarness(cleanups, { pageSize: 2 });
    h.connectLive();
    const records = [rec('p', [child('c1'), child('c2')]), rec('q', [child('d1')])];
    const id = await h.startImport('crash.mbox', records);
    // The first pass stops after the parent and its first child.
    await h.pull(id, { maxItems: 2 });
    expect(h.ids()).toEqual(['p', fixtureChildId('p', 'c1')]);
    // The next pass dies as it starts reading: the cut is still where the last pass left it.
    h.gate.before = () => { throw new Error('the export could not be read'); };
    await h.pull(id, { maxItems: 2 }).catch(() => undefined);
    expect(h.runtime.state.get(id)?.status).toBe('importing');
    expect(h.ids()).toEqual(['p', fixtureChildId('p', 'c1')]);
    h.gate.before = undefined;
    await h.importAll(id, { maxItems: 2 });
    expect(h.ids()).toEqual(records.flatMap(itemsOf).sort());
    expect(h.duplicates()).toEqual([]);
    expect(h.runtime.state.get(id)?.intake?.read).toBe(2);
    expect(h.runtime.state.get(id)?.status).toBe('imported');
  });

  test('a pass whose items were stored but whose cursor was not committed replays the record without duplicates', async () => {
    const h = onePipelineHarness(cleanups, { pageSize: 2 });
    h.connectLive();
    const record = rec('p', [child('c1'), child('c2')]);
    h.live.records = [record];
    // The first pass stores the record's item and its first child, and dies before it commits its cursor.
    await h.set.sync(liveConnector(h), { fetchContent: true, deferMetadataOnlyContent: true, placement: placementOf(h), maxItems: 2 }, { commitCursor: false });
    expect(h.ids()).toHaveLength(2);
    // A pass from the old cursor decides again: what is stored is not stored twice, what is missing is.
    await h.pullLive({ maxItems: 2 });
    await h.pullLive({ maxItems: 2 });
    expect(h.ids()).toEqual(itemsOf(record).sort());
    expect(h.duplicates()).toEqual([]);
  });
});

describe('an import is complete only when the store has consumed the last page', () => {
  test('a listing that hands back more than its budget on its last page is not complete, and goes on next pass', async () => {
    const h = onePipelineHarness(cleanups, { pageSize: 2 });
    h.connectLive();
    h.ignoreLimit.on = true;
    const record = rec('p', [child('c1'), child('c2')]);
    const id = await h.startImport('over.mbox', [record]);
    const first = await h.pull(id, { maxItems: 1 });
    // The listing reached its end, but the store took one item of the three: not stored, not imported.
    expect(first.continueSoon).toBe(true);
    expect(h.runtime.state.get(id)?.status).toBe('importing');
    expect(h.ids().length).toBeLessThan(3);
    h.ignoreLimit.on = false;
    await h.importAll(id, { maxItems: 1 });
    expect(h.runtime.state.get(id)?.status).toBe('imported');
    expect(h.ids()).toEqual(itemsOf(record).sort());
  });
});

import type { SourceConnector } from '../src/core/contracts.ts';
import { FIXTURE_PLACEMENT } from './helpers/tier-fixtures.ts';

/** The harness's live connector, for a test that runs the set itself. */
function liveConnector(h: OnePipelineHarness): SourceConnector {
  return h.connector;
}
function placementOf(_h: OnePipelineHarness): typeof FIXTURE_PLACEMENT {
  return FIXTURE_PLACEMENT;
}
