// Fresh install, Dropbox connected while the built-in private model is still
// downloading. An item whose text extraction has not read yet has no content
// question, because that question can only exist once the text does: it is
// waiting for extraction, not missing a question. Recovery of lost questions
// (#381) must leave it pending; when extraction lands, the text is judged,
// not refused. Items an older build already settled fail-safe Private for
// that reason are judged the same way when their text arrives. Synthetic data.

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalystModel, AnalystModelRequest } from '../src/core/analyst.ts';
import { defaultDropboxIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { loadSovereigntyPreset, isPublicTierRetired } from '../src/core/sovereignty.ts';
import { STANDALONE_SOVEREIGNTY_PRESET } from '../src/core/engine-service.ts';
import { appendClassificationLedgerEntry, CLASSIFICATION_LEDGER_OWNER_APPROVAL } from '../src/workers/classification-ledger.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import {
  clearInstalledTierClassification,
  configureInstalledTierClassification,
} from '../src/workers/classification/installed-tier-classification.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { snifferPromptVersions } from '../src/workers/classification/sniffer.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  createDropboxProviderStoreSyncHandler,
  createDropboxTierLane,
  type DropboxMetadataClient,
  type DropboxMetadataPage,
} from '../src/workers/dropbox-files/index.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';

const SECURE_CORPUS = 'secure_local.dropbox.files';
const FILE = { id: 'id:garden', name: 'orchard-plan.pdf', path: '/Notes/orchard-plan.pdf', text: 'Orchard pruning plan for the apple trees this winter.' };
const identity = { provider: 'dropbox', accountScope: 'personal', providerItemId: FILE.id };
const FAIL_SAFE = /^content:sniffer:.*:fail_safe:missing_question$/;

let root: string;
let env: Record<string, string>;
const closers: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'olympus-unread-not-missing-'));
  env = {
    HOME: join(root, 'home'),
    OLYMPUS_SOURCE_INGESTION_EXCLUSIONS_PATH: join(root, 'no-exclusions.json'),
    OLYMPUS_TIER_RULES_PATH: join(root, 'olympus', 'tier-rules.json'),
    OLYMPUS_PRIVACY_PROFILE_PATH: join(root, 'olympus', 'privacy.json'),
  };
});
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  clearInstalledTierClassification();
  rmSync(root, { recursive: true, force: true });
});

/** Dropbox connected, names listed, nothing extracted yet. */
async function connected() {
  const policy = loadSovereigntyPreset(STANDALONE_SOVEREIGNTY_PRESET);
  const installed = configureInstalledTierClassification({
    env,
    lane: { kind: BUILT_IN_SNIFFER_LANE.kind, modelId: BUILT_IN_SNIFFER_LANE.modelId },
    ...(isPublicTierRetired(policy) ? { retirePublic: true } : {}),
  });
  const secure = new LocalConnectorStore({ dbPath: join(root, 'dropbox-secure.sqlite'), corpusId: SECURE_CORPUS, family: 'file', trustDomain: 'secure_local' });
  closers.push(() => secure.close());
  const secrets = new SecretLocationsIndex({ dbPath: join(root, 'secrets.sqlite') });
  closers.push(() => secrets.close());
  const lane = createDropboxTierLane({ secureStore: secure, env, policy: defaultDropboxIngestionPolicy(), secretLocations: secrets });
  closers.push(() => { lane.internal.current()?.close(); lane.public.current()?.close(); });
  const entries = [{ tag: 'file' as const, id: FILE.id, name: FILE.name, pathDisplay: FILE.path, rev: 'r1' }];
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
  const extract = () => sink.accept({
    ref: { corpusId: SECURE_CORPUS, provider: 'dropbox', accountScope: 'personal', approvedScopeKey: 'dropbox.personal:/',
      providerItemId: FILE.id, localItemId: `personal:${FILE.id}`, sourceVersion: 'r1' },
    text: FILE.text, extractorKind: 'local_text', extractorVersion: 'test', fetchedAt: '2026-10-01T00:00:00.000Z',
  });
  return { installed, secure, lane, extract };
}

function serviceFor(f: Awaited<ReturnType<typeof connected>>, state: { ready: boolean; owed: boolean; prompts: AnalystModelRequest[] }) {
  const model: AnalystModel = {
    async complete(request) {
      state.prompts.push(request);
      return { text: '{"verdicts":[{"i":1,"tier":"personal","category":"ordinary","ownRecord":false,"privateKind":"none","confidence":0.97}]}', modelId: 'built_in' };
    },
  };
  const ledgerPath = join(root, 'classification-ledger.jsonl');
  const service = new TierSnifferService({
    installed: f.installed, lane: BUILT_IN_SNIFFER_LANE, model,
    stores: () => f.lane.set.openStores(), classificationLedgerPath: ledgerPath,
    modelAvailable: () => state.ready,
    extractionOwed: () => state.owed,
    rejudgePerPass: 0,
    autoMoves: { localEmbeddingsOnly: () => true, embeddingLedgerPath: join(root, 'embedding-ledger.jsonl') },
  });
  closers.push(() => service.stop());
  const approve = () => appendClassificationLedgerEntry(ledgerPath, {
    recorded_at: '2026-10-01T12:00:00.000Z', kind: 'classifier_model_decision',
    what: 'Owner approves the built-in private model for the privacy sniffer.',
    model_id: 'built_in', prompt_version: snifferPromptVersions(undefined).approval,
    lane: 'local', profile_id: 'built_in', approved_by: CLASSIFICATION_LEDGER_OWNER_APPROVAL, status: 'complete',
  });
  return { service, approve };
}

