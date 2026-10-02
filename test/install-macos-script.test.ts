/**
 * The Mac installer (scripts/install-macos.sh, rendered with release pins the
 * way scripts/publish-release-to-site.ts renders it) and the uninstaller
 * (site/uninstall.sh), run against a fake home directory.
 *
 * Unit tests: PATH shims stand in for curl, uname, sw_vers, sysctl, id and
 * launchctl; a fake Bun runs each package's dist/cli.js as a shell script
 * that logs the engine command it was given.
 *
 * End to end (macOS): real curl fetches a release tarball built from this
 * checkout and a zip of the real Bun from a local HTTPS server; the real
 * `olympus engine install` runs against the fake home, with a fake launchctl
 * that plays launchd and writes the engine status a started engine would.
 * Nothing touches the real launchctl, the real home directory or ~/.olympus.
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { renderInstallScript } from '../scripts/publish-release-to-site.ts';
import { V0_4_PUBLIC_PACKAGE_FILES } from '../src/core/public-surface.ts';

const REPO = resolve(import.meta.dir, '..');
const TEMPLATE = join(REPO, 'scripts', 'install-macos.sh');
const UNINSTALL = join(REPO, 'site', 'uninstall.sh');
const has = (tool: string): boolean => spawnSync('/bin/sh', ['-c', `command -v ${tool}`]).status === 0;
const shellTest = has('zip') && has('unzip') && has('shasum') ? test : test.skip;
const darwinE2E = process.platform === 'darwin' && has('openssl') && has('zip') ? test : test.skip;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const sha256 = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const sizeOf = (path: string): number => readFileSync(path).length;

/** The served installer, re-pointed at test hosts and a test Bun archive. */
function renderForTest(input: {
  version: string;
  tarball: string;
  releaseBase: string;
  bunBase: string;
  bunZip: string;
  sha256?: string;
}): string {
  return renderInstallScript(readFileSync(TEMPLATE, 'utf8'), {
    version: input.version,
    sha256: input.sha256 ?? sha256(input.tarball),
    bytes: sizeOf(input.tarball),
  })
    .replace(/^RELEASE_BASE=.*$/m, `RELEASE_BASE=${input.releaseBase}`)
    .replace(/^BUN_BASE=.*$/m, `BUN_BASE=${input.bunBase}`)
    .replace(/^BUN_SHA256_DARWIN_AARCH64=.*$/m, `BUN_SHA256_DARWIN_AARCH64=${sha256(input.bunZip)}`)
    .replace(/^BUN_BYTES_DARWIN_AARCH64=.*$/m, `BUN_BYTES_DARWIN_AARCH64=${sizeOf(input.bunZip)}`);
}

function zipBun(dir: string, bunBinary: string): string {
  const staging = join(dir, 'bun-zip');
  mkdirSync(join(staging, 'bun-darwin-aarch64'), { recursive: true });
  copyFileSync(bunBinary, join(staging, 'bun-darwin-aarch64', 'bun'));
  chmodSync(join(staging, 'bun-darwin-aarch64', 'bun'), 0o755);
  const zip = join(dir, 'bun-darwin-aarch64.zip');
  expect(spawnSync('zip', ['-qr', zip, 'bun-darwin-aarch64'], { cwd: staging }).status).toBe(0);
  return zip;
}

