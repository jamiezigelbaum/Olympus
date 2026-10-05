// Consult outbound gate: the adversarial review's cases (Codex, round 1 on
// 66ac9768). Each finding is either refused here, or recorded as a tested,
// stated limit (`known gap:` tests expect a pass and say why).

import { describe, expect, test } from 'bun:test';
import { createAnalyst, type AnalystModel, type AnalystModelRequest } from '../src/core/analyst.ts';
import type { EvidenceCandidate, EvidencePack } from '../src/core/contracts.ts';
import {
  consultWriterContextFromPack,
  evaluateConsultQuestion,
  evaluateConsultRequest,
  normalizeForComparison,
  type ConsultWriterContext,
  type ConsultWriterContextOptions,
} from '../src/core/consult-gate.ts';

interface Spec {
  chunks?: string[];
  rows?: string[][];
  title?: string;
  author?: string;
  uri?: string;
  accountScope?: string;
}

function packOf(specs: Spec[], question = 'what happened'): EvidencePack {
  return {
    question,
    builtAt: '2026-10-05T09:00:00.000Z',
    candidates: specs.map((spec, index): EvidenceCandidate => ({
      provenance: {
        sourceItem: {
          family: 'file',
          provider: 'synthetic',
          accountScope: spec.accountScope ?? 'personal',
          providerItemId: `item-${index}`,
          localItemId: `local-${index}`,
        },
        citation: {
          ...(spec.title ? { title: spec.title } : {}),
          ...(spec.author ? { authorLabel: spec.author } : {}),
          ...(spec.uri ? { uri: spec.uri } : {}),
        },
      },
      trustTier: 'S4',
      trustDomain: 'secure_local',
      chunks: spec.chunks ?? [],
      ...(spec.rows ? { tables: [{ columns: ['a', 'b'], rows: spec.rows }] } : {}),
    })),
    coverage: { searchedCorpora: ['secure_local.synthetic'], skippedCorpora: [], extractionGaps: [] },
  };
}

function ctx(specs: Spec[], options: ConsultWriterContextOptions = {}): ConsultWriterContext {
  return consultWriterContextFromPack(packOf(specs), options);
}

function refused(question: string, context: ConsultWriterContext): void {
  expect({ question, decision: evaluateConsultQuestion(question, context).decision }).toEqual({ question, decision: 'refuse' });
}

function passed(question: string, context: ConsultWriterContext): void {
  expect({ question, verdict: evaluateConsultQuestion(question, context) }).toEqual({ question, verdict: { decision: 'pass', reasons: [] } });
}

const cp = (...points: number[]) => String.fromCodePoint(...points);
const b64 = (text: string) => Buffer.from(text).toString('base64');

const TENANCY = ctx([{
  author: 'Desmond Achterberg',
  chunks: [
    'Marguerite Okafor confirmed on 14 March 2024 that the deposit of 2,375.50 would be released.',
    'Under the blue lantern clause the landlord may hold the deposit until the shared boiler is serviced.',
  ],
}]);

describe('review 1: long runs and function-word insertion', () => {
  test('a whole copied sentence of mostly function words', () => {
    refused('What if I have cancer and it is in the liver?', ctx([{ chunks: ['I have cancer and it is in the liver'] }]));
  });
  test('one inserted function word', () => {
    refused('Why does amber kestrel folds and beneath violet arches matter?', ctx([{ chunks: ['amber kestrel folds beneath violet arches'] }]));
  });
  test('a function word inserted every three tokens', () => {
    refused(
      'Is under the blue and lantern clause the and landlord may hold and the deposit until and the shared boiler and is serviced enforceable?',
      TENANCY,
    );
  });
});

