import { afterEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { createEmailSourceWorker } from '../src/workers/engine/index.ts';
import { PERSONAL_FIRST_REASON } from '../src/workers/classification/tier-classifier.ts';
import { findOwnerTierItems } from '../src/workers/classification/tier-owner-items.ts';
import { createFileExtractionRuntime } from '../src/workers/engine/runtime/file-extraction-runtime.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createReleaseTierCheck, createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import {
  ACCOUNT, CORPORA, PROVIDER, FIXTURE_PLACEMENT, JUDGED_PERSONAL_SNIFFER,
  fixtureConnector, identityOf, openTierFixture, tempDir,
  type TierFixture,
} from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const specs = [
  { id: 'raised', name: 'orchard-raised.txt', text: 'Orchard planting notes for the spring.' },
  { id: 'ordinary', name: 'orchard-ordinary.txt', text: 'Orchard planting notes for the summer.' },
];

async function fixture() {
  const tmp = tempDir('item-ledger-exits-');
  const fx = openTierFixture(tmp.dir, { embed: false });
  cleanups.push(() => { fx.close(); tmp.cleanup(); });
  const store = fx.stores.internal!;
  // Deliberately retain Personal copies: placement and the ledger can diverge.
  await store.syncFromConnector(fixtureConnector(() => specs), {
    fetchContent: true, placement: FIXTURE_PLACEMENT, tierClassification: { sniffer: JUDGED_PERSONAL_SNIFFER },
  });
  for (const spec of specs) {
    const identity = identityOf(spec.id);
    fx.ledger.recordRoutedPlacement(identity, {
      ...fx.ledger.getCurrent(identity)!, decidedBy: 'sniffer', state: 'current', snifferId: JUDGED_PERSONAL_SNIFFER.id,
    }, { copies: [{ corpusId: store.corpusId, trustDomain: 'internal', layers: 'both' }], embedHold: false });
  }
  expect(store.localContent('personal:raised', 1)?.trustTier).toBe('S3');
  expect(fx.ledger.getCurrent(identityOf('raised'))?.contentTier).toBe('private');
  return { fx, store };
}

function raise(fx: TierFixture, change: 'target' | 'override' | 'held' | 'secret', names = false) {
  const identity = identityOf('raised');
  const record = fx.ledger.getCurrent(identity)!;
  if (change === 'override') fx.ledger.setOverride(identity, { kind: 'tier', tier: 'secure' });
  else if (change === 'held') fx.ledger.recordDecision(identity, {
    ...record, decidedBy: 'default', snifferId: JUDGED_PERSONAL_SNIFFER.id,
    metadataPending: names, contentPending: !names, state: 'pending',
  });
  else fx.ledger.beginMove(identity, {
    metadataTier: names ? (change === 'secret' ? 'secrets' : 'secure') : 'private',
    contentTier: change === 'secret' ? 'secrets' : 'secure',
  }, record.generation);
}

for (const change of ['target', 'override', 'held', 'secret'] as const) {
  test(`N1: ${change} text verdict withholds a Personal copy from Gemini`, async () => {
    const { fx, store } = await fixture();
    raise(fx, change);
    expect(store.searchItems('orchard', 10)).toHaveLength(2);
    await store.embedChunks({ provider: fx.cloud });
    expect(fx.cloud.inputs.join('\n')).not.toContain('spring');
    expect(fx.cloud.inputs.join('\n')).toContain('summer');
    // Existing Private-approved providers may still receive Private text.
    if (change !== 'secret') {
      await store.embedChunks({ provider: fx.local });
      expect(fx.local.inputs.join('\n')).toContain('spring');
    }
  });
}

test('N1: a verdict raised during an earlier dispatch is checked on the next batch', async () => {
  const { fx, store } = await fixture();
  // A prior dispatch is another classification window.
  const original = fx.cloud.embed.bind(fx.cloud);
  fx.cloud.embed = async inputs => { raise(fx, 'override'); return original(inputs); };
  // First dispatch is still Personal; a later pass must withhold after the edit.
  await store.embedChunks({ provider: fx.cloud, localItemIds: ['personal:ordinary'] });
  fx.cloud.inputs.length = 0;
  await store.embedChunks({ provider: fx.cloud, localItemIds: ['personal:raised'] });
  expect(fx.cloud.inputs).toEqual([]);
});

