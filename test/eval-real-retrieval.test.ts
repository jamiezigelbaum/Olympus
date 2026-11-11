// The real held-out eval runner (eval/run-real.ts) searches the way Ask does
// (#707): every tier store of the source (Private and Personal), through the
// shared answer lanes, with the built-in embedding model when it is loaded and
// keyword search, said so, when it is not. Its gaps come from the release's
// structured notes, never parsed back out of the answer text.
//
// Synthetic data only: fixture stores in a temp folder, a scripted model.

import { afterEach, describe, expect, test } from 'bun:test';
import { createAnalyst, type AnalystModel } from '../src/core/analyst.ts';
import type { AnalystResult, EvidencePack } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { DROPBOX_TIER_CORPUS_IDS } from '../src/workers/dropbox-files/connector-store.ts';
import type { AnalystReleaseOutcome } from '../src/workers/source-index/analyst-answer.ts';
import {
  buildEvalPack,
  createEvalDropboxLanes,
  evalAnswerRepeat,
  evalAnswerStageAudit,
  failIncompleteRetrieval,
  evalRetrievalAudit,
  informationalEvalMaxResults,
  promptFittedEvalAnalyst,
  expectedSeatOnlyAudit,
  expectedSeatOnlyEvalAnalyst,
  evalExpectedSeats,
  repeatedEvalAnalyst,
  openEvalDropboxStores,
  prepareEvalEmbedding,
  releaseEvalAnswer,
  releasedEvalResult,
} from '../eval/run-real.ts';
import { fixtureConnector, RecordingProvider, tempDir, type FixtureSpec } from './helpers/tier-fixtures.ts';
import type { SourceTrustDomain } from '../src/core/source-index/types.ts';
import { join } from 'node:path';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';
import { BuiltInSourceEmbeddingProvider } from '../src/workers/source-index/built-in-embedding/provider.ts';
import { reportBuiltInEmbeddingState } from '../src/workers/source-index/built-in-embedding/assets.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function seedStore(path: string, domain: SourceTrustDomain, specs: FixtureSpec[], embedWith?: SourceEmbeddingProvider): Promise<void> {
  const store = new LocalConnectorStore({
    dbPath: path,
    corpusId: DROPBOX_TIER_CORPUS_IDS[domain]!,
    family: 'file',
    trustDomain: domain,
    tierLedger: null,
  });
  try {
    await store.syncFromConnector(fixtureConnector(() => specs), { fetchContent: true });
    if (embedWith) await store.embedChunks({ provider: embedWith });
  } finally {
    store.close();
  }
}

/** A Private store holding an unrelated file, and a Personal store holding the only answer. */
async function twoTierWorld(embedWith?: SourceEmbeddingProvider) {
  const { dir, cleanup } = tempDir('olympus-eval-707-');
  cleanups.push(cleanup);
  const secure = join(dir, 'secure_local.sqlite');
  const personal = join(dir, 'internal.sqlite');
  await seedStore(secure, 'secure_local', [
    { id: 'p1', name: 'garden-plan.txt', text: 'The garden plan has tomatoes along the south fence.' },
  ], embedWith);
  await seedStore(personal, 'internal', [
    { id: 'k1', name: 'kestrel-invoice.txt', text: 'The Kestrel boatyard invoice total is 4182 dollars, due in March.' },
  ], embedWith);
  const opened = openEvalDropboxStores({ secure, personal });
  cleanups.push(() => opened.close());
  return opened;
}

describe('the real eval report says why a pack is empty (#1233)', () => {
  test('a found item and a question with no match each carry lane counts, skips and drops, counts only', async () => {
    const { stores, ledger } = await twoTierWorld();
    const lanes = createEvalDropboxLanes({ stores, ...(ledger ? { ledger } : {}), scope: { accountScope: 'personal' } });

    const found = evalRetrievalAudit(await buildEvalPack({
      question: 'What is the Kestrel boatyard invoice total?', lanes, maxResults: 5, maxCharsPerCandidate: 1_500,
    }));
    expect(found.packCandidates).toBeGreaterThan(0);
    const personalKeyword = found.lanes.find((lane) => lane.laneName.startsWith(DROPBOX_TIER_CORPUS_IDS.internal!) && lane.laneType === 'keyword');
    expect(personalKeyword?.returnedCount).toBeGreaterThan(0);
    expect(found.secureExclusion).toBe('not_applied');
    // Each searched store reports its wall time and outcome.
    expect(found.corpusTimings.map((timing) => timing.corpusId).sort())
      .toEqual([DROPBOX_TIER_CORPUS_IDS.internal!, DROPBOX_TIER_CORPUS_IDS.secure_local!].sort());
    expect(found.corpusTimings.every((timing) => timing.outcome === 'success' && timing.elapsedMs >= 0)).toBe(true);
    // Which store each pack candidate came from, in pack order: the Personal
    // answer is in the pack, and is said to come from the Personal store.
    expect(found.packCandidateSources).toHaveLength(found.packCandidates);
    expect(found.packCandidateSources[0]).toEqual({ corpusId: DROPBOX_TIER_CORPUS_IDS.internal!, trustDomain: 'internal' });
    // Given the question, each seat says which expected item it holds, by
    // item id in any store, so a stale copy in another store shows up too.
    const detail = await buildEvalPack({
      question: 'What is the Kestrel boatyard invoice total?', lanes, maxResults: 5, maxCharsPerCandidate: 1_500,
    });
    const marked = evalRetrievalAudit(detail, {
      expectedEvidence: [{ corpusId: DROPBOX_TIER_CORPUS_IDS.secure_local!, providerItemId: 'k1', hint: 'the invoice' }],
    });
    // A seat holding an expected item also says which of the item's chunks
    // the lane matched (0-based) and how many characters of it the pack
    // carries, so a seat with the right item but the wrong passage shows.
    expect(marked.packCandidateSources[0]).toEqual({
      corpusId: DROPBOX_TIER_CORPUS_IDS.internal!, trustDomain: 'internal', expectedItem: 1,
      anchorChunkIndex: 0, packChars: 'The Kestrel boatyard invoice total is 4182 dollars, due in March.'.length,
    });
    expect(marked.packCandidateSources.slice(1).every((seat) => seat.expectedItem === undefined)).toBe(true);

    const empty = evalRetrievalAudit(await buildEvalPack({
      question: 'zebra quartz harmonica', lanes, maxResults: 5, maxCharsPerCandidate: 1_500,
    }));
    expect(empty).toMatchObject({ packCandidates: 0, policyDeniedCandidates: 0, unreadCandidates: 0 });
    // Both tier stores were searched and reported, so "nothing matched" is
    // told apart from "a corpus was skipped" or "a lane degraded".
    const searched = new Set(empty.lanes.map((lane) => lane.laneName.split(':')[0]));
    expect(searched.has(DROPBOX_TIER_CORPUS_IDS.internal!)).toBe(true);
    expect(searched.has(DROPBOX_TIER_CORPUS_IDS.secure_local!)).toBe(true);
    expect(empty.lanes.every((lane) => lane.returnedCount === 0)).toBe(true);
    expect(empty.skippedCorpora).toEqual([]);
    expect(empty.degradations).toEqual([]);
    // No item text in the audit.
    expect(JSON.stringify([found, empty])).not.toContain('Kestrel');
    expect(JSON.stringify([found, empty])).not.toContain('4182');
  });
});

