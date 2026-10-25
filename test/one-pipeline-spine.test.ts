// One pipeline for a source's two ways in (contract 2.2.0,
// docs/design/archive-live-one-dataset.md): the live reader and an imported
// archive are inputs of the source's one connector, run through the real
// archive import, dashboard approval, tiered store set and intake rule. A
// fixture source stands in (test/support/one-pipeline-harness.ts); no real
// source or format is involved, because the spine is source-neutral.

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readSourceRegistry, findRegistryAccount } from '../src/core/source-registry.ts';
import { recordProviderAccount } from '../src/core/source-storage.ts';
import { deleteOlympusData } from '../src/data-lifecycle.ts';
import { ForgetStepError } from '../src/core/source-forget-registry.ts';
import { HELD_UNTIL_JUDGED_REASON } from '../src/workers/classification/tier-classifier.ts';
import { archiveConnectorId } from '../src/workers/archive-import/state.ts';
import { archiveImportTaskId, createArchiveImportsSchedulerSource } from '../src/workers/archive-import/scheduler-source.ts';
import { defaultConfig } from '../src/core/config.ts';
import {
  FIXTURE_LIVE_INPUT_ID,
  FIXTURE_SOURCE_ID,
  fixtureChildId,
  fixtureLocator,
  onePipelineHarness,
  type FxRecord,
  type OnePipelineHarness,
} from './support/one-pipeline-harness.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

const rec = (id: string, version: number, body: string | undefined, extra: Partial<FxRecord> = {}): FxRecord => ({
  id, version, subject: `Subject ${id}`, ...(body !== undefined ? { body } : {}), ...extra,
});

const versionOf = (h: OnePipelineHarness, id: string): string | null | undefined =>
  h.rows().find((row) => row.providerItemId === id && row.tombstoned === 0)?.version;

