import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { contentDigestReason, type TierSniffer, type TierSnifferRequest, type TierSnifferVerdict } from '../src/workers/classification/tier-classifier.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';
import { fixtureConnector, fixtureItem, tempDir } from './helpers/tier-fixtures.ts';
import { defaultConfig } from '../src/core/config.ts';
import { EmailClient, DirectHttpEmailTransport } from '../src/core/email.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { handleMcpCallTool } from '../src/mcp/server.ts';
import { listMcpTools } from '../src/mcp/tools.ts';
import { CachedTierSniffer } from '../src/workers/classification/sniffer.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { readFileSync } from 'node:fs';
import { createReleaseTierCheck } from '../src/workers/connector-store/tier-visibility.ts';
import { openTierFixture, FIXTURE_PLACEMENT } from './helpers/tier-fixtures.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { registerInstalledTierClassification(undefined); cleanup.splice(0).reverse().forEach(fn => fn()); });
async function fixture(text = 'An ordinary orchard note. ', domain: 'internal' | 'secure_local' = 'internal') {
  const tmp = tempDir('item-read-'); cleanup.push(tmp.cleanup);
  const ledger = new TierLedger({ dbPath: `${tmp.dir}/ledger.sqlite` }); cleanup.push(() => ledger.close());
  const store = new LocalConnectorStore({ dbPath: `${tmp.dir}/store.sqlite`, corpusId: `${domain}.fixture.files`, family: 'file', trustDomain: domain, tierLedger: ledger }); cleanup.push(() => store.close());
  const item = fixtureItem({ id: 'note', name: 'Orchard note', text });
  await store.syncFromConnector(fixtureConnector(() => [{ id: 'note', name: 'Orchard note', text }]), {
    fetchContent: true, tierClassification: { sniffer: { id: 'initial', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary' }) } },
  });
  const calls: TierSnifferRequest[] = [];
  const cache = new Map<string, TierSnifferVerdict>();
  let judge: (request: TierSnifferRequest) => TierSnifferVerdict = () => ({ verdict: 'decided', tier: 'private', code: 'ordinary' });
  const sniffer: TierSniffer = { id: 'windows', cachedVerdict: r => cache.get(r.materialHash!) ?? { verdict: 'undecided' }, judge(r) {
    calls.push(r); const verdict = judge(r); if (verdict.verdict === 'decided') cache.set(r.materialHash!, verdict); return verdict;
  } };
  registerInstalledTierClassification({ forLedger: () => ({ sniffer }) });
  const db = new Database(store.dbPath); cleanup.push(() => db.close());
  const ledgerDb = new Database(ledger.dbPath); cleanup.push(() => ledgerDb.close());
  return { store, ledger, item, calls, db, ledgerDb, judge: (fn: typeof judge) => { judge = fn; } };
}
function refused(result: Awaited<ReturnType<LocalConnectorStore['readItemPages']>>, code: import('../src/core/source-item-read.ts').SourceItemReadRefusal) {
  expect(result.pages).toEqual([]); expect(result.couldNotRead).toContain(code);
  expect(JSON.stringify(result)).not.toContain('orchard');
}

test('sentence pages preserve all ordered chunks, resume, cap pages and characters; windows cache', async () => {
  const text = 'An ordinary orchard sentence. '.repeat(2600).trim();
  const f = await fixture(text);
  const first = await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 99 });
  expect(first.pages).toHaveLength(3); expect(first.nextPage).toBe(4); expect(first.totalChars).toBe(text.length);
  const rest = await f.store.readItemPages(f.item.identity.localItemId, { page: 4, pages: 3 });
  const tail = rest.nextPage ? await f.store.readItemPages(f.item.identity.localItemId, { page: rest.nextPage, pages: 3 }) : { pages: [] };
  const all = [...first.pages, ...rest.pages, ...tail.pages];
  expect(all.map(p => p.text).join('')).toBe(text);
  expect(all.every(p => p.text.length <= 12000 && p.text.trimEnd().endsWith('.'))).toBe(true);
  expect(f.calls.every(c => c.pass === 'content' && c.material!.length <= 1200)).toBe(true);
  const count = f.calls.length;
  await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 3 });
  expect(f.calls).toHaveLength(count);
});

