// The private answer panel reads in depth when one or two items clearly lead,
// lists only the items its answer cites, and shows only gaps that are whole
// sentences the answer does not already contradict.
//
// 2026-10-02 live: "can you give me all the details from that lab please?"
// (after a good first answer about the June 2026 blood work) got four thin
// slices of four items and answered "the provided evidence does not contain
// the details"; the first answer listed a third, unrelated report as a
// source; and its gaps line read "Specific arsenic value for June 2026 is"
// (cut by the schema's 40-character bound) beside an answer that gave it.
// Synthetic fixtures only.

import { describe, expect, test } from 'bun:test';
import type { AnswerPrivatelyOptions, BuiltInAnalystModel, PrivateEvidenceItem as BuiltInEvidenceItem } from '../src/core/analyst-built-in.ts';
import { answerPrivately, cleanUnanswered } from '../src/core/analyst-built-in.ts';
import { analystResponseSchema, analystSchemaGapChars } from '../src/core/analyst.ts';
import {
  PANEL_ANSWER_LIMITS,
  createBuiltInPrivateAnswerModel,
  leadingCount,
  panelSelection,
} from '../src/workers/chatgpt/private-answer-model.ts';
import type { PrivateEvidenceItem } from '../src/workers/chatgpt/private-answer-contract.ts';

function hit(id: string, title: string, text: string): PrivateEvidenceItem {
  return {
    provenance: {
      sourceItem: { family: 'file', provider: 'fixture', accountScope: 'personal', providerItemId: id, localItemId: id },
      citation: { title, uri: `/Labs/${title}` },
    },
    trustDomain: 'secure_local',
    chunks: [text],
  };
}

describe('which items lead', () => {
  test('the top one or two lead when the drop to the next is clear and larger than their own spread', () => {
    // The follow-up's live shape: two reports together, then a slope.
    expect(leadingCount([0.366, 0.361, 0.350, 0.339, 0.333], 2, 0.01)).toBe(2);
    expect(leadingCount([0.505, 0.497, 0.416, 0.40], 2, 0.01)).toBe(2);
    expect(leadingCount([0.62, 0.37, 0.36], 2, 0.01)).toBe(1);
    // An even slope: nothing leads.
    expect(leadingCount([0.50, 0.495, 0.49, 0.485], 2, 0.01)).toBe(0);
    // Leading is off.
    expect(leadingCount([0.62, 0.37], 0, 0.01)).toBe(0);
    // Only one item at all.
    expect(leadingCount([0.4], 2, 0.01)).toBe(1);
  });

  test('leading items are read alone: an item merely within the relevance floor is left out', async () => {
    const read = { items: ['a', 'b', 'c', 'd'].map((id) => ({ id, title: id, text: `text ${id}` })) };
    const limits = { maxItems: 4, relevanceMargin: 0.04, maxLeadingItems: 2, leadGap: 0.01 };
    expect(await panelSelection('q', read, limits, async () => [0.366, 0.361, 0.350, 0.339])).toEqual({ items: [0, 1], leading: true });
    expect(await panelSelection('q', read, limits, async () => [0.50, 0.495, 0.49, 0.485])).toEqual({ items: [0, 1, 2, 3], leading: false });
    // No scores: retrieval order, never leading (nothing says which leads)...
    expect(await panelSelection('q', read, limits)).toEqual({ items: [0, 1, 2, 3], leading: false });
    // ...unless only one item is readable.
    expect(await panelSelection('q', { items: read.items.slice(0, 1) }, limits)).toEqual({ items: [0], leading: true });
  });
});

