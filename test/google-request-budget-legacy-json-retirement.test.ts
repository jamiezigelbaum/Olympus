// The legacy JSON budget file is imported into the SQLite ledger on every
// construction. Until it is retired, the guarded future-UTC-day recovery is
// undone by the next worker boot on exactly the upgraded hosts it exists for.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  GoogleDailyRequestBudget,
  GoogleRequestBudgetError,
} from '../src/workers/google-connectors/request-budget.ts';

describe('Google request budget legacy JSON retirement', () => {
  test('a recovered future UTC day is not reinstated by the next construction', () => {
    withFixture((statePath) => {
      writeFileSync(
        statePath,
        '{"version":1,"utcDay":"2026-08-02","requests":3}\n',
        { mode: 0o600 },
      );
      const options = {
        provider: 'Gmail',
        dailyRequestBudget: 10,
        statePath,
        now: () => new Date('2026-07-29T10:00:00.000Z'),
      };

      const parked = new GoogleDailyRequestBudget(options);
      expect(() => parked.reserve()).toThrow(GoogleRequestBudgetError);
      expect(parked.recoverFutureUtcDay({
        expectedFutureUtcDay: '2026-08-02',
        reason: 'clock_repaired',
      })).toMatchObject({ removed_rows: 1, removed_requests: 3 });

      const afterRestart = new GoogleDailyRequestBudget(options);

      expect(() => afterRestart.reserve()).not.toThrow();
      expect(afterRestart.status().requests).toBe(1);
      expect(existsSync(statePath)).toBe(false);
    });
  });

  test('the imported count is preserved and the retired file is kept beside the ledger', () => {
    withFixture((statePath) => {
      writeFileSync(
        statePath,
        '{"version":1,"utcDay":"2026-07-29","requests":1}\n',
        { mode: 0o600 },
      );
      const options = {
        provider: 'Gmail',
        dailyRequestBudget: 1,
        statePath,
        now: () => new Date('2026-07-29T10:00:00.000Z'),
      };

      const budget = new GoogleDailyRequestBudget(options);

      expect(() => budget.reserve()).toThrow(GoogleRequestBudgetError);
      expect(budget.status().requests).toBe(1);
      expect(existsSync(statePath)).toBe(false);
      expect(JSON.parse(readFileSync(`${statePath}.imported`, 'utf8'))).toMatchObject({
        utcDay: '2026-07-29',
        requests: 1,
      });
      // The count stays imported once: a second construction must not double it.
      expect(new GoogleDailyRequestBudget(options).status().requests).toBe(1);
    });
  });
});

function withFixture(run: (statePath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-google-request-budget-legacy-'));
  try {
    run(join(dir, 'budget.json'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
