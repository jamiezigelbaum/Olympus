// Reflect, Roam and Evernote as import-only sources (docs/design/archive-live-one-dataset.md,
// step 7): each has its own card in Sources, its own Import an archive for its
// formats, and lists its imports, which stay stored under Archives (one account
// scope each, with their Remove), as source-storage.md keeps archive-only
// formats. Synthetic files only, through the real dashboard approval.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARCHIVE_FORMATS, archiveSourceCardOf, archiveSourceCards } from '../src/core/archive-formats.ts';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { buildSourceDashboardViewModel, DASHBOARD_SUPPORTED_SOURCES } from '../src/workers/source-dashboard.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { secretLocationsPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { createArchiveImportDashboard } from '../src/workers/archive-import/dashboard.ts';
import { createArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import { MacPermissions } from '../src/workers/local-files/mac-permissions.ts';
import { createArchivePathResolver } from '../src/workers/local-files/scope-browser.ts';
import { approveStaged } from './support/stage-upload.ts';
import { VolumeResolver } from '../src/workers/local-files/volume-identity.ts';
import { reflectJson, reflectNotes } from './support/archive-fixtures-reflect.ts';
import { roamJson, roamPages } from './support/archive-fixtures-roam.ts';
import { enexExport, evernoteNotes } from './support/archive-fixtures-evernote.ts';
import { previewDashboardToolResult } from '../scripts/dashboard-preview.ts';
import { DASHBOARD_DISCONNECTED_DATA_KEPT } from '../src/workers/dashboard/vocabulary.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function fixture() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'archive-cards-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const home = join(base, 'home');
  const exports = join(home, 'Exports');
  mkdirSync(exports, { recursive: true });
  const env = { HOME: home, XDG_DATA_HOME: join(base, 'xdg'), OPENCLAW_STATE_DIR: join(base, 'openclaw') };
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
  const volumes = new VolumeResolver({ platform: 'darwin', home, readMounts: () => '/dev/disk3s1s1 on / (apfs, local)', diskutilPlist: () => undefined });
  const permissions = new MacPermissions({ home, memoryPath: join(base, 'folder-access.json'), platform: 'linux' });
  const resolver = createArchivePathResolver({ volumes, home, permissions });
  const dashboard = createArchiveImportDashboard({ runtime, resolver, refreshScheduler: () => undefined, privateModel: () => 'ready', home });
  cleanups.push(() => dashboard.close());
  const write = (name: string, text: string): string => {
    const path = join(exports, name);
    writeFileSync(path, text);
    return path;
  };
  const mbox = (name: string): string => write(name, [
    'From sender@example.invalid Mon Jan  5 10:00:00 2015',
    'From: Sam Example <sam@example.invalid>',
    'Subject: synthetic',
    'Date: Mon, 05 Jan 2015 10:00:00 +0000',
    'Message-ID: <synthetic@example.invalid>',
    '',
    'The synthetic harbour log.',
    '',
  ].join('\n'));
  return { runtime, dashboard, write, mbox };
}

describe('the import-only sources the format registry names', () => {
  test('Reflect (both of its formats), Roam and Evernote each have one card; every other format has none', () => {
    const cards = archiveSourceCards();
    expect(cards.map((card) => ({ id: card.id, label: card.label, formats: card.formats.map((format) => format.id) }))).toEqual([
      { id: 'reflect.archive', label: 'Reflect', formats: ['reflect-json', 'reflect-markdown'] },
      { id: 'roam.archive', label: 'Roam', formats: ['roam-json'] },
      { id: 'evernote.archive', label: 'Evernote', formats: ['evernote-enex'] },
    ]);
    for (const format of ARCHIVE_FORMATS) {
      if (format.family !== 'note') expect(archiveSourceCardOf(format.id)).toBeUndefined();
    }
  });

  test('each card is a source on the dashboard, part of the public Archives source, owning no corpus of its own', () => {
    for (const card of archiveSourceCards()) {
      const definition = DASHBOARD_SUPPORTED_SOURCES.find((entry) => entry.source_id === card.id)!;
      expect(definition).toMatchObject({ label: card.label, public_source_id: 'archive.imports', connect_action: { kind: 'archive_import' } });
      expect(definition.corpus_source_ids).toEqual([]);
    }
  });
});

