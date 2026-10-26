/**
 * Media waiting for disk space, fetched only once Olympus asks (owner,
 * 2026-10-26: waiting media is downloaded only after Olympus judges the
 * message not Secret; review round 8 on #558: Olympus alone owns what is
 * fetched).
 *
 * Below its disk floor the bridge spools a picture, video or voice note
 * message at once, its media `waiting_for_disk`, with what a later download
 * needs on the line, and keeps nothing else (tools/whatsapp-bridge/
 * media_waiting.go). The listing notes each such line (`waitingMedia`), and
 * this module keeps them, one row per message, beside the spool index. On
 * every pull, after the Secrets clearing, it makes the bridge's folders match
 * that state and the stores:
 *
 *   - A message stored at the row's version, judged not Secret (nor its
 *     media child), whose names are not still being judged, gets a request
 *     `media/fetch/<stem>.json` while the disk is above the floor. A request
 *     is written to a temp, fsynced, linked into place (never over another)
 *     and its folder fsynced; one that says something else is replaced.
 *   - The bridge answers in `media/fetched/`: `<stem><ext>`, or
 *     `<stem>.failed` for media that can never be fetched. An answer is put
 *     in its media folder as `<stem>-fetched<ext>` and read into the stored
 *     item through the connector's own record builder (`mediaFill`), which
 *     fills the picture's or video's child, or the voice note itself, and
 *     nothing else: no caption goes out this way. Extraction and judgment
 *     follow as for any media. The request, the answer and the row go once
 *     the fill is committed.
 *   - Whatever is no longer wanted is deleted, whenever its download
 *     finished: the request, answer and fetched copy of a message turned
 *     Secret, stored at another version, or gone; any request, answer or part
 *     whose message has no row. A download that lands after its message
 *     turned Secret is deleted on the next pass.
 *
 * The bridge keeps no state for any of this, so a crash of either side leaves
 * at most a request to do again or an answer to read again.
 *
 * Doc comments here are always multi-line blocks.
 */