describe('live and archive build one dataset', () => {
  test('live then archive, and archive then live, give one dataset with no duplicates', async () => {
    for (const order of ['live-first', 'archive-first'] as const) {
      const h = onePipelineHarness(cleanups);
      h.connectLive();
      h.live.records = [rec('a', 1, 'live a'), rec('b', 1, 'live b')];
      const exported = [rec('b', 1, 'archive b'), rec('c', 1, 'archive c'), rec('d', 1, 'archive d')];
      if (order === 'live-first') await h.pullLive();
      const id = await h.startImport('first.mbox', exported);
      await h.importAll(id);
      if (order === 'archive-first') await h.pullLive();
      expect(h.ids(), order).toEqual(['a', 'b', 'c', 'd']);
      // No leg stores an item twice.
      expect(h.duplicates(), order).toEqual([]);
      expect(h.textOf('a'), order).toBe('live a');
      expect(h.textOf('c'), order).toBe('archive c');
      expect(h.textOf('d'), order).toBe('archive d');
      // The tie at the same version: whichever order they arrived in, live's item is the one kept.
      expect(h.textOf('b'), order).toBe('live b');
    }
  });

  test('an older record never overwrites a newer one, from either input', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    // Live holds version 3 of a; the archive carries version 2 of it.
    h.live.records = [rec('a', 3, 'live a v3')];
    await h.pullLive();
    const first = await h.startImport('older.mbox', [rec('a', 2, 'archive a v2'), rec('b', 5, 'archive b v5')]);
    await h.importAll(first);
    expect(versionOf(h, 'a')).toBe('3');
    expect(h.textOf('a')).toBe('live a v3');
    // The archive holds version 5 of b; a queued live record is version 4 of it.
    h.live.records = [rec('b', 4, 'live b v4')];
    await h.pullLive();
    expect(versionOf(h, 'b')).toBe('5');
    expect(h.textOf('b')).toBe('archive b v5');
    // A newer one still applies, from the live input and from another archive.
    h.live.records = [rec('b', 6, 'live b v6')];
    await h.pullLive();
    expect(versionOf(h, 'b')).toBe('6');
    expect(h.textOf('b')).toBe('live b v6');
    const second = await h.startImport('newer.mbox', [rec('b', 8, 'archive b v8'), rec('b2', 1, 'archive b2')]);
    await h.importAll(second);
    expect(versionOf(h, 'b')).toBe('8');
    expect(h.textOf('b')).toBe('archive b v8');
    expect(h.duplicates()).toEqual([]);
  });

  test('a newer archive record over an item live stored raises it to Private: the new text lands in Private, never in Personal, and no move is left to lose it', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    h.live.records = [rec('a', 3, 'live a v3')];
    await h.pullLive();
    expect(h.contentDomain('a')).toBe('internal');
    const id = await h.startImport('raise.mbox', [rec('a', 9, 'archive a v9')]);
    const out = await h.importAll(id);
    // The held archive version errs Private and replaces the Personal copy in the same write: the item
    // is not left moving (a move would copy the old body), and nothing of either version stays in Personal.
    expect(out.receipt.counts.tier_moves_queued).toBe(0);
    expect(h.contentDomain('a')).toBe('secure_local');
    expect(h.stores.internal.localContent('fixture-account:a')?.chunks.join(' ') ?? '').toBe('');
    expect(h.textOf('a')).toBe('archive a v9');
    expect(h.ledgerRecord('a')?.state).not.toBe('moving');
  });

  test('at the same version a record applies only if it brings content the stored item lacks', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    // Live lists a with names only; the archive has its content at that version.
    h.live.records = [rec('a', 1, undefined), rec('b', 1, 'live b')];
    await h.pullLive();
    expect(h.textOf('a')).toBe('');
    const id = await h.startImport('fill.mbox', [rec('a', 1, 'archive a'), rec('b', 1, undefined)]);
    await h.importAll(id);
    // a was missing its content, so the archive's record applied.
    expect(h.textOf('a')).toBe('archive a');
    expect(versionOf(h, 'a')).toBe('1');
    // b's archive record brings nothing it lacks, so it left b alone.
    expect(h.textOf('b')).toBe('live b');
    // And a live record of names only never takes the content away.
    h.live.records = [rec('a', 1, undefined)];
    await h.pullLive();
    expect(h.textOf('a')).toBe('archive a');
  });

  test('on a tie live wins: a live record applies over an archive\'s, never the other way', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    const id = await h.startImport('tie.mbox', [rec('a', 1, 'archive a')]);
    await h.importAll(id);
    expect(h.textOf('a')).toBe('archive a');
    h.live.records = [rec('a', 1, 'live a')];
    await h.pullLive();
    expect(h.textOf('a')).toBe('live a');
    const again = await h.startImport('tie-again.mbox', [rec('a', 1, 'archive a again')]);
    await h.importAll(again);
    expect(h.textOf('a')).toBe('live a');
  });
});

