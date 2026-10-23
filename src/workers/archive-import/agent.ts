/**
 * What an agent may do about archive imports (the `archive_import` operation,
 * docs/design/archive-import.md, "Operation"): ask, and look. Nothing here
 * imports or removes anything.
 *
 * - `start` leaves a request holding the path as text. The path is never
 *   statted, opened, resolved or listed here: a prompt-injected or careless
 *   call can at most put a line under Needs you, which the person answers on
 *   the computer's dashboard (dashboard.ts approve; the dashboard's control
 *   routes accept a local control session only).
 * - `remove` leaves a request naming the archive. The per-archive removal
 *   (removal.ts) runs only when the person approves it in the dashboard.
 * - `status` is the dashboard's own list (dashboard.ts view), worded the
 *   same way and with the same truthfulness: a list that cannot be read is
 *   said so, never an empty one. It carries names, counts and plain lines,
 *   never a message, subject or snippet; the engine does not hand them here.
 *
 * Every answer is a result, never an error: a refusal is `{ok: false, code,
 * message}` for the agent to tell the person in those words.
 */
import { posix } from 'node:path';
import { olympusOpenUrl, openPageUrl, openTargetPath } from '../../core/open-targets.ts';
import type {
  ComputerArchiveEntry,
  ComputerArchiveRequest,
  ComputerArchivesMeta,
} from '../chatgpt/dashboard-contract.ts';
import { displayText } from '../dashboard/display-text.ts';
import { DASHBOARD_ARCHIVE_COPY } from '../dashboard/vocabulary.ts';
import {
  ARCHIVE_IMPORT_REQUEST_PATH_MAX,
  archivePathLabel,
  type ArchiveImportRequestStore,
} from './requests.ts';
import { ArchiveRecordFormError, isArchiveId, type ArchiveImportStateStore } from './state.ts';

/**
 * Where the person answers: the Archives row of the computer's dashboard.
 */
export interface ArchiveOpenTarget {
  target: 'archives';
  /** Opens Olympus on the computer, on the Archives row (the olympus:// handler). */
  url: string;
  /** The same, as a page that says what to do when nothing opens. */
  page: string;
}

export function archivesOpenTarget(): ArchiveOpenTarget {
  const target = { kind: 'archives' } as const;
  return { target: openTargetPath(target) as 'archives', url: olympusOpenUrl(target), page: openPageUrl(target) };
}

export interface AgentArchiveStopped {
  code: string;
  file?: string;
  why: string;
  fix: string;
}

export interface AgentArchiveLine {
  kind: string;
  count: number;
  file?: string;
  line: string;
}

export interface AgentArchive {
  archive_id: string;
  /** The file's or folder's name. */
  name: string;
  format: string;
  /** The folder it was imported from (home shown as ~). */
  where: string;
  status: ComputerArchiveEntry['status'];
  /** Messages stored so far. Absent when Olympus cannot count them now (`counts_unavailable`): never 0. */
  messages?: number;
  /** Of those, judged by the private model (or by the rules). */
  judged?: number;
  /** Of those, held Private until the private model judges them. */
  waiting_for_private_model?: number;
  /** Olympus could not open its index to count this archive's messages; the numbers are left out, not zero. */
  counts_unavailable?: true;
  progress_percent?: number;
  earliest?: string;
  latest?: string;
  started_at: string;
  imported_at?: string;
  stopped?: AgentArchiveStopped;
  /** What could not be read fully, one plain line per kind (and file). */
  not_read: AgentArchiveLine[];
  /** What was left out on purpose. */
  left_out: AgentArchiveLine[];
  /** One plain line: the state, and how much of it is judged. */
  summary: string;
}

export interface AgentArchiveRequest {
  request_id: string;
  kind: 'import' | 'remove';
  name: string;
  where: string;
  origin: 'agent' | 'dashboard';
  state: 'waiting_for_approval' | 'checking' | 'already_imported' | 'not_imported';
  archive_id?: string;
  archive_name?: string;
  /** One plain line: what the request waits for, or how it ended. */
  note: string;
}

