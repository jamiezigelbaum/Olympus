import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Analyst, EvidencePack } from '../src/core/contracts.ts';
import type { SourceItemIdentity } from '../src/core/source-index/types.ts';
import { openWaitingPrivateQuestionStore, type WaitingQuestionStore } from '../src/core/waiting-private-questions.ts';
import { createDeepReadJobs, DeepReadRefused, type DeepReadStore } from '../src/workers/engine/runtime/deep-read-jobs.ts';
import type { AnalystAnswerLanes } from '../src/workers/source-index/analyst-answer.ts';

const dirs: string[] = [];
const stores: WaitingQuestionStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function inbox(): WaitingQuestionStore {
  const dir = mkdtempSync(join(tmpdir(), 'deep-read-'));
  dirs.push(dir);
  const store = openWaitingPrivateQuestionStore(join(dir, 'waiting.sqlite'));
  stores.push(store);
  return store;
}

function item(n: number): { sourceItem: SourceItemIdentity; authoredAt: string } {
  return {
    sourceItem: { family: 'chat', provider: 'telegram', accountScope: 'me', providerItemId: `m${n}`, providerConversationId: 'wellness', localItemId: `l${n}` },
    authoredAt: `2023-0${(n % 9) + 1}-01T00:00:00Z`,
  };
}

/** Two tier legs of one source: messages 0-9 Personal, 10-14 Private, 15 Names only. */
function fixture(texts: (n: number) => string) {
  const personal: DeepReadStore = {
    corpusId: 'telegram.internal', family: 'chat',
    conversationItems: () => Array.from({ length: 10 }, (_, n) => item(n)).concat([item(15)]),
    activeLocalItemRow: () => ({}),
  };
  const priv: DeepReadStore = {
    corpusId: 'telegram.secure_local', family: 'chat',
    conversationItems: () => Array.from({ length: 5 }, (_, n) => item(n + 10)),
    activeLocalItemRow: () => ({}),
  };
  const domains: Record<string, string> = { 'telegram.internal': 'internal', 'telegram.secure_local': 'secure_local' };
  const lanes = {
    registry: { get: (id: string) => ({ trustDomain: domains[id] }) },
    contentProviders: Object.fromEntries(Object.keys(domains).map(id => [id, {
      async fetchLocalContent(request: { provenance: { sourceItem: SourceItemIdentity } }) {
        const n = Number(request.provenance.sourceItem.providerItemId.slice(1));
        if (n === 15) return { sensitivity: { trustTier: 'S1' }, chunks: [], namesOnly: true };
        return { sensitivity: { trustTier: id.endsWith('secure_local') ? 'S4' : 'S1' }, chunks: [texts(n)] };
      },
    }])),
  } as unknown as AnalystAnswerLanes;
  return { stores: [personal, priv], lanes };
}

function analyst(packs: EvidencePack[]): Analyst {
  return {
    async analyze(pack) {
      packs.push(pack);
      const hits = pack.candidates.filter(c => c.chunks.some(chunk => chunk.includes('heart')));
      return { answer: hits.length ? 'Members discussed heart health.' : 'Nothing here.', citations: hits.map(c => ({ provenance: c.provenance, claim: c.chunks[0]! })), unanswered: [] };
    },
  };
}

const set = { selected_item: { corpus_id: 'telegram.internal', family: 'chat', provider: 'telegram', account_scope: 'me', provider_item_id: 'm3', local_item_id: 'l3', provider_conversation_id: 'wellness', conversation_label: 'Wellness' }, whole: 'conversation' as const };

