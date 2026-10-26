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
import type { LayoutEnv } from '../../core/olympus-layout.ts';
import { resolvedRawPath } from '../../core/source-placement.ts';
import { recordAccountPlacement } from '../../core/source-storage.ts';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import { ARCHIVE_COMMON_FINDINGS, type ArchiveImportFinding } from '../../core/archive-formats.ts';
import { withFileLeaseSync } from '../../core/file-lease.ts';
import type { ArchiveManifestFile } from './manifest.ts';

export const ARCHIVE_IMPORTS_SOURCE_ID = 'archive.imports';

/**
 * Findings kept per archive as examples of exactly where each gap is.
 */
export const ARCHIVE_FINDING_SAMPLES_MAX = 50;

export type ArchiveImportStatus = 'importing' | 'imported' | 'stopped' | 'removing';

export interface ArchiveImportStop {
  code:
    | 'file_changed' | 'file_missing' | 'file_unreadable' | 'resume_point_invalid' | 'format_unavailable' | 'root_changed'
    // The owner pressed Stop: what was imported stays.
    | 'stopped_by_owner'
    // An input of a source (below): the account the source now holds is another one than the export's.
    | 'account_changed'
    // An input of a source (below): the source is being deleted or moved, or this build has no reader for it.
    | 'source_unavailable';
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
   * The gaps again, per file of the archive (by file index), so an archive
   * of several files can say which file each is in. Absent in a record
   * written before this was kept.
   */
  gaps_by_file?: Record<string, Record<string, number>>;
  /**
   * The last position counted: a finding at or before it was counted already.
   */
  through?: { file_index: number; offset: number };
  /**
   * The position of the last item whose repeat or not was counted, for
   * connectors that tell where each item is: an item at or before it was
   * judged on an earlier pass, whatever pages the replay cuts.
   */
  listed_through?: { file_index: number; offset: number };
}

/**
 * Items of a page whose positions the connector told: where the repeats are,
 * and where the page's last item is.
 */
export interface ArchiveRepeatedItems {
  repeatedAt: ReadonlyArray<{ fileIndex: number; offset: number }>;
  through?: { fileIndex: number; offset: number };
}

/**
 * The source an import is one input of (docs/design/archive-live-one-dataset.md):
 * its items are written by that source's own connector into the account's own
 * stores, not under `archive.imports`. Absent on an import that stays under
 * Archives. Set when the import starts and never changed.
 */
export interface ArchiveImportTarget {
  source_id: string;
  slot: string;
  /**
   * The provider account the export names (opaque: as the source's reader of
   * the export wrote it), asked about again at every pass. Absent when the
   * export names none.
   */
  import_account_id?: string;
  /**
   * The owner confirmed that the export is the account's own, where it could not be proved.
   */
  owner_confirmed?: true;
  /**
   * Which account that confirmation was about (`importAccountIdentity`), checked at every pass:
   * if the source holds another account by then, the import stops and the owner is asked again.
   */
  confirmed_account?: string;
}

/**
 * What an import's own run read, for an import that is an input of a source:
 * "N items from this archive, of which M were already there". Counted once per
 * position, so a pass replayed after a restart counts nothing twice.
 */
export interface ArchiveImportIntake {
  read: number;
  already_there: number;
  /**
   * The last position counted.
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
  /**
   * The source this import is an input of (see ArchiveImportTarget). Its
   * items are the source's, deleted with the source; it has no Remove.
   */
  target?: ArchiveImportTarget;
  /**
   * What the import read, and how much of it the source already held (inputs of a source only).
   */
  intake?: ArchiveImportIntake;
  /**
   * Why the import's last pass stopped early and waits (the source's provider
   * cannot be asked now): a short reason code, and for a limit that is too
   * small, the least it must be raised to. Cleared by the next pass that does
   * not wait.
   */
  waiting?: { reason: string; at: string; minimum?: number };
}

interface PersistedArchiveImportState {
  version: 1;
  archives: ArchiveImportRecord[];
}

export function defaultArchiveImportStatePath(env: Record<string, string | undefined> = process.env): string {
  return resolvedRawPath(ARCHIVE_IMPORTS_SOURCE_ID, 'archive-imports.json', env);
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
    && Array.isArray(value.findings.samples)
    && (value.target === undefined || (isRecord(value.target) && typeof value.target.source_id === 'string'
      && typeof value.target.slot === 'string'));
}

