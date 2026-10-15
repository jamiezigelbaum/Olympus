// The Private-match probe on a computer whose local model is busy or slow
// (docs/design/background-agents.md section A; core/remote-private-part.ts).
//
// What starved it: every search first asks the built-in model to translate the
// question's words into the languages the store holds (keyword-expansion.ts),
// once per new wording. The model serves one request at a time, is slow on a
// CPU-only computer, and may be busy with the tier sniffer or an answer, so a
// first-time wording waited far past the probe's two seconds, the verdict was
// `unknown`, and the agent got no Open link. The probe now never waits on the
// model: it matches on the words alone, then on words and meaning, and waits for
// a translation only when nothing matched and the translation could still
// change the answer.
//
// The model here is a stand-in with the real server's one property that matters:
// a single slot, first come first served, held by a sniffer-sized call until the
// test lets it go.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import type { AnalystModelRequest } from '../src/core/analyst.ts';
import { createRemotePrivateParts } from '../src/core/remote-private-part.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { expandSourceIndexKeywords } from '../src/core/source-index/keyword-expansion.ts';
import { openWaitingPrivateQuestionStore, type WaitingQuestionStore } from '../src/core/waiting-private-questions.ts';
import { registerBuiltInPrivateModel } from '../src/workers/classification/built-in-sniffer.ts';
import { LocalConnectorStore, createConnectorStoreCorpusAdapter, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { probePrivateMatch, type AnalystAnswerLanes } from '../src/workers/source-index/analyst-answer.ts';
import { ARCTIC_EMBED_M_V1_5 } from '../src/workers/source-index/built-in-embedding/manifest.ts';
import type { SourceEmbeddingProvider } from '../src/workers/source-index/embeddings.ts';

const CORPUS_ID = 'secure_local.fixture.files';
const TRANSLATION_PREFIX = 'Translate only the INDIVIDUAL content words';

const ITEMS = [
  { id: 'cardio', name: 'Cardiology follow-up notes', text: 'Cardiology follow-up: resting heart rate 52 bpm. Prescribed lisinopril 5 mg daily. Reference PRIVMARK-lantern-moth-4417.' },
  { id: 'lease', name: 'Apartment lease renewal.pdf', text: 'The apartment lease renewal runs to May 2027 and the deposit is returned within thirty days of the move.' },
  // The language that puts a translation target into the store's profile.
  { id: 'asteroide', name: 'Observación del asteroide', text: 'El asteroide se acercará a la Tierra durante la madrugada y los astrónomos de todo el país observarán el fenómeno con sus telescopios.' },
];

function connector(): SourceConnector {
  const raw = ITEMS.map((item): RawItem => ({
    identity: { family: 'file', provider: 'fixture_files', accountScope: 'personal', providerItemId: item.id, providerFileId: item.id, localItemId: `personal:${item.id}`, sourceVersion: `${item.id}:v1` },
    mimeType: 'text/plain',
    content: { kind: 'text', text: item.text },
    metadata: Object.freeze({ name: item.name, locatorUri: `/home/${item.name}`, pathDisplay: `/home/${item.name}`, updatedAt: '2026-07-01T10:00:00.000Z' }),
    fetchedAt: '2026-07-01T10:00:00.000Z',
  }));
  const byId = new Map(raw.map((item) => [item.identity.localItemId, item]));
  return {
    id: 'fixture-busy-model',
    family: 'file',
    async authenticate(): Promise<void> {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      return (async function* (): AsyncGenerator<SourceConnectorListPage> { yield { items: raw, done: true }; })();
    },
    async fetchItem(localItemId: string): Promise<RawItem> {
      const item = byId.get(localItemId);
      if (!item) throw new Error(`missing fixture ${localItemId}`);
      return item;
    },
    classificationSignals() {
      return {};
    },
  } as unknown as SourceConnector;
}

/** One slot, first come first served, as the llama-server runs (--parallel 1). */
function singleSlotModel(translate: (request: AnalystModelRequest) => string) {
  const calls: AnalystModelRequest[] = [];
  let tail: Promise<void> = Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const model = {
    async complete(request: AnalystModelRequest) {
      calls.push(request);
      const turn = tail.then(async () => {
        if (request.system.startsWith('sniffer')) await held;
        return { text: request.system.startsWith(TRANSLATION_PREFIX) ? translate(request) : '{}', modelId: 'fixture' };
      });
      tail = turn.then(() => undefined, () => undefined);
      return turn;
    },
  };
  return {
    model,
    release,
    /** A sniffer-sized call that occupies the slot until `release`. */
    holdSlot: () => { void model.complete({ system: 'sniffer', prompt: 'x', localOnly: true }); },
    translationCalls: () => calls.filter((request) => request.system.startsWith(TRANSLATION_PREFIX)).length,
  };
}

const at = (cosine: number) => [cosine, Math.sqrt(1 - cosine * cosine)];

let dir: string;
let store: LocalConnectorStore;
let waiting: WaitingQuestionStore;
let queryEmbeds: string[];
let hangQueryEmbeds: boolean;
let busy: ReturnType<typeof singleSlotModel>;

// Built-in-like (calibrated bar 0.40): only a question about the tenancy is near the lease.
const provider: SourceEmbeddingProvider = {
  provider: 'built-in',
  modelId: ARCTIC_EMBED_M_V1_5.modelId,
  dimension: 2,
  configHash: 'busy-model-fixture',
  epochId: `local:built-in:${ARCTIC_EMBED_M_V1_5.modelId}:2`,
  backend: 'local',
  async embed(inputs, options) {
    if (options.taskType !== 'RETRIEVAL_QUERY') return inputs.map(() => [1, 0]);
    queryEmbeds.push(...inputs.map((input) => input.text));
    if (hangQueryEmbeds) return new Promise<number[][]>(() => {});
    return inputs.map((input) => at(input.text.includes('tenancy') ? 0.9 : 0.1));
  },
};

const lanes = (request: unknown): AnalystAnswerLanes => ({
  registry: buildSourceIndexCorpusRegistry([defineConnectorCorpus({ corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' })]),
  adapters: { [CORPUS_ID]: createConnectorStoreCorpusAdapter({ store, retrievalMode: (request as { retrieval_mode?: 'keyword' | 'hybrid' }).retrieval_mode ?? 'keyword', embeddingProvider: provider }) },
}) as unknown as AnalystAnswerLanes;

const probe = (question: string, timeoutMs = 1_500) => probePrivateMatch({ lanes, request: { question } as never, timeoutMs });

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'olympus-probe-busy-model-'));
  store = new LocalConnectorStore({ dbPath: join(dir, 'files.sqlite'), corpusId: CORPUS_ID, family: 'file', trustDomain: 'secure_local' });
  await store.syncFromConnector(connector(), { fetchContent: true });
  await store.embedChunks({ provider });
  waiting = openWaitingPrivateQuestionStore(join(dir, 'waiting.sqlite'));
  queryEmbeds = [];
  hangQueryEmbeds = false;
  // Translates `dawn` into the store's Spanish the way a model would, once its turn comes.
  busy = singleSlotModel((request) => {
    const concepts = (JSON.parse(request.prompt) as { concepts: Array<{ id: string; term: string }> }).concepts;
    const dawn = concepts.find((concept) => concept.term.toLowerCase() === 'dawn');
    return JSON.stringify({ spa: dawn ? { [dawn.id]: ['madrugada'] } : {} });
  });
  registerBuiltInPrivateModel({ available: () => true, model: busy.model });
});

afterEach(() => {
  busy.release();
  registerBuiltInPrivateModel(undefined);
  waiting.close();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** The question of the release check: its words are in the Private item, and nothing is cached for it. */
const FIRST_TIME_WORDING = 'What did my cardiology follow-up say about my resting heart rate and my medication? Use my Olympus records.';

describe('the Private-match probe with the local model busy', () => {
  test('the setup starves a translation: a first-time wording would wait on the model', async () => {
    expect(store.keywordLanguages()).toContain('spa');
    busy.holdSlot();
    // Any other wording, so nothing here is cached for the probe's own.
    const waited = await Promise.race([
      expandSourceIndexKeywords(`${FIRST_TIME_WORDING} Again.`, store.keywordLanguages()).then(() => 'translated'),
      Bun.sleep(200).then(() => 'still waiting'),
    ]);
    expect(waited).toBe('still waiting');
    expect(busy.translationCalls()).toBe(1);
  });

  test('a first-time wording whose words are in the Private item is a match, with the model held and the question never embedded', async () => {
    busy.holdSlot();
    expect(await probe(FIRST_TIME_WORDING)).toBe('match');
    // The probe asked the model for nothing, and embedded nothing it did not need.
    expect(busy.translationCalls()).toBe(0);
    expect(queryEmbeds).toEqual([]);
  });

  test('the words match even when the question cannot be embedded at all', async () => {
    hangQueryEmbeds = true;
    expect(await probe(FIRST_TIME_WORDING)).toBe('match');
    expect(queryEmbeds).toEqual([]);
  });

  test('a match by meaning alone does not wait for the model either', async () => {
    busy.holdSlot();
    // No word of the lease is in it; only its meaning is.
    expect(await probe('When does my tenancy expire?')).toBe('match');
    expect(queryEmbeds).toEqual(['When does my tenancy expire?']);
    expect(busy.translationCalls()).toBe(0);
  });

  test('a match only the translation finds: unknown while the model is held (never "no"), a match once it has answered', async () => {
    busy.holdSlot();
    const question = 'Tell me about the dawn.';
    // Words and meaning find nothing, and the translation could change that: the wait is bounded, and the answer is not a "no".
    expect(await probe(question, 300)).toBe('unknown');
    expect(busy.translationCalls()).toBe(1);
    // The model answers; the translation is kept for the wording, and the probe uses it at once.
    busy.release();
    let verdict = await probe(question, 300);
    for (let tries = 0; tries < 40 && verdict !== 'match'; tries += 1) {
      await Bun.sleep(25);
      verdict = await probe(question, 300);
    }
    expect(verdict).toBe('match');
    // The wording is translated once, not again for each ask.
    expect(busy.translationCalls()).toBe(1);
  });

  test('a question nothing matches is still a "no" when no translation was missing', async () => {
    // Every concept of this wording is a number or already in the static equivalents: no model call is needed.
    expect(await probe('zebra quantum saxophone')).toBe('no_match');
  });

  test('the agent gets the note: a remote agent\'s first-time search, on the default two-second bound, records a waiting question', async () => {
    busy.holdSlot();
    const remote = createRemotePrivateParts({
      probe: (request, timeoutMs) => probePrivateMatch({ lanes, request: request as never, timeoutMs }),
      store: () => waiting,
    });
    const call = remote.forConnection('conn-a').start('olympus_search', { question: FIRST_TIME_WORDING })!;
    const started = Date.now();
    expect(await call.settle({ evidence: [] }, undefined)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(waiting.list().questions.map((question) => [question.surface, question.state])).toEqual([['remote', 'waiting']]);
    expect(busy.translationCalls()).toBe(0);
  });
});

describe('re-checking a "couldn\'t check yet" row while the model is busy', () => {
  const question = 'Tell me about the dawn.';
  const partsWith = (extra: Partial<Parameters<typeof createRemotePrivateParts>[0]> = {}) => createRemotePrivateParts({
    probe: (request, timeoutMs) => probePrivateMatch({ lanes, request: request as never, timeoutMs }),
    store: () => waiting,
    // A search's bound: far shorter than the model's hold.
    probeTimeoutMs: 300,
    ...extra,
  });

  test('the search gives up at its bound, and the re-check waits on the held translation past it, then records the match', async () => {
    busy.holdSlot();
    const parts = partsWith();
    await parts.forConnection('conn-a').start('olympus_search', { question })!.settle({ evidence: [] }, undefined);
    expect(waiting.list().questions.map((row) => row.state)).toEqual(['unchecked']);
    const started = Date.now();
    setTimeout(() => busy.release(), 800);
    expect(await parts.retryUnchecked()).toEqual({ matched: 1, cleared: 0, still: 0 });
    // It outwaited the search's 300 ms, and the translation was made once for the wording.
    expect(Date.now() - started).toBeGreaterThanOrEqual(700);
    expect(busy.translationCalls()).toBe(1);
    expect(waiting.list().questions.map((row) => row.state)).toEqual(['waiting']);
  });

  test('a translation that never arrives leaves the row for the next pass, never a "no"', async () => {
    busy.holdSlot();
    waiting.record(waiting.ticket('conn-a'), { question, surface: 'remote', state: 'unchecked' });
    const started = Date.now();
    expect(await partsWith({ retryProbeTimeoutMs: 400 }).retryUnchecked()).toEqual({ matched: 0, cleared: 0, still: 1 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(350);
    expect(waiting.list().questions.map((row) => row.state)).toEqual(['unchecked']);
  });

  test('a pass starts no probe while the owner\'s own answer is in flight', async () => {
    waiting.record(waiting.ticket('conn-a'), { question, surface: 'remote', state: 'unchecked' });
    const probes: unknown[] = [];
    let ownerBusy = true;
    const parts = partsWith({
      probe: async (request) => { probes.push(request); return 'match'; },
      interactiveBusy: () => ownerBusy,
    });
    expect(await parts.retryUnchecked()).toEqual({ matched: 0, cleared: 0, still: 1 });
    expect(probes).toEqual([]);
    ownerBusy = false;
    expect(await parts.retryUnchecked()).toEqual({ matched: 1, cleared: 0, still: 0 });
    expect(probes).toHaveLength(1);
  });
});
