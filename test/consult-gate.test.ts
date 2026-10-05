// Consult outbound gate (src/core/consult-gate.ts): every refusal class with
// its near-miss, the writer-context snapshot's completeness, and the limits.
// Secret-shaped fixtures are assembled at runtime so no credential scanner sees
// a literal.

import { describe, expect, test } from 'bun:test';
import type { EvidencePack } from '../src/core/contracts.ts';
import {
  CONSULT_GATE_MAX_CONTENT_WORDS_PER_QUESTION,
  CONSULT_GATE_MAX_QUESTION_BYTES,
  CONSULT_GATE_MAX_RECENT_CONSULTS,
  CONSULT_GATE_MAX_SUB_QUESTIONS,
  CONSULT_GATE_MAX_WRITER_CONTEXT_BYTES,
  CONSULT_GATE_SHARED_RUN_TOKENS,
  consultWriterContextFromPack,
  evaluateConsultQuestion,
  evaluateConsultRequest,
  normalizeForComparison,
  type ConsultGateReason,
  type ConsultWriterContext,
} from '../src/core/consult-gate.ts';

// --- Fixtures -------------------------------------------------------------------

/**
 * Every field of the pack made required, recursively. FULL_PACK below is typed
 * with it, so adding any field to the EvidencePack types (contracts.ts,
 * source-index/types.ts, opsec.ts) fails `bun run typecheck` here until the
 * fixture carries a value for it — and the runtime test then proves the
 * snapshot collected that value.
 */
type DeepRequired<T> = T extends string | number | boolean | bigint
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepRequired<U>[]
    : { readonly [K in keyof T]-?: DeepRequired<NonNullable<T[K]>> };

const FULL_PROVENANCE = {
  sourceItem: {
    family: 'file',
    provider: 'leaf-provider',
    accountScope: 'leaf-account-scope',
    providerItemId: 'leaf-provider-item-id',
    providerThreadId: 'leaf-provider-thread-id',
    providerConversationId: 'leaf-provider-conversation-id',
    providerFileId: 'leaf-provider-file-id',
    providerEventId: 'leaf-provider-event-id',
    localItemId: 'leaf-local-item-id',
    sourceVersion: 'leaf-source-version',
  },
  chunk: {
    sourceItem: {
      family: 'file',
      provider: 'leaf-chunk-provider',
      accountScope: 'leaf-chunk-account-scope',
      providerItemId: 'leaf-chunk-provider-item-id',
      providerThreadId: 'leaf-chunk-thread-id',
      providerConversationId: 'leaf-chunk-conversation-id',
      providerFileId: 'leaf-chunk-file-id',
      providerEventId: 'leaf-chunk-event-id',
      localItemId: 'leaf-chunk-local-item-id',
      sourceVersion: 'leaf-chunk-source-version',
    },
    chunkId: 'leaf-chunk-id',
    chunkIndex: 7001,
    contentHash: 'leaf-content-hash',
    span: { charStart: 7002, charEnd: 7003, itemCharStart: 7004, itemCharEnd: 7005, chunkChars: 7010, lane: 'keyword' },
  },
  providerIds: { leafProviderKey: 'leaf-provider-id-value' },
  localIds: { leafLocalKey: 'leaf-local-id-value' },
  syncRunId: 'leaf-sync-run-id',
  syncCheckpoint: 'leaf-sync-checkpoint',
  citation: {
    title: 'leaf-citation-title',
    sourceLabel: 'leaf-source-label',
    conversationLabel: 'leaf-conversation-label',
    authorLabel: 'leaf-author-label',
    uri: 'leaf-citation-uri',
    authoredAt: 'leaf-authored-at',
    updatedAt: 'leaf-updated-at',
  },
} as const;

