/**
 * The forget registry: what a per-source Delete removes from the files that
 * sit outside an account's own store (docs/design/source-storage.md, "Shared
 * files"). Reconnecting after a delete starts clean, so every shared file that
 * keys rows by source or corpus has one step here; every shared file that does
 * not is listed with the reason, in KEPT_SHARED_FILES.
 *
 * A step's logic lives in the module that owns its file, as a small exported
 * function; this module only lists them and runs them. Each step is idempotent,
 * runs in its own transaction (SQLite) or its own atomic write (JSON), counts
 * without writing on a dry run, and does nothing for a file that is not there.
 * Steps run in order and the first failure stops the run, so a retry is clean.
 *
 * `test/store-open-guard.test.ts` ties the two lists to the code: a module that
 * opens a shared SQLite file must own a step or a kept entry.
 */
import type { LayoutEnv } from './olympus-layout.ts';
import { OperationError } from './operation-error.ts';
import { resolveRemoteConnectionsDbPath } from './remote-connections.ts';
import {
  forgetWaitingPrivateQuestions,
  waitingPrivateQuestionsDbPath,
} from './waiting-private-questions.ts';
import { forgetSourceWatches, defaultSourceWatchDbPath } from './source-watch.ts';
import { defaultIngestionHealthStatePath, forgetIngestionHealthState } from './ingestion-health-state.ts';
import { defaultFileSourceScopeStatePath, forgetFileSourceScopeApproval } from './source-scope-approval.ts';
import { defaultMailSourceScopeStatePath, forgetMailSourceScopeApproval } from './mail-source-scope.ts';
import { forgetSourceAccountBindings, sourceAccountBindingsPath } from './source-account-binding.ts';
import { defaultThisComputerStatePath, forgetThisComputerSources } from './this-computer.ts';
import {
  defaultSourceDashboardHistoryDbPath,
  forgetSourceDashboardRows,
  ledgerSourceIdsFor,
} from '../workers/source-dashboard.ts';
import { defaultSourceSchedulerStateDbPath, forgetSourceSchedulerState } from '../workers/source-scheduler-state.ts';
import { extractionJobsDbPaths, forgetExtractionJobs } from '../workers/file-extraction/job-names.ts';
import { forgetExtractionSpool } from '../workers/file-extraction/spool.ts';
import { accountExtractionSpoolRoot } from './olympus-layout.ts';
import { placedAccount } from './source-placement.ts';
import {
  forgetTierMigrationReports,
  forgetTierMigrationSelectors,
  tierMigrationReportDir,
  tierMigrationStatePath,
} from '../workers/classification/tier-migration-reports.ts';

/** One account whose rows are forgotten. Slot is always `'1'` until accounts get a second slot. */
export interface ForgetAccount {
  source_id: string;
  slot: string;
  /** Every corpus the account holds: the registry's entry joined with the shipped corpus registry's. */
  corpus_ids: readonly string[];
}

export interface ForgetContext {
  /** Where the data root is: the shared SQLite and JSON files sit under it. */
  env: LayoutEnv;
  /** The connected-handle registry's path; the config files sit beside it. */
  handleRegistryPath: string;
  /** Other ids the source has answered to (WhatsApp's old `whatsapp.messages`), for steps keyed by source id. */
  sourceAliases?: readonly string[] | undefined;
  /**
   * Every corpus the shipped registry knows. Waiting private answers that read
   * a corpus not in this list cannot be placed, so they go too.
   */
  knownCorpusIds?: readonly string[] | undefined;
  /**
   * The ids of the source's tier ledgers, read from the ledger files before
   * any of them is removed. A ledger id is the `claimant` of the Secrets
   * redaction claims it holds in the extraction job ledger; a reconnected
   * source gets new ids, so the old claims could never be retired again.
   */
  tierLedgerIds?: readonly string[] | undefined;
  /**
   * Tier ledgers that exist but whose id could not be read. Their claims stay
   * (nothing is guessed) and the extraction step says so in its report.
   */
  unreadableTierLedgers?: readonly string[] | undefined;
}

