// Contract 1 adapter for the append-only Telegram capture spool. The Telethon
// helper owns provider/session semantics and writes validated-scope records;
// this connector owns only durable local listing, normalization and trust.

import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { TELEGRAM_SOURCE_ID } from '../../core/olympus-layout.ts';
import { resolvedRawPath } from '../../core/source-placement.ts';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorInput,
  SourceConnectorListOptions,
  SourceConversationKind,
  SourceRecordPage,
  StoredItemLookup,
} from '../../core/contracts.ts';
import { inputConnector } from '../../core/source-inputs.ts';
import {
  buildSourceSensitivity,
  type SourceItemIdentity,
  type SourceSensitivity,
} from '../../core/source-index/types.ts';
import {
  redactCaptureSpoolLines,
  type CaptureSpoolRedactionResult,
  type SpoolSecretJudge,
} from '../connector-store/capture-spool-secrets.ts';
import {
  INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID,
  PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID,
  type TelegramMessagesCorpusId,
  type TelegramMessagesCorpusTrustDomain,
} from './corpus-adapter.ts';
import { rememberSpoolOffset, spoolFileLines, spoolLineOffset } from './spool-lines.ts';
import { telegramServiceContent } from '../archive-import/telegram/message.ts';
import { telegramCaptureVersion, telegramRecordBuilder, type TelegramRecordItems } from './record-builder.ts';

// Product capture and migration replay are independent writers with
// independent cursors. Reusing the historical `telegram_spool_replay_*`
// owner ids lets a replay run advance the product scheduler past unread live
// capture (or vice versa), so the product lane has its own stable lineage.
export const TELEGRAM_CAPTURE_CONNECTOR_ID = 'telegram_capture_spool';
export const TELEGRAM_CAPTURE_CONNECTOR_IDS = {
  internal: `${TELEGRAM_CAPTURE_CONNECTOR_ID}_internal`,
  secure_local: `${TELEGRAM_CAPTURE_CONNECTOR_ID}_secure_local`,
} as const;
// Removing the internal lane's copy of a reclassified message is a local write,
// not a traversal. It gets its own run lineage because a completed run under
// the lane's own id carries no cursor, and the lane would resume from that
// emptiness — a full spool rescan — on its very next pull.
export const TELEGRAM_TRUST_EVICTION_CONNECTOR_ID = `${TELEGRAM_CAPTURE_CONNECTOR_ID}_trust_eviction`;
// The one-time sweep over duplication that predates the trust invariant keeps
// its resume cursor in the internal store's run history. It cannot share the
// eviction lineage: eviction runs carry no cursor, so one inline eviction
// would erase the sweep's durable position.
export const TELEGRAM_TRUST_RECONCILIATION_CONNECTOR_ID = `${TELEGRAM_CAPTURE_CONNECTOR_ID}_trust_reconciliation`;

// A record whose item was judged Secrets keeps its place in the spool but not
// its text (connector-store/capture-spool-secrets.ts). The flag it carries is
// read back as a Secrets floor, so a replay judges it Secrets again.
export const TELEGRAM_SECRET_REDACTED_FLOOR_BASIS = 'capture:secret_redacted';

// One read of the spool is bounded in what it consumes, not in how large the
// spool may grow: past either bound it stops and hands back where it stopped.
const MAX_READ_BYTES = 64 * 1024 * 1024;
const MAX_LINES_PER_READ = 200_000;
// A record longer than this is never held: it is counted as damaged and passed.
// Python writes JSON with `ensure_ascii`, so 4M characters of text can take
// up to 24 MB on disk.
const MAX_RECORD_BYTES = 32 * 1024 * 1024;
// How far back from a file's end the freshness check looks for its newest record.
const MAX_TAIL_SCAN_BYTES = 16 * 1024 * 1024;
const MAX_TEXT_CHARS = 4_000_000;
const DEFAULT_PAGE_LIMIT = 500;
const MAX_PAGE_LIMIT = 10_000;

export interface TelegramCaptureSpoolRecord {
  captureId: string;
  capturedAt: string;
  /** The helper's capture sequence, which only grows; absent on records written before it existed. */
  captureSeq?: number;
  capturedItem: {
    item: RawItem;
    trustDomain: TelegramMessagesCorpusTrustDomain;
  };
}

export interface TelegramCaptureSpoolReadResult {
  records: TelegramCaptureSpoolRecord[];
  malformedRecords: number;
  /**
   * localItemId -> the one trust domain this read resolved the item to, for
   * items whose spool records disagreed. Only conflicted items appear here.
   */
  trustConflicts: ReadonlyMap<string, TelegramMessagesCorpusTrustDomain>;
  resumeCursor?: string;
  exhausted: boolean;
  /** The cursor given no longer named a place in this spool, so the read started from the beginning. */
  cursorReset?: true;
}

export function defaultTelegramCaptureSpoolDir(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolvedRawPath(TELEGRAM_SOURCE_ID, 'telegram-spool', env);
}

