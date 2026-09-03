// Canonical Gmail stores are disjoint by trust domain, so the family ledger
// must count both without applying the retired custodial-index correction.

import { describe, expect, test } from 'bun:test';
import { buildSourceIngestionLedgerSnapshot } from '../src/workers/source-ingestion-ledger.ts';
import type { SourceIndexStatusResult } from '../src/workers/source-index/status.ts';

const GENERATED_AT = '2026-08-01T12:00:00.000Z';

function emailStatus(): SourceIndexStatusResult {
  return {
    kind: 'source_index_status',
    generated_at: GENERATED_AT,
    corpora: [
      {
        corpus_id: 'secure_local.email.private',
        family: 'email',
        trust_domain: 'secure_local',
        configured: true,
        provider: 'gmail',
        read_authority: 'connector_store',
        counts: { indexed_items: 100, private_chunks: 60, items_with_text: 60 },
        item_metadata_returned: false,
      },
      {
        corpus_id: 'internal.email',
        family: 'email',
        trust_domain: 'internal',
        configured: true,
        provider: 'gmail',
        read_authority: 'connector_store',
        counts: { indexed_items: 40, internal_chunks: 40, items_with_text: 40 },
        item_metadata_returned: false,
      },
    ],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_packets_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      castor_visible: true,
    },
  } as unknown as SourceIndexStatusResult;
}

function emailRow(status: SourceIndexStatusResult) {
  const snapshot = buildSourceIngestionLedgerSnapshot(status, { now: new Date(GENERATED_AT) });
  const row = snapshot.rows.find((entry) => entry.corpus_ids.includes('secure_local.email.private'));
  expect(row).toBeDefined();
  return row!;
}

describe('ledger counts canonical trust-domain stores', () => {
  test('the two disjoint Gmail stores both contribute to the family total', () => {
    const row = emailRow(emailStatus());

    expect(row.items).toBe(140);
    expect(row.content_indexed).toBe(100);
    expect(row.corpus_ids).toContain('internal.email');
    expect(row.trust_domains).toContain('internal');
  });
});
