// The one-item privacy change's surfaces (issue #1060): the agent operations
// privacy_item_find and privacy_item_set, the worker's agent routes behind the
// bearer, and the dashboard's local routes. An agent can only raise an item to
// Private: the operation refuses anything else before sending, and the agent
// routes have no way to lower. Lowering, and putting an item back to the
// judge, take this computer's own (local-grade) dashboard session.

import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { describe, expect, spyOn, test } from 'bun:test';
import { defaultConfig } from '../src/core/config.ts';
import { DirectHttpEmailTransport, EmailClient } from '../src/core/email.ts';
import { exposedOperations, type OperationSurface } from '../src/core/operation-exposure.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { V0_4_PUBLIC_DASHBOARD_ROUTES, V0_4_PUBLIC_REMOTE_MCP_TOOLS } from '../src/core/public-surface.ts';
import { FIXTURE_PLACEMENT, JUDGED_PERSONAL_SNIFFER, fixtureConnector, identityOf, tempDir } from './helpers/tier-fixtures.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { ownerLocalMint, postAsLocalOwner } from './helpers/owner-local-mint.ts';
import { buildEnvBridgeSovereigntyConfig, createSovereigntyEngine } from '../src/core/sovereignty.ts';
import { createOwnerTierItems, ownerTierItemId, type OwnerTierItem, type OwnerTierItems, type OwnerTierItemFindInput, type OwnerTierItemSetInput } from '../src/workers/classification/tier-owner-items.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import {
  DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER,
  DASHBOARD_PRIVACY_ITEM_PATHS,
  withWorkerBearerAuth,
} from '../src/workers/http.ts';

const TOKEN = 'privacy-item-worker-secret';
const ORIGIN = 'http://127.0.0.1:28193';
const ITEM_ID = 'oti_WyJnbWFpbCIsImEiLCIiLCJtMSJd';
const find = operations.find((operation) => operation.name === 'privacy_item_find')!;
const set = operations.find((operation) => operation.name === 'privacy_item_set')!;

function fixture() {
  const finds: OwnerTierItemFindInput[] = [];
  const sets: OwnerTierItemSetInput[] = [];
  const engine: OwnerTierItems = {
    find(input) { finds.push(input); return { items: [] }; },
    set(input) {
      sets.push(input);
      return { ok: false, code: 'not_found', message: 'Olympus no longer holds that item.' };
    },
  };
  const worker = createEmailSourceWorker({
    ownerTierItems: engine,
    readOwnerItem: async (itemId) => ({ state: itemId === ITEM_ID ? 'queued' : 'refused', etaSeconds: 60 }),
    sourceDashboard: { sovereigntyEngine: createSovereigntyEngine(buildEnvBridgeSovereigntyConfig({})) },
  });
  const guarded = withWorkerBearerAuth((request: Request) => worker.fetch(request), { authToken: TOKEN });
  const config = defaultConfig();
  config.email.enabled = true;
  let sent = 0;
  const email = new EmailClient(config, new DirectHttpEmailTransport((input, init) => {
    sent += 1;
    return guarded(new Request(input, init));
  }, TOKEN));
  const ctx: OperationContext = { config, delphi: {} as OperationContext['delphi'], email };
  return { worker, guarded, ctx, finds, sets, sent: () => sent };
}

const surfaceNames = (surface: OperationSurface) =>
  exposedOperations(operations, { config: defaultConfig(), surface }).map((operation) => operation.name);

