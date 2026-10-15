/**
 * scripts/publish-release-to-site.ts: the one path from a release tarball to
 * the served installer. site/install.sh is the template with exactly its pin
 * lines filled in, and deploy.sh publishes nothing a fresh install would
 * refuse.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  bunExecutableDigest,
  checkLinuxSiteRelease,
  checkSiteRelease,
  fileDigest,
  pinBunExecutable,
  prepareMacLocalBundle,
  publishLinuxToSite,
  prepareLinuxLocalBundle,
  publishToSite,
  readBunPins,
  readInstallScriptPins,
  readLinuxRuntimePins,
  releaseTarballPath,
  renderInstallScript,
  renderLinuxInstallScript,
  validateLinuxRuntimePins,
  verifyLinuxRuntimeArchive,
  type LinuxRuntimePins,
} from '../scripts/publish-release-to-site.ts';

const REPO = resolve(import.meta.dir, '..');
const TEMPLATE = readFileSync(join(REPO, 'scripts', 'install-macos.sh'), 'utf8');
const LINUX_TEMPLATE = readFileSync(join(REPO, 'scripts', 'install-linux.sh'), 'utf8');
const LINUX_RUNTIME = readLinuxRuntimePins(join(REPO, 'config', 'linux-runtime-pins.json'));
const PINS = { version: '1.0.0-rc.1', sha256: 'a'.repeat(64), bytes: 1234 };
const has = (tool: string): boolean => spawnSync('/bin/sh', ['-c', `command -v ${tool}`]).status === 0;
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A minimal repository: package.json, the real template and uninstaller, and a release tarball. */
function fixture(version = '1.0.0-rc.1', packaged: { name: string; version: string } = { name: 'olympus', version }) {
  const root = mkdtempSync(join(tmpdir(), 'olympus-publish-site-'));
  roots.push(root);
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'site'));
  copyFileSync(join(REPO, 'scripts', 'install-macos.sh'), join(root, 'scripts', 'install-macos.sh'));
  copyFileSync(join(REPO, 'site', 'uninstall.sh'), join(root, 'site', 'uninstall.sh'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'olympus-source-checkout', version }));
  mkdirSync(join(root, 'build', 'package'), { recursive: true });
  writeFileSync(join(root, 'build', 'package', 'package.json'), JSON.stringify(packaged));
  const artifact = join(root, `olympus-${version}.tgz`);
  expect(spawnSync('tar', ['-czf', artifact, '-C', join(root, 'build'), 'package']).status).toBe(0);
  return { root, artifact };
}

const cloneLinuxRuntime = (): LinuxRuntimePins => JSON.parse(JSON.stringify(LINUX_RUNTIME)) as LinuxRuntimePins;

test('local Linux bundle pins the real installer without publishing unqualified runtime', () => {
  const { root, artifact } = linuxFixture('pending-omarchy');
  const output = join(root, 'acceptance');
  const pins = prepareLinuxLocalBundle({ root, artifact, output });
  expect(readInstallScriptPins(readFileSync(join(output, 'install-linux.sh'), 'utf8'))).toEqual({ version: pins.version, sha256: pins.sha256, bytes: pins.bytes });
  expect(readFileSync(join(output, `olympus-${pins.version}.tgz`))).toEqual(readFileSync(artifact));
  expect(readFileSync(join(output, 'install-linux.sh'), 'utf8')).toBe(renderLinuxInstallScript(LINUX_TEMPLATE, pins, LINUX_RUNTIME));
  expect(readFileSync(join(output, 'uninstall-linux.sh'))).toEqual(readFileSync(join(root, 'site/uninstall-linux.sh')));
  expect(existsSync(join(root, 'site/install-linux.sh'))).toBe(false);
  expect(() => publishLinuxToSite({ root, artifact })).toThrow();
  expect(() => prepareLinuxLocalBundle({ root, artifact, output })).toThrow();
  expect(readFileSync(join(output, 'SHA256SUMS'), 'utf8')).toContain(fileDigest(artifact).sha256);
  expect(readFileSync(join(output, 'README.txt'), 'utf8')).toContain(`sh ./install-linux.sh --tarball "$(pwd)/olympus-${pins.version}.tgz"`);
}, 30_000);