export type ArchiveAgentStatus =
  | {
    ok: true;
    archives: AgentArchive[];
    /** Absent only when the list of requests cannot be read (`requests_unreadable` says why). */
    requests?: AgentArchiveRequest[];
    requests_unreadable?: { reason: string; message: string };
    private_model: ComputerArchivesMeta['privateModel'];
    /** Said when messages wait for the private model. */
    private_model_note?: string;
    /** Imports and removals are waiting for background reading that this computer's settings keep from running. */
    not_running?: { setting: 'disabled' | 'not_selected'; message: string };
  }
  | { ok: false; code: 'archives_unreadable'; reason: string; message: string }
  | { ok: false; code: 'unknown_archive'; message: string };

/**
 * An archive Olympus already holds a record of at the path asked for, in the
 * state it is actually in. A record at the same path is not proof that the
 * file is the one imported (it may have been replaced), so it never stands
 * in for the answer: it is reported beside the request that was recorded.
 */
export interface AgentExistingRecord {
  archive_id: string;
  name: string;
  state: ComputerArchiveEntry['status'];
}

export type ArchiveAgentStart =
  | { ok: false; code: 'needs_approval'; request_id: string; message: string; open: ArchiveOpenTarget; existing_record?: AgentExistingRecord }
  | { ok: true; status: 'checking'; request_id: string; name: string; message: string }
  | { ok: false; code: 'invalid_path' | 'too_many_requests' | 'archives_unreadable' | 'requests_unreadable'; message: string };

export type ArchiveAgentRemove =
  | { ok: false; code: 'needs_approval'; request_id: string; archive_id: string; name: string; message: string; open: ArchiveOpenTarget }
  | { ok: true; status: 'removing'; archive_id: string; name: string; message: string }
  | { ok: false; code: 'unknown_archive' | 'too_many_requests' | 'archives_unreadable' | 'requests_unreadable'; message: string };

export interface ArchiveImportAgent {
  start(path: unknown): ArchiveAgentStart;
  status(archiveId?: unknown): ArchiveAgentStatus;
  remove(archiveId: unknown): ArchiveAgentRemove;
}

export interface ArchiveImportAgentDeps {
  state: ArchiveImportStateStore;
  requests: ArchiveImportRequestStore;
  /** The dashboard's own list (dashboard.ts view): the one thing status words. */
  view: () => ComputerArchivesMeta;
}

/**
 * Plain words for what an agent is told; the codes are the contract.
 */
export const ARCHIVE_AGENT_COPY = {
  invalidPath: 'Give the full path of the file or folder, starting with /. Olympus does not look at it until the person approves.',
  tooMany: 'Too many requests are already waiting for the person. Ask them to answer the ones under Archives on their computer\'s dashboard first.',
  archivesUnreadable: 'Olympus cannot read its list of imported archives right now, so it cannot tell what is imported. Nothing was deleted. Ask the person to open Archives on their computer\'s dashboard and choose See why.',
  requestsUnreadable: 'Olympus cannot read its list of imports waiting for an answer right now, so it did not record the request. Ask the person to open Archives on their computer\'s dashboard and choose See why.',
  unknownArchive: 'No archive with that id is imported. Call archive_import with status to list them.',
  needsApproval: 'Olympus imports a file only after the person approves it, and has not opened {name}. Tell them to open Olympus on their computer, go to Sources, then Archives, and choose Import on the request for {name}. Do not open, copy or read the file yourself, and do not ask again: call archive_import with status to see when it has been approved.',
  needsRemovalApproval: 'Olympus removes an imported archive only after the person approves it. Tell them to open Olympus on their computer, go to Sources, then Archives, and choose Remove on the request for {name}. Removing deletes everything Olympus made from it; the file itself stays where it is. Do not ask again: call archive_import with status to see when it is gone.',
  checking: 'The person approved {name} and Olympus is checking whether it is already imported. Call archive_import with status to see the result.',
  existingRecord: {
    imported: 'Olympus has an earlier import from this same path: {name}.',
    importing: 'Olympus is importing {name} from this same path now.',
    stopped: 'An earlier import from this same path, {name}, stopped before it finished.',
    removing: 'Olympus is removing {name}, an earlier import from this same path.',
  },
  existingNote: 'A matching path does not show that this file is the one imported: it may have been replaced since, so Olympus recorded a request for the file as it is now. When the person approves, Olympus opens the file, compares it with what it already holds, and says if it is the same export.',
  removing: '{name} is already being removed. Call archive_import with status to see when it is gone.',
  heldNote: {
    ready: DASHBOARD_ARCHIVE_COPY.heldWhy.ready,
    waiting: DASHBOARD_ARCHIVE_COPY.heldWhy.waiting,
    off: DASHBOARD_ARCHIVE_COPY.heldWhy.off,
  },
  request: {
    importWaiting: 'Waiting for the person to choose Import or Decline on the dashboard.',
    removeWaiting: 'Waiting for the person to choose Remove or Decline on the dashboard.',
    checking: 'Olympus is checking whether this is already imported.',
    already: 'It is already imported.',
    failed: 'It was not imported: {reason}',
  },
} as const;

