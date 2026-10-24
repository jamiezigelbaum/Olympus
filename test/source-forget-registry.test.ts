import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  FORGET_STEPS,
  ForgetStepError,
  KEPT_SHARED_FILES,
  runForgetSteps,
  type ForgetStep,
} from '../src/core/source-forget-registry.ts';
import { defaultSourceDashboardHistoryDbPath } from '../src/workers/source-dashboard.ts';
import {
  MINE,
  OTHER,
  SEEDED_FILES,
  accountOf,
  contextOf,
  layoutUnder,
  seedAllFiles,
  treeDigest,
  type SeededFile,
} from './helpers/forget-seeds.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-forget-'));
  roots.push(root);
  return root;
}

const stepOf = (file: SeededFile): ForgetStep => FORGET_STEPS.find((step) => step.id === file.stepId)!;
const LINE = /^\S+ \([a-z ]+: [1-9]\d*\)$/;

describe('forget registry: one test file per step', () => {
  test('every step has a seeded file, in the registry\'s order', () => {
    expect(SEEDED_FILES.map((file) => file.stepId)).toEqual(FORGET_STEPS.map((step) => step.id));
  });

  for (const file of SEEDED_FILES) {
    describe(file.stepId, () => {
      const setup = () => {
        const root = newRoot();
        const layout = layoutUnder(root);
        file.seed(layout);
        return { root, layout, context: contextOf(layout) };
      };

      test('forgets one source\'s rows and leaves another\'s', () => {
        const { layout, context } = setup();
        const before = file.left(layout, file.mine);
        expect(before).toBeGreaterThan(0);
        const keptBefore = file.left(layout, file.other);

        const lines = stepOf(file).forget(accountOf(file.mine), context, { dryRun: false });

        expect(file.left(layout, file.mine)).toBe(0);
        expect(file.left(layout, file.other)).toBe(keptBefore);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(LINE);
        expect(lines[0]!.startsWith(file.path(layout))).toBe(true);
      });

      test('a second run changes nothing and reports nothing', () => {
        const { root, layout, context } = setup();
        const step = stepOf(file);
        step.forget(accountOf(file.mine), context, { dryRun: false });
        const settled = treeDigest(root);

        expect(step.forget(accountOf(file.mine), context, { dryRun: false })).toEqual([]);
        expect(treeDigest(root)).toEqual(settled);
        if (file.otherHasRows !== false) expect(file.left(layout, file.other)).toBeGreaterThan(0);
      });

      test('a dry run reports what a run forgets and writes nothing', () => {
        const { root, layout, context } = setup();
        const step = stepOf(file);
        const seeded = treeDigest(root);
        const before = { mine: file.left(layout, file.mine), other: file.left(layout, file.other) };

        const preview = step.forget(accountOf(file.mine), context, { dryRun: true });

        expect(treeDigest(root)).toEqual(seeded);
        expect({ mine: file.left(layout, file.mine), other: file.left(layout, file.other) }).toEqual(before);
        expect(preview).toEqual(step.forget(accountOf(file.mine), context, { dryRun: false }));
      });

      test('a file that is not there is a no-op that creates nothing', () => {
        const root = newRoot();
        const layout = layoutUnder(root);
        const step = stepOf(file);

        expect(step.forget(accountOf(file.mine), contextOf(layout), { dryRun: false })).toEqual([]);
        expect(step.forget(accountOf(file.mine), contextOf(layout), { dryRun: true })).toEqual([]);
        expect(treeDigest(root)).toEqual({});
        expect(existsSync(file.path(layout))).toBe(false);
      });

      test('a source with no rows there forgets nothing', () => {
        const { root, layout, context } = setup();
        const seeded = treeDigest(root);
        const stranger = { source_id: 'made.up', slot: '1', corpus_ids: ['internal.made.up'] };

        expect(stepOf(file).forget(stranger, context, { dryRun: false })).toEqual([]);
        expect(treeDigest(root)).toEqual(seeded);
        expect(file.left(layout, file.mine)).toBeGreaterThan(0);
      });
    });
  }
});

describe('forget registry: keys', () => {
  test('rows filed under a source\'s alias or its dashboard ids go with it', () => {
    const root = newRoot();
    const layout = layoutUnder(root);
    const dashboard = SEEDED_FILES.find((file) => file.stepId === 'source-dashboard')!;
    dashboard.seed(layout);

    // The account is named by an old id and holds no corpus of its own: the
    // card, the ledger's short id and the card's corpus still find its rows.
    const lines = FORGET_STEPS.find((step) => step.id === 'source-dashboard')!.forget(
      { source_id: 'dropbox.legacy', slot: '1', corpus_ids: [] },
      { ...contextOf(layout), sourceAliases: ['dropbox.files'] },
      { dryRun: false },
    );

    expect(lines).toHaveLength(1);
    expect(dashboard.left(layout, MINE)).toBe(0);
    expect(dashboard.left(layout, OTHER)).toBeGreaterThan(0);
  });

  test('a mail scope survives another source\'s forget', () => {
    const root = newRoot();
    const layout = layoutUnder(root);
    const mail = SEEDED_FILES.find((file) => file.stepId === 'mail-source-scopes')!;
    mail.seed(layout);

    expect(stepOf(mail).forget(accountOf(mail.other), contextOf(layout), { dryRun: false })).toEqual([]);
    expect(mail.left(layout, mail.mine)).toBe(1);
  });

  test('a this-computer forget keeps the machine id', () => {
    const root = newRoot();
    const layout = layoutUnder(root);
    const file = SEEDED_FILES.find((entry) => entry.stepId === 'this-computer')!;
    file.seed(layout);
    const machineId = (path: string) => (JSON.parse(readFileSync(path, 'utf8')) as { machine_id: string }).machine_id;
    const before = machineId(file.path(layout));

    stepOf(file).forget(accountOf(file.mine), contextOf(layout), { dryRun: false });

    expect(machineId(file.path(layout))).toBe(before);
  });
});

