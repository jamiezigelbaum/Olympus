// The toolchain contract itself.
//
// This helper is what stands between "the installers are shellcheck-clean" and
// "the installers are shellcheck-clean on machines that happen to have
// shellcheck". It is worth its own test precisely because its failure mode is
// silence: if the required-environment branch ever stopped throwing, every
// deploy-lane test would keep reporting green while checking nothing, and no
// other test in the suite would notice.

import { describe, expect, test } from 'bun:test';
import {
  optionalToolchain,
  requireToolchainVersion,
  toolchainsAreRequired,
} from './helpers/required-toolchain.ts';

const ABSENT = 'olympus-definitely-not-a-real-binary';
const REQUIRED = { OLYMPUS_REQUIRE_TOOLCHAINS: '1' };

describe('external toolchain contract', () => {
  test('a missing tool skips on a developer box', () => {
    // A contributor without Go must still be able to run the suite.
    expect(optionalToolchain(ABSENT, {})).toBeNull();
  });

  test('a missing tool THROWS where toolchains are required', () => {
    // The whole point: in CI a silent skip is indistinguishable from deleting
    // the test, and it fails in the direction that looks green.
    expect(() => optionalToolchain(ABSENT, REQUIRED)).toThrow(/is not on PATH/);
  });

  test('the error names the tool and the flag, so the fix is obvious from CI logs', () => {
    expect(() => optionalToolchain(ABSENT, REQUIRED))
      .toThrow(new RegExp(`${ABSENT}[\\s\\S]*OLYMPUS_REQUIRE_TOOLCHAINS`));
  });

  test('a present tool resolves in both environments', () => {
    // `sh` is the one binary safe to assume on any host this repo runs on.
    expect(optionalToolchain('sh', {})).toBeTruthy();
    expect(optionalToolchain('sh', REQUIRED)).toBeTruthy();
  });

  test('a tool below its version floor skips locally and throws where required', () => {
    // A version floor that silently skips is the same defect as a missing
    // binary — the check does not run and the suite still says pass.
    expect(requireToolchainVersion('go', false, '1.21', '>= 1.26', {})).toBe(false);
    expect(() => requireToolchainVersion('go', false, '1.21', '>= 1.26', REQUIRED))
      .toThrow(/does not satisfy/);
  });

  test('a satisfied version floor never throws', () => {
    expect(requireToolchainVersion('go', true, '1.26', '>= 1.26', REQUIRED)).toBe(true);
  });

  test('the flag is exact, so a stray value cannot quietly disable the gate', () => {
    expect(toolchainsAreRequired(REQUIRED)).toBe(true);
    expect(toolchainsAreRequired({ OLYMPUS_REQUIRE_TOOLCHAINS: ' 1 ' })).toBe(true);
    expect(toolchainsAreRequired({ OLYMPUS_REQUIRE_TOOLCHAINS: '0' })).toBe(false);
    expect(toolchainsAreRequired({ OLYMPUS_REQUIRE_TOOLCHAINS: 'true' })).toBe(false);
    expect(toolchainsAreRequired({ OLYMPUS_REQUIRE_TOOLCHAINS: '' })).toBe(false);
    expect(toolchainsAreRequired({})).toBe(false);
  });
});
