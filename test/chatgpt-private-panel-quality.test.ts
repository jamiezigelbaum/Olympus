// The private answer panel reads only items that bear on the question, says
// so when they do not answer it, and never shows one sentence twice.
//
// 2026-10-11 live (reviewer demo, built-in Qwen3.5 2B on CPU): "What did my
// blood test results say?" matched two items and was offered three nearest
// neighbours; the panel read four, mixed a bank statement's balance into the
// answer and printed "Your September statement shows an account balance of
// $8,940.00." three times. Synthetic fixtures only.

import { describe, expect, test } from 'bun:test';
import type { AnswerPrivatelyOptions, BuiltInAnalystModel, PrivateEvidenceItem as BuiltInEvidenceItem } from '../src/core/analyst-built-in.ts';
import { answerPrivately, PRIVATE_ANSWER_NOT_FOUND } from '../src/core/analyst-built-in.ts';
import type { AnalystModelRequest } from '../src/core/analyst.ts';
import {
  createBuiltInPrivateAnswerModel,
  panelSelection,
  withoutRepeatedEntries,
  withoutRepeatedSentences,
} from '../src/workers/chatgpt/private-answer-model.ts';
import { NoPrivateEvidenceError, type PrivateEvidenceItem } from '../src/workers/chatgpt/private-answer-contract.ts';

const ALL_ELIGIBLE = async (items: readonly unknown[]) => items.map(() => true);

function hit(id: string, title: string, text: string, neighbour = false): PrivateEvidenceItem {
  return {
    provenance: {
      sourceItem: { family: 'file', provider: 'fixture', accountScope: 'personal', providerItemId: id, localItemId: id },
      citation: { title },
    },
    trustDomain: 'secure_local',
    chunks: [text],
    ...(neighbour ? { neighbour: true } : {}),
  };
}

const items = (ids: readonly string[]) => ids.map((id) => ({ id, title: id, text: `text ${id}` }));
const LIMITS = { maxItems: 4, relevanceMargin: 0.04, maxLeadingItems: 2, leadGap: 0.03 };

describe('nearest neighbours are read only when they outrank every match', () => {
  test('a neighbour scoring below the best match is left out, however close', async () => {
    // Two matches, two neighbours, all within the 0.04 relevance floor (a
    // narrow cosine scale on a tiny store): only the matches are read.
    const read = { items: items(['labs', 'clinic', 'bank', 'tax']), neighbours: [false, false, true, true] };
    const picked = await panelSelection('blood test results', read, LIMITS, async () => [0.71, 0.70, 0.705, 0.69]);
    expect(picked.items).toEqual([0, 1]);
  });

  test('a neighbour that outranks every match is read, first (the cross-language letter of intent)', async () => {
    // 2026-10-10: the Spanish letter of intent was found by neither lane; its
    // nearest versions were closer to the question than any keyword match.
    const read = { items: items(['m1', 'm2', 'm3', 'loi']), neighbours: [false, false, false, true] };
    const picked = await panelSelection('Letter of Intent notary', read, LIMITS, async () => [0.33, 0.32, 0.31, 0.45]);
    expect(picked).toEqual({ items: [3], leading: true });
    // A tie with the best match counts as outranking it.
    const tie = await panelSelection('q', read, { ...LIMITS, maxLeadingItems: 0 }, async () => [0.40, 0.30, 0.29, 0.40]);
    expect(tie.items).toEqual([0, 3]);
  });

  test('without scores, or with no readable match, no neighbour is read', async () => {
    const read = { items: items(['m1', 'n1', 'n2']), neighbours: [false, true, true] };
    expect(await panelSelection('q', read, LIMITS)).toEqual({ items: [0], leading: true });
    expect(await panelSelection('q', read, LIMITS, async () => undefined)).toEqual({ items: [0], leading: true });
    const onlyNeighbours = { items: items(['n1', 'n2']), neighbours: [true, true] };
    expect(await panelSelection('q', onlyNeighbours, LIMITS, async () => [0.9, 0.8])).toEqual({ items: [], leading: false });
    // No neighbour flags: unchanged behaviour.
    expect(await panelSelection('q', { items: items(['a', 'b', 'c']) }, { ...LIMITS, maxLeadingItems: 0 }, async () => [0.5, 0.49, 0.48])).toEqual({ items: [0, 1, 2], leading: false });
  });
});

