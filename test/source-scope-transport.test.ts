import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { withWorkerBearerAuth } from '../src/workers/http.ts';
import { dashboardQueryTokenFromWorkerAuthToken } from '../src/core/worker-auth.ts';
import { defaultConfig } from '../src/core/config.ts';
import { registerOlympusDashboardGateway, type DashboardFetch } from '../src/core/control-ui-gateway.ts';
import { OLYMPUS_DASHBOARD_READ_METHOD, OLYMPUS_DASHBOARD_CONTROL_METHOD, type OlympusFolderScopeBrowseResult } from '../src/control-ui-contract.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).reverse().forEach((close) => close()); });
const SOURCE = 'google_drive.docs' as const;
const generation = 'a'.repeat(64);
const revision = '11111111-1111-4111-8111-111111111111';
const selection = { key: 'opaque-folder', state: 'metadata_only' as const, ancestor_keys: [] };
const approval = { action: 'approve_source_scope_and_start', source_id: SOURCE, account_generation: generation, expected_scope_revision: revision, selections: [selection], whole_account: false, explicit_whole_account_confirmation: false };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'scope-transport-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const rules = join(dir, 'rules.json'); writeFileSync(rules, JSON.stringify({ schemaVersion: 1, rules: [] }));
  const calls: { browses: unknown[]; approvals: unknown[] } = { browses: [], approvals: [] };
  const browser: OlympusFolderScopeBrowseResult = {
    source_id: SOURCE, account_generation: generation, scope_revision: revision, status: 'scope_pending',
    nodes: [{ key: 'opaque-folder', name: 'Private folder', kind: 'folder', has_children: false, selectable: true }],
    selections: [], whole_account_selected: false,
  };
  const worker = createEmailSourceWorker({
    sourceIndexStatus: { async status() { return { kind: 'source_index_status', generated_at: new Date().toISOString(), corpora: [], policy: { read_only: true, raw_source_exposed: false, source_packets_exposed: false, source_text_returned: false, secure_local_item_metadata_exposed: false, castor_visible: true } } as never; } },
    sourceDashboard: {
      sovereigntyEngine: { config: { routes: {} } } as never, registryPath: join(dir, 'handles.json'), registryAdoptionIntervalMs: 0,
      ingestionDispositions: () => ({ rulesPath: rules, sources: [] }),
      fileSourceScopes: {
        summaries: () => [{ source_id: SOURCE, disposition_source_id: 'google_drive.personal', label: 'Google Drive', connected: true, status: 'scope_pending', account_generation: generation, scope_revision: revision }, { source_id: 'dropbox.files', disposition_source_id: 'dropbox.personal', label: 'Dropbox', connected: true, status: 'scope_pending', account_generation: generation, scope_revision: revision }],
        async browse(input) { calls.browses.push(input); return browser; },
        async approveAndStart(input) { calls.approvals.push(input); return { ok: true, result: { approved: true } }; },
      },
    },
  });
  cleanups.push(() => worker.close());
  return { calls, fetch: withWorkerBearerAuth(worker.fetch, { authToken: 'fixture-worker-secret' }) };
}

async function session(fetch: ReturnType<typeof fixture>['fetch']) {
  const response = await fetch(new Request('http://worker.test/dashboard/control/session', { method: 'POST', headers: { Authorization: 'Bearer fixture-worker-secret', Origin: 'http://worker.test' } }));
  expect(response.status).toBe(200);
  const body = await response.json() as { csrf_token: string };
  return { Cookie: response.headers.get('set-cookie')!.split(';')[0]!, Origin: 'http://worker.test', 'X-Olympus-CSRF': body.csrf_token, 'Content-Type': 'application/json' };
}

