import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TierSnifferStore, type SnifferPass } from '../src/workers/classification/sniffer-store.ts';

for (const scenario of ['new metadata', 'new content', 'promoted'] as const) {
  test(`${scenario} priority work is visible next tick above a persisted 100k blocked scan`, () => {
    const root = mkdtempSync(join(tmpdir(), 'sniffer-priority-'));
    const dbPath = join(root, 'queue.sqlite');
    const pass: SnifferPass = scenario === 'new content' ? 'content' : 'metadata';
    const now = () => new Date('2026-10-13T00:00:00Z');
    let store = new TierSnifferStore({ dbPath, now });
    try {
      // Bulk-create synthetic blocked questions without paying for 100k fsyncs.
      // No cursor is planted: real eligibility scans below must persist it.
      const seed = new Database(dbPath);
      try {
        seed.query(`WITH RECURSIVE backlog(n) AS (
          VALUES(1) UNION ALL SELECT n + 1 FROM backlog WHERE n < 100000
        ) INSERT INTO sniffer_questions
          (provider, account_scope, provider_item_id, pass, material_hash,
           map_revision, material, flags_json, queued_at, priority)
        SELECT 'fixture', 'synthetic', 'blocked-' || n, ?, 'fixture-hash',
          'none', 'synthetic question', '[]', '2026-01-01T00:00:00.000Z', 10 FROM backlog`).run(pass);
      } finally { seed.close(); }
      for (const scanPass of [undefined, pass]) {
        let examined = 0;
        expect(store.listQuestions({ ...(scanPass ? { pass: scanPass } : {}), limit: 500, eligible: () => { examined++; return false; } })).toEqual([]);
        expect(examined).toBe(1000); // At most 500 recent and 500 oldest.
      }
      store.close();
      store = new TierSnifferStore({ dbPath, now });
      const providerItemId = scenario === 'promoted' ? 'blocked-50000' : 'new-held-record';
      store.enqueue({
        subject: { provider: 'fixture', accountScope: 'synthetic', providerItemId },
        pass, material: 'synthetic held record', mapRevision: 'none', flags: [],
        priority: scenario === 'promoted' ? 20 : 10,
      });
      store.close();
      store = new TierSnifferStore({ dbPath, now });
      for (const scanPass of [undefined, pass]) {
        const examined: string[] = [];
        const ready = store.listQuestions({ ...(scanPass ? { pass: scanPass } : {}), limit: 500, eligible: question => {
          examined.push(question.providerItemId);
          return question.providerItemId === providerItemId;
        } });
        expect(ready.map(question => question.providerItemId)).toEqual([providerItemId]);
        expect(examined.length).toBeLessThanOrEqual(1000);
        // Priority arrivals must not rewind progress through the oldest work.
        expect(examined).toContain('blocked-501');
        expect(examined).not.toContain('blocked-1');
      }
    } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
  }, 30_000);
}