test('a sentence longer than a page is hard cut without gaps', async () => {
  const f = await fixture('x'.repeat(25001));
  const r = await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 3 });
  expect(r.pages.map(p => p.text.length)).toEqual([12000, 12000, 1001]);
});

test('Private in the second window raises the item before refusing all text', async () => {
  const f = await fixture('An ordinary orchard note. '.repeat(100));
  f.judge(() => ({ verdict: 'decided', tier: f.calls.length === 2 ? 'secure' : 'private', code: 'synthetic' }));
  refused(await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1 }), 'not_personal');
  expect(f.calls).toHaveLength(2); expect(f.ledger.getCurrent(f.item.identity)?.contentTier).toBe('secure');
});

test('Secret window raises the item and refuses text', async () => {
  const f = await fixture(); f.judge(() => ({ verdict: 'decided', tier: 'secrets', code: 'synthetic_secret' }));
  refused(await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1 }), 'not_personal');
  expect(f.ledger.getCurrent(f.item.identity)?.contentTier).toBe('secrets');
});

test('pending window holds page and resumes there', async () => {
  const f = await fixture(); f.judge(() => ({ verdict: 'undecided', queued: true }));
  const r = await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1 });
  refused(r, 'window_judging'); expect(r.nextPage).toBe(1);
});

test('changed text cannot use original excerpt clearance', async () => {
  const f = await fixture();
  expect(f.ledger.getCurrent(f.item.identity)?.reasons).toContain(contentDigestReason('An ordinary orchard note. '));
  f.db.query('UPDATE chunks SET bounded_text = ?').run('Changed orchard text.');
  f.judge(() => ({ verdict: 'undecided' }));
  refused(await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1 }), 'window_judging');
  expect(f.calls[0]?.material).toBe('Changed orchard text.');
});

for (const state of ['moving', 'pending', 'metadataPending', 'contentPending', 'rejudge'] as const) {
  test(`refuses unstable ledger: ${state}`, async () => {
    const f = await fixture();
    if (state === 'metadataPending' || state === 'contentPending') f.ledgerDb.exec(`UPDATE tier_items SET ${state === 'metadataPending' ? 'metadata_pending' : 'content_pending'} = 1`);
    else if (state === 'rejudge') {
      const row = f.ledger.getCurrent(f.item.identity)!;
      f.ledger.openRejudgeQuestion(f.item.identity, { expectedGeneration: row.generation, decision: { ...row, state: 'pending', decidedBy: 'sniffer', snifferId: 'windows', contentPending: true }, keepVisible: false });
    } else f.ledgerDb.query('UPDATE tier_items SET state = ?').run(state);
    refused(await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1 }), 'held_until_judged');
    expect(f.calls).toHaveLength(0);
  });
}

for (const change of ['tier', 'override'] as const) {
  test(`rechecks ${change} during judge await`, async () => {
    const f = await fixture();
    f.judge(() => {
      queueMicrotask(() => {
        if (change === 'tier') f.ledgerDb.exec("UPDATE tier_items SET content_tier = 'secure'");
        else f.ledger.setOverride(f.item.identity, { kind: 'tier', tier: 'secure' });
      });
      return { verdict: 'decided', tier: 'private', code: 'ordinary' };
    });
    refused(await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1 }), 'not_personal');
  });
}

test('Private item in internal refused; Personal item in secure-local readable', async () => {
  const f = await fixture(); f.ledgerDb.exec("UPDATE tier_items SET content_tier = 'secure'");
  refused(await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1 }), 'not_personal');
  const p = await fixture('Personal orchard text.', 'secure_local');
  expect((await p.store.readItemPages(p.item.identity.localItemId, { page: 1, pages: 1 })).pages[0]?.text).toBe('Personal orchard text.');
});