const FULL_PACK: DeepRequired<EvidencePack> = {
  question: 'leaf-question',
  builtAt: 'leaf-built-at',
  candidates: [{
    provenance: FULL_PROVENANCE,
    trustTier: 'S4',
    trustDomain: 'secure_local',
    chunks: ['leaf-chunk-text'],
    tables: [{ caption: 'leaf-table-caption', columns: ['leaf-table-column'], rows: [['leaf-table-cell']] }],
    facts: [{
      factId: 'leaf-fact-id',
      claim: 'leaf-fact-claim',
      sourceProvenance: [FULL_PROVENANCE],
      sensitivity: { trustTier: 'S4', trustDomain: 'secure_local', localOnly: true, cloudEmbeddingEligible: false },
      confidence: 'high',
      extractionKind: 'quoted_fact',
      sourceInstructionFlags: ['general_source_instruction'],
      releaseSurface: 'local_only',
    }],
    score: 7006,
  }],
  coverage: {
    searchedCorpora: ['leaf-searched-corpus'],
    skippedCorpora: [{ corpusId: 'leaf-skipped-corpus', reason: 'leaf-skip-reason' }],
    extractionGaps: ['leaf-extraction-gap'],
    matchCounts: [{
      corpusId: 'leaf-match-corpus',
      family: 'file',
      matchedItems: 7007,
      contentMatchedItems: 7008,
      atLeast: true,
      inEvidence: 7009,
    }],
  },
};

function stringAndNumberLeaves(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string' || typeof value === 'number') out.push(String(value));
  else if (Array.isArray(value)) for (const item of value) stringAndNumberLeaves(item, out);
  else if (value && typeof value === 'object') for (const child of Object.values(value)) stringAndNumberLeaves(child, out);
  return out;
}

interface CandidateSpec {
  chunks?: string[];
  title?: string;
  authorLabel?: string;
  conversationLabel?: string;
  uri?: string;
  tables?: EvidencePack['candidates'][number]['tables'];
  factClaims?: string[];
}

function packWith(question: string, specs: CandidateSpec[], extraGaps: string[] = []): EvidencePack {
  return {
    question,
    builtAt: '2026-10-05T09:00:00.000Z',
    candidates: specs.map((spec, index) => {
      const provenance = {
        sourceItem: {
          family: 'file' as const,
          provider: 'synthetic',
          accountScope: 'personal',
          providerItemId: `item-${index}`,
          localItemId: `local-${index}`,
        },
        citation: {
          ...(spec.title ? { title: spec.title } : {}),
          ...(spec.authorLabel ? { authorLabel: spec.authorLabel } : {}),
          ...(spec.conversationLabel ? { conversationLabel: spec.conversationLabel } : {}),
          ...(spec.uri ? { uri: spec.uri } : {}),
        },
      };
      return {
        provenance,
        trustTier: 'S4' as const,
        trustDomain: 'secure_local' as const,
        chunks: spec.chunks ?? [],
        ...(spec.tables ? { tables: spec.tables } : {}),
        ...(spec.factClaims
          ? {
            facts: spec.factClaims.map((claim, factIndex) => ({
              factId: `fact-${index}-${factIndex}`,
              claim,
              sourceProvenance: [provenance],
              sensitivity: { trustTier: 'S4' as const, trustDomain: 'secure_local' as const, localOnly: true, cloudEmbeddingEligible: false },
              confidence: 'high' as const,
              extractionKind: 'quoted_fact' as const,
              sourceInstructionFlags: [],
              releaseSurface: 'local_only' as const,
            })),
          }
          : {}),
      };
    }),
    coverage: { searchedCorpora: ['secure_local.synthetic'], skippedCorpora: [], extractionGaps: extraGaps },
  };
}

const PACK = packWith('what did the letting agent say about returning my deposit after I moved out', [
  {
    title: 'Heron Quay tenancy file',
    authorLabel: 'Desmond Achterberg',
    conversationLabel: 'Flat 4B handover',
    uri: 'files/Personal/Housing/heron-quay-inventory.pdf',
    chunks: [
      'Marguerite Okafor confirmed on 14 March 2024 that the deposit of 2,375.50 would be released after the final inspection at 12 Heron Quay.',
      'Reach the agent at 0161 496 0734 or desk@heronquay-lettings.example and quote reference AC-55821-Q.',
      'The inspection report noted minor scuffing in the hallway and a stained carpet in the second bedroom.',
    ],
    tables: [{ caption: 'Deductions proposed by the agent', columns: ['Item', 'Amount'], rows: [['Carpet cleaning', '186.40'], ['Repainting hallway', '312.00']] }],
    factClaims: ['The landlord proposed retaining 498.40 from the deposit.'],
  },
], ['heron-quay-photos.zip could not be read']);

