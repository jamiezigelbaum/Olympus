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

/** An idle store is unfinished even when a usable prefix reached the answer. */
export function laneTimeoutGap(corpusId: string): string {
  return `${corpusId} is still being read; this answer uses only the matches already available, so more may be there. Ask again in a moment.`;
}

export const KEYWORD_PREPARATION_INCOMPLETE = 'keyword_preparation_incomplete';
export const SEMANTIC_SEARCH_STARTING = 'search_starting';
export const STARTUP_SEARCH_GAP = 'Olympus was still starting when you asked, so the search took longer.';

export function promptFitCoverageGap(lane: 'local' | 'cloud', kept: number, shortlisted: number): string {
  const model = lane === 'local' ? 'private' : 'cloud';
  return `The ${model} model read ${kept} of the ${shortlisted} shortlisted sources. The rest did not fit in its prompt.`;
}

const KEYWORDS_PREFIX = 'Keyword preparation unfinished for ';
export function keywordPreparationGap(corpusId: string): string {
  return `${KEYWORDS_PREFIX}${corpusId}; this answer uses the available keyword equivalents, so matches in other languages may be missing.`;
}

// A source's newest-items read can be incomplete while its keyword lane answers.
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
  const stillSearching = [...new Set(coverage.skippedCorpora
    .filter((skip) => skip.reason === 'lane_timeout')
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
    ...[...new Set(coverage.extractionGaps.map(gap => gapCorpus(KEYWORDS_PREFIX, gap)).filter((id): id is string => id !== undefined))].map(keywordPreparationGap),
  ];
}
