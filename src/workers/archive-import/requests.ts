/**
 * Imports asked for but not recorded as archives (yet): the requests an
 * agent left for the person to approve or decline, and the dashboard's own
 * approvals while their files are read whole to tell a copy of an earlier
 * import apart ("checking"), or after that check found one ("already
 * imported") or failed. Also the removals an agent asked for, which wait for
 * the person the same way (`kind: 'remove'`, the archive's id and name, no
 * path).
 *
 * Kept apart from the archive record (state.ts), which holds only approved
 * imports, and from the folder-scope approvals (file-source-scopes.json),
 * whose sources have accounts and scopes this has neither of. One private
 * JSON file beside the archive record, written atomically under a file
 * lease.
 *
 * An agent's request holds the path exactly as asked, as text: nothing here
 * opens or stats it. Only the dashboard's approval does, through the picker's
 * checks.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import { withFileLeaseSync } from '../../core/file-lease.ts';
import type { LayoutEnv } from '../../core/olympus-layout.ts';
import { recordAccountPlacement } from '../../core/source-storage.ts';
import { archiveManifestSha256 } from './manifest.ts';
import {
  ARCHIVE_IMPORTS_SOURCE_ID,
  ArchiveImportStateStore,
  ArchiveRecordFormError,
  defaultArchiveImportStatePath,
  isArchiveId,
  type NewArchiveImportRecord,
} from './state.ts';

/**
 * Requests an agent may leave waiting at once; one more is refused until the person answers.
 */
export const ARCHIVE_IMPORT_PENDING_REQUESTS_MAX = 20;
/**
 * Finished checks kept for the person to see (the oldest go first past this).
 */
export const ARCHIVE_IMPORT_OUTCOMES_MAX = 20;
/**
 * The longest path text kept for a request.
 */
export const ARCHIVE_IMPORT_REQUEST_PATH_MAX = 4096;

export type ArchiveImportRequestStatus = 'pending' | 'checking' | 'already_imported' | 'failed';

/**
 * What the request asks: to import a file or folder, or to remove an
 * imported archive. A request written before removals existed has no kind,
 * and is an import.
 */
export type ArchiveImportRequestKind = 'import' | 'remove';

export interface ArchiveImportRequest {
  request_id: string;
  kind: ArchiveImportRequestKind;
  /**
   * Who asked: an agent (waits for the person), or the person in the dashboard.
   */
  origin: 'agent' | 'dashboard';
  /**
   * The path as asked (an agent's) or as chosen in the picker (the dashboard's).
   * A removal names no path: it is empty.
   */
  path: string;
  /**
   * The last part of the path, for display; for a removal, the archive's name when it was asked.
   */
  label: string;
  status: ArchiveImportRequestStatus;
  /**
   * already_imported: the import that already holds these files. A removal:
   * the archive it asks to remove.
   */
  archive_id?: string;
  /**
   * failed: why, as a closed code the dashboard words.
   */
  code?: string;
  /**
   * checking: exactly what the person approved (the folder's identity, each
   * file's path and version), so a check a restart interrupted resumes
   * against that approval, reading nothing before it matches.
   */
  approved?: ArchiveImportApproval;
  created_at: string;
  updated_at: string;
}

/**
 * What one approval pinned: the import exactly as it would be recorded.
 */
export type ArchiveImportApproval = NewArchiveImportRecord;

interface PersistedRequests {
  version: 1;
  requests: ArchiveImportRequest[];
}

export function archiveImportRequestsPath(statePath: string): string {
  return join(dirname(statePath), 'archive-import-requests.json');
}

/**
 * The one exclusion an approval holds while it moves between these requests
 * and the archive record (a check's commit, an import recorded at once), and
 * the CLI delete holds across its custody check and its delete: no delete
 * runs between those two writes, and no commit lands after a delete.
 */