describe('the panel answer', () => {
  function panelWith(
    answer: (q: string, items: readonly BuiltInEvidenceItem[], options: AnswerPrivatelyOptions) => Promise<{ answer: string; citations: Array<{ id: string; title?: string; claim: string }>; unanswered: string[]; modelId: string }>,
    extra: Partial<Parameters<typeof createBuiltInPrivateAnswerModel>[0]> = {},
  ) {
    return createBuiltInPrivateAnswerModel({
      eligible: ALL_ELIGIBLE,
      model: { name: 'built_in' } as unknown as BuiltInAnalystModel,
      available: () => true,
      answer,
      ...extra,
    });
  }

  test('the blood-test shape: the bank-statement neighbour is not read, and a looped sentence appears once', async () => {
    const evidence = [
      hit('labs', 'Lab results Sept.pdf', 'Ferritin 41 ng/mL. TSH 2.1 mIU/L.'),
      hit('clinic', 'Clinic visit.pdf', 'Blood drawn for ferritin and TSH.'),
      hit('bank', 'Bank notice.pdf', 'Your September statement shows an account balance of $8,940.00.', true),
      hit('tax', 'Tax notes.pdf', 'Paid $1,240 for the 2025 tax year.', true),
      hit('lease', 'Lease.pdf', 'Rent is due on the first.', true),
    ];
    let read: string[] = [];
    const looped = 'Your ferritin was 41 ng/mL [1]. Your ferritin was 41 ng/mL [1].\nYour ferritin was 41 ng/mL.\n\nTSH was 2.1 mIU/L [1].';
    const panel = panelWith(async (_q, given) => {
      read = given.map((item) => item.id);
      return { answer: looped, citations: [{ id: 'labs', claim: 'ferritin' }], unanswered: ['TSH range is not given.', 'TSH range is not given.'], modelId: 'm' };
    }, { relevance: async () => [0.72, 0.70, 0.705, 0.69, 0.68] });
    const result = await panel.answerPrivately('What did my blood test results say?', evidence);
    expect(read).toEqual(['labs', 'clinic']);
    expect(result.answer).toBe('Your ferritin was 41 ng/mL.\n\nTSH was 2.1 mIU/L.');
    expect(result.unanswered).toEqual(['TSH range is not given.']);
  });

  test('only neighbours readable: no answer from them', async () => {
    const panel = panelWith(async () => ({ answer: 'x', citations: [], unanswered: [], modelId: 'm' }), { relevance: async () => [0.9, 0.8] });
    const evidence = [
      { ...hit('match', 'Match.pdf', ''), chunks: [] },
      hit('n1', 'Other.pdf', 'Unrelated.', true),
      hit('n2', 'Another.pdf', 'Also unrelated.', true),
    ];
    // The match is unreadable: the answer says so; neighbours are not read.
    const result = await panel.answerPrivately('q', evidence);
    expect(result.answer).toContain('no readable text');
    expect(result.citations).toEqual([]);
    // No match at all (only neighbours): no evidence.
    await expect(panel.answerPrivately('q', evidence.slice(1))).rejects.toBeInstanceOf(NoPrivateEvidenceError);
  });

  test('the panel prompt tells the model to say so when no item answers, and never to repeat itself', async () => {
    let request: AnalystModelRequest | undefined;
    const model = {
      name: 'built_in',
      spec: { modelId: 'fixture' },
      complete: async (r: AnalystModelRequest) => {
        request = r;
        // A small model that cites nothing: the panel says the items do not answer.
        return { text: JSON.stringify({ answer: 'The user paid taxes.', citations: [], unanswered: [], sufficient: false }), modelId: 'built_in/fixture' };
      },
    } as unknown as BuiltInAnalystModel;
    const result = await answerPrivately('what did I decide about the budget last month?', [{ id: 'tax', title: 'Tax notes.pdf', text: 'Paid $1,240 for the 2025 tax year.' }], {
      model,
      maxAnswerChars: 1_000,
      audit: false,
      evidenceFormat: 'compact',
    });
    expect(request!.system).toContain('If no item is about what the question asks, the whole answer is one short sentence saying the evidence does not answer it');
    expect(request!.system).toContain('Never describe an item about something else as if it answered the question.');
    expect(request!.system).toContain('never repeat a sentence or a line');
    expect(result.answer).toBe(PRIVATE_ANSWER_NOT_FOUND);
    expect(result.citations).toEqual([]);
  });
});

