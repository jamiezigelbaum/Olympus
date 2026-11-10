// The real held-out eval runner (eval/run-real.ts) searches the way Ask does
// (#707): every tier store of the source (Private and Personal), through the
// shared answer lanes, with the built-in embedding model when it is loaded and
// keyword search, said so, when it is not. Its gaps come from the release's
// structured notes, never parsed back out of the answer text.
//
// Synthetic data only: fixture stores in a temp folder, a scripted model.

import { afterEach, describe, expect, test } from 'bun:test';
import { createAnalyst, type AnalystModel } from '../src/core/analyst.ts';
import type { AnalystResult } from '../src/core/contracts.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { DROPBOX_TIER_CORPUS_IDS } from '../src/workers/dropbox-files/connector-store.ts';
import type { AnalystReleaseOutcome } from '../src/workers/source-index/analyst-answer.ts';
import {
  buildEvalPack,
  createEvalDropboxLanes,
  evalAnswerStageAudit,
  evalRetrievalAudit,
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

    // The Analyst said it; the release removed it.
    expect(evalAnswerStageAudit(question, pack, answer('The total is 4182 dollars.'), answer('The total is [withheld].'))).toEqual({
      expected: [
        { inPack: true, inAnalystAnswer: true, inReleasedAnswer: false },
        { inPack: false, inAnalystAnswer: false, inReleasedAnswer: false },
      ],
    });
    // The value was in the pack and the Analyst missed it.
    expect(evalAnswerStageAudit(question, pack, answer('I could not find the total.'), answer('I could not find the total.')).expected[0])
      .toEqual({ inPack: true, inAnalystAnswer: false, inReleasedAnswer: false });
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