function writeExecutable(path: string, text: string): void {
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

interface RunResult { status: number | null; stderr: string; stdout: string }

/** Fails with the script's own output, so a failure says why. */
function expectSucceeded(result: RunResult, extra = ''): void {
  expect({ status: result.status, output: `${result.stdout}${result.stderr}${extra}` })
    .toEqual({ status: 0, output: `${result.stdout}${result.stderr}${extra}` });
}

interface Harness {
  root: string;
  home: string;
  support: string;
  app: string;
  runtimeBun: string;
  run(version: string, env?: Record<string, string>, options?: { sha256?: string }): RunResult;
  uninstall(env?: Record<string, string>): RunResult;
  logLines(): string[];
  curlCalls(): string[];
}

function harness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'olympus-install-script-'));
  roots.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const tarballs = join(root, 'tarballs');
  const log = join(root, 'engine.log');
  const curlLog = join(root, 'curl.log');
  for (const dir of [home, bin, tarballs, join(root, 'tmp')]) mkdirSync(dir, { recursive: true });

  // The Bun the installer downloads: --version answers, anything else runs as sh.
  const fakeBun = join(root, 'fake-bun');
  writeExecutable(fakeBun, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "${FAKE_BUN_VERSION:-1.3.14}"; exit 0; fi\nexec /bin/sh "$@"\n');
  const bunZip = zipBun(root, fakeBun);

  writeExecutable(join(bin, 'curl'), `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --proto|--retry) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$url" >> "${curlLog}"
case "$url" in
  https://releases.test/*) cp "${tarballs}/\${url##*/}" "$out" ;;
  https://bun.test/bun-v1.3.14/bun-darwin-aarch64.zip)
    if [ -n "$FAKE_BUN_CORRUPT" ]; then printf 'not the real bun' > "$out"; else cp "${bunZip}" "$out"; fi ;;
  *) exit 22 ;;
esac
`);
  writeExecutable(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo "${FAKE_UNAME_S:-Darwin}" ;; -m) echo "${FAKE_UNAME_M:-arm64}" ;; *) /usr/bin/uname "$@" ;; esac\n');
  writeExecutable(join(bin, 'sw_vers'), '#!/bin/sh\necho "${FAKE_MACOS:-15.1}"\n');
  writeExecutable(join(bin, 'sysctl'), '#!/bin/sh\necho "${FAKE_TRANSLATED:-0}"\n');
  writeExecutable(join(bin, 'id'), '#!/bin/sh\ncase "$1" in -u) echo "${FAKE_UID:-501}" ;; -un) echo tester ;; *) /usr/bin/id "$@" ;; esac\n');
  writeExecutable(join(bin, 'launchctl'), `#!/bin/sh\necho "launchctl $*" >> "${log}"\n`);

  const makeTarball = (version: string): string => {
    const file = join(tarballs, `olympus-${version}.tgz`);
    // A release is built once: the same version again is the same bytes.
    if (existsSync(file)) return file;
    const staging = join(root, `pkg-${version}`);
    mkdirSync(join(staging, 'package', 'dist'), { recursive: true });
    writeFileSync(join(staging, 'package', 'package.json'), JSON.stringify({ name: 'olympus', version }));
    // The fake engine CLI: FAKE_FAIL_VERSION fails that version's install (it
    // never proves healthy), FAKE_FAIL_RESTORE fails every install, and
    // FAKE_UNHEALTHY fails every `engine verify`.
    writeFileSync(join(staging, 'package', 'dist', 'cli.js'), [
      `echo "${version} $*" >> "${log}"`,
      'if [ "$2" = verify ]; then [ -z "$FAKE_UNHEALTHY" ] || exit 1; exit 0; fi',
      `if [ "$2" = install ] && { [ "$FAKE_FAIL_VERSION" = "${version}" ] || [ -n "$FAKE_FAIL_RESTORE" ]; }; then exit 1; fi`,
      '',
    ].join('\n'));
    expect(spawnSync('tar', ['-czf', file, '-C', staging, 'package']).status).toBe(0);
    return file;
  };
  const env = (extra: Record<string, string>): Record<string, string> => ({
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    SHELL: '/bin/zsh',
    TMPDIR: join(root, 'tmp'),
    ...extra,
  });
  const support = join(home, 'Library', 'Application Support', 'Olympus');
  return {
    root,
    home,
    support,
    app: join(support, 'app'),
    runtimeBun: join(support, 'runtime', 'bun'),
    run(version, extra = {}, options = {}) {
      const tarball = makeTarball(version);
      const script = join(root, `install-${version}.sh`);
      writeFileSync(script, renderForTest({
        version,
        tarball,
        releaseBase: 'https://releases.test',
        bunBase: 'https://bun.test',
        bunZip,
        ...(options.sha256 ? { sha256: options.sha256 } : {}),
      }));
      const result = spawnSync('/bin/sh', [script], { encoding: 'utf8', timeout: 30_000, env: env(extra) });
      return { status: result.status, stderr: result.stderr, stdout: result.stdout };
    },
    uninstall(extra = {}) {
      const result = spawnSync('/bin/sh', [UNINSTALL], { encoding: 'utf8', timeout: 30_000, env: env(extra) });
      return { status: result.status, stderr: result.stderr, stdout: result.stdout };
    },
    logLines() {
      return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
    },
    curlCalls() {
      return existsSync(curlLog) ? readFileSync(curlLog, 'utf8').trim().split('\n') : [];
    },
  };
}

