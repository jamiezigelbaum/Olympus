// "Check the judge" (issue #887; mockups release-1.5/l3/v2 L3-4, L3-5): an
// optional round of 10 items, the ones the judge was least sure about plus a
// few picked at random. The owner answers each one Personal, Private or Not
// sure before seeing the judge's label, so the agreement count is honest. An
// answer that differs from the judge settles that one item (the owner's
// one-item change, tier-owner-items.ts); it never becomes a rule for a sender,
// chat or folder, and it does not change how the judge decides.
//
// Everything stays on this computer: the round (item ids, the judge's label
// at the start, the owner's answers) is one private file next to the owner's
// privacy profile. Nothing here sends a label anywhere.

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writePrivateFileAtomicSync } from '../../core/atomic-file.ts';
import { defaultOwnerConfigPath } from '../../core/owner-config-read.ts';
import type { OwnerItemChoice, OwnerTierItem, OwnerTierItems } from './tier-owner-items.ts';

export const JUDGE_CHECK_ROUND_SIZE = 10;
/** Of each round, how many are picked at random instead of by the judge's doubt. */
export const JUDGE_CHECK_RANDOM_PICKS = 3;
/** How many recently sorted items a round is drawn from. */
export const JUDGE_CHECK_POOL = 50;
/** How far back a new round pages for items no round has asked about yet. */
export const JUDGE_CHECK_MAX_PAGES = 20;
export const JUDGE_CHECK_PATH_ENV = 'OLYMPUS_JUDGE_CHECK_PATH';

export type JudgeLabel = 'Personal' | 'Private';
export type JudgeCheckAnswer = JudgeLabel | 'not_sure';

interface StoredRoundItem {
  item_id: string;
  /** The judge's label when the round began. Shown only after the owner answers. */
  judge: JudgeLabel;
  answer?: JudgeCheckAnswer;
  /** The owner's answer differed and the item was set to it. */
  changed?: boolean;
  /** Picked at random, not for the judge's doubt: only these answers estimate how often the judge agrees overall. */
  random?: boolean;
}

interface StoredJudgeCheck {
  v: 1;
  round?: { started_at: string; items: StoredRoundItem[] };
  /** Put away (X or Stop for now): the card shrinks to one line until the owner picks it up. */
  put_away?: boolean;
  /** Items earlier rounds asked about, so a new round asks about others. Ids only. */
  seen?: string[];
  /** The random picks of earlier rounds: how many were compared and how many the judge agreed with. */
  random_tally?: { compared: number; agreed: number };
}

const JUDGE_CHECK_SEEN_MAX = 500;

/** An item as the round shows it: no label until the owner has answered. */
export interface JudgeCheckItem {
  item_id: string;
  source: string;
  family: string;
  title: string | null;
  sender: string | null;
  location: string | null;
  preview: string | null;
}

export interface JudgeCheckAnswered extends JudgeCheckItem {
  answer: JudgeCheckAnswer;
  judge: JudgeLabel;
  changed: boolean;
}

export interface JudgeCheckView {
  /** `none`: no round yet; `active`: items left to answer; `done`: every item answered. */
  state: 'none' | 'active' | 'done';
  put_away: boolean;
  total: number;
  /** The item to answer now, without its label. */
  current?: JudgeCheckItem;
  /** 1-based position of `current` in the round. */
  position?: number;
  answered: JudgeCheckAnswered[];
  /** Answers that were Personal or Private (Not sure is left out), and how many the judge agreed with. */
  compared: number;
  agreed: number;
  not_sure: number;
  changed: number;
  /**
   * The likely share of items the judge agrees with the owner on (95% Wilson
   * interval), once the round is done. Drawn only from the random picks, this
   * round's and earlier rounds', since the doubtful picks are not a fair sample;
   * `from` is how many answers it rests on, `agreed` how many of them matched.
   */
  range?: { low: number; high: number; from: number; agreed: number };
}

export interface JudgeCheck {
  status(): JudgeCheckView;
  /** A new round of 10. Replaces a finished one; a round still going is kept. */
  start(): JudgeCheckView;
  answer(itemId: string, answer: JudgeCheckAnswer): JudgeCheckView;
  /** Put the card away; the answers stay. */
  putAway(): JudgeCheckView;
  /** Pick the round up again. */
  resume(): JudgeCheckView;
}

export interface JudgeCheckOptions {
  items: OwnerTierItems;
  /** One item by id with its preview (tier-owner-items.ts getOwnerTierItem). */
  get: (itemId: string) => OwnerTierItem | undefined;
  path?: string;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  /** For the random picks; tests pass a seeded one. */
  random?: () => number;
}

