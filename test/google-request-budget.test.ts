import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  GoogleDailyRequestBudget,
  GoogleRequestBudgetError,
} from '../src/workers/google-connectors/request-budget.ts';

describe('Google daily request budget ledger', () => {
  test('two holders constructed against the same ledger cannot spend the same slot', () => {
    withFixture((statePath) => {
      const options = {
        provider: 'Gmail',
        dailyRequestBudget: 1,
        statePath,
        now: () => new Date('2026-07-29T10:00:00.000Z'),
      };
      const first = new GoogleDailyRequestBudget(options);
      const overlapping = new GoogleDailyRequestBudget(options);

      first.reserve();

      expect(() => overlapping.reserve()).toThrow(GoogleRequestBudgetError);
      expect(first.status().requests).toBe(1);
      expect(overlapping.status().requests).toBe(1);
    });
  });

  test('two real processes reserve without raw SQLite errors and preserve the exact ledger total', async () => {
    await withAsyncFixture(async (statePath) => {
      const attemptsPerProcess = 300;
      const fixtureDir = statePath.slice(0, statePath.lastIndexOf('/'));
      const goPath = join(fixtureDir, 'go');
      const readyPaths = [join(fixtureDir, 'ready-0'), join(fixtureDir, 'ready-1')];
      // H1 is isolated from H2: the ledger and both holders are initialized
      // without overlap, then only reserve() is released concurrently.
      new GoogleDailyRequestBudget({
        provider: 'Gmail',
        dailyRequestBudget: attemptsPerProcess * 2,
        statePath,
        now: () => new Date('2026-07-29T10:00:00.000Z'),
      }).status();
      const spawnContender = (readyPath: string) => Bun.spawn([
        process.execPath,
        '--eval',
        budgetContenderScript(statePath, readyPath, goPath, attemptsPerProcess),
      ], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const children = [spawnContender(readyPaths[0]!)];
      await waitForFile(readyPaths[0]!);
      children.push(spawnContender(readyPaths[1]!));
      await waitForFile(readyPaths[1]!);
      writeFileSync(goPath, 'go\n', { mode: 0o600 });
      const results = await Promise.all(children.map(async (child) => {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exitCode, stderr).toBe(0);
        return JSON.parse(stdout) as {
          successes: number;
          typedRefusals: number;
          rawSqliteErrors: number;
        };
      }));

      expect(results).toEqual([
        { successes: attemptsPerProcess, typedRefusals: 0, rawSqliteErrors: 0 },
        { successes: attemptsPerProcess, typedRefusals: 0, rawSqliteErrors: 0 },
      ]);
      const budget = new GoogleDailyRequestBudget({
        provider: 'Gmail',
        dailyRequestBudget: attemptsPerProcess * 2,
        statePath,
        now: () => new Date('2026-07-29T10:00:00.000Z'),
      });
      expect(budget.status().requests).toBe(attemptsPerProcess * 2);
    });
  }, 30_000);

  test('concurrent process startup initializes one ledger without raw SQLite errors', async () => {
    await withAsyncFixture(async (statePath) => {
      const startAt = Date.now() + 500;
      const children = [0, 1, 2, 3].map(() => Bun.spawn([
        process.execPath,
        '--eval',
        budgetInitializerScript(statePath, startAt),
      ], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      }));
      const results = await Promise.all(children.map(async (child) => {
        const [stdout, stderr, exitCode] = await Promise.all([
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
          child.exited,
        ]);
        expect(exitCode, stderr).toBe(0);
        return JSON.parse(stdout) as { initialized: boolean; rawSqliteErrors: number };
      }));
      expect(results).toEqual([
        { initialized: true, rawSqliteErrors: 0 },
        { initialized: true, rawSqliteErrors: 0 },
        { initialized: true, rawSqliteErrors: 0 },
        { initialized: true, rawSqliteErrors: 0 },
      ]);
    });
  }, 30_000);

  test('a persisted future UTC day fails closed instead of reissuing today', () => {
    withFixture((statePath) => {
      const futureHolder = new GoogleDailyRequestBudget({
        provider: 'Gmail',
        dailyRequestBudget: 10,
        statePath,
        now: () => new Date('2026-07-30T10:00:00.000Z'),
      });
      futureHolder.reserve();

      const regressedClockHolder = new GoogleDailyRequestBudget({
        provider: 'Gmail',
        dailyRequestBudget: 10,
        statePath,
        now: () => new Date('2026-07-29T10:00:00.000Z'),
      });

      let failure: unknown;
      try {
        regressedClockHolder.reserve();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(GoogleRequestBudgetError);
      expect(failure).toMatchObject({
        reason: 'future_utc_day',
        observedFutureUtcDay: '2026-07-30',
      });
      expect((failure as Error).message).toMatch(/future UTC day/i);
      expect(regressedClockHolder.status().requests).toBe(0);
    });
  });

  test('future-day fail-closed state has an exact guarded recovery path', () => {
    withFixture((statePath) => {
      const currentHolder = new GoogleDailyRequestBudget({
        provider: 'Gmail',
        dailyRequestBudget: 10,
        statePath,
        now: () => new Date('2026-07-29T10:00:00.000Z'),
      });
      currentHolder.reserve();
      const futureHolder = new GoogleDailyRequestBudget({
        provider: 'Gmail',
        dailyRequestBudget: 10,
        statePath,
        now: () => new Date('2026-08-02T10:00:00.000Z'),
      });
      futureHolder.reserve();

      expect(() => currentHolder.recoverFutureUtcDay({
        expectedFutureUtcDay: '2026-08-01',
        reason: 'clock_repaired',
      })).toThrow(/expected_future_utc_day_mismatch/);
      expect(currentHolder.recoverFutureUtcDay({
        expectedFutureUtcDay: '2026-08-02',
        reason: 'clock_repaired',
      })).toMatchObject({
        kind: 'google_request_budget_future_day_recovered',
        provider: 'Gmail',
        current_utc_day: '2026-07-29',
        expected_future_utc_day: '2026-08-02',
        removed_rows: 1,
        removed_requests: 1,
        reason: 'clock_repaired',
      });
      expect(() => currentHolder.reserve()).not.toThrow();
      expect(currentHolder.status().requests).toBe(2);
    });
  });

  test('ledger sidecars are owner-only while concurrent connections are open', () => {
    withFixture((statePath) => {
      const budget = new GoogleDailyRequestBudget({
        provider: 'Gmail',
        dailyRequestBudget: 10,
        statePath,
        now: () => new Date('2026-07-29T10:00:00.000Z'),
      });
      const ledgerPath = `${statePath}.sqlite`;
      const observer = new Database(ledgerPath);
      try {
        observer.exec('PRAGMA busy_timeout = 10000;');
        observer.query('SELECT COUNT(*) AS count FROM google_request_budget_ledger').get();
        budget.reserve();
        for (const path of [ledgerPath, `${ledgerPath}-wal`, `${ledgerPath}-shm`]) {
          expect(existsSync(path), path).toBe(true);
          expect(statSync(path).mode & 0o777, path).toBe(0o600);
        }
      } finally {
        observer.close();
      }
    });
  });

  test('imports the deployed JSON count into the SQLite ledger without reissuing it', () => {
    withFixture((statePath) => {
      writeFileSync(
        statePath,
        '{"version":1,"utcDay":"2026-07-29","requests":1}\n',
        { mode: 0o600 },
      );
      const budget = new GoogleDailyRequestBudget({
        provider: 'Gmail',
        dailyRequestBudget: 1,
        statePath,
        now: () => new Date('2026-07-29T10:00:00.000Z'),
      });

      expect(() => budget.reserve()).toThrow(GoogleRequestBudgetError);
      expect(budget.status().requests).toBe(1);
    });
  });
});