export function withArchiveImportApprovals<T>(statePath: string, run: () => T): T {
  return withFileLeaseSync(join(dirname(statePath), 'archive-import-approvals'), () => run());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const STATUSES: ReadonlySet<string> = new Set(['pending', 'checking', 'already_imported', 'failed']);

function validApprovedFile(value: unknown): boolean {
  return isRecord(value) && typeof value.rel_path === 'string'
    && typeof value.dev === 'string' && typeof value.ino === 'string'
    && Number.isSafeInteger(value.size) && typeof value.mtime_ms === 'number' && Number.isFinite(value.mtime_ms)
    && isRecord(value.fingerprint)
    && typeof value.fingerprint.head_sha256 === 'string' && typeof value.fingerprint.tail_sha256 === 'string'
    && (value.members === undefined
      || (isRecord(value.members) && Number.isSafeInteger(value.members.count) && typeof value.members.sha256 === 'string'));
}

function validApproval(value: unknown): value is ArchiveImportApproval {
  if (!isRecord(value) || !isRecord(value.root_identity) || !Array.isArray(value.files) || value.files.length === 0) return false;
  return typeof value.format === 'string' && typeof value.provider === 'string' && typeof value.family === 'string'
    && typeof value.label === 'string' && typeof value.root_path === 'string' && value.root_path.startsWith('/')
    && typeof value.root_identity.dev === 'string' && typeof value.root_identity.ino === 'string'
    && typeof value.chosen_rel_path === 'string'
    && value.files.every(validApprovedFile)
    && (value.skipped === undefined
      || (isRecord(value.skipped) && Object.values(value.skipped).every((count) => Number.isSafeInteger(count) && (count as number) > 0)))
    && value.manifest_sha256 === archiveManifestSha256(value.files as ArchiveImportApproval['files']);
}

function validRequest(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const kind = value.kind === undefined ? 'import' : value.kind;
  if (kind !== 'import' && kind !== 'remove') return false;
  const path = value.path;
  // An import names a path; a removal names the archive and waits (it is never checked).
  const named = kind === 'import'
    ? typeof path === 'string' && path.length > 0 && path.length <= ARCHIVE_IMPORT_REQUEST_PATH_MAX
    : path === '' && value.origin === 'agent' && value.status === 'pending'
      && typeof value.archive_id === 'string';
  return typeof value.request_id === 'string' && isArchiveId(value.request_id)
    && (value.origin === 'agent' || value.origin === 'dashboard')
    && named
    && typeof value.label === 'string'
    && typeof value.status === 'string' && STATUSES.has(value.status)
    && (value.archive_id === undefined || (typeof value.archive_id === 'string' && isArchiveId(value.archive_id)))
    && (value.code === undefined || typeof value.code === 'string')
    && (value.approved === undefined || validApproval(value.approved))
    && typeof value.created_at === 'string' && typeof value.updated_at === 'string';
}

/**
 * An unreadable file is an error, never an empty list: a request the person was asked about must not vanish.
 */
function readRequests(path: string): PersistedRequests {
  if (!existsSync(path)) return { version: 1, requests: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.requests) || !parsed.requests.every(validRequest)) {
    throw new ArchiveRecordFormError('The archive import requests are not in a form this build reads.');
  }
  return {
    version: 1,
    requests: (parsed.requests as Array<Record<string, unknown>>).map((entry) => ({ ...entry, kind: entry.kind ?? 'import' }) as unknown as ArchiveImportRequest),
  };
}

/**
 * The last part of a path, for display only.
 */
export function archivePathLabel(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return (parts[parts.length - 1] ?? path).normalize('NFC').slice(0, 255);
}

export class ArchiveImportRequestStore {
  readonly path: string;
  private readonly now: () => Date;
  private readonly env: LayoutEnv;

