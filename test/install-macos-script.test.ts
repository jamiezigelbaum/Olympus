/**
 * scripts/install-macos.sh, end to end against fakes: a fake curl serves
 * local tarballs, a fake bun runs each package's dist/cli.js as a shell
 * script that logs the engine command it was given. Nothing touches
 * launchctl or the real home directory.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const SCRIPT = resolve(import.meta.dir, '..', 'scripts', 'install-macos.sh');
const darwinTest = process.platform === 'darwin' ? test : test.skip;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Harness {
  root: string;
  home: string;
  log: string;
  app: string;
  run(version: string, env?: Record<string, string>): { status: number | null; stderr: string; stdout: string };
  logLines(): string[];
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'olympus-install-script-'));
  roots.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const tarballs = join(root, 'tarballs');
  const log = join(root, 'engine.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(bin);
  mkdirSync(tarballs);
  mkdirSync(join(root, 'tmp'));
  writeFileSync(join(bin, 'bun'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${FAKE_BUN_VERSION:-1.3.14}"; exit 0; fi\nexec /bin/sh "$@"\n');
  writeFileSync(join(bin, 'curl'), `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  https://artifacts.test/*) cp "${tarballs}/\${url##*/}" "$out" ;;
  *bun-darwin*) printf 'not the real bun' > "$out" ;;
  *) exit 22 ;;
esac
`);
  chmodSync(join(bin, 'bun'), 0o755);
  chmodSync(join(bin, 'curl'), 0o755);
  const makeTarball = (version: string): string => {
    const staging = join(root, `pkg-${version}`);
    mkdirSync(join(staging, 'package', 'dist'), { recursive: true });
    // The fake engine CLI: FAKE_FAIL_VERSION fails that version's install (it
    // never proves healthy), FAKE_FAIL_RESTORE fails every install, and
    // FAKE_UNHEALTHY fails every `engine verify`.
    writeFileSync(join(staging, 'package', 'dist', 'cli.js'), [
      `echo "${version} $*" >> "${log}"`,
      'if [ "$2" = verify ]; then [ -z "$FAKE_UNHEALTHY" ] || exit 1; exit 0; fi',
      `if [ "$FAKE_FAIL_VERSION" = "${version}" ] || [ -n "$FAKE_FAIL_RESTORE" ]; then exit 1; fi`,
      '',
    ].join('\n'));
    const file = join(tarballs, `olympus-${version}.tgz`);
    expect(spawnSync('tar', ['-czf', file, '-C', staging, 'package']).status).toBe(0);
    return createHash('sha256').update(readFileSync(file)).digest('hex');
  };
  return {
    root,
    home,
    log,
    app: join(home, 'Library', 'Application Support', 'Olympus', 'app'),
    run(version, env = {}) {
      const sha = makeTarball(version);
      const result = spawnSync('/bin/sh', [SCRIPT], {
        encoding: 'utf8',
        timeout: 30_000,
        env: {
          PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
          HOME: home,
          TMPDIR: join(root, 'tmp'),
          OLYMPUS_ARTIFACT_URL: `https://artifacts.test/olympus-${version}.tgz`,
          OLYMPUS_ARTIFACT_SHA256: sha,
          ...env,
        },
      });
      return { status: result.status, stderr: result.stderr, stdout: result.stdout };
    },
    logLines() {
      return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    },
  };
}

const appVersion = (dir: string): string | undefined => {
  try {
    return /echo "(\S+) /.exec(readFileSync(join(dir, 'dist', 'cli.js'), 'utf8'))?.[1];
  } catch {
    return undefined;
  }
};

