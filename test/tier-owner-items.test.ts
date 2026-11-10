// The owner's one-item privacy change (issue #1060), end to end on a fresh
// install (the harness of tier-review-fixes-2026-10-02.test.ts): find an item,
// set it Private -> Personal -> Private, and put it back to the judge. The
// owner's word holds across a re-judge, an always-Private rules sweep and a
// worker restart (every store and ledger closed and opened again), and search
// follows it. An agent can only raise.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { isPublicTierRetired, loadSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { resolvedStorePath } from '../src/core/source-placement.ts';
import { defaultDropboxIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import {
  BUILT_IN_SNIFFER_LANE,
  registerBuiltInPrivateModel,
  registeredBuiltInPrivateModel,
  resolveTierSnifferRuntime,
} from '../src/workers/classification/built-in-sniffer.ts';
import {
  clearInstalledTierClassification,
  configureInstalledTierClassification,
} from '../src/workers/classification/installed-tier-classification.ts';
import { writePrivacyProfile } from '../src/workers/classification/privacy-profile.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { runTierCommand } from '../src/workers/classification/tier-cli.ts';
import {
  countOwnerTierItems,
  createOwnerTierItems,
  getOwnerTierItem,
  ownerTierItemId,
  parseOwnerTierItemId,
  type OwnerTierItem,
} from '../src/workers/classification/tier-owner-items.ts';
import {
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
  LocalConnectorStore,
} from '../src/workers/connector-store/index.ts';
import { applyOwnerOverrides } from '../src/workers/connector-store/tier-override-settle.ts';
import { emptyTierRejudgeReport, rejudgeStoredContent } from '../src/workers/connector-store/tier-rejudge.ts';
import { sweepOwnerRuleRaises } from '../src/workers/connector-store/tier-rules-sweep.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  createDropboxProviderStoreSyncHandler,
  createDropboxTierLane,
  type DropboxMetadataClient,
  type DropboxMetadataPage,
} from '../src/workers/dropbox-files/index.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';
import { searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';

const SECURE_CORPUS = 'secure_local.dropbox.files';
const FILES = [
  { id: 'id:garden', name: 'orchard-plan.pdf', path: '/Notes/orchard-plan.pdf', text: 'Orchard pruning plan for the apple trees this winter.' },
  { id: 'id:bank', name: 'bank letter.pdf', path: '/Notes/bank letter.pdf', text: 'Orchard loan terms from the lender, signed in March.' },
] as const;
// The judge finds the bank letter Private (financial) and the garden plan Personal.
const verdictFor = (material: string) => /loan terms|bank letter/i.test(material)
  ? '{"verdicts":[{"i":1,"tier":"private","category":"financial","confidence":0.9}]}'
  : '{"verdicts":[{"i":1,"tier":"personal","category":"ordinary","ownRecord":false,"privateKind":"none","confidence":0.97}]}';

let root: string;
let env: Record<string, string>;
let ownerWords: string | undefined;
const closers: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'olympus-owner-items-'));
  env = {
    HOME: join(root, 'home'),
    OLYMPUS_SOURCE_INGESTION_EXCLUSIONS_PATH: join(root, 'no-exclusions.json'),
    OLYMPUS_TIER_RULES_PATH: join(root, 'olympus', 'tier-rules.json'),
    OLYMPUS_PRIVACY_PROFILE_PATH: join(root, 'olympus', 'privacy.json'),
  };
  ownerWords = undefined;
});

afterEach(() => {
  closeAll();
  clearInstalledTierClassification();
  registerBuiltInPrivateModel(undefined);
  rmSync(root, { recursive: true, force: true });
});

function closeAll(): void {
  for (const close of closers.splice(0).reverse()) close();
}

