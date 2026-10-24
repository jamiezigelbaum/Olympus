/**
 * A per-source Delete also forgets the source's rows in the shared files
 * (core/source-forget-registry.ts), so reconnecting starts clean. These tests
 * run it through deleteOlympusData, the primitive both the CLI and the
 * worker's Delete end in.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { deleteOlympusData, forgetSourceRowsAgain, lifecycleSourceSpecs } from '../src/data-lifecycle.ts';
import { ForgetStepError } from '../src/core/source-forget-registry.ts';
import { sourceRegistryPath, updateSourceRegistry } from '../src/core/source-registry.ts';
import { createTrustedSourceWatchOwnerContext, defaultSourceWatchDbPath, LocalSourceWatchStore } from '../src/core/source-watch.ts';
import { defaultSourceDashboardHistoryDbPath, SqliteSourceDashboardHistory } from '../src/workers/source-dashboard.ts';
import {
  MINE,
  OTHER,
  SEEDED_FILES,
  layoutUnder,
  seedAllFiles,
  treeDigest,
} from './helpers/forget-seeds.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** A data root with Dropbox's connector store on disk, and every shared file seeded for two sources. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'olympus-lifecycle-forget-'));
  roots.push(root);
  const layout = layoutUnder(root);
  const homeDir = join(root, 'home');
  const store = lifecycleSourceSpecs().find((entry) => entry.sourceId === MINE.source_id)!.connectorStorePaths!({ homeDir })[0]!;
  mkdirSync(dirname(store), { recursive: true });
  writeFileSync(store, 'indexed');
  seedAllFiles(layout);
  const run = (options: { dryRun?: boolean; sourceId?: string } = {}) => deleteOlympusData({
    sourceId: options.sourceId ?? MINE.source_id,
    homeDir,
    handleRegistryPath: layout.handleRegistryPath,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
  return { root, layout, homeDir, store, run };
}

/** Files this source has rows in, in this fixture: not Gmail's mail scope or the computer connection. */
const dropboxFiles = SEEDED_FILES.filter((file) => file.stepId !== 'mail-source-scopes' && file.stepId !== 'this-computer');

describe('a per-source Delete forgets the source in the shared files', () => {
  test('removes its rows from every shared file, keeps another source\'s, and reports each file', () => {
    const f = fixture();

    const result = f.run();

    expect(result.removed).toContain(f.store);
    expect(existsSync(f.store)).toBe(false);
    for (const file of dropboxFiles) {
      expect(file.left(f.layout, MINE), file.stepId).toBe(0);
      expect(file.left(f.layout, OTHER), file.stepId).toBeGreaterThan(0);
    }
    expect(result.forgotten).toHaveLength(dropboxFiles.length);
    for (const file of dropboxFiles) {
      expect(result.forgotten!.some((line) => line.startsWith(file.path(f.layout))), file.stepId).toBe(true);
    }
    // The report lists files forgotten from, not files removed.
    expect(result.removed.some((path) => path.includes('(') )).toBe(false);
  });

  test('a dry run reports what it would forget and changes nothing', () => {
    const f = fixture();
    const seeded = treeDigest(f.root);

    const preview = f.run({ dryRun: true });

    expect(preview.dryRun).toBe(true);
    expect(treeDigest(f.root)).toEqual(seeded);
    expect(existsSync(f.store)).toBe(true);
    expect(preview.forgotten).toHaveLength(dropboxFiles.length);
    expect(f.run().forgotten).toEqual(preview.forgotten);
  });

  test('a repeat forgets nothing more', () => {
    const f = fixture();
    f.run();
    const settled = treeDigest(f.root);

    const again = f.run();

    expect(again.forgotten).toBeUndefined();
    expect(treeDigest(f.root)).toEqual(settled);
  });

  test('a failing step stops the delete before any bytes are removed, and names the step', () => {
    const f = fixture();
    writeFileSync(defaultSourceDashboardHistoryDbPath(f.layout.env), 'this is not a sqlite file '.repeat(200));

    let thrown: unknown;
    try { f.run(); } catch (error) { thrown = error; }

    expect(thrown).toBeInstanceOf(ForgetStepError);
    expect((thrown as ForgetStepError).stepId).toBe('source-dashboard');
    expect((thrown as ForgetStepError).message).toContain('source-dashboard.sqlite');
    expect(existsSync(f.store)).toBe(true);
    // The retry is clean: fix the file and run it again.
    rmSync(defaultSourceDashboardHistoryDbPath(f.layout.env), { force: true });
    const retried = f.run();
    expect(existsSync(f.store)).toBe(false);
    const scheduler = SEEDED_FILES.find((file) => file.stepId === 'source-scheduler')!;
    expect(scheduler.left(f.layout, MINE)).toBe(0);
    expect(retried.removed).toContain(f.store);
  });

  test('the dependent private answers are erased first, before any other step or any source bytes', () => {
    const f = fixture();
    // The second step cannot run, so the answers having gone shows they ran first.
    writeFileSync(defaultSourceDashboardHistoryDbPath(f.layout.env), 'this is not a sqlite file '.repeat(200));
    const waiting = SEEDED_FILES.find((file) => file.stepId === 'waiting-private-questions')!;
    expect(waiting.left(f.layout, MINE)).toBe(1);

    expect(() => f.run()).toThrow(ForgetStepError);

    expect(waiting.left(f.layout, MINE)).toBe(0);
    expect(waiting.left(f.layout, OTHER)).toBe(1);
    expect(existsSync(f.store)).toBe(true);
  });

  test('forgetting again after a delete removes only what was written back', () => {
    const f = fixture();
    f.run();
    // A poll that read the deleted stores through handles still open.
    const dashboard = SEEDED_FILES.find((file) => file.stepId === 'source-dashboard')!;
    const before = dashboard.left(f.layout, OTHER);
    const history = new SqliteSourceDashboardHistory(defaultSourceDashboardHistoryDbPath(f.layout.env));
    history.record([{
      source_id: MINE.source_id,
      corpus_id: MINE.corpus_id,
      sampled_at: new Date().toISOString(),
      indexed_items: 40,
      content_ready_items: 30,
      queue_waiting: 0,
      queue_active: 0,
      queue_attention: 0,
    }]);
    history.close();
    expect(dashboard.left(f.layout, MINE)).toBeGreaterThan(0);

    const lines = forgetSourceRowsAgain({
      sourceId: MINE.source_id,
      homeDir: f.homeDir,
      handleRegistryPath: f.layout.handleRegistryPath,
    });

    expect(lines.some((line) => line.includes('source-dashboard.sqlite'))).toBe(true);
    expect(dashboard.left(f.layout, MINE)).toBe(0);
    expect(dashboard.left(f.layout, OTHER)).toBe(before);
  });

  test('works from the home and environment alone: the handle registry sits where the CLI puts it', () => {
    const f = fixture();

    deleteOlympusData({ sourceId: MINE.source_id, homeDir: f.homeDir });

    for (const file of dropboxFiles) expect(file.left(f.layout, MINE), file.stepId).toBe(0);
  });
});

