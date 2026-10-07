// Re-home Private rows that sit in a non-secure store (owner approval
// 2026-10-07: moved items are re-embedded by the local Private embedder).
// Source-agnostic: it reads only each store's own stored row tiers and the
// tier ledger, never a source.
//
// A row that is Private by its OWN stored tier (S4, S4+) belongs in the
// Private (secure_local) store. Classification never pairs S4 with Personal or
// Public, but a raise queued without hiding on an install whose Personal
// embedder is a cloud model (the moves wait for `olympus tier migrate`), a
// failed or interrupted move, or a content fetch that raised the stored tier
// (`trust_domain_mismatch`) leave one behind. No trigger read a row's own
// tier, so nothing moved it; the embedding backstop (PR #150) only withholds
// it from the cloud embedder. This pass closes that loop:
//
// 1. Scan a bounded window of each non-secure store for S4+ rows (cursor in
//    the set ledger; no trust_tier index, so the scan is bounded by item_pk).
// 2. Skip what is not ours to move: owner overrides, force-decided names,
//    items mid-move, Secrets, items with an open question, rows whose current
//    copy is elsewhere, and any store whose placement policy itself rests
//    items at a Private tier (no ping-pong with a lane that pairs them).
// 3. A legacy row is adopted first (the ledger names the copy that serves it
//    today, nothing becomes visible or hidden), then queued as a raise
//    WITHOUT hiding: the item stays searchable where it is until its move.
// 4. The raises this pass queued are carried out here, bounded per
//    call, so no install waits for the migration. The move primitive hides the
//    source first, copies the rows, and leaves the chunks to the Private
//    store's own embedder (zero provider calls in the move itself). Each move
//    appends its embedding-ledger note. Failed moves are retried next call
//    (to the back of the queue).
//
// Never throws; a store that cannot be read keeps its rows this call.

import { BUILT_IN_EMBEDDING_PROVIDER } from '../source-index/built-in-embedding/provider.ts';
import type { SourceTrustDomain } from '../../core/source-index/types.ts';
import { isSecureTrustTier } from '../../core/source-index/types.ts';
import type { TierDecision } from '../classification/tier-classifier.ts';
import {
  copyServingLayer,
  TierLedgerGenerationConflictError,
  tierLedgerIdentityKey,
  trustDomainRank,
  type TierLedgerIdentity,
  type TierLedgerRecord,
} from '../classification/tier-ledger.ts';
import { EMBEDDING_LEDGER_OWNER_APPROVAL, resolveEmbeddingLedgerPath } from '../embedding-ledger.ts';
import { moveTieredItem, TierMoveRefusedError } from './tier-move.ts';
import type { TieredStoreSet } from './tiered-store-set.ts';

/** item_pk values scanned per store per call. */
export const DEFAULT_ROW_REHOME_SCAN_WINDOW = 2_000;
/** Candidate rows examined per store per call. */
export const DEFAULT_ROW_REHOME_CANDIDATES = 100;
/** Moves carried out per call, per set. */
export const DEFAULT_ROW_REHOME_MOVES = 25;
export const ROW_REHOME_REASON = 'row_tier:private_rehome';

const CURSOR_KEY_PREFIX = 'private_row_rehome_after:';
const NON_SECURE_DOMAINS: readonly SourceTrustDomain[] = ['public_safe', 'internal'];

const MOVE_WHY = 'Automatic re-home of a Private row found in a Personal or Public store: the owner approved on 2026-10-07 '
  + 'that moved items are re-embedded by the local Private embedder (the move itself makes no provider call).';

export interface TierRowRehomeReport {
  /** Candidate S4+ rows examined. */
  examined: number;
  /** Legacy rows whose current placement was recorded first. */
  adopted: number;
  /** Raises queued (the item stays visible until its move). */
  queued: number;
  /** Moves carried out. */
  moved: number;
  /** Moves that failed (retried next call). */
  failed: number;
  /** Rows left alone: overrides, forced names, mid-move, Secrets, open questions, copy elsewhere. */
  skipped: number;
  /** Stores skipped because their placement policy rests items at a Private tier. */
  guardedStores: number;
  /** Queued raises left for the owner-approved migration (the Private embedder is not known to be local). */
  awaitingMigration: number;
  /** Moves the destination refuses for good (it keeps different text); recorded once, never retried. */
  refused: number;
}

