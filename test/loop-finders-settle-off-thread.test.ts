// Family 3 of the loop-thread rule (loop-stall step-back, 15 Nov 2026): the
// settle step's finders (the override pass, the cleared-override walk, the
// sweeps' pages, the move queue, the unread relabel) run on the ledger's read
// worker, and find exactly what the same reads find on the writer's
// connection. test/loop-sql-finders-guard.test.ts holds them off the loop;
// this holds what they find equal to what they found there.

import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TierDecision } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger, type LedgerRead } from '../src/workers/classification/tier-ledger.ts';
import { setReadPoolObserverForTests, shutdownReadPool } from '../src/workers/connector-store/off-thread-reads.ts';
import { findInLedger, runPassHere, runPassOffThread, turn } from '../src/workers/connector-store/loop-pass.ts';

const placement = { copies: [{ corpusId: 'fixture', trustDomain: 'internal' as const, layers: 'both' as const }], embedHold: false };
const decision: TierDecision = {
  metadataTier: 'private', contentTier: 'private', decidedBy: 'override', reasons: ['override:tier:private'],
  state: 'current', contentRead: true, metadataPending: false, contentPending: false, metadataForced: false, metadataFlagged: false,
  engineVersion: 't', mapRevision: 't', snifferId: 't',
};
const dirs: string[] = [];
afterEach(() => {
  setReadPoolObserverForTests();
  shutdownReadPool();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fileLedger(): TierLedger {
  const dir = mkdtempSync(join(tmpdir(), 'loop-finders-settle-'));
  dirs.push(dir);
  return new TierLedger({ dbPath: join(dir, 'tier-ledger.sqlite') });
}

function seed(ledger: TierLedger): void {
  for (let index = 0; index < 40; index += 1) {
    const identity = { provider: 'gmail', accountScope: 'acct', providerItemId: `judged-${String(index).padStart(2, '0')}` };
    ledger.recordRoutedPlacement(identity, { ...decision, decidedBy: 'sniffer', reasons: ['content:sniffer:test:personal'] }, placement);
  }
  // Rows an override decided, one with its override cleared (an undo), one still set.
  for (const id of ['owner-a', 'owner-b', 'owner-c']) ledger.recordRoutedPlacement({ provider: 'gmail', accountScope: 'acct', providerItemId: id }, decision, placement);
  ledger.setOverride({ provider: 'gmail', accountScope: 'acct', providerItemId: 'owner-a' }, { kind: 'tier', tier: 'private' });
  const undone = { provider: 'gmail', accountScope: 'acct', providerItemId: 'judged-07' };
  ledger.setOverride(undone, { kind: 'tier', tier: 'secure' });
  ledger.clearOverride(undone);
  // Waiting for text, held Personal-first, settled fail-safe before `unread`, and a queued move.
  ledger.recordRoutedPlacement({ provider: 'gmail', accountScope: 'acct', providerItemId: 'awaiting' },
    { ...decision, decidedBy: 'default', reasons: ['content:unread'], state: 'pending', contentRead: false, contentPending: true }, placement);
  ledger.recordRoutedPlacement({ provider: 'gmail', accountScope: 'acct', providerItemId: 'first' },
    { ...decision, decidedBy: 'default', reasons: ['content:personal_first'], state: 'pending', contentPending: true }, placement);
  ledger.recordRoutedPlacement({ provider: 'gmail', accountScope: 'acct', providerItemId: 'failsafe' },
    { ...decision, decidedBy: 'sniffer', reasons: ['content:sniffer:test:fail_safe:missing_question'], contentRead: false }, placement);
}

test('each settle finder finds on the read worker what it finds on the writer', async () => {
  const ledger = fileLedger();
  seed(ledger);
  const pooled: string[] = [];
  setReadPoolObserverForTests((path, read) => { if (path === ledger.dbPath) pooled.push(read.sql); }, { snapshots: true });
  const both = async <T>(steps: () => Generator<LedgerRead, T, unknown>) => {
    const before = pooled.length;
    const offThread = await runPassOffThread(findInLedger(ledger, steps));
    expect(pooled.length).toBeGreaterThan(before);
    expect(offThread).toEqual(runPassHere(findInLedger(ledger, steps)) as Awaited<T>);
    return offThread;
  };
  expect(await both(() => ledger.listRoutedOverridesSteps())).toEqual(ledger.listRoutedOverrides());
  expect(await both(() => ledger.clearedOverrideFingerprintSteps())).toBe(ledger.clearedOverrideFingerprint());
  const cleared = await both(() => ledger.listClearedOverrideRowsSteps(2));
  expect(cleared).toEqual(ledger.listClearedOverrideRows(2));
  expect(cleared.length).toBeGreaterThan(0);
  expect(await both(() => ledger.listClearedOverrideRowsSteps(2, cleared.at(-1)))).toEqual(ledger.listClearedOverrideRows(2, cleared.at(-1)));
  expect(await both(() => ledger.listRoutedSteps({ limit: 7 }))).toEqual(ledger.listRouted({ limit: 7 }));
  const after = { provider: 'gmail', accountScope: 'acct', providerItemId: 'judged-10' };
  expect(await both(() => ledger.listRoutedSteps({ after, limit: 7 }))).toEqual(ledger.listRouted({ after, limit: 7 }));
  expect(await both(() => ledger.listAwaitingTextWindowSteps({ limit: 5, examine: 10 }))).toEqual(ledger.listAwaitingTextWindow({ limit: 5, examine: 10 }));
  expect(await both(() => ledger.listPersonalFirstWindowSteps({ limit: 5 }))).toEqual(ledger.listPersonalFirstWindow({ limit: 5 }));
  expect(await both(() => ledger.listMovingSteps({ limit: 5 }))).toEqual(ledger.listMoving({ limit: 5 }));
  expect(await both(() => ledger.unsettledSecretSideStoresSteps(10))).toEqual(ledger.unsettledSecretSideStores(10));
  ledger.close();
});

test('the unread relabel finds its rows on the worker and the loop re-checks each before it writes', async () => {
  const ledger = fileLedger();
  seed(ledger);
  const failsafe = { provider: 'gmail', accountScope: 'acct', providerItemId: 'failsafe' };
  const found = await runPassOffThread(findInLedger(ledger, () => ledger.relabelUnreadFailSafeCandidateSteps()));
  expect(found.length).toBe(1);
  // A row that no longer qualifies is left alone: read on an older snapshot, it is refused here.
  expect(ledger.relabelUnreadFailSafeRows([...found, 999_999])).toBe(1);
  expect(ledger.relabelUnreadFailSafeRows(found)).toBe(0);
  expect(ledger.getCurrent(failsafe)!.reasons).toContain('content:sniffer:test:fail_safe:unread');
  expect(await runPassOffThread(findInLedger(ledger, () => ledger.relabelUnreadFailSafeCandidateSteps()))).toEqual([]);
  ledger.close();
});

test('a pass takes the loop only at its turns and its finders, and a finder that fails reaches the pass', async () => {
  const ledger = fileLedger();
  seed(ledger);
  let turns = 0;
  function* pass() {
    let rows = 0;
    for (const _record of yield* findInLedger(ledger, () => ledger.listRoutedSteps({ limit: 5 }))) { yield* turn(); rows += 1; }
    try {
      yield* findInLedger(ledger, function* () { yield { sql: 'SELECT * FROM no_such_table', params: [], mode: 'all' } as LedgerRead; return 0; });
    } catch {
      return { rows, failed: true };
    }
    return { rows, failed: false };
  }
  expect(await runPassOffThread(pass(), { turn: () => { turns += 1; return undefined; } })).toEqual({ rows: 5, failed: true });
  expect(turns).toBe(5);
  expect(runPassHere(pass())).toEqual({ rows: 5, failed: true });
  ledger.close();
});