test('local Mac bundle is the served installer for the candidate and changes nothing in site/', () => {
  const { root, artifact } = fixture();
  const output = join(root, 'release-check');
  const pins = prepareMacLocalBundle({ root, artifact, output });
  // The installer is the template with the candidate's pins, byte for byte what the site would serve for it.
  expect(readFileSync(join(output, 'install.sh'), 'utf8')).toBe(renderInstallScript(TEMPLATE, pins));
  expect(readInstallScriptPins(readFileSync(join(output, 'install.sh'), 'utf8'))).toEqual({ version: pins.version, sha256: pins.sha256, bytes: pins.bytes });
  expect(readFileSync(join(output, `olympus-${pins.version}.tgz`))).toEqual(readFileSync(artifact));
  expect(readFileSync(join(output, 'uninstall.sh'))).toEqual(readFileSync(join(root, 'site/uninstall.sh')));
  expect(readFileSync(join(output, 'SHA256SUMS'), 'utf8')).toContain(fileDigest(artifact).sha256);
  expect(existsSync(join(root, 'site/install.sh'))).toBe(false);
  expect(existsSync(join(root, 'site/releases'))).toBe(false);
  // A second candidate never mixes into the first one's folder, and a tarball that is not this version is refused.
  expect(() => prepareMacLocalBundle({ root, artifact, output })).toThrow();
  const other = fixture('1.0.0-rc.1', { name: 'olympus', version: '9.9.9' });
  expect(() => prepareMacLocalBundle({ root: other.root, artifact: other.artifact, output: join(other.root, 'out') })).toThrow('identity');
}, 30_000);

function linuxFixture(qualification: LinuxRuntimePins['bun']['qualification'] = 'qualified-omarchy') {
  const result = fixture();
  mkdirSync(join(result.root, 'config'));
  copyFileSync(join(REPO, 'scripts', 'install-linux.sh'), join(result.root, 'scripts', 'install-linux.sh'));
  copyFileSync(join(REPO, 'site', 'uninstall-linux.sh'), join(result.root, 'site', 'uninstall-linux.sh'));
  const runtime = cloneLinuxRuntime();
  runtime.bun.qualification = qualification;
  writeFileSync(join(result.root, 'config', 'linux-runtime-pins.json'), `${JSON.stringify(runtime, null, 2)}\n`);
  return { ...result, runtime };
}

describe('renderInstallScript', () => {
  test('fills exactly the three pin lines and changes nothing else', () => {
    const rendered = renderInstallScript(TEMPLATE, PINS);
    const before = TEMPLATE.split('\n');
    const after = rendered.split('\n');
    expect(after).toHaveLength(before.length);
    const changed = before.flatMap((line, index) => (line === after[index] ? [] : [[line, after[index]]]));
    expect(changed).toEqual([
      ['OLYMPUS_VERSION=@OLYMPUS_VERSION@', 'OLYMPUS_VERSION=1.0.0-rc.1'],
      ['OLYMPUS_SHA256=@OLYMPUS_SHA256@', `OLYMPUS_SHA256=${'a'.repeat(64)}`],
      ['OLYMPUS_BYTES=@OLYMPUS_BYTES@', 'OLYMPUS_BYTES=1234'],
    ]);
    expect(readInstallScriptPins(rendered)).toEqual(PINS);
    expect(readInstallScriptPins(TEMPLATE)).toBeUndefined();
    // The rendered installer parses.
    const path = join(mkdtempSync(join(tmpdir(), 'olympus-render-')), 'install.sh');
    roots.push(resolve(path, '..'));
    writeFileSync(path, rendered);
    expect(spawnSync('/bin/sh', ['-n', path]).status).toBe(0);
  }, 30_000);

  test('refuses pins that are not safe in a shell assignment or URL', () => {
    for (const version of ['1.0', '1.0.0 ', '1.0.0;rm', '../1.0.0', '1.0.0-rc.1/x']) {
      expect(() => renderInstallScript(TEMPLATE, { ...PINS, version })).toThrow('not plain semver');
    }
    expect(() => renderInstallScript(TEMPLATE, { ...PINS, sha256: 'A'.repeat(64) })).toThrow('SHA-256');
    expect(() => renderInstallScript(TEMPLATE, { ...PINS, bytes: 0 })).toThrow('byte count');
  });

  test('refuses a template whose pin lines are missing or repeated', () => {
    expect(() => renderInstallScript(TEMPLATE.replace('OLYMPUS_BYTES=@OLYMPUS_BYTES@\n', ''), PINS)).toThrow('exactly once');
    expect(() => renderInstallScript(`${TEMPLATE}OLYMPUS_SHA256=@OLYMPUS_SHA256@\n`, PINS)).toThrow('exactly once');
  });
});