export interface TierRowRehomeOptions {
  set: TieredStoreSet;
  scanWindow?: number;
  candidates?: number;
  maxMoves?: number;
  /** Where each move's embedding-ledger note goes. Default: the install's ledger. */
  embeddingLedgerPath?: string;
}

export function emptyTierRowRehomeReport(): TierRowRehomeReport {
  return { examined: 0, adopted: 0, queued: 0, moved: 0, failed: 0, skipped: 0, guardedStores: 0, awaitingMigration: 0, refused: 0 };
}

export async function rehomePrivateTierRows(options: TierRowRehomeOptions): Promise<TierRowRehomeReport> {
  const report = emptyTierRowRehomeReport();
  const { set } = options;
  const ledger = set.ledger;
  const window = Math.max(1, options.scanWindow ?? DEFAULT_ROW_REHOME_SCAN_WINDOW);
  const limit = Math.max(1, options.candidates ?? DEFAULT_ROW_REHOME_CANDIDATES);
  // Moves this pass queued earlier that the scan met again (found in the store, not through the queue).
  const ours: TierLedgerIdentity[] = [];

  for (const domain of NON_SECURE_DOMAINS) {
    try {
      const store = set.store(domain);
      if (!store) continue;
      // A lane that rests its items at a Private tier in this domain pairs S4
      // with the store by design: re-homing them would fight the lane.
      if (domainRestsAtPrivateTier(set, domain)) {
        report.guardedStores += 1;
        continue;
      }
      const key = `${CURSOR_KEY_PREFIX}${store.corpusId}`;
      const stored = Number.parseInt(ledger.readMeta(key) ?? '', 10);
      const page = store.privateTierRowWindow({
        ...(Number.isFinite(stored) && stored > 0 ? { after: stored } : {}),
        window,
        limit,
      });
      ledger.writeMeta(key, page.next === undefined ? '' : String(page.next));
      for (const row of page.rows) {
        report.examined += 1;
        try {
          considerRow(set, domain, row.identity, report, ours);
        } catch {
          // Left where it is; a later call tries again.
          report.skipped += 1;
        }
      }
    } catch {
      // An unreadable store keeps its rows this call.
    }
  }

  await runQueuedMoves(options, report, ours);
  set.recordRowRehomeReport(report);
  return report;
}

function domainRestsAtPrivateTier(set: TieredStoreSet, domain: SourceTrustDomain): boolean {
  if (isSecureTrustTier(set.restingTierFor(domain))) return true;
  // The placement policy itself: a Private decision must land in a store
  // more private than this one, or the pairing is deliberate.
  const placement = set.placementFor({
    metadataTier: 'secure',
    contentTier: 'secure',
    state: 'current',
    metadataPending: false,
    contentPending: false,
    contentRead: true,
  });
  return placement.copies.every((copy) => trustDomainRank(copy.trustDomain) <= trustDomainRank(domain));
}