  // `env` is the one the path was resolved in; it decides where the account's placement is recorded.
  constructor(options: { path: string; now?: () => Date; env?: LayoutEnv }) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date());
    this.env = options.env ?? process.env;
  }

  list(): ArchiveImportRequest[] {
    return readRequests(this.path).requests;
  }

  get(requestId: string): ArchiveImportRequest | undefined {
    return this.list().find((request) => request.request_id === requestId);
  }

  /**
   * An agent's request, waiting for the person. The path is kept as text and
   * never opened here. Refused (undefined) while too many already wait.
   */
  addPending(path: string): ArchiveImportRequest | undefined {
    if (!path || path.length > ARCHIVE_IMPORT_REQUEST_PATH_MAX || path.includes('\0')) {
      throw new Error('The path to import is not a path.');
    }
    let added: ArchiveImportRequest | undefined;
    this.mutate((state) => {
      const waiting = state.requests.filter((request) => request.status === 'pending');
      const same = waiting.find((request) => request.kind === 'import' && request.path === path);
      if (same) {
        added = same;
        return false;
      }
      // Imports and removals share one bound: what waits for the person is theirs to answer.
      if (waiting.length >= ARCHIVE_IMPORT_PENDING_REQUESTS_MAX) return false;
      added = this.entry('import', 'agent', path, 'pending');
      state.requests.push(added);
      return true;
    });
    return added;
  }

  /**
   * An agent's request to remove an imported archive, waiting for the
   * person. One request per archive; refused (undefined) while too many
   * already wait. Nothing is removed here: only the dashboard's approval
   * removes (dashboard.ts).
   */
  addRemoval(archiveId: string, name: string): ArchiveImportRequest | undefined {
    if (!isArchiveId(archiveId)) throw new Error('The archive to remove is not an archive id.');
    let added: ArchiveImportRequest | undefined;
    this.mutate((state) => {
      const waiting = state.requests.filter((request) => request.status === 'pending');
      const same = waiting.find((request) => request.kind === 'remove' && request.archive_id === archiveId);
      if (same) {
        added = same;
        return false;
      }
      if (waiting.length >= ARCHIVE_IMPORT_PENDING_REQUESTS_MAX) return false;
      added = this.entry('remove', 'agent', '', 'pending', { archiveId, label: name });
      state.requests.push(added);
      return true;
    });
    return added;
  }

  /**
   * The person's approval, while its files are read whole (the one already checking, for a second press).
   */
  addChecking(path: string, approved: ArchiveImportApproval): ArchiveImportRequest {
    let entry: ArchiveImportRequest | undefined;
    this.mutate((state) => {
      entry = state.requests.find((request) => request.status === 'checking' && request.path === path);
      if (entry) return false;
      entry = { ...this.entry('import', 'dashboard', path, 'checking'), approved };
      state.requests.push(entry);
      return true;
    });
    return entry!;
  }

  /**
   * A pending request the person approved: it is checked now, against what they approved.
   */
  startChecking(requestId: string, approved: ArchiveImportApproval): ArchiveImportRequest | undefined {
    return this.change(requestId, (request) => {
      if (request.kind !== 'import' || request.status !== 'pending') return false;
      request.status = 'checking';
      request.approved = approved;
    });
  }

  /**
   * How a check ended when it did not start an import.
   */
  settle(requestId: string, outcome: { status: 'already_imported'; archiveId: string } | { status: 'failed'; code: string }): void {
    this.mutate((state) => {
      const request = state.requests.find((entry) => entry.request_id === requestId);
      if (!request) return false;
      request.status = outcome.status;
      delete request.approved;
      if (outcome.status === 'already_imported') {
        request.archive_id = outcome.archiveId;
        delete request.code;
      } else {
        request.code = outcome.code;
        delete request.archive_id;
      }
      request.updated_at = this.now().toISOString();
      // Finished checks are kept for the person to read, the newest first to stay.
      const finished = state.requests.filter((entry) => entry.status === 'already_imported' || entry.status === 'failed');
      const drop = new Set(finished
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(ARCHIVE_IMPORT_OUTCOMES_MAX)
        .map((entry) => entry.request_id));
      state.requests = state.requests.filter((entry) => !drop.has(entry.request_id));
      return true;
    });
  }

  /**
   * Declined, dismissed, or done (its import started, its archive removed).
   */
  remove(requestId: string): boolean {
    let removed = false;
    this.mutate((state) => {
      const before = state.requests.length;
      state.requests = state.requests.filter((entry) => entry.request_id !== requestId);
      removed = state.requests.length !== before;
      return removed;
    });
    return removed;
  }

  private entry(
    kind: ArchiveImportRequestKind,
    origin: ArchiveImportRequest['origin'],
    path: string,
    status: ArchiveImportRequestStatus,
    removal?: { archiveId: string; label: string },
  ): ArchiveImportRequest {
    const at = this.now().toISOString();
    return {
      request_id: randomUUID(),
      kind,
      origin,
      path,
      label: removal ? removal.label.normalize('NFC').slice(0, 255) : archivePathLabel(path),
      status,
      ...(removal ? { archive_id: removal.archiveId } : {}),
      created_at: at,
      updated_at: at,
    };
  }

  private change(requestId: string, edit: (request: ArchiveImportRequest) => void | false): ArchiveImportRequest | undefined {
    let changed: ArchiveImportRequest | undefined;
    this.mutate((state) => {
      const request = state.requests.find((entry) => entry.request_id === requestId);
      if (!request || edit(request) === false) return false;
      request.updated_at = this.now().toISOString();
      changed = request;
      return true;
    });
    return changed;
  }

  private mutate(change: (state: PersistedRequests) => boolean | void): void {
    // A request can be the account's first file, with no store opened yet.
    recordAccountPlacement({ sourceId: ARCHIVE_IMPORTS_SOURCE_ID }, this.path, this.env);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    withFileLeaseSync(this.path, (lease) => {
      const state = readRequests(this.path);
      if (change(state) === false) return;
      lease.commit(() => writePrivateFileAtomicSync(this.path, `${JSON.stringify(state, null, 2)}\n`));
    });
  }
}

/**
 * Imported archives have no credential or pairing to end before their data is
 * deleted: an archive still recorded, or an approval still being checked for
 * copies, holds the per-source Delete instead (core/source-delete-holds.ts).
 * The check records the import when it finishes, so deleting under it would
 * let an import land after the Delete. Either file unreadable counts as there.
 */
export const archiveImportDeleteHold = {
  id: 'archive-import-approvals',
  sourceId: ARCHIVE_IMPORTS_SOURCE_ID,
  present(env: LayoutEnv): boolean {
    try {
      const statePath = defaultArchiveImportStatePath(env);
      if (new ArchiveImportStateStore({ path: statePath }).list().length > 0) return true;
      return new ArchiveImportRequestStore({ path: archiveImportRequestsPath(statePath) }).list()
        .some((request) => request.status === 'checking');
    } catch {
      return true;
    }
  },
  nextAction: 'Under Archives in the local dashboard, cancel any import still being checked (or let it finish) and remove each archive, then rerun the CLI delete.',
  exclusive<T>(env: LayoutEnv, run: () => T): T {
    return withArchiveImportApprovals(defaultArchiveImportStatePath(env), run);
  },
};