/** What an account-scope forget needs: where the data root is. */
export type AccountScopeForgetContext = Pick<ForgetContext, 'env'>;

export interface ForgetOptions {
  dryRun: boolean;
  /**
   * Run only the steps marked `repeatBeforeRestart`: the repeat the worker
   * makes just before the restart a Delete asks for.
   */
  repeatableOnly?: boolean | undefined;
}

export interface ForgetStep {
  id: string;
  /** The file it covers, by name, for the error that names it. */
  file: string;
  /** The modules that open the file; the store-open guard needs each to own a step or a kept entry. */
  modules: readonly string[];
  /**
   * True when the running worker's own background writers (a dashboard poll
   * reading stores through handles still open, the watch pass) can write this
   * file's rows back while the worker winds down after a Delete, so the worker
   * repeats the step just before it restarts. Never set it on a step whose
   * rows the owner can legitimately create again in that window (a reconnect
   * writes scope approvals, the this-computer connection and the account
   * binding; a remote agent can ask a new private question): a repeat there
   * would erase the reconnect.
   */
  repeatBeforeRestart?: true;
  /** Report lines in the style `<path> (private answers: N)`, one per file with something to forget. */
  forget(account: ForgetAccount, context: ForgetContext, options: ForgetOptions): string[];
  /**
   * The same step for the rows of named account scopes only, inside corpora
   * that other accounts share (an archive family's stores hold every archive
   * of the family). Only a file keyed by account scope has one; a step
   * without it is not part of an account-scope forget.
   */
  forgetAccountScopes?(
    account: ForgetAccount,
    accountScopes: readonly string[],
    context: AccountScopeForgetContext,
    options: ForgetOptions,
  ): string[];
}

export interface KeptSharedFile {
  file: string;
  /** The modules that open it, when it is a SQLite file. */
  modules: readonly string[];
  reason: string;
}

export class ForgetStepError extends OperationError {
  readonly stepId: string;
  readonly file: string;

  constructor(step: Pick<ForgetStep, 'id' | 'file'>, account: ForgetAccount, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      'source_index_error',
      `Olympus could not forget ${account.source_id}'s rows in ${step.file} (step ${step.id}): ${detail}`,
      'No store of this source was removed. The steps before this one already ran; every step is safe to repeat, so fix the cause and run the delete again.',
    );
    this.name = 'ForgetStepError';
    this.stepId = step.id;
    this.file = step.file;
    this.cause = cause;
  }
}

const line = (path: string, what: string, count: number): string[] =>
  count > 0 ? [`${path} (${what}: ${count})`] : [];

/**
 * The extraction spool's scratch files of the account's corpora, or of the
 * named account scopes inside them. An account in its folder keeps its spool
 * in the folder (`raw/extraction-spool`), which a Delete removes whole, so the
 * whole-account forget has nothing to do there; an account scope forgotten out
 * of a corpus its siblings share (an archive removed) is still named, in that
 * folder's spool. A `legacy` account's scratch files sit in the shared spool.
 */
function spoolLines(
  account: ForgetAccount,
  context: Pick<ForgetContext, 'env'>,
  { dryRun }: ForgetOptions,
  accountScopes?: readonly string[],
): string[] {
  const placed = placedAccount(account.source_id, context.env, account.slot);
  if (placed.layout === 'folder' && accountScopes === undefined) return [];
  const root = accountExtractionSpoolRoot(placed, context.env);
  return line(root, 'scratch files', forgetExtractionSpool(
    root,
    { corpusIds: account.corpus_ids, ...(accountScopes ? { accountScopes } : {}) },
    { dryRun },
  ));
}

/** The ids a source's rows may be filed under: its own and its aliases'. */
const sourceIdsOf = (account: ForgetAccount, context: ForgetContext): string[] =>
  [...new Set([account.source_id, ...(context.sourceAliases ?? [])])];

/**
 * In the order they run. The waiting private answers come first: they depend
 * on the source's items, and go before anything else of it does.
 */
