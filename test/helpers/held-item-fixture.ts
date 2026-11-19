import { Database } from 'bun:sqlite';
import { TierLedger } from '../../src/workers/classification/tier-ledger.ts';

/** Seed pending items with copies in all supplied corpora. All content is synthetic. */
export function seedHeldLedger(path: string, corpora: readonly string[], accountScopes: readonly string[], items = 1): TierLedger {
  const ledger = new TierLedger({ dbPath: path });
  const db = new Database(path, { create: false });
  try {
    db.transaction(() => {
      for (const account of accountScopes) {
        db.query(`
          WITH RECURSIVE items(value) AS (SELECT 1 UNION ALL SELECT value + 1 FROM items WHERE value < ?1)
          INSERT INTO tier_items (provider, account_scope, provider_item_id, family, metadata_tier, content_tier,
            generation, decided_by, reasons_json, engine_version, map_revision, state, metadata_pending, decided_at)
          SELECT 'local_files', ?2, value, 'file', 'private', 'private', 1, 'fixture', '[]', 'fixture', 'fixture',
            'pending', 1, '2026-11-18T00:00:00Z' FROM items
        `).run(account, items);
        for (const corpus of corpora) db.query(`
          INSERT INTO tier_copies (provider, account_scope, provider_item_id, corpus_id,
            trust_domain, layers, copy_state, generation, updated_at)
          SELECT provider, account_scope, provider_item_id, ?, 'secure_local', 'both', 'current',
            generation, decided_at FROM tier_items WHERE account_scope = ?
        `).run(corpus, account);
      }
    })();
    return ledger;
  } catch (error) {
    ledger.close();
    throw error;
  } finally {
    db.close();
  }
}