describe('reading leading items in depth', () => {
  const longText = (label: string, pages: number) => Array.from({ length: pages }, (_, page) => `${label} page ${page + 1}: value ${page + 1}.`).join(' ').padEnd(12_000, ' x');

  function panelWith(answer: (q: string, items: readonly BuiltInEvidenceItem[], options: AnswerPrivatelyOptions) => Promise<{ answer: string; citations: Array<{ id: string; title?: string; claim: string }>; unanswered: string[]; modelId: string }>, extra: Partial<Parameters<typeof createBuiltInPrivateAnswerModel>[0]> = {}) {
    return createBuiltInPrivateAnswerModel({
      model: { name: 'built_in' } as unknown as BuiltInAnalystModel,
      available: () => true,
      answer,
      ...extra,
    });
  }

  test('the follow-up reads both leading reports whole, with the deep prompt and answer budget, and cites only what it used', async () => {
    const evidence = [
      hit('bw1', 'blood work 1.pdf', 'header only'),
      hit('bw2', 'blood work 2.pdf', 'header only'),
      hit('near', 'other report.pdf', 'near text'),
      hit('far', 'far report.pdf', 'far text'),
    ];
    const whole: Record<string, string> = { bw1: longText('bw1', 5).slice(0, 4_000), bw2: longText('bw2', 9) };
    let seen: { items: readonly BuiltInEvidenceItem[]; options: AnswerPrivatelyOptions } | undefined;
    const readRequests: Array<{ id: string; maxChars: number }> = [];
    const panel = panelWith(async (_q, items, options) => {
      seen = { items, options };
      return { answer: 'All values.', citations: [{ id: 'bw1', claim: 'c' }, { id: 'bw2', claim: 'c' }], unanswered: [], modelId: 'm' };
    }, {
      relevance: async () => [0.366, 0.361, 0.350, 0.339],
      readItem: async (item, request) => {
        const id = ((item.provenance as { sourceItem: { localItemId: string } }).sourceItem.localItemId);
        readRequests.push({ id, maxChars: request.maxChars });
        return [whole[id]!.slice(0, request.maxChars)];
      },
      sourceLinks: (item) => {
        const id = ((item.provenance as { sourceItem: { localItemId: string } }).sourceItem.localItemId);
        return { url: `https://www.dropbox.com/home/Labs?preview=${id}`, localPath: `/Users/x/Dropbox/Labs/${id}` };
      },
    });
    const result = await panel.answerPrivately('can you give me all the details from that lab please?', evidence);
    expect(seen!.items.map((item) => item.id)).toEqual(['bw1', 'bw2']);
    expect(seen!.options.maxPromptBytes).toBe(PANEL_ANSWER_LIMITS.deepPromptBytes);
    expect(seen!.options.maxAnswerChars).toBe(PANEL_ANSWER_LIMITS.deepAnswerChars);
    // bw1 (4,000) is read whole; bw2 gets the rest of the budget, re-read at that size.
    expect(seen!.items[0]!.text).toBe(whole.bw1!);
    expect(seen!.items[1]!.text.length).toBe(PANEL_ANSWER_LIMITS.deepEvidenceChars - 4_000);
    expect(readRequests.filter((request) => request.id === 'bw2').map((request) => request.maxChars))
      .toEqual([PANEL_ANSWER_LIMITS.deepEvidenceChars, PANEL_ANSWER_LIMITS.deepEvidenceChars - 4_000]);
    expect(result.citations).toEqual([
      { title: 'blood work 1.pdf', source: 'fixture', url: 'https://www.dropbox.com/home/Labs?preview=bw1', localPath: '/Users/x/Dropbox/Labs/bw1' },
      { title: 'blood work 2.pdf', source: 'fixture', url: 'https://www.dropbox.com/home/Labs?preview=bw2', localPath: '/Users/x/Dropbox/Labs/bw2' },
    ]);
  });

  test('without a clear lead, four items at the standard budget; an uncited item is not a source', async () => {
    const evidence = ['a', 'b', 'c', 'd'].map((id) => hit(id, `${id}.pdf`, `text ${id}`));
    let seen: { items: readonly BuiltInEvidenceItem[]; options: AnswerPrivatelyOptions } | undefined;
    let reads = 0;
    const panel = panelWith(async (_q, items, options) => {
      seen = { items, options };
      return { answer: 'x', citations: [{ id: 'b', claim: 'c' }], unanswered: [], modelId: 'm' };
    }, { relevance: async () => [0.50, 0.495, 0.49, 0.485], readItem: async () => { reads += 1; return ['deep']; } });
    const result = await panel.answerPrivately('q', evidence);
    expect(seen!.items).toHaveLength(4);
    expect(seen!.options.maxPromptBytes).toBe(PANEL_ANSWER_LIMITS.maxPromptBytes);
    expect(seen!.options.maxAnswerChars).toBe(PANEL_ANSWER_LIMITS.maxAnswerChars);
    expect(reads).toBe(0);
    expect(result.citations).toEqual([{ title: 'b.pdf', source: 'fixture' }]);
  });

  test('a failing in-depth read keeps the search-time passages', async () => {
    const evidence = [hit('a', 'a.pdf', 'search passage a')];
    let text = '';
    const panel = panelWith(async (_q, items) => {
      text = items[0]!.text;
      return { answer: 'x', citations: [], unanswered: [], modelId: 'm' };
    }, { readItem: async () => { throw new Error('store busy'); } });
    await panel.answerPrivately('q', evidence);
    expect(text).toBe('search passage a');
  });
});

