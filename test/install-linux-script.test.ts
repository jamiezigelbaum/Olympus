/** Shell boundary proof; fake lifecycle commands are NOT systemd/durability proof. */
import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { uninstallEngine } from '../src/core/engine-service.ts';
import { linuxMachineArtifactDigest } from '../src/core/linux-engine-service.ts';

const REPO = resolve(import.meta.dir, '..');
const roots: string[] = [];
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const text = (p: string) => readFileSync(p, 'utf8');
const executable = (p: string, s: string) => writeFileSync(p, s, { mode: 0o755 });
const shells = ['/bin/sh', '/bin/dash'];
const TEST_UID = process.getuid?.() ?? 1000;
const FOREIGN_UID = TEST_UID === 999 ? 998 : 999;
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function treeSha(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const relative = full.slice(root.length + 1).split('/').join('/');
      const info = lstatSync(full);
      const mode = (info.mode & 0o7777).toString(8);
      const [kind, payload] = info.isDirectory() ? ['directory', Buffer.alloc(0)] : info.isSymbolicLink() ? ['symlink', Buffer.from(readlinkSync(full))] : ['file', readFileSync(full)];
      hash.update(`${kind}\0${relative}\0${mode}\0`);
      if (kind === 'directory') walk(full);
      else {
        hash.update(`${payload.length}\0`);
        hash.update(payload);
      }
    }
  };
  walk(root);
  return hash.digest('hex');
}