function fill(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(values)) out = out.split(`{${key}}`).join(value);
  return out;
}

function messages(n: number): string {
  return n === 1 ? DASHBOARD_ARCHIVE_COPY.items.one : DASHBOARD_ARCHIVE_COPY.items.many.replace('{n}', String(n));
}

function kindLine(kinds: Readonly<Record<string, { one: string; many: string }>>, entry: { kind: string; count: number; file?: string }): AgentArchiveLine {
  const words = kinds[entry.kind] ?? kinds.other!;
  const gap = entry.count === 1 ? words.one : words.many.replace('{n}', String(entry.count));
  return {
    kind: entry.kind,
    count: entry.count,
    ...(entry.file ? { file: entry.file } : {}),
    line: entry.file ? fill(DASHBOARD_ARCHIVE_COPY.gapInFile, { file: entry.file, gap }) : gap,
  };
}

function summaryOf(entry: ComputerArchiveEntry, stopped: AgentArchiveStopped | undefined): string {
  const copy = DASHBOARD_ARCHIVE_COPY;
  if (entry.countsUnavailable && entry.status !== 'stopped' && entry.status !== 'removing') {
    // The counts are not zero, they are unknown: say so, never "0 messages".
    const read = entry.status === 'importing' ? `${fill(copy.importingLineUncounted, { percent: String(entry.percent ?? 0) })}. ` : '';
    return `${read}${copy.countsUnavailable.why} ${copy.countsUnavailable.fix}`;
  }
  const items = messages(entry.items);
  const held = entry.items > 0 && entry.status !== 'removing'
    ? ` ${fill(copy.judgedLine, { judged: String(entry.judged), held: String(entry.held) })}.`
    : '';
  switch (entry.status) {
    case 'importing':
      return `${fill(copy.importingLine, { percent: String(entry.percent ?? 0), items })}.${held}`;
    case 'imported':
      return `${fill(copy.importedLineNoTime, { items })}.${held}`;
    case 'stopped':
      return `Stopped: ${stopped?.why ?? ''} ${stopped?.fix ?? ''}`.trim();
    case 'removing':
      return copy.removingLine;
  }
}

function archiveOf(entry: ComputerArchiveEntry): AgentArchive {
  const copy = DASHBOARD_ARCHIVE_COPY;
  let stopped: AgentArchiveStopped | undefined;
  if (entry.status === 'stopped') {
    const words = (copy.stopped as Record<string, { why: string; fix: string }>)[entry.stop?.code ?? ''] ?? copy.stopped.other;
    stopped = {
      code: entry.stop?.code ?? 'other',
      ...(entry.stop?.file ? { file: entry.stop.file } : {}),
      why: fill(words.why, { file: entry.stop?.file ?? copy.thisFile }),
      fix: words.fix,
    };
  }
  return {
    archive_id: entry.id,
    name: entry.name,
    format: entry.format,
    where: entry.where,
    status: entry.status,
    ...(entry.countsUnavailable
      ? { counts_unavailable: true as const }
      : { messages: entry.items, judged: entry.judged, waiting_for_private_model: entry.held }),
    ...(entry.status === 'importing' && entry.percent !== undefined ? { progress_percent: entry.percent } : {}),
    ...(entry.earliest ? { earliest: entry.earliest } : {}),
    ...(entry.latest ? { latest: entry.latest } : {}),
    started_at: entry.startedAt,
    ...(entry.importedAt ? { imported_at: entry.importedAt } : {}),
    ...(stopped ? { stopped } : {}),
    not_read: entry.gaps.map((gap) => kindLine(copy.gaps, gap)),
    left_out: entry.skipped.map((gap) => kindLine(copy.gaps, gap)),
    summary: summaryOf(entry, stopped),
  };
}