test('scope, names-only, content-private and extraction refusals contain codes only', async () => {
  const f = await fixture();
  refused(await f.store.readItemPages('missing', { page: 1, pages: 1 }), 'not_in_scope');
  refused(await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1, scope: () => ({ allowed: false }) }), 'not_in_scope');
  refused(await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1, scope: () => ({ allowed: true, contentAllowed: false }) }), 'names_only');
  const original = f.store.contentHeldPrivate.bind(f.store); f.store.contentHeldPrivate = () => true;
  refused(await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1 }), 'content_private'); f.store.contentHeldPrivate = original;
  f.db.exec('DELETE FROM chunks');
  refused(await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1 }), 'extraction_pending');
});


function selected(f: Awaited<ReturnType<typeof fixture>>) {
  return { corpus_id: f.store.corpusId, family: 'file', provider: 'fixture', account_scope: 'personal', provider_item_id: 'note', local_item_id: f.item.identity.localItemId };
}
function config() {
  const c = defaultConfig(); c.sourceIndex.enabled = true; c.email.enabled = true; c.email.baseUrl = 'http://worker.test/v1'; return c;
}
function client(f: Awaited<ReturnType<typeof fixture>>, scope?: NonNullable<Parameters<typeof createEmailSourceWorker>[0]>['connectorStoreReadScope']) {
  const worker = createEmailSourceWorker({ connectorStores: [f.store], ...(scope ? { connectorStoreReadScope: scope } : {}) });
  return new EmailClient(config(), new DirectHttpEmailTransport(async (url, init) => worker.fetch(new Request(url, init))));
}

test('operation, client and engine read a selected search hit with defaults', async () => {
  const f = await fixture('Personal orchard text.'); const email = client(f);
  const op = operations.find(o => o.name === 'source_item_read')!;
  expect(op).toBeDefined(); expect(op.mutating).toBe(false); expect(op.nativeExposure).toBe('sourceIndexEnabledOnly');
  expect(listMcpTools(config()).map(t => t.name)).toContain('source_item_read');
  const result = await op.handler({ config: config(), email, delphi: {} } as OperationContext, { selected_item: selected(f) });
  expect(result).toMatchObject({ pages: [{ page: 1, text: 'Personal orchard text.' }], couldNotRead: [] });
  expect(JSON.stringify(result)).not.toContain('account_scope');
});

test('selected-item validation rejects content and mismatched identities; page bounds enforced', async () => {
  const f = await fixture(); const email = client(f); const op = operations.find(o => o.name === 'source_item_read')!;
  const ctx = { config: config(), email, delphi: {} } as OperationContext;
  for (const args of [{}, { selected_item: { ...selected(f), text: 'must not accept' } }, { selected_item: selected(f), page: 0 }, { selected_item: selected(f), pages: 4 }]) {
    await expect(op.handler(ctx, args)).rejects.toMatchObject({ code: 'invalid_params' });
  }
  const mismatch = await email.sourceItemRead({ selectedItem: { ...selected(f), provider_item_id: 'other' }, page: 1, pages: 1 });
  refused(mismatch, 'not_in_scope');
});

test('engine applies fresh scope and per-item tier, with the prescribed Private refusal', async () => {
  const f = await fixture(); const email = client(f); f.ledgerDb.exec("UPDATE tier_items SET content_tier = 'secure'");
  await expect(email.sourceItemRead({ selectedItem: selected(f) })).rejects.toMatchObject({ code: 'not_personal', message: 'Private item: ask with source_answer' });
  const p = await fixture('Personal orchard.', 'secure_local');
  expect((await client(p).sourceItemRead({ selectedItem: selected(p) })).pages).toHaveLength(1);
  refused(await client(p, () => ({ allowed: false })).sourceItemRead({ selectedItem: selected(p) }), 'not_in_scope');
});

test('client permits pages text while rejecting raw and operational fields', async () => {
  const f = await fixture();
  for (const extra of [{ body: 'forbidden' }, { cursor: 'forbidden' }, { pages: [{ page: 1, text: 'ordinary', access_token: 'forbidden' }] }]) {
    const email = new EmailClient(config(), { async requestJson() { return { pages: [], totalPages: 1, totalChars: 1, couldNotRead: [], ...extra }; } });
    await expect(email.sourceItemRead({ selectedItem: selected(f) })).rejects.toMatchObject({ code: 'email_policy_violation' });
  }
});

