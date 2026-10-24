/**
 * The dashboard's side of importing archives (docs/design/archive-import.md):
 * the picker's listing, the person's approval, Decline, Remove, and the
 * Archives row's list.
 *
 * Only the dashboard approves. The worker's /dashboard/archive-import/
 * routes call this under the dashboard grant guard, and the chosen key is
 * checked here before anything of it is read (local-files/scope-browser.ts
 * archive mode: real path, no link, a file or a folder, the Mac's own
 * permission for a guarded folder).
 *
 * An approval answers at once. Metadata and the first and last bytes of
 * every file say whether it may be a copy of an earlier import; when it may,
 * the answer is "checking" while the files are read whole in the background,
 * a slice at a time, and the outcome ("already imported", or the import
 * started) shows on a later dashboard read. Every started import is handed
 * to the scheduler at once, so it runs without a restart.
 */
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { getArchiveFormat } from '../../core/archive-formats.ts';
import { ScopeRoot, ScopeSafeError } from '../../core/scope-safe-fs.ts';
import type {
  ArchiveBrowseList,
  ComputerArchiveEntry,
  ComputerArchiveRequest,
  ComputerArchivesMeta,
} from '../chatgpt/dashboard-contract.ts';
import type { LocalFilesArchiveBrowser } from '../local-files/scope-browser.ts';
import { createArchiveImportAgent, type ArchiveImportAgent } from './agent.ts';
import { SCHEDULER_SOURCE_IDS } from '../source-scheduler.ts';
import { archiveFileDigestSteps, findProbableCopies, verifyArchiveManifest } from './manifest.ts';
import { requestArchiveRemoval } from './removal.ts';
import type { ArchiveImportRuntime } from './runtime.ts';
import {
  commitArchiveImport,
  prepareArchiveImport,
  type ArchiveImportStart,
  type PreparedArchiveImport,
} from './start.ts';
import type {
  DashboardImportAttention,
  DashboardImportedArchives,
  DashboardImportsUnreadableReason,
} from '../source-dashboard.ts';
import { displayText } from '../dashboard/display-text.ts';
import { ARCHIVE_IMPORTS_SOURCE_ID, ArchiveRecordFormError, type ArchiveImportRecord } from './state.ts';
import {
  ArchiveImportRequestStore,
  archiveImportRequestsPath,
  withArchiveImportApprovals,
  type ArchiveImportApproval,
  type ArchiveImportRequest,
} from './requests.ts';

/**
 * How the private model stands for judging held items.
 */
export type ArchivePrivateModelState = ComputerArchivesMeta['privateModel'];

/**
 * How the private model stands, off the tier sniffer's own status: none
 * built is `off`; asking, or a pass at work, is `ready`; any reason it asks
 * nothing (not answering, no model, the owner's approval, resting after
 * failures, the day's budget) is `waiting`.
 */
export function archivePrivateModelFromSniffer(
  sniffer: { status(): { waiting?: { reason: string } } } | undefined,
): ArchivePrivateModelState {
  if (!sniffer) return 'off';
  const reason = sniffer.status().waiting?.reason;
  return reason === undefined || reason === 'yielding_to_answers' || reason === 'pass_running' ? 'ready' : 'waiting';
}

/**
 * Whether the scheduler runs archive imports: `on`, or the setting that
 * stops it (background syncing off, or its source list leaving archives out).
 */
export type ArchiveSchedulingState = 'on' | NonNullable<ComputerArchivesMeta['notRunning']>;

/**
 * Whether the worker's scheduler settings run archive imports: off when the
 * scheduler is (`worker.scheduler.enabled`), not selected when its source
 * list (`worker.scheduler.sourceIds`) is not empty and leaves archives out.
 */
export function archiveImportScheduling(scheduler: { enabled: boolean; sourceIds: readonly string[] }): ArchiveSchedulingState {
  if (!scheduler.enabled) return 'disabled';
  const selected = scheduler.sourceIds.map((sourceId) => sourceId.trim());
  return selected.length > 0 && !selected.includes(SCHEDULER_SOURCE_IDS.archiveImports) ? 'not_selected' : 'on';
}