describe('the real eval report says where an expected value was lost (#1234)', () => {
  test('in the pack, in the Analyst answer, and in the released answer, as booleans', async () => {
    const { stores, ledger } = await twoTierWorld();
    const lanes = createEvalDropboxLanes({ stores, ...(ledger ? { ledger } : {}), scope: { accountScope: 'personal' } });
    const { pack } = await buildEvalPack({
      question: 'What is the Kestrel boatyard invoice total?', lanes, maxResults: 5, maxCharsPerCandidate: 1_500,
    });
    const answer = (text: string): AnalystResult => ({ answer: text, citations: [], unanswered: [], sufficient: true } as unknown as AnalystResult);
    const question = { expectedAnswerContains: ['4182', 'April'] };

    const excerpt = 'The Kestrel boatyard invoice total is 4182 dollars, due in March.';
    const kestrelSeat = { seat: 1, charOffset: excerpt.indexOf('4182'), seatChars: excerpt.length };

    // The Analyst said it; the release removed it.
    expect(evalAnswerStageAudit(question, pack, answer('The total is 4182 dollars.'), answer('The total is [withheld].'))).toEqual({
      answerShape: 'partial',
      answerCitations: 0,
      answerUnanswered: 0,
      answerCitedSeats: [],
      answerCitationsOutsidePack: 0,
      answerValueTokens: 1,
      answerValueTokensInCitedSeats: 0,
      answerValueTokensUnmatchedShapes: ['9999'],
      expected: [
        { inPack: true, inPackAsSubstring: true, inAnalystAnswer: true, inReleasedAnswer: false, packSeats: [kestrelSeat], valueSeatCited: false },
        { inPack: false, inPackAsSubstring: false, inAnalystAnswer: false, inReleasedAnswer: false, packSeats: [], valueSeatCited: false },
      ],
    });
    // The value was in the pack and in the prompt, and the Analyst missed it.
    const prompt = 'Evidence 1: total is 4182 dollars';
    const missed = evalAnswerStageAudit(question, pack, answer('I could not find the total.'), answer('I could not find the total.'), [prompt], ['local-model-a']);
    expect(missed.expected[0]).toEqual({
      inPack: true, inPackAsSubstring: true, inAnalystPrompt: true, inAnalystAnswer: false, inReleasedAnswer: false,
      packSeats: [kestrelSeat], promptCharOffset: prompt.indexOf('4182'), valueSeatCited: false,
    });
    expect(missed).toMatchObject({ answerShape: 'not_found', analystPromptChars: prompt.length, analystModelIds: ['local-model-a'] });
    // A value present only inside a longer token: the token's shape, never its text.
    const glued = evalAnswerStageAudit({ expectedAnswerContains: ['4182'] }, pack, answer('The total is 4182USD.'), answer('The total is 4182USD.')).expected[0]!;
    expect(glued).toMatchObject({ inAnalystAnswer: false, answerTokenShape: '9999aaa' });
    expect(glued.packTokenShape).toBeUndefined();
  });

  test('a value only in a locator, a fact or a table counts as in the pack (#1239 review)', async () => {
    const { stores, ledger } = await twoTierWorld();
    const lanes = createEvalDropboxLanes({ stores, ...(ledger ? { ledger } : {}), scope: { accountScope: 'personal' } });
    const { pack } = await buildEvalPack({
      question: 'What is the Kestrel boatyard invoice total?', lanes, maxResults: 5, maxCharsPerCandidate: 1_500,
    });
    const answer = (text: string): AnalystResult => ({ answer: text, citations: [], unanswered: [], sufficient: true } as unknown as AnalystResult);
    // The fixture's locator ends in the file name.
    expect(evalAnswerStageAudit({ expectedAnswerContains: ['kestrel-invoice.txt'] }, pack, answer('x'), answer('x')).expected[0]!.inPack).toBe(true);
    const withStructure = {
      ...pack,
      candidates: pack.candidates.map((candidate, index) => index === 0
        ? { ...candidate, chunks: [], facts: [{ key: 'policy', value: 'ZX-4471' }], tables: [{ rows: [['slip', 'B-17']] }] }
        : candidate),
    } as unknown as typeof pack;
    const audit = evalAnswerStageAudit({ expectedAnswerContains: ['ZX-4471', 'B-17'] }, withStructure, answer('x'), answer('x'));
    expect(audit.expected.map((entry) => entry.inPack)).toEqual([true, true]);
  });
});

