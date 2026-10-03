import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_GOOGLE_PILOT_CLIENT_ID,
  PACKAGED_GOOGLE_PILOT_CLIENT_ID,
  packagedGooglePilotClientId,
  resolveGooglePilotClientId,
} from '../src/core/google-pilot-client.ts';
import {
  describeReleaseGooglePilotChoice,
  GOOGLE_PILOT_CLIENT_MISSING_MESSAGE,
  packagedGooglePilotClientModule,
  releaseGooglePilotChoice,
} from '../scripts/release-google-pilot-choice.ts';

const ROOT = join(import.meta.dir, '..');
const SENTINEL = '__OLYMPUS_GOOGLE_PILOT_CLIENT_ID__';
const RELEASE_ID = '12-release.apps.googleusercontent.com';
const SHIPPED_ID = '34-shipped.apps.googleusercontent.com';

/**
 * A repository install never runs the release substitution, so the shipped
 * default is the only way a repo-installed pilot reaches the shared-OAuth
 * path instead of being pushed onto advanced BYO OAuth.
 */
describe('Google pilot client resolution order', () => {
  test('the release-substituted id wins over the shipped default', () => {
    expect(resolveGooglePilotClientId(RELEASE_ID, SHIPPED_ID)).toBe(RELEASE_ID);
  });

  test('an unsubstituted sentinel falls back to the shipped default', () => {
    expect(resolveGooglePilotClientId(SENTINEL, SHIPPED_ID)).toBe(SHIPPED_ID);
    expect(resolveGooglePilotClientId('  ', SHIPPED_ID)).toBe(SHIPPED_ID);
  });

  test('no substitution and no default fails closed to BYO OAuth', () => {
    expect(resolveGooglePilotClientId(SENTINEL, '')).toBeUndefined();
    expect(resolveGooglePilotClientId('', '   ')).toBeUndefined();
  });

  test('source keeps the sentinel so an ordinary build never mints a client id', () => {
    expect(PACKAGED_GOOGLE_PILOT_CLIENT_ID).toBe(SENTINEL);
  });

  test('the shipped default is empty or a real Google Desktop client id', () => {
    expect(
      DEFAULT_GOOGLE_PILOT_CLIENT_ID === ''
      || /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(DEFAULT_GOOGLE_PILOT_CLIENT_ID),
    ).toBe(true);
    expect(packagedGooglePilotClientId()).toBe(
      DEFAULT_GOOGLE_PILOT_CLIENT_ID === '' ? undefined : DEFAULT_GOOGLE_PILOT_CLIENT_ID,
    );
  });

  test('the release builder resolves its Desktop client through the shared choice module', () => {
    const builder = readFileSync(join(ROOT, 'scripts/release-artifact.ts'), 'utf8');
    expect(builder).toContain("import { DEFAULT_GOOGLE_PILOT_CLIENT_ID } from '../src/core/google-pilot-client.ts';");
    expect(builder).toContain('releaseGooglePilotChoice(process.env.OLYMPUS_GOOGLE_PILOT_CLIENT_ID, DEFAULT_GOOGLE_PILOT_CLIENT_ID)');
    expect(builder).toContain('if (!googlePilotChoice) throw new Error(GOOGLE_PILOT_CLIENT_MISSING_MESSAGE);');
    expect(builder).toContain('contents: packagedGooglePilotClientModule(googlePilotChoice!)');
    const gate = readFileSync(join(ROOT, 'scripts/release-artifact-ci.ts'), 'utf8');
    expect(gate).toContain('releaseGooglePilotChoice(');
  });
});

/**
 * Olympus 1.0 release builds ship with no Desktop client (owner, 2026-10-03),
 * but only by an explicit choice: OLYMPUS_GOOGLE_PILOT_CLIENT_ID=none.
 */
describe('release Google Desktop client choice', () => {
  test('a Desktop client id is packaged; none is an explicit choice; anything else refuses', () => {
    expect(releaseGooglePilotChoice(RELEASE_ID, '')).toEqual({ kind: 'client', clientId: RELEASE_ID });
    expect(releaseGooglePilotChoice(undefined, SHIPPED_ID)).toEqual({ kind: 'client', clientId: SHIPPED_ID });
    expect(releaseGooglePilotChoice(' none ', SHIPPED_ID)).toEqual({ kind: 'none' });
    for (const value of [undefined, '', '   ', 'None', 'NONE', 'off', 'false', SENTINEL, 'not-a-client-id']) {
      expect(releaseGooglePilotChoice(value, '')).toBeUndefined();
    }
    expect(GOOGLE_PILOT_CLIENT_MISSING_MESSAGE).toContain('or be "none"');
  });

  test('the packaged module for none resolves to no Desktop client and carries no sentinel', async () => {
    const source = packagedGooglePilotClientModule({ kind: 'none' });
    expect(source).not.toContain(SENTINEL);
    const packaged = await importModuleSource(source);
    expect(packaged.packagedGooglePilotClientId()).toBeUndefined();
    expect(packaged.DEFAULT_GOOGLE_PILOT_CLIENT_ID).toBe('');
    expect(packaged.PACKAGED_GOOGLE_PILOT_CLIENT_ID).toBe('');
    expect(describeReleaseGooglePilotChoice({ kind: 'none' })).toContain('none');
  });

  test('the packaged module for a client resolves to exactly that client', async () => {
    const packaged = await importModuleSource(packagedGooglePilotClientModule({ kind: 'client', clientId: RELEASE_ID }));
    expect(packaged.packagedGooglePilotClientId()).toBe(RELEASE_ID);
    expect(packaged.resolveGooglePilotClientId('', '')).toBeUndefined();
  });
});

async function importModuleSource(source: string): Promise<Record<string, any>> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-pilot-module-'));
  try {
    const path = join(dir, 'google-pilot-client.js');
    writeFileSync(path, source);
    return await import(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
