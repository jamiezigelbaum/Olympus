import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const HELPER = join(
  import.meta.dir,
  '..',
  'scripts',
  'ops',
  'lib',
  'systemd-activity-classifier.sh',
);

const R29_ACTIVITY_MATRIX: Array<{
  label: string;
  output: string;
  exit: number;
  expected: 'trusted-active' | 'trusted-inactive' | 'untrusted/error';
}> = [
  { label: 'inactive/3 after stop success', output: 'inactive', exit: 3, expected: 'trusted-inactive' },
  { label: 'failed/3 after stop success', output: 'failed', exit: 3, expected: 'trusted-inactive' },
  { label: 'active/0 after stop success', output: 'active', exit: 0, expected: 'trusted-active' },
  { label: 'active/0 after stop failure', output: 'active', exit: 0, expected: 'trusted-active' },
  { label: 'unknown/4 after stop success', output: 'unknown', exit: 4, expected: 'untrusted/error' },
  { label: 'DBus error/7 after stop success', output: 'Failed to connect to bus', exit: 7, expected: 'untrusted/error' },
  { label: 'active/7 after stop success', output: 'active', exit: 7, expected: 'untrusted/error' },
  { label: 'DBus error/7 after stop failure', output: 'Failed to connect to bus', exit: 7, expected: 'untrusted/error' },
  { label: 'inactive/3 after stop failure', output: 'inactive', exit: 3, expected: 'trusted-inactive' },
  { label: 'inactive/0 after stop success', output: 'inactive', exit: 0, expected: 'untrusted/error' },
];

describe('shared systemd activity classifier', () => {
  test.each(R29_ACTIVITY_MATRIX)('$label => $expected', ({ output, exit, expected }) => {
    const root = mkdtempSync(join(tmpdir(), 'olympus-systemd-activity-'));
    const bin = join(root, 'bin');
    const systemctl = join(bin, 'systemctl');
    const verdict = join(root, 'verdict');
    const harness = join(root, 'harness.sh');
    mkdirSync(bin, { recursive: true });
    writeFileSync(systemctl, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `printf '%s\\n' ${shellQuote(output)}`,
      `exit ${exit}`,
    ].join('\n'));
    chmodSync(systemctl, 0o755);
    writeFileSync(harness, [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `SYSTEMD_ACTIVITY_SYSTEMCTL_BIN=${shellQuote(systemctl)}`,
      `source ${shellQuote(HELPER)}`,
      'systemd_classify_unit_activity olympus-proof.service',
      `printf '%s\\n' "$SYSTEMD_ACTIVITY_CLASSIFICATION" > ${shellQuote(verdict)}`,
    ].join('\n'));

    const proc = Bun.spawnSync(['bash', harness], { stdout: 'pipe', stderr: 'pipe' });
    expect(proc.exitCode).toBe(0);
    expect(readFileSync(verdict, 'utf8').trim()).toBe(expected);
  });
});

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