describe('each input keeps its own cursor', () => {
  test('the live cursor never moves for an import, and the import\'s is bound to its files', async () => {
    const h = onePipelineHarness(cleanups, { pageSize: 2 });
    h.connectLive();
    h.live.records = [rec('l1', 1, 'l1'), rec('l2', 1, 'l2'), rec('l3', 1, 'l3'), rec('l4', 1, 'l4'), rec('l5', 1, 'l5')];
    await h.pullLive({ maxItems: 2 });
    const liveCursor = h.set.committedCursor(FIXTURE_LIVE_INPUT_ID);
    expect(liveCursor?.cursor).toBe('2');

    const id = await h.startImport('cursor.mbox', [rec('x1', 1, 'x1'), rec('x2', 1, 'x2'), rec('x3', 1, 'x3'), rec('x4', 1, 'x4')]);
    const record = h.runtime.state.get(id)!;
    const partial = await h.pull(id, { maxItems: 2 });
    expect(partial.continueSoon).toBe(true);
    // The import's cursor is its own, recorded under its own connector id, and names its files.
    const importCursor = h.set.committedCursor(archiveConnectorId(id))?.cursor;
    expect(importCursor?.startsWith(`${record.manifest_sha256}|`)).toBe(true);
    // The live cursor did not move, and nothing of the live listing was read by the import.
    expect(h.set.committedCursor(FIXTURE_LIVE_INPUT_ID)).toEqual(liveCursor);
    expect(h.ids()).toEqual(['l1', 'l2', 'x1', 'x2']);

    // Each resumes from its own place.
    await h.pullLive();
    expect(h.liveLog.cursors.at(-1)).toBe('2');
    expect(h.ids()).toEqual(['l1', 'l2', 'l3', 'l4', 'l5', 'x1', 'x2']);
    await h.importAll(id);
    expect(h.archiveLog.cursors.at(-1)).toBe('2');
    expect(h.ids()).toEqual(['l1', 'l2', 'l3', 'l4', 'l5', 'x1', 'x2', 'x3', 'x4']);
  });

  test('a crash in the middle of an input replays from its last committed cursor with no duplicates', async () => {
    const h = onePipelineHarness(cleanups, { pageSize: 2 });
    h.connectLive();
    const id = await h.startImport('crash.mbox', [rec('a', 1, 'a'), rec('b', 1, 'b'), rec('c', 1, 'c'), rec('d', 1, 'd'), rec('e', 1, 'e')]);
    // The input fails when it reaches its third page.
    h.gate.before = (index) => { if (index >= 4) throw new Error('the export could not be read any further'); };
    await h.pull(id).catch(() => undefined);
    const afterCrash = h.ids();
    expect(afterCrash.length).toBeGreaterThanOrEqual(2);
    expect(afterCrash.length).toBeLessThan(5);
    // The record is still importing: the crash is not a verdict on the export.
    expect(h.runtime.state.get(id)?.status).toBe('importing');
    h.gate.before = undefined;
    await h.importAll(id);
    expect(h.ids()).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(h.duplicates()).toEqual([]);
    // What the import counts is the export's records, each once.
    expect(h.runtime.state.get(id)?.intake?.read).toBe(5);
  });
});

describe('a held item stays held', () => {
  test('items an archive input built are held Private until judged; a live-only item is not', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    h.live.records = [rec('live-only', 1, 'only live ever saw this')];
    await h.pullLive();
    const id = await h.startImport('held.mbox', [rec('from-archive', 1, 'only the archive had this')]);
    await h.importAll(id);
    expect(h.ledgerRecord('from-archive')?.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
    expect(h.ledgerRecord('live-only')?.reasons ?? []).not.toContain(HELD_UNTIL_JUDGED_REASON);
    // The held item's text rests Private; the live-only item's is where a live item's goes.
    expect(h.contentDomain('from-archive')).toBe('secure_local');
    expect(h.contentDomain('live-only')).toBe('internal');
  });

  test('the hold keeps applying to a later version that live brings, until the private model has judged', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    const id = await h.startImport('persist.mbox', [rec('a', 1, 'archive a')]);
    await h.importAll(id);
    h.live.records = [rec('a', 2, 'live a edited')];
    await h.pullLive();
    expect(versionOf(h, 'a')).toBe('2');
    expect(h.ledgerRecord('a')?.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
    expect(h.contentDomain('a')).toBe('secure_local');
    expect(h.textOf('a')).toBe('live a edited');
    expect(h.duplicates()).toEqual([]);
  });

  test('children of an archive record arrive as a live record\'s do: the same shape, held as the parent is', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    const attached = { key: 'one', name: 'tides.pdf', text: 'tide table' };
    h.live.records = [rec('live-parent', 1, 'live parent', { children: [attached] })];
    await h.pullLive();
    const id = await h.startImport('children.mbox', [rec('arch-parent', 1, 'archive parent', { children: [attached] })]);
    await h.importAll(id);
    const childRow = (parent: string) =>
      h.rows().find((entry) => entry.providerItemId === fixtureChildId(parent, 'one') && entry.tombstoned === 0)!;
    for (const parent of ['live-parent', 'arch-parent']) {
      const child = childRow(parent);
      expect(child, parent).toBeDefined();
      expect(child.parent, parent).toBe(`fixture-account:${parent}`);
      expect(child.locator, parent).toBe(fixtureLocator(rec(parent, 1, undefined), attached));
      expect(child.version, parent).toBe('1');
      expect(child.chunks, parent).toBe(0);
    }
    // Their bytes are read later, so their names rest where a child's names do; the parent's text is held.
    expect(h.ledgerRecord('arch-parent')?.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
    expect(h.ledgerRecord(fixtureChildId('arch-parent', 'one'))?.reasons).toContain(HELD_UNTIL_JUDGED_REASON);
    expect(h.ledgerRecord(fixtureChildId('live-parent', 'one'))?.reasons ?? []).not.toContain(HELD_UNTIL_JUDGED_REASON);
    expect(h.ids()).toEqual([
      'arch-parent', fixtureChildId('arch-parent', 'one'), 'live-parent', fixtureChildId('live-parent', 'one'),
    ].sort());
    expect(h.duplicates()).toEqual([]);
  });

  test('a record that is the same export again changes nothing (children included)', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    const attached = { key: 'one', name: 'tides.pdf', text: 'tide table' };
    const parent = rec('p', 1, 'parent', { children: [attached] });
    h.live.records = [parent];
    await h.pullLive();
    const before = JSON.stringify(h.rows());
    const id = await h.startImport('again.mbox', [parent]);
    await h.importAll(id);
    expect(JSON.stringify(h.rows())).toBe(before);
  });
});


