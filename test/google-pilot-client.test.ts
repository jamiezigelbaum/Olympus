import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_GOOGLE_PILOT_CLIENT_ID,
  isRetiredGooglePilotClientId,
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
/** The 0.4.0-beta.11 Desktop client, whose Google project is deleted. */
const RETIRED_ID = '604346037984-oukrdn4ouh8n2fctggracadt0fdd2lps.apps.googleusercontent.com';

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

  test('source ships no Desktop client: the beta.11 one is deleted (#765)', () => {
    expect(DEFAULT_GOOGLE_PILOT_CLIENT_ID).toBe('');
    expect(packagedGooglePilotClientId()).toBeUndefined();
  });

  test('the retired beta.11 client is recognised by hash, and nothing else is', () => {
    expect(isRetiredGooglePilotClientId(` ${RETIRED_ID} `)).toBe(true);
    for (const value of [undefined, '', RELEASE_ID, SHIPPED_ID, RETIRED_ID.slice(1)]) {
      expect(isRetiredGooglePilotClientId(value)).toBe(false);
    }
  });

  test('no source or script carries the retired client id', () => {
    const grep = Bun.spawnSync(['git', 'grep', '-l', RETIRED_ID, '--', 'src', 'scripts', 'site', 'skills', 'docs', 'chatgpt-plugin'], { cwd: ROOT });
    expect(grep.stdout.toString().trim()).toBe('');
  }, 30_000);

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
 * Release builds ship no Desktop client unless one is named (#765): unset and
 * `none` both mean none; the retired beta.11 client is refused.
 */
describe('release Google Desktop client choice', () => {
  test('a Desktop client id is packaged; none is an explicit choice; anything else refuses', () => {
    expect(releaseGooglePilotChoice(RELEASE_ID, '')).toEqual({ kind: 'client', clientId: RELEASE_ID });
    expect(releaseGooglePilotChoice(undefined, SHIPPED_ID)).toEqual({ kind: 'client', clientId: SHIPPED_ID });
    expect(releaseGooglePilotChoice(' none ', SHIPPED_ID)).toEqual({ kind: 'none' });
    for (const value of [undefined, '', '   ']) {
      expect(releaseGooglePilotChoice(value, '')).toEqual({ kind: 'none' });
    }
    for (const value of ['None', 'NONE', 'off', 'false', SENTINEL, 'not-a-client-id', RETIRED_ID]) {
      expect(releaseGooglePilotChoice(value, '')).toBeUndefined();
    }
    expect(releaseGooglePilotChoice(undefined, RETIRED_ID)).toBeUndefined();
    expect(GOOGLE_PILOT_CLIENT_MISSING_MESSAGE).toContain('or be "none"');
  });

  test('the packaged module for none resolves to no Desktop client and carries no sentinel', async () => {
    const source = packagedGooglePilotClientModule({ kind: 'none' });
    expect(source).not.toContain(SENTINEL);
    const packaged = await importModuleSource(source);
    expect(packaged.packagedGooglePilotClientId()).toBeUndefined();
    expect(packaged.DEFAULT_GOOGLE_PILOT_CLIENT_ID).toBe('');
    expect(packaged.PACKAGED_GOOGLE_PILOT_CLIENT_ID).toBe('');
    expect(packaged.isRetiredGooglePilotClientId(RETIRED_ID)).toBe(true);
    expect(packaged.isRetiredGooglePilotClientId(RELEASE_ID)).toBe(false);
    expect(source).not.toContain(RETIRED_ID);
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
