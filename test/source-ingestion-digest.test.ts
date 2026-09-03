import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { runSourceIngestionDigest } from '../scripts/source-ingestion-digest.ts';
import type { SourceIngestionLedgerSnapshot, SourceIngestionLedgerRow } from '../src/workers/source-ingestion-ledger.ts';

describe('source ingestion digest', () => {
  test('composes a deterministic counts-only digest from worker ledger and janitor report', async () => {
    const dir = tmpDir();
    const janitorPath = join(dir, 'janitor.json');
    writeFileSync(janitorPath, `${JSON.stringify({
      kind: 'source_processing_janitor_report',
      generated_at: '2026-07-09T08:00:00.000Z',
      summary: {
        stale_leases_requeued: 1,
        expired_retryable_requeued: 2,
        terminal_requeued: 3,
        skipped_attempt_budget: 4,
        skipped_already_janitor_requeued: 5,
      },
      warnings: ['bounded warning'],
    })}\n`);

    const result = await runSourceIngestionDigest({
      now: new Date('2026-07-09T09:00:00.000Z'),
      stateDir: dir,
      janitorReportPath: janitorPath,
      env: envForDigest(),
      fetchImpl: fetchOk(statusWithLedger(ledgerFixture({
        queued: 2,
        retryable: 1,
        terminal: 2,
        oldest: 12,
        terminalClass: 'ocrmypdf_pdf_encrypted',
      }))),
    });

    expect(result.emitted).toBe(true);
    expect(result.digest.status).toBe('YELLOW');
    expect(result.text).toContain('YELLOW source ingestion digest 2026-07-09T09:00:00.000Z');
    expect(result.text).toContain('Stuck: oldest 12h; queued/retryable 3; active 0; terminal 2.');
    expect(result.text).toContain('Terminal classes: Dropbox local_text:ocrmypdf_pdf_encrypted=2 (delta +2).');
    expect(result.text).toContain('Janitor: requeued 6; escalated 0; skipped 9; warnings 1.');
    expect(result.text).not.toContain('/Users/owner/Library/CloudStorage/Dropbox');
    expect(result.text).not.toContain('dropbox.personal:/1 Projects');
    expect(result.text).not.toContain('path_display');
  });

  test('goes red for disabled drain with queued work and degraded credential lane', async () => {
    const result = await runSourceIngestionDigest({
      now: new Date('2026-07-09T10:00:00.000Z'),
      stateDir: tmpDir(),
      env: envForDigest(),
      fetchImpl: fetchOk(statusWithLedger(
        ledgerFixture({ queued: 5, retryable: 0, terminal: 0, oldest: 80, drainState: 'disabled' }),
        [{
          kind: 'worker_credential_degraded',
          display_name: 'Venice API key',
          state: 'stopped',
          status_label: 'Credential unavailable - needs your attention',
          hint: 'Reconnect credential.',
          attempts: 3,
          max_attempts: 3,
          affected_capabilities: ['secure extraction'],
        }],
      )),
    });

    expect(result.digest.status).toBe('RED');
    expect(result.text).toContain('Dropbox drain disabled with 5 queued/retryable item(s)');
    expect(result.text).toContain('Venice API key credential lane is stopped');
    expect(result.text).toContain('- Dropbox: clear the drain disable state or restart the source drain before more planning.');
    expect(result.text).toContain('- Venice API key: repair/recheck the credential lane');
  });

  test('fails closed red when worker status is unreachable', async () => {
    const result = await runSourceIngestionDigest({
      now: new Date('2026-07-09T11:00:00.000Z'),
      stateDir: tmpDir(),
      env: envForDigest(),
      fetchImpl: (async () => {
        throw new Error('connection refused');
      }) as unknown as typeof fetch,
    });

    expect(result.digest.status).toBe('RED');
    expect(result.text).toContain('worker unreachable: connection refused');
    expect(result.text).toContain('Restore the Olympus source worker');
  });

  test('--red-only is silent on green fixture but still writes state and report', async () => {
    const result = await runSourceIngestionDigest({
      now: new Date('2026-07-09T12:00:00.000Z'),
      stateDir: tmpDir(),
      redOnly: true,
      env: envForDigest(),
      fetchImpl: fetchOk(statusWithLedger(ledgerFixture({ queued: 0, retryable: 0, terminal: 0 }))),
    });

    expect(result.digest.status).toBe('GREEN');
    expect(result.emitted).toBe(false);
    expect(result.text).toBe('');
    expect(result.digest.report_path).toBeString();
  });

  test('terminal deltas compare against the previous digest state', async () => {
    const dir = tmpDir();
    await runSourceIngestionDigest({
      now: new Date('2026-07-09T13:00:00.000Z'),
      stateDir: dir,
      env: envForDigest(),
      fetchImpl: fetchOk(statusWithLedger(ledgerFixture({ queued: 0, retryable: 0, terminal: 2 }))),
    });
    const second = await runSourceIngestionDigest({
      now: new Date('2026-07-09T14:00:00.000Z'),
      stateDir: dir,
      env: envForDigest(),
      fetchImpl: fetchOk(statusWithLedger(ledgerFixture({ queued: 0, retryable: 0, terminal: 5 }))),
    });

    expect(second.text).toContain('Dropbox local_text:provider_timeout=5 (delta +3)');
  });

  test('tolerates S5 escalation fields being absent or present', async () => {
    const dir = tmpDir();
    const janitorPath = join(dir, 'janitor-with-escalations.json');
    writeFileSync(janitorPath, `${JSON.stringify({
      summary: { terminal_requeued: 1 },
      escalations: { escalated: 2, policy_excluded: 3, already_escalated: 4 },
    })}\n`);

    const result = await runSourceIngestionDigest({
      now: new Date('2026-07-09T15:00:00.000Z'),
      stateDir: dir,
      janitorReportPath: janitorPath,
      env: envForDigest(),
      fetchImpl: fetchOk(statusWithLedger(ledgerFixture({ queued: 0, retryable: 0, terminal: 0 }))),
    });

    expect(result.text).toContain('Janitor: requeued 1; escalated 2; skipped 7; warnings 0.');
  });
});

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'source-ingestion-digest-test-'));
}

