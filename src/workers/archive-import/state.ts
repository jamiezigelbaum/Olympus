/**
 * The record of every imported archive (docs/design/archive-import.md).
 *
 * One private JSON file in the data directory, written atomically under a
 * file lease so the worker and a command never interleave. Each archive has a
 * random, persistent id: it is the connector instance id (`archive.<id>`) and
 * the `accountScope` of every item, so two imports of the same format never
 * share a resume point or a removal.
 *
 * Status: `importing` until the listing reached the end, then `imported`.
 * `stopped` when a file changed or went missing (with the reason), and
 * `removing` from the moment a removal starts until every derived row is gone,
 * so a removal interrupted by a restart carries on from where it was.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import type { ArchiveImportFinding } from '../../core/archive-formats.ts';
import { withFileLeaseSync } from '../../core/file-lease.ts';
import { standaloneLinuxDataDir } from '../../core/linux-engine-layout.ts';
import type { ArchiveManifestFile } from './manifest.ts';

export const ARCHIVE_IMPORTS_STATE_PATH_ENV = 'OLYMPUS_ARCHIVE_IMPORTS_STATE_PATH';
export const ARCHIVE_IMPORTS_SOURCE_ID = 'archive.imports';

/**
 * Findings kept per archive as examples of exactly where each gap is.
 */
export const ARCHIVE_FINDING_SAMPLES_MAX = 50;

export type ArchiveImportStatus = 'importing' | 'imported' | 'stopped' | 'removing';

export interface ArchiveImportStop {
  code: 'file_changed' | 'file_missing' | 'file_unreadable' | 'resume_point_invalid' | 'format_unavailable' | 'root_changed';
  message: string;
  rel_path?: string;
  at: string;
}

export interface ArchiveFindingSample {
  kind: string;
  file_index: number;
  offset: number;
}

export interface ArchiveImportFindings {
  gaps: Record<string, number>;
  skipped: Record<string, number>;
  samples: ArchiveFindingSample[];
  /**
   * The last position counted: a finding at or before it was counted already.
   */
  through?: { file_index: number; offset: number };
}

export interface ArchiveImportRecord {
  archive_id: string;
  format: string;
  provider: string;
  family: string;
  /**
   * The chosen file or folder's name, for display.
   */
  label: string;
  /**
   * The approved folder the reader opens (a chosen file's parent, or the chosen folder).
   */
  root_path: string;
  root_identity: { dev: string; ino: string };
  /**
   * The chosen path inside the root ('' for the root itself).
   */
  chosen_rel_path: string;
  files: ArchiveManifestFile[];
  manifest_sha256: string;
  status: ArchiveImportStatus;
  stop?: ArchiveImportStop;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  removal_started_at?: string;
  findings: ArchiveImportFindings;
  /**
   * Earliest and latest item dates seen.
   */
  date_range?: { earliest: string; latest: string };
  /**
   * How far the import has read (a file of `files` and a byte offset in it),
   * for progress only: the resume point is the store's committed cursor.
   */
  read_position?: { file_index: number; offset: number };
}

interface PersistedArchiveImportState {
  version: 1;
  archives: ArchiveImportRecord[];
}

function dataDir(env: Record<string, string | undefined>): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return standaloneLinuxDataDir(env) ?? join(dataHome, 'openclaw', 'olympus');
}

export function defaultArchiveImportStatePath(env: Record<string, string | undefined> = process.env): string {
  return env[ARCHIVE_IMPORTS_STATE_PATH_ENV]?.trim() || join(dataDir(env), 'archive-imports.json');
}

export function archiveConnectorId(archiveId: string): string {
  return `archive.${archiveId}`;
}

export function emptyArchiveFindings(): ArchiveImportFindings {
  return { gaps: {}, skipped: {}, samples: [] };
}

/**
 * A version-4 UUID in lowercase hex, as `randomUUID` writes it.
 */
export function isArchiveId(value: string): boolean {
  if (value.length !== 36) return false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (index === 8 || index === 13 || index === 18 || index === 23) {
      if (char !== '-') return false;
    } else if (!'0123456789abcdef'.includes(char)) {
      return false;
    }
  }
  return value[14] === '4' && '89ab'.includes(value[19]!);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validRecord(value: unknown): value is ArchiveImportRecord {
  if (!isRecord(value)) return false;
  return typeof value.archive_id === 'string' && isArchiveId(value.archive_id)
    && typeof value.format === 'string' && typeof value.provider === 'string' && typeof value.family === 'string'
    && typeof value.label === 'string' && typeof value.root_path === 'string' && value.root_path.startsWith('/')
    && isRecord(value.root_identity) && typeof value.root_identity.dev === 'string' && typeof value.root_identity.ino === 'string'
    && typeof value.chosen_rel_path === 'string'
    && Array.isArray(value.files) && value.files.length > 0
    && typeof value.manifest_sha256 === 'string'
    && (value.status === 'importing' || value.status === 'imported' || value.status === 'stopped' || value.status === 'removing')
    && typeof value.created_at === 'string' && typeof value.updated_at === 'string'
    && isRecord(value.findings) && isRecord(value.findings.gaps) && isRecord(value.findings.skipped)
    && Array.isArray(value.findings.samples);
}

