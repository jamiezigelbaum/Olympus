import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import type { OwnerTierRule } from '../src/workers/classification/tier-classifier.ts';
import type { ReleaseCheck, ReleaseInput } from '../src/core/release-manifest.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';
import { fixtureConnector, fixtureItem, tempDir } from './helpers/tier-fixtures.ts';
import { defaultConfig } from '../src/core/config.ts';
import { EmailClient, DirectHttpEmailTransport } from '../src/core/email.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { handleMcpCallTool } from '../src/mcp/server.ts';
import { listMcpTools } from '../src/mcp/tools.ts';
import { readFileSync } from 'node:fs';
import { createReleaseTierCheck } from '../src/workers/connector-store/tier-visibility.ts';

const cleanup: (() => void)[] = [];
afterEach(() => { registerInstalledTierClassification(undefined); cleanup.splice(0).reverse().forEach(fn => fn()); });
async function fixture(text = 'An ordinary orchard note. ', domain: 'internal' | 'secure_local' = 'internal', rules: OwnerTierRule[] = []) {
  const tmp = tempDir('item-read-'); cleanup.push(tmp.cleanup);
  const ledger = new TierLedger({ dbPath: `${tmp.dir}/ledger.sqlite` }); cleanup.push(() => ledger.close());
  const store = new LocalConnectorStore({ dbPath: `${tmp.dir}/store.sqlite`, corpusId: `${domain}.fixture.files`, family: 'file', trustDomain: domain, tierLedger: ledger }); cleanup.push(() => store.close());
  const item = fixtureItem({ id: 'note', name: 'Orchard note', text });
  await store.syncFromConnector(fixtureConnector(() => [{ id: 'note', name: 'Orchard note', text }]), {
    fetchContent: true, tierClassification: { rules, sniffer: { id: 'initial', judge: () => ({ verdict: 'decided', tier: 'private', code: 'ordinary' }) } },
  });
  const calls: Array<{ inputs: readonly ReleaseInput[]; budgetMs: number | undefined }> = [];
  let allowed: (hash: string) => boolean = () => true;
  let onCheck: () => void = () => {};
  const check: ReleaseCheck = {
    inputs: inputs => inputs.map(() => ({ tier: 'public_or_personal', gone: false })),
    secureDerivativeDefault: () => 'allow',
    async chunks(inputs, options) {
      calls.push({ inputs, budgetMs: options?.budgetMs });
      onCheck();
      const cleared = inputs.map(input => (input.chunkHashes ?? []).filter(allowed));
      const withheldPassages = inputs.reduce((n, input, i) => n + (input.chunkHashes?.length ?? 0) - cleared[i]!.length, 0);
      return { allowed: cleared, withheldPassages, withheldDocuments: withheldPassages ? 1 : 0 };
    },
  };
  const db = new Database(store.dbPath); cleanup.push(() => db.close());
  const ledgerDb = new Database(ledger.dbPath); cleanup.push(() => ledgerDb.close());
  const read = (id = item.identity.localItemId, options: Parameters<LocalConnectorStore['readItemPages']>[1] = {}) => store.readItemPages(id, { releaseCheck: check, ...options });
  return { store, ledger, item, calls, db, ledgerDb, check, read,
    allow: (fn: typeof allowed) => { allowed = fn; }, onCheck: (fn: typeof onCheck) => { onCheck = fn; } };
}
function refused(result: Awaited<ReturnType<LocalConnectorStore['readItemPages']>>, code: import('../src/core/source-item-read.ts').SourceItemReadRefusal) {
  expect(result.pages).toEqual([]); expect(result.couldNotRead).toContain(code);
  expect(JSON.stringify(result)).not.toContain('orchard');
}

