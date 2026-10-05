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
import { NoPrivateEvidenceError, PRIVATE_ANSWER_META_KEY, type PrivateAnswerModel, type PrivateEvidenceItem } from '../src/workers/chatgpt/private-answer-contract.ts';
import { generatePanelKeyPair } from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PRIVATE_ANSWER_FULL_ANALYSIS_TIMEOUT_MS, PrivateAnswerJobs } from '../src/workers/chatgpt/private-answer-jobs.ts';
import { SEARCH_TOOL, SOURCE_ANSWER_TOOL, callChatGptTool, type ChatGptSurfaceOptions } from '../src/workers/chatgpt/mcp-surface.ts';
import { copyPrivateMatch } from '../src/workers/chatgpt/response-builder.ts';
import type { OperationContext } from '../src/core/operations.ts';

/** Synthetic fixtures with no store behind them: every item is eligible unless a test says otherwise. */
const ALL_ELIGIBLE = async (items: readonly unknown[]) => items.map(() => true);

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
    return createBuiltInPrivateAnswerModel({ eligible: ALL_ELIGIBLE,
      model: { name: 'built_in' } as unknown as BuiltInAnalystModel,
      available: () => true,
      answer,
      ...extra,
    });
  }

  test('detail "full": the follow-up reads both leading reports whole, with the deep prompt and answer budget, and cites only what it used', async () => {
    const evidence = [
      hit('bw1', 'blood work 1.pdf', 'header only'),
      hit('bw2', 'blood work 2.pdf', 'header only'),
      hit('near', 'other report.pdf', 'near text'),
      hit('far', 'far report.pdf', 'far text'),
    ];
    const whole: Record<string, string> = { bw1: longText('bw1', 5).slice(0, 3_000), bw2: longText('bw2', 9) };
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
    const result = await panel.answerPrivately('June 2026 blood work all details', evidence, undefined, undefined, { detail: 'full' });
    expect(seen!.items.map((item) => item.id)).toEqual(['bw1', 'bw2']);
    expect(seen!.options.maxPromptBytes).toBe(PANEL_ANSWER_LIMITS.deepPromptBytes);
    expect(seen!.options.maxAnswerChars).toBe(PANEL_ANSWER_LIMITS.deepAnswerChars);
    // bw1 (3,000) is read whole; bw2 gets the rest of the budget, re-read at that size.
    expect(seen!.items[0]!.text).toBe(whole.bw1!);
    expect(seen!.items[1]!.text.length).toBe(PANEL_ANSWER_LIMITS.deepEvidenceChars - 3_000);
    expect(readRequests.filter((request) => request.id === 'bw2').map((request) => request.maxChars))
      .toEqual([PANEL_ANSWER_LIMITS.deepEvidenceChars, PANEL_ANSWER_LIMITS.deepEvidenceChars - 3_000]);
    expect(result.citations).toEqual([
      { title: 'blood work 1.pdf', source: 'fixture', url: 'https://www.dropbox.com/home/Labs?preview=bw1', localPath: '/Users/x/Dropbox/Labs/bw1' },
      { title: 'blood work 2.pdf', source: 'fixture', url: 'https://www.dropbox.com/home/Labs?preview=bw2', localPath: '/Users/x/Dropbox/Labs/bw2' },
    ]);
  });

  test('summary (the default): leading items only, re-read for their best passages within the summary budget, at the standard prompt and answer budget', async () => {
    const evidence = [
      hit('bw1', 'blood work 1.pdf', 'header only'),
      hit('bw2', 'blood work 2.pdf', 'header only'),
      hit('april', 'april report.pdf', 'near text'),
      hit('far', 'far report.pdf', 'far text'),
    ];
    let seen: { items: readonly BuiltInEvidenceItem[]; options: AnswerPrivatelyOptions } | undefined;
    const sizes: number[] = [];
    const panel = panelWith(async (_q, items, options) => {
      seen = { items, options };
      return { answer: 'x', citations: [{ id: 'bw1', claim: 'c' }], unanswered: [], modelId: 'm' };
    }, {
      relevance: async () => [0.505, 0.497, 0.416, 0.40],
      readItem: async (_item, request) => {
        sizes.push(request.maxChars);
        return ['results page '.repeat(1_000).slice(0, request.maxChars)];
      },
    });
    await panel.answerPrivately('What did my June 2026 blood work show?', evidence);
    expect(seen!.items.map((item) => item.id)).toEqual(['bw1', 'bw2']);
    expect(seen!.options.maxPromptBytes).toBe(PANEL_ANSWER_LIMITS.maxPromptBytes);
    expect(seen!.options.maxAnswerChars).toBe(PANEL_ANSWER_LIMITS.maxAnswerChars);
    expect(seen!.items.reduce((sum, item) => sum + item.text.length, 0)).toBeLessThanOrEqual(PANEL_ANSWER_LIMITS.leadingEvidenceChars);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(PANEL_ANSWER_LIMITS.leadingEvidenceChars);
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

  test('a failing in-depth read (transient) keeps only the passages the dispatch-time re-check returned', async () => {
    const evidence = [hit('a', 'a.pdf', 'search passage a')];
    let text = '';
    const panel = panelWith(async (_q, items) => {
      text = items[0]!.text;
      return { answer: 'x', citations: [], unanswered: [], modelId: 'm' };
    }, { readItem: async () => { throw new Error('store busy'); } });
    await panel.answerPrivately('q', evidence);
    expect(text).toBe('search passage a');
  });

  test('an in-depth read the store refuses (re-tiered, out of scope, gone) drops the item: no fallback to its passages', async () => {
    const evidence = [hit('a', 'a.pdf', 'SENTINEL_REFUSED_PASSAGE_4d1b'), hit('b', 'b.pdf', 'passage b')];
    let seen: readonly BuiltInEvidenceItem[] = [];
    const stats: Array<{ items: number; unreadable: number; bytes: number; used?: readonly number[] }> = [];
    const panel = panelWith(async (_q, items) => {
      seen = items;
      return { answer: 'x', citations: [{ id: 'a', claim: 'c' }, { id: 'b', claim: 'c' }], unanswered: [], modelId: 'm' };
    }, {
      // Both lead; the store now refuses `a`.
      relevance: async () => [0.9, 0.89],
      readItem: async (item) => ((item.provenance as { sourceItem: { localItemId: string } }).sourceItem.localItemId === 'a' ? undefined : ['deep b']),
    });
    const result = await panel.answerPrivately('q', evidence, undefined, { evidence: (entry) => stats.push(entry) });
    expect(seen.map((item) => item.id)).toEqual(['b']);
    expect(JSON.stringify(seen)).not.toContain('SENTINEL_REFUSED_PASSAGE_4d1b');
    // Truthful counts: one item used (b, input index 1), nothing reported unreadable.
    expect(stats).toEqual([{ items: 1, unreadable: 0, bytes: 'passage b'.length, used: [1] }]);
    // A dropped item is never a source, even if the model named it.
    expect(result.citations).toEqual([{ title: 'b.pdf', source: 'fixture' }]);
  });

  test('every picked item refused on re-read: no model call, and the no-evidence outcome', async () => {
    let calls = 0;
    const panel = panelWith(async () => {
      calls += 1;
      return { answer: 'x', citations: [], unanswered: [], modelId: 'm' };
    }, { readItem: async () => undefined });
    await expect(panel.answerPrivately('q', [hit('a', 'a.pdf', 'SENTINEL_REFUSED_PASSAGE_4d1b')])).rejects.toBeInstanceOf(NoPrivateEvidenceError);
    expect(calls).toBe(0);

    // Through the jobs: the claim fails, and the log says no evidence.
    const lines: string[] = [];
    const jobs = new PrivateAnswerJobs({ eligible: ALL_ELIGIBLE, model: () => panel, installId: () => 'e'.repeat(32), log: (line) => lines.push(line), claimHoldMs: 0, audit: () => {} });
    const evidence = [hit('a', 'a.pdf', 'SENTINEL_REFUSED_PASSAGE_4d1b')];
    const { jobId } = jobs.begin({ question: 'q', count: 1, evidence, refresh: async () => evidence });
    const key = await generatePanelKeyPair();
    await jobs.claim(jobId!, key.publicKey);
    await Bun.sleep(50);
    expect(await jobs.claim(jobId!, key.publicKey)).toEqual({ status: 200, body: { status: 'failed' } });
    expect(calls).toBe(0);
    expect(lines.join('\n')).toContain('reason=no_evidence');
    expect(lines.join('\n')).not.toContain('SENTINEL');
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

describe('detail: chosen by ChatGPT\'s model through the tool argument', () => {
  const INSTALL = 'a'.repeat(32);
  const EVIDENCE = [{ title: 'e', trust_domain: 'secure_local' }];

  function recordingModel() {
    const calls: Array<{ question: string; detail: string | undefined }> = [];
    const model: PrivateAnswerModel = {
      status: () => ({ state: 'ready' }),
      answerPrivately: async (question, _evidence, _signal, _observe, request) => {
        calls.push({ question, detail: request?.detail });
        return { answer: 'a', citations: [] };
      },
    };
    return { model, calls };
  }

  test('olympus_search and source_answer declare it; anything but summary/full is refused', async () => {
    for (const tool of [SEARCH_TOOL, SOURCE_ANSWER_TOOL]) {
      expect(tool.inputSchema.properties.detail).toMatchObject({ type: 'string', enum: ['summary', 'full'] });
      expect(tool.inputSchema.required).toEqual(['question']);
    }
    expect(String((SEARCH_TOOL.inputSchema.properties.detail as { description: string }).description)).toContain('"full" when the user asks for all the details');
    const { model } = recordingModel();
    const jobs = new PrivateAnswerJobs({ eligible: ALL_ELIGIBLE, model: () => model, installId: () => INSTALL, log: () => {}, claimHoldMs: 0 });
    const options: ChatGptSurfaceOptions = {
      dashboardView: async () => ({}) as never,
      evidenceSearch: async () => ({ evidence: [], coverage: {} }),
      privateMatchProbe: async () => ({ count: 1, evidence: EVIDENCE }),
      privateAnswers: jobs,
    };
    const bad = await callChatGptTool(SEARCH_TOOL.name, { question: 'q', detail: 'everything' }, {} as OperationContext, options);
    expect(bad.isError).toBe(true);
  });

  test('it flows into the private job, the job\'s _meta says detail "full", and the same question in each detail is a separate answer', async () => {
    const { model, calls } = recordingModel();
    const jobs = new PrivateAnswerJobs({ eligible: ALL_ELIGIBLE, model: () => model, installId: () => INSTALL, log: () => {}, claimHoldMs: 0 });
    const options: ChatGptSurfaceOptions = {
      dashboardView: async () => ({}) as never,
      evidenceSearch: async () => ({ evidence: [], coverage: {} }),
      privateMatchProbe: async () => ({ count: 1, evidence: EVIDENCE }),
      privateAnswers: jobs,
    };
    const full = await callChatGptTool(SEARCH_TOOL.name, { question: 'June 2026 blood work', detail: 'full' }, {} as OperationContext, options);
    const summary = await callChatGptTool(SEARCH_TOOL.name, { question: 'June 2026 blood work' }, {} as OperationContext, options);
    const fullMeta = (full._meta as Record<string, Record<string, unknown>>)[PRIVATE_ANSWER_META_KEY]!;
    const summaryMeta = (summary._meta as Record<string, Record<string, unknown>>)[PRIVATE_ANSWER_META_KEY]!;
    expect(fullMeta).toMatchObject({ v: 1, state: 'ready', detail: 'full' });
    expect(summaryMeta).not.toHaveProperty('detail');
    // The model never sees it: only the widget-only _meta carries it.
    expect(JSON.stringify(full.structuredContent ?? {})).not.toContain('"detail"');
    await Bun.sleep(30);
    expect(calls.map((call) => call.detail).sort()).toEqual(['full', 'summary']);
  });

  test('copyPrivateMatch carries detail only for a ready full job', () => {
    const jobId = `oly2p.${INSTALL}.${'A'.repeat(43)}`;
    expect(copyPrivateMatch({ count: 2, panelState: 'ready', jobId, detail: 'full' })).toEqual({ v: 1, count: 2, state: 'ready', jobId, detail: 'full' });
    expect(copyPrivateMatch({ count: 2, panelState: 'ready', jobId, detail: 'summary' })).toEqual({ v: 1, count: 2, state: 'ready', jobId });
    expect(copyPrivateMatch({ count: 2, panelState: 'no_model', detail: 'full' })).toEqual({ v: 1, count: 2, state: 'no_model' });
  });

  test('a full job has the longer deadline; a summary job keeps the short one', async () => {
    const never: PrivateAnswerModel = { status: () => ({ state: 'ready' }), answerPrivately: () => new Promise(() => {}) };
    const lines: string[] = [];
    const jobs = new PrivateAnswerJobs({ eligible: ALL_ELIGIBLE,
      model: () => never, installId: () => INSTALL, log: (line) => lines.push(line), claimHoldMs: 0,
      analysisTimeoutMs: 40, fullAnalysisTimeoutMs: 400, audit: () => {},
    });
    const summary = jobs.begin({ question: 's', count: 1, evidence: EVIDENCE, refresh: async () => EVIDENCE }).jobId!;
    const full = jobs.begin({ question: 'f', count: 1, evidence: EVIDENCE, refresh: async () => EVIDENCE, detail: 'full' }).jobId!;
    const key = (await generatePanelKeyPair()).publicKey;
    const key2 = (await generatePanelKeyPair()).publicKey;
    await jobs.claim(summary, key);
    await jobs.claim(full, key2);
    await Bun.sleep(150);
    expect((await jobs.claim(summary, key)).body.status).toBe('failed');
    expect((await jobs.claim(full, key2)).body.status).toBe('pending');
    expect(PRIVATE_ANSWER_FULL_ANALYSIS_TIMEOUT_MS).toBe(240_000);
  });
});

describe('full detail fits its deadline on a busy Mac', () => {
  // 2026-10-02 live: 10,000 characters of evidence and a 3,700-character
  // answer budget took 179.4 s of a 180 s deadline (prefill 64 s for 3,920
  // tokens, 2.8 tokens/s). Smaller budgets, and a longer deadline.
  test('about 7k characters of evidence, an answer of about 1.5k characters, 240 s', () => {
    expect(PANEL_ANSWER_LIMITS.deepEvidenceChars).toBe(7_000);
    const answer = (analystResponseSchema(PANEL_ANSWER_LIMITS.deepAnswerChars).properties as Record<string, { maxLength?: number }>).answer!;
    expect(answer.maxLength).toBeGreaterThanOrEqual(1_400);
    expect(answer.maxLength).toBeLessThanOrEqual(1_500);
    // The prompt holds the evidence and the instructions around it.
    expect(PANEL_ANSWER_LIMITS.deepPromptBytes).toBeGreaterThan(PANEL_ANSWER_LIMITS.deepEvidenceChars + 4_000);
    expect(PRIVATE_ANSWER_FULL_ANALYSIS_TIMEOUT_MS).toBe(240_000);
  });
});

describe('a private match probe that is slow or fails', () => {
  const INSTALL = 'a'.repeat(32);
  const QUESTION = 'SENTINEL_QUESTION_5d1e what did my report show';

  function options(probe: NonNullable<ChatGptSurfaceOptions['privateMatchProbe']>, lines: string[]): ChatGptSurfaceOptions {
    const model: PrivateAnswerModel = { status: () => ({ state: 'ready' }), answerPrivately: async () => ({ answer: 'a', citations: [] }) };
    return {
      dashboardView: async () => ({}) as never,
      evidenceSearch: async () => ({ evidence: [], coverage: {} }),
      privateMatchProbe: probe,
      privateMatchProbeTimeoutMs: 30,
      privateMatchProbeLog: (line) => lines.push(line),
      privateAnswers: new PrivateAnswerJobs({ eligible: ALL_ELIGIBLE, model: () => model, installId: () => INSTALL, log: () => {}, claimHoldMs: 0 }),
    };
  }

  test('a probe past its deadline: no panel, and one counts-only line that says it timed out', async () => {
    const lines: string[] = [];
    const result = await callChatGptTool(SEARCH_TOOL.name, { question: QUESTION }, {} as OperationContext, options(() => new Promise(() => {}), lines));
    expect(result.isError).not.toBe(true);
    expect((result._meta as Record<string, unknown> | undefined)?.[PRIVATE_ANSWER_META_KEY]).toBeUndefined();
    expect(lines).toEqual(['[chatgpt] private match probe timed_out stage=search timeout_ms=30']);
  });

  test('a probe that fails: no panel, and one line that says it failed, without the question', async () => {
    const lines: string[] = [];
    const result = await callChatGptTool(SEARCH_TOOL.name, { question: QUESTION }, {} as OperationContext, options(async () => {
      throw new Error(`boom ${QUESTION}`);
    }, lines));
    expect((result._meta as Record<string, unknown> | undefined)?.[PRIVATE_ANSWER_META_KEY]).toBeUndefined();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[chatgpt\] private match probe failed stage=search elapsed_ms=\d+$/);
  });

  test('a probe in time logs nothing', async () => {
    const lines: string[] = [];
    const result = await callChatGptTool(SEARCH_TOOL.name, { question: QUESTION }, {} as OperationContext, options(async () => ({ count: 1, evidence: [{ title: 'e', trust_domain: 'secure_local' }] }), lines));
    expect((result._meta as Record<string, Record<string, unknown>>)[PRIVATE_ANSWER_META_KEY]).toMatchObject({ count: 1, state: 'ready' });
    expect(lines).toEqual([]);
  });
});