export const FORGET_STEPS: readonly ForgetStep[] = [
  {
    id: 'waiting-private-questions',
    file: 'waiting-private-questions.sqlite',
    modules: ['src/core/waiting-private-questions.ts'],
    // A question asked before the restart is answered from the deleted
    // stores' handles, still open; an answer derived from them must not stay.
    // The repeat takes answers only: a question still waiting is answered
    // after the restart, and may be about another source.
    repeatBeforeRestart: true,
    forget(account, context, { dryRun, repeatableOnly }) {
      const path = waitingPrivateQuestionsDbPath(resolveRemoteConnectionsDbPath(context.env));
      return line(path, 'private answers', forgetWaitingPrivateQuestions(
        path,
        { corpusIds: account.corpus_ids, knownCorpusIds: context.knownCorpusIds },
        { dryRun, answeredOnly: repeatableOnly === true },
      ));
    },
  },
  {
    id: 'source-dashboard',
    file: 'source-dashboard.sqlite',
    // The ingestion ledger shares the file; forgetSourceDashboardRows covers both writers' tables.
    modules: ['src/workers/source-dashboard.ts', 'src/workers/source-ingestion-ledger.ts'],
    // The dashboard's history poll records a source's counts from stale handles.
    repeatBeforeRestart: true,
    forget(account, context, { dryRun }) {
      const path = defaultSourceDashboardHistoryDbPath(context.env);
      return line(path, 'dashboard rows', forgetSourceDashboardRows(
        path,
        { sourceIds: sourceIdsOf(account, context), corpusIds: account.corpus_ids },
        { dryRun },
      ));
    },
  },
  {
    id: 'source-scheduler',
    file: 'source-scheduler.sqlite',
    modules: ['src/workers/source-scheduler-state.ts'],
    forget(account, context, { dryRun }) {
      const path = defaultSourceSchedulerStateDbPath(context.env);
      return line(path, 'scheduler rows', forgetSourceSchedulerState(
        path,
        { sourceIds: sourceIdsOf(account, context), corpusIds: account.corpus_ids },
        { dryRun },
      ));
    },
  },
  {
    id: 'file-extraction-jobs',
    file: 'file-extraction-jobs.sqlite',
    modules: ['src/workers/file-extraction/job-store.ts', 'src/workers/file-extraction/job-names.ts'],
    forgetAccountScopes(account, accountScopes, context, { dryRun }) {
      // The Secrets claims of a tier ledger stay: the ledger is shared by the other accounts of the corpora.
      return [
        ...extractionJobsDbPaths(context.env).flatMap((path) =>
          line(path, 'extraction rows', forgetExtractionJobs(
            path,
            { corpusIds: account.corpus_ids, accountScopes },
            { dryRun },
          ))),
        // The raw scratch files a read left in the account's spool (a recording a crash interrupted) are theirs too.
        ...spoolLines(account, context, { dryRun }, accountScopes),
      ];
    },
    forget(account, context, { dryRun }) {
      // Every ledger this process opened, as the Secrets clearing does.
      const paths = extractionJobsDbPaths(context.env);
      const lines = paths.flatMap((path) =>
        line(path, 'extraction rows', forgetExtractionJobs(
          path,
          { corpusIds: account.corpus_ids, tierLedgerIds: context.tierLedgerIds ?? [] },
          { dryRun },
        )));
      // A tier ledger whose id could not be read: its Secrets redaction claims
      // stay, because no claim is retired on a guess. Said in the report.
      const unreadable = context.unreadableTierLedgers?.length ?? 0;
      const withSpool = [...lines, ...spoolLines(account, context, { dryRun })];
      return unreadable > 0 && paths[0] !== undefined
        ? [...withSpool, ...line(paths[0], 'redaction claims kept, tier ledger unreadable', unreadable)]
        : withSpool;
    },
  },
  {
    id: 'source-watches',
    file: 'source-watches.sqlite',
    modules: ['src/core/source-watch.ts'],
    // The watch pass can queue matches from stores that are being deleted.
    repeatBeforeRestart: true,
    forget(account, context, { dryRun }) {
      const path = defaultSourceWatchDbPath(context.env);
      return line(path, 'watches', forgetSourceWatches(path, { corpusIds: account.corpus_ids }, { dryRun }));
    },
  },
  {
    id: 'ingestion-doctor-state',
    file: 'source-ingestion-doctor-state.json',
    modules: [],
    forget(account, context, { dryRun }) {
      const path = defaultIngestionHealthStatePath(context.env);
      return line(path, 'doctor baselines', forgetIngestionHealthState(
        path,
        ledgerSourceIdsFor(sourceIdsOf(account, context)),
        { dryRun },
      ));
    },
  },
  {
    // `olympus tier migrate plan` reports: the owner's folder paths, senders and chat keys per source.
    id: 'tier-migration-reports',
    file: 'tier-migration/reports/*.json',
    modules: [],
    forget(account, context, { dryRun }) {
      const dir = tierMigrationReportDir(context.env);
      return line(dir, 'migration report patterns', forgetTierMigrationReports(dir, sourceIdsOf(account, context), { dryRun }));
    },
  },
  {
    // The migration's state file keeps the owner's raw batch selectors (folder paths, labels, senders, chats).
    id: 'tier-migration-state',
    file: 'tier-migration/state.json',
    modules: [],
    forget(account, context, { dryRun }) {
      const path = tierMigrationStatePath(context.env);
      return line(path, 'migration batch selectors', forgetTierMigrationSelectors(path, sourceIdsOf(account, context), { dryRun }));
    },
  },
  {
    // Config files, beside the handle registry, until they move into the account's folder.
    id: 'file-source-scopes',
    file: 'file-source-scopes.json',
    modules: [],
    forget(account, context, { dryRun }) {
      const path = defaultFileSourceScopeStatePath(context.handleRegistryPath);
      return line(path, 'folder scope approvals', forgetFileSourceScopeApproval(path, sourceIdsOf(account, context), { dryRun }));
    },
  },
  {
    id: 'mail-source-scopes',
    file: 'mail-source-scopes.json',
    modules: [],
    forget(account, context, { dryRun }) {
      const path = defaultMailSourceScopeStatePath(context.handleRegistryPath);
      return line(path, 'mail scope approvals', forgetMailSourceScopeApproval(path, sourceIdsOf(account, context), { dryRun }));
    },
  },
  {
    id: 'this-computer',
    file: 'this-computer.json',
    modules: [],
    forget(account, context, { dryRun }) {
      const path = defaultThisComputerStatePath(context.handleRegistryPath);
      return line(path, 'connections', forgetThisComputerSources(context.handleRegistryPath, sourceIdsOf(account, context), { dryRun }));
    },
  },
  {
    // Last: it records which account the source's items came from.
    id: 'source-account-bindings',
    file: 'source-account-bindings.json',
    modules: [],
    forget(account, context, { dryRun }) {
      const path = sourceAccountBindingsPath(context.handleRegistryPath);
      return line(path, 'account bindings', forgetSourceAccountBindings(path, sourceIdsOf(account, context), { dryRun }));
    },
  },
];