function fixture(shell = '/bin/sh', archiveKind = 'normal') {
  const root = mkdtempSync(join(tmpdir(), 'olympus-linux-shell-'));
  roots.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const runtime = join(root, 'run');
  for (const p of [home, bin, runtime]) mkdirSync(p, { mode: 0o700 });
  const log = join(root, 'calls');
  const bunProgram = `#!/bin/sh
[ "$1" != --no-env-file ] || shift
if [ "$1" = --version ]; then echo "\${FAKE_BUN_VERSION:-1.3.14}"; exit 0; fi
if [ "$1" = -e ]; then exec '${process.execPath}' --no-env-file "$@"; fi
exec /bin/sh "$@"
`;
  const zipStage = join(root, 'zip', 'bun-linux-x64-baseline');
  mkdirSync(zipStage, { recursive: true });
  executable(join(zipStage, 'bun'), bunProgram);
  const zip = join(root, 'bun.zip');
  expect(spawnSync('python3', ['-m', 'zipfile', '-c', zip, 'bun-linux-x64-baseline'], { cwd: dirname(zipStage) }).status).toBe(0);
  const packageDir = join(root, 'release', 'package');
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'olympus', version: '1.0.0-rc.7' }));
  const cli = `echo "$*" >> '${log}'
if [ "$2" = install ]; then
  case "$*" in *--dry-run*) [ -z "$FAKE_PREFLIGHT_FAIL" ] || exit 1; exit 0 ;; esac
  if flock -n "$XDG_RUNTIME_DIR/olympus/lifecycle.lock" true; then echo lock-missing >> '${log}'; exit 9; fi
  [ -z "$FAKE_LOGIND_FAIL" ] || { echo 'systemd-logind is unavailable.' >&2; exit 1; }
  [ -z "$FAKE_LINGER_DENY" ] || { echo 'persistent-service permission was denied by lifecycle.' >&2; exit 1; }
  [ -z "$FAKE_INSTALL_FAIL" ] || { echo 'Upgrade failed; previous version restored and healthy.' >&2; exit 1; }
  [ -z "$FAKE_BLOCK" ] || { echo blocked >> '${log}'; while [ ! -f '${root}/release-child' ]; do sleep 0.05; done; }
fi
if [ "$2" = status ]; then printf '{"ok":%s}\n' "\${FAKE_HEALTH:-true}"; fi
if [ "$2" = uninstall ]; then
  [ -z "$FAKE_UNINSTALL_FAIL" ] || { echo 'Unknown custody; nothing removed.' >&2; exit 1; }
fi
`;
  writeFileSync(join(packageDir, 'dist', 'cli.js'), cli);
  if (archiveKind === 'link') symlinkSync('/tmp/outside', join(packageDir, 'escape'));
  const tar = join(root, 'release.tgz');
  const tarArgs = ['-czf', tar, '-C', join(root, 'release'), 'package'];
  if (archiveKind === 'traversal') tarArgs.splice(2, 0, '--transform=s|package|../escape|');
  expect(spawnSync('tar', tarArgs).status).toBe(0);
  executable(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Linux ;; -m) echo "${FAKE_ARCH:-x86_64}" ;; *) exec /usr/bin/uname "$@" ;; esac\n');
  executable(join(bin, 'id'), `#!/bin/sh\ncase "$1" in -u) echo "\${FAKE_UID:-${TEST_UID}}" ;; -un) echo "\${FAKE_ACCOUNT:-tester}" ;; *) exec /usr/bin/id "$@" ;; esac\n`);
  executable(join(bin, 'stat'), `#!/bin/sh
if [ "$2" = %u ]; then
 case "$3" in '${root}'*) echo "\${FAKE_OWNER:-${TEST_UID}}"; exit 0 ;; esac
fi
exec /usr/bin/stat "$@"
`);
  executable(join(bin, 'systemctl'), `#!/bin/sh
if [ "$1" = --version ]; then echo "systemd \${FAKE_SYSTEMD:-256}"; exit 0; fi
[ -z "$FAKE_BUS_FAIL" ] || exit 1
case "$*" in
 *'--user daemon-reload'*)
   if [ -n "$FAKE_UNINSTALL_BLOCK" ]; then
     touch '${root}/uninstall-blocked'
     while [ ! -f '${root}/release-uninstall' ]; do sleep 0.05; done
   fi
   ;;
 *'--user show olympus-engine.service'*)
   if [ -n "$FAKE_UNINSTALL_FAIL" ]; then
     printf 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\nMainPID=42\nControlGroup=\nFragmentPath=%s\n' "\${FAKE_FRAGMENT:-${home}/.config/systemd/user/olympus-engine.service}"
   else
     printf 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\nMainPID=0\nControlGroup=\nFragmentPath=%s\n' "\${FAKE_FRAGMENT:-${home}/.config/systemd/user/olympus-engine.service}"
   fi
   ;;
esac
`);
  executable(join(bin, 'systemd-analyze'), '#!/bin/sh\nexit 0\n');
  executable(join(bin, 'awk'), '#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = /proc/cpuinfo ] && [ -n "$FAKE_CPU_FAIL" ]; then exit 1; fi; done\nexec /usr/bin/awk "$@"\n');
  executable(join(bin, 'getconf'), '#!/bin/sh\necho "glibc ${FAKE_GLIBC:-2.36}"\n');
  executable(join(bin, 'loginctl'), `#!/bin/sh
[ -z "$FAKE_LOGIND_FAIL" ] || exit 1
case "$1" in
 show-user) if [ -f '${root}/linger-off' ]; then echo no; elif [ -f '${root}/linger' ]; then echo yes; else echo "\${FAKE_LINGER:-yes}"; fi ;;
 --no-ask-password)
   if [ "$2" = disable-linger ]; then rm -f '${root}/linger'; touch '${root}/linger-off'; exit 0; fi
   echo "enable-linger $*" >> '${log}'; [ -z "$FAKE_LINGER_DENY" ] || exit 1; touch '${root}/linger'
   ;;
 *) exit 2 ;;
esac
`);
  executable(join(bin, 'curl'), `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; --proto|--retry) shift 2 ;; -*) shift ;; *) url=$1; shift ;; esac; done
case "$url" in
 *bun-linux-x64-baseline.zip) [ -z "$FAKE_ARCHIVE_CORRUPT" ] || { echo corrupt > "$out"; exit 0; }; cp '${zip}' "$out" ;;
 *) cp '${tar}' "$out" ;;
esac
`);
  const template = text(join(REPO, 'scripts/install-linux.sh'));
  const pins: Record<string, string> = {
    OLYMPUS_VERSION: '1.0.0-rc.7', OLYMPUS_SHA256: sha(readFileSync(tar)), OLYMPUS_BYTES: String(readFileSync(tar).length),
    BUN_VERSION: '1.3.14', BUN_URL: 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64-baseline.zip',
    BUN_ENTRY: 'bun-linux-x64-baseline/bun', BUN_BYTES: String(readFileSync(zip).length), BUN_SHA256: sha(readFileSync(zip)),
    BUN_EXE_SHA256: sha(bunProgram), BUN_GLIBC_MIN: '2.17',
  };
  const script = join(root, 'install.sh');
  writeFileSync(script, template.replace(/@([A-Z0-9_]+)@/g, (all, key) => pins[key] ?? all));
  const env = (extra: Record<string, string> = {}) => ({ PATH: `${bin}:/usr/bin:/bin`, HOME: home, XDG_RUNTIME_DIR: runtime, ...extra });
  const run = (extra: Record<string, string> = {}, args: string[] = []) => spawnSync(shell, [script, ...args], { env: env(extra), encoding: 'utf8', timeout: 15_000 });
  const calls = () => existsSync(log) ? text(log) : '';
  const uninstall = (extra: Record<string, string> = {}, args: string[] = []) => spawnSync(shell, [join(REPO, 'site/uninstall-linux.sh'), ...args], { env: env(extra), encoding: 'utf8', timeout: 15_000 });
  const receipt = (dataLayout: 'legacy' | 'xdg' = 'legacy') => {
    const engine = join(home, dataLayout === 'xdg' ? '.local/share/olympus-engine' : '.local/share/olympus/engine');
    const generation = join(engine, 'generations', 'a'.repeat(64));
    const bun = join(generation, 'runtime/bun');
    const installedCli = join(generation, 'app/dist/cli.js');
    const configDir = join(home, '.config/olympus');
    const stateDir = join(home, '.local/state/olympus/engine');
    const cacheDir = join(home, '.cache/olympus/engine');
    const dataDir = join(home, dataLayout === 'xdg' ? '.local/share/olympus' : '.local/share/openclaw/olympus');
    const unitPath = join(home, '.config/systemd/user/olympus-engine.service');
    const launcherPath = join(home, '.local/bin/olympus');
    for (const p of [dirname(bun), dirname(installedCli), configDir, stateDir, cacheDir, dataDir, dirname(unitPath), dirname(launcherPath), join(runtime, 'olympus')]) mkdirSync(p, { recursive: true, mode: 0o700 });
    executable(bun, bunProgram);
    writeFileSync(installedCli, cli);
    const markerPath = join(generation, '.olympus-generation.json');
    writeFileSync(markerPath, '{"schema":"olympus.engine.generation.v1","token":"fixture"}\n', { mode: 0o600 });
    writeFileSync(unitPath, 'unit', { mode: 0o600 });
    executable(launcherPath, '#!/bin/sh\nexit 0\n');
    writeFileSync(join(runtime, 'olympus/lifecycle.lock'), '', { mode: 0o600 });
    const receiptPath = join(configDir, 'install-receipt.json');
    const layout = {
      home, configHome: join(home, '.config'), dataHome: join(home, '.local/share'), stateHome: join(home, '.local/state'), cacheHome: join(home, '.cache'), runtimeHome: runtime,
      configDir, dataDir, stateDir, cacheDir, runtimeDir: join(runtime, 'olympus'), packageDir: engine, launcherPath, unitPath,
      openHandlerPath: join(home, '.local/share/applications/ai.olympusplugin.open.desktop'), mimeappsPath: join(home, '.config/mimeapps.list'),
      configPath: join(configDir, 'engine.json'), sovereigntyPath: join(configDir, 'sovereignty.json'), workerEnvPath: join(configDir, 'worker.env'),
      workerSocketPath: join(runtime, 'olympus/worker.sock'), receiptPath, lifecycleLockPath: join(runtime, 'olympus/lifecycle.lock'),
      secretsPath: join(configDir, 'secrets.enc'), secretsKeyPath: join(configDir, 'secrets.key'),
    };
    const data = { schema: 'olympus.engine.install.v1', installationState: 'installed', uid: TEST_UID, layout, ownedUnitLinks: [], lingerPredated: false,
      rotation: { mechanism: 'host-copytruncate', maxBytes: 10, retained: 3 },
      machineArtifacts: [
        { path: generation, kind: 'tree', sha256: treeSha(generation), rootDevice: lstatSync(generation).dev, rootInode: lstatSync(generation).ino, markerPath, markerSha256: sha(readFileSync(markerPath)) },
        { path: unitPath, kind: 'file', sha256: sha(readFileSync(unitPath)) },
        { path: launcherPath, kind: 'file', sha256: sha(readFileSync(launcherPath)) },
      ],
    };
    writeFileSync(receiptPath, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    return { path: receiptPath, bun, cli: installedCli, engine, generation, markerPath, unitPath, launcherPath, configDir, dataDir, stateDir, cacheDir };
  };
  return { root, home, runtime, bin, script, run, calls, uninstall, receipt, env, shell, tar, zip };
}

