import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import {
  credentialHealthDegradations,
  readCredentialHealthReport,
  type CredentialHealthReport,
} from '../src/workers/credential-health.ts';

const CHECKED_AT = '2026-08-18T12:00:00.000Z';
const CANONICAL_POLICY = {
  counts_only: true,
  raw_source_exposed: false,
  secrets_exposed: false,
  x_refresh_forced: false,
  op_cached_read_only: true,
} as const;

const tempRoots: string[] = [];
afterAll(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('credential health under the packaged public runtime', () => {
  test('keeps a report carrying readwise and venice static_api_key results readable', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-public-credential-health-'));
    tempRoots.push(root);
    const reportPath = join(root, 'current.json');
    writeFileSync(reportPath, JSON.stringify(publicHostReport(), null, 2));

    const report = readCredentialHealthReport(reportPath);

    expect(report?.results).toEqual([
      expect.objectContaining({
        handle: 'readwise.personal',
        credential_type: 'static_api_key',
        status: 'reauth_required',
      }),
      expect.objectContaining({
        handle: 'venice.api-key',
        credential_type: 'static_api_key',
        status: 'skipped',
      }),
      expect.objectContaining({
        handle: 'dropbox.personal',
        credential_type: 'oauth2_refresh',
        status: 'reauth_required',
      }),
    ]);
    expect(credentialHealthDegradations(report, new Date(CHECKED_AT))
      .map((degradation) => degradation.display_name)).toEqual([
      'Credential health: readwise.personal',
      'Credential health: dropbox.personal',
    ]);
  });
});

function publicHostReport(): CredentialHealthReport {
  return {
    kind: 'credential_health_report',
    version: 1,
    generated_at: CHECKED_AT,
    results: [
      {
        handle: 'readwise.personal',
        provider: 'readwise',
        source_ids: ['readwise.library'],
        credential_type: 'static_api_key',
        status: 'reauth_required',
        checked_at: CHECKED_AT,
        probe_mode: 'active',
        reason: 'provider_auth_rejected',
      },
      {
        handle: 'venice.api-key',
        provider: 'venice',
        source_ids: ['venice.api'],
        credential_type: 'static_api_key',
        status: 'skipped',
        checked_at: CHECKED_AT,
        probe_mode: 'passive',
      },
      {
        handle: 'dropbox.personal',
        provider: 'dropbox',
        source_ids: ['dropbox.files'],
        credential_type: 'oauth2_refresh',
        status: 'reauth_required',
        checked_at: CHECKED_AT,
        probe_mode: 'active',
        reason: 'credential_reauth_required',
      },
    ],
    policy: { ...CANONICAL_POLICY },
  };
}