for (const change of ['target', 'override', 'held', 'secret'] as const) {
  test(`N16: fallback reader refuses remote extraction for ${change} text verdict`, async () => {
    const { fx, store } = await fixture();
    raise(fx, change);
    const jobsDbPath = join(fx.dir, 'jobs.sqlite');
    const lane = { corpusId: store.corpusId, provider: PROVIDER, accountScope: ACCOUNT, approvedScopeKey: 'fixture:/Files' };
    let sent = 0;
    const runtime = createFileExtractionRuntime({
      enabled: true, connectorStores: [store], jobsDbPath,
      corpora: [{ corpusId: store.corpusId, provider: PROVIDER, scopes: [lane.approvedScopeKey], maxTrustTierForRemote: 'S3' }],
      scopeGuard: { assertAuthorized() {}, allowsRef: () => true },
      sourceFactories: new Map([[PROVIDER, () => ({ id: 'fixture', corpusId: store.corpusId, provider: PROVIDER,
        listCandidates: async () => ({ candidates: [], done: true }),
        fetch: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'image/png' }),
      })]]),
      extractors: { remote: {
        localReader: { extract: async () => ({ status: 'metadata_only' }) },
        client: { describe: async () => { sent++; return { text: 'ordinary garden image' }; } },
      } },
    });
    expect(runtime).toBeDefined();
    cleanups.push(() => runtime!.close());
    // No tierSets: exercise the audited fallback, with a Personal ceiling.
    const queued = specs.map(spec => runtime!.jobs.enqueue({ refs: [{
      ...lane, providerItemId: spec.id, localItemId: `personal:${spec.id}`, sourceVersion: 'v1', mimeType: 'image/png', name: spec.name,
    }], extractorKind: 'venice_e2ee_document', extractorVersion: 'venice-v1', policyDecision: 'index_allowed' }));
    await runtime!.runner.run(lane);
    expect(sent).toBe(1); // only the unchanged Personal item
    expect(runtime!.jobs.get(queued[0]!.jobRefs[0]!.jobId)?.status).toBe('blocked_policy');
  });
}

async function search(fx: TierFixture, store: LocalConnectorStore, allTiers = false) {
  const corpusIds = new Set(Object.values(CORPORA));
  const worker = createEmailSourceWorker({
    connectorStores: [store, fx.stores.secure_local!],
    // As the engine wires it: every other corpus of the same tier lane.
    connectorStoreTierSiblings: (corpusId: string) => [...corpusIds].filter((sibling) => sibling !== corpusId),
    sourceIndexVisibilityGate: createTierVisibilityGate(() => [{ ledger: fx.ledger, corpusIds }]),
  });
  const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    // The Private path asks for Private names explicitly from a Private corpus (the private_answer audience);
    // an ordinary all-tiers search gets Personal names only, as an older client's request does.
    body: JSON.stringify(allTiers
      ? { corpus_id: CORPORA.secure_local, query: 'orchard', all_tiers: true, include_private_names: true }
      : { corpus_id: store.corpusId, query: 'orchard', all_tiers: allTiers }),
  }));
  expect(response.status).toBe(200);
  return await response.json() as { hits: unknown[]; policy: { local_only: boolean } };
}

for (const change of ['target', 'override', 'held', 'secret'] as const) {
  test(`N4: ${change} names verdict is withheld from Personal search, kept on the existing Private path`, async () => {
    const { fx, store } = await fixture();
    raise(fx, change, true);
    const personal = await search(fx, store);
    expect(JSON.stringify(personal.hits)).not.toContain('orchard-raised');
    expect(JSON.stringify(personal.hits)).toContain('orchard-ordinary');
    const privateResult = await search(fx, store, true);
    // Private names stay on the Private path; Secret names are listed on none.
    if (change === 'secret') expect(JSON.stringify(privateResult.hits)).not.toContain('orchard-raised');
    else expect(JSON.stringify(privateResult.hits)).toContain('orchard-raised');
    expect(privateResult.policy.local_only).toBe(true);
  });
}

