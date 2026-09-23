// P1b tier ledger: store copies are the visibility switch (design section 3.3).
// A routed item's copies are current, staged or superseded; a move stages the
// destination, then one flip makes it current and supersedes the source; a
// raise hides first; rollback is a flip back. Legacy (pre-P1b) items have no
// copy rows and the ledger never gives them any on its own.

import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { classifyItemTiers, type TierDecision } from '../src/workers/classification/tier-classifier.ts';
import {
  TierLedger,
  TierLedgerGenerationConflictError,
  placementIsRaise,
  type TierPlacementPlan,
} from '../src/workers/classification/tier-ledger.ts';

const ITEM = { provider: 'fixture', accountScope: 'personal', providerItemId: 'item-1', family: 'file' as const };
const INTERNAL = { corpusId: 'internal.fixture.files', trustDomain: 'internal' as const };
const SECURE = { corpusId: 'secure_local.fixture.files', trustDomain: 'secure_local' as const };
const PUBLIC = { corpusId: 'public_safe.fixture.files', trustDomain: 'public_safe' as const };

function decision(overrides: Partial<TierDecision> = {}): TierDecision {
  return { ...classifyItemTiers({ signals: { title: 'Garden plan' }, text: 'weekly notes' }), ...overrides };
}

function ledger(): TierLedger {
  let tick = 0;
  return new TierLedger({ dbPath: ':memory:', now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, tick++)) });
}

function whole(target: { corpusId: string; trustDomain: 'public_safe' | 'internal' | 'secure_local' }, embedHold = false): TierPlacementPlan {
  return { copies: [{ ...target, layers: 'both' }], embedHold };
}