const appVersion = (dir: string): string | undefined => {
  try {
    return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version;
  } catch {
    return undefined;
  }
};

const V1 = '1.0.0-rc.1';
const V2 = '1.0.0-rc.2';
const V3 = '1.0.0-rc.3';

describe('install.sh', () => {
  shellTest('installs Bun and Olympus, starts the engine, and tells the user the next step in ChatGPT', () => {
    const h = harness();
    const result = h.run(V1);
    expectSucceeded(result);
    expect(appVersion(h.app)).toBe(V1);
    expect(readFileSync(h.runtimeBun, 'utf8')).toContain('FAKE_BUN_VERSION');
    expect(h.logLines()).toEqual([`${V1} engine install --bun ${h.runtimeBun} --restart`]);
    expect(h.curlCalls()).toEqual([
      'https://bun.test/bun-v1.3.14/bun-darwin-aarch64.zip',
      `https://releases.test/${V1}/olympus-${V1}.tgz`,
    ]);
    expect(result.stdout).toContain('Olympus is installed and running in the background on this Mac.');
    expect(result.stdout).toContain('In ChatGPT desktop, add the Olympus plugin and ask: Connect Olympus');
    expect(result.stdout).toContain('olympus engine status');
    expect(result.stdout).toContain('curl -fsSL https://olympusplugin.ai/uninstall.sh | sh');
    // The `olympus` command and the PATH line that finds it.
    const launcher = readFileSync(join(h.home, '.local', 'bin', 'olympus'), 'utf8');
    expect(launcher).toContain('Written by the Olympus installer');
    expect(launcher).toContain('exec "$HOME/Library/Application Support/Olympus/runtime/bun" "$HOME/Library/Application Support/Olympus/app/dist/cli.js" "$@"');
    expect(readFileSync(join(h.home, '.zprofile'), 'utf8')).toBe('\nexport PATH="$HOME/.local/bin:$PATH" # Added by the Olympus installer\n');
    expect(readFileSync(join(h.home, 'Library', 'Logs', 'Olympus', 'install.log'), 'utf8')).toContain(`== Olympus installer ${V1}`);
  });

  shellTest('an upgrade swaps the app, keeps the previous one, restarts the engine, and reuses the installed Bun', () => {
    const h = harness();
    expectSucceeded(h.run(V1));
    expectSucceeded(h.run(V2));
    expect(appVersion(h.app)).toBe(V2);
    expect(appVersion(`${h.app}.previous`)).toBe(V1);
    expect(h.logLines().at(-1)).toBe(`${V2} engine install --bun ${h.runtimeBun} --restart`);
    expect(h.curlCalls().filter((url) => url.includes('bun.test'))).toHaveLength(1);
    // One PATH line, however often it runs.
    expect(readFileSync(join(h.home, '.zprofile'), 'utf8').match(/Olympus installer/g)).toHaveLength(1);
  });

  shellTest('running the same release again checks the engine instead of replacing the rollback copy, and repairs it when unhealthy', () => {
    const h = harness();
    expectSucceeded(h.run(V1));
    expectSucceeded(h.run(V2));
    const again = h.run(V2);
    expectSucceeded(again);
    expect(again.stdout).toContain(`Olympus ${V2} is already installed.`);
    expect(appVersion(`${h.app}.previous`)).toBe(V1);
    expect(h.logLines().at(-1)).toBe(`${V2} engine verify`);

    const repaired = h.run(V2, { FAKE_UNHEALTHY: '1' });
    expectSucceeded(repaired);
    expect(h.logLines().slice(-2)).toEqual([`${V2} engine verify`, `${V2} engine install --bun ${h.runtimeBun} --restart`]);
    expect(appVersion(`${h.app}.previous`)).toBe(V1);
  });

  shellTest('an upgrade whose engine does not prove healthy puts the previous version back, starts it, and verifies it', () => {
    const h = harness();
    expectSucceeded(h.run(V1));
    expectSucceeded(h.run(V2));
    const failed = h.run(V3, { FAKE_FAIL_VERSION: V3 });
    expect(failed.status).not.toBe(0);
    expect(failed.stdout).toContain('restoring the previous one');
    expect(failed.stderr).toContain('the previous version was restored and is running');
    expect(appVersion(h.app)).toBe(V2);
    expect(existsSync(`${h.app}.failed`)).toBe(false);
    expect(h.logLines().slice(-3)).toEqual([
      `${V3} engine install --bun ${h.runtimeBun} --restart`,
      `${V2} engine install --bun ${h.runtimeBun} --restart`,
      `${V2} engine verify`,
    ]);
  });

  shellTest('a restore that cannot start the previous version is reported, not swallowed', () => {
    const h = harness();
    expectSucceeded(h.run(V1));
    const failed = h.run(V2, { FAKE_FAIL_RESTORE: '1' });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('the restored previous version did not come back healthy either');
    expect(failed.stderr).not.toContain('was restored and is running');
    // Both ways of starting the previous version were tried; nothing claimed it healthy.
    expect(h.logLines().slice(-3)).toEqual([
      `${V2} engine install --bun ${h.runtimeBun} --restart`,
      `${V1} engine install --bun ${h.runtimeBun} --restart`,
      `${V1} engine install --bun ${h.runtimeBun}`,
    ]);
    expect(appVersion(h.app)).toBe(V1);
  });

  shellTest('a previous version whose install exits 0 but never proves healthy is reported as not restored', () => {
    const h = harness();
    expectSucceeded(h.run(V1));
    const failed = h.run(V2, { FAKE_FAIL_VERSION: V2, FAKE_UNHEALTHY: '1' });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('did not come back healthy either');
    // The previous package's verifier, then the new package's (for a previous one that predates verify).
    expect(h.logLines().slice(-2)).toEqual([`${V1} engine verify`, `${V2} engine verify`]);
  });

  shellTest('a first install whose engine does not start says so and points to the log', () => {
    const h = harness();
    const failed = h.run(V1, { FAKE_FAIL_VERSION: V1 });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('Olympus is installed but did not start.');
    expect(failed.stderr).toContain('install.log');
  });

  shellTest('a tarball that does not match its pinned SHA-256 changes nothing on the Mac', () => {
    const h = harness();
    const result = h.run(V1, {}, { sha256: '0'.repeat(64) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('the Olympus download did not match its checksum, so it was not used.');
    expect(result.stderr).toContain('Nothing was changed on this Mac.');
    expect(existsSync(join(h.home, 'Library'))).toBe(false);
    expect(existsSync(join(h.home, '.local'))).toBe(false);
    expect(h.logLines()).toEqual([]);
  });

  shellTest('a tarball that does not match on an upgrade leaves the installed version alone', () => {
    const h = harness();
    expectSucceeded(h.run(V1));
    const result = h.run(V2, {}, { sha256: 'f'.repeat(64) });
    expect(result.status).not.toBe(0);
    expect(appVersion(h.app)).toBe(V1);
    expect(h.logLines()).toHaveLength(1);
  });

  shellTest('a Bun download that does not match its pinned SHA-256 is never run', () => {
    const h = harness();
    const result = h.run(V1, { FAKE_BUN_CORRUPT: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('the Bun download did not match its checksum, so it was not used.');
    expect(existsSync(join(h.home, 'Library'))).toBe(false);
  });

  shellTest('a runtime Bun of another version is replaced by the pinned one', () => {
    const h = harness();
    expectSucceeded(h.run(V1));
    expectSucceeded(h.run(V2, { FAKE_BUN_VERSION: '1.2.0' }));
    expect(h.curlCalls().filter((url) => url.includes('bun.test'))).toHaveLength(2);
  });

  shellTest('an Intel Mac is refused before anything is downloaded', () => {
    const h = harness();
    const result = h.run(V1, { FAKE_UNAME_M: 'x86_64', FAKE_TRANSLATED: '0' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('this Mac has an Intel processor.');
    expect(result.stderr).toContain('Olympus needs a Mac with Apple silicon (M1 or later). Nothing was changed on this Mac.');
    expect(h.curlCalls()).toEqual([]);
    expect(existsSync(join(h.home, 'Library'))).toBe(false);
  });

  shellTest('an Apple-silicon Mac whose Terminal runs under Rosetta installs the Apple-silicon build', () => {
    const h = harness();
    expectSucceeded(h.run(V1, { FAKE_UNAME_M: 'x86_64', FAKE_TRANSLATED: '1' }));
    expect(h.curlCalls()[0]).toBe('https://bun.test/bun-v1.3.14/bun-darwin-aarch64.zip');
  });

  shellTest('macOS older than 13 is refused before anything is downloaded', () => {
    const h = harness();
    const result = h.run(V1, { FAKE_MACOS: '12.7.4' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('this Mac runs macOS 12.7.4.');
    expect(result.stderr).toContain('Olympus needs macOS 13 (Ventura) or later.');
    expect(h.curlCalls()).toEqual([]);
  });

  shellTest('root and other systems are refused', () => {
    const h = harness();
    const root = h.run(V1, { FAKE_UID: '0' });
    expect(root.status).not.toBe(0);
    expect(root.stderr).toContain('it was run as root');
    const linux = h.run(V1, { FAKE_UNAME_S: 'Linux' });
    expect(linux.status).not.toBe(0);
    expect(linux.stderr).toContain('this installer is for macOS.');
    expect(h.curlCalls()).toEqual([]);
  });

  shellTest('an `olympus` command the installer did not write is left alone', () => {
    const h = harness();
    mkdirSync(join(h.home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(h.home, '.local', 'bin', 'olympus'), '#!/bin/sh\necho mine\n');
    const result = h.run(V1);
    expectSucceeded(result);
    expect(readFileSync(join(h.home, '.local', 'bin', 'olympus'), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    expect(result.stdout).toContain('this installer did not write it');
    expect(result.stdout).toContain(`"${h.runtimeBun}" "${h.app}/dist/cli.js" engine status`);
    expect(existsSync(join(h.home, '.zprofile'))).toBe(false);
  });

  shellTest('OLYMPUS_NO_MODIFY_PATH leaves shell profiles alone; ~/.local/bin already on PATH needs no line', () => {
    const h = harness();
    expectSucceeded(h.run(V1, { OLYMPUS_NO_MODIFY_PATH: '1' }));
    expect(existsSync(join(h.home, '.zprofile'))).toBe(false);
    const onPath = harness();
    const result = onPath.run(V1, { PATH: `${join(onPath.root, 'bin')}:${join(onPath.home, '.local', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin` });
    expectSucceeded(result);
    expect(existsSync(join(onPath.home, '.zprofile'))).toBe(false);
    expect(result.stdout).toContain('run: olympus engine status');
  });

  test('the template refuses to run until a release is pinned into it', () => {
    const result = spawnSync('/bin/sh', [TEMPLATE], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('this is the installer template, not a release.');
  });

  test('pins Bun by version, SHA-256 and size, and takes no download location or checksum from the environment', () => {
    const text = readFileSync(TEMPLATE, 'utf8');
    expect(text).toMatch(/^BUN_VERSION=1\.3\.14$/m);
    expect(text).toMatch(/^BUN_SHA256_DARWIN_AARCH64=[0-9a-f]{64}$/m);
    expect(text).toMatch(/^BUN_BYTES_DARWIN_AARCH64=[0-9]+$/m);
    expect(text).toMatch(/^RELEASE_BASE=https:\/\/olympusplugin\.ai\/releases$/m);
    expect(text).toMatch(/^BUN_BASE=https:\/\/github\.com\/oven-sh\/bun\/releases\/download$/m);
    expect(text).not.toContain('SHASUMS256.txt"');
    expect(text).not.toContain('OLYMPUS_ARTIFACT_URL');
    expect(text).not.toContain('OLYMPUS_ARTIFACT_SHA256');
    expect(text).not.toMatch(/^\s*sudo\s/m);
    expect(text).not.toContain('DRAFT');
    expect(text).toContain("curl -fsSL --proto '=https' --tlsv1.2");
    // The whole script runs from main, on the last line, so a cut-short download runs nothing.
    expect(text.trimEnd().split('\n').at(-1)).toBe('main "$@"');
  });

  test.skipIf(!has('shellcheck'))('the installer, uninstaller and site deploy script pass shellcheck', () => {
    for (const [shell, path] of [['sh', TEMPLATE], ['sh', UNINSTALL], ['bash', join(REPO, 'site', 'deploy', 'deploy.sh')]] as const) {
      const result = spawnSync('shellcheck', ['-s', shell, path], { encoding: 'utf8' });
      expect(`${path}\n${result.stdout}${result.stderr}`).toBe(`${path}\n`);
      expect(result.status).toBe(0);
    }
  });
});

describe('uninstall.sh', () => {
  shellTest('stops the engine, removes the app, runtime, command and PATH line, and keeps data', () => {
    const h = harness();
    writeFileSync(join(h.home, '.zprofile'), 'export EDITOR=vim\n');
    expectSucceeded(h.run(V1));
    mkdirSync(join(h.home, '.olympus'), { recursive: true });
    writeFileSync(join(h.home, '.olympus', 'engine.json'), '{}');
    const result = h.uninstall();
    expectSucceeded(result);
    expect(h.logLines().at(-1)).toBe(`${V1} engine uninstall`);
    expect(existsSync(h.support)).toBe(false);
    expect(existsSync(join(h.home, '.local', 'bin', 'olympus'))).toBe(false);
    expect(readFileSync(join(h.home, '.zprofile'), 'utf8')).toBe('export EDITOR=vim\n\n');
    expect(readFileSync(join(h.home, '.olympus', 'engine.json'), 'utf8')).toBe('{}');
    expect(result.stdout).toContain('Olympus is uninstalled. Your data and settings are still on this Mac:');
    expect(result.stdout).toContain(join(h.home, '.olympus'));
    expect(result.stdout).toContain('olympus data delete --all');
  });

  shellTest('with the app already gone, unloads and removes the login item directly; a foreign command stays', () => {
    const h = harness();
    const plist = join(h.home, 'Library', 'LaunchAgents', 'ai.olympusplugin.engine.plist');
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, '<plist/>');
    mkdirSync(join(h.home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(h.home, '.local', 'bin', 'olympus'), '#!/bin/sh\necho mine\n');
    expectSucceeded(h.uninstall());
    expect(h.logLines()).toEqual(['launchctl bootout gui/501/ai.olympusplugin.engine']);
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(join(h.home, '.local', 'bin', 'olympus'))).toBe(true);
  });

  shellTest('an engine that cannot be stopped leaves everything in place', () => {
    const h = harness();
    expectSucceeded(h.run(V1));
    writeFileSync(join(h.app, 'dist', 'cli.js'), 'exit 1\n');
    const result = h.uninstall();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Olympus could not be stopped, so nothing was removed.');
    expect(existsSync(h.app)).toBe(true);
    expect(existsSync(join(h.home, '.local', 'bin', 'olympus'))).toBe(true);
  });

  shellTest('refuses root', () => {
    const h = harness();
    const result = h.uninstall({ FAKE_UID: '0' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('it was run as root');
  });
});

// ---------------------------------------------------------------------------
// End to end: real curl over HTTPS, real Bun, the real engine CLI.

describe('install.sh end to end', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterAll(() => server?.stop(true));

  darwinE2E('installs, upgrades, restores a failed upgrade and uninstalls through the real engine CLI', async () => {
    // Real path: the engine records its package root resolved, so /var vs /private/var would differ.
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'olympus-install-e2e-')));
    roots.push(root);
    const home = join(root, 'home');
    const shims = join(root, 'shims');
    const served = join(root, 'served');
    const launchd = join(root, 'launchd');
    for (const dir of [home, shims, served, launchd, join(root, 'tmp')]) mkdirSync(dir, { recursive: true });

    // A certificate for 127.0.0.1 that curl trusts through CURL_CA_BUNDLE.
    const cert = join(root, 'cert.pem');
    const key = join(root, 'key.pem');
    const openssl = spawnSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1',
    ], { encoding: 'utf8' });
    expect(openssl.status).toBe(0);
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') },
      fetch(request) {
        const path = resolve(served, `.${decodeURIComponent(new URL(request.url).pathname)}`);
        return path.startsWith(`${served}/`) && existsSync(path) ? new Response(Bun.file(path)) : new Response('not found', { status: 404 });
      },
    });
    const origin = `https://127.0.0.1:${server.port}`;

    // The Bun the installer downloads is this test's own Bun.
    const bunZip = zipBun(root, process.execPath);
    mkdirSync(join(served, 'bun', 'bun-v1.3.14'), { recursive: true });
    copyFileSync(bunZip, join(served, 'bun', 'bun-v1.3.14', 'bun-darwin-aarch64.zip'));

    // Release tarballs built from this checkout's package files.
    const release = (version: string): string => {
      const staging = join(root, `staging-${version}`, 'package');
      for (const file of V0_4_PUBLIC_PACKAGE_FILES) {
        mkdirSync(dirname(join(staging, file)), { recursive: true });
        copyFileSync(join(REPO, file), join(staging, file));
      }
      const pkg = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8')) as Record<string, unknown>;
      pkg.name = 'olympus';
      pkg.version = version;
      delete pkg.private;
      writeFileSync(join(staging, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
      const tarball = join(served, 'releases', version, `olympus-${version}.tgz`);
      mkdirSync(dirname(tarball), { recursive: true });
      expect(spawnSync('tar', ['-czf', tarball, '-C', dirname(staging), 'package']).status).toBe(0);
      const script = join(root, `install-${version}.sh`);
      writeFileSync(script, renderForTest({ version, tarball, releaseBase: `${origin}/releases`, bunBase: `${origin}/bun`, bunZip }));
      return script;
    };

    // launchd, played by a shell script: it loads and unloads the label, and a
    // load (or kickstart) writes the status a started engine writes, naming
    // the build in the plist, so `engine install` gets its proof. A build
    // whose version is FAKE_LAUNCHD_FAIL_VERSION fails to load.
    const statusPath = join(home, '.local', 'share', 'openclaw', 'olympus', 'engine', 'status.json');
    const plistPath = join(home, 'Library', 'LaunchAgents', 'ai.olympusplugin.engine.plist');
    writeExecutable(join(shims, 'launchctl'), `#!/bin/sh
echo "$*" >> "${launchd}/calls"
started() {
  build=$(sed -n '/OLYMPUS_ENGINE_BUILD/{n;s/.*<string>\\(.*\\)<\\/string>.*/\\1/p;}' "$1")
  case "$build" in "$FAKE_LAUNCHD_FAIL_VERSION"+*) echo "Bootstrap failed: 1: Operation not permitted" >&2; exit 1 ;; esac
  mkdir -p "${dirname(statusPath)}"
  printf '{"schema":"olympus.engine.status.v1","state":"running","build":"%s","pid":%s,"started_at":"%s","services":{"olympus-worker":{"state":"off"}}}\\n' \\
    "$build" "$FAKE_ENGINE_PID" "$(date -u -v+2S '+%Y-%m-%dT%H:%M:%S.000Z')" > "${statusPath}"
}
case "$1" in
  print) [ -f "${launchd}/loaded" ] && exit 0; echo "Could not find service" >&2; exit 113 ;;
  bootout) rm -f "${launchd}/loaded" ;;
  enable) ;;
  bootstrap) started "$3"; touch "${launchd}/loaded" ;;
  kickstart) started "${plistPath}" ;;
  *) exit 1 ;;
esac
`);
    const env = {
      PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      SHELL: '/bin/zsh',
      TMPDIR: join(root, 'tmp'),
      CURL_CA_BUNDLE: cert,
      FAKE_ENGINE_PID: String(process.pid),
    };
    const sh = async (args: string[], extra: Record<string, string> = {}): Promise<RunResult> => {
      const child = Bun.spawn(['/bin/sh', ...args], { env: { ...env, ...extra }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
      const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { status, stdout, stderr };
    };
    const support = join(home, 'Library', 'Application Support', 'Olympus');
    const app = join(support, 'app');
    const runtimeBun = join(support, 'runtime', 'bun');
    const logPath = join(home, 'Library', 'Logs', 'Olympus', 'install.log');
    const installLog = (): string => (existsSync(logPath) ? readFileSync(logPath, 'utf8') : '');

    // Fresh install.
    const first = await sh([release(V1)]);
    expectSucceeded(first, installLog());
    expect(first.stdout).toContain('Olympus is installed and running in the background on this Mac.');
    expect(sha256(runtimeBun)).toBe(sha256(process.execPath));
    const plist = readFileSync(plistPath, 'utf8');
    expect(plist).toContain(`<string>${runtimeBun}</string>`);
    expect(plist).toContain(`<string>${join(app, 'dist', 'cli.js')}</string>`);
    expect(plist).toContain(`<string>${V1}+`);
    expect(existsSync(join(home, '.olympus', 'engine.json'))).toBe(true);
    expect(readFileSync(join(launchd, 'calls'), 'utf8')).toContain(`bootstrap gui/${process.getuid!()} ${plistPath}`);
    // The `olympus` command runs the installed engine CLI.
    const verify = await sh([join(home, '.local', 'bin', 'olympus'), 'engine', 'verify']);
    expectSucceeded(verify);
    expect(JSON.parse(verify.stdout).ok).toBe(true);

    // Upgrade: the agent reloads onto the new build; the old one is kept.
    expectSucceeded(await sh([release(V2)]), installLog());
    expect(appVersion(app)).toBe(V2);
    expect(appVersion(`${app}.previous`)).toBe(V1);
    expect(readFileSync(plistPath, 'utf8')).toContain(`<string>${V2}+`);

    // A failed upgrade puts V2 back and proves it running.
    const third = await sh([release(V3)], { FAKE_LAUNCHD_FAIL_VERSION: V3 });
    expect(third.status).not.toBe(0);
    expect(third.stderr).toContain('the previous version was restored and is running');
    expect(appVersion(app)).toBe(V2);
    expect(readFileSync(plistPath, 'utf8')).toContain(`<string>${V2}+`);
    expect(installLog()).toContain('Operation not permitted');

    // Uninstall: the real `engine uninstall` unloads and removes the agent.
    expectSucceeded(await sh([UNINSTALL]), installLog());
    expect(existsSync(plistPath)).toBe(false);
    expect(existsSync(support)).toBe(false);
    expect(existsSync(join(home, '.local', 'bin', 'olympus'))).toBe(false);
    expect(readFileSync(join(home, '.zprofile'), 'utf8')).not.toContain('Olympus');
    expect(existsSync(join(home, '.olympus', 'engine.json'))).toBe(true);
  }, 120_000);
});
