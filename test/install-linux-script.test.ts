/** Shell boundary proof; fake lifecycle commands are NOT systemd/durability proof. */
import { afterEach, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(import.meta.dir, '..');
const roots: string[] = [];
const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const text = (p: string) => readFileSync(p, 'utf8');
const executable = (p: string, s: string) => writeFileSync(p, s, { mode: 0o755 });
const shells = ['/bin/sh', '/bin/dash'];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
  expect(spawnSync('zip', ['-qr', zip, 'bun-linux-x64-baseline'], { cwd: dirname(zipStage) }).status).toBe(0);
  const packageDir = join(root, 'release', 'package');
  mkdirSync(join(packageDir, 'dist'), { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({ name: 'olympus', version: '1.0.0-rc.7' }));
  const cli = `echo "$*" >> '${log}'
if [ "$2" = install ]; then
  case "$*" in *--dry-run*) [ -z "$FAKE_PREFLIGHT_FAIL" ] || exit 1; exit 0 ;; esac
  echo "linger-before=$OLYMPUS_LINGER_BEFORE" >> '${log}'
  if flock -n "$XDG_RUNTIME_DIR/olympus/lifecycle.lock" true; then echo lock-missing >> '${log}'; exit 9; fi
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
  executable(join(bin, 'id'), '#!/bin/sh\ncase "$1" in -u) echo "${FAKE_UID:-1000}" ;; -un) echo "${FAKE_ACCOUNT:-tester}" ;; *) exec /usr/bin/id "$@" ;; esac\n');
  executable(join(bin, 'stat'), `#!/bin/sh
if [ "$2" = %u ]; then
 case "$3" in '${root}'*) echo "\${FAKE_OWNER:-1000}"; exit 0 ;; esac
fi
exec /usr/bin/stat "$@"
`);
  executable(join(bin, 'systemctl'), `#!/bin/sh
if [ "$1" = --version ]; then echo "systemd \${FAKE_SYSTEMD:-256}"; exit 0; fi
[ -z "$FAKE_BUS_FAIL" ]
`);
  executable(join(bin, 'awk'), '#!/bin/sh\nfor arg in "$@"; do if [ "$arg" = /proc/cpuinfo ] && [ -n "$FAKE_CPU_FAIL" ]; then exit 1; fi; done\nexec /usr/bin/awk "$@"\n');
  executable(join(bin, 'getconf'), '#!/bin/sh\necho "glibc ${FAKE_GLIBC:-2.36}"\n');
  executable(join(bin, 'loginctl'), `#!/bin/sh
[ -z "$FAKE_LOGIND_FAIL" ] || exit 1
case "$1" in
 show-user) if [ -f '${root}/linger' ]; then echo yes; else echo "\${FAKE_LINGER:-yes}"; fi ;;
 --no-ask-password) echo "enable-linger $*" >> '${log}'; [ -z "$FAKE_LINGER_DENY" ] || exit 1; touch '${root}/linger' ;;
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
  const run = (extra: Record<string, string> = {}) => spawnSync(shell, [script], { env: env(extra), encoding: 'utf8', timeout: 15_000 });
  const calls = () => existsSync(log) ? text(log) : '';
  const uninstall = (extra: Record<string, string> = {}, args: string[] = []) => spawnSync(shell, [join(REPO, 'site/uninstall-linux.sh'), ...args], { env: env(extra), encoding: 'utf8', timeout: 15_000 });
  const receipt = () => {
    const engine = join(home, '.local/share/olympus/engine');
    const bun = join(engine, 'runtime/bun');
    const installedCli = join(engine, 'app/dist/cli.js');
    for (const p of [dirname(bun), dirname(installedCli), join(home, '.config/olympus'), join(runtime, 'olympus')]) mkdirSync(p, { recursive: true, mode: 0o700 });
    executable(bun, bunProgram);
    writeFileSync(installedCli, cli);
    writeFileSync(join(runtime, 'olympus/lifecycle.lock'), '', { mode: 0o600 });
    const data = {
      schema: 'olympus.linux-uninstall.v1', uid: '1000', bun, bun_sha256: sha(bunProgram), cli: installedCli, cli_sha256: sha(cli),
      config_root: join(home, '.config'), data_root: join(home, '.local/share'), state_root: join(home, '.local/state'), cache_root: join(home, '.cache'), linger_before: 'no',
    };
    const path = join(home, '.config/olympus/uninstall-receipt.tsv');
    writeFileSync(path, Object.entries(data).map(([key, value]) => `${key}\t${value}\n`).join(''), { mode: 0o600 });
    return { path, bun, cli: installedCli };
  };
  return { root, home, runtime, bin, script, run, calls, uninstall, receipt, env, shell };
}