test('unread content waiting for extraction is not a lost question: it stays pending, then the landed text is asked and judged', async () => {
  const f = await connected();
  const state = { ready: false, owed: true, prompts: [] as AnalystModelRequest[] };
  const { service, approve } = serviceFor(f, state);
  // Make the item the observed one: names settled, content unread and pending.
  const before = f.lane.ledger.getCurrent(identity)!;
  expect(before.contentRead).toBe(false);
  const db = new Database(f.lane.ledger.dbPath);
  db.query(`UPDATE tier_items SET state = 'pending', metadata_pending = 0, content_pending = 1, content_read = 0,
    decided_at = ?`).run(new Date(Date.now() - 24 * 3_600_000).toISOString());
  db.close();

  // The restart: model still unavailable, recovery ticks.
  expect(await service.runOnce()).toMatchObject({ state: 'model_unavailable' });
  const waiting = f.lane.ledger.getCurrent(identity)!;
  expect(waiting).toMatchObject({ state: 'pending', contentPending: true, contentRead: false });
  expect(waiting.reasons.some((reason) => FAIL_SAFE.test(reason))).toBe(false);

  // Extraction lands: the text is held Private, not refused, and a question is waiting.
  expect((await f.extract()).accepted).toBe(true);
  const landed = f.lane.ledger.getCurrent(identity)!;
  expect(landed).toMatchObject({ contentRead: true, state: 'pending', contentPending: true });
  expect(f.lane.ledger.copies(identity).some((copy) => copy.layers !== 'metadata' && copy.state === 'current')).toBe(true);

  // The model arrives and judges the text.
  state.ready = true; state.owed = false;
  await approve();
  await service.runOnce();
  expect(state.prompts.some((request) => request.prompt.includes('pruning plan'))).toBe(true);
  expect(f.lane.ledger.getCurrent(identity)).toMatchObject({ state: 'current', contentPending: false, contentRead: true, contentTier: 'private' });
});

test('unread content that extraction no longer owes is still settled fail-safe Private', async () => {
  const f = await connected();
  const state = { ready: false, owed: false, prompts: [] as AnalystModelRequest[] };
  const { service } = serviceFor(f, state);
  const db = new Database(f.lane.ledger.dbPath);
  db.query(`UPDATE tier_items SET state = 'pending', metadata_pending = 0, content_pending = 1, content_read = 0,
    decided_at = ?`).run(new Date(Date.now() - 24 * 3_600_000).toISOString());
  db.close();
  await service.runOnce();
  const settled = f.lane.ledger.getCurrent(identity)!;
  expect(settled).toMatchObject({ state: 'current', contentTier: 'secure', contentRead: false });
  expect(settled.reasons.some((reason) => FAIL_SAFE.test(reason))).toBe(true);
});

test('an item an older build settled fail-safe with its text unread is judged when the text lands, not refused', async () => {
  const f = await connected();
  const state = { ready: true, owed: false, prompts: [] as AnalystModelRequest[] };
  const { service, approve } = serviceFor(f, state);
  const db = new Database(f.lane.ledger.dbPath);
  db.query(`UPDATE tier_items SET state = 'current', metadata_pending = 0, content_pending = 0, content_read = 0, content_tier = 'secure',
    reasons_json = ?`).run(JSON.stringify(['content:sniffer:old:fail_safe:missing_question']));
  db.close();

  expect((await f.extract()).accepted).toBe(true);
  const landed = f.lane.ledger.getCurrent(identity)!;
  expect(landed).toMatchObject({ contentRead: true, state: 'pending', contentPending: true });
  expect(landed.reasons).toContain('content:held_until_judged');
  expect(landed.reasons.some((reason) => FAIL_SAFE.test(reason))).toBe(false);

  await approve();
  await service.runOnce();
  expect(state.prompts.some((request) => request.prompt.includes('pruning plan'))).toBe(true);
  expect(f.lane.ledger.getCurrent(identity)).toMatchObject({ state: 'current', contentPending: false, contentRead: true, contentTier: 'private' });
});

for (const shape of [
  { what: 'a message (not a file)', set: `family = 'message'` },
  { what: 'a legacy unrouted row', set: `routed = 0` },
]) test(`unread content of ${shape.what} has no extraction lane, so it is settled fail-safe Private even with no job`, async () => {
  const f = await connected();
  // Owed says "no job yet", which for anything extraction does not serve is never going to change.
  const state = { ready: false, owed: true, prompts: [] as AnalystModelRequest[] };
  const { service } = serviceFor(f, state);
  const db = new Database(f.lane.ledger.dbPath);
  db.query(`UPDATE tier_items SET state = 'pending', metadata_pending = 0, content_pending = 1, content_read = 0, ${shape.set},
    decided_at = ?`).run(new Date(Date.now() - 24 * 3_600_000).toISOString());
  if (shape.set === 'routed = 0') db.query('DELETE FROM tier_copies').run();
  db.close();
  await service.runOnce();
  const settled = f.lane.ledger.getCurrent(identity)!;
  expect(settled).toMatchObject({ state: 'current', contentTier: 'secure', contentRead: false });
  expect(settled.reasons.some((reason) => FAIL_SAFE.test(reason))).toBe(true);
});
