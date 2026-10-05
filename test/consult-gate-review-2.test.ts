// Consult outbound gate: the second adversarial review's cases (Codex, round 2
// on b2332dc3). Each case is refused here or recorded as a tested, stated limit
// (`known gap:` tests expect a pass and say why).

import { describe, expect, test } from 'bun:test';
import type { EvidenceCandidate, EvidencePack } from '../src/core/contracts.ts';
import {
  consultWriterContextFromPack,
  evaluateConsultQuestion,
  evaluateConsultRequest,
  type ConsultWriterContext,
  type ConsultWriterContextOptions,
} from '../src/core/consult-gate.ts';

interface Spec {
  chunks?: string[];
  title?: string;
  providerItemId?: string;
}

function packOf(specs: Spec[]): EvidencePack {
  return {
    question: 'what happened',
    builtAt: '2026-10-05T09:00:00.000Z',
    candidates: specs.map((spec, index): EvidenceCandidate => ({
      provenance: {
        sourceItem: {
          family: 'file',
          provider: 'synthetic',
          accountScope: 'personal',
          providerItemId: spec.providerItemId ?? `item-${index}`,
          localItemId: `local-${index}`,
        },
        citation: spec.title ? { title: spec.title } : {},
      },
      trustTier: 'S4',
      trustDomain: 'secure_local',
      chunks: spec.chunks ?? [],
    })),
    coverage: { searchedCorpora: ['secure_local.synthetic'], skippedCorpora: [], extractionGaps: [] },
  };
}

function ctx(specs: Spec[], options: ConsultWriterContextOptions = {}): ConsultWriterContext {
  return consultWriterContextFromPack(packOf(specs), options);
}

function refused(question: string | string[], context: ConsultWriterContext): void {
  const request = typeof question === 'string' ? [question] : question;
  expect({ question, decision: evaluateConsultRequest(request, context).decision }).toEqual({ question, decision: 'refuse' });
}

function passed(question: string, context: ConsultWriterContext): void {
  expect({ question, verdict: evaluateConsultQuestion(question, context) }).toEqual({ question, verdict: { decision: 'pass', reasons: [] } });
}

const cp = (...points: number[]) => String.fromCodePoint(...points);
const NEUTRAL = ctx([{ chunks: ['The inspection happened after the keys were returned.'] }]);
const IVO = ctx([{}], { connectedAccountIdentifiers: ['Ivo'] });

describe('review 2: names', () => {
  test('a name inside a copied sentence', () => {
    refused('Selene has melanoma. What treatment classes exist?', ctx([{ chunks: ['Selene has melanoma.'] }]));
  });
  test('a name as a label value, bare or quoted', () => {
    refused('Can Selene appeal?', ctx([{ chunks: ['Reporter: Selene.'] }]));
    refused('Can Selene appeal?', ctx([{ chunks: ['Reporter: "Selene".'] }]));
  });
  test('a dictionary-word name as a label value', () => {
    refused('Can Grace appeal?', ctx([{ chunks: ['Reporter: Grace.'] }]));
  });
  test('lower-case occurrences do not cancel a name', () => {
    refused('Can Selene appeal?', ctx([{ chunks: ['The report from Selene arrived. selene.'] }]));
    refused('Can Dorian Fenwick appeal?', ctx([{ chunks: ['Dorian Fenwick. dorian fenwick. dorian fenwick.'] }]));
  });
  test('first-round gaps closed by the vocabulary rule', () => {
    refused('Can Nadia appeal?', ctx([{ chunks: ['Nadia reported a breach.'] }]));
    refused('Can Nadia Selwyn appeal?', ctx([{ chunks: ['nadia selwyn reported a breach.'] }]));
    refused('Why would kelpbox stop?', ctx([{ chunks: ['Internal host kelpbox stopped.'] }]));
    refused(`Can ${cp(0x738b, 0x82b3)} appeal?`, ctx([{ chunks: [`${cp(0x738b, 0x82b3)} reported.`] }]));
  });
  test('misspellings and transliterations of a known name', () => {
    const context = ctx([{ chunks: ['Dorian Fenwick reported a breach.'] }]);
    for (const question of [
      'Can Doreian Fenewick appeal?',
      'Can Dorin Fenwik appeal?',
      'Can Doryan Fennick appeal?',
      `Can ${cp(0x414, 0x43e, 0x440, 0x438, 0x430, 0x43d)} ${cp(0x424, 0x435, 0x43d, 0x432, 0x438, 0x43a)} appeal?`,
      `Can ${cp(0x39d, 0x3c4, 0x3cc, 0x3c1, 0x3b9, 0x3b1, 0x3bd)} appeal?`,
    ]) refused(question, context);
    refused(`Can ${cp(0x141)}ena H${cp(0xf8)}lt appeal?`, ctx([{ chunks: ['Lena Holt reported a breach.'] }]));
  });
  test('known gap: a dictionary-word name in running prose', () => {
    // "Grace" is an ordinary English word; outside a label or a pair it is
    // indistinguishable from the word.
    passed('Can grace be shown to a late payer?', ctx([{ chunks: ['Grace reported a breach.'] }]));
  });
});

