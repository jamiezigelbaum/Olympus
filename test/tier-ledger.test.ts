// The tier ledger (design section 3.3): record a decision, read the current
// row, flip generations with compare-and-swap, list pending items, and keep
// per-item overrides. Custody: identity, tier keys and reason codes only.

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { classifyItemTiers, type TierDecision } from '../src/workers/classification/tier-classifier.ts';
import {
  TierLedger,
  TierLedgerGenerationConflictError,
  tierLedgerPathForStore,
} from '../src/workers/classification/tier-ledger.ts';

const ITEM = { provider: 'fixture', accountScope: 'personal', providerItemId: 'item-1', family: 'file' as const };

function decision(overrides: Partial<TierDecision> = {}): TierDecision {
  return {
    ...classifyItemTiers({ signals: { title: 'Garden plan' }, text: 'weekly notes' }),
    ...overrides,
  };
}

function ledger(): TierLedger {
  let tick = 0;
  return new TierLedger({ dbPath: ':memory:', now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, tick++)) });
}

describe('tier ledger', () => {
  test('records a new item at generation 1 and writes nothing for an unchanged decision', () => {
    const store = ledger();
    const first = store.recordDecision(ITEM, decision(), { trustDomain: 'secure_local', trustTier: 'S4' });
    expect(first.outcome).toBe('inserted');
    expect(first.record).toMatchObject({
      metadataTier: 'private',
      contentTier: 'private',
      generation: 1,
      state: 'current',
      storedTrustDomain: 'secure_local',
      storedTrustTier: 'S4',
      previousContentTier: null,
      decidedBy: 'default',
    });
    const again = store.recordDecision(ITEM, decision(), { trustDomain: 'secure_local', trustTier: 'S4' });
    expect(again.outcome).toBe('unchanged');
    expect(again.record.decidedAt).toBe(first.record.decidedAt);
    expect(store.history(ITEM)).toHaveLength(1);
    store.close();
  });

  test('a changed tier bumps the generation and keeps the previous tiers', () => {
    const store = ledger();
    store.recordDecision(ITEM, decision());
    const raised = store.recordDecision(ITEM, decision({ contentTier: 'secure', decidedBy: 'sensitive_detector' }));
    expect(raised.outcome).toBe('updated');
    expect(raised.record).toMatchObject({ generation: 2, contentTier: 'secure', previousContentTier: 'private', previousMetadataTier: 'private' });

    const reasonsOnly = store.recordDecision(ITEM, decision({ contentTier: 'secure', decidedBy: 'sensitive_detector', reasons: ['x'] }));
    expect(reasonsOnly.outcome).toBe('updated');
    expect(reasonsOnly.record.generation).toBe(2);
    store.close();
  });

  test('flip is compare-and-swap, and a rollback is a flip back', () => {
    const store = ledger();
    const { record } = store.recordDecision(ITEM, decision());
    const moving = store.beginMove(ITEM, { metadataTier: 'private', contentTier: 'secure' }, record.generation);
    expect(moving.state).toBe('moving');
    expect(store.recordDecision(ITEM, decision({ contentTier: 'public' })).outcome).toBe('held_moving');

    expect(() => store.flip(ITEM, { expectedGeneration: 99 })).toThrow(TierLedgerGenerationConflictError);
    const flipped = store.flip(ITEM, { expectedGeneration: 1, stored: { trustDomain: 'secure_local', trustTier: 'S4' } });
    expect(flipped).toMatchObject({ generation: 2, state: 'current', contentTier: 'secure', previousContentTier: 'private', targetContentTier: null });

    const rolledBack = store.flip(ITEM, {
      expectedGeneration: 2,
      metadataTier: flipped.previousMetadataTier!,
      contentTier: flipped.previousContentTier!,
      decidedBy: 'rollback',
    });
    expect(rolledBack).toMatchObject({ generation: 3, contentTier: 'private', previousContentTier: 'secure', decidedBy: 'rollback' });
    expect(store.history(ITEM).map((entry) => entry.generation)).toEqual([1, 2, 3]);
    store.close();
  });

  test('lists pending items and counts by state', () => {
    const store = ledger();
    const pending = classifyItemTiers({ signals: { title: 'biopsy results' } });
    expect(pending.state).toBe('pending');
    store.recordDecision({ ...ITEM, providerItemId: 'b' }, pending);
    store.recordDecision({ ...ITEM, providerItemId: 'a' }, pending);
    store.recordDecision({ ...ITEM, providerItemId: 'c' }, decision());
    expect(store.listPending().map((row) => row.providerItemId)).toEqual(['a', 'b']);
    expect(store.listPending({ after: { ...ITEM, providerItemId: 'a' } }).map((row) => row.providerItemId)).toEqual(['b']);
    expect(store.counts()).toEqual({
      items: 3,
      byState: { pending: 2, current: 1, moving: 0 },
      byContentTier: { public: 0, private: 3, secure: 0, secrets: 0 },
    });
    store.close();
  });

  test('keeps per-item overrides keyed by provider identity', () => {
    const store = ledger();
    expect(store.getOverride(ITEM)).toBeUndefined();
    store.setOverride(ITEM, { kind: 'tier', tier: 'public' });
    expect(store.getOverride(ITEM)).toEqual({ kind: 'tier', tier: 'public' });
    store.setOverride(ITEM, { kind: 'not_secret' });
    expect(store.getOverride(ITEM)).toEqual({ kind: 'not_secret' });
    expect(() => store.setOverride(ITEM, { kind: 'tier', tier: 'bogus' as never })).toThrow(/Unknown tier/);
    expect(store.clearOverride(ITEM)).toBe(true);
    expect(store.getOverride(ITEM)).toBeUndefined();
    store.close();
  });

  test('the ledger file is owner-only and holds no names or text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-tier-ledger-'));
    try {
      const dbPath = tierLedgerPathForStore(join(dir, 'some-store.sqlite'));
      expect(dbPath).toBe(join(dir, 'tier-ledger.sqlite'));
      const store = new TierLedger({ dbPath });
      store.recordDecision(ITEM, classifyItemTiers({
        signals: { title: 'zebracorn medical invoice', path: '/zebracorn/tax.pdf', sender: 'zebracorn@example.com' },
        text: 'zebracorn lab results confirm the diagnosis for the patient',
      }));
      store.close();
      expect(statSync(dbPath).mode & 0o777).toBe(0o600);
      const bytes = readFileSync(dbPath).toString('latin1') + (() => {
        try { return readFileSync(`${dbPath}-wal`).toString('latin1'); } catch { return ''; }
      })();
      expect(bytes).not.toContain('zebracorn');
      expect(bytes).not.toContain('diagnosis');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