test('MCP connection revoked during a window read receives only the fixed refusal', async () => {
  const f = await fixture('Personal orchard.'); let active = true;
  f.judge(() => { queueMicrotask(() => { active = false; }); return { verdict: 'decided', tier: 'private', code: 'ordinary' }; });
  const ctx = { config: config(), email: client(f), delphi: {} } as OperationContext;
  const result = await handleMcpCallTool({ params: { name: 'source_item_read', arguments: { selected_item: selected(f) } } }, () => ctx, 'remote', () => active ? 'active' : 'revoked');
  expect(active).toBe(false); expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('invalid_token'); expect(JSON.stringify(result)).not.toContain('orchard');
});


test('real queue resolves settled-item window questions, caches each once, and resumes', async () => {
  const f = await fixture('Personal orchard text.');
  const queue = new TierSnifferStore({ dbPath: ':memory:' }); cleanup.push(() => queue.close());
  const sniffer = new CachedTierSniffer(queue, BUILT_IN_SNIFFER_LANE);
  registerInstalledTierClassification({ forLedger: () => ({ sniffer }) });
  const first = await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1 });
  refused(first, 'window_judging');
  let modelCalls = 0;
  await runSnifferPass({ targets: [{ ledger: f.ledger, sniffer: queue }], lane: BUILT_IN_SNIFFER_LANE, model: { async complete() {
    modelCalls++;
    return { modelId: BUILT_IN_SNIFFER_LANE.modelId, text: JSON.stringify({ verdicts: [{ i: 1, tier: 'personal', category: 'ordinary', ownRecord: false, privateKind: 'none', confidence: 0.99 }] }) };
  } } });
  expect(modelCalls).toBe(1);
  expect((await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1 })).pages).toHaveLength(1);
  expect((await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1 })).pages).toHaveLength(1);
  expect(modelCalls).toBe(1);
});

test('search skill directs long-hit reads and Private selected-item answers', () => {
  const skill = readFileSync(new URL('../skills/ask-sources/SKILL.md', import.meta.url), 'utf8');
  expect(skill).toContain('read a long hit with `source_item_read` before answering from it');
  expect(skill).toContain('Private hit, ask `source_answer` with `selected_items` instead');
});


test('remote pages are withheld if the owner overrides the item during release await', async () => {
  const f = await fixture('Personal orchard.');
  const check = createReleaseTierCheck(() => [{ ledger: f.ledger, corpusIds: new Set([f.store.corpusId]) }], () => 'allow');
  let checked = false;
  const ctx = { config: config(), email: client(f), delphi: {}, releaseCheck: {
    inputs(inputs) {
      const result = check.inputs(inputs);
      if (!checked) { checked = true; queueMicrotask(() => f.ledger.setOverride(f.item.identity, { kind: 'tier', tier: 'secure' })); }
      return result;
    }, secureDerivativeDefault: () => 'allow',
  } } as OperationContext;
  const result = await handleMcpCallTool({ params: { name: 'source_item_read', arguments: { selected_item: selected(f) } } }, () => ctx, 'remote');
  expect(checked).toBe(true); expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain('orchard');
});


