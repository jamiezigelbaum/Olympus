import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { stripPublicRuntimeExcludedBlocks } from '../scripts/public-runtime-strip.ts';
import type { CredentialHealthReport } from '../src/workers/credential-health.ts';

const SOURCE_PATH = join(import.meta.dir, '..', 'src', 'workers', 'credential-health.ts');
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');
const STRIPPED = stripPublicRuntimeExcludedBlocks(SOURCE, SOURCE_PATH);
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
  test('keeps a report carrying readwise and venice static_api_key results readable', async () => {
    const { module, root } = await loadStrippedCredentialHealth();
    const reportPath = join(root, 'current.json');
    writeFileSync(reportPath, JSON.stringify(publicHostReport(), null, 2));

    const report = module.readCredentialHealthReport(reportPath);

    // The venice probe result is pushed on every host, configured or not, so a
    // validator that rejects static_api_key discards EVERY report -- including
    // the oauth handles whose expiry is the whole point of the probe.
    expect(report?.results.map((result) => result.handle)).toEqual([
      'readwise.personal',
      'venice.api-key',
      'dropbox.personal',
    ]);
    expect(module.credentialHealthDegradations(report, new Date(CHECKED_AT))
      .map((degradation) => degradation.display_name)).toEqual([
      'Credential health: readwise.personal',
      'Credential health: dropbox.personal',
    ]);
  });

  test('references nothing the public-runtime strip removes', () => {
    for (const name of declarationsInsideExcludedBlocks(SOURCE)) {
      expect({ name, referenced: new RegExp(`\\b${name}\\b`).test(STRIPPED) })
        .toEqual({ name, referenced: false });
    }
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

/**
 * Import the module the release builder actually packages. The stripped copy
 * lands outside the repository so a crashed run cannot leave a stray source
 * file behind, which means its relative imports have to be resolved against the
 * original directory first.
 */
async function loadStrippedCredentialHealth(): Promise<{
  module: typeof import('../src/workers/credential-health.ts');
  root: string;
}> {
  const root = mkdtempSync(join(tmpdir(), 'olympus-public-credential-health-'));
  tempRoots.push(root);
  const modulePath = join(root, 'credential-health.public.ts');
  const sourceDir = dirname(SOURCE_PATH);
  writeFileSync(modulePath, STRIPPED.replace(
    /(\bfrom\s+')(\.{1,2}\/[^']+)(')/g,
    (_match, head: string, specifier: string, tail: string) =>
      `${head}${Bun.resolveSync(specifier, sourceDir)}${tail}`,
  ));
  return { module: await import(modulePath), root };
}

/**
 * Every top-level name the strip deletes. The stripped module is never
 * type-checked or built by CI, so a call site left outside the markers is a
 * ReferenceError that only a packaged host would ever see.
 */
function declarationsInsideExcludedBlocks(source: string): string[] {
  const names: string[] = [];
  for (const block of source.split('// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START').slice(1)) {
    const body = block.slice(0, block.indexOf('// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END'));
    for (const match of body.matchAll(/\b(?:function|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g)) {
      names.push(match[1]!);
    }
  }
  return names;
}