/**
 * Shared files with no per-source data, each with the reason it stays. A claim
 * here is checked against the code that writes the file; if it stops being
 * true the file needs a step instead.
 */
export const KEPT_SHARED_FILES: readonly KeptSharedFile[] = [
  {
    file: 'embedding-ledger.jsonl',
    modules: [],
    reason: 'An append-only record of embedding decisions: corpus ids, counts and one-sentence notes, no item content or names. The owner\'s ruling is that it is never rewritten.',
  },
  {
    file: 'source-answer-latency.jsonl',
    modules: [],
    reason: 'A content-free latency log: timings, the corpus ids searched, the calling agent. Never a question, answer, path or citation.',
  },
  {
    file: 'classification-ledger.jsonl',
    modules: [],
    reason: 'The owner-approved classifier model and prompt decisions. It names no source, corpus or item.',
  },
  {
    file: 'gmail-daily-request-budget.json, google-drive-daily-request-budget.json, readwise-daily-request-budget.json and the Google request-budget ledger',
    modules: ['src/workers/google-connectors/request-budget.ts'],
    reason: 'Request counts per provider and UTC day. They must outlive a delete, or a reconnect would reset the provider\'s daily guard.',
  },
  {
    file: 'tier-sniffer-budget.json',
    modules: [],
    reason: 'One global counter of the day\'s sniffer calls ({ day, used }).',
  },
  {
    file: 'remote-connections.sqlite',
    modules: ['src/core/remote-connections.ts'],
    reason: 'The agents connected to Olympus: display name, token digest, and the host the agent runs on. It references no source or corpus.',
  },
  {
    file: 'credential-broker-state.json',
    modules: [],
    reason: 'The OAuth2 state of each connected handle (refresh token, account id, scopes, status), keyed by handle, not by source or corpus; no item data. Disconnect, which a Delete requires first, deletes the handle\'s entry.',
  },
  {
    file: 'handles.json.unpaired',
    modules: [],
    reason: 'The record that a paired-session source (Telegram, WhatsApp) was unpaired, and any pairing artifacts left. A Delete needs a clean Unpair on record to run, so it has to outlive the Delete; it holds no item data.',
  },
  {
    file: 'connect-relay/',
    modules: [],
    reason: 'The remote-access relay\'s status and secret. It references no source or corpus.',
  },
  {
    file: 'local-files/folder-access.json',
    modules: [],
    reason: 'The answers the Mac gave for its protected folders (Desktop, Documents, Downloads, iCloud Drive, removable and network disks), by folder root (the path of a mounted volume, for the last two). The Mac keeps those answers whether or not Olympus deletes a source.',
  },
  {
    file: 'models/',
    modules: [],
    reason: 'The built-in embedding and reasoning model files. They hold nothing of any source.',
  },
  {
    file: '~/.olympus/{sources/ingestion-exclusions.json, tier-rules.json, privacy.json}',
    modules: [],
    reason: 'The owner\'s own policy files: exclusion and tier rules (folder paths, senders, labels, each optionally naming a source) and the privacy profile, written by the owner or by the dispositions and tier-rule writers. A rule may cover several sources or all of them, and exclusion rules may also sit inline in plugin config, which a Delete cannot reach, so none is edited here. An exclusion beats any inclusion, so dropping one would let a reconnected account ingest what the owner refused; a tier rule is the owner\'s own classification, which may tighten or loosen a tier, and is theirs to change. Delete forgets the account\'s connection choices (folder picks, scope approvals, the account binding) and keeps these.',
  },
];

