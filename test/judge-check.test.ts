// "Check the judge" (issue #887): a round of 10 items, the least sure plus a
// few at random; the judge's label stays hidden until the owner answers; a
// differing answer settles that one item; the result is a count, and a Wilson
// range once 30 random picks are answered. Everything is kept in one private file on this computer.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  createJudgeCheck,
  forgetJudgeCheckItems,
  JUDGE_CHECK_RANDOM_PICKS,
  JUDGE_CHECK_RANGE_MIN_ANSWERS,
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

function fixture(items: OwnerTierItem[], pick?: () => number) {
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
    path, now: () => clock.date(), random: pick ?? random,
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

  test('a finished round gives the count and the random picks so far, with no range below 30; Check 10 more asks about other items', () => {
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
    // The least-sure picks are not a fair sample of all items, so the tally counts the random ones alone.
    const random = view.random!;
    expect(random).toMatchObject({ compared: JUDGE_CHECK_RANDOM_PICKS, needed: JUDGE_CHECK_RANGE_MIN_ANSWERS, per_round: JUDGE_CHECK_RANDOM_PICKS });
    expect([JUDGE_CHECK_RANDOM_PICKS - 1, JUDGE_CHECK_RANDOM_PICKS]).toContain(random.agreed);
    // Three answers make a range too wide to read as a measurement, so there is none yet.
    expect(view.range).toBeUndefined();
    let next = check.start();
    expect(next.state).toBe('active');
    expect(asked).not.toContain(next.current!.item_id);
    // The next round's random picks add to the earlier ones.
    while (next.current) {
      const judge = items.find((candidate) => candidate.item_id === next.current!.item_id)!.tier as 'Personal' | 'Private';
      next = check.answer(next.current.item_id, judge);
    }
    expect(next.random).toMatchObject({ compared: 2 * JUDGE_CHECK_RANDOM_PICKS, agreed: random.agreed + JUDGE_CHECK_RANDOM_PICKS });
    expect(next.range).toBeUndefined();
  });

  test('once the random picks reach 30, a finished round gives the likely range from them alone', () => {
    const items = pool();
    const { check, path } = fixture(items);
    // Earlier rounds left 27 random picks, 24 agreed.
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ v: 1, random_tally: { compared: 27, agreed: 24 } }));
    let view = check.start();
    while (view.current) {
      const judge = items.find((candidate) => candidate.item_id === view.current!.item_id)!.tier as 'Personal' | 'Private';
      view = check.answer(view.current.item_id, judge);
    }
    expect(view.random).toMatchObject({ compared: 27 + JUDGE_CHECK_RANDOM_PICKS, agreed: 24 + JUDGE_CHECK_RANDOM_PICKS });
    const from = 27 + JUDGE_CHECK_RANDOM_PICKS;
    expect(from).toBeGreaterThanOrEqual(JUDGE_CHECK_RANGE_MIN_ANSWERS);
    expect(view.range).toEqual({ ...wilsonInterval(24 + JUDGE_CHECK_RANDOM_PICKS, from), from, agreed: 24 + JUDGE_CHECK_RANDOM_PICKS });
  });

  test('an answer that cannot be applied (the item became Secret) is kept but never shown as a change', () => {
    const items = pool();
    const engine: OwnerTierItems = {
      find: () => ({ items }),
      set: () => ({ ok: false, code: 'secret_item', message: 'Secret items are not changed here.' }),
    };
    const check = createJudgeCheck({ items: engine, get: (id) => items.find((candidate) => candidate.item_id === id), path: join(root, 'jc.json'), random: () => 0.5 });
    const view = check.start();
    const id = view.current!.item_id;
    const judge = items.find((candidate) => candidate.item_id === id)!.tier as 'Personal' | 'Private';
    const after = check.answer(id, judge === 'Personal' ? 'Private' : 'Personal');
    expect(after.answered[0]).toMatchObject({ item_id: id, changed: false, not_applied: true });
    expect(after.changed).toBe(0);
  });

  test('an answer is applied against the item\'s label now, if the owner changed it since the round began', () => {
    const items = pool();
    const { check, sets } = fixture(items);
    const view = check.start();
    const id = view.current!.item_id;
    const judge = items.find((candidate) => candidate.item_id === id)!.tier as 'Personal' | 'Private';
    const other = judge === 'Personal' ? 'Private' : 'Personal';
    // Changed in Your items while the round waited.
    items.find((candidate) => candidate.item_id === id)!.tier = other;
    const after = check.answer(id, judge);
    // Counted as agreeing with the judge, and the item is set back to the owner's answer.
    expect(after.agreed).toBe(1);
    expect(sets).toEqual([{ itemId: id, choice: judge === 'Personal' ? 'personal' : 'private', allowLower: true }]);
  });

  test('an answer is applied when the owner\'s choice or a move is still waiting for its pass', () => {
    for (const pending of [{ owner_choice: 'Personal' }, { moving_to: 'Personal' }]) {
      const items = pool();
      const { check, sets } = fixture(items);
      const view = check.start();
      const id = view.current!.item_id;
      // Recorded Private, but becoming Personal at the next pass; the owner answers Private.
      Object.assign(items.find((candidate) => candidate.item_id === id)!, { tier: 'Private' }, pending);
      check.answer(id, 'Private');
      expect(sets).toEqual([{ itemId: id, choice: 'private', allowLower: true }]);
    }
  });

  test('a judge\'s label that moved the item is asked about once the move has landed', () => {
    const items = [item(1, { decided_by: 'move' }), item(2, { decided_by: 'move', moving_to: 'Private' })];
    const { check } = fixture(items);
    const view = check.start();
    expect(view.total).toBe(1);
    expect(view.current!.item_id).toBe('oti_1');
  });

  test('the random picks come from the whole pool, the least sure included', () => {
    // Always the first remaining item: the random picks are the least sure ones.
    const { check, path } = fixture(pool(), () => 0);
    check.start();
    const stored = JSON.parse(readFileSync(path, 'utf8')) as { round: { items: Array<{ item_id: string; random?: boolean }> } };
    const randomIds = stored.round.items.filter((entry) => entry.random).map((entry) => entry.item_id).sort();
    expect(randomIds).toEqual(['oti_1', 'oti_2', 'oti_3']);
    expect(stored.round.items).toHaveLength(JUDGE_CHECK_ROUND_SIZE);
    // The rest of the round is the least sure after them.
    expect(stored.round.items.filter((entry) => !entry.random).map((entry) => entry.item_id).sort())
      .toEqual(['oti_10', 'oti_4', 'oti_5', 'oti_6', 'oti_7', 'oti_8', 'oti_9']);
  });

  test('an item asked about again never counts twice toward the accuracy range', () => {
    const { check } = fixture([item(1)]);
    let view = check.start();
    for (let round = 0; round < 40; round += 1) {
      while (view.current) view = check.answer(view.current.item_id, 'Private');
      if (round < 39) view = check.start();
    }
    expect(view.random?.compared).toBe(1);
    expect(view.range).toBeUndefined();
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

describe('an item judged again during a round', () => {
  test('the answer is compared with the newer verdict, since the owner answers about the text shown now', () => {
    const items = pool();
    const { check, sets } = fixture(items);
    let view = check.start();
    const id = view.current!.item_id;
    const index = items.findIndex((candidate) => candidate.item_id === id);
    const before = items[index]!.tier;
    const after: 'Personal' | 'Private' = before === 'Private' ? 'Personal' : 'Private';
    // The text changed and the judge decided again, with the other label.
    items[index] = { ...items[index]!, tier: after, decided_at: '2026-11-05T00:00:00.000Z' };

    view = check.answer(id, after);
    expect(view.answered[0]!.judge).toBe(after);
    expect(view.agreed).toBe(1);
    expect(view.answered[0]!.changed).toBe(false);
    expect(sets).toHaveLength(0);
  });

  test('an item the owner changed meanwhile is still compared with the verdict the round began with', () => {
    const items = pool();
    const { check } = fixture(items);
    let view = check.start();
    const id = view.current!.item_id;
    const index = items.findIndex((candidate) => candidate.item_id === id);
    const before = items[index]!.tier as 'Personal' | 'Private';
    const other = before === 'Private' ? 'Personal' : 'Private';
    items[index] = { ...items[index]!, tier: other, owner_set: true, decided_by: 'override', decided_at: '2026-11-05T00:00:00.000Z' };

    view = check.answer(id, before);
    expect(view.answered[0]!.judge).toBe(before);
    expect(view.agreed).toBe(1);
  });
});
