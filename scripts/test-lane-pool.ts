/**
 * The fast lane's runner: every test file in its own `bun test` process, a
 * few at a time.
 *
 * A `bun test --parallel` worker never gives memory back between files, so a
 * worker's footprint grows with the number of files it is handed. Measured on
 * a remote-build container (4 CPUs, 6 GiB, no swap; 549 files, 2026-10-25):
 * one worker per CPU, two workers and one process all reached 6 GiB and the
 * kernel killed a worker mid-file (`worker crashed: SIGKILL`). Each file alone
 * peaks at 1.6 GB at most (median 95 MB), and the whole lane run one file per
 * process, three at a time, passed in 273 s. Bun 1.3.14 has no option to
 * recycle its workers, so the pool here does it.
 *
 * TEST_LANE_WORKERS sets how many files run at once (default 3, the measured
 * value; more needs a new measurement against the 6 GiB limit).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const DEFAULT_POOL_SIZE = 3;

type Env = Record<string, string | undefined>;

export function poolSize(env: Env = process.env): number {
  const value = env.TEST_LANE_WORKERS;
  if (value === undefined) return DEFAULT_POOL_SIZE;
  const count = /^[1-9][0-9]*$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(count)) {
    throw new Error(`TEST_LANE_WORKERS must be a positive whole number, not ${JSON.stringify(value)}.`);
  }
  return count;
}

/**
 * One file's command. `./` makes Bun read the argument as a path, not a name
 * filter. Files still share the CPUs, so a CPU-heavy test runs ~2-3x slower
 * than alone (a 2.2 s corpus test hit Bun's 5 s default): the per-test
 * timeout scales to match and still catches hangs. Explicit timeouts win.
 */
export function buildFileCommand(file: string, junitPath: string): string[] {
  return ['bun', 'test', '--timeout=15000', `./test/${file}`, '--reporter=junit', `--reporter-outfile=${junitPath}`];
}

export interface FileResult {
  file: string;
  exitCode: number | null;
  signal: string | null;
  seconds: number;
  /** The file's JUnit report, or null when the process left none. */
  junit: string | null;
  /** Set when the runner itself failed around this file (spawn, HOME, spool). */
  error?: string;
}

export interface JUnitTotals {
  tests: number;
  assertions: number;
  failures: number;
  skipped: number;
  time: number;
}

const ROOT_OPEN = /^<\?xml[^>]*\?>\s*<testsuites\b([^>]*)>/;
const ROOT_CLOSE = /<\/testsuites>\s*$/;