/**
 * Runs every step for one account, in order, and returns their report lines.
 * The first failure throws a ForgetStepError naming the step and the file.
 * Steps are idempotent, so after a failure the same call can simply run again.
 * `repeatableOnly` runs just the steps marked `repeatBeforeRestart`.
 */
export function runForgetSteps(account: ForgetAccount, context: ForgetContext, options: ForgetOptions): string[] {
  const lines: string[] = [];
  for (const step of FORGET_STEPS) {
    if (options.repeatableOnly === true && step.repeatBeforeRestart !== true) continue;
    try {
      lines.push(...step.forget(account, context, options));
    } catch (error) {
      throw new ForgetStepError(step, account, error);
    }
  }
  return lines;
}

/**
 * Runs the steps that key their rows by account scope, for the named account
 * scopes only, inside the account's corpora. Same order, failure and retry
 * behavior as `runForgetSteps`.
 */
export function runForgetAccountScopeSteps(
  account: ForgetAccount,
  accountScopes: readonly string[],
  context: AccountScopeForgetContext,
  options: ForgetOptions,
): string[] {
  const lines: string[] = [];
  for (const step of FORGET_STEPS) {
    if (step.forgetAccountScopes === undefined) continue;
    try {
      lines.push(...step.forgetAccountScopes(account, accountScopes, context, options));
    } catch (error) {
      throw new ForgetStepError(step, account, error);
    }
  }
  return lines;
}
