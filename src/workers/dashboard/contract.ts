/**
 * How the pages reach the additive view-model blocks: the sensitivity map, the
 * tier policy, one source's slice of the exclusion rules, and a card's review
 * breakdown.
 *
 * Four readers rather than four field accesses, because each one answers
 * "absent" rather than "zero". A page that prints 0 for a field the worker
 * never emitted has asserted something nobody measured, and these blocks exist
 * precisely because their counts are real.
 */
import type {
  DashboardExcludedSource,
  DashboardNeedsReview,
  DashboardSensitivityCategory,
  DashboardSensitivityTier,
  DashboardSourceCard,
  SourceDashboardViewModel,
} from '../source-dashboard.ts';

/** The secure categories, or an empty list when no map was read. */
export function dashboardSensitivityCategories(
  view: SourceDashboardViewModel,
): readonly DashboardSensitivityCategory[] {
  return view.sensitivity?.categories ?? [];
}

/** The four policy rows, or an empty list on a view model that predates them. */
export function dashboardSensitivityTiers(
  view: SourceDashboardViewModel,
): readonly DashboardSensitivityTier[] {
  return view.sensitivity_tiers?.tiers ?? [];
}

/**
 * This card's share of the exclusion rules, matched by CORPUS ID.
 *
 * Never by source_id: the disposition store, the dashboard cards and the
 * ingestion ledger each name sources in a different space
 * (`dropbox.personal` / `dropbox.files` / `dropbox`), so a source_id join
 * silently attributes one source's rules to another. Corpus ids match exactly,
 * and a disposition corpus belonging to no card — `secure_local.drive.docs` —
 * matches nothing here and stays in the page-wide section where it belongs.
 */
export function dashboardScopeForCard(
  view: SourceDashboardViewModel,
  card: DashboardSourceCard,
): DashboardExcludedSource | undefined {
  const matches = (view.excluded_by_configuration.by_source ?? [])
    .filter((scope) => scope.corpus_ids.includes(card.corpus_id));
  if (matches.length <= 1) return matches[0];
  // Two disposition stores writing one corpus is not a shape the ledger
  // produces today, but rendering only the first would understate the owner's
  // own configuration, so both are stated.
  return matches.reduce((total, scope) => ({
    corpus_ids: [...total.corpus_ids, ...scope.corpus_ids.filter((id) => !total.corpus_ids.includes(id))],
    rules: total.rules + scope.rules,
    prefixes: total.prefixes + scope.prefixes,
    metadata_only_prefixes: total.metadata_only_prefixes + scope.metadata_only_prefixes,
    items_present: total.items_present + scope.items_present,
    items_unevaluable: total.items_unevaluable + scope.items_unevaluable,
    items_metadata_only_content_present:
      total.items_metadata_only_content_present + scope.items_metadata_only_content_present,
    ...(total.unenforceable_rule_ids || scope.unenforceable_rule_ids
      ? { unenforceable_rule_ids: [...(total.unenforceable_rule_ids ?? []), ...(scope.unenforceable_rule_ids ?? [])] }
      : {}),
    entries: [...total.entries, ...scope.entries],
  }));
}

/**
 * The card's review breakdown, or undefined when there is nothing to review.
 *
 * A zero-count reason is not a reason. The builder already drops them; this
 * drops any that survive rather than rendering a chip that reads "0".
 */
export function dashboardNeedsReview(card: DashboardSourceCard): DashboardNeedsReview | undefined {
  const review = card.needs_review;
  if (!review || review.total <= 0) return undefined;
  const reasons = review.reasons.filter((reason) => reason.count > 0);
  // Re-summed from the reasons that survived rather than copied off the card,
  // so the header's two halves always describe the chips actually rendered
  // beneath them. A hand-written fixture that carries no split gets a correct
  // one for free.
  let automatic = 0;
  let operator = 0;
  for (const reason of reasons) {
    if (reason.who_acts === 'automatic') automatic += reason.count;
    else operator += reason.count;
  }
  return { total: review.total, automatic_total: automatic, operator_total: operator, reasons };
}