/**
 * An unreadable or malformed file is an error, never an empty list: reading
 * it as "no archives" would forget an import whose items are still stored.
 */
function readState(path: string): PersistedArchiveImportState {
  if (!existsSync(path)) return { version: 1, archives: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.archives)) {
    throw new Error('The archive import record is not in a form this build reads.');
  }
  const archives: ArchiveImportRecord[] = [];
  for (const entry of parsed.archives) {
    if (!validRecord(entry)) throw new Error('The archive import record holds an entry this build does not read.');
    archives.push(entry);
  }
  return { version: 1, archives };
}

export interface NewArchiveImportRecord {
  format: string;
  provider: string;
  family: string;
  label: string;
  root_path: string;
  root_identity: { dev: string; ino: string };
  chosen_rel_path: string;
  files: ArchiveManifestFile[];
  manifest_sha256: string;
}

export class ArchiveImportStateStore {
  readonly path: string;
  private readonly now: () => Date;

  constructor(options: { path: string; now?: () => Date }) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date());
  }

  list(): ArchiveImportRecord[] {
    return readState(this.path).archives;
  }

  get(archiveId: string): ArchiveImportRecord | undefined {
    return this.list().find((record) => record.archive_id === archiveId);
  }

  create(input: NewArchiveImportRecord): ArchiveImportRecord {
    const at = this.now().toISOString();
    const record: ArchiveImportRecord = {
      archive_id: randomUUID(),
      ...input,
      status: 'importing',
      created_at: at,
      updated_at: at,
      findings: emptyArchiveFindings(),
    };
    this.mutate((state) => {
      state.archives.push(record);
    });
    return record;
  }

  /**
   * Applies `change` to the archive's record, as read under the lease;
   * undefined when it is not recorded. A change that returns false leaves
   * the record as it was (nothing is written) and the record is returned.
   */
  update(archiveId: string, change: (record: ArchiveImportRecord) => void | false): ArchiveImportRecord | undefined {
    let updated: ArchiveImportRecord | undefined;
    this.mutate((state) => {
      const record = state.archives.find((entry) => entry.archive_id === archiveId);
      if (!record) return false;
      const before = structuredClone(record);
      if (change(record) === false) {
        updated = before;
        return false;
      }
      record.updated_at = this.now().toISOString();
      updated = record;
      return true;
    });
    return updated;
  }

  /**
   * Counts the findings an import met, each once: a finding at or before the
   * position already counted was counted on an earlier pass (the same bytes
   * listed again after a restart). With `position`, also notes how far the
   * import has read, in the same write.
   */
  recordFindings(
    archiveId: string,
    findings: readonly ArchiveImportFinding[],
    position?: { fileIndex: number; offset: number },
  ): void {
    if (findings.length === 0 && !position) return;
    this.update(archiveId, (record) => {
      // How far the import read, for its progress: only forward, and only while it imports.
      const read = record.read_position;
      const movesOn = position !== undefined && record.status === 'importing'
        && (!read || position.fileIndex > read.file_index
          || (position.fileIndex === read.file_index && position.offset > read.offset));
      if (findings.length === 0 && !movesOn) return false;
      if (movesOn) record.read_position = { file_index: position!.fileIndex, offset: position!.offset };
      const tally = record.findings;
      // Positions counted by an earlier call. One call carries every finding
      // of the messages it covers, so several findings at one position count.
      const through = tally.through;
      const before = (fileIndex: number, offset: number): boolean => through !== undefined
        && (fileIndex < through.file_index || (fileIndex === through.file_index && offset <= through.offset));
      let last = through;
      for (const finding of findings) {
        if (before(finding.fileIndex, finding.offset)) continue;
        const bucket = finding.class === 'gap' ? tally.gaps : tally.skipped;
        bucket[finding.kind] = (bucket[finding.kind] ?? 0) + Math.max(1, finding.count ?? 1);
        if (finding.class === 'gap' && tally.samples.length < ARCHIVE_FINDING_SAMPLES_MAX) {
          tally.samples.push({ kind: finding.kind, file_index: finding.fileIndex, offset: finding.offset });
        }
        if (!last || finding.fileIndex > last.file_index
          || (finding.fileIndex === last.file_index && finding.offset > last.offset)) {
          last = { file_index: finding.fileIndex, offset: finding.offset };
        }
      }
      if (last) tally.through = last;
    });
  }

  /**
   * Forgets the archive. Only the removal calls this, once nothing derived from it is left.
   */
  delete(archiveId: string): boolean {
    let removed = false;
    this.mutate((state) => {
      const before = state.archives.length;
      state.archives = state.archives.filter((entry) => entry.archive_id !== archiveId);
      removed = state.archives.length !== before;
      return removed;
    });
    return removed;
  }

  private mutate(change: (state: PersistedArchiveImportState) => boolean | void): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    withFileLeaseSync(this.path, (lease) => {
      const state = readState(this.path);
      if (change(state) === false) return;
      lease.commit(() => writePrivateFileAtomicSync(this.path, `${JSON.stringify(state, null, 2)}\n`));
    });
  }
}