test('routed window raises hide copies through normal queued moves and Secrets disposition', async () => {
  for (const tier of ['secure', 'secrets'] as const) {
    const tmp = tempDir('read-window-routed-'); cleanup.push(tmp.cleanup);
    const f = openTierFixture(tmp.dir, { embed: false }); cleanup.push(f.close);
    let reading = false;
    const sniffer: TierSniffer = { id: 'routed-fixture', judge: () => ({ verdict: 'decided', tier: reading ? tier : 'private', code: 'synthetic' }) };
    registerInstalledTierClassification({ forLedger: () => ({ sniffer }) });
    await f.set.sync(fixtureConnector(() => [{ id: 'note', name: 'Orchard note', text: 'Personal orchard.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT }, { embed: false });
    reading = true;
    const identity = fixtureItem({ id: 'note', name: 'Orchard note' }).identity;
    refused(await f.stores.internal!.readItemPages(identity.localItemId, { page: 1, pages: 1 }), 'not_personal');
    const row = f.ledger.getCurrent(identity)!;
    expect(tier === 'secure' ? row.targetContentTier : row.contentTier).toBe(tier);
    expect(f.stores.internal!.localContent(identity.localItemId)?.chunks ?? []).toEqual([]);
  }
});

test('real queued Private verdict raises before a retry and never credits a whole-item Personal verdict', async () => {
  const f = await fixture('Personal orchard text.');
  const original = f.ledger.getCurrent(f.item.identity)!;
  const queue = new TierSnifferStore({ dbPath: ':memory:' }); cleanup.push(() => queue.close());
  const sniffer = new CachedTierSniffer(queue, BUILT_IN_SNIFFER_LANE);
  registerInstalledTierClassification({ forLedger: () => ({ sniffer }) });
  refused(await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1 }), 'window_judging');
  await runSnifferPass({ targets: [{ ledger: f.ledger, sniffer: queue }], lane: BUILT_IN_SNIFFER_LANE, model: { async complete() {
    return { modelId: BUILT_IN_SNIFFER_LANE.modelId, text: JSON.stringify({ verdicts: [{ i: 1, tier: 'private', category: 'health', ownRecord: true, privateKind: 'health', confidence: 0.99 }] }) };
  } } });
  const row = f.ledger.getCurrent(f.item.identity)!;
  expect(row.contentTier).toBe('secure'); expect(row.metadataTier).toBe(original.metadataTier);
  refused(await f.store.readItemPages(f.item.identity.localItemId, { page: 1, pages: 1 }), 'not_personal');
});

test('stored hold reason and live account/filter boundaries refuse without text', async () => {
  const f = await fixture();
  refused(await f.store.readItemPages(f.item.identity.localItemId, { scope: () => ({ allowed: true, accountScope: 'other' }) }), 'not_in_scope');
  refused(await f.store.readItemPages(f.item.identity.localItemId, { scope: () => ({ allowed: true, filters: { provider: 'other' } }) }), 'not_in_scope');
  refused(await f.store.readItemPages(f.item.identity.localItemId, { scope: () => ({ allowed: true, contentFilters: { provider: 'other' } }) }), 'names_only');
  const row = f.ledger.getCurrent(f.item.identity)!;
  f.ledgerDb.query('UPDATE tier_items SET reasons_json = ?').run(JSON.stringify([...row.reasons, 'content:held_until_judged']));
  refused(await f.store.readItemPages(f.item.identity.localItemId), 'held_until_judged');
});

for (const change of ['scope', 'text', 'pending'] as const) {
  test(`rechecks ${change} after a window await`, async () => {
    const f = await fixture(); let allowed = true;
    f.judge(() => {
      queueMicrotask(() => {
        if (change === 'scope') allowed = false;
        if (change === 'text') f.db.query('UPDATE chunks SET bounded_text = ?').run('Changed orchard text.');
        if (change === 'pending') f.ledgerDb.exec('UPDATE tier_items SET content_pending = 1');
      });
      return { verdict: 'decided', tier: 'private', code: 'ordinary' };
    });
    refused(await f.store.readItemPages(f.item.identity.localItemId, { scope: () => ({ allowed }) }), change === 'scope' ? 'not_in_scope' : 'held_until_judged');
  });
}

test('a Private window raises even when the original item had a Personal override', async () => {
  const f = await fixture(); f.ledger.setOverride(f.item.identity, { kind: 'tier', tier: 'private' });
  f.judge(() => ({ verdict: 'decided', tier: 'secure', code: 'synthetic' }));
  refused(await f.store.readItemPages(f.item.identity.localItemId), 'not_personal');
  expect(f.ledger.getCurrent(f.item.identity)?.contentTier).toBe('secure');
});

test('engine Private refusal carries the fixed code and message with no item text', async () => {
  const f = await fixture(); f.ledgerDb.exec("UPDATE tier_items SET content_tier = 'secure'");
  const worker = createEmailSourceWorker({ connectorStores: [f.store] });
  const response = await worker.fetch(new Request('http://worker.test/v1/source/item/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selected_item: selected(f) }) }));
  const result = await response.json();
  expect(response.status).toBe(403);
  expect(result).toMatchObject({ error: { code: 'not_personal', message: 'Private item: ask with source_answer' } });
  expect(JSON.stringify(result)).not.toContain('orchard');
});
