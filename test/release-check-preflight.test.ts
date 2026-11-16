import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, firstStatus, OLD_STATUS_WAIT_MS, oldInstallBundle, oldInstallerStatusRetry, preflightProbes, verifyStagedBundle } from '../scripts/release-check/preflight.ts';
import { createTestClock } from './helpers/test-clock.ts';

const dirs: string[] = [];
const scratch = () => { const dir = mkdtempSync(join(tmpdir(), 'rc-preflight-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const oldStatus = String.raw`  "$WORK/bun" --no-env-file "$WORK/unpacked/package/dist/cli.js" engine status > "$WORK/status.json" \
    || die 'Lifecycle status failed; do not treat this as a healthy installation.'`;

describe('old-release startup allowance', () => {
  test('status can answer after the candidate bound, but never gets more than 120 seconds', async () => {
    for (const readyAt of [0, 90_000, Infinity]) {
      const clock = createTestClock(0);
      const reads: number[] = [];
      const reply = firstStatus({ now: clock.now, sleep: clock.sleep,
        read: remaining => { reads.push(remaining); return clock.now() >= readyAt; }, answers: Boolean }, OLD_STATUS_WAIT_MS);
      await clock.advance(120_000);
      expect(await reply).toBe(Number.isFinite(readyAt));
      expect(reads[0]).toBe(120_000);
      expect(reads.every(ms => ms > 0 && ms <= 120_000)).toBe(true);
      expect(reads.length).toBe(readyAt === 0 ? 1 : readyAt === 90_000 ? 31 : 40);
    }
  });

  test('the candidate retains its shorter status bound', async () => {
    const clock = createTestClock(0);
    let attempts = 0;
    const reply = firstStatus({ now: clock.now, sleep: clock.sleep, read: () => { attempts++; return clock.now() >= 90_000; }, answers: Boolean }, 45_000);
    await clock.advance(45_000);
    expect(await reply).toBe(false);
    expect(attempts).toBe(15);
  });

  test('the historical installer retry runs for real, recovers or fails at its deadline without reinstalling', () => {
    for (const failUntil of [0, 2, 100]) {
      const dir = scratch();
      const bin = join(dir, 'bin'); mkdirSync(bin);
      writeFileSync(join(dir, 'clock'), '0'); writeFileSync(join(dir, 'calls'), '0');
      const executable = (path: string, script: string) => { writeFileSync(path, '#!/bin/sh\n' + script); chmodSync(path, 0o700); };
      executable(join(bin, 'date'), 'cat "$WORK/clock"\n');
      executable(join(bin, 'sleep'), 'n=$(cat "$WORK/clock"); echo $((n + $1)) > "$WORK/clock"\n');
      executable(join(bin, 'timeout'), 'shift; exec "$@"\n');
      executable(join(dir, 'bun'), `n=$(cat "$WORK/calls"); n=$((n + 1)); echo "$n" > "$WORK/calls"; [ "$n" -gt ${failUntil} ] || exit 1; echo '{"ok":true}'\n`);
      const script = 'die() { echo "$*" >&2; exit 1; }\n' + oldInstallerStatusRetry(oldStatus) + '\ncat "$WORK/status.json"\n';
      const result = Bun.spawnSync(['sh', '-c', script], { env: { ...process.env, WORK: dir, PATH: `${bin}:${process.env.PATH}` } });
      expect(result.exitCode).toBe(failUntil < 100 ? 0 : 1);
      if (failUntil < 100) {
        expect(result.stdout.toString()).toContain('"ok":true');
        expect(Number(readFileSync(join(dir, 'calls'), 'utf8'))).toBe(failUntil + 1);
      } else {
        expect(result.stderr.toString()).toContain('setup.old-install');
        expect(Number(readFileSync(join(dir, 'clock'), 'utf8'))).toBe(120);
      }
    }
  }, 30_000);

  test('only a scratch copy of the old installer changes, with matching manifest; modern and candidate inputs stay intact', () => {
    const dir = scratch(), source = join(dir, 'old'); mkdirSync(source);
    writeFileSync(join(source, 'install-linux.sh'), oldStatus);
    writeFileSync(join(source, 'olympus-1.4.4.tgz'), 'unchanged release');
    writeFileSync(join(source, 'SHA256SUMS'), `${digest(join(source, 'install-linux.sh'))}  install-linux.sh\n${digest(join(source, 'olympus-1.4.4.tgz'))}  olympus-1.4.4.tgz\n`);
    const copy = oldInstallBundle(source, dir);
    expect(copy).not.toBe(source);
    expect(readFileSync(join(source, 'install-linux.sh'), 'utf8')).toBe(oldStatus);
    expect(digest(join(copy, 'olympus-1.4.4.tgz'))).toBe(digest(join(source, 'olympus-1.4.4.tgz')));
    expect(readFileSync(join(copy, 'SHA256SUMS'), 'utf8')).toContain(digest(join(copy, 'install-linux.sh')));
    const modern = 'status_wait=${OLYMPUS_INSTALL_STATUS_WAIT_S:-45}\n';
    expect(oldInstallerStatusRetry(modern)).toBe(modern);
    writeFileSync(join(source, 'install-linux.sh'), modern);
    expect(oldInstallBundle(source, dir)).toBe(source);
  });
});

describe('staged candidate on the leg machine', () => {
  function bundle() {
    const boundary = scratch(), root = join(boundary, 'candidate'); mkdirSync(root, { mode: 0o700 });
    const tar = join(root, 'olympus-1.5.0.tgz'); writeFileSync(tar, 'candidate', { mode: 0o600 });
    writeFileSync(join(root, 'SHA256SUMS'), `${digest(tar)}  olympus-1.5.0.tgz\n`, { mode: 0o600 });
    return { boundary, root, tar };
  }
  test('accepts exact checksums and private paths', () => {
    const { boundary, root } = bundle();
    expect(() => verifyStagedBundle(root, boundary)).not.toThrow();
    // The real root check must include /tmp, which is intentionally world writable.
    expect(() => verifyStagedBundle(root)).toThrow('unsafe staged path');
  });
  test('rejects corruption, writable files/directories/ancestors, symlinks and missing checksums', () => {
    for (const change of ['hash', 'file', 'directory', 'ancestor', 'link', 'unpinned', 'missing', 'traversal']) {
      const { boundary, root, tar } = bundle();
      if (change === 'hash') writeFileSync(tar, 'corrupt');
      if (change === 'file') chmodSync(tar, 0o620);
      if (change === 'directory') chmodSync(root, 0o702);
      if (change === 'ancestor') chmodSync(boundary, 0o720);
      if (change === 'link') symlinkSync(tar, join(root, 'link'));
      if (change === 'unpinned') writeFileSync(join(root, 'SHA256SUMS'), `${digest(tar)}  SHA256SUMS\n`);
      if (change === 'missing') rmSync(join(root, 'SHA256SUMS'));
      if (change === 'traversal') writeFileSync(join(root, 'SHA256SUMS'), `${digest(tar)}  ../escape\n`);
      expect(() => verifyStagedBundle(root, boundary)).toThrow();
    }
  });
  test('each probe failure stops the following probes', async () => {
    for (const failed of ['bundle', 'browser', 'protocol']) {
      const calls: string[] = [];
      const probe = (name: string) => async () => { calls.push(name); if (name === failed) throw new Error('unavailable'); };
      await expect(preflightProbes({ bundle: probe('bundle'), browser: probe('browser'), protocol: probe('protocol') })).rejects.toThrow(`${failed}: unavailable`);
      expect(calls.at(-1)).toBe(failed);
    }
  });
});
