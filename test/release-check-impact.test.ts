// An incremental release check: a change re-runs the legs it can reach and keeps the tested run's results for the rest.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { harnessReach, planImpact } from '../scripts/release-check/impact.ts';
import { carryInto, copyCarriedFiles, LEG_SKIPPED, loadCarryBase } from '../scripts/release-check/carry.ts';
import { buildReport, renderHtml, type MachineReport, type ReleaseReport } from '../scripts/release-check/report.ts';
import { parseCli } from '../scripts/release-check/run.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const reach = harnessReach(join(import.meta.dir, '..'));

function machine(over: Partial<MachineReport> = {}): MachineReport {
  return { id: 'm', label: 'Linux VM', os: 'linux', driver: 'lxd', timings: {}, checks: [], agents: [], screenshots: [], logs: [], ...over };
}

function tested(over: Partial<MachineReport> = {}): ReleaseReport {
  return buildReport({
    runId: 'run-base', candidate: { label: 'c', sha: A }, startedAt: 't0', finishedAt: 't1', errors: [], harnessCommit: A,
    machines: [machine({
      checks: [
        { id: 'install', title: 'installed', status: 'pass' },
        { id: 'archive.import', title: 'archive imported', status: 'pass' },
        { id: 'journey.inbox-delete-one', title: 'delete one', status: 'fail', detail: 'broke' },
        { id: 'scan.report', title: 'scan', status: 'pass' },
      ],
      agents: [
        { id: 'claude', label: 'Claude', kind: 'model', ran: true, checks: [{ id: 'q1', title: 'q1', status: 'pass' }] },
        { id: 'chatgpt-protocol', label: 'protocol', kind: 'protocol', ran: true, checks: [{ id: 'p1', title: 'p1', status: 'pass' }] },
      ],
      visual: [],
      ...over,
    })],
  });
}

describe('which legs a change reaches', () => {
  test('docs, tests and built output alone reach no leg, so only the install and setup checks run again', () => {
    const plan = planImpact(['docs/x.md', 'test/a.test.ts', 'dist/index.js', 'README.md', 'config/dashboard-design-review.json'], reach);
    expect(plan.mode).toBe('none');
    expect(plan.run).toEqual([]);
    expect(plan.skipFlags).toContain('--skip-suite');
  });

  test('an archive-import change runs only the archive leg; harness code no VM leg runs reaches nothing', () => {
    const plan = planImpact(['src/workers/archive-import/zip.ts', 'scripts/release-check/web-clients.ts', 'scripts/release-check/canary.ts'], reach);
    expect(plan.mode).toBe('partial');
    expect(plan.run).toEqual(['archive']);
    expect(plan.files.find((f) => f.file.endsWith('web-clients.ts'))!.legs).toEqual([]);
  });

  test('harness code reached only through a side-effect import still reaches its leg', () => {
    expect(reach.has('scripts/release-check/archive-live-seed-hooks.ts')).toBe(true);
    expect(planImpact(['scripts/release-check/archive-live-seed-hooks.ts'], reach).run).toEqual(['archive']);
  });

  test('a dashboard change runs the screens, the archive leg that drives them, and everything their pictures depend on', () => {
    expect(planImpact(['src/workers/dashboard/inbox.ts'], reach).mode).toBe('full');
  });

  test('test support the harness imports reaches the machine; other tests do not', () => {
    const fixture = [...reach].find((file) => file.startsWith('test/support/archive-fixtures'));
    expect(fixture).toBeDefined();
    expect(planImpact([fixture!], reach).mode).toBe('full');
    expect(planImpact(['test/release-check-impact.test.ts'], reach).mode).toBe('none');
  });

  test('a file no rule maps, or the harness core, is a full run', () => {
    expect(planImpact(['src/core/anything-else.ts'], reach).mode).toBe('full');
    expect(planImpact(['package.json'], reach).mode).toBe('full');
    expect(planImpact(['scripts/release-check/run.ts', 'docs/a.md'], reach).mode).toBe('full');
    expect(planImpact(['scripts/release-check/machine-agent.ts'], reach).mode).toBe('full');
  });
});

