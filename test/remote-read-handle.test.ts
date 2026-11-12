import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { openRemoteConnectionStore } from '../src/core/remote-connections.ts';
import { RemoteReadHandleStore } from '../src/core/remote-read-handles.ts';
import { remoteOperationOutput } from '../src/core/remote-result.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { handleMcpCallTool } from '../src/mcp/server.ts';
import { listMcpTools } from '../src/mcp/tools.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { createReleaseTierCheck } from '../src/workers/connector-store/tier-visibility.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { buildRemoteOpenApiSpec, createRemoteOpenApiHandler } from '../src/workers/remote-openapi.ts';
import { createRemoteMcpHandler } from '../src/workers/remote-mcp.ts';
import { searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { recordReleaseManifest, releasedTextDigest } from '../src/core/release-manifest.ts';
import { createTestClock } from './helpers/test-clock.ts';
import { fixtureConnector, fixtureItem, JUDGED_PERSONAL_SNIFFER, tempDir } from './helpers/tier-fixtures.ts';
import { provedReleaseCheck } from './helpers/scripted-search-release.ts';

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()));
const selected = { corpus_id: 'internal.fixture.files', family: 'file', provider: 'fixture', account_scope: 'personal', provider_item_id: 'note', local_item_id: 'personal:note' };
const personal = { ...selected, trust_domain: 'internal', title: 'Orchard note', excerpt: 'Personal orchard.' };
const raw = () => ({ evidence: [
  { ...personal, trust_domain: 'secure_local', provider_item_id: 'private-note' },
  personal,
  { ...personal, trust_domain: 'public_safe', provider_item_id: 'public-note' },
  { ...personal, local_item_id: undefined, provider_item_id: 'unresolved-note' },
  { ...personal, trust_domain: undefined, provider_item_id: 'unclassified-note' },
], coverage: {} });