const CONTEXT = consultWriterContextFromPack(PACK);

function verdict(question: string, context: ConsultWriterContext = CONTEXT) {
  return evaluateConsultQuestion(question, context);
}

function expectPass(question: string, context: ConsultWriterContext = CONTEXT): void {
  expect({ question, verdict: verdict(question, context) }).toEqual({ question, verdict: { decision: 'pass', reasons: [] } });
}

function expectRefused(question: string, reason: ConsultGateReason, context: ConsultWriterContext = CONTEXT): void {
  const result = verdict(question, context);
  expect({ question, decision: result.decision }).toEqual({ question, decision: 'refuse' });
  expect({ question, reasons: result.reasons }).toEqual({ question, reasons: expect.arrayContaining([reason]) });
}

const CLEAN = 'What deductions from a rental deposit are usually allowed for normal wear versus damage?';

// --- Snapshot ---------------------------------------------------------------------

describe('writer-context snapshot', () => {
  test('collects every string and number leaf of a fully populated pack', () => {
    const context = consultWriterContextFromPack(FULL_PACK as EvidencePack);
    const collected = new Set(context.entries.map((entry) => entry.text));
    const leaves = stringAndNumberLeaves(FULL_PACK);
    expect(leaves.length).toBeGreaterThan(60);
    expect(leaves.filter((leaf) => !collected.has(leaf))).toEqual([]);
    expect(context.overflow).toBe(false);
  });

  test('classifies by schema path: provenance strict, closed enumerations as vocabulary, free text as text', () => {
    const context = consultWriterContextFromPack(FULL_PACK as EvidencePack);
    const kindsOf = (text: string) => [...new Set(context.entries.filter((entry) => entry.text === text).map((entry) => entry.kind))];
    for (const text of ['leaf-citation-title', 'leaf-conversation-label', 'leaf-citation-uri', 'leaf-provider',
      'leaf-provider-item-id', 'leaf-provider-id-value', 'leaf-content-hash', 'leaf-sync-run-id']) {
      expect({ text, kinds: kindsOf(text) }).toEqual({ text, kinds: ['identifier'] });
    }
    expect(kindsOf('leaf-author-label')).toEqual(['person_identifier']);
    expect(kindsOf('leaf-account-scope')).toEqual(['account_scope']);
    for (const text of ['leaf-built-at', 'leaf-fact-id', '7001', '7002', '7006']) {
      expect({ text, kinds: kindsOf(text) }).toEqual({ text, kinds: ['metadata'] });
    }
    expect(kindsOf('7007')).toEqual(['text']);
    expect(kindsOf('leaf-question')).toEqual(['user_question']);
    for (const text of ['leaf-chunk-text', 'leaf-table-caption', 'leaf-table-column', 'leaf-table-cell',
      'leaf-fact-claim', 'leaf-extraction-gap', 'leaf-skip-reason', 'leaf-searched-corpus']) {
      expect({ text, kinds: kindsOf(text) }).toEqual({ text, kinds: ['text'] });
    }
    for (const text of ['secure_local', 'S4', 'high', 'quoted_fact', 'local_only', 'general_source_instruction', 'keyword']) {
      expect({ text, kinds: kindsOf(text) }).toEqual({ text, kinds: ['vocabulary'] });
    }
  });

  test('a field the builder has never heard of is still collected, as an identifier', () => {
    const pack = {
      ...PACK,
      futureField: 'leaf-unknown-top',
      candidates: PACK.candidates.map((candidate) => ({ ...candidate, futureNote: { deep: ['leaf-unknown-deep'] } })),
    } as unknown as EvidencePack;
    const context = consultWriterContextFromPack(pack);
    for (const text of ['leaf-unknown-top', 'leaf-unknown-deep']) {
      expect(context.entries.filter((entry) => entry.text === text).map((entry) => entry.kind)).toEqual(['identifier']);
    }
  });

  test('connected-account identifiers are added as identifiers', () => {
    const context = consultWriterContextFromPack(PACK, { connectedAccountIdentifiers: ['Holly Marsh'] });
    expect(context.entries.at(-1)).toEqual({ kind: 'person_identifier', text: 'Holly Marsh', path: 'connectedAccount[]', group: -3 });
    // Dictionary words, so the vocabulary rule passes them and the identifier rule decides.
    expectRefused('What does a holly marsh contract usually cover?', 'snapshot_identifier', context);
  });

  test('the snapshot is frozen', () => {
    expect(Object.isFrozen(CONTEXT)).toBe(true);
    expect(Object.isFrozen(CONTEXT.entries)).toBe(true);
    expect(Object.isFrozen(CONTEXT.entries[0])).toBe(true);
  });

  test('a pack larger than the ceiling marks overflow and the gate refuses before comparing', () => {
    const huge = packWith('q', [{ chunks: Array.from({ length: 1_200 }, () => 'x'.repeat(1_000)) }]);
    const context = consultWriterContextFromPack(huge);
    expect(context.overflow).toBe(true);
    expect(verdict(CLEAN, context)).toEqual({ decision: 'refuse', reasons: ['writer_context_too_large'] });
  });

  test('a hand-built context over the byte ceiling is refused on its recomputed size', () => {
    const forged: ConsultWriterContext = {
      overflow: false,
      entries: [{ kind: 'text', text: 'y'.repeat(CONSULT_GATE_MAX_WRITER_CONTEXT_BYTES + 1), path: 'x', group: -1 }],
    };
    expect(verdict(CLEAN, forged)).toEqual({ decision: 'refuse', reasons: ['writer_context_too_large'] });
  });
});

