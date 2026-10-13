/**
 * Clearing Secrets out of a capture spool: the append-only JSONL backlog a
 * messaging lane keeps on disk beside its stores.
 *
 * The stores hold a Secret item nowhere (only its location, in the secret
 * locations index). A spool is the raw copy the stores were filled from, so
 * without this a message Olympus judged Secret would still sit, word for
 * word, in the spool. Once an item is judged Secrets, its spool records keep
 * their place but lose their text.
 *
 * What a spool's readers rely on, and how each is kept:
 *
 *   - Cursors are `<file>:<line count>`. A record is rewritten IN PLACE and
 *     padded with spaces to its original byte length, so no line moves, no
 *     newline moves and no file changes size. A capture process appending at
 *     the end, or trimming a torn tail back to the last newline, never meets
 *     a byte this module wrote.
 *   - Identity and dedup fields stay: a redacted record still names its
 *     message, version and capture, and carries a redaction flag the lane's
 *     connector reads as a Secrets floor, so a replay or a rebuilt store
 *     judges the item Secrets again instead of indexing a text-less copy.
 *   - A record that cannot be redacted within its own length becomes a blank
 *     line, which every reader already skips.
 *
 * Who judges is the tier ledger (the item's recorded tiers) and, for records
 * the ledger cannot speak for (an earlier version of an edited message, an
 * item the set never routed), the Secrets floor itself on the record's own
 * text, unless the owner set that item's tier by hand. Redaction follows the
 * one Secrets policy (secrets-disposition.ts): only when Secrets copies are
 * tombstoned at once is the spool copy removed at once too.
 *
 * This module names no source family; each lane supplies how its records are
 * read and redacted. Doc comments here are always multi-line blocks.
 */

import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, readSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { detectSecretFindingKinds } from '../classification/engine.ts';
import type { TierLedger, TierLedgerIdentity } from '../classification/tier-ledger.ts';
import { secretsDisposition } from './secrets-disposition.ts';

/**
 * How much of a record goes. `content`: the text (and anything that would
 * fetch it again). `names`: the text and the names too, because the names
 * themselves were judged Secrets.
 */
export type SpoolSecretRedaction = 'content' | 'names';

export type SpoolSecretJudge = (
  identity: TierLedgerIdentity,
  text: string | undefined,
) => SpoolSecretRedaction | undefined;

/**
 * A position in a spool: a file name and the number of its lines already
 * consumed. The same shape both lanes' cursors spell as `<file>:<lines>`.
 */
export interface CaptureSpoolPosition {
  file: string;
  line: number;
}

export interface CaptureSpoolRedactionResult {
  /**
   * Records rewritten without their text.
   */
  recordsRedacted: number;
  /**
   * Records that could not be redacted within their length and were blanked.
   */
  recordsBlanked: number;
}

/**
 * Rewrite, in place, every complete line in `[from, through)` for which
 * `redact` returns a replacement. `files` are the spool's file names in
 * order. A line still being written (no newline yet) is never touched, and
 * a line that changed on disk between the read and the write is left alone.
 */