async function settled(jobs: ReturnType<typeof createDeepReadJobs>, id: string) {
  for (let i = 0; i < 200; i += 1) {
    const view = jobs.status(id)[0]!;
    if (view.state === 'done' || view.state === 'failed' || view.state === 'cancelled') return view;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('deep read did not settle');
}

describe('deep read jobs', () => {
  test('reads every readable message of the conversation across tier stores and lands the answer in Private answers', async () => {
    const { stores: deepStores, lanes } = fixture(n => (n === 4 || n === 12 ? `message ${n}: my heart doctor said ...` : `message ${n}: other things`));
    const packs: EvidencePack[] = [];
    const waiting = inbox();
    const jobs = createDeepReadJobs({
      stores: () => deepStores, lanes: () => lanes, inbox: () => waiting,
      model: async () => ({ analyst: analyst(packs), promptBytes: 13_500, modelId: 'qwen-35b' }),
    });
    const started = await jobs.start('What was said about heart disease?', set);
    expect(started).toMatchObject({ items: 16, unreadable: 1, model: 'qwen-35b', setLabel: 'Wellness' });
    const done = await settled(jobs, started.id);
    expect(done.state).toBe('done');
    const read = packs.slice(0, -1).flatMap(p => p.candidates.map(c => c.provenance.sourceItem.localItemId));
    expect(new Set(read).size).toBe(15);
    expect(packs.at(-1)!.candidates.map(c => c.provenance.sourceItem.localItemId)).toEqual(['l12', 'l4']); // authored order: l12 (April) before l4 (May)
    expect(packs.at(-1)!.candidates.map(c => c.trustDomain)).toEqual(['secure_local', 'internal']);
    const landed = waiting.get(done.inboxId!)!;
    expect(landed.result?.status).toBe('answered');
    expect(landed.result?.answer).toContain('with qwen-35b');
    expect(landed.result?.read.length).toBe(2);
  });

  test('never falls back to the built-in model: no private model refuses, a down one says so', async () => {
    const { stores: deepStores, lanes } = fixture(() => 'x');
    const none = createDeepReadJobs({ stores: () => deepStores, lanes: () => lanes, inbox: () => undefined, model: async () => undefined });
    await expect(none.start('q', set)).rejects.toMatchObject({ code: 'no_private_model' });
    const down = createDeepReadJobs({ stores: () => deepStores, lanes: () => lanes, inbox: () => undefined, model: async () => ({ unavailable: true, modelId: 'qwen-35b' }) });
    await expect(down.start('q', set)).rejects.toBeInstanceOf(DeepReadRefused);
  });

  test('steps aside for privacy judging, says so, and still moves on a standing backlog', async () => {
    const { stores: deepStores, lanes } = fixture(() => 'x');
    let t = 0;
    const jobs = createDeepReadJobs({
      stores: () => deepStores, lanes: () => lanes, inbox: () => undefined,
      model: async () => ({ analyst: analyst([]), promptBytes: 13_500, modelId: 'm' }),
      judgeBusy: () => true,
      now: () => new Date(t),
      sleep: async (ms) => { t += ms; await Promise.resolve(); },
    });
    const started = await jobs.start('q', set);
    const done = await settled(jobs, started.id);
    expect(done.state).toBe('done');
    expect(done.waitingOn).toBeUndefined();
  });

  test('the owner can cancel a read in progress', async () => {
    const { stores: deepStores, lanes } = fixture(() => 'x');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const slow: Analyst = { analyze: async () => { await gate; return { answer: '', citations: [], unanswered: [] }; } };
    const jobs = createDeepReadJobs({ stores: () => deepStores, lanes: () => lanes, inbox: () => undefined, model: async () => ({ analyst: slow, promptBytes: 13_500, modelId: 'm' }) });
    const started = await jobs.start('q', set);
    expect(jobs.cancel(started.id)).toBe(true);
    release();
    expect((await settled(jobs, started.id)).state).toBe('cancelled');
  });
});

describe('conversation lister', () => {
  test('lists one conversation\'s active items in authored order, within the span, ids only', async () => {
    const { LocalConnectorStore } = await import('../src/workers/connector-store/local-index.ts');
    const { TierLedger } = await import('../src/workers/classification/tier-ledger.ts');
    const { fixtureConnector, tempDir } = await import('./helpers/tier-fixtures.ts');
    const { Database } = await import('bun:sqlite');
    const tmp = tempDir('deep-read-store-');
    const ledger = new TierLedger({ dbPath: `${tmp.dir}/ledger.sqlite` });
    const store = new LocalConnectorStore({ dbPath: `${tmp.dir}/store.sqlite`, corpusId: 'internal.fixture.files', family: 'file', trustDomain: 'internal', tierLedger: ledger });
    try {
      const specs = [
        { id: 'a', name: 'a', text: 'first', conversation: 'c1' },
        { id: 'b', name: 'b', text: 'second', conversation: 'c1' },
        { id: 'c', name: 'c', text: 'third', conversation: 'c1' },
        { id: 'd', name: 'd', text: 'elsewhere', conversation: 'c2' },
      ];
      await store.syncFromConnector(fixtureConnector(() => specs), {
        fetchContent: true, tierClassification: { rules: [], sniffer: { id: 'initial', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary' }) } },
      });
      const db = new Database(store.dbPath);
      const times: Record<string, string> = { a: '2024-03-01T00:00:00Z', b: '2022-01-01T00:00:00Z', c: '2023-06-01T00:00:00Z', d: '2023-01-01T00:00:00Z' };
      for (const [id, at] of Object.entries(times)) db.query('UPDATE items SET authored_at = ? WHERE provider_item_id = ?').run(at, id);
      db.close();
      const first = specs[0]!;
      const key = { provider: 'fixture', accountScope: 'acct', providerConversationId: 'c1' };
      const provider = store.activeLocalItemRow((await import('./helpers/tier-fixtures.ts')).fixtureLocalId(first))!.identity;
      const listed = store.conversationItems({ ...key, provider: provider.provider, accountScope: provider.accountScope });
      expect(listed.map(entry => entry.sourceItem.providerItemId)).toEqual(['b', 'c', 'a']);
      expect(JSON.stringify(listed)).not.toContain('third');
      const span = store.conversationItems({ provider: provider.provider, accountScope: provider.accountScope, providerConversationId: 'c1', after: '2023-01-01', before: '2024-01-01' });
      expect(span.map(entry => entry.sourceItem.providerItemId)).toEqual(['c']);
    } finally {
      store.close(); ledger.close(); tmp.cleanup();
    }
  });
});

describe('deep read through the engine route and the operation', () => {
  test('source_deep_read starts a job on the engine and source_deep_read_status reads it back', async () => {
    const { createEmailSourceWorker } = await import('../src/workers/engine/index.ts');
    const { EmailClient, DirectHttpEmailTransport } = await import('../src/core/email.ts');
    const { operations } = await import('../src/core/operations.ts');
    const { defaultConfig } = await import('../src/core/config.ts');
    const { stores: deepStores, lanes } = fixture(n => `message ${n}: heart ${n}`);
    const jobs = createDeepReadJobs({ stores: () => deepStores, lanes: () => lanes, inbox: () => undefined, model: async () => ({ analyst: analyst([]), promptBytes: 13_500, modelId: 'm' }) });
    const worker = createEmailSourceWorker({ deepRead: () => jobs });
    const config = defaultConfig();
    config.email.enabled = true;
    config.email.baseUrl = 'http://worker.test/v1';
    (config as { sourceIndex: { enabled: boolean } }).sourceIndex.enabled = true;
    const email = new EmailClient(config, new DirectHttpEmailTransport(async (url, init) => worker.fetch(new Request(url, init))));
    const ctx = { config, email } as never;
    const start = operations.find(o => o.name === 'source_deep_read')!;
    const started = await start.handler(ctx, { question: 'heart?', selected_item: set.selected_item, whole: 'conversation' }) as { job: { id: string; items: number } };
    expect(started.job.items).toBe(16);
    const status = operations.find(o => o.name === 'source_deep_read_status')!;
    const listed = await status.handler(ctx, { id: started.job.id }) as { jobs: Array<{ id: string }> };
    expect(listed.jobs.map(job => job.id)).toEqual([started.job.id]);
    await expect(start.handler(ctx, { question: 'q', selected_item: set.selected_item, whole: 'folder' })).rejects.toThrow();
  });
});

describe('deep read on the remote surface', () => {
  test('a remote agent sees progress only: never the question, the set name, counts or the answer', async () => {
    const { remoteOperationOutput, remoteOutputSchema } = await import('../src/core/remote-result.ts');
    const job = { id: 'dr_abcdefghij', state: 'reading', question: 'secret question', setLabel: 'Wellness', items: 16, unreadable: 1, sectionsTotal: 4, sectionsDone: 1, notes: 2, model: 'qwen', startedAt: 'x', estimateSecondsLeft: 60, waitingOn: 'privacy checks' };
    const started = remoteOperationOutput('source_deep_read', { job }, {}) as Record<string, unknown>;
    expect(started).toEqual({ job: { id: 'dr_abcdefghij', state: 'reading', sectionsTotal: 4, sectionsDone: 1, estimateSecondsLeft: 60, waitingOn: 'privacy checks' }, answerLandsIn: "Olympus Private answers on the owner's computer" });
    const listed = JSON.stringify(remoteOperationOutput('source_deep_read_status', { jobs: [{ ...job, state: 'done', inboxId: 'q1' }] }, {}));
    for (const hidden of ['secret question', 'Wellness', 'qwen', 'q1', '"items"']) expect(listed).not.toContain(hidden);
    expect(remoteOutputSchema('source_deep_read')).toBeDefined();
    expect(() => remoteOperationOutput('source_deep_read', { job: { id: 'nope', state: 'reading' } }, {})).toThrow();
  });
});