/**
 * An unreadable or malformed file is an error, never an empty list: reading
 * it as "no archives" would forget an import whose items are still stored.
 */
function readState(path: string): PersistedArchiveImportState {
  if (!existsSync(path)) return { version: 1, archives: [] };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.archives)) {
    throw new ArchiveRecordFormError('The archive import record is not in a form this build reads.');
  }
  const archives: ArchiveImportRecord[] = [];
  for (const entry of parsed.archives) {
    if (!validRecord(entry)) throw new ArchiveRecordFormError('The archive import record holds an entry this build does not read.');
    archives.push(entry);
  }
  return { version: 1, archives };
}

/**
 * A record that parsed but is not in a form this build reads (a newer
 * version wrote it, or it is damaged), apart from one that is not JSON at
 * all or cannot be opened.
 */
export class ArchiveRecordFormError extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = 'ArchiveRecordFormError';
  }
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
  /**
   * What was left out before any file was read, by kind (files of a chosen
   * folder that were not taken or not looked at). Counted once, here.
   */
  skipped?: Record<string, number>;
  /**
   * The source this import is an input of (see ArchiveImportTarget).
   */
  target?: ArchiveImportTarget;
}

export class ArchiveImportStateStore {
  readonly path: string;
  private readonly now: () => Date;
  // The environment the path was resolved in; it decides where the account's placement is recorded.
  readonly env: LayoutEnv;

  constructor(options: { path: string; now?: () => Date; env?: LayoutEnv }) {
    this.path = options.path;
    this.now = options.now ?? (() => new Date());
    this.env = options.env ?? process.env;
  }

  list(): ArchiveImportRecord[] {
    return readState(this.path).archives;
  }

  get(archiveId: string): ArchiveImportRecord | undefined {
    return this.list().find((record) => record.archive_id === archiveId);
  }