describe('the real eval report locates an expected item and value for a miss', () => {
  test('each store\'s rank for the expected item, before the stores merge, ids never in the report', async () => {
    const { stores, ledger } = await twoTierWorld();
    const searches: Array<{ corpusId: string; providerItemIds: readonly string[] }> = [];
    const lanes = createEvalDropboxLanes({
      stores, ...(ledger ? { ledger } : {}), scope: { accountScope: 'personal' },
      onStoreSearch: (search) => searches.push(search),
    });
    const detail = await buildEvalPack({ question: 'What is the Kestrel boatyard invoice total?', lanes, maxResults: 5, maxCharsPerCandidate: 1_500 });
    const expectedId = detail.pack.candidates[0]!.provenance.sourceItem.providerItemId;
    const audit = evalRetrievalAudit(detail, { expectedEvidence: [{ corpusId: DROPBOX_TIER_CORPUS_IDS.internal!, providerItemId: expectedId, hint: 'invoice' }] } as never, searches);
    const ranks = new Map(audit.expectedStoreRanks!.map((entry) => [entry.corpusId, entry]));
    expect(ranks.get(DROPBOX_TIER_CORPUS_IDS.internal!)).toMatchObject({ expectedItem: 1, bestRank: 1 });
    expect(ranks.get(DROPBOX_TIER_CORPUS_IDS.secure_local!)).toMatchObject({ expectedItem: 1, bestRank: -1 });
    for (const entry of ranks.values()) expect(entry.searches).toBeGreaterThan(0);
    expect(JSON.stringify(audit.expectedStoreRanks)).not.toContain(expectedId);
    // Without recorded searches the field is absent, not empty.
    expect(evalRetrievalAudit(detail).expectedStoreRanks).toBeUndefined();
  });

  test('an answer from other evidence is told apart from "found nothing"', async () => {
    const { stores, ledger } = await twoTierWorld();
    const lanes = createEvalDropboxLanes({ stores, ...(ledger ? { ledger } : {}), scope: { accountScope: 'personal' } });
    const { pack } = await buildEvalPack({ question: 'What is the Kestrel boatyard invoice total?', lanes, maxResults: 5, maxCharsPerCandidate: 1_500 });
    const cited = { answer: 'The total is 99 dollars.', citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'total' }], unanswered: [] } as unknown as AnalystResult;
    const audit = evalAnswerStageAudit({ expectedAnswerContains: ['4182'] }, pack, cited, cited);
    expect(audit).toMatchObject({ answerShape: 'other_answer', answerCitations: 1, answerUnanswered: 0 });
    expect(evalAnswerStageAudit({ expectedAnswerContains: [] }, pack, cited, cited).answerShape).toBeUndefined();
  });

  test('which seats the answer cites, and whether one holds the value or the expected item', async () => {
    const { stores, ledger } = await twoTierWorld();
    const lanes = createEvalDropboxLanes({ stores, ...(ledger ? { ledger } : {}), scope: { accountScope: 'personal' } });
    const built = (await buildEvalPack({ question: 'What is the Kestrel boatyard invoice total?', lanes, maxResults: 5, maxCharsPerCandidate: 1_500 })).pack;
    // A second seat: another document that does not hold the value.
    const first = built.candidates[0]!;
    const other = {
      ...first,
      provenance: { ...first.provenance, sourceItem: { ...first.provenance.sourceItem, localItemId: 'personal:other', providerItemId: 'other' } },
      chunks: ['Marina fuel log for the spring.'],
    };
    const pack = { ...built, candidates: [first, other] } as typeof built;
    const expectedId = pack.candidates[0]!.provenance.sourceItem.providerItemId;
    const question = {
      expectedAnswerContains: ['4182'],
      expectedEvidence: [{ corpusId: DROPBOX_TIER_CORPUS_IDS.internal!, providerItemId: expectedId, hint: 'invoice' }],
    } as never;
    const citing = (...seats: number[]) => ({
      answer: 'The total is 99 dollars.',
      citations: seats.map((seat) => ({ provenance: pack.candidates[seat - 1]!.provenance, claim: 'total' })),
      unanswered: [],
    }) as unknown as AnalystResult;
    // Cited the right document and still gave another value: a misreading.
    expect(evalAnswerStageAudit(question, pack, citing(1), citing(1))).toMatchObject({
      answerCitedSeats: [1], answerCitationsOutsidePack: 0, expectedSeatCited: true,
      expected: [{ valueSeatCited: true }],
    });
    // Cited another seat only: the wrong document.
    expect(evalAnswerStageAudit(question, pack, citing(2), citing(2))).toMatchObject({
      answerCitedSeats: [2], expectedSeatCited: false, expected: [{ valueSeatCited: false }],
    });
    // How many cited seats hold no expected item: citing every seat still
    // cites the expected one, and this count shows the rest.
    expect(evalAnswerStageAudit(question, pack, citing(1), citing(1)).citedSeatsWithoutExpectedItem).toBe(0);
    expect(evalAnswerStageAudit(question, pack, citing(1, 2), citing(1, 2))).toMatchObject({ expectedSeatCited: true, citedSeatsWithoutExpectedItem: 1 });
    expect(evalAnswerStageAudit({ expectedAnswerContains: ['4182'] }, pack, citing(1, 2), citing(1, 2)).citedSeatsWithoutExpectedItem).toBeUndefined();
    // The flag for a misreading: is the answer's value in the seat it cites?
    const inSeat = { ...citing(1), answer: 'The total is 4182 dollars, due in March.' } as unknown as AnalystResult;
    expect(evalAnswerStageAudit(question, pack, inSeat, inSeat)).toMatchObject({ answerValueTokens: 1, answerValueTokensInCitedSeats: 1 });
    expect(evalAnswerStageAudit(question, pack, citing(1), citing(1))).toMatchObject({ answerValueTokens: 1, answerValueTokensInCitedSeats: 0 });
    // Whole tokens only: '41' is not supported by a seat that says '4182'.
    const part = { ...citing(1), answer: 'The total is 41 dollars.' } as unknown as AnalystResult;
    expect(evalAnswerStageAudit(question, pack, part, part)).toMatchObject({ answerValueTokens: 1, answerValueTokensInCitedSeats: 0 });
    // A value held only in a cited table is still whole-token supported.
    const tabled = { ...pack, candidates: [pack.candidates[0]!, { ...other, tables: [{ columns: ['total'], rows: [['5120']] }] }] } as typeof pack;
    const fromTable = { ...citing(2), answer: 'The fuel total is 5120 dollars.' } as unknown as AnalystResult;
    expect(evalAnswerStageAudit(question, tabled, fromTable, fromTable)).toMatchObject({ answerValueTokens: 1, answerValueTokensInCitedSeats: 1 });
    // A seat marker the Analyst writes inline ("[1]") names a seat, not a value.
    const marked = { ...citing(1), answer: 'The total is 4182 dollars [1].' } as unknown as AnalystResult;
    expect(evalAnswerStageAudit(question, pack, marked, marked)).toMatchObject({ answerValueTokens: 1, answerValueTokensInCitedSeats: 1 });
    const markedList = { ...citing(1, 2), answer: 'The total is 4182 dollars [1, 2].' } as unknown as AnalystResult;
    expect(evalAnswerStageAudit(question, pack, markedList, markedList)).toMatchObject({ answerValueTokens: 1, answerValueTokensInCitedSeats: 1 });
    // A bracketed number past the pack is not a seat marker, so it still counts.
    const year = { ...citing(1), answer: 'The total is 4182 dollars [2024].' } as unknown as AnalystResult;
    expect(evalAnswerStageAudit(question, pack, year, year)).toMatchObject({ answerValueTokens: 2, answerValueTokensInCitedSeats: 1 });
    // What did not match, by shape only (digits 9, letters a), so a run can say why without the value.
    const reformatted = { ...citing(1), answer: 'The total is 4,182 dollars, due 2026-03-01.' } as unknown as AnalystResult;
    expect(evalAnswerStageAudit(question, pack, reformatted, reformatted)).toMatchObject({
      answerValueTokensUnmatchedShapes: ['9,999', '9999-99-99'],
    });
    expect(evalAnswerStageAudit(question, pack, inSeat, inSeat).answerValueTokensUnmatchedShapes).toEqual([]);
    // A value the answer takes from the cited seat's citation line (its date,
    // its file name inside a path) is in that seat, as the Analyst saw it.
    const dated = {
      ...pack,
      candidates: [{
        ...first,
        provenance: {
          ...first.provenance,
          citation: { ...first.provenance.citation, authoredAt: '2026-03-01T09:30:00.000Z', uri: '/Boats/2026-03-01_kestrel-invoice.pdf' },
        },
      }, other],
    } as typeof pack;
    const fromCitation = {
      answer: 'The 2026-03-01_kestrel-invoice.pdf of 2026-03-01 says 4182 dollars [1], see 2026-03-01_kestrel-invoice.',
      citations: [{ provenance: dated.candidates[0]!.provenance, claim: 'total' }],
      unanswered: [],
    } as unknown as AnalystResult;
    expect(evalAnswerStageAudit(question, dated, fromCitation, fromCitation)).toMatchObject({
      // The file name without its extension is the name too.
      answerValueTokens: 4, answerValueTokensInCitedSeats: 4, answerValueTokensUnmatchedShapes: [],
    });
    // Only the cited seat's citation counts: the same answer citing seat 2 is unmatched.
    const otherSeat = { ...fromCitation, citations: [{ provenance: dated.candidates[1]!.provenance, claim: 'total' }] } as unknown as AnalystResult;
    expect(evalAnswerStageAudit(question, dated, otherSeat, otherSeat).answerValueTokensInCitedSeats).toBe(0);
    // A citation naming nothing in the pack is counted, not seated.
    const stray = { ...citing(), citations: [{ provenance: { sourceItem: { localItemId: 'elsewhere' } }, claim: 'x' }] } as unknown as AnalystResult;
    expect(evalAnswerStageAudit(question, pack, stray, stray)).toMatchObject({ answerCitedSeats: [], answerCitationsOutsidePack: 1 });
  });
});

