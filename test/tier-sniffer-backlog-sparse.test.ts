import { Database } from 'bun:sqlite';
import { afterEach, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { InstalledTierClassification } from '../src/workers/classification/installed-tier-classification.ts';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { TierSnifferService } from '../src/workers/classification/sniffer-service.ts';
import { TierLedger, tierLedgerPathForStore } from '../src/workers/classification/tier-ledger.ts';
import { tierSnifferPathForLedger } from '../src/workers/classification/tier-ledger-path.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { identityOf, tempDir } from './helpers/tier-fixtures.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

// Observe real aggregate slice work without exposing a product test hook.
interface SliceProbe {
  addPendingSlice(counts: unknown, opened: unknown, range: [number, number] | undefined): void;
  addQuestionSlice(counts: unknown, db: Database, range: [number, number] | undefined): void;
  countBacklogInSlices(): Promise<Record<string, number> | undefined>;
}

test('sparse backlog reads slices of existing rows and stops at both initial high-water marks', async () => {
  const tmp = tempDir();
  cleanup.push(() => tmp.cleanup());
  const storePath = join(tmp.dir, 'store.sqlite');
  const ledger = new TierLedger({ dbPath: tierLedgerPathForStore(storePath) });
  cleanup.push(() => ledger.close());
  const installed = new InstalledTierClassification({ env: {}, lane: BUILT_IN_SNIFFER_LANE });
  cleanup.push(() => installed.close());
  const queue = installed.snifferStoreForLedger(ledger.dbPath);
  const decision = classifyItemTiers({ signals: { title: 'Notes' }, text: 'Ordinary notes.' });
  const record = (id: string, pending: boolean) => ledger.recordDecision(identityOf(id), {
    ...decision, state: pending ? 'pending' : 'current', contentRead: true,
    metadataPending: false, contentPending: pending,
  });
  for (const [id, pending] of [['00', true], ['01', true], ['02', false], ['03', false]] as const) record(id, pending);
  for (const [id, pass] of [['00', 'metadata'], ['00', 'content'], ['02', 'content']] as const) {
    queue.enqueue({ subject: identityOf(id), pass, material: 'Ordinary notes.', flags: [], mapRevision: 'none' });
  }
  // Simulate large retired/deleted ranges without creating millions of rows.
  const db = new Database(ledger.dbPath);
  const qdb = new Database(tierSnifferPathForLedger(ledger.dbPath));
  cleanup.push(() => { qdb.close(); db.close(); });
  for (const [id, rowid] of [['00', 11], ['01', 1_000_000], ['02', 9_000_000], ['03', 100_000_000]] as const) {
    db.query('UPDATE tier_items SET rowid = ?, decided_at = ? WHERE provider_item_id = ?')
      .run(rowid, '2026-11-01T00:00:00.000Z', identityOf(id).providerItemId);
  }
  // Move in descending order so existing primary keys never collide.
  const questions = qdb.query('SELECT question_pk AS pk FROM sniffer_questions ORDER BY question_pk DESC').all() as Array<{ pk: number }>;
  const keys = [20_000_000, 2_000_000, 31];
  questions.forEach((row, i) => qdb.query('UPDATE sniffer_questions SET question_pk = ? WHERE question_pk = ?').run(keys[i]!, row.pk));
  const service = new TierSnifferService({ installed, lane: BUILT_IN_SNIFFER_LANE,
    model: { async complete() { throw new Error('counting must not infer'); } },
    stores: () => [{ dbPath: storePath }], classificationLedgerPath: join(tmp.dir, 'classification.jsonl'),
    now: () => new Date('2026-11-06T00:00:00.000Z'), backlogSliceRows: 2,
  });
  cleanup.push(() => service.stop());
  // The normal count is forced onto the exact branch using its existing seam.
  const exact = new TierSnifferService({ installed, lane: BUILT_IN_SNIFFER_LANE,
    model: { async complete() { throw new Error('counting must not infer'); } },
    stores: () => [{ dbPath: storePath }], classificationLedgerPath: join(tmp.dir, 'classification.jsonl'),
    now: () => new Date('2026-11-06T00:00:00.000Z'), backlogExactRows: Number.MAX_SAFE_INTEGER,
  });
  cleanup.push(() => exact.stop());
  const expected = exact.backlog();
  expect(expected).toMatchObject({ checkingItems: 3, remainingQuestions: 3, pendingItems: 2, pendingWithoutQuestion: 1, oldestPendingAgeMs: 5 * 86_400_000 });

  const probe = service as unknown as SliceProbe;
  const originalPending = probe.addPendingSlice.bind(service);
  let inserted = false;
  const pending = spyOn(probe, 'addPendingSlice').mockImplementation((...args) => {
    originalPending(...args);
    if (!inserted) {
      inserted = true;
      record('04-new', true);
      queue.enqueue({ subject: identityOf('04-new'), pass: 'content', material: 'New notes.', flags: [], mapRevision: 'none' });
    }
  });
  const questionsRead = spyOn(probe, 'addQuestionSlice');
  cleanup.push(() => { questionsRead.mockRestore(); pending.mockRestore(); });
  const counted = await probe.countBacklogInSlices();
  expect(counted).toEqual({ checkingItems: expected.checkingItems, remainingQuestions: expected.remainingQuestions,
    pendingItems: expected.pendingItems, pendingWithoutQuestion: expected.pendingWithoutQuestion, oldestPendingAgeMs: expected.oldestPendingAgeMs });
  expect(pending).toHaveBeenCalledTimes(2);
  expect(questionsRead).toHaveBeenCalledTimes(2);
  expect(pending.mock.calls.map(call => call[2])).toEqual([[0, 1_000_000], [1_000_000, 100_000_000]]);
  expect(questionsRead.mock.calls.map(call => call[2])).toEqual([[0, 2_000_000], [2_000_000, 20_000_000]]);
  // The appended row really exists, but belongs to the next refresh.
  expect(exact.backlog()).toMatchObject({ pendingItems: 3, remainingQuestions: 4 });
});