describe('review 2: names and known identifiers', () => {
  test('known gap: a single-word name seen only at the start of a sentence', () => {
    // No case signal separates it from any capitalized first word.
    passed('Can Nadia appeal?', ctx([{ chunks: ['Nadia reported a breach.'] }]));
  });
  test('a single-word name seen capitalized mid-sentence', () => {
    refused('Can Nadia appeal?', ctx([{ chunks: ['The report from Nadia arrived late.'] }]));
  });
  test('known gap: a name written only in lower case', () => {
    passed('Can Nadia Selwyn appeal?', ctx([{ chunks: ['nadia selwyn reported a breach.'] }]));
  });
  test('one lower-case repeat does not suppress a name', () => {
    refused('Can Nadia Selwyn appeal?', ctx([{ chunks: ['Nadia Selwyn. nadia selwyn.'] }]));
  });
  test('name parts that are also function words', () => {
    refused('Can Will May appeal?', ctx([{ chunks: ['Will May signed.'] }]));
  });
  test('a complete known identifier shorter than three characters', () => {
    refused('Can Li appeal?', ctx([{ author: 'Li' }]));
  });
  test('a capitalized path segment', () => {
    refused('Can Nadia appeal?', ctx([{ uri: '/clients/Nadia/report.txt' }]));
  });
  test('product default scope values are exempt only where the product writes them', () => {
    passed('Which personal records prove a payment?', ctx([{ accountScope: 'personal' }]));
    refused('Which personal records prove a payment?', ctx([{}], { connectedAccountIdentifiers: ['personal'] }));
    refused('What is a default judgment?', ctx([{ title: 'default' }]));
  });
  test('digit fragments compared jointly', () => {
    refused('Is 7319 the prefix and 2846 the suffix?', ctx([{ chunks: ['Account 73192846'] }]));
  });
  test('a name split across sub-questions', () => {
    const verdict = evaluateConsultRequest(['Can Marguerite ask about a lease?', 'Can Okafor dispute a charge?'], TENANCY);
    expect(verdict.decision).toBe('refuse');
  });
  test('concatenation, hyphenation, separated letters, leetspeak, reversal', () => {
    for (const question of [
      'Can MargueriteOkafor appeal?',
      'Can Mar-guerite Oka-for appeal?',
      'Can M.a.r.g.u.e.r.i.t.e appeal?',
      'Can Okaf0r appeal?',
      'Can etireugraM rofakO appeal?',
      'Can rofakO etireugraM appeal?',
    ]) refused(question, TENANCY);
  });
});

describe('review 3: figures and dates', () => {
  test('a bare four-digit number present in the snapshot', () => {
    refused('Is EUR 1984 a lot?', ctx([{ chunks: ['paid EUR 1984 in fees'] }]));
    refused('What changed after 1997?', ctx([{ chunks: ['diagnosed in 1997'] }]));
  });
  test('short figures with a unit, and round numbers', () => {
    refused('Is 8.2 mg high?', ctx([{ chunks: ['8.2 mg daily'] }]));
    refused('Is 1000 units a lot?', ctx([{ chunks: ['a dose of 1000 units'] }]));
  });
  test('underscore separators', () => {
    refused('Is 123_45 normal?', ctx([{ chunks: ['a reading of 123.45'] }]));
  });
  test('dates in CJK, number-word, and Roman-month forms', () => {
    const context = ctx([{ chunks: ['signed 2024-03-14'] }]);
    for (const question of [
      `What happened on 2024${cp(0x5e74)}3${cp(0x6708)}14${cp(0x65e5)}?`,
      'What happened on March fourteen, 2024?',
      'What happened on 14 III 2024?',
      'What happened on the fourteenth of March in twenty twenty four?',
    ]) refused(question, context);
  });
  test('number words, other digit systems, scaled forms', () => {
    const context = ctx([{ chunks: ['a deposit of 2375.50'] }]);
    for (const question of [
      'Is two thousand three hundred seventy five point five zero a lot?',
      `Is ${cp(0x662, 0x663, 0x667, 0x665)}.${cp(0x665, 0x660)} a lot?`,
      'Is 2.3755k a lot?',
    ]) refused(question, context);
  });
});

describe('review 4: encodings and normalization', () => {
  test('short base64, hex with and without spaces, percent-escapes, split base64, apostrophes', () => {
    refused('Is TmFkaWE eligible?', ctx([{ author: 'Nadia' }]));
    refused('Is 4d6961 eligible?', ctx([{ author: 'Mia' }]));
    refused('Can %4Eadia appeal?', ctx([{ author: 'Nadia' }]));
    refused('Can 4e 61 64 69 61 qualify?', ctx([{ author: 'Nadia' }]));
    refused(`Is ${b64('Nadia Selwyn').slice(0, 7)},${b64('Nadia Selwyn').slice(7)} eligible?`, ctx([{ author: 'Nadia Selwyn' }]));
    refused("Can Na'dia appeal?", ctx([{ author: 'Nadia' }]));
  });
  test('known gap: acrostics and other covert channels', () => {
    passed('New accounts deserve independent audits?', ctx([{ author: 'Nadia' }]));
  });
  test('normalization is case-consistent', () => {
    expect(normalizeForComparison(cp(0x395, 0x39b, 0x395, 0x39d, 0x397))).toBe(normalizeForComparison(cp(0x3b5, 0x3bb, 0x3b5, 0x3bd, 0x3b7)));
  });
  test('Latin look-alikes outside the basic alphabet, mark stacks, other scripts mixed in', () => {
    refused(`Can M${cp(0x251)}rguerite Oka${cp(0x192)}or appeal?`, TENANCY);
    refused(`Can x${cp(0x301, 0x302, 0x303)}y appeal?`, TENANCY);
    refused(`Can ${cp(0x555)}kafor appeal?`, TENANCY);
  });
});