describe('publishToSite and checkSiteRelease', () => {
  test('copies the tarball under site/releases and writes site/install.sh pinned to it', () => {
    const { root, artifact } = fixture();
    const result = publishToSite({ root, artifact });
    const tarball = join(root, releaseTarballPath('1.0.0-rc.1'));
    expect(result.tarball).toBe(tarball);
    expect(result.sha256).toBe(createHash('sha256').update(readFileSync(artifact)).digest('hex'));
    expect(result.bytes).toBe(readFileSync(artifact).length);
    expect(readFileSync(tarball)).toEqual(readFileSync(artifact));
    expect(readFileSync(`${tarball}.sha256`, 'utf8')).toBe(`${result.sha256}  olympus-1.0.0-rc.1.tgz\n`);
    const served = readFileSync(join(root, 'site', 'install.sh'), 'utf8');
    expect(served).toBe(renderInstallScript(TEMPLATE, { version: '1.0.0-rc.1', sha256: result.sha256, bytes: result.bytes }));
    expect(checkSiteRelease(root)).toEqual([]);
  }, 30_000);

  test('refuses a tarball whose name or packaged identity is not the source version', () => {
    const wrongName = fixture();
    const renamed = join(wrongName.root, 'olympus-1.0.0-rc.2.tgz');
    copyFileSync(wrongName.artifact, renamed);
    expect(() => publishToSite({ root: wrongName.root, artifact: renamed })).toThrow('is not olympus-1.0.0-rc.1.tgz');
    const wrongPackage = fixture('1.0.0-rc.1', { name: 'olympus', version: '1.0.0-rc.0' });
    expect(() => publishToSite(wrongPackage)).toThrow('packages olympus@1.0.0-rc.0, not olympus@1.0.0-rc.1');
    const wrongNamePackage = fixture('1.0.0-rc.1', { name: 'olympus-source-checkout', version: '1.0.0-rc.1' });
    expect(() => publishToSite(wrongNamePackage)).toThrow('not olympus@1.0.0-rc.1');
  }, 30_000);

  test('the deploy check catches a missing installer, an edited installer, a stale template, a changed tarball and a version bump', () => {
    const missing = fixture();
    expect(checkSiteRelease(missing.root)).toEqual(['site/install.sh is missing: run bun scripts/publish-release-to-site.ts.']);

    const edited = fixture();
    publishToSite(edited);
    const servedPath = join(edited.root, 'site', 'install.sh');
    writeFileSync(servedPath, readFileSync(servedPath, 'utf8').replace('set -eu', 'set -u'));
    expect(checkSiteRelease(edited.root).join('\n')).toContain('differs from scripts/install-macos.sh rendered with its pins');

    const stale = fixture();
    publishToSite(stale);
    writeFileSync(join(stale.root, 'scripts', 'install-macos.sh'), `${TEMPLATE}# changed\n`);
    expect(checkSiteRelease(stale.root).join('\n')).toContain('differs from scripts/install-macos.sh');

    const tampered = fixture();
    const published = publishToSite(tampered);
    writeFileSync(published.tarball, 'not the release');
    const problems = checkSiteRelease(tampered.root).join('\n');
    expect(problems).toContain('not the pinned');
    expect(problems).toContain('has no package/package.json');

    const bumped = fixture();
    publishToSite(bumped);
    writeFileSync(join(bumped.root, 'package.json'), JSON.stringify({ version: '1.0.0-rc.2' }));
    expect(checkSiteRelease(bumped.root)).toContain('site/install.sh pins 1.0.0-rc.1, but package.json is 1.0.0-rc.2.');

    const noUninstaller = fixture();
    publishToSite(noUninstaller);
    rmSync(join(noUninstaller.root, 'site', 'uninstall.sh'));
    expect(checkSiteRelease(noUninstaller.root)).toEqual(['site/uninstall.sh is missing.']);
  }, 30_000);
});

