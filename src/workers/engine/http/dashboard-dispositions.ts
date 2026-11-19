import type { SourceDispositionsSource } from '../../source-dispositions.ts';
import type { SourceDispositionState, SourceDispositionEdit } from '../../../core/source-disposition-tree.ts';
import type { SourceExclusionCriterionKind } from '../../../core/source-ingestion-exclusions.ts';
import type { SourceIngestionLedgerExclusionSource } from '../../source-ingestion-ledger.ts';
import { asOptionalString } from './request-fields.ts';
import { EmailSourceWorkerError } from './worker-responses.ts';
import type { EmailSourceWorkerOptions } from './worker-options.ts';

/**
 * One opening of the dispositions picker's inputs: the sources, where their
 * rules live, and how to let the stores go again.
 */
export interface SourceDispositionsRuntime {
  sources: SourceDispositionsSource[];
  rulesPath?: string;
  close?: () => void;
}

const SOURCE_DISPOSITION_STATES: readonly SourceDispositionState[] = ['ingest', 'metadata_only', 'on_demand', 'exclude'];

/**
 * Validate a folder-picker save.
 *
 * Two things here are load-bearing rather than hygiene:
 *
 *   - `source` must be one this worker actually serves. A save is allowed to
 *     scope a new rule to a source key, and an unchecked one would let a caller
 *     write rules against a source that does not exist — which parse accepts
 *     and no gate ever applies, so the owner would see a rule on the page that
 *     never matches anything.
 *   - `enforceable` is read from that source's own declaration and is NEVER
 *     taken from the body. It is what decides whether a folder rule can be
 *     written at all, so a caller that supplied it could write path rules into
 *     a source that cannot enforce them — the exact silent no-op the gate's
 *     capability declaration exists to prevent.
 */
export function parseSourceDispositionsSave(
  body: Record<string, unknown>,
  sources: readonly SourceDispositionsSource[],
): {
  source?: string;
  enforceable?: readonly SourceExclusionCriterionKind[];
  edits: SourceDispositionEdit[];
  document?: unknown;
} {
  const requested = asOptionalString(body.source);
  const matched = requested === undefined
    ? undefined
    : sources.find((source) => source.source_id.toLowerCase() === requested.trim().toLowerCase());
  if (requested !== undefined && !matched) {
    throw new EmailSourceWorkerError(
      400,
      'unknown_dispositions_source',
      'That source is not served by this worker, so no rule was written for it.',
    );
  }
  const rawEdits = body.edits;
  if (rawEdits !== undefined && !Array.isArray(rawEdits)) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'edits must be an array.');
  }
  const edits = (Array.isArray(rawEdits) ? rawEdits : []).map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new EmailSourceWorkerError(400, 'invalid_request', `edits[${index}] must be an object.`);
    }
    const record = entry as Record<string, unknown>;
    const path = asOptionalString(record.path);
    const state = asOptionalString(record.state);
    if (!path) {
      throw new EmailSourceWorkerError(400, 'invalid_request', `edits[${index}].path must be a non-empty string.`);
    }
    const known = SOURCE_DISPOSITION_STATES.find((candidate) => candidate === state);
    if (!known) {
      throw new EmailSourceWorkerError(
        400,
        'invalid_request',
        `edits[${index}].state must be one of ${SOURCE_DISPOSITION_STATES.join(', ')}.`,
      );
    }
    const reason = asOptionalString(record.reason);
    return { path, state: known, ...(reason ? { reason } : {}) };
  });
  if (edits.length === 0 && body.document === undefined) {
    throw new EmailSourceWorkerError(400, 'invalid_request', 'Send at least one edit, or a whole rules document.');
  }
  return {
    ...(matched ? { source: matched.source_id, enforceable: matched.enforceable } : {}),
    edits,
    ...(body.document !== undefined ? { document: body.document } : {}),
  };
}

/**
 * The owner's exclusion gates, read for one dashboard render.
 *
 * Same runtime the picker opens, and closed again immediately: the purge-debt
 * counts are read here, while its stores are open, and nothing else in the
 * ledger snapshot needs a handle. A worker with no picker configured reports
 * an empty list, which the ledger renders as an all-zero section rather than
 * an absent one.
 */
