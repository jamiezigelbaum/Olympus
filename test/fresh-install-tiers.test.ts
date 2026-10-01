// A fresh, clean install (owner rulings 2026-09-23 and 2026-10-01): Personal,
// Private and Secret only.
//
// - An unflagged file is Personal at once: its text reaches olympus_search.
// - A file whose NAMES look private waits (held Private, keyword-searchable,
//   never in olympus_search) until the private model judges it; with no
//   private model at all it waits, and nothing else does.
// - A file with a secret in it is Secret: nowhere on any channel.
// - The built-in private model judges flagged items through the AnalystModel
//   interface, reading the owner's own words about privacy, only after the
//   owner approves it.
// - Public is retired: the seeded policy has no Public tier and nothing is
//   ever placed Public.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalystModel, AnalystModelRequest } from '../src/core/analyst.ts';
import { OLYMPUS_SENSITIVITY_MAP_ENV } from '../src/core/sensitivity-map.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import { isPublicTierRetired, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { STANDALONE_SOVEREIGNTY_PRESET } from '../src/core/engine-service.ts';
import { searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import {
  appendClassificationLedgerEntry,
  CLASSIFICATION_LEDGER_OWNER_APPROVAL,
} from '../src/workers/classification-ledger.ts';
import {
  BUILT_IN_SNIFFER_LANE,
  resolveTierSnifferRuntime,
  type BuiltInPrivateModel,
} from '../src/workers/classification/built-in-sniffer.ts';
import {
  clearInstalledTierClassification,
  configureInstalledTierClassification,
} from '../src/workers/classification/installed-tier-classification.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { snifferPromptVersions } from '../src/workers/classification/sniffer.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { loadSovereigntyEngine } from '../src/core/sovereignty.ts';
import {
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
  LocalConnectorStore,
} from '../src/workers/connector-store/index.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import { defaultDropboxIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import {
  createDropboxProviderStoreSyncHandler,
  createDropboxTierLane,
  type DropboxMetadataClient,
  type DropboxMetadataPage,
} from '../src/workers/dropbox-files/index.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';
import { searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';

// Built at runtime: the repository refuses literal credential patterns.
const FAKE_AWS_KEY = ['AKIA', 'QRSTUVWXYZ234567'].join('');
const SECURE_CORPUS = 'secure_local.dropbox.files';

const FILES = [
  { id: 'id:garden', name: 'orchard-plan.pdf', path: '/Notes/orchard-plan.pdf', text: 'Orchard pruning plan for the apple trees this winter.' },
  // "bank" in the NAME: flagged, so it waits for the private model.
  { id: 'id:bank', name: 'bank letter.pdf', path: '/Notes/bank letter.pdf', text: 'Orchard loan terms from the lender, signed in March.' },
  { id: 'id:secret', name: 'orchard-deploy.pdf', path: '/Notes/orchard-deploy.pdf', text: `orchard deploy key ${FAKE_AWS_KEY} for the pipeline` },
] as const;

let root: string;
let env: Record<string, string>;
const closers: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'olympus-fresh-tiers-'));
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
  rmSync(root, { recursive: true, force: true });
});