describe('Linux runtime pins and rendering', () => {
  test('requires the complete Linux x64 baseline manifest and refuses arm64', () => {
    const missing = cloneLinuxRuntime() as unknown as { bun: Record<string, unknown> };
    delete missing.bun.executableSha256;
    expect(() => validateLinuxRuntimePins(missing)).toThrow('must contain exactly');

    const arm64 = cloneLinuxRuntime() as unknown as { bun: Record<string, unknown> };
    arm64.bun.platform = 'linux-arm64';
    expect(() => validateLinuxRuntimePins(arm64)).toThrow('must be linux-x64');

    const looseUrl = cloneLinuxRuntime() as unknown as { bun: Record<string, unknown> };
    looseUrl.bun.url = 'https://github.com/oven-sh/bun/releases/latest/download/bun-linux-x64-baseline.zip';
    expect(() => validateLinuxRuntimePins(looseUrl)).toThrow('exact versioned oven-sh baseline URL');

    for (const [field, value, message] of [
      ['version', '1.3.14-canary.1', 'stable X.Y.Z'],
      ['bytes', 0, 'positive byte count'],
      ['sha256', 'A'.repeat(64), '64 lowercase hex'],
      ['glibcMin', '2.18', 'must be 2.17'],
      ['cpuRequired', ['avx2'], 'exactly ["sse4_2"]'],
    ] as const) {
      const invalid = cloneLinuxRuntime() as unknown as { bun: Record<string, unknown> };
      invalid.bun[field] = value;
      expect(() => validateLinuxRuntimePins(invalid)).toThrow(message);
    }
  });

  test('fills every Linux release/runtime placeholder, including pending fixtures', () => {
    const rendered = renderLinuxInstallScript(LINUX_TEMPLATE, PINS, LINUX_RUNTIME);
    expect(rendered).not.toMatch(/@[A-Z][A-Z0-9_]*@/i);
    expect(rendered).toMatch(/^OLYMPUS_VERSION=1\.0\.0-rc\.1$/m);
    expect(rendered).toMatch(/^BUN_VERSION=1\.3\.14$/m);
    expect(rendered).toContain(`BUN_URL=${LINUX_RUNTIME.bun.url}`);
    expect(rendered).toContain(`BUN_ENTRY=${LINUX_RUNTIME.bun.entry}`);
    expect(rendered).toContain(`BUN_EXE_SHA256=${LINUX_RUNTIME.bun.executableSha256}`);
    expect(rendered).toMatch(/^BUN_GLIBC_MIN=2\.17$/m);
    expect(() => renderLinuxInstallScript(LINUX_TEMPLATE.replace('BUN_BYTES=@BUN_BYTES@\n', ''), PINS, LINUX_RUNTIME)).toThrow('exactly one');
    expect(() => renderLinuxInstallScript(`${LINUX_TEMPLATE}BUN_SHA256=@BUN_SHA256@\n`, PINS, LINUX_RUNTIME)).toThrow('exactly one');
    expect(() => renderLinuxInstallScript(`${LINUX_TEMPLATE}BUN_URL=https://example.test/bun.zip\n`, PINS, LINUX_RUNTIME)).toThrow('exactly one');
    expect(() => renderLinuxInstallScript(`${LINUX_TEMPLATE}EXTRA=@UNKNOWN_PIN@\n`, PINS, LINUX_RUNTIME)).toThrow('unfilled placeholder');
    expect(() => renderLinuxInstallScript(`${LINUX_TEMPLATE}extra=@unknown_pin@\n`, PINS, LINUX_RUNTIME)).toThrow('unfilled placeholder');
    const path = join(mkdtempSync(join(tmpdir(), 'olympus-linux-render-')), 'install-linux.sh');
    roots.push(resolve(path, '..'));
    writeFileSync(path, rendered);
    expect(spawnSync('/bin/sh', ['-n', path]).status).toBe(0);
  }, 30_000);

  test.skipIf(!has('zip') || !has('unzip'))('verifies the archive before reading the named executable and rejects tampering', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-linux-bun-pin-'));
    roots.push(root);
    const makeArchive = (directory: string, program: string): string => {
      mkdirSync(join(directory, 'bun-linux-x64-baseline'), { recursive: true });
      writeFileSync(join(directory, 'bun-linux-x64-baseline', 'bun'), program, { mode: 0o755 });
      const archive = join(directory, 'bun-linux-x64-baseline.zip');
      expect(spawnSync('zip', ['-qr', archive, 'bun-linux-x64-baseline'], { cwd: directory }).status).toBe(0);
      return archive;
    };
    const goodDir = join(root, 'good');
    const program = '#!/bin/sh\necho verified but never executed\n';
    const archive = makeArchive(goodDir, program);
    const runtime = cloneLinuxRuntime();
    Object.assign(runtime.bun, {
      ...fileDigest(archive),
      executableSha256: createHash('sha256').update(program).digest('hex'),
    });
    expect(verifyLinuxRuntimeArchive(archive, runtime).executableSha256).toBe(runtime.bun.executableSha256);

    writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.from('tampered')]));
    expect(() => verifyLinuxRuntimeArchive(archive, runtime)).toThrow('not the pinned Linux Bun archive');

    const changedArchive = makeArchive(join(root, 'changed'), '#!/bin/sh\necho changed\n');
    const changedRuntime = cloneLinuxRuntime();
    Object.assign(changedRuntime.bun, fileDigest(changedArchive), { executableSha256: runtime.bun.executableSha256 });
    expect(() => verifyLinuxRuntimeArchive(changedArchive, changedRuntime)).toThrow('executable SHA-256');
  }, 30_000);
});