function envForDigest(): Record<string, string | undefined> {
  return {
    OLYMPUS_ENABLE_SOURCE_INDEX: 'true',
    OLYMPUS_EMAIL_ENABLED: 'true',
    OLYMPUS_EMAIL_BASE_URL: 'http://worker.test/v1',
    OLYMPUS_WORKER_AUTH_TOKEN: 'fixture-token',
  };
}

function fetchOk(payload: unknown): typeof fetch {
  return (async (input: URL | RequestInfo, init?: RequestInit) => {
    expect(String(input)).toBe('http://worker.test/v1/source/index/status');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ include_ingestion_ledger: true, include_items: false });
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer fixture-token');
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
}

function statusWithLedger(
  ledger: SourceIngestionLedgerSnapshot,
  degraded_credentials: unknown[] = [],
): Record<string, unknown> {
  return {
    kind: 'source_index_status',
    generated_at: ledger.generated_at,
    corpora: [],
    ingestion_ledger: ledger,
    ...(degraded_credentials.length > 0 ? { degraded_credentials } : {}),
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

function ledgerFixture(input: {
  queued: number;
  retryable: number;
  terminal: number;
  oldest?: number;
  terminalClass?: string;
  drainState?: 'enabled' | 'disabled' | 'held' | 'unknown';
}): SourceIngestionLedgerSnapshot {
  return {
    kind: 'source_ingestion_ledger',
    generated_at: '2026-07-09T08:30:00.000Z',
    unassigned_corpora: { corpus_count: 0, items: 0, content_indexed: 0, entries: [] },
    rows: [
      rowFixture({
        source_id: 'dropbox',
        label: 'Dropbox',
        queued: input.queued,
        retryable: input.retryable,
        terminal: input.terminal,
        ...(input.oldest !== undefined ? { oldest: input.oldest } : {}),
        terminalClass: input.terminalClass ?? 'provider_timeout',
        drainState: input.drainState ?? 'enabled',
      }),
      rowFixture({
        source_id: 'email',
        label: 'Email',
        queued: 0,
        retryable: 0,
        terminal: 0,
        drainState: 'enabled',
      }),
    ],
    attention: [],
    unreadable_content: [{
      source_id: 'dropbox',
      name: 'Secret file.pdf',
      path_display: '/Users/owner/Library/CloudStorage/Dropbox/Secret file.pdf',
      status: 'failed_terminal',
      extractor_kind: 'local_text',
      error_class: 'provider_timeout',
      updated_at: '2026-07-09T08:00:00.000Z',
    }],
    policy: {
      read_only: true,
      raw_source_exposed: false,
      source_text_returned: false,
      castor_safe: true,
    },
  };
}

function rowFixture(input: {
  source_id: string;
  label: string;
  queued: number;
  retryable: number;
  terminal: number;
  oldest?: number;
  terminalClass?: string;
  drainState: 'enabled' | 'disabled' | 'held' | 'unknown';
  }): SourceIngestionLedgerRow {
  const byClass: SourceIngestionLedgerRow['ingestion_health']['stuck_work']['by_class'] = [];
  if (input.queued > 0) {
    byClass.push({
      status: 'queued',
      extractor_kind: 'local_text',
      count: input.queued,
      ...(input.oldest !== undefined ? { oldest_age_hours: input.oldest } : {}),
    });
  }
  if (input.retryable > 0) {
    byClass.push({
      status: 'failed_retryable',
      extractor_kind: 'local_text',
      count: input.retryable,
      ...(input.oldest !== undefined ? { oldest_age_hours: input.oldest } : {}),
    });
  }
  if (input.terminal > 0) {
    byClass.push({
      status: 'failed_terminal',
      extractor_kind: 'local_text',
      ...(input.terminalClass ? { error_class: input.terminalClass } : {}),
      count: input.terminal,
      ...(input.oldest !== undefined ? { oldest_age_hours: input.oldest } : {}),
    });
  }
  return {
    source_id: input.source_id,
    label: input.label,
    primary_corpus_id: input.source_id === 'dropbox' ? 'secure_local.dropbox.files' : 'secure_local.email.private',
    corpus_ids: [],
    family: 'file',
    trust_domains: ['secure_local'],
    configured: true,
    items: input.source_id === 'dropbox' ? 10 : 4,
    content_indexed: input.source_id === 'dropbox' ? 6 : 4,
    metadata_only: 0,
    failed: input.retryable + input.terminal,
    coverage_percent: 60,
    stuck: {
      queued: input.queued,
      active: 0,
      held_paused: input.drainState === 'held' ? 1 : 0,
      broken: input.terminal,
    },
    ingestion_health: {
      coverage_percent: 60,
      stuck_work: {
        queued: input.queued,
        failed_retryable: input.retryable,
        failed_terminal: input.terminal,
        ...(input.oldest !== undefined ? { oldest_age_hours: input.oldest } : {}),
        by_class: byClass,
      },
      drain: {
        state: input.drainState,
        unit: `olympus-${input.source_id}-drain.service`,
      },
    },
    attention: [],
    failure_breakdown: [],
  };
}