describe('review 2: known identifiers', () => {
  test('an identifier glued inside a longer token', () => {
    const context = ctx([{}], { connectedAccountIdentifiers: ['Dorian Fenwick'] });
    refused('Is supportdorianfenwick.example trustworthy?', context);
    refused('Is supportdorianfenwick(at)mail trustworthy?', context);
  });
  test('a single-token identifier longer than the compact window', () => {
    const id = 'q'.repeat(10) + 'w'.repeat(30) + 'x'.repeat(30);
    refused(`Is ${id} valid?`, ctx([{ providerItemId: id }]));
  });
});

describe('review 2: encodings', () => {
  test('base32, base58, rot13, split and double base64, 0x bytes', () => {
    for (const question of ['Is JF3G6 eligible?', 'Is RgAi eligible?', 'Is Vib eligible?', 'Is SX Zv eligible?', 'Is U1ha dg== eligible?', 'Is 0x49 0x76 0x6f eligible?']) {
      refused(question, IVO);
    }
  });
  test('encoded numbers and dates', () => {
    refused('Is NDYy a normal reading?', ctx([{ chunks: ['a reading of 462'] }]));
    refused('Is 0x34 0x36 0x32 a normal reading?', ctx([{ chunks: ['a reading of 462'] }]));
    refused('What happened on MjAy NC0w My0x NA==?', ctx([{ chunks: ['signed 2024-03-14'] }]));
  });
});

describe('review 2: numbers and dates read the same way on both sides', () => {
  test('number words in the snapshot', () => {
    refused('Is 862 euros a reasonable fee?', ctx([{ chunks: ['The fee was eight hundred sixty two euros.'] }]));
  });
  test('date words in the snapshot', () => {
    refused('What rules applied on 14-03-24?', ctx([{ chunks: ['It was signed on the fourteenth of March in twenty twenty four.'] }]));
  });
});

describe('review 2: word order and splitting', () => {
  test('an adjacent swap of content words', () => {
    refused('Why do silver cranes guard cedar hidden tunnels?', ctx([{ chunks: ['silver cranes guard hidden cedar tunnels'] }]));
  });
  test('a copied sentence split across sub-questions', () => {
    refused(
      ['Did the tenant paint?', 'Were hallway walls bright?', 'Was it orange last spring?'],
      ctx([{ chunks: ['the tenant painted the hallway walls bright orange last spring'] }]),
    );
  });
  test('known gap: synonym substitution', () => {
    passed('Why do silver herons protect concealed cedar passages?', ctx([{ chunks: ['silver cranes guard hidden cedar tunnels'] }]));
  });
});

describe('review 2: items inside one sub-question', () => {
  test('a long run-on ask is capped by its content words', () => {
    refused('Please explain refunds, compare arbitration, outline mediation, describe escrow, assess depreciation, and summarize limitation periods?', NEUTRAL);
  });
  test('known gap: a short list of items inside one sub-question is not counted', () => {
    // The structural limit is the sub-question array plus a content-word cap;
    // the gate does not count items by punctuation or conjunctions.
    passed('Explain mediation, arbitration, litigation, restitution and damages?', NEUTRAL);
  });
});

