import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import {
  optionalToolchain,
  requireToolchainVersion,
  toolchainsAreRequired,
} from './helpers/required-toolchain.ts';

// OLYMPUS_TEST_LANE: go

const bridgeDir = join(import.meta.dir, '..', 'tools', 'whatsapp-bridge');

/**
 * Six separate conditions used to end this test in a bare `return`: no `go`,
 * a failing version probe, an unparseable version, a version below the floor,
 * a failing `go env CC`, and a C compiler that is named but absent. Any one of
 * them and the suite reported a pass for a Go suite that never ran. Each is now
 * routed through the toolchain contract, so the same six conditions skip on a
 * developer box and THROW wherever OLYMPUS_REQUIRE_TOOLCHAINS=1 says the
 * toolchain must be there.
 */
function unusableToolchain(reason: string): null {
  if (toolchainsAreRequired()) {
    throw new Error(
      `The Go toolchain is unusable (${reason}), but OLYMPUS_REQUIRE_TOOLCHAINS=1 says `
      + 'this environment must run the WhatsApp bridge Go suite.',
    );
  }
  return null;
}

test('WhatsApp bridge Go unit tests pass when the required toolchain is available', () => {
  const go = optionalToolchain('go');
  if (go === null) return;

  const goVersion = Bun.spawnSync([go, 'env', 'GOVERSION'], {
    cwd: bridgeDir,
    env: { ...process.env, GOTOOLCHAIN: 'local' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (goVersion.exitCode !== 0 && unusableToolchain('go env GOVERSION failed') === null) return;
  const match = goVersion.stdout.toString().trim().match(/^go(\d+)\.(\d+)/);
  if (match === null && unusableToolchain('go env GOVERSION was unparseable') === null) return;
  const major = Number(match![1]);
  const minor = Number(match![2]);
  const meetsFloor = major > 1 || (major === 1 && minor >= 26);
  if (!requireToolchainVersion('go', meetsFloor, `${major}.${minor}`, '>= 1.26')) return;

  const goCompiler = Bun.spawnSync([go, 'env', 'CC'], {
    cwd: bridgeDir,
    env: { ...process.env, GOTOOLCHAIN: 'local' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (goCompiler.exitCode !== 0 && unusableToolchain('go env CC failed') === null) return;
  const compiler = goCompiler.stdout.toString().trim().split(/\s+/)[0] ?? '';
  if (compiler === '' && unusableToolchain('go env CC named no compiler') === null) return;
  const compilerPresent = isAbsolute(compiler) ? existsSync(compiler) : Bun.which(compiler) !== null;
  if (!compilerPresent && unusableToolchain(`the C compiler ${compiler} is absent`) === null) return;

  // Reuse Go's ambient build cache by default. `-count=1` below still forces
  // the tests themselves to execute; only compiled packages are reused. Set
  // OLYMPUS_HERMETIC_GO=1 for the scheduled cold-cache qualification lane.
  let goCache = process.env.OLYMPUS_HERMETIC_GO === '1'
    ? mkdtempSync(join(tmpdir(), 'olympus-whatsapp-go-cache-'))
    : undefined;
  try {
    const run = () => Bun.spawnSync([go, 'test', '-count=1', './...'], {
      cwd: bridgeDir,
      env: {
        ...process.env,
        ...(goCache ? { GOCACHE: goCache } : {}),
        GOTOOLCHAIN: 'local',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    let result = run();
    if (!goCache && /go-build.*operation not permitted/i.test(result.stderr.toString())) {
      goCache = mkdtempSync(join(tmpdir(), 'olympus-whatsapp-go-cache-'));
      result = run();
    }
    expect(result.exitCode, result.stderr.toString() || result.stdout.toString()).toBe(0);
  } finally {
    if (goCache) rmSync(goCache, { recursive: true, force: true });
  }
// The hermetic qualification lane intentionally pays for a cold build. Its
// doubled timeout is a diagnostic ceiling, not a scheduling weight.
}, 240_000);
