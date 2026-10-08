// Versions of one document in the evidence (owner report 2026-10-08): three
// private answers to one question about a letter gave three different prices
// and deposits, because the store held drafts and copies of it and each run
// read whichever versions retrieval surfaced. The panel now reads the newest
// version in every run and the Analyst is told which items are versions and
// which is newest; differing values must be reported, never picked silently.
// Synthetic fixtures only (eval/fixtures/versioned-documents.ts).

import { describe, expect, test } from 'bun:test';
import { evidenceVersionGroups } from '../src/core/evidence-versions.ts';
import { answerPrivately, type BuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import { createAnalyst, type AnalystModelRequest } from '../src/core/analyst.ts';
import type { EvidencePack } from '../src/core/contracts.ts';
import { citedVersionNote, createBuiltInPrivateAnswerModel, panelSelection } from '../src/workers/chatgpt/private-answer-model.ts';
import { VERSIONED_FIXTURE_ITEMS, versionedFixtureHits } from '../eval/fixtures/versioned-documents.ts';

const items = VERSIONED_FIXTURE_ITEMS;
const indexOf = (id: string) => items.findIndex((item) => item.id === id);
const asText = (ids: readonly string[]) => ids.map((id) => {
  const item = items[indexOf(id)]!;
  return { text: item.text, date: item.saved };
});

function permutations<T>(values: readonly T[]): T[][] {
  if (values.length <= 1) return [[...values]];
  return values.flatMap((value, index) =>
    permutations([...values.slice(0, index), ...values.slice(index + 1)]).map((rest) => [value, ...rest]));
}

describe('finding versions of one document', () => {
  test('drafts and copies group together, newest first; other documents on the same subject do not', () => {
    const ids = ['offer-v2', 'lease', 'offer-v1', 'contract', 'offer-v3', 'old-offer'];
    const groups = evidenceVersionGroups(asText(ids));
    expect(groups.map((group) => group.map((index) => ids[index]))).toEqual([['offer-v3', 'offer-v2', 'offer-v1']]);
  });

  test('undated versions keep input order after dated ones; short texts are never judged', () => {
    const [v1, v2] = asText(['offer-v1', 'offer-v2']);
    expect(evidenceVersionGroups([{ text: v1!.text }, { text: v2!.text, date: v2!.date }])).toEqual([[1, 0]]);
    expect(evidenceVersionGroups([{ text: 'Deposit €6,000.' }, { text: 'Deposit €6,000.' }])).toEqual([]);
  });
});

describe('the Analyst sees which items are versions, and is told not to pick values silently', () => {
  function packOf(ids: readonly string[]): EvidencePack {
    return {
      question: 'What price is in the offer?',
      builtAt: '2026-10-08T00:00:00Z',
      coverage: { searchedCorpora: ['fixture'], skippedCorpora: [], extractionGaps: [] },
      candidates: ids.map((id) => {
        const item = items[indexOf(id)]!;
        return {
          provenance: {
            sourceItem: { family: 'file', provider: 'fixture', accountScope: 'personal', providerItemId: id, localItemId: id },
            citation: { title: item.title, authoredAt: item.saved, uri: `${item.folder}/${item.title}` },
          },
          trustTier: 'S2',
          trustDomain: 'internal',
          chunks: [item.text],
        };
      }),
    };
  }

  async function promptFor(pack: EvidencePack): Promise<AnalystModelRequest> {
    let seen: AnalystModelRequest | undefined;
    const analyst = createAnalyst({
      complete: async (request) => {
        seen = request;
        return { text: JSON.stringify({ answer: 'x [1].', citations: [{ evidence: 1, claim: 'x' }], unanswered: [], sufficient: true }), modelId: 'fixture' };
      },
    });
    await analyst.analyze(pack, { localOnly: false });
    return seen!;
  }

  test('each version is labelled with its date and the newest; other items carry no label', async () => {
    const request = await promptFor(packOf(['offer-v1', 'contract', 'offer-v3']));
    expect(request.prompt).toContain('version group: older version, dated 2025-11-02; the newest version is [3] 2025-12-03');
    expect(request.prompt).toContain('version group: newest of 2 versions of one document, dated 2025-12-03 (older: [1] 2025-11-02)');
    expect(request.prompt.split('\n').filter((line) => line.startsWith('version group:'))).toHaveLength(2);
    expect(request.prompt).toContain('Answer from the newest version unless the question asks about an earlier one');
    expect(request.system).toContain("give each value with its item's name and date; never pick one silently");
  });

  test('versions saved the same day are told apart to the minute', async () => {
    const pack = packOf(['offer-v1', 'offer-v2']);
    const sameDay = {
      ...pack,
      candidates: pack.candidates.map((candidate, index) => ({
        ...candidate,
        provenance: { ...candidate.provenance, citation: { ...candidate.provenance.citation, authoredAt: index === 0 ? '2025-12-16T09:39:49Z' : '2025-12-16T14:55:18Z' } },
      })),
    };
    const request = await promptFor(sameDay);
    expect(request.prompt).toContain('newest of 2 versions of one document, dated 2025-12-16 14:55 UTC (older: [1] 2025-12-16 09:39 UTC)');
  });

  test('the compact rendering a small local model reads carries the same label and rules', async () => {
    let seen: AnalystModelRequest | undefined;
    const model = {
      name: 'built_in',
      spec: { modelId: 'fixture' },
      complete: async (request: AnalystModelRequest) => {
        seen = request;
        return { text: JSON.stringify({ answer: 'x [1].', citations: [{ evidence: 1, claim: 'x' }], unanswered: [], sufficient: true }), modelId: 'built_in/fixture' };
      },
    } as unknown as BuiltInAnalystModel;
    const evidence = ['offer-v2', 'offer-v3'].map((id) => {
      const item = items[indexOf(id)]!;
      return { id, title: item.title, text: item.text, date: item.saved };
    });
    await answerPrivately('What price is in the offer?', evidence, { model, maxAnswerChars: 1_000, audit: false, evidenceFormat: 'compact' });
    expect(seen!.prompt).toContain('version group: newest of 2 versions of one document, dated 2025-12-03 (older: [1] 2025-11-20)');
    expect(seen!.prompt).toContain('Answer from the newest version unless the question asks about an earlier one');
    expect(seen!.system).toContain('never pick one silently');
  });

  test('evidence without versions carries no version label or instruction', async () => {
    const request = await promptFor(packOf(['contract', 'lease', 'offer-v1']));
    expect(request.prompt).not.toContain('version group:');
    expect(request.prompt).not.toContain('Answer from the newest version');
  });
});

describe('the panel reads the newest version in every run', () => {
  const limits = { maxItems: 4, relevanceMargin: 0.04, maxLeadingItems: 2, leadGap: 0.01 };
  const read = (ids: readonly string[]) => ({
    items: ids.map((id) => {
      const item = items[indexOf(id)]!;
      return { id, title: item.title, text: item.text, date: item.saved };
    }),
  });

  test('versions take one place: the most relevant one and the newest are read, the rest make room for other documents', async () => {
    const ids = ['offer-v1', 'offer-v2', 'offer-v3', 'contract', 'old-offer', 'lease'];
    // The oldest draft scores highest, the copies crowd the top.
    const scores = [0.62, 0.61, 0.60, 0.58, 0.55, 0.30];
    const picked = await panelSelection('q', read(ids), { ...limits, relevanceMargin: 0.1, maxLeadingItems: 0 }, async () => scores);
    expect(picked.items.map((index) => ids[index])).toEqual(['offer-v1', 'offer-v3', 'contract', 'old-offer']);
    // Without scores (retrieval order), the same rule holds.
    const unscored = await panelSelection('q', read(ids), limits);
    expect(unscored.items.map((index) => ids[index])).toEqual(['offer-v1', 'offer-v3', 'contract', 'old-offer']);
  });

  test('a version that leads brings the newest version with it', async () => {
    const ids = ['offer-v2', 'offer-v3', 'contract', 'lease'];
    const picked = await panelSelection('q', read(ids), limits, async () => [0.70, 0.40, 0.39, 0.20]);
    expect(picked).toEqual({ items: [0, 1], leading: true });
  });

  test('every retrieval order of the same matches sends the model the same evidence, newest version included', async () => {
    const ids = ['offer-v1', 'offer-v2', 'offer-v3', 'contract', 'lease'];
    // Fixed per-item relevance (a question's embedding scores do not depend on retrieval order).
    const relevanceOf: Record<string, number> = { 'offer-v1': 0.61, 'offer-v2': 0.63, 'offer-v3': 0.60, contract: 0.59, lease: 0.2 };
    const prompts = new Set<string>();
    const readSets = new Set<string>();
    const answers = new Set<string>();
    for (const order of permutations(ids)) {
      const panel = createBuiltInPrivateAnswerModel({
        model: { name: 'built_in', spec: { modelId: 'fixture' } } as unknown as BuiltInAnalystModel,
        available: () => true,
        eligible: async (hits) => hits.map(() => true),
        relevance: async (_question, offered) => (await offered()).map((item) => {
          const id = items.find((candidate) => candidate.title === item?.title)!.id;
          return relevanceOf[id]!;
        }),
        answer: (question, evidence, options) => answerPrivately(question, evidence, {
          ...options,
          model: {
            ...options.model,
            complete: async (request: AnalystModelRequest) => {
              prompts.add(request.prompt);
              return { text: JSON.stringify({ answer: 'The price is €620,000 [2].', citations: [{ evidence: 2, claim: 'Price €620,000' }], unanswered: [], sufficient: true }), modelId: 'built_in/fixture' };
            },
          } as BuiltInAnalystModel,
        }),
      });
      let used: readonly number[] = [];
      const result = await panel.answerPrivately('What price is in the offer?', versionedFixtureHits(order), undefined, { evidence: (stats) => { used = stats.used ?? []; } });
      readSets.add(used.map((index) => order[index]).join(','));
      answers.add(result.answer);
    }
    expect([...readSets]).toEqual(['offer-v2,offer-v3,contract']);
    expect(prompts.size).toBe(1);
    expect([...prompts][0]).toContain('version group: newest of 2 versions of one document, dated 2025-12-03');
    // The answer says which version it used, the same way every run.
    expect([...answers]).toEqual(['The price is €620,000. Several versions of “Offer_14_Larch_Court_signed.pdf” were found; this answer uses the newest, saved 3 December 2025.']);
  });

  test('an answer from an older version says so and when the newest was saved; an answer with no versions gets no note', () => {
    const evidence = ['offer-v1', 'offer-v3', 'lease'].map((id) => {
      const item = items[indexOf(id)]!;
      return { id, title: item.title, text: item.text, date: item.saved };
    });
    expect(citedVersionNote(evidence, ['offer-v1'])).toBe('This answer uses an older version of “Offer 14 Larch Court draft.docx”, saved 2 November 2025; the newest version was saved 3 December 2025.');
    expect(citedVersionNote(evidence, ['lease'])).toBeUndefined();
    const sameDay = evidence.map((item, index) => ({ ...item, date: index === 0 ? '2025-12-16T09:39:49Z' : '2025-12-16T14:55:18Z' }));
    expect(citedVersionNote(sameDay, ['offer-v3'])).toBe('Several versions of “Offer_14_Larch_Court_signed.pdf” were found; this answer uses the newest, saved 16 December 2025, 14:55 UTC.');
  });
});