export function createTelegramCaptureSpoolConnector(options: {
  spoolDir: string;
  trustDomain: TelegramMessagesCorpusTrustDomain;
  /**
   * Trust resolutions computed over a wider window than one page of this lane
   * can see — the pull preflight reads the whole unread spool window. Applying
   * them here is what keeps a message whose classification changed in exactly
   * one lane even when only its looser copy falls inside this lane's page.
   */
  resolvedTrustByItemId?: ReadonlyMap<string, TelegramMessagesCorpusTrustDomain>;
  /**
   * The last spool position those resolutions were computed over. The spool is
   * appended to while a pull runs, so without this bound a lane would index a
   * record that no resolution ever saw. `null` bounds the lane to nothing.
   */
  admitThroughCursor?: string | null;
  /**
   * What the source's stores hold of an item (`TieredStoreSet.storedItem`):
   * with it, a record older than what is stored is not applied, whichever
   * input stored it (core/source-inputs.ts). Without it, every record applies.
   */
  storedItem?: StoredItemLookup;
  /**
   * Records listed ahead of the spool, as this lane's: the newest version of
   * an item moving into this lane whole (`readTelegramCaptureSpoolNewest`).
   */
  carried?: readonly TelegramCaptureSpoolRecord[];
}): SourceConnector {
  const spoolDir = requiredString(options.spoolDir, 'spool directory');
  const trustDomain = options.trustDomain;
  const resolved = options.resolvedTrustByItemId
    ? { resolvedTrustByItemId: options.resolvedTrustByItemId }
    : {};
  const bound = options.admitThroughCursor === undefined
    ? {}
    : { admitThroughCursor: options.admitThroughCursor };
  const builder = telegramRecordBuilder({
    trustDomain,
    authenticate: async () => { assertTelegramCaptureSpoolDirectory(spoolDir); },
    async fetchItem(localItemId: string): Promise<RawItem> {
      // The newest record of the item wins, so the whole spool is read, a
      // bounded read at a time.
      let found: RawItem | undefined;
      let cursor: string | undefined;
      for (;;) {
        const result = readTelegramCaptureSpool({
          spoolDir,
          trustDomain,
          malformedPolicy: 'skip',
          ...(cursor ? { cursor } : {}),
          ...resolved,
          ...bound,
        });
        for (const record of result.records) {
          if (record.capturedItem.item.identity.localItemId === localItemId) {
            found = record.capturedItem.item;
          }
        }
        if (result.exhausted || !result.resumeCursor || result.resumeCursor === cursor) break;
        cursor = result.resumeCursor;
      }
      if (!found) throw new Error('Telegram capture spool cannot fetch an unknown item.');
      return found;
    },
  });
  // The spool is the connector's live input: its records in their own shape,
  // turned into items by the connector's one builder, as an export's are.
  const input: SourceConnectorInput<TelegramRecordItems> = {
    inputId: TELEGRAM_CAPTURE_CONNECTOR_IDS[trustDomain],
    kind: 'live',
    // The spool is a durable backlog, not a live tail: a migration replay or a
    // reconnected gateway can leave hundreds of thousands of unread records.
    // Yielding a single page per run capped every sync at one page — a 200k
    // backlog then needed weeks of scheduler intervals, and a max-items budget
    // larger than one page silently delivered one page. Keep paging until the
    // spool is exhausted or the run's budget is spent.
    records(listOptions = {}): AsyncIterable<SourceRecordPage<TelegramRecordItems>> {
      const budget = normalizeBudget(listOptions.limit);
      const carried = options.carried ?? [];
      return (async function* (): AsyncGenerator<SourceRecordPage<TelegramRecordItems>> {
        let cursor = listOptions.cursor;
        let remaining = budget;
        if (carried.length > 0) {
          // Ahead of the spool, and at the lane's own resume point: nothing of the spool is passed by it.
          yield { records: carried.map((record) => ({ record })), ...(cursor ? { nextCursor: cursor } : {}), done: false };
        }
        for (;;) {
          // Every page reads on from its cursor (the byte offset of a cursor
          // already met is remembered, so a page does not re-scan the file
          // before it). The page limit bounds one read's records and the read
          // itself is bounded in bytes; a run with a budget spends it in whole
          // pages so the spine never has to abandon one mid-page.
          const result = readTelegramCaptureSpool({
            spoolDir,
            trustDomain,
            limit: remaining === undefined ? DEFAULT_PAGE_LIMIT : Math.min(remaining, MAX_PAGE_LIMIT),
            malformedPolicy: 'skip',
            ...(cursor ? { cursor } : {}),
            ...resolved,
            ...bound,
          });
          if (remaining !== undefined) remaining -= result.records.length;
          const records = result.records.map((record) => ({ record }));
          const next = result.resumeCursor ? { nextCursor: result.resumeCursor } : {};
          yield result.exhausted ? { records, ...next, done: true } : { records, ...next, done: false };
          if (result.exhausted) return;
          if (remaining !== undefined && remaining <= 0) return;
          // A page that stopped short of the spool always carries the resume
          // point that produced it. Refusing to loop without a NEW one keeps a
          // future reader from spinning on the same window forever.
          if (!result.resumeCursor || result.resumeCursor === cursor) return;
          cursor = result.resumeCursor;
        }
      })();
    },
  };
  const connector = inputConnector(builder, input);
  if (!options.storedItem) return connector;
  const lookup = options.storedItem;
  const withLookup = Object.create(connector) as SourceConnector;
  withLookup.listItems = (listOptions: SourceConnectorListOptions = {}) => connector.listItems({ storedItem: lookup, ...listOptions });
  return withLookup;
}

