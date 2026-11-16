import { describe, expect, test } from 'bun:test';
import type { Analyst, AnalystResult, EvidenceCandidate, EvidencePack } from '../src/core/contracts.ts';
import { analystPromptBytes } from '../src/core/analyst.ts';
import { planDeepReadSections, runDeepRead, type DeepReadProgress } from '../src/core/deep-read.ts';

function message(n: number, text: string): EvidenceCandidate {
  return {
    provenance: {
      sourceItem: { family: 'chat', provider: 'telegram', accountScope: 'me', providerItemId: `m${n}`, providerConversationId: 'c1', localItemId: `l${n}` },
      citation: { title: 'Wellness', authoredAt: `2022-01-${String((n % 28) + 1).padStart(2, '0')}T10:00:00Z` },
    },
    trustTier: 'S4',
    trustDomain: 'secure_local',
    chunks: [text],
  } as EvidenceCandidate;
}

const filler = 'We talked about the weather and the market again today, nothing new. '.repeat(20);
const set = Array.from({ length: 30 }, (_, n) => message(n, n === 7 ? 'Statins lowered my LDL from 190 to 110 in three months.' : n === 22 ? 'My cardiologist says CAC score 0 means low risk.' : filler));

/** A stand-in Analyst: cites every passage that mentions a heart topic, answers from what it got. */
function fakeAnalyst(calls: EvidencePack[]): Analyst {
  return {
    async analyze(pack): Promise<AnalystResult> {
      calls.push(pack);
      const hits = pack.candidates.filter(candidate => candidate.chunks.some(chunk => /LDL|CAC/.test(chunk)));
      return {
        answer: hits.length ? hits.flatMap(hit => hit.chunks).join(' ') : 'Nothing about this here.',
        citations: hits.map(hit => ({ provenance: hit.provenance, claim: hit.chunks.join(' ') })),
        unanswered: hits.length ? [] : ['nothing relevant'],
      };
    },
  };
}

describe('deep read', () => {
  test('sections fit the Analyst prompt budget and cover every piece once, in order', () => {
    const budget = 6_000;
    const sections = planDeepReadSections('q', set, ['telegram'], budget);
    expect(sections.length).toBeGreaterThan(1);
    expect(sections.flat()).toEqual(set.map((_, index) => index));
    for (const section of sections) {
      if (section.length === 1) continue;
      const pack = { question: 'q', candidates: section.map(i => set[i]!), coverage: { searchedCorpora: ['telegram'], skippedCorpora: [], extractionGaps: [] }, builtAt: new Date(0).toISOString() };
      expect(analystPromptBytes(pack, { localOnly: true })).toBeLessThanOrEqual(budget);
    }
  });

  test('reads every section, then answers once from the notes with the original provenance', async () => {
    const calls: EvidencePack[] = [];
    const progress: DeepReadProgress[] = [];
    const result = await runDeepRead({
      question: 'What was said about heart disease?', candidates: set, corpusIds: ['telegram'],
      analyst: fakeAnalyst(calls), promptBytes: 6_000, onProgress: p => { progress.push(p); },
    });
    const sections = planDeepReadSections('What was said about heart disease?', set, ['telegram'], 6_000);
    expect(calls.length).toBe(sections.length + 1);
    const final = calls.at(-1)!;
    expect(final.candidates.map(c => c.provenance.sourceItem.localItemId)).toEqual(['l7', 'l22']);
    expect(final.candidates.every(c => c.trustTier === 'S4' && c.trustDomain === 'secure_local')).toBe(true);
    expect(result.citations.map(c => c.provenance.sourceItem.localItemId)).toEqual(['l7', 'l22']);
    expect(result.sectionsRead).toBe(sections.length);
    expect(progress.at(-1)).toMatchObject({ phase: 'done', sectionsDone: sections.length, notes: 2 });
  });

  test('a section the model fails on is named in coverage, not dropped silently', async () => {
    const calls: EvidencePack[] = [];
    const inner = fakeAnalyst(calls);
    let n = 0;
    const flaky: Analyst = { analyze: (pack, options) => (++n === 2 ? Promise.reject(new Error('model gone')) : inner.analyze(pack, options)) };
    const result = await runDeepRead({ question: 'q', candidates: set, corpusIds: ['telegram'], analyst: flaky, promptBytes: 6_000 });
    expect(result.failedSections).toEqual([1]);
    expect(calls.at(-1)!.coverage.extractionGaps[0]).toContain('could not be read');
  });

  test('resumes after the last section read and stops on the owner\'s cancel', async () => {
    const calls: EvidencePack[] = [];
    const sections = planDeepReadSections('q', set, ['telegram'], 6_000);
    await runDeepRead({
      question: 'q', candidates: set, corpusIds: ['telegram'], analyst: fakeAnalyst(calls), promptBytes: 6_000,
      state: { sectionsDone: sections.length - 1, notes: [{ candidate: 7, claim: 'LDL fell' }], failedSections: [] },
    });
    expect(calls.length).toBe(2);
    expect(calls.at(-1)!.candidates.map(c => c.provenance.sourceItem.localItemId)).toContain('l7');

    const controller = new AbortController();
    controller.abort();
    await expect(runDeepRead({ question: 'q', candidates: set, corpusIds: ['telegram'], analyst: fakeAnalyst([]), promptBytes: 6_000, signal: controller.signal })).rejects.toThrow();
  });

  test('notes that outgrow one prompt are reduced in rounds', async () => {
    const many = Array.from({ length: 40 }, (_, n) => message(n, `LDL reading ${n}: ${'detail '.repeat(60)}`));
    const calls: EvidencePack[] = [];
    let round = 0;
    const analyst: Analyst = {
      async analyze(pack) {
        calls.push(pack);
        round += 1;
        // Each call keeps only its first two cited pieces, so notes shrink round by round.
        const kept = pack.candidates.slice(0, 2);
        return { answer: 'ok', citations: kept.map(c => ({ provenance: c.provenance, claim: c.chunks[0]!.slice(0, 40) })), unanswered: [] };
      },
    };
    const result = await runDeepRead({ question: 'q', candidates: many, corpusIds: ['telegram'], analyst, promptBytes: 5_000 });
    expect(round).toBeGreaterThan(planDeepReadSections('q', many, ['telegram'], 5_000).length + 1);
    expect(result.citations.length).toBeGreaterThan(0);
  });
});