describe('the Analyst on the expected seat alone', () => {
  const candidate = (id: string) => ({
    provenance: { sourceItem: { localItemId: `personal:${id}`, providerItemId: id } },
    chunks: [`text ${id}`],
  });
  const pack = {
    question: 'q',
    candidates: [candidate('a'), candidate('b'), candidate('c')],
    coverage: { searchedCorpora: [], skippedCorpora: [], extractionGaps: [] },
    builtAt: 't',
  } as never as EvidencePack;

  test('after the graded answer, the Analyst answers a pack holding only the expected seats', async () => {
    const seen: EvidencePack[] = [];
    let call = 0;
    const inner = { analyze: async (sent: EvidencePack) => { seen.push(sent); call += 1; return { answer: `answer ${call}`, citations: [], unanswered: [] } as unknown as AnalystResult; } };
    const results: Array<[EvidencePack, AnalystResult | undefined]> = [];
    const graded = await expectedSeatOnlyEvalAnalyst(inner, () => [2], (_pack, alone, result) => results.push([alone, result])).analyze(pack, {} as never);
    expect(graded.answer).toBe('answer 1');
    expect(seen[0]).toBe(pack);
    expect(seen[1]!.candidates).toEqual([pack.candidates[1]!]);
    expect(seen[1]!.question).toBe('q');
    expect(results.map(([alone, result]) => [alone.candidates.length, result?.answer])).toEqual([[1, 'answer 2']]);
  });

  test('the expected seats are the ones the grader would accept: by item id, or by locator alone, in the named store', () => {
    const located = {
      ...pack,
      candidates: pack.candidates.map((entry, index) => ({ ...entry, provenance: { ...entry.provenance, citation: { uri: `/files/${index}.pdf` } } })),
    } as never as EvidencePack;
    const stores = ['store.a', 'store.b', 'store.a'];
    expect(evalExpectedSeats([{ corpusId: 'store.a', providerItemId: 'c', hint: 'x' }], located, stores)).toEqual([3]);
    expect(evalExpectedSeats([{ corpusId: 'store.b', uri: '/files/1.pdf', hint: 'x' }], located, stores)).toEqual([2]);
    expect(evalExpectedSeats([{ corpusId: 'store.a', uri: '/files/1.pdf', hint: 'x' }], located, stores)).toEqual([]);
  });

  test('the report says which seats ran alone and how that answer came out, shape and flags only', () => {
    const alone = { ...pack, candidates: [pack.candidates[1]!] } as EvidencePack;
    const right = { answer: 'The total is 4182 dollars.', citations: [{ provenance: alone.candidates[0]!.provenance, claim: 'total' }], unanswered: [] } as unknown as AnalystResult;
    const audit = expectedSeatOnlyAudit({ expectedAnswerContains: ['4182'] }, { seats: [2], alone, result: right });
    expect(audit).toMatchObject({ seats: [2], answerShape: 'contains_all', answerCitedSeats: [1], valuesInAnswer: [true] });
    expect(JSON.stringify(audit)).not.toContain('4182');
    expect(expectedSeatOnlyAudit({ expectedAnswerContains: ['4182'] }, { seats: [2], alone, result: undefined })).toEqual({ seats: [2], failed: true });
  });

  test('the seat-alone pack states its own coverage: each store\'s items in evidence are the seats it holds', async () => {
    const counted = {
      ...pack,
      coverage: {
        searchedCorpora: ['store.a', 'store.b'], skippedCorpora: [], extractionGaps: [],
        matchCounts: [
          { corpusId: 'store.a', family: 'file', trustDomain: 'internal', trustTier: 'S2', matchedItems: 9, inEvidence: 2 },
          { corpusId: 'store.b', family: 'file', trustDomain: 'internal', trustTier: 'S2', matchedItems: 4, inEvidence: 1 },
        ],
      },
    } as never as EvidencePack;
    const sent: EvidencePack[] = [];
    const inner = { analyze: async (packSent: EvidencePack) => { sent.push(packSent); return { answer: 'x', citations: [], unanswered: [] } as unknown as AnalystResult; } };
    await expectedSeatOnlyEvalAnalyst(inner, () => [2], () => {}, () => ['store.a', 'store.b', 'store.a']).analyze(counted, {} as never);
    expect(sent[1]!.coverage.matchCounts!.map((count) => [count.corpusId, count.matchedItems, count.inEvidence]))
      .toEqual([['store.a', 9, 0], ['store.b', 4, 1]]);
  });

  test('each seat-alone prompt is reported by its length and a short hash, never its text', () => {
    const alone = { ...pack, candidates: [pack.candidates[1]!] } as EvidencePack;
    const right = { answer: 'x', citations: [], unanswered: [] } as unknown as AnalystResult;
    const audit = expectedSeatOnlyAudit({ expectedAnswerContains: ['4182'] }, { seats: [2], alone, result: right, prompts: ['secret prompt one', 'secret prompt one', 'other'] });
    expect(audit.prompts?.map((prompt) => prompt.chars)).toEqual([17, 17, 5]);
    expect(audit.prompts![0]!.sha256).toMatch(/^[0-9a-f]{12}$/);
    expect(audit.prompts![0]!.sha256).toBe(audit.prompts![1]!.sha256);
    expect(audit.prompts![0]!.sha256).not.toBe(audit.prompts![2]!.sha256);
    expect(JSON.stringify(audit)).not.toContain('secret');
  });

  test('no expected seat in the pack means no second call; a failed call is reported, never the grade', async () => {
    let calls = 0;
    const inner = { analyze: async () => { calls += 1; if (calls === 3) throw new Error('provider down'); return { answer: `answer ${calls}`, citations: [], unanswered: [] } as unknown as AnalystResult; } };
    const none: unknown[] = [];
    await expectedSeatOnlyEvalAnalyst(inner, () => [], () => none.push(1)).analyze(pack, {} as never);
    expect(calls).toBe(1);
    expect(none).toEqual([]);
    const failed: Array<AnalystResult | undefined> = [];
    const graded = await expectedSeatOnlyEvalAnalyst(inner, () => [1, 3], (_pack, alone, result) => {
      expect(alone.candidates).toEqual([pack.candidates[0]!, pack.candidates[2]!]);
      failed.push(result);
    }).analyze(pack, {} as never);
    expect(graded.answer).toBe('answer 2');
    expect(failed).toEqual([undefined]);
  });
});

