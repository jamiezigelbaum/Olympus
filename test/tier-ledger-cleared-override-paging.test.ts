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

test('the cleared-override search reads the overridden rows and saved undos, never every routed row', () => {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  // Many items the judge decided and one an override decided.
  for (let index = 0; index < 300; index += 1) {
    ledger.recordRoutedPlacement({ provider: 'gmail', accountScope: 'acct', providerItemId: `judged-${index}` },
      { ...decision, decidedBy: 'sniffer', reasons: ['content:sniffer:test:personal'] }, placement);
  }
  ledger.recordRoutedPlacement({ provider: 'gmail', accountScope: 'acct', providerItemId: 'owner' }, decision, placement);
  const db = (ledger as unknown as { db: { query(sql: string): { all(...params: unknown[]): unknown[] } } }).db;
  const seen: string[] = [];
  const query = db.query.bind(db);
  db.query = (sql: string) => { seen.push(sql); return query(sql); };
  expect(ledger.listClearedOverrideRows().map((row) => row.providerItemId)).toEqual(['owner']);
  db.query = query;
  const search = seen.find((sql) => sql.includes('tier_items_override_rows'))!;
  const plan = (query(`EXPLAIN QUERY PLAN ${search}`).all('[]', null, null, null, null, null, 100) as Array<{ detail: string }>)
    .map((row) => row.detail).join('\n');
  expect(plan).toContain('tier_items_override_rows');
  // tier_items (alias i) is reached only through the override index or by its whole key, never scanned or walked by state.
  const reads = plan.split('\n').filter((line) => /^(SCAN|SEARCH) i\b/.test(line));
  expect(reads.length).toBe(2);
  for (const line of reads) expect(line.includes('tier_items_override_rows') || line.includes('provider_item_id=?')).toBe(true);
});