describe('publishLinuxToSite and checkLinuxSiteRelease', () => {
  test('refuses pending qualification before writing any served asset', () => {
    const pending = linuxFixture('pending-omarchy');
    expect(() => publishLinuxToSite(pending)).toThrow('requires qualified-omarchy');
    expect(existsSync(join(pending.root, 'site', 'install-linux.sh'))).toBe(false);
    expect(existsSync(join(pending.root, 'site', 'releases'))).toBe(false);
    expect(checkLinuxSiteRelease(pending.root).join('\n')).toContain('requires qualified-omarchy');
  }, 30_000);

  test('publishes Linux without changing Mac/prior assets and reuses identical same-version assets', () => {
    const current = linuxFixture();
    const prior = join(current.root, 'site', 'releases', '1.0.0-rc.0');
    mkdirSync(prior, { recursive: true });
    writeFileSync(join(prior, 'olympus-1.0.0-rc.0.tgz'), 'prior release');
    writeFileSync(join(prior, 'olympus-1.0.0-rc.0.tgz.sha256'), 'prior checksum');
    writeFileSync(join(current.root, 'site', 'install.sh'), 'mac installer');
    writeFileSync(join(current.root, 'site', 'uninstall.sh'), 'mac uninstaller');

    const result = publishLinuxToSite(current);
    const firstInstaller = readFileSync(result.installScript, 'utf8');
    expect(checkLinuxSiteRelease(current.root)).toEqual([]);
    expect(readFileSync(join(prior, 'olympus-1.0.0-rc.0.tgz'), 'utf8')).toBe('prior release');
    expect(readFileSync(join(current.root, 'site', 'install.sh'), 'utf8')).toBe('mac installer');
    expect(readFileSync(join(current.root, 'site', 'uninstall.sh'), 'utf8')).toBe('mac uninstaller');
    expect(() => publishLinuxToSite(current)).not.toThrow();

    writeFileSync(result.tarball, 'different release');
    expect(() => publishLinuxToSite(current)).toThrow('already exists with different contents');
    expect(readFileSync(result.tarball, 'utf8')).toBe('different release');
    expect(readFileSync(result.installScript, 'utf8')).toBe(firstInstaller);

    copyFileSync(current.artifact, result.tarball);
    writeFileSync(`${result.tarball}.sha256`, 'different checksum\n');
    expect(() => publishLinuxToSite(current)).toThrow('.sha256 already exists with different contents');
    expect(readFileSync(`${result.tarball}.sha256`, 'utf8')).toBe('different checksum\n');
  }, 30_000);

  test('Mac publishing cannot replace a same-version asset pinned by Linux', () => {
    const current = linuxFixture();
    const linux = publishLinuxToSite(current);
    writeFileSync(join(current.root, 'site', 'install.sh'), 'existing Mac installer');
    const alternateDir = join(current.root, 'alternate');
    mkdirSync(alternateDir);
    writeFileSync(join(current.root, 'build', 'package', 'variant'), 'different same-version bytes');
    const alternate = join(alternateDir, 'olympus-1.0.0-rc.1.tgz');
    expect(spawnSync('tar', ['-czf', alternate, '-C', join(current.root, 'build'), 'package']).status).toBe(0);
    const before = {
      tarball: readFileSync(linux.tarball),
      checksum: readFileSync(`${linux.tarball}.sha256`),
      linuxInstaller: readFileSync(linux.installScript),
      macInstaller: readFileSync(join(current.root, 'site', 'install.sh')),
    };

    expect(() => publishToSite({ root: current.root, artifact: alternate })).toThrow('pinned by site/install-linux.sh');
    expect(readFileSync(linux.tarball)).toEqual(before.tarball);
    expect(readFileSync(`${linux.tarball}.sha256`)).toEqual(before.checksum);
    expect(readFileSync(linux.installScript)).toEqual(before.linuxInstaller);
    expect(readFileSync(join(current.root, 'site', 'install.sh'))).toEqual(before.macInstaller);
    expect(checkLinuxSiteRelease(current.root)).toEqual([]);
  }, 30_000);

  test('the default site check includes served Linux tampering and qualification', () => {
    const current = linuxFixture();
    publishLinuxToSite(current);
    publishToSite(current);
    const linuxInstaller = join(current.root, 'site', 'install-linux.sh');
    const served = readFileSync(linuxInstaller, 'utf8');
    writeFileSync(linuxInstaller, served.replace('set -eu', 'set -u'));
    expect(checkSiteRelease(current.root).join('\n')).toContain('site/install-linux.sh differs from scripts/install-linux.sh');

    writeFileSync(linuxInstaller, served);
    current.runtime.bun.qualification = 'pending-omarchy';
    writeFileSync(join(current.root, 'config', 'linux-runtime-pins.json'), `${JSON.stringify(current.runtime, null, 2)}\n`);
    expect(checkSiteRelease(current.root).join('\n')).toContain('Linux publication requires qualified-omarchy');
  }, 30_000);
});