describe('which account an import joins', () => {
  const startedOrAsked = (h: OnePipelineHarness, name: string, records: readonly FxRecord[], answer: { confirmAccount?: true; keepApart?: true } = {}) =>
    h.dashboard.approve({ key: h.writeExport(name, records), ...answer });

  test('the same account joins the source and writes into its stores', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive('export-account');
    const result = await startedOrAsked(h, 'same.mbox', [rec('a', 1, 'a')]);
    expect(result).toMatchObject({ ok: true, status: 'started' });
    if (!result.ok || result.status !== 'started') throw new Error('expected a start');
    expect(h.runtime.state.get(result.archive_id)?.target).toMatchObject({ source_id: FIXTURE_SOURCE_ID, import_account_id: 'export-account' });
    await h.importAll(result.archive_id);
    expect(h.ids()).toEqual(['a']);
  });

  test('a source with no account yet gets one that names the export\'s, and a later live connect joins it', async () => {
    const h = onePipelineHarness(cleanups);
    const result = await startedOrAsked(h, 'new.mbox', [rec('a', 1, 'a')]);
    expect(result).toMatchObject({ ok: true, status: 'started' });
    const entry = findRegistryAccount(readSourceRegistry(h.env), FIXTURE_SOURCE_ID, '1');
    expect(entry?.provider_account_hash).toBeDefined();
    // The same provider account connecting live is the account the import wrote into.
    expect(recordProviderAccount({ sourceId: FIXTURE_SOURCE_ID }, 'export-account', h.env)).toBe('same');
    expect(recordProviderAccount({ sourceId: FIXTURE_SOURCE_ID }, 'another-account', h.env)).toBe('different');
  });

  test('an account that cannot be proved is asked about; the owner\'s yes then lets it in', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive(null);
    const asked = await startedOrAsked(h, 'unproven.mbox', [rec('a', 1, 'a')]);
    expect(asked).toMatchObject({ ok: true, status: 'confirm_account', source: { id: FIXTURE_SOURCE_ID } });
    // Nothing was recorded or written by asking.
    expect(h.runtime.state.list()).toEqual([]);
    expect(h.ids()).toEqual([]);
    const confirmed = await startedOrAsked(h, 'unproven.mbox', [rec('a', 1, 'a')], { confirmAccount: true });
    if (!confirmed.ok || confirmed.status !== 'started') throw new Error('expected a start after the owner said yes');
    expect(h.runtime.state.get(confirmed.archive_id)?.target).toMatchObject({ source_id: FIXTURE_SOURCE_ID, owner_confirmed: true });
    await h.importAll(confirmed.archive_id);
    expect(h.ids()).toEqual(['a']);
  });

  test('the owner\'s yes is about the account it was given for: bound to another account before the first pass, the import writes nothing, stops and asks again', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive('account-a');
    h.evidence.current = { kind: 'none' };
    const key = h.writeExport('none.mbox', [rec('a', 1, 'a'), rec('b', 1, 'b')]);
    expect(await h.dashboard.approve({ key })).toMatchObject({ ok: true, status: 'confirm_account' });
    const confirmed = await h.dashboard.approve({ key, confirmAccount: true });
    if (!confirmed.ok || confirmed.status !== 'started') throw new Error('expected a start after the owner said yes');
    expect(h.runtime.state.get(confirmed.archive_id)?.target?.confirmed_account).toBeDefined();

    // The account guard binds the empty source to another account before the first pass.
    expect(recordProviderAccount({ sourceId: FIXTURE_SOURCE_ID }, 'account-b', h.env, { historyEmpty: true })).toBe('recorded');
    const stopped = await h.pull(confirmed.archive_id);
    expect(stopped.record).toMatchObject({ status: 'stopped', stop: { code: 'account_changed' } });
    expect(h.ids()).toEqual([]);
    expect(h.rows()).toEqual([]);

    // Choosing the same export again asks the question again; a yes binds it to the account that is there.
    expect(await h.dashboard.approve({ key })).toMatchObject({ ok: true, status: 'confirm_account', source: { id: FIXTURE_SOURCE_ID } });
    expect(h.runtime.state.get(confirmed.archive_id)?.status).toBe('stopped');
    const again = await h.dashboard.approve({ key, confirmAccount: true });
    expect(again).toMatchObject({ ok: true, status: 'started', archive_id: confirmed.archive_id });
    const done = await h.importAll(confirmed.archive_id);
    expect(done.record?.status).toBe('imported');
    expect(h.ids()).toEqual(['a', 'b']);
  });

  test('keeping an export apart, or one of a different account, stays under Archives with its own Remove', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive('someone-elses-account');
    const different = await startedOrAsked(h, 'different.mbox', [rec('a', 1, 'a')]);
    if (!different.ok || different.status !== 'started') throw new Error('expected a start');
    expect(h.runtime.state.get(different.archive_id)?.target).toBeUndefined();
    expect(h.dashboard.view().archives.map((archive) => archive.id)).toContain(different.archive_id);

    const h2 = onePipelineHarness(cleanups);
    h2.connectLive(null);
    const apart = await startedOrAsked(h2, 'apart.mbox', [rec('a', 1, 'a')], { keepApart: true });
    if (!apart.ok || apart.status !== 'started') throw new Error('expected a start');
    expect(h2.runtime.state.get(apart.archive_id)?.target).toBeUndefined();
    expect(h2.dashboard.view().archives.map((archive) => archive.id)).toContain(apart.archive_id);
    // Apart, it has a Remove; nothing of it is in the source's stores.
    expect(h2.dashboard.remove(apart.archive_id)).toMatchObject({ ok: true });
    expect(h2.ids()).toEqual([]);
  });

  test('an export that names no account joins the only account at the owner\'s confirmation', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive('export-account');
    h.evidence.current = { kind: 'none' };
    const asked = await startedOrAsked(h, 'none.mbox', [rec('a', 1, 'a')]);
    expect(asked).toMatchObject({ ok: true, status: 'confirm_account' });
    const confirmed = await startedOrAsked(h, 'none.mbox', [rec('a', 1, 'a')], { confirmAccount: true });
    expect(confirmed).toMatchObject({ ok: true, status: 'started' });
  });

  test('an export the source cannot take stays under Archives', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive('export-account');
    h.evidence.current = { kind: 'archives' };
    const result = await startedOrAsked(h, 'archives.mbox', [rec('a', 1, 'a')]);
    if (!result.ok || result.status !== 'started') throw new Error('expected a start');
    expect(h.runtime.state.get(result.archive_id)?.target).toBeUndefined();
  });

  test('an import stops, writing nothing more, when the account the source holds is no longer the export\'s', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive('export-account');
    const id = await h.startImport('moved.mbox', [rec('a', 1, 'a'), rec('b', 1, 'b'), rec('c', 1, 'c')]);
    await h.pull(id, { maxItems: 2 });
    expect(h.ids()).toEqual(['a', 'b']);
    // The export now belongs to another account than the source's.
    h.runtime.state.update(id, (entry) => { entry.target!.import_account_id = 'a-different-account'; });
    const outcome = await h.pull(id);
    expect(outcome.record?.status).toBe('stopped');
    expect(outcome.record?.stop?.code).toBe('account_changed');
    expect(h.ids()).toEqual(['a', 'b']);
    // That one is a problem with a route to it: the source's card says so.
    expect(h.dashboard.present().attention).toEqual([expect.objectContaining({ kind: 'stopped', id })]);
  });
});