describe('an import-only source\'s card', () => {
  test('its Import an archive takes its exports, which show in its card and not under Other archives', async () => {
    const f = fixture();
    expect(f.dashboard.archiveSources().map((entry) => entry.sourceId)).toEqual(['reflect.archive', 'roam.archive', 'evernote.archive']);
    const reflect = f.dashboard.archiveSources().find((entry) => entry.sourceId === 'reflect.archive')!;
    expect(reflect.intro).toContain('a Reflect export');
    expect(reflect.intro).not.toContain('mail export');

    const path = f.write('Reflect notes.json', reflectJson(reflectNotes(3)));
    const started = await approveStaged(f.dashboard, path, { sourceId: 'reflect.archive' });
    expect(started).toMatchObject({ ok: true, status: 'started', source: { id: 'reflect.archive', label: 'Reflect' } });
    // Stored under Archives as before (no source target), one account scope of its own.
    const record = f.runtime.state.list()[0]!;
    expect(record.target).toBeUndefined();
    expect(record.format).toBe('reflect-json');

    const card = f.dashboard.cardViews().find((entry) => entry.sourceId === 'reflect.archive')!;
    expect(card.archives.map((entry) => entry.name)).toEqual(['Reflect notes.json']);
    expect(f.dashboard.cardViews().find((entry) => entry.sourceId === 'roam.archive')!.archives).toEqual([]);
    expect(f.dashboard.view().archives).toEqual([]);
    expect(f.dashboard.present().archives).toBe(0);
    expect(f.dashboard.presentCards()['reflect.archive']).toMatchObject({ archives: 1 });
    expect(f.dashboard.presentCards()['roam.archive']).toMatchObject({ archives: 0 });
  });

  test('the agent\'s status lists every card\'s imports, though the dashboard shows them in their cards', async () => {
    // Found by the release check: a notes import the agent asked for was missing from its status, so it could not follow it.
    const f = fixture();
    const files = [
      f.write('Reflect notes.json', reflectJson(reflectNotes(2))),
      f.write('Roam graph.json', roamJson(roamPages(2))),
      f.write('Evernote notes.enex', enexExport(evernoteNotes(2))),
    ];
    const ids: string[] = [];
    for (const path of files) {
      const started = await approveStaged(f.dashboard, path);
      if (!started.ok || started.status !== 'started') throw new Error(`not started: ${path}`);
      ids.push(started.archive_id);
    }
    expect(f.dashboard.view().archives).toEqual([]);
    const status = f.dashboard.agent.status();
    if (!status.ok) throw new Error('status refused');
    expect(status.archives.map((archive) => archive.name).sort()).toEqual(['Evernote notes.enex', 'Reflect notes.json', 'Roam graph.json']);
    expect(status.archives.map((archive) => archive.format).sort()).toEqual(['Evernote export (.enex)', 'Reflect notes (JSON)', 'Roam notes (JSON)']);
    // And each by its id, as the agent follows the one it asked for.
    for (const id of ids) expect(f.dashboard.agent.status(id)).toMatchObject({ ok: true, archives: [{ archive_id: id }] });
  });

  test('Import another archive sends the same file to the same card', async () => {
    const f = fixture();
    const path = f.write('Reflect notes.json', reflectJson(reflectNotes(2)));
    const started = await approveStaged(f.dashboard, path);
    expect(started).toMatchObject({ ok: true, status: 'started', source: { id: 'reflect.archive', label: 'Reflect' } });
    expect(f.dashboard.cardViews().find((entry) => entry.sourceId === 'reflect.archive')!.archives).toHaveLength(1);
  });

  test('another kind of export is refused from the card, and nothing is recorded', async () => {
    const f = fixture();
    const refused = await approveStaged(f.dashboard, f.mbox('Takeout.mbox'), { sourceId: 'roam.archive' });
    expect(refused).toMatchObject({ ok: false, code: 'not_this_source' });
    expect(refused.ok ? '' : refused.message).toContain("This isn't a Roam export.");
    expect(f.runtime.state.list()).toEqual([]);
  });

  test('an import of the card keeps its Remove, as under Archives', async () => {
    const f = fixture();
    const path = f.write('Reflect notes.json', reflectJson(reflectNotes(2)));
    const started = await approveStaged(f.dashboard, path, { sourceId: 'reflect.archive' });
    if (!started.ok || started.status !== 'started') throw new Error('not started');
    expect(f.dashboard.remove(started.archive_id)).toEqual({ ok: true });
    expect(f.runtime.state.get(started.archive_id)?.status).toBe('removing');
  });

  test('the card reads its own imports on the dashboard; Other archives does not count them', async () => {
    const f = fixture();
    await approveStaged(f.dashboard, f.write('Reflect notes.json', reflectJson(reflectNotes(2))));
    const view = buildSourceDashboardViewModel({
      sourceIndexStatus: { kind: 'source_index_status', generated_at: new Date().toISOString(), corpora: [], policy: {} } as never,
      sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})),
      connectedHandleRegistry: { version: 1, handles: [] },
      apiKeyAvailability: {},
      importedArchives: f.dashboard.present(),
      importedArchivesByCard: f.dashboard.presentCards(),
    });
    const reflect = view.sources.find((entry) => entry.source_id === 'reflect.archive')!;
    const roam = view.sources.find((entry) => entry.source_id === 'roam.archive')!;
    const archives = view.sources.find((entry) => entry.source_id === 'archive.imports')!;
    expect(reflect.connection.state).not.toBe('not_connected');
    expect(roam.connection.label).toMatch(/no archives imported yet/i);
    expect(archives.connection.label).toMatch(/no archives imported yet/i);
    // In ChatGPT the card's own action is Import an archive (it opens the computer's dashboard); Other archives keeps Import another archive.
    const chatgpt = buildChatGptDashboardViewModel(view, {});
    const roamRow = chatgpt.sources.find((source) => source.id === 'roam.archive')!;
    const archivesRow = chatgpt.sources.find((source) => source.id === 'archive.imports')!;
    expect(roamRow.primary?.label).toBe('Import an archive');
    expect(archivesRow.primary?.label).toBe('Import another archive');
  });

  test('a card with nothing imported, beside notes another card imported, never reads as a disconnected account', () => {
    // An Evernote import is the only one: its items sit in the notes store set Other archives owns.
    const result = previewDashboardToolResult('archives-notes-evernote', false) as unknown as { structuredContent: { sources: Array<{ id: string; detail?: string }> } };
    const detail = (id: string) => result.structuredContent.sources.find((source) => source.id === id)?.detail ?? '';
    // The card whose import is running says so in its own words, not a corpus's first sync.
    expect(detail('evernote.archive')).toMatch(/^importing/i);
    for (const id of ['reflect.archive', 'roam.archive', 'archive.imports']) {
      expect(detail(id)).not.toBe(DASHBOARD_DISCONNECTED_DATA_KEPT);
      expect(detail(id)).toMatch(/no archives imported yet/i);
    }
  });
});
