// OLYMPUS_TEST_LANE: deploy
// The driver seam: the harness talks to any executable that implements the verbs, and
// leaves nothing behind when a run fails. A fake driver stands in for a real machine.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandDriver, parseProvisionLine } from '../scripts/release-check/machine.ts';
import { newRunId, parseAgentLine, runReleaseCheck, type RunConfigFile } from '../scripts/release-check/run.ts';
import { PRIVATE_MARKER, SECRET_MARKER } from '../scripts/release-check/fixture.ts';

let dir: string;
let driverPath: string;
let logPath: string;
const saved = { log: process.env.FAKE_DRIVER_LOG, fail: process.env.FAKE_DRIVER_FAIL, failDestroy: process.env.FAKE_DRIVER_FAIL_DESTROY, leak: process.env.FAKE_DRIVER_DESTROY_LEAK };

const FAKE_DRIVER = `#!/usr/bin/env bash
verb="$1"; shift
echo "$verb $*" >> "$FAKE_DRIVER_LOG"
case "$verb" in
  provision)
    [ "\${FAKE_DRIVER_FAIL:-}" = "1" ] && { echo "image pull failed" >&2; exit 1; }
    echo "Pulling image: 12%"; printf '\\r....\\r'
    run_id=""; while [ $# -gt 0 ]; do [ "$1" = "--run-id" ] && run_id="$2"; shift; done
    echo "{\\"machine\\":\\"fake-$run_id\\",\\"label\\":\\"Fake machine\\",\\"os\\":\\"linux\\",\\"driver\\":\\"fake\\"}" ;;
  exec) cat > /dev/null ;;
  put|get|reap) ;;
  upgrade) if [ "\${FAKE_DRIVER_FAIL_UPGRADE:-}" = "1" ]; then echo "installer failed" >&2; exit 1; fi ;;
  destroy)
    if [ -n "\${FAKE_DRIVER_DESTROY_LEAK:-}" ]; then echo "CLEANUP FAILED: fake-machine may still exist (\$FAKE_DRIVER_DESTROY_LEAK)" >&2; exit 1; fi
    if [ "\${FAKE_DRIVER_FAIL_DESTROY:-}" = "1" ]; then echo "checking" >&2; echo "CLEANUP FAILED: fake-machine may still exist on host (listing failed). Remove it by hand: ssh host 'lxc delete fake-machine --force'" >&2; exit 1; fi ;;
  *) exit 64 ;;
esac
`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rc-driver-test-'));
  driverPath = join(dir, 'driver.sh');
  logPath = join(dir, 'driver.log');
  writeFileSync(driverPath, FAKE_DRIVER);
  chmodSync(driverPath, 0o755);
  writeFileSync(logPath, '');
  process.env.FAKE_DRIVER_LOG = logPath;
  delete process.env.FAKE_DRIVER_FAIL;
  delete process.env.FAKE_DRIVER_FAIL_DESTROY;
  delete process.env.FAKE_DRIVER_DESTROY_LEAK;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of [['FAKE_DRIVER_LOG', saved.log], ['FAKE_DRIVER_FAIL', saved.fail], ['FAKE_DRIVER_FAIL_DESTROY', saved.failDestroy], ['FAKE_DRIVER_DESTROY_LEAK', saved.leak]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const driverLog = (): string[] => readFileSync(logPath, 'utf8').split('\n').filter(Boolean);

describe('provision line', () => {
  test('is found even when a progress meter is glued to it', () => {
    const info = parseProvisionLine('Pushing 40%\r{"machine":"rcv-1","label":"Box","os":"linux","driver":"lxd"}\n');
    expect(info).toEqual({ handle: 'rcv-1', label: 'Box', os: 'linux', driver: 'lxd' });
  });

  test('refuses output without a machine, an unsafe handle, or an unknown os', () => {
    expect(() => parseProvisionLine('nothing here')).toThrow('did not end with a JSON line');
    expect(() => parseProvisionLine('{"machine":"a b; rm","os":"linux"}')).toThrow('unusable machine handle');
    expect(() => parseProvisionLine('{"machine":"ok","os":"plan9"}')).toThrow('unknown os');
  });

  test('falls back to the handle for a missing label and a generic driver name', () => {
    expect(parseProvisionLine('{"machine":"m1","os":"macos"}')).toEqual({ handle: 'm1', label: 'm1', os: 'macos', driver: 'driver' });
  });
});

describe('command driver', () => {
  test('provisions, runs verbs against the handle, and destroys by handle or by run id', async () => {
    const lines: string[] = [];
    const driver = new CommandDriver({ argv: [driverPath], onLog: (line) => lines.push(line) });
    const machine = await driver.provision({ runId: 'run1', candidateDir: dir, workdir: dir, timeoutMs: 20_000 });
    expect(machine).toMatchObject({ handle: 'fake-run1', label: 'Fake machine', os: 'linux' });
    // Redrawn meters and bare dots are dropped from the diagnostics.
    expect(lines.some((line) => line.includes('Pulling image: 12%'))).toBe(false);
    expect(lines.some((line) => /^\.+$/.test(line))).toBe(false);

    const out = await machine.exec('echo hi\n', { timeoutMs: 10_000 });
    expect(out.code).toBe(0);
    await machine.put('/a', '~/b');
    await machine.get('~/c', '/d');
    await driver.destroy({ handle: machine.handle });
    await driver.destroy({ runId: 'run1' });
    await driver.reap(30);
    expect(driverLog()).toEqual([
      `provision --run-id run1 --candidate ${dir} --workdir ${dir}`,
      'exec --machine fake-run1 --timeout-s 10',
      'put --machine fake-run1 --from /a --to ~/b',
      'get --machine fake-run1 --from ~/c --to /d',
      'destroy --machine fake-run1',
      'destroy --run-id run1',
      'reap --older-than-min 30',
    ]);
  });

  test('upgrade runs the driver verb against the handle with the newer bundle, and a failed installer is an error', async () => {
    const driver = new CommandDriver({ argv: [driverPath] });
    const machine = await driver.provision({ runId: 'run2', candidateDir: dir, workdir: dir, timeoutMs: 20_000 });
    await machine.upgrade('/newer/bundle');
    expect(driverLog().filter((line) => line.startsWith('upgrade'))).toEqual(['upgrade --machine fake-run2 --candidate /newer/bundle']);
    process.env.FAKE_DRIVER_FAIL_UPGRADE = '1';
    try {
      await expect(machine.upgrade('/newer/bundle')).rejects.toThrow('driver upgrade failed (exit 1)');
    } finally {
      delete process.env.FAKE_DRIVER_FAIL_UPGRADE;
    }
  });

  test('a failed provision is an error and a failed destroy is an error', async () => {
    const driver = new CommandDriver({ argv: [driverPath] });
    process.env.FAKE_DRIVER_FAIL = '1';
    await expect(driver.provision({ runId: 'r', candidateDir: dir, workdir: dir, timeoutMs: 20_000 })).rejects.toThrow('driver provision failed (exit 1)');
    const missing = new CommandDriver({ argv: [join(dir, 'nope.sh')] });
    await expect(missing.destroy({ runId: 'r' })).rejects.toThrow('driver destroy failed');
  });
});

describe('a cleanup the driver could not confirm', () => {
  test('the failure carries the driver\'s last line: the machine and the manual command', async () => {
    process.env.FAKE_DRIVER_FAIL_DESTROY = '1';
    const driver = new CommandDriver({ argv: [driverPath] });
    const failure = await driver.destroy({ handle: 'fake-machine' }).then(() => undefined, (error: Error) => error.message);
    expect(failure).toContain('driver destroy failed (exit 1): CLEANUP FAILED: fake-machine may still exist');
    expect(failure).toContain("ssh host 'lxc delete fake-machine --force'");
    expect(failure).not.toContain('checking');
  });
});

describe('run helpers', () => {
  test('the agent line is the last JSON object on stdout', () => {
    expect(parseAgentLine('noise\n{"ok":true,"n":1}\nmore noise\n')).toEqual({ ok: true, n: 1 });
    expect(parseAgentLine('{"a":1}\n{broken\n')).toEqual({ a: 1 });
    expect(parseAgentLine('nothing')).toBeUndefined();
  });

  test('run ids are sortable timestamps with a random suffix', () => {
    const a = newRunId(new Date('2026-10-14T21:50:08Z'));
    expect(a).toMatch(/^20261014t215008-[0-9a-f]{4}$/);
    expect(newRunId(new Date('2026-10-14T21:50:08Z'))).not.toBe(a);
  });
});

describe('teardown', () => {
  function options(extra: Record<string, unknown> = {}) {
    const runId = newRunId();
    const config: RunConfigFile = { driver: [driverPath], agents: [], settleTimeoutS: 5 };
    return { runId, candidateDir: dir, candidateLabel: 'test', outDir: join(dir, 'out', runId), config, skipRelay: true, skipScreenshots: true, ...extra };
  }

  test('a failure after the machine exists still destroys it, and the report fails with the reason', async () => {
    const opts = options({ failAfterProvision: true });
    const report = await runReleaseCheck(opts);
    expect(report.verdict).toBe('fail');
    expect(report.errors.join(' ')).toContain('simulated failure after provision');
    expect(driverLog().some((line) => line === `destroy --machine fake-${opts.runId}`)).toBe(true);
    expect(existsSync(join(opts.outDir, 'report.json'))).toBe(true);
    expect(readFileSync(join(opts.outDir, 'report.html'), 'utf8')).toContain('FAIL');
    // The finished report holds no Private content.
    expect(readFileSync(join(opts.outDir, 'report.json'), 'utf8')).not.toContain(PRIVATE_MARKER);
  }, 120_000);

  test('a provision that never returned a handle is destroyed by run id', async () => {
    process.env.FAKE_DRIVER_FAIL = '1';
    const opts = options();
    const report = await runReleaseCheck(opts);
    expect(report.verdict).toBe('fail');
    expect(driverLog().some((line) => line === `destroy --run-id ${opts.runId}`)).toBe(true);
  }, 120_000);

  test('a teardown the driver could not confirm fails the run, and the report names the machine and the manual command', async () => {
    process.env.FAKE_DRIVER_FAIL_DESTROY = '1';
    const opts = options({ failAfterProvision: true });
    const report = await runReleaseCheck(opts);
    expect(report.verdict).toBe('fail');
    const text = report.errors.join(' ');
    expect(text).toContain('teardown failed');
    expect(text).toContain('CLEANUP FAILED: fake-machine may still exist');
    expect(text).toContain("lxc delete fake-machine --force");
    expect(readFileSync(join(opts.outDir, 'report.html'), 'utf8')).toContain('CLEANUP FAILED');
  }, 120_000);

  test('driver stderr that carries a Private and a Secret marker fails the run, and neither reaches report.json or report.html', async () => {
    process.env.FAKE_DRIVER_DESTROY_LEAK = `${PRIVATE_MARKER} and ${SECRET_MARKER}`;
    const opts = options({ failAfterProvision: true });
    const report = await runReleaseCheck(opts);
    expect(report.verdict).toBe('fail');
    // The scan still fails the run on the hit...
    const scan = report.machines[0]!.checks.find((c) => c.id === 'scan.report');
    expect(scan?.status).toBe('fail');
    expect(scan?.detail).toContain('private-marker');
    expect(scan?.detail).toContain('secret-marker');
    // ...and the written report holds the redaction, not the text, in every file it wrote.
    for (const file of ['report.json', 'report.html', join('logs', 'run.log')]) {
      const text = readFileSync(join(opts.outDir, file), 'utf8');
      expect(text, file).not.toContain(PRIVATE_MARKER);
      expect(text, file).not.toContain(SECRET_MARKER);
    }
    expect(readFileSync(join(opts.outDir, 'report.json'), 'utf8')).toContain('[redacted:private-marker]');
    // The returned report is the written one.
    expect(JSON.stringify(report)).not.toContain(PRIVATE_MARKER);
    expect(JSON.stringify(report)).not.toContain(SECRET_MARKER);
  }, 120_000);

  test('--keep-machine leaves the machine and fails the run so it cannot pass for release evidence', async () => {
    const opts = options({ failAfterProvision: true, keepMachine: true });
    const report = await runReleaseCheck(opts);
    expect(driverLog().some((line) => line.startsWith('destroy'))).toBe(false);
    expect(report.errors.join(' ')).toContain('was kept for debugging');
    expect(report.verdict).toBe('fail');
  }, 120_000);
});