describe('the source\'s lock', () => {
  test('an import runs under the source\'s own exclusive runner, so a guarded task never runs inside a pass', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive('export-account');
    const id = await h.startImport('lock.mbox', [rec('a', 1, 'a'), rec('b', 1, 'b'), rec('c', 1, 'c')]);
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    h.gate.before = async () => { order.push('page'); await held; };
    const pulling = h.pull(id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const guarded = h.exclusive(async () => { order.push('guarded'); });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The pass is waiting inside the runner; the guarded task has not started.
    expect(order).toEqual(['page']);
    h.gate.before = undefined;
    release();
    await pulling;
    await guarded;
    expect(order).toEqual(['page', 'guarded']);
  });

  test('the scheduler runs an import under the source\'s key, with no removal and no extraction task of its own', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive('export-account');
    const id = await h.startImport('sched.mbox', [rec('a', 1, 'a'), rec('b', 1, 'b'), rec('c', 1, 'c')]);
    const source = createArchiveImportsSchedulerSource({
      runtime: h.runtime,
      config: defaultConfig(),
      extraction: { runner: () => undefined } as never,
      maxItems: 2,
    })!;
    const tasks = source.tasks.filter((task) => task.id === archiveImportTaskId(id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ kind: 'sync', writer: true, concurrencyKey: 'fixture.mail' });
    const first = await tasks[0]!.run({} as never);
    expect(first.continueSoon).toBe(true);
    expect(h.ids()).toEqual(['a', 'b']);
    const second = await tasks[0]!.run({} as never);
    expect(second.continueSoon).not.toBe(true);
    expect(h.ids()).toEqual(['a', 'b', 'c']);
  });
});