for (const changed of ['launcher', 'open handler', 'generation'] as const) {
 test(`partial then full uninstall preserves a user-modified ${changed}`, () => {
  const h = fixture(), installed = h.receipt();
  const receipt = JSON.parse(text(installed.path));
  // The TypeScript reader requires the generation's content-addressed name.
  const tree = receipt.machineArtifacts.find((entry: any) => entry.kind === 'tree');
  const generation = join(dirname(tree.path), tree.sha256);
  renameSync(tree.path, generation);
  tree.path = generation; tree.markerPath = join(generation, '.olympus-generation.json');
  const handler = receipt.layout.openHandlerPath;
  mkdirSync(dirname(handler), {recursive: true, mode: 0o700});
  writeFileSync(handler, 'original handler', {mode: 0o600});
  receipt.machineArtifacts.push({path: handler, kind: 'file', sha256: sha(text(handler))});
  writeFileSync(installed.path, JSON.stringify(receipt));
  const changedPath = changed === 'launcher' ? installed.launcherPath : changed === 'open handler' ? handler : tree.markerPath;
  writeFileSync(changedPath, 'user replacement');
  const result = uninstallEngine({platform: 'linux', homeDir: h.home, env: h.env(),
   exec: (command, args) => {
    const r = spawnSync(command, args, {env: h.env(), encoding: 'utf8'});
    return {status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? ''};
   }, consultInFlight: () => undefined, cgroupEmpty: () => true, workerStopped: () => true});
  expect(result.removed_plist).toBe(true);
  const after = JSON.parse(text(installed.path));
  const full = h.uninstall();
  expect(text(changedPath)).toBe('user replacement');
  expect(full.status).not.toBe(0);
  expect(after.machineArtifacts).toEqual(receipt.machineArtifacts.filter((entry: any) => entry.path !== installed.unitPath));
 }, 30_000);
}

for (const shell of shells) {
  test(`${shell}: verified bootstrap calls the CLI under flock and checks status`, () => {
    const h = fixture(shell);
    const r = h.run();
    expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
    expect(h.calls()).toContain('engine install --from-checkout');
    expect(h.calls()).not.toContain('linger-before=');
    expect(h.calls()).toContain('engine status');
    expect(h.calls()).not.toContain('lock-missing');
    expect(r.stdout).toContain('Installed for your user');
    expect(r.stdout).toContain('By installing Olympus you agree to its Terms (https://olympusplugin.ai/terms/)\nand acknowledge its Privacy Policy (https://olympusplugin.ai/privacy/).\nOlympus is provided as is, without warranty. Keep your own backups.');
    expect(r.stdout.indexOf('By installing Olympus you agree')).toBeLessThan(r.stdout.indexOf('Installed for your user'));
  }, 30_000);
  test(`${shell}: truncated pipe and unfilled template execute nothing`, () => {
    const h = fixture(shell);
    const template = text(join(REPO, 'scripts/install-linux.sh'));
    for (const input of [template, text(h.script).replace(/main "\$@"\s*$/, '')]) {
      const r = spawnSync(shell, [], { input, env: h.env(), encoding: 'utf8' });
      expect(h.calls()).toBe('');
      expect(r.stdout).not.toContain('Installed for your user');
    }
  }, 30_000);
  test(`${shell}: default OS-only uninstall removes receipt-owned machinery and keeps data`, () => {
    const h = fixture(shell);
    const receipt = h.receipt();
    const data = join(h.home, '.config/olympus/personal');
    writeFileSync(data, 'keep me');
    const r = h.uninstall();
    expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
    expect(h.calls()).toBe('');
    expect(text(data)).toBe('keep me');
    expect(r.stdout).toContain('Data, settings, secrets, models and logs were kept');
    expect(r.stdout).toContain('Linger was preserved');
    expect(existsSync(receipt.engine)).toBe(false);
    expect(existsSync(receipt.unitPath)).toBe(false);
    expect(existsSync(receipt.launcherPath)).toBe(false);
    expect(JSON.parse(text(receipt.path))).toMatchObject({ installationState: 'data_retained', machineArtifacts: [], ownedUnitLinks: [] });
    expect(existsSync(join(h.runtime, 'olympus/lifecycle.lock'))).toBe(true);
  }, 30_000);
}

test('local pinned tarball and Bun archive install without curl', () => {
  const h = fixture();
  rmSync(join(h.bin, 'curl'));
  const r = h.run({}, ['--tarball', h.tar, '--bun-archive', h.zip]);
  expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
  expect(h.calls()).toContain('engine status');
}, 30_000);

test('local archive options still enforce pins and reject unsafe paths', () => {
  const h = fixture();
  const tampered = join(h.root, 'tampered.tgz');
  writeFileSync(tampered, 'wrong');
  expect(h.run({}, ['--tarball', tampered, '--bun-archive', h.zip]).stderr).toContain('Release checksum/size mismatch');
  expect(h.run({}, ['--tarball', 'relative.tgz']).stderr).toContain('must be absolute');
  expect(h.calls()).toBe('');
}, 30_000);