describe('the gaps the panel shows', () => {
  test('the schema bounds the gap list, with room for a whole sentence each, and keeps claims short', () => {
    const schema = analystResponseSchema(1_000) as { properties: Record<string, { maxItems?: number; items?: { maxLength?: number; properties?: { claim: { maxLength: number } } } }> };
    expect(schema.properties.unanswered!.maxItems).toBe(3);
    expect(schema.properties.unanswered!.items!.maxLength).toBe(analystSchemaGapChars(1_000));
    expect(analystSchemaGapChars(1_000)).toBeGreaterThanOrEqual(120);
    expect((analystResponseSchema(4_600) as typeof schema).properties.citations!.items!.properties!.claim.maxLength).toBe(80);
  });

  test('a cut entry, a restatement of the answer and an empty phrase are dropped; a real gap stays', () => {
    const answer = 'Your June 2026 blood work shows arsenic at 4.1 µg/L and mercury at 1.2 µg/L.';
    const gaps = [
      'Specific arsenic value for June 2026 is'.padEnd(120, ' x'),
      'Specific arsenic value for June 2026 is not provided.',
      'The specific values are not provided in the evidence.',
      'Reference ranges for lead are not in these items.',
      'Reference ranges for lead are not in these items.',
      // A reply field name listed as a gap (seen live on the owner's store).
      'sufficient',
    ];
    expect(cleanUnanswered(gaps, answer, { maxChars: 120, complete: false })).toEqual(['Reference ranges for lead are not in these items.']);
  });

  test('no gaps at all when the model called its answer complete', () => {
    expect(cleanUnanswered(['Reference ranges for lead are not in these items.'], 'x', { maxChars: 120, complete: true })).toEqual([]);
  });

  test('answerPrivately applies it: "sufficient" true shows none; an entry at the bound is dropped', async () => {
    const reply = (body: Record<string, unknown>) => ({
      name: 'built_in',
      spec: { modelId: 'fixture' },
      complete: async () => ({ text: JSON.stringify(body), modelId: 'built_in/fixture' }),
    }) as unknown as BuiltInAnalystModel;
    const evidence = [{ id: 'a', title: 'a.pdf', text: 'Arsenic 4.1 µg/L. Mercury 1.2 µg/L.' }];
    const complete = await answerPrivately('arsenic and mercury?', evidence, {
      model: reply({ answer: 'Arsenic 4.1 µg/L and mercury 1.2 µg/L [1].', citations: [{ evidence: 1, claim: 'Arsenic 4.1' }], unanswered: ['Lead is not in these items.'], sufficient: true }),
      maxAnswerChars: 1_000,
      audit: false,
      evidenceFormat: 'compact',
    });
    expect(complete.unanswered).toEqual([]);
    const cut = 'Specific arsenic value for June 2026 is'.padEnd(analystSchemaGapChars(1_000), ' x');
    const partial = await answerPrivately('arsenic, mercury and lead?', evidence, {
      model: reply({ answer: 'Arsenic 4.1 µg/L and mercury 1.2 µg/L [1].', citations: [{ evidence: 1, claim: 'Arsenic 4.1' }], unanswered: [cut, 'Lead is not in these items.'], sufficient: false }),
      maxAnswerChars: 1_000,
      audit: false,
      evidenceFormat: 'compact',
    });
    expect(partial.unanswered).toEqual(['Lead is not in these items.']);
  });
});
