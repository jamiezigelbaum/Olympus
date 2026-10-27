// A source's own Import an archive (owner, 2026-10-25): the dashboard lists the
// cards whose connector reads archives as inputs, and an approval that names one
// recognises only that source's formats. Run through the real dashboard approval
// with the fixture source of test/support/one-pipeline-harness.ts (it reads the
// mbox format); every file is invented.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { FIXTURE_LABEL, FIXTURE_SOURCE_ID, onePipelineHarness, type OnePipelineHarness } from './support/one-pipeline-harness.ts';
import { approveStaged, stageUpload } from './support/stage-upload.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

/** A WhatsApp chat export beside the fixture's mbox: a format the fixture source does not read. */
function whatsappExport(h: OnePipelineHarness): string {
  const path = join(h.home, 'Exports', 'WhatsApp Chat with Sam Example.txt');
  writeFileSync(path, '12/01/2020, 10:00 - Sam Example: hello there\n12/01/2020, 10:01 - Sam Example: still here\n');
  return path;
}

describe('a source\'s own Import an archive', () => {
  test('the dashboard lists the card of each source that reads archives, with its exports in the picker\'s words', () => {
    const h = onePipelineHarness(cleanups);
    const sources = h.dashboard.archiveSources();
    // The fixture source first; the import-only sources of the format registry (Reflect, Roam, Evernote) after it.
    expect(sources.map((entry) => ({ sourceId: entry.sourceId, label: entry.label }))[0]).toEqual({ sourceId: FIXTURE_SOURCE_ID, label: FIXTURE_LABEL });
    expect(sources.slice(1).map((entry) => entry.sourceId)).toEqual(['reflect.archive', 'roam.archive', 'evernote.archive']);
    // The fixture reads mbox only: the picker names that export and no other.
    expect(sources[0]!.intro).toContain('a mail export');
    expect(sources[0]!.intro).not.toContain('WhatsApp');
  });

  test('an export of the source\'s own format starts into the source', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    const path = h.writeExport('own.mbox', []);
    const result = await approveStaged(h.dashboard, path, { sourceId: FIXTURE_SOURCE_ID });
    // The answer names the card it joined, so the line can say where it shows.
    expect(result).toMatchObject({ ok: true, status: 'started', source: { id: FIXTURE_SOURCE_ID, label: FIXTURE_LABEL } });
    const records = h.runtime.state.list();
    expect(records).toHaveLength(1);
    expect(records[0]!.target?.source_id).toBe(FIXTURE_SOURCE_ID);
  });

  test('another kind of export is refused with the route to Import another archive, and nothing is recorded', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    const path = whatsappExport(h);
    const refused = await approveStaged(h.dashboard, path, { sourceId: FIXTURE_SOURCE_ID });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.code).toBe('not_this_source');
    expect(refused.message).toBe(`This isn't a ${FIXTURE_LABEL} export. From the ${FIXTURE_LABEL} card, Olympus imports only these: Mail (mbox). For any other export, use Import another archive under Other archives.`);
    expect(h.runtime.state.list()).toEqual([]);
    // The same file through Import another archive (no source named) is taken, by what it is, under Archives.
    const apart = await approveStaged(h.dashboard, path);
    expect(apart).toMatchObject({ ok: true, status: 'started' });
    expect(apart.ok && apart.status === 'started' ? apart.source : 'none').toBeUndefined();
    expect(h.runtime.state.list()[0]!.target).toBeUndefined();
  });

  test('an export that does not name its account is asked about from the card exactly as from Import another archive', async () => {
    const h = onePipelineHarness(cleanups);
    h.connectLive();
    h.evidence.current = { kind: 'none' };
    const path = h.writeExport('unnamed.mbox', []);
    const generic = await approveStaged(h.dashboard, path);
    const fromCard = await approveStaged(h.dashboard, path, { sourceId: FIXTURE_SOURCE_ID });
    expect(generic).toMatchObject({ ok: true, status: 'confirm_account', source: { id: FIXTURE_SOURCE_ID } });
    expect(fromCard).toEqual(generic);
    expect(h.runtime.state.list()).toEqual([]);
    // Kept apart from the card: under Other archives, as from the general button.
    const apart = await approveStaged(h.dashboard, path, { sourceId: FIXTURE_SOURCE_ID, keepApart: true });
    expect(apart).toMatchObject({ ok: true, status: 'started' });
    expect(apart.ok && apart.status === 'started' ? apart.source : 'none').toBeUndefined();
    expect(h.runtime.state.list()[0]!.target).toBeUndefined();
  });

  test('a card no source registers is refused before anything is read', async () => {
    const h = onePipelineHarness(cleanups);
    const path = h.writeExport('own.mbox', []);
    const refused = await approveStaged(h.dashboard, path, { sourceId: 'telegram.messages' });
    expect(refused).toMatchObject({ ok: false, code: 'unknown_source' });
    expect(h.runtime.state.list()).toEqual([]);
  });

  test('while the list of imports cannot be read, no card imports (nothing would overwrite it)', () => {
    const h = onePipelineHarness(cleanups);
    mkdirSync(dirname(h.runtime.state.path), { recursive: true });
    writeFileSync(h.runtime.state.path, '{ not json');
    expect(h.dashboard.archiveSources()).toEqual([]);
  });
});