test('allowed pages contain whole stored chunks in order, with bounded pages and resumable reads', async () => {
  const f = await fixture();
  // Seed exact stored boundaries: this proof exercises reading, independently of extraction.
  f.db.transaction(() => {
    const item = f.db.query('SELECT item_pk FROM items').get() as { item_pk: number };
    f.db.exec('DELETE FROM chunks');
    const insert = f.db.query('INSERT INTO chunks (item_pk, chunk_index, bounded_text, content_hash, indexed_at) VALUES (?, ?, ?, ?, ?)');
    [6000, 6000, 1, 12000, 3000, 9001, 1000].forEach((length, index) => {
      const text = String(index).repeat(length);
      insert.run(item.item_pk, index, text, createHash('sha256').update(text).digest('hex'), '2026-11-12T00:00:00.000Z');
    });
  })();
  const chunks = f.db.query('SELECT bounded_text, content_hash FROM chunks ORDER BY chunk_index').all() as Array<{ bounded_text: string; content_hash: string }>;
  const all: Array<{ page: number; text: string }> = [];
  let page: number | undefined = 1;
  do {
    const r = await f.read(f.item.identity.localItemId, { page, pages: 99 });
    expect(r.pages.length).toBeGreaterThan(0);
    expect(r.pages.length).toBeLessThanOrEqual(3);
    all.push(...r.pages); page = r.nextPage;
  } while (page);
  expect(all.map(p => p.text).join('')).toBe(chunks.map(c => c.bounded_text).join(''));
  expect(all.every(p => p.text.length <= 12000)).toBe(true);
  let offset = 0;
  for (const page of all) {
    let text = '';
    while (text.length < page.text.length) text += chunks[offset++]!.bounded_text;
    expect(page.text).toBe(text);
  }
  expect(f.calls.flatMap(c => c.inputs.flatMap(i => i.chunkHashes ?? []))).toEqual(chunks.map(c => c.content_hash));
  expect(f.calls.every(c => c.budgetMs === 8000)).toBe(true);
});

for (const verdict of ['unread', 'Private'] as const) {
  test(`a page with one ${verdict} chunk withholds its entire text and counts held passages`, async () => {
    const f = await fixture('An ordinary orchard note. '.repeat(200));
    const chunks = f.db.query('SELECT content_hash FROM chunks ORDER BY chunk_index').all() as Array<{ content_hash: string }>;
    expect(chunks.length).toBeGreaterThan(1);
    f.allow(hash => hash !== chunks[1]!.content_hash);
    // Private receipts use the actual shared gate; the read owns no tier raise.
    if (verdict === 'Private') registerInstalledTierClassification({ forLedger: () => ({
      releaseWindows: { modelId: 'fixture-judge', promptVersion: 'fixture',
        read: key => key.contentHash === chunks[1]!.content_hash ? 'secure' : 'private' },
    }) });
    const releaseCheck = verdict === 'Private' ? createReleaseTierCheck(() => [{ ledger: f.ledger,
      corpusIds: new Set([f.store.corpusId]), stores: () => [f.store] }], () => 'allow') : f.check;
    const r = await f.read(f.item.identity.localItemId, { releaseCheck, budgetMs: 0 });
    refused(r, 'window_judging'); expect(r.nextPage).toBe(1);
    const withheld = verdict === 'Private' ? new Set(chunks.map(chunk => chunk.content_hash)).size : 1;
    expect(r.coverageNote).toBe(`${withheld} passages from 1 documents are still being checked for privacy and weren't shared. Ask again in a minute.`);
  });
}

for (const failure of ['missing', 'unsupported', 'failing'] as const) {
  test(`${failure} release check withholds and counts all requested chunks`, async () => {
    const f = await fixture();
    const { chunks, ...withoutChunks } = f.check;
    const check = failure === 'missing' ? undefined : failure === 'unsupported' ? withoutChunks
      : { ...f.check, chunks: async () => { throw new Error('fixture unavailable'); } };
    const r = await f.read(f.item.identity.localItemId, { releaseCheck: check });
    refused(r, 'window_judging'); expect(r.nextPage).toBe(1); expect(r.coverageNote).toContain('1 passages from 1 documents');
  });
}

for (const state of ['moving', 'pending', 'metadataPending', 'contentPending', 'rejudge'] as const) {
  test(`refuses unstable ledger: ${state}`, async () => {
    const f = await fixture();
    if (state === 'metadataPending' || state === 'contentPending') f.ledgerDb.exec(`UPDATE tier_items SET ${state === 'metadataPending' ? 'metadata_pending' : 'content_pending'} = 1`);
    else if (state === 'rejudge') {
      const row = f.ledger.getCurrent(f.item.identity)!;
      f.ledger.openRejudgeQuestion(f.item.identity, { expectedGeneration: row.generation, decision: { ...row, state: 'pending', decidedBy: 'sniffer', snifferId: 'windows', contentPending: true }, keepVisible: false });
    } else f.ledgerDb.query('UPDATE tier_items SET state = ?').run(state);
    refused(await f.read(f.item.identity.localItemId, { page: 1, pages: 1 }), 'held_until_judged');
    expect(f.calls).toHaveLength(0);
  });
}

