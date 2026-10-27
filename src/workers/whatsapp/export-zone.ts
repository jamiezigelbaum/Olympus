// Wall times of a WhatsApp chat export, read in a named time zone
// (docs/design/archive-live-one-dataset.md, section 4, WhatsApp).
//
// An export writes the phone's wall time with no zone. A zone, not an offset,
// is chosen for the whole export, and each line is converted with the rules
// for its own date, so daylight-saving changes are followed.

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(zone, formatter);
  }
  return formatter;
}

/** Whether the runtime knows a zone by this name. */
export function isKnownTimeZone(zone: string): boolean {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

/** This computer's zone (TZ when set). */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** Every zone the runtime knows, this computer's first. */
export function candidateTimeZones(): string[] {
  const local = localTimeZone();
  let all: string[] = [];
  try {
    all = (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf('timeZone');
  } catch {
    all = [];
  }
  return [local, ...all.filter((zone) => zone !== local), ...(all.includes('UTC') || local === 'UTC' ? [] : ['UTC'])];
}

/** The zone's offset from UTC at an instant, in milliseconds. */
export function zoneOffsetMs(zone: string, utcMs: number): number {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(zone).formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const asUtc = Date.UTC(parts['year']!, parts['month']! - 1, parts['day']!, parts['hour']! % 24, parts['minute']!, parts['second']!);
  const whole = utcMs - (((utcMs % 1000) + 1000) % 1000);
  return asUtc - whole;
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/u;

/**
 * The instant a wall time (`YYYY-MM-DDTHH:MM:SS`) names in a zone, in UTC
 * milliseconds. A time a daylight-saving jump skips is read with the offset
 * before the jump; a time it repeats, as the first of the two.
 */
export function wallTimeToUtcMs(wall: string, zone: string): number | undefined {
  const found = WALL.exec(wall);
  if (!found) return undefined;
  const naive = Date.UTC(Number(found[1]), Number(found[2]) - 1, Number(found[3]), Number(found[4]), Number(found[5]), Number(found[6]));
  if (!Number.isFinite(naive)) return undefined;
  // Two candidates: with the offset an hour either side of the naive instant; the earlier one that reads back wins.
  const before = naive - zoneOffsetMs(zone, naive - 12 * 3_600_000);
  const after = naive - zoneOffsetMs(zone, naive + 12 * 3_600_000);
  for (const candidate of [Math.min(before, after), Math.max(before, after)]) {
    if (candidate + zoneOffsetMs(zone, candidate) === naive) return candidate;
  }
  // Skipped by a jump forward: read with the offset in force before it.
  return before;
}

/**
 * The offsets a zone has at noon UTC of each of the given days: two zones with
 * the same signature convert those days' wall times alike, so only one of them
 * is tried.
 */
export function zoneSignature(zone: string, days: readonly string[]): string {
  return days.map((day) => zoneOffsetMs(zone, Date.parse(`${day}T12:00:00Z`))).join(',');
}

/**
 * The zone under which most of a sample matches, trying this computer's zone
 * first: `score(zone)` counts the sample's matches under it. With no match
 * under any zone, this computer's zone is used and said to be assumed.
 */
export function chooseExportTimeZone(
  days: readonly string[],
  score: (zone: string) => number,
  zones: readonly string[] = candidateTimeZones(),
): { zone: string; matches: number; assumed: boolean } {
  const local = zones[0] ?? localTimeZone();
  let best = { zone: local, matches: score(local) };
  const tried = new Set<string>([zoneSignature(local, days)]);
  for (const zone of zones.slice(1)) {
    let signature: string;
    try {
      signature = zoneSignature(zone, days);
    } catch {
      continue;
    }
    if (tried.has(signature)) continue;
    tried.add(signature);
    const matches = score(zone);
    // Strictly more: a tie keeps the zone tried first, this computer's above all.
    if (matches > best.matches) best = { zone, matches };
  }
  return { ...best, assumed: best.matches === 0 };
}
