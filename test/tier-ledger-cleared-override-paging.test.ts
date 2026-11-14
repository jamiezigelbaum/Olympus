// The undo pass pages cleared overrides by identity (tier-override-settle.ts),
// so rows it cannot restore never hold back the ones after them.

import { expect, test } from 'bun:test';
import type { TierDecision } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';

const placement = { copies: [{ corpusId: 'fixture', trustDomain: 'internal' as const, layers: 'both' as const }], embedHold: false };
const decision: TierDecision = {
  metadataTier: 'private', contentTier: 'private', decidedBy: 'override', reasons: ['override:tier:private'],
  state: 'current', contentRead: true, metadataPending: false, contentPending: false, metadataForced: false, metadataFlagged: false,
  engineVersion: 't', mapRevision: 't', snifferId: 't',
};

test('cleared overrides page past earlier rows', () => {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  for (const id of ['a', 'b', 'c']) {
    const identity = { provider: 'gmail', accountScope: 'acct', providerItemId: id };
    if (id === 'b') {
      // A carried restore request is paged among ordinary cleared overrides,
      // even though its current decider is no longer the override.
      ledger.recordRoutedPlacement(identity, { ...decision, decidedBy: 'sniffer', reasons: ['content:sniffer:test:personal'] }, placement);
      ledger.setOverride(identity, { kind: 'tier', tier: 'secure' });
      ledger.clearOverride(identity);
    } else {
      ledger.recordRoutedPlacement(identity, decision, placement);
    }
  }
  const first = ledger.listClearedOverrideRows(2);
  expect(first.map((row) => row.providerItemId)).toEqual(['a', 'b']);
  const next = ledger.listClearedOverrideRows(2, first[first.length - 1]);
  expect(next.map((row) => row.providerItemId)).toEqual(['c']);
  expect(ledger.listClearedOverrideRows(2, next[0])).toEqual([]);
  ledger.close();
});

// The undo pass reads every routed item, so the background skips it while its
// inputs are unchanged (the 5 to 33 s background freezes on Sparta, 14 Nov).
test('the cleared-override fingerprint moves with overrides, undo requests and moves, and only with them', () => {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const a = { provider: 'gmail', accountScope: 'acct', providerItemId: 'a' };
  const b = { provider: 'gmail', accountScope: 'acct', providerItemId: 'b' };
  ledger.recordRoutedPlacement(a, { ...decision, decidedBy: 'sniffer', reasons: ['content:sniffer:test:personal'] }, placement);
  const quiet = ledger.clearedOverrideFingerprint();
  // An ordinary judgment of another item leaves it as it was.
  ledger.recordRoutedPlacement(b, { ...decision, decidedBy: 'sniffer', reasons: ['content:sniffer:test:private'] }, placement);
  expect(ledger.clearedOverrideFingerprint()).toBe(quiet);
  ledger.setOverride(a, { kind: 'tier', tier: 'secure' });
  const set = ledger.clearedOverrideFingerprint();
  expect(set).not.toBe(quiet);
  ledger.clearOverride(a);
  expect(ledger.clearedOverrideFingerprint()).not.toBe(set);
  const cleared = ledger.clearedOverrideFingerprint();
  ledger.recordRoutedPlacement(b, { ...decision, decidedBy: 'sniffer', reasons: ['content:sniffer:test:private'], state: 'moving' } as unknown as TierDecision, placement);
  expect(ledger.clearedOverrideFingerprint()).not.toBe(cleared);
  ledger.close();
});