export function readTelegramCaptureSpool(options: {
  spoolDir: string;
  cursor?: string;
  trustDomain?: TelegramMessagesCorpusTrustDomain;
  limit?: number;
  /** Product capture advances past damaged records; migration remains strict. */
  malformedPolicy?: 'reject' | 'skip';
  /** Trust resolutions observed over a wider window than this read's own. */
  resolvedTrustByItemId?: ReadonlyMap<string, TelegramMessagesCorpusTrustDomain>;
  /**
   * Highest spool position this read may admit, as a `<file>:<lines>` cursor.
   * Records past it are left for a later read; `null` admits none at all.
   * Unset reads the spool to its tail, which is what an unresolved caller —
   * a preflight, a migration replay — wants.
   */
  admitThroughCursor?: string | null;
  /** Bytes of records one read consumes before it hands back a resume point (default: 64 MB). */
  maxReadBytes?: number;
  /** A record longer than this is passed over as damaged without being held (default: 32 MB). */
  maxRecordBytes?: number;
}): TelegramCaptureSpoolReadResult {
  assertTelegramCaptureSpoolDirectory(options.spoolDir);
  const names = telegramCaptureSpoolFiles(options.spoolDir);
  // A cursor that no longer names a place in this spool (its file went while
  // older ones stayed, or the file holds fewer lines than it says) is read
  // from the start: re-reading is idempotent, skipping could lose history.
  let cursor = parseTelegramCaptureSpoolCursor(options.cursor);
  let cursorReset = false;
  if (cursor && telegramCaptureSpoolCursorState(options.spoolDir, options.cursor!, names) === 'reset') {
    cursor = undefined;
    cursorReset = true;
  }
  // An empty resolved window and a resolved window ending mid-file are the same
  // rule: `''` sorts before every dated spool name, so nothing is admissible.
  const admitThrough = options.admitThroughCursor === null
    ? { file: '', line: 0 }
    : parseTelegramCaptureSpoolCursor(options.admitThroughCursor);
  const limit = options.limit === undefined ? undefined : normalizeLimit(options.limit);
  const maxReadBytes = Math.max(1, options.maxReadBytes ?? MAX_READ_BYTES);

  const records: TelegramCaptureSpoolRecord[] = [];
  const trustByIdentity = new Map<string, TelegramMessagesCorpusTrustDomain>();
  const trustConflicts = new Map<string, TelegramMessagesCorpusTrustDomain>();
  let linesRead = 0;
  let malformedRecords = 0;
  let bytesRead = 0;
  let resumeCursor = cursorReset ? undefined : options.cursor;
  let exhausted = true;
  outer: for (const [fileIndex, name] of names.entries()) {
    if (cursor && name < cursor.file) continue;
    // Spool names sort by date, so a file past the admissible bound ends the
    // read: it is neither opened nor read.
    if (admitThrough && name > admitThrough.file) break;
    const path = join(options.spoolDir, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error('Telegram capture spool refuses non-regular JSONL files.');
    }
    const fd = openSync(path, 'r');
    try {
      const startLine = cursor?.file === name ? cursor.line : 0;
      const startOffset = spoolLineOffset(fd, path, stat, startLine);
      if (startOffset === undefined) throw new Error('Telegram capture spool cursor is beyond the durable spool tail.');
      // The bound stops the read inside the file that holds it. `resumeCursor` is
      // only ever assigned for a line this read consumed, so the position handed
      // back is the bound rather than the file's growing tail.
      const admitLine = admitThrough && name === admitThrough.file ? admitThrough.line : Number.POSITIVE_INFINITY;
      const isLastFile = fileIndex === names.length - 1;
      let lineIndex = startLine;
      const bytesBefore = bytesRead;
      for (const line of spoolFileLines(fd, startOffset, stat.size, Math.max(1, options.maxRecordBytes ?? MAX_RECORD_BYTES))) {
        if (lineIndex >= admitLine) break;
        lineIndex += 1;
        linesRead += 1;
        bytesRead = bytesBefore + (line.end - startOffset);
        resumeCursor = `${name}:${lineIndex}`;
        rememberSpoolOffset(path, stat, lineIndex, line.end);
        const atEnd = isLastFile && line.end >= stat.size;
        // One read is bounded in the bytes and lines it consumes, whatever this
        // lane keeps of them: past either bound it hands back where it stopped,
        // so a backlog of any size is read in passes instead of failing.
        const spent = bytesRead >= maxReadBytes || linesRead >= MAX_LINES_PER_READ;
        const stop = (): boolean => {
          if (!spent) return false;
          exhausted = atEnd;
          return true;
        };
        if (line.text === undefined || !line.text.trim()) {
          if (line.text === undefined) {
            if (options.malformedPolicy !== 'skip') throw new Error('Telegram capture spool found a malformed record.');
            malformedRecords += 1;
          }
          if (stop()) break outer;
          continue;
        }
        let record: TelegramCaptureSpoolRecord;
        try {
          record = markCapture(parseTelegramCaptureSpoolRecord(line.text), name, lineIndex);
        } catch {
          if (options.malformedPolicy !== 'skip') {
            throw new Error('Telegram capture spool found a malformed record.');
          }
          // A damaged append-only record cannot be repaired in place and must
          // not wedge every later message forever. Advance past it, count it in
          // the product receipt, and expose none of its contents or parse error.
          malformedRecords += 1;
          if (stop()) break outer;
          continue;
        }
        const identityKey = record.capturedItem.item.identity.localItemId;
        const observedTrust = record.capturedItem.trustDomain;
        const priorTrust = trustByIdentity.get(identityKey);
        // A conversation reclassified between live capture and backfill writes
        // the same message into the append-only spool under both trust domains.
        // Refusing the window was fail-STOP: every later preflight re-read the
        // same disagreement, neither lane ever wrote again, and the spool cannot
        // be edited to repair it. Resolve it fail-safe instead — the more
        // restrictive domain wins, so a message can only ever move INTO the
        // stricter lane, never out of it — and count it so the disagreement
        // stays visible in the pull receipt.
        const resolvedTrust = mostRestrictiveTrust(
          observedTrust,
          priorTrust,
          options.resolvedTrustByItemId?.get(identityKey),
        );
        if (resolvedTrust !== observedTrust || (priorTrust !== undefined && priorTrust !== observedTrust)) {
          trustConflicts.set(identityKey, resolvedTrust);
        }
        if (priorTrust !== undefined && priorTrust !== resolvedTrust) {
          // Copies already collected under the looser domain belong to no lane.
          for (let index = records.length - 1; index >= 0; index -= 1) {
            if (records[index]!.capturedItem.item.identity.localItemId === identityKey) {
              records.splice(index, 1);
            }
          }
        }
        trustByIdentity.set(identityKey, resolvedTrust);
        if (resolvedTrust === observedTrust && (options.trustDomain === undefined || resolvedTrust === options.trustDomain)) {
          records.push(record);
          if (limit !== undefined && records.length >= limit) {
            exhausted = atEnd;
            break outer;
          }
        }
        if (stop()) break outer;
      }
    } finally {
      closeSync(fd);
    }
  }
  return {
    records,
    malformedRecords,
    trustConflicts,
    ...(resumeCursor ? { resumeCursor } : {}),
    exhausted,
    ...(cursorReset ? { cursorReset: true } : {}),
  };
}