for (const shell of shells) {
  test(`${shell}: verified bootstrap calls the CLI under flock and checks status`, () => {
    const h = fixture(shell);
    const r = h.run();
    expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
    expect(h.calls()).toContain('engine install --from-checkout');
    expect(h.calls()).toContain('linger-before=yes');
    expect(h.calls()).toContain('engine status');
    expect(h.calls()).not.toContain('lock-missing');
    expect(r.stdout).toContain('Installed for your user');
  });
  test(`${shell}: truncated pipe and unfilled template execute nothing`, () => {
    const h = fixture(shell);
    const template = text(join(REPO, 'scripts/install-linux.sh'));
    for (const input of [template, text(h.script).replace(/main "\$@"\s*$/, '')]) {
      const r = spawnSync(shell, [], { input, env: h.env(), encoding: 'utf8' });
      expect(h.calls()).toBe('');
      expect(r.stdout).not.toContain('Installed for your user');
    }
  });
  test(`${shell}: default uninstall delegates only verified receipt machinery and keeps data`, () => {
    const h = fixture(shell);
    h.receipt();
    const data = join(h.home, '.config/olympus/personal');
    writeFileSync(data, 'keep me');
    const r = h.uninstall();
    expect({ status: r.status, err: r.stderr }).toEqual({ status: 0, err: '' });
    expect(h.calls()).toBe('engine uninstall\n');
    expect(text(data)).toBe('keep me');
    expect(r.stdout).toContain('Data and settings were kept');
    expect(r.stdout).toContain('Linger was preserved');
    expect(existsSync(join(h.runtime, 'olympus/lifecycle.lock'))).toBe(true);
  });
}

test('Mac installer and uninstaller stay byte-for-byte unchanged', () => {
  expect(sha(readFileSync(join(REPO, 'scripts/install-macos.sh')))).toBe('0c3ed6a1a98a2774115c5b6ada7700b42a1eebffff25833826f0324c9257f35d');
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
    if ('FAKE_LOGIND_FAIL' in env) expect(h.calls()).not.toContain('--restart');
    else expect(h.calls()).toBe('');
  });
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
});

test('linger denial prints the exact design refusal and never installs', () => {
  const h = fixture();
  const r = h.run({ FAKE_LINGER: 'no', FAKE_LINGER_DENY: '1' });
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain("Olympus needs permission to keep running after you log out and to start\nbefore you log in. This account cannot enable that permission without an\nadministrator. Ask an administrator to run: `sudo loginctl enable-linger 'tester'`.\nThen run the installer again. Olympus was not installed or upgraded;\nan existing installation was left running.\n");
  expect(h.calls()).not.toContain('--restart');
  expect(r.stdout).toContain('account-wide linger');
  expect(r.stdout).not.toContain('No administrator password is needed');
});

test('CLI preflight refusal leaves linger and existing installation untouched', () => {
  const h = fixture();
  const r = h.run({ FAKE_PREFLIGHT_FAIL: '1', FAKE_LINGER: 'no' });
  expect(r.status).not.toBe(0);
  expect(h.calls()).not.toContain('enable-linger');
  expect(h.calls()).not.toContain('--restart');
});

test('newly enabled linger is re-read and prior state passed to lifecycle', () => {
  const h = fixture();
  expect(h.run({ FAKE_LINGER: 'no' }).status).toBe(0);
  expect(h.calls()).toContain('linger-before=no');
});

for (const kind of ['link', 'traversal']) {
  test(`valid checksum cannot authorize unsafe archive ${kind}`, () => {
    const h = fixture('/bin/sh', kind);
    const r = h.run();
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/archive path|special files/);
    expect(h.calls()).toBe('');
  });
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
});

test('tampered extracted Bun is not executed, even with an intact archive', () => {
  const h = fixture();
  writeFileSync(h.script, text(h.script).replace(/^BUN_EXE_SHA256=.*$/m, `BUN_EXE_SHA256=${'0'.repeat(64)}`));
  const r = h.run();
  expect(r.status).not.toBe(0);
  expect(r.stderr).toContain('Bun executable checksum mismatch');
  expect(h.calls()).toBe('');
});

test('unknown health and failed install never report success', () => {
  for (const env of [{ FAKE_HEALTH: 'false' }, { FAKE_INSTALL_FAIL: '1' }]) {
    const h = fixture();
    const r = h.run(env as Record<string, string>);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('Installed for your user');
    if ('FAKE_INSTALL_FAIL' in env) expect(r.stderr).toContain('previous version restored and healthy');
    else expect(r.stderr).toContain('unhealthy or unknown');
  }
});

test('unsafe runtime path refuses without following a symlink', () => {
  const h = fixture();
  symlinkSync(h.home, join(h.runtime, 'olympus'));
  expect(h.run().stderr).toContain('Symbolic link refused');
  expect(h.calls()).toBe('');
});

for (const fault of ['bun', 'cli', 'missing', 'duplicate', 'foreign', 'symlink', 'purge', 'custody']) {
  test(`uninstall fault ${fault} preserves personal data and refuses success`, () => {
    const h = fixture();
    const receipt = h.receipt();
    const personal = join(h.home, '.config/olympus/personal');
    writeFileSync(personal, 'untouched');
    if (fault === 'bun') writeFileSync(receipt.bun, '#!/bin/sh\necho BAD\n');
    if (fault === 'cli') writeFileSync(receipt.cli, 'echo BAD\n');
    if (fault === 'missing') rmSync(receipt.bun);
    if (fault === 'duplicate') writeFileSync(receipt.path, text(receipt.path) + 'uid\t1000\n');
    if (fault === 'symlink') { rmSync(receipt.cli); symlinkSync(personal, receipt.cli); }
    const r = h.uninstall(fault === 'foreign' ? { FAKE_OWNER: '999' } : fault === 'custody' ? { FAKE_UNINSTALL_FAIL: '1' } : {}, fault === 'purge' ? ['--purge'] : []);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('machinery was removed');
    expect(text(personal)).toBe('untouched');
    if (fault !== 'custody') expect(h.calls()).toBe('');
    else expect(r.stderr).toContain('Unknown custody');
  });
}

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

test('Linux drafts parse and pass ShellCheck', () => {
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