export type ArchiveApproveResult =
  | { ok: true; status: 'started'; archive_id: string; name: string }
  | { ok: true; status: 'checking'; request_id: string; name: string }
  | { ok: true; status: 'already_imported'; archive_id: string; name: string; archive_name: string }
  | { ok: false; code: string; message: string; access?: { state: string; message: string; settings_url?: string } };

export type ArchiveSimpleResult = { ok: true } | { ok: false; code: string; message: string };

export interface ArchiveImportDashboard {
  browse(request: { parentKey?: string; cursor?: string }): Promise<ArchiveBrowseList>;
  approve(request: { key: string } | { requestId: string }): Promise<ArchiveApproveResult>;
  decline(requestId: string): ArchiveSimpleResult;
  remove(archiveId: string): ArchiveSimpleResult;
  /**
   * The person's approval of an agent's request to remove an archive: the
   * same removal Remove runs, for the archive the request names.
   */
  approveRemoval(requestId: string): ArchiveSimpleResult;
  view(): ComputerArchivesMeta;
  /**
   * What an agent may do (agent.ts): ask for an import or a removal, and
   * read the same list. It approves and removes nothing; only the methods
   * above, behind the dashboard's control routes, do.
   */
  readonly agent: ArchiveImportAgent;
  /**
   * The Archives card's connection: how many archives, whether one is
   * moving, and what needs the person. Never throws: a record that cannot
   * be read is an entry of its own, never none imported.
   */
  present(): DashboardImportedArchives;
  /**
   * Checks a restart interrupted, started again.
   */
  resume(): void;
  /**
   * Settles when every check started so far has finished (tests, shutdown).
   */
  idle(): Promise<void>;
  close(): void;
}

export interface ArchiveImportDashboardOptions {
  runtime: ArchiveImportRuntime;
  browser: LocalFilesArchiveBrowser;
  /**
   * Hands the scheduler the current archive tasks (its updateSources).
   */
  refreshScheduler: () => void;
  /**
   * How the private model stands now.
   */
  privateModel: () => ArchivePrivateModelState;
  /**
   * Whether the scheduler would run an import or a removal now (default on).
   * When it would not, approving and removing are refused rather than left
   * at 0% forever.
   */
  scheduling?: () => ArchiveSchedulingState;
  /**
   * Test seam: the requests' file (default beside the archive record).
   */
  requestsPath?: string;
  /**
   * Test seam: what a check waits between slices of a file.
   */
  pause?: () => Promise<void>;
  /**
   * Test seam: the home folder, shown as ~.
   */
  home?: string;
  now?: () => Date;
}

/**
 * Plain words for every refusal an approval can meet; the codes are the contract.
 */
export const ARCHIVE_APPROVE_COPY = {
  unsupported: "Olympus can't import this. It imports {formats}.",
  ambiguous: "Olympus can't tell which kind of export this is.",
  changed: 'This changed while Olympus was reading it. Choose it again once it has finished changing.',
  not_found: 'This file or folder is no longer there. Choose it again.',
  permission_denied: 'Your user account is not allowed to open this. Check who may open it, then try again.',
  unreadable: 'Olympus could not read this. Choose it again, or choose another file.',
  not_waiting: 'This request was already answered.',
  checking: 'Olympus is still checking this one.',
  unknown_archive: 'This archive is no longer in the list.',
  not_an_import: 'This request is not an import.',
  not_a_removal: 'This request is not to remove an archive.',
  already_removing: 'This archive is already being removed.',
} as const;

/**
 * Why an import or a removal is refused while it would never run: the
 * setting that stops it, and what to change.
 */
export const ARCHIVE_NOT_RUNNING_COPY = {
  disabled: "Background syncing is turned off in Olympus's settings, so imports and removals can't run. The setting is worker.scheduler.enabled: turn it on, and restart Olympus after changing it.",
  not_selected: "Background syncing in Olympus's settings leaves out archives, so imports and removals can't run. The setting is worker.scheduler.sourceIds: add archive.imports to it, or empty it, and restart Olympus after changing it.",
} as const;

function fill(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.split(`{${key}}`).join(value);
  return out;
}

/**
 * The day of an ISO timestamp (YYYY-MM-DD), or undefined when it is not one.
 */
