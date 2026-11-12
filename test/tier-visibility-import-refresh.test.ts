// OLYMPUS_TEST_LANE: deploy
// The saved visibility set stays current while another store imports: this
// test imports thousands of items to move the shared ledger feed past its
// whole window, so it runs for seconds and lives in the deploy lane.

import { afterEach, expect, spyOn, test } from 'bun:test';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { controlPathHeadroom } from '../src/workers/control-path-headroom.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, type FixtureSpec } from './helpers/tier-fixtures.ts';
import {
  cleanups,
  countFullRebuilds,
  fixtureWithEveryState,
  ledgerStamp,
  MODEL,
  probe,
  secondWriter,
  sorted,
  SPECS,
  truthOf,
  type Probe,
} from './helpers/tier-visibility-saved-set.ts';

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

test('a read-only reader stays served from the saved set while another store\'s import moves the ledger feed past its window', async () => {
  const { f, writer, ledgerDb, openReader, pk } = await fixtureWithEveryState();
  await writer.keepVisibilityCurrentInTurns();
  const reader = openReader();
  const rebuilds = countFullRebuilds(probe(reader).visibilityLedger()!);
  cleanups.push(() => rebuilds.restore());
  expect(probe(reader).tierHiddenItemPks().moving).toBe(1);
  const cursor = () => (ledgerDb.query('SELECT MAX(seq) AS seq FROM tier_visibility_changes').get() as { seq: number }).seq;
  const start = cursor();
  ledgerDb.query("UPDATE tier_copies SET copy_state = 'superseded' WHERE provider_item_id = 'plain' AND corpus_id = ?").run(CORPORA.internal);
  // The secure_local store imports; nothing reads the internal writer, whose
  // only work is the refresh the shared ledger's movement asks of it. Its own
  // leg of each sync runs without the end-of-import refresh, so only the
  // other store's import can keep it current.
  const held = (writer as unknown as { syncFromConnectorHeld: LocalConnectorStore['syncFromConnector'] }).syncFromConnectorHeld.bind(writer);
  const ownLeg = spyOn(writer, 'syncFromConnector').mockImplementation((connector, options) => held(connector, options));
  cleanups.push(() => ownLeg.mockRestore());
  const churn: FixtureSpec[] = Array.from({ length: 3_000 }, (_, n) => ({
    id: `secure-${n}`, name: `secure-${n}.txt`, text: `Secure note ${n}.`, legacyDomain: 'secure_local' as const,
  }));
  // Mid-import, once the ledger feed has moved past its whole window since
  // the reader's last read and the writer's saved stamp, the reader serves a
  // request.
  let served = false;
  const realTurn = controlPathHeadroom.ingestionTurn.bind(controlPathHeadroom);
  const turns = spyOn(controlPathHeadroom, 'ingestionTurn').mockImplementation(() => {
    if (!served && cursor() - start > 8_192 + 500) {
      served = true;
      expect(probe(reader).tierHiddenItemPks().hidden).toContain(pk('plain'));
    }
    return realTurn();
  });
  try {
    await f.set.sync(fixtureConnector(() => [...SPECS, ...churn]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  } finally {
    turns.mockRestore();
  }
  expect(served).toBe(true);
  // The reader never rebuilt: each read applied only the feed past the saved
  // stamp, and matches a connection that rebuilds from the ledger.
  const truth = openReader();
  spyOn(truth as unknown as { savedVisibilitySteps(): Generator<void, undefined> }, 'savedVisibilitySteps')
    .mockImplementation(function* () { return undefined; });
  expect(probe(reader).tierHiddenItemPks().hidden).toContain(pk('plain'));
  expect(sorted(probe(reader).tierHiddenItemPks())).toEqual(sorted(probe(truth).tierHiddenItemPks()));
  expect(reader.hasEmbeddings(MODEL)).toBe(truth.hasEmbeddings(MODEL));
  expect(rebuilds.count).toBe(0);
}, 120_000);