const storePaths = () => [join(root, 'dropbox-secure.sqlite'), resolvedStorePath('dropbox.files', 'internal', env)];
const ownerItems = () => createOwnerTierItems({ storePaths: storePaths() });
const bankIdentity = { provider: 'dropbox', accountScope: 'personal', providerItemId: 'id:bank' };
const gardenIdentity = { provider: 'dropbox', accountScope: 'personal', providerItemId: 'id:garden' };

/**
 * Olympus started: the built-in judge registered, the Dropbox lane opened on
 * the stores and ledger at their paths, one sync, and (first start only) the
 * files' text landed. A restart closes everything and calls this again.
 */
async function start(options: { extract: boolean }) {
  registerBuiltInPrivateModel({
    model: { async complete(request) { return { text: verdictFor(JSON.stringify(request)), modelId: 'built_in' }; } },
    available: () => true,
  });
  const builtIn = registeredBuiltInPrivateModel()!;
  expect(resolveTierSnifferRuntime({ engine: loadSovereigntyEngine({ inlineConfig: loadSovereigntyPreset('no-sensitive') }), builtIn }).source).toBe('built_in');
  const policy = loadSovereigntyPreset('no-sensitive');
  const installed = configureInstalledTierClassification({
    env,
    lane: { kind: BUILT_IN_SNIFFER_LANE.kind, modelId: BUILT_IN_SNIFFER_LANE.modelId },
    ...(isPublicTierRetired(policy) ? { retirePublic: true } : {}),
    ownerContext: () => ownerWords,
  });
  const secure = new LocalConnectorStore({ dbPath: join(root, 'dropbox-secure.sqlite'), corpusId: SECURE_CORPUS, family: 'file', trustDomain: 'secure_local' });
  closers.push(() => secure.close());
  const secrets = new SecretLocationsIndex({ dbPath: join(root, 'secrets.sqlite') });
  closers.push(() => secrets.close());
  const lane = createDropboxTierLane({ secureStore: secure, env, policy: defaultDropboxIngestionPolicy(), secretLocations: secrets });
  closers.push(() => {
    lane.internal.current()?.close();
    lane.public.current()?.close();
  });
  const entries = FILES.map((file) => ({ tag: 'file' as const, id: file.id, name: file.name, pathDisplay: file.path, rev: 'r1' }));
  const metadataClient: DropboxMetadataClient = {
    supportsNativeRecursive: true,
    async listFolder(): Promise<DropboxMetadataPage> { return { entries, cursor: 'c1', hasMore: false }; },
    async listFolderContinue(): Promise<DropboxMetadataPage> { return { entries, cursor: 'c2', hasMore: false }; },
  };
  const broker = new StaticCredentialBroker([{
    handle: 'dropbox.personal', provider: 'dropbox', allowedCapabilities: ['dropbox.files.sync'], token: 'test-token', trustDomain: 'secure_local',
  }]);
  const sync = createDropboxProviderStoreSyncHandler({ store: secure, account: 'personal', broker, metadataClient, tierSet: lane.set });
  await sync.pull({ approved_scope_key: 'dropbox.personal:/' });
  if (options.extract) {
    const sink = createTieredStoreExtractionSink({ set: lane.set, syncConnectorId: 'extraction', ownerConnectorId: 'dropbox', ownershipKind: 'observed' });
    for (const file of FILES) {
      await sink.accept({
        ref: {
          corpusId: SECURE_CORPUS, provider: 'dropbox', accountScope: 'personal', approvedScopeKey: 'dropbox.personal:/',
          providerItemId: file.id, localItemId: `personal:${file.id}`, sourceVersion: 'r1',
        },
        text: file.text, extractorKind: 'local_text', extractorVersion: 'test', fetchedAt: '2026-10-01T00:00:00.000Z',
      });
    }
  }
  const service = new TierSnifferService({
    installed,
    lane: BUILT_IN_SNIFFER_LANE,
    model: builtIn.model,
    stores: () => [secure, ...[lane.internal.current()].filter((store): store is LocalConnectorStore => store !== undefined)],
    classificationLedgerPath: join(root, 'classification-ledger.jsonl'),
    modelAvailable: () => true,
    ownerContext: () => ownerWords,
    autoApproveBuiltIn: true,
    autoMoves: { localEmbeddingsOnly: () => true, embeddingLedgerPath: join(root, 'embedding-ledger.jsonl'), maxPerPass: 5 },
  });
  closers.push(() => service.stop());
  return { lane, sync, service };
}

