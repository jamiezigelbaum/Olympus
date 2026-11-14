// A file read on demand is judged at once: the question waiting for it is the
// answer the judge would otherwise stand back 15 s for.
import { expect, test } from 'bun:test';
import { ARRIVAL_STAND_BACK_MS, TierSnifferService } from '../src/workers/classification/sniffer-service.ts';

test('an on-demand read waiting for its content judgment gets the arrival turn without the stand-back', () => {
  let now = 1_000_000;
  let onDemand = true;
  const question = { provider: 'fixture', accountScope: 'one', providerItemId: 'scan', pass: 'content' };
  const sniffer = { arrivalContentQuestions: () => [question], hasArrivalWaiting: () => true };
  const store = {
    dbPath: '/fixture/items.sqlite',
    onDemandReadCandidate: () => ({ identity: { provider: 'fixture', accountScope: 'one', localItemId: 'scan' } }),
    readOnDemand: () => onDemand,
  };
  const service = new TierSnifferService({
    installed: new Proxy({ snifferStoreForLedger: () => sniffer }, { get: (target, key) => (target as Record<string | symbol, unknown>)[key] ?? (() => undefined) }) as never,
    lane: { kind: 'local', modelId: 'm', profileId: 'p', profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'm' } } as never,
    model: { complete: async () => ({ text: '{}', modelId: 'm' }) },
    stores: () => [store] as never,
    monotonicNow: () => now,
    now: () => new Date(now),
  } as never) as unknown as { arrivalTurnDue(): boolean; heldBackSinceMs?: number; ledgers: Map<string, unknown>; ledgerPaths(): string[]; clockMs(): number };
  service.ledgers.set('/fixture/items.tier-ledger.sqlite', {});
  service.ledgerPaths = () => ['/fixture/items.tier-ledger.sqlite'];
  service.heldBackSinceMs = service.clockMs();
  expect(service.arrivalTurnDue()).toBe(true);
  // An ordinary arrival still stands back first.
  onDemand = false;
  expect(service.arrivalTurnDue()).toBe(false);
  now += ARRIVAL_STAND_BACK_MS;
  expect(service.arrivalTurnDue()).toBe(true);
});
