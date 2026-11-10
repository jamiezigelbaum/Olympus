// The run command's own argument rules: a harness commit is recorded, and one that is not the candidate's is refused up front.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { engineSplitCheck, parseCli } from '../scripts/release-check/run.ts';
import { engineRolesIn, turnOnEngineSplit } from '../scripts/release-check/machine-agent.ts';
import { buildReport, renderHtml } from '../scripts/release-check/report.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

function withConfig<T>(body: (args: string[]) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'rc-cli-test-'));
  try {
    const config = join(dir, 'config.json');
    writeFileSync(config, JSON.stringify({ driver: ['/bin/true'] }));
    return body(['--config', config, '--candidate', dir, '--out', join(dir, 'out')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('release-check run command arguments', () => {
  test('a harness commit is carried into the options; none means an unpinned run', () => {
    withConfig((base) => {
      expect(parseCli([...base, '--sha', A, '--harness-commit', A]).harnessCommit).toBe(A);
      expect(parseCli([...base, '--harness-commit', B]).harnessCommit).toBe(B);
      expect(parseCli(base).harnessCommit).toBeUndefined();
    });
  });

  test('a harness commit that is not the candidate\'s sha, or not a full commit, is refused before anything starts', () => {
    withConfig((base) => {
      expect(() => parseCli([...base, '--sha', A, '--harness-commit', B])).toThrow("is not the candidate's --sha");
      expect(() => parseCli([...base, '--harness-commit', 'abc123'])).toThrow('40-character');
    });
  });

  test('the archive-import leg is on unless --skip-archive leaves it out, and the usage names the flag', () => {
    withConfig((base) => {
      expect(parseCli(base).skipArchive).toBe(false);
      expect(parseCli([...base, '--skip-archive']).skipArchive).toBe(true);
      let usage = '';
      try { parseCli([]); } catch (error) { usage = (error as Error).message; }
      expect(usage).toContain('--skip-archive');
    });
  });

  test('the Mac server-mode leg is on unless --skip-server-mode leaves it out, and the usage names the flag', () => {
    withConfig((base) => {
      expect(parseCli(base).skipServerMode).toBe(false);
      expect(parseCli([...base, '--skip-server-mode']).skipServerMode).toBe(true);
      let usage = '';
      try { parseCli([]); } catch (error) { usage = (error as Error).message; }
      expect(usage).toContain('--skip-server-mode');
    });
  });

  test('--engine-split is off unless named, is refused with a kept run or new baselines, and the usage names it', () => {
    withConfig((base) => {
      expect(parseCli(base).engineSplit).toBeUndefined();
      expect(parseCli([...base, '--engine-split']).engineSplit).toBe(true);
      expect(() => parseCli([...base, '--engine-split', '--baselines', base[3]!, '--update-baselines'])).toThrow('--engine-split');
      const changed = join(base[3]!, 'changed.txt');
      writeFileSync(changed, 'src/cli.ts\n');
      expect(() => parseCli([...base, '--engine-split', '--carry-from', join(base[3]!, 'report.json'), '--changed-files', changed])).toThrow('drop --engine-split');
      let usage = '';
      try { parseCli([]); } catch (error) { usage = (error as Error).message; }
      expect(usage).toContain('--engine-split');
    });
  });
});

describe('the engine split on the install under test', () => {
  test('turning the switch on keeps every other setting and the file stays owner-only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-split-test-'));
    try {
      const path = join(dir, 'engine.json');
      writeFileSync(path, JSON.stringify({ olympusStandalone: true, worker: { service: { enabled: true }, scheduler: { enabled: true } }, email: { x: 1 } }), { mode: 0o600 });
      turnOnEngineSplit(path);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ olympusStandalone: true, worker: { service: { enabled: true }, scheduler: { enabled: true }, engineSplit: true }, email: { x: 1 } });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(() => turnOnEngineSplit(join(dir, 'missing.json'))).toThrow('does not exist');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the roles are counted from process environments, and the check passes only with both', () => {
    const env = (role?: string) => ['HOME=/home/u', ...(role ? [`OLYMPUS_WORKER_ENGINE_ROLE=${role}`] : []), 'PATH=/bin'].join('\0');
    const roles = engineRolesIn([env('front'), env('background'), env(), env('single')]);
    expect(roles).toEqual({ front: 1, background: 1 });
    expect(engineSplitCheck(roles).status).toBe('pass');
    expect(engineSplitCheck({ front: 1, background: 0 }).status).toBe('fail');
    expect(engineSplitCheck(undefined).status).toBe('fail');
    expect(engineSplitCheck(null).status).toBe('warn');
  });

  test('the report records and shows that the switch was on', () => {
    const report = buildReport({ runId: 'r', candidate: { label: 'c' }, startedAt: 'a', finishedAt: 'b', machines: [], errors: [], settings: { engineSplit: true } });
    expect(report.settings).toEqual({ engineSplit: true });
    expect(renderHtml(report)).toContain('Engine split on');
  });
});

