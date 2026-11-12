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
  if (!gap.startsWith(PREFIX)) return undefined;
  const end = gap.indexOf(';', PREFIX.length);
  return end > PREFIX.length ? gap.slice(PREFIX.length, end) : undefined;
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

function recentItemsTimeoutGapCorpus(gap: string): string | undefined {
  if (!gap.startsWith(RECENT_PREFIX)) return undefined;
  const end = gap.indexOf(';', RECENT_PREFIX.length);
  return end > RECENT_PREFIX.length ? gap.slice(RECENT_PREFIX.length, end) : undefined;
}

export interface TimedOutCorpora {
  /** Lanes that ran out of time before returning anything. */
  stillSearching: string[];
  /** Searched by keyword only: the search by meaning ran out of time. */
  partlySearched: string[];
  /** Searched, but the read of their newest items ran out of time. */
  newestMissed: string[];
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
  const partlySearched = [...new Set(coverage.extractionGaps
    .map(semanticTimeoutGapCorpus)
    .filter((corpusId): corpusId is string => corpusId !== undefined && !stillSearching.includes(corpusId)))].sort();
  const newestMissed = [...new Set(coverage.extractionGaps
    .map(recentItemsTimeoutGapCorpus)
    .filter((corpusId): corpusId is string => corpusId !== undefined && !stillSearching.includes(corpusId)))].sort();
  return { stillSearching, partlySearched, newestMissed };
}

/** One coverage note per source a search cut short, naming it by corpus. */
export function timedOutCoverageNotes(coverage: Parameters<typeof timedOutCorpora>[0]): string[] {
  const { stillSearching, partlySearched, newestMissed } = timedOutCorpora(coverage);
  return [...stillSearching.map(laneTimeoutGap), ...partlySearched.map(semanticTimeoutGap), ...newestMissed.map(recentItemsTimeoutGap)];
}
