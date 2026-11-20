import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, type Stats } from 'node:fs';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';

/**
 * The durable record of which paired-session sources the owner has unpaired,
 * and whether anything was left behind.
 *
 * Telegram and WhatsApp own no broker credential, so a chat card infers
 * connectedness from its own sync evidence — indexed items and their
 * timestamps. An Unpair changes none of that evidence, so the fact that the
 * pairing was removed has to be stored somewhere or the card starts claiming a
 * live session again. Held only in memory it survived exactly as long as the
 * worker process: one restart and the card re-rendered as connected over a
 * session that no longer existed.
 *
 * It lives beside the handle registry, in the same directory and under the same
 * grant-custody lease the Unpair itself holds, because it is part of the same
 * fact: this source has no usable local grant. It is deliberately NOT a field
 * inside `handles.json` — that writer emits only `version` and `handles`, and
 * teaching it to carry unrelated state would put dashboard bookkeeping inside
 * the one file that maps every handle to its secret refs.
 *
 * ONLY the grant-custody paths write it. Rendering the dashboard reads it and
 * nothing more: a render that rewrote the file could race an Unpair holding the
 * lease and overwrite the fact it had just committed.
 */
export interface UnpairedSourceRecord {
  source_id: string;
  /**
   * `unpair_in_progress` is the pessimistic record written before the teardown
   * starts, when every planned artifact is still there. `unpaired` and
   * `unpair_incomplete` are the outcomes written after it.
   *
   * `unpair_incomplete` means the teardown did not finish: artifacts still on
   * disk, or a stored reference that could not be removed. The owner is the
   * only one who can finish the job, and a silent "unpaired" over a live
   * session file is the exact false completion this state exists to prevent.
   *
   * An `unpair_in_progress` record is not trusted as an outcome. If the
   * narrowing write never happened — the process died between the deletes and
   * the final commit — the record still names files that are now gone, so it is
   * reconciled against the disk before it is believed.
   */
  state: 'unpaired' | 'unpair_in_progress' | 'unpair_incomplete';
  unremoved_paths?: string[];
  /**
   * A teardown step that failed after the session files were already gone, e.g.
   * `stored_reference`. Recorded so the incomplete state survives with a reason
   * rather than as an unexplained flag.
   */
  failed_steps?: string[];
}

/**
 * Reading this file has three outcomes, and collapsing them was a bug.
 *
 * A parse failure used to yield an empty list, which is the same value as "the
 * owner has never unpaired anything". After a restart that silently handed the
 * card back to its sync evidence, which is exactly the false "connected" the
 * record exists to prevent — the file failing open is worse than the file not
 * existing. `unreadable` is therefore its own outcome: it is rendered as a
 * degraded, unknown state and it blocks mutation until the owner fixes it.
 */
export type UnpairedSourcesRead =
  | { status: 'missing' }
  | { status: 'ok'; records: UnpairedSourceRecord[] }
  | { status: 'unreadable'; path: string; reason: string };

export function unpairedSourcesPath(registryPath: string): string {
  return `${registryPath}.unpaired`;
}

/**
 * What the record path IS, before anything opens it.
 *
 * One classification, shared by the read and the writability check, so the two
 * cannot disagree about the same file. They used to: the write side rejected
 * any non-regular node via lstat while the read side simply called
 * `readFileSync`, which follows a symlink and trusts whatever it lands on — and
 * blocks forever on a FIFO. A single damaged file at that path could stall the
 * worker's event loop on every dashboard poll, and inside connect before
 * custody was even taken.
 */
type RecordNode =
  | { kind: 'missing' }
  | { kind: 'unreadable'; reason: string }
  | { kind: 'file'; stat: Stats };

function inspectRecordNode(path: string): RecordNode {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    // ENOTDIR: a component above it is a file, so nothing can live there.
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'unreadable', reason: `${code}: ${(error as Error).message}` };
  }
  // lstat, so a symlink is seen as a symlink rather than as its target. Nothing
  // but a regular file is opened: a FIFO blocks, a socket is not a file, a
  // directory is not a record, and a symlink is an indirection this path has no
  // reason to follow — the record is written here, so it lives here.
  if (stat.isSymbolicLink()) return { kind: 'unreadable', reason: 'record path is a symbolic link' };
  if (!stat.isFile()) return { kind: 'unreadable', reason: 'record path is not a regular file' };
  return { kind: 'file', stat };
}