describe('the account\'s corpora', () => {
  test('a corpus only the registry entry names is forgotten too', () => {
    const f = fixture();
    const extra = 'secure_local.dropbox.extra';
    updateSourceRegistry(f.layout.env, (registry) => {
      registry.accounts.push({
        source_id: MINE.source_id,
        slot: '1',
        state: 'active',
        layout: 'legacy',
        corpus_ids: [MINE.corpus_id, extra],
        created_at: '2026-10-01T00:00:00.000Z',
      });
    });
    const owner = createTrustedSourceWatchOwnerContext({
      ownerId: 'owner-a',
      routeKind: 'openclaw_task',
      routeTargetId: '019f6ff4-2fb0-70a3-91dd-3ef3ada9354f',
    });
    const watches = new LocalSourceWatchStore(defaultSourceWatchDbPath(f.layout.env));
    watches.createWatch({ watchId: 'watch-extra', corpusId: extra, queryText: 'A saved watch on the extra corpus.', mode: 'continuous' }, owner);
    watches.close();

    const result = f.run();

    const watchLine = result.forgotten!.find((line) => line.includes('source-watches.sqlite'))!;
    expect(watchLine).toContain('(watches: 2)');
  });

  test('a registry that cannot be read does not keep the owner from deleting', () => {
    const f = fixture();
    writeFileSync(sourceRegistryPath(f.layout.env), 'not json');

    const result = f.run();

    expect(result.removed).toContain(f.store);
    for (const file of dropboxFiles) expect(file.left(f.layout, MINE), file.stepId).toBe(0);
  });

  test('rows filed under an old id go with the source', () => {
    const f = fixture();
    const whatsapp = lifecycleSourceSpecs().find((entry) => entry.sourceId === 'whatsapp.personal.messages')!;
    expect(whatsapp.sourceAliases).toEqual(['whatsapp.messages']);
    const dashboard = SEEDED_FILES.find((file) => file.stepId === 'source-dashboard')!;
    const legacy = { source_id: 'whatsapp.messages', corpus_id: 'unregistered.corpus', ledger_id: 'whatsapp' };
    const db = new Database(defaultSourceDashboardHistoryDbPath(f.layout.env));
    db.query(`
      INSERT INTO source_dashboard_samples (source_id, corpus_id, sampled_at, indexed_items, content_ready_items, queue_waiting, queue_active, queue_attention)
      VALUES (?, ?, '2026-10-01T00:00:00.000Z', 5, 5, 0, 0, 0)
    `).run(legacy.source_id, legacy.corpus_id);
    db.close();
    expect(dashboard.left(f.layout, legacy)).toBeGreaterThan(0);

    f.run({ sourceId: 'whatsapp.personal.messages' });

    expect(dashboard.left(f.layout, legacy)).toBe(0);
    expect(dashboard.left(f.layout, OTHER)).toBeGreaterThan(0);
  });
});

describe('Gmail and the computer: the config files', () => {
  test('deleting Gmail forgets its mail scope', () => {
    const f = fixture();
    const mail = SEEDED_FILES.find((file) => file.stepId === 'mail-source-scopes')!;
    expect(mail.left(f.layout, mail.mine)).toBe(1);

    const result = deleteOlympusData({ sourceId: 'gmail.email', homeDir: f.homeDir, handleRegistryPath: f.layout.handleRegistryPath });

    expect(mail.left(f.layout, mail.mine)).toBe(0);
    expect(result.forgotten?.some((line) => line.includes('mail-source-scopes.json (mail scope approvals: 1)'))).toBe(true);
  });

  test('deleting the files on this computer forgets the connection and keeps another\'s', () => {
    const f = fixture();
    const computer = SEEDED_FILES.find((file) => file.stepId === 'this-computer')!;

    const result = deleteOlympusData({ sourceId: 'local.files', homeDir: f.homeDir, handleRegistryPath: f.layout.handleRegistryPath });

    expect(computer.left(f.layout, computer.mine)).toBe(0);
    expect(computer.left(f.layout, computer.other)).toBe(1);
    expect(result.forgotten?.some((line) => line.includes('this-computer.json (connections: 1)'))).toBe(true);
  });
});
