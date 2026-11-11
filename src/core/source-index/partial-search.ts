// A source searched by keyword only, because its search by meaning ran out
// of time, is only partly searched (#1305). The evidence pack notes it in its
// coverage gaps and the no-evidence answer says so, the way it says when a
// whole source ran out of time (#1317).

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
