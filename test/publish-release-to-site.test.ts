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
  checkSiteRelease,
  pinBunExecutable,
  publishToSite,
  readBunPins,
  readInstallScriptPins,
  releaseTarballPath,
  renderInstallScript,
} from '../scripts/publish-release-to-site.ts';

const REPO = resolve(import.meta.dir, '..');
const TEMPLATE = readFileSync(join(REPO, 'scripts', 'install-macos.sh'), 'utf8');
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
  });

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
  });

  test('refuses a tarball whose name or packaged identity is not the source version', () => {
    const wrongName = fixture();
    const renamed = join(wrongName.root, 'olympus-1.0.0-rc.2.tgz');
    copyFileSync(wrongName.artifact, renamed);
    expect(() => publishToSite({ root: wrongName.root, artifact: renamed })).toThrow('is not olympus-1.0.0-rc.1.tgz');
    const wrongPackage = fixture('1.0.0-rc.1', { name: 'olympus', version: '1.0.0-rc.0' });
    expect(() => publishToSite(wrongPackage)).toThrow('packages olympus@1.0.0-rc.0, not olympus@1.0.0-rc.1');
    const wrongNamePackage = fixture('1.0.0-rc.1', { name: 'olympus-source-checkout', version: '1.0.0-rc.1' });
    expect(() => publishToSite(wrongNamePackage)).toThrow('not olympus@1.0.0-rc.1');
  });

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
  });
});

describe('site publishing wiring', () => {
  test('the served installer and tarballs are build products, never committed', () => {
    const ignore = readFileSync(join(REPO, '.gitignore'), 'utf8').split('\n');
    expect(ignore).toContain('site/install.sh');
    expect(ignore).toContain('site/releases/');
    const tracked = spawnSync('git', ['ls-files', 'site/install.sh', 'site/releases'], { cwd: REPO, encoding: 'utf8' });
    expect(tracked.stdout.trim()).toBe('');
  });

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
      env: { PATH: `${shims}:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: root, SITE_SSH_TARGET: 'deploy@site.test', SITE_REMOTE_DIR: remote, SITE_SSH_KEY: join(root, 'key') },
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
