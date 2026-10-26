/**
 * Grants for media waiting for disk space (owner, 2026-10-26: waiting media
 * is downloaded only after Olympus judges the message not Secret).
 *
 * Below its disk floor the bridge spools a picture or video message at once,
 * marked waiting, and keeps what a later download needs in
 * `media/waiting/<stem>.json`: the message's ids, its media keys and the
 * digest of the line it spooled, never its words
 * (tools/whatsapp-bridge/media_waiting.go). It downloads nothing for an entry
 * until Olympus writes `<stem>.grant` beside it, and only when the grant
 * matches the entry's digest.
 *
 * Olympus grants an entry once the line the entry names is the message's
 * newest line, the tier set has committed past it, and the ledger holds a
 * judgment of the message that is neither pending nor Secrets (its media
 * child, held until its download is judged, must not be Secrets either). The grant carries that line and its digest; it
 * is made exclusively and fsynced, and the bridge removes it with its entry
 * once the line with its media is spooled. A message judged Secrets never
 * gets one, and loses one it had. Olympus never writes or removes an entry.
 *
 * Doc comments here are always multi-line blocks.
 */

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fsyncSync, linkSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { childProviderItemId } from '../../core/child-item-id.ts';
import type { TierLedger, TierLedgerRecord } from '../classification/tier-ledger.ts';
import { comparePlaces, WhatsAppSpoolIndex, type SpoolPlace } from './spool-index.ts';
import { spoolRecords, WHATSAPP_SPOOL_MAX_RECORD_BYTES } from './spool-reader.ts';
import { whatsAppMediaFileStem } from './live-connector.ts';

const ENTRY_SUFFIX = '.json';
const GRANT_SUFFIX = '.grant';
/** An entry is a few hundred bytes; anything far larger is not the bridge's. */
const ENTRY_MAX_BYTES = 64 * 1024;
/** A grant temp a killed pull left behind is removed once it is this old. */
const GRANT_TEMP_AGE_MS = 60_000;
const GRANT_TEMP = /^\..+\.grant\.tmp-[0-9a-f]+$/u;

export interface WhatsAppMediaGrantResult {
  granted: number;
  revoked: number;
}

/**
 * Grants every waiting entry whose message is judged not Secrets, and takes
 * back a grant whose message is now judged Secrets or whose entry is gone.
 * `committed` is the place the tier set has committed to: a line at or past it
 * is not judged yet. A folder that is not there holds nothing to grant.
 */