/** A fresh install with Dropbox connected: the seeded policy, the lane, one sync, and the text extracted. */
async function freshInstall(options: { lane?: typeof BUILT_IN_SNIFFER_LANE; ownerWords?: string } = {}) {
  const policy = loadSovereigntyPreset(STANDALONE_SOVEREIGNTY_PRESET);
  const installed = configureInstalledTierClassification({
    env,
    ...(options.lane ? { lane: { kind: options.lane.kind, modelId: options.lane.modelId } } : {}),
    ...(isPublicTierRetired(policy) ? { retirePublic: true } : {}),
    ownerContext: () => options.ownerWords,
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
  for (const file of FILES) {
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
  return { installed, secure, secrets, lane };
}

type Install = Awaited<ReturnType<typeof freshInstall>>;

/** olympus_search as ChatGPT receives it: released evidence through the response builder. */
async function olympusSearch(install: Install, question: string) {
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
  return { raw, result: searchToolResult(raw, { privateMatched: false }) };
}

const identity = (id: string) => ({ provider: 'dropbox', accountScope: 'personal', providerItemId: id });

describe('fresh install: Personal by default, flagged items wait, Secrets never leave', () => {
  test('no private model: unflagged content reaches olympus_search; the flagged file waits; the secret is nowhere', async () => {
    const install = await freshInstall();

    // The unflagged file is Personal, content and names, at once.
    const garden = install.lane.ledger.getCurrent(identity('id:garden'))!;
    expect(garden).toMatchObject({ metadataTier: 'private', contentTier: 'private', state: 'current', contentRead: true });
    // The flagged one waits, held Private (keyword-searchable on the Mac, never embedded).
    const bank = install.lane.ledger.getCurrent(identity('id:bank'))!;
    expect(bank).toMatchObject({ state: 'pending', metadataPending: true, metadataFlagged: true });
    expect(install.secure.searchItems('lender', 10).map((row) => row.sourceItem.providerItemId)).toEqual(['id:bank']);
    expect(install.lane.ledger.corpusCopyCounts(SECURE_CORPUS).held).toBe(1);
    // The secret is Secret: stored nowhere, its location only.
    expect(install.lane.ledger.getCurrent(identity('id:secret'))).toMatchObject({ contentTier: 'secrets' });
    // Public is retired: no Public store was ever created.
    expect(existsSync(env.OLYMPUS_SOURCE_INDEX_DROPBOX_PUBLIC_CONNECTOR_STORE_DB_PATH!)).toBe(false);

    const { result } = await olympusSearch(install, 'orchard');
    const evidence = (result.structuredContent as { evidence: Array<{ title?: string; excerpt?: string }> }).evidence;
    const everything = JSON.stringify(result);
    // The PDF's TEXT reaches ChatGPT, not just its name.
    expect(evidence.some((item) => item.excerpt?.includes('pruning plan for the apple trees'))).toBe(true);
    expect(everything).not.toContain('loan terms');
    expect(everything).not.toContain('bank letter');
    expect(everything).not.toContain(FAKE_AWS_KEY);
    expect(everything).not.toContain('orchard-deploy');
  });

  test('a borderline word in the text alone does not hold an item without a private model', async () => {
    // "invoice" once in the text is a borderline financial word, not a flag on the names.
    const decision = classifyItemTiers({ signals: { title: 'trip.pdf', path: '/trip.pdf' }, text: 'Hotel booking; the invoice comes later.' });
    expect(decision).toMatchObject({ contentTier: 'private', state: 'current', contentPending: false });
  });

  test('the built-in private model judges the flagged file, only once the owner approves it, reading the owner\'s words', async () => {
    const prompts: AnalystModelRequest[] = [];
    let ready = false;
    const model: AnalystModel = {
      async complete(request) {
        prompts.push(request);
        return { text: '{"verdicts":[{"i":1,"tier":"private","category":"financial","confidence":0.9}]}', modelId: 'built_in' };
      },
    };
    const builtIn: BuiltInPrivateModel = { model, available: () => ready };
    // The seeded policy has no private lane, so the built-in model is the sniffer.
    const runtime = resolveTierSnifferRuntime({
      engine: loadSovereigntyEngine({ inlineConfig: loadSovereigntyPreset(STANDALONE_SOVEREIGNTY_PRESET) }),
      builtIn,
    });
    expect(runtime.source).toBe('built_in');
    const ownerWords = 'Money matters and anything about my health.';
    const install = await freshInstall({ ...(runtime.source === 'built_in' ? { lane: runtime.lane } : {}), ownerWords });
    expect(install.lane.ledger.getCurrent(identity('id:bank'))).toMatchObject({ state: 'pending', metadataPending: true });

    const ledgerPath = join(root, 'classification-ledger.jsonl');
    const service = new TierSnifferService({
      installed: install.installed,
      lane: BUILT_IN_SNIFFER_LANE,
      model,
      stores: () => [install.secure, ...[install.lane.internal.current()].filter((store): store is LocalConnectorStore => store !== undefined)],
      classificationLedgerPath: ledgerPath,
      modelAvailable: () => builtIn.available(),
      ownerContext: () => ownerWords,
    });
    closers.push(() => service.stop());

    // Still downloading: nothing is asked, nothing counted.
    expect(await service.runOnce()).toMatchObject({ state: 'model_unavailable' });
    ready = true;
    // Not approved yet: nothing is asked.
    expect(await service.runOnce()).toMatchObject({ state: 'awaiting_owner_approval' });
    expect(prompts).toHaveLength(0);

    await appendClassificationLedgerEntry(ledgerPath, {
      recorded_at: '2026-10-01T12:00:00.000Z',
      kind: 'classifier_model_decision',
      what: 'Owner approves the built-in private model for the privacy sniffer.',
      model_id: 'built_in',
      prompt_version: snifferPromptVersions(ownerWords).approval,
      lane: 'local',
      profile_id: 'built_in',
      approved_by: CLASSIFICATION_LEDGER_OWNER_APPROVAL,
      status: 'complete',
    });
    const tick = await service.runOnce();
    expect(tick).toMatchObject({ state: 'ran' });
    expect(prompts.length).toBeGreaterThan(0);
    // The owner's words travel as quoted data; the secret's text never does.
    expect(prompts.every((prompt) => prompt.prompt.includes(JSON.stringify({ owner_privacy: ownerWords })))).toBe(true);
    expect(prompts.some((prompt) => prompt.prompt.includes('bank letter'))).toBe(true);
    expect(JSON.stringify(prompts)).not.toContain(FAKE_AWS_KEY);
    expect(prompts.every((prompt) => prompt.localOnly === true)).toBe(true);

    // Judged Private: no longer pending, and still never in olympus_search.
    expect(install.lane.ledger.getCurrent(identity('id:bank'))).toMatchObject({ state: 'current', metadataTier: 'secure', metadataPending: false });
    const { result } = await olympusSearch(install, 'orchard');
    expect(JSON.stringify(result)).not.toContain('loan terms');
    expect(JSON.stringify(result)).toContain('pruning plan');
  });

  test('a configured private lane wins; a refused one is never papered over with the built-in model', () => {
    const builtIn: BuiltInPrivateModel = { model: { complete: async () => ({ text: '', modelId: 'built_in' }) }, available: () => true };
    const localFirst = loadSovereigntyEngine({ inlineConfig: loadSovereigntyPreset('local-first') });
    expect(resolveTierSnifferRuntime({ engine: localFirst, builtIn }).source).toBe('configured');
    const noSensitive = loadSovereigntyEngine({ inlineConfig: loadSovereigntyPreset(STANDALONE_SOVEREIGNTY_PRESET) });
    expect(resolveTierSnifferRuntime({ engine: noSensitive })).toEqual({ source: 'off', reason: 'no_private_lane' });
  });
});

describe('Public is retired on a fresh install', () => {
  test('public evidence or a Public owner rule is Personal, with a content-free reason', () => {
    const signals = { title: 'talk-slides.pdf', path: '/talks/talk-slides.pdf', sharing: 'public_link' as const };
    expect(classifyItemTiers({ signals, text: 'Slides for the conference talk.' }).metadataTier).toBe('public');
    const retired = classifyItemTiers({ signals, text: 'Slides for the conference talk.' }, { retirePublic: true });
    expect(retired).toMatchObject({ metadataTier: 'private', contentTier: 'private' });
    expect(retired.reasons).toContain('tier:public_retired');
    const ruled = classifyItemTiers(
      { signals: { title: 'a.pdf', path: '/work/published/a.pdf' }, provider: 'dropbox', text: 'Published essay.' },
      { retirePublic: true, rules: [{ id: 'published', match: { kind: 'pathPrefix', value: '/work/published' }, tier: 'public', strength: 'force' }] },
    );
    expect(ruled).toMatchObject({ metadataTier: 'private', contentTier: 'private' });
    const overridden = classifyItemTiers({ signals, text: 'x' }, { retirePublic: true, override: { kind: 'tier', tier: 'public' } });
    expect(overridden).toMatchObject({ metadataTier: 'private', contentTier: 'private' });
  });

  test('an older policy that defines Public keeps it; a half-removed Public tier is refused', () => {
    const localFirst = loadSovereigntyPreset('local-first');
    expect(isPublicTierRetired(localFirst)).toBe(false);
    const halfRemoved = structuredClone(localFirst);
    delete halfRemoved.routes.public_safe;
    expect(() => loadSovereigntyEngine({ inlineConfig: halfRemoved })).toThrow(/public_safe/);
  });
});