describe('what the source\'s card shows of an import', () => {
  test('counts the import\'s own run: N read, of which M were already there; the dataset counts each item once', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive('export-account');
    h.live.records = [rec('a', 2, 'live a'), rec('b', 2, 'live b')];
    await h.pullLive();
    const id = await h.startImport('counts.mbox', [rec('a', 2, 'archive a'), rec('b', 1, 'older b'), rec('c', 1, 'archive c')]);
    await h.importAll(id);
    const [source] = h.dashboard.sourceImports();
    expect(source?.sourceId).toBe(FIXTURE_SOURCE_ID);
    expect(source?.imports).toHaveLength(1);
    expect(source?.imports[0]).toMatchObject({ id, status: 'imported', read: 3, alreadyThere: 2 });
    expect(h.ids()).toEqual(['a', 'b', 'c']);
    // A second import of the same history adds to its own count, not the first's, and still no duplicate.
    const again = await h.startImport('counts-again.mbox', [rec('a', 2, 'archive a'), rec('c', 1, 'archive c'), rec('d', 1, 'archive d')]);
    await h.importAll(again);
    const imports = h.dashboard.sourceImports()[0]!.imports;
    expect(imports.find((entry) => entry.id === again)).toMatchObject({ read: 3, alreadyThere: 2 });
    expect(imports.find((entry) => entry.id === id)).toMatchObject({ read: 3, alreadyThere: 2 });
    expect(h.ids()).toEqual(['a', 'b', 'c', 'd']);
    expect(h.duplicates()).toEqual([]);
  });

  test('a replay after a crash counts each record once', async () => {
    const h = onePipelineHarness(cleanups, { pageSize: 1 });
    h.connectLive('export-account');
    const id = await h.startImport('replay.mbox', [rec('a', 1, 'a'), rec('b', 1, 'b'), rec('c', 1, 'c')]);
    h.gate.before = (index) => { if (index >= 2) throw new Error('crash'); };
    await h.pull(id).catch(() => undefined);
    h.gate.before = undefined;
    await h.importAll(id);
    expect(h.dashboard.sourceImports()[0]!.imports[0]).toMatchObject({ read: 3, alreadyThere: 0 });
  });

  test('says which history each input covers: imported up to the export\'s date, live since pairing', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive('export-account');
    const id = await h.startImport('covers.mbox', [
      rec('a', 1, 'a', { sentAt: '2019-03-02T10:00:00.000Z' }),
      rec('b', 1, 'b', { sentAt: '2021-07-15T10:00:00.000Z' }),
    ]);
    await h.importAll(id);
    expect(h.dashboard.sourceImports()[0]).toMatchObject({
      covers: { importedFrom: '2019-03-02', importedTo: '2021-07-15', liveSince: '2026-05-01' },
    });
  });

  test('a merged import is not an Archives row, is not counted there, and has no Remove of its own', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive('export-account');
    const id = await h.startImport('merged.mbox', [rec('a', 1, 'a')]);
    await h.importAll(id);
    expect(h.dashboard.view().archives.map((archive) => archive.id)).not.toContain(id);
    expect(h.dashboard.present().archives).toBe(0);
    expect(h.dashboard.remove(id)).toMatchObject({ ok: false, code: 'part_of_source' });
    expect(h.dashboard.agent.remove(id)).toMatchObject({ ok: false, code: 'part_of_source' });
    expect(h.ids()).toEqual(['a']);
  });
});