for (const change of ['tier', 'override'] as const) {
  test(`rechecks ${change} during release await`, async () => {
    const f = await fixture();
    f.onCheck(() => {
      queueMicrotask(() => {
        if (change === 'tier') f.ledgerDb.exec("UPDATE tier_items SET content_tier = 'secure'");
        else f.ledger.setOverride(f.item.identity, { kind: 'tier', tier: 'secure' });
      });
    });
    refused(await f.read(f.item.identity.localItemId, { page: 1, pages: 1 }), 'not_personal');
  });
}

test('Private item in internal refused; Personal item in secure-local readable', async () => {
  const f = await fixture(); f.ledgerDb.exec("UPDATE tier_items SET content_tier = 'secure'");
  refused(await f.read(f.item.identity.localItemId, { page: 1, pages: 1 }), 'not_personal');
  const p = await fixture('Personal orchard text.', 'secure_local');
  expect((await p.read(p.item.identity.localItemId, { page: 1, pages: 1 })).pages[0]?.text).toBe('Personal orchard text.');
});

test('scope, names-only, content-private and extraction refusals contain codes only', async () => {
  const f = await fixture();
  refused(await f.read('missing', { page: 1, pages: 1 }), 'not_in_scope');
  refused(await f.read(f.item.identity.localItemId, { page: 1, pages: 1, scope: () => ({ allowed: false }) }), 'not_in_scope');
  refused(await f.read(f.item.identity.localItemId, { page: 1, pages: 1, scope: () => ({ allowed: true, contentAllowed: false }) }), 'names_only');
  const original = f.store.contentHeldPrivate.bind(f.store); f.store.contentHeldPrivate = () => true;
  refused(await f.read(f.item.identity.localItemId, { page: 1, pages: 1 }), 'content_private'); f.store.contentHeldPrivate = original;
  f.db.exec('DELETE FROM chunks');
  refused(await f.read(f.item.identity.localItemId, { page: 1, pages: 1 }), 'extraction_pending');
});