test('Bun-free uninstaller tree digest matches lifecycle recursive ordering', () => {
  const root = mkdtempSync(join(tmpdir(), 'olympus-linux-digest-'));
  roots.push(root);
  mkdirSync(join(root, 'a'));
  writeFileSync(join(root, 'a', 'x'), 'nested');
  writeFileSync(join(root, 'a.txt'), 'sibling');
  expect(treeSha(root)).toBe(linuxMachineArtifactDigest(root, 'tree'));
});

test('Mac installer and uninstaller stay byte-for-byte unchanged', () => {
  expect(sha(readFileSync(join(REPO, 'scripts/install-macos.sh')))).toBe('c34567e08d83ca09b88a2bd3453bd0368730800ea1794553879eac17741021bb');
  expect(sha(readFileSync(join(REPO, 'site/uninstall.sh')))).toBe('074c2fd5d249ce413a900b57ceb0d0e1f6a19b2c17f4157674a9bc5f1a9bc7b8');
});

for (const [env, message] of [
  [{ FAKE_ARCH: 'aarch64' }, 'arm64 is unavailable'],
  [{ FAKE_UID: '0' }, 'without sudo'],
  [{ FAKE_GLIBC: '2.16' }, 'glibc 2.17'],
  [{ FAKE_CPU_FAIL: '1' }, 'requires SSE4.2'],
  [{ FAKE_SYSTEMD: '253' }, 'systemd 254'],
  [{ FAKE_BUS_FAIL: '1' }, 'working systemd user bus'],
  [{ FAKE_LOGIND_FAIL: '1' }, 'logind is unavailable'],
  [{ XDG_DATA_HOME: 'relative' }, 'absolute path'],
  [{ FAKE_ARCHIVE_CORRUPT: '1' }, 'Bun archive checksum/size mismatch'],
] as Array<[Record<string, string>, string]>) {
  test(`preflight fault refuses before lifecycle: ${message}`, () => {
    const h = fixture();
    const r = h.run(env);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(message);
    if ('FAKE_LOGIND_FAIL' in env) expect(h.calls()).toContain('--restart');
    else expect(h.calls()).toBe('');
  }, 30_000);
}

test('missing tool refusal lists both distro remedies before mutation', () => {
  const h = fixture();
  // Minimal PATH makes the absent tools real, not a fake successful preflight.
  const r = h.run({ PATH: h.bin });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('Missing required tools:');
  expect(r.stderr).toContain('sudo pacman -S --needed');
  expect(r.stderr).toContain('sudo apt install');
  expect(h.calls()).toBe('');
}, 30_000);

test('lifecycle-owned linger denial propagates and never reports installation', () => {
  const h = fixture();
  const r = h.run({ FAKE_LINGER: 'no', FAKE_LINGER_DENY: '1' });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('persistent-service permission was denied by lifecycle');
  expect(r.stderr).toContain('engine CLI\'s recovery report above is authoritative');
  expect(h.calls()).toContain('--restart');
  expect(h.calls()).not.toContain('engine status');
  expect(r.stdout).not.toContain('Installed for your user');
}, 30_000);

test('CLI preflight refusal leaves linger and existing installation untouched', () => {
  const h = fixture();
  const r = h.run({ FAKE_PREFLIGHT_FAIL: '1', FAKE_LINGER: 'no' });
  expect(r.status).not.toBe(0);
  expect(h.calls()).not.toContain('enable-linger');
  expect(h.calls()).not.toContain('--restart');
}, 30_000);

test('bootstrap never passes ambient linger provenance to lifecycle', () => {
  const h = fixture();
  expect(h.run({ FAKE_LINGER: 'no' }).status).toBe(0);
  expect(h.calls()).not.toContain('linger-before=');
  expect(text(h.script)).not.toContain('OLYMPUS_LINGER_BEFORE');
}, 30_000);

for (const kind of ['link', 'traversal']) {
  test(`valid checksum cannot authorize unsafe archive ${kind}`, () => {
    const h = fixture('/bin/sh', kind);
    const r = h.run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/archive path|special files/);
    expect(h.calls()).toBe('');
  }, 30_000);
}

test('missing pin and tampered release refuse before execution', () => {
  for (const replacement of ['BUN_SHA256=', `OLYMPUS_SHA256=${'0'.repeat(64)}`]) {
    const h = fixture();
    const key = replacement.split('=')[0];
    writeFileSync(h.script, text(h.script).replace(new RegExp(`^${key}=.*$`, 'm'), replacement));
    const r = h.run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/pin|checksum/);
    expect(h.calls()).toBe('');
  }
}, 30_000);

test('tampered extracted Bun is not executed, even with an intact archive', () => {
  const h = fixture();
  writeFileSync(h.script, text(h.script).replace(/^BUN_EXE_SHA256=.*$/m, `BUN_EXE_SHA256=${'0'.repeat(64)}`));
  const r = h.run();
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('Bun executable checksum mismatch');
  expect(h.calls()).toBe('');
}, 30_000);

test('unknown health and failed install never report success', () => {
  for (const env of [{ FAKE_HEALTH: 'false' }, { FAKE_INSTALL_FAIL: '1' }]) {
    const h = fixture();
    const r = h.run(env as Record<string, string>);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('Installed for your user');
    if ('FAKE_INSTALL_FAIL' in env) expect(r.stderr).toContain('previous version restored and healthy');
    else expect(r.stderr).toContain('unhealthy or unknown');
  }
// Two complete archive/bootstrap fixtures exceed Bun's 5s test default on
// emulated runners; production command deadlines remain unchanged.
}, 20_000);

test('unsafe runtime path refuses without following a symlink', () => {
  const h = fixture();
  symlinkSync(h.home, join(h.runtime, 'olympus'));
  expect(h.run().stderr).toContain('Symbolic link refused');
  expect(h.calls()).toBe('');
}, 30_000);