/**
 * Read the record's bytes without ever following or blocking on the path.
 *
 * The lstat above can be raced, so the descriptor is opened with O_NOFOLLOW and
 * O_NONBLOCK where the platform has them, then fstat'd: what was checked and
 * what was opened must be the same regular file, or the read is refused.
 */
function readRecordText(
  path: string,
): { kind: 'missing' } | { kind: 'unreadable'; reason: string } | { kind: 'ok'; text: string } {
  const node = inspectRecordNode(path);
  if (node.kind !== 'file') return node;
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
  let fd: number;
  try {
    fd = openSync(path, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    // ELOOP is O_NOFOLLOW refusing a symlink swapped in after the lstat;
    // ENXIO is O_NONBLOCK refusing a FIFO with no writer.
    return { kind: 'unreadable', reason: `${code}: ${(error as Error).message}` };
  }
  try {
    const opened = fstatSync(fd);
    // Identity, not just shape. `isFile()` alone would accept a DIFFERENT
    // regular file swapped in between the lstat and the open, which is exactly
    // the race the comment above claims to close; dev+ino is what makes the
    // descriptor provably the node that was inspected.
    if (!opened.isFile() || opened.dev !== node.stat.dev || opened.ino !== node.stat.ino) {
      return { kind: 'unreadable', reason: 'record path changed between inspection and opening' };
    }
    return { kind: 'ok', text: readFileSync(fd, 'utf8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return { kind: 'unreadable', reason: `${code}: ${(error as Error).message}` };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Nothing useful to do here: the read already has its answer.
    }
  }
}

/**
 * Refuse before anything is deleted if the record cannot be committed.
 *
 * The latch is written BEFORE the irreversible teardown so a later failure
 * still leaves an honest card. That ordering is worth nothing if the write
 * itself is going to fail, so the path is classified up front by the same
 * helper the read uses — read and write must agree about what is there.
 */
export function assertUnpairedRecordWritable(registryPath: string): void {
  const path = unpairedSourcesPath(registryPath);
  const node = inspectRecordNode(path);
  // Absent is fine: the write creates it.
  if (node.kind === 'missing' || node.kind === 'file') return;
  throw new Error(`Unpaired-source record path cannot be written (${node.reason}): ${path}`);
}

/**
 * Read the record, keeping "not there" and "could not read" apart.
 *
 * There is deliberately no `existsSync` probe: it answers false for a file it
 * merely could not look at, so an EACCES became `missing` — the same value as
 * "the owner has never unpaired anything" — and after a restart the card went
 * straight back to inferring a live session from its sync evidence. Only the
 * two error codes that genuinely mean "not there" are absence; everything else,
 * including a path that is not a plain file, is `unreadable`.
 */
export function readUnpairedSources(registryPath: string): UnpairedSourcesRead {
  const path = unpairedSourcesPath(registryPath);
  const read = readRecordText(path);
  if (read.kind === 'missing') return { status: 'missing' };
  if (read.kind === 'unreadable') return { status: 'unreadable', path, reason: read.reason };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.text);
  } catch (error) {
    return { status: 'unreadable', path, reason: (error as Error).message };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'unreadable', path, reason: 'record must be a JSON object' };
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) {
    return { status: 'unreadable', path, reason: `unsupported record version: ${String(record.version)}` };
  }
  if (!Array.isArray(record.sources)) {
    return { status: 'unreadable', path, reason: 'record.sources must be an array' };
  }
  const records = new Map<string, UnpairedSourceRecord>();
  for (const [index, entry] of record.sources.entries()) {
    const normalized = normalizeRecord(entry);
    // An entry this build cannot make sense of makes the WHOLE record
    // unreadable. Dropping it and reporting `ok` with the survivors was the
    // same failure open by another route: a typo'd or newer-format entry
    // vanished, and a source the owner had unpaired came back as connected.
    if (normalized === 'invalid') {
      return { status: 'unreadable', path, reason: `record.sources[${index}] is not a recognized entry` };
    }
    records.set(normalized.source_id, normalized);
  }
  return {
    status: 'ok',
    records: [...records.values()].sort((a, b) => a.source_id.localeCompare(b.source_id)),
  };
}