function requestOf(request: ComputerArchiveRequest): AgentArchiveRequest {
  const copy = ARCHIVE_AGENT_COPY.request;
  const kind = request.kind === 'remove' ? 'remove' : 'import';
  let state: AgentArchiveRequest['state'];
  let note: string;
  if (request.status === 'pending') {
    state = 'waiting_for_approval';
    note = kind === 'remove' ? copy.removeWaiting : copy.importWaiting;
  } else if (request.status === 'checking') {
    state = 'checking';
    note = copy.checking;
  } else if (request.status === 'already_imported') {
    state = 'already_imported';
    note = copy.already;
  } else {
    state = 'not_imported';
    const reason = (DASHBOARD_ARCHIVE_COPY.failed as Record<string, string>)[request.code ?? ''] ?? DASHBOARD_ARCHIVE_COPY.failed.unreadable;
    note = fill(copy.failed, { reason });
  }
  return {
    request_id: request.id,
    kind,
    name: request.name,
    where: request.where,
    origin: request.origin,
    state,
    ...(request.archiveId ? { archive_id: request.archiveId } : {}),
    ...(request.archiveName ? { archive_name: request.archiveName } : {}),
    note,
  };
}

function unreadableMessage(unreadable: NonNullable<ComputerArchivesMeta['unreadable']>): string {
  const copy = DASHBOARD_ARCHIVE_COPY.unreadable;
  const why = fill((copy.why as Record<string, string>)[unreadable.reason] ?? copy.why.other, { file: unreadable.file });
  return `${why} ${copy.kept} ${(copy.fix as Record<string, string>)[unreadable.reason] ?? copy.fix.other}`;
}

/**
 * The canonical path of an archive's chosen file or folder, as text.
 */
function recordedPath(rootPath: string, chosenRelPath: string): string {
  return chosenRelPath ? posix.join(rootPath, chosenRelPath) : rootPath;
}

/**
 * A path as an agent spelled it, with trailing slashes dropped and its
 * letters composed: text only, nothing here asks the disk. `..` and links
 * are left alone, since only the disk can say where they lead.
 */
function spelled(path: string): string {
  const composed = path.normalize('NFC');
  return composed.length > 1 ? composed.replace(/\/+$/, '') || '/' : composed;
}

/**
 * A store that could not be read (damaged, written by a newer build, or not
 * allowed), as opposed to a bug: the answer says so instead of "none".
 */
function unreadableStore(error: unknown): boolean {
  return error instanceof ArchiveRecordFormError || error instanceof SyntaxError
    || typeof (error as { code?: unknown } | null)?.code === 'string';
}

