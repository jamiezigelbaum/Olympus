import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { runSourceIngestionCoordinator } from '../scripts/source-ingestion-coordinator.ts';

describe('source ingestion coordinator', () => {
  test('summarizes only canonical shared processing lanes without raw content', () => {
    const dir = temporaryDirectory('canonical');
    try {
      writeJson(join(dir, 'current.json'), {
        kind: 'source_processing_supervisor_report',
        generated_at: '2026-06-27T10:01:00.000Z',
        updated_at: '2026-06-27T10:08:00.000Z',
        status: 'idle',
        run_state: 'complete',
        active_phase: 'complete',
        summary: {
          jobs_leased: 0,
          jobs_planned: 3,
          jobs_existing: 1,
          terminal_progress_jobs: 0,
          failed_retryable_jobs: 0,
          queued_after: 4,
          provider_backpressure_jobs: 0,
          qa_visible_gaps_after: 5,
        },
        private_file_name: 'Private Contract.pdf',
      });
      writeJson(join(dir, 'source-embedding-drain-current.json'), {
        kind: 'source_embedding_drain_report',
        generated_at: '2026-06-27T10:02:00.000Z',
        updated_at: '2026-06-27T10:07:00.000Z',
        status: 'progress',
        run_state: 'complete',
        active_phase: 'complete',
        chunks_seen: 8,
        chunks_embedded: 8,
        active_scope_key_hash: 'fedcba0987654321',
      });
      writeJson(join(dir, 'venice-credit-status.json'), {
        kind: 'venice_credit_status',
        generated_at: '2026-06-27T10:04:00.000Z',
        status: 'ok',
        can_consume: true,
        balances: { usd: 12.5, diem: 4 },
        api_key: 'venice-secret-key',
      });

      const report = runSourceIngestionCoordinator({
        reportDir: dir,
        now: new Date('2026-06-27T10:10:00.000Z'),
        staleAfterMs: 20 * 60 * 1_000,
      });

      expect(report).toMatchObject({
        kind: 'source_ingestion_coordinator_report',
        mode: 'shadow',
        run_state: 'complete',
        policy: {
          shadow_read_only: true,
          raw_source_exposed: false,
          source_text_returned: false,
          source_scope_keys_exposed: false,
          file_names_returned: false,
          provider_cursors_returned: false,
          secrets_returned: false,
          direct_db_mutation: false,
        },
      });
      expect(report.active_lanes).toEqual([]);
      expect(report.stale_lanes).toEqual([]);
      expect(report.attention_lanes).toEqual([]);
      expect(lane(report, 'source_processing_supervisor').counts.qa_visible_gaps_after).toBe(5);
      expect(lane(report, 'embedding_drain').counts.chunks_embedded).toBe(8);
      expect(lane(report, 'venice_credit').counts.balance_usd).toBe(12.5);
      expect(report.lanes.map((entry) => entry.id)).toEqual([
        'source_processing_supervisor',
        'embedding_drain',
        'venice_credit',
        'venice_provider_pause',
      ]);
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain('Private Contract.pdf');
      expect(serialized).not.toContain('venice-secret-key');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('treats absent optional shared reports as non-attention lanes', () => {
    const dir = temporaryDirectory('missing');
    try {
      const report = runSourceIngestionCoordinator({
        reportDir: dir,
        now: new Date('2026-06-27T10:10:00.000Z'),
      });
      expect(report.lanes.every((entry) => entry.report_state === 'missing')).toBe(true);
      expect(report.attention_lanes).toEqual([]);
      expect(report.recommended_next_actions).toEqual([
        'source_processing:enable_shadow_report',
        'embedding:enable_shadow_report',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('marks a stale canonical report and never returns ignored raw fields', () => {
    const dir = temporaryDirectory('stale');
    try {
      writeJson(join(dir, 'source-embedding-drain-current.json'), {
        generated_at: '2026-06-27T09:00:00.000Z',
        updated_at: '2026-06-27T09:00:00.000Z',
        status: 'idle',
        run_state: 'complete',
        active_phase: 'complete',
        chunks_embedded: 0,
        raw_chat_name: 'Secret Room',
      });
      const report = runSourceIngestionCoordinator({
        reportDir: dir,
        now: new Date('2026-06-27T10:10:00.000Z'),
        staleAfterMs: 15 * 60 * 1_000,
      });
      expect(lane(report, 'embedding_drain')).toMatchObject({
        status: 'stale',
        report_state: 'stale',
        stale: true,
        attention: true,
      });
      expect(report.recommended_next_actions).toContain('embedding_drain:refresh_stale_report');
      expect(JSON.stringify(report)).not.toContain('Secret Room');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('hashes invalid JSON errors without returning the source path', () => {
    const dir = temporaryDirectory('invalid');
    try {
      writeFileSync(join(dir, 'current.json'), '{"secret_path": "/private/source"');
      const report = runSourceIngestionCoordinator({ reportDir: dir });
      const processing = lane(report, 'source_processing_supervisor');
      expect(processing).toMatchObject({
        status: 'invalid',
        report_state: 'invalid',
        attention: true,
        action_labels: ['report_json_invalid'],
      });
      expect(processing.hashes.parse_error_hash).toMatch(/^[a-f0-9]{16}$/);
      expect(report.recommended_next_actions).toContain(
        'source_processing_supervisor:repair_invalid_report_json',
      );
      expect(JSON.stringify(report)).not.toContain('/private/source');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('treats invalid canonical report timestamps as attention', () => {
    const dir = temporaryDirectory('bad-time');
    try {
      writeJson(join(dir, 'current.json'), {
        generated_at: 'not-a-date',
        updated_at: 'still-not-a-date',
        status: 'progress',
        run_state: 'running',
        active_phase: 'extracting',
        summary: { jobs_leased: 1 },
      });
      const report = runSourceIngestionCoordinator({ reportDir: dir });
      expect(lane(report, 'source_processing_supervisor')).toMatchObject({
        status: 'invalid',
        report_state: 'invalid',
        attention: true,
        action_labels: ['report_timestamp_invalid'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('keeps Venice attention and pause actions privacy bounded', () => {
    const dir = temporaryDirectory('actions');
    try {
      const pauseFile = join(dir, 'pause.json');
      writeJson(join(dir, 'venice-credit-status.json'), {
        generated_at: '2026-06-27T10:09:00.000Z',
        status: 'credit_exhausted',
        can_consume: false,
        error_message: 'private billing detail',
      });
      writeJson(pauseFile, {
        active: true,
        reason: 'venice_http_402 from private request',
        error_kind: 'venice_http_402',
        created_at: '2026-06-27T10:09:10.000Z',
        message: 'private provider detail',
      });
      const report = runSourceIngestionCoordinator({
        reportDir: dir,
        venicePauseFile: pauseFile,
        now: new Date('2026-06-27T10:10:00.000Z'),
      });
      expect(report.attention_lanes).toEqual(['venice_credit', 'venice_provider_pause']);
      expect(report.recommended_next_actions).toContain('venice:hold_or_repair_credit_lane');
      expect(report.recommended_next_actions).toContain('venice:respect_provider_pause_marker');
      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain('private billing detail');
      expect(serialized).not.toContain('private provider detail');
      expect(serialized).not.toContain('venice_http_402 from private request');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('writes the consolidated report when requested', () => {
    const dir = temporaryDirectory('write');
    try {
      const reportPath = join(dir, 'nested', 'coordinator.json');
      const report = runSourceIngestionCoordinator({ reportDir: dir, reportPath });
      expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual(report);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function temporaryDirectory(label: string): string {
  return mkdtempSync(join(tmpdir(), `olympus-source-ingestion-${label}-`));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function lane(
  report: ReturnType<typeof runSourceIngestionCoordinator>,
  id: string,
) {
  const found = report.lanes.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing lane ${id}`);
  return found;
}
