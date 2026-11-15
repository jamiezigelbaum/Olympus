// A loop pass: background work that finds rows, then writes them (loop-stall
// step-back, 15 Nov 2026). On a loop thread a statement only writes, or reads
// by key with a bounded row count; every scan, count or set build is a
// finder and runs on the store's read worker, which hands the writer the rows
// to act on (test/loop-sql-finders-guard.test.ts holds the rule).
//
// A pass is written once, as a generator. It yields each finder (`find`) and
// a turn between the rows it writes (`turn`). `runPassOffThread` is the
// engine's driver: finders run on the read worker and each turn lets the loop
// serve requests. `runPassHere` runs the same pass synchronously on its
// caller's connection, for direct callers that are not the loop (a test, a
// one-shot command). Both make the same decisions: only where the rows are
// found differs. A candidate found on the worker can be older than the
// writer's state, so every write a pass makes re-checks, in its own
// transaction, what it read (the ledger's generation and override guards).

import { ledgerReadOffThread } from './child-visibility.ts';
import type { LedgerRead, TierLedger } from '../classification/tier-ledger.ts';

/** One finder: how to run it here, and how to run it on the read worker. */
export interface LoopFinder<T> {
  here(): T;
  offThread(): Promise<T>;
}

export type LoopPassStep = { find: LoopFinder<unknown> } | { turn: true };
export type LoopPass<T> = Generator<LoopPassStep, T, unknown>;

/** Within a pass: the finder's result (`yield* find(...)`). */
export function* find<T>(finder: LoopFinder<T>): Generator<LoopPassStep, T, unknown> {
  return (yield { find: finder as LoopFinder<unknown> }) as T;
}

/** Within a pass: a point where the loop may serve other work. */
export function* turn(): Generator<LoopPassStep, void, unknown> {
  yield { turn: true };
}

/** A ledger finder: its reads run on the ledger's read worker (or here). */
export function ledgerFinder<T>(ledger: TierLedger, steps: () => Generator<LedgerRead, T, unknown>): LoopFinder<T> {
  return {
    here: () => ledger.readSteps(steps()),
    offThread: () => ledgerReadOffThread(ledger, steps()),
  };
}

/** Within a pass: a ledger finder's result. */
export function findInLedger<T>(ledger: TierLedger, steps: () => Generator<LedgerRead, T, unknown>): Generator<LoopPassStep, T, unknown> {
  return find(ledgerFinder(ledger, steps));
}

/** Runs a pass on its caller's connection, synchronously (not the engine's loop). */
export function runPassHere<T>(pass: LoopPass<T>): T {
  let next = pass.next();
  while (!next.done) {
    const step = next.value;
    if ('turn' in step) { next = pass.next(); continue; }
    let value: unknown;
    try {
      value = step.find.here();
    } catch (error) {
      next = pass.throw(error);
      continue;
    }
    next = pass.next(value);
  }
  return next.value;
}

/** Runs a pass on the loop: finders on the read worker, a turn wherever the pass asks for one. */
export async function runPassOffThread<T>(pass: LoopPass<T>, options: { turn?: () => Promise<void> | undefined } = {}): Promise<T> {
  let next = pass.next();
  while (!next.done) {
    const step = next.value;
    if ('turn' in step) {
      await options.turn?.();
      next = pass.next();
      continue;
    }
    let value: unknown;
    try {
      value = await step.find.offThread();
    } catch (error) {
      next = pass.throw(error);
      continue;
    }
    next = pass.next(value);
  }
  return next.value;
}
