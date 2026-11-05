import { describe, expect, test } from 'bun:test';
import { TierLedger, type TierLedgerIdentity } from '../src/workers/classification/tier-ledger.ts';

// listAwaitingTextWindow looks at a bounded window of the ledger per call, so a
// ledger with few rows waiting on text is walked a window at a time instead of
// whole (Sparta, 2026-11-05: a 10 s freeze in one names-only settle pass).
describe('listAwaitingTextWindow', () => {
  test('examines at most a window of rows, resumes after it, and finds every waiting row once', () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const db = (ledger as unknown as { db: import('bun:sqlite').Database }).db;
    const now = new Date().toISOString();
    const insert = db.prepare(`INSERT INTO tier_items (provider, account_scope, conversation_key, provider_item_id, family, metadata_tier,
      content_tier, generation, decided_by, reasons_json, engine_version, map_revision, state, decided_at, routed, content_read, content_pending)
      VALUES ('drive', 'a', '', ?, 'file', 'private', 'private', 1, 'sniffer', '[]', 'v', 'r', ?, ?, 1, ?, ?)`);
    const waiting: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      const id = `item-${String(i).padStart(3, '0')}`;
      const awaits = i % 25 === 7;
      if (awaits) waiting.push(id);
      insert.run(id, awaits ? 'pending' : 'current', now, awaits ? 0 : 1, awaits ? 1 : 0);
    }
    const seen: string[] = [];
    let after: TierLedgerIdentity | undefined;
    let calls = 0;
    for (;;) {
      calls += 1;
      const page = ledger.listAwaitingTextWindow({ limit: 10, examine: 20, ...(after ? { after } : {}) });
      seen.push(...page.records.map((record) => record.providerItemId));
      if (!page.resumeAfter) break;
      after = page.resumeAfter;
      expect(calls).toBeLessThan(20);
    }
    expect(seen).toEqual(waiting);
    // 100 rows, 20 examined per call: the walk takes five full windows and a last, empty one.
    expect(calls).toBe(6);
    ledger.close();
  });
});