test('N4: a content-only raise keeps Personal names visible', async () => {
  const { fx, store } = await fixture();
  raise(fx, 'target');
  expect(JSON.stringify((await search(fx, store)).hits)).toContain('orchard-raised');
});

test('Personal search withholds titles of items still held in a Personal copy', async () => {
  const { fx, store } = await fixture();
  const identity = identityOf('raised');
  const record = fx.ledger.getCurrent(identity)!;
  store.bindTierSet(fx.ledger);
  fx.ledger.recordDecision(identity, {
    ...record, decidedBy: 'default', snifferId: JUDGED_PERSONAL_SNIFFER.id,
    contentPending: true, state: 'pending', reasons: [PERSONAL_FIRST_REASON],
  });
  expect(fx.ledger.getCurrent(identity)).toMatchObject({ metadataPending: false, contentPending: true });
  expect(store.searchItems('orchard', 10)).toHaveLength(2);

  const personal = await search(fx, store);
  expect(personal.policy.local_only).toBe(false);
  expect(personal.hits).toHaveLength(1);
  expect(JSON.stringify(personal.hits)).toContain('orchard-ordinary.txt');
  expect(JSON.stringify(personal.hits)).not.toContain('orchard-raised.txt');
  const privateResult = await search(fx, store, true);
  expect(privateResult.policy.local_only).toBe(true);
  expect(JSON.stringify(privateResult.hits)).toContain('orchard-raised.txt');
});

test('privacy search withholds a held title from the agent and lets the owner preview it', async () => {
  const { fx, store } = await fixture();
  store.bindTierSet(fx.ledger);
  raise(fx, 'held');
  const context = { storePaths: [store.dbPath] };
  expect(findOwnerTierItems({ query: 'orchard-raised', personalNamesOnly: true }, context).items).toEqual([]);
  expect(findOwnerTierItems({ query: 'orchard-raised', withPreview: true }, context).items)
    .toMatchObject([{ title: 'orchard-raised.txt', preview: specs[0]!.text }]);
});

test('shared verdict: release check and store agree; no row stays legacy; unreadable ledger holds Private', async () => {
  const { fx, store } = await fixture();
  raise(fx, 'target');
  const check = createReleaseTierCheck(() => [{ ledger: fx.ledger, corpusIds: new Set([store.corpusId]) }], () => 'approval');
  const inputs = ['raised', 'ordinary', 'missing'].map(id => ({ ...identityOf(id), corpusId: store.corpusId, privateAtAnswer: false }));
  const batched = spyOn(fx.ledger, 'itemStatesForMany');
  try {
    check.inputs([...inputs, ...inputs]);
    expect(batched).toHaveBeenCalledTimes(1);
  } finally { batched.mockRestore(); }
  expect(check.inputs(inputs).map(verdict => verdict.tier)).toEqual(['private', 'public_or_personal', 'legacy']);
  expect((await check.inputsOffThread!(inputs)).map(verdict => verdict.tier)).toEqual(store.effectiveItemTiers(inputs));
  const failed = spyOn(fx.ledger, 'itemStatesForMany').mockImplementation(() => { throw new Error('ledger unavailable'); });
  try {
    expect(store.effectiveItemTiers(inputs)).toEqual(['private', 'private', 'private']);
    const personal = await search(fx, store);
    expect(personal.hits).toEqual([]);
    expect((await search(fx, store, true)).hits).toEqual([]);
  } finally { failed.mockRestore(); }
});

test('fallback reader: an unknown local id is held Private, and a verdict follows the stored identity', async () => {
  const { fx, store } = await fixture();
  expect(store.effectiveLocalItemTier('personal:not-here')).toBe('private');
  expect(store.effectiveLocalItemTier('personal:ordinary')).toBe('public_or_personal');
  raise(fx, 'override');
  expect(store.effectiveLocalItemTier('personal:raised')).toBe('private');
});
