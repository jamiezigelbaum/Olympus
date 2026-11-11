import { describe, expect, test } from 'bun:test';
import { analystPromptBytes } from '../src/core/analyst.ts';
import type { EvidenceCandidate, EvidencePack } from '../src/core/contracts.ts';
import { clipChunksToUtf8Bytes, utf8ByteLength } from '../src/core/evidence-pack.ts';
import { fitPackToPromptBytes } from '../src/workers/source-index/analyst-answer.ts';

const options = { localOnly: true };
const question = 'What is the zephyr cobalt measurement?';
const value = 'zephyr cobalt measurement 73.25';

function fixture(chunks: (index: number) => readonly string[], count = 24) {
  const candidates: EvidenceCandidate[] = Array.from({ length: count }, (_, index) => ({
    provenance: {
      sourceItem: { family: 'file', provider: 'fixture', accountScope: 'personal', providerItemId: `seat-${index}`, localItemId: `seat-${index}` },
      citation: { title: `Note ${index}` },
    },
    trustTier: 'S2',
    trustDomain: 'internal',
    chunks: chunks(index),
  }));
  // Head and recency seats share a store; later seats are grouped by store
  // so round-robin selection differs from simply keeping a pack prefix.
  const corpusOf = new Map(candidates.map((candidate, index) => [candidate, index < 5 ? 'a' : index < 12 ? 'b' : index < 19 ? 'c' : 'a']));
  const pack: EvidencePack = {
    question,
    candidates,
    coverage: {
      searchedCorpora: ['a', 'b', 'c'],
      skippedCorpora: [{ corpusId: 'unavailable', reason: 'offline' }],
      extractionGaps: ['one unreadable attachment'],
      matchCounts: ['a', 'b', 'c'].map((corpusId) => ({
        corpusId, family: 'file', matchedItems: 50, contentMatchedItems: 40,
        atLeast: true, inEvidence: [...corpusOf.values()].filter((id) => id === corpusId).length,
      })),
    },
    builtAt: '2026-11-11T00:00:00Z',
  };
  return { pack, corpusOf };
}

function passageBytes(candidate: EvidenceCandidate): number {
  return candidate.chunks.reduce((total, chunk) => total + utf8ByteLength(chunk), 0);
}

