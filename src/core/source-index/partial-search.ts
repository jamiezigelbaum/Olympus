// A source searched by keyword only, because its search by meaning ran out
// of time, is only partly searched (#1305). The evidence pack notes it in its
// coverage gaps, and every answer names it beside the sources whose whole
// lane ran out of time (#1317), so a cut search is never read as a full one.

/** The vector lane's skip reasons that mean it ran out of time, not that it could not run. */
const SEMANTIC_TIMEOUT_REASONS: ReadonlySet<string> = new Set(['vector_scan_deadline_exceeded', 'vector_scan_store_busy']);

const PREFIX = 'Ran out of time searching by meaning: ';

export function semanticSearchTimedOut(detail: string | undefined): boolean {
  return detail !== undefined && SEMANTIC_TIMEOUT_REASONS.has(detail);
}

/** The coverage gap for a source whose search by meaning ran out of time. */
export function semanticTimeoutGap(corpusId: string): string {
  return `${PREFIX}${corpusId}; only its keyword matches were searched, so related items may be missing. Ask again in a moment.`;
}

/** The source a `semanticTimeoutGap` names, or undefined for any other gap. */
export function semanticTimeoutGapCorpus(gap: string): string | undefined {
  return gapCorpus(PREFIX, gap);
}

/** The coverage gap for a source whose whole lane ran out of time and was left out of the answer. */
export function laneTimeoutGap(corpusId: string): string {
  return `Ran out of time searching ${corpusId}; it is not part of this answer, so more may be there. Ask again in a moment.`;
}

// A source's read of its newest items (the chat recency lane) that ran out of
// time or found the store busy (#1460). Its other lanes still answered, so the
// source is searched; only its newest items may be missing, and that is said.
// The lane reports this token as its skip reason; the router carries it as a
// lane_timeout degradation on that one lane.
export const RECENT_ITEMS_CUT_SHORT = 'recent_items_cut_short';

const RECENT_PREFIX = 'Ran out of time reading the newest items in ';

/** The coverage gap for a source whose read of its newest items ran out of time. */
export function recentItemsTimeoutGap(corpusId: string): string {
  return `${RECENT_PREFIX}${corpusId}; its newest items may be missing from this search. Ask again in a moment.`;
}

// A source whose matches the visibility gate could not judge (#1460): its tier
// ledger's read found the read pool busy or failed, so its matches were left
// out of this search, failing closed. The gate reports the corpus; the router
// carries it as a lane_timeout degradation on that source's visibility lane.
export const VISIBILITY_CHECK_CUT_SHORT = 'visibility_check_cut_short';

const UNCHECKED_PREFIX = 'Ran out of time checking the privacy of matches in ';

/** The coverage gap for a source whose matches were left out because their privacy could not be checked in time. */
export function visibilityCheckTimeoutGap(corpusId: string): string {
  return `${UNCHECKED_PREFIX}${corpusId}; they were left out of this search. Ask again in a moment.`;
}

/** The corpus a gap that starts with `prefix` names, up to its first ';'. */
function gapCorpus(prefix: string, gap: string): string | undefined {
  if (!gap.startsWith(prefix)) return undefined;
  const end = gap.indexOf(';', prefix.length);
  return end > prefix.length ? gap.slice(prefix.length, end) : undefined;
}

export interface TimedOutCorpora {
  /** Lanes that ran out of time before returning anything. */
  stillSearching: string[];
  /** Searched by keyword only: the search by meaning ran out of time. */
  partlySearched: string[];
  /** Searched, but the read of their newest items ran out of time. */
  newestMissed: string[];
  /** Searched, but some matches were left out because their privacy could not be checked in time. */
  unchecked: string[];
}

/** The sources a search cut short, from the evidence pack's coverage. */
export function timedOutCorpora(coverage: {
  searchedCorpora: readonly string[];
  skippedCorpora: readonly { corpusId: string; reason: string }[];
  extractionGaps: readonly string[];
}): TimedOutCorpora {
  const searched = new Set(coverage.searchedCorpora);
  const stillSearching = [...new Set(coverage.skippedCorpora
    .filter((skip) => skip.reason === 'lane_timeout' && !searched.has(skip.corpusId))
    .map((skip) => skip.corpusId))].sort();
  const named = (corpusOf: (gap: string) => string | undefined) => [...new Set(coverage.extractionGaps
    .map(corpusOf)
    .filter((corpusId): corpusId is string => corpusId !== undefined && !stillSearching.includes(corpusId)))].sort();
  return {
    stillSearching,
    partlySearched: named(semanticTimeoutGapCorpus),
    newestMissed: named((gap) => gapCorpus(RECENT_PREFIX, gap)),
    unchecked: named((gap) => gapCorpus(UNCHECKED_PREFIX, gap)),
  };
}

/** One coverage note per source a search cut short, naming it by corpus. */
export function timedOutCoverageNotes(coverage: Parameters<typeof timedOutCorpora>[0]): string[] {
  const { stillSearching, partlySearched, newestMissed, unchecked } = timedOutCorpora(coverage);
  return [
    ...stillSearching.map(laneTimeoutGap),
    ...partlySearched.map(semanticTimeoutGap),
    ...newestMissed.map(recentItemsTimeoutGap),
    ...unchecked.map(visibilityCheckTimeoutGap),
  ];
}
