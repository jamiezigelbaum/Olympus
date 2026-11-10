// "Check the judge" (issue #887): a round of 10 items, the least sure plus a
// few at random; the judge's label stays hidden until the owner answers; a
// differing answer settles that one item; the result is a count and a Wilson
// range. Everything is kept in one private file on this computer.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createJudgeCheck,
  JUDGE_CHECK_RANDOM_PICKS,
  JUDGE_CHECK_ROUND_SIZE,
  judgeConfidence,
  wilsonInterval,
} from '../src/workers/classification/judge-check.ts';
import type { OwnerTierItem, OwnerTierItems, OwnerTierItemSetInput } from '../src/workers/classification/tier-owner-items.ts';
import { createTestClock } from './helpers/test-clock.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'olympus-judge-check-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function item(n: number, overrides: Partial<OwnerTierItem> = {}): OwnerTierItem {
  return {
    item_id: `oti_${n}`, source: 'gmail', family: 'email', title: `Item ${n}`, sender: 'Someone', location: null,
    tier: n % 2 ? 'Private' : 'Personal', names_tier: 'Personal', decided_by: 'sniffer', owner_set: false,
    // Item n is the judge's n-th surest: item 1 is the least sure.
    judge_reason: `ordinary:${(n / 100).toFixed(2)}`, decided_at: '2026-11-01T00:00:00.000Z', ...overrides,
  };
}

function fixture(items: OwnerTierItem[]) {
  const sets: OwnerTierItemSetInput[] = [];
  const engine: OwnerTierItems = {
    find: () => ({ items }),
    set(input) { sets.push(input); return { ok: true, item: items[0]!, changed: 'set', applies: 'now', results: [] }; },
  };
  // A seeded generator: the same picks every run.
  let seed = 7;
  const random = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const clock = createTestClock();
  const path = join(root, 'olympus', 'judge-check.json');
  const check = createJudgeCheck({
    items: engine,
    get: (id) => ({ ...items.find((candidate) => candidate.item_id === id)!, preview: `Text of ${id}` }),
    path, now: () => clock.date(), random,
  });
  return { check, sets, path };
}

const pool = () => Array.from({ length: 30 }, (_, index) => item(index + 1));