describe('site publishing wiring', () => {
  test('the served installer and tarballs are build products, never committed', () => {
    const ignore = readFileSync(join(REPO, '.gitignore'), 'utf8').split('\n');
    expect(ignore).toContain('site/install.sh');
    expect(ignore).toContain('site/install-linux.sh');
    expect(ignore).toContain('site/releases/');
    const tracked = spawnSync('git', ['ls-files', 'site/install.sh', 'site/install-linux.sh', 'site/releases'], { cwd: REPO, encoding: 'utf8' });
    expect(tracked.stdout.trim()).toBe('');
  }, 30_000);

  test('deploy.sh refuses to publish without the release check, uploads releases before install.sh, and never deletes a release', () => {
    const deploy = readFileSync(join(REPO, 'site', 'deploy', 'deploy.sh'), 'utf8');
    const check = deploy.indexOf('publish-release-to-site.ts" --check');
    const releases = deploy.indexOf('"$SITE_DIR/releases/" "$TARGET:$REMOTE_DIR/releases/"');
    const site = deploy.indexOf('"$SITE_DIR/" "$TARGET:$REMOTE_DIR/"');
    expect(check).toBeGreaterThan(0);
    expect(releases).toBeGreaterThan(check);
    expect(site).toBeGreaterThan(releases);
    // The release upload never deletes: the live install.sh may still pin a tarball.
    const releaseRsync = deploy.slice(deploy.lastIndexOf('rsync', releases), releases);
    expect(releaseRsync).not.toContain('--delete');
    // The site sync deletes, but releases/ is outside it, and excluded files are not deleted.
    const siteRsync = deploy.slice(deploy.lastIndexOf('rsync', site), site);
    expect(siteRsync).toContain('--delete');
    expect(siteRsync).toContain("--exclude '/releases/'");
    expect(deploy).not.toContain('--delete-excluded');
  });

  test.skipIf(!has('rsync'))('PoC: deploying a site without an old release keeps that release on the host, and removes other stale pages', () => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-deploy-'));
    roots.push(root);
    const site = join(root, 'repo', 'site');
    const remote = join(root, 'remote');
    const shims = join(root, 'shims');
    for (const dir of [join(site, 'deploy'), join(site, 'releases', '1.0.0-rc.2'), join(remote, 'releases', '1.0.0-rc.1'), shims]) mkdirSync(dir, { recursive: true });
    copyFileSync(join(REPO, 'site', 'deploy', 'deploy.sh'), join(site, 'deploy', 'deploy.sh'));
    writeFileSync(join(site, 'index.html'), 'new index');
    writeFileSync(join(site, 'install.sh'), 'new installer');
    writeFileSync(join(site, 'releases', '1.0.0-rc.2', 'olympus-1.0.0-rc.2.tgz'), 'rc.2');
    writeFileSync(join(remote, 'releases', '1.0.0-rc.1', 'olympus-1.0.0-rc.1.tgz'), 'rc.1');
    writeFileSync(join(remote, 'stale.html'), 'old page');
    // The release check passes; ssh runs the remote command here, as the host would.
    writeFileSync(join(shims, 'bun'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    writeFileSync(join(shims, 'ssh'), [
      '#!/bin/sh',
      'while [ $# -gt 0 ]; do case "$1" in -i|-o|-l|-p) shift 2 ;; -*) shift ;; *) break ;; esac; done',
      'shift',
      'exec /bin/sh -c "$*"',
      '',
    ].join('\n'), { mode: 0o755 });
    const result = spawnSync('bash', [join(site, 'deploy', 'deploy.sh')], {
      encoding: 'utf8',
      env: { PATH: `${shims}:${process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin'}`, ...(process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH } : {}), HOME: root, SITE_SSH_TARGET: 'deploy@site.test', SITE_REMOTE_DIR: remote, SITE_SSH_KEY: join(root, 'key') },
    });
    expect({ status: result.status, output: `${result.stdout}${result.stderr}` }).toEqual({ status: 0, output: `${result.stdout}${result.stderr}` });
    expect(readFileSync(join(remote, 'releases', '1.0.0-rc.1', 'olympus-1.0.0-rc.1.tgz'), 'utf8')).toBe('rc.1');
    expect(readFileSync(join(remote, 'releases', '1.0.0-rc.2', 'olympus-1.0.0-rc.2.tgz'), 'utf8')).toBe('rc.2');
    expect(readFileSync(join(remote, 'install.sh'), 'utf8')).toBe('new installer');
    expect(existsSync(join(remote, 'stale.html'))).toBe(false);
    expect(existsSync(join(remote, 'deploy'))).toBe(false);
  });
});

