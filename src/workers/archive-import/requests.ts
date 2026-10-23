/**
 * Imports asked for but not recorded as archives (yet): the requests an
 * agent left for the person to approve or decline, and the dashboard's own
 * approvals while their files are read whole to tell a copy of an earlier
 * import apart ("checking"), or after that check found one ("already
 * imported") or failed.
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
import { isArchiveId } from './state.ts';

/** Requests an agent may leave waiting at once; one more is refused until the person answers. */
export const ARCHIVE_IMPORT_PENDING_REQUESTS_MAX = 20;
/** Finished checks kept for the person to see (the oldest go first past this). */
export const ARCHIVE_IMPORT_OUTCOMES_MAX = 20;
/** The longest path text kept for a request. */
export const ARCHIVE_IMPORT_REQUEST_PATH_MAX = 4096;

export type ArchiveImportRequestStatus = 'pending' | 'checking' | 'already_imported' | 'failed';

export interface ArchiveImportRequest {
  request_id: string;
  /** Who asked: an agent (waits for the person), or the person in the dashboard. */
  origin: 'agent' | 'dashboard';
  /** The path as asked (an agent's) or as chosen in the picker (the dashboard's). */
  path: string;
  /** The last part of the path, for display. */
  label: string;
  status: ArchiveImportRequestStatus;
  /** already_imported: the import that already holds these files. */
  archive_id?: string;
  /** failed: why, as a closed code the dashboard words. */
  code?: string;
  created_at: string;
  updated_at: string;
}

interface PersistedRequests {
  version: 1;
  requests: ArchiveImportRequest[];
}

export function archiveImportRequestsPath(statePath: string): string {
  return join(dirname(statePath), 'archive-import-requests.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

const STATUSES: ReadonlySet<string> = new Set(['pending', 'checking', 'already_imported', 'failed']);

function validRequest(value: unknown): value is ArchiveImportRequest {
  if (!isRecord(value)) return false;
  return typeof value.request_id === 'string' && isArchiveId(value.request_id)
    && (value.origin === 'agent' || value.origin === 'dashboard')
    && typeof value.path === 'string' && value.path.length > 0 && value.path.length <= ARCHIVE_IMPORT_REQUEST_PATH_MAX
    && typeof value.label === 'string'
    && typeof value.status === 'string' && STATUSES.has(value.status)
    && (value.archive_id === undefined || (typeof value.archive_id === 'string' && isArchiveId(value.archive_id)))
    && (value.code === undefined || typeof value.code === 'string')
    && typeof value.created_at === 'string' && typeof value.updated_at === 'string';
}

/** An unreadable file is an error, never an empty list: a request the person was asked about must not vanish. */
function readRequests(path: string): PersistedRequests {
  if (!existsSync(path)) return { version: 1, requests: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.requests) || !parsed.requests.every(validRequest)) {
    throw new Error('The archive import requests are not in a form this build reads.');
  }
  return { version: 1, requests: parsed.requests as ArchiveImportRequest[] };
}

/** The last part of a path, for display only. */
export function archivePathLabel(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return (parts[parts.length - 1] ?? path).normalize('NFC').slice(0, 255);
}

export class ArchiveImportRequestStore {
  readonly path: string;
  private readonly now: () => Date;

  constructor(options: { path: string; now?: () => Date }) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date());
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
      const same = waiting.find((request) => request.path === path);
      if (same) {
        added = same;
        return false;
      }
      if (waiting.length >= ARCHIVE_IMPORT_PENDING_REQUESTS_MAX) return false;
      added = this.entry('agent', path, 'pending');
      state.requests.push(added);
      return true;
    });
    return added;
  }

  /** The person's approval, while its files are read whole (the one already checking, for a second press). */
  addChecking(path: string): ArchiveImportRequest {
    let entry: ArchiveImportRequest | undefined;
    this.mutate((state) => {
      entry = state.requests.find((request) => request.status === 'checking' && request.path === path);
      if (entry) return false;
      entry = this.entry('dashboard', path, 'checking');
      state.requests.push(entry);
      return true;
    });
    return entry!;
  }

  /** A pending request the person approved: it is checked now. */
  startChecking(requestId: string): ArchiveImportRequest | undefined {
    return this.change(requestId, (request) => {
      if (request.status !== 'pending') return false;
      request.status = 'checking';
    });
  }

  /** How a check ended when it did not start an import. */
  settle(requestId: string, outcome: { status: 'already_imported'; archiveId: string } | { status: 'failed'; code: string }): void {
    this.mutate((state) => {
      const request = state.requests.find((entry) => entry.request_id === requestId);
      if (!request) return false;
      request.status = outcome.status;
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

  /** Declined, dismissed, or done (its import started). */
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

  private entry(origin: ArchiveImportRequest['origin'], path: string, status: ArchiveImportRequestStatus): ArchiveImportRequest {
    const at = this.now().toISOString();
    return { request_id: randomUUID(), origin, path, label: archivePathLabel(path), status, created_at: at, updated_at: at };
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
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    withFileLeaseSync(this.path, (lease) => {
      const state = readRequests(this.path);
      if (change(state) === false) return;
      lease.commit(() => writePrivateFileAtomicSync(this.path, `${JSON.stringify(state, null, 2)}\n`));
    });
  }
}
