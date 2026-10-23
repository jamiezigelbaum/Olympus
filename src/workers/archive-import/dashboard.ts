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
import { ScopeSafeError } from '../../core/scope-safe-fs.ts';
import type {
  ArchiveBrowseList,
  ComputerArchiveEntry,
  ComputerArchiveRequest,
  ComputerArchivesMeta,
} from '../chatgpt/dashboard-contract.ts';
import type { LocalFilesArchiveBrowser } from '../local-files/scope-browser.ts';
import { archiveFileDigestSteps } from './manifest.ts';
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
import { ARCHIVE_IMPORTS_SOURCE_ID, ArchiveRecordFormError, type ArchiveImportRecord } from './state.ts';
import {
  ArchiveImportRequestStore,
  archiveImportRequestsPath,
  type ArchiveImportRequest,
} from './requests.ts';

/**
 * How the private model stands for judging held items.
 */
export type ArchivePrivateModelState = ComputerArchivesMeta['privateModel'];

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
  view(): ComputerArchivesMeta;
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
  unsupported: 'Olympus can’t import this. It imports {formats}.',
  ambiguous: 'Olympus can’t tell which kind of export this is.',
  changed: 'This changed while Olympus was reading it. Choose it again once it has finished changing.',
  not_found: 'This file or folder is no longer there. Choose it again.',
  permission_denied: 'Your user account is not allowed to open this. Check who may open it, then try again.',
  unreadable: 'Olympus could not read this. Choose it again, or choose another file.',
  not_waiting: 'This request was already answered.',
  checking: 'Olympus is still checking this one.',
  unknown_archive: 'This archive is no longer in the list.',
  already_removing: 'This archive is already being removed.',
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

  // A path with the home folder shown as ~.
  const shown = (path: string): string => {
    if (path === home) return '~';
    return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
  };
  const where = (path: string): string => shown(posix.dirname(path));

  const refresh = (): void => {
    try {
      options.refreshScheduler();
    } catch (error) {
      console.warn(`[archive-import] the scheduler was not updated: ${error instanceof Error ? error.name : 'error'}`);
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
        const digests: string[] = [];
        for (const file of prepared.record.files) {
          const steps = archiveFileDigestSteps(prepared.root, file);
          for (;;) {
            const step = steps.next();
            if (step.done) {
              digests.push(step.value);
              break;
            }
            if (closed) {
              steps.return('');
              return;
            }
            await pause();
          }
        }
        if (closed) return;
        outcome(requestId, commitArchiveImport(state, prepared, digests));
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
        prepared.root.close();
      }
    });
  };

  /**
   * The approval of one resolved path: answered at once, the slow part (a
   * possible copy, read whole) in the background. `requestId` is an agent's
   * request being approved.
   */
  const approvePath = (path: string, requestId?: string): ArchiveApproveResult => {
    const name = posix.basename(path);
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
      if (requestId) requests.remove(requestId);
      return { ok: true, status: 'already_imported', archive_id: prepared.archive.archive_id, name, archive_name: prepared.archive.label };
    }
    if (prepared.copies.length === 0) {
      let result: ArchiveImportStart;
      try {
        result = commitArchiveImport(state, prepared);
      } finally {
        prepared.root.close();
      }
      if (result.kind === 'started') {
        if (requestId) requests.remove(requestId);
        refresh();
        return { ok: true, status: 'started', archive_id: result.archive.archive_id, name };
      }
      if (result.kind === 'already_imported') {
        if (requestId) requests.remove(requestId);
        return { ok: true, status: 'already_imported', archive_id: result.archive.archive_id, name, archive_name: result.archive.label };
      }
      const code = result.kind === 'unreadable' ? unreadableCode(result.code) : result.kind;
      return refusal(code, ARCHIVE_APPROVE_COPY[code as keyof typeof ARCHIVE_APPROVE_COPY] ?? ARCHIVE_APPROVE_COPY.unreadable);
    }
    let entry: ArchiveImportRequest | undefined;
    try {
      entry = requestId ? requests.startChecking(requestId) : requests.addChecking(path);
    } catch (error) {
      prepared.root.close();
      throw error;
    }
    if (!entry) {
      prepared.root.close();
      return refusal('not_waiting', ARCHIVE_APPROVE_COPY.not_waiting);
    }
    // A second press while the first is checking: one check is enough.
    if (running.has(entry.request_id)) prepared.root.close();
    else check(entry.request_id, prepared);
    return { ok: true, status: 'checking', request_id: entry.request_id, name };
  };

  const counts = (record: ArchiveImportRecord): { items: number; held: number } => {
    try {
      const lane = options.runtime.lane(record.family);
      const tally = lane.ledger.accountScopeCounts(record.provider, record.archive_id);
      return { items: tally.items, held: tally.awaitingJudgment };
    } catch {
      return { items: 0, held: 0 };
    }
  };

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
    const fileName = (index: number): string => posix.basename(record.files[index]?.rel_path || record.label) || record.label;
    return Object.entries(byFile)
      .map(([index, kinds]) => ({ index: Number(index), kinds }))
      .filter((entry) => Number.isInteger(entry.index) && entry.index >= 0 && entry.index < record.files.length)
      .sort((a, b) => a.index - b.index)
      .flatMap((entry) => tallies(entry.kinds).map((gap) => ({ ...gap, file: fileName(entry.index) })));
  };

  const entryOf = (record: ArchiveImportRecord): ComputerArchiveEntry => {
    const { items, held } = counts(record);
    const earliest = dateOnly(record.date_range?.earliest);
    const latest = dateOnly(record.date_range?.latest);
    const stopFile = record.stop?.rel_path ? posix.basename(record.stop.rel_path) : undefined;
    return {
      id: record.archive_id,
      name: record.label,
      format: getArchiveFormat(record.format)?.label ?? record.format,
      where: where(posix.join(record.root_path, record.chosen_rel_path || '.')),
      status: record.status,
      items,
      judged: Math.max(0, items - held),
      held,
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
    return {
      id: request.request_id,
      name: request.label,
      where: where(request.path),
      origin: request.origin,
      // A check no process is running (a restart came between) is started again by resume().
      status: request.status,
      ...(request.archive_id ? { archiveId: request.archive_id } : {}),
      ...(archive ? { archiveName: archive.label } : {}),
      ...(request.code ? { code: request.code } : {}),
    };
  };

  return {
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
      if ('requestId' in request) {
        const waiting = requests.get(request.requestId);
        if (!waiting || waiting.status !== 'pending') return refusal('not_waiting', ARCHIVE_APPROVE_COPY.not_waiting);
        const resolved = await options.browser.resolvePath(waiting.path);
        if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message, ...(resolved.access ? { access: resolved.access } : {}) };
        return approvePath(resolved.path, waiting.request_id);
      }
      const resolved = await options.browser.resolve(request.key);
      if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message, ...(resolved.access ? { access: resolved.access } : {}) };
      return approvePath(resolved.path);
    },

    decline(requestId) {
      const request = requests.get(requestId);
      if (!request) return { ok: false, code: 'not_waiting', message: ARCHIVE_APPROVE_COPY.not_waiting };
      if (request.status === 'checking') return { ok: false, code: 'checking', message: ARCHIVE_APPROVE_COPY.checking };
      requests.remove(requestId);
      return { ok: true };
    },

    remove(archiveId) {
      const record = state.get(archiveId);
      if (!record) return { ok: false, code: 'unknown_archive', message: ARCHIVE_APPROVE_COPY.unknown_archive };
      if (record.status === 'removing') return { ok: false, code: 'already_removing', message: ARCHIVE_APPROVE_COPY.already_removing };
      requestArchiveRemoval(state, archiveId, options.now);
      // A finished check pointing at it says nothing true any more.
      for (const request of requests.list()) {
        if (request.archive_id === archiveId) requests.remove(request.request_id);
      }
      refresh();
      return { ok: true };
    },

    view() {
      const model = options.privateModel();
      const base = { sourceId: ARCHIVE_IMPORTS_SOURCE_ID, privateModel: model };
      let records: ArchiveImportRecord[];
      try {
        records = state.list();
      } catch (error) {
        return { ...base, archives: [], requests: [], unreadable: { reason: recordUnreadableReason(error), file: shown(state.path) } };
      }
      let asked: ArchiveImportRequest[];
      try {
        asked = requests.list();
      } catch (error) {
        return {
          ...base,
          archives: records.map(entryOf),
          requests: [],
          unreadable: { reason: recordUnreadableReason(error), file: shown(requests.path) },
        };
      }
      return {
        ...base,
        archives: records.map(entryOf),
        requests: asked.map((request) => requestOf(request, records)),
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
      for (const request of asked) {
        if (request.origin === 'agent' && request.status === 'pending') {
          attention.push({ kind: 'request', id: request.request_id, name: request.label });
        }
      }
      // Held content no private model can judge now: the person's to set up.
      const model = options.privateModel();
      if (model !== 'ready') {
        const held = records
          .filter((record) => record.status !== 'removing')
          .reduce((sum, record) => sum + counts(record).held, 0);
        if (held > 0) attention.push({ kind: 'held', count: held, model });
      }
      return {
        archives: records.length,
        importing: records.some((record) => record.status === 'importing' || record.status === 'removing'),
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
        void options.browser.resolvePath(request.path).then((resolved) => {
          if (closed || running.has(request.request_id)) return;
          if (!resolved.ok) {
            requests.settle(request.request_id, { status: 'failed', code: resolved.code === 'not_found' ? 'not_found' : 'unreadable' });
            return;
          }
          const prepared = prepareArchiveImport({ state, path: resolved.path });
          if (prepared.kind !== 'ready') {
            outcome(request.request_id, prepared);
            return;
          }
          if (prepared.copies.length === 0) {
            try {
              outcome(request.request_id, commitArchiveImport(state, prepared));
            } finally {
              prepared.root.close();
            }
            return;
          }
          check(request.request_id, prepared);
        }).catch(() => {
          // Left as it is: the next start tries again.
        });
      }
    },

    idle: () => checks,

    close() {
      closed = true;
    },
  };
}
