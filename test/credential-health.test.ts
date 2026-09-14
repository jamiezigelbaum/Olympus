import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  CREDENTIAL_HEALTH_MAX_FUTURE_SKEW_MS,
  CREDENTIAL_HEALTH_REPORT_MAX_AGE_MS,
  credentialHealthDegradations,
  credentialHealthReportIsStale,
  readCredentialHealthReport,
  type CredentialHealthReport,
  type CredentialHealthResult,
} from '../src/workers/credential-health.ts';

const NOW = '2026-08-18T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
let root: string;
let reportPath: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'olympus-credential-health-reader-'));
  reportPath = join(root, 'current.json');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function resultFixture(overrides: Partial<CredentialHealthResult> = {}): CredentialHealthResult {
  return {
    handle: 'dropbox.personal',
    provider: 'dropbox',
    source_ids: ['dropbox.files'],
    credential_type: 'oauth2_refresh',
    status: 'reauth_required',
    checked_at: NOW,
    probe_mode: 'passive',
    reason: 'credential_reauth_required',
    ...overrides,
  };
}

function reportFixture(results = [resultFixture()]): CredentialHealthReport {
  return {
    kind: 'credential_health_report',
    version: 1,
    generated_at: NOW,
    results,
    policy: {
      counts_only: true,
      raw_source_exposed: false,
      secrets_exposed: false,
      x_refresh_forced: false,
      op_cached_read_only: true,
    },
  };
}

function readReport(value: unknown): CredentialHealthReport | undefined {
  writeFileSync(reportPath, JSON.stringify(value), { mode: 0o600 });
  return readCredentialHealthReport(reportPath);
}

describe('credential health report reader', () => {
  test('leaves missing reports optional and malformed files unreadable', () => {
    expect(readCredentialHealthReport(reportPath)).toBeUndefined();
    expect(credentialHealthDegradations(undefined, new Date(NOW))).toEqual([]);
    writeFileSync(reportPath, '{broken', { mode: 0o600 });
    expect(readCredentialHealthReport(reportPath)).toBeUndefined();
  });

  test('projects only report fields and reads without changing the file', () => {
    const expected = reportFixture();
    const input = {
      ...expected,
      generated_at: '2026-08-18T13:00:00+01:00',
      secret: 'synthetic-secret-not-for-output',
      results: [{
        ...expected.results[0],
        checked_at: '2026-08-18T13:00:00+01:00',
        raw_error: 'synthetic-secret-not-for-output',
      }],
    };
    const encoded = JSON.stringify(input);
    writeFileSync(reportPath, encoded, { mode: 0o600 });

    const report = readCredentialHealthReport(reportPath);

    expect(report).toEqual(expected);
    expect(JSON.stringify(report)).not.toContain('synthetic-secret-not-for-output');
    expect(readFileSync(reportPath, 'utf8')).toBe(encoded);
  });

  test('accepts reports without optional probe mode or reason', () => {
    const result = resultFixture();
    delete result.probe_mode;
    delete result.reason;
    expect(readReport(reportFixture([result]))?.results).toEqual([result]);
  });

  test('rejects a missing policy instead of supplying trusted defaults', () => {
    const { policy: _policy, ...report } = reportFixture();
    expect(readReport(report)).toBeUndefined();
  });

  test.each(Object.entries(reportFixture().policy))('rejects a changed %s policy assertion', (key, value) => {
    const report = reportFixture();
    expect(readReport({ ...report, policy: { ...report.policy, [key]: !value } })).toBeUndefined();
  });

  test('rejects extra policy assertions', () => {
    const report = reportFixture();
    expect(readReport({ ...report, policy: { ...report.policy, unchecked: true } })).toBeUndefined();
  });

  const invalidReports: Array<[string, unknown]> = [
    ['array', []],
    ['null', null],
    ['wrong kind', { ...reportFixture(), kind: 'other_report' }],
    ['wrong version', { ...reportFixture(), version: 2 }],
    ['invalid generation time', { ...reportFixture(), generated_at: 'not-a-date' }],
    ['non-array results', { ...reportFixture(), results: {} }],
    ['non-object result', { ...reportFixture(), results: [null] }],
  ];
  test.each(invalidReports)('rejects an invalid report: %s', (_name, report) => {
    expect(readReport(report)).toBeUndefined();
  });

  const invalidRows: Array<[string, Record<string, unknown>]> = [
    ['empty handle', { handle: '' }],
    ['long handle', { handle: 'x'.repeat(161) }],
    ['unsafe provider', { provider: 'dropbox/private' }],
    ['unsafe source id', { source_ids: ['dropbox.files\nprivate'] }],
    ['non-array source ids', { source_ids: 'dropbox.files' }],
    ['unsafe reason', { reason: 'secret=synthetic-token' }],
    ['unknown status', { status: 'working' }],
    ['unknown credential type', { credential_type: 'unknown' }],
    ['unknown probe mode', { probe_mode: 'forced' }],
    ['invalid checked time', { checked_at: 'not-a-date' }],
  ];
  test.each(invalidRows)('rejects an invalid row without silently filtering it: %s', (_name, patch) => {
    expect(readReport({ ...reportFixture(), results: [resultFixture(), { ...resultFixture(), ...patch }] }))
      .toBeUndefined();
  });

  test('rejects a mixed private/public report outside the public report format', () => {
    // Removing private credential issuance does not widen the public parser.
    // A legacy private row must not be silently dropped from its report.
    const legacyRow = {
      ...resultFixture(),
      handle: 'gmail.personal.delegated',
      provider: 'gmail',
      credential_type: 'service_account_jwt',
    };
    expect(readReport({ ...reportFixture(), results: [legacyRow, resultFixture()] })).toBeUndefined();
  });

  test('bounds each result timestamp against its report generation time', () => {
    for (const offset of [-CREDENTIAL_HEALTH_REPORT_MAX_AGE_MS, CREDENTIAL_HEALTH_MAX_FUTURE_SKEW_MS]) {
      const checked_at = new Date(NOW_MS + offset).toISOString();
      expect(readReport(reportFixture([resultFixture({ checked_at })]))).toBeDefined();
    }
    for (const offset of [-CREDENTIAL_HEALTH_REPORT_MAX_AGE_MS - 1, CREDENTIAL_HEALTH_MAX_FUTURE_SKEW_MS + 1]) {
      const checked_at = new Date(NOW_MS + offset).toISOString();
      expect(readReport(reportFixture([resultFixture({ checked_at })]))).toBeUndefined();
    }
  });
});