import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { SourceConnectorInput, SourceConnectorListOptions } from '../../core/contracts.ts';
import { childProviderItemId } from '../../core/child-item-id.ts';
import { inputConnector } from '../../core/source-inputs.ts';
import { closeSqliteStore } from '../../core/sqlite-store.ts';
import type { TierLedgerRecord } from '../classification/tier-ledger.ts';
import type { ConnectorStoreSyncOptions } from '../connector-store/index.ts';
import type { TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import {
  compareWhatsAppVersions,
  createWhatsAppRecordBuilder,
  isWhatsAppChildMediaType,
  parseWhatsAppSpoolRecord,
  whatsAppFetchedMediaName,
  whatsAppMediaChildLocalItemId,
  whatsAppMediaFileStem,
  type WhatsAppRecord,
  type WhatsAppSpoolPassFindings,
  type WhatsAppWaitingMedia,
} from './live-connector.ts';
import { WhatsAppSpoolIndex } from './spool-index.ts';
import { spoolRecords, WHATSAPP_SPOOL_MAX_RECORD_BYTES } from './spool-reader.ts';

export const WHATSAPP_MEDIA_FETCH_STATE_FILE = 'media-fetch.sqlite';
/** The connector id fills are synced under (an input of the WhatsApp connector, with its own cursor). */
export const WHATSAPP_MEDIA_FETCH_INPUT_ID = 'whatsapp-media-fetch';

const FAILED_SUFFIX = '.failed';
const PART_SUFFIX = '.part';
/** The floor the bridge keeps: the larger of 5 GiB and 5% of the volume (media_waiting.go, diskFloor). */
const DISK_FLOOR_MIN_BYTES = 5 * 1024 * 1024 * 1024;
const DISK_FLOOR_SHARE = 20;

export type WhatsAppVolumeSpace = (dir: string) => { free: number; total: number } | undefined;

export interface WhatsAppMediaFetchResult {
  /** Requests written this pass. */
  requested: number;
  /** Items filled from fetched media this pass. */
  filled: number;
  /** Rows dropped this pass (Secret, superseded, gone, never fetchable), with everything fetched for them. */
  dropped: number;
  /** Media waits and the volume is below the floor: the card's findable problem. */
  waitingForDisk: boolean;
}

export interface WhatsAppMediaFetchOptions {
  spoolDir: string;
  account: string;
  /** The bridge's media folder in its state folder: `fetch/` and `fetched/` are in it. */
  mediaRoot: string;
  /** Where fetched media is kept, by kind: the folders the readers are confined to. */
  folders: { image: string; video: string; audio: string };
  tierSet: TieredStoreSet;
  findings: WhatsAppSpoolPassFindings;
  sync: ConnectorStoreSyncOptions;
  readChild?: (locator: string, options: { maxBytes?: number }) => Uint8Array;
  /** The volume's space (test seam); the real volume by default. */
  space?: WhatsAppVolumeSpace;
}

/**
 * One pass: note what the listing found, then make the requests, answers and
 * fetched copies match the stored state, and fill what was fetched.
 */
export async function runWhatsAppMediaFetch(options: WhatsAppMediaFetchOptions): Promise<WhatsAppMediaFetchResult> {
  const result: WhatsAppMediaFetchResult = { requested: 0, filled: 0, dropped: 0, waitingForDisk: false };
  const state = WaitingMediaState.open(options.spoolDir);
  try {
    for (const saved of options.findings.savedMedia) state.saved(saved.chatJid, saved.id, saved.version);
    for (const waiting of options.findings.waitingMedia) state.note(waiting);
    const fetchDir = join(options.mediaRoot, 'fetch');
    const fetchedDir = join(options.mediaRoot, 'fetched');
    const room = hasRoom(options.mediaRoot, options.space ?? volumeSpace);
    const ledger = options.tierSet.ledger;
    const fills: Array<{ row: WaitingMediaRow; placed: string; answer: string; size: number }> = [];
    const drop = (row: WaitingMediaRow, fetchedCopy: boolean, finished = false): void => {
      removeIfThere(join(fetchDir, `${row.stem}.json`));
      for (const name of namesOf(fetchedDir, row.stem)) removeIfThere(join(fetchedDir, name));
      if (fetchedCopy) for (const dir of Object.values(options.folders)) removeFetchedCopies(dir, row.stem);
      if (finished) state.finish(row.stem);
      else state.forget(row.stem);
      result.dropped += 1;
    };
    for (const row of state.all()) {
      const parent = { provider: 'whatsapp', accountScope: options.account, providerItemId: row.id, providerConversationId: row.chatJid };
      const child = isWhatsAppChildMediaType(row.media.mediaType) ? { ...parent, providerItemId: childProviderItemId(row.id, 'media') } : undefined;
      const target = child ?? parent;
      const parentRecord = ledger.getCurrent(parent);
      const childRecord = child ? ledger.getCurrent(child) : undefined;
      if (isSecret(parentRecord) || isSecret(childRecord)) {
        drop(row, true);
        continue;
      }
      const stored = options.tierSet.storedItem(target, compareWhatsAppVersions);
      if (!stored) {
        // Not stored yet (the pull that listed it has not committed it); once its message is, it is gone.
        if (parentRecord) drop(row, true);
        continue;
      }
      if (stored.tombstoned === true || stored.version === undefined || compareWhatsAppVersions(stored.version, row.version) !== 0) {
        drop(row, true);
        continue;
      }
      if (child && childFilled(options.tierSet, whatsAppMediaChildLocalItemId(options.account, row.chatJid, row.id))) {
        drop(row, false, true);
        continue;
      }
      const answers = namesOf(fetchedDir, row.stem);
      if (answers.includes(`${row.stem}${FAILED_SUFFIX}`)) {
        // Gone from WhatsApp's servers, or not what its hashes say: the media stays unreadable.
        drop(row, false, true);
        continue;
      }
      const answer = answers.find((name) => name !== `${row.stem}${PART_SUFFIX}` && !name.startsWith('.'));
      if (answer !== undefined) {
        const ext = answer.slice(row.stem.length);
        const folder = isWhatsAppChildMediaType(row.media.mediaType)
          ? (row.media.mediaType === 'image' ? options.folders.image : options.folders.video)
          : options.folders.audio;
        const placed = join(folder, whatsAppFetchedMediaName(row.stem, ext));
        const size = place(join(fetchedDir, answer), placed);
        fills.push({ row, placed, answer: join(fetchedDir, answer), size });
        continue;
      }
      if (!room) {
        result.waitingForDisk = true;
        continue;
      }
      // Judged not Secret: its names are settled (a Secret only ever comes from them or its words, both judged by now).
      if (!parentRecord || parentRecord.metadataPending) continue;
      if (ensureRequest(fetchDir, row)) result.requested += 1;
    }
    sweepOrphans(fetchDir, state);
    sweepOrphans(fetchedDir, state);
    if (fills.length > 0) {
      const records = fills.flatMap(({ row, placed, size }) => {
        const record = fillRecord(options.spoolDir, row, placed, size);
        return record ? [record] : [];
      });
      if (records.length > 0) {
        const builder = createWhatsAppRecordBuilder({
          spoolDir: options.spoolDir,
          account: options.account,
          ...(options.readChild ? { readChild: options.readChild } : {}),
        });
        const input: SourceConnectorInput<WhatsAppRecord> = {
          inputId: WHATSAPP_MEDIA_FETCH_INPUT_ID,
          kind: 'live',
          records: (_listOptions?: SourceConnectorListOptions) => (async function* () {
            yield { records, done: true };
          })(),
        };
        await options.tierSet.sync(inputConnector(builder, input), options.sync);
      }
      for (const { row, answer } of fills) {
        if (!records.some((record) => record.id === row.id && record.chatJid === row.chatJid)) continue;
        // Filled: the request goes first, so the bridge never fetches it again once the answer is gone.
        removeIfThere(join(fetchDir, `${row.stem}.json`));
        removeIfThere(answer);
        state.finish(row.stem);
        result.filled += 1;
      }
    }
    if (!room && state.count() > 0) result.waitingForDisk = true;
    return result;
  } finally {
    state.close();
  }
}

interface WaitingMediaRow {
  stem: string;
  chatJid: string;
  id: string;
  version: string;
  media: WhatsAppWaitingMedia;
  /** Filled, or never fetchable: its keys are gone and nothing is asked for it. */
  done: boolean;
}

/**
 * Olympus's one record of the media waiting to be fetched: a row per
 * message, at the newest version a listing found waiting.
 */
class WaitingMediaState {
  private constructor(private readonly db: Database) {}

  static open(spoolDir: string): WaitingMediaState {
    const path = join(spoolDir, WHATSAPP_MEDIA_FETCH_STATE_FILE);
    const db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    db.run(`CREATE TABLE IF NOT EXISTS waiting (
      stem TEXT PRIMARY KEY,
      chat_jid TEXT NOT NULL,
      id TEXT NOT NULL,
      version TEXT NOT NULL,
      media_json TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0
    )`);
    return new WaitingMediaState(db);
  }

  note(media: WhatsAppWaitingMedia): void {
    const stem = whatsAppMediaFileStem(media.chatJid, media.id);
    const existing = this.row(stem);
    if (existing) {
      const order = compareWhatsAppVersions(existing.version, media.version);
      // A newer version waits anew; the same one read again (a replay) is not asked for twice once it is done.
      if (order > 0 || (order === 0 && existing.done)) return;
    }
    this.db.query('INSERT OR REPLACE INTO waiting (stem, chat_jid, id, version, media_json, done) VALUES (?, ?, ?, ?, ?, 0)')
      .run(stem, media.chatJid, media.id, media.version, JSON.stringify(media));
  }

  saved(chatJid: string, id: string, version: string): void {
    const stem = whatsAppMediaFileStem(chatJid, id);
    const existing = this.row(stem);
    if (existing && compareWhatsAppVersions(existing.version, version) <= 0) this.forget(stem);
  }

  forget(stem: string): void {
    this.db.query('DELETE FROM waiting WHERE stem = ?').run(stem);
  }

  /** Filled, or never fetchable: kept at its version so a replay of the same line does not ask again. */
  finish(stem: string): void {
    this.db.query('UPDATE waiting SET done = 1, media_json = ? WHERE stem = ?').run('{}', stem);
  }

  count(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM waiting WHERE done = 0').get() as { n: number }).n;
  }

  all(): WaitingMediaRow[] {
    const rows = this.db.query('SELECT stem, chat_jid, id, version, media_json, done FROM waiting WHERE done = 0 ORDER BY rowid').all() as RawRow[];
    return rows.map(toRow);
  }

  close(): void {
    closeSqliteStore(this.db);
  }

  private row(stem: string): WaitingMediaRow | undefined {
    const row = this.db.query('SELECT stem, chat_jid, id, version, media_json, done FROM waiting WHERE stem = ?').get(stem) as RawRow | null;
    return row ? toRow(row) : undefined;
  }
}

interface RawRow {
  stem: string;
  chat_jid: string;
  id: string;
  version: string;
  media_json: string;
  done: number;
}

function toRow(row: RawRow): WaitingMediaRow {
  return {
    stem: row.stem,
    chatJid: row.chat_jid,
    id: row.id,
    version: row.version,
    media: JSON.parse(row.media_json) as WhatsAppWaitingMedia,
    done: row.done === 1,
  };
}

/**
 * Judged Secrets, or on the way there: never fetched, and whatever was
 * fetched is deleted. A record the ledger does not hold is not Secrets.
 */
function isSecret(record: TierLedgerRecord | undefined): boolean {
  if (!record) return false;
  return record.metadataTier === 'secrets' || record.contentTier === 'secrets'
    || record.targetMetadataTier === 'secrets' || record.targetContentTier === 'secrets';
}

/** A child some store already reads from a saved file: the bridge saved it, or a fill already landed. */
function childFilled(tierSet: TieredStoreSet, localItemId: string): boolean {
  return tierSet.openStores().some((store) => store.deferredBytesStateOfLocalItem(localItemId).state === 'ready');
}

/** The request the bridge downloads from: the message and the fields its spool line carried. */
function requestPayload(row: WaitingMediaRow): string {
  const media = row.media;
  return JSON.stringify({
    chat_jid: row.chatJid,
    id: row.id,
    media_type: media.mediaType,
    ...(media.mediaMime !== undefined ? { media_mime: media.mediaMime } : {}),
    ...(media.mediaKey !== undefined ? { media_key: media.mediaKey } : {}),
    media_direct_path: media.mediaDirectPath,
    ...(media.mediaFileSha256 !== undefined ? { media_file_sha256: media.mediaFileSha256 } : {}),
    ...(media.mediaFileEncSha256 !== undefined ? { media_file_enc_sha256: media.mediaFileEncSha256 } : {}),
  });
}

/**
 * Makes the row's request be there, saying what it should: written whole
 * before it can be seen, and replaced when it says something else. True when
 * it was written now.
 */
function ensureRequest(fetchDir: string, row: WaitingMediaRow): boolean {
  const path = join(fetchDir, `${row.stem}.json`);
  const payload = requestPayload(row);
  try {
    if (readFileSync(path, 'utf8') === payload) return false;
    removeIfThere(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  mkdirSync(fetchDir, { recursive: true, mode: 0o700 });
  const temp = join(fetchDir, `.${row.stem}.json.tmp-${randomBytes(8).toString('hex')}`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    try {
      const bytes = Buffer.from(payload, 'utf8');
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      linkSync(temp, path);
    } catch (error) {
      // Written meanwhile by another pass: the next pass checks what it says.
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    fsyncDir(fetchDir);
    return true;
  } finally {
    removeIfThere(temp);
  }
}

/**
 * Puts an answer in its media folder under its fetched name (a link, or a
 * copy across volumes), durably, replacing an earlier copy. Returns its size.
 */
function place(answer: string, placed: string): number {
  const folder = join(placed, '..');
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  removeIfThere(placed);
  try {
    linkSync(answer, placed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    const temp = `${placed}.tmp-${randomBytes(8).toString('hex')}`;
    try {
      copyFileSync(answer, temp, constants.COPYFILE_EXCL);
      const fd = openSync(temp, 'r');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, placed);
    } finally {
      removeIfThere(temp);
    }
  }
  fsyncDir(folder);
  return statSync(placed).size;
}

/** The fill: the message's line at the stored version, naming the fetched copy. Undefined when the line is not that version now. */
function fillRecord(spoolDir: string, row: WaitingMediaRow, placed: string, size: number): WhatsAppRecord | undefined {
  const index = WhatsAppSpoolIndex.open(spoolDir);
  if (!index) return undefined;
  try {
    const located = index.newestMessage(row.id, row.chatJid);
    if (!located) return undefined;
    for (const read of spoolRecords(join(spoolDir, located.file), located.offset, WHATSAPP_SPOOL_MAX_RECORD_BYTES, { bytesLeft: WHATSAPP_SPOOL_MAX_RECORD_BYTES })) {
      if (read.kind !== 'line') return undefined;
      const message = parseWhatsAppSpoolRecord(read.text);
      if (!message || message.id !== row.id || message.secretRedacted === true) return undefined;
      if (compareWhatsAppVersions(message.timestamp, row.version) !== 0) return undefined;
      return { ...message, mediaPath: placed, downloadStatus: 'ok', mediaSizeBytes: size, mediaFill: true };
    }
    return undefined;
  } finally {
    index.close();
  }
}

/** The names in a folder that are a message's: its request, answer, part, or a temp of one. */
function namesOf(dir: string, stem: string): string[] {
  return listNames(dir).filter((name) => belongsTo(name, stem));
}

function belongsTo(name: string, stem: string): boolean {
  return name.startsWith(`${stem}.`) || name.startsWith(`.${stem}.`);
}

/**
 * Removes every request, answer, part or temp whose message is not wanted:
 * withdrawn, or downloaded too late. Matched against the stems wanted, never
 * parsed out of a name (a message id may hold a dot).
 */
function sweepOrphans(dir: string, state: WaitingMediaState): void {
  const wanted = state.all().map((row) => row.stem);
  for (const name of listNames(dir)) {
    if (!wanted.some((stem) => belongsTo(name, stem))) removeIfThere(join(dir, name));
  }
}

/** Removes a message's fetched copies from a media folder. */
function removeFetchedCopies(dir: string, stem: string): void {
  const prefix = whatsAppFetchedMediaName(stem, '.');
  for (const name of listNames(dir)) {
    if (name.startsWith(prefix)) removeIfThere(join(dir, name));
  }
}

function listNames(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function volumeSpace(dir: string): { free: number; total: number } | undefined {
  try {
    const stats = statfsSync(existingAncestor(dir));
    return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
  } catch {
    return undefined;
  }
}

function existingAncestor(dir: string): string {
  for (let current = dir; ; current = join(current, '..')) {
    try {
      statSync(current);
      return current;
    } catch {
      if (join(current, '..') === current) return current;
    }
  }
}

/** Whether the volume is above the bridge's floor. A volume whose space cannot be read is never paused for it. */
function hasRoom(dir: string, space: WhatsAppVolumeSpace): boolean {
  const volume = space(dir);
  if (!volume || volume.total <= 0) return true;
  return volume.free >= Math.max(DISK_FLOOR_MIN_BYTES, Math.floor(volume.total / DISK_FLOOR_SHARE));
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Removes a file; anything but its being gone fails the pass. */
function removeIfThere(path: string): void {
  try {
    rmSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
