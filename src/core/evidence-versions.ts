/**
 * Versions of one document among evidence items: documents whose text is
 * nearly the same (a draft and its revision, a copy saved under another name,
 * a signed scan of the same letter). Several versions in one evidence set can
 * disagree on a value, and an answer that silently reads whichever version
 * retrieval happened to surface gives different facts on different runs
 * (owner report 2026-10-08: three runs over drafts and copies of one letter
 * gave three different prices and deposits).
 *
 * Detection is symmetric text overlap: the Jaccard similarity of the two
 * items' word 3-shingles, so an item merely quoted inside a longer one (a
 * reply quoting its original) is not a version of it. Only documents are
 * judged (families that are edited and copied: files and notes); a message
 * is sent once and never revised, so a thread is never read as versions.
 * Nothing about the title, source, question or document kind is consulted.
 * Measured on a real file store (scores only): revisions and copies of one
 * document scored 0.50–0.98 on whole texts and 0.71–1.00 on 2,400-character
 * excerpts; distinct documents on the same subject, including a same-agency
 * letter for another deal and a translation, stayed at or below 0.35.
 *
 * Items made from one template (statements, payslips) can still score like
 * versions. Callers therefore never hide a version on this signal alone:
 * revisions stay readable, the newest is kept in reach, and the Analyst
 * decides from the question which version, date or period it asks about.
 * Only near-exact copies (EVIDENCE_COPY_SIMILARITY) stand in for each other.
 */

export interface VersionedEvidenceText {
  text: string;
  /** The item's date (written or modified), ISO; orders the versions. */
  date?: string;
  /** The item's source family; only document families are judged. Absent: judged. */
  family?: string;
}

/** Jaccard similarity at or above which two documents are versions of one. */
export const EVIDENCE_VERSION_SIMILARITY = 0.5;
/** Jaccard similarity at or above which two versions are near-exact copies. */
export const EVIDENCE_COPY_SIMILARITY = 0.9;
/** Families whose items are edited and copied, so can exist in versions. */
const DOCUMENT_FAMILIES: ReadonlySet<string> = new Set(['file', 'note']);
/** Items with fewer shingles than this (about 60 words) are too short to judge. */
const MIN_SHINGLES = 60;
const SHINGLE_WORDS = 3;

export interface EvidenceVersions {
  /** Groups of two or more versions, each newest first (dated before undated, then input order). */
  groups: number[][];
  /** Jaccard similarity of two items' texts (0 for items not judged). */
  similarity(a: number, b: number): number;
}

export function evidenceVersions(items: readonly VersionedEvidenceText[]): EvidenceVersions {
  const shingles = items.map((item) =>
    item.family === undefined || DOCUMENT_FAMILIES.has(item.family) ? shingleSet(item.text) : new Set<string>());
  const memo = new Map<string, number>();
  const similarity = (a: number, b: number): number => {
    if (a === b) return 1;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    let value = memo.get(key);
    if (value === undefined) {
      value = jaccard(shingles[a]!, shingles[b]!);
      memo.set(key, value);
    }
    return value;
  };
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
      if (similarity(left, right) < EVIDENCE_VERSION_SIMILARITY) continue;
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
  const times = items.map((item) => evidenceDateValue(item.date));
  const groups = [...byRoot.values()]
    .filter((members) => members.length > 1)
    .map((members) => [...members].sort((a, b) => newerFirst(times[a]!, times[b]!) || a - b))
    .sort((a, b) => Math.min(...a) - Math.min(...b));
  return { groups, similarity };
}

/** evidenceVersions' groups alone. */
export function evidenceVersionGroups(items: readonly VersionedEvidenceText[]): number[][] {
  return evidenceVersions(items).groups;
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

/** Whether the group can be ordered: every member carries a date that parses. */
export function evidenceVersionsDated(items: readonly VersionedEvidenceText[], group: readonly number[]): boolean {
  return group.every((member) => Number.isFinite(evidenceDateValue(items[member]?.date)));
}

/** A date's time value, or NaN when absent or unparseable. */
export function evidenceDateValue(date: string | undefined): number {
  const value = date ? Date.parse(date) : Number.NaN;
  return Number.isFinite(value) ? value : Number.NaN;
}

function shingleSet(text: string): Set<string> {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const set = new Set<string>();
  for (let index = 0; index + SHINGLE_WORDS <= words.length; index += 1) {
    set.add(words.slice(index, index + SHINGLE_WORDS).join(' '));
  }
  return set;
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size < MIN_SHINGLES || b.size < MIN_SHINGLES) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const shingle of small) if (large.has(shingle)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function newerFirst(a: number, b: number): number {
  const aDated = Number.isFinite(a);
  const bDated = Number.isFinite(b);
  if (aDated && bDated) return b - a;
  if (aDated !== bDated) return aDated ? -1 : 1;
  return 0;
}
