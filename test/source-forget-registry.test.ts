import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { readTierMigrationState, TIER_MIGRATION_STATE_SCHEMA_VERSION } from '../src/workers/classification/tier-migration.ts';
import {
  FORGET_STEPS,
  ForgetStepError,
  KEPT_SHARED_FILES,
  runForgetSteps,
  type ForgetStep,
} from '../src/core/source-forget-registry.ts';
import { defaultSourceDashboardHistoryDbPath } from '../src/workers/source-dashboard.ts';
import { openWaitingPrivateQuestionStore } from '../src/core/waiting-private-questions.ts';
import {
  MINE,
  OTHER,
  SEEDED_FILES,
  accountOf,
  contextOf,
  layoutUnder,
  migrationPlan,
  seedAllFiles,
  storedAnswer,
  tierLedgerIdOf,
  waitingPath,
  treeDigest,
  writeBackAfterDelete,
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

        // A source nobody connected has no tier ledger either.
        expect(stepOf(file).forget(stranger, { ...context, tierLedgerIds: [] }, { dryRun: false })).toEqual([]);
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
    for (const id of ['file-source-scopes', 'mail-source-scopes', 'this-computer', 'source-account-bindings', 'ingestion-doctor-state', 'tier-migration-state']) {
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

const seededFile = (stepId: string): SeededFile => SEEDED_FILES.find((file) => file.stepId === stepId)!;

describe('steps the worker repeats before its restart', () => {
  test('only the steps its own background writers can write back are marked', () => {
    // The private answers (asked of the deleted stores' open handles), the
    // dashboard history poll and the watch pass; no owner-choice step.
    expect(FORGET_STEPS.filter((step) => step.repeatBeforeRestart).map((step) => step.id))
      .toEqual(['waiting-private-questions', 'source-dashboard', 'source-watches']);
  });

  test('a repeat-only run forgets the marked steps\' rows and no others', () => {
    const root = newRoot();
    const layout = layoutUnder(root);
    seedAllFiles(layout);
    const before = new Map(SEEDED_FILES.map((file) => [file.stepId, file.left(layout, MINE)]));

    const lines = runForgetSteps(accountOf(MINE), contextOf(layout), { dryRun: false, repeatableOnly: true });

    const repeated = FORGET_STEPS.filter((step) => step.repeatBeforeRestart).map((step) => step.id);
    expect(lines).toHaveLength(repeated.length);
    for (const file of SEEDED_FILES) {
      const marked = repeated.includes(file.stepId);
      expect(file.left(layout, MINE), file.stepId).toBe(marked ? 0 : before.get(file.stepId)!);
    }
  });

  test('the repeat takes the private answers that read the source, and keeps a question still waiting', () => {
    const root = newRoot();
    const layout = layoutUnder(root);
    mkdirSync(dirname(waitingPath(layout)), { recursive: true });
    const store = openWaitingPrivateQuestionStore(waitingPath(layout));
    try {
      // Asked after the delete: one answered from the deleted stores' open
      // handles, one still waiting (it may be about another source).
      const answered = store.record(store.ticket('synthetic-agent'), { question: 'Answered from stale handles?', state: 'waiting', surface: 'remote' });
      store.saveAnswer(answered!, storedAnswer(MINE.corpus_id));
      store.record(store.ticket('synthetic-agent'), { question: 'Still waiting?', state: 'waiting', surface: 'remote' });
    } finally {
      store.close();
    }
    const questions = () => {
      const reopened = openWaitingPrivateQuestionStore(waitingPath(layout));
      try {
        return reopened.list().questions.map((question) => question.result ? 'answered' : 'waiting');
      } finally {
        reopened.close();
      }
    };

    expect(runForgetSteps(accountOf(MINE), contextOf(layout), { dryRun: true, repeatableOnly: true }).join('\n')).toContain('private answers: 1');
    runForgetSteps(accountOf(MINE), contextOf(layout), { dryRun: false, repeatableOnly: true });
    expect(questions()).toEqual(['waiting']);
    // The delete itself takes a waiting question too: nothing says yet what it will read.
    runForgetSteps(accountOf(MINE), contextOf(layout), { dryRun: false });
    expect(questions()).toEqual([]);
  });

  test('a reconnect after the delete survives the repeat, while a write-back does not', () => {
    const root = newRoot();
    const layout = layoutUnder(root);
    seedAllFiles(layout);
    runForgetSteps(accountOf(MINE), contextOf(layout), { dryRun: false });
    for (const id of ['file-source-scopes', 'source-account-bindings']) expect(seededFile(id).left(layout, MINE)).toBe(0);

    // The owner reconnects in the window; a poll writes the old counts back.
    seededFile('file-source-scopes').seed(layout);
    seededFile('source-account-bindings').seed(layout);
    writeBackAfterDelete(layout, MINE);
    expect(seededFile('source-dashboard').left(layout, MINE)).toBeGreaterThan(0);

    runForgetSteps(accountOf(MINE), contextOf(layout), { dryRun: false, repeatableOnly: true });

    expect(seededFile('file-source-scopes').left(layout, MINE)).toBeGreaterThan(0);
    expect(seededFile('source-account-bindings').left(layout, MINE)).toBeGreaterThan(0);
    expect(seededFile('source-dashboard').left(layout, MINE)).toBe(0);
  });
});

describe('tier-migration-state: the owner\'s raw batch selectors', () => {
  const statePath = (layout: ReturnType<typeof layoutUnder>): string => seededFile('tier-migration-state').path(layout);
  const readPlans = (layout: ReturnType<typeof layoutUnder>) =>
    (JSON.parse(readFileSync(statePath(layout), 'utf8')) as { plans: Array<{ planId: string; batches: Array<{ selector: string | null; moved: number; state: string }> }> }).plans;

  test('replaces each selector but source: with the same kind and a non-identifying value, and keeps every other field', () => {
    const root = newRoot();
    const layout = layoutUnder(root);
    seededFile('tier-migration-state').seed(layout);
    const before = readPlans(layout);

    const lines = stepOf(seededFile('tier-migration-state')).forget(accountOf(MINE), contextOf(layout), { dryRun: false });

    expect(lines).toEqual([`${statePath(layout)} (migration batch selectors: 3)`]);
    const after = readPlans(layout);
    const mine = after.find((plan) => plan.planId === 'plan-of-dropbox')!;
    expect(mine.batches.map((batch) => batch.selector)).toEqual([
      'source:dropbox.files',
      'folder:<forgotten>',
      'sender:<forgotten>',
      'chat:<forgotten>',
      null,
    ]);
    // Counts, states and ids stay; a stopped batch keeps its place (it no longer resumes by its selector).
    const withoutSelector = (plan: (typeof before)[number]) => plan.batches.map(({ selector: _selector, ...rest }) => rest);
    expect(withoutSelector(mine)).toEqual(withoutSelector(before.find((plan) => plan.planId === 'plan-of-dropbox')!));
    expect(mine.batches[2]!.state).toBe('stopped');
    // Another source's plan keeps its selectors, byte for byte.
    expect(after.find((plan) => plan.planId === 'plan-of-google_drive')).toEqual(before.find((plan) => plan.planId === 'plan-of-google_drive'));
  });

  test('a plan that spans the source and another loses all of its selectors, and the name appears nowhere in the file', () => {
    const root = newRoot();
    const layout = layoutUnder(root);
    mkdirSync(dirname(statePath(layout)), { recursive: true });
    writeFileSync(statePath(layout), JSON.stringify({
      schemaVersion: 1,
      plans: [migrationPlan(MINE, [OTHER.source_id]), migrationPlan(OTHER)],
    }));

    const lines = stepOf(seededFile('tier-migration-state')).forget(accountOf(MINE), contextOf(layout), { dryRun: false });

    expect(lines).toEqual([`${statePath(layout)} (migration batch selectors: 3)`]);
    const text = readFileSync(statePath(layout), 'utf8');
    expect(text).not.toContain('person-dropbox@example.invalid');
    expect(text).not.toContain('/synthetic/dropbox folder');
    expect(text).toContain('person-google_drive@example.invalid');
  });

  test('the migration still reads the state file afterwards', () => {
    const root = newRoot();
    const layout = layoutUnder(root);
    seededFile('tier-migration-state').seed(layout);

    stepOf(seededFile('tier-migration-state')).forget(accountOf(MINE), contextOf(layout), { dryRun: false });

    const state = readTierMigrationState(statePath(layout));
    expect(state.schemaVersion).toBe(TIER_MIGRATION_STATE_SCHEMA_VERSION);
    expect(state.plans).toHaveLength(2);
  });

  test('a state file the migration would not read, or without plans, is left alone', () => {
    const root = newRoot();
    const layout = layoutUnder(root);
    mkdirSync(dirname(statePath(layout)), { recursive: true });
    for (const content of ['{ not json', '[]', JSON.stringify({ schemaVersion: 1 })]) {
      writeFileSync(statePath(layout), content);
      expect(stepOf(seededFile('tier-migration-state')).forget(accountOf(MINE), contextOf(layout), { dryRun: false })).toEqual([]);
      expect(readFileSync(statePath(layout), 'utf8')).toBe(content);
    }
  });
});

describe('file-extraction-jobs: Secrets redaction claims of the deleted source\'s tier ledgers', () => {
  const jobsPath = (layout: ReturnType<typeof layoutUnder>): string => seededFile('file-extraction-jobs').path(layout);
  const rows = (layout: ReturnType<typeof layoutUnder>, sql: string, ...params: string[]): number => {
    const db = new Database(jobsPath(layout), { readonly: true });
    try { return (db.query(sql).get(...params) as { n: number }).n; } finally { db.close(); }
  };
  const claimsOf = (layout: ReturnType<typeof layoutUnder>, claimant: string) =>
    rows(layout, 'SELECT COUNT(*) AS n FROM secret_item_redaction_claims WHERE claimant = ?', claimant);
  const redactionsOf = (layout: ReturnType<typeof layoutUnder>, accountScope: string) =>
    rows(layout, 'SELECT COUNT(*) AS n FROM secret_item_redactions WHERE account_scope = ?', accountScope);
  const mineScope = `${MINE.ledger_id}@example.com`;
  const otherScope = `${OTHER.ledger_id}@example.com`;
  const setup = () => {
    const root = newRoot();
    const layout = layoutUnder(root);
    seededFile('file-extraction-jobs').seed(layout);
    return layout;
  };
  const forget = (layout: ReturnType<typeof layoutUnder>, context = contextOf(layout), dryRun = false) =>
    stepOf(seededFile('file-extraction-jobs')).forget(accountOf(MINE), context, { dryRun });

  test('the deleted ledger\'s claim and its sole redaction go; another source\'s stay', () => {
    const layout = setup();
    expect(claimsOf(layout, tierLedgerIdOf(MINE))).toBe(1);
    expect(redactionsOf(layout, mineScope)).toBe(1);

    forget(layout);

    expect(claimsOf(layout, tierLedgerIdOf(MINE))).toBe(0);
    expect(redactionsOf(layout, mineScope)).toBe(0);
    expect(claimsOf(layout, tierLedgerIdOf(OTHER))).toBe(1);
    expect(redactionsOf(layout, otherScope)).toBe(1);
  });

  test('a redaction another ledger also claims stays, with that ledger\'s claim', () => {
    const layout = setup();
    const db = new Database(jobsPath(layout));
    try {
      db.query(`INSERT INTO secret_item_redaction_claims (provider, account_scope, provider_item_id, claimant, claimed_at)
        VALUES ('example_provider', ?, 'item-1', 'ledger-of-a-second-store', '2026-10-01T00:00:00.000Z')`).run(mineScope);
    } finally {
      db.close();
    }

    forget(layout);

    expect(claimsOf(layout, tierLedgerIdOf(MINE))).toBe(0);
    expect(claimsOf(layout, 'ledger-of-a-second-store')).toBe(1);
    expect(redactionsOf(layout, mineScope)).toBe(1);
  });

  test('a redaction with no claim on record cannot be attributed and stays', () => {
    const layout = setup();
    const db = new Database(jobsPath(layout));
    try {
      db.query(`INSERT INTO secret_item_redactions (provider, account_scope, provider_item_id, local_item_id, redacted_at)
        VALUES ('example_provider', ?, 'old-item', '', '2026-10-01T00:00:00.000Z')`).run(mineScope);
    } finally {
      db.close();
    }

    forget(layout);

    expect(redactionsOf(layout, mineScope)).toBe(1);
  });

  test('a dry run counts the claims and redactions and removes none; a second run reports nothing', () => {
    const layout = setup();
    const preview = forget(layout, contextOf(layout), true);

    expect(claimsOf(layout, tierLedgerIdOf(MINE))).toBe(1);
    expect(redactionsOf(layout, mineScope)).toBe(1);
    expect(forget(layout)).toEqual(preview);
    expect(forget(layout)).toEqual([]);
  });

  test('without the ledger ids no claim is retired, and the unreadable ledger is reported', () => {
    const layout = setup();
    const lines = forget(layout, { ...contextOf(layout), tierLedgerIds: [], unreadableTierLedgers: ['/synthetic/store.tier-ledger.sqlite'] });

    expect(claimsOf(layout, tierLedgerIdOf(MINE))).toBe(1);
    expect(redactionsOf(layout, mineScope)).toBe(1);
    // The jobs go as always; the claims stay, and the report says why.
    expect(lines.some((line) => line.includes('extraction rows'))).toBe(true);
    expect(lines.at(-1)).toBe(`${jobsPath(layout)} (redaction claims kept, tier ledger unreadable: 1)`);
  });

  test('a ledger whose claims table is missing (an older schema) is not an error and keeps its redactions', () => {
    const layout = setup();
    const db = new Database(jobsPath(layout));
    try {
      db.exec('DROP TABLE secret_item_redaction_claims');
    } finally {
      db.close();
    }

    expect(() => forget(layout)).not.toThrow();
    expect(redactionsOf(layout, mineScope)).toBe(1);
  });
});
