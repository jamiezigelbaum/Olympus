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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
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
  /** The bun program inside bunZip. */
  bunExe: string;
  sha256?: string;
  bunExeSha256?: string;
}): string {
  return renderInstallScript(readFileSync(TEMPLATE, 'utf8'), {
    version: input.version,
    sha256: input.sha256 ?? sha256(input.tarball),
    bytes: sizeOf(input.tarball),
  })
    .replace(/^RELEASE_BASE=.*$/m, `RELEASE_BASE=${input.releaseBase}`)
    .replace(/^BUN_BASE=.*$/m, `BUN_BASE=${input.bunBase}`)
    .replace(/^BUN_SHA256_DARWIN_AARCH64=.*$/m, `BUN_SHA256_DARWIN_AARCH64=${sha256(input.bunZip)}`)
    .replace(/^BUN_BYTES_DARWIN_AARCH64=.*$/m, `BUN_BYTES_DARWIN_AARCH64=${sizeOf(input.bunZip)}`)
    .replace(/^BUN_EXE_SHA256_DARWIN_AARCH64=.*$/m, `BUN_EXE_SHA256_DARWIN_AARCH64=${input.bunExeSha256 ?? sha256(input.bunExe)}`);
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
  uid: number;
  run(version: string, env?: Record<string, string>, options?: { sha256?: string; bunExeSha256?: string }): RunResult;
  uninstall(env?: Record<string, string>): RunResult;
  /** The engine commands run, with the verified download and the app folder named <download> and <app>. */
  logLines(): string[];
  curlCalls(): string[];
  /** The release tarball for a version (built once). */
  tarball(version: string): string;
}

/** The shells the scripts must run under: sh, and dash where it is installed (it is /bin/sh on Debian and Ubuntu). */
const SHELLS = ['/bin/sh', ...(existsSync('/bin/dash') ? ['/bin/dash'] : [])];
const UID = process.getuid?.() ?? 501;

