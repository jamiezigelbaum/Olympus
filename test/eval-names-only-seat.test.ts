// A Dropbox file whose names are in the Personal store and whose content was
// never read (no chunks; its content held fail-safe Private in the tier
// ledger) matches three of a question's four title words. Keyword search
// ranks it first among every item in the store, so the held-out eval's
// evidence pack must give it a seat (as a names-only/unread candidate the
// pack counts), never drop it silently before hydration.
//
// Built through the real Dropbox tier lane, the real sniffer service and the
// eval's own store/lane/pack functions. Synthetic data only.

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AnalystModel } from '../src/core/analyst.ts';
import { defaultDropboxIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { isPublicTierRetired, loadSovereigntyPreset } from '../src/core/sovereignty.ts';
import { resolvedStorePath } from '../src/core/source-placement.ts';
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
import { tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  createDropboxProviderStoreSyncHandler,
  createDropboxTierLane,
  type DropboxMetadataClient,
  type DropboxMetadataPage,
} from '../src/workers/dropbox-files/index.ts';
import { DROPBOX_FILES_SOURCE_ID } from '../src/workers/dropbox-files/corpus-adapter.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';
import { buildEvalPack, createEvalDropboxLanes, evalRetrievalAudit, openEvalDropboxStores } from '../eval/run-real.ts';

const SECURE_CORPUS = 'secure_local.dropbox.files';
const PERSONAL_CORPUS = 'internal.dropbox.files';
const ACCOUNT = 'personal';
const TOPICS = [
  'garden', 'boat', 'piano', 'kitchen', 'roof', 'bicycle', 'school', 'dentist', 'insurance', 'passport',
  'wedding', 'tax', 'car', 'camera', 'library', 'concert', 'museum', 'hiking', 'fishing', 'bakery',
  'violin', 'chess', 'pottery', 'tennis', 'sailing', 'quilt', 'beekeeping', 'telescope', 'aquarium', 'orchard',
];
// Thirty ordinary files with read content, and one file whose names alone are known.
const CONTENT_FILES = TOPICS.map((topic, index) => ({
  id: `id:c${index}`, name: `${topic}-notes-${index}.txt`, path: `/Notes/${topic}-notes-${index}.txt`,
  text: `Notes about the ${topic}: the ${topic} schedule for this season, the ${topic} checklist and who to call about the ${topic}.`,
}));
// Readable files that share part of the question in their text, as many
// readable files on a large install do: each matches three of its four words,
// none of them as strongly as the title-only file's name.
const PARTIAL_FILES = ['marina', 'pier', 'dock', 'ferry', 'jetty', 'wharf'].map((place, index) => ({
  id: `id:p${index}`, name: `${place}-minutes-${index}.txt`, path: `/Minutes/${place}-minutes-${index}.txt`,
  text: `Meeting minutes for the ${place} committee. Item four: the harbor master asked for an estimate before any restoration work, `
    + `and the committee will revisit the ${place} budget next month.`,
}));
const TITLE_ONLY = { id: 'id:lantern', name: 'Harbor Lantern Restoration Quote.pdf', path: '/Projects/Harbor Lantern Restoration Quote.pdf' };
const QUESTION = 'What was the harbor lantern restoration estimate?';
const titleOnlyIdentity = { provider: 'dropbox', accountScope: ACCOUNT, providerItemId: TITLE_ONLY.id };

let root: string;
let env: Record<string, string>;
const closers: Array<() => void> = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'olympus-eval-names-only-seat-'));
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

