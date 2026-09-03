/**
 * The one denominator behind every answer-ready percentage on this page.
 *
 * Owner ruling, 2026-08-21: a file the system deliberately never reads is not
 * a file it failed to read. Media, books and shelf items land on the store's
 * expected-metadata-only verdict, privacy-fenced items land on its
 * blocked-by-policy verdict, and neither will ever become answer-ready — no
 * operator action is pending on either. Counting them in the denominator
 * reported a Dropbox that reads every file it is meant to read as 55% ready.
 *
 * So the ratio is answer-ready over ELIGIBLE items — indexed minus
 * policy-deferred. `indexed_items` itself is untouched: how much is stored is
 * still a fact the page states, and the two numbers are shown together.
 *
 * The verdicts are disjoint by construction — the store's ladder assigns each
 * item exactly one — so this subtraction can never remove an item that is also
 * counted as ready.
 *
 * The count keys below are the store's internal `qa_` vocabulary and stay
 * internal: everything published from them is plain language
 * (`not_read_by_policy_items`), the same convention
 * DASHBOARD_NEEDS_REVIEW_REASONS keeps for its own ids. A corpus reporting
 * neither key yields `undefined`, and every ratio it feeds is unchanged.
 */

/**
 * Deferred by policy: media, books and shelf items the extraction ladder is
 * never asked to read.
 */
export const METADATA_ONLY_EXPECTED_COUNT_KEY = 'qa_metadata_only_expected';
/** Fenced by policy: content the sensitivity rules refuse to extract. */
export const BLOCKED_BY_POLICY_COUNT_KEY = 'qa_blocked_policy';
/**
 * Outside the folders the content lanes are pointed at. Metadata sync covers a
 * whole account; extraction is deliberately aimed at a few folders, and a file
 * in none of them was never asked for.
 */
export const OUT_OF_CONTENT_SCOPE_COUNT_KEY = 'qa_out_of_content_scope';

/**
 * Items this corpus holds text for: the per-item numerator of every
 * answer-ready ratio, published by whoever owns the readiness evidence.
 */
export const ITEMS_WITH_TEXT_COUNT_KEY = 'items_with_text';

/**
 * The per-corpus count keys whose items the system is not asked to read.
 *
 * `qa_pending` is deliberately absent: pending IS work in flight, and work in
 * flight belongs in the denominator or the percentage would climb by ignoring
 * everything still queued.
 */
export const POLICY_NOT_READ_COUNT_KEYS: readonly string[] = [
  METADATA_ONLY_EXPECTED_COUNT_KEY,
  BLOCKED_BY_POLICY_COUNT_KEY,
  OUT_OF_CONTENT_SCOPE_COUNT_KEY,
];

/** Count keys that specifically mean the user selected Metadata only. */
export const METADATA_ONLY_POLICY_COUNT_KEYS: readonly string[] = [
  METADATA_ONLY_EXPECTED_COUNT_KEY,
];

/**
 * Exact Metadata-only population when the corpus publishes policy verdicts.
 * A corpus that reports another policy exit but no metadata-only verdict has
 * an exact zero; a corpus that reports no policy vocabulary stays undefined.
 */
export function metadataOnlyByPolicyFromCounts(counts: Record<string, number>): number | undefined {
  const policyVocabularyPresent = POLICY_NOT_READ_COUNT_KEYS.some((key) => {
    const value = counts[key];
    return typeof value === 'number' && Number.isFinite(value);
  });
  if (!policyVocabularyPresent) return undefined;
  let total = 0;
  for (const key of METADATA_ONLY_POLICY_COUNT_KEYS) {
    const value = counts[key];
    if (typeof value === 'number' && Number.isFinite(value)) total += Math.max(0, Math.trunc(value));
  }
  return total;
}

/**
 * Where a corpus may publish its OWN eligible denominator, in preference to
 * the subtraction below.
 *
 * The subtraction assumes one population: that the indexed count and the
 * policy counts describe the same items. A corpus whose readiness evidence
 * lives beside its read authority breaks that assumption — the Dropbox
 * connector store reports what it has finished draining while the QA ladder
 * scores the whole legacy index — and `indexed - excluded` across two
 * populations can land anywhere, including below zero.
 *
 * So a corpus that can count its own eligible items says so, and is believed.
 */
export const ANSWER_READY_ELIGIBLE_COUNT_KEYS: readonly string[] = [
  'qa_eligible_items',
];

/** The corpus's own eligible denominator, or undefined when it publishes none. */
export function answerReadyEligibleFromCounts(counts: Record<string, number>): number | undefined {
  for (const key of ANSWER_READY_ELIGIBLE_COUNT_KEYS) {
    const value = counts[key];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.trunc(value));
  }
  return undefined;
}

/**
 * How many indexed items this corpus reports as never-to-be-read, or undefined
 * when it reports no such key at all.
 *
 * Undefined and 0 are different answers: undefined means "this corpus does not
 * speak that vocabulary", which is what keeps every non-Dropbox ratio
 * arithmetically identical to what it was before this rule existed.
 */
export function notReadByPolicyFromCounts(counts: Record<string, number>): number | undefined {
  let total: number | undefined;
  for (const key of POLICY_NOT_READ_COUNT_KEYS) {
    const value = counts[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    total = (total ?? 0) + Math.max(0, Math.trunc(value));
  }
  return total;
}

/**
 * Indexed items the system is actually meant to read. Never negative.
 *
 * `publishedEligibleItems` wins outright when the corpus reported one: it was
 * counted inside the population that also produced the ready count, which is
 * the only place the two can be compared honestly. The subtraction stays for
 * every corpus that publishes no such number.
 */
export function answerReadyEligibleItems(
  indexedItems: number,
  notReadByPolicyItems?: number,
  publishedEligibleItems?: number,
): number {
  if (typeof publishedEligibleItems === 'number' && Number.isFinite(publishedEligibleItems)) {
    return Math.max(0, Math.trunc(publishedEligibleItems));
  }
  const excluded = typeof notReadByPolicyItems === 'number' && Number.isFinite(notReadByPolicyItems)
    ? Math.max(0, notReadByPolicyItems)
    : 0;
  return Math.max(0, indexedItems - excluded);
}

/**
 * Percent of the ELIGIBLE items that are answer-ready, to one decimal.
 *
 * Nothing indexed answers 0, not 100: an empty corpus knows nothing about its
 * own coverage, and 100 would assert a full corpus on exactly the card whose
 * true answer is "none, and it is broken".
 *
 * Nothing eligible but something indexed answers 100 — every file the system
 * reads is read, because it reads none of them. That is not a claim that
 * anything is answerable, which is why callers print the policy-deferred count
 * beside the number rather than the number alone.
 */
export function answerReadyPercent(input: {
  indexedItems: number;
  contentReadyItems: number;
  notReadByPolicyItems?: number;
  eligibleItems?: number;
}): number {
  if (input.indexedItems <= 0) return 0;
  const eligible = answerReadyEligibleItems(
    input.indexedItems,
    input.notReadByPolicyItems,
    input.eligibleItems,
  );
  if (eligible <= 0) return 100;
  return clampPercent((input.contentReadyItems / eligible) * 100);
}

/** 0..100, one decimal place. */
export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
}