export class JudgeCheckError extends Error {
  constructor(readonly code: 'no_round' | 'not_current' | 'invalid_answer', message: string) {
    super(message);
  }
}

export function judgeCheckPath(env: Record<string, string | undefined> = process.env): string {
  return env[JUDGE_CHECK_PATH_ENV]?.trim() || defaultOwnerConfigPath('judge-check.json', env);
}

/**
 * The 95% Wilson score interval for `agreed` of `compared`: the range the
 * judge's true agreement rate likely sits in. Narrower with more answers.
 */
export function wilsonInterval(agreed: number, compared: number, z = 1.96): { low: number; high: number } {
  if (compared <= 0) return { low: 0, high: 1 };
  const p = agreed / compared;
  const z2 = z * z;
  const denominator = 1 + z2 / compared;
  const centre = (p + z2 / (2 * compared)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / compared + z2 / (4 * compared * compared))) / denominator;
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/** The judge's confidence from its stored reason code (`<category>:<confidence>`); 1 when none is stored. */
export function judgeConfidence(reason: string | null): number {
  if (!reason) return 1;
  const last = reason.slice(reason.lastIndexOf(':') + 1);
  const value = Number(last);
  return Number.isFinite(value) && last.trim() !== '' ? value : 1;
}

/**
 * Items the judge itself labelled, with its verdict recorded: not a default
 * still waiting for the judge, not the owner, not an owner rule, and not moving.
 */
function judged(item: OwnerTierItem): item is OwnerTierItem & { tier: JudgeLabel } {
  return (item.tier === 'Personal' || item.tier === 'Private')
    && item.decided_by === 'sniffer'
    && item.judge_reason !== null
    && !item.owner_set
    && item.moving_to === undefined;
}

/** How many of a round's random picks were compared (Not sure left out), and how many the judge agreed with. */
function randomTally(items: readonly StoredRoundItem[]): { compared: number; agreed: number } {
  const compared = items.filter((item) => item.random && item.answer !== undefined && item.answer !== 'not_sure');
  return { compared: compared.length, agreed: compared.filter((item) => item.answer === item.judge).length };
}