describe('review 5: the snapshot as the writer saw it', () => {
  test('whitespace collapsed the way the prompt collapses it', () => {
    refused('Can Nadia Selwyn appeal?', ctx([{ chunks: ['Nadia    Selwyn reported a breach.'] }]));
  });
  test('adjacent table cells and adjacent chunks', () => {
    refused('Can Nadia Selwyn appeal?', ctx([{ rows: [['Nadia', 'Selwyn']] }]));
    refused('Why do amber kestrel folds beneath violet arches?', ctx([{ chunks: ['amber kestrel folds', 'beneath violet arches'] }]));
  });
  test('classification is by schema path; an unknown path is strict', () => {
    const pack = packOf([{}]);
    const withFuture = {
      ...pack,
      candidates: pack.candidates.map((candidate) => ({ ...candidate, futureNote: { provider: 'Nadia' } })),
    } as unknown as EvidencePack;
    const context = consultWriterContextFromPack(withFuture);
    expect(context.entries.filter((entry) => entry.text === 'Nadia').map((entry) => entry.kind)).toEqual(['identifier']);
    refused('Can Nadia appeal?', context);
  });
  test('text the writer saw outside the pack (a draft answer) is compared', () => {
    const context = consultWriterContextFromPack(packOf([{}]), { writerVisibleTexts: ['Nadia Selwyn appealed in writing.'] });
    refused('Can Nadia Selwyn appeal?', context);
  });

  test('every token of every rendered analyst prompt is in the snapshot', async () => {
    const pack = packOf([{
      title: 'Heron Quay tenancy file',
      author: 'Desmond Achterberg',
      uri: 'files/Housing/heron-quay/inventory.pdf',
      chunks: ['Marguerite   Okafor confirmed the deposit.', 'The boiler is shared.'],
      rows: [['Carpet', '186.40']],
    }], 'what did the agent say');
    const blank = JSON.parse(JSON.stringify(pack), (_key, value) =>
      typeof value === 'string' && !['file', 'S4', 'secure_local'].includes(value)
        ? value.replace(/[\p{L}\p{N}]+/gu, 'zzz')
        : typeof value === 'number' ? 0 : value) as EvidencePack;
    const draft = JSON.stringify({ answer: 'Draft says the deposit is held.', citations: [], unanswered: ['inspection date'], sufficient: false });
    const render = async (evidence: EvidencePack, format: 'full' | 'compact'): Promise<string[]> => {
      const prompts: string[] = [];
      const model: AnalystModel = {
        id: 'double',
        async complete(request: AnalystModelRequest) {
          prompts.push(request.prompt);
          return { text: draft, modelId: 'double' };
        },
      } as unknown as AnalystModel;
      await createAnalyst(model, { evidenceFormat: format, auditSuspiciousDrafts: true }).analyze(evidence, { localOnly: true });
      return prompts;
    };
    const words = (text: string) => new Set(text.normalize('NFKD').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean));
    const context = consultWriterContextFromPack(pack, { writerVisibleTexts: [draft] });
    const snapshotWords = words(context.entries.map((entry) => entry.text).join(' '));
    for (const format of ['full', 'compact'] as const) {
      const prompts = await render(pack, format);
      const template = words((await render(blank, format)).join(' ') + ' ' + draft);
      expect(prompts.length).toBeGreaterThan(0);
      const missing = [...words(prompts.join(' '))].filter((word) => !snapshotWords.has(word) && !template.has(word));
      expect({ format, missing }).toEqual({ format, missing: [] });
    }
  });
});

