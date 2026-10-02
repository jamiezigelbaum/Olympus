// Tier classification review fixes (2026-10-02), end to end on a fresh
// install (the harness of fresh-install-tiers.test.ts):
//
// 1. A Personal item an automatic move left a superseded copy of, raised
//    again later, moves back even when its text changed meanwhile (the
//    automatic move replaces its own earlier superseded copy); a move that
//    keeps failing goes to the back of the queue.
// 2. A re-judge never hides an item pending an answer: it asks while the
//    item stays where it is, and only a Private verdict raises it. With
//    automatic moves off, nothing is hidden: the raise waits, visible, for
//    the owner-approved migration.
// 3. An "always Private" rule saved later raises items already stored.
// 4. A re-judge that finds a secret in stored text hides it at once and
//    hands it to the Secrets policy.
// 6. The sniffer starts a model download that never started.
// 7. A re-judge that changes nothing is not repeated every tick, and a page
//    reads a bounded window of the ledger.
// 9. The built-in default approval is never signed as the owner (see
//    fresh-install-tiers.test.ts) and a revocation sticks.
// 10. olympus_search does not preempt the sniffer.
// T-1. A private lane that exists but is not ready holds read items.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalystModelRequest } from '../src/core/analyst.ts';
import { OLYMPUS_SENSITIVITY_MAP_ENV } from '../src/core/sensitivity-map.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { isPublicTierRetired, loadSovereigntyEngine, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { STANDALONE_SOVEREIGNTY_PRESET } from '../src/core/engine-service.ts';
import { searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import {
  BUILT_IN_SNIFFER_LANE,
  registerBuiltInPrivateModel,
  registeredBuiltInPrivateModel,
  resolveTierSnifferRuntime,
  type BuiltInPrivateModel,
} from '../src/workers/classification/built-in-sniffer.ts';
import {
  clearInstalledTierClassification,
  configureInstalledTierClassification,
} from '../src/workers/classification/installed-tier-classification.ts';
import { writePrivacyProfile } from '../src/workers/classification/privacy-profile.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { classifyItemTiers, TIER_CLASSIFIER_VERSION, type TierDecision } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger, type TierPlacementPlan } from '../src/workers/classification/tier-ledger.ts';
import {
  CLASSIFICATION_LEDGER_OWNER_APPROVAL,
  isClassifierApproved,
  type ClassificationLedgerEntry,
} from '../src/workers/classification-ledger.ts';
import {
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
  LocalConnectorStore,
} from '../src/workers/connector-store/index.ts';
import { moveTieredItem, TierMoveRefusedError } from '../src/workers/connector-store/tier-move.ts';
import { defaultStoreTrustTier } from '../src/workers/connector-store/tier-placement.ts';
import { settleNamesOnlyItems } from '../src/workers/connector-store/tier-names-only-settle.ts';
import { sweepOwnerRuleRaises } from '../src/workers/connector-store/tier-rules-sweep.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import { defaultDropboxIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import {
  createDropboxProviderStoreSyncHandler,
  createDropboxTierLane,
  type DropboxMetadataClient,
  type DropboxMetadataPage,
} from '../src/workers/dropbox-files/index.ts';
import { readEmbeddingLedger } from '../src/workers/embedding-ledger.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';
import { searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';

// Built at runtime: the repository refuses literal credential patterns.
const FAKE_AWS_KEY = ['AKIA', 'QRSTUVWXYZ234567'].join('');
const SECURE_CORPUS = 'secure_local.dropbox.files';
const INTERNAL_CORPUS = 'internal.dropbox.files';

const FILES = [
  { id: 'id:garden', name: 'orchard-plan.pdf', path: '/Notes/orchard-plan.pdf', text: 'Orchard pruning plan for the apple trees this winter.' },
  { id: 'id:bank', name: 'bank letter.pdf', path: '/Notes/bank letter.pdf', text: 'Orchard loan terms from the lender, signed in March.' },
] as const;

const PRIVATE_VERDICT = '{"verdicts":[{"i":1,"tier":"private","category":"financial","confidence":0.9}]}';
const PERSONAL_VERDICT = '{"verdicts":[{"i":1,"tier":"personal","category":"ordinary","confidence":0.97}]}';

let root: string;
let env: Record<string, string>;
const closers: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'olympus-tier-fixes-'));
  env = {
    OLYMPUS_SOURCE_INDEX_DROPBOX_INTERNAL_CONNECTOR_STORE_DB_PATH: join(root, 'dropbox-internal.sqlite'),
    OLYMPUS_SOURCE_INDEX_DROPBOX_PUBLIC_CONNECTOR_STORE_DB_PATH: join(root, 'dropbox-public.sqlite'),
    OLYMPUS_SOURCE_INGESTION_EXCLUSIONS_PATH: join(root, 'no-exclusions.json'),
    OLYMPUS_TIER_RULES_PATH: join(root, 'olympus', 'tier-rules.json'),
    OLYMPUS_PRIVACY_PROFILE_PATH: join(root, 'olympus', 'privacy.json'),
    [OLYMPUS_SENSITIVITY_MAP_ENV]: join(root, 'olympus', 'sensitivity-map.json'),
  };
});

afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  clearInstalledTierClassification();
  registerBuiltInPrivateModel(undefined);
  rmSync(root, { recursive: true, force: true });
});

let ownerWords: string | undefined;

async function freshInstall(options: { lane?: typeof BUILT_IN_SNIFFER_LANE; extract?: boolean } = {}) {
  ownerWords = undefined;
  const policy = loadSovereigntyPreset(STANDALONE_SOVEREIGNTY_PRESET);
  const installed = configureInstalledTierClassification({
    env,
    ...(options.lane ? { lane: { kind: options.lane.kind, modelId: options.lane.modelId } } : {}),
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
  const sink = createTieredStoreExtractionSink({ set: lane.set, syncConnectorId: 'extraction', ownerConnectorId: 'dropbox', ownershipKind: 'observed' });
  for (const file of options.extract === false ? [] : FILES) {
    await sink.accept({
      ref: {
        corpusId: SECURE_CORPUS,
        provider: 'dropbox',
        accountScope: 'personal',
        approvedScopeKey: 'dropbox.personal:/',
        providerItemId: file.id,
        localItemId: `personal:${file.id}`,
        sourceVersion: 'r1',
      },
      text: file.text,
      extractorKind: 'local_text',
      extractorVersion: 'test',
      fetchedAt: '2026-10-01T00:00:00.000Z',
    });
  }
  return { installed, secure, secrets, lane, sync };
}

type Install = Awaited<ReturnType<typeof freshInstall>>;

async function olympusSearch(install: Install, question: string): Promise<string> {
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

const identity = (id: string) => ({ provider: 'dropbox', accountScope: 'personal', providerItemId: id });
const garden = identity('id:garden');

/** The worker's boot order: register the built-in model, then resolve the sniffer from the registry. */
function registeredBuiltIn(verdict: string | ((request: AnalystModelRequest) => string), available: () => boolean = () => true) {
  const prompts: AnalystModelRequest[] = [];
  let started = 0;
  registerBuiltInPrivateModel({
    model: {
      async complete(request) {
        prompts.push(request);
        return { text: typeof verdict === 'string' ? verdict : verdict(request), modelId: 'built_in' };
      },
    },
    available,
    startIfIdle: () => { started += 1; },
  });
  const builtIn = registeredBuiltInPrivateModel()!;
  const runtime = resolveTierSnifferRuntime({
    engine: loadSovereigntyEngine({ inlineConfig: loadSovereigntyPreset(STANDALONE_SOVEREIGNTY_PRESET) }),
    builtIn,
  });
  expect(runtime.source).toBe('built_in');
  return { prompts, builtIn, started: () => started };
}

function snifferFor(install: Install, builtIn: BuiltInPrivateModel, options: { localEmbeddingsOnly?: boolean; maxPerPass?: number } = {}) {
  const service = new TierSnifferService({
    installed: install.installed,
    lane: BUILT_IN_SNIFFER_LANE,
    model: builtIn.model,
    stores: () => [install.secure, ...[install.lane.internal.current()].filter((store): store is LocalConnectorStore => store !== undefined)],
    classificationLedgerPath: join(root, 'classification-ledger.jsonl'),
    modelAvailable: () => builtIn.available(),
    startModel: () => builtIn.startIfIdle?.(),
    ownerContext: () => ownerWords,
    autoApproveBuiltIn: true,
    autoMoves: {
      localEmbeddingsOnly: () => options.localEmbeddingsOnly ?? true,
      embeddingLedgerPath: join(root, 'embedding-ledger.jsonl'),
      maxPerPass: options.maxPerPass ?? 5,
    },
  });
  closers.push(() => service.stop());
  return service;
}

/** Garden judged Personal by the model and moved there: its held copy stays kept (superseded) in the Private store. */
async function gardenSettledPersonal(verdict: string | ((request: AnalystModelRequest) => string) = PERSONAL_VERDICT) {
  const model = registeredBuiltIn(verdict);
  const install = await freshInstall({ lane: BUILT_IN_SNIFFER_LANE });
  const service = snifferFor(install, model.builtIn);
  for (let pass = 0; pass < 3; pass += 1) await service.runOnce();
  expect(install.lane.ledger.getCurrent(garden)).toMatchObject({ state: 'current', contentTier: 'private' });
  expect(install.lane.ledger.copies(garden).find((copy) => copy.corpusId === SECURE_CORPUS)).toMatchObject({ state: 'superseded' });
  return { install, service, ...model };
}

/** Rewrite an item's text in its Personal store (a later sync of a changed file), leaving its ledger row as it was. */
function rewriteInternalText(install: Install, id: string, text: string): void {
  const internal = install.lane.internal.current()!;
  const copy = internal.exportItemCopy(identity(id))!;
  internal.importItemCopy({
    ...copy,
    chunks: [{ chunkIndex: 0, boundedText: text, contentHash: `h-${text.length}-${text.slice(0, 8)}`, embeddingInputHash: null }],
    vectors: [],
    vectorAuthorities: [],
  }, { trustTier: defaultStoreTrustTier('internal'), syncConnectorId: 'test-resync' });
}

describe('1. a raise back into a store that kept an older copy, and refused moves', () => {
  test('ported probe: Personal after an automatic move, then new owner words: the item is never hidden and never stuck', async () => {
    const { install, service } = await gardenSettledPersonal();
    expect(await olympusSearch(install, 'orchard')).toContain('pruning plan');
    ownerWords = 'My health and money matters.';
    for (let pass = 0; pass < 3; pass += 1) {
      const tick = await service.runOnce();
      expect(tick.state).toBe('ran');
      // Visible after every tick: the re-judge asked, and the model said Personal again.
      expect(await olympusSearch(install, 'orchard')).toContain('pruning plan');
      expect(install.lane.ledger.getCurrent(garden)!.state).toBe('current');
    }
    const after = install.lane.ledger.getCurrent(garden)!;
    expect(after).toMatchObject({ state: 'current', contentTier: 'private' });
    expect(after.reasons.some((reason) => reason.startsWith('content:sniffer:local:') && reason.includes('.o'))).toBe(true);
    expect(install.lane.ledger.listMoving()).toEqual([]);
  });

  test('a raise back into the Private store whose kept copy holds OLDER text completes (the automatic move replaces it)', async () => {
    const { install, service } = await gardenSettledPersonal();
    rewriteInternalText(install, 'id:garden', 'Orchard grafting notes, revised for spring.');
    const settled = install.lane.ledger.getCurrent(garden)!;
    const held: TierDecision = {
      ...classifyItemTiers({ signals: { title: 'orchard-plan.pdf' }, text: 'x' }),
      metadataTier: 'private',
      contentTier: 'secure',
      decidedBy: 'sniffer',
      reasons: ['metadata:default:personal', 'content:sniffer:local:test:financial:0.90'],
      state: 'current',
      contentRead: true,
      contentPending: false,
      metadataPending: false,
      engineVersion: settled.engineVersion,
      mapRevision: settled.mapRevision,
    };
    // The migration's path (no replacement) still refuses: nothing it keeps is lost.
    const refusedLedger = install.lane.ledger;
    expect(refusedLedger.recordRoutedPlacement(garden, held, install.lane.set.placementFor(held))).toMatchObject({ outcome: 'queued_move', raise: true });
    await expect(moveTieredItem({ set: install.lane.set, identity: { ...garden, family: 'file', localItemId: 'personal:id:garden' }, target: { metadataTier: 'private', contentTier: 'secure' } }))
      .rejects.toBeInstanceOf(TierMoveRefusedError);
    expect(await olympusSearch(install, 'grafting')).not.toContain('grafting notes');

    // The automatic move replaces its own earlier copy and lands the item.
    expect(await service.runOnce()).toMatchObject({ state: 'ran', autoMoves: { moved: 1, failed: 0 } });
    expect(install.lane.ledger.getCurrent(garden)).toMatchObject({ state: 'current', contentTier: 'secure' });
    expect(install.secure.exportItemCopy(garden)!.chunks.map((chunk) => chunk.boundedText).join(' ')).toContain('grafting notes');
    expect(install.lane.ledger.listMoving()).toEqual([]);
    const ledger = await readEmbeddingLedger(join(root, 'embedding-ledger.jsonl'));
    expect(ledger.entries.some((entry) => entry.what.includes('Replaced an older superseded copy'))).toBe(true);
  });

  test('a move that keeps failing goes to the back of the queue', () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    try {
      const plan: TierPlacementPlan = { copies: [{ corpusId: INTERNAL_CORPUS, trustDomain: 'internal', layers: 'both' }], embedHold: false };
      const decision = classifyItemTiers({ signals: { title: 'a.pdf' }, text: 'plain notes' });
      for (const id of ['a', 'b', 'c']) {
        ledger.recordRoutedPlacement(identity(id), decision, plan);
        ledger.beginMove(identity(id), { metadataTier: 'private', contentTier: 'secure' }, 1);
      }
      expect(ledger.listMoving({ limit: 1 }).map((record) => record.providerItemId)).toEqual(['a']);
      expect(ledger.recordMoveFailure(identity('a'), { expectedGeneration: 1 })).toBe(1);
      expect(ledger.recordMoveFailure(identity('b'), { expectedGeneration: 1 })).toBe(1);
      expect(ledger.recordMoveFailure(identity('a'), { expectedGeneration: 1 })).toBe(2);
      expect(ledger.listMoving().map((record) => record.providerItemId)).toEqual(['c', 'b', 'a']);
      // A stale generation counts nothing.
      expect(ledger.recordMoveFailure(identity('c'), { expectedGeneration: 7 })).toBe(0);
    } finally {
      ledger.close();
    }
  });
});

describe('2. a re-judge asks while the item stays where it is', () => {
  test('with automatic moves off, a Private verdict queues the raise with the item still visible (the migration\'s proposal)', async () => {
    const { install } = await gardenSettledPersonal();
    // A new prompt version: the re-judge asks, and the model now says Private.
    const model = registeredBuiltIn(PRIVATE_VERDICT);
    const service = snifferFor(install, model.builtIn, { localEmbeddingsOnly: false });
    ownerWords = 'Anything about my garden.';
    const first = await service.runOnce();
    // Both Personal files are asked about; both answers are Private.
    expect(first).toMatchObject({ state: 'ran', rejudged: { asked: 2 }, report: { resolvedPrivate: 2, movesQueued: 2 } });
    expect((first as { autoMoves?: unknown }).autoMoves).toBeUndefined();
    const record = install.lane.ledger.getCurrent(garden)!;
    expect(record).toMatchObject({ state: 'moving', targetContentTier: 'secure', contentTier: 'private' });
    // Never hidden: its Personal copy stays current until an approved migration moves it.
    expect(install.lane.ledger.copies(garden).find((copy) => copy.state === 'current' && copy.layers !== 'metadata'))
      .toMatchObject({ corpusId: INTERNAL_CORPUS });
    expect(await olympusSearch(install, 'orchard')).toContain('pruning plan');
  });

  test('a newer decision makes an open re-judge question stale (the newer decision stands)', async () => {
    const { install } = await gardenSettledPersonal();
    const record = install.lane.ledger.getCurrent(garden)!;
    const decision: TierDecision = {
      ...classifyItemTiers({ signals: { title: 'orchard-plan.pdf' }, text: 'x' }),
      metadataTier: 'private', contentTier: 'private', state: 'pending', contentPending: true, contentRead: true,
      engineVersion: record.engineVersion, mapRevision: record.mapRevision,
    };
    expect(install.lane.ledger.openRejudgeQuestion(garden, {
      expectedGeneration: record.generation, decision, keepVisible: false,
    })).toBe(true);
    expect(install.lane.ledger.rejudgeQuestion(garden)).toBeDefined();
    // An override (or any newer decision) re-decides the row.
    install.lane.ledger.recordRoutedPlacement(garden, { ...decision, reasons: ['metadata:default:personal', 'content:no_raise'], state: 'current', contentPending: false, decidedBy: 'default' }, install.lane.set.placementFor({ ...decision, state: 'current', contentPending: false }));
    expect(install.lane.ledger.rejudgeQuestion(garden)).toBeUndefined();
  });

  test('while its question is open the row is no candidate; once a newer decision makes it stale it is one again', () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    try {
      const plan: TierPlacementPlan = { copies: [{ corpusId: INTERNAL_CORPUS, trustDomain: 'internal', layers: 'both' }], embedHold: false };
      const old: TierDecision = { ...classifyItemTiers({ signals: { title: 'a.pdf' }, text: 'plain notes' }), engineVersion: '2026-09-30.p0' };
      ledger.recordRoutedPlacement(garden, old, plan);
      const key = { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: 's' };
      expect(ledger.listRejudgeCandidates(key)).toHaveLength(1);
      expect(ledger.openRejudgeQuestion(garden, { expectedGeneration: 1, decision: { ...old, state: 'pending', contentPending: true }, keepVisible: false })).toBe(true);
      expect(ledger.listRejudgeCandidates(key)).toHaveLength(0);
      // A listing re-records the names (still the old content decision).
      ledger.recordRoutedPlacement(garden, { ...old, reasons: [...old.reasons, 'metadata:relisted'] }, plan);
      expect(ledger.rejudgeQuestion(garden)).toBeUndefined();
      expect(ledger.listRejudgeCandidates(key)).toHaveLength(1);
    } finally {
      ledger.close();
    }
  });
});

describe('3. an always-Private rule saved later raises items already stored', () => {
  test('with no private model at all: the matching stored item is raised (hidden first), once', async () => {
    const install = await freshInstall();
    expect(install.lane.ledger.getCurrent(garden)).toMatchObject({ state: 'current', contentTier: 'private' });
    expect(await olympusSearch(install, 'orchard')).toContain('pruning plan');
    // Nothing new yet: the first sweep reads every routed item once.
    expect(sweepOwnerRuleRaises({ set: install.lane.set })).toMatchObject({ raised: 0, complete: true });

    writePrivacyProfile({ rules: [{ kind: 'folder', source_id: 'dropbox.files', key: '/Notes' }] }, { env });
    const report = sweepOwnerRuleRaises({ set: install.lane.set });
    // Both files sit in /Notes: the bank letter (held for its names) is raised too.
    expect(report).toMatchObject({ raised: 2, complete: true });
    const raised = install.lane.ledger.getCurrent(garden)!;
    expect(raised).toMatchObject({ state: 'moving', targetMetadataTier: 'secure', targetContentTier: 'secure', decidedBy: 'owner_rule' });
    expect(raised.reasons.some((reason) => reason.startsWith('metadata:owner_rule:pathPrefix:'))).toBe(true);
    // Hidden at once: a protection increase needs nobody's approval.
    expect(await olympusSearch(install, 'orchard')).not.toContain('pruning plan');
    // Applied once: the same rules sweep nothing again.
    expect(sweepOwnerRuleRaises({ set: install.lane.set })).toMatchObject({ scanned: 0, raised: 0 });
  });

  test('with the built-in model and automatic moves: the sniffer tick raises and moves the stored item', async () => {
    const { install, service } = await gardenSettledPersonal();
    writePrivacyProfile({ rules: [{ kind: 'folder', source_id: 'dropbox.files', key: '/notes/' }] }, { env });
    await service.runOnce();
    expect(install.lane.ledger.getCurrent(garden)).toMatchObject({ state: 'current', metadataTier: 'secure', contentTier: 'secure' });
    expect(await olympusSearch(install, 'orchard')).not.toContain('pruning plan');
  });

  test('a rule that matches nothing stored, or that would lower, changes nothing', async () => {
    const install = await freshInstall();
    writePrivacyProfile({ rules: [{ kind: 'folder', source_id: 'dropbox.files', key: '/Elsewhere' }] }, { env });
    expect(sweepOwnerRuleRaises({ set: install.lane.set })).toMatchObject({ raised: 0 });
    expect(install.lane.ledger.getCurrent(garden)).toMatchObject({ state: 'current', contentTier: 'private' });
  });
});

describe('4. a re-judge that finds a secret in stored text', () => {
  test('hides every copy at once, records the location, and tombstones the copies (the Secrets policy)', async () => {
    const { install, service } = await gardenSettledPersonal();
    rewriteInternalText(install, 'id:garden', `orchard irrigation controller key ${FAKE_AWS_KEY} for the pump`);
    // Decided under an older classifier: a re-judge candidate.
    const record = install.lane.ledger.getCurrent(garden)!;
    const older: TierDecision = {
      ...classifyItemTiers({ signals: { title: 'orchard-plan.pdf' }, text: 'x' }),
      metadataTier: record.metadataTier, contentTier: record.contentTier, decidedBy: 'default',
      reasons: ['metadata:default:personal', 'content:no_raise'], state: 'current', contentRead: true,
      contentPending: false, metadataPending: false, engineVersion: '2026-09-30.p0', mapRevision: record.mapRevision,
    };
    install.lane.ledger.recordRoutedPlacement(garden, older, install.lane.set.placementFor(older));
    const tick = await service.runOnce();
    expect(tick).toMatchObject({ state: 'ran', rejudged: { secrets: 1 } });
    expect(install.lane.ledger.getCurrent(garden)).toMatchObject({ contentTier: 'secrets' });
    expect(install.lane.ledger.copies(garden)).toEqual([]);
    expect(install.lane.internal.current()!.exportItemCopy(garden)).toBeUndefined();
    expect(install.secure.exportItemCopy(garden)).toBeUndefined();
    expect(install.secrets.get(garden)).toMatchObject({ providerItemId: 'id:garden', findingKinds: expect.arrayContaining([expect.any(String)]) });
    const everything = await olympusSearch(install, 'orchard irrigation');
    expect(everything).not.toContain(FAKE_AWS_KEY);
    expect(everything).not.toContain('irrigation controller');
  });
});

describe('6 and T-1. a private model that is not ready', () => {
  test('read items wait for it (never Personal before it judges them), and the sniffer starts its download', async () => {
    let ready = false;
    const model = registeredBuiltIn(PERSONAL_VERDICT, () => ready);
    const install = await freshInstall({ lane: BUILT_IN_SNIFFER_LANE });
    // The built-in lane exists but its model is not downloaded: the unflagged
    // file is held for it, not released to ChatGPT.
    expect(install.lane.ledger.getCurrent(garden)).toMatchObject({ state: 'pending', contentPending: true });
    expect(await olympusSearch(install, 'orchard')).not.toContain('pruning plan');
    const service = snifferFor(install, model.builtIn);
    expect(await service.runOnce()).toMatchObject({ state: 'model_unavailable' });
    expect(model.started()).toBe(1);
    ready = true;
    for (let pass = 0; pass < 3; pass += 1) await service.runOnce();
    expect(install.lane.ledger.getCurrent(garden)).toMatchObject({ state: 'current', contentTier: 'private' });
    expect(await olympusSearch(install, 'orchard')).toContain('pruning plan');
  });
});

describe('7. re-judging is bounded and not repeated', () => {
  const plan: TierPlacementPlan = { copies: [{ corpusId: INTERNAL_CORPUS, trustDomain: 'internal', layers: 'both' }], embedHold: false };
  const oldPersonal: TierDecision = {
    ...classifyItemTiers({ signals: { title: 'a.pdf' }, text: 'plain notes' }),
    engineVersion: '2026-09-30.p0',
  };

  test('a page reads a bounded window of the ledger and says where to continue', () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    try {
      // Twenty rows, only the last two candidates.
      for (let index = 0; index < 20; index += 1) {
        const id = `item-${String(index).padStart(2, '0')}`;
        ledger.recordRoutedPlacement(identity(id), index >= 18 ? oldPersonal : { ...oldPersonal, engineVersion: TIER_CLASSIFIER_VERSION, reasons: [...oldPersonal.reasons, 'content:sniffer:s:ordinary:0.9'] }, plan);
      }
      const key = { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: 's' };
      const first = ledger.rejudgeCandidatePage({ ...key, limit: 5, scanLimit: 10 });
      expect(first.records).toEqual([]);
      expect(first.next?.providerItemId).toBe('item-09');
      const second = ledger.rejudgeCandidatePage({ ...key, limit: 5, scanLimit: 10, after: first.next! });
      expect(second.records.map((record) => record.providerItemId)).toEqual(['item-18', 'item-19']);
      // The window was full: one more call reaches the end.
      const third = ledger.rejudgeCandidatePage({ ...key, limit: 5, scanLimit: 10, ...(second.next ? { after: second.next } : {}) });
      expect(third.next).toBeUndefined();

      // A row a re-judge left as it was is not a candidate again under the same classifier and sniffer...
      ledger.markRejudged(identity('item-18'), key);
      expect(ledger.listRejudgeCandidates(key).map((record) => record.providerItemId)).toEqual(['item-19']);
      // ...but is under a new one.
      expect(ledger.listRejudgeCandidates({ ...key, snifferId: 's2' }).map((record) => record.providerItemId)).toContain('item-18');
    } finally {
      ledger.close();
    }
  });

  test('a routed item with no stored text is stamped, not re-read every tick', async () => {
    const { install, service } = await gardenSettledPersonal();
    // Names only: its store keeps no text.
    rewriteInternalText(install, 'id:garden', ' ');
    ownerWords = 'Anything about money.';
    const first = await service.runOnce();
    expect(first).toMatchObject({ state: 'ran', rejudged: { skipped: 1 } });
    expect(await service.runOnce()).not.toHaveProperty('rejudged');
  });
});