describe('credential health report status', () => {
  test('preserves freshness boundaries and rejects future reports as current evidence', () => {
    const report = reportFixture();
    expect(credentialHealthReportIsStale(report, new Date(NOW_MS + CREDENTIAL_HEALTH_REPORT_MAX_AGE_MS))).toBe(false);
    expect(credentialHealthReportIsStale(report, new Date(NOW_MS + CREDENTIAL_HEALTH_REPORT_MAX_AGE_MS + 1))).toBe(true);
    expect(credentialHealthReportIsStale(report, new Date(NOW_MS - CREDENTIAL_HEALTH_MAX_FUTURE_SKEW_MS))).toBe(false);
    expect(credentialHealthReportIsStale(report, new Date(NOW_MS - CREDENTIAL_HEALTH_MAX_FUTURE_SKEW_MS - 1))).toBe(true);
  });

  test('reports stale evidence instead of repeating an old reconnect demand', () => {
    const report = readReport(reportFixture())!;
    for (const readingAt of [
      NOW_MS + CREDENTIAL_HEALTH_REPORT_MAX_AGE_MS + 1,
      NOW_MS - CREDENTIAL_HEALTH_MAX_FUTURE_SKEW_MS - 1,
    ]) {
      const degradations = credentialHealthDegradations(report, new Date(readingAt));
      expect(degradations).toEqual([expect.objectContaining({
        display_name: 'Credential health: stale probe report',
        state: 'retrying',
        hint: 'This credential health report is out of date. Check the source connection status in Setup.',
      })]);
      expect(degradations[0]?.affected_profiles).toBeUndefined();
    }
  });

  test('keeps current failures scoped and distinguishes retrying from reconnecting', () => {
    const report = readReport(reportFixture([
      resultFixture({ handle: 'dropbox.healthy', status: 'healthy' }),
      resultFixture({ handle: 'dropbox.skipped', status: 'skipped' }),
      resultFixture({ handle: 'dropbox.missing', status: 'missing' }),
      resultFixture({ handle: 'dropbox.reauth', status: 'reauth_required' }),
      resultFixture({ handle: 'dropbox.degraded', status: 'degraded', source_ids: [] }),
    ]));
    const degradations = credentialHealthDegradations(report, new Date(NOW));
    expect(degradations.map(({ display_name, state, affected_profiles }) => ({ display_name, state, affected_profiles })))
      .toEqual([
        { display_name: 'Credential health: dropbox.missing', state: 'stopped', affected_profiles: ['dropbox.files'] },
        { display_name: 'Credential health: dropbox.reauth', state: 'stopped', affected_profiles: ['dropbox.files'] },
        { display_name: 'Credential health: dropbox.degraded', state: 'retrying', affected_profiles: undefined },
      ]);
    expect(degradations[0]?.hint).toBe('Reconnect or restore this source credential in Setup.');
    expect(degradations[2]?.hint).toBe('This report could not confirm the connection. Check its current status in Setup and retry the source.');
  });
});