function dateOnly(iso: string | undefined): string | undefined {
  if (typeof iso !== 'string' || iso.length < 10 || iso[4] !== '-' || iso[7] !== '-') return undefined;
  const day = iso.slice(0, 10);
  return Number.isNaN(Date.parse(`${day}T00:00:00Z`)) ? undefined : day;
}

function tallies(values: Readonly<Record<string, number>>): Array<{ kind: string; count: number }> {
  return Object.entries(values)
    .filter(([, count]) => Number.isFinite(count) && count > 0)
    .map(([kind, count]) => ({ kind, count: Math.floor(count) }))
    .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

/**
 * Why a record file could not be read, as the dashboard words it.
 */
function recordUnreadableReason(error: unknown): DashboardImportsUnreadableReason {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === 'EACCES' || code === 'EPERM') return 'permission';
  if (error instanceof SyntaxError) return 'damaged';
  if (error instanceof ArchiveRecordFormError) return 'unknown_form';
  return 'other';
}

function unreadableCode(code: string): string {
  if (code === 'not_found') return 'not_found';
  if (code === 'permission_denied') return 'permission_denied';
  if (code === 'changed' || code === 'escape' || code === 'not_regular') return 'changed';
  return 'unreadable';
}

export function createArchiveImportDashboard(options: ArchiveImportDashboardOptions): ArchiveImportDashboard {
  const state = options.runtime.state;
  const requests = new ArchiveImportRequestStore({
    path: options.requestsPath ?? archiveImportRequestsPath(state.path),
    ...(options.now ? { now: options.now } : {}),
  });
  const pause = options.pause ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  const home = options.home ?? homedir();
  let closed = false;
  // One check at a time: each reads whole files.
  let checks: Promise<void> = Promise.resolve();
  // Requests whose check runs in this process (a `checking` entry not here was left by a restart).
  const running = new Set<string>();
  // Checks the person cancelled: each stops at its next slice and records nothing.
  const cancelled = new Set<string>();
  const exclusive = <T>(run: () => T): T => withArchiveImportApprovals(state.path, run);
  // Whether a check may still record its import: not cancelled, and its
  // request still there and checking (a list that cannot be read: no).
  const stillChecking = (requestId: string): boolean => {
    if (cancelled.has(requestId)) return false;
    try {
      return requests.get(requestId)?.status === 'checking';
    } catch {
      return false;
    }
  };
  const scheduling = (): ArchiveSchedulingState => {
    try {
      return options.scheduling?.() ?? 'on';
    } catch {
      return 'on';
    }
  };
  const notRunning = (): ArchiveApproveResult | undefined => {
    const setting = scheduling();
    return setting === 'on' ? undefined : refusal('imports_not_running', ARCHIVE_NOT_RUNNING_COPY[setting]);
  };

  // A path with the home folder shown as ~.
  const shown = (path: string): string => {
    if (path === home) return '~';
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  };
  // What the dashboard, a Needs you line and an agent are told of a name, a folder or a path:
  // asked for by whoever chose it, so every character that cannot be seen is written out
  // (display-text.ts). The stored path is untouched, and is what the disk is asked for.
  const named = (text: string): string => displayText(text);
  const where = (path: string): string => named(shown(posix.dirname(path)));

  const refresh = (): void => {
    try {
      options.refreshScheduler();
    } catch (error) {
      console.warn(`[archive-import] the scheduler was not updated: ${error instanceof Error ? error.name : 'error'}`);
    }
  };

  // A removal shares its archive's scheduler task, whose schedule says the
  // next pass is 30 minutes after the import's last: tell the scheduler there
  // is work now, once it has the task (after refresh).
  const wakeScheduler = (): void => {
    try {
      options.runtime.notifyWork();
    } catch (error) {
      console.warn(`[archive-import] the scheduler was not woken: ${error instanceof Error ? error.name : 'error'}`);
    }
  };

  const refusal = (code: string, message: string): ArchiveApproveResult => ({ ok: false, code, message });

  const outcome = (requestId: string, result: ArchiveImportStart): void => {
    if (result.kind === 'started') {
      requests.remove(requestId);
      refresh();
    } else if (result.kind === 'already_imported') {
      requests.settle(requestId, { status: 'already_imported', archiveId: result.archive.archive_id });
    } else {
      requests.settle(requestId, { status: 'failed', code: result.kind === 'unreadable' ? unreadableCode(result.code) : result.kind });
    }
  };

  /**
   * Reads every file whole, a slice at a time, then records the import unless it is a copy.
   */
  const check = (requestId: string, prepared: PreparedArchiveImport): void => {
    running.add(requestId);
    checks = checks.then(async () => {
      try {
        // Cancelled, or its request gone, while it waited its turn: nothing is read.
        if (closed || !stillChecking(requestId)) return;
        const digests: string[] = [];
        for (const file of prepared.record.files) {
          const steps = archiveFileDigestSteps(prepared.root, file);
          for (;;) {
            const step = steps.next();
            if (step.done) {
              digests.push(step.value);
              break;
            }
            if (closed || cancelled.has(requestId)) {
              steps.return('');
              return;
            }
            await pause();
          }
        }
        if (closed) return;
        // Recorded only while its request still stands, read again under
        // the approvals' exclusion: cancelled, removed, deleted by the CLI
        // (or a list that cannot be read) records nothing.
        exclusive(() => {
          if (stillChecking(requestId)) outcome(requestId, commitArchiveImport(state, prepared, digests));
        });
      } catch (error) {
        if (closed) return;
        const code = error instanceof ScopeSafeError ? unreadableCode(error.code) : 'unreadable';
        try {
          requests.settle(requestId, { status: 'failed', code });
        } catch {
          // The request file is unreadable: the dashboard says so on its next read.
        }
      } finally {
        running.delete(requestId);
        cancelled.delete(requestId);
        prepared.root.close();
      }
    });
  };

  /**
   * The approved import, reopened after a restart without reading anything
   * of it first: the folder must be the approved one, then each file must
   * still be at its approved version (opened, never read); only then is it
   * read whole, through readers held to those versions.
   */
  const reopenApproved = (approved: ArchiveImportApproval): PreparedArchiveImport | { kind: 'failed'; code: string } => {
    let root: ScopeRoot;
    try {
      root = ScopeRoot.open(approved.root_path);
    } catch (error) {
      return { kind: 'failed', code: error instanceof ScopeSafeError && error.code === 'not_found' ? 'not_found' : 'replaced' };
    }
    let handed = false;
    try {
      if (root.identity.dev !== approved.root_identity.dev || root.identity.ino !== approved.root_identity.ino) {
        return { kind: 'failed', code: 'replaced' };
      }
      const current = verifyArchiveManifest(root, approved.files);
      if (!current.ok) return { kind: 'failed', code: current.code === 'file_missing' ? 'not_found' : current.code === 'file_changed' ? 'replaced' : 'unreadable' };
      const copies = findProbableCopies(state.list(), approved.files);
      handed = true;
      return { kind: 'ready', root, record: approved, copies };
    } catch {
      return { kind: 'failed', code: 'unreadable' };
    } finally {
      if (!handed) root.close();
    }
  };

  /**
   * One check a restart interrupted, against what the person approved; a
   * cancelled or removed one is left alone.
   */
  const resumeOne = (requestId: string): void => {
    const live = requests.get(requestId);
    if (closed || !live || live.status !== 'checking' || running.has(requestId) || cancelled.has(requestId)) return;
    const reopened = live.approved ? reopenApproved(live.approved) : { kind: 'failed' as const, code: 'replaced' };
    if (reopened.kind !== 'ready') {
      requests.settle(requestId, { status: 'failed', code: reopened.code });
      return;
    }
    if (reopened.copies.length > 0) {
      check(requestId, reopened);
      return;
    }
    try {
      exclusive(() => {
        if (stillChecking(requestId)) outcome(requestId, commitArchiveImport(state, reopened));
      });
    } finally {
      reopened.root.close();
    }
  };

  /**
   * The approval of one resolved path: answered at once, the slow part (a
   * possible copy, read whole) in the background. `from` is the request
   * being answered: an agent's (pending), or a check that ended without
   * importing (failed, Try again); either must still stand, as it was, once
   * its path is resolved.
   */
  const approvePath = (path: string, from?: { requestId: string; status: 'pending' | 'failed' }): ArchiveApproveResult => {
    const name = named(posix.basename(path));
    // An agent's request becomes the import or its check; Try again starts afresh.
    const requestId = from?.status === 'pending' ? from.requestId : undefined;
    const answered = (): void => {
      if (from) requests.remove(from.requestId);
    };
    const prepared = prepareArchiveImport({ state, path });
    if (prepared.kind === 'unsupported') {
      return refusal('unsupported', fill(ARCHIVE_APPROVE_COPY.unsupported, { formats: prepared.supported.join(', ') }));
    }
    if (prepared.kind === 'ambiguous') return refusal('ambiguous', ARCHIVE_APPROVE_COPY.ambiguous);
    if (prepared.kind === 'unreadable') {
      const code = unreadableCode(prepared.code);
      return refusal(code, ARCHIVE_APPROVE_COPY[code as keyof typeof ARCHIVE_APPROVE_COPY] ?? ARCHIVE_APPROVE_COPY.unreadable);
    }
    if (prepared.kind === 'already_imported') {
      answered();
      return { ok: true, status: 'already_imported', archive_id: prepared.archive.archive_id, name, archive_name: named(prepared.archive.label) };
    }
    // From here the approval moves into the record or the checks, under the
    // approvals' exclusion; the root is closed or handed to its check.
    let handed = false;
    try {
      return exclusive((): ArchiveApproveResult => {
        // Declined or dismissed while its path was resolved: not imported.
        if (from && requests.get(from.requestId)?.status !== from.status) return refusal('not_waiting', ARCHIVE_APPROVE_COPY.not_waiting);
        if (prepared.copies.length === 0) {
          const result = commitArchiveImport(state, prepared);
          if (result.kind === 'started') {
            answered();
            refresh();
            return { ok: true, status: 'started', archive_id: result.archive.archive_id, name };
          }
          if (result.kind === 'already_imported') {
            answered();
            return { ok: true, status: 'already_imported', archive_id: result.archive.archive_id, name, archive_name: named(result.archive.label) };
          }
          const code = result.kind === 'unreadable' ? unreadableCode(result.code) : result.kind;
          return refusal(code, ARCHIVE_APPROVE_COPY[code as keyof typeof ARCHIVE_APPROVE_COPY] ?? ARCHIVE_APPROVE_COPY.unreadable);
        }
        const entry = requestId ? requests.startChecking(requestId, prepared.record) : requests.addChecking(path, prepared.record);
        if (!entry) return refusal('not_waiting', ARCHIVE_APPROVE_COPY.not_waiting);
        if (!requestId) answered();
        // A second press while the first is checking: one check is enough.
        if (!running.has(entry.request_id)) {
          check(entry.request_id, prepared);
          handed = true;
        }
        return { ok: true, status: 'checking', request_id: entry.request_id, name };
      });
    } finally {
      if (!handed) prepared.root.close();
    }
  };

  /**
   * How many items the archive holds and how many still wait for the private
   * model; undefined when its index cannot be opened or read, which is said
   * as such and never as an empty archive.
   */
  const counts = (record: ArchiveImportRecord): { items: number; held: number } | undefined => {
    try {
      const lane = options.runtime.lane(record.family);
      const tally = lane.ledger.accountScopeCounts(record.provider, record.archive_id);
      return { items: tally.items, held: tally.awaitingJudgment };
    } catch {
      return undefined;
    }
  };

  // An import or a removal waiting for the scheduler to run it.
  const stuck = (records: readonly ArchiveImportRecord[]): boolean =>
    records.some((record) => record.status === 'importing' || record.status === 'removing');

  const percent = (record: ArchiveImportRecord): number => {
    const total = record.files.reduce((sum, file) => sum + file.size, 0);
    const read = record.read_position;
    if (!read || total <= 0) return 0;
    const before = record.files.slice(0, read.file_index).reduce((sum, file) => sum + file.size, 0);
    const done = Math.min(total, before + (read.file_index < record.files.length ? read.offset : 0));
    return Math.max(0, Math.min(99, Math.floor((done / total) * 100)));
  };

  /**
   * The gaps, per kind; for an archive of several files, per file and kind
   * when the record kept that. Offsets stay in the record.
   */
  const gapsOf = (record: ArchiveImportRecord): ComputerArchiveEntry['gaps'] => {
    const byFile = record.findings.gaps_by_file;
    if (record.files.length < 2 || !byFile || Object.keys(byFile).length === 0) return tallies(record.findings.gaps);
    const fileName = (index: number): string => named(posix.basename(record.files[index]?.rel_path || record.label) || record.label);
    const perFile = Object.entries(byFile)
      .map(([index, kinds]) => ({ index: Number(index), kinds }))
      .filter((entry) => Number.isInteger(entry.index) && entry.index >= 0 && entry.index < record.files.length)
      .sort((a, b) => a.index - b.index);
    // Gaps counted before the record kept them per file (an import that went
    // on after an upgrade) stay, as the part of each kind no file accounts for.
    const placed: Record<string, number> = {};
    for (const entry of perFile) {
      for (const [kind, count] of Object.entries(entry.kinds)) {
        if (Number.isFinite(count) && count > 0) placed[kind] = (placed[kind] ?? 0) + Math.floor(count);
      }
    }
    const remainder: Record<string, number> = {};
    for (const [kind, count] of Object.entries(record.findings.gaps)) {
      if (Number.isFinite(count)) remainder[kind] = Math.floor(count) - (placed[kind] ?? 0);
    }
    return [
      ...perFile.flatMap((entry) => tallies(entry.kinds).map((gap) => ({ ...gap, file: fileName(entry.index) }))),
      ...tallies(remainder),
    ];
  };

  const entryOf = (record: ArchiveImportRecord): ComputerArchiveEntry => {
    const counted = counts(record);
    const { items, held } = counted ?? { items: 0, held: 0 };
    const earliest = dateOnly(record.date_range?.earliest);
    const latest = dateOnly(record.date_range?.latest);
    const stopFile = record.stop?.rel_path ? named(posix.basename(record.stop.rel_path)) : undefined;
    return {
      id: record.archive_id,
      name: named(record.label),
      format: getArchiveFormat(record.format)?.label ?? record.format,
      family: record.family,
      where: where(posix.join(record.root_path, record.chosen_rel_path || '.')),
      status: record.status,
      items,
      judged: Math.max(0, items - held),
      held,
      ...(counted ? {} : { countsUnavailable: true as const }),
      ...(record.status === 'importing' ? { percent: percent(record) } : {}),
      ...(earliest ? { earliest } : {}),
      ...(latest ? { latest } : {}),
      startedAt: record.created_at,
      ...(record.completed_at ? { importedAt: record.completed_at } : {}),
      ...(record.status === 'stopped' && record.stop ? { stop: { code: record.stop.code, ...(stopFile ? { file: stopFile } : {}) } } : {}),
      gaps: gapsOf(record),
      skipped: tallies(record.findings.skipped),
    };
  };

  const requestOf = (request: ArchiveImportRequest, records: readonly ArchiveImportRecord[]): ComputerArchiveRequest => {
    const archive = request.archive_id ? records.find((record) => record.archive_id === request.archive_id) : undefined;
    if (request.kind === 'remove') {
      // A removal names the archive, not a path: its name and folder are the archive's own.
      return {
        id: request.request_id,
        kind: 'remove',
        name: named(archive?.label ?? request.label),
        where: archive ? where(posix.join(archive.root_path, archive.chosen_rel_path || '.')) : '',
        ...(archive ? { path: named(shown(posix.join(archive.root_path, archive.chosen_rel_path || '.'))) } : {}),
        origin: request.origin,
        status: request.status,
        archiveId: request.archive_id!,
      };
    }
    return {
      id: request.request_id,
      kind: 'import',
      name: named(request.label),
      where: where(request.path),
      // The whole path, as asked, so the person can read exactly what they approve.
      path: named(shown(request.path)),
      origin: request.origin,
      // A check no process is running (a restart came between) is started again by resume().
      status: request.status,
      ...(request.archive_id ? { archiveId: request.archive_id } : {}),
      ...(archive ? { archiveName: named(archive.label) } : {}),
      ...(request.code ? { code: request.code } : {}),
    };
  };

  /**
   * A request to remove an archive that is gone, or already being removed,
   * asks the person nothing: it is left out of every list, and the next
   * answer or removal clears it from the file.
   */
  const askingNow = (asked: readonly ArchiveImportRequest[], records: readonly ArchiveImportRecord[]): ArchiveImportRequest[] =>
    asked.filter((request) => request.kind !== 'remove'
      || records.some((record) => record.archive_id === request.archive_id && record.status !== 'removing'));

  /**
   * Removes one archive: marks it removing, drops what pointed at it, and
   * hands the scheduler its removal task. The one place anything is removed
   * (Remove on an archive, and the approval of an agent's request).
   */
  const removeNow = (archiveId: string): ArchiveSimpleResult => {
    const record = state.get(archiveId);
    if (!record) {
      for (const request of requests.list()) {
        if (request.archive_id === archiveId && request.kind === 'remove') requests.remove(request.request_id);
      }
      return { ok: false, code: 'unknown_archive', message: ARCHIVE_APPROVE_COPY.unknown_archive };
    }
    if (record.status === 'removing') return { ok: false, code: 'already_removing', message: ARCHIVE_APPROVE_COPY.already_removing };
    requestArchiveRemoval(state, archiveId, options.now);
    // A finished check pointing at it, and any request to remove it, say nothing true any more.
    for (const request of requests.list()) {
      if (request.archive_id === archiveId) requests.remove(request.request_id);
    }
    refresh();
    wakeScheduler();
    return { ok: true };
  };

  const api: ArchiveImportDashboard = {
    agent: createArchiveImportAgent({ state, requests, view: () => api.view() }),

    async browse(request) {
      const page = await options.browser.browse(request);
      return {
        nodes: page.nodes.map((node) => ({
          key: node.key,
          ...(node.parent_key !== undefined ? { parent_key: node.parent_key } : {}),
          name: node.name,
          kind: node.kind,
          has_children: node.has_children,
          selectable: node.selectable,
          ...(node.size_bytes !== undefined ? { size_bytes: node.size_bytes } : {}),
          ...(node.access ? { access: node.access } : {}),
          ...(node.is_disk ? { is_disk: true as const } : {}),
        })),
        ...(page.nextCursor ? { next_cursor: page.nextCursor } : {}),
        ...(page.access ? { access: page.access } : {}),
      } as ArchiveBrowseList;
    },

    async approve(request) {
      // Nothing is approved that would never run.
      const blocked = notRunning();
      if (blocked) return blocked;
      if ('requestId' in request) {
        const waiting = requests.get(request.requestId);
        if (waiting?.status === 'failed') {
          // Try again on a check that ended without importing: a fresh
          // approval of the same path, the old outcome kept until it starts.
          const resolved = await options.browser.resolvePath(waiting.path);
          if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message, ...(resolved.access ? { access: resolved.access } : {}) };
          return approvePath(resolved.path, { requestId: waiting.request_id, status: 'failed' });
        }
        if (!waiting || waiting.status !== 'pending') return refusal('not_waiting', ARCHIVE_APPROVE_COPY.not_waiting);
        // A request to remove an archive is answered by approveRemoval, never read as a path.
        if (waiting.kind !== 'import') return refusal('not_an_import', ARCHIVE_APPROVE_COPY.not_an_import);
        const resolved = await options.browser.resolvePath(waiting.path);
        if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message, ...(resolved.access ? { access: resolved.access } : {}) };
        return approvePath(resolved.path, { requestId: waiting.request_id, status: 'pending' });
      }
      const resolved = await options.browser.resolve(request.key);
      if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message, ...(resolved.access ? { access: resolved.access } : {}) };
      return approvePath(resolved.path);
    },

    decline(requestId) {
      const request = requests.get(requestId);
      if (!request) return { ok: false, code: 'not_waiting', message: ARCHIVE_APPROVE_COPY.not_waiting };
      // Cancel a check, running or not yet resumed: it records nothing.
      if (request.status === 'checking') cancelled.add(requestId);
      requests.remove(requestId);
      return { ok: true };
    },

    remove(archiveId) {
      // Nothing is removed that would never run.
      const blocked = notRunning();
      if (blocked && !blocked.ok) return { ok: false, code: blocked.code, message: blocked.message };
      return removeNow(archiveId);
    },

    approveRemoval(requestId) {
      const request = requests.get(requestId);
      if (!request || request.status !== 'pending') return { ok: false, code: 'not_waiting', message: ARCHIVE_APPROVE_COPY.not_waiting };
      if (request.kind !== 'remove' || !request.archive_id) return { ok: false, code: 'not_a_removal', message: ARCHIVE_APPROVE_COPY.not_a_removal };
      // The request stays for when the setting is on again: an answer that did nothing is not an answer.
      const blocked = notRunning();
      if (blocked && !blocked.ok) return { ok: false, code: blocked.code, message: blocked.message };
      const result = removeNow(request.archive_id);
      // Answered either way: the request does not stay for an archive that cannot be removed again.
      requests.remove(requestId);
      return result;
    },

    view() {
      const model = options.privateModel();
      const base = { sourceId: ARCHIVE_IMPORTS_SOURCE_ID, privateModel: model };
      let records: ArchiveImportRecord[];
      try {
        records = state.list();
      } catch (error) {
        return { ...base, archives: [], requests: [], unreadable: { reason: recordUnreadableReason(error), file: shown(state.path), list: 'archives' } };
      }
      let asked: ArchiveImportRequest[];
      try {
        asked = requests.list();
      } catch (error) {
        return {
          ...base,
          archives: records.map(entryOf),
          requests: [],
          unreadable: { reason: recordUnreadableReason(error), file: shown(requests.path), list: 'requests' },
        };
      }
      const setting = scheduling();
      return {
        ...base,
        archives: records.map(entryOf),
        requests: askingNow(asked, records).map((request) => requestOf(request, records)),
        // Any archive here: its import or removal would not run, and neither would Remove.
        ...(setting !== 'on' && records.length > 0 ? { notRunning: setting } : {}),
      };
    },

    present() {
      let records: ArchiveImportRecord[];
      try {
        records = state.list();
      } catch (error) {
        return { archives: 0, importing: false, attention: [{ kind: 'unreadable', reason: recordUnreadableReason(error) }] };
      }
      const attention: DashboardImportAttention[] = [];
      let asked: ArchiveImportRequest[] = [];
      try {
        asked = requests.list();
      } catch (error) {
        attention.push({ kind: 'unreadable', reason: recordUnreadableReason(error) });
      }
      for (const record of records) {
        if (record.status === 'stopped') attention.push({ kind: 'stopped', id: record.archive_id, name: record.label });
      }
      // An import or a removal the scheduler will never run, and the setting why.
      const setting = scheduling();
      if (setting !== 'on' && stuck(records)) attention.push({ kind: 'scheduler', setting });
      const counted = new Map<string, { items: number; held: number }>();
      for (const record of records) {
        if (record.status === 'removing') continue;
        const tally = counts(record);
        if (tally) counted.set(record.archive_id, tally);
        else attention.push({ kind: 'counts', id: record.archive_id, name: record.label });
      }
      for (const request of askingNow(asked, records)) {
        if (request.origin !== 'agent' || request.status !== 'pending') continue;
        // A removal names the archive as it is now; an import, the file as asked.
        if (request.kind === 'remove') {
          const archive = records.find((record) => record.archive_id === request.archive_id);
          attention.push({ kind: 'removal', id: request.request_id, name: archive?.label ?? request.label });
        } else {
          attention.push({ kind: 'request', id: request.request_id, name: request.label });
        }
      }
      // A check that ended without importing what the person approved.
      for (const request of asked) {
        if (request.status === 'failed') attention.push({ kind: 'failed', id: request.request_id, name: request.label });
      }
      // Held content no private model can judge now: the person's to set up.
      const model = options.privateModel();
      if (model !== 'ready') {
        const held = [...counted.values()].reduce((sum, tally) => sum + tally.held, 0);
        if (held > 0) attention.push({ kind: 'held', count: held, model });
      }
      return {
        archives: records.length,
        // Nothing reads as importing while this computer's settings keep it from running.
        importing: setting === 'on' && records.some((record) => record.status === 'importing' || record.status === 'removing'),
        ...(attention.length > 0 ? { attention } : {}),
      };
    },

    resume() {
      let waiting: ArchiveImportRequest[];
      try {
        waiting = requests.list().filter((request) => request.status === 'checking' && !running.has(request.request_id));
      } catch {
        return;
      }
      for (const request of waiting) {
        try {
          resumeOne(request.request_id);
        } catch {
          // Left as it is: the next start tries again.
        }
      }
    },

    idle: () => checks,

    close() {
      closed = true;
    },
  };
  return api;
}