describe('9. built-in default approvals', () => {
  const key = { lane: 'local', profileId: 'built_in', modelId: 'built_in', promptVersion: 'p-1' };
  const entry = (overrides: Partial<ClassificationLedgerEntry>): ClassificationLedgerEntry => ({
    recorded_at: '2026-10-02T00:00:00.000Z',
    kind: 'classifier_model_decision',
    what: 'x',
    model_id: 'built_in',
    prompt_version: 'p-1',
    lane: 'local',
    profile_id: 'built_in',
    approved_by: 'built_in_default',
    status: 'complete',
    ...overrides,
  });

  test('count only when asked for, and never past an owner revocation of any prompt version', () => {
    const defaultOnly = [entry({})];
    expect(isClassifierApproved(defaultOnly, key)).toBe(false);
    expect(isClassifierApproved(defaultOnly, key, { builtInDefault: true })).toBe(true);
    const revokedOlder = [
      entry({ recorded_at: '2026-10-02T02:00:00.000Z' }),
      entry({ recorded_at: '2026-10-02T01:00:00.000Z', kind: 'classifier_model_revoked', prompt_version: 'p-0', approved_by: CLASSIFICATION_LEDGER_OWNER_APPROVAL }),
    ];
    expect(isClassifierApproved(revokedOlder, key, { builtInDefault: true })).toBe(false);
    const ownerAgain = [
      entry({ recorded_at: '2026-10-02T03:00:00.000Z', prompt_version: 'p-0', approved_by: CLASSIFICATION_LEDGER_OWNER_APPROVAL }),
      ...revokedOlder,
    ];
    expect(isClassifierApproved(ownerAgain, key, { builtInDefault: true })).toBe(true);
  });
});