describe('keeping the tested run\'s results', () => {
  test('what the new run left out is kept and marked; what it ran is its own; the report link files come along', () => {
    const base = tested();
    const now = machine({
      checks: [{ id: 'install', title: 'installed', status: 'pass', detail: 'new' }, { id: 'journey.agent-never-expired', title: 'x', status: 'skip', detail: `needs the suite leg, ${LEG_SKIPPED}` }],
      agents: [{ id: 'chatgpt-protocol', label: 'protocol', kind: 'protocol', ran: false, skipReason: 'skipped by option', checks: [] }],
    });
    const parts = carryInto(now, base.machines[0]!, { runId: 'run-base', sha: A });
    expect(now.checks.find((c) => c.id === 'install')).toEqual({ id: 'install', title: 'installed', status: 'pass', detail: 'new' });
    expect(now.checks.find((c) => c.id === 'archive.import')!.carried).toEqual({ runId: 'run-base', sha: A });
    expect(now.checks.some((c) => c.id === 'scan.report')).toBe(false);
    expect(now.agents.map((a) => [a.id, a.ran, a.carried?.sha])).toEqual([['chatgpt-protocol', true, A], ['claude', true, A]]);
    expect(parts).toEqual(['screen comparisons']);
    // A kept failure still fails the run.
    const report = buildReport({ runId: 'run-new', candidate: { label: 'c', sha: B }, startedAt: 't0', finishedAt: 't1', errors: [], harnessCommit: B, machines: [now] });
    expect(report.verdict).toBe('fail');
    expect(renderHtml(report)).toContain('kept from aaaaaaaa');
  });

  test('a run on another platform cannot lend its results', () => {
    expect(() => carryInto(machine({ os: 'macos' }), tested().machines[0]!, { runId: 'r', sha: A })).toThrow('linux run');
  });

  test('only a plain run pinned to its own commit, of another commit, can be a base', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-carry-'));
    try {
      const write = (report: unknown): string => { const p = join(dir, `${Math.random()}.json`); writeFileSync(p, JSON.stringify(report)); return p; };
      expect(loadCarryBase(write(tested()), B).runId).toBe('run-base');
      expect(() => loadCarryBase(write(tested()), A)).toThrow('same commit');
      expect(() => loadCarryBase(write(tested()), undefined)).toThrow('--sha');
      expect(() => loadCarryBase(write({ ...tested(), selfTest: 'x' }), B)).toThrow('self-test');
      expect(() => loadCarryBase(write({ ...tested(), harness: { relation: 'unpinned' } }), B)).toThrow('own commit');
      // The tested run's pictures are copied beside the new report without replacing the new run's own.
      const baseDir = join(dir, 'base');
      mkdirSync(join(baseDir, 'visual'), { recursive: true });
      writeFileSync(join(baseDir, 'visual', 'keys.png'), 'old');
      writeFileSync(join(baseDir, 'report.json'), '{}');
      const out = join(dir, 'out');
      mkdirSync(out);
      copyCarriedFiles(join(baseDir, 'report.json'), out);
      expect(existsSync(join(out, 'visual', 'keys.png'))).toBe(true);
      expect(existsSync(join(out, 'report.json'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the command line takes the plan\'s skips and refuses anything else that changes what runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rc-carry-cli-'));
    try {
      const config = join(dir, 'config.json');
      writeFileSync(config, JSON.stringify({ driver: ['/bin/true'] }));
      const basePath = join(dir, 'base.json');
      writeFileSync(basePath, JSON.stringify(tested()));
      const changed = join(dir, 'changed.txt');
      writeFileSync(changed, 'src/workers/archive-import/zip.ts\n');
      const args = ['--config', config, '--candidate', dir, '--out', join(dir, 'out'), '--sha', B, '--harness-commit', B, '--carry-from', basePath, '--changed-files', changed];
      const options = parseCli(args);
      expect([options.skipSuite, options.skipRelay, options.skipJourneys, options.skipArchive]).toEqual([true, true, true, false]);
      expect(options.carry!.plan.run).toEqual(['archive']);
      expect(() => parseCli([...args, '--skip-archive'])).toThrow('drop --skip-archive');
      expect(() => parseCli(args.slice(0, -2))).toThrow('go together');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
