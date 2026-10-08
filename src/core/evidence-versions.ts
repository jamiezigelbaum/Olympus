/**
 * Versions of one document among evidence items: items whose text is nearly
 * the same (a draft and its revision, a copy saved under another name, a
 * signed scan of the same letter). Several versions in one evidence set can
 * disagree on a value, and an answer that silently reads whichever version
 * retrieval happened to surface gives different facts on different runs
 * (owner report 2026-10-08: three runs over drafts and copies of one letter
 * gave three different prices and deposits).
 *
 * Detection is text overlap only: word 3-shingles, and the share of the
 * smaller item's shingles the other item also has. No title, source, question
 * or document kind is consulted. Measured on a real file store (metadata
 * only): revisions and copies of one document overlapped 0.65–0.99; distinct
 * documents on the same subject, including a same-agency letter for another
 * deal and a translation, stayed at or below 0.28.
 *
 * Items made from one template (monthly statements, payslips) can overlap
 * as much as versions do. Callers therefore never drop an older version on
 * this signal alone: they keep the newest in reach and label the group, and
 * the Analyst decides from the question which version it asks about.
 */

export interface VersionedEvidenceText {
  text: string;
  /** The item's date (written or modified), ISO; orders the versions. */
  date?: string;
}

/** Share of the smaller item's shingles the other must have to be a version of it. */
export const EVIDENCE_VERSION_OVERLAP = 0.6;
/** Items with fewer shingles than this are too short to judge. */
const MIN_SHINGLES = 20;
const SHINGLE_WORDS = 3;

/**
 * Groups of two or more items that are versions of one document, each group
 * newest first (by date; undated items after dated ones, then input order).
 * Groups are ordered by their first member's input position. Items in no
 * group are left out.
 */
export function evidenceVersionGroups(items: readonly VersionedEvidenceText[]): number[][] {
  const shingles = items.map((item) => shingleSet(item.text));
  const parent = items.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      if (overlap(shingles[left]!, shingles[right]!) < EVIDENCE_VERSION_OVERLAP) continue;
      const a = find(left);
      const b = find(right);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const byRoot = new Map<number, number[]>();
  items.forEach((_, index) => {
    const root = find(index);
    byRoot.set(root, [...(byRoot.get(root) ?? []), index]);
  });
  const times = items.map((item) => dateValue(item.date));
  return [...byRoot.values()]
    .filter((members) => members.length > 1)
    .map((members) => [...members].sort((a, b) => newerFirst(times[a]!, times[b]!) || a - b))
    .sort((a, b) => Math.min(...a) - Math.min(...b));
}

/**
 * Each item's group (by input index), for rendering: the group's members
 * newest first, or undefined for an item in no group.
 */
export function evidenceVersionIndex(items: readonly VersionedEvidenceText[]): Array<readonly number[] | undefined> {
  const index: Array<readonly number[] | undefined> = items.map(() => undefined);
  for (const group of evidenceVersionGroups(items)) {
    for (const member of group) index[member] = group;
  }
  return index;
}

/** Whether the group can be ordered: every member carries a date. */
export function evidenceVersionsDated(items: readonly VersionedEvidenceText[], group: readonly number[]): boolean {
  return group.every((member) => Number.isFinite(dateValue(items[member]?.date)));
}

function shingleSet(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const set = new Set<string>();
  for (let index = 0; index + SHINGLE_WORDS <= words.length; index += 1) {
    set.add(words.slice(index, index + SHINGLE_WORDS).join(' '));
  }
  return set;
}

function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size < MIN_SHINGLES || b.size < MIN_SHINGLES) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const shingle of small) if (large.has(shingle)) shared += 1;
  return shared / small.size;
}

function dateValue(date: string | undefined): number {
  const value = date ? Date.parse(date) : Number.NaN;
  return Number.isFinite(value) ? value : Number.NaN;
}

function newerFirst(a: number, b: number): number {
  const aDated = Number.isFinite(a);
  const bDated = Number.isFinite(b);
  if (aDated && bDated) return b - a;
  if (aDated !== bDated) return aDated ? -1 : 1;
  return 0;
}