test('standalone picker needs control-session CSRF; rendering and browsing do not approve ingestion', async () => {
  const f = fixture(); const headers = await session(f.fetch);
  const rendered = await f.fetch(new Request('http://worker.test/dashboard/dispositions?source_id=google_drive.docs', { headers }));
  expect(rendered.status).toBe(200);
  const html = await rendered.text();
  expect(html).toContain('data-folder-scope-source="google_drive.docs"');
  expect(html).not.toContain('fixture-worker-secret'); expect(html).not.toContain('Private folder');
  expect(f.calls).toEqual({ browses: [], approvals: [] });
  const browse = { action: 'browse_folder_scope', source_id: SOURCE, parent_key: 'private-parent' };
  for (const body of [browse, approval]) {
    const response = await f.fetch(new Request('http://worker.test/dashboard/dispositions', { method: 'POST', headers: { Cookie: headers.Cookie, Origin: headers.Origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    expect(response.status).toBe(403);
  }
  expect(f.calls).toEqual({ browses: [], approvals: [] });
  const response = await f.fetch(new Request('http://worker.test/dashboard/dispositions', { method: 'POST', headers, body: JSON.stringify(browse) }));
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ scope_browser: { nodes: [{ name: 'Private folder' }] } });
  expect(f.calls.browses).toEqual([{ sourceId: SOURCE, parentKey: 'private-parent' }]); expect(f.calls.approvals).toHaveLength(0);
  const started = await f.fetch(new Request('http://worker.test/dashboard/dispositions', { method: 'POST', headers, body: JSON.stringify(approval) }));
  expect(started.status).toBe(200); expect(f.calls.approvals).toEqual([{ sourceId: SOURCE, accountGeneration: generation, expectedRevision: revision, selections: [{ key: selection.key, state: selection.state }], wholeAccount: false, explicitWholeAccountConfirmation: false }]);
});

test('read-only dashboard URL token cannot browse or activate private scope', async () => {
  const f = fixture(); const token = dashboardQueryTokenFromWorkerAuthToken('fixture-worker-secret');
  for (const action of [{ action: 'browse_folder_scope', source_id: SOURCE }, approval]) {
    const response = await f.fetch(new Request(`http://worker.test/dashboard/dispositions?token=${token}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(action) }));
    expect(response.status).toBe(401);
  }
  expect(f.calls).toEqual({ browses: [], approvals: [] });
});

test('native RPC reaches the same worker hooks without exposing auth or folder paths in URLs', async () => {
  const f = fixture(); const config = defaultConfig(); config.worker.authToken = 'fixture-worker-secret'; config.email.baseUrl = 'http://worker.test/v1';
  type Handler = (input: { params: Record<string, unknown>; client: { connect: { scopes: string[] } }; respond: (...args: unknown[]) => void }) => Promise<void> | void;
  const methods = new Map<string, Handler>(); const urls: string[] = [];
  const fetchImpl: DashboardFetch = async (url, init) => { urls.push(String(url)); return f.fetch(new Request(String(url), init)); };
  registerOlympusDashboardGateway({ registerGatewayMethod(method, handler) { methods.set(method, handler as Handler); }, registerHttpRoute() {} }, config, { fetchImpl });
  const responses: unknown[][] = [];
  const invoke = async (method: string, params: Record<string, unknown>, scopes = ['operator.write']) => {
    await methods.get(method)!({ params, client: { connect: { scopes } }, respond: (...args) => responses.push(args) });
  };
  await invoke(OLYMPUS_DASHBOARD_READ_METHOD, { view: 'dispositions', source_id: 'dropbox.files' });
  expect(responses.at(-1)?.[0]).toBe(true);
  const picker = responses.at(-1)?.[1] as { body: string };
  expect(picker.body).toContain('data-scope-panel="dropbox.files">');
  expect(picker.body).toContain('data-scope-panel="google_drive.docs" hidden>');
  await invoke(OLYMPUS_DASHBOARD_READ_METHOD, { view: 'dispositions', source_id: SOURCE });
  expect(responses.at(-1)?.[0]).toBe(true); expect(f.calls.browses).toHaveLength(0);
  await invoke(OLYMPUS_DASHBOARD_READ_METHOD, { view: 'dispositions', action: 'browse_folder_scope', source_id: SOURCE, parent_key: 'private-parent' }, ['operator.read']);
  expect(responses.at(-1)?.[0]).toBe(false); expect(f.calls.browses).toHaveLength(0);
  await invoke(OLYMPUS_DASHBOARD_READ_METHOD, { view: 'dispositions', action: 'browse_folder_scope', source_id: SOURCE, parent_key: 'private-parent' });
  expect(responses.at(-1)?.[0]).toBe(true); expect(responses.at(-1)?.[1]).toMatchObject({ scope_browser: { source_id: SOURCE } });
  expect(f.calls.approvals).toHaveLength(0);
  await invoke(OLYMPUS_DASHBOARD_CONTROL_METHOD, approval, ['operator.read']);
  expect(responses.at(-1)?.[0]).toBe(false); expect(f.calls.approvals).toHaveLength(0);
  await invoke(OLYMPUS_DASHBOARD_CONTROL_METHOD, approval);
  expect(responses.at(-1)?.[0]).toBe(true); expect(f.calls.approvals).toHaveLength(1);
  expect(urls.every((url) => !url.includes('private-parent'))).toBe(true);
  expect(JSON.stringify(responses)).not.toContain('fixture-worker-secret');
});

test.each([false, true])('metadata-only worker searches stay isolated with mixed full ingestion=%s', async (mixed) => {
  const { LocalConnectorStore } = await import('../src/workers/connector-store/index.ts');
  const { fileSourceScopeMetadataFilters, fileSourceScopeContentFilters } = await import('../src/workers/source-scope-runtime.ts');
  const store = new LocalConnectorStore({ dbPath: ':memory:', corpusId: 'secure_local.dropbox.files', family: 'file', trustDomain: 'secure_local' });
  cleanups.push(() => store.close());
  const raw = {
    identity: { family: 'file' as const, provider: 'dropbox', accountScope: 'personal', providerItemId: 'fixture-file', providerFileId: 'fixture-file', localItemId: 'personal:fixture-file', sourceVersion: 'rev1' },
    mimeType: 'text/plain', content: { kind: 'text' as const, text: 'cachedsensitivebody sharedbody confidential contents' },
    metadata: Object.freeze({ name: 'Publicfilename.txt', pathDisplay: '/work/Publicfilename.txt' }),
    fetchedAt: '2026-09-10T10:00:00.000Z',
  };
  const full = { ...raw, identity: { ...raw.identity, providerItemId: 'full-file', providerFileId: 'full-file', localItemId: 'personal:full-file' }, content: { kind: 'text' as const, text: 'allowedcontentbody sharedbody' }, metadata: Object.freeze({ name: 'Fullfilename.txt', pathDisplay: '/full/Fullfilename.txt' }) };
  await store.syncFromConnector({
    id: 'scope-transport-fixture', family: 'file', async authenticate() {},
    async *listItems() { yield { items: mixed ? [raw, full] : [raw], done: true }; }, async fetchItem(id) { return id === full.identity.localItemId ? full : raw; },
    classify() { return { trustTier: 'S4', trustDomain: 'secure_local', cloudEmbeddingEligible: false, localOnly: true }; },
  }, { fetchContent: true, sourceScopeObservation: () => ({ accountGeneration: generation, scopeRevision: revision }) });
  const selected = { sourceId: 'dropbox.files' as const, status: 'approved' as const, accountGeneration: generation, revision, selections: [{ key: '/work', state: 'metadata_only' as const }, ...(mixed ? [{ key: '/full', state: 'ingest' as const }] : [])], wholeAccount: false };
  const metadataScope = fileSourceScopeMetadataFilters(selected);
  const contentScope = fileSourceScopeContentFilters(selected);
  if (!metadataScope.allowed) throw new Error('fixture scope must allow metadata');
  const worker = createEmailSourceWorker({ connectorStores: [store], connectorStoreReadScope: () => ({ allowed: true, accountScope: 'personal', filters: metadataScope.filters, contentAllowed: contentScope.allowed, ...(contentScope.allowed ? { contentFilters: contentScope.filters } : {}) }) });
  cleanups.push(() => worker.close());
  const query = async (text: string) => {
    const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ corpus_id: store.corpusId, query: text }) }));
    expect(response.status).toBe(200); return await response.json() as { hits: unknown[] };
  };
  const filename = await query('Publicfilename');
  expect(filename.hits).toHaveLength(1);
  expect(JSON.stringify(filename)).not.toContain('cachedsensitivebody');
  expect((await query('cachedsensitivebody')).hits).toHaveLength(0);
  expect((await query('sharedbody')).hits).toHaveLength(mixed ? 1 : 0);
  if (mixed) expect((await query('allowedcontentbody')).hits).toMatchObject([{ sourceItem: { providerItemId: 'full-file' } }]);
});