describe('Stop', () => {
  test('keeps what was imported, and approving the same export again picks it up where it stopped', async () => {
    const h = onePipelineHarness(cleanups, { pageSize: 2 });
    h.connectLive('export-account');
    const id = await h.startImport('stop.mbox', [rec('a', 1, 'a'), rec('b', 1, 'b'), rec('c', 1, 'c'), rec('d', 1, 'd')]);
    await h.pull(id, { maxItems: 2 });
    expect(h.ids()).toEqual(['a', 'b']);
    expect(h.dashboard.stop(id)).toEqual({ ok: true });
    const stopped = h.runtime.state.get(id)!;
    expect(stopped.status).toBe('stopped');
    expect(stopped.stop?.code).toBe('stopped_by_owner');
    // What it imported stays, and a stopped import reads nothing more.
    expect(h.ids()).toEqual(['a', 'b']);
    await h.pull(id);
    expect(h.ids()).toEqual(['a', 'b']);
    expect(h.dashboard.sourceImports()[0]!.imports[0]).toMatchObject({ status: 'stopped', stop: { code: 'stopped_by_owner' } });
    // The owner's own Stop is not a problem to fix.
    expect(h.dashboard.present().attention ?? []).toEqual([]);
    // Choosing the same export again resumes it from its own cursor.
    const resumed = await h.dashboard.approve({ key: join(h.home, 'Exports', 'stop.mbox') });
    expect(resumed).toMatchObject({ ok: true, status: 'started', archive_id: id });
    await h.importAll(id);
    // It read on from where it stopped: the input was handed its own cursor, not the start.
    expect(h.archiveLog.cursors.at(-1)).toBe('2');
    expect(h.ids()).toEqual(['a', 'b', 'c', 'd']);
    expect(h.runtime.state.get(id)?.status).toBe('imported');
    expect(h.duplicates()).toEqual([]);
  });

  test('only an import that is part of a source, and still running, can be stopped', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive('export-account');
    const id = await h.startImport('done.mbox', [rec('a', 1, 'a')]);
    await h.importAll(id);
    expect(h.dashboard.stop(id)).toMatchObject({ ok: false, code: 'not_importing' });
    expect(h.dashboard.stop('no-such-archive')).toMatchObject({ ok: false, code: 'unknown_archive' });
  });
});