type Install = Awaited<ReturnType<typeof start>>;

async function search(install: Install, question: string): Promise<string> {
  const raw = await searchReleasedEvidence({
    question,
    lanes: () => {
      const stores = install.lane.set.openStores();
      return {
        registry: buildSourceIndexCorpusRegistry(stores.map((store) => defineConnectorCorpus({
          corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain,
        }))),
        adapters: Object.fromEntries(stores.map((store) => [store.corpusId, createConnectorStoreCorpusAdapter({ store })])),
        contentProviders: Object.fromEntries(stores.map((store) => [store.corpusId, createConnectorStoreContentProvider({ store })])),
        visibilityGate: createTierVisibilityGate(() => [{ ledger: install.lane.ledger, corpusIds: new Set(stores.map((store) => store.corpusId)) }]),
        classificationCoverage: (searched: readonly string[]) => searched.map((corpusId) => ({
          corpusId, pendingClassificationItems: install.lane.ledger.corpusCopyCounts(corpusId).held,
        })),
      };
    },
  });
  return JSON.stringify(searchToolResult(raw));
}

const LOAN_TEXT = 'Orchard loan terms';

async function judged(): Promise<Install> {
  const install = await start({ extract: true });
  for (let pass = 0; pass < 3; pass += 1) await install.service.runOnce();
  // Judged Private, then moved there by the judge's automatic move.
  expect(install.lane.ledger.getCurrent(bankIdentity)).toMatchObject({ state: 'current', contentTier: 'secure', decidedBy: 'move' });
  expect(install.lane.ledger.getCurrent(gardenIdentity)).toMatchObject({ state: 'current', contentTier: 'private' });
  return install;
}

function bankItem(): OwnerTierItem {
  const [item] = ownerItems().find({ query: 'bank letter' }).items;
  expect(item).toBeDefined();
  return item!;
}

