// Family 3 of the loop-thread rule, under writes (plan thread, 15 Nov 2026):
// settle's sweeps raise items towards Private. A sweep's page is found on the
// ledger's read worker, so a row it hands the loop can be older than the
// ledger by the time the loop reaches it. The loop judges each row again from
// the row as it is now, read by key, so a raise can be delayed but not lost,
// and a decision made after the snapshot (a judge's verdict) is never written
// over with the older one.

import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { OwnerTierRule, TierDecision } from '../src/workers/classification/tier-classifier.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { shutdownReadPool } from '../src/workers/connector-store/off-thread-reads.ts';
import { sweepOwnerRuleRaises, sweepOwnerRuleRaisesOffThread } from '../src/workers/connector-store/tier-rules-sweep.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir, type FixtureSpec } from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  shutdownReadPool();
});

const RULE: OwnerTierRule = { id: 'files-personal', match: { kind: 'pathPrefix', value: '/Files/' }, tier: 'secure', strength: 'prior' };

async function publicFixture(ids: string[]) {
  const { dir, cleanup } = tempDir();
  const fixture = openTierFixture(dir, { embed: false });
  cleanups.push(() => { fixture.close(); cleanup(); });
  const specs: FixtureSpec[] = ids.map((id) => ({ id, name: `${id}.txt`, text: `harbour note ${id}` }));
  await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  for (const id of ids) {
    await moveTieredItem({
      set: fixture.set, identity: identityOf(id), target: { metadataTier: 'public', contentTier: 'public' },
      vectorIdentities: { public_safe: fixture.cloud },
      embeddingLedger: { path: join(dir, 'embedding-ledger.jsonl'), approvedBy: 'system-automatic' },
    });
    expect(fixture.ledger.getCurrent(identityOf(id))).toMatchObject({ metadataTier: 'public', contentTier: 'public', state: 'current' });
  }
  const set = fixture.set as unknown as { classification(): unknown };
  set.classification = () => ({ rules: [RULE] });
  return fixture;
}

/** Where an item is going: a raise to Private hides first and moves, so a moving row's target. */
function headed(fixture: Awaited<ReturnType<typeof publicFixture>>, id: string) {
  const row = fixture.ledger.getCurrent(identityOf(id))!;
  return row.state === 'moving'
    ? { metadataTier: row.targetMetadataTier, contentTier: row.targetContentTier }
    : { metadataTier: row.metadataTier, contentTier: row.contentTier };
}

test('a raise found on the worker lands on the row as it is now, and a newer verdict is kept', async () => {
  const ids = ['note-a', 'note-b', 'note-c'];
  const fixture = await publicFixture(ids);
  const ledger = fixture.ledger;
  // After the worker found the page, before the loop reaches note-b: the
  // secret detector makes note-b Secrets. The older row says Public, and
  // judged from it the rule would write Private over Secrets.
  let turns = 0;
  const judged = () => {
    const current = ledger.getCurrent(identityOf('note-b'))!;
    const decision: TierDecision = {
      metadataTier: 'secrets', contentTier: 'secrets', decidedBy: 'secret_detector', reasons: ['content:secret:api_key'],
      state: 'current', contentRead: true, metadataPending: false, contentPending: false,
      metadataForced: false, metadataFlagged: false, engineVersion: current.engineVersion, mapRevision: current.mapRevision, snifferId: 'test',
    };
    ledger.recordRoutedPlacement(identityOf('note-b'), decision, fixture.set.placementFor(decision));
  };
  const report = await sweepOwnerRuleRaisesOffThread({ set: fixture.set, turn: () => {
    if (turns++ === 0) judged();
    return undefined;
  } });
  expect(turns).toBeGreaterThanOrEqual(ids.length);
  expect(report.raised).toBe(2);
  // The others raised to the rule's Private; note-b stays Secrets.
  for (const id of ['note-a', 'note-c']) expect(headed(fixture, id)).toEqual({ metadataTier: 'secure', contentTier: 'secure' });
  expect(headed(fixture, 'note-b')).toEqual({ metadataTier: 'secrets', contentTier: 'secrets' });
});

test('a raise that cannot land yet is held, and lands on the next pass', async () => {
  const ids = ['note-a', 'note-b'];
  const fixture = await publicFixture(ids);
  const ledger = fixture.ledger;
  // note-a's copies can't be read the first time the loop reaches it (a
  // write in flight, a busy file): the sweep holds it instead of passing it.
  const copies = ledger.copies.bind(ledger);
  let failures = 1;
  ledger.copies = ((identity: Parameters<typeof copies>[0]) => {
    if (identity.providerItemId === 'note-a' && failures > 0) { failures -= 1; throw new Error('busy'); }
    return copies(identity);
  }) as typeof ledger.copies;
  const first = await sweepOwnerRuleRaisesOffThread({ set: fixture.set });
  expect(first).toMatchObject({ scanned: 2, raised: 1, complete: false });
  expect(headed(fixture, 'note-a').metadataTier).toBe('public');
  expect(headed(fixture, 'note-b').metadataTier).toBe('secure');
  const second = await sweepOwnerRuleRaisesOffThread({ set: fixture.set });
  expect(second).toMatchObject({ raised: 1, complete: true });
  expect(headed(fixture, 'note-a').metadataTier).toBe('secure');
  // Done: neither driver finds anything left to raise.
  expect(sweepOwnerRuleRaises({ set: fixture.set })).toMatchObject({ scanned: 0, raised: 0 });
});
