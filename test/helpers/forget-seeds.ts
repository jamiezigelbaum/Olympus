/**
 * Seeds for the forget registry's tests: every shared file the registry
 * covers, filled for two sources (`MINE`, which is forgotten, and `OTHER`,
 * which must not be touched), and a count of the rows each still has. One
 * helper serves the per-step tests, the delete-through-the-lifecycle tests and
 * the worker tests, so they agree on what "the source's rows" are.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { writeIngestionHealthState, readIngestionHealthState, defaultIngestionHealthStatePath } from '../../src/core/ingestion-health-state.ts';
import { resolveRemoteConnectionsDbPath } from '../../src/core/remote-connections.ts';
import {
  openWaitingPrivateQuestionStore,
  waitingPrivateQuestionsDbPath,
  type StoredPrivateAnswer,
} from '../../src/core/waiting-private-questions.ts';
import { defaultFileSourceScopeStatePath } from '../../src/core/source-scope-approval.ts';
import { defaultMailSourceScopeStatePath } from '../../src/core/mail-source-scope.ts';
import { sourceAccountBindingsPath, updateSourceAccountBinding, readSourceAccountBindings } from '../../src/core/source-account-binding.ts';
import { connectThisComputerSource, defaultThisComputerStatePath } from '../../src/core/this-computer.ts';
import {
  createTrustedSourceWatchOwnerContext,
  defaultSourceWatchDbPath,
  LocalSourceWatchStore,
} from '../../src/core/source-watch.ts';
import { defaultSourceDashboardHistoryDbPath, SqliteSourceDashboardHistory } from '../../src/workers/source-dashboard.ts';
import { SqliteSourceIngestionLedgerStore } from '../../src/workers/source-ingestion-ledger.ts';
import { tierMigrationReportDir, tierMigrationStatePath } from '../../src/workers/classification/tier-migration-reports.ts';
import { TierLedger, tierLedgerPathForStore } from '../../src/workers/classification/tier-ledger.ts';
import { LocalSourceSchedulerStateStore, defaultSourceSchedulerStateDbPath } from '../../src/workers/source-scheduler-state.ts';
import { LocalFileExtractionJobStore, defaultFileExtractionJobsDbPath } from '../../src/workers/file-extraction/job-store.ts';
import type { ForgetAccount, ForgetContext } from '../../src/core/source-forget-registry.ts';

export interface SeededSource {
  source_id: string;
  corpus_id: string;
  /** The ingestion ledger's short id for the source. */
  ledger_id: string;
}

/** The source being forgotten. */
export const MINE: SeededSource = { source_id: 'dropbox.files', corpus_id: 'secure_local.dropbox.files', ledger_id: 'dropbox' };
/** A source whose rows must survive. */
export const OTHER: SeededSource = { source_id: 'google_drive.docs', corpus_id: 'internal.drive.docs', ledger_id: 'google_drive' };

export const accountOf = (source: SeededSource): ForgetAccount =>
  ({ source_id: source.source_id, slot: '1', corpus_ids: [source.corpus_id] });

export interface ForgetLayout {
  env: Record<string, string | undefined>;
  handleRegistryPath: string;
}

/** A layout under `root`, shaped as data-lifecycle's `envForHome` shapes one. */
export function layoutUnder(root: string): ForgetLayout {
  const home = join(root, 'home');
  return {
    env: { HOME: home, XDG_DATA_HOME: join(home, '.local', 'share'), XDG_STATE_HOME: join(home, '.local', 'state') },
    handleRegistryPath: join(home, '.config', 'olympus', 'handles.json'),
  };
}

/** The tier ledger id the seeds give a source: the claimant of its Secrets redaction claims. */
export const tierLedgerIdOf = (source: SeededSource): string => `ledger-of-${source.ledger_id}`;

/** A context for forgetting `source` (the first seeded source by default): its tier ledger's id is known. */
export const contextOf = (layout: ForgetLayout, source: SeededSource = MINE): ForgetContext =>
  ({ ...layout, knownCorpusIds: [MINE.corpus_id, OTHER.corpus_id], tierLedgerIds: [tierLedgerIdOf(source)] });

/**
 * The tier ledger beside a connector store, with the id the seeded redaction
 * claims name: the Delete reads it before it removes the ledger.
 */