describe('repeated sentences', () => {
  test('a sentence repeating the one right before it in a prose paragraph is removed; line breaks are kept', () => {
    const balance = 'Your September statement shows an account balance of $8,940.00.';
    expect(withoutRepeatedSentences(`${balance} ${balance} ${balance} The loan balance is $12,300.`))
      .toBe(`${balance} The loan balance is $12,300.`);
    expect(withoutRepeatedSentences(`${balance}\n${balance}\n${balance}\nThe loan balance is $12,300.`))
      .toBe(`${balance}\nThe loan balance is $12,300.`);
    expect(withoutRepeatedSentences('Ferritin was 41 ng/mL. ferritin  was 41 ng/mL\nTSH was 2.1 mIU/L.')).toBe('Ferritin was 41 ng/mL.\nTSH was 2.1 mIU/L.');
    // Nothing repeated: returned exactly as given.
    const plain = 'Line one says a thing.\n\n  - Indented item stays.\n| a | b |\n|---|---|';
    expect(withoutRepeatedSentences(plain)).toBe(plain);
  });

  test('conservative: abbreviations, short sentences, rewordings and table rules stay', () => {
    const doctors = 'Dr. Lee reviewed the results. Dr. Shah reviewed the results.';
    expect(withoutRepeatedSentences(doctors)).toBe(doctors);
    expect(withoutRepeatedSentences('Yes. The rent is due. Yes.')).toBe('Yes. The rent is due. Yes.');
    const reworded = 'Ferritin was 41 ng/mL. Your ferritin level was 41 ng/mL.';
    expect(withoutRepeatedSentences(reworded)).toBe(reworded);
    const tables = '| a | b |\n|---|---|\n| 1 | 2 |\n\n| c | d |\n|---|---|\n| 3 | 4 |';
    expect(withoutRepeatedSentences(tables)).toBe(tables);
    // Different numbers are different sentences.
    const values = 'The balance was $8,940.00 in September. The balance was $8,490.00 in September.';
    expect(withoutRepeatedSentences(values)).toBe(values);
  });

  // Review of #272: one fee under two months is two facts, not a repeat.
  test('a repeat under another heading or subject stays; headings, list items and table rows are never touched', () => {
    const fee = 'The fee is €25.';
    const contextual = [
      `September:\n${fee}\nOctober:\n${fee}`,
      `## September\n${fee}\n\n## October\n${fee}`,
      `**September**\n${fee}\n**October**\n${fee}`,
      `September statement:\n- ${fee}\n- ${fee}\nOctober statement:\n- ${fee}`,
      '| Month | Fee |\n|---|---|\n| September fee charged | €25 |\n| September fee charged | €25 |',
      // Not consecutive: another sentence sits between.
      `${fee} Rent is due monthly. ${fee}`,
      // Another paragraph (a blank line between).
      `${fee}\n\n${fee}`,
      // One line, two subjects.
      'In September the fee is €25. In October the fee is €25.',
    ];
    for (const answer of contextual) expect(withoutRepeatedSentences(answer)).toBe(answer);
  });

  test('gap lines are listed once', () => {
    expect(withoutRepeatedEntries(['The rent is not given.', 'the rent is not given', 'Deposit is not given.'])).toEqual(['The rent is not given.', 'Deposit is not given.']);
  });
});
