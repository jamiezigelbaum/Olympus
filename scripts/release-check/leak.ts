/**
 * Exact-string leak matcher for the release check.
 *
 * A "marker" is a string that must never appear in a given surface (an
 * agent's output, an engine log, a dashboard payload, the report itself).
 * Matching is exact and case-sensitive on purpose: the release check's rule is
 * that exact checks stay in code, and the fixture's markers are unique strings.
 * A match reports where it was found and never copies the marker's
 * surroundings, so a leak finding cannot itself spread the content.
 */

export interface LeakMarker {
  id: string;
  text: string;
  tier: 'private' | 'secrets';
}

export interface ScannedText {
  /** Where the text came from, for the finding ("agent-a answer to q1", "engine log"). */
  label: string;
  text: string;
}

export interface LeakFinding {
  label: string;
  markerId: string;
  tier: 'private' | 'secrets';
  /** How many times the marker occurs in the text. */
  occurrences: number;
}

/** Number of non-overlapping exact occurrences of `needle` in `haystack`. */
export function countExact(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** Every marker found in every text. Empty means no leak. */
export function findLeaks(texts: readonly ScannedText[], markers: readonly LeakMarker[]): LeakFinding[] {
  const findings: LeakFinding[] = [];
  for (const scanned of texts) {
    for (const marker of markers) {
      const occurrences = countExact(scanned.text, marker.text);
      if (occurrences > 0) findings.push({ label: scanned.label, markerId: marker.id, tier: marker.tier, occurrences });
    }
  }
  return findings;
}

/** One line per finding, safe to print: marker ids and labels only, never the marker text. */
export function describeLeaks(findings: readonly LeakFinding[]): string[] {
  return findings.map((f) => `${f.markerId} (${f.tier}) found ${f.occurrences}x in ${f.label}`);
}

/**
 * Redacts every marker from a text before it is stored or printed. Anything
 * the harness keeps (logs, captured output) goes through this first, so the
 * run's own artifacts cannot become a leak.
 */
export function redactMarkers(text: string, markers: readonly LeakMarker[]): string {
  let out = text;
  for (const marker of markers) {
    if (marker.text.length > 0) out = out.split(marker.text).join(`[redacted:${marker.id}]`);
  }
  return out;
}

/** The same redaction over every string in a value (object keys included), so a structure can be written whole. */
export function redactDeep<T>(value: T, markers: readonly LeakMarker[]): T {
  if (typeof value === 'string') return redactMarkers(value, markers) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, markers)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactMarkers(key, markers), redactDeep(item, markers)])) as T;
  }
  return value;
}