export function createJudgeCheck(options: JudgeCheckOptions): JudgeCheck {
  const path = options.path ?? judgeCheckPath(options.env);
  const random = options.random ?? Math.random;

  const read = (): StoredJudgeCheck => {
    if (!existsSync(path)) return { v: 1 };
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as StoredJudgeCheck;
      return parsed && parsed.v === 1 ? parsed : { v: 1 };
    } catch {
      return { v: 1 };
    }
  };
  const write = (state: StoredJudgeCheck): void => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writePrivateFileAtomicSync(path, `${JSON.stringify(state)}\n`);
  };

  const shown = (itemId: string): JudgeCheckItem => {
    const item = options.get(itemId);
    return {
      item_id: itemId,
      source: item?.source ?? 'unknown',
      family: item?.family ?? 'unknown',
      title: item?.title ?? null,
      sender: item?.sender ?? null,
      location: item?.location ?? null,
      preview: item?.preview ?? null,
    };
  };

  const rangeOf = (state: StoredJudgeCheck): Pick<JudgeCheckView, 'range'> => {
    const now = randomTally(state.round?.items ?? []);
    const from = now.compared + (state.random_tally?.compared ?? 0);
    const agreed = now.agreed + (state.random_tally?.agreed ?? 0);
    return from > 0 ? { range: { ...wilsonInterval(agreed, from), from, agreed } } : {};
  };

  const viewOf = (state: StoredJudgeCheck): JudgeCheckView => {
    const round = state.round;
    if (!round) return { state: 'none', put_away: state.put_away === true, total: 0, answered: [], compared: 0, agreed: 0, not_sure: 0, changed: 0 };
    const answered = round.items.filter((item) => item.answer !== undefined).map((item) => ({
      ...shown(item.item_id), answer: item.answer!, judge: item.judge, changed: item.changed === true,
    }));
    const compared = answered.filter((item) => item.answer !== 'not_sure');
    const agreed = compared.filter((item) => item.answer === item.judge).length;
    const next = round.items.findIndex((item) => item.answer === undefined);
    const done = next < 0;
    return {
      state: done ? 'done' : 'active',
      put_away: state.put_away === true,
      total: round.items.length,
      ...(done ? {} : { current: shown(round.items[next]!.item_id), position: next + 1 }),
      answered,
      compared: compared.length,
      agreed,
      not_sure: answered.length - compared.length,
      changed: answered.filter((item) => item.changed).length,
      ...(done ? rangeOf(state) : {}),
    };
  };

  const sample = (seenOrder: readonly string[]): StoredRoundItem[] => {
    const seen = new Set(seenOrder);
    // Page back through the recently sorted items until the pool holds enough
    // items no round has asked about, or the items run out.
    const unseen: Array<OwnerTierItem & { tier: JudgeLabel }> = [];
    const askedBefore = new Map<string, OwnerTierItem & { tier: JudgeLabel }>();
    // The cursor is the last item's time and id, so items sorted at the same
    // moment as a page's last one are still reached on the next page.
    let cursor: { before: string; beforeItem: string } | undefined;
    for (let page = 0; page < JUDGE_CHECK_MAX_PAGES && unseen.length < JUDGE_CHECK_POOL; page += 1) {
      const found = options.items.find({ recent: true, limit: JUDGE_CHECK_POOL, ...cursor }).items;
      for (const item of found) {
        if (!judged(item)) continue;
        if (seen.has(item.item_id)) askedBefore.set(item.item_id, item);
        else if (!unseen.some((kept) => kept.item_id === item.item_id)) unseen.push(item);
      }
      const last = found.at(-1);
      if (!last?.decided_at || (cursor && last.item_id === cursor.beforeItem)) break;
      cursor = { before: last.decided_at, beforeItem: last.item_id };
    }
    // Nothing new left: ask again about the items asked longest ago.
    const pool = [...unseen];
    for (const id of seenOrder) {
      if (pool.length >= JUDGE_CHECK_ROUND_SIZE) break;
      const again = askedBefore.get(id);
      if (again) pool.push(again);
    }
    const byDoubt = [...pool].sort((left, right) => judgeConfidence(left.judge_reason) - judgeConfidence(right.judge_reason));
    const doubtful = byDoubt.slice(0, Math.max(0, JUDGE_CHECK_ROUND_SIZE - JUDGE_CHECK_RANDOM_PICKS));
    const rest = byDoubt.slice(doubtful.length);
    const picked: Array<{ item: OwnerTierItem & { tier: JudgeLabel }; random: boolean }> = doubtful.map((item) => ({ item, random: false }));
    while (picked.length < JUDGE_CHECK_ROUND_SIZE && rest.length > 0) {
      picked.push({ item: rest.splice(Math.floor(random() * rest.length), 1)[0]!, random: true });
    }
    // Shuffled, so the least sure do not all come first.
    for (let index = picked.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1));
      [picked[index], picked[other]] = [picked[other]!, picked[index]!];
    }
    return picked.map(({ item, random: byChance }) => ({ item_id: item.item_id, judge: item.tier, ...(byChance ? { random: true } : {}) }));
  };

  return {
    status: () => viewOf(read()),
    start() {
      const state = read();
      if (state.round && viewOf(state).state === 'active') {
        state.put_away = false;
        write(state);
        return viewOf(state);
      }
      // Oldest asked first; an item asked again moves to the end.
      const latest = state.round?.items.map((item) => item.item_id) ?? [];
      const seen = [...(state.seen ?? []).filter((id) => !latest.includes(id)), ...latest].slice(-JUDGE_CHECK_SEEN_MAX);
      const next: StoredJudgeCheck = {
        v: 1,
        round: { started_at: (options.now?.() ?? new Date()).toISOString(), items: sample(seen) },
        put_away: false,
        seen,
      };
      // The finished round's random picks join the earlier ones for the overall range.
      const finished = randomTally(state.round?.items ?? []);
      const tally = { compared: (state.random_tally?.compared ?? 0) + finished.compared, agreed: (state.random_tally?.agreed ?? 0) + finished.agreed };
      if (tally.compared > 0) next.random_tally = tally;
      write(next);
      return viewOf(next);
    },
    answer(itemId, answer) {
      if (answer !== 'Personal' && answer !== 'Private' && answer !== 'not_sure') {
        throw new JudgeCheckError('invalid_answer', 'The answer is Personal, Private or Not sure.');
      }
      const state = read();
      const round = state.round;
      if (!round) throw new JudgeCheckError('no_round', 'There is no round to answer. Start one first.');
      const current = round.items.find((item) => item.answer === undefined);
      if (!current || current.item_id !== itemId) {
        throw new JudgeCheckError('not_current', 'That is not the item waiting for an answer.');
      }
      current.answer = answer;
      if (answer !== 'not_sure' && answer !== current.judge) {
        const choice: OwnerItemChoice = answer === 'Personal' ? 'personal' : 'private';
        // The owner's answer settles this one item, on this computer.
        const result = options.items.set({ itemId, choice, allowLower: true });
        current.changed = result.ok;
      }
      write(state);
      return viewOf(state);
    },
    putAway() {
      const state = read();
      state.put_away = true;
      write(state);
      return viewOf(state);
    },
    resume() {
      const state = read();
      state.put_away = false;
      write(state);
      return viewOf(state);
    },
  };
}