/**
 * The byte offset a `<file>:<lines>` cursor stands at in its file, or
 * undefined when the file is gone or holds fewer lines.
 */
export function telegramCaptureCursorOffset(spoolDir: string, cursorText: string): number | undefined {
  const cursor = parseTelegramCaptureSpoolCursor(cursorText)!;
  const path = join(spoolDir, cursor.file);
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
    const fd = openSync(path, 'r');
    try {
      return spoolLineOffset(fd, path, stat, cursor.line);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * Whether a `<file>:<lines>` cursor still names a place in this spool. `reset`
 * when its file is gone while older files remain (the spool was replaced or
 * pruned under it) or when the file holds fewer complete lines than the cursor
 * says; a cursor past every file (the spool was emptied) is still a place.
 * A cursor that does not parse throws, as it always has.
 */
export function telegramCaptureSpoolCursorState(
  spoolDir: string,
  cursorText: string,
  names: readonly string[] = telegramCaptureSpoolFiles(spoolDir),
): 'ok' | 'reset' {
  const cursor = parseTelegramCaptureSpoolCursor(cursorText)!;
  if (!names.includes(cursor.file)) {
    return names.some((name) => name < cursor.file) ? 'reset' : 'ok';
  }
  if (cursor.line === 0) return 'ok';
  const path = join(spoolDir, cursor.file);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return 'ok';
  const fd = openSync(path, 'r');
  try {
    return spoolLineOffset(fd, path, stat, cursor.line) === undefined ? 'reset' : 'ok';
  } finally {
    closeSync(fd);
  }
}

/**
 * When the newest record the importer would accept was captured, or undefined
 * when no such record exists. The helper only appends and names files by
 * date, so the last complete record of the newest file that has one is the
 * newest capture. A record counts only if the connector's own validation
 * accepts it (schema, declared conversation, classification, capture
 * identity): the pull skips anything else as malformed, so a damaged record
 * with a current timestamp must not make a feed that imports nothing read
 * fresh. Never throws: a missing, unreadable or empty spool simply has no
 * time, which the freshness verdict reads as "unavailable".
 */
export function readTelegramCaptureSpoolNewestCapturedAt(spoolDir: string): string | undefined {
  let names: string[];
  try {
    assertTelegramCaptureSpoolDirectory(spoolDir);
    names = telegramCaptureSpoolFiles(spoolDir);
  } catch {
    return undefined;
  }
  for (const name of names.reverse()) {
    let lines: string[];
    try {
      lines = spoolTailLines(join(spoolDir, name));
    } catch {
      continue;
    }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]!;
      if (!line.trim()) continue;
      try {
        return parseTelegramCaptureSpoolRecord(line).capturedAt;
      } catch {
        // Skipped exactly as the product pull skips it.
      }
    }
  }
  return undefined;
}

/** The heartbeat the capture helper writes beside its spool after every finished cycle. */
export const TELEGRAM_CAPTURE_HEARTBEAT_FILE = '.capture-heartbeat.json';
const MAX_HEARTBEAT_BYTES = 4_096;

/**
 * When the capture helper last finished a cycle (it read every approved chat,
 * whether or not anyone wrote), or undefined when there is no heartbeat that
 * reads. Never throws: an older helper writes none, and the verdict then rests
 * on the newest record alone.
 */