function considerRow(
  set: TieredStoreSet,
  domain: SourceTrustDomain,
  row: { provider: string; accountScope: string; providerItemId: string; providerConversationId?: string; family: string },
  report: TierRowRehomeReport,
  ours: TierLedgerIdentity[],
): void {
  const ledger = set.ledger;
  const store = set.store(domain)!;
  const identity: TierLedgerIdentity = {
    provider: row.provider,
    accountScope: row.accountScope,
    providerItemId: row.providerItemId,
    ...(row.providerConversationId ? { providerConversationId: row.providerConversationId } : {}),
  };
  if (ledger.getOverride(identity) || ledger.rejudgeQuestion(identity)) return void (report.skipped += 1);
  let record = ledger.getCurrent(identity);
  // Our own queued raise, met again through its store row: the queue may be
  // too long to reach it, so the scan hands it to the move step.
  if (record?.routed && record.state === 'moving' && record.reasons.includes(ROW_REHOME_REASON)) {
    ours.push(identity);
    return void (report.skipped += 1);
  }
  if (record && (openQuestion(record) || record.state === 'moving' || forced(record) || record.contentTier === 'secrets' || record.metadataTier === 'secrets')) {
    return void (report.skipped += 1);
  }
  if (record?.routed) {
    // Only a row that is this item's CURRENT copy is the item; a superseded
    // or staged copy kept here is not.
    const here = ledger.copies(identity).some((copy) => copy.state === 'current' && copy.corpusId === store.corpusId);
    if (!here) return void (report.skipped += 1);
  } else {
    // Legacy: a store the lane always had, with no routed copy rows yet.
    if (set.legSpec(domain)?.legacy !== true) return void (report.skipped += 1);
    store.bindTierSet(ledger);
    record = ledger.adoptLegacyPlacement(
      identity,
      [{ corpusId: store.corpusId, trustDomain: domain, layers: 'both' }],
      {
        whenMissing: {
          family: row.family,
          metadataTier: domain === 'public_safe' ? 'public' : 'private',
          contentTier: domain === 'public_safe' ? 'public' : 'private',
        },
      },
    );
    report.adopted += 1;
  }
  const decision: TierDecision = {
    metadataTier: 'secure',
    contentTier: 'secure',
    decidedBy: 'sensitive_detector',
    reasons: [...record!.reasons.filter((reason) => reason !== ROW_REHOME_REASON), ROW_REHOME_REASON],
    state: 'current',
    contentRead: record!.contentRead,
    metadataPending: false,
    contentPending: false,
    metadataForced: false,
    metadataFlagged: record!.metadataFlagged,
    engineVersion: record!.engineVersion,
    mapRevision: record!.mapRevision,
    snifferId: 'undecided',
  };
  const plan = set.placementFor(decision);
  // Nowhere more private to go: nothing to queue (the embedding backstop still
  // keeps the row out of a cloud embedder).
  if (!plan.copies.some((copy) => trustDomainRank(copy.trustDomain) > trustDomainRank(domain))) {
    return void (report.skipped += 1);
  }
  // Queue WITHOUT hiding: the item stays searchable where it is until the
  // move (which hides its source first) runs, in this same call.
  const recorded = ledger.recordRoutedPlacement(identity, decision, plan, { queueWithoutHiding: true });
  if (recorded.outcome === 'queued_move') report.queued += 1;
  else report.skipped += 1;
}

const REFUSED_META_KEY = 'private_row_rehome_refused';
const REFUSED_META_LIMIT = 200;

function readRefused(ledger: TieredStoreSet['ledger']): string[] {
  try {
    const parsed = JSON.parse(ledger.readMeta(REFUSED_META_KEY) ?? '[]') as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
  } catch {
    return [];
  }
}

function isOurQueuedRaise(record: TierLedgerRecord): boolean {
  return record.routed
    && record.state === 'moving'
    && record.targetMetadataTier !== null && record.targetContentTier !== null
    && record.targetMetadataTier !== 'secrets' && record.targetContentTier !== 'secrets'
    // Only the raises this pass queued (its reason code is on the queued
    // decision): every other queued move keeps its own path and approval.
    && record.reasons.includes(ROW_REHOME_REASON)
    && (record.targetMetadataTier === 'secure' || record.targetContentTier === 'secure');
}