describe('a round', () => {
  test('asks about the least sure items plus a few at random, never ones the owner or a rule decided', () => {
    const items = [
      ...pool(),
      item(100, { judge_reason: 'ordinary:0.01', owner_set: true, decided_by: 'override' }),
      item(101, { judge_reason: 'ordinary:0.01', decided_by: 'owner_rule' }),
      item(102, { judge_reason: 'ordinary:0.01', moving_to: 'Private' }),
      item(103, { judge_reason: 'ordinary:0.01', tier: null }),
      // Held Private by default while waiting for the judge, and a judge verdict not recorded yet.
      item(104, { judge_reason: null, decided_by: 'default', tier: 'Private' }),
      item(105, { judge_reason: null }),
    ];
    const { check } = fixture(items);
    const round = check.start();
    expect(round.state).toBe('active');
    expect(round.total).toBe(JUDGE_CHECK_ROUND_SIZE);
    const ids = new Set<string>();
    let view = round;
    for (let index = 0; index < JUDGE_CHECK_ROUND_SIZE; index += 1) {
      ids.add(view.current!.item_id);
      view = check.answer(view.current!.item_id, 'not_sure');
    }
    const leastSure = Array.from({ length: JUDGE_CHECK_ROUND_SIZE - JUDGE_CHECK_RANDOM_PICKS }, (_, index) => `oti_${index + 1}`);
    for (const id of leastSure) expect(ids.has(id)).toBe(true);
    expect([...ids].filter((id) => !leastSure.includes(id))).toHaveLength(JUDGE_CHECK_RANDOM_PICKS);
    for (const id of ['oti_100', 'oti_101', 'oti_102', 'oti_103', 'oti_104', 'oti_105']) expect(ids.has(id)).toBe(false);
  });

  test('the judge\'s label stays hidden until the owner answers', () => {
    const { check } = fixture(pool());
    const view = check.start();
    expect(view.current).toBeDefined();
    expect(JSON.stringify(view.current)).not.toMatch(/Personal|Private|judge/);
    expect(view.current!.preview).toBe(`Text of ${view.current!.item_id}`);
    expect(view.answered).toEqual([]);
  });

  test('agreeing changes nothing; differing settles that one item; Not sure leaves it with the judge', () => {
    const items = pool();
    const { check, sets } = fixture(items);
    let view = check.start();
    const tierOf = (id: string) => items.find((candidate) => candidate.item_id === id)!.tier as 'Personal' | 'Private';
    const first = view.current!.item_id;
    view = check.answer(first, tierOf(first));
    const second = view.current!.item_id;
    const other = tierOf(second) === 'Personal' ? 'Private' : 'Personal';
    view = check.answer(second, other);
    const third = view.current!.item_id;
    view = check.answer(third, 'not_sure');
    expect(sets).toEqual([{ itemId: second, choice: other === 'Personal' ? 'personal' : 'private', allowLower: true }]);
    expect(view.answered.map((answered) => [answered.item_id, answered.answer, answered.judge, answered.changed])).toEqual([
      [first, tierOf(first), tierOf(first), false],
      [second, other, tierOf(second), true],
      [third, 'not_sure', tierOf(third), false],
    ]);
    expect(view).toMatchObject({ state: 'active', position: 4, compared: 2, agreed: 1, not_sure: 1, changed: 1 });
    // Mid-round there is no range: too few answers to mean anything.
    expect(view.range).toBeUndefined();
    // Only the item waiting for an answer can be answered.
    expect(() => check.answer(first, 'Private')).toThrow('not the item waiting');
  });

  test('a finished round gives the count, and a likely range from the random picks only; Check 10 more asks about other items', () => {
    const items = pool();
    const { check } = fixture(items);
    let view = check.start();
    const asked: string[] = [];
    while (view.current) {
      const id = view.current.item_id;
      asked.push(id);
      const judge = items.find((candidate) => candidate.item_id === id)!.tier as 'Personal' | 'Private';
      // Agree on all but the last.
      view = check.answer(id, asked.length < JUDGE_CHECK_ROUND_SIZE ? judge : judge === 'Personal' ? 'Private' : 'Personal');
    }
    expect(view).toMatchObject({ state: 'done', compared: 10, agreed: 9, changed: 1 });
    // The least-sure picks are not a fair sample of all items, so the range rests on the random ones alone.
    const random = view.range!;
    expect(random.from).toBe(JUDGE_CHECK_RANDOM_PICKS);
    expect([JUDGE_CHECK_RANDOM_PICKS - 1, JUDGE_CHECK_RANDOM_PICKS]).toContain(random.agreed);
    expect(random).toEqual({ ...wilsonInterval(random.agreed, JUDGE_CHECK_RANDOM_PICKS), from: JUDGE_CHECK_RANDOM_PICKS, agreed: random.agreed });
    let next = check.start();
    expect(next.state).toBe('active');
    expect(asked).not.toContain(next.current!.item_id);
    // The next round's random picks add to the earlier ones.
    while (next.current) {
      const judge = items.find((candidate) => candidate.item_id === next.current!.item_id)!.tier as 'Personal' | 'Private';
      next = check.answer(next.current.item_id, judge);
    }
    expect(next.range).toMatchObject({ from: 2 * JUDGE_CHECK_RANDOM_PICKS, agreed: random.agreed + JUDGE_CHECK_RANDOM_PICKS });
  });

  test('putting it away keeps the answers, and it picks up where it stopped', () => {
    const { check, path } = fixture(pool());
    let view = check.start();
    const first = view.current!.item_id;
    view = check.answer(first, 'not_sure');
    expect(check.putAway()).toMatchObject({ put_away: true, position: 2 });
    // Start while a round is going picks it up instead of starting over.
    expect(check.start()).toMatchObject({ put_away: false, position: 2 });
    expect(check.resume().answered.map((answered) => answered.item_id)).toEqual([first]);
    // One private file on this computer, with ids and labels only: no item text or names.
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const stored = readFileSync(path, 'utf8');
    expect(stored).not.toContain('Text of');
    expect(stored).not.toContain('Item ');
  });
});