describe('tier ledger copies (P1b)', () => {
  test('a first placement records the decision and current copies in one write', () => {
    const store = ledger();
    const placed = store.recordRoutedPlacement(ITEM, decision(), {
      copies: [{ ...INTERNAL, layers: 'metadata' }, { ...SECURE, layers: 'content' }],
      embedHold: false,
    });
    expect(placed.outcome).toBe('inserted');
    expect(placed.record).toMatchObject({ routed: true, generation: 1, state: 'current' });
    expect(store.copies(ITEM).map((copy) => [copy.corpusId, copy.layers, copy.state])).toEqual([
      [INTERNAL.corpusId, 'metadata', 'current'],
      [SECURE.corpusId, 'content', 'current'],
    ]);
    expect(store.isRouted(ITEM)).toBe(true);
    // Same plan again: nothing to write.
    expect(store.recordRoutedPlacement(ITEM, decision(), {
      copies: [{ ...INTERNAL, layers: 'metadata' }, { ...SECURE, layers: 'content' }],
      embedHold: false,
    }).outcome).toBe('unchanged');
    store.close();
  });

  test('a legacy row recorded by P1a never gains copies unless routed or adopted', () => {
    const store = ledger();
    store.recordDecision(ITEM, decision(), { trustDomain: 'secure_local', trustTier: 'S4' });
    expect(store.isRouted(ITEM)).toBe(false);
    expect(store.copies(ITEM)).toEqual([]);
    expect(store.copiesForMany([ITEM]).size).toBe(0);
    expect(() => store.stageMove(ITEM, {
      expectedGeneration: 1,
      target: { metadataTier: 'private', contentTier: 'private' },
      destination: [{ ...INTERNAL, layers: 'both' }],
      hideSource: false,
    })).toThrow(/adopt the legacy placement/);
    store.close();
  });

  test('a routed item whose decision needs other stores is queued, never moved, and a raise hides first', () => {
    const store = ledger();
    store.recordRoutedPlacement(ITEM, decision(), whole(INTERNAL));
    const raised = store.recordRoutedPlacement(ITEM, decision({ contentTier: 'secure', decidedBy: 'sensitive_detector' }), {
      copies: [{ ...INTERNAL, layers: 'metadata' }, { ...SECURE, layers: 'content' }],
      embedHold: false,
    });
    expect(raised).toMatchObject({ outcome: 'queued_move', raise: true });
    expect(raised.record).toMatchObject({ state: 'moving', contentTier: 'private', targetContentTier: 'secure', generation: 1 });
    expect(store.copies(ITEM)).toEqual([expect.objectContaining({ corpusId: INTERNAL.corpusId, state: 'superseded', supersededByGeneration: 2 })]);
    // The move owns the row now.
    expect(store.recordRoutedPlacement(ITEM, decision(), whole(INTERNAL)).outcome).toBe('held_moving');
    store.close();

    const lowering = ledger();
    lowering.recordRoutedPlacement(ITEM, decision({ contentTier: 'secure' }), whole(SECURE));
    const lowered = lowering.recordRoutedPlacement(ITEM, decision(), whole(INTERNAL));
    expect(lowered).toMatchObject({ outcome: 'queued_move', raise: false });
    // A lowering keeps the more private copy current until the move flips.
    expect(lowering.copies(ITEM)).toEqual([expect.objectContaining({ corpusId: SECURE.corpusId, state: 'current' })]);
    lowering.close();
  });

  test('stage, flip and roll back: the item is current in exactly one set of stores at every step', () => {
    const store = ledger();
    store.recordRoutedPlacement(ITEM, decision({ contentTier: 'secure' }), whole(SECURE));
    const visible = () => store.copies(ITEM).filter((copy) => copy.state === 'current').map((copy) => copy.corpusId);

    const staged = store.stageMove(ITEM, {
      expectedGeneration: 1,
      target: { metadataTier: 'private', contentTier: 'private' },
      destination: [{ ...INTERNAL, layers: 'both' }],
      hideSource: false,
    });
    expect(staged.state).toBe('moving');
    expect(visible()).toEqual([SECURE.corpusId]);
    expect(store.copies(ITEM).find((copy) => copy.corpusId === INTERNAL.corpusId)?.state).toBe('staged');

    expect(() => store.completeMove(ITEM, { expectedGeneration: 7 })).toThrow(TierLedgerGenerationConflictError);
    const flipped = store.completeMove(ITEM, { expectedGeneration: 1 });
    expect(flipped).toMatchObject({ generation: 2, state: 'current', contentTier: 'private', previousContentTier: 'secure' });
    expect(visible()).toEqual([INTERNAL.corpusId]);
    expect(store.copies(ITEM).find((copy) => copy.corpusId === SECURE.corpusId)).toMatchObject({ state: 'superseded', supersededByGeneration: 2 });

    const rolledBack = store.rollbackMove(ITEM, { expectedGeneration: 2 });
    expect(rolledBack).toMatchObject({ generation: 3, contentTier: 'secure', decidedBy: 'rollback' });
    expect(visible()).toEqual([SECURE.corpusId]);
    expect(store.copies(ITEM).find((copy) => copy.corpusId === INTERNAL.corpusId)?.state).toBe('superseded');
    store.close();
  });

  test('a raise hides the source before the destination is written', () => {
    const store = ledger();
    store.recordRoutedPlacement(ITEM, decision(), whole(INTERNAL));
    store.stageMove(ITEM, {
      expectedGeneration: 1,
      target: { metadataTier: 'secure', contentTier: 'secure' },
      destination: [{ ...SECURE, layers: 'both' }],
      hideSource: true,
    });
    expect(store.copies(ITEM).filter((copy) => copy.state === 'current')).toEqual([]);
    store.completeMove(ITEM, { expectedGeneration: 1 });
    expect(store.copies(ITEM).filter((copy) => copy.state === 'current').map((copy) => copy.corpusId)).toEqual([SECURE.corpusId]);
    // The Personal copy (and its cloud vectors) is kept, hidden: owner ruling.
    expect(store.copies(ITEM).find((copy) => copy.corpusId === INTERNAL.corpusId)?.state).toBe('superseded');
    store.close();
  });

  test('a destination the item is already current in is refused', () => {
    const store = ledger();
    store.recordRoutedPlacement(ITEM, decision(), whole(INTERNAL));
    expect(() => store.stageMove(ITEM, {
      expectedGeneration: 1,
      target: { metadataTier: 'private', contentTier: 'private' },
      destination: [{ ...INTERNAL, layers: 'both' }],
      hideSource: false,
    })).toThrow(/not current in/);
    store.close();
  });

  test('Secrets drop every copy and return where they were', () => {
    const store = ledger();
    store.recordRoutedPlacement(ITEM, decision(), whole(PUBLIC));
    const secret = store.recordRoutedPlacement(ITEM, decision({ contentTier: 'secrets', decidedBy: 'secret_detector' }), {
      copies: [],
      embedHold: false,
    });
    expect(secret.outcome).toBe('secrets');
    expect(secret.previousCopies.map((copy) => copy.corpusId)).toEqual([PUBLIC.corpusId]);
    expect(store.copies(ITEM)).toEqual([]);
    expect(store.isRouted(ITEM)).toBe(true);
    store.close();
  });

  test('copiesForMany reads one snapshot; counts and held identities are per store', () => {
    const store = ledger();
    const other = { ...ITEM, providerItemId: 'item-2' };
    store.recordRoutedPlacement(ITEM, decision(), whole(SECURE, true));
    store.recordRoutedPlacement(other, decision(), whole(INTERNAL));
    const map = store.copiesForMany([ITEM, other, { ...ITEM, providerItemId: 'missing' }]);
    expect(map.size).toBe(2);
    expect(store.corpusCopyIdentities(SECURE.corpusId, 'held').map((row) => row.providerItemId)).toEqual(['item-1']);
    expect(store.corpusCopyCounts(SECURE.corpusId)).toEqual({ current: 1, superseded: 0, staged: 0, held: 1, moving: 0 });
    expect(store.removeCopies(ITEM).map((copy) => copy.corpusId)).toEqual([SECURE.corpusId]);
    expect(store.corpusCopyCounts(SECURE.corpusId).current).toBe(0);
    store.close();
  });

  test('set cursors are written only when committed', () => {
    const store = ledger();
    expect(store.setCursor('set', 'conn')).toBeUndefined();
    store.commitSetCursor('set', 'conn', 'page-2');
    expect(store.setCursor('set', 'conn')?.cursor).toBe('page-2');
    store.commitSetCursor('set', 'conn', null);
    expect(store.setCursor('set', 'conn')?.cursor).toBeNull();
    store.close();
  });

  test('a P1a (schema 1) ledger upgrades additively: rows kept, none routed, no copies', () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-tier-ledger-v1-'));
    try {
      const dbPath = join(dir, 'tier-ledger.sqlite');
      // Build a schema-1 file by hand, the way P1a left it.
      const v1 = new TierLedger({ dbPath });
      v1.recordDecision(ITEM, decision(), { trustDomain: 'secure_local', trustTier: 'S4' });
      v1.close();
      const raw = new Database(dbPath);
      raw.exec(`
        DROP TABLE tier_copies; DROP TABLE tier_set_cursors;
        ALTER TABLE tier_items DROP COLUMN routed;
        UPDATE schema_version SET version = 1 WHERE store_id = 'olympus_tier_ledger';
      `);
      raw.close();

      const upgraded = new TierLedger({ dbPath });
      expect(upgraded.getCurrent(ITEM)).toMatchObject({ routed: false, storedTrustDomain: 'secure_local', generation: 1 });
      expect(upgraded.copies(ITEM)).toEqual([]);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('raise detection compares the store serving each layer', () => {
    const both = (domain: 'public_safe' | 'internal' | 'secure_local') => [{ trustDomain: domain, layers: 'both' as const }];
    expect(placementIsRaise(both('internal'), both('secure_local'))).toBe(true);
    expect(placementIsRaise(both('secure_local'), both('internal'))).toBe(false);
    expect(placementIsRaise(both('public_safe'), both('internal'))).toBe(true);
    expect(placementIsRaise(both('internal'), [
      { trustDomain: 'internal', layers: 'metadata' },
      { trustDomain: 'secure_local', layers: 'content' },
    ])).toBe(true);
  });
});
