/**
 * Media that waited for disk space, fetched by Olympus alone (owner,
 * 2026-10-26: Olympus asks the bridge for the exact message version, receives
 * the bytes into its own folder, re-checks the judgment before indexing, and
 * keys everything by version).
 *
 * Below its disk floor the bridge spools a picture, video or voice note
 * message at once, its media `waiting_for_disk`, with what a later download
 * needs on the line, and keeps nothing else (tools/whatsapp-bridge/
 * media_waiting.go). The listing tells this module of each such line as it
 * reads it, before the pull commits past it, and the line is kept as a row
 * keyed by the message and its version digest, with the line's place in the
 * spool. Every write after that is Olympus's, in the pull, after the Secrets
 * clearing (the take-back), one message at a time:
 *
 *   1. The message is stored at the row's version, neither it nor its media
 *      child is Secret there (each stored at that version, not hidden, and
 *      not judged Secret since), its names are settled, and the disk is
 *      above the floor.
 *   2. Olympus asks the bridge for that version's media through its one
 *      local call (media_serve.go), and receives the bytes into
 *      `<stem>~<version digest><ext>.part` in its own folder, then fsyncs it.
 *   3. It checks step 1 again; on a Secret or another version the part is
 *      deleted. Otherwise it is renamed to its name and the folder fsynced.
 *   4. The file is read into the stored item through the connector's own
 *      record builder (`mediaFill`), built from the version's own spool line:
 *      the picture's or video's child, or the voice note itself, and nothing
 *      else (no caption goes out this way). Each fill is fenced: under the
 *      ledger's write hold (`holdingWrites`), step 1 is checked once more,
 *      the fill alone is synced (no embedding, no other settlement; what a
 *      sync sweeps besides runs before the hold), and step 1 is checked again; a decision another
 *      process makes waits for the hold, and one made in this process
 *      meanwhile is seen by the last check, which takes the fill back at
 *      once. Extraction and judgment follow as for any media. A row is done
 *      only once the stores are seen to hold the file at that version.
 *
 * On every pass, a row of a message that is now Secret (the message or its
 * media) is taken back. The row is marked first, so the take-back is owed
 * for that version until it is confirmed. The picture's or video's child at
 * that version is made Secret through the one Secrets path
 * (`settleRoutedSecrets`; its copies, chunks, embeddings and extraction-job
 * names go), whether or not the file is still there. Once that is confirmed,
 * the file is deleted and the folder fsynced, and the row is forgotten last.
 * An owed take-back is taken up again only while a Secret still covers it,
 * and never touches a newer version. A row stored at another version, or
 * whose message is gone, loses its file and is forgotten. A file in the
 * folder that no row names is deleted. The clearing deletes a fetched copy
 * whose media is judged Secret too, though no line names it.
 *
 * Doc comments here are always multi-line blocks.
 */