// --- Refusal classes ----------------------------------------------------------------

describe('consult gate', () => {
  test('a generic class-level question passes', () => {
    expectPass(CLEAN);
    expectPass('How long does a landlord usually have to return a deposit after a tenancy ends?');
    expectPass('Is a stained carpet normally treated as damage or as ordinary wear?');
  });

  test('the verdict is content-free: a closed set of codes, never question or snapshot text', () => {
    const result = verdict('Can Marguerite Okafor keep 2,375.50 from desk@heronquay-lettings.example?');
    expect(result.decision).toBe('refuse');
    for (const reason of result.reasons) expect(reason).toMatch(/^[a-z_]+$/);
    const serialized = JSON.stringify(result).toLowerCase();
    for (const fragment of ['okafor', 'marguerite', '2,375', 'heronquay']) expect(serialized).not.toContain(fragment);
  });

  test('secret detector (reused from opsec)', () => {
    const fakeKey = ['sk', '-', 'Zq8Rr7Tt6Yy5Uu4Ii3Oo2Pp1'].join('');
    expectRefused(`Why would a key like ${fakeKey} be rejected?`, 'secret_detected');
    const password = ['pass', 'word', ': ', 'hunter2hunter2'].join('');
    expectRefused(`Is ${password} strong enough?`, 'secret_detected');
    expectPass('How should a password manager store a recovery code?');
  });

  test(`shared run of ${CONSULT_GATE_SHARED_RUN_TOKENS} normalized tokens with any snapshot text`, () => {
    expectRefused('Is minor scuffing in the hallway something a landlord can charge for?', 'shared_token_run');
    // Case, accents and look-alike letters do not hide a copy.
    expectRefused('Is MINOR SCÚFFING IN THE HALLWAY chargeable?', 'shared_token_run');
    expectRefused('Is minor scuffing in th\u0435 hallway chargeable?', 'mixed_script_token');
    // The user's own wording is in the snapshot.
    expectRefused('Generally, what does the letting agent say about returning deposits?', 'shared_token_run');
    // Table captions and fact claims are in the snapshot.
    expectRefused('Are deductions proposed by the agent binding?', 'shared_token_run');
    expectRefused('Can the landlord proposed retaining part of a deposit?', 'shared_token_run');
    // Near-misses: three shared tokens, or four that are mostly function words.
    expectPass('Is scuffing in hallways normally chargeable?');
    expectPass('What is the usual process at the end of a fixed-term tenancy?');
  });

  test('identifier shapes are refused whether or not the snapshot holds them', () => {
    expectRefused('What does a message from someone@elsewhere.example usually mean?', 'identifier_shape');
    expectRefused('Is @someone a reliable source on deposits?', 'identifier_shape');
    expectRefused('Is https://example.org/guide a good deposit guide?', 'identifier_shape');
    expectRefused('Who owns account 123456789 in general?', 'identifier_shape');
    expectRefused('Is 020 7946 0991 a landline?', 'identifier_shape');
    // Near-misses: a grouped thousands figure and a year range.
    expectPass('Is a deposit cap of 1,000,000 units realistic for any tenancy?');
    expectPass('How did deposit rules change between 2015 and 2020?');
  });

  test('provenance values: title, author, conversation, locator segments', () => {
    expectRefused('What does a Heron Quay tenancy file usually contain?', 'snapshot_identifier');
    // Not English words: the vocabulary rule refuses before any comparison.
    expectRefused('Who is desmond achterberg in a letting dispute?', 'unknown_word');
    expectRefused('What is a flat 4b handover?', 'snapshot_identifier');
    expectRefused('What is in a heron quay inventory pdf?', 'snapshot_identifier');
    // A product default scope value is not an identifier.
    expectPass('Which personal records prove a deposit was paid?');
  });

  test('names that occur only in running text', () => {
    expectRefused('Can marguerite okafor refuse an inspection?', 'unknown_word');
    expectRefused('Can Okafor, Marguerite refuse an inspection?', 'unknown_word');
    // A name made of English words is caught by the name rule.
    const named = consultWriterContextFromPack(packWith('q', [{ chunks: ['The tenant, Holly Marsh, signed it.'] }]));
    expectRefused('Can Holly Marsh refuse an inspection?', 'snapshot_name', named);
    expectRefused('Can Marsh, Holly refuse an inspection?', 'snapshot_name', named);
    // Since round 2 lower-case occurrences no longer cancel a capitalized pair,
    // so a title-case heading is protected as if it were a name: the price of
    // not letting "dorian fenwick" in lower case unmake "Dorian Fenwick".
    const context = consultWriterContextFromPack(packWith('q', [{
      chunks: ['Final Inspection', 'The final inspection happens after keys are returned, and the final inspection is short.'],
    }]));
    expectRefused('When does a final inspection usually happen?', 'snapshot_name', context);
    // Near-miss: one of the words alone.
    expectPass('When does the last inspection usually happen?', context);
  });

  test('hostnames and their registrable parent', () => {
    expectRefused('Is heronquay-lettings.example a regulated agency?', 'unknown_word');
    const hosts = consultWriterContextFromPack(packWith('q', [{ chunks: ['Rates are listed at harbour-rentals.example today.'] }]));
    expectRefused('Is harbour-rentals.example a regulated agency?', 'snapshot_hostname', hosts);
    expectRefused('Is mail.harbour-rentals.example trustworthy?', 'snapshot_hostname', hosts);
    expectPass('Is news.example a reliable source for deposit rules?', hosts);
  });

  test('exact dates in other written forms', () => {
    expectRefused('What usually happens on 2024-03-14 for deposits?', 'snapshot_date');
    expectRefused('What usually happens on March 14th, 2024 for deposits?', 'snapshot_date');
    expectRefused('What usually happens on 14-03-2024 for deposits?', 'snapshot_date');
    // French is a shipped language, so the date rule decides.
    expectRefused('Que se passe-t-il le 14 mars 2024 pour une caution?', 'snapshot_date');
    // Day and month alone are still the date.
    expectRefused('What usually happens on the 14th of March?', 'snapshot_date');
    // Near-misses: a month alone, another day.
    expectPass('What changed for deposits in March?');
    expectPass('What usually happens on 15 March for deposits?');
  });

  test('exact figures in other written forms', () => {
    expectRefused('Is 2375.50 a normal deposit?', 'snapshot_figure');
    expectRefused('Is 2.375,50 a normal deposit?', 'snapshot_figure');
    expectRefused('Is a deduction of 186.4 for carpet cleaning normal?', 'snapshot_figure');
    expectRefused('Is reference 55821 a normal format?', 'snapshot_figure');
    // Years are numbers like any other: one present in the snapshot is refused.
    expectRefused('Did deposit protection rules change in 2024?', 'snapshot_figure');
    // Near-misses: another figure, a band.
    expectPass('Is a carpet cleaning charge of about 190 normal?');
    expectPass('Is a deposit between 2,000 and 2,500 normal?');
  });

  test('size limits', () => {
    const long = `${'Is this a reasonable question about rental deposits and wear '.repeat(10)}?`;
    expect(new TextEncoder().encode(long).length).toBeGreaterThan(CONSULT_GATE_MAX_QUESTION_BYTES);
    expect(verdict(long)).toEqual({ decision: 'refuse', reasons: ['question_too_many_bytes'] });
    const manyTokens = `${'a b c d e f g h i j '.repeat(9)}?`;
    expect(verdict(manyTokens).reasons).toContain('question_too_many_tokens');
    expect(verdict('?').reasons).toContain('question_empty');
    expect(verdict('   ').reasons).toEqual(['question_empty']);
  });

  test('limits can be tightened but never loosened', () => {
    expect(evaluateConsultQuestion(CLEAN, CONTEXT, { maxQuestionBytes: 20 }).reasons).toEqual(['question_too_many_bytes']);
    const long = `${'Is this a reasonable question about rental deposits and wear '.repeat(10)}?`;
    expect(evaluateConsultQuestion(long, CONTEXT, { maxQuestionBytes: 1_000_000 }).reasons).toEqual(['question_too_many_bytes']);
  });

  test('characters: control, invisible, bidi, whitespace, NFKC, combining stacks, markup', () => {
    expectRefused('What deductions are allowed?\n', 'control_character');
    expectRefused('What\tdeductions are allowed?', 'control_character');
    expectRefused('What deduc\u200Btions are allowed?', 'invisible_or_format_character');
    expectRefused('What deductions \u202Eare allowed?', 'invisible_or_format_character');
    expectRefused('What deductions are allowed\uFE0F?', 'invisible_or_format_character');
    expectRefused('What deductions are allowed\u{E0041}?', 'invisible_or_format_character');
    expectRefused('What deductions\u00A0are allowed?', 'irregular_whitespace');
    expectRefused('What  deductions are allowed?', 'irregular_whitespace');
    expectRefused(' What deductions are allowed?', 'irregular_whitespace');
    expectRefused('What \uFF44\uFF45\uFF44\uFF55\uFF43\uFF54\uFF49\uFF4F\uFF4E\uFF53 are allowed?', 'not_nfkc_normalized');
    expectRefused('What deductions are x\u0301\u0302\u0303\u0304\u0305llowed?', 'combining_mark_stack');
    expectRefused('What <b>deductions</b> are allowed?', 'not_plain_text');
    expectRefused('What deductions are allowed &amp; why?', 'not_plain_text');
    // Ordinary accents in NFKC form pass, and so do the shipped languages
    // (English, Dutch, French, Spanish, Portuguese); other languages and
    // scripts are refused as unknown words.
    expectPass('Is a caf\u00e9 deposit rule different?');
    expectPass('Quelles retenues sur une caution sont autorisées après un état des lieux?');
    expectRefused('退去時の敷金からどのような控除が認められますか?', 'unknown_word');
  });

  test('encoded blobs', () => {
    const base64 = Buffer.from('Marguerite Okafor').toString('base64');
    expectRefused(`What does ${base64} decode to?`, 'encoded_blob');
    expectRefused('What does deadbeefcafe0123456789 mean?', 'encoded_blob');
    expectRefused('What does %4D%61%72 mean?', 'encoded_blob');
    // Near-misses: a long ordinary word and a single camel hump.
    expectPass('Is a counterclaim for uncharacteristically high cleaning costs common?');
    // An unusual product name is an unknown word now.
    expectRefused('How do PostgreSQL databases store dates?', 'unknown_word');
  });

  test('mixed-script look-alikes', () => {
    expectRefused('Can M\u0430rguerite keep a deposit?', 'mixed_script_token');
    // A whole look-alike token is folded and still compared.
    expect(normalizeForComparison('\u041E\u041A\u0410F\u041ER')).toBe('okafor');
    // Near-miss: a Cyrillic word next to a Latin word.
    expectRefused('Что такое deposit protection в общем случае?', 'unknown_word');
  });

  test(`request structure: at most ${CONSULT_GATE_MAX_SUB_QUESTIONS} sub-questions, each one question with at most ${CONSULT_GATE_MAX_CONTENT_WORDS_PER_QUESTION} content words`, () => {
    expectRefused('What is a deposit', 'not_a_question');
    expectRefused('What is a deposit? Explain.', 'not_a_question');
    expectRefused('What is a deposit? What is a lease?', 'not_a_question');
    expect(evaluateConsultRequest(['What is a deposit?', 'What is a lease?', 'What is an inventory?', 'What is a guarantor?'], CONTEXT).reasons)
      .toEqual(['too_many_sub_questions']);
    expectRefused('Please explain refunds, compare arbitration, outline mediation, describe escrow, assess depreciation, and summarize limitation periods?', 'too_many_content_words');
    expectRefused('Tenancy ended. Keys returned. What happens next?', 'too_many_sentences');
    // Near-misses: a bounded list of sub-questions, a short list inside one,
    // one context sentence, Spanish opening mark, a decimal point.
    expect(evaluateConsultRequest(['What is a deposit cap?', 'What is a holding deposit?', 'What is a guarantor?'], CONTEXT))
      .toEqual({ decision: 'pass', reasons: [] });
    expectPass('What matters when a deposit is held for one, three, or six months?');
    expectPass('Assume a fixed-term tenancy has ended. What is the usual timeline for returning a deposit?');
    expectPass('\u00BFCu\u00E1nto tiempo tiene un arrendador para devolver una fianza?');
    expectPass('Is a 2.5 percent annual cap on deposit interest typical?');
  });

  test('technical fingerprints are refused whether or not the snapshot holds them', () => {
    expectRefused('Why does build.internal reject my certificate?', 'technical_fingerprint');
    expectRefused('Why is localhost slow to resolve?', 'technical_fingerprint');
    expectRefused('Why would staging-api.example.com time out?', 'technical_fingerprint');
    expectRefused('Why is 10.20.30.40 unreachable?', 'technical_fingerprint');
    expectRefused('Why does src/core/billing.ts fail to import?', 'technical_fingerprint');
    expectRefused('Why does handler.js:118 throw?', 'technical_fingerprint');
    expectRefused('Is version 4.17.21 of a parser vulnerable?', 'technical_fingerprint');
    expectRefused('What does error 0x80070005 mean?', 'technical_fingerprint');
    // Near-misses: the error class and a two-part version.
    expectPass('What usually causes a null reference error when a module imports itself?');
    expectPass('Did Python 3.11 change how imports are cached?');
    // Any slash between letters reads as a path; words are cheaper.
    expectRefused('Is input/output buffering a common cause of lost log lines?', 'technical_fingerprint');
  });

  test('linkage: an exact repeat, or a shared run, with a recent approved consult', () => {
    const recent = ['How long does a landlord usually have to return a deposit after a tenancy ends?'];
    const check = (question: string) => evaluateConsultQuestion(question, CONTEXT, {}, { recentApprovedQuestions: recent });
    expect(check('How long does a landlord usually have to return a deposit after a tenancy ends?').reasons)
      .toEqual(expect.arrayContaining(['repeats_recent_consult', 'links_recent_consult']));
    expect(check('In general, must a landlord usually return a deposit after inspections?').reasons)
      .toContain('links_recent_consult');
    // Near-miss: the same topic in independent wording.
    expect(check('What deductions from a rental deposit are usually allowed for normal wear versus damage?'))
      .toEqual({ decision: 'pass', reasons: [] });
    const tooMany = Array.from({ length: CONSULT_GATE_MAX_RECENT_CONSULTS + 1 }, () => 'What is a deposit?');
    expect(evaluateConsultQuestion(CLEAN, CONTEXT, {}, { recentApprovedQuestions: tooMany }))
      .toEqual({ decision: 'refuse', reasons: ['recent_consults_too_large'] });
  });

  test('comparison time stays bounded at the snapshot ceiling', () => {
    const sentence = 'The quarterly review compared several suppliers across many regions and noted delays. ';
    const chunks = Array.from({ length: 500 }, (_, index) => `${sentence.repeat(20)} batch ${index}`);
    const context = consultWriterContextFromPack(packWith('q', [{ chunks }]));
    expect(context.overflow).toBe(false);
    const started = performance.now();
    const result = verdict('What usually causes supplier delays across regions in a quarter?', context);
    const elapsed = performance.now() - started;
    expect(result.decision).toBe('pass');
    expect(elapsed).toBeLessThan(10_000);
  });
});