describe('forget registry: a file that cannot be read', () => {
  test('a malformed JSON file is left alone and does not fail the run', () => {
    const root = newRoot();
    const layout = layoutUnder(root);
    for (const id of ['file-source-scopes', 'mail-source-scopes', 'this-computer', 'source-account-bindings', 'ingestion-doctor-state']) {
      const file = SEEDED_FILES.find((entry) => entry.stepId === id)!;
      mkdirSync(dirname(file.path(layout)), { recursive: true });
      writeFileSync(file.path(layout), '{ not json');
    }
    const seeded = treeDigest(root);

    expect(runForgetSteps(accountOf(MINE), contextOf(layout), { dryRun: false })).toEqual([]);
    expect(treeDigest(root)).toEqual(seeded);
  });
});

describe('runForgetSteps', () => {
  test('forgets the source in every file and reports one line per file, private answers first', () => {
    const root = newRoot();
    const layout = layoutUnder(root);
    seedAllFiles(layout);

    const lines = runForgetSteps(accountOf(MINE), contextOf(layout), { dryRun: false });

    // One line per file the source has rows in: not the mail scope (Gmail's
    // alone) nor this-computer.json (Dropbox is not connected to the computer).
    expect(lines).toHaveLength(SEEDED_FILES.length - 2);
    expect(lines[0]).toMatch(/waiting-private-questions\.sqlite \(private answers: 1\)$/);
    for (const file of SEEDED_FILES) {
      // The mail scope is Gmail's alone, so this source never had one.
      if (file.stepId === 'mail-source-scopes' || file.stepId === 'this-computer') continue;
      expect(file.left(layout, MINE), file.stepId).toBe(0);
      expect(file.left(layout, OTHER), file.stepId).toBeGreaterThan(0);
    }
  });

  test('a dry run reports the same lines and writes nothing', () => {
    const root = newRoot();
    const layout = layoutUnder(root);
    seedAllFiles(layout);
    const seeded = treeDigest(root);

    const preview = runForgetSteps(accountOf(MINE), contextOf(layout), { dryRun: true });

    expect(treeDigest(root)).toEqual(seeded);
    expect(preview.length).toBeGreaterThan(0);
    expect(runForgetSteps(accountOf(MINE), contextOf(layout), { dryRun: false })).toEqual(preview);
  });

  test('the first failure names the step and the file, and later steps do not run', () => {
    const root = newRoot();
    const layout = layoutUnder(root);
    seedAllFiles(layout);
    // The dashboard database is not a database any more.
    writeFileSync(defaultSourceDashboardHistoryDbPath(layout.env), 'this is not a sqlite file '.repeat(200));

    let thrown: unknown;
    try { runForgetSteps(accountOf(MINE), contextOf(layout), { dryRun: false }); } catch (error) { thrown = error; }

    expect(thrown).toBeInstanceOf(ForgetStepError);
    const failure = thrown as ForgetStepError;
    expect(failure.stepId).toBe('source-dashboard');
    expect(failure.file).toBe('source-dashboard.sqlite');
    expect(failure.message).toContain('source-dashboard.sqlite');
    expect(failure.message).toContain('source-dashboard');
    expect(failure.message).toContain(MINE.source_id);
    const waiting = SEEDED_FILES.find((file) => file.stepId === 'waiting-private-questions')!;
    const scheduler = SEEDED_FILES.find((file) => file.stepId === 'source-scheduler')!;
    expect(waiting.left(layout, MINE)).toBe(0);
    expect(scheduler.left(layout, MINE)).toBeGreaterThan(0);
  });
});

describe('the registry\'s lists', () => {
  test('step ids and files are unique, and the answers\' step runs first', () => {
    expect(new Set(FORGET_STEPS.map((step) => step.id)).size).toBe(FORGET_STEPS.length);
    expect(new Set(FORGET_STEPS.map((step) => step.file)).size).toBe(FORGET_STEPS.length);
    expect(FORGET_STEPS[0]!.id).toBe('waiting-private-questions');
    expect(FORGET_STEPS.at(-1)!.id).toBe('source-account-bindings');
  });

  test('a kept file is never also a step\'s file', () => {
    const files = new Set(FORGET_STEPS.map((step) => step.file));
    for (const kept of KEPT_SHARED_FILES) expect(files.has(kept.file), kept.file).toBe(false);
  });
});