function selected(f: Awaited<ReturnType<typeof fixture>>) {
  return { corpus_id: f.store.corpusId, family: 'file', provider: 'fixture', account_scope: 'personal', provider_item_id: 'note', local_item_id: f.item.identity.localItemId };
}
function config() {
  const c = defaultConfig(); c.sourceIndex.enabled = true; c.email.enabled = true; c.email.baseUrl = 'http://worker.test/v1'; return c;
}
function client(f: Awaited<ReturnType<typeof fixture>>, scope?: NonNullable<Parameters<typeof createEmailSourceWorker>[0]>['connectorStoreReadScope']) {
  const worker = createEmailSourceWorker({ connectorStores: [f.store], sourceAnswerReleaseCheck: f.check, ...(scope ? { connectorStoreReadScope: scope } : {}) });
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

test('MCP connection revoked during a chunk release receives only the fixed refusal', async () => {
  const f = await fixture('Personal orchard.'); let active = true;
  f.onCheck(() => { queueMicrotask(() => { active = false; }); });
  const ctx = { config: config(), email: client(f), delphi: {} } as OperationContext;
  const result = await handleMcpCallTool({ params: { name: 'source_item_read', arguments: { selected_item: selected(f) } } }, () => ctx, 'remote', () => active ? 'active' : 'revoked');
  expect(active).toBe(false); expect(result.isError).toBe(true);
  expect(JSON.stringify(result)).toContain('invalid_token'); expect(JSON.stringify(result)).not.toContain('orchard');
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


test('stored hold reason and live account/filter boundaries refuse without text', async () => {
  const f = await fixture();
  refused(await f.read(f.item.identity.localItemId, { scope: () => ({ allowed: true, accountScope: 'other' }) }), 'not_in_scope');
  refused(await f.read(f.item.identity.localItemId, { scope: () => ({ allowed: true, filters: { provider: 'other' } }) }), 'not_in_scope');
  refused(await f.read(f.item.identity.localItemId, { scope: () => ({ allowed: true, contentFilters: { provider: 'other' } }) }), 'names_only');
  const row = f.ledger.getCurrent(f.item.identity)!;
  f.ledgerDb.query('UPDATE tier_items SET reasons_json = ?').run(JSON.stringify([...row.reasons, 'content:held_until_judged']));
  refused(await f.read(f.item.identity.localItemId), 'held_until_judged');
});

for (const change of ['scope', 'text', 'pending'] as const) {
  test(`rechecks ${change} after a release await`, async () => {
    const f = await fixture(); let allowed = true;
    f.onCheck(() => {
      queueMicrotask(() => {
        if (change === 'scope') allowed = false;
        if (change === 'text') f.db.query('UPDATE chunks SET bounded_text = ?').run('Changed orchard text.');
        if (change === 'pending') f.ledgerDb.exec('UPDATE tier_items SET content_pending = 1');
      });
    });
    refused(await f.read(f.item.identity.localItemId, { scope: () => ({ allowed }) }), change === 'scope' ? 'not_in_scope' : 'held_until_judged');
  });
}

test('an owner Personal override still uses the shared release check', async () => {
  const f = await fixture(); f.ledger.setOverride(f.item.identity, { kind: 'tier', tier: 'private' });
  expect((await f.read()).pages).toHaveLength(1);
  expect(f.calls).toHaveLength(1);
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


test('a held later page keeps cleared pages, resumes at the held page and carries coverage through the client', async () => {
  const f = await fixture(Array.from({ length: 2000 }, (_, i) => `Orchard note ${i}. `).join(''));
  const first = await f.read();
  const hashes = f.calls[0]!.inputs[0]!.chunkHashes!;
  f.allow(hash => hashes.includes(hash));
  const result = await client(f).sourceItemRead({ selectedItem: selected(f), pages: 3 });
  expect(result.pages).toEqual(first.pages);
  expect(result.couldNotRead).toEqual(['window_judging']);
  expect(result.nextPage).toBe(2);
  expect(result.coverageNote).toContain('from 1 documents');
  expect(JSON.stringify(result)).not.toContain('Orchard note 1999.');
  f.allow(() => true);
  const resumed = await f.read(f.item.identity.localItemId, { page: result.nextPage! });
  expect(resumed.pages[0]?.page).toBe(2);
  expect(resumed.couldNotRead).toEqual([]);
});

test('an oversized stored chunk is withheld whole', async () => {
  const f = await fixture(); f.db.query('UPDATE chunks SET bounded_text = ?').run('orchard'.repeat(2000));
  refused(await f.read(), 'extraction_pending');
  expect(f.calls).toHaveLength(0);
});

test('engine withholds when its release check is missing', async () => {
  const f = await fixture();
  const worker = createEmailSourceWorker({ connectorStores: [f.store] });
  const response = await worker.fetch(new Request('http://worker.test/v1/source/item/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ selected_item: selected(f) }) }));
  const result = await response.json() as Awaited<ReturnType<typeof f.read>>;
  refused(result, 'window_judging'); expect(result.coverageNote).toContain('1 passages from 1 documents');
});


for (const ownerDecision of ['override', 'owner_rule'] as const) {
  test(`the shared check credits an owner's ${ownerDecision} for long content without a model read`, async () => {
    const rules: OwnerTierRule[] = ownerDecision === 'owner_rule' ? [{ id: 'orchard-notes', match: { kind: 'pathPrefix', value: '/Files/' }, tier: 'private', strength: 'force' }] : [];
    const f = await fixture('An ordinary orchard note. '.repeat(200), 'internal', rules);
    if (ownerDecision === 'override') f.ledger.setOverride(f.item.identity, { kind: 'tier', tier: 'private' });
    const check = createReleaseTierCheck(() => [{ ledger: f.ledger, corpusIds: new Set([f.store.corpusId]), stores: () => [f.store] }], () => 'allow');
    const result = await f.read(f.item.identity.localItemId, { releaseCheck: check, budgetMs: 0 });
    expect(result.pages).toHaveLength(1);
    expect(result.couldNotRead).toEqual([]);
  });
}


test('revoking a Personal owner override during the release await withholds all text', async () => {
  const f = await fixture(); f.ledger.setOverride(f.item.identity, { kind: 'tier', tier: 'private' });
  f.onCheck(() => { queueMicrotask(() => f.ledger.clearOverride(f.item.identity)); });
  refused(await f.read(), 'held_until_judged');
});

test('an unread Personal item in a secure-local corpus is held and counted', async () => {
  const f = await fixture('An ordinary orchard note. ', 'secure_local');
  f.allow(() => false);
  const result = await f.read();
  refused(result, 'window_judging'); expect(result.coverageNote).toContain('1 passages from 1 documents');
});

test('a missing ledger row refuses before checking chunks', async () => {
  const f = await fixture(); f.ledgerDb.exec('DELETE FROM tier_items');
  refused(await f.read(), 'held_until_judged'); expect(f.calls).toHaveLength(0);
});
