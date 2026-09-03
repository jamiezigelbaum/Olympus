import { describe, expect, test } from 'bun:test';
import { fuseRankedCandidateLanes, reciprocalRank } from '../src/core/source-index/retrieval.ts';

interface FixtureItem {
  id: string;
  title: string;
  updatedAt: string;
}

describe('source-index ranked candidate fusion', () => {
  test('dedupes by caller id, sums reciprocal-rank scores across ranked lanes, and respects limit', () => {
    const fused = fuseRankedCandidateLanes({
      lanes: [
        {
          name: 'lexical',
          items: [
            item('alpha', 'Alpha', '2026-05-01'),
            item('beta', 'Beta', '2026-05-02'),
          ],
        },
        {
          name: 'semantic',
          items: [
            item('beta', 'Beta semantic duplicate', '2026-05-02'),
            item('gamma', 'Gamma', '2026-05-03'),
          ],
        },
      ],
      getId: (candidate) => candidate.id,
      limit: 2,
    });

    expect(fused.map((candidate) => candidate.id)).toEqual(['beta', 'alpha']);
    expect(fused[0]?.item.title).toBe('Beta');
    expect(fused[0]?.score).toBeCloseTo(reciprocalRank(2) + reciprocalRank(1));
    expect(fused[0]?.laneRanks.get('lexical')).toBe(2);
    expect(fused[0]?.laneRanks.get('semantic')).toBe(1);
    expect(fused).toHaveLength(2);
  });

  test('applies caller tie-breaker after score ties', () => {
    const fused = fuseRankedCandidateLanes({
      lanes: [
        {
          name: 'structured',
          items: [
            item('older', 'Older record', '2026-05-01'),
            item('newer', 'Newer record', '2026-05-10'),
          ],
        },
        {
          name: 'vector',
          items: [
            item('newer', 'Newer vector duplicate', '2026-05-10'),
            item('older', 'Older vector duplicate', '2026-05-01'),
          ],
        },
      ],
      getId: (candidate) => candidate.id,
      limit: 10,
      tieBreaker: (left, right) => right.item.updatedAt.localeCompare(left.item.updatedAt),
    });

    expect(fused.map((candidate) => candidate.id)).toEqual(['newer', 'older']);
    expect(fused[0]?.score).toBeCloseTo(fused[1]?.score ?? 0);
  });

  test('ignores repeated ids within one lane instead of giving one source multiple boosts', () => {
    const fused = fuseRankedCandidateLanes({
      lanes: [
        {
          name: 'first',
          items: [
            item('shared', 'Shared first rank', '2026-05-01'),
            item('shared', 'Shared repeated', '2026-05-01'),
          ],
        },
        {
          name: 'second',
          items: [item('other', 'Other', '2026-05-02')],
        },
      ],
      getId: (candidate) => candidate.id,
      limit: 10,
    });

    expect(fused.find((candidate) => candidate.id === 'shared')?.score).toBeCloseTo(reciprocalRank(1));
  });

  test('returns no candidates for a zero limit', () => {
    const fused = fuseRankedCandidateLanes({
      lanes: [
        { name: 'first', items: [item('alpha', 'Alpha', '2026-05-01')] },
        { name: 'second', items: [item('beta', 'Beta', '2026-05-02')] },
      ],
      getId: (candidate) => candidate.id,
      limit: 0,
    });

    expect(fused).toEqual([]);
  });
});

function item(id: string, title: string, updatedAt: string): FixtureItem {
  return { id, title, updatedAt };
}