describe('the Bun program pin', () => {
  const zipBun = (dir: string, program: string): string => {
    mkdirSync(join(dir, 'bun-darwin-aarch64'), { recursive: true });
    writeFileSync(join(dir, 'bun-darwin-aarch64', 'bun'), program, { mode: 0o755 });
    const zip = join(dir, 'bun-darwin-aarch64.zip');
    expect(spawnSync('zip', ['-qr', zip, 'bun-darwin-aarch64'], { cwd: dir }).status).toBe(0);
    return zip;
  };

  test('the template pins the archive and the program inside it', () => {
    const pins = readBunPins(TEMPLATE);
    expect(pins).toBeDefined();
    expect(pins!.zipSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pins!.exeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(pins!.exeSha256).not.toBe(pins!.zipSha256);
  });

  test.skipIf(!has('zip') || !has('unzip'))('computes the program digest only from the pinned archive, and writes it into the template', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-bun-pin-'));
    roots.push(dir);
    const zip = zipBun(dir, '#!/bin/sh\necho fake bun\n');
    const zipPins = { zipSha256: createHash('sha256').update(readFileSync(zip)).digest('hex'), zipBytes: readFileSync(zip).length };
    const program = createHash('sha256').update('#!/bin/sh\necho fake bun\n').digest('hex');
    expect(bunExecutableDigest(zip, zipPins)).toBe(program);
    expect(() => bunExecutableDigest(zip, { ...zipPins, zipSha256: '0'.repeat(64) })).toThrow('is not the pinned Bun archive');
    expect(() => bunExecutableDigest(zip, { ...zipPins, zipBytes: zipPins.zipBytes + 1 })).toThrow('is not the pinned Bun archive');
    const pinned = pinBunExecutable(TEMPLATE, program);
    expect(readBunPins(pinned)?.exeSha256).toBe(program);
    expect(pinned.split('\n').filter((line, index) => line !== TEMPLATE.split('\n')[index])).toEqual([`BUN_EXE_SHA256_DARWIN_AARCH64=${program}`]);
    expect(() => pinBunExecutable(TEMPLATE, 'A'.repeat(64))).toThrow('64 lowercase hex');
  });
});
