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

export function sweepImageContentToPrivate(options: { set: TieredStoreSet; limit?: number }): ImageContentSweepReport {
  const report: ImageContentSweepReport = { scanned: 0, raised: 0, stripped: 0, complete: true };
  const { set } = options;
  const ledger = set.ledger;
  const state = readState(ledger.readMeta(SWEEP_META_KEY));
  if (state.done) return report;
  const limit = Math.max(1, options.limit ?? DEFAULT_IMAGE_CONTENT_SWEEP_ROWS);
  const rows = ledger.listRouted({ ...(state.after ? { after: state.after } : {}), limit });
  for (const record of rows) {
    report.scanned += 1;
    try {
      if (raiseIfImage(set, record)) report.raised += 1;
    } catch {
      // Left as it was; the item's next landing judges it as an image.
    }
  }
  if (rows.length >= limit) {
    report.complete = false;
    ledger.writeMeta(SWEEP_META_KEY, JSON.stringify({ done: false, after: identityOf(rows.at(-1)!) }));
    return report;
  }
  for (const domain of ['public_safe', 'internal'] as const) {
    const store = set.store(domain);
    if (!store) continue;
    report.stripped += store.stripImageContentOutsidePrivate({ keep: (identity) => ledger.isRouted(identity) });
  }
  ledger.writeMeta(SWEEP_META_KEY, JSON.stringify({ done: true }));
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

function readState(raw: string | undefined): { done: boolean; after?: TierLedgerIdentity } {
  if (!raw) return { done: false };
  try {
    const parsed = JSON.parse(raw) as { done?: unknown; after?: TierLedgerIdentity };
    return { done: parsed.done === true, ...(parsed.after ? { after: parsed.after } : {}) };
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