describe('install-macos.sh', () => {
  darwinTest('installs, then upgrades by swapping the app and restarting the engine on the new build', () => {
    const h = harness();
    const first = h.run('v1');
    expect(first.status).toBe(0);
    expect(appVersion(h.app)).toBe('v1');
    const bun = join(h.root, 'bin', 'bun');
    expect(h.logLines()).toEqual([`v1 engine install --bun ${bun} --restart`]);

    const second = h.run('v2');
    expect(second.status).toBe(0);
    expect(appVersion(h.app)).toBe('v2');
    expect(appVersion(`${h.app}.previous`)).toBe('v1');
    expect(h.logLines().at(-1)).toBe(`v2 engine install --bun ${bun} --restart`);
  });

  darwinTest('an upgrade whose engine does not prove healthy puts the previous version back, starts it, and verifies it', () => {
    const h = harness();
    expect(h.run('v1').status).toBe(0);
    expect(h.run('v2').status).toBe(0);
    const failed = h.run('v3', { FAKE_FAIL_VERSION: 'v3' });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('restoring the previous one');
    expect(failed.stderr).toContain('the previous version was restored and is running');
    expect(appVersion(h.app)).toBe('v2');
    expect(existsSync(`${h.app}.failed`)).toBe(false);
    const bun = join(h.root, 'bin', 'bun');
    expect(h.logLines().slice(-3)).toEqual([
      `v3 engine install --bun ${bun} --restart`,
      `v2 engine install --bun ${bun} --restart`,
      'v2 engine verify',
    ]);
  });

  darwinTest('PoC: a restore that cannot start the previous version is reported, not swallowed', () => {
    const h = harness();
    expect(h.run('v1').status).toBe(0);
    const failed = h.run('v2', { FAKE_FAIL_RESTORE: '1' });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('the restored previous version did not come back healthy either');
    expect(failed.stderr).not.toContain('was restored and is running');
    const bun = join(h.root, 'bin', 'bun');
    // Both ways of starting the previous version were tried; nothing claimed it healthy.
    expect(h.logLines().slice(-3)).toEqual([
      `v2 engine install --bun ${bun} --restart`,
      `v1 engine install --bun ${bun} --restart`,
      `v1 engine install --bun ${bun}`,
    ]);
    expect(appVersion(h.app)).toBe('v1');
  });

  darwinTest('PoC: a previous version whose install exits 0 but never proves healthy is reported as not restored', () => {
    const h = harness();
    expect(h.run('v1').status).toBe(0);
    const failed = h.run('v2', { FAKE_FAIL_VERSION: 'v2', FAKE_UNHEALTHY: '1' });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('did not come back healthy either');
    // The previous package's verifier, then the new package's (for a previous one that predates verify).
    expect(h.logLines().slice(-2)).toEqual(['v1 engine verify', 'v2 engine verify']);
  });

  darwinTest('a Bun on PATH older than the minimum is not used; the pinned download must match its pinned digest', () => {
    const h = harness();
    expect(h.run('v1').status).toBe(0);
    const result = h.run('v2', { FAKE_BUN_VERSION: '1.2.0' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Bun checksum mismatch; nothing was installed.');
    // Bun is settled before the package swap, so the installed app is untouched.
    expect(appVersion(h.app)).toBe('v1');
    expect(h.logLines()).toHaveLength(1);
  });

  darwinTest('a tarball that does not match its digest installs nothing', () => {
    const h = harness();
    const result = h.run('v1', { OLYMPUS_ARTIFACT_SHA256: '0'.repeat(64) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('checksum mismatch');
    expect(existsSync(h.app)).toBe(false);
  });

  test('pins Bun by version and per-architecture SHA-256, with no checksum file fetched at install time', () => {
    const text = readFileSync(SCRIPT, 'utf8');
    expect(text).toMatch(/^BUN_VERSION=1\.3\.14$/m);
    expect(text).toMatch(/^BUN_SHA256_DARWIN_AARCH64=[0-9a-f]{64}$/m);
    expect(text).toMatch(/^BUN_SHA256_DARWIN_X64=[0-9a-f]{64}$/m);
    expect(text).not.toContain('SHASUMS256.txt"');
    expect(text).not.toContain('OLYMPUS_BUN_VERSION');
  });
});