describe('Analyst repeats on a frozen pack', () => {
  test('the Analyst answers the same pack again, and the first answer is the graded one', async () => {
    const pack = { question: 'q', candidates: [], coverage: { searchedCorpora: [], skippedCorpora: [], extractionGaps: [] }, builtAt: 't' } as never;
    const seen: unknown[] = [];
    let call = 0;
    const inner = { analyze: async (sent: unknown) => { seen.push(sent); call += 1; return { answer: `answer ${call}`, citations: [], unanswered: [] } as unknown as AnalystResult; } };
    const repeats: AnalystResult[][] = [];
    const result = await repeatedEvalAnalyst(inner, 2, (_pack, extra) => repeats.push(extra)).analyze(pack, {} as never);
    expect(result.answer).toBe('answer 1');
    expect(seen).toEqual([pack, pack, pack]);
    expect(repeats.map((extra) => extra.map((r) => r.answer))).toEqual([['answer 2', 'answer 3']]);
    // A repeat that fails is counted; the graded first answer still stands.
    let calls = 0;
    const flaky = { analyze: async () => { calls += 1; if (calls === 2) throw new Error('provider down'); return { answer: `answer ${calls}`, citations: [], unanswered: [] } as unknown as AnalystResult; } };
    const failures: number[] = [];
    const graded = await repeatedEvalAnalyst(flaky, 2, (_pack, extra, failed) => failures.push(extra.length, failed)).analyze(pack, {} as never);
    expect(graded.answer).toBe('answer 1');
    expect(failures).toEqual([1, 1]);
    // No extra runs: the Analyst itself, untouched.
    expect(repeatedEvalAnalyst(inner, 0, () => {})).toBe(inner);
  });

  test('a repeat is summarized by shape, cited seats and value flags only', async () => {
    const { stores, ledger } = await twoTierWorld();
    const lanes = createEvalDropboxLanes({ stores, ...(ledger ? { ledger } : {}), scope: { accountScope: 'personal' } });
    const { pack } = await buildEvalPack({ question: 'What is the Kestrel boatyard invoice total?', lanes, maxResults: 5, maxCharsPerCandidate: 1_500 });
    const cited = (answer: string) => ({ answer, citations: [{ provenance: pack.candidates[0]!.provenance, claim: 'total' }], unanswered: [] }) as unknown as AnalystResult;
    const question = { expectedAnswerContains: ['4182', 'April'] };
    expect(evalAnswerRepeat(question, pack, cited('The total is 4182 dollars [1].'))).toEqual({
      answerShape: 'partial',
      answerCitedSeats: [1],
      valuesInAnswer: [true, false],
      answerValueTokens: 1,
      answerValueTokensInCitedSeats: 1,
      answerValueTokensUnmatchedShapes: [],
    });
    expect(JSON.stringify(evalAnswerRepeat(question, pack, cited('The total is 4137 dollars.')))).not.toContain('4137');
  });
});