const UNPAIRED_RECORD_KEYS = new Set(['source_id', 'state', 'unremoved_paths', 'failed_steps']);
const UNPAIRED_RECORD_STATES = new Set(['unpaired', 'unpair_in_progress', 'unpair_incomplete']);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

function normalizeRecord(entry: unknown): UnpairedSourceRecord | 'invalid' {
  // A bare id is accepted so a record written before the richer states existed
  // still reads as the plain unpaired fact it meant.
  if (typeof entry === 'string') {
    return entry.trim() === '' ? 'invalid' : { source_id: entry.trim(), state: 'unpaired' };
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'invalid';
  const value = entry as Record<string, unknown>;
  // An unknown key is not a harmless extra: it is either a typo that dropped
  // the field this entry needed, or a newer format this build must not
  // half-understand. Either way the honest answer is that it cannot be read.
  for (const key of Object.keys(value)) if (!UNPAIRED_RECORD_KEYS.has(key)) return 'invalid';
  if (typeof value.source_id !== 'string' || value.source_id.trim() === '') return 'invalid';
  if (value.state !== undefined && (typeof value.state !== 'string' || !UNPAIRED_RECORD_STATES.has(value.state))) {
    return 'invalid';
  }
  if (value.unremoved_paths !== undefined && !isStringArray(value.unremoved_paths)) return 'invalid';
  if (value.failed_steps !== undefined && !isStringArray(value.failed_steps)) return 'invalid';
  const paths = (value.unremoved_paths ?? []) as string[];
  const steps = (value.failed_steps ?? []) as string[];
  return {
    source_id: value.source_id.trim(),
    state: (value.state ?? 'unpaired') as UnpairedSourceRecord['state'],
    ...(paths.length > 0 ? { unremoved_paths: [...new Set(paths)].sort() } : {}),
    ...(steps.length > 0 ? { failed_steps: [...new Set(steps)].sort() } : {}),
  };
}

/** Replace the record. An empty list still writes, so a clear is durable too. */
export function writeUnpairedSources(
  records: readonly UnpairedSourceRecord[],
  registryPath: string,
): void {
  const sources = [...records]
    .sort((a, b) => a.source_id.localeCompare(b.source_id))
    .map((record) => ({
      source_id: record.source_id,
      state: record.state,
      ...(record.unremoved_paths?.length ? { unremoved_paths: [...record.unremoved_paths].sort() } : {}),
      ...(record.failed_steps?.length ? { failed_steps: [...record.failed_steps].sort() } : {}),
    }));
  writePrivateFileAtomicSync(
    unpairedSourcesPath(registryPath),
    `${JSON.stringify({ version: 1, sources }, null, 2)}\n`,
  );
}

/**
 * One source's update, expressed as what is now owed plus what was discharged.
 *
 * The distinction is the whole point. A writer that simply replaced the entry
 * lost obligations it could not see: a second attempt, holding a snapshot taken
 * before another attempt recorded a custom path, wrote its own view over the
 * top and the newer obligation vanished. Nothing is ever dropped from the
 * record unless the caller states that it discharged that exact thing.
 */
export interface UnpairedSourceUpdate {
  source_id: string;
  state: UnpairedSourceRecord['state'];
  /** Obligations this attempt is adding or restating. Unioned with what is there. */
  unremoved_paths?: readonly string[];
  failed_steps?: readonly string[];
  /** Obligations this attempt PROVED are finished. The only way anything leaves. */
  discharged?: {
    paths?: readonly string[];
    steps?: readonly string[];
  };
}

/**
 * Merge these updates into the record. Call under the grant-custody lease.
 *
 * Read-modify-write on a file two processes can reach, so the read happens here
 * rather than being handed in: an obligation written between a caller's read
 * and its write must not be lost, and the only way to guarantee that is to
 * union against the contents as they are at the moment of writing.
 */
export function recordUnpairedSources(
  updates: readonly UnpairedSourceUpdate[],
  registryPath: string,
): UnpairedSourceRecord[] {
  const existing = readUnpairedSources(registryPath);
  if (existing.status === 'unreadable') {
    throw new UnpairedSourcesUnreadableError(existing.path, existing.reason);
  }
  const merged = new Map(
    (existing.status === 'ok' ? existing.records : []).map((record) => [record.source_id, record]),
  );
  for (const update of updates) {
    merged.set(update.source_id, mergeUnpairedSourceUpdate(merged.get(update.source_id), update));
  }
  const next = [...merged.values()];
  writeUnpairedSources(next, registryPath);
  return next;
}

function mergeUnpairedSourceUpdate(
  existing: UnpairedSourceRecord | undefined,
  update: UnpairedSourceUpdate,
): UnpairedSourceRecord {
  const dischargedPaths = new Set(update.discharged?.paths ?? []);
  const dischargedSteps = new Set(update.discharged?.steps ?? []);
  const paths = [...new Set([
    ...(existing?.unremoved_paths ?? []),
    ...(update.unremoved_paths ?? []),
  ])].filter((path) => !dischargedPaths.has(path)).sort();
  const steps = [...new Set([
    ...(existing?.failed_steps ?? []),
    ...(update.failed_steps ?? []),
  ])].filter((step) => !dischargedSteps.has(step)).sort();
  // The state follows the merged obligations, never the caller's belief about
  // them. Nothing owed is `unpaired`, because a state saying work remains over
  // an empty set would ask the owner to finish something already finished — and
  // something owed is never `unpaired`, because a run that thought it had
  // finished may be merging over an obligation another attempt recorded while
  // it was working.
  const outstanding = paths.length > 0 || steps.length > 0;
  const state = !outstanding
    ? 'unpaired' as const
    : update.state === 'unpaired' ? 'unpair_incomplete' as const : update.state;
  return {
    source_id: update.source_id,
    state,
    ...(paths.length > 0 ? { unremoved_paths: paths } : {}),
    ...(steps.length > 0 ? { failed_steps: steps } : {}),
  };
}

export class UnpairedSourcesUnreadableError extends Error {
  path: string;

  constructor(path: string, reason: string) {
    super(`Olympus unpaired-source record is unreadable (${reason}): ${path}`);
    this.path = path;
  }
}

/**
 * Drop one source from the record, because it has been paired again.
 *
 * Called from the connect path that registers the new pairing, under the same
 * grant-custody lease that writes the handle — never from a render. Refuses
 * while the record is unreadable, for the same reason the upsert does.
 */
export function clearUnpairedSource(sourceId: string, registryPath: string): void {
  const current = readUnpairedSources(registryPath);
  if (current.status === 'unreadable') {
    throw new UnpairedSourcesUnreadableError(current.path, current.reason);
  }
  if (current.status === 'missing') return;
  if (!current.records.some((record) => record.source_id === sourceId)) return;
  writeUnpairedSources(current.records.filter((record) => record.source_id !== sourceId), registryPath);
}

/**
 * Whether one outstanding artifact is really gone.
 *
 * `existsSync` answers false for a path it merely could not look at, and that
 * turned an EACCES into "already cleaned up": an incomplete record narrowed
 * itself to a clean unpaired while the session file was still sitting there.
 * Only ENOENT and ENOTDIR mean gone — ENOTDIR being the case where a component
 * above it is a file, so nothing can live below. Anything else is unknown, and
 * an unknown keeps the record incomplete.
 */
export type ArtifactPresence = 'gone' | 'present' | 'unknown';

export function artifactPresence(path: string): ArtifactPresence {
  try {
    lstatSync(path);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'unknown';
  }
}

/**
 * What a record means once the disk has been consulted.
 *
 * A pessimistic `unpair_in_progress` record, or an `unpair_incomplete` one
 * whose files have since been deleted by hand, still names paths that are gone.
 * Believing either verbatim would leave a card asking the owner to remove files
 * that are not there — the mirror image of the false completion the pessimistic
 * write exists to prevent. So the paths are checked, and a record with nothing
 * left outstanding reconciles to the plain unpaired fact.
 *
 * A recorded failed step is never reconciled away by looking at files: it did
 * not happen, and no amount of absent artifacts makes it have happened.
 *
 * Pure and read-only: rendering calls this and MUST NOT write the result back,
 * because a render holds no grant-custody lease. The reconciled value is
 * committed by the next Unpair or connect, which do hold it.
 */
export function reconcileUnpairedSource(
  record: UnpairedSourceRecord,
  presence: (path: string) => ArtifactPresence = artifactPresence,
): UnpairedSourceRecord {
  if (record.state === 'unpaired') return record;
  const outstanding = (record.unremoved_paths ?? []).filter((path) => presence(path) !== 'gone');
  const failedSteps = record.failed_steps ?? [];
  if (outstanding.length === 0 && failedSteps.length === 0) {
    return { source_id: record.source_id, state: 'unpaired' };
  }
  return {
    source_id: record.source_id,
    state: 'unpair_incomplete',
    ...(outstanding.length > 0 ? { unremoved_paths: outstanding.sort() } : {}),
    ...(failedSteps.length > 0 ? { failed_steps: [...failedSteps].sort() } : {}),
  };
}

/** Every record, reconciled against the filesystem. Read-only. */
export function readReconciledUnpairedSources(
  registryPath: string,
  presence: (path: string) => ArtifactPresence = artifactPresence,
): UnpairedSourcesRead {
  const read = readUnpairedSources(registryPath);
  if (read.status !== 'ok') return read;
  return {
    status: 'ok',
    records: read.records.map((record) => reconcileUnpairedSource(record, presence)),
  };
}

/** Refuse to mutate paired-session state while the record cannot be read. */
export function assertUnpairedSourcesReadable(registryPath: string): void {
  const read = readUnpairedSources(registryPath);
  if (read.status === 'unreadable') throw new UnpairedSourcesUnreadableError(read.path, read.reason);
}

/** The credential providers that back each paired-session source. */
const UNPAIRED_SOURCE_PROVIDERS: Record<string, string> = {
  'telegram.messages': 'telegram',
  'whatsapp.personal.messages': 'whatsapp_personal',
};

/**
 * Providers whose lane must not be built, because the owner unpaired them.
 *
 * A teardown that could not remove its registry handle leaves that handle
 * behind on purpose, recorded as an outstanding obligation. Building a lane off
 * it would undo the Unpair at the next boot — the one place that never consults
 * the record and only ever looked at the registry. An unreadable record fails
 * closed for the same reason it renders as a degraded card: not knowing whether
 * a source was unpaired is not permission to start reading it again.
 */
export function unpairedLaneProviders(registryPath: string): Set<string> {
  const read = readUnpairedSources(registryPath);
  if (read.status === 'missing') return new Set();
  if (read.status === 'unreadable') return new Set(Object.values(UNPAIRED_SOURCE_PROVIDERS));
  const providers = new Set<string>();
  for (const record of read.records) {
    const provider = UNPAIRED_SOURCE_PROVIDERS[record.source_id];
    if (provider) providers.add(provider);
  }
  return providers;
}

/**
 * Drop every handle whose lane the owner has unpaired.
 *
 * The one place this decision is made. Boot, the adoption tick and the
 * production refresh callback all pass through here, because a handle an Unpair
 * could not remove is still in the registry and any path that reads the
 * registry alone will happily rebuild its lane.
 */
export function withoutUnpairedLaneHandles<T extends { provider: string }>(
  handles: readonly T[],
  registryPath: string,
): T[] {
  const unpaired = unpairedLaneProviders(registryPath);
  if (unpaired.size === 0) return [...handles];
  return handles.filter((handle) => !unpaired.has(handle.provider));
}
