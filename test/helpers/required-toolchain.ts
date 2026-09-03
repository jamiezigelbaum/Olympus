/**
 * External toolchains the deploy-lane tests shell out to.
 *
 * These tests are the ones that lint the installer scripts and run the Go
 * bridge's own suite, so what they assert is only true while the tool is
 * actually there. Every one of them used to resolve the binary with
 * `Bun.which` and quietly `return` when it came back null — which turns
 * "the installers are shellcheck-clean" from a fact into a belief that holds
 * only while the runner image happens to ship shellcheck. On 2026-08-24 the CI
 * workflow installed bun and nothing else: 17 files and 13 skip guards were
 * resting on whatever `ubuntu-latest` preinstalled, unpinned and unasserted.
 *
 * So the answer depends on WHERE the suite is running, and the caller does not
 * get to decide:
 *
 * - A developer checkout without Go must still run the suite. Skipping is
 *   correct there; requiring every contributor to install a Go toolchain to
 *   run unit tests is not.
 * - CI and any deploy-lane run set OLYMPUS_REQUIRE_TOOLCHAINS=1, and there a
 *   missing tool THROWS. That is the whole point: a silent skip in the lane
 *   that guards live-system installers is indistinguishable from deleting the
 *   test, and it fails in the direction that looks green.
 */
const REQUIRE_ENV = 'OLYMPUS_REQUIRE_TOOLCHAINS';

export function toolchainsAreRequired(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[REQUIRE_ENV]?.trim() === '1';
}

/**
 * Resolve an external tool, or null when this environment is allowed to skip.
 *
 * Throws instead of returning null wherever toolchains are required, naming
 * the tool and the flag, so a CI image that stops shipping one fails loudly on
 * the spot rather than reporting a pass for a check that never ran.
 */
export function optionalToolchain(
  name: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const resolved = Bun.which(name);
  if (resolved) return resolved;
  if (toolchainsAreRequired(env)) {
    throw new Error(
      `${name} is not on PATH, but ${REQUIRE_ENV}=1 says this environment must have it. `
      + `Install ${name} in the workflow, or unset ${REQUIRE_ENV} if this lane is `
      + 'genuinely allowed to skip it. Skipping silently would report a pass for a '
      + 'check that never ran.',
    );
  }
  return null;
}

/**
 * The same contract for a tool that is present but too old to answer the
 * question. A version floor that silently skips is the same defect as a
 * missing binary: the check does not run and the suite still says pass.
 */
export function requireToolchainVersion(
  name: string,
  satisfied: boolean,
  found: string,
  wanted: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (satisfied) return true;
  if (toolchainsAreRequired(env)) {
    throw new Error(
      `${name} ${found} does not satisfy ${wanted}, and ${REQUIRE_ENV}=1 says this `
      + 'environment must run this check. Pin a newer toolchain in the workflow.',
    );
  }
  return false;
}