describe('finding an item', () => {
  test('by title, sender or file name, and the recently sorted list: the label, who decided it and the judge\'s reason', async () => {
    await judged();
    const item = bankItem();
    expect(item).toMatchObject({
      item_id: ownerTierItemId(bankIdentity),
      source: 'dropbox',
      family: 'file',
      title: 'bank letter.pdf',
      tier: 'Private',
      decided_by: 'move',
      owner_set: false,
    });
    expect(item.judge_reason).toStartWith('financial');
    // A file name in the path finds it too; the words are matched literally.
    expect(ownerItems().find({ query: '/Notes/bank' }).items.map((found) => found.title)).toEqual(['bank letter.pdf']);
    expect(ownerItems().find({ query: '%' }).items).toEqual([]);
    const recent = ownerItems().find({ recent: true }).items.map((found) => found.title).sort();
    expect(recent).toEqual(['bank letter.pdf', 'orchard-plan.pdf']);
    expect(parseOwnerTierItemId(item.item_id)).toEqual(bankIdentity);
    expect(() => parseOwnerTierItemId('oti_bm9wZQ')).toThrow('item_id');
  });

  test('the dashboard reads the start of what the item says; an agent never does', async () => {
    await judged();
    expect(ownerItems().find({ query: 'bank letter', withPreview: true }).items[0]?.preview).toBe(FILES[1].text);
    expect(ownerItems().find({ query: 'bank letter' }).items[0]).not.toHaveProperty('preview');
    expect(ownerItems().find({ query: 'bank', withPreview: true, personalNamesOnly: true }).items[0]).not.toHaveProperty('preview');
  });

  test('the dashboard\'s filters and counts: by label, and the items the owner changed', async () => {
    await judged();
    const titles = (filter: 'personal' | 'private' | 'changed') => ownerItems().find({ recent: true, filter }).items.map((found) => found.title);
    expect(countOwnerTierItems({ storePaths: storePaths() })).toEqual({ personal: 1, private: 1, changed: 0 });
    expect(titles('private')).toEqual(['bank letter.pdf']);
    expect(titles('personal')).toEqual(['orchard-plan.pdf']);
    expect(titles('changed')).toEqual([]);
    // Paging further back: only items decided before the given time.
    const [newest, older] = ownerItems().find({ recent: true }).items;
    expect(ownerItems().find({ recent: true, before: newest!.decided_at! }).items.map((found) => found.item_id))
      .toEqual(older && older.decided_at! < newest!.decided_at! ? [older.item_id] : []);
    // With the last item as well, a page resumes right after it, even when both were decided at the same moment.
    const [first] = ownerItems().find({ recent: true, limit: 1 }).items;
    expect(first?.item_id).toBe(newest!.item_id);
    expect(ownerItems().find({ recent: true, limit: 1, before: first!.decided_at!, beforeItem: first!.item_id }).items.map((found) => found.item_id))
      .toEqual([older!.item_id]);
    expect(() => ownerItems().find({ recent: true, beforeItem: first!.item_id })).toThrow('beforeItem');
    expect(() => ownerItems().find({ recent: true, before: 'not a time' })).toThrow('before');
    expect(() => ownerItems().find({ query: 'bank', filter: 'private' })).toThrow('filter');
    ownerItems().set({ itemId: bankItem().item_id, choice: 'personal', allowLower: true });
    expect(titles('changed')).toEqual(['bank letter.pdf']);
    expect(ownerItems().counts!()).toMatchObject({ changed: 1 });
  });

  test('one item by its id, with its preview; a Secret or unknown item is not returned', async () => {
    await judged();
    const itemId = bankItem().item_id;
    expect(getOwnerTierItem(itemId, { storePaths: storePaths() }, { withPreview: true })).toMatchObject({ title: 'bank letter.pdf', tier: 'Private', preview: FILES[1].text });
    expect(getOwnerTierItem(ownerTierItemId({ ...bankIdentity, providerItemId: 'id:none' }), { storePaths: storePaths() })).toBeUndefined();
    await runTierCommand(['set', 'id:bank', 'secrets'], { storePaths: storePaths() });
    expect(getOwnerTierItem(itemId, { storePaths: storePaths() })).toBeUndefined();
  });

  test('for an agent, an item whose names are Private is left out', async () => {
    await judged();
    // The bank letter's names stay Personal (only its text is Private): listed.
    expect(ownerItems().find({ query: 'bank', personalNamesOnly: true }).items).toHaveLength(1);
    await runTierCommand(['set', 'id:garden', 'private'], { storePaths: storePaths() });
    expect(ownerItems().find({ query: 'orchard-plan', personalNamesOnly: true }).items).toEqual([]);
    expect(ownerItems().find({ query: 'orchard-plan' }).items).toHaveLength(1);
  });
});