describe('the real eval matches what Ask sends a local Analyst (rerun 20)', () => {
  test('the pack is fitted to the local prompt budget, and the seats sent are recorded', async () => {
    const { stores, ledger } = await twoTierWorld();
    const lanes = createEvalDropboxLanes({ stores, ...(ledger ? { ledger } : {}), scope: { accountScope: 'personal' } });
    const detail = await buildEvalPack({ question: 'What is the Kestrel boatyard invoice total?', lanes, maxResults: 5, maxCharsPerCandidate: 1_500 });
    const first = detail.pack.candidates[0]!;
    // Five long seats: far more than a 4,000-byte prompt holds.
    const seats = Array.from({ length: 5 }, (_, index) => ({
      ...first,
      provenance: { ...first.provenance, sourceItem: { ...first.provenance.sourceItem, localItemId: `personal:seat-${index}` } },
      chunks: [`Seat ${index}. ${'harbor ledger line '.repeat(120)}`],
    }));
    const pack = { ...detail.pack, candidates: seats } as typeof detail.pack;
    const sentPacks: Array<typeof pack> = [];
    const recorded: number[][] = [];
    const analyst = promptFittedEvalAnalyst(
      { analyze: async (sent) => { sentPacks.push(sent); return { answer: 'x', citations: [], unanswered: [] } as unknown as AnalystResult; } },
      4_000,
      () => seats.map(() => DROPBOX_TIER_CORPUS_IDS.internal!),
      (_pack, kept) => recorded.push(kept),
    );
    await analyst.analyze(pack, {} as never);
    const sent = sentPacks[0]!;
    const sentChars = sent.candidates.reduce((sum, candidate) => sum + candidate.chunks.join('').length, 0);
    const packChars = pack.candidates.reduce((sum, candidate) => sum + candidate.chunks.join('').length, 0);
    expect(sentChars).toBeLessThan(packChars);
    expect(recorded[0]!.length).toBe(sent.candidates.length);
    expect(recorded[0]!.every((seat) => seat >= 1 && seat <= 5)).toBe(true);

    // Without a budget (a Venice leg) the pack goes whole.
    const whole: Array<typeof pack> = [];
    await promptFittedEvalAnalyst(
      { analyze: async (sentPack) => { whole.push(sentPack); return { answer: 'x', citations: [], unanswered: [] } as unknown as AnalystResult; } },
      undefined, () => undefined, () => {},
    ).analyze(pack, {} as never);
    expect(whole[0]).toBe(pack);
  });

  test('the second score runs at Ask\'s pack size unless turned off or equal to the gate', () => {
    expect(informationalEvalMaxResults(undefined, 5)).toBe(24);
    expect(informationalEvalMaxResults('12', 5)).toBe(12);
    expect(informationalEvalMaxResults('0', 5)).toBeUndefined();
    expect(informationalEvalMaxResults('5', 5)).toBeUndefined();
    expect(() => informationalEvalMaxResults('-1', 5)).toThrow();
  });
});

