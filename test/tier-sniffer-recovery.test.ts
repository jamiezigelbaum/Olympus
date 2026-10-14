import { Database } from 'bun:sqlite';
import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';
import { dashboardSourceProgress } from '../src/workers/dashboard/phases.ts';
import type { DashboardSourceCard } from '../src/workers/source-dashboard.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

async function fixture(contentRead = true) {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false });
  const installed = new InstalledTierClassification({ env: {}, lane: BUILT_IN_SNIFFER_LANE });
  const identity = identityOf('stuck');
  await f.set.sync(fixtureConnector(() => [{ id: 'stuck', name: 'Notes', text: 'Ordinary notes.', legacyDomain: 'secure_local' }]), {
    fetchContent: true, placement: FIXTURE_PLACEMENT,
  });
  await moveTieredItem({ set: f.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
  const decision = { ...classifyItemTiers({ signals: { title: 'Notes' }, text: 'Ordinary notes.' }),
    metadataTier: 'secure' as const, contentTier: 'secure' as const, state: 'pending' as const,
    contentRead, metadataPending: false, contentPending: true,
    reasons: [contentRead ? 'content:sniffer:old:undecided' : 'content:unread'],
  };
  f.ledger.recordRoutedPlacement(identity, decision, f.set.placementFor(decision));
  if (!contentRead) {
    const db = new Database(f.ledger.dbPath);
    db.exec('UPDATE tier_items SET content_read = 0');
    db.close();
  }
  const age = new Database(f.ledger.dbPath);
  age.query('UPDATE tier_items SET decided_at = ?').run(new Date(Date.now() - 24 * 3_600_000).toISOString());
  age.close();
  let calls = 0;
  const service = new TierSnifferService({ installed, lane: BUILT_IN_SNIFFER_LANE,
    model: { async complete() { calls++; throw new Error('missing material must fail safe'); } },
    stores: () => f.set.openStores(), classificationLedgerPath: join(f.dir, 'classification.jsonl'),
    modelAvailable: () => false, rejudgePerPass: 0,
  });
  cleanup.push(() => { service.stop(); installed.close(); f.close(); tmp.cleanup(); });
  return { ...f, service, installed, identity, calls: () => calls };
}

for (const contentRead of [true, false]) test(`an upgraded pending row with no question settles Private (contentRead=${contentRead})`, async () => {
  const f = await fixture(contentRead);
  expect(f.service.backlog().pendingWithoutQuestion).toBe(1);
  await f.service.runOnce();
  expect(f.ledger.getCurrent(f.identity)).toMatchObject({ state: 'current', contentTier: 'secure', contentPending: false });
  expect(f.service.backlog().checkingItems).toBe(0);
  expect(f.calls()).toBe(0);
  expect(f.ledger.getCurrent(f.identity)?.reasons).toContainEqual(expect.stringMatching(/^content:sniffer:.*:fail_safe:missing_question$/));
  await f.service.runOnce();
  expect(f.ledger.counts().byState.pending).toBe(0);
});

test('a vanished item retires its pending ledger row without deleting stored content', async () => {
  const f = await fixture();
  for (const store of f.set.openStores()) store.tombstoneCopy(f.identity, { connectorId: 'fixture-deletion' });
  await f.service.runOnce();
  expect(f.ledger.getCurrent(f.identity)).toBeUndefined();
  expect(f.ledger.copies(f.identity)).toEqual([]);
  expect(f.service.backlog().checkingItems).toBe(0);
});

test('an unreadable store is retried and an existing question is preserved', async () => {
  const f = await fixture();
  const queue = f.installed.snifferStoreForLedger(f.ledger.dbPath);
  queue.enqueue({ subject: f.identity, pass: 'content', material: 'Ordinary notes.', flags: [], mapRevision: 'none' });
  await f.service.runOnce();
  expect(f.ledger.getCurrent(f.identity)?.state).toBe('pending');
  expect(queue.counts().questions).toBe(1);
  queue.deleteQuestion(f.identity, 'content');
  const store = f.stores.secure_local!;
  const original = store.exportItemCopy;
  store.exportItemCopy = () => { throw new Error('read failure'); };
  await f.service.runOnce();
  expect(f.ledger.getCurrent(f.identity)?.state).toBe('pending');
  store.exportItemCopy = original;
  await f.service.runOnce();
  expect(f.ledger.getCurrent(f.identity)?.state).toBe('current');
});

test('classification held items wait for automatic checking instead of reporting an unactionable embedding stall', () => {
  const card = {
    source_id: 'fixture', connection: { state: 'connected' }, freshness: { label: 'Current' }, kind: 'messages', coverage: { indexed_items: 11, content_ready_items: 11, embedded_files: 0 },
    content_arrives_extracted: true, embedding_required: true,
    tier_classification: { pending_classification_items: 11, secrets_located: 0, superseded_chunks: 0, names_only_kept_chunks: 0 },
    schedule: { last_success_at: '2026-10-01T00:00:00Z', consecutive_failures: 0 },
    movement: { metadata_sync_at: '2026-10-01T00:00:00Z', extraction_at: '2026-10-01T00:00:00Z', embedding_at: '2026-10-01T00:00:00Z' },
  } as unknown as DashboardSourceCard;
  const phase = dashboardSourceProgress(card, { now: new Date('2026-10-14T00:00:00Z') }).phases.find(p => p.id === 'embedding');
  expect(phase?.state).toBe('waiting');
  expect(phase?.state_words).toContain('Waiting to be checked');
});

for (const mismatch of ['unflagged', 'not_secret'] as const) test(`recovery also settles ${mismatch} pending decisions without a question`, async () => {
  const f = await fixture();
  if (mismatch === 'unflagged') {
    const db = new Database(f.ledger.dbPath);
    db.exec("UPDATE tier_items SET metadata_pending = 0, content_pending = 0 WHERE state = 'pending'");
    db.close();
  } else f.ledger.setOverride(f.identity, { kind: 'not_secret' });
  await f.service.runOnce();
  expect(f.ledger.getCurrent(f.identity)).toMatchObject({ state: 'current', contentTier: 'secure' });
  if (mismatch === 'not_secret') expect(f.ledger.getOverride(f.identity)).toEqual({ kind: 'not_secret' });
});