function withFixture(run: (statePath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-google-request-budget-'));
  try {
    run(join(dir, 'budget.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withAsyncFixture(run: (statePath: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-google-request-budget-'));
  try {
    await run(join(dir, 'budget.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function budgetContenderScript(
  statePath: string,
  readyPath: string,
  goPath: string,
  attempts: number,
): string {
  return `
    import { existsSync, writeFileSync } from 'node:fs';
    import {
      GoogleDailyRequestBudget,
      GoogleRequestBudgetError,
    } from ${JSON.stringify(join(process.cwd(), 'src/workers/google-connectors/request-budget.ts'))};
    const budget = new GoogleDailyRequestBudget({
      provider: 'Gmail',
      dailyRequestBudget: ${attempts * 2},
      statePath: ${JSON.stringify(statePath)},
      now: () => new Date('2026-07-29T10:00:00.000Z'),
    });
    writeFileSync(${JSON.stringify(readyPath)}, 'ready\\n', { mode: 0o600 });
    while (!existsSync(${JSON.stringify(goPath)})) Bun.sleepSync(1);
    let successes = 0;
    let typedRefusals = 0;
    let rawSqliteErrors = 0;
    for (let index = 0; index < ${attempts}; index += 1) {
      try {
        budget.reserve();
        successes += 1;
      } catch (error) {
        if (error instanceof GoogleRequestBudgetError) typedRefusals += 1;
        else rawSqliteErrors += 1;
      }
    }
    console.log(JSON.stringify({ successes, typedRefusals, rawSqliteErrors }));
  `;
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error('budget contender readiness timed out');
    await Bun.sleep(5);
  }
}

function budgetInitializerScript(statePath: string, startAt: number): string {
  return `
    import { GoogleDailyRequestBudget } from ${JSON.stringify(join(process.cwd(), 'src/workers/google-connectors/request-budget.ts'))};
    while (Date.now() < ${startAt}) {}
    let initialized = false;
    let rawSqliteErrors = 0;
    try {
      const budget = new GoogleDailyRequestBudget({
        provider: 'Gmail',
        dailyRequestBudget: 10,
        statePath: ${JSON.stringify(statePath)},
        now: () => new Date('2026-07-29T10:00:00.000Z'),
      });
      budget.status();
      initialized = true;
    } catch {
      rawSqliteErrors += 1;
    }
    console.log(JSON.stringify({ initialized, rawSqliteErrors }));
  `;
}
