import { afterEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { TierSnifferService, MISSING_QUESTION_RECOVERY_PHASE_MS } from '../src/workers/classification/sniffer-service.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

test('both recovery phases bound store work, resume partial pages durably, and wrap to retry held rows', async () => {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false });
  const installed = new InstalledTierClassification({ env: {}, lane: BUILT_IN_SNIFFER_LANE });
  cleanup.push(() => { installed.close(); f.close(); tmp.cleanup(); });
  const ids = ['00-retry', '01', '02-queued', '03', '04', '05'];
  await f.set.sync(fixtureConnector(() => ids.map(id => ({ id, name: 'Notes', text: 'Ordinary notes.', legacyDomain: 'secure_local' as const }))), {
    fetchContent: true, placement: FIXTURE_PLACEMENT,
  });
  const decision = { ...classifyItemTiers({ signals: { title: 'Notes' }, text: 'Ordinary notes.' }),
    metadataTier: 'secure' as const, contentTier: 'secure' as const, state: 'pending' as const,
    contentRead: true, metadataPending: false, contentPending: true, reasons: ['content:sniffer:old:undecided'],
  };
  for (const id of ids) {
    await moveTieredItem({ set: f.set, identity: identityOf(id), target: { metadataTier: 'secure', contentTier: 'secure' } });
    f.ledger.recordRoutedPlacement(identityOf(id), decision, f.set.placementFor(decision));
    expect(f.ledger.getCurrent(identityOf(id))).toMatchObject({ state: 'pending', contentTier: 'secure', contentPending: true });
  }
  const queue = installed.snifferStoreForLedger(f.ledger.dbPath);
  queue.enqueue({ subject: identityOf('02-queued'), pass: 'content', material: 'Ordinary notes.', flags: [], mapRevision: 'none' });

  // Only synchronous store reads consume this clock. Each row costs more
  // than one phase's allowance, independent of machine speed or timers.
  let clock = 0;
  const time = spyOn(performance, 'now').mockImplementation(() => clock);
  cleanup.push(() => time.mockRestore());
  let failFirst = true;
  let exports = 0;
  for (const store of f.set.openStores()) {
    const original = store.exportItemCopy.bind(store);
    const read = spyOn(store, 'exportItemCopy').mockImplementation(identity => {
      exports++;
      clock += MISSING_QUESTION_RECOVERY_PHASE_MS + 1;
      if (failFirst && identity.providerItemId === identityOf('00-retry').providerItemId) throw new Error('read failure');
      return original(identity);
    });
    cleanup.push(() => read.mockRestore());
  }
  const makeService = () => new TierSnifferService({ installed, lane: BUILT_IN_SNIFFER_LANE,
    model: { async complete() { throw new Error('no model work permitted'); } },
    stores: () => f.set.openStores(), classificationLedgerPath: join(f.dir, 'classification.jsonl'),
    autoApproveBuiltIn: true, rejudgePerPass: 0, maxCallsPerPass: 0,
  });
  let service = makeService();
  cleanup.push(() => service.stop());
  const first = await service.runOnce();
  expect(first.state).toBe('ran');
  // The same failed row is visited once by each independent phase, rather
  // than the full six-row page twice. No failed read releases its content.
  expect(exports).toBe(2);
  expect(f.ledger.getCurrent(identityOf('00-retry'))?.state).toBe('pending');
  expect(f.ledger.getCurrent(identityOf('05'))?.state).toBe('pending');
  expect(JSON.parse(f.ledger.readMeta('sniffer_missing_question_cursor_v1')!)).toMatchObject({ provider: 'fixture', accountScope: 'personal', providerItemId: '00-retry' });
  expect(JSON.parse(f.ledger.readMeta('sniffer_missing_question_reask_cursor_v1')!)).toMatchObject({ provider: 'fixture', accountScope: 'personal', providerItemId: '00-retry' });

  // A new service must resume after the examined row, not the unexamined
  // end of the page. Eventually the short page wraps to retry that row.
  service.stop();
  service = makeService();
  failFirst = false;
  for (let tick = 0; tick < 12; tick++) {
    const before = exports;
    expect((await service.runOnce()).state).toBe('ran');
    expect(exports - before).toBeLessThanOrEqual(2 * f.set.openStores().length);
  }
  for (const id of ids.filter(id => id !== '02-queued')) {
    expect(f.ledger.getCurrent(identityOf(id))).toMatchObject({ state: 'current', contentTier: 'secure', contentPending: false });
    expect(f.ledger.getCurrent(identityOf(id))?.reasons).toContainEqual(expect.stringMatching(/:fail_safe:missing_question$/));
  }
  expect(f.ledger.getCurrent(identityOf('02-queued'))?.state).toBe('pending');
  expect(queue.questionFor(identityOf('02-queued'), 'content')).toBeDefined();
});
