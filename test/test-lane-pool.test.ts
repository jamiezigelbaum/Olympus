// OLYMPUS_TEST_LANE: deploy
//
// The fast lane's runner starts one `bun test` process per file, a few at a
// time, because a long-lived Bun worker never gives memory back between files
// and a 6 GiB remote-build container killed workers mid-file
// (scripts/test-lane-pool.ts). What must hold: every file runs exactly once,
// no more than the pool size at once; a failing or killed file fails the lane
// and shows in the merged JUnit report; nothing is reported as a pass the run
// did not have.

import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_POOL_SIZE,
  buildFileCommand,
  filePassed,
  mergeJUnit,
  parseJUnit,
  poolSize,
  runFilePool,
} from '../scripts/test-lane-pool.ts';

const REPORT = (file: string, tests: number, failures: number, skipped = 0) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<testsuites name="bun test" tests="${tests}" assertions="${tests * 2}" failures="${failures}" skipped="${skipped}" time="0.5">\n` +
  `  <testsuite name="test/${file}" file="test/${file}" tests="${tests}" assertions="${tests * 2}" failures="${failures}" skipped="${skipped}" time="0">\n` +
  `    <testcase name="a &lt;b&gt;" classname="x" time="0.1" />\n` +
  `  </testsuite>\n` +
  `</testsuites>\n`;

function fixtureRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'lane-pool-fixture-'));
  mkdirSync(join(root, 'test'));
  for (const [name, source] of Object.entries(files)) writeFileSync(join(root, 'test', name), source);
  return root;
}

describe('fast lane pool', () => {
  test('the pool size defaults to the measured value and only takes a positive whole number', () => {
    expect(poolSize({})).toBe(DEFAULT_POOL_SIZE);
    expect(DEFAULT_POOL_SIZE).toBe(3);
    expect(poolSize({ TEST_LANE_WORKERS: '1' })).toBe(1);
    expect(poolSize({ TEST_LANE_WORKERS: '12' })).toBe(12);
    for (const bad of ['', ' 2', '2 ', '0', '-1', '+2', '1.5', '1e2', '02', 'abc', '9007199254740993']) {
      expect(() => poolSize({ TEST_LANE_WORKERS: bad })).toThrow('TEST_LANE_WORKERS must be a positive whole number');
    }
  });

  test('each file is addressed as a path, never as a name filter', () => {
    expect(buildFileCommand('a.test.ts', '/r/0.xml')).toEqual([
      'bun', 'test', '--timeout=15000', './test/a.test.ts', '--reporter=junit', '--reporter-outfile=/r/0.xml',
    ]);
  });

  test('reports merge in file order with recomputed totals, and a crash becomes a failure', () => {
    expect(parseJUnit('not xml')).toBeNull();
    expect(parseJUnit('<?xml version="1.0"?>\n<testsuites tests="1">')).toBeNull();
    const ok = { file: 'a.test.ts', exitCode: 0, signal: null, seconds: 1, junit: REPORT('a.test.ts', 3, 0, 1) };
    const failing = { file: 'b.test.ts', exitCode: 1, signal: null, seconds: 1, junit: REPORT('b.test.ts', 2, 1) };
    const killed = { file: 'c&d.test.ts', exitCode: null, signal: 'SIGKILL', seconds: 2.5, junit: null };
    const truncated = { file: 'e.test.ts', exitCode: 0, signal: null, seconds: 1, junit: REPORT('e.test.ts', 1, 0).slice(0, 120) };
    // Bun writes the report before it counts an error between tests.
    const erroredAfter = { file: 'f.test.ts', exitCode: 1, signal: null, seconds: 1, junit: REPORT('f.test.ts', 1, 0) };
    const runnerError = { file: 'g.test.ts', exitCode: null, signal: null, seconds: 0, junit: null, error: 'ENOSPC' };
    // A file that passed, then its spool or HOME could not be removed.
    const passedThenErrored = { ...ok, file: 'h.test.ts', junit: REPORT('h.test.ts', 1, 0), error: 'EACCES' };
    const all = [ok, failing, killed, truncated, erroredAfter, runnerError, passedThenErrored];
    expect(all.map(filePassed)).toEqual([true, false, false, false, false, false, false]);

    const { xml, totals } = mergeJUnit(all);
    expect(totals).toEqual({ tests: 12, assertions: 14, failures: 6, skipped: 1, time: 2 });
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test" tests="12" assertions="14" failures="6" skipped="1" time="2">\n')).toBe(true);
    expect(xml).toContain('message="runner error: EACCES"');
    expect(xml).toContain('message="exit 1 with no failing test in its report"');
    expect(xml).toContain('message="runner error: ENOSPC, no readable JUnit report"');
    expect(xml.match(/<testsuites\b/g)).toHaveLength(1);
    expect(xml.indexOf('test/a.test.ts')).toBeLessThan(xml.indexOf('test/b.test.ts'));
    expect(xml).toContain('name="a &lt;b&gt;"');
    expect(xml).toContain('<testsuite name="test/c&amp;d.test.ts"');
    expect(xml).toContain('message="killed by SIGKILL, no readable JUnit report"');
    expect(xml).toContain('message="exit 0, no readable JUnit report"');
    expect(parseJUnit(xml)?.totals.failures).toBe(6);
  });

  test('every file runs once, never more than the pool size at once, and a failure or kill fails the lane', async () => {
    const stamps = mkdtempSync(join(tmpdir(), 'lane-pool-stamps-'));
    const sleeper = (name: string) =>
      `import { test } from 'bun:test';\nimport { appendFileSync } from 'node:fs';\n` +
      `test('${name}', async () => {\n` +
      `  appendFileSync(${JSON.stringify(join(stamps, 'log'))}, 'start ' + Date.now() + '\\n');\n` +
      `  await Bun.sleep(400);\n` +
      `  appendFileSync(${JSON.stringify(join(stamps, 'log'))}, 'end ' + Date.now() + '\\n');\n` +
      `});\n`;
    const root = fixtureRoot({
      'one.test.ts': sleeper('one'),
      'two.test.ts': sleeper('two'),
      'three.test.ts': sleeper('three'),
      'four.test.ts': sleeper('four'),
    });
    const junit = 'results/fast.xml';
    expect(await runFilePool(['one.test.ts', 'two.test.ts', 'three.test.ts', 'four.test.ts'], 2, root, junit)).toBe(0);

    const events = readFileSync(join(stamps, 'log'), 'utf8').trim().split('\n').map((line) => {
      const [kind, at] = line.split(' ');
      return { delta: kind === 'start' ? 1 : -1, at: Number(at) };
    });
    expect(events.filter((event) => event.delta === 1)).toHaveLength(4);
    let live = 0;
    let peak = 0;
    for (const event of events.sort((a, b) => a.at - b.at || a.delta - b.delta)) peak = Math.max(peak, (live += event.delta));
    expect(peak).toBe(2);

    const merged = parseJUnit(readFileSync(join(root, junit), 'utf8'));
    expect(merged?.totals).toMatchObject({ tests: 4, failures: 0 });
    expect(readdirSync(join(root, 'results'))).toEqual(['fast.xml']);

    const broken = fixtureRoot({
      'pass.test.ts': `import { test, expect } from 'bun:test';\ntest('passes', () => expect(1).toBe(1));\n`,
      'fail.test.ts': `import { test, expect } from 'bun:test';\ntest('fails', () => expect(1).toBe(2));\n`,
      'killed.test.ts': `import { test } from 'bun:test';\ntest('is killed', () => { process.kill(process.pid, 'SIGKILL'); });\n`,
    });
    expect(await runFilePool(['pass.test.ts', 'fail.test.ts', 'killed.test.ts'], 3, broken, 'fast.xml')).toBe(1);
    const report = readFileSync(join(broken, 'fast.xml'), 'utf8');
    expect(parseJUnit(report)?.totals).toMatchObject({ tests: 3, failures: 2 });
    expect(report).toContain('message="killed by SIGKILL, no readable JUnit report"');
  }, 30_000);

  test('a runner error after a file (its HOME cannot be removed) ends the running files and fails the lane', async () => {
    const marks = mkdtempSync(join(tmpdir(), 'lane-pool-cleanup-'));
    const root = fixtureRoot({
      // Leaves an undeletable directory in its own throwaway HOME.
      'locks-home.test.ts':
        `import { test } from 'bun:test';\nimport { chmodSync, mkdirSync, writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\n` +
        `test('locks its HOME', () => {\n` +
        `  const dir = join(process.env.HOME!, 'locked');\n` +
        `  mkdirSync(dir); writeFileSync(join(dir, 'f'), 'x'); chmodSync(dir, 0o500);\n` +
        `  writeFileSync(${JSON.stringify(join(marks, 'locked'))}, dir);\n` +
        `});\n`,
      'slow.test.ts': `import { test } from 'bun:test';\ntest('runs long', async () => { await Bun.sleep(20_000); }, 30_000);\n`,
      'queued.test.ts': `import { test } from 'bun:test';\ntest('never runs', () => { throw new Error('ran'); });\n`,
    });
    let locked = '';
    try {
      const begin = Date.now();
      const code = await runFilePool(['slow.test.ts', 'locks-home.test.ts', 'queued.test.ts'], 2, root, 'fast.xml', 300);
      locked = readFileSync(join(marks, 'locked'), 'utf8');
      expect(code).toBe(1);
      expect(Date.now() - begin).toBeLessThan(15_000);
      const report = readFileSync(join(root, 'fast.xml'), 'utf8');
      expect(report).toContain('test/locks-home.test.ts');
      expect(report).toMatch(/message="runner error: [^"]*"/);
      expect(report).toContain('message="killed by SIGTERM, no readable JUnit report"');
      expect(report).not.toContain('never runs');
    } finally {
      if (locked) {
        chmodSync(locked, 0o700);
        rmSync(join(locked, '..'), { recursive: true, force: true });
      }
    }
  }, 30_000);

  test('a signal stops new files, ends a running one that ignores SIGTERM, and fails the lane', async () => {
    const marks = mkdtempSync(join(tmpdir(), 'lane-pool-cancel-'));
    const root = fixtureRoot({
      'stubborn.test.ts':
        `import { test } from 'bun:test';\nimport { writeFileSync } from 'node:fs';\n` +
        `test('ignores SIGTERM', async () => {\n` +
        `  process.on('SIGTERM', () => {});\n` +
        `  writeFileSync(${JSON.stringify(join(marks, 'pid'))}, String(process.pid));\n` +
        `  await Bun.sleep(60_000);\n` +
        `});\n`,
      'never.test.ts': `import { test } from 'bun:test';\ntest('never runs', () => { throw new Error('ran'); });\n`,
    });
    const pool = join(import.meta.dir, '..', 'scripts', 'test-lane-pool.ts');
    const coordinator = Bun.spawn(
      ['bun', '-e', `import { runFilePool } from ${JSON.stringify(pool)}; process.exit(await runFilePool(['stubborn.test.ts', 'never.test.ts'], 1, ${JSON.stringify(root)}, 'fast.xml', 300));`],
      { stdout: 'pipe', stderr: 'pipe' },
    );
    let fixturePid = 0;
    try {
      for (let waited = 0; !fixturePid && waited < 15_000; waited += 50) {
        await Bun.sleep(50);
        try { fixturePid = Number(readFileSync(join(marks, 'pid'), 'utf8')); } catch {}
      }
      expect(fixturePid).toBeGreaterThan(0);
      coordinator.kill('SIGTERM');
      const exit = await Promise.race([coordinator.exited, Bun.sleep(10_000).then(() => 'timeout')]);
      expect(exit).toBe(1);
      const alive = (() => { try { process.kill(fixturePid, 0); return true; } catch { return false; } })();
      expect(alive).toBe(false);
      const out = await new Response(coordinator.stdout).text();
      expect(out).toContain('stopped (SIGTERM); the rest did not run');
      expect(out).not.toContain('never.test.ts');
      const report = readFileSync(join(root, 'fast.xml'), 'utf8');
      expect(report).toContain('message="killed by SIGKILL, no readable JUnit report"');
    } finally {
      coordinator.kill('SIGKILL');
      if (fixturePid) try { process.kill(fixturePid, 'SIGKILL'); } catch {}
    }
  }, 30_000);
});
