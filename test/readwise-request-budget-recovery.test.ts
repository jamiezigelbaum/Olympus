// The Readwise budget file is rewritten on every provider request and read back
// in the connector constructor, which is on the email-source worker's boot path.
// An unreadable counter must stay fail-closed — never reissue a day of budget
// that may already be spent — but it must not be boot-fatal, or one unclean
// shutdown crash-loops the whole worker until a human deletes the file.

import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  ReadwiseRequestBudgetError,
  createReadwiseDailyRequestBudget,
} from '../src/workers/readwise/connector.ts';

const WRITER_SOURCE = readFileSync(
  join(import.meta.dir, '..', 'src', 'workers', 'readwise', 'connector.ts'),
  'utf8',
);

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('readwise daily request budget recovery', () => {
  test('a torn state file parks the day instead of throwing out of the constructor', () => {
    const statePath = join(tempDir(), 'readwise-daily-request-budget.json');
    writeFileSync(statePath, '');
    const clock = { now: new Date('2026-08-18T09:00:00.000Z') };

    const budget = createReadwiseDailyRequestBudget({
      env: { OLYMPUS_SOURCE_INDEX_READWISE_DAILY_API_REQUEST_BUDGET: '5' },
      statePath,
      now: () => clock.now,
    });

    expect(budget.status()).toMatchObject({ utcDay: '2026-08-18', requests: 5 });
    expect(() => budget.reserve()).toThrow(ReadwiseRequestBudgetError);
    try {
      budget.reserve();
    } catch (error) {
      expect((error as ReadwiseRequestBudgetError).retryAt).toBe('2026-08-19T00:00:00.000Z');
    }

    // The UTC rollover releases it without human intervention.
    clock.now = new Date('2026-08-19T00:00:01.000Z');
    expect(() => budget.reserve()).not.toThrow();
    expect(budget.status()).toMatchObject({ utcDay: '2026-08-19', requests: 1 });
  });

  test('a state file with a bad shape parks the day the same way', () => {
    const statePath = join(tempDir(), 'readwise-daily-request-budget.json');
    writeFileSync(statePath, `${JSON.stringify({ version: 99, utcDay: 'nonsense', requests: -1 })}\n`);

    const budget = createReadwiseDailyRequestBudget({
      env: { OLYMPUS_SOURCE_INDEX_READWISE_DAILY_API_REQUEST_BUDGET: '3' },
      statePath,
      now: () => new Date('2026-08-18T09:00:00.000Z'),
    });

    expect(budget.status()).toMatchObject({ requests: 3 });
    expect(() => budget.reserve()).toThrow(ReadwiseRequestBudgetError);
  });

  test('persists through the flushing private-file writer, not a bare rename', () => {
    expect(WRITER_SOURCE.includes('writePrivateFileAtomicSync'), 'flushing writer used').toBe(true);
    expect(WRITER_SOURCE.includes('renameSync'), 'no hand-rolled rename').toBe(false);
  });

  test('a normal reserve still persists a private counter and leaves no temp behind', () => {
    const dir = tempDir();
    const statePath = join(dir, 'readwise-daily-request-budget.json');
    const budget = createReadwiseDailyRequestBudget({
      env: { OLYMPUS_SOURCE_INDEX_READWISE_DAILY_API_REQUEST_BUDGET: '5' },
      statePath,
      now: () => new Date('2026-08-18T09:00:00.000Z'),
    });

    budget.reserve();

    expect(readdirSync(dir)).toEqual(['readwise-daily-request-budget.json']);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({
      version: 1,
      utcDay: '2026-08-18',
      requests: 1,
    });
  });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-readwise-budget-recovery-'));
  dirs.push(dir);
  return dir;
}