export function readTelegramCaptureHeartbeat(spoolDir: string): string | undefined {
  try {
    const path = join(spoolDir, TELEGRAM_CAPTURE_HEARTBEAT_FILE);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_HEARTBEAT_BYTES) return undefined;
    const buffer = Buffer.alloc(stat.size);
    const fd = openSync(path, 'r');
    try {
      readSync(fd, buffer, 0, buffer.length, 0);
    } finally {
      closeSync(fd);
    }
    const value = JSON.parse(buffer.toString('utf8')) as unknown;
    if (!isRecordValue(value) || value.kind !== 'telegram_capture_heartbeat' || value.schema_version !== 1) return undefined;
    const at = value.cycle_completed_at;
    return typeof at === 'string' && Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The complete lines at the end of a spool file, read back from its end and
 * never more than the tail bound: the newest records without the whole file.
 * A final fragment without its newline is a write in progress and is left out,
 * as is the first piece when the bound cut into a longer line.
 */
function spoolTailLines(path: string): string[] {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) return [];
  const start = Math.max(0, stat.size - MAX_TAIL_SCAN_BYTES);
  const buffer = Buffer.alloc(stat.size - start);
  const fd = openSync(path, 'r');
  try {
    let read = 0;
    while (read < buffer.length) {
      const got = readSync(fd, buffer, read, buffer.length - read, start + read);
      if (got <= 0) break;
      read += got;
    }
    const payload = buffer.subarray(0, read);
    const complete = payload.subarray(0, payload.lastIndexOf(0x0a) + 1).toString('utf8');
    const lines = complete.split('\n');
    lines.pop();
    if (start > 0) lines.shift();
    return lines;
  } finally {
    closeSync(fd);
  }
}

/**
 * Rewrite, in place, every complete record in `[from, through)` whose item
 * the judge says is Secrets: its text and attachment names go (and its chat
 * title and sender name when the names themselves were judged Secrets, also
 * from a record whose text went earlier), its
 * identity, version and capture id stay, and it is flagged so a replay
 * judges it Secrets again. Cursors are this spool's `<file>:<lines>`.
 */
export function redactTelegramCaptureSpoolSecrets(options: {
  spoolDir: string;
  from?: string;
  through?: string;
  judge: SpoolSecretJudge;
}): CaptureSpoolRedactionResult {
  assertTelegramCaptureSpoolDirectory(options.spoolDir);
  const from = parseTelegramCaptureSpoolCursor(options.from);
  const through = parseTelegramCaptureSpoolCursor(options.through);
  return redactCaptureSpoolLines({
    dir: options.spoolDir,
    files: telegramCaptureSpoolFiles(options.spoolDir),
    ...(from ? { from } : {}),
    ...(through ? { through } : {}),
    redact: (line) => redactTelegramSpoolLine(line, options.judge),
  });
}

function redactTelegramSpoolLine(line: string, judge: SpoolSecretJudge): string | undefined {
  let record: TelegramCaptureSpoolRecord;
  let raw: Record<string, unknown>;
  try {
    record = parseTelegramCaptureSpoolRecord(line);
    raw = requireObject(JSON.parse(line), 'record');
  } catch {
    // A damaged record is left exactly as it is; every reader skips it.
    return undefined;
  }
  const message = requireObject(raw.message, 'message');
  const item = record.capturedItem.item;
  const alreadyRedacted = message.secretRedacted === true;
  const text = alreadyRedacted || typeof item.metadata['searchText'] !== 'string'
    ? undefined
    : item.metadata['searchText'] as string;
  const redaction = judge(item.identity, text);
  if (!redaction) return undefined;
  // A record already cleared of its text is rewritten again only when its
  // names are now judged Secrets and still there.
  if (alreadyRedacted && (redaction !== 'names' || (
    message.chatTitle === undefined && message.senderDisplayName === undefined
    && message.forwardFromName === undefined && message.participantDisplayNames === undefined
  ))) {
    return undefined;
  }
  const namesLeft = message.chatTitle !== undefined || message.senderDisplayName !== undefined
    || message.forwardFromName !== undefined || message.participantDisplayNames !== undefined;
  const serviceWords = isRecordValue(message.service) && Object.keys(message.service).some((key) => key !== 'action');
  const namedAttachment = Array.isArray(message.attachments) && message.attachments.some((attachment) => (
    !!attachment && typeof attachment === 'object' && !Array.isArray(attachment) && 'name' in attachment
  ));
  // A record with nothing left to remove is not rewritten: the flag alone
  // would not fit, and blanking it would lose the record for nothing.
  if (
    message.boundedText === undefined && message.attachmentNames === undefined && !namedAttachment && !serviceWords
    && (redaction !== 'names' || !namesLeft)
  ) return undefined;
  const kept: Record<string, unknown> = { ...message };
  delete kept.boundedText;
  delete kept.attachmentNames;
  if (Array.isArray(kept.attachments)) {
    kept.attachments = kept.attachments.map((attachment) => {
      if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) return attachment;
      const { name: _name, ...rest } = attachment as Record<string, unknown>;
      return rest;
    });
  }
  // A service event keeps what happened, not the words it carried (a title, an amount).
  if (isRecordValue(kept.service)) kept.service = { action: kept.service.action };
  if (redaction === 'names') {
    delete kept.chatTitle;
    delete kept.senderDisplayName;
    delete kept.forwardFromName;
    delete kept.participantDisplayNames;
  }
  kept.secretRedacted = true;
  return JSON.stringify({ ...raw, message: kept });
}