export async function dashboardExclusionSources(
  sourceDashboard: NonNullable<EmailSourceWorkerOptions['sourceDashboard']>,
  cache: DashboardExclusionDebtCache,
): Promise<SourceIngestionLedgerExclusionSource[]> {
  if (!sourceDashboard.ingestionDispositions) return [];
  // Stores open only when a source's debt is counted again, once per reuse window.
  const runtime = await sourceDashboard.ingestionDispositions({ lazyStores: true });
  // One reading for the whole render, so two sources counted in the same page
  // can never straddle the reuse window's edge.
  const nowMs = Date.now();
  try {
    return runtime.sources.map((source) => ({
      matcher: source.matcher,
      // Attribution for the per-source split. `corpus_ids` is the join key a
      // reader can use; `source_id` is carried for display only, because the
      // picker's source ids are not the dashboard's card ids.
      sourceId: source.source_id,
      corpusIds: [...source.corpus_ids],
      ...resolveDashboardExclusionDebt(cache, source, nowMs),
    }));
  } finally {
    runtime.close?.();
  }
}

/**
 * How stale a source's stored-exclusion debt may be before the dashboard counts
 * it again.
 *
 * Both counts are a full walk of every locator in the source's stores, put
 * through the owner's gate one row at a time — measured at 270ms per source on
 * a 262k-item store, and the page re-renders on every load and re-polls itself
 * every few seconds. They are debt figures: they move when a purge or a strip
 * runs, or as new items land, never at page-load pace. Same allowance the
 * readiness ladder takes, for the same reason.
 *
 * Deliberately a plain reuse window with no background revalidation, unlike the
 * readiness ladder's. The ladder was seconds of work, so a caller landing on an
 * expired copy was a visible stall worth engineering around; this is a quarter
 * of a second on a poll the reader never watches, and paying it inline once a
 * window keeps the counts on one code path that a test can actually reach.
 */
export const DASHBOARD_EXCLUSION_DEBT_MAX_AGE_MS = 120_000;

/**
 * Both halves are independently optional, because a source may expose one
 * accessor and not the other, and the ledger's two counts are separate answers.
 */
interface DashboardExclusionDebt {
  present?: { items: number; unevaluable: number };
  metadataOnlyContentPresent?: { items: number; unevaluable: number };
}

interface DashboardExclusionDebtCacheEntry {
  debt: DashboardExclusionDebt;
  computed_at_ms: number;
}

export type DashboardExclusionDebtCache = Map<string, DashboardExclusionDebtCacheEntry>;

/**
 * Keyed by the source AND by the gate it was counted under.
 *
 * The rules are editable from this very page, and a count taken under the old
 * rules answers a different question than the same count under the new ones. So
 * an edit changes the key and the next render counts again rather than showing
 * the owner a number their change should already have moved.
 */
function dashboardExclusionDebtCacheKey(source: SourceDispositionsSource): string {
  return JSON.stringify([source.source_id, [...source.corpus_ids].sort(), source.matcher.criteria]);
}

function readDashboardExclusionDebt(source: SourceDispositionsSource): DashboardExclusionDebt | undefined {
  if (!source.excludedItemsPresent && !source.metadataOnlyContentPresent) return undefined;
  return {
    ...(source.excludedItemsPresent ? { present: source.excludedItemsPresent() } : {}),
    ...(source.metadataOnlyContentPresent
      ? { metadataOnlyContentPresent: source.metadataOnlyContentPresent() }
      : {}),
  };
}

function resolveDashboardExclusionDebt(
  cache: DashboardExclusionDebtCache,
  source: SourceDispositionsSource,
  nowMs: number,
): DashboardExclusionDebt {
  // No store mounted for this source: the rules are still reported, and the
  // counts are absent rather than zero, exactly as before.
  if (!source.excludedItemsPresent && !source.metadataOnlyContentPresent) return {};
  const key = dashboardExclusionDebtCacheKey(source);
  const cached = cache.get(key);
  const ageMs = cached ? nowMs - cached.computed_at_ms : undefined;
  // A negative age means the clock moved, not that the count is fresh.
  if (cached && ageMs !== undefined && ageMs >= 0 && ageMs <= DASHBOARD_EXCLUSION_DEBT_MAX_AGE_MS) {
    return cached.debt;
  }
  let debt: DashboardExclusionDebt | undefined;
  try {
    debt = readDashboardExclusionDebt(source);
  } catch {
    // A store that will not open leaves the counts absent, as an unopened source's are.
    return {};
  }
  if (!debt) return {};
  cache.set(key, { debt, computed_at_ms: nowMs });
  return debt;
}