for (const fault of ['duplicate', 'foreign', 'generation', 'marker', 'purge', 'custody', 'fragment']) {
  test(`uninstall fault ${fault} preserves personal data and refuses success`, () => {
    const h = fixture();
    const receipt = h.receipt();
    const personal = join(h.home, '.config/olympus/personal');
    writeFileSync(personal, 'untouched');
    if (fault === 'duplicate') writeFileSync(receipt.path, text(receipt.path).replace(`"uid":${TEST_UID}`, `"uid":${TEST_UID},"uid":${TEST_UID}`));
    // Retain the old inode so Linux cannot reuse it for the replacement.
    if (fault === 'generation') { renameSync(receipt.generation, join(h.root, 'displaced-generation')); mkdirSync(receipt.generation, { recursive: true, mode: 0o700 }); writeFileSync(receipt.markerPath, '{"schema":"olympus.engine.generation.v1","token":"fixture"}\n', { mode: 0o600 }); }
    if (fault === 'marker') writeFileSync(receipt.markerPath, 'replaced');
    const r = h.uninstall(fault === 'foreign' ? { FAKE_OWNER: String(FOREIGN_UID) } : fault === 'custody' ? { FAKE_UNINSTALL_FAIL: '1' } : fault === 'fragment' ? { FAKE_FRAGMENT: join(h.home, 'foreign.service') } : {}, fault === 'purge' ? ['--purge'] : []);
    if (fault === 'generation') expect(r.stderr).toContain('generation root was replaced and retained');
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('machinery was removed');
    expect(text(personal)).toBe('untouched');
    if (fault !== 'custody' && fault !== 'fragment') expect(h.calls()).toBe('');
    if (fault === 'custody') expect(r.stderr).toContain('active engine cgroup is unknown');
    if (fault === 'fragment') expect(r.stderr).toContain('not receipt-owned');
  }, 30_000);
}

for (const damage of ['missing-bun', 'corrupt-cli', 'symlink-cli']) {
  test(`Bun-free removal completes with ${damage}`, () => {
    const h = fixture();
    const receipt = h.receipt();
    if (damage === 'missing-bun') rmSync(receipt.bun);
    if (damage === 'corrupt-cli') writeFileSync(receipt.cli, 'corrupt');
    if (damage === 'symlink-cli') { rmSync(receipt.cli); symlinkSync(join(h.home, 'nowhere'), receipt.cli); }
    const r = h.uninstall();
    expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
    expect(existsSync(receipt.generation)).toBe(false);
  }, 30_000);
}

test('explicit purge removes only Olympus roots and restores receipt-proven linger by choice', () => {
  const h = fixture();
  const receipt = h.receipt();
  const unrelated = join(h.home, '.local/share/unrelated');
  writeFileSync(unrelated, 'keep');
  for (const root of [receipt.configDir, receipt.dataDir, receipt.stateDir, receipt.cacheDir]) writeFileSync(join(root, 'personal'), 'remove');
  const r = h.uninstall({}, ['--purge', '--yes', '--restore-linger']);
  expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
  expect(r.stdout).toContain('data, settings, secrets, models, logs, caches and recovery state were removed');
  expect(r.stdout).toContain('pre-install linger state was restored');
  for (const root of [receipt.configDir, receipt.dataDir, receipt.stateDir, receipt.cacheDir]) expect(existsSync(root)).toBe(false);
  expect(text(unrelated)).toBe('keep');
}, 30_000);

test('full purge refuses explicit libsecret without claiming keyring deletion', () => {
  const h = fixture();
  const receipt = h.receipt();
  writeFileSync(join(receipt.configDir, 'secret-backend.json'), '{"version":1,"backend":"libsecret"}\n', { mode: 0o600 });
  const r = h.uninstall({}, ['--purge', '--yes']);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('delete Olympus items individually');
  expect(r.stderr).toContain('never delete the whole keyring');
  expect(existsSync(receipt.path)).toBe(true);
  expect(existsSync(receipt.generation)).toBe(true);
}, 30_000);