import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  fsyncSync,
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
import { createConnection } from 'node:net';
import { dirname, join } from 'node:path';
import type { SourceConnectorInput } from '../../core/contracts.ts';
import { childProviderItemId } from '../../core/child-item-id.ts';
import { inputConnector } from '../../core/source-inputs.ts';
import { closeSqliteStore } from '../../core/sqlite-store.ts';
import type { TierDecision } from '../classification/tier-classifier.ts';
import type { TierLedgerRecord } from '../classification/tier-ledger.ts';
import type { ConnectorStoreSyncOptions } from '../connector-store/index.ts';
import type { TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import { forgetSecretInSideStores } from '../connector-store/secrets-disposition.ts';
import { settleLegacySecrets, settleRoutedSecrets } from '../connector-store/tier-rejudge.ts';
import { WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX } from './child-media.ts';
import {
  compareWhatsAppVersions,
  createWhatsAppRecordBuilder,
  isWhatsAppChildMediaType,
  parseWhatsAppSpoolRecord,
  whatsAppFetchedMediaName,
  whatsAppMediaChildLocalItemId,
  whatsAppMediaFileStem,
  whatsAppMessageLocalItemId,
  type WhatsAppRecord,
  type WhatsAppSpoolPassFindings,
  type WhatsAppWaitingMedia,
} from './live-connector.ts';
import { spoolRecords, WHATSAPP_SPOOL_MAX_RECORD_BYTES } from './spool-reader.ts';

export const WHATSAPP_MEDIA_FETCH_STATE_FILE = 'media-fetch.sqlite';
/** The connector id fills are synced under (an input of the WhatsApp connector, with its own cursor). */
export const WHATSAPP_MEDIA_FETCH_INPUT_ID = 'whatsapp-media-fetch';
/** The bridge's note of where its one local call listens (media_serve.go). */
export const WHATSAPP_MEDIA_SOCKET_POINTER = 'media-download.json';

const PART_SUFFIX = '.part';
/** The floor the bridge keeps: the larger of 5 GiB and 5% of the volume (media_waiting.go, diskFloor). */
const DISK_FLOOR_MIN_BYTES = 5 * 1024 * 1024 * 1024;
const DISK_FLOOR_SHARE = 20;
/** How long the call may go without a byte (the bridge sends one at least every 30 s) before Olympus gives up on it for this pass. */
const CALL_STALL_MS = 120_000;
/** An answer's head is one short JSON line. */
const ANSWER_HEAD_MAX_BYTES = 64 * 1024;

export type WhatsAppVolumeSpace = (dir: string) => { free: number; total: number } | undefined;

/** What the bridge's call answered (media_serve.go). */
export type WhatsAppMediaAnswer =
  | { status: 'ok'; size: number }
  | { status: 'failed'; permanent: boolean; reason: string }
  /** The bridge is not running, or its call cannot be reached: nothing more is asked of it this pass. */
  | { status: 'unavailable' };

export interface WhatsAppMediaRequest {
  chat_jid: string;
  id: string;
  version: string;
  media_type: string;
  media_mime?: string;
  media_key?: string;
  media_direct_path: string;
  media_file_sha256?: string;
  media_file_enc_sha256?: string;
}

/**
 * Asks the bridge for one version's media and writes its bytes to
 * `partPath`, fsynced. `fits` is asked the size before a byte is written.
 */
export type WhatsAppMediaCall = (request: WhatsAppMediaRequest, partPath: string, fits: (size: number) => boolean) => Promise<WhatsAppMediaAnswer>;

export interface WhatsAppMediaFetchResult {
  /** Downloads received this pass. */
  received: number;
  /** Items filled from fetched media this pass, seen in the stores. */
  filled: number;
  /** Rows forgotten this pass (Secret, another version, gone), their files deleted. */
  dropped: number;
  /** Media waits and the volume is below the floor: the card's findable problem. */
  waitingForDisk: boolean;
}

export interface WhatsAppMediaFetchOptions {
  state: WhatsAppMediaFetchState;
  spoolDir: string;
  account: string;
  /** Olympus's own folder for fetched media; the media roots, which the readers are confined to, include it. */
  folder: string;
  tierSet: TieredStoreSet;
  /** What the pull's listing found (the rows it told already, and the media the bridge saved itself). */
  findings: WhatsAppSpoolPassFindings;
  sync: ConnectorStoreSyncOptions;
  /** The bridge's call (`bridgeMediaCall`). */
  call: WhatsAppMediaCall;
  readChild?: (locator: string, options: { maxBytes?: number }) => Uint8Array;
  /** The volume's space (test seam); the real volume by default. */
  space?: WhatsAppVolumeSpace;
}

/**
 * One pass, in the pull after the clearing: forget what is no longer wanted,
 * fetch what is, and fill what was fetched.
 */
export async function runWhatsAppMediaFetch(options: WhatsAppMediaFetchOptions): Promise<WhatsAppMediaFetchResult> {
  const result: WhatsAppMediaFetchResult = { received: 0, filled: 0, dropped: 0, waitingForDisk: false };
  const { state, folder } = options;
  for (const media of options.findings.waitingMedia) state.note(media);
  for (const saved of options.findings.savedMedia) state.saved(saved.chatJid, saved.id, saved.version);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const space = options.space ?? volumeSpace;
  // A part is only ever written inside one pass: any left is a pass that died.
  for (const name of listNames(folder)) if (name.endsWith(PART_SUFFIX)) removeDurably(join(folder, name));
  const removeFiles = (row: WaitingMediaRow): boolean => {
    let had = false;
    for (const name of listNames(folder)) {
      if (!name.startsWith(row.filePrefix)) continue;
      had = true;
      removeDurably(join(folder, name));
    }
    return had;
  };
  // A Secret takes everything back, in this order: the row is marked first (a take-back owed for this version);
  // what a fill made searchable is settled through the one Secrets path, whether or not the file is still there;
  // only once that is confirmed is the file deleted, and the row forgotten last. One cut off anywhere is taken up
  // again by the next pass, for this version only and only while a Secret still covers it: a Secret since cleared
  // drops the obligation untouched, and a newer version stored meanwhile is never touched (only this version's
  // file goes).
  const takeBack = (row: WaitingMediaRow): void => {
    state.markRevoking(row.key);
    const outcome = revokeFetchedChild(options, row);
    if (outcome === 'owed') return;
    if (outcome === 'cleared') {
      state.clearRevoking(row.key);
      return;
    }
    removeFiles(row);
    state.forget(row.key);
    result.dropped += 1;
  };
  const forget = (row: WaitingMediaRow): void => {
    removeFiles(row);
    state.forget(row.key);
    result.dropped += 1;
  };
  const toFill: Array<{ row: WaitingMediaRow; path: string }> = [];
  let bridgeReachable = true;
  for (const row of state.all()) {
    if (row.revoking) {
      takeBack(row);
      continue;
    }
    const verdict = judge(options, row);
    if (verdict === 'secret') {
      takeBack(row);
      continue;
    }
    if (verdict === 'gone') {
      // Another version is stored, or none: this version's file goes, and the newer version is never touched.
      forget(row);
      continue;
    }
    if (row.done) continue;
    const named = listNames(folder).find((name) => name.startsWith(row.filePrefix) && !name.endsWith(PART_SUFFIX));
    if (named !== undefined) {
      // Received by an earlier pass that did not see its fill land: filled again, never fetched again.
      if (verdict === 'clear') toFill.push({ row, path: join(folder, named) });
      continue;
    }
    if (verdict !== 'clear') continue;
    if (!hasRoom(folder, space, 0)) {
      result.waitingForDisk = true;
      continue;
    }
    if (!bridgeReachable) continue;
    const finalPath = join(folder, whatsAppFetchedMediaName(row.stem, row.versionDigest, extensionFor(row.media.mediaMime)));
    const part = `${finalPath}${PART_SUFFIX}`;
    const answer = await options.call(requestOf(row), part, (size) => hasRoom(folder, space, size));
    if (answer.status === 'unavailable') {
      bridgeReachable = false;
      removeDurably(part);
      continue;
    }
    if (answer.status === 'failed') {
      removeDurably(part);
      if (answer.reason === 'waiting_for_disk') result.waitingForDisk = true;
      // Gone from WhatsApp's servers, or not what its hashes say: the media stays unreadable for good.
      if (answer.permanent) state.finish(row.key);
      continue;
    }
    // The judgment is checked again over the bytes received: a message that turned Secret, or moved to another
    // version, while they came never keeps them.
    const again = judge(options, row);
    if (again !== 'clear') {
      removeDurably(part);
      if (again === 'secret') takeBack(row);
      else if (again === 'gone') forget(row);
      continue;
    }
    renameSync(part, finalPath);
    fsyncFolder(folder);
    result.received += 1;
    toFill.push({ row, path: finalPath });
  }
  if (toFill.length > 0) {
    const builder = createWhatsAppRecordBuilder({
      spoolDir: options.spoolDir,
      account: options.account,
      ...(options.readChild ? { readChild: options.readChild } : {}),
    });
    for (const { row, path } of toFill) {
      const record = fillRecord(options.spoolDir, row, path);
      if (!record) continue;
      // What a sync does besides its own records runs before the hold, so the hold covers one record's
      // publication only: writes a cut-off pass still owes, and the children of parents that are gone.
      await options.tierSet.finishWritesCutOff();
      await options.tierSet.sweepOrphanedChildren();
      // Fenced, one item at a time: no decision lands between the last check and the store write. The fill embeds
      // nothing (a filled child has no text until extraction reads it) and settles nothing else.
      const outcome = await options.tierSet.ledger.holdingWrites(async () => {
        const before = judge(options, row);
        if (before !== 'clear') return before;
        await options.tierSet.sync(inputConnector(builder, fillInput(record)), options.sync, { embed: false, settle: false });
        return judge(options, row);
      });
      if (outcome === 'secret') {
        takeBack(row);
        continue;
      }
      if (outcome === 'gone') {
        forget(row);
        continue;
      }
      // Done only once the stores are seen to hold the file at the version: a fill a truncated or failed sync
      // did not land is filled again next pass.
      if (outcome === 'clear' && filledAt(options, row, path)) {
        state.finish(row.key);
        result.filled += 1;
      }
    }
  }
  // Files no row names: a forgotten message's copies that a crash left, or anything else in Olympus's folder.
  const prefixes = state.all().map((row) => row.filePrefix);
  for (const name of listNames(folder)) {
    if (!prefixes.some((prefix) => name.startsWith(prefix))) removeDurably(join(folder, name));
  }
  if (!hasRoom(folder, space, 0) && state.waitingCount() > 0) result.waitingForDisk = true;
  return result;
}

/** The input one fill is synced through: one record, at the version it fills. */
function fillInput(record: WhatsAppRecord): SourceConnectorInput<WhatsAppRecord> {
  return {
    inputId: WHATSAPP_MEDIA_FETCH_INPUT_ID,
    kind: 'live',
    records: () => (async function* () {
      yield { records: [record], done: true };
    })(),
  };
}

function parentOf(options: WhatsAppMediaFetchOptions, row: WaitingMediaRow) {
  return { provider: 'whatsapp', accountScope: options.account, providerItemId: row.id, providerConversationId: row.chatJid };
}

/**
 * Takes back what a fill of this row's version made searchable, while a
 * Secret still covers it (the message's, or its media child's own):
 *
 *   - `cleared`: no Secret covers it any more (a decision restored before an
 *     owed take-back ran): nothing is settled, and nothing is deleted.
 *   - `superseded`: another version is stored now: that version is never
 *     touched; only this version's own file is to go.
 *   - `settled`: the child at this version is Secret through the one Secrets
 *     path (a routed row through its copy ledger, an older row by every copy
 *     a store holds at this version; its chunks, embeddings and side-store
 *     entries go) and no store holds an active copy of it at this version. A
 *     voice note is its message: its own Secret already took it.
 *   - `owed`: not confirmed yet; the next pass takes it up again.
 *
 * It does not depend on the fetched file being there. An older row's
 * settlement cut off after its tombstones (before its decision was written)
 * is resumed from the Secret location it recorded first.
 */
function revokeFetchedChild(options: WhatsAppMediaFetchOptions, row: WaitingMediaRow): 'cleared' | 'superseded' | 'settled' | 'owed' {
  const { tierSet } = options;
  const parent = parentOf(options, row);
  const child = isWhatsAppChildMediaType(row.media.mediaType) ? { ...parent, providerItemId: childProviderItemId(row.id, 'media') } : undefined;
  // Another version stored now is never touched, whatever is judged: only this version's own file goes.
  const stored = tierSet.storedItem(child ?? parent, compareWhatsAppVersions);
  if (stored?.version !== undefined && compareWhatsAppVersions(stored.version, row.version) !== 0) return 'superseded';
  const covered = isSecret(tierSet.ledger.getCurrent(parent)) || (child !== undefined && isSecret(tierSet.ledger.getCurrent(child)));
  if (!covered) return 'cleared';
  if (!child) return 'settled';
  // Only copies of this version: a newer one is another item's content, judged on its own.
  const copies = () => tierSet.openStores().flatMap((store) => {
    const state = store.storedItemState(child);
    if (!state || state.tombstoned || state.version === undefined || compareWhatsAppVersions(state.version, row.version) !== 0) return [];
    const copy = store.exportItemCopy(child);
    return copy ? [{ store, copy }] : [];
  });
  const record = tierSet.ledger.getCurrent(child);
  const held = copies();
  const locations = tierSet.secrets();
  const decision = (base: TierLedgerRecord): TierDecision => ({
    ...base,
    metadataTier: 'secrets',
    contentTier: 'secrets',
    decidedBy: 'secret_detector',
    reasons: ['content:secret:fetched_media_parent_secret'],
    // No sniffer answered this: it follows from the message's own Secret.
    snifferId: 'undecided',
    state: 'current',
    contentRead: true,
    metadataPending: false,
    contentPending: false,
  });
  if (record && !isSecret(record)) {
    const exported = held[0]?.copy;
    if (exported) {
      const finding = { findingKinds: [FETCHED_MEDIA_SECRET_FINDING] };
      if (record.routed) {
        settleRoutedSecrets(tierSet, child, decision(record), exported, finding);
      } else if (locations) {
        // A row the set never routed has no copy ledger: its location is recorded, then every copy a store holds is
        // tombstoned, then the decision is written.
        settleLegacySecrets({ ledger: tierSet.ledger, stores: tierSet.openStores(), locations, identity: child, decision: decision(record) });
      } else {
        // No location index to resume from: the decision goes first (it hides every copy), and copies left by a
        // cut-off pass are tombstoned below, now or on the next pass.
        tierSet.ledger.recordDecision(child, decision(record));
      }
      forgetSecretInSideStores({ ledger: tierSet.ledger, identity: { ...child, localItemId: exported.identity.localItemId } });
    } else if (locations?.get(child)) {
      // An older row's settlement cut off after its last tombstone: the location it recorded first says it was under
      // way, so its decision is written now, and the side stores forget it.
      tierSet.ledger.recordDecision(child, decision(record));
      forgetSecretInSideStores({ ledger: tierSet.ledger, identity: { ...child, localItemId: whatsAppMediaChildLocalItemId(options.account, row.chatJid, row.id) } });
    } else {
      // Never stored at this version, and no settlement under way: nothing of it can be searched.
      return 'settled';
    }
  }
  // A settlement cut off after its decision leaves copies of this version behind: they go now, as the policy would.
  for (const { store, copy } of copies()) store.tombstoneCopy(copy.identity, { connectorId: WHATSAPP_MEDIA_FETCH_INPUT_ID, trustTier: 'S5' });
  if (copies().length > 0) return 'owed';
  return !record || isSecret(tierSet.ledger.getCurrent(child)) ? 'settled' : 'owed';
}

/** The finding a fetched child's take-back records: its Secret follows from its message's. */
const FETCHED_MEDIA_SECRET_FINDING = 'fetched_media_parent_secret';

interface WaitingMediaRow {
  /** The message and its version: `<stem>@<version digest>`. */
  key: string;
  stem: string;
  chatJid: string;
  id: string;
  version: string;
  versionDigest: string;
  /** What every file of this row in Olympus's folder is named with first. */
  filePrefix: string;
  media: WhatsAppWaitingMedia;
  /** Filled, or never fetchable: nothing more is asked, but a Secret still takes its file back. */
  done: boolean;
  /** A take-back is owed and not yet confirmed. */
  revoking: boolean;
}

/**
 * Olympus's one record of the media it fetches: a row per message version,
 * written as the listing reads the line.
 */
export class WhatsAppMediaFetchState {
  private constructor(private readonly db: Database) {}

  static open(spoolDir: string): WhatsAppMediaFetchState {
    const path = join(spoolDir, WHATSAPP_MEDIA_FETCH_STATE_FILE);
    const db = new Database(path, { create: true });
    chmodSync(path, 0o600);
    db.exec('PRAGMA busy_timeout = 10000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    db.run(`CREATE TABLE IF NOT EXISTS media (
      key TEXT PRIMARY KEY,
      stem TEXT NOT NULL,
      version TEXT NOT NULL,
      media_json TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      revoking INTEGER NOT NULL DEFAULT 0
    )`);
    return new WhatsAppMediaFetchState(db);
  }

  /**
   * A waiting line read: its version is kept, and read again (a recovered or
   * replaced spool) its line's place is the one just read. A version done
   * asks nothing again.
   */
  note(media: WhatsAppWaitingMedia): void {
    const stem = whatsAppMediaFileStem(media.chatJid, media.id);
    this.db.query(`INSERT INTO media (key, stem, version, media_json) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET media_json = excluded.media_json WHERE media.done = 0`)
      .run(rowKey(stem, media.version), stem, media.version, JSON.stringify(media));
  }

  /** The bridge saved a version's media itself: nothing is fetched for that version or an older one. */
  saved(chatJid: string, id: string, version: string): void {
    const stem = whatsAppMediaFileStem(chatJid, id);
    for (const row of this.rowsOf(stem)) {
      if (!row.done && compareWhatsAppVersions(row.version, version) <= 0) this.finish(row.key);
    }
  }

  finish(key: string): void {
    this.db.query('UPDATE media SET done = 1 WHERE key = ?').run(key);
  }

  /** A take-back is owed for this version: kept until it is confirmed, or until no Secret covers it. */
  markRevoking(key: string): void {
    this.db.query('UPDATE media SET revoking = 1 WHERE key = ?').run(key);
  }

  clearRevoking(key: string): void {
    this.db.query('UPDATE media SET revoking = 0 WHERE key = ?').run(key);
  }

  forget(key: string): void {
    this.db.query('DELETE FROM media WHERE key = ?').run(key);
  }

  all(): WaitingMediaRow[] {
    return (this.db.query('SELECT key, stem, version, media_json, done, revoking FROM media ORDER BY rowid').all() as RawRow[]).map(toRow);
  }

  waitingCount(): number {
    return (this.db.query('SELECT COUNT(*) AS n FROM media WHERE done = 0').get() as { n: number }).n;
  }

  close(): void {
    closeSqliteStore(this.db);
  }

  private rowsOf(stem: string): WaitingMediaRow[] {
    return (this.db.query('SELECT key, stem, version, media_json, done, revoking FROM media WHERE stem = ?').all(stem) as RawRow[]).map(toRow);
  }
}

interface RawRow {
  key: string;
  stem: string;
  version: string;
  media_json: string;
  done: number;
  revoking: number;
}

function versionDigestOf(version: string): string {
  return createHash('sha256').update(version, 'utf8').digest('hex').slice(0, 16);
}

function rowKey(stem: string, version: string): string {
  return `${stem}@${versionDigestOf(version)}`;
}

function toRow(row: RawRow): WaitingMediaRow {
  const media = JSON.parse(row.media_json) as WhatsAppWaitingMedia;
  const versionDigest = versionDigestOf(row.version);
  return {
    key: row.key,
    stem: row.stem,
    chatJid: media.chatJid,
    id: media.id,
    version: row.version,
    versionDigest,
    filePrefix: whatsAppFetchedMediaName(row.stem, versionDigest, ''),
    media,
    done: row.done === 1,
    revoking: row.revoking === 1,
  };
}

/**
 * The row's standing at its version: `clear` to fetch and fill; `secret`
 * when the message or its media is Secret; `gone` when the message is stored
 * at another version, or no more; `wait` while it is not stored yet, or its
 * names are still being judged.
 */
function judge(options: WhatsAppMediaFetchOptions, row: WaitingMediaRow): 'clear' | 'secret' | 'gone' | 'wait' {
  const { tierSet } = options;
  const parent = parentOf(options, row);
  const child = isWhatsAppChildMediaType(row.media.mediaType) ? { ...parent, providerItemId: childProviderItemId(row.id, 'media') } : undefined;
  const parentRecord = tierSet.ledger.getCurrent(parent);
  const childRecord = child ? tierSet.ledger.getCurrent(child) : undefined;
  if (isSecret(parentRecord) || isSecret(childRecord)) return 'secret';
  const storedParent = tierSet.storedItem(parent, compareWhatsAppVersions);
  const storedChild = child ? tierSet.storedItem(child, compareWhatsAppVersions) : undefined;
  if (!storedParent) return parentRecord ? 'gone' : 'wait';
  // A Secret leaves the stored copy a location only: hidden at its version is Secret there.
  if (storedParent.tombstoned === true || storedChild?.tombstoned === true) return 'secret';
  if (storedParent.version === undefined || compareWhatsAppVersions(storedParent.version, row.version) !== 0) return 'gone';
  if (child && (!storedChild || storedChild.version === undefined || compareWhatsAppVersions(storedChild.version, row.version) !== 0)) return 'gone';
  if (storedParent.incomplete === true || storedChild?.incomplete === true) return 'wait';
  if (!parentRecord || parentRecord.metadataPending) return 'wait';
  // The child's names are judged on their own: they too must be there and settled.
  if (child && (!childRecord || childRecord.metadataPending)) return 'wait';
  return 'clear';
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

/** Whether the stores hold the fetched file at the row's version: the child's locator, or the voice note's own path. */
function filledAt(options: WhatsAppMediaFetchOptions, row: WaitingMediaRow, path: string): boolean {
  const stores = options.tierSet.openStores();
  const childLocal = whatsAppMediaChildLocalItemId(options.account, row.chatJid, row.id);
  if (isWhatsAppChildMediaType(row.media.mediaType)) {
    return stores.some((store) => {
      const state = store.deferredBytesStateOfLocalItem(childLocal, row.version);
      return state.state === 'ready' && state.locator === `${WHATSAPP_MEDIA_FILE_LOCATOR_PREFIX}${path}`;
    });
  }
  const parent = { provider: 'whatsapp', accountScope: options.account, providerItemId: row.id, providerConversationId: row.chatJid };
  const parentLocal = whatsAppMessageLocalItemId(options.account, row.chatJid, row.id);
  return stores.some((store) => {
    const stored = store.storedItemState(parent);
    if (!stored || stored.tombstoned || stored.version === undefined || compareWhatsAppVersions(stored.version, row.version) !== 0) return false;
    return store.activeLocalItemRow(parentLocal)?.locatorUri === path;
  });
}

/** The request for a row: the message, its version, and the fields its line carried. */
function requestOf(row: WaitingMediaRow): WhatsAppMediaRequest {
  const media = row.media;
  return {
    chat_jid: row.chatJid,
    id: row.id,
    version: row.version,
    media_type: media.mediaType,
    ...(media.mediaMime !== undefined ? { media_mime: media.mediaMime } : {}),
    ...(media.mediaKey !== undefined ? { media_key: media.mediaKey } : {}),
    media_direct_path: media.mediaDirectPath,
    ...(media.mediaFileSha256 !== undefined ? { media_file_sha256: media.mediaFileSha256 } : {}),
    ...(media.mediaFileEncSha256 !== undefined ? { media_file_enc_sha256: media.mediaFileEncSha256 } : {}),
  };
}

/**
 * The fill: the version's own spool line (where the listing read it), naming
 * the fetched file. Undefined when that line is no longer that version, or was
 * cleared of a Secret.
 */
function fillRecord(spoolDir: string, row: WaitingMediaRow, path: string): WhatsAppRecord | undefined {
  for (const read of spoolRecords(join(spoolDir, row.media.spoolFile), row.media.spoolOffset, WHATSAPP_SPOOL_MAX_RECORD_BYTES, { bytesLeft: WHATSAPP_SPOOL_MAX_RECORD_BYTES })) {
    if (read.kind !== 'line') return undefined;
    const message = parseWhatsAppSpoolRecord(read.text);
    if (!message || message.id !== row.id || message.secretRedacted === true) return undefined;
    if (whatsAppMediaFileStem(message.chatJid, message.id) !== row.stem) return undefined;
    if (compareWhatsAppVersions(message.timestamp, row.version) !== 0) return undefined;
    return { ...message, mediaPath: path, downloadStatus: 'ok', mediaSizeBytes: statSync(path).size, mediaFill: true };
  }
  return undefined;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/3gpp': '.3gp',
  'video/quicktime': '.mov',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp4': '.m4a',
  'audio/aac': '.aac',
  'audio/amr': '.amr',
};

/** An extension for a mime type (the file is Olympus's own; readers go by the stored mime type). */
function extensionFor(mime: string | undefined): string {
  return EXTENSIONS[(mime ?? '').split(';')[0]!.trim().toLowerCase()] ?? '.bin';
}

/**
 * The bridge's one local call (media_serve.go): the socket its state folder
 * names, one request, one answer, the bytes written to the part and fsynced.
 * A bridge that is not running is `unavailable`.
 */
export function bridgeMediaCall(stateDir: string): WhatsAppMediaCall {
  return (request, partPath, fits) => new Promise((resolve) => {
    let socketPath: string;
    try {
      const named = JSON.parse(readFileSync(join(stateDir, WHATSAPP_MEDIA_SOCKET_POINTER), 'utf8')) as { socket?: unknown };
      if (typeof named.socket !== 'string' || named.socket === '') throw new Error('no socket');
      socketPath = named.socket;
    } catch {
      resolve({ status: 'unavailable' });
      return;
    }
    let settled = false;
    let head = Buffer.alloc(0);
    let answer: { status: 'ok'; size: number } | undefined;
    let fd: number | undefined;
    let written = 0;
    const socket = createConnection({ path: socketPath });
    const finish = (outcome: WhatsAppMediaAnswer): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (fd !== undefined) {
        try {
          if (outcome.status === 'ok') fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
      }
      resolve(outcome);
    };
    const take = (bytes: Buffer): void => {
      if (!answer || fd === undefined) return;
      const chunk = bytes.subarray(0, Math.max(0, answer.size - written));
      let offset = 0;
      while (offset < chunk.length) offset += writeSync(fd, chunk, offset, chunk.length - offset);
      written += chunk.length;
      if (written === answer.size) finish(answer);
    };
    socket.setTimeout(CALL_STALL_MS, () => finish({ status: 'failed', permanent: false, reason: 'stalled' }));
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on('error', () => finish(answer ? { status: 'failed', permanent: false, reason: 'cut_off' } : { status: 'unavailable' }));
    socket.on('close', () => finish({ status: 'failed', permanent: false, reason: 'cut_off' }));
    socket.on('data', (data: Buffer) => {
      if (answer) {
        take(data);
        return;
      }
      head = Buffer.concat([head, data]);
      // While the bridge downloads it sends a bare newline now and then: alive, not stalled. Only a stall ends the call.
      let start = 0;
      while (start < head.length && head[start] === 0x0a) start += 1;
      head = head.subarray(start);
      const newline = head.indexOf(0x0a);
      if (newline === -1) {
        if (head.length > ANSWER_HEAD_MAX_BYTES) finish({ status: 'failed', permanent: false, reason: 'bad_answer' });
        return;
      }
      let parsed: { status?: unknown; size?: unknown; permanent?: unknown; reason?: unknown };
      try {
        parsed = JSON.parse(head.subarray(0, newline).toString('utf8')) as typeof parsed;
      } catch {
        finish({ status: 'failed', permanent: false, reason: 'bad_answer' });
        return;
      }
      if (parsed.status !== 'ok') {
        finish({ status: 'failed', permanent: parsed.permanent === true, reason: typeof parsed.reason === 'string' ? parsed.reason : 'failed' });
        return;
      }
      const size = typeof parsed.size === 'number' && Number.isSafeInteger(parsed.size) && parsed.size >= 0 ? parsed.size : undefined;
      if (size === undefined) {
        finish({ status: 'failed', permanent: false, reason: 'bad_answer' });
        return;
      }
      if (!fits(size)) {
        finish({ status: 'failed', permanent: false, reason: 'waiting_for_disk' });
        return;
      }
      answer = { status: 'ok', size };
      fd = openSync(partPath, 'w', 0o600);
      if (size === 0) {
        finish(answer);
        return;
      }
      take(head.subarray(newline + 1));
    });
  });
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
    const stats = statfsSync(dir);
    return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
  } catch {
    return undefined;
  }
}

/** Whether `adding` more bytes keep the volume above the bridge's floor. A volume whose space cannot be read is never paused for. */
function hasRoom(dir: string, space: WhatsAppVolumeSpace, adding: number): boolean {
  const volume = space(dir);
  if (!volume || volume.total <= 0) return true;
  return volume.free - adding >= Math.max(DISK_FLOOR_MIN_BYTES, Math.floor(volume.total / DISK_FLOOR_SHARE));
}

function fsyncFolder(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Removes a file and fsyncs its folder, so the removal is durable before it is recorded; gone already is fine. */
function removeDurably(path: string): void {
  try {
    rmSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return;
  }
  fsyncFolder(dirname(path));
}