function attribute(attributes: string, name: string): number {
  const match = new RegExp(`\\b${name}="([0-9.]+)"`).exec(attributes);
  return match ? Number(match[1]) : 0;
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** The suites inside one Bun JUnit report and its totals; null when it is not one. */
export function parseJUnit(xml: string): { totals: JUnitTotals; body: string } | null {
  const open = ROOT_OPEN.exec(xml);
  const close = ROOT_CLOSE.exec(xml);
  if (!open || !close || close.index < open[0].length) return null;
  const body = xml.slice(open[0].length, close.index);
  if (/<\/?testsuites\b/.test(body)) return null;
  const attrs = open[1]!;
  return {
    body: body.replace(/^\n+|\s+$/g, ''),
    totals: {
      tests: attribute(attrs, 'tests'),
      assertions: attribute(attrs, 'assertions'),
      failures: attribute(attrs, 'failures'),
      skipped: attribute(attrs, 'skipped'),
      time: attribute(attrs, 'time'),
    },
  };
}

function describeExit(result: FileResult): string {
  if (result.error) return `runner error: ${result.error}`;
  return result.signal ? `killed by ${result.signal}` : `exit ${result.exitCode}`;
}

/**
 * One report for the lane, in file order. A file that crashed, left no
 * readable report, or exited nonzero with no failing test in it (Bun writes
 * the report before it counts an error between tests) gains a failed test
 * case, so the report can never read as a pass the run did not have.
 */
export function mergeJUnit(results: readonly FileResult[]): { xml: string; totals: JUnitTotals } {
  const totals: JUnitTotals = { tests: 0, assertions: 0, failures: 0, skipped: 0, time: 0 };
  const bodies: string[] = [];
  for (const result of results) {
    const parsed = result.junit === null ? null : parseJUnit(result.junit);
    if (parsed) {
      for (const key of Object.keys(totals) as (keyof JUnitTotals)[]) totals[key] += parsed.totals[key];
      if (parsed.body) bodies.push(parsed.body);
    }
    if (!parsed || (result.exitCode !== 0 && !(result.exitCode !== null && parsed.totals.failures > 0))) {
      const why = !parsed
        ? `${describeExit(result)}, no readable JUnit report`
        : result.exitCode === null
          ? describeExit(result)
          : `${describeExit(result)} with no failing test in its report`;
      const name = escapeXml(`test/${result.file}`);
      totals.tests += 1;
      totals.failures += 1;
      bodies.push(
        `  <testsuite name="${name}" file="${name}" tests="1" failures="1" skipped="0" time="${result.seconds}">\n` +
          `    <testcase name="(the file did not finish)" classname="${name}" time="${result.seconds}">\n` +
          `      <failure type="crash" message="${escapeXml(why)}" />\n` +
          `    </testcase>\n` +
          `  </testsuite>`,
      );
    }
  }
  totals.time = Math.round(totals.time * 1e5) / 1e5;
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="bun test" tests="${totals.tests}" assertions="${totals.assertions}" failures="${totals.failures}" skipped="${totals.skipped}" time="${totals.time}">\n` +
    (bodies.length ? `${bodies.join('\n')}\n` : '') +
    `</testsuites>\n`;
  return { xml, totals };
}

/** A file passed only when its process exited 0 on its own and left a report. */
export function filePassed(result: FileResult): boolean {
  return (
    result.exitCode === 0 && result.signal === null && !result.error && result.junit !== null && parseJUnit(result.junit) !== null
  );
}

/**
 * Run every file, `size` at a time, in the given order. Each process gets a
 * fresh throwaway HOME (Bun reads HOME once at start; test/support/
 * isolated-home.ts enforces it per process). Output is spooled to files and
 * printed whole when the file finishes: one line for a pass, everything for a
 * failure. SIGINT or SIGTERM, or a runner error, stops new files and ends the
 * running ones (SIGTERM, then SIGKILL after `graceMs`; a second signal kills at
 * once). Returns the lane's exit code.
 */
export async function runFilePool(
  files: readonly string[],
  size: number,
  root: string,
  junitPath?: string,
  graceMs = 5000,
): Promise<number> {
  const spool = mkdtempSync(join(tmpdir(), 'olympus-lane-pool-'));
  const results: FileResult[] = new Array(files.length);
  const running = new Set<ReturnType<typeof Bun.spawn>>();
  let stopped: string | null = null;
  let escalation: ReturnType<typeof setTimeout> | undefined;
  const stop = (why: string) => {
    if (stopped !== null) {
      for (const child of running) child.kill('SIGKILL');
      return;
    }
    stopped = why;
    for (const child of running) child.kill('SIGTERM');
    escalation = setTimeout(() => {
      for (const child of running) child.kill('SIGKILL');
    }, graceMs);
  };
  const onSignal = (signal: NodeJS.Signals) => stop(signal);
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const started = Date.now();
  let next = 0;
  let done = 0;
  const runOne = async (index: number) => {
    const file = files[index]!;
    const base = join(spool, String(index));
    const report = `${base}.xml`;
    const spooled = [report, `${base}.out`, `${base}.err`];
    const begin = Date.now();
    let home: string | undefined;
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let result: FileResult;
    try {
      // /tmp may be a tmpfs counted against the same memory limit, so each
      // file's HOME and spool go as soon as it is done.
      home = mkdtempSync(join(tmpdir(), 'olympus-lane-home-'));
      child = Bun.spawn(buildFileCommand(file, report), {
        cwd: root,
        stdout: Bun.file(spooled[1]!),
        stderr: Bun.file(spooled[2]!),
        env: { ...process.env, HOME: home },
      });
      running.add(child);
      if (stopped !== null) child.kill('SIGKILL');
      await child.exited;
      result = {
        file,
        exitCode: child.signalCode ? null : child.exitCode,
        signal: child.signalCode ?? null,
        seconds: Math.round((Date.now() - begin) / 100) / 10,
        junit: existsSync(report) ? readFileSync(report, 'utf8') : null,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = { file, exitCode: null, signal: null, seconds: Math.round((Date.now() - begin) / 100) / 10, junit: null, error: message };
      stop(`runner error on test/${file}: ${message}`);
      if (child) await child.exited;
    } finally {
      if (child) running.delete(child);
      if (home) rmSync(home, { recursive: true, force: true });
    }
    results[index] = result;
    done += 1;
    const passed = filePassed(result);
    const counts = result.junit ? parseJUnit(result.junit)?.totals : undefined;
    const summary = counts ? `${counts.tests - counts.failures - counts.skipped} pass, ${counts.failures} fail` : describeExit(result);
    console.log(`[test-lane] ${done}/${files.length} ${passed ? 'ok  ' : 'FAIL'} test/${file} (${summary}, ${result.seconds}s)`);
    if (!passed) {
      for (const output of spooled.slice(1)) if (existsSync(output)) process.stdout.write(readFileSync(output, 'utf8'));
      if (result.signal || result.exitCode !== 0) console.log(`[test-lane] test/${file}: ${describeExit(result)}`);
    }
    for (const path of spooled) rmSync(path, { force: true });
  };
  // Anything runOne throws (cleanup, reading output) stops the lane like a
  // runner error, so the siblings are ended and awaited before the report.
  const slot = async () => {
    while (next < files.length && stopped === null) {
      const index = next++;
      try {
        await runOne(index);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const recorded = results[index];
        results[index] = recorded
          ? { ...recorded, error: recorded.error ?? message }
          : { file: files[index]!, exitCode: null, signal: null, seconds: 0, junit: null, error: message };
        console.log(`[test-lane] runner error on test/${files[index]}: ${message}`);
        stop(`runner error on test/${files[index]}: ${message}`);
      }
    }
  };

  let code: number;
  let totals: JUnitTotals;
  let failed: FileResult[];
  let finished: FileResult[];
  try {
    await Promise.all(Array.from({ length: Math.min(size, files.length) }, slot));
  } finally {
    clearTimeout(escalation);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    finished = results.filter(Boolean);
    failed = finished.filter((result) => !filePassed(result));
    const merged = mergeJUnit(finished);
    totals = merged.totals;
    code = stopped !== null || failed.length > 0 || finished.length !== files.length ? 1 : 0;
    if (junitPath) {
      try {
        const target = join(root, junitPath);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(`${target}.partial`, merged.xml);
        renameSync(`${target}.partial`, target);
      } catch (error) {
        console.error(`[test-lane] could not write ${junitPath}: ${error instanceof Error ? error.message : String(error)}`);
        code = 1;
      }
    }
    rmSync(spool, { recursive: true, force: true });
  }

  const seconds = Math.round((Date.now() - started) / 1000);
  console.log(
    `[test-lane] ${finished.length} of ${files.length} files run, ${failed.length} failed; ` +
      `${totals.tests - totals.failures - totals.skipped} pass, ${totals.skipped} skip, ${totals.failures} fail; ${seconds}s`,
  );
  for (const result of failed) console.log(`[test-lane] failed: test/${result.file} (${describeExit(result)})`);
  if (stopped !== null) console.log(`[test-lane] stopped (${stopped}); the rest did not run`);
  return code;
}
