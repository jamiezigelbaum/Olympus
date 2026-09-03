import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_GOOGLE_PILOT_CLIENT_ID,
  PACKAGED_GOOGLE_PILOT_CLIENT_ID,
  packagedGooglePilotClientId,
  resolveGooglePilotClientId,
} from '../src/core/google-pilot-client.ts';

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

  test('the release builder still requires a real client id and substitutes both constants', () => {
    const builder = readFileSync(join(ROOT, 'scripts/release-artifact.ts'), 'utf8');
    expect(builder).toContain("import { DEFAULT_GOOGLE_PILOT_CLIENT_ID } from '../src/core/google-pilot-client.ts';");
    expect(builder).toContain('export const PACKAGED_GOOGLE_PILOT_CLIENT_ID = ${JSON.stringify(googlePilotClientId)}');
    expect(builder).toContain('export const DEFAULT_GOOGLE_PILOT_CLIENT_ID = ${JSON.stringify(googlePilotClientId)}');
    expect(builder).toContain('\\.apps\\.googleusercontent\\.com$/.test(clientId)');
  });
});