describe('many rounds', () => {
  test('page further back for items no round asked about, then ask again about the oldest asked', () => {
    // 200 judged items, each decided a minute apart; the engine pages by `before`, 50 at a time.
    const start = Date.UTC(2026, 9, 1);
    const items = Array.from({ length: 200 }, (_, index) => item(index + 1, {
      decided_at: new Date(start + (200 - index) * 60_000).toISOString(),
    }));
    const finds: Array<string | undefined> = [];
    const engine: OwnerTierItems = {
      find(input) {
        finds.push(input.before);
        const older = input.before ? items.filter((candidate) => candidate.decided_at! < input.before!) : items;
        return { items: older.slice(0, input.limit ?? 20) };
      },
      set: () => ({ ok: true, item: items[0]!, changed: 'set', applies: 'now', results: [] }),
    };
    let seed = 3;
    const check = createJudgeCheck({
      items: engine,
      get: (id) => items.find((candidate) => candidate.item_id === id),
      path: join(root, 'judge-check.json'),
      random: () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; },
    });
    const round = () => {
      let view = check.start();
      const asked: string[] = [];
      while (view.current) {
        asked.push(view.current.item_id);
        view = check.answer(view.current.item_id, 'not_sure');
      }
      return asked;
    };
    const rounds = Array.from({ length: 22 }, round);
    // Every round is full, and the first twenty never repeat an item.
    for (const asked of rounds) expect(asked).toHaveLength(JUDGE_CHECK_ROUND_SIZE);
    expect(new Set(rounds.slice(0, 20).flat()).size).toBe(200);
    // It paged past the first 50.
    expect(finds.some((before) => before !== undefined)).toBe(true);
    // With nothing new left, it asks again about the items asked longest ago, not the latest.
    expect(new Set(rounds[20])).toEqual(new Set(rounds[0]));
    expect(new Set(rounds[21])).toEqual(new Set(rounds[1]));
  });
});

describe('paging through items sorted at the same moment', () => {
  test('a page boundary inside a tie skips nothing', () => {
    // 120 judged items all decided at the same moment; the engine pages by time and the last item, 50 at a time.
    const items = Array.from({ length: 120 }, (_, index) => item(index + 1));
    const engine: OwnerTierItems = {
      find(input) {
        const after = input.beforeItem ? items.findIndex((candidate) => candidate.item_id === input.beforeItem) + 1 : 0;
        return { items: items.slice(after, after + (input.limit ?? 20)) };
      },
      set: () => ({ ok: true, item: items[0]!, changed: 'set', applies: 'now', results: [] }),
    };
    let seed = 5;
    const check = createJudgeCheck({
      items: engine,
      get: (id) => items.find((candidate) => candidate.item_id === id),
      path: join(root, 'judge-check.json'),
      random: () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; },
    });
    const asked: string[] = [];
    for (let round = 0; round < 12; round += 1) {
      let view = check.start();
      while (view.current) {
        asked.push(view.current.item_id);
        view = check.answer(view.current.item_id, 'not_sure');
      }
    }
    expect(new Set(asked).size).toBe(120);
  });
});

describe('the numbers', () => {
  test('the Wilson range for 9 of 10 is about 60% to 98%, and narrows with more answers', () => {
    const ten = wilsonInterval(9, 10);
    expect(ten.low).toBeCloseTo(0.596, 3);
    expect(ten.high).toBeCloseTo(0.982, 3);
    const hundred = wilsonInterval(90, 100);
    expect(hundred.high - hundred.low).toBeLessThan(ten.high - ten.low);
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
    expect(wilsonInterval(10, 10).high).toBe(1);
  });

  test('the judge\'s confidence comes from its stored reason code', () => {
    expect(judgeConfidence('financial:0.90')).toBe(0.9);
    expect(judgeConfidence('record_held:health:0.42')).toBe(0.42);
    expect(judgeConfidence('unresolved:0.00')).toBe(0);
    expect(judgeConfidence(null)).toBe(1);
    expect(judgeConfidence('garbled')).toBe(1);
  });
});
