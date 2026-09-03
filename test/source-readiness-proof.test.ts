import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_REGISTERED_SOURCE_CORPORA,
  buildSourceReadinessProof,
  corpusProofFromStatus,
  runSourceReadinessProof,
} from '../scripts/source-readiness-proof.ts';
import type { EmailClient, SourceIndexStatusResult } from '../src/core/email.ts';

describe('source readiness proof', () => {
  test('summarizes every registered corpus including message lanes', () => {
    const report = buildSourceReadinessProof([
      {
        corpus_id: 'internal.drive.docs',
        family: 'file',
        trust_domain: 'internal',
        activation_mode: 'hybrid_primary',
        embedding_policy: 'cloud_allowed_by_policy',
        configured: true,
        status: 'ready',
        last_refresh: {
          status: 'completed',
          completed_at: '2026-06-21T08:00:00.000Z',
          items_seen: 10,
          items_indexed: 10,
        },
        counts: {
          indexed_items: 10,
          chunks: 10,
          embedded_chunks: 10,
          sync_runs: 1,
        },
        embedding: {
          required: true,
          ready: true,
          coverage_ratio: 1,
        },
        retrieval: {
          declared_mode: 'hybrid_primary',
          servable_mode: 'hybrid',
          state: 'ready',
        },
        actions: [],
      },
    ], new Date('2026-06-21T08:30:00.000Z'));

    expect(report.kind).toBe('source_readiness_proof');
    expect(report.status).toBe('ready');
    expect(report.summary).toMatchObject({ ready: 1, watch: 0, attention: 0 });
    expect(report.corpora).toHaveLength(1);
    expect(report.policy).toMatchObject({
      raw_source_exposed: false,
      source_text_returned: false,
      secure_local_item_metadata_exposed: false,
      all_registered_corpora_included: true,
      read_only: true,
    });
  });

  test('maps status corpora to actionable readiness without raw source fields', () => {
    const status: SourceIndexStatusResult = {
      kind: 'source_index_status',
      generated_at: '2026-06-21T08:00:00.000Z',
      corpora: [{
        corpus_id: 'secure_local.dropbox.files',
        family: 'file',
        trust_domain: 'secure_local',
        activation_mode: 'hybrid_primary',
        embedding_policy: 'local_only',
        configured: true,
        provider: 'dropbox',
        read_authority: 'connector_store',
        retrieval: {
          declared_mode: 'hybrid_primary',
          servable_mode: 'keyword',
          state: 'degraded',
          reason: 'no_current_embedding_artifacts',
        },
        counts: {
          indexed_items: 5,
          tombstoned_items: 0,
          chunks: 4,
          accounts: 1,
          files: 5,
          folders: 1,
          tombstones: 0,
          secure_local_chunks: 4,
          extraction_artifacts: 4,
          extraction_jobs: 5,
          extraction_jobs_queued: 2,
          extraction_jobs_leased: 1,
          extraction_jobs_blocked: 0,
          extraction_jobs_skipped: 0,
          extraction_jobs_failed: 1,
          sync_runs: 1,
          retrieval_audits: 0,
          semantic_runs: 1,
          embedding_models: 1,
          embedded_chunks: 3,
          qa_total_items: 5,
          qa_pass: 1,
          qa_metadata_only_expected: 0,
          qa_metadata_only_gap: 1,
          qa_raster_ocr_vlm_escalation: 0,
          qa_low_confidence_retry_local: 0,
          qa_low_confidence_candidate_for_venice: 1,
          qa_blocked_policy: 0,
          qa_failed_needs_operator: 1,
          qa_pending: 1,
          qa_visible_gaps: 3,
          qa_low_confidence: 1,
        },
        metadata_only_gap_breakdown: {
          kind: 'dropbox_metadata_only_gap_breakdown',
          total: 1,
          likely_needs_extraction: 1,
          likely_deferred_metadata_only: 0,
          unknown_or_needs_policy: 0,
          by_mime: [{ key: 'application/pdf', count: 1 }],
          by_extension: [{ key: '.pdf', count: 1 }],
          by_path_category: [{ key: 'document_like', count: 1 }],
          by_size_bucket: [{ key: 'small_513b_to_100kb', count: 1 }],
          by_decision_category: [{ key: 'likely_needs_extraction', count: 1 }],
          policy: {
            counts_only: true,
            raw_paths_exposed: false,
            file_names_exposed: false,
            source_text_returned: false,
            scope_keys_exposed: false,
            derived_from_existing_metadata: true,
          },
        },
        last_refresh: {
          sync_run_id: 'sync-1',
          status: 'completed',
          completed_at: '2026-06-21T08:00:00.000Z',
          items_seen: 5,
          items_indexed: 5,
        },
        item_metadata_returned: false,
        skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
      }],
      policy: {
        read_only: true,
        raw_source_exposed: false,
        source_packets_exposed: false,
        source_text_returned: false,
        secure_local_item_metadata_exposed: false,
        castor_visible: true,
      },
    };

    const proof = corpusProofFromStatus(status, 'secure_local.dropbox.files');
    expect(proof.status).toBe('attention');
    expect(proof.retrieval).toEqual({
      declared_mode: 'hybrid_primary',
      servable_mode: 'keyword',
      state: 'degraded',
      reason: 'no_current_embedding_artifacts',
    });
    expect(proof.actions).toContain(
      'secure_local.dropbox.files: declared hybrid_primary is unservable; keyword fallback is active (no_current_embedding_artifacts).',
    );
    expect(proof.counts).toMatchObject({
      indexed_items: 5,
      chunks: 4,
      embedded_chunks: 3,
      extraction_failed: 1,
      extraction_queued: 2,
      extraction_leased: 1,
    });
    expect(proof.qa).toEqual({
      total_items: 5,
      pass: 1,
      stale_revision: 0,
      metadata_only_expected: 0,
      metadata_only_gap: 1,
      low_confidence_retry_local: 0,
      low_confidence_candidate_for_venice: 1,
      blocked_policy: 0,
      failed_needs_operator: 1,
      pending: 1,
      visible_gaps: 3,
      low_confidence: 1,
    });
    expect(proof.actions).toContain('secure_local.dropbox.files: repair 1 failed extraction job(s).');
    expect(proof.actions).toContain('secure_local.dropbox.files: drain 2 queued extraction job(s).');
    expect(proof.actions).toContain('secure_local.dropbox.files: wait for or complete 1 leased extraction job(s).');
    expect(proof.actions).toContain('secure_local.dropbox.files: review 3 extraction QA gap(s).');
    expect(proof.actions).toContain('secure_local.dropbox.files: consider Venice escalation for 1 low-confidence hard document item(s).');
    expect(JSON.stringify(proof)).not.toContain('/Olympus Approved');
    expect(JSON.stringify(proof)).not.toContain('sync-1');
  });

  test('keeps the default registered target list explicit, including messages and connector stores', () => {
    expect(DEFAULT_REGISTERED_SOURCE_CORPORA).toEqual([
      'secure_local.email.private',
      'internal.email',
      'internal.drive.docs',
      'secure_local.drive.docs',
      'internal.telegram.messages',
      'internal.readwise.library',
      'internal.x.bookmarks',
      'secure_local.dropbox.files',
      'secure_local.telegram.protected.messages',
      'secure_local.whatsapp.messages',
    ]);
  });

  test('flags exact embedding parity gaps for a message corpus and a connector store', () => {
    const connectorCorpusId = 'internal.fixture.connector-store';
    const status = {
      kind: 'source_index_status',
      generated_at: '2026-07-21T10:00:00.000Z',
      corpora: [
        readinessStatusCorpus('secure_local.whatsapp.messages', 'chat', 4, 2),
        readinessStatusCorpus(connectorCorpusId, 'file', 3, 1),
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

    const message = corpusProofFromStatus(status, 'secure_local.whatsapp.messages');
    const connector = corpusProofFromStatus(status, connectorCorpusId);
    expect(message.counts).toMatchObject({ chunks: 4, embedded_chunks: 2 });
    expect(message.embedding).toMatchObject({ required: true, ready: false, coverage_ratio: 0.5 });
    expect(message.actions).toContain('secure_local.whatsapp.messages: refresh embeddings (2/4 chunks embedded).');
    expect(connector.counts).toMatchObject({ chunks: 3, embedded_chunks: 1 });
    expect(connector.actions).toContain(`${connectorCorpusId}: refresh embeddings (1/3 chunks embedded).`);
  });

  test('does not gate an intentionally lexical-only corpus on optional vector parity', () => {
    const corpusId = 'secure_local.fixture.lexical';
    const corpus = {
      ...readinessStatusCorpus(corpusId, 'file', 4, 1),
      activation_mode: 'lexical_only',
      retrieval: {
        declared_mode: 'lexical_only',
        servable_mode: 'keyword',
        state: 'ready',
      },
    };
    const status = {
      kind: 'source_index_status',
      generated_at: '2026-07-21T10:00:00.000Z',
      corpora: [corpus],
      policy: {
        read_only: true,
        raw_source_exposed: false,
        source_packets_exposed: false,
        source_text_returned: false,
        secure_local_item_metadata_exposed: false,
        castor_visible: true,
      },
    } as unknown as SourceIndexStatusResult;

    const proof = corpusProofFromStatus(status, corpusId);
    expect(proof.embedding).toEqual({ required: false, ready: true, coverage_ratio: 0.25 });
    expect(proof.status).toBe('ready');
    expect(proof.actions).not.toContain(`${corpusId}: refresh embeddings (1/4 chunks embedded).`);
  });

  test('returns an attention report instead of throwing when source status is unavailable', async () => {
    const client = {
      sourceIndexStatus: async () => {
        throw new Error('worker offline');
      },
    } as unknown as EmailClient;

    const report = await runSourceReadinessProof({
      client,
      now: new Date('2026-06-21T08:30:00.000Z'),
    });

    expect(report.status).toBe('attention');
    expect(report.summary.attention).toBe(DEFAULT_REGISTERED_SOURCE_CORPORA.length);
    expect(report.actions[0]).toContain('source status unavailable: worker offline');
  });
});

function readinessStatusCorpus(corpusId: string, family: string, chunks: number, embeddedChunks: number) {
  return {
    corpus_id: corpusId,
    family,
    trust_domain: corpusId.startsWith('secure_local.') ? 'secure_local' : 'internal',
    activation_mode: 'hybrid_shadow',
    embedding_policy: 'local_only',
    configured: true,
    provider: 'fixture',
    counts: {
      indexed_items: chunks,
      chunks,
      embedded_chunks: embeddedChunks,
      sync_runs: 1,
    },
    retrieval: {
      declared_mode: 'hybrid_shadow',
      servable_mode: 'hybrid',
      state: 'ready',
    },
    last_refresh: {
      sync_run_id: 'content-free-fixture',
      status: 'completed',
      completed_at: '2026-07-21T10:00:00.000Z',
      items_seen: chunks,
      items_indexed: chunks,
    },
    item_metadata_returned: false,
    skipped_item_metadata_reason: 'connector_store_item_metadata_not_exposed_to_castor',
  };
}