function telegramCaptureSpoolFiles(spoolDir: string): string[] {
  return readdirSync(spoolDir)
    .filter((value) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(value))
    .sort();
}

/**
 * The safe reading of a disagreement: content may only be pulled toward the
 * stricter lane. `secure_local` therefore wins over `internal` no matter which
 * record was written first.
 */
function mostRestrictiveTrust(
  observed: TelegramMessagesCorpusTrustDomain,
  ...others: readonly (TelegramMessagesCorpusTrustDomain | undefined)[]
): TelegramMessagesCorpusTrustDomain {
  return observed === 'secure_local' || others.includes('secure_local') ? 'secure_local' : 'internal';
}

function assertTelegramCaptureSpoolDirectory(spoolDir: string): void {
  if (!existsSync(spoolDir)) throw new Error('Telegram capture spool directory does not exist.');
  const dir = lstatSync(spoolDir);
  if (!dir.isDirectory() || dir.isSymbolicLink()) {
    throw new Error('Telegram capture spool requires a real directory.');
  }
}

function parseTelegramCaptureSpoolCursor(value: string | undefined): { file: string; line: number } | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{4}-\d{2}-\d{2}\.jsonl):([0-9]+)$/.exec(value);
  const line = match ? Number(match[2]) : Number.NaN;
  if (!match || !Number.isSafeInteger(line)) {
    throw new Error('Telegram capture spool cursor must look like <YYYY-MM-DD.jsonl>:<line-count>.');
  }
  return { file: match[1]!, line };
}

function parseTelegramCaptureSpoolRecord(line: string, asTrust?: TelegramMessagesCorpusTrustDomain): TelegramCaptureSpoolRecord {
  let value: unknown;
  try { value = JSON.parse(line); } catch { throw new Error('Telegram capture spool found invalid JSON.'); }
  const record = requireObject(value, 'record');
  if (record.schema_version !== 1 || record.provider !== 'telegram') {
    throw new Error('Telegram capture spool found an unsupported record.');
  }
  const account = requiredString(record.account, 'account');
  const conversationId = requiredString(record.conversation_id, 'conversation id');
  const chatScope = requiredString(record.chat_scope, 'chat scope');
  if (chatScope !== `${account}:chat:${conversationId}`) {
    throw new Error('Telegram capture spool found a record outside its declared conversation.');
  }
  const trustDomain = telegramTrust(record.trust_domain);
  const corpusId = telegramCorpus(record.corpus_id);
  assertTrustCorpus(trustDomain, corpusId);
  const classification = requireObject(record.classification, 'classification');
  if (classification.trust_domain !== trustDomain || !requiredString(classification.reason, 'classification reason')) {
    throw new Error('Telegram capture spool found inconsistent classification inputs.');
  }
  if (record.sync_direction !== 'forward' && record.sync_direction !== 'backfill') {
    throw new Error('Telegram capture spool found an invalid sync direction.');
  }
  const message = requireObject(record.message, 'message');
  const messageId = requiredString(message.id, 'message id');
  if (requiredString(message.conversationId ?? message.chatId, 'message conversation') !== conversationId) {
    throw new Error('Telegram capture spool found a message outside its declared conversation.');
  }
  const capturedAt = timestamp(record.captured_at, 'capture timestamp');
  const sourceVersion = optionalString(message.sourceVersion);
  const captureId = requiredSha256(record.capture_id, 'capture id');
  const expected = sha256([account, conversationId, messageId, sourceVersion ?? ''].join('\x1f'));
  if (captureId !== expected) throw new Error('Telegram capture spool found a capture identity mismatch.');
  const captureSeq = record.capture_seq;
  if (captureSeq !== undefined && (typeof captureSeq !== 'number' || !Number.isSafeInteger(captureSeq) || captureSeq < 0)) {
    throw new Error('Telegram capture spool found an invalid capture sequence.');
  }
  return {
    captureId,
    capturedAt,
    ...(captureSeq !== undefined ? { captureSeq } : {}),
    capturedItem: telegramMessageItem({
      account,
      conversationId,
      // A record carried into the stricter lane is built as that lane's.
      trustDomain: asTrust ?? trustDomain,
      corpusId: asTrust === 'secure_local' ? PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID : asTrust === 'internal' ? INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID : corpusId,
      message,
      fetchedAt: capturedAt,
    }),
  };
}

/** The record with its capture order in its version (`telegramCaptureVersion`): `line` counts from 1. */
function markCapture(record: TelegramCaptureSpoolRecord, file: string, line: number): TelegramCaptureSpoolRecord {
  const item = record.capturedItem.item;
  const version = item.identity.sourceVersion;
  if (version === undefined) return record;
  const order = { capturedAt: record.capturedAt, seq: record.captureSeq ?? 0, file, line };
  return {
    ...record,
    capturedItem: {
      ...record.capturedItem,
      item: { ...item, identity: { ...item.identity, sourceVersion: telegramCaptureVersion(version, order) } },
    },
  };
}

