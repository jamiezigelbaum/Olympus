import type { EvidenceCandidate, EvidencePack } from './contracts.ts';

export const READ_WIDE_MATCH_LIMIT = 60;
export const READ_WIDE_MIN_PASSAGE_BYTES = 400;
export function readWideEnabled(): boolean { return process.env.OLYMPUS_READ_WIDE === '1'; }

// Compare only scores from the same store or the same reranker. A drop of
// more than 20% after either of the first two seats is a clear leader.
// Missing/non-finite scores cannot establish a broad match set.
export function scoresHaveNoLeader(scores: readonly (number | undefined)[]): boolean {
  if (scores.length < 3 || scores.some(score => score === undefined || !Number.isFinite(score))) return false;
  const ranked = (scores as readonly number[]).slice().sort((a, b) => b - a);
  const scale = Math.max(Math.abs(ranked[0]!), Math.abs(ranked[2]!), 1e-9);
  return ranked[0]! - ranked[2]! <= scale * 0.2;
}

const matchingProvenances = new WeakSet<object>();
export function isReadWideMatch(candidate: EvidenceCandidate): boolean { return matchingProvenances.has(candidate.provenance) && candidate.chunks.some(chunk => chunk.length > 0); }
const wideProvenances = new WeakSet<object>();
export function markReadWidePack(pack: EvidencePack, matches: readonly EvidenceCandidate[] = pack.candidates): EvidencePack {
  for (const candidate of matches) matchingProvenances.add(candidate.provenance);
  for (const candidate of pack.candidates) wideProvenances.add(candidate.provenance);
  return pack;
}
export function isReadWidePack(pack: EvidencePack): boolean {
  return pack.candidates.length > 0 && pack.candidates.every(candidate => wideProvenances.has(candidate.provenance));
}