/** Dropbox listed, the thirty files read and judged Personal, the title-only file settled with its content fail-safe Private. */
async function installLikeWorld(partials: readonly typeof PARTIAL_FILES[number][]) {
  const policy = loadSovereigntyPreset('no-sensitive');
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
  const entries = [...CONTENT_FILES, ...partials, TITLE_ONLY].map((file) => ({ tag: 'file' as const, id: file.id, name: file.name, pathDisplay: file.path, rev: 'r1' }));
  const metadataClient: DropboxMetadataClient = {
    supportsNativeRecursive: true,
    async listFolder(): Promise<DropboxMetadataPage> { return { entries, cursor: 'c1', hasMore: false }; },
    async listFolderContinue(): Promise<DropboxMetadataPage> { return { entries, cursor: 'c2', hasMore: false }; },
  };
  const broker = new StaticCredentialBroker([{
    handle: 'dropbox.personal', provider: 'dropbox', allowedCapabilities: ['dropbox.files.sync'], token: 'test-token', trustDomain: 'secure_local',
  }]);
  const sync = createDropboxProviderStoreSyncHandler({ store: secure, account: ACCOUNT, broker, metadataClient, tierSet: lane.set });
  await sync.pull({ approved_scope_key: 'dropbox.personal:/' });

  const sink = createTieredStoreExtractionSink({ set: lane.set, syncConnectorId: 'extraction', ownerConnectorId: 'dropbox', ownershipKind: 'observed' });
  for (const file of [...CONTENT_FILES, ...partials]) {
    const accepted = await sink.accept({
      ref: { corpusId: SECURE_CORPUS, provider: 'dropbox', accountScope: ACCOUNT, approvedScopeKey: 'dropbox.personal:/',
        providerItemId: file.id, localItemId: `${ACCOUNT}:${file.id}`, sourceVersion: 'r1' },
      text: file.text, extractorKind: 'local_text', extractorVersion: 'test', fetchedAt: '2026-10-01T00:00:00.000Z',
    });
    expect(accepted.accepted).toBe(true);
  }

  // The title-only file's text was never read and extraction no longer owes
  // it: listed a day ago, so the sniffer settles its content fail-safe Private.
  const db = new Database(lane.ledger.dbPath);
  db.query(`UPDATE tier_items SET decided_at = ? WHERE provider_item_id = ?`)
    .run(new Date(Date.now() - 24 * 3_600_000).toISOString(), TITLE_ONLY.id);
  db.close();

  // Every read text is judged Personal by the (scripted) built-in model.
  const model: AnalystModel = {
    async complete(request) {
      const count = Math.max(1, (request.prompt.match(/^\s*(?:Item|#)\s*\d+/gim) ?? []).length, 40);
      const verdicts = Array.from({ length: count }, (_, index) => ({
        i: index + 1, tier: 'personal', category: 'ordinary', ownRecord: false, privateKind: 'none', confidence: 0.97,
      }));
      return { text: JSON.stringify({ verdicts }), modelId: 'built_in' };
    },
  };
  const ledgerPath = join(root, 'classification-ledger.jsonl');
  appendClassificationLedgerEntry(ledgerPath, {
    recorded_at: '2026-10-01T12:00:00.000Z', kind: 'classifier_model_decision',
    what: 'Owner approves the built-in private model for the privacy sniffer.',
    model_id: 'built_in', prompt_version: snifferPromptVersions(undefined).approval,
    lane: 'local', profile_id: 'built_in', approved_by: CLASSIFICATION_LEDGER_OWNER_APPROVAL, status: 'complete',
  });
  const service = new TierSnifferService({
    installed, lane: BUILT_IN_SNIFFER_LANE, model,
    stores: () => lane.set.openStores(), classificationLedgerPath: ledgerPath,
    modelAvailable: () => true,
    extractionState: () => 'settled',
    rejudgePerPass: 0,
    autoMoves: { localEmbeddingsOnly: () => true, embeddingLedgerPath: join(root, 'embedding-ledger.jsonl') },
  });
  closers.push(() => service.stop());
  for (let pass = 0; pass < 10; pass += 1) await service.runOnce();
  return { lane, secure };
}

async function evalWorld(partials: readonly typeof PARTIAL_FILES[number][]) {
  const { lane, secure } = await installLikeWorld(partials);

  // The world is the real install's shape.
  const row = lane.ledger.getCurrent(titleOnlyIdentity)!;
  expect(row).toMatchObject({ state: 'current', contentRead: false, contentTier: 'secure', metadataTier: 'private' });
  const copies = lane.ledger.copies(titleOnlyIdentity).filter((copy) => copy.state === 'current');
  expect(copies.some((copy) => copy.corpusId === PERSONAL_CORPUS && copy.layers !== 'content')).toBe(true);
  for (const file of CONTENT_FILES.slice(0, 3)) {
    expect(lane.ledger.getCurrent({ provider: 'dropbox', accountScope: ACCOUNT, providerItemId: file.id }))
      .toMatchObject({ state: 'current', contentRead: true, contentTier: 'private', metadataTier: 'private' });
  }
  const personalPath = resolvedStorePath(DROPBOX_FILES_SOURCE_ID, 'internal', env);
  const raw = new Database(personalPath, { readonly: true });
  const personalRow = raw.query(`SELECT i.item_pk, (SELECT COUNT(*) FROM chunks c WHERE c.item_pk = i.item_pk) AS chunks
    FROM items i WHERE i.local_item_id = ?`).get(`${ACCOUNT}:${TITLE_ONLY.id}`) as { item_pk: number; chunks: number } | null;
  const personalItems = (raw.query('SELECT COUNT(*) AS n FROM items').get() as { n: number }).n;
  raw.close();
  expect(personalRow).not.toBeNull();
  expect(personalRow!.chunks).toBe(0);
  expect(personalItems).toBe(CONTENT_FILES.length + partials.length + 1);

  // Close the writer side, then search the way the eval does.
  lane.internal.current()?.close();
  secure.close();
  const opened = openEvalDropboxStores({ secure: secure.dbPath, personal: personalPath, ledger: tieredStoreSetLedgerPath(secure.dbPath) });
  closers.push(() => opened.close());
  return opened;
}

async function evalSeat(opened: Awaited<ReturnType<typeof evalWorld>>) {
  const lanes = createEvalDropboxLanes({ stores: opened.stores, ...(opened.ledger ? { ledger: opened.ledger } : {}), scope: { accountScope: ACCOUNT } });
  const detail = await buildEvalPack({ question: QUESTION, lanes, maxResults: 5, maxCharsPerCandidate: 1_500 });
  return evalRetrievalAudit(detail, { expectedEvidence: [{ corpusId: PERSONAL_CORPUS, providerItemId: TITLE_ONLY.id, hint: 'the quote' }] });
}

// Control: with no readable file sharing the question's words, the title-only
// file is seated, counted as an unread candidate. So neither the tier ledger
// (content Private, names Personal), the visibility gate nor hydration drops it.
test('control: alone among the matches, the title-only file is seated as an unread candidate', async () => {
  const audit = await evalSeat(await evalWorld([]));
  expect(audit.packCandidateSources.some((seat) => seat.expectedItem === 1)).toBe(true);
  expect(audit.unreadCandidates).toBe(1);
});

test('a title-only Personal match ranked first by keyword search keeps a seat when readable files match part of the question', async () => {
  const opened = await evalWorld(PARTIAL_FILES);
  // Where it stands at each step. The store's plain keyword search (the
  // lane's first query, read to its 50-row probe) finds it, ranked first, and
  // it passes the minimum-signal and tier filters; it has no chunk.
  const personal = opened.stores.find((store) => store.corpusId === PERSONAL_CORPUS)!;
  const plain = personal.searchItemsDetailed(QUESTION, 50, ACCOUNT).rows;
  const plainIds = plain.map((row) => row.sourceItem.providerItemId);
  expect(plainIds[0]).toBe(TITLE_ONLY.id);
  expect(plain[0]!.chunk).toBeUndefined();
  // The Personal store's adapter, asked for the pack's 5, as the router asks it.
  const laneSet = createEvalDropboxLanes({ stores: opened.stores, ...(opened.ledger ? { ledger: opened.ledger } : {}), scope: { accountScope: ACCOUNT } })(QUESTION);
  const ask = async (maxResults: number) => (await laneSet.adapters[PERSONAL_CORPUS]!({
    query: QUESTION, maxResults, corpus: { corpusId: PERSONAL_CORPUS, family: 'file', trustDomain: 'internal' },
    context: { allowedTrustDomains: ['public_safe', 'internal', 'secure_local'] },
  } as never)).hits.map((hit) => hit.sourceItem.providerItemId);
  // The rule: the best name match keeps a seat whenever the store's lane has
  // room for more than one, and never takes the first seat from a readable
  // match. It used to drop here: every readable partial match came before
  // every title-only one, cut at what the router asks for.
  expect(await ask(5)).toContain(TITLE_ONLY.id);
  const two = await ask(2);
  expect(two[1]).toBe(TITLE_ONLY.id);
  const one = await ask(1);
  expect(one).toHaveLength(1);
  expect(one[0]).not.toBe(TITLE_ONLY.id);

  const audit = await evalSeat(opened);
  expect(audit.packCandidateSources.some((seat) => seat.expectedItem === 1)).toBe(true);
});