describe('review 2: malformed packs', () => {
  const withCandidate = (patch: Record<string, unknown>): ConsultWriterContext => {
    const pack = packOf([{}]);
    return consultWriterContextFromPack({ ...pack, candidates: [{ ...pack.candidates[0]!, ...patch }] } as unknown as EvidencePack);
  };
  test('out-of-contract values in closed fields refuse the whole snapshot', () => {
    expect(evaluateConsultQuestion('What is a deposit?', withCandidate({ trustTier: 'Selene' })).reasons).toEqual(['writer_context_malformed']);
    expect(evaluateConsultQuestion('What is a deposit?', withCandidate({ facts: [{ claim: 'x', factId: 'f', confidence: 'high', extractionKind: 'quoted_fact', releaseSurface: 'local_only', sourceProvenance: [], sensitivity: { trustTier: 'S4', trustDomain: 'secure_local', localOnly: true, cloudEmbeddingEligible: false }, sourceInstructionFlags: ['Selene'] }] })).reasons)
      .toEqual(['writer_context_malformed']);
    expect(evaluateConsultQuestion('What is a deposit?', withCandidate({ tables: [{ columns: ['a'], rows: [[{ Selene: true }]] }] })).reasons)
      .toEqual(['writer_context_malformed']);
  });
  test('unknown provenance numbers are identifiers, and keys cannot spoof a path', () => {
    const pack = packOf([{}]);
    const candidate = pack.candidates[0]!;
    const context = consultWriterContextFromPack({
      ...pack,
      candidates: [{ ...candidate, provenance: { ...candidate.provenance, newAccount: 735 }, 'facts[].confidence': 'Grace' }],
    } as unknown as EvidencePack);
    expect(context.entries.filter((entry) => entry.text === '735').map((entry) => entry.kind)).toEqual(['identifier']);
    expect(context.entries.filter((entry) => entry.text === 'Grace').map((entry) => entry.kind)).toEqual(['identifier']);
  });
});

describe('review 2: bounded work', () => {
  const question = `Is ${'z '.repeat(76)}it?`;
  test('a half-megabyte single-letter identifier against a long question', () => {
    const context = ctx([{}], { connectedAccountIdentifiers: ['z '.repeat(524_000)] });
    const started = performance.now();
    evaluateConsultQuestion(question, context);
    expect(performance.now() - started).toBeLessThan(1_500);
  });
  test('a quarter-million-word capitalized identifier: time and memory', () => {
    const context = ctx([{}], { connectedAccountIdentifiers: ['Abc '.repeat(262_000)] });
    Bun.gc(true);
    const before = process.memoryUsage();
    const started = performance.now();
    evaluateConsultQuestion('Is cat a word?', context);
    expect(performance.now() - started).toBeLessThan(1_500);
    Bun.gc(true);
    const after = process.memoryUsage();
    // Nothing is retained. Peak RSS is allocator churn from tokenizing a
    // megabyte of capitalized words (measured 200-290 MB on macOS arm64);
    // bounded loosely so a real regression still fails.
    expect((after.heapUsed - before.heapUsed) / 1e6).toBeLessThan(50);
    expect((after.rss - before.rss) / 1e6).toBeLessThan(400);
  });
});

describe('review 2: usability probes', () => {
  test('ordinary questions with units, symbols and abbreviations pass', () => {
    for (const question of [
      'What general consumer rules changed after 2024?',
      'When is written and/or verbal consent sufficient?',
      'What is the difference between mg/dL and mmol/L?',
      'How is a café classified for fire safety?',
      'How does 5% compound interest work?',
      'How do ISO 8601 dates avoid ambiguity?',
      'How does a flat interest rate differ from a reducing balance rate?',
      'How do OAuth2 scopes limit an application\'s access?',
    ]) passed(question, NEUTRAL);
  });
  test('a word from a language with no installed pack is refused (German ships only as a user pack)', () => {
    expect(evaluateConsultQuestion(`What does K${cp(0xfc)}ndigung mean in a rental agreement?`, NEUTRAL).reasons).toContain('unknown_word');
  });
});