describe('review 6: bounded work', () => {
  test('hostname scanning is linear', () => {
    const context: ConsultWriterContext = { overflow: false, entries: [{ kind: 'text', text: 'a.'.repeat(200_000), path: 'x', group: -1 }] };
    const started = performance.now();
    evaluateConsultQuestion('Is sample.example reachable?', context);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
  test('a ceiling-sized snapshot of short tokens stays fast', () => {
    const context = consultWriterContextFromPack(packOf([{ chunks: Array.from({ length: 1_000 }, () => 'a '.repeat(500)) }]));
    expect(context.overflow).toBe(false);
    const started = performance.now();
    evaluateConsultQuestion('What usually causes supplier delays across regions?', context);
    expect(performance.now() - started).toBeLessThan(3_000);
  });
  test('worst case for the run matcher: one repeated word on both sides', () => {
    const context: ConsultWriterContext = { overflow: false, entries: [{ kind: 'text', text: 'the '.repeat(262_000), path: 'x', group: -1 }] };
    const question = `Is ${'the '.repeat(70)}it?`;
    const started = performance.now();
    evaluateConsultQuestion(question, context);
    expect(performance.now() - started).toBeLessThan(4_000);
  });
  test('millions of empty strings overflow the builder instead of passing its ceilings', () => {
    const pack = packOf([{ chunks: new Array<string>(5_000_000).fill('') }]);
    expect(consultWriterContextFromPack(pack).overflow).toBe(true);
  });
  test('a question refused on its own characters does no snapshot work', () => {
    const big = consultWriterContextFromPack(packOf([{ chunks: Array.from({ length: 500 }, () => 'word '.repeat(300)) }]));
    const started = performance.now();
    expect(evaluateConsultQuestion('What\tis this?', big).reasons).toEqual(['control_character']);
    expect(performance.now() - started).toBeLessThan(50);
  });
});

describe('review 7: structure and linkage', () => {
  test('many asks behind one question mark', () => {
    refused('Please explain refunds, compare arbitration, outline mediation, describe escrow, assess depreciation, and summarize limitation periods?', TENANCY);
  });
  test('an exact repeat of a short recent consult', () => {
    const verdict = evaluateConsultQuestion('What is a deposit?', TENANCY, {}, { recentApprovedQuestions: ['What is a deposit?'] });
    expect(verdict.reasons).toContain('repeats_recent_consult');
  });
  test('one inserted word does not break linkage', () => {
    const verdict = evaluateConsultQuestion(
      'How long does a landlord really usually have to return a deposit after a tenancy ends?',
      TENANCY,
      {},
      { recentApprovedQuestions: ['How long does a landlord usually have to return a deposit after a tenancy ends?'] },
    );
    expect(verdict.reasons).toContain('links_recent_consult');
  });
});

describe('review: other passes', () => {
  test('spelled-out and ideographic dots in a host', () => {
    const context = ctx([{ chunks: ['portfolio at nadia.photography'] }]);
    refused('Is nadia dot photography a good site?', context);
    refused(`Is nadia${cp(0x3002)}photography a good site?`, context);
  });
  test('known gap: a single-label host written as an ordinary word', () => {
    passed('Why would kelpbox stop?', ctx([{ chunks: ['Internal host kelpbox stopped.'] }]));
  });
  test('a two-segment path', () => {
    refused('What belongs in src/secrets?', TENANCY);
  });
  test('an unlabelled secret value seen under a label in the snapshot', () => {
    refused('Is password sunburst secure?', ctx([{ chunks: ['password: sunburst'] }]));
  });
  test('known gap: a short name in a script without spaces or case', () => {
    passed(`${cp(0x738b, 0x82b3)}${cp(0x53ef, 0x4ee5)}${cp(0x4e0a, 0x8bc9)}${cp(0x5417)}?`, ctx([{ chunks: [`${cp(0x738b, 0x82b3)}${cp(0x63d0, 0x4ea4)}${cp(0x4e86, 0x62a5, 0x544a)}`] }]));
  });
  test('Hangul spacing changes do not hide a copy', () => {
    const korean = cp(0xae40, 0xbbfc, 0xc900, 0x20, 0xb300, 0xd45c, 0xac00, 0x20, 0xc2b9, 0xc778, 0xd588, 0xb2e4);
    const respaced = `${cp(0xae40, 0x20, 0xbbfc, 0xc900, 0xb300, 0xd45c, 0xac00, 0x20, 0xc2b9, 0xc778)}?`;
    refused(respaced, ctx([{ chunks: [korean] }]));
  });
});