function harness(shell = '/bin/sh'): Harness {
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
  // launchctl: logs each call; print answers FAKE_LAUNCHCTL_PRINT (113, "not loaded", by default).
  writeExecutable(join(bin, 'launchctl'), `#!/bin/sh\necho "launchctl $*" >> "${log}"\nif [ "$1" = print ]; then exit "\${FAKE_LAUNCHCTL_PRINT:-113}"; fi\n`);
  // mv: FAKE_MV_FAIL_ONCE=<destination> fails the first move onto that path.
  writeExecutable(join(bin, 'mv'), `#!/bin/sh
for last in "$@"; do :; done
if [ -n "$FAKE_MV_FAIL_ONCE" ] && [ "$last" = "$FAKE_MV_FAIL_ONCE" ] && [ ! -e "${root}/mv-failed" ]; then
  : > "${root}/mv-failed"
  echo "mv: simulated failure" >&2
  exit 1
fi
exec /bin/mv "$@"
`);

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
      // FAKE_TERM_VERSION: that version's install stops the installer (Ctrl-C, a closed Terminal).
      `if [ "$2" = install ] && [ "$FAKE_TERM_VERSION" = "${version}" ]; then kill -TERM "$PPID"; fi`,
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
    FAKE_UID: String(UID),
    ...extra,
  });
  const support = join(home, 'Library', 'Application Support', 'Olympus');
  const app = join(support, 'app');
  return {
    root,
    home,
    support,
    app,
    runtimeBun: join(support, 'runtime', 'bun'),
    uid: UID,
    tarball: makeTarball,
    run(version, extra = {}, options = {}) {
      const tarball = makeTarball(version);
      const script = join(root, `install-${version}.sh`);
      writeFileSync(script, renderForTest({
        version,
        tarball,
        releaseBase: 'https://releases.test',
        bunBase: 'https://bun.test',
        bunZip,
        bunExe: fakeBun,
        ...(options.sha256 ? { sha256: options.sha256 } : {}),
        ...(options.bunExeSha256 ? { bunExeSha256: options.bunExeSha256 } : {}),
      }));
      const result = spawnSync(shell, [script], { encoding: 'utf8', timeout: 30_000, env: env(extra) });
      return { status: result.status, stderr: result.stderr, stdout: result.stdout };
    },
    uninstall(extra = {}) {
      const result = spawnSync(shell, [UNINSTALL], { encoding: 'utf8', timeout: 30_000, env: env(extra) });
      return { status: result.status, stderr: result.stderr, stdout: result.stdout };
    },
    logLines() {
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf8').trim().split('\n')
        .map((line) => line.split(` --expect-package ${app}`).join(' --expect-package <app>'))
        .map((line) => line.replace(/ --expect-package \S*\/olympus-install\.\w+\/unpacked\/package$/, ' --expect-package <download>'));
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
const V4 = '1.0.0-rc.4';

/** Unpack a release tarball into a folder, the way the installer leaves it (with its receipt). */
function unpackInto(tarball: string, dir: string): void {
  const staging = mkdtempSync(join(dirname(dir), '.unpack-'));
  expect(spawnSync('tar', ['-xzf', tarball, '-C', staging]).status).toBe(0);
  writeFileSync(join(staging, 'package', '.olympus-release-sha256'), `${sha256(tarball)}\n`);
  renameSync(join(staging, 'package'), dir);
  rmSync(staging, { recursive: true, force: true });
}

const leftovers = (support: string): string[] =>
  existsSync(support) ? readdirSync(support).filter((name) => name !== 'app' && name !== 'app.previous' && name !== 'runtime') : [];

describe.each(SHELLS)('install.sh under %s', (shell) => {
  shellTest('installs Bun and Olympus, starts the engine, and tells the user the next step in ChatGPT', () => {
    const h = harness(shell);
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
    // No lock, swap marker or scratch folder is left behind.
    expect(leftovers(h.support)).toEqual([]);
  });

  shellTest('an upgrade swaps the app, keeps the previous one, restarts the engine, and reuses the installed Bun', () => {
    const h = harness(shell);
    expectSucceeded(h.run(V1));
    expectSucceeded(h.run(V2));
    expect(appVersion(h.app)).toBe(V2);
    expect(appVersion(`${h.app}.previous`)).toBe(V1);
    expect(h.logLines().at(-1)).toBe(`${V2} engine install --bun ${h.runtimeBun} --restart`);
    expect(h.curlCalls().filter((url) => url.includes('bun.test'))).toHaveLength(1);
    // One PATH line, however often it runs.
    expect(readFileSync(join(h.home, '.zprofile'), 'utf8').match(/Olympus installer/g)).toHaveLength(1);
    expect(leftovers(h.support)).toEqual([]);
  });

  shellTest('running the same release again checks the engine against the verified download, and repairs it when it does not prove that build', () => {
    const h = harness(shell);
    expectSucceeded(h.run(V1));
    expectSucceeded(h.run(V2));
    const again = h.run(V2);
    expectSucceeded(again);
    expect(again.stdout).toContain(`Olympus ${V2} is already installed.`);
    expect(appVersion(`${h.app}.previous`)).toBe(V1);
    // The expected build is the verified download's, not whatever the installed agent names.
    expect(h.logLines().at(-1)).toBe(`${V2} engine verify --expect-package <download>`);

    const repaired = h.run(V2, { FAKE_UNHEALTHY: '1' });
    expectSucceeded(repaired);
    expect(h.logLines().slice(-2)).toEqual([`${V2} engine verify --expect-package <download>`, `${V2} engine install --bun ${h.runtimeBun} --restart`]);
    expect(appVersion(`${h.app}.previous`)).toBe(V1);
  });

  shellTest('PoC: an installed copy whose CLI is damaged or missing, with an intact receipt, is replaced from the verified download', () => {
    const h = harness(shell);
    expectSucceeded(h.run(V1));
    expectSucceeded(h.run(V2));
    const cli = join(h.app, 'dist', 'cli.js');
    const good = readFileSync(cli, 'utf8');
    for (const damage of [() => writeFileSync(cli, 'exit 0\n'), () => rmSync(cli)]) {
      damage();
      const result = h.run(V2);
      expectSucceeded(result);
      expect(result.stdout).toContain(`The installed copy of Olympus ${V2} is incomplete or changed; replacing it with the verified download...`);
      expect(readFileSync(cli, 'utf8')).toBe(good);
      // The rollback copy is kept, and the engine is restarted on the replaced files.
      expect(appVersion(`${h.app}.previous`)).toBe(V1);
      expect(h.logLines().at(-1)).toBe(`${V2} engine install --bun ${h.runtimeBun} --restart`);
      expect(leftovers(h.support)).toEqual([]);
    }
  });

  shellTest('an upgrade whose engine does not prove healthy puts the previous version back, starts it, and verifies it', () => {
    const h = harness(shell);
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
      `${V2} engine verify --expect-package <app>`,
    ]);
    expect(leftovers(h.support)).toEqual([]);
  });

  shellTest('a restore that cannot start the previous version is reported, not swallowed', () => {
    const h = harness(shell);
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
    const h = harness(shell);
    expectSucceeded(h.run(V1));
    const failed = h.run(V2, { FAKE_FAIL_VERSION: V2, FAKE_UNHEALTHY: '1' });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('did not come back healthy either');
    // The previous package's verifier, then the new package's (for a previous one that predates verify),
    // both against the previous package's build.
    expect(h.logLines().slice(-2)).toEqual([`${V1} engine verify --expect-package <app>`, `${V2} engine verify --expect-package <app>`]);
  });

  shellTest('a first install whose engine does not start says so and points to the log', () => {
    const h = harness(shell);
    const failed = h.run(V1, { FAKE_FAIL_VERSION: V1 });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('Olympus is installed but did not start.');
    expect(failed.stderr).toContain('install.log');
  });

  shellTest('PoC: an upgrade cut short after its first rename is put back on the next run, then completed', () => {
    const h = harness(shell);
    expectSucceeded(h.run(V1));
    // What a power cut between the two renames leaves: no app/, the old one as app.previous, the new one unpacked beside it.
    renameSync(h.app, `${h.app}.previous`);
    mkdirSync(join(`${h.app}.next`, 'dist'), { recursive: true });
    writeFileSync(join(h.support, '.install-swap'), 'upgrade\n');
    const result = h.run(V2);
    expectSucceeded(result);
    expect(result.stdout).toContain('Put back the version an interrupted upgrade had moved aside.');
    expect(appVersion(h.app)).toBe(V2);
    expect(appVersion(`${h.app}.previous`)).toBe(V1);
    expect(leftovers(h.support)).toEqual([]);
  });

  shellTest('PoC: an upgrade cut short while its engine was starting is swapped back on the next run and done again', () => {
    const h = harness(shell);
    expectSucceeded(h.run(V1));
    // The swap finished, the marker says the engine never proved the new build.
    renameSync(h.app, `${h.app}.previous`);
    unpackInto(h.tarball(V2), h.app);
    writeFileSync(join(h.support, '.install-swap'), 'upgrade\n');
    const result = h.run(V2);
    expectSucceeded(result);
    expect(result.stdout).toContain('Put back the version that was installed before an interrupted upgrade.');
    expect(result.stdout).not.toContain('is already installed');
    expect(appVersion(h.app)).toBe(V2);
    expect(appVersion(`${h.app}.previous`)).toBe(V1);
    expect(h.logLines().at(-1)).toBe(`${V2} engine install --bun ${h.runtimeBun} --restart`);
    expect(leftovers(h.support)).toEqual([]);
  });

  shellTest('a failure after the first rename puts the previous version back before the installer exits', () => {
    const h = harness(shell);
    expectSucceeded(h.run(V1));
    const failed = h.run(V2, { FAKE_MV_FAIL_ONCE: h.app });
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('The upgrade stopped before it finished, so the previous version was put back. Run the installer again.');
    expect(appVersion(h.app)).toBe(V1);
    expect(existsSync(`${h.app}.previous`)).toBe(false);
    expect(leftovers(h.support)).toEqual([]);
    expect(h.logLines()).toEqual([`${V1} engine install --bun ${h.runtimeBun} --restart`]);
  });

  shellTest('an installer stopped (SIGTERM) while the new engine starts puts the previous version back', () => {
    const h = harness(shell);
    expectSucceeded(h.run(V1));
    const stopped = h.run(V2, { FAKE_TERM_VERSION: V2 });
    expect(stopped.status).toBe(143);
    expect(stopped.stderr).toContain('so the previous version was put back');
    expect(appVersion(h.app)).toBe(V1);
    expect(leftovers(h.support)).toEqual([]);
    // The next run upgrades again.
    expectSucceeded(h.run(V2));
    expect(appVersion(h.app)).toBe(V2);
    expect(appVersion(`${h.app}.previous`)).toBe(V1);
  });

  shellTest('one installer at a time: a lock held by a running process refuses; a lock left by a dead one is taken over', () => {
    const h = harness(shell);
    expectSucceeded(h.run(V1));
    const lock = join(h.support, '.install.lock');
    mkdirSync(lock);
    writeFileSync(join(lock, 'pid'), `${process.pid}\n`);
    const busy = h.run(V2);
    expect(busy.status).not.toBe(0);
    expect(busy.stderr).toContain(`another Olympus installer is running (process ${process.pid}).`);
    expect(appVersion(h.app)).toBe(V1);
    // Another installer's lock is not this one's to remove.
    expect(readFileSync(join(lock, 'pid'), 'utf8')).toBe(`${process.pid}\n`);

    const dead = spawnSync('/bin/sh', ['-c', 'echo $$']).stdout.toString().trim();
    writeFileSync(join(lock, 'pid'), `${dead}\n`);
    expectSucceeded(h.run(V2));
    expect(appVersion(h.app)).toBe(V2);
    expect(existsSync(lock)).toBe(false);
  });

  shellTest('PoC: a symbolic link anywhere in the managed folders is refused before anything cached runs or anything changes', () => {
    for (const [name, link] of [
      ['Olympus', (h: Harness) => h.support],
      ['app', (h: Harness) => h.app],
      ['app.previous', (h: Harness) => `${h.app}.previous`],
      ['runtime', (h: Harness) => dirname(h.runtimeBun)],
      ['bun', (h: Harness) => h.runtimeBun],
      ['.local/bin', (h: Harness) => join(h.home, '.local', 'bin')],
    ] as const) {
      const h = harness(shell);
      expectSucceeded(h.run(V1));
      if (name === 'app.previous') expectSucceeded(h.run(V2));
      const path = link(h);
      const elsewhere = join(h.root, `elsewhere-${name.replace('/', '-')}`);
      renameSync(path, elsewhere);
      symlinkSync(elsewhere, path);
      const before = h.logLines().length;
      const curls = h.curlCalls().length;
      const result = h.run(V3);
      expect({ name, status: result.status }).toEqual({ name, status: 1 });
      expect(result.stderr).toContain(`Olympus was not installed: ${path} is a symbolic link.`);
      expect(result.stderr).toContain('Olympus installs only into real folders (not symbolic links) that belong to you.');
      // Nothing ran (no engine command, no download) and nothing moved.
      expect(h.logLines()).toHaveLength(before);
      expect(h.curlCalls()).toHaveLength(curls);
      expect(lstatSync(path).isSymbolicLink()).toBe(true);
    }
  });

  shellTest('PoC: managed folders that belong to another user are refused before anything changes', () => {
    const h = harness(shell);
    expectSucceeded(h.run(V1));
    const result = h.run(V2, { FAKE_UID: String(h.uid + 1) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('belongs to another user.');
    expect(appVersion(h.app)).toBe(V1);
    expect(h.logLines()).toHaveLength(1);
    expect(h.curlCalls()).toHaveLength(2);
  });

  shellTest('a tarball that does not match its pinned SHA-256 changes nothing on the Mac', () => {
    const h = harness(shell);
    const result = h.run(V1, {}, { sha256: '0'.repeat(64) });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('the Olympus download did not match its checksum, so it was not used.');
    expect(result.stderr).toContain('Nothing was changed on this Mac.');
    expect(existsSync(join(h.home, 'Library'))).toBe(false);
    expect(existsSync(join(h.home, '.local'))).toBe(false);
    expect(h.logLines()).toEqual([]);
  });

  shellTest('a tarball that does not match on an upgrade leaves the installed version alone', () => {
    const h = harness(shell);
    expectSucceeded(h.run(V1));
    const result = h.run(V2, {}, { sha256: 'f'.repeat(64) });
    expect(result.status).not.toBe(0);
    expect(appVersion(h.app)).toBe(V1);
    expect(h.logLines()).toHaveLength(1);
  });

  shellTest('a Bun download that does not match its pinned SHA-256, or whose program does not, is never run', () => {
    const h = harness(shell);
    const result = h.run(V1, { FAKE_BUN_CORRUPT: '1' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('the Bun download did not match its checksum, so it was not used.');
    expect(existsSync(join(h.home, 'Library'))).toBe(false);

    const program = h.run(V1, {}, { bunExeSha256: '0'.repeat(64) });
    expect(program.status).not.toBe(0);
    expect(program.stderr).toContain('the bun program in the Bun download did not match its checksum, so it was not used.');
    expect(existsSync(join(h.home, 'Library'))).toBe(false);
  });

  shellTest('PoC: an installed Bun that is not the pinned program is never run, and is replaced from the verified download', () => {
    const h = harness(shell);
    expectSucceeded(h.run(V1));
    const ran = join(h.root, 'tampered-bun-ran');
    writeExecutable(h.runtimeBun, `#!/bin/sh\n: > "${ran}"\necho 1.3.14\n`);
    expectSucceeded(h.run(V2));
    expect(existsSync(ran)).toBe(false);
    expect(readFileSync(h.runtimeBun, 'utf8')).toContain('FAKE_BUN_VERSION');
    expect(h.curlCalls().filter((url) => url.includes('bun.test'))).toHaveLength(2);
    expect(appVersion(h.app)).toBe(V2);
  });

  shellTest('an Intel Mac is refused before anything is downloaded', () => {
    const h = harness(shell);
    const result = h.run(V1, { FAKE_UNAME_M: 'x86_64', FAKE_TRANSLATED: '0' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('this Mac has an Intel processor.');
    expect(result.stderr).toContain('Olympus needs a Mac with Apple silicon (M1 or later). Nothing was changed on this Mac.');
    expect(h.curlCalls()).toEqual([]);
    expect(existsSync(join(h.home, 'Library'))).toBe(false);
  });

  shellTest('an Apple-silicon Mac whose Terminal runs under Rosetta installs the Apple-silicon build', () => {
    const h = harness(shell);
    expectSucceeded(h.run(V1, { FAKE_UNAME_M: 'x86_64', FAKE_TRANSLATED: '1' }));
    expect(h.curlCalls()[0]).toBe('https://bun.test/bun-v1.3.14/bun-darwin-aarch64.zip');
  });

  shellTest('macOS older than 13 is refused before anything is downloaded', () => {
    const h = harness(shell);
    const result = h.run(V1, { FAKE_MACOS: '12.7.4' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('this Mac runs macOS 12.7.4.');
    expect(result.stderr).toContain('Olympus needs macOS 13 (Ventura) or later.');
    expect(h.curlCalls()).toEqual([]);
  });

  shellTest('root and other systems are refused', () => {
    const h = harness(shell);
    const root = h.run(V1, { FAKE_UID: '0' });
    expect(root.status).not.toBe(0);
    expect(root.stderr).toContain('it was run as root');
    const linux = h.run(V1, { FAKE_UNAME_S: 'Linux' });
    expect(linux.status).not.toBe(0);
    expect(linux.stderr).toContain('this installer is for macOS.');
    expect(h.curlCalls()).toEqual([]);
  });

  shellTest('an `olympus` command the installer did not write, or a link in its place, is left alone', () => {
    const h = harness(shell);
    mkdirSync(join(h.home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(h.home, '.local', 'bin', 'olympus'), '#!/bin/sh\necho mine\n');
    const result = h.run(V1);
    expectSucceeded(result);
    expect(readFileSync(join(h.home, '.local', 'bin', 'olympus'), 'utf8')).toBe('#!/bin/sh\necho mine\n');
    expect(result.stdout).toContain('this installer did not write it');
    expect(result.stdout).toContain(`"${h.runtimeBun}" "${h.app}/dist/cli.js" engine status`);
    expect(existsSync(join(h.home, '.zprofile'))).toBe(false);

    const linked = harness(shell);
    const target = join(linked.root, 'someone-elses-olympus');
    writeFileSync(target, '#!/bin/sh\n# Written by the Olympus installer\n');
    mkdirSync(join(linked.home, '.local', 'bin'), { recursive: true });
    symlinkSync(target, join(linked.home, '.local', 'bin', 'olympus'));
    expectSucceeded(linked.run(V1));
    expect(lstatSync(join(linked.home, '.local', 'bin', 'olympus')).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('#!/bin/sh\n# Written by the Olympus installer\n');
  });

  shellTest('OLYMPUS_NO_MODIFY_PATH leaves shell profiles alone; ~/.local/bin already on PATH needs no line', () => {
    const h = harness(shell);
    expectSucceeded(h.run(V1, { OLYMPUS_NO_MODIFY_PATH: '1' }));
    expect(existsSync(join(h.home, '.zprofile'))).toBe(false);
    const onPath = harness(shell);
    const result = onPath.run(V1, { PATH: `${join(onPath.root, 'bin')}:${join(onPath.home, '.local', 'bin')}:/usr/bin:/bin:/usr/sbin:/sbin` });
    expectSucceeded(result);
    expect(existsSync(join(onPath.home, '.zprofile'))).toBe(false);
    expect(result.stdout).toContain('run: olympus engine status');
  });
});

describe('install.sh template', () => {
  test('the template refuses to run until a release is pinned into it', () => {
    const result = spawnSync('/bin/sh', [TEMPLATE], { encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('this is the installer template, not a release.');
  });

  test('pins Bun by version, archive SHA-256 and size, and program SHA-256, and takes no download location or checksum from the environment', () => {
    const text = readFileSync(TEMPLATE, 'utf8');
    expect(text).toMatch(/^BUN_VERSION=1\.3\.14$/m);
    expect(text).toMatch(/^BUN_SHA256_DARWIN_AARCH64=[0-9a-f]{64}$/m);
    expect(text).toMatch(/^BUN_BYTES_DARWIN_AARCH64=[0-9]+$/m);
    expect(text).toMatch(/^BUN_EXE_SHA256_DARWIN_AARCH64=[0-9a-f]{64}$/m);
    expect(text).toMatch(/^RELEASE_BASE=https:\/\/olympusplugin\.ai\/releases$/m);
    expect(text).toMatch(/^BUN_BASE=https:\/\/github\.com\/oven-sh\/bun\/releases\/download$/m);
    expect(text).not.toContain('SHASUMS256.txt"');
    expect(text).not.toContain('OLYMPUS_ARTIFACT_URL');
    expect(text).not.toContain('OLYMPUS_ARTIFACT_SHA256');
    expect(text).not.toMatch(/^\s*sudo\s/m);
    expect(text).not.toContain('DRAFT');
    expect(text).toContain("curl -fsSL --proto '=https' --tlsv1.2");
    // An installed Bun is checked by digest, never trusted by running it.
    expect(text).not.toContain('--version');
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

describe.each(SHELLS)('uninstall.sh under %s', (shell) => {
  const PATH_LINE = 'export PATH="$HOME/.local/bin:$PATH" # Added by the Olympus installer';

  shellTest('stops the engine, removes the app, runtime, command and PATH line, and keeps data', () => {
    const h = harness(shell);
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

  shellTest('PoC: removing the PATH line keeps every other byte of the profile and its permissions, and leaves no temporary file', () => {
    const h = harness(shell);
    const profile = join(h.home, '.zprofile');
    // A last line with no newline, a line that only mentions Olympus, and the installer's line in the middle.
    writeFileSync(profile, `export A=1\n# my Olympus notes\n${PATH_LINE}\nexport B=2`);
    chmodSync(profile, 0o640);
    const result = h.uninstall();
    expectSucceeded(result);
    expect(result.stdout).toContain(`Removed the Olympus PATH line from ${profile}.`);
    expect(readFileSync(profile, 'utf8')).toBe('export A=1\n# my Olympus notes\nexport B=2\n');
    expect(statSync(profile).mode & 0o777).toBe(0o640);
    expect(readdirSync(h.home).filter((name) => name.includes('olympus-uninstall'))).toEqual([]);

    // A profile holding only that line ends up empty, not deleted.
    writeFileSync(profile, `${PATH_LINE}\n`);
    expectSucceeded(h.uninstall());
    expect(readFileSync(profile, 'utf8')).toBe('');
  });

  shellTest('PoC: a symlinked profile is left alone, and the uninstaller says which line to remove', () => {
    const h = harness(shell);
    const target = join(h.root, 'dotfiles-zprofile');
    writeFileSync(target, `export A=1\n${PATH_LINE}\n`);
    symlinkSync(target, join(h.home, '.zprofile'));
    const result = h.uninstall();
    expectSucceeded(result);
    expect(result.stdout).toContain(`Left ${join(h.home, '.zprofile')} unchanged: it is a symbolic link.`);
    expect(result.stdout).toContain(`To finish, delete this line from it yourself: ${PATH_LINE}`);
    expect(readFileSync(target, 'utf8')).toBe(`export A=1\n${PATH_LINE}\n`);
    expect(lstatSync(join(h.home, '.zprofile')).isSymbolicLink()).toBe(true);
  });

  (UID === 0 ? test.skip : shellTest)('PoC: a profile that cannot be read is left alone, not emptied', () => {
    const h = harness(shell);
    const profile = join(h.home, '.bash_profile');
    writeFileSync(profile, `export A=1\n${PATH_LINE}\n`);
    chmodSync(profile, 0o000);
    const result = h.uninstall();
    expectSucceeded(result);
    expect(result.stdout).toContain(`Left ${profile} unchanged: it could not be read.`);
    chmodSync(profile, 0o600);
    expect(readFileSync(profile, 'utf8')).toBe(`export A=1\n${PATH_LINE}\n`);
  });

  shellTest('with the app already gone, unloads the login item, confirms launchd no longer has it, then removes it; a foreign command stays', () => {
    const h = harness(shell);
    const plist = join(h.home, 'Library', 'LaunchAgents', 'ai.olympusplugin.engine.plist');
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(plist, '<plist/>');
    mkdirSync(join(h.home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(h.home, '.local', 'bin', 'olympus'), '#!/bin/sh\necho mine\n');
    expectSucceeded(h.uninstall());
    expect(h.logLines()).toEqual([`launchctl bootout gui/${h.uid}/ai.olympusplugin.engine`, `launchctl print gui/${h.uid}/ai.olympusplugin.engine`]);
    expect(existsSync(plist)).toBe(false);
    expect(existsSync(join(h.home, '.local', 'bin', 'olympus'))).toBe(true);
  });

  shellTest('PoC: with the app gone, an agent launchd still has (or cannot report) stops the uninstall before anything is deleted', () => {
    for (const print of ['0', '5']) {
      const h = harness(shell);
      const plist = join(h.home, 'Library', 'LaunchAgents', 'ai.olympusplugin.engine.plist');
      mkdirSync(dirname(plist), { recursive: true });
      writeFileSync(plist, '<plist/>');
      mkdirSync(join(h.support, 'runtime'), { recursive: true });
      const result = h.uninstall({ FAKE_LAUNCHCTL_PRINT: print });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('Olympus could not be stopped, so nothing was removed.');
      expect(result.stderr).toContain(`(status ${print})`);
      expect(existsSync(plist)).toBe(true);
      expect(existsSync(h.support)).toBe(true);
    }
  }, 30_000);

  shellTest('an engine that cannot be stopped leaves everything in place', () => {
    const h = harness(shell);
    expectSucceeded(h.run(V1));
    writeFileSync(join(h.app, 'dist', 'cli.js'), 'exit 1\n');
    const result = h.uninstall();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Olympus could not be stopped, so nothing was removed.');
    expect(existsSync(h.app)).toBe(true);
    expect(existsSync(join(h.home, '.local', 'bin', 'olympus'))).toBe(true);
  });

  shellTest('refuses root', () => {
    const h = harness(shell);
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
      writeFileSync(script, renderForTest({ version, tarball, releaseBase: `${origin}/releases`, bunBase: `${origin}/bun`, bunZip, bunExe: process.execPath }));
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

    // An upgrade to V3 cut short by an older installer after its swap, with no
    // swap marker: app/ holds V3 (and its receipt), the agent still names V2.
    // Running V3 again finds V3 installed, but the real `engine verify`,
    // given the verified download, does not accept the V2 agent: the
    // installer restarts the engine onto V3 instead of reporting success.
    const v3 = release(V3);
    const v3Tarball = join(served, 'releases', V3, `olympus-${V3}.tgz`);
    rmSync(`${app}.previous`, { recursive: true });
    renameSync(app, `${app}.previous`);
    unpackInto(v3Tarball, app);
    expect(readFileSync(plistPath, 'utf8')).toContain(`<string>${V2}+`);
    const reconciled = await sh([v3]);
    expectSucceeded(reconciled, installLog());
    expect(reconciled.stdout).toContain(`Olympus ${V3} is already installed.`);
    expect(reconciled.stdout).toContain('Starting Olympus in the background');
    expect(installLog()).toContain(`The installed engine agent runs build ${V2}+`);
    expect(readFileSync(plistPath, 'utf8')).toContain(`<string>${V3}+`);
    expect(appVersion(`${app}.previous`)).toBe(V2);

    // A failed upgrade puts V3 back and proves it running.
    const fourth = await sh([release(V4)], { FAKE_LAUNCHD_FAIL_VERSION: V4 });
    expect(fourth.status).not.toBe(0);
    expect(fourth.stderr).toContain('the previous version was restored and is running');
    expect(appVersion(app)).toBe(V3);
    expect(readFileSync(plistPath, 'utf8')).toContain(`<string>${V3}+`);
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
