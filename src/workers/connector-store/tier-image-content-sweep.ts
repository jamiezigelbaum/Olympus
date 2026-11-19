// Picture content stored before pictures became Private-only (2026-10-07,
// docs/design/photo-embeddings.md). Source-agnostic: it reads only the tier
// ledger and each copy's stored media type.
//
// A still image's text (OCR) that a set already holds in a Personal or Public
// store, and whose picture the photo judge has not found ordinary
// (tier-media-judgment-sweep.ts), is moved to the Private store: its content decision is raised to
// Private with the image reason and the move is queued exactly as an owner
// rule's raise is (`recordRoutedPlacement`, hidden first). An item the owner
// placed by a per-item override stays where the owner put it. Items in those
// stores the set never routed (stored before per-item routing) cannot be
// moved, so their picture content is stripped; the names stay. A bounded page
// per call, resumed from the ledger; once complete it never runs again.

import {
  IMAGE_PRIVATE_DEFAULT_REASON,
  isImageMediaType,
  maxTier,
  UNDECIDED_TIER_SNIFFER,
  type TierDecision,
} from '../classification/tier-classifier.ts';
import { copyServingLayer, type TierLedgerIdentity, type TierLedgerRecord } from '../classification/tier-ledger.ts';
import { find, findInLedger, runPassHere, runPassOffThread, turn, type LoopPass } from './loop-pass.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

const SWEEP_META_KEY = 'image_content_private_sweep';
export const DEFAULT_IMAGE_CONTENT_SWEEP_ROWS = 1_000;

export interface ImageContentSweepReport {
  scanned: number;
  /** Routed images whose content was raised to Private (a move queued). */
  raised: number;
  /** Unrouted images whose content was stripped from a non-Private store. */
  stripped: number;
  complete: boolean;
}

/** Stripped between turns: each item is one store write. */
const STRIP_BATCH = 50;

/** The sweep on its caller's connection (a direct caller, not the engine's loop). */
export function sweepImageContentToPrivate(options: { set: TieredStoreSet; limit?: number }): ImageContentSweepReport {
  return runPassHere(imageContentSweepPass(options));
}

/** The sweep on the engine's loop: rows are found on the read workers, a turn between the rows it writes. */
export function sweepImageContentToPrivateOffThread(options: { set: TieredStoreSet; limit?: number; turn?: () => Promise<void> | undefined }): Promise<ImageContentSweepReport> {
  return runPassOffThread(imageContentSweepPass(options), { family: 'image-content-sweep', ...(options.turn ? { turn: options.turn } : {}) });
}

function* imageContentSweepPass(options: { set: TieredStoreSet; limit?: number }): LoopPass<ImageContentSweepReport> {
  const report: ImageContentSweepReport = { scanned: 0, raised: 0, stripped: 0, complete: true };
  const { set } = options;
  const ledger = set.ledger;
  const state = readState(ledger.readMeta(SWEEP_META_KEY));
  if (state.done) return report;
  // An image that can't be judged yet (a move in flight, a failure) is held
  // and tried again before the sweep is recorded as done, so its raise is
  // delayed, never skipped. Too many to remember: the walk starts over.
  const held: TierLedgerIdentity[] = [];
  let overflow = state.overflow === true;
  const attempt = (identity: TierLedgerIdentity): void => {
    // Found on an older snapshot (or held): judged from the row as it is now, by key.
    const record = ledger.getCurrent(identity);
    if (!record?.routed) return;
    let outcome: boolean | 'deferred';
    try {
      outcome = record.state === 'moving' ? 'deferred' : raiseIfImage(set, record);
    } catch {
      outcome = 'deferred';
    }
    if (outcome === true) report.raised += 1;
    else if (outcome === 'deferred') {
      if (held.length < MAX_HELD_IMAGES) held.push(identity);
      else overflow = true;
    }
  };
  const save = (next: SweepState) => ledger.writeSettleProgress(SWEEP_META_KEY, JSON.stringify(next));
  if (state.retry) {
    for (const identity of state.held ?? []) {
      yield* turn();
      report.scanned += 1;
      attempt(identity);
    }
  } else {
    const limit = Math.max(1, options.limit ?? DEFAULT_IMAGE_CONTENT_SWEEP_ROWS);
    const rows = yield* findInLedger(ledger, () => ledger.listRoutedSteps({ ...(state.after ? { after: state.after } : {}), limit }));
    held.push(...(state.held ?? []));
    for (const found of rows) {
      yield* turn();
      report.scanned += 1;
      attempt(identityOf(found));
    }
    if (rows.length >= limit) {
      report.complete = false;
      save({ done: false, after: identityOf(rows.at(-1)!), held, ...(overflow ? { overflow: true } : {}) });
      return report;
    }
  }
  for (const domain of ['public_safe', 'internal'] as const) {
    const store = set.store(domain);
    if (!store) continue;
    const found = yield* find({ here: () => store.imageContentOutsidePrivateRows(), offThread: () => store.imageContentOutsidePrivateRowsOffThread() });
    for (let at = 0; at < found.length; at += STRIP_BATCH) {
      yield* turn();
      report.stripped += store.stripImageContentRows(found.slice(at, at + STRIP_BATCH), { keep: (identity) => ledger.isRouted(identity) });
    }
  }
  // Stripping never waits on a held image; only the sweep's done does.
  if (held.length > 0 || overflow) {
    report.complete = false;
    save(overflow ? { done: false } : { done: false, held, retry: true });
    return report;
  }
  // The strips are durable before the ledger (FULL) records them done.
  for (const domain of ['public_safe', 'internal'] as const) set.store(domain)?.durabilityBarrier();
  save({ done: true });
  return report;
}