  create(input: NewArchiveImportRecord): ArchiveImportRecord {
    const at = this.now().toISOString();
    const { skipped, ...rest } = input;
    const record: ArchiveImportRecord = {
      archive_id: randomUUID(),
      ...rest,
      status: 'importing',
      created_at: at,
      updated_at: at,
      findings: { ...emptyArchiveFindings(), skipped: { ...(skipped ?? {}) } },
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
    repeated = 0,
    items?: ArchiveRepeatedItems,
  ): void {
    if (findings.length === 0 && !position && !items) return;
    this.update(archiveId, (record) => {
      // How far the import read, for its progress: only forward, and only while it imports.
      const read = record.read_position;
      const movesOn = position !== undefined && record.status === 'importing'
        && (!read || position.fileIndex > read.file_index
          || (position.fileIndex === read.file_index && position.offset > read.offset));
      const listed = record.findings.listed_through;
      const after = (at: { fileIndex: number; offset: number }): boolean => !listed || at.fileIndex > listed.file_index
        || (at.fileIndex === listed.file_index && at.offset > listed.offset);
      const freshRepeats = record.status === 'importing' && items ? items.repeatedAt.filter(after).length : 0;
      const itemsMoveOn = record.status === 'importing' && items?.through !== undefined && after(items.through);
      if (findings.length === 0 && !movesOn && freshRepeats === 0 && !itemsMoveOn) return false;
      if (movesOn) record.read_position = { file_index: position!.fileIndex, offset: position!.offset };
      const tally = record.findings;
      // Items whose positions are known: each repeat is counted once, when the import reads past
      // the last item it judged, however the pages of a replay are cut.
      if (freshRepeats > 0) {
        tally.skipped[ARCHIVE_COMMON_FINDINGS.itemRepeated] = (tally.skipped[ARCHIVE_COMMON_FINDINGS.itemRepeated] ?? 0) + freshRepeats;
      }
      if (itemsMoveOn) tally.listed_through = { file_index: items!.through!.fileIndex, offset: items!.through!.offset };
      // Items the stores already held from earlier in the archive. Counted only when the import
      // reads past where it had read: a page listed again after a restart finds its own items
      // stored, and they are not repeats.
      if (movesOn && repeated > 0) {
        tally.skipped[ARCHIVE_COMMON_FINDINGS.itemRepeated] = (tally.skipped[ARCHIVE_COMMON_FINDINGS.itemRepeated] ?? 0) + repeated;
      }
      // Positions counted by an earlier call. One call carries every finding
      // of the messages it covers, so several findings at one position count.
      const through = tally.through;
      const before = (fileIndex: number, offset: number): boolean => through !== undefined
        && (fileIndex < through.file_index || (fileIndex === through.file_index && offset <= through.offset));
      let last = through;
      const reach = (fileIndex: number, offset: number): void => {
        if (!last || fileIndex > last.file_index || (fileIndex === last.file_index && offset > last.offset)) {
          last = { file_index: fileIndex, offset };
        }
      };
      for (const finding of findings) {
        // A tally that tells where each of its occurrences is counts the ones past `through`, however it was cut.
        let counted = Math.max(1, finding.count ?? 1);
        let firstCounted = finding.offset;
        let lastCounted = finding.offset;
        if (finding.at) {
          counted = 0;
          for (const offset of finding.at) {
            if (before(finding.fileIndex, offset)) continue;
            if (counted === 0 || offset < firstCounted) firstCounted = offset;
            if (counted === 0 || offset > lastCounted) lastCounted = offset;
            counted += 1;
          }
        } else if (before(finding.fileIndex, finding.offset)) {
          continue;
        }
        if (counted === 0) continue;
        const bucket = finding.class === 'gap' ? tally.gaps : tally.skipped;
        bucket[finding.kind] = (bucket[finding.kind] ?? 0) + counted;
        if (finding.class === 'gap') {
          const byFile = (tally.gaps_by_file ??= {});
          const inFile = (byFile[String(finding.fileIndex)] ??= {});
          inFile[finding.kind] = (inFile[finding.kind] ?? 0) + counted;
        }
        if (finding.class === 'gap' && tally.samples.length < ARCHIVE_FINDING_SAMPLES_MAX) {
          tally.samples.push({ kind: finding.kind, file_index: finding.fileIndex, offset: firstCounted });
        }
        reach(finding.fileIndex, lastCounted);
      }
      if (last) tally.through = last;
    });
  }

  /**
   * Counts what an input read: one per record of a page, and how many of them
   * the source already held. `positions` are the records' places in the
   * archive, in the page's order and strictly increasing; a record at or
   * before the last position counted was counted on an earlier pass (the same
   * bytes listed again after a restart) and is not counted again. A page
   * whose positions are not told is not counted. The dates of the records
   * read widen the import's date range (it covers what the export holds, not
   * only what was new).
   */
  recordIntake(
    archiveId: string,
    outcomes: ReadonlyArray<{ alreadyThere: boolean; authoredAt?: string }>,
    positions: ReadonlyArray<{ fileIndex: number; offset: number }> | undefined,
  ): void {
    if (outcomes.length === 0) return;
    this.update(archiveId, (record) => {
      if (record.status !== 'importing') return false;
      let changed = false;
      for (const outcome of outcomes) {
        const at = outcome.authoredAt;
        if (typeof at !== 'string' || !Number.isFinite(Date.parse(at))) continue;
        const range = record.date_range;
        if (!range) {
          record.date_range = { earliest: at, latest: at };
          changed = true;
          continue;
        }
        if (at < range.earliest) { range.earliest = at; changed = true; }
        if (at > range.latest) { range.latest = at; changed = true; }
      }
      if (positions && positions.length === outcomes.length) {
        const intake = record.intake ?? { read: 0, already_there: 0 };
        const through = intake.through;
        const past = (at: { fileIndex: number; offset: number }): boolean => !through || at.fileIndex > through.file_index
          || (at.fileIndex === through.file_index && at.offset > through.offset);
        let read = 0;
        let already = 0;
        outcomes.forEach((outcome, index) => {
          if (!past(positions[index]!)) return;
          read += 1;
          if (outcome.alreadyThere) already += 1;
        });
        const last = positions[positions.length - 1]!;
        if (read > 0 || past(last)) {
          record.intake = {
            read: intake.read + read,
            already_there: intake.already_there + already,
            through: past(last) ? { file_index: last.fileIndex, offset: last.offset } : through!,
          };
          changed = true;
        }
      }
      if (!changed) return false;
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
    // This can be the account's first file, with no store opened yet.
    recordAccountPlacement({ sourceId: ARCHIVE_IMPORTS_SOURCE_ID }, this.path, this.env);
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    withFileLeaseSync(this.path, (lease) => {
      const state = readState(this.path);
      if (change(state) === false) return;
      lease.commit(() => writePrivateFileAtomicSync(this.path, `${JSON.stringify(state, null, 2)}\n`));
    });
  }
}
