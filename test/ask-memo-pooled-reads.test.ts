import { afterEach, expect, test } from 'bun:test';
import { TierLedger, tierLedgerIdentityKey } from '../src/workers/classification/tier-ledger.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { itemStatesOffThread, memoVisibilityItemsHere, VisibilityChangedError } from '../src/workers/connector-store/child-visibility.ts';
import { shutdownReadPool } from '../src/workers/connector-store/off-thread-reads.ts';
import { createSourceAnswerTrace, runWithSourceAnswerTrace } from '../src/workers/source-index/answer-latency-trace.ts';
import { identityOf, tempDir } from './helpers/tier-fixtures.ts';

const cleanup: Array<() => void> = [];
afterEach(async () => {
  for (const done of cleanup.splice(0).reverse()) done();
  await shutdownReadPool();
});

test('a read taken on another connection while the ledger holds writes is never reused later in the Ask', async () => {
  const tmp = tempDir();
  const ledger = new TierLedger({ dbPath: `${tmp.dir}/ledger.sqlite` });
  cleanup.push(() => { ledger.close(); tmp.cleanup(); });
  const identity = identityOf('parent');
  const decision = classifyItemTiers({ signals: { title: 'Parent' }, text: 'Ordinary notes.' });
  ledger.recordDecision(identity, decision);
  const key = tierLedgerIdentityKey(identity);
  const statesHere = () => memoVisibilityItemsHere(ledger, 'states', () => ledger.changeMarker(), [identity], tierLedgerIdentityKey,
    missing => ledger.itemStatesForMany(missing));

  let pooled: unknown;
  await runWithSourceAnswerTrace(createSourceAnswerTrace(), async () => {
    await ledger.holdingWrites(async () => {
      ledger.putWriteIntent({ identity, connectorId: 'fixture', kind: 'deletion' });
      // The other connection cannot see the uncommitted intent: the read is refused.
      try { pooled = (await itemStatesOffThread(ledger, [identity])).get(key); } catch (error) { pooled = error; }
    });
    // Committed now. A later check in the same Ask sees the deletion.
    expect(statesHere().get(key)?.hidingIntent).toBe('deletion');
  });
  expect(pooled).toBeInstanceOf(VisibilityChangedError);
});