function raiseIfImage(set: TieredStoreSet, record: TierLedgerRecord): boolean {
  if (record.state === 'moving' || record.contentTier === 'secrets' || record.metadataTier === 'secrets') return false;
  if (record.contentTier === 'secure') return false;
  const identity = identityOf(record);
  if (set.ledger.getOverride(identity)) return false;
  const current = set.ledger.copies(identity).filter((copy) => copy.state === 'current');
  const content = copyServingLayer(current, 'content');
  const domain = content ? set.domainForCorpus(content.corpusId) : undefined;
  if (!domain || domain === 'secure_local') return false;
  const exported = set.store(domain)?.exportItemCopy(identity);
  if (!exported || exported.chunks.length === 0) return false;
  const mimeType = exported.columns['mime_type'];
  if (typeof mimeType !== 'string' || !isImageMediaType(mimeType)) return false;
  // A picture the photo judge found ordinary rests where its tier puts it.
  if (exported.chunks.some((chunk) => chunk.mediaJudgment?.verdict === 'ordinary')) return false;
  const decision: TierDecision = {
    metadataTier: record.metadataTier,
    contentTier: maxTier(record.contentTier, 'secure'),
    decidedBy: 'default',
    reasons: [...record.reasons.filter((reason) => !reason.startsWith('content:')), IMAGE_PRIVATE_DEFAULT_REASON],
    state: record.metadataPending ? 'pending' : 'current',
    contentRead: true,
    metadataPending: record.metadataPending,
    contentPending: false,
    metadataForced: record.metadataForced,
    metadataFlagged: record.metadataFlagged,
    engineVersion: record.engineVersion,
    mapRevision: record.mapRevision,
    snifferId: UNDECIDED_TIER_SNIFFER.id,
  };
  set.ledger.recordRoutedPlacement(identity, decision, set.placementFor(decision));
  return true;
}

/** Images held for a retry at most; past it the walk starts over. */
const MAX_HELD_IMAGES = 1_000;

interface SweepState {
  done: boolean;
  after?: TierLedgerIdentity;
  held?: TierLedgerIdentity[];
  retry?: boolean;
  overflow?: boolean;
}

function readState(raw: string | undefined): SweepState {
  if (!raw) return { done: false };
  try {
    const parsed = JSON.parse(raw) as { done?: unknown; after?: TierLedgerIdentity; held?: unknown; retry?: unknown; overflow?: unknown };
    return {
      done: parsed.done === true,
      ...(parsed.after ? { after: parsed.after } : {}),
      ...(Array.isArray(parsed.held) ? { held: parsed.held as TierLedgerIdentity[] } : {}),
      ...(parsed.retry === true ? { retry: true } : {}),
      ...(parsed.overflow === true ? { overflow: true } : {}),
    };
  } catch {
    return { done: false };
  }
}

function identityOf(record: TierLedgerRecord): TierLedgerIdentity {
  return {
    provider: record.provider,
    accountScope: record.accountScope,
    providerItemId: record.providerItemId,
    ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}),
  };
}