describe('question-anchored prompt fitting', () => {
  test('keeps the widest question-term region and adjacent value beyond the byte share', () => {
    const { pack, corpusOf } = fixture(() => [`zephyr ${'x'.repeat(753)} ${value} ${'y'.repeat(2_000)}`]);
    expect(utf8ByteLength(pack.candidates[0]!.chunks[0]!.split(value)[0]!)).toBe(761);
    const fitted = fitPackToPromptBytes(pack, 13_500, corpusOf, options);
    expect(fitted.candidates.length).toBeGreaterThan(1);
    for (const candidate of fitted.candidates) {
      expect(passageBytes(candidate)).toBeLessThan(761);
      expect(candidate.chunks.join('\n')).toContain(value);
    }
    expect(analystPromptBytes(fitted, options)).toBeLessThanOrEqual(13_500);
  });

  test('a seat with no matching term keeps exactly the old passage heads, including whitespace and order', () => {
    const { pack, corpusOf } = fixture((index) => index % 2 === 0
      ? ['  head😀\n', 'duplicate', 'duplicate', 'x'.repeat(4_000), 'last passage']
      : [`${'x'.repeat(1_500)} ${value} ${'y'.repeat(2_000)}`]);
    const fitted = fitPackToPromptBytes(pack, 13_500, corpusOf, options);
    for (const candidate of fitted.candidates) {
      const original = pack.candidates.find((entry) => entry.provenance === candidate.provenance)!;
      if (original.chunks.length === 1) continue;
      expect(candidate.chunks).toEqual(clipChunksToUtf8Bytes(original.chunks, passageBytes(candidate)));
      expect(candidate.chunks[0]).toBe('  head😀\n');
      expect(candidate.chunks.slice(1, 3)).toEqual(['duplicate', 'duplicate']);
      expect(candidate.chunks[3]).toMatch(/^x+$/);
    }
    expect(analystPromptBytes(fitted, options)).toBeLessThanOrEqual(13_500);
  });

  test('shares a seat between later relevant regions in distinct passages', () => {
    const { pack, corpusOf } = fixture(() => [
      `${'x'.repeat(2_000)} zephyr 73.25 ${'x'.repeat(2_000)}`,
      `${'y'.repeat(2_000)} cobalt 18.50 ${'y'.repeat(2_000)}`,
    ]);
    const fitted = fitPackToPromptBytes(pack, 13_500, corpusOf, options);
    for (const candidate of fitted.candidates) {
      expect(candidate.chunks.join('\n')).toContain('zephyr 73.25');
      expect(candidate.chunks.join('\n')).toContain('cobalt 18.50');
    }
    expect(analystPromptBytes(fitted, options)).toBeLessThanOrEqual(13_500);
  });

  for (const padding of ['é', '界', '😀', '"\\\n\t\u0001', '😀界"\\\n']) {
    for (const maxPromptBytes of [9_000, 13_500]) {
      test(`keeps whole code points within ${maxPromptBytes} prompt bytes with ${JSON.stringify(padding)}`, () => {
        const { pack, corpusOf } = fixture(() => [`${padding.repeat(2_001)} ${value} ${padding.repeat(2_000)}`]);
        const fitted = fitPackToPromptBytes(pack, maxPromptBytes, corpusOf, options);
        const empty: EvidencePack = { ...fitted, candidates: fitted.candidates.map((candidate) => ({ ...candidate, chunks: [] })) };
        const initialShare = Math.floor((maxPromptBytes - analystPromptBytes(empty, options)) / fitted.candidates.length);
        for (const candidate of fitted.candidates) {
          expect(passageBytes(candidate)).toBeLessThanOrEqual(initialShare);
          expect(candidate.chunks.join('\n')).toContain(value);
          for (const chunk of candidate.chunks) {
            expect(chunk).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
            expect(pack.candidates[0]!.chunks[0]!.includes(chunk)).toBe(true);
          }
        }
        expect(analystPromptBytes(fitted, options)).toBeLessThanOrEqual(maxPromptBytes);
      });
    }
  }

  test('preserves main seat selection, pack order, and restated coverage with head and recency reservations', () => {
    const { pack, corpusOf } = fixture(() => [`${'x'.repeat(1_500)} ${value} ${'y'.repeat(2_000)}`]);
    const results = [0, 2].flatMap((recencySeats) => [9_000, 13_500].map((budget) => {
      const fitted = fitPackToPromptBytes(pack, budget, corpusOf, options, recencySeats);
      expect(analystPromptBytes(fitted, options)).toBeLessThanOrEqual(budget);
      expect(fitted.coverage).toEqual({
        ...pack.coverage,
        matchCounts: pack.coverage.matchCounts!.map((count) => ({
          ...count,
          inEvidence: fitted.candidates.filter((candidate) => corpusOf.get(pack.candidates.find((entry) => entry.provenance === candidate.provenance)!) === count.corpusId).length,
        })),
      });
      return { recencySeats, budget, seats: fitted.candidates.map((candidate) => candidate.provenance.sourceItem.providerItemId), counts: fitted.coverage.matchCounts!.map((count) => count.inEvidence) };
    }));
    // Recorded against main before changing the fit's clip.
    expect(results).toMatchInlineSnapshot(`
      [
        {
          "budget": 9000,
          "counts": [
            5,
            2,
            1,
          ],
          "recencySeats": 0,
          "seats": [
            "seat-0",
            "seat-1",
            "seat-2",
            "seat-3",
            "seat-4",
            "seat-5",
            "seat-6",
            "seat-12",
          ],
        },
        {
          "budget": 13500,
          "counts": [
            7,
            4,
            3,
          ],
          "recencySeats": 0,
          "seats": [
            "seat-0",
            "seat-1",
            "seat-2",
            "seat-3",
            "seat-4",
            "seat-5",
            "seat-6",
            "seat-7",
            "seat-8",
            "seat-12",
            "seat-13",
            "seat-14",
            "seat-19",
            "seat-20",
          ],
        },
        {
          "budget": 9000,
          "counts": [
            6,
            1,
            1,
          ],
          "recencySeats": 2,
          "seats": [
            "seat-0",
            "seat-1",
            "seat-2",
            "seat-3",
            "seat-4",
            "seat-5",
            "seat-12",
            "seat-19",
          ],
        },
        {
          "budget": 13500,
          "counts": [
            8,
            3,
            3,
          ],
          "recencySeats": 2,
          "seats": [
            "seat-0",
            "seat-1",
            "seat-2",
            "seat-3",
            "seat-4",
            "seat-5",
            "seat-6",
            "seat-7",
            "seat-12",
            "seat-13",
            "seat-14",
            "seat-19",
            "seat-20",
            "seat-21",
          ],
        },
      ]
    `);
  });

  test('returns an already-fitting pack unchanged', () => {
    const { pack, corpusOf } = fixture(() => [value], 1);
    expect(fitPackToPromptBytes(pack, 13_500, corpusOf, options)).toBe(pack);
  });
});