export function createArchiveImportAgent(deps: ArchiveImportAgentDeps): ArchiveImportAgent {
  return {
    start(path) {
      if (typeof path !== 'string' || path.length === 0 || path.length > ARCHIVE_IMPORT_REQUEST_PATH_MAX
        || path.includes('\0') || !path.startsWith('/')) {
        return { ok: false, code: 'invalid_path', message: ARCHIVE_AGENT_COPY.invalidPath };
      }
      const name = displayText(archivePathLabel(path));
      const asked = spelled(path);
      let records;
      try {
        records = deps.state.list();
      } catch (error) {
        if (unreadableStore(error)) {
          return { ok: false, code: 'archives_unreadable', message: ARCHIVE_AGENT_COPY.archivesUnreadable };
        }
        throw error;
      }
      // A record at this path is reported as what it is: an earlier record, in its own state. It is not
      // proof the file is the same export (a newer one may have replaced it, or an import may have stopped
      // before reading anything), so a request is recorded for the file as it is now. Whether the bytes
      // repeat an earlier import is for the approval to find out, which reads the files; nothing here does.
      const record = records
        .filter((candidate) => spelled(recordedPath(candidate.root_path, candidate.chosen_rel_path)) === asked)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
      const existing_record: AgentExistingRecord | undefined = record
        ? { archive_id: record.archive_id, name: displayText(record.label), state: record.status }
        : undefined;
      let entry;
      try {
        const checking = deps.requests.list().find((request) => request.kind === 'import'
          && request.path === path && request.status === 'checking');
        if (checking) {
          return {
            ok: true,
            status: 'checking',
            request_id: checking.request_id,
            name,
            message: fill(ARCHIVE_AGENT_COPY.checking, { name }),
          };
        }
        entry = deps.requests.addPending(path);
      } catch (error) {
        if (unreadableStore(error)) {
          return { ok: false, code: 'requests_unreadable', message: ARCHIVE_AGENT_COPY.requestsUnreadable };
        }
        throw error;
      }
      if (!entry) return { ok: false, code: 'too_many_requests', message: ARCHIVE_AGENT_COPY.tooMany };
      return {
        ok: false,
        code: 'needs_approval',
        request_id: entry.request_id,
        message: [
          ...(existing_record
            ? [fill(ARCHIVE_AGENT_COPY.existingRecord[existing_record.state], { name: existing_record.name }), ARCHIVE_AGENT_COPY.existingNote]
            : []),
          fill(ARCHIVE_AGENT_COPY.needsApproval, { name }),
        ].join(' '),
        open: archivesOpenTarget(),
        ...(existing_record ? { existing_record } : {}),
      };
    },

    status(archiveId) {
      if (archiveId !== undefined && (typeof archiveId !== 'string' || !isArchiveId(archiveId))) {
        return { ok: false, code: 'unknown_archive', message: ARCHIVE_AGENT_COPY.unknownArchive };
      }
      const meta = deps.view();
      if (meta.unreadable?.list === 'archives') {
        return {
          ok: false,
          code: 'archives_unreadable',
          reason: meta.unreadable.reason,
          message: unreadableMessage(meta.unreadable),
        };
      }
      const entries = archiveId === undefined ? meta.archives : meta.archives.filter((entry) => entry.id === archiveId);
      if (archiveId !== undefined && entries.length === 0) {
        return { ok: false, code: 'unknown_archive', message: ARCHIVE_AGENT_COPY.unknownArchive };
      }
      const held = entries.some((entry) => entry.status !== 'removing' && !entry.countsUnavailable && entry.held > 0);
      const result: Extract<ArchiveAgentStatus, { ok: true }> = {
        ok: true,
        archives: entries.map(archiveOf),
        private_model: meta.privateModel,
      };
      if (meta.unreadable?.list === 'requests') {
        result.requests_unreadable = { reason: meta.unreadable.reason, message: unreadableMessage(meta.unreadable) };
      } else {
        const asked = archiveId === undefined
          ? meta.requests
          : meta.requests.filter((request) => request.archiveId === archiveId);
        result.requests = asked.map(requestOf);
      }
      if (held) result.private_model_note = ARCHIVE_AGENT_COPY.heldNote[meta.privateModel];
      if (meta.notRunning) {
        const copy = DASHBOARD_ARCHIVE_COPY.notRunning;
        result.not_running = { setting: meta.notRunning, message: `${copy.why[meta.notRunning]} ${copy.fix[meta.notRunning]}` };
      }
      return result;
    },

    remove(archiveId) {
      if (typeof archiveId !== 'string' || !isArchiveId(archiveId)) {
        return { ok: false, code: 'unknown_archive', message: ARCHIVE_AGENT_COPY.unknownArchive };
      }
      let record;
      try {
        record = deps.state.get(archiveId);
      } catch (error) {
        if (unreadableStore(error)) {
          return { ok: false, code: 'archives_unreadable', message: ARCHIVE_AGENT_COPY.archivesUnreadable };
        }
        throw error;
      }
      if (!record) return { ok: false, code: 'unknown_archive', message: ARCHIVE_AGENT_COPY.unknownArchive };
      const label = displayText(record.label);
      if (record.status === 'removing') {
        return {
          ok: true,
          status: 'removing',
          archive_id: record.archive_id,
          name: label,
          message: fill(ARCHIVE_AGENT_COPY.removing, { name: label }),
        };
      }
      let entry;
      try {
        entry = deps.requests.addRemoval(record.archive_id, record.label);
      } catch (error) {
        if (unreadableStore(error)) {
          return { ok: false, code: 'requests_unreadable', message: ARCHIVE_AGENT_COPY.requestsUnreadable };
        }
        throw error;
      }
      if (!entry) return { ok: false, code: 'too_many_requests', message: ARCHIVE_AGENT_COPY.tooMany };
      return {
        ok: false,
        code: 'needs_approval',
        request_id: entry.request_id,
        archive_id: record.archive_id,
        name: label,
        message: fill(ARCHIVE_AGENT_COPY.needsRemovalApproval, { name: label }),
        open: archivesOpenTarget(),
      };
    },
  };
}