async function fixture() {
  const tmp = tempDir('remote-read-handle-'); cleanup.push(tmp.cleanup);
  const ledger = new TierLedger({ dbPath: `${tmp.dir}/ledger.sqlite` }); cleanup.push(() => ledger.close());
  const store = new LocalConnectorStore({ dbPath: `${tmp.dir}/store.sqlite`, corpusId: selected.corpus_id, family: 'file', trustDomain: 'internal', tierLedger: ledger }); cleanup.push(() => store.close());
  await store.syncFromConnector(fixtureConnector(() => [{ id: 'note', name: 'Orchard note', text: 'Personal orchard.' }]), { fetchContent: true, tierClassification: { sniffer: JUDGED_PERSONAL_SNIFFER } });
  const ledgerDb = new Database(ledger.dbPath); cleanup.push(() => ledgerDb.close());
  let onCheck = () => {};
  const check = { ...provedReleaseCheck, chunks: async (...args: Parameters<NonNullable<typeof provedReleaseCheck.chunks>>) => { onCheck(); return provedReleaseCheck.chunks!(...args); } };
  const worker = createEmailSourceWorker({ connectorStores: [store], sourceAnswerReleaseCheck: check });
  const config = defaultConfig(); config.sourceIndex.enabled = true; config.email.enabled = true; config.email.baseUrl = 'http://worker.test/v1';
  const email = new EmailClient(config, new DirectHttpEmailTransport(async (url, init) => worker.fetch(new Request(url, init))));
  const ctx = { config, email, delphi: {}, releaseCheck: check } as OperationContext;
  const connections = openRemoteConnectionStore(`${tmp.dir}/connections.sqlite`); cleanup.push(() => connections.close());
  const first = connections.create('First app'); const second = connections.create('Second app');
  const clock = createTestClock();
  const handler = createRemoteMcpHandler({ connections: () => connections, readHandleNow: clock.now, log: () => {},
    makeOperationContext: () => ctx,
    search: { evidenceSearch: async () => {
      const result = raw();
      recordReleaseManifest({ inputs: result.evidence.filter(item => item.trust_domain === 'internal' || item.trust_domain === 'public_safe').map(item => ({
        corpusId: item.corpus_id, provider: item.provider, accountScope: item.account_scope,
        providerItemId: item.provider_item_id, privateAtAnswer: false, chunkHashes: ['proved-chunk'], releasedTextDigest: releasedTextDigest(item.excerpt),
      })), constraints: { secureDerivativeDefault: 'allow', includeSecureLocalContent: false } });
      return result;
    } },
  });
  const rpc = async (method: string, params: unknown, token = first.token) => {
    const response = await handler(new Request('http://worker.test/mcp', { method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
    return await response.json() as any;
  };
  const call = async (name: string, args: Record<string, unknown>, token = first.token) => (await rpc('tools/call', { name, arguments: args }, token)).result;
  const search = () => call('olympus_search', { question: 'orchard' });
  const read = (handle: string, token = first.token) => call('source_item_read', { read_handle: handle }, token);
  return { ledger, ledgerDb, store, ctx, clock, connections, first, second, rpc, call, search, read, onCheck: (fn: () => void) => { onCheck = fn; } };
}

function body(result: any) { return JSON.parse(result.content[0].text); }
function opaque(handle: unknown) {
  expect(handle).toMatch(/^rh_[A-Za-z0-9_-]{22,}$/);
  for (const id of [selected.corpus_id, selected.provider, selected.local_item_id]) expect(handle).not.toContain(id);
}

test('remote search issues opaque handles only for kept Personal evidence with a local identity', async () => {
  const f = await fixture(); const result = await f.search();
  const evidence = result.structuredContent.evidence;
  expect(evidence.map((e: any) => e.id)).toEqual(['E1', 'E2', 'E3']);
  opaque(evidence[0].read_handle); opaque(evidence[1].read_handle);
  expect(evidence[0].read_handle).not.toBe(evidence[1].read_handle);
  expect(evidence[2].read_handle).toBeUndefined();
  for (const key of Object.keys(selected)) expect(JSON.stringify(result)).not.toContain(`"${key}"`);
  expect(JSON.stringify(result)).not.toContain(selected.local_item_id);
  expect(body(await f.read(evidence[0].read_handle))).toMatchObject({ pages: [{ page: 1, text: 'Personal orchard.' }], couldNotRead: [] });
});

test('unknown, wrong-connection and expired handles have exactly the same content-free refusal', async () => {
  const f = await fixture(); const handle = (await f.search()).structuredContent.evidence[0].read_handle;
  const unknown = await f.read(`rh_${'0'.repeat(32)}`);
  expect(unknown.isError).toBe(true);
  expect(await f.read(handle, f.second.token)).toEqual(unknown);
  await f.clock.advance(30 * 60 * 1000 - 1);
  expect(body(await f.read(handle)).pages).toHaveLength(1);
  await f.clock.advance(1);
  expect(await f.read(handle)).toEqual(unknown);
  expect(JSON.stringify(unknown)).not.toContain('orchard');
});

test('a handle does not cache privacy: an item re-judged Private after search is refused', async () => {
  const f = await fixture(); const handle = (await f.search()).structuredContent.evidence[0].read_handle;
  f.ledgerDb.exec("UPDATE tier_items SET content_tier = 'secure'");
  const result = await f.read(handle);
  expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('not_personal');
  expect(JSON.stringify(result)).not.toContain('orchard');
});

test('remote read declares only read_handle, page and pages and rejects selected_item even with a valid handle', async () => {
  const f = await fixture(); const handle = (await f.search()).structuredContent.evidence[0].read_handle;
  const tool = (await f.rpc('tools/list', {})).result.tools.find((t: any) => t.name === 'source_item_read');
  expect(tool.description).not.toContain('selected_item');
  expect(tool.inputSchema.required).toEqual(['read_handle']);
  expect(Object.keys(tool.inputSchema.properties).sort()).toEqual(['page', 'pages', 'read_handle']);
  expect(tool.inputSchema.additionalProperties).toBe(false);
  for (const args of [{ selected_item: selected }, { selected_item: selected, read_handle: handle }, {}, { read_handle: 7 }]) {
    const result = await f.call('source_item_read', args);
    expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain('orchard');
  }
  expect(listMcpTools(f.ctx.config).find(t => t.name === 'source_item_read')!.inputSchema.properties).toHaveProperty('selected_item');
});

test('MCP connection revoked during a chunk release receives only the fixed refusal', async () => {
  const f = await fixture(); const handle = (await f.search()).structuredContent.evidence[0].read_handle;
  f.onCheck(() => { queueMicrotask(() => f.connections.revoke(f.first.connection.id)); });
  const result = await f.read(handle);
  expect(result.isError).toBe(true); expect(JSON.stringify(result)).toContain('invalid_token');
  expect(JSON.stringify(result)).not.toContain('orchard');
});

test('remote pages are withheld if the owner overrides the item during release await', async () => {
  const f = await fixture();
  const check = createReleaseTierCheck(() => [{ ledger: f.ledger, corpusIds: new Set([f.store.corpusId]) }], () => 'allow');
  let checked = false;
  f.ctx.releaseCheck = { inputs(inputs) {
    const result = check.inputs(inputs);
    if (!checked) { checked = true; queueMicrotask(() => f.ledger.setOverride(fixtureItem({ id: 'note', name: 'Orchard note' }).identity, { kind: 'tier', tier: 'secure' })); }
    return result;
  }, secureDerivativeDefault: () => 'allow' };
  const handles = new RemoteReadHandleStore().forConnection('test-connection');
  const read_handle = handles.issueReadHandle(personal)!;
  const result = await handleMcpCallTool({ params: { name: 'source_item_read', arguments: { read_handle } } }, () => f.ctx, 'remote', undefined, handles);
  expect(checked).toBe(true); expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain('orchard');
});

test('source answer and collected answer citations issue handles only on the remote MCP path for Personal identities', async () => {
  const handles = new RemoteReadHandleStore().forConnection('answer-connection');
  const answer = { answer: 'Released answer.', evidence: raw().evidence };
  for (const operation of ['source_answer', 'source_answer_result']) {
    const output = remoteOperationOutput(operation, answer, { issueReadHandle: handles.issueReadHandle });
    const citations = output.citations as any[];
    expect(citations).toHaveLength(5);
    expect(citations[0].read_handle).toBeUndefined(); opaque(citations[1].read_handle); opaque(citations[2].read_handle);
    expect(citations[3].read_handle).toBeUndefined(); expect(citations[4].read_handle).toBeUndefined();
    expect(handles.resolveReadHandle(citations[1].read_handle)).toEqual(selected);
    expect(JSON.stringify(remoteOperationOutput(operation, answer))).not.toContain('read_handle');
    expect(JSON.stringify(output)).not.toContain('local_item_id');
  }
  // Default shared builder remains byte-identical, including when raw evidence gains internal identity.
  const withoutLocalId = { ...raw(), evidence: raw().evidence.map(({ local_item_id, ...item }) => item) };
  expect(JSON.stringify(searchToolResult(raw()))).toBe(JSON.stringify(searchToolResult(withoutLocalId)));
});

test('the remote source_answer operation issues a usable handle through the authenticated MCP handler', async () => {
  const f = await fixture();
  f.ctx.email.sourceAnswer = async () => {
    recordReleaseManifest({ inputs: [{ corpusId: selected.corpus_id, provider: selected.provider,
      accountScope: selected.account_scope, providerItemId: selected.provider_item_id,
      privateAtAnswer: false, chunkHashes: ['proved-chunk'],
    }], constraints: { secureDerivativeDefault: 'allow', includeSecureLocalContent: false } });
    return { answer: 'Released answer.', evidence: [personal] } as never;
  };
  const result = await f.call('source_answer', { question: 'orchard' });
  expect(result.isError).not.toBe(true);
  const handle = body(result).citations[0].read_handle;
  opaque(handle);
  expect(body(await f.read(handle)).pages).toEqual([{ page: 1, text: 'Personal orchard.' }]);
});

test('the in-memory handle map evicts oldest entries and refuses incomplete or non-Personal identities', () => {
  const store = new RemoteReadHandleStore({ maxEntries: 2, now: createTestClock().now });
  const scope = store.forConnection('app');
  const oldest = scope.issueReadHandle(personal)!; const next = scope.issueReadHandle(personal)!;
  const newest = scope.issueReadHandle(personal)!;
  expect(scope.resolveReadHandle(oldest)).toBeUndefined(); expect(scope.resolveReadHandle(next)).toEqual(selected); expect(scope.resolveReadHandle(newest)).toEqual(selected);
  for (const item of [{ ...personal, trust_domain: 'secure_local' }, { ...personal, trust_domain: undefined }, { ...personal, local_item_id: undefined }, { ...personal, account_scope: undefined }]) expect(scope.issueReadHandle(item)).toBeUndefined();
  expect(new RemoteReadHandleStore().forConnection('app').resolveReadHandle(newest)).toBeUndefined();
});

test('handle resolution preserves account and conversation identity and returns independent copies', () => {
  const scope = new RemoteReadHandleStore().forConnection('app');
  const item = { ...personal, account_scope: 'another-account', provider_conversation_id: 'conversation' };
  const handle = scope.issueReadHandle(item)!;
  const identity = scope.resolveReadHandle(handle)!;
  expect(identity).toEqual({ ...selected, account_scope: 'another-account', provider_conversation_id: 'conversation' });
  identity.local_item_id = 'modified';
  expect(scope.resolveReadHandle(handle)!.local_item_id).toBe(selected.local_item_id);
});

test('OpenAPI neither advertises nor accepts the MCP-only handle read', async () => {
  expect(buildRemoteOpenApiSpec().paths).not.toHaveProperty('/api/v1/tools/source_item_read');
  const f = await fixture();
  const handler = createRemoteOpenApiHandler({ connections: () => f.connections, makeOperationContext: () => f.ctx });
  const handle = (await f.search()).structuredContent.evidence[0].read_handle;
  const result = await handler(new Request('http://worker.test/api/v1/tools/source_item_read', {
    method: 'POST', headers: { authorization: `Bearer ${f.first.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ read_handle: handle }),
  }));
  expect(result.status).toBe(404);
  expect(await result.text()).not.toContain('orchard');
});
