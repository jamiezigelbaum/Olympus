// The private answer panel wired to the built-in private model (integration):
//
// - olympus_search with a Private match creates a one-time panel job; the
//   panel collects it with ECDH and decrypts an answer the built-in model
//   wrote from the Private hits (a stub completion, the real answerPrivately
//   and Analyst). Model-visible: one fixed note that a private match exists
//   (owner decision 2026-10-02), never a count, title or content.
// - The sealed answer is padded to a size bucket.
// - The panel page refuses a job id outside the routable shape.
// - The panel model reports ready / downloading / no model from the built-in
//   model's install state, and its reset stops the model server.
// - A Private item re-tiered to Secret in a real local index is never returned
//   by the claim-time (`all_tiers: false`) search.
// - The dashboard shows the built-in private model as the answer model, and
//   its download alone never puts the page into `installing`.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { answerPrivately, type BuiltInAnalystModel } from '../src/core/analyst-built-in.ts';
import type { AnalystModelRequest } from '../src/core/analyst.ts';
import { defaultConfig } from '../src/core/config.ts';
import { openRemoteConnectionStore } from '../src/core/remote-connections.ts';
import { buildChatGptDashboardViewModel } from '../src/workers/chatgpt/dashboard-view-model.ts';
import { copyDashboardViewModel, PRIVATE_MATCH_NOTE, PRIVATE_MATCH_PANEL_NOTE, searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { PRIVATE_ANSWER_META_KEY, type PrivateEvidenceItem } from '../src/workers/chatgpt/private-answer-contract.ts';
import { PRIVATE_ANSWER_RESOURCE_VERSIONED_URI } from '../src/workers/chatgpt/private-answer-resource.ts';
import {
  PRIVATE_ANSWER_PAD_BUCKETS,
  generatePanelKeyPair,
  openPrivateAnswer,
  padPrivateAnswerPlaintext,
  type SealedPrivateAnswer,
} from '../src/workers/chatgpt/private-answer-crypto.ts';
import { PrivateAnswerJobs, createPrivateAnswerHandler, isPrivateEligible } from '../src/workers/chatgpt/private-answer-jobs.ts';
import { createBuiltInPrivateAnswerModel, privateEvidence, privateEvidenceItems, withoutEvidenceMarkers } from '../src/workers/chatgpt/private-answer-model.ts';
import { privateAnswerPageHtml } from '../src/workers/chatgpt/private-answer-resource.ts';
import { CHATGPT_PRIVATE_ANSWER_JOB_ID } from '../src/workers/dashboard/chatgpt/private-answer.ts';
import { PRIVATE_ANSWER_PATH_PATTERN } from '../connect-relay/shared/private-answer.ts';
import { CHATGPT_TOOLS } from '../src/workers/chatgpt/mcp-surface.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { createConnectorStoreContentProvider, createConnectorStoreCorpusAdapter, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { searchPrivateEvidence } from '../src/workers/source-index/analyst-answer.ts';
import { buildEvidencePackDetailed } from '../src/core/evidence-pack.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createInProcessOperationContext, createRemoteMcpHandler } from '../src/workers/remote-mcp.ts';
import { QWEN35_4B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import type { SourceDashboardViewModel } from '../src/workers/source-dashboard.ts';
import { DASHBOARD_CHATGPT_VOCABULARY } from '../src/workers/dashboard/vocabulary.ts';
import {
  CORPORA,
  FIXTURE_PLACEMENT,
  fixtureConnector,
  identityOf,
  openTierFixture,
  tempDir,
  type FixtureSpec,
} from './helpers/tier-fixtures.ts';

const INSTALL = 'c'.repeat(32);
const PANEL_ORIGIN = 'https://olympus.web-sandbox.oaiusercontent.com';
const PRIVATE_PASSAGE = 'SENTINEL_LEASE_7f3a: the lease on the flat ends on 31 May 2027.';
const SENTINEL_PATTERN = /SENTINEL_[A-Z_]+_7f3a/;

/** Private hits as the worker's `source_index_search` returns them. */
const PRIVATE_HITS: PrivateEvidenceItem[] = [{
  sourceItem: { family: 'email', provider: 'gmail', accountScope: 'personal', providerItemId: 'm-1', localItemId: 'personal:m-1' },
  provenance: { citation: { title: 'Lease renewal', sourceLabel: 'Gmail', authoredAt: '2026-04-01' } },
  internalContent: { kind: 'bounded_item_passage', passage: PRIVATE_PASSAGE, passageChars: PRIVATE_PASSAGE.length, truncated: false, sourceTextReturned: true },
  selected_item: { corpus_id: 'secure_local.email' },
  rawExposed: false,
}];

const INTEGRAL_PASSAGE = 'SENTINEL_INTEGRAL_7f3a: the integral approach maps experience into four quadrants.';

/** Private candidates as the shared EvidencePack build returns them (source-index/analyst-answer.ts searchPrivateEvidence). */
const PRIVATE_CANDIDATES: PrivateEvidenceItem[] = [
  {
    provenance: {
      sourceItem: { family: 'file', provider: 'dropbox', accountScope: 'personal', providerItemId: 'f-1', localItemId: 'personal:f-1' },
      citation: { title: 'Integral approach notes', sourceLabel: 'dropbox', authoredAt: '2020-02-05T13:56:40Z' },
    },
    trustTier: 'S4',
    trustDomain: 'secure_local',
    chunks: [INTEGRAL_PASSAGE, 'SENTINEL_INTEGRAL_7f3a: each quadrant is a perspective.'],
  },
  {
    provenance: {
      sourceItem: { family: 'file', provider: 'dropbox', accountScope: 'personal', providerItemId: 'f-2', localItemId: 'personal:f-2' },
      citation: { title: 'Scanned receipt.pdf', sourceLabel: 'dropbox' },
    },
    trustTier: 'S4',
    trustDomain: 'secure_local',
    chunks: [],
  },
];

/** A built-in model whose completion is canned: the real answerPrivately and Analyst run over it. */
function stubBuiltInModel(text: string, state: 'ready' | 'downloading' | 'not_started' = 'ready') {
  const requests: AnalystModelRequest[] = [];
  let stops = 0;
  const model: BuiltInAnalystModel = {
    name: 'built_in',
    spec: QWEN35_4B,
    async prepare() {},
    status: () => ({
      state,
      modelId: QWEN35_4B.modelId,
      percent: state === 'downloading' ? 42 : state === 'ready' ? 100 : 0,
      label: '',
      bytesDone: 0,
      bytesTotal: 0,
      updatedAt: new Date(0).toISOString(),
    }),
    async stop() { stops += 1; },
    async complete(request) {
      requests.push(request);
      return { text, modelId: `built_in/${QWEN35_4B.modelId}` };
    },
  };
  return { model, requests, stops: () => stops };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('olympus_search -> private answer panel -> built-in model (end to end)', () => {
  test('a Private match reaches only the panel; it collects and decrypts the built-in model\'s answer', async () => {
    const stub = stubBuiltInModel(JSON.stringify({
      answer: 'The lease ends on 31 May 2027 [1].',
      citations: [{ evidence: 1, claim: 'The lease ends on 31 May 2027.' }],
      unanswered: [],
      sufficient: true,
    }));
    const privateModel = createBuiltInPrivateAnswerModel({ model: stub.model, available: () => true, answer: answerPrivately });
    const jobs = new PrivateAnswerJobs({ model: () => privateModel, installId: () => INSTALL });

    const dir = mkdtempSync(join(tmpdir(), 'olympus-private-integration-'));
    const store = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'));
    const worker = createEmailSourceWorker({});
    const config = { ...defaultConfig(), sourceIndex: { ...defaultConfig().sourceIndex, enabled: true } };
    let refreshes = 0;
    const handler = createRemoteMcpHandler({
      connections: () => store,
      makeOperationContext: (caller, signal) => createInProcessOperationContext({ config, sourceIndexReadEnabled: true, workerFetch: worker.fetch, caller, signal }),
      chatgpt: {
        servesRequest: () => true,
        privateAnswers: jobs,
        async privateMatchProbe() {
          refreshes += 1;
          return { count: 1, evidence: PRIVATE_HITS };
        },
        async dashboardView() { throw new Error('unused'); },
        async evidenceSearch() {
          return {
            evidence: [{ trust_domain: 'internal', family: 'file', provider: 'google_drive', title: 'Flat inventory', excerpt: 'Two chairs and a table.' }],
            coverage: { searched_corpora: 2, unreadable_items: 0, partially_read_items: 0, unclassified_items: 0 },
          };
        },
      },
    });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
    cleanups.push(() => {
      server.stop(true);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const { token } = store.create('ChatGPT');
    const client = new Client({ name: 'private-integration-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as unknown as Parameters<Client['connect']>[0]);
    let result: Record<string, unknown>;
    let listed: Array<Record<string, unknown>>;
    try {
      listed = (await client.listTools()).tools as unknown as Array<Record<string, unknown>>;
      result = await client.callTool({ name: 'olympus_search', arguments: { question: 'When does the lease end?' } }) as Record<string, unknown>;
    } finally {
      await client.close();
    }

    // olympus_search always links the panel resource.
    const search = listed.find((tool) => tool.name === 'olympus_search')!;
    expect(search._meta).toEqual({ ui: { resourceUri: PRIVATE_ANSWER_RESOURCE_VERSIONED_URI }, 'openai/outputTemplate': PRIVATE_ANSWER_RESOURCE_VERSIONED_URI });
    expect(CHATGPT_TOOLS.find((tool) => tool.name === 'olympus_search')!._meta).toEqual(search._meta as Record<string, unknown>);

    // The panel's `_meta`: count, state and the one-time job, nothing else.
    const meta = (result._meta as Record<string, unknown>)[PRIVATE_ANSWER_META_KEY] as Record<string, unknown>;
    expect(Object.keys(meta).sort()).toEqual(['count', 'jobId', 'state', 'v']);
    expect(meta).toMatchObject({ v: 1, count: 1, state: 'ready' });
    // Model-visible: the Personal evidence plus exactly the one fixed Private
    // note (owner decision 2026-10-02); no count, state, job, title or content.
    const visible = JSON.stringify({ content: result.content, structuredContent: result.structuredContent });
    expect(visible).toContain('Flat inventory');
    expect(visible.split(JSON.stringify(PRIVATE_MATCH_PANEL_NOTE).slice(1, -1)).length - 1).toBe(2);
    expect((result.structuredContent as { notes?: string[] }).notes).toContain(PRIVATE_MATCH_PANEL_NOTE);
    expect(visible).not.toContain(String(meta.jobId));
    expect(visible).not.toMatch(/privateMatch|panelState|"count"/);
    expect(visible).not.toContain(DASHBOARD_CHATGPT_VOCABULARY.privateMatches);
    expect(visible).not.toContain('Lease renewal');
    expect(JSON.stringify(result)).not.toMatch(SENTINEL_PATTERN);

    // The panel collects it (as through the relay) with an ECDH key of its own.
    const panel = await generatePanelKeyPair();
    const collectHandler = createPrivateAnswerHandler({ jobs, isRelayed: () => true });
    const collect = () => collectHandler(new Request(`http://127.0.0.1/private/${meta.jobId}`, {
      method: 'POST',
      headers: { origin: PANEL_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, publicKey: panel.publicKey }),
    }));
    expect((await collect()).status).toBe(202);
    let response = await collect();
    for (let i = 0; i < 50 && response.status === 202; i += 1) {
      await Bun.sleep(20);
      response = await collect();
    }
    expect(response.status).toBe(200);
    const wire = await response.text();
    expect(wire).not.toMatch(SENTINEL_PATTERN);
    const sealed = JSON.parse(wire) as SealedPrivateAnswer & { status: string };
    expect(sealed.status).toBe('ready');
    const plaintext = await openPrivateAnswer(String(meta.jobId), panel.privateKey, sealed);
    // Padded to the first bucket; JSON reads the same value.
    expect(new TextEncoder().encode(plaintext).byteLength).toBe(PRIVATE_ANSWER_PAD_BUCKETS[0]);
    const opened = JSON.parse(plaintext) as { v: number; answer: string; citations: unknown[]; unanswered?: unknown };
    expect(opened.v).toBe(1);
    // The panel lists sources by title, so the Analyst's evidence numbers are taken out.
    expect(opened.answer).toStartWith('The lease ends on 31 May 2027.');
    expect(opened.answer).not.toContain('[1]');
    expect(opened.citations).toEqual([{ title: 'Lease renewal', source: 'Gmail', date: '2026-04-01' }]);
    expect(opened.unanswered).toBeUndefined();

    // The built-in model read the Private passage, locally, and the evidence was re-read at claim time.
    expect(stub.requests.length).toBeGreaterThan(0);
    expect(stub.requests.every((request) => request.localOnly === true)).toBe(true);
    expect(stub.requests[0]!.prompt).toContain(PRIVATE_PASSAGE);
    expect(refreshes).toBe(2);
  });

  test('Private candidates carry their passages to the built-in model; the tool result carries only the count', async () => {
    const stub = stubBuiltInModel(JSON.stringify({
      answer: 'The integral approach maps four quadrants [1].',
      citations: [{ evidence: 1, claim: 'It maps four quadrants.' }],
      unanswered: [],
      sufficient: true,
    }));
    const privateModel = createBuiltInPrivateAnswerModel({ model: stub.model, available: () => true, answer: answerPrivately });
    const jobs = new PrivateAnswerJobs({ model: () => privateModel, installId: () => INSTALL });
    const dir = mkdtempSync(join(tmpdir(), 'olympus-private-integration-'));
    const store = openRemoteConnectionStore(join(dir, 'state', 'remote-connections.sqlite'));
    const worker = createEmailSourceWorker({});
    const config = { ...defaultConfig(), sourceIndex: { ...defaultConfig().sourceIndex, enabled: true } };
    const handler = createRemoteMcpHandler({
      connections: () => store,
      makeOperationContext: (caller, signal) => createInProcessOperationContext({ config, sourceIndexReadEnabled: true, workerFetch: worker.fetch, caller, signal }),
      chatgpt: {
        servesRequest: () => true,
        privateAnswers: jobs,
        async privateMatchProbe() {
          return { count: PRIVATE_CANDIDATES.length, evidence: PRIVATE_CANDIDATES };
        },
        async dashboardView() { throw new Error('unused'); },
        async evidenceSearch() {
          return { evidence: [], coverage: { searched_corpora: 1, unreadable_items: 0, partially_read_items: 0, unclassified_items: 0 } };
        },
      },
    });
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: handler });
    cleanups.push(() => {
      server.stop(true);
      store.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const { token } = store.create('ChatGPT');
    const client = new Client({ name: 'private-integration-test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }) as unknown as Parameters<Client['connect']>[0]);
    let result: Record<string, unknown>;
    try {
      result = await client.callTool({ name: 'olympus_search', arguments: { question: 'What do I have about integral theory?' } }) as Record<string, unknown>;
    } finally {
      await client.close();
    }

    // ChatGPT sees the count (widget-only) and nothing of the items: no passage, no title.
    const meta = (result._meta as Record<string, unknown>)[PRIVATE_ANSWER_META_KEY] as Record<string, unknown>;
    expect(meta).toMatchObject({ v: 1, count: 2, state: 'ready' });
    const whole = JSON.stringify(result);
    expect(whole).not.toMatch(SENTINEL_PATTERN);
    expect(whole).not.toContain('Integral approach notes');

    const panel = await generatePanelKeyPair();
    const collectHandler = createPrivateAnswerHandler({ jobs, isRelayed: () => true });
    const collect = () => collectHandler(new Request(`http://127.0.0.1/private/${meta.jobId}`, {
      method: 'POST',
      headers: { origin: PANEL_ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, publicKey: panel.publicKey }),
    }));
    let response = await collect();
    for (let i = 0; i < 50 && response.status === 202; i += 1) {
      await Bun.sleep(20);
      response = await collect();
    }
    expect(response.status).toBe(200);
    const sealed = JSON.parse(await response.text()) as SealedPrivateAnswer & { status: string };
    const opened = JSON.parse(await openPrivateAnswer(String(meta.jobId), panel.privateKey, sealed)) as {
      answer: string; citations: unknown[]; unanswered?: string[];
    };

    // The model read the passages, locally; the unreadable item was left out, not answered from its title.
    const prompt = stub.requests[0]!.prompt;
    expect(prompt).toContain(INTEGRAL_PASSAGE);
    expect(prompt).not.toContain('Scanned receipt.pdf');
    expect(opened.answer).toStartWith('The integral approach maps four quadrants.');
    expect(opened.citations).toEqual([{ title: 'Integral approach notes', source: 'dropbox', date: '2020-02-05T13:56:40Z' }]);
    expect(opened.unanswered).toEqual(['1 matching private item has no readable text on this computer, so it was not read.']);
  });

  test('only unreadable Private items: a plain no-answer, never one built from titles', async () => {
    const stub = stubBuiltInModel('{}');
    const privateModel = createBuiltInPrivateAnswerModel({ model: stub.model, available: () => true, answer: answerPrivately });
    const result = await privateModel.answerPrivately('Any receipts?', [PRIVATE_CANDIDATES[1]!]);
    expect(stub.requests).toHaveLength(0);
    expect(result.citations).toEqual([]);
    expect(result.answer).not.toContain('Scanned receipt.pdf');
  });

  test('an ungrounded built-in answer carries its gaps to the panel', async () => {
    const stub = stubBuiltInModel(JSON.stringify({ answer: 'Nothing here says.', citations: [], unanswered: ['the deposit amount'], sufficient: false }));
    const privateModel = createBuiltInPrivateAnswerModel({ model: stub.model, available: () => true, answer: answerPrivately });
    const result = await privateModel.answerPrivately('How much was the deposit?', PRIVATE_HITS);
    expect(result.citations).toEqual([]);
    expect(result.unanswered?.length).toBeGreaterThan(0);
  });
});

describe('the panel model over the built-in model', () => {
  test('status follows the install; reset stops the model server; no model means no_model', async () => {
    const ready = stubBuiltInModel('{}');
    expect(createBuiltInPrivateAnswerModel({ model: ready.model, available: () => true, answer: answerPrivately }).status()).toEqual({ state: 'ready' });
    const downloading = stubBuiltInModel('{}', 'downloading');
    expect(createBuiltInPrivateAnswerModel({ model: downloading.model, available: () => false, answer: answerPrivately }).status())
      .toEqual({ state: 'model_downloading', percent: 42 });
    const notStarted = stubBuiltInModel('{}', 'not_started');
    expect(createBuiltInPrivateAnswerModel({ model: notStarted.model, available: () => false, answer: answerPrivately }).status()).toEqual({ state: 'no_model' });
    const none = createBuiltInPrivateAnswerModel({ model: undefined, available: () => false, answer: answerPrivately });
    expect(none.status()).toEqual({ state: 'no_model' });
    const model = createBuiltInPrivateAnswerModel({ model: ready.model, available: () => true, answer: answerPrivately });
    await model.reset?.();
    expect(ready.stops()).toBe(1);
  });

  test('Private candidates are read from their passages; an item without text is counted unreadable, never read by title', () => {
    expect(privateEvidence(PRIVATE_CANDIDATES)).toEqual({
      items: [{
        id: 'personal:f-1',
        text: `${INTEGRAL_PASSAGE}\n…\nSENTINEL_INTEGRAL_7f3a: each quadrant is a perspective.`,
        title: 'Integral approach notes',
        source: 'dropbox',
        date: '2020-02-05T13:56:40Z',
      }],
      unreadable: 1,
    });
    // A title-only hit (the metadata search's shape) is unreadable too.
    expect(privateEvidence([{ sourceItem: { providerItemId: 'x' }, provenance: { citation: { title: 'Only a title.pdf' } } }]))
      .toEqual({ items: [], unreadable: 1 });
  });

  test('the panel answer drops the Analyst\'s evidence numbers and keeps everything else', () => {
    expect(withoutEvidenceMarkers('The fee was $25 [1]. It was charged twice [2, 3].')).toBe('The fee was $25. It was charged twice.');
    expect(withoutEvidenceMarkers('Filed in [2020] under [Taxes].')).toBe('Filed in [2020] under [Taxes].');
  });

  test('search hits become evidence items with stable ids; hits without text are skipped', () => {
    const items = privateEvidenceItems([...PRIVATE_HITS, { sourceItem: { providerItemId: 'empty' } }]);
    expect(items).toEqual([{ id: 'personal:m-1', text: PRIVATE_PASSAGE, title: 'Lease renewal', source: 'Gmail', date: '2026-04-01' }]);
  });
});

describe('sealing and the panel page', () => {
  test('plaintext pads to 1/4/16/64 KiB buckets, then multiples of 64 KiB', () => {
    const size = (text: string) => new TextEncoder().encode(padPrivateAnswerPlaintext(text)).byteLength;
    expect(size('{}')).toBe(1024);
    expect(size(JSON.stringify({ a: 'x'.repeat(2000) }))).toBe(4096);
    expect(size(JSON.stringify({ a: 'x'.repeat(10_000) }))).toBe(16_384);
    expect(size(JSON.stringify({ a: 'x'.repeat(40_000) }))).toBe(65_536);
    expect(size(JSON.stringify({ a: 'x'.repeat(70_000) }))).toBe(131_072);
    expect(JSON.parse(padPrivateAnswerPlaintext('{"a":"é"}'))).toEqual({ a: 'é' });
  });

  test('the panel only builds a fetch URL from a routable private job id, and renders nothing without a match', () => {
    const html = privateAnswerPageHtml({ relayOrigin: 'https://relay.test' });
    // The panel's job id pattern is exactly the relay's routable path shape
    // (test/chatgpt-private-answer-ui.test.ts drives the page itself).
    const pattern = CHATGPT_PRIVATE_ANSWER_JOB_ID;
    expect(PRIVATE_ANSWER_PATH_PATTERN.source).toBe(`^\\/private\\/${pattern.source.slice(1)}`);
    expect(html).toContain(JSON.stringify(pattern.source));
    expect(pattern.test(`oly2p.${INSTALL}.${'A'.repeat(43)}`)).toBe(true);
    for (const bad of [`oly2p.${INSTALL}.${'A'.repeat(43)}/../mcp`, `oly2.${INSTALL}.${'A'.repeat(43)}`, '../../mcp', `oly2p.${INSTALL}.x?y=1`]) {
      expect(pattern.test(bad)).toBe(false);
    }
  });
});

describe('claim-time evidence over a real local index', () => {
  test('a Private item re-tiered to Secret is never returned by the all_tiers:false search a job refreshes with', async () => {
    const specs: FixtureSpec[] = [
      { id: 'invoice', name: 'orchard-invoice.txt', text: 'Orchard invoice total and IBAN GB82WEST12345698765432 for the transfer.' },
    ];
    const { dir, cleanup } = tempDir();
    const fixture = openTierFixture(dir, { embed: false });
    cleanups.push(() => {
      fixture.close();
      cleanup();
    });
    await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const corpusIds = new Set(Object.values(CORPORA));
    const worker = createEmailSourceWorker({
      connectorStores: fixture.set.openStores(),
      connectorStoreTierSiblings: (corpusId) => [...corpusIds].filter((sibling) => sibling !== corpusId),
      sourceIndexVisibilityGate: createTierVisibilityGate(() => [{ ledger: fixture.ledger, corpusIds }]),
    });
    const privateSearch = async (): Promise<PrivateEvidenceItem[]> => {
      const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
        method: 'POST',
        body: JSON.stringify({ corpus_id: CORPORA.secure_local, query: 'orchard', all_tiers: false }),
        headers: { 'Content-Type': 'application/json' },
      }));
      expect(response.status).toBe(200);
      return ((await response.json()) as { hits: PrivateEvidenceItem[] }).hits;
    };

    // At search time the invoice's body is Private and found.
    const atSearch = await privateSearch();
    expect(atSearch.map((hit) => (hit.sourceItem as { providerItemId: string }).providerItemId)).toEqual(['invoice']);

    // The owner marks it Secret before the panel claims the job.
    await moveTieredItem({ set: fixture.set, identity: identityOf('invoice'), target: { metadataTier: 'secrets', contentTier: 'secrets' } });

    const seen: unknown[] = [];
    const model = {
      status: () => ({ state: 'ready' as const }),
      async answerPrivately(_question: string, evidence: readonly PrivateEvidenceItem[]) {
        seen.push(...evidence);
        return { answer: 'should not run', citations: [] };
      },
    };
    const jobs = new PrivateAnswerJobs({ model: () => model, installId: () => INSTALL });
    const { jobId } = jobs.begin({ question: 'orchard invoice?', count: atSearch.length, evidence: atSearch, refresh: privateSearch });
    const panel = await generatePanelKeyPair();
    await jobs.claim(jobId!, panel.publicKey);
    await Bun.sleep(80);
    // The claim-time search no longer returns it, so the model reads nothing.
    expect(await privateSearch()).toEqual([]);
    expect(seen).toEqual([]);
    expect(await jobs.claim(jobId!, panel.publicKey)).toEqual({ status: 200, body: { status: 'failed' } });
    expect(atSearch.every(isPrivateEligible)).toBe(true);
  });
});

describe('a Personal name over Private contents', () => {
  test('counted apart from Names only and unreadable; ChatGPT gets the one Private note and no folder advice', async () => {
    const specs: FixtureSpec[] = [{ id: 'crown', name: 'dentist-crown-report.txt', text: 'SENTINEL_CROWN_7f3a: the molar crown was fitted and set.' }];
    const { dir, cleanup } = tempDir();
    const fixture = openTierFixture(dir, { embed: false });
    cleanups.push(() => {
      fixture.close();
      cleanup();
    });
    await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    // Name Personal, contents Private: a split move.
    await moveTieredItem({ set: fixture.set, identity: identityOf('crown'), target: { metadataTier: 'private', contentTier: 'secure' } });
    const personal = fixture.set.openStores().find((store) => store.trustDomain === 'internal')!;
    const provenance = {
      sourceItem: { family: 'file' as const, provider: 'fixture', accountScope: 'personal', providerItemId: 'crown', localItemId: 'personal:crown' },
    };
    // The Personal copy serves the name only, and says why: its contents are Private.
    const block = await createConnectorStoreContentProvider({ store: personal })
      .fetchLocalContent({ provenance, trustDomain: 'internal', query: 'dentist crown report' });
    expect(block).toMatchObject({ chunks: [], contentPrivate: true });
    expect(block?.namesOnly).toBeUndefined();
    const registry = buildSourceIndexCorpusRegistry([defineConnectorCorpus({ corpusId: personal.corpusId, family: 'file', trustDomain: 'internal' })]);
    const detail = await buildEvidencePackDetailed({
      question: 'dentist crown report',
      selectedItems: [{ corpusId: personal.corpusId, sourceItem: provenance.sourceItem }],
      maxResults: 5,
      searchContext: { allowedTrustDomains: ['internal'] },
      registry,
      adapters: {},
      contentProviders: { [personal.corpusId]: createConnectorStoreContentProvider({ store: personal }) },
    });
    expect(detail).toMatchObject({ contentPrivateCandidateIndexes: [0], namesOnlyCandidateIndexes: [], unreadCandidates: 0 });

    // olympus_search over such a match: the one Private note, no folder advice.
    const result = searchToolResult({
      evidence: [{ trust_domain: 'internal', family: 'file', provider: 'google_drive', title: 'Flat inventory', excerpt: 'Two chairs.' }],
      coverage: { searched_corpora: 1, unreadable_items: 0, names_only_items: 0, content_private_items: 1 },
    });
    const visible = JSON.stringify({ content: result.content, structuredContent: result.structuredContent });
    expect((result.structuredContent as { notes: string[] }).notes).toEqual([PRIVATE_MATCH_NOTE]);
    expect(visible).not.toMatch(/Names only|Switch|folder picker|could not read/);
    expect(visible).not.toMatch(SENTINEL_PATTERN);
  });
});

describe('private evidence over a real local index', () => {
  test('each matched Private item carries its own passages, read locally; re-tiered to Secret, it is gone', async () => {
    const passage = 'Orchard invoice total and IBAN GB82WEST12345698765432 for the transfer of the orchard lease.';
    const specs: FixtureSpec[] = [{ id: 'invoice', name: 'orchard-invoice.txt', text: passage }];
    const { dir, cleanup } = tempDir();
    const fixture = openTierFixture(dir, { embed: false });
    cleanups.push(() => {
      fixture.close();
      cleanup();
    });
    await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const lanes = () => {
      const stores = fixture.set.openStores();
      return {
        registry: buildSourceIndexCorpusRegistry(stores.map((store) => defineConnectorCorpus({
          corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain,
        }))),
        adapters: Object.fromEntries(stores.map((store) => [store.corpusId, createConnectorStoreCorpusAdapter({ store })])),
        contentProviders: Object.fromEntries(stores.map((store) => [store.corpusId, createConnectorStoreContentProvider({ store })])),
        visibilityGate: createTierVisibilityGate(() => [{ ledger: fixture.ledger, corpusIds: new Set(stores.map((store) => store.corpusId)) }]),
      };
    };

    const found = await searchPrivateEvidence({ lanes, question: 'orchard invoice' });
    expect(found.matched).toBe(1);
    expect(found.candidates.every((candidate) => candidate.trustDomain === 'secure_local')).toBe(true);
    expect(found.candidates[0]!.chunks.join(' ')).toContain('GB82WEST12345698765432');
    // The private model reads that text (not the title).
    expect(privateEvidenceItems(found.candidates as unknown as PrivateEvidenceItem[])[0]!.text).toContain('orchard lease');

    await moveTieredItem({ set: fixture.set, identity: identityOf('invoice'), target: { metadataTier: 'secrets', contentTier: 'secrets' } });
    expect(await searchPrivateEvidence({ lanes, question: 'orchard invoice' })).toEqual({ matched: 0, candidates: [] });
  });
});

describe('dashboard: the built-in private model as the answer model', () => {
  const view = { sources: [], model_setup: undefined } as unknown as SourceDashboardViewModel;

  test('shown as Built-in; ready once installed; a download alone never makes the page installing', () => {
    const downloading = buildChatGptDashboardViewModel(view, {
      embedding: { kind: 'built_in', state: 'ready' },
      privateModel: { state: 'downloading', percent: 30 },
    });
    expect(downloading.models.answers).toEqual({ kind: 'built_in', label: 'Built-in', ready: false, install: { state: 'downloading', percent: 30 } });
    expect(downloading.connection).toEqual({ state: 'ready' });
    expect(downloading.needsYou.some((item) => item.id === 'model:answers')).toBe(false);

    const ready = buildChatGptDashboardViewModel(view, {
      embedding: { kind: 'built_in', state: 'ready' },
      privateModel: { state: 'ready', percent: 100 },
    });
    expect(ready.models.answers).toEqual({ kind: 'built_in', label: 'Built-in', ready: true });

    const failed = buildChatGptDashboardViewModel(view, { privateModel: { state: 'failed', percent: 0, failedReason: 'disk_full' } });
    expect(failed.models.answers?.install).toEqual({ state: 'failed', failedReason: 'disk_full' });
    // A failed built-in install is started again from the page.
    expect(failed.needsYou.find((item) => item.id === 'model:answers')?.fix)
      .toEqual({ label: 'Try again', tool: 'olympus_model_retry', args: { model: 'answers' } });
  });

  test('verifying reports bytes checked; a failed built-in embedding gets the retry fix; fields survive the copy', () => {
    const verifying = buildChatGptDashboardViewModel(view, {
      embedding: { kind: 'built_in', state: 'verifying', percent: 40, bytesDone: 400, bytesTotal: 1_000 },
      privateModel: { state: 'verifying', percent: 61, bytesDone: 1_671_000_000, bytesTotal: 2_740_937_888 },
    });
    expect(verifying.models.answers?.install).toEqual({ state: 'verifying', percent: 61, bytesDone: 1_671_000_000, bytesTotal: 2_740_937_888 });
    // Checking the search model is still installing: indexing waits for it.
    expect(verifying.connection).toMatchObject({ state: 'installing' });
    const copied = copyDashboardViewModel(verifying);
    expect(copied.models.embedding).toEqual({ kind: 'built_in', state: 'verifying', percent: 40, bytesDone: 400, bytesTotal: 1_000 });
    expect(copied.models.answers?.install).toEqual({ state: 'verifying', percent: 61, bytesDone: 1_671_000_000, bytesTotal: 2_740_937_888 });

    const failed = buildChatGptDashboardViewModel(view, {
      embedding: { kind: 'built_in', state: 'failed', failedReason: 'network' },
      privateModel: { state: 'ready', percent: 100 },
    });
    expect(failed.needsYou.find((item) => item.id === 'model:embedding')?.fix)
      .toEqual({ label: 'Try again', tool: 'olympus_model_retry', args: { model: 'embedding' } });
    const copiedFailed = copyDashboardViewModel(failed);
    expect(copiedFailed.models.embedding).toEqual({ kind: 'built_in', state: 'failed', failedReason: 'network' });
    expect(copiedFailed.needsYou.find((item) => item.id === 'model:embedding')?.fix?.tool).toBe('olympus_model_retry');
    expect(copiedFailed.models.answers).toEqual({ kind: 'built_in', label: 'Built-in', ready: true });
    // Only fixed failure codes cross the copy.
    const odd = copyDashboardViewModel({ ...failed, models: { ...failed.models, embedding: { kind: 'built_in', state: 'failed', failedReason: '/Users/me/disk' as never } } });
    expect(odd.models.embedding.failedReason).toBe('unknown');
  });

  test('while the embedding model also downloads, the installing bar waits for both', () => {
    const both = buildChatGptDashboardViewModel(view, {
      embedding: { kind: 'built_in', state: 'downloading', percent: 80 },
      privateModel: { state: 'downloading', percent: 25 },
    });
    expect(both.connection).toMatchObject({ state: 'installing', progress: { percent: 25 } });
    const embeddingOnly = buildChatGptDashboardViewModel(view, {
      embedding: { kind: 'built_in', state: 'downloading', percent: 80 },
      privateModel: { state: 'ready', percent: 100 },
    });
    expect(embeddingOnly.connection).toMatchObject({ state: 'installing', progress: { percent: 80 } });
  });
});