describe('one item, Private -> Personal -> Private', () => {
  test('holds across a re-judge, a rules sweep and a restart; search follows; the agent can only raise; undo goes back to the judge', async () => {
    let install = await judged();
    expect(await search(install, 'loan terms')).not.toContain(LOAN_TEXT);
    const itemId = bankItem().item_id;

    // An agent cannot lower it.
    expect(ownerItems().set({ itemId, choice: 'personal', allowLower: false })).toMatchObject({ ok: false, code: 'dashboard_only' });
    expect(ownerItems().set({ itemId, choice: 'judge', allowLower: false })).toMatchObject({ ok: false, code: 'dashboard_only' });
    expect(install.lane.ledger.getOverride(bankIdentity)).toBeUndefined();

    // The owner, on the dashboard: Personal. It applies at the next pass and then serves.
    expect(ownerItems().set({ itemId, choice: 'personal', allowLower: true })).toMatchObject({ ok: true, changed: 'set', applies: 'next_pass' });
    await install.service.runOnce();
    expect(install.lane.ledger.getCurrent(bankIdentity)).toMatchObject({ state: 'current', metadataTier: 'private', contentTier: 'private', decidedBy: 'override' });
    expect(await search(install, 'loan terms')).toContain(LOAN_TEXT);
    expect(bankItem()).toMatchObject({ tier: 'Personal', decided_by: 'override', owner_set: true });

    // A re-judge leaves the owner's word alone, whatever the judge would say now.
    ownerWords = 'Anything about money is private.';
    const report = emptyTierRejudgeReport();
    rejudgeStoredContent(install.lane.set, install.lane.ledger.getCurrent(bankIdentity)!, { report, autoMoves: true });
    expect(report.skipped).toBe(1);
    await install.service.runOnce();
    expect(install.lane.ledger.getCurrent(bankIdentity)).toMatchObject({ contentTier: 'private', decidedBy: 'override' });

    // An always-Private folder rule raises the folder's other file, not this one.
    writePrivacyProfile({ rules: [{ kind: 'folder', source_id: 'dropbox.files', key: '/Notes' }] }, { env });
    expect(sweepOwnerRuleRaises({ set: install.lane.set })).toMatchObject({ raised: 1, complete: true });
    expect(install.lane.ledger.getCurrent(gardenIdentity)).toMatchObject({ targetContentTier: 'secure', decidedBy: 'owner_rule' });
    expect(install.lane.ledger.getCurrent(bankIdentity)).toMatchObject({ state: 'current', contentTier: 'private', decidedBy: 'override' });
    writePrivacyProfile({ rules: [] }, { env });
    expect(await search(install, 'loan terms')).toContain(LOAN_TEXT);

    // A restart: every store and ledger closed and opened again, then an unchanged sync and a tick.
    closeAll();
    clearInstalledTierClassification();
    install = await start({ extract: false });
    await install.service.runOnce();
    expect(install.lane.ledger.getOverride(bankIdentity)).toEqual({ kind: 'tier', tier: 'private' });
    expect(install.lane.ledger.getCurrent(bankIdentity)).toMatchObject({ state: 'current', contentTier: 'private', decidedBy: 'override' });
    expect(await search(install, 'loan terms')).toContain(LOAN_TEXT);

    // An agent raises it back to Private: hidden at once, before any tick.
    const raised = ownerItems().set({ itemId, choice: 'private', allowLower: false });
    expect(raised).toMatchObject({ ok: true, changed: 'set' });
    expect(await search(install, 'loan terms')).not.toContain(LOAN_TEXT);
    await install.service.runOnce();
    expect(install.lane.ledger.getCurrent(bankIdentity)).toMatchObject({ state: 'current', contentTier: 'secure', decidedBy: 'override' });
    expect(await search(install, 'loan terms')).not.toContain(LOAN_TEXT);

    // Personal again, then undo: back to the judge's Private, hidden first, decided by the judge again.
    ownerItems().set({ itemId, choice: 'personal', allowLower: true });
    await install.service.runOnce();
    expect(await search(install, 'loan terms')).toContain(LOAN_TEXT);
    expect(ownerItems().set({ itemId, choice: 'judge', allowLower: true })).toMatchObject({ ok: true, changed: 'cleared', applies: 'next_pass' });
    expect(applyOwnerOverrides({ set: install.lane.set })).toMatchObject({ restored: 1 });
    expect(await search(install, 'loan terms')).not.toContain(LOAN_TEXT);
    await install.service.runOnce();
    const restored = install.lane.ledger.getCurrent(bankIdentity)!;
    expect(restored).toMatchObject({ state: 'current', contentTier: 'secure' });
    expect(restored.decidedBy).not.toBe('override');
    expect(restored.reasons.some((reason) => reason.startsWith('override:'))).toBe(false);
    expect(bankItem()).toMatchObject({ tier: 'Private', owner_set: false });
    expect(bankItem().judge_reason).toStartWith('financial');
    expect(await search(install, 'loan terms')).not.toContain(LOAN_TEXT);
    // Nothing left to restore, and undo on an item nobody set says so.
    expect(applyOwnerOverrides({ set: install.lane.set })).toMatchObject({ restored: 0 });
    expect(ownerItems().set({ itemId, choice: 'judge', allowLower: true })).toMatchObject({ ok: false, code: 'not_owner_set' });
  });

  test('undo under an always-Private rule added while the owner\'s word stood: the rule holds, across a restart', async () => {
    let install = await judged();
    const gardenId = ownerItems().find({ query: 'orchard-plan' }).items[0]!.item_id;
    expect(await search(install, 'pruning plan')).toContain('Orchard pruning plan');

    // Judged Personal; the owner makes it Private by hand.
    expect(ownerItems().set({ itemId: gardenId, choice: 'private', allowLower: true })).toMatchObject({ ok: true, changed: 'set' });
    await install.service.runOnce();
    expect(install.lane.ledger.getCurrent(gardenIdentity)).toMatchObject({ state: 'current', contentTier: 'secure', decidedBy: 'override' });

    // An always-Private folder rule arrives while the override stands: the sweep leaves the item alone and counts itself done.
    writePrivacyProfile({ rules: [{ kind: 'folder', source_id: 'dropbox.files', key: '/Notes' }] }, { env });
    expect(sweepOwnerRuleRaises({ set: install.lane.set })).toMatchObject({ complete: true });
    expect(install.lane.ledger.getCurrent(gardenIdentity)).toMatchObject({ decidedBy: 'override' });

    // A restart, then the owner puts it back to the judge.
    closeAll();
    clearInstalledTierClassification();
    install = await start({ extract: false });
    await install.service.runOnce();
    expect(ownerItems().set({ itemId: gardenId, choice: 'judge', allowLower: true })).toMatchObject({ ok: true, changed: 'cleared' });
    expect(applyOwnerOverrides({ set: install.lane.set })).toMatchObject({ restored: 1 });

    // The rule, not the judge's Personal, decides it now: still Private, never served in between.
    const restored = install.lane.ledger.getCurrent(gardenIdentity)!;
    expect(restored).toMatchObject({ contentTier: 'secure', metadataTier: 'secure', decidedBy: 'owner_rule' });
    expect(restored.reasons.some((reason) => reason.startsWith('metadata:owner_rule:pathPrefix:'))).toBe(true);
    expect(await search(install, 'pruning plan')).not.toContain('Orchard pruning plan');
    for (let pass = 0; pass < 2; pass += 1) await install.service.runOnce();
    expect(install.lane.ledger.getCurrent(gardenIdentity)).toMatchObject({ state: 'current', contentTier: 'secure', decidedBy: 'owner_rule' });
    expect(await search(install, 'pruning plan')).not.toContain('Orchard pruning plan');
    expect(applyOwnerOverrides({ set: install.lane.set })).toMatchObject({ restored: 0 });
  });

  test('a Secret item is neither listed nor changed', async () => {
    await judged();
    const itemId = bankItem().item_id;
    await runTierCommand(['set', 'id:bank', 'secrets'], { storePaths: storePaths() });
    expect(ownerItems().set({ itemId, choice: 'personal', allowLower: true })).toMatchObject({ ok: false, code: 'secret_item' });
    expect(ownerItems().set({ itemId, choice: 'private', allowLower: false })).toMatchObject({ ok: false, code: 'secret_item' });
    expect(ownerItems().find({ query: 'bank letter' }).items).toEqual([]);
  });
});
