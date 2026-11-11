// An item a sniffer verdict settled under the current classifier and sniffer
// is not a re-judge candidate for the same inputs (#954). On the Linux release
// check, messages judged Personal a moment earlier were re-asked at once, and
// the small judge's second answer hid three of four as Private. The resolver
// stamps the row it settles; a new classifier or sniffer makes it a candidate
// again, and rows still owed a verdict stay candidates. Synthetic data only.

import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { TIER_CLASSIFIER_VERSION, type TierSniffer } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { rejudgeRoutedItems } from '../src/workers/connector-store/tier-rejudge.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { TieredStoreSet, tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import { CORPORA, FIXTURE_PLACEMENT, cloudProvider, fixtureConnector, identityOf, localProvider, openLegStore, storePaths, tempDir } from './helpers/tier-fixtures.ts';

const SNIFFER = 'fixture-now';
const waiting: TierSniffer = { id: SNIFFER, judge() { return { verdict: 'undecided', queued: true }; } };
const KEY = { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: SNIFFER };
const cleanups: Array<() => void> = [];
/** Edits a ledger row the way another pass would, through its own connection. */
function poke(ledger: TierLedger, sql: string, ...args: string[]): void {
  const db = new Database(ledger.dbPath);
  try { db.query(sql).run(...args); } finally { db.close(); }
}
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

async function lane(text = 'Please remember the bananas for the picnic on Saturday.') {
  const tmp = tempDir('olympus-judged-');
  const paths = storePaths(tmp.dir);
  const ledger = new TierLedger({ dbPath: tieredStoreSetLedgerPath(paths.secure_local) });
  const secrets = new SecretLocationsIndex({ dbPath: join(tmp.dir, 'secret-locations.sqlite') });
  const stores = { internal: openLegStore(paths, 'internal', ledger), secure_local: openLegStore(paths, 'secure_local', ledger) };
  const set = new TieredStoreSet({
    setId: 'judged', ledger, secretLocations: secrets, tierClassification: { sniffer: waiting },
    legs: [
      { trustDomain: 'internal', corpusId: CORPORA.internal, store: stores.internal, embeddingProvider: cloudProvider() },
      { trustDomain: 'secure_local', corpusId: CORPORA.secure_local, store: stores.secure_local, embeddingProvider: localProvider() },
    ],
  });
  cleanups.push(() => { stores.internal.close(); stores.secure_local.close(); secrets.close(); ledger.close(); tmp.cleanup(); });
  await set.sync(fixtureConnector(() => [{ id: 'note', name: 'Orchard note', text }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const identity = identityOf('note');
  /** The verdict the resolver lands, with the names judged under another sniffer prompt kept beside it. */
  const judge = async (code = 'ordinary:0.95') => {
    const applied = ledger.applySnifferVerdict(identity, { pass: 'content', tier: 'private', reason: `content:sniffer:${SNIFFER}:${code}`, modelId: 'fixture' }, { placementFor: (decision) => set.placementFor(decision) });
    expect(applied?.outcome).toBeDefined();
    // Held until judged (#1316), a Personal verdict moves the text down; the mover finishes it, as the worker's does.
    const row = ledger.getCurrent(identity)!;
    if (row.state === 'moving') {
      await moveTieredItem({ set, identity, target: { metadataTier: row.targetMetadataTier!, contentTier: row.targetContentTier! }, expectedGeneration: row.generation });
    }
  };
  /** Names an earlier sniffer prompt judged: by themselves they make the row a candidate. */
  const olderNames = () => {
    const row = ledger.getCurrent(identity)!;
    poke(ledger, 'UPDATE tier_items SET reasons_json = ? WHERE provider_item_id = ?',
      JSON.stringify([...row.reasons, 'metadata:sniffer:fixture-older-prompt:ordinary:0.90']), 'note');
  };
  return { ledger, set, identity, judge, olderNames };
}

test('a row settled a moment ago is not re-asked for the same classifier and sniffer', async () => {
  const f = await lane();
  await f.judge();
  f.olderNames();
  // Without the stamp the names reason alone makes it a candidate (the shape the live run showed).
  const page = f.ledger.rejudgeCandidatePage(KEY);
  expect(page.records.map((row) => row.providerItemId)).toEqual(['note']);
  expect(page.causes).toEqual(['names_prompt']);

  f.ledger.markJudged(f.identity, KEY);
  expect(f.ledger.rejudgeCandidatePage(KEY).records).toEqual([]);
  expect(rejudgeRoutedItems({ set: f.set, autoMoves: true }).report).toMatchObject({ seen: 0, asked: 0 });
  // A new sniffer prompt or classifier makes it a candidate again.
  expect(f.ledger.rejudgeCandidatePage({ ...KEY, snifferId: 'fixture-next' }).records).toHaveLength(1);
  expect(f.ledger.rejudgeCandidatePage({ ...KEY, engineVersion: 'next-classifier' }).causes).toEqual(['classifier']);
});

test('a row still owed a verdict is never stamped: held, fail-safe, older classifier, retired source prior', async () => {
  const held = await lane();
  held.ledger.markJudged(held.identity, KEY);
  const heldPage = held.ledger.rejudgeCandidatePage(KEY);
  expect(heldPage.causes).toEqual(['held']);

  const failSafe = await lane();
  await failSafe.judge('unresolved:0.00');
  const row = failSafe.ledger.getCurrent(failSafe.identity)!;
  poke(failSafe.ledger, 'UPDATE tier_items SET reasons_json = ? WHERE provider_item_id = ?',
    JSON.stringify([...row.reasons, `content:sniffer:${SNIFFER}:fail_safe:missing_question`]), 'note');
  failSafe.ledger.markJudged(failSafe.identity, KEY);
  expect(failSafe.ledger.rejudgeCandidatePage(KEY).causes).toEqual(['missing_question']);

  const older = await lane();
  await older.judge();
  poke(older.ledger, 'UPDATE tier_items SET engine_version = ? WHERE provider_item_id = ?', 'older-classifier', 'note');
  older.ledger.markJudged(older.identity, KEY);
  expect(older.ledger.rejudgeCandidatePage(KEY).causes).toEqual(['classifier']);

  const prior = await lane();
  await prior.judge();
  const priorRow = prior.ledger.getCurrent(prior.identity)!;
  poke(prior.ledger, 'UPDATE tier_items SET reasons_json = ? WHERE provider_item_id = ?',
    JSON.stringify([...priorRow.reasons, 'metadata:prior:source_chat']), 'note');
  prior.ledger.markJudged(prior.identity, KEY);
  expect(prior.ledger.rejudgeCandidatePage(KEY).causes).toEqual(['retired_prior']);
});

test('a stamp does not outlive a later decision that left the row owed a verdict', async () => {
  const f = await lane();
  await f.judge();
  f.ledger.markJudged(f.identity, KEY);
  expect(f.ledger.rejudgeCandidatePage(KEY).records).toEqual([]);
  // Later: another decision, its question lost, settled fail-safe (settleMissingQuestions).
  const row = f.ledger.getCurrent(f.identity)!;
  poke(f.ledger, 'UPDATE tier_items SET reasons_json = ?, content_tier = ? WHERE provider_item_id = ?',
    JSON.stringify([...row.reasons.filter((reason) => !reason.startsWith('content:sniffer:')), `content:sniffer:${SNIFFER}:fail_safe:missing_question`]), 'secure', 'note');
  expect(f.ledger.rejudgeCandidatePage(KEY).causes).toEqual(['missing_question']);
});