describe('the agent operations', () => {
  test('are on the native, MCP and CLI surfaces, and not on the remote one', () => {
    for (const surface of ['native', 'mcp', 'cli'] as const) {
      expect(surfaceNames(surface)).toContain('privacy_item_find');
      expect(surfaceNames(surface)).toContain('privacy_item_set');
    }
    expect(V0_4_PUBLIC_REMOTE_MCP_TOOLS as readonly string[]).not.toContain('privacy_item_set');
    expect(set.mutating).toBe(true);
    expect(find.mutating).toBe(false);
    expect(set.params.tier?.enum).toEqual(['private']);
  });

  test('privacy_item_set can only raise: Personal, the judge\'s label or anything else is refused before anything is sent', async () => {
    const f = fixture();
    for (const tier of ['personal', 'judge', 'public', 'secrets', 'Personal', 'PRIVATE']) {
      await expect(set.handler(f.ctx, { item_id: ITEM_ID, tier })).rejects.toMatchObject({ code: 'invalid_params' });
    }
    await expect(set.handler(f.ctx, { item_id: ITEM_ID, tier: 'private', allow_lower: true })).rejects.toThrow('undeclared property');
    expect(f.sent()).toBe(0);
    expect(f.sets).toEqual([]);

    // Private goes to the worker's raise route, which asks the engine for a raise and nothing else.
    expect(await set.handler(f.ctx, { item_id: ITEM_ID, tier: 'private' })).toMatchObject({ ok: false, code: 'not_found' });
    expect(f.sets).toEqual([{ itemId: ITEM_ID, choice: 'private', allowLower: false }]);
  });

  test('privacy_item_find asks for items whose names are Personal only', async () => {
    const f = fixture();
    expect(await find.handler(f.ctx, { query: 'bank letter' })).toEqual({ items: [] });
    expect(await find.handler(f.ctx, { recent: true, limit: 5 })).toEqual({ items: [] });
    await expect(find.handler(f.ctx, {})).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(find.handler(f.ctx, { query: 'x', recent: true })).rejects.toMatchObject({ code: 'invalid_params' });
    expect(f.finds).toEqual([
      { query: 'bank letter', personalNamesOnly: true },
      { recent: true, limit: 5, personalNamesOnly: true },
    ]);
  });

  test('agent find and Personal search see the same names after revocation, while dashboard find keeps all items', async () => {
    const tmp = tempDir('privacy-item-routes-');
    const store = new LocalConnectorStore({ dbPath: join(tmp.dir, 'items.sqlite'), corpusId: 'internal.fixture.files',
      family: 'file', trustDomain: 'internal' });
    const specs = ['visible', 'excluded', 'revoked', 'private'].map(id => ({ id, name: `report-${id}.txt`, text: 'Garden notes' }));
    const generation = 'a'.repeat(64);
    const revision = 'bdca1717-208e-48cc-8dd5-3e843bc3c83d';
    let allowed = true;
    let approvedGeneration = 'b'.repeat(64);
    let renameDuringFind = false;
    const worker = createEmailSourceWorker({
      connectorStores: [store], ownerTierItems: createOwnerTierItems({ storePaths: [store.dbPath] }),
      sourceIndexVisibilityGate(hits) {
        if (renameDuringFind) {
          const writer = new Database(store.dbPath);
          try { writer.run("UPDATE items SET title = 'New title' WHERE provider_item_id = 'visible'"); }
          finally { writer.close(); }
        }
        return hits;
      },
      connectorStoreReadScope: () => allowed ? { allowed: true, contentAllowed: false, filters: {
        sourceScopeGeneration: approvedGeneration, sourceScopeRevision: revision, sourceScopeFolderNoneKeys: ['excluded'],
      } } : { allowed: false },
    });
    const agent = (action: string, body: object) => worker.fetch(post('/v1/privacy-item/' + action, {}, body));
    try {
      await store.syncFromConnector(fixtureConnector(() => specs), {
        fetchContent: true, placement: FIXTURE_PLACEMENT, tierClassification: { sniffer: JUDGED_PERSONAL_SNIFFER },
        sourceScopeObservation: item => ({ scopeRevision: revision,
          accountGeneration: item.identity.providerItemId === 'revoked' ? 'b'.repeat(64) : generation,
          folderKeys: [item.identity.providerItemId === 'excluded' ? 'excluded' : 'included'] }),
      });
      store.governingTierLedger()!.setOverride(identityOf('private'), { kind: 'tier', tier: 'secure' });
      expect(await (await agent('find', { query: 'report' })).json()).toMatchObject({ items: [{ title: 'report-revoked.txt' }] });
      approvedGeneration = generation;
      const search = await worker.fetch(post('/v1/source/index/search', {}, { query: 'report', corpus_id: store.corpusId }));
      expect(search.status).toBe(200);
      expect(await search.json()).toMatchObject({ hits: [{ sourceItem: { providerItemId: 'visible' } }] });
      for (const body of [{ query: 'report' }, { recent: true }]) {
        const dashboard = await postAsLocalOwner(worker, '/dashboard/privacy/items/find', body);
        expect(dashboard.status).toBe(200);
        const { items } = await dashboard.json() as { items: OwnerTierItem[] };
        expect(items.map(item => item.title).sort()).toEqual(specs.map(spec => spec.name).sort());
        const response = await agent('find', body);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ items: [{ title: 'report-visible.txt' }] });
      }
      const current = async () => (await (await agent('find', { recent: true })).json() as { items: OwnerTierItem[] }).items;
      const [visible] = await current();
      expect(visible).not.toHaveProperty('preview');
      approvedGeneration = 'c'.repeat(64);
      expect(await current()).toEqual([]);
      approvedGeneration = generation;
      allowed = false;
      expect(await current()).toEqual([]);
      allowed = true;
      renameDuringFind = true;
      const changed = await agent('find', { query: 'report' });
      expect(changed.status).toBe(403);
      expect(await changed.text()).not.toContain('report-visible');
      renameDuringFind = false;
      expect(await current()).toMatchObject([{ title: 'New title', item_id: visible!.item_id }]);
      expect(await (await agent('raise', { item_id: visible!.item_id })).json()).toMatchObject({ ok: true });
      expect(await current()).toEqual([]);
    } finally {
      worker.close();
      store.close();
      tmp.cleanup();
    }
  });

  test('find intersects caller and worker search grants before opening corpora', async () => {
    const config = defaultConfig();
    config.email.enabled = true;
    const ids = ['internal.drive.docs', 'secure_local.drive.docs'];
    const corpora = config.sourceIndex.corpusRegistry.corpora.filter(c => ids.includes(c.corpusId));
    config.sourceIndex.corpusRegistry.corpora = corpora;
    const tmp = tempDir('privacy-corpus-');
    const stores = ids.map(corpusId => new LocalConnectorStore({ corpusId, family: 'file', trustDomain: 'internal',
      dbPath: join(tmp.dir, corpusId + '.sqlite') }));
    const searchable = new Set(ids);
    const refreshes: Array<ReadonlySet<string> | undefined> = [];
    const worker = createEmailSourceWorker({ connectorStores: stores, searchableCorpusIds: searchable,
      refreshConnectorStores: ids => { refreshes.push(ids); },
      ownerTierItems: createOwnerTierItems({ storePaths: stores.map(store => store.dbPath) }) });
    const email = new EmailClient(config, new DirectHttpEmailTransport((input, init) => worker.fetch(new Request(input, init))));
    try {
      for (const [i, store] of stores.entries()) await seed(store, ['report-' + i]);
      const deniedReads = spyOn(stores[1]!, 'changeMarker');
      for (const authority of ['caller', 'worker']) {
        const denied = corpora.find(c => c.corpusId === ids[1])!;
        if (authority === 'caller') denied.capabilities = ['status'];
        else { denied.capabilities = ['search']; searchable.delete(denied.corpusId); }
        for (const body of [{ query: 'report' }, { recent: true }]) {
          expect(await email.privacyItem({ action: 'find', ...body })).toMatchObject({ items: [{ title: 'report-0' }] });
          expect(refreshes.at(-1)).toEqual(new Set([ids[0]!]));
          expect(deniedReads).not.toHaveBeenCalled();
        }
      }
    } finally { worker.close(); for (const store of stores) store.close(); tmp.cleanup(); }
  });

  test('find proves an encoded parent in an admitted store and rechecks its grant before release', async () => {
    const tmp = tempDir('privacy-parent-');
    const [parent, child] = ['parent', 'child'].map(id => new LocalConnectorStore({ corpusId: 'internal.' + id,
      dbPath: join(tmp.dir, id + '.sqlite'), family: 'file', trustDomain: 'internal' })) as [LocalConnectorStore, LocalConnectorStore];
    const childId = 'garden#child:notes';
    let allowed = true;
    let revokeDuringLookup = false;
    const stores = [parent, child];
    const worker = createEmailSourceWorker({ connectorStores: stores,
      connectorStoreReadScope: store => ({ allowed: store !== parent || allowed }),
      sourceIndexVisibilityGate: hits => { if (revokeDuringLookup) allowed = false; return hits; },
      ownerTierItems: createOwnerTierItems({ storePaths: stores.map(store => store.dbPath) }) });
    const lookup = () => worker.fetch(post('/v1/privacy-item/find', {}, { query: 'notes' }));
    try {
      await seed(parent, ['garden']);
      await seed(child, [childId]);
      child.useChildVisibility({ stores: () => stores, ledger: () => child.governingTierLedger() });
      expect(await (await lookup()).json()).toMatchObject({ items: [{ item_id: ownerTierItemId(identityOf(childId)) }] });
      allowed = false;
      const reads = spyOn(parent, 'itemStandings');
      expect(await (await lookup()).json()).toEqual({ items: [] });
      expect(reads).not.toHaveBeenCalled();
      allowed = true;
      revokeDuringLookup = true;
      const changed = await lookup();
      expect(changed.status).toBe(403);
      expect(await changed.text()).not.toContain(ownerTierItemId(identityOf(childId)));
    } finally { worker.close(); for (const store of stores) store.close(); tmp.cleanup(); }
  });

  test('raise of a retained id after folder revocation or a Secret verdict matches an absent id', async () => {
    const tmp = tempDir('privacy-raise-');
    const store = new LocalConnectorStore({ dbPath: join(tmp.dir, 'items.sqlite'), corpusId: 'internal.fixture.files',
      family: 'file', trustDomain: 'internal' });
    let exclude = false;
    let revokeDuringLookup = false;
    const worker = createEmailSourceWorker({ connectorStores: [store],
      sourceIndexVisibilityGate: hits => { if (revokeDuringLookup) exclude = true; return hits; },
      connectorStoreReadScope: () => ({ allowed: true, filters: { sourceScopeFolderNoneKeys: exclude ? ['closed'] : [] } }),
      ownerTierItems: createOwnerTierItems({ storePaths: [store.dbPath] }) });
    const raise = async (id: string) => (await worker.fetch(post('/v1/privacy-item/raise', {}, { item_id: id }))).json();
    try {
      await seed(store, ['document']);
      const found = await worker.fetch(post('/v1/privacy-item/find', {}, { recent: true }));
      const { items: [item] } = await found.json() as { items: OwnerTierItem[] };
      const absent = await raise(ownerTierItemId(identityOf('absent')));
      expect(absent).toMatchObject({ ok: false, code: 'not_found' });
      exclude = true;
      expect(await raise(item!.item_id)).toEqual(absent);
      const ledger = store.governingTierLedger()!;
      expect(ledger.getOverride(identityOf('document'))).toBeUndefined();
      exclude = false;
      revokeDuringLookup = true;
      expect(await raise(item!.item_id)).toEqual(absent);
      expect(ledger.getOverride(identityOf('document'))).toBeUndefined();
      revokeDuringLookup = false;
      exclude = false;
      ledger.setOverride(identityOf('document'), { kind: 'tier', tier: 'secrets' });
      expect(await raise(item!.item_id)).toEqual(absent);
      expect(ledger.getOverride(identityOf('document'))).toMatchObject({ tier: 'secrets' });
    } finally { worker.close(); store.close(); tmp.cleanup(); }
  });

  test('recent find fills the limit past a full page of excluded decisions', async () => {
    const tmp = tempDir('privacy-recent-');
    const store = new LocalConnectorStore({ dbPath: join(tmp.dir, 'items.sqlite'), corpusId: 'internal.fixture.files',
      family: 'file', trustDomain: 'internal' });
    const worker = createEmailSourceWorker({ connectorStores: [store],
      connectorStoreReadScope: () => ({ allowed: true, filters: { sourceScopeFolderNoneKeys: ['closed'] } }),
      ownerTierItems: createOwnerTierItems({ storePaths: [store.dbPath] }) });
    try {
      await seed(store, ['visible', 'a', 'b', 'c']);
      const ledger = store.governingTierLedger()!;
      const db = new Database(ledger.dbPath);
      try { db.run("UPDATE tier_items SET decided_at = '2026-01-01T00:00:00.000Z'"); }
      finally { db.close(); }
      const result = await worker.fetch(post('/v1/privacy-item/find', {}, { recent: true, limit: 1 }));
      expect(await result.json()).toMatchObject({ items: [{ title: 'visible' }] });
    } finally { worker.close(); store.close(); tmp.cleanup(); }
  });

  test('the worker\'s agent routes have no way to lower an item', async () => {
    const f = fixture();
    for (const action of ['set', 'lower', 'judge', 'clear']) {
      const response = await f.guarded(new Request(`${ORIGIN}/v1/privacy-item/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: ITEM_ID, tier: 'personal', allowLower: true }),
      }));
      expect(response.status).toBe(404);
    }
    // A raise ignores whatever else the body says.
    await f.guarded(new Request(`${ORIGIN}/v1/privacy-item/raise`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ item_id: ITEM_ID, tier: 'personal', allow_lower: true }),
    }));
    expect(f.sets).toEqual([{ itemId: ITEM_ID, choice: 'private', allowLower: false }]);
  });
});

async function seed(store: LocalConnectorStore, ids: string[]) {
  await store.syncFromConnector(fixtureConnector(() => ids.map(id => ({ id, name: id, text: 'Garden notes' }))), {
    fetchContent: true, placement: FIXTURE_PLACEMENT, tierClassification: { sniffer: JUDGED_PERSONAL_SNIFFER },
    sourceScopeObservation: item => ({ scopeRevision: 'bdca1717-208e-48cc-8dd5-3e843bc3c83d',
      accountGeneration: 'a'.repeat(64), folderKeys: [item.identity.providerItemId === 'visible' ? 'open' : 'closed'] }),
  });
}

function cookieOf(response: Response): string {
  const cookie = (response.headers.get('Set-Cookie') ?? '').split(';')[0] ?? '';
  if (!cookie.startsWith('olympus_dashboard_control=')) throw new Error('no control cookie');
  return cookie;
}

function post(path: string, headers: Record<string, string>, body: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

async function localSession(fetch: (request: Request) => Promise<Response>) {
  const mint = await ownerLocalMint(fetch, ORIGIN, TOKEN);
  expect(mint.status).toBe(200);
  return { Cookie: cookieOf(mint), 'X-Olympus-CSRF': ((await mint.json()) as { csrf_token: string }).csrf_token };
}

async function bearerSession(fetch: (request: Request) => Promise<Response>) {
  const mint = await fetch(new Request(`${ORIGIN}/dashboard/control/session`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, Origin: ORIGIN } }));
  expect(mint.status).toBe(200);
  return { Cookie: cookieOf(mint), 'X-Olympus-CSRF': ((await mint.json()) as { csrf_token: string }).csrf_token };
}

describe('the dashboard\'s routes', () => {
  test('are public dashboard routes, held to this computer\'s own session', async () => {
    const f = fixture();
    const published = V0_4_PUBLIC_DASHBOARD_ROUTES.map((route) => route.path);
    for (const path of DASHBOARD_PRIVACY_ITEM_PATHS) expect(published).toContain(path);
    const bearer = await bearerSession(f.guarded);
    for (const path of DASHBOARD_PRIVACY_ITEM_PATHS) {
      const body = { query: 'bank', item_id: ITEM_ID, tier: 'personal' };
      for (const headers of [
        { Authorization: `Bearer ${TOKEN}` },
        { Authorization: `Bearer ${TOKEN}`, [DASHBOARD_CONTROL_GRADE_CONTEXT_HEADER]: 'local' },
        bearer,
      ]) {
        const refused = await f.guarded(post(path, headers, body));
        expect(refused.status).toBe(403);
      }
      // An in-process caller without the boundary's grade is refused by the route itself.
      expect((await f.worker.fetch(post(path, {}, body))).status).toBe(403);
    }
    expect(f.finds).toEqual([]);
    expect(f.sets).toEqual([]);
  });

  test('a local session finds any item and sets Personal, Private or back to the judge', async () => {
    const f = fixture();
    const session = await localSession(f.guarded);
    const found = await f.guarded(post('/dashboard/privacy/items/find', session, { query: 'bank' }));
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({ ok: true, items: [] });
    expect(f.finds).toEqual([{ query: 'bank', withPreview: true }]);
    for (const tier of ['personal', 'private', 'judge']) {
      expect((await f.guarded(post('/dashboard/privacy/items/set', session, { item_id: ITEM_ID, tier }))).status).toBe(200);
    }
    expect(f.sets).toEqual([
      { itemId: ITEM_ID, choice: 'personal', allowLower: true },
      { itemId: ITEM_ID, choice: 'private', allowLower: true },
      { itemId: ITEM_ID, choice: 'judge', allowLower: true },
    ]);
    expect((await f.guarded(post('/dashboard/privacy/items/set', session, { item_id: ITEM_ID, tier: 'secrets' }))).status).toBe(400);
  });

  test('the local review filter and text receipt reach the same per-item operation', async () => {
    const f = fixture();
    const session = await localSession(f.guarded);
    const digest = 'content:sha256:' + 'd'.repeat(64);
    expect((await f.guarded(post('/dashboard/privacy/items/find', session, { recent: true, filter: 'override_review' }))).status).toBe(200);
    await f.guarded(post('/dashboard/privacy/items/set', session, { item_id: ITEM_ID, tier: 'personal', review_digest: digest }));
    expect(f.finds).toEqual([{ recent: true, filter: 'override_review', withPreview: true }]);
    expect(f.sets).toEqual([{ itemId: ITEM_ID, choice: 'personal', reviewDigest: digest, allowLower: true }]);
  });

  test('Read this file uses the owner operation only from a local session', async () => {
    const f = fixture();
    const session = await localSession(f.guarded);
    const response = await f.guarded(post('/dashboard/privacy/items/read', session, { item_id: ITEM_ID }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, state: 'queued', etaSeconds: 60 });
    expect((await f.guarded(post('/dashboard/privacy/items/read', session, {}))).status).toBe(400);
  });

  test('Check the judge answers a local session only, and says when it is not set up', async () => {
    const f = fixture();
    const session = await localSession(f.guarded);
    const response = await f.guarded(post('/dashboard/privacy/judge-check', session, { action: 'status' }));
    expect(response.status).toBe(501);
  });
});