describe('deleting the whole source', () => {
  test('removes the items of both inputs and the imports that were part of it, and keeps an import that stayed apart', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive('export-account');
    h.live.records = [rec('live-item', 1, 'live')];
    await h.pullLive();
    const merged = await h.startImport('merged-delete.mbox', [rec('archive-item', 1, 'archive')]);
    await h.importAll(merged);
    expect(h.ids()).toEqual(['archive-item', 'live-item']);
    // An export of another account stays under Archives, and is not the source's to delete.
    h.evidence.current = { kind: 'archives' };
    const apart = await h.dashboard.approve({ key: h.writeExport('apart-delete.mbox', [rec('x', 1, 'x')]) });
    if (!apart.ok || apart.status !== 'started') throw new Error('expected a start');

    const result = deleteOlympusData({ sourceId: FIXTURE_SOURCE_ID, homeDir: h.home });

    expect(result.removed.some((path) => path === h.storePaths.secure_local)).toBe(true);
    for (const path of Object.values(h.storePaths)) expect(existsSync(path)).toBe(false);
    const left = h.runtime.state.list().map((record) => record.archive_id);
    expect(left).not.toContain(merged);
    expect(left).toContain(apart.archive_id);
  });
  test('fails loudly when an import record cannot be read: nothing is removed and the delete stays to be run again, and then it leaves no import behind', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive('export-account');
    h.live.records = [rec('live-item', 1, 'live')];
    await h.pullLive();
    const merged = await h.startImport('unreadable.mbox', [rec('a', 1, 'a'), rec('b', 1, 'b'), rec('c', 1, 'c')]);
    await h.pull(merged, { maxItems: 2 });
    expect(h.runtime.state.get(merged)?.status).toBe('importing');
    const recordPath = h.runtime.state.path;
    const readable = readFileSync(recordPath, 'utf8');

    writeFileSync(recordPath, '{ not an import record');
    let failure: unknown;
    try {
      deleteOlympusData({ sourceId: FIXTURE_SOURCE_ID, homeDir: h.home });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ForgetStepError);
    expect((failure as ForgetStepError).stepId).toBe('archive-imports-of-source');
    // No store was removed: the delete is incomplete, not "done with zero imports".
    for (const path of Object.values(h.storePaths)) expect(existsSync(path)).toBe(true);
    expect(h.ids()).toContain('live-item');

    // Once the record reads again the same delete finishes, and the import that was going into the source is gone with it.
    writeFileSync(recordPath, readable);
    deleteOlympusData({ sourceId: FIXTURE_SOURCE_ID, homeDir: h.home });
    for (const path of Object.values(h.storePaths)) expect(existsSync(path)).toBe(false);
    expect(h.runtime.state.list().map((record) => record.archive_id)).not.toContain(merged);
  });

  test('an import record that outlived the delete writes nothing and puts no history back', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive('export-account');
    const merged = await h.startImport('outlived.mbox', [rec('a', 1, 'a'), rec('b', 1, 'b')]);
    await h.pull(merged, { maxItems: 1 });
    const recordPath = h.runtime.state.path;
    const survivor = readFileSync(recordPath, 'utf8');
    deleteOlympusData({ sourceId: FIXTURE_SOURCE_ID, homeDir: h.home });
    // The record comes back (a file that read again, a restore): it must not recreate the account.
    writeFileSync(recordPath, survivor);
    const outcome = await h.pull(merged);
    expect(outcome.record?.status).toBe('stopped');
    expect(['account_changed', 'source_unavailable']).toContain(outcome.record?.stop?.code ?? '');
    for (const path of Object.values(h.storePaths)) expect(existsSync(path)).toBe(false);
  });
});
