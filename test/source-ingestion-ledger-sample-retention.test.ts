// The ledger writer and the dashboard writer append to one shared
// source_dashboard_samples table, but only the dashboard writer used to prune
// it. On a headless install the scheduler's afterTick hook is the only writer
// that ever runs, so the table grew without bound.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import {
  buildSourceIngestionLedgerSnapshot,
  SqliteSourceIngestionLedgerStore,
} from '../src/workers/source-ingestion-ledger.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';

function emptyStatus(generatedAt: string): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: generatedAt,
    corpora: [],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  };
}

describe('source ingestion ledger sample retention', () => {
  test('the ledger writer prunes dashboard samples older than the retention window', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-ledger-retention-'));
    const dbPath = join(dir, 'source-dashboard.sqlite');
    const store = new SqliteSourceIngestionLedgerStore(dbPath);
    const record = (iso: string): void => {
      const now = new Date(iso);
      store.record(buildSourceIngestionLedgerSnapshot(emptyStatus(iso), { now }));
    };
    try {
      record('2026-08-01T00:00:00.000Z');
      record('2026-08-01T12:00:00.000Z');
      record('2026-08-02T06:00:00.000Z');

      const db = new Database(dbPath, { readonly: true });
      try {
        const oldest = (db.query(
          'SELECT MIN(sampled_at) AS oldest FROM source_dashboard_samples',
        ).get() as { oldest: string }).oldest;
        // The first tick is more than 24h behind the newest sample.
        expect(oldest).toBe('2026-08-01T12:00:00.000Z');
        expect((db.query(
          'SELECT COUNT(*) AS count FROM source_dashboard_samples',
        ).get() as { count: number }).count).toBe(14);
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the ledger writer caps samples per corpus so one long-running tick lane cannot grow forever', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-ledger-cap-'));
    const dbPath = join(dir, 'source-dashboard.sqlite');
    const store = new SqliteSourceIngestionLedgerStore(dbPath);
    try {
      // A minute apart keeps every sample inside the retention window, so only
      // the per-corpus cap can bound the table.
      const base = Date.parse('2026-08-01T00:00:00.000Z');
      for (let tick = 0; tick < 780; tick += 1) {
        const iso = new Date(base + tick * 60_000).toISOString();
        store.record(buildSourceIngestionLedgerSnapshot(emptyStatus(iso), { now: new Date(iso) }));
      }

      const db = new Database(dbPath, { readonly: true });
      try {
        const worst = (db.query(`
          SELECT COUNT(*) AS count FROM source_dashboard_samples
          GROUP BY corpus_id ORDER BY count DESC LIMIT 1
        `).get() as { count: number }).count;
        expect(worst).toBeLessThanOrEqual(720);
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
    // 780 single-sample transactions (7 inserts + 7 subquery trims each) are
    // ~1s on an idle machine and 5-7s on a loaded CI runner — the work is the
    // point, its duration is not. The default 5s timeout false-failed two
    // main pushes on 2026-08-24 before anyone read the failure as a timeout.
  }, 30_000);
});