describe('11a. items a names-only folder covers stop waiting for text', () => {
  test('a row recorded before p4, pending on text that never comes, is settled on its names without a re-list', async () => {
    const install = await freshInstall({ extract: false });
    expect(install.lane.ledger.getCurrent(garden)).toMatchObject({ state: 'pending', contentRead: false, contentPending: true });
    expect(install.lane.ledger.getCurrent(garden)!.reasons).toContain('content:unread');
    // Not names-only yet: nothing settles.
    expect(settleNamesOnlyItems({ set: install.lane.set })).toMatchObject({ settled: 0 });

    // The owner sets the folder to Names only; the lane's stores read the rule.
    mkdirSync(root, { recursive: true });
    writeFileSync(env.OLYMPUS_SOURCE_INGESTION_EXCLUSIONS_PATH!, JSON.stringify({
      schemaVersion: 1,
      rules: [{ id: 'notes-names-only', mode: 'metadata_only', sources: ['dropbox.personal'], path_prefixes: ['/Notes'], reason: 'names only' }],
    }), { mode: 0o600 });
    install.lane.internal.current()?.close();
    const lane = createDropboxTierLane({ secureStore: install.secure, env, policy: defaultDropboxIngestionPolicy(), secretLocations: install.secrets });
    closers.push(() => lane.internal.current()?.close());

    const report = settleNamesOnlyItems({ set: lane.set });
    expect(report.settled).toBe(1);
    const settled = lane.ledger.getCurrent(garden)!;
    expect(settled).toMatchObject({ state: 'current', contentRead: false, contentPending: false, contentTier: settled.metadataTier });
    expect(settled.reasons).toContain('content:names_only');
    expect(settled.reasons).not.toContain('content:unread');
    // Its names copy is where it was; nothing moved.
    expect(lane.ledger.copies(garden).filter((copy) => copy.state === 'current'))
      .toEqual([expect.objectContaining({ corpusId: INTERNAL_CORPUS, layers: 'metadata' })]);
    // The bank letter waits on its names question, not on text: left alone.
    expect(lane.ledger.getCurrent(identity('id:bank'))).toMatchObject({ state: 'pending', metadataPending: true });
  });
});

describe('10. olympus_search is not an answer on the private pool', () => {
  test('the worker does not wrap the ChatGPT evidence search in answer activity (it never preempts the sniffer)', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'workers', 'email-source', 'server.ts'), 'utf8');
    const start = source.indexOf('const chatgptEvidenceSearch = ');
    expect(start).toBeGreaterThan(0);
    const body = source.slice(start, source.indexOf(': undefined;', start));
    expect(body).toContain('searchReleasedEvidence(');
    expect(body).not.toContain('answerActivity.run');
  });
});