async function runQueuedMoves(
  options: TierRowRehomeOptions,
  report: TierRowRehomeReport,
  found: readonly TierLedgerIdentity[],
): Promise<void> {
  const { set } = options;
  const ledger = set.ledger;
  let budget = Math.max(0, options.maxMoves ?? DEFAULT_ROW_REHOME_MOVES);
  if (budget === 0) return;
  // The ledger's queue has no filter or cursor to export, so the widest page it
  // allows is read and filtered; anything past it is reached through the scan
  // (`found`: our queued rows met again in their store), which cycles the whole
  // table over successive calls. Unrelated queued moves cannot starve ours.
  const work = new Map<string, TierLedgerRecord>();
  try {
    for (const record of ledger.listMoving({ limit: 5_000 })) {
      if (isOurQueuedRaise(record)) work.set(tierLedgerIdentityKey(identityOfRecord(record)), record);
    }
    for (const identity of found) {
      const key = tierLedgerIdentityKey(identity);
      const record = work.has(key) ? undefined : ledger.getCurrent(identity);
      if (record && isOurQueuedRaise(record)) work.set(key, record);
    }
  } catch {
    return;
  }
  if (work.size === 0) return;
  // The approval covers the LOCAL Private embedder. Anything not known to be
  // local (a cloud model, or an embedder this set cannot resolve) keeps its
  // queued moves for the migration, which prices them.
  if (set.privateEmbedderBackend() !== 'local') {
    report.awaitingMigration += work.size;
    return;
  }
  const builtInOnly = setEmbedsWithBuiltInOnly(set);
  const embeddingLedgerPath = options.embeddingLedgerPath ?? resolveEmbeddingLedgerPath(process.env);
  const refused = new Set(readRefused(ledger));
  for (const queued of work.values()) {
    if (budget === 0) break;
    const identity = identityOfRecord(queued);
    const refusedKey = `${tierLedgerIdentityKey(identity)}#${queued.generation}`;
    if (refused.has(refusedKey)) {
      report.refused += 1;
      continue;
    }
    try {
      // Re-check everything against the ledger right now, not the queue-time record.
      const record = ledger.getCurrent(identity);
      if (!record || !isOurQueuedRaise(record) || record.generation !== queued.generation
        || ledger.getOverride(identity) || ledger.rejudgeQuestion(identity)
        || record.targetMetadataTier !== queued.targetMetadataTier || record.targetContentTier !== queued.targetContentTier) {
        report.skipped += 1;
        continue;
      }
      const sources = ledger.copies(identity).filter((copy) => copy.state === 'current'
        || (copy.state === 'superseded' && copy.supersededByGeneration === record.generation + 1));
      // Already (at least partly) in the Private store, or nothing to move from.
      if (sources.length === 0 || sources.every((copy) => copy.trustDomain === 'secure_local')) continue;
      budget -= 1;
      const source = copyServingLayer(sources, 'content') ?? sources[0]!;
      const exported = set.store(source.trustDomain)?.exportItemCopy(identity);
      if (!exported) throw new Error('no current copy');
      await moveTieredItem({
        set,
        identity: { ...identity, family: exported.identity.family, localItemId: exported.identity.localItemId },
        target: { metadataTier: record.targetMetadataTier!, contentTier: record.targetContentTier! },
        embeddingLedger: { path: embeddingLedgerPath, approvedBy: EMBEDDING_LEDGER_OWNER_APPROVAL, why: MOVE_WHY },
        expectedGeneration: record.generation,
        ...(builtInOnly ? { replaceOwnSupersededCopy: true } : {}),
      });
      report.moved += 1;
    } catch (error) {
      if (error instanceof TierLedgerGenerationConflictError) {
        // Decided again, or settled by someone else (the sniffer's automatic move) first.
        continue;
      }
      if (error instanceof TierMoveRefusedError) {
        // The destination keeps different text of this item: a permanent
        // refusal until an approved purge. Recorded once, not retried; the
        // guard in the move primitive stays.
        refused.add(refusedKey);
        ledger.writeMeta(REFUSED_META_KEY, JSON.stringify([...refused].slice(-REFUSED_META_LIMIT)));
        report.refused += 1;
        continue;
      }
      report.failed += 1;
      try {
        ledger.recordMoveFailure(identity, { expectedGeneration: queued.generation });
      } catch {
        // Counting is best effort.
      }
    }
  }
}

function identityOfRecord(record: TierLedgerRecord): TierLedgerIdentity {
  return {
    provider: record.provider,
    accountScope: record.accountScope,
    providerItemId: record.providerItemId,
    ...(record.conversationKey ? { providerConversationId: record.conversationKey } : {}),
  };
}

function openQuestion(record: TierLedgerRecord): boolean {
  return record.state === 'pending' || record.metadataPending || record.contentPending;
}

/** A force rule or force prior fixed the names: the owner's or the lane's say stands. */
function forced(record: TierLedgerRecord): boolean {
  return record.metadataForced || record.decidedBy === 'override';
}

/** Every open store of the set embeds (if at all) with the built-in local model only. */
function setEmbedsWithBuiltInOnly(set: TieredStoreSet): boolean {
  try {
    return set.openStores().every((store) => store.embeddingAuthorities()
      .every((authority) => authority.provider === BUILT_IN_EMBEDDING_PROVIDER));
  } catch {
    return false;
  }
}