describe('the real eval fails a question whose search was incomplete (#1242)', () => {
  const audit = (overrides: Record<string, unknown>) => ({
    packCandidates: 5, packCandidateSources: [], lanes: [], skippedCorpora: [], degradations: [], policyDeniedCandidates: 0,
    unreadCandidates: 0, namesOnlyCandidates: 0, contentPrivateCandidates: 0, corpusReadabilityGaps: 0,
    secureExclusion: 'not_applied' as const, corpusTimings: [], ...overrides,
  });
  const report = (passed: boolean[]) => ({
    total: passed.length, completed: passed.length, remaining: 0,
    passed: passed.filter(Boolean).length, failed: passed.filter((value) => !value).length,
    grades: passed.map((value, index) => ({ questionId: `q${index}`, passed: value, detail: [] as string[] })),
    timings: [],
  }) as never;

  test('a store dropped at the deadline, or a vector lane stopped by it, fails the question and says why', () => {
    const result = failIncompleteRetrieval(report([true, true, true]), [
      { questionId: 'q0', retrieval: audit({ skippedCorpora: [{ corpusId: 'internal.dropbox.files', reason: 'lane_timeout' }] }) },
      { questionId: 'q1', retrieval: audit({ lanes: [{ laneName: 'secure_local.dropbox.files:semantic', laneType: 'semantic', candidateCount: 0, returnedCount: 0, skippedReason: 'vector_scan_deadline_exceeded' }] }) },
      { questionId: 'q2', retrieval: audit({}) },
    ]) as unknown as { passed: number; failed: number; grades: Array<{ passed: boolean; detail: string[] }> };
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.grades[0]!.detail).toEqual(['retrieval_incomplete: internal.dropbox.files store dropped: lane_timeout']);
    expect(result.grades[1]!.detail).toEqual(['retrieval_incomplete: secure_local.dropbox.files:semantic lane skipped: vector_scan_deadline_exceeded']);
    expect(result.grades[2]!.passed).toBe(true);
  });

  test('a value only inside a longer number is in the pack as a substring, not by the grader\'s rules', async () => {
    const { stores, ledger } = await twoTierWorld();
    const lanes = createEvalDropboxLanes({ stores, ...(ledger ? { ledger } : {}), scope: { accountScope: 'personal' } });
    const { pack } = await buildEvalPack({ question: 'What is the Kestrel boatyard invoice total?', lanes, maxResults: 5, maxCharsPerCandidate: 1_500 });
    const answer = { answer: 'x', citations: [], unanswered: [], sufficient: true } as unknown as AnalystResult;
    // The fixture says "4182"; "418" sits inside it.
    expect(evalAnswerStageAudit({ expectedAnswerContains: ['418'] }, pack, answer, answer).expected[0])
      .toMatchObject({ inPack: false, inPackAsSubstring: true });
  });
});