export function seedTierLedgerBeside(storePath: string, source: SeededSource): string {
  const ledgerPath = tierLedgerPathForStore(storePath);
  new TierLedger({ dbPath: ledgerPath }).close();
  const db = new Database(ledgerPath);
  try {
    db.query("UPDATE tier_ledger_meta SET value = ? WHERE key = 'ledger_id'").run(tierLedgerIdOf(source));
  } finally {
    db.close();
  }
  return ledgerPath;
}

const APPROVED_AT = '2026-10-01T00:00:00.000Z';
const REVISION = '11111111-1111-4111-8111-111111111111';
const GENERATION = 'a'.repeat(64);

function withDb<T>(path: string, run: (db: Database) => T, readonly = true): T | 0 {
  if (!existsSync(path)) return 0;
  const db = new Database(path, readonly ? { readonly: true } : undefined);
  try { return run(db); } finally { db.close(); }
}

function count(path: string, table: string, where: string, ...params: string[]): number {
  return withDb(path, (db) => {
    if (!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) return 0;
    return (db.query(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params) as { n: number }).n;
  });
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** One file the registry covers: where it is, how to fill it for both sources, and what is left for one. */
export interface SeededFile {
  /** The registry step that covers it. */
  stepId: string;
  /** The source pair the step is tested with. */
  mine: SeededSource;
  other: SeededSource;
  /** False when `other` has no rows in this file by nature (only Gmail has a mail scope). */
  otherHasRows?: false;
  path(layout: ForgetLayout): string;
  seed(layout: ForgetLayout): void;
  /** Rows the source still has there. */
  left(layout: ForgetLayout, source: SeededSource): number;
}

export const storedAnswer = (corpusId: string): StoredPrivateAnswer => ({
  status: 'answered',
  answer: 'SYNTHETIC_FORGET_ANSWER',
  citations: [{ title: 'Synthetic item', url: 'https://example.invalid/item' }],
  unanswered: [],
  leftOut: [],
  read: [{
    corpusId,
    trustDomain: 'secure_local',
    trustTier: 'private',
    provenance: { sourceItem: { family: 'file', provider: 'synthetic', providerItemId: 'item' } },
  }],
});

export const waitingPath = (layout: ForgetLayout): string =>
  waitingPrivateQuestionsDbPath(resolveRemoteConnectionsDbPath(layout.env));

/** The dashboard database's rows for a source, however keyed. */
const dashboardRows = (path: string, source: SeededSource): number =>
  count(path, 'source_dashboard_samples', 'source_id = ? OR source_id = ? OR corpus_id = ?', source.source_id, source.ledger_id, source.corpus_id)
  + count(path, 'source_dashboard_movement', 'corpus_id = ?', source.corpus_id)
  + count(path, 'source_ingestion_ledger', 'source_id = ?', source.ledger_id)
  + count(path, 'source_ingestion_unreadable_content', 'source_id = ?', source.ledger_id);

/** The migration plan the seeds give a source: one lane, and batches that carry the owner's raw selectors. */
export function migrationPlan(source: SeededSource, extraLaneSourceIds: readonly string[] = []): Record<string, unknown> {
  const batch = (n: number, selector: string | null) => ({
    batchId: `${source.ledger_id}-batch-${n}`,
    selector,
    state: n === 3 ? 'stopped' : 'completed',
    startedAt: APPROVED_AT,
    moved: 4,
    secrets: 0,
    skipped: 0,
    rolledBack: 0,
  });
  return {
    planId: `plan-of-${source.ledger_id}`,
    state: 'approved',
    countsSha256: 'c'.repeat(64),
    lanes: [source.source_id, ...extraLaneSourceIds].map((sourceId) => ({
      sourceId,
      ledgerPath: `/synthetic/${sourceId}.tier-ledger.sqlite`,
      corpora: [source.corpus_id],
    })),
    batches: [
      batch(1, `source:${source.source_id}`),
      batch(2, `folder:/synthetic/${source.ledger_id} folder`),
      batch(3, `sender:person-${source.ledger_id}@example.invalid`),
      batch(4, `chat:chat-of-${source.ledger_id}`),
      batch(5, null),
    ],
  };
}

/** Batch selectors in plans that have the source as a lane that still carry a name (not `source:`, null or forgotten). */
function identifyingSelectors(layout: ForgetLayout, source: SeededSource): number {
  const path = tierMigrationStatePath(layout.env);
  if (!existsSync(path)) return 0;
  const state = JSON.parse(readFileSync(path, 'utf8')) as {
    plans: Array<{ lanes: Array<{ sourceId: string }>; batches: Array<{ selector: string | null }> }>;
  };
  return state.plans
    .filter((plan) => plan.lanes.some((lane) => lane.sourceId === source.source_id))
    .flatMap((plan) => plan.batches)
    .filter((batch) => batch.selector !== null && !batch.selector.startsWith('source:') && !batch.selector.endsWith(':<forgotten>'))
    .length;
}

export const SEEDED_FILES: readonly SeededFile[] = [
  {
    stepId: 'waiting-private-questions',
    mine: MINE,
    other: OTHER,
    path: waitingPath,
    seed(layout) {
      mkdirSync(dirname(waitingPath(layout)), { recursive: true });
      const store = openWaitingPrivateQuestionStore(waitingPath(layout));
      try {
        for (const source of [MINE, OTHER]) {
          const ref = store.record(store.ticket('synthetic-agent'), {
            question: `What do my ${source.source_id} files say?`,
            state: 'waiting',
            surface: 'remote',
          });
          store.saveAnswer(ref!, storedAnswer(source.corpus_id));
        }
      } finally {
        store.close();
      }
    },
    left(layout, source) {
      if (!existsSync(waitingPath(layout))) return 0;
      const store = openWaitingPrivateQuestionStore(waitingPath(layout));
      try {
        return store.list().questions.filter((question) =>
          question.result?.read.some((item) => item.corpusId === source.corpus_id)).length;
      } finally {
        store.close();
      }
    },
  },
  {
    stepId: 'source-dashboard',
    mine: MINE,
    other: OTHER,
    path: (layout) => defaultSourceDashboardHistoryDbPath(layout.env),
    seed(layout) {
      const path = defaultSourceDashboardHistoryDbPath(layout.env);
      const history = new SqliteSourceDashboardHistory(path);
      try {
        history.record([MINE, OTHER].map((source) => ({
          source_id: source.source_id,
          corpus_id: source.corpus_id,
          sampled_at: new Date().toISOString(),
          indexed_items: 40,
          content_ready_items: 30,
          queue_waiting: 3,
          queue_active: 1,
          queue_attention: 0,
        })));
      } finally {
        history.close();
      }
      // The ingestion ledger's tables share the file.
      new SqliteSourceIngestionLedgerStore(path).close();
      const db = new Database(path);
      try {
        for (const source of [MINE, OTHER]) {
          db.query(`
            INSERT INTO source_ingestion_ledger (
              source_id, label, primary_corpus_id, corpus_ids_json, family, trust_domains_json, configured,
              items, content_indexed, metadata_only, failed, stuck_queued, stuck_active, held_paused, broken,
              attention_json, failure_breakdown_json, refreshed_at
            ) VALUES (?, ?, ?, '[]', 'file', '[]', 1, 40, 30, 0, 0, 0, 0, 0, 0, '[]', '[]', ?)
          `).run(source.ledger_id, source.source_id, source.corpus_id, APPROVED_AT);
          db.query(`
            INSERT INTO source_ingestion_unreadable_content (
              source_id, name, path_display, status, extractor_kind, error_class, updated_at, refreshed_at
            ) VALUES (?, 'SYNTHETIC_FILE_NAME.pdf', '/Synthetic/SYNTHETIC_FILE_NAME.pdf', 'failed_terminal', 'local_ocr', 'image_pdf', ?, ?)
          `).run(source.ledger_id, APPROVED_AT, APPROVED_AT);
        }
      } finally {
        db.close();
      }
    },
    left: (layout, source) => dashboardRows(defaultSourceDashboardHistoryDbPath(layout.env), source),
  },
  {
    stepId: 'source-scheduler',
    mine: MINE,
    other: OTHER,
    path: (layout) => defaultSourceSchedulerStateDbPath(layout.env),
    seed(layout) {
      const store = new LocalSourceSchedulerStateStore(defaultSourceSchedulerStateDbPath(layout.env));
      try {
        for (const source of [MINE, OTHER]) {
          const key = { sourceId: source.source_id, corpusId: source.corpus_id, taskId: `${source.source_id}_head` };
          store.recordFailure({
            ...key,
            completedAt: '2026-07-29T09:00:00.000Z',
            notBeforeAt: '2026-07-30T00:00:00.000Z',
            errorKind: 'task_failed',
            errorHash: '0123456789abcdef',
          });
          store.requestUnpark({
            sourceId: key.sourceId,
            taskId: key.taskId,
            expectedNotBeforeAt: '2026-07-30T00:00:00.000Z',
            reason: 'incident_probe',
            requestedAt: '2026-07-29T10:00:00.000Z',
          });
        }
      } finally {
        store.close();
      }
    },
    left(layout, source) {
      const path = defaultSourceSchedulerStateDbPath(layout.env);
      return count(path, 'source_scheduler_task_state', 'source_id = ? OR corpus_id = ?', source.source_id, source.corpus_id)
        + count(path, 'source_scheduler_unpark_request', 'source_id = ? OR corpus_id = ?', source.source_id, source.corpus_id);
    },
  },
  {
    stepId: 'file-extraction-jobs',
    mine: MINE,
    other: OTHER,
    path: (layout) => defaultFileExtractionJobsDbPath(layout.env),
    seed(layout) {
      const store = new LocalFileExtractionJobStore(defaultFileExtractionJobsDbPath(layout.env));
      try {
        for (const source of [MINE, OTHER]) {
          const lane = { corpusId: source.corpus_id, provider: 'example_provider', accountScope: `${source.ledger_id}@example.com`, approvedScopeKey: 'root' };
          const queued = store.enqueue({
            refs: [{
              ...lane,
              providerItemId: 'item-1',
              localItemId: `${lane.accountScope}:item-1`,
              sourceVersion: 'v1',
              contentHash: 'hash-1',
              name: 'SYNTHETIC_FILE_NAME.pdf',
              mimeType: 'application/pdf',
              sizeBytes: 1_024,
            }],
            extractorKind: 'local_text',
            extractorVersion: '2026-05-22',
            policyDecision: 'index_allowed',
          });
          const jobId = queued.jobRefs[0]!.jobId;
          store.lease({ ...lane, workerId: 'worker-1' });
          store.record({
            jobId,
            status: 'indexed',
            derivations: [{ artifactKind: 'page', structuralRef: { kind: 'page', page: 1 }, chars: 100 }],
          });
        }
      } finally {
        store.close();
      }
      // A re-read owed after a Secrets restoration, for each source's job.
      const path = defaultFileExtractionJobsDbPath(layout.env);
      const db = new Database(path);
      try {
        db.exec('INSERT INTO secret_restored_rereads (job_id) SELECT job_id FROM extraction_jobs');
        // An item of each source that became Secrets in the source's own tier ledger.
        for (const source of [MINE, OTHER]) {
          db.query(`INSERT INTO secret_item_redactions (provider, account_scope, provider_item_id, local_item_id, redacted_at)
            VALUES ('example_provider', ?, 'item-1', '', ?)`).run(`${source.ledger_id}@example.com`, APPROVED_AT);
          db.query(`INSERT INTO secret_item_redaction_claims (provider, account_scope, provider_item_id, claimant, claimed_at)
            VALUES ('example_provider', ?, 'item-1', ?, ?)`).run(`${source.ledger_id}@example.com`, tierLedgerIdOf(source), APPROVED_AT);
        }
      } finally {
        db.close();
      }
    },
    left(layout, source) {
      const path = defaultFileExtractionJobsDbPath(layout.env);
      return count(path, 'extraction_jobs', 'corpus_id = ?', source.corpus_id)
        + count(path, 'extraction_artifacts', 'corpus_id = ?', source.corpus_id)
        + count(path, 'secret_restored_rereads', 'job_id IN (SELECT job_id FROM extraction_jobs WHERE corpus_id = ?)', source.corpus_id)
        + count(path, 'secret_item_redaction_claims', 'claimant = ?', tierLedgerIdOf(source))
        + count(path, 'secret_item_redactions', 'account_scope = ?', `${source.ledger_id}@example.com`);
    },
  },
  {
    stepId: 'source-watches',
    mine: MINE,
    other: OTHER,
    path: (layout) => defaultSourceWatchDbPath(layout.env),
    seed(layout) {
      const store = new LocalSourceWatchStore(defaultSourceWatchDbPath(layout.env));
      try {
        const owner = createTrustedSourceWatchOwnerContext({
          ownerId: 'owner-a',
          routeKind: 'openclaw_task',
          routeTargetId: '019f6ff4-2fb0-70a3-91dd-3ef3ada9354f',
        });
        for (const source of [MINE, OTHER]) {
          store.createWatch({
            watchId: `watch-${source.ledger_id}`,
            corpusId: source.corpus_id,
            queryText: 'Tell me when a newly indexed item matches this saved watch.',
            mode: 'continuous',
          }, owner);
        }
      } finally {
        store.close();
      }
    },
    left(layout, source) {
      const path = defaultSourceWatchDbPath(layout.env);
      // The watch's children cascade with it: its watermark counts too.
      return count(path, 'source_watches', 'corpus_id = ?', source.corpus_id)
        + count(path, 'source_watch_watermarks', 'watch_id IN (SELECT watch_id FROM source_watches WHERE corpus_id = ?)', source.corpus_id);
    },
  },
  {
    stepId: 'ingestion-doctor-state',
    mine: MINE,
    other: OTHER,
    path: (layout) => defaultIngestionHealthStatePath(layout.env),
    seed(layout) {
      writeIngestionHealthState(defaultIngestionHealthStatePath(layout.env), {
        generated_at: APPROVED_AT,
        sources: {
          [MINE.ledger_id]: { actionable_stuck: 2, failed_terminal_by_class: { image_pdf: 1 } },
          [OTHER.ledger_id]: { actionable_stuck: 0, failed_terminal_by_class: {} },
        },
      });
    },
    left: (layout, source) =>
      Object.keys(readIngestionHealthState(defaultIngestionHealthStatePath(layout.env))?.sources ?? {})
        .filter((id) => id === source.ledger_id).length,
  },
  {
    stepId: 'tier-migration-reports',
    mine: MINE,
    other: OTHER,
    path: (layout) => tierMigrationReportDir(layout.env),
    seed(layout) {
      const dir = tierMigrationReportDir(layout.env);
      mkdirSync(dir, { recursive: true });
      for (const plan of ['plan-a', 'plan-b']) {
        writeJson(join(dir, `${plan}.json`), {
          kind: 'olympus_tier_migration_plan',
          planId: plan,
          totals: { itemsScanned: 3 },
          topPatterns: [MINE, OTHER].map((source) => ({
            source: source.source_id,
            kind: 'folder',
            value: '/SYNTHETIC/Folder Name',
            from: 'Private',
            toNames: 'Personal',
            toContent: 'Private',
            items: 3,
          })),
        });
      }
    },
    left(layout, source) {
      const dir = tierMigrationReportDir(layout.env);
      if (!existsSync(dir)) return 0;
      return readdirSync(dir).filter((name) => name.endsWith('.json')).reduce((sum, name) =>
        sum + (JSON.parse(readFileSync(join(dir, name), 'utf8')) as { topPatterns: Array<{ source: string }> }).topPatterns
          .filter((pattern) => pattern.source === source.source_id).length, 0);
    },
  },
  {
    stepId: 'tier-migration-state',
    mine: MINE,
    other: OTHER,
    path: (layout) => tierMigrationStatePath(layout.env),
    seed(layout) {
      writeJson(tierMigrationStatePath(layout.env), {
        schemaVersion: 1,
        plans: [MINE, OTHER].map((source) => migrationPlan(source)),
      });
    },
    left: (layout, source) => identifyingSelectors(layout, source),
  },
  {
    stepId: 'file-source-scopes',
    mine: MINE,
    other: OTHER,
    path: (layout) => defaultFileSourceScopeStatePath(layout.handleRegistryPath),
    seed(layout) {
      writeJson(defaultFileSourceScopeStatePath(layout.handleRegistryPath), {
        version: 1,
        approvals: [MINE, OTHER].map((source) => ({
          source_id: source.source_id,
          account_generation: GENERATION,
          revision: REVISION,
          status: 'approved',
          selections: [],
          whole_account: true,
          approved_at: APPROVED_AT,
        })),
      });
    },
    left(layout, source) {
      const path = defaultFileSourceScopeStatePath(layout.handleRegistryPath);
      if (!existsSync(path)) return 0;
      return (JSON.parse(readFileSync(path, 'utf8')) as { approvals: Array<{ source_id: string }> }).approvals
        .filter((approval) => approval.source_id === source.source_id).length;
    },
  },
  {
    // Gmail holds the only mail scope, so this pair is Gmail and a source with none.
    stepId: 'mail-source-scopes',
    mine: { source_id: 'gmail.email', corpus_id: 'internal.email', ledger_id: 'email' },
    other: MINE,
    otherHasRows: false,
    path: (layout) => defaultMailSourceScopeStatePath(layout.handleRegistryPath),
    seed(layout) {
      writeJson(defaultMailSourceScopeStatePath(layout.handleRegistryPath), {
        version: 1,
        approvals: [{
          source_id: 'gmail.email',
          account_generation: GENERATION,
          revision: REVISION,
          status: 'approved',
          mail_scope: {
            window: 'all',
            skipped_categories: ['promotions'],
            skipped_labels: [],
            always_private_senders: ['sender@example.invalid'],
            skip_senders: [],
          },
          owner_tier_rules: [],
          approved_at: APPROVED_AT,
        }],
      });
    },
    left(layout, source) {
      const path = defaultMailSourceScopeStatePath(layout.handleRegistryPath);
      if (!existsSync(path)) return 0;
      return (JSON.parse(readFileSync(path, 'utf8')) as { approvals: Array<{ source_id: string }> }).approvals
        .filter((approval) => approval.source_id === source.source_id).length;
    },
  },
  {
    // `local.files` is the one source that connects to this computer.
    stepId: 'this-computer',
    mine: { source_id: 'local.files', corpus_id: 'secure_local.local.files', ledger_id: 'local_files' },
    other: { source_id: 'archive.imports', corpus_id: 'secure_local.archive.email', ledger_id: 'archive_imports' },
    path: (layout) => defaultThisComputerStatePath(layout.handleRegistryPath),
    seed(layout) {
      connectThisComputerSource(layout.handleRegistryPath, 'local.files');
      const path = defaultThisComputerStatePath(layout.handleRegistryPath);
      const state = JSON.parse(readFileSync(path, 'utf8')) as { sources: Array<{ source_id: string; connected_at: string }> };
      state.sources.push({ source_id: 'archive.imports', connected_at: APPROVED_AT });
      writeJson(path, state);
    },
    left(layout, source) {
      const path = defaultThisComputerStatePath(layout.handleRegistryPath);
      if (!existsSync(path)) return 0;
      return (JSON.parse(readFileSync(path, 'utf8')) as { sources: Array<{ source_id: string }> }).sources
        .filter((entry) => entry.source_id === source.source_id).length;
    },
  },
  {
    stepId: 'source-account-bindings',
    mine: MINE,
    other: OTHER,
    path: (layout) => sourceAccountBindingsPath(layout.handleRegistryPath),
    seed(layout) {
      const path = sourceAccountBindingsPath(layout.handleRegistryPath);
      mkdirSync(dirname(path), { recursive: true });
      updateSourceAccountBinding(path, 'dropbox.files', () => ({ provider_account_id: 'account-a', bound_at: APPROVED_AT }));
      updateSourceAccountBinding(path, 'google_drive.docs', () => ({ provider_account_id: 'account-b', bound_at: APPROVED_AT }));
    },
    left(layout, source) {
      const read = readSourceAccountBindings(sourceAccountBindingsPath(layout.handleRegistryPath));
      return read.kind === 'ok' ? Object.keys(read.bindings.sources).filter((id) => id === source.source_id).length : 0;
    },
  },
];

export function seedAllFiles(layout: ForgetLayout): void {
  for (const file of SEEDED_FILES) file.seed(layout);
}

/** Every file under `root` by path and digest, except SQLite's -wal and -shm sidecars (a reader may create them). */
export function treeDigest(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (!/-(?:wal|shm)$/.test(entry.name)) out[path] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}

/**
 * What a worker still winding down can write back after a delete: a dashboard
 * poll recording the counts it read through store handles that were still
 * open, and an answer to a question that was in flight.
 */
export function writeBackAfterDelete(layout: ForgetLayout, source: SeededSource): void {
  const history = new SqliteSourceDashboardHistory(defaultSourceDashboardHistoryDbPath(layout.env));
  try {
    history.record([{
      source_id: source.source_id,
      corpus_id: source.corpus_id,
      sampled_at: new Date().toISOString(),
      indexed_items: 40,
      content_ready_items: 30,
      queue_waiting: 0,
      queue_active: 0,
      queue_attention: 0,
    }]);
  } finally {
    history.close();
  }
  mkdirSync(dirname(waitingPath(layout)), { recursive: true });
  const store = openWaitingPrivateQuestionStore(waitingPath(layout));
  try {
    const ref = store.record(store.ticket('synthetic-agent'), {
      question: `A question asked while ${source.source_id} was deleted`,
      state: 'waiting',
      surface: 'remote',
    });
    store.saveAnswer(ref!, storedAnswer(source.corpus_id));
  } finally {
    store.close();
  }
}