export function redactCaptureSpoolLines(options: {
  dir: string;
  files: readonly string[];
  from?: CaptureSpoolPosition;
  through?: CaptureSpoolPosition;
  redact: (line: string) => string | undefined;
}): CaptureSpoolRedactionResult {
  const result: CaptureSpoolRedactionResult = { recordsRedacted: 0, recordsBlanked: 0 };
  for (const name of options.files) {
    if (options.from && name < options.from.file) continue;
    if (options.through && name > options.through.file) break;
    const path = join(options.dir, name);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const bytes = readFileSync(path);
    const startLine = options.from?.file === name ? options.from.line : 0;
    const endLine = options.through?.file === name ? options.through.line : Number.POSITIVE_INFINITY;
    const edits: Array<{ offset: number; original: Buffer; replacement: Buffer; blanked: boolean }> = [];
    let offset = 0;
    let lineIndex = 0;
    while (offset < bytes.length && lineIndex < endLine) {
      const newline = bytes.indexOf(0x0a, offset);
      if (newline < 0) break;
      if (lineIndex >= startLine) {
        // A carriage return before the newline stays where it is.
        const contentEnd = newline > offset && bytes[newline - 1] === 0x0d ? newline - 1 : newline;
        const original = bytes.subarray(offset, contentEnd);
        const line = original.toString('utf8');
        const replacementText = line.trim() ? options.redact(line) : undefined;
        if (replacementText !== undefined) {
          const encoded = Buffer.from(replacementText, 'utf8');
          const fits = encoded.length <= original.length && !encoded.includes(0x0a);
          const replacement = Buffer.alloc(original.length, 0x20);
          if (fits) encoded.copy(replacement);
          edits.push({ offset, original: Buffer.from(original), replacement, blanked: !fits });
        }
      }
      offset = newline + 1;
      lineIndex += 1;
    }
    if (edits.length === 0) continue;
    const fd = openSync(path, 'r+');
    try {
      for (const edit of edits) {
        const current = Buffer.alloc(edit.original.length);
        readSync(fd, current, 0, current.length, edit.offset);
        if (!current.equals(edit.original)) continue;
        writeSync(fd, edit.replacement, 0, edit.replacement.length, edit.offset);
        if (edit.blanked) result.recordsBlanked += 1;
        else result.recordsRedacted += 1;
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  return result;
}

/**
 * Whether a spool record must lose its text, and how much of it.
 *
 * The ledger first: names judged Secrets take the names too; content judged
 * Secrets takes the text. With `floor`, the record's own text is judged by
 * the Secrets floor as well, for records whose item the ledger does not
 * describe (an older version of an edited message, an item never routed);
 * an owner's per-item tier decides instead, as it does for the classifier.
 * Off entirely while the Secrets policy keeps copies for a purge.
 */
export function createSpoolSecretJudge(options: {
  ledger: TierLedger | undefined;
  floor: boolean;
}): SpoolSecretJudge {
  if (secretsDisposition() !== 'tombstone_now') return () => undefined;
  const ledger = options.ledger;
  return (identity, text) => {
    const record = ledger?.getCurrent(identity);
    if (record?.metadataTier === 'secrets') return 'names';
    if (record?.contentTier === 'secrets') return 'content';
    if (!options.floor || !text?.trim()) return undefined;
    if (ledger?.getOverride(identity)) return undefined;
    return detectSecretFindingKinds(text).length > 0 ? 'content' : undefined;
  };
}

/**
 * Bumped when the sweep must run over the whole spool once more, judging
 * every record's text as well (the first run on a host clears what was
 * captured before redaction existed).
 */
export const CAPTURE_SPOOL_SWEEP_VERSION = 1;

/**
 * Where a lane's full-spool pass stands, kept beside the ledger: the sweep
 * version it last completed and a digest of the Secrets it cleared for.
 */
interface SpoolSweepState {
  version: number;
  secrets: string;
}

/**
 * Run a full-spool pass when it has something to do: once per sweep version
 * (judging text with the floor too), and again whenever the ledger's set of
 * Secrets items changed since the last pass (ledger judgment only). That
 * second case is an owner marking an old message Secret, a chat rule turning
 * a whole chat Secret, or a voice note whose transcript was judged Secrets
 * after its record was read. `sweep` does the lane's own redaction with the
 * judge it is handed; the state is written only after it returns.
 */
export function sweepCaptureSpoolWhenSecretsChange(options: {
  ledger: TierLedger;
  stateKey: string;
  sweep: (judge: SpoolSecretJudge) => CaptureSpoolRedactionResult;
}): CaptureSpoolRedactionResult | undefined {
  if (secretsDisposition() !== 'tombstone_now') return undefined;
  const digest = secretsDigest(options.ledger);
  const state = readSweepState(options.ledger, options.stateKey);
  const versionDue = state?.version !== CAPTURE_SPOOL_SWEEP_VERSION;
  if (!versionDue && state?.secrets === digest) return undefined;
  const result = options.sweep(createSpoolSecretJudge({ ledger: options.ledger, floor: versionDue }));
  const next: SpoolSweepState = { version: CAPTURE_SPOOL_SWEEP_VERSION, secrets: digest };
  options.ledger.writeMeta(options.stateKey, JSON.stringify(next));
  return result;
}

/**
 * Add redaction results.
 */
export function addCaptureSpoolRedactions(
  ...results: readonly (CaptureSpoolRedactionResult | undefined)[]
): CaptureSpoolRedactionResult {
  return results.reduce<CaptureSpoolRedactionResult>((total, result) => ({
    recordsRedacted: total.recordsRedacted + (result?.recordsRedacted ?? 0),
    recordsBlanked: total.recordsBlanked + (result?.recordsBlanked ?? 0),
  }), { recordsRedacted: 0, recordsBlanked: 0 });
}

function secretsDigest(ledger: TierLedger): string {
  const hash = createHash('sha256');
  for (const identity of ledger.secretsIdentities()) {
    hash.update([
      identity.provider,
      identity.accountScope,
      identity.providerConversationId ?? '',
      identity.providerItemId,
    ].join('\u001f'));
    hash.update('\u001e');
  }
  return hash.digest('hex');
}

function readSweepState(ledger: TierLedger, key: string): SpoolSweepState | undefined {
  const raw = ledger.readMeta(key);
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Partial<SpoolSweepState>;
    return typeof parsed.version === 'number' && typeof parsed.secrets === 'string'
      ? { version: parsed.version, secrets: parsed.secrets }
      : undefined;
  } catch {
    return undefined;
  }
}