describe('the real eval runner searches the way Ask does', () => {
  test('reaches an item that lives only in the Personal store, with its name and path in the Analyst prompt', async () => {
    const { stores, ledger } = await twoTierWorld();
    expect(stores.map((store) => store.trustDomain).sort()).toEqual(['internal', 'secure_local']);
    for (const store of stores) expect(store.dbPath).toBeTruthy();

    const lanes = createEvalDropboxLanes({ stores, ...(ledger ? { ledger } : {}), scope: { accountScope: 'personal' } });
    const detail = await buildEvalPack({
      question: 'What is the Kestrel boatyard invoice total?',
      lanes,
      maxResults: 5,
      maxCharsPerCandidate: 1_500,
    });
    const index = detail.pack.candidates.findIndex((candidate) => candidate.provenance.sourceItem.providerItemId === 'k1');
    expect(index).toBeGreaterThanOrEqual(0);
    expect(detail.candidateCorpusIds[index]).toBe(DROPBOX_TIER_CORPUS_IDS.internal);
    const citation = detail.pack.candidates[index]!.provenance.citation;
    expect(citation?.title).toBe('kestrel-invoice.txt');
    expect(citation?.uri).toContain('kestrel-invoice.txt');

    // Title and path reach the Analyst, as they do for live Ask (same pack, same Analyst).
    const prompts: string[] = [];
    const model: AnalystModel = {
      async complete(request) {
        prompts.push(request.prompt);
        return { text: JSON.stringify({ answer: 'x', citations: [], unanswered: [], sufficient: false }), modelId: 'scripted' };
      },
    };
    await createAnalyst(model, { auditSuspiciousDrafts: true }).analyze(detail.pack, { localOnly: true });
    expect(prompts[0]).toContain('kestrel-invoice.txt');
    expect(prompts[0]).toContain(citation!.uri!);
  });

  test('uses the built-in model when it is loaded, and says keyword search when it is not', async () => {
    const none = await prepareEvalEmbedding({ configured: {} });
    expect(none.retrieval.mode).toBe('keyword');
    expect(none.retrieval.note).toMatch(/keyword/i);
    expect(none.embeddingFor('secure_local')).toBeUndefined();

    // A configured model that is not the built-in one is never used by an eval that searches as Ask does.
    const remote = await prepareEvalEmbedding({
      configured: { secure_local: new RecordingProvider('openai-compatible', 'other-model', 'local') },
    });
    expect(remote.retrieval.mode).toBe('keyword');
    expect(remote.retrieval.note).toMatch(/not the built-in/i);
  });

  test('a status file that outlived the model files leaves the eval on keyword search, with no download', async () => {
    const { dir, cleanup } = tempDir('olympus-eval-707-model-');
    cleanups.push(cleanup);
    const env = { OLYMPUS_BUILT_IN_EMBEDDING_DIR: dir };
    reportBuiltInEmbeddingState({ env }, 'ready');
    let installs = 0;
    const provider = new BuiltInSourceEmbeddingProvider({
      env,
      install: async () => { installs += 1; throw new Error('the eval must not install a model'); },
    });
    expect(provider.status().state).toBe('ready');
    const prepared = await prepareEvalEmbedding({ configured: { secure_local: provider }, env });
    expect(prepared.retrieval.mode).toBe('keyword');
    expect(prepared.retrieval.note).toMatch(/files are missing/);
    expect(installs).toBe(0);
  });

  test('a loaded local model makes the vector lane run', async () => {
    const provider = new RecordingProvider('built-in', 'fixture-model', 'local');
    const { stores, ledger } = await twoTierWorld(provider);
    const embeddedDocuments = provider.inputs.length;
    const lanes = createEvalDropboxLanes({
      stores,
      ...(ledger ? { ledger } : {}),
      scope: { accountScope: 'personal' },
      embeddingFor: () => provider,
      localEmbedding: (configured) => configured,
    });
    await buildEvalPack({ question: 'Kestrel invoice total', lanes, maxResults: 5, maxCharsPerCandidate: 1_500 });
    // The question itself was embedded: the vector lane ran beside keyword search.
    expect(provider.inputs.slice(embeddedDocuments).some((text) => text.includes('Kestrel invoice total'))).toBe(true);
  });
});

describe('the real eval runner reads gaps from the release, not from text', () => {
  const result: AnalystResult = { answer: 'The total is unknown.', citations: [], unanswered: ['No source states the due date.'] };
  const release = (over: Partial<AnalystReleaseOutcome>): AnalystReleaseOutcome => ({
    decision: { decision: 'allow', reasons: ['release_gate_passed'] },
    facts: [],
    opsec: { structured_evidence: [], release_decision: { decision: 'allow', reasons: [] }, raw_source_exposed: false } as unknown as AnalystReleaseOutcome['opsec'],
    answer: 'The total is unknown.',
    unanswered: [],
    ...over,
  });

  test('a gap reported outside a "Coverage notes:" section still ends up in unanswered', () => {
    const projected = releasedEvalResult(result, release({
      answer: 'The total is unknown. No source states the due date.',
      unanswered: ['No source states the due date.'],
    }));
    expect(projected.unanswered).toEqual(['No source states the due date.']);
  });

  test('each released note is its own entry; nothing is released when the gate holds the answer', () => {
    const projected = releasedEvalResult(result, release({
      answer: 'A.\n\nCoverage notes:\n- one\n- two',
      unanswered: ['one', 'two'],
    }));
    expect(projected.unanswered).toEqual(['one', 'two']);
    const held = releasedEvalResult(result, release({
      decision: { decision: 'needs_approval', reasons: ['x'], requiredApproval: 's4_release' },
      unanswered: [],
    }));
    expect(held.unanswered).toEqual([]);
    expect(held.citations).toEqual([]);
  });
});

describe('the runner\'s release step', () => {
  test('carries the analyst\'s reported gap into unanswered, as released', async () => {
    const { stores, ledger } = await twoTierWorld();
    const lanes = createEvalDropboxLanes({ stores, ...(ledger ? { ledger } : {}), scope: { accountScope: 'personal' } });
    const detail = await buildEvalPack({ question: 'Kestrel boatyard invoice due date', lanes, maxResults: 5, maxCharsPerCandidate: 1_500 });
    const candidate = detail.pack.candidates.find((entry) => entry.provenance.sourceItem.providerItemId === 'k1')!;
    const projected = releaseEvalAnswer(detail, {
      answer: 'The Kestrel boatyard invoice total is 4182 dollars.',
      citations: [{ provenance: candidate.provenance, claim: 'The invoice total is 4182 dollars.' }],
      unanswered: ['No source states the exact due date.'],
    });
    expect(projected.result.unanswered.length).toBeGreaterThan(0);
    for (const note of projected.result.unanswered) expect(projected.result.answer).toContain(note);
  });
});

describe('the dataset shape the runner reads', () => {
  test('per-question notes still load with the questions', async () => {
    const dataset = await Bun.file(new URL('../eval/questions/held-out.json', import.meta.url)).json() as import('../eval/types.ts').EvalDataset;
    const withNotes = dataset.questions.filter((question) => typeof question.notes === 'string' && question.notes.length > 0);
    expect(withNotes.length).toBe(dataset.questions.length);
  });
});