/**
 * The newest record the spool holds of each item named, whatever lane its
 * chat was in when it was captured, built as `asTrust`'s: what moves an item
 * whole into the stricter lane when that lane's claim on it arrives in a
 * record older than the copy the looser lane holds. The whole spool is read,
 * a line at a time; damaged lines are passed.
 */
export function readTelegramCaptureSpoolNewest(options: {
  spoolDir: string;
  localItemIds: ReadonlySet<string>;
  compareVersions: (a: string, b: string) => number;
  asTrust: TelegramMessagesCorpusTrustDomain;
}): Map<string, TelegramCaptureSpoolRecord> {
  const newest = new Map<string, TelegramCaptureSpoolRecord>();
  if (options.localItemIds.size === 0) return newest;
  assertTelegramCaptureSpoolDirectory(options.spoolDir);
  for (const name of telegramCaptureSpoolFiles(options.spoolDir)) {
    const path = join(options.spoolDir, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const fd = openSync(path, 'r');
    try {
      let lineNumber = 0;
      for (const line of spoolFileLines(fd, 0, stat.size, MAX_RECORD_BYTES)) {
        lineNumber += 1;
        if (line.text === undefined || !line.text.trim()) continue;
        let record: TelegramCaptureSpoolRecord;
        try {
          record = markCapture(parseTelegramCaptureSpoolRecord(line.text, options.asTrust), name, lineNumber);
        } catch {
          continue;
        }
        const identity = record.capturedItem.item.identity;
        if (!options.localItemIds.has(identity.localItemId)) continue;
        const held = newest.get(identity.localItemId)?.capturedItem.item.identity.sourceVersion;
        // A later line of the same version is the later capture (its reactions, say): it wins.
        if (held === undefined || identity.sourceVersion === undefined || options.compareVersions(identity.sourceVersion, held) >= 0) {
          newest.set(identity.localItemId, record);
        }
      }
    } finally {
      closeSync(fd);
    }
  }
  return newest;
}

/**
 * The Telegram connector's one way from a message record (the spool's
 * `message` object, which every input of the connector writes) to its item.
 *
 * The item's text is the message's words; a service message (a join, a call,
 * a pin) is the plain sentence the export reader writes for the same event,
 * naming who did it. Its search context adds what the words leave out: the
 * names of attachments, the chat, the sender and who a forward came from.
 */
export function telegramMessageItem(input: {
  account: string;
  conversationId: string;
  trustDomain: TelegramMessagesCorpusTrustDomain;
  corpusId: TelegramMessagesCorpusId;
  message: Record<string, unknown>;
  fetchedAt: string;
}): TelegramCaptureSpoolRecord['capturedItem'] {
  const messageId = requiredString(input.message.id, 'message id');
  const words = optionalString(input.message.boundedText);
  if (words && words.length > MAX_TEXT_CHARS) {
    throw new Error('Telegram capture spool message exceeds its bounded text capacity.');
  }
  const senderName = optionalString(input.message.senderDisplayName);
  const chatTitle = optionalString(input.message.chatTitle);
  const forwardedFrom = optionalString(input.message.forwardFromName);
  const replyTo = optionalString(input.message.replyToMessageId);
  const service = serviceEvent(input.message.service, senderName, replyTo);
  const body = [service?.sentence, words].filter((part): part is string => Boolean(part)).join('\n') || undefined;
  if (body && body.length > MAX_TEXT_CHARS) {
    throw new Error('Telegram capture spool message exceeds its bounded text capacity.');
  }
  const attachmentNames = captureAttachmentNames(input.message);
  const searchText = captureSearchText(body, [
    ...attachmentNames,
    ...(forwardedFrom ? [`Forwarded from ${forwardedFrom}`] : []),
    ...(senderName ? [senderName] : []),
    ...(chatTitle ? [chatTitle] : []),
  ]);
  const identity: SourceItemIdentity = {
    family: 'chat',
    provider: 'telegram',
    accountScope: input.account,
    providerItemId: messageId,
    providerConversationId: input.conversationId,
    localItemId: `${input.account}:${input.conversationId}:${messageId}`,
    ...(optionalString(input.message.threadId) ? { providerThreadId: optionalString(input.message.threadId)! } : {}),
    ...(optionalString(input.message.sourceVersion) ? { sourceVersion: optionalString(input.message.sourceVersion)! } : {}),
  };
  const metadata = {
    title: chatTitle ?? `Telegram conversation ${sha256(input.conversationId).slice(0, 12)}`,
    ...(searchText ? { searchText } : {}),
    sentAt: optionalTimestamp(input.message.sentAt, 'sent timestamp'),
    authoredAt: optionalTimestamp(input.message.sentAt, 'sent timestamp'),
    editedAt: optionalTimestamp(input.message.editedAt, 'edited timestamp'),
    senderId: optionalString(input.message.senderId),
    senderDisplayName: senderName,
    senderLabel: senderName ?? optionalString(input.message.senderId),
    senderIsOwner: optionalBoolean(input.message.senderIsOwner),
    replyToMessageId: replyTo,
    forwardSource: optionalString(input.message.forwardSource),
    ...(forwardedFrom ? { forwardedFrom } : {}),
    ...(attachmentNames.length > 0 ? { attachmentNames } : {}),
    ...(service ? { serviceMessage: true, serviceAction: service.action } : {}),
    ...(optionalString(input.message.recordKind) ? { recordKind: optionalString(input.message.recordKind)! } : {}),
    chatType: optionalString(input.message.chatType),
    attachments: Array.isArray(input.message.attachments) ? input.message.attachments : [],
    reactions: input.message.reactions,
    corpusId: input.corpusId,
    trustDomain: input.trustDomain,
    ...(input.message.secretRedacted === true ? { secretRedacted: true } : {}),
  };
  return {
    trustDomain: input.trustDomain,
    item: {
      identity,
      mimeType: 'text/plain; charset=utf-8',
      content: body ? { kind: 'text', text: body } : { kind: 'metadata_only' },
      metadata: Object.freeze(metadata),
      fetchedAt: input.fetchedAt,
    },
  };
}

// The plain fields a service event may carry, by the export's names. Anything
// else in a record's `service` is not read, so a record cannot smuggle text in.
const SERVICE_FIELDS: ReadonlySet<string> = new Set([
  'title', 'new_title', 'members', 'duration_seconds', 'duration', 'discard_reason', 'period',
  'amount', 'currency', 'boosts', 'inviter',
]);

/**
 * A service message's sentence, from the event's export-named fields and the
 * sender as who did it; the pinned message is the one the record replies to.
 */
function serviceEvent(
  value: unknown,
  actor: string | undefined,
  replyTo: string | undefined,
): { action: string; sentence: string } | undefined {
  if (!isRecordValue(value)) return undefined;
  const action = optionalString(value.action);
  if (!action || action.length > 80) return undefined;
  const fields: Record<string, unknown> = { action };
  for (const [key, field] of Object.entries(value)) {
    if (!SERVICE_FIELDS.has(key)) continue;
    if (typeof field === 'string' && field.length <= 1_000) fields[key] = field;
    else if (typeof field === 'number' && Number.isFinite(field)) fields[key] = field;
    else if (Array.isArray(field) && field.length <= 200 && field.every((entry) => typeof entry === 'string' && entry.length <= 200)) {
      fields[key] = field;
    }
  }
  if (actor) fields.actor = actor;
  if (action === 'pin_message' && replyTo) fields.message_id = replyTo;
  return { action, sentence: telegramServiceContent(fields).text };
}

function captureAttachmentNames(message: Record<string, unknown>): string[] {
  const values: string[] = [];
  if (Array.isArray(message.attachmentNames)) {
    for (const value of message.attachmentNames) {
      const name = optionalString(value);
      if (name) values.push(name);
    }
  }
  if (Array.isArray(message.attachments)) {
    for (const value of message.attachments) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const name = optionalString((value as Record<string, unknown>).name);
      if (name) values.push(name);
    }
  }
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function captureSearchText(body: string | undefined, context: readonly string[]): string | undefined {
  const value = [body, ...context].filter((part): part is string => Boolean(part)).join('\n');
  if (!value) return undefined;
  if (value.length > MAX_TEXT_CHARS) throw new Error('Telegram capture spool search text exceeds its bounded capacity.');
  return value;
}

function assertTrustCorpus(trust: TelegramMessagesCorpusTrustDomain, corpus: TelegramMessagesCorpusId): void {
  const expected = trust === 'secure_local'
    ? PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID
    : INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID;
  if (corpus !== expected) throw new Error('Telegram capture spool found a corpus/trust mismatch.');
}

function telegramTrust(value: unknown): TelegramMessagesCorpusTrustDomain {
  if (value !== 'internal' && value !== 'secure_local') {
    throw new Error('Telegram capture spool found an invalid trust domain.');
  }
  return value;
}

function telegramCorpus(value: unknown): TelegramMessagesCorpusId {
  if (value !== INTERNAL_TELEGRAM_MESSAGES_CORPUS_ID && value !== PROTECTED_TELEGRAM_MESSAGES_CORPUS_ID) {
    throw new Error('Telegram capture spool found an invalid corpus id.');
  }
  return value;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Telegram capture spool ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_TEXT_CHARS) {
    throw new Error(`Telegram capture spool ${label} is invalid.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function timestamp(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!Number.isFinite(Date.parse(result))) throw new Error(`Telegram capture spool ${label} is invalid.`);
  return new Date(result).toISOString();
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  return value === null || value === undefined || value === '' ? undefined : timestamp(value, label);
}

function requiredSha256(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`Telegram capture spool ${label} is invalid.`);
  return result;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_PAGE_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Telegram capture spool limit must be positive.');
  return Math.min(value, MAX_PAGE_LIMIT);
}

/**
 * A listing `limit` is the RUN's item budget, not a page size: the connector
 * spine passes its max-items budget there. Capping it at one page is what made
 * a 50,000-item budget deliver 10,000 items and stop, so the budget keeps its
 * full value and only each page is capped.
 */
function normalizeBudget(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Telegram capture spool limit must be positive.');
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * The capture's chat-type vocabulary mapped to the contract's conversation
 * kinds. An unknown or missing value claims nothing.
 */
export function telegramConversationKind(chatType: string | undefined): SourceConversationKind | undefined {
  switch (chatType?.toLowerCase()) {
    case 'dm':
    case 'private':
    case 'direct':
      return 'direct';
    case 'group':
    case 'supergroup':
      return 'group';
    case 'channel':
      return 'channel';
    case 'secret':
    case 'secret_chat':
      return 'secret_chat';
    default:
      return undefined;
  }
}