export function grantWhatsAppWaitingMedia(options: {
  waitingDir: string;
  spoolDir: string;
  account: string;
  ledger: TierLedger;
  committed: SpoolPlace | undefined;
  nowMs?: number;
}): WhatsAppMediaGrantResult {
  const result: WhatsAppMediaGrantResult = { granted: 0, revoked: 0 };
  let names: string[];
  try {
    names = readdirSync(options.waitingDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return result;
    throw error;
  }
  const nowMs = options.nowMs ?? Date.now();
  const entries = new Set(names.filter((name) => name.endsWith(ENTRY_SUFFIX) && !name.startsWith('.')).map((name) => name.slice(0, -ENTRY_SUFFIX.length)));
  for (const name of names) {
    const path = join(options.waitingDir, name);
    if (GRANT_TEMP.test(name)) {
      if (olderThan(path, nowMs, GRANT_TEMP_AGE_MS)) removeIfThere(path);
      continue;
    }
    // A grant whose entry is gone must never meet a later entry of the same message.
    if (name.endsWith(GRANT_SUFFIX) && !entries.has(name.slice(0, -GRANT_SUFFIX.length))) {
      removeIfThere(path);
      result.revoked += 1;
    }
  }
  if (entries.size === 0) return result;
  const index = WhatsAppSpoolIndex.open(options.spoolDir);
  try {
    for (const stem of entries) {
      const entry = readEntry(join(options.waitingDir, `${stem}${ENTRY_SUFFIX}`));
      if (!entry || whatsAppMediaFileStem(entry.chatJid, entry.id) !== stem) continue;
      const grantPath = join(options.waitingDir, `${stem}${GRANT_SUFFIX}`);
      const identity = { provider: 'whatsapp', accountScope: options.account, providerItemId: entry.id, providerConversationId: entry.chatJid };
      const message = options.ledger.getCurrent(identity);
      const media = options.ledger.getCurrent({ ...identity, providerItemId: childProviderItemId(entry.id, 'media') });
      if (isSecret(message) || isSecret(media)) {
        if (removeIfThere(grantPath)) result.revoked += 1;
        continue;
      }
      // The media child stays pending until its download is judged: only the message must be judged first.
      if (!judged(message) || exists(grantPath)) continue;
      const located = index?.newestMessage(entry.id, entry.chatJid);
      if (!located || !options.committed || comparePlaces(located, options.committed) >= 0) continue;
      const line = lineAt(join(options.spoolDir, located.file), located.offset);
      if (line === undefined || sha256(line) !== entry.lineSha256) continue;
      if (writeGrant(options.waitingDir, stem, JSON.stringify({ line_sha256: entry.lineSha256, line }))) result.granted += 1;
    }
  } finally {
    index?.close();
  }
  return result;
}

interface WaitingEntry {
  lineSha256: string;
  chatJid: string;
  id: string;
}

function readEntry(path: string): WaitingEntry | undefined {
  try {
    if (statSync(path).size > ENTRY_MAX_BYTES) return undefined;
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const lineSha256 = raw['line_sha256'];
    const chatJid = raw['chat_jid'];
    const id = raw['id'];
    if (typeof lineSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(lineSha256)) return undefined;
    if (typeof chatJid !== 'string' || typeof id !== 'string' || chatJid === '' || id === '') return undefined;
    return { lineSha256, chatJid, id };
  } catch {
    // Gone, or caught mid-write: the next pull reads it again.
    return undefined;
  }
}

/**
 * Judged Secrets, or on the way there: never granted. A record the ledger
 * does not hold is not Secrets, but neither is it judged.
 */
function isSecret(record: TierLedgerRecord | undefined): boolean {
  if (!record) return false;
  return record.metadataTier === 'secrets' || record.contentTier === 'secrets'
    || record.targetMetadataTier === 'secrets' || record.targetContentTier === 'secrets';
}

function judged(record: TierLedgerRecord | undefined): boolean {
  return record !== undefined && !record.metadataPending && !record.contentPending;
}

/** The line at a place in a spool file, as the bridge wrote it (without its newline). */
function lineAt(path: string, offset: number): string | undefined {
  for (const record of spoolRecords(path, offset, WHATSAPP_SPOOL_MAX_RECORD_BYTES, { bytesLeft: WHATSAPP_SPOOL_MAX_RECORD_BYTES })) {
    return record.kind === 'line' ? record.text : undefined;
  }
  return undefined;
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Writes a grant whole before it can be seen: a temp written and fsynced,
 * then linked to its name, which fails when a grant is already there.
 */
function writeGrant(dir: string, stem: string, payload: string): boolean {
  const temp = join(dir, `.${stem}${GRANT_SUFFIX}.tmp-${randomBytes(8).toString('hex')}`);
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
      linkSync(temp, join(dir, `${stem}${GRANT_SUFFIX}`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    fsyncDir(dir);
    return true;
  } finally {
    removeIfThere(temp);
  }
}

function fsyncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function exists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function olderThan(path: string, nowMs: number, ageMs: number): boolean {
  try {
    return nowMs - statSync(path).mtimeMs >= ageMs;
  } catch {
    return false;
  }
}

/** Removes a file; true when it was there. Anything but its being gone fails the pass. */
function removeIfThere(path: string): boolean {
  try {
    rmSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