test('pending crash-safe open handler intent removes only marked desktop and Olympus MIME value', () => {
  const h = fixture();
  const receipt = h.receipt();
  const parsed = JSON.parse(text(receipt.path));
  parsed.openHandlerPending = true;
  writeFileSync(receipt.path, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  mkdirSync(dirname(parsed.layout.openHandlerPath), { recursive: true, mode: 0o700 });
  writeFileSync(parsed.layout.openHandlerPath, '# Written by olympus open-handler install\n', { mode: 0o600 });
  writeFileSync(parsed.layout.mimeappsPath, '[Default Applications]\nx-scheme-handler/olympus=ai.olympusplugin.open.desktop;other.desktop;\nx-scheme-handler/other=keep.desktop;\n', { mode: 0o600 });
  const r = h.uninstall();
  expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
  expect(existsSync(parsed.layout.openHandlerPath)).toBe(false);
  expect(text(parsed.layout.mimeappsPath)).toContain('x-scheme-handler/olympus=other.desktop;');
  expect(text(parsed.layout.mimeappsPath)).toContain('x-scheme-handler/other=keep.desktop;');
  expect(JSON.parse(text(receipt.path))).toMatchObject({ installationState: 'data_retained', openHandlerPending: false });
}, 30_000);

test('pending open handler recovers a receipt-bound tombstone after shell interruption', () => {
  const h = fixture();
  const receipt = h.receipt();
  const parsed = JSON.parse(text(receipt.path));
  parsed.openHandlerPending = true;
  writeFileSync(receipt.path, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  mkdirSync(dirname(parsed.layout.openHandlerPath), { recursive: true, mode: 0o700 });
  writeFileSync(parsed.layout.openHandlerPath, '# Written by olympus open-handler install\n', { mode: 0o600 });
  const digest = sha(readFileSync(parsed.layout.openHandlerPath));
  const identity = lstatSync(parsed.layout.openHandlerPath);
  const tombstone = join(dirname(parsed.layout.openHandlerPath), `.olympus-remove-${basename(parsed.layout.openHandlerPath)}-${digest.slice(0, 16)}`);
  const journal = `${tombstone}.journal.json`;
  renameSync(parsed.layout.openHandlerPath, tombstone);
  writeFileSync(journal, `${JSON.stringify({ schema: 'olympus.engine.remove-artifact.v1', path: parsed.layout.openHandlerPath, tombstone, kind: 'file', sha256: digest, dev: identity.dev, ino: identity.ino })}\n`, { mode: 0o600 });
  const r = h.uninstall();
  expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
  expect(existsSync(tombstone)).toBe(false);
  expect(existsSync(journal)).toBe(false);
  expect(JSON.parse(text(receipt.path))).toMatchObject({ installationState: 'data_retained', openHandlerPending: false });
}, 30_000);

test('pending open handler reuses an existing receipt artifact during tombstone replay', () => {
  const h = fixture();
  const receipt = h.receipt();
  const parsed = JSON.parse(text(receipt.path));
  parsed.openHandlerPending = true;
  mkdirSync(dirname(parsed.layout.openHandlerPath), { recursive: true, mode: 0o700 });
  writeFileSync(parsed.layout.openHandlerPath, '# Written by olympus open-handler install\n', { mode: 0o600 });
  const digest = sha(readFileSync(parsed.layout.openHandlerPath));
  parsed.machineArtifacts.push({ path: parsed.layout.openHandlerPath, kind: 'file', sha256: digest });
  writeFileSync(receipt.path, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  const identity = lstatSync(parsed.layout.openHandlerPath);
  const tombstone = join(dirname(parsed.layout.openHandlerPath), `.olympus-remove-${basename(parsed.layout.openHandlerPath)}-${digest.slice(0, 16)}`);
  const journal = `${tombstone}.journal.json`;
  renameSync(parsed.layout.openHandlerPath, tombstone);
  writeFileSync(journal, `${JSON.stringify({ schema: 'olympus.engine.remove-artifact.v1', path: parsed.layout.openHandlerPath, tombstone, kind: 'file', sha256: digest, dev: identity.dev, ino: identity.ino })}\n`, { mode: 0o600 });
  const r = h.uninstall();
  expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
  expect(existsSync(tombstone)).toBe(false);
  expect(existsSync(journal)).toBe(false);
  expect(JSON.parse(text(receipt.path))).toMatchObject({ installationState: 'data_retained', machineArtifacts: [], openHandlerPending: false });
}, 30_000);

test('interrupted purge resumes from inode-bound tombstone while receipt stays reachable', () => {
  const h = fixture();
  const receipt = h.receipt();
  const nested = join(receipt.dataDir, 'nested');
  mkdirSync(nested);
  writeFileSync(join(nested, 'partial'), 'data');
  const identity = lstatSync(receipt.dataDir);
  const tombstone = join(dirname(receipt.dataDir), '.olympus-purge-olympus');
  const journal = `${tombstone}.journal.json`;
  renameSync(receipt.dataDir, tombstone);
  rmSync(join(tombstone, 'nested/partial'));
  writeFileSync(journal, `${JSON.stringify({ schema: 'olympus.engine.purge-root.v1', path: receipt.dataDir, tombstone, dev: identity.dev, ino: identity.ino })}\n`, { mode: 0o600 });
  const r = h.uninstall({}, ['--purge', '--yes']);
  expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
  expect(existsSync(tombstone)).toBe(false);
  expect(existsSync(journal)).toBe(false);
  expect(existsSync(receipt.path)).toBe(false);
}, 30_000);

test('interrupted generation deletion resumes after partial tombstone cleanup', () => {
  const h = fixture();
  const receipt = h.receipt();
  const artifact = JSON.parse(text(receipt.path)).machineArtifacts.find((entry: { kind: string }) => entry.kind === 'tree');
  const tombstone = join(dirname(receipt.generation), `.olympus-remove-${basename(receipt.generation)}-${artifact.sha256.slice(0, 16)}`);
  const journal = `${tombstone}.journal.json`;
  renameSync(receipt.generation, tombstone);
  rmSync(join(tombstone, 'runtime/bun'));
  writeFileSync(journal, `${JSON.stringify({ schema: 'olympus.engine.remove-artifact.v1', path: receipt.generation, tombstone, kind: 'tree', sha256: artifact.sha256, dev: artifact.rootDevice, ino: artifact.rootInode })}\n`, { mode: 0o600 });
  const r = h.uninstall();
  expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
  expect(existsSync(tombstone)).toBe(false);
  expect(existsSync(journal)).toBe(false);
}, 30_000);

test('uninstaller help is available without an install or live session', () => {
  const r = spawnSync('/bin/sh', [join(REPO, 'site/uninstall-linux.sh'), '--help'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('--purge --yes');
}, 30_000);

test('keep-data removal is repeatable and retained receipt authorizes later purge', () => {
  const h = fixture();
  const receipt = h.receipt();
  writeFileSync(join(receipt.dataDir, 'retained'), 'personal');
  expect(h.uninstall().status).toBe(0);
  expect(h.uninstall().status).toBe(0);
  expect(h.uninstall({}, ['--purge', '--yes']).status).toBe(0);
  expect(existsSync(receipt.path)).toBe(false);
  expect(existsSync(receipt.dataDir)).toBe(false);
}, 30_000);

test('failed-first recovery receipt supports Bun-free cleanup with no machine claims', () => {
  const h = fixture();
  const receipt = h.receipt();
  const parsed = JSON.parse(text(receipt.path));
  parsed.installationState = 'recovery_pending';
  parsed.machineArtifacts = [];
  parsed.ownedUnitLinks = [];
  parsed.openHandlerPending = false;
  delete parsed.mimeOwnership;
  writeFileSync(receipt.path, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  rmSync(receipt.generation, { recursive: true });
  rmSync(receipt.unitPath);
  rmSync(receipt.launcherPath);
  writeFileSync(join(receipt.configDir, 'failed-first-setting'), 'keep');
  const r = h.uninstall();
  expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
  expect(text(join(receipt.configDir, 'failed-first-setting'))).toBe('keep');
  expect(JSON.parse(text(receipt.path))).toMatchObject({ installationState: 'data_retained', machineArtifacts: [], ownedUnitLinks: [] });
}, 30_000);

test('later purge recreates a missing private Olympus runtime directory after reboot', () => {
  const h = fixture();
  const receipt = h.receipt();
  expect(h.uninstall().status).toBe(0);
  rmSync(join(h.runtime, 'olympus'), { recursive: true });
  const r = h.uninstall({}, ['--purge', '--yes']);
  expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
  expect(existsSync(receipt.path)).toBe(false);
  expect((lstatSync(join(h.runtime, 'olympus')).mode & 0o777)).toBe(0o700);
}, 30_000);

test('malformed receipt cannot widen purge to the home directory', () => {
  const h = fixture();
  const receipt = h.receipt();
  const parsed = JSON.parse(text(receipt.path));
  parsed.layout.dataDir = h.home;
  writeFileSync(receipt.path, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  const sentinel = join(h.home, 'keep');
  writeFileSync(sentinel, 'safe');
  const r = h.uninstall({}, ['--purge', '--yes']);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('inconsistent Linux layout');
  expect(text(sentinel)).toBe('safe');
}, 30_000);

test('overlapping canonical managed roots refuse before removal', () => {
  const h = fixture();
  const receipt = h.receipt();
  const parsed = JSON.parse(text(receipt.path));
  const configHome = join(parsed.layout.dataDir, 'config-root');
  parsed.layout.configHome = configHome;
  parsed.layout.configDir = join(configHome, 'olympus');
  parsed.layout.unitPath = join(configHome, 'systemd/user/olympus-engine.service');
  parsed.layout.configPath = join(parsed.layout.configDir, 'engine.json');
  parsed.layout.sovereigntyPath = join(parsed.layout.configDir, 'sovereignty.json');
  parsed.layout.workerEnvPath = join(parsed.layout.configDir, 'worker.env');
  parsed.layout.receiptPath = join(parsed.layout.configDir, 'install-receipt.json');
  parsed.layout.secretsPath = join(parsed.layout.configDir, 'secrets.enc');
  parsed.layout.secretsKeyPath = join(parsed.layout.configDir, 'secrets.key');
  parsed.layout.mimeappsPath = join(configHome, 'mimeapps.list');
  mkdirSync(parsed.layout.configDir, { recursive: true, mode: 0o700 });
  writeFileSync(parsed.layout.receiptPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  rmSync(receipt.path);
  const r = h.uninstall({ XDG_CONFIG_HOME: configHome }, ['--purge', '--yes']);
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('managed Olympus roots overlap');
  expect(existsSync(receipt.generation)).toBe(true);
}, 30_000);

test('unfinished install transaction refuses before service or artifact mutation', () => {
  const h = fixture();
  const receipt = h.receipt();
  const transaction = join(receipt.stateDir, 'install-transaction.json');
  writeFileSync(transaction, '{"schema":"olympus.engine.install-transaction.v1","phase":"preparing"}\n', { mode: 0o600 });
  const r = h.uninstall();
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('Rerun the same pinned installer or local release tarball');
  expect(existsSync(receipt.unitPath)).toBe(true);
  expect(existsSync(receipt.generation)).toBe(true);
  expect(existsSync(receipt.path)).toBe(true);
}, 30_000);

test('unknown package machinery is retained and prevents a success receipt', () => {
  const h = fixture();
  const receipt = h.receipt();
  const unknown = join(receipt.engine, 'unknown-replacement');
  writeFileSync(unknown, 'keep');
  const r = h.uninstall();
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain(`unknown engine machinery was retained: ${unknown}`);
  expect(existsSync(unknown)).toBe(true);
  expect(existsSync(receipt.path)).toBe(true);
  expect(r.stdout).not.toContain('machinery was removed');
}, 30_000);

test('Bun-free removal refuses while a recorded process group survives', async () => {
  const h = fixture();
  const receipt = h.receipt();
  const child = spawn('/bin/sh', ['-c', 'while :; do sleep 1; done'], { detached: true, stdio: 'ignore' });
  try {
    mkdirSync(join(receipt.dataDir, 'engine'), { recursive: true, mode: 0o700 });
    writeFileSync(join(receipt.dataDir, 'engine/children.json'), JSON.stringify({ schema: 'olympus.engine.children.v2', host_pid: 1, children: [{ service: 'worker', pgid: child.pid, started_at: '', process_started: null, argv: [] }] }), { mode: 0o600 });
    const r = h.uninstall();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(`process group ${child.pid} still exists`);
    expect(existsSync(receipt.unitPath)).toBe(true);
  } finally {
    try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
    await new Promise(resolve => child.once('exit', resolve));
  }
}, 30_000);

test('real flock contention and cancellation retain custody through the mutation child', async () => {
  const h = fixture();
  h.receipt();
  const child = spawn(h.shell, [h.script], { env: h.env({ FAKE_BLOCK: '1' }), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
  try {
    const until = Date.now() + 15_000;
    while (!h.calls().includes('blocked')) {
      if (Date.now() > until) throw new Error('installer never reached mutation');
      await Bun.sleep(25);
    }
    // Signal the entire supervisor/operation group, not just the outer shell.
    process.kill(-child.pid!, 'SIGTERM');
    const lock = join(h.runtime, 'olympus/lifecycle.lock');
    expect(spawnSync('flock', ['--nonblock', lock, 'true']).status).not.toBe(0);
    expect(h.uninstall().status).not.toBe(0);
    expect(h.calls()).not.toContain('engine uninstall');
    const r = h.run({ FAKE_LINGER: 'no' });
    expect(r.status).not.toBe(0);
    expect(h.calls()).not.toContain('enable-linger');
    expect(h.calls().match(/--restart/g)?.length).toBe(1);
    writeFileSync(join(h.root, 'release-child'), '');
    expect(await exited).toBe(0);
    expect(spawnSync('flock', ['--nonblock', lock, 'true']).status).toBe(0);
  } finally {
    writeFileSync(join(h.root, 'release-child'), '');
    await exited;
  }
}, 30_000);

test('killing the uninstall shell cannot release flock while Python mutation continues', async () => {
  const h = fixture();
  const receipt = h.receipt();
  const child = spawn(h.shell, [join(REPO, 'site/uninstall-linux.sh')], { env: h.env({ FAKE_UNINSTALL_BLOCK: '1' }), detached: true, stdio: 'ignore' });
  try {
    const until = Date.now() + 15_000;
    while (!existsSync(join(h.root, 'uninstall-blocked'))) {
      if (Date.now() > until) throw new Error('uninstaller never reached blocked mutation');
      await Bun.sleep(25);
    }
    process.kill(child.pid!, 'SIGKILL');
    await new Promise(resolve => child.once('exit', resolve));
    const lock = join(h.runtime, 'olympus/lifecycle.lock');
    expect(spawnSync('flock', ['--nonblock', lock, 'true']).status).not.toBe(0);
    writeFileSync(join(h.root, 'release-uninstall'), '');
    const releaseUntil = Date.now() + 15_000;
    while (spawnSync('flock', ['--nonblock', lock, 'true']).status !== 0) {
      if (Date.now() > releaseUntil) throw new Error('orphaned Python did not release lifecycle lock');
      await Bun.sleep(25);
    }
    expect(JSON.parse(text(receipt.path))).toMatchObject({ installationState: 'data_retained' });
  } finally {
    writeFileSync(join(h.root, 'release-uninstall'), '');
    try { process.kill(-child.pid!, 'SIGKILL'); } catch {}
  }
}, 30_000);

test('Linux installers parse', () => {
 for(const p of ['scripts/install-linux.sh','site/uninstall-linux.sh']) for(const shell of shells) expect(spawnSync(shell,['-n',join(REPO,p)]).status).toBe(0);
}, 30_000);
test.skipIf(spawnSync('shellcheck',['--version']).status !== 0)('Linux installers pass ShellCheck', () => {
  for (const p of ['scripts/install-linux.sh', 'site/uninstall-linux.sh']) {
    for (const shell of shells) expect(spawnSync(shell, ['-n', join(REPO, p)]).status).toBe(0);
    const sources = [text(join(REPO, p))];
    if (p.includes('install-linux') && !p.includes('uninstall')) sources.push(sources[0]!.split("<<'ACTIVATE'\n")[1]!.split('\nACTIVATE')[0]!);
    for (const source of sources) {
      const r = spawnSync('shellcheck', ['-s', 'sh', '-'], { input: source, encoding: 'utf8' });
      expect({ status: r.status, output: r.stdout + r.stderr }).toEqual({ status: 0, output: '' });
    }
  }
});

for (const purge of [false, true]) test(`desktop launcher removal in ${purge ? 'purge' : 'keep-data'} mode`, () => {
 const h=fixture(),r=h.receipt(),receipt=JSON.parse(text(r.path));
 const desktop=join(receipt.layout.dataHome,'applications/ai.olympusplugin.Olympus.desktop');
 const icon=join(receipt.layout.dataHome,'icons/hicolor/512x512/apps/ai.olympusplugin.Olympus.png');
 for(const [path,contents] of [[desktop,'[Desktop Entry]\nX-Olympus-Managed=true\n'],[icon,'icon bytes']]){
  mkdirSync(dirname(path!),{recursive:true,mode:0o700});writeFileSync(path!,contents!);receipt.machineArtifacts.push({path,kind:'file',sha256:sha(contents!)});
 }
 writeFileSync(r.path,JSON.stringify(receipt));
 const result=h.uninstall({},purge?['--purge','--yes']:[]);
 expect({status:result.status,stderr:result.stderr}).toEqual({status:0,stderr:''});
 expect(existsSync(desktop)).toBe(false);expect(existsSync(icon)).toBe(false);
}, 30_000);

for (const dataLayout of ['legacy', 'xdg'] as const) {
  for (const purge of [false, true]) {
    test(`uninstall ${dataLayout}: ${purge ? 'purge removes' : 'keep-data retains'} the receipt data root`, () => {
      const h = fixture('/bin/sh'); const r = h.receipt(dataLayout);
      writeFileSync(join(r.dataDir, 'personal.sqlite'), 'personal');
      mkdirSync(join(r.dataDir, 'engine'), { recursive: true, mode: 0o700 });
      writeFileSync(join(r.dataDir, 'engine/status.json'), '{}');
      const other = join(h.home, dataLayout === 'xdg' ? '.local/share/openclaw/olympus' : '.local/share/olympus');
      mkdirSync(other, { recursive: true, mode: 0o700 });
      writeFileSync(join(other, 'unrelated.sqlite'), 'unrelated');
      const result = h.uninstall({}, purge ? ['--purge', '--yes'] : []);
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
      expect(existsSync(join(r.dataDir, 'personal.sqlite'))).toBe(!purge);
      expect(readFileSync(join(other, 'unrelated.sqlite'), 'utf8')).toBe('unrelated');
    }, 30_000);
  }
}

for (const scenario of ['owned', 'unrecorded', 'nonempty', 'replacement', 'symlink'] as const) {
 test(`purge empty parent directories: ${scenario}`, () => {
  const h=fixture(), r=h.receipt('xdg'), receipt=JSON.parse(text(r.path));
  const parents=[dirname(r.stateDir),dirname(r.cacheDir)];
  receipt.ownedEmptyParents=parents.map(path=>{const info=lstatSync(path);return {path,device:info.dev,inode:info.ino};});
  if(scenario==='unrecorded')delete receipt.ownedEmptyParents;
  if(scenario==='nonempty')for(const path of parents)writeFileSync(join(path,'unrelated'),'keep');
  if(scenario==='replacement')for(const record of receipt.ownedEmptyParents)record.inode+=1;
  if(scenario==='symlink'){
   // Empty symlink replacement must never be followed or removed.
   const path=parents[0]!, moved=path+'-saved';renameSync(path,moved);symlinkSync(moved,path);
  }
  writeFileSync(r.path,JSON.stringify(receipt),{mode:0o600});
  const result=h.uninstall({},['--purge','--yes']);
  if(scenario==='symlink'){expect(result.status).not.toBe(0);expect(lstatSync(parents[0]!).isSymbolicLink()).toBe(true);return;}
  expect({status:result.status,error:result.stderr}).toEqual({status:0,error:''});
  for(const path of parents){expect(existsSync(path)).toBe(scenario!=='owned');if(scenario==='nonempty')expect(text(join(path,'unrelated'))).toBe('keep');}
 }, 30_000);
}
