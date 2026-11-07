import { expect, test } from 'bun:test';
import type { RawItem } from '../src/core/contracts.ts';
import type { AnalystModel } from '../src/core/analyst.ts';
import { decideItemTiers } from '../src/workers/connector-store/tier-placement.ts';
import { CachedTierSniffer } from '../src/workers/classification/sniffer.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';

const lane: SnifferLane = {
  kind: 'local', profileId: 'fixture', modelId: 'fixture',
  profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture' },
};
const cases = [
  ['direct-personal', 'direct'], ['small-private', 'small'], ['unknown-personal', undefined],
  ['large-personal', 'large'], ['small-personal', 'small'], ['direct-private', 'direct'],
  ['unknown-private', undefined], ['large-private', 'large'],
] as const;
const connector = { classificationSignals: (item: RawItem) => ({
  title: String(item.metadata.title), labels: ['SSN 123-45-6789'],
}) };
function item(id: string, size?: string): RawItem {
  return {
    identity: { family: 'chat', provider: 'fixture', accountScope: 'owner', providerItemId: id, localItemId: id },
    mimeType: 'text/plain', content: { kind: 'metadata_only' }, fetchedAt: '2026-11-07T00:00:00Z',
    metadata: { title: id, ...(size ? { conversationSize: size } : {}) },
  };
}

test('direct and small chats precede unknown sizes and large groups, with stable newest-first ties', () => {
  const store = new TierSnifferStore({ dbPath: ':memory:', now: () => new Date('2026-11-07T00:00:00Z') });
  try {
    for (const [id, size] of cases) decideItemTiers(connector, item(id, size), undefined, { sniffer: new CachedTierSniffer(store, lane) }, undefined);
    expect(store.listQuestions().map(question => question.providerItemId)).toEqual([
      'direct-private', 'small-personal', 'small-private', 'direct-personal',
      'unknown-private', 'unknown-personal', 'large-private', 'large-personal',
    ]);
    // Ordering happens before the bounded page is selected, not just within it.
    expect(store.listQuestions({ limit: 2 }).slice(0, 2).map(question => question.providerItemId))
      .toEqual(['direct-private', 'small-personal']);
  } finally { store.close(); }
});

test('refreshing a size hint reorders a question without resetting its attempts, hold or material', () => {
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  try {
    const subject = item('refresh').identity;
    const question = { subject, pass: 'content' as const, material: 'same item text', mapRevision: 'none', flags: [] };
    store.enqueue({ ...question, conversationOrder: -1 });
    store.recordAttemptFailure(subject, 'content');
    store.markHeldLowering(store.questionFor(subject, 'content')!, 'fixture');
    const before = store.questionFor(subject, 'content')!;
    store.enqueue({ ...question, conversationOrder: 1 });
    expect(store.questionFor(subject, 'content')).toEqual({ ...before, conversationOrder: 1 });
    expect(store.questionWorkCounts('fixture')).toEqual({ unanswered: 0, heldLowering: 1 });
  } finally { store.close(); }
});

test('changing only queue order preserves each item’s material, cache key, pending hold and final verdict', async () => {
  async function judge(ordered: boolean) {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    try {
      const pending = new Map();
      for (const [id, size] of cases) {
        const raw: RawItem = { ...item(id, ordered ? size : undefined),
          content: { kind: 'text', text: `We can meet by the park after lunch. ${id}` }, holdContentUntilJudged: true };
        const contentConnector = { classificationSignals: (value: RawItem) => ({ title: String(value.metadata.title) }) };
        const decision = decideItemTiers(contentConnector, raw, raw.content.kind === 'text' ? raw.content.text : undefined, { sniffer: new CachedTierSniffer(store, lane) }, ledger);
        pending.set(id, decision);
        ledger.recordDecision(raw.identity, decision);
      }
      const questions = Object.fromEntries(store.listQuestions().map(q => [q.providerItemId, {
        material: q.material, materialHash: q.materialHash, flags: q.flags, mapRevision: q.mapRevision,
      }]));
      const prompts: string[] = [];
      const model: AnalystModel = { async complete(request) {
        prompts.push(request.prompt);
        const privateItem = request.prompt.includes('-private');
        return { modelId: lane.modelId, text: JSON.stringify({ verdicts: [{
          i: 1, tier: privateItem ? 'private' : 'personal', category: privateItem ? 'financial' : 'ordinary',
          ownRecord: privateItem, privateKind: privateItem ? 'financial' : 'none', confidence: 1,
        }] }) };
      } };
      const report = await runSnifferPass({ targets: [{ ledger, sniffer: store }], lane, model, maxCallsPerPass: 20 });
      expect(report.verdictsApplied).toBe(cases.length);
      expect(store.counts().questions).toBe(0);
      const verdicts = Object.fromEntries(cases.map(([id]) => {
        const row = ledger.getCurrent(item(id).identity)!;
        expect(row.state).toBe('current');
        expect(row.contentTier).toBe(id.endsWith('-private') ? 'secure' : 'private');
        return [id, { metadataTier: row.metadataTier, contentTier: row.contentTier, reasons: row.reasons,
          decidedBy: row.decidedBy, state: row.state, metadataPending: row.metadataPending, contentPending: row.contentPending }];
      }));
      return { pending, questions, verdicts, prompts };
    } finally { store.close(); ledger.close(); }
  }
  const baseline = await judge(false);
  const ordered = await judge(true);
  expect(ordered.pending).toEqual(baseline.pending);
  expect(ordered.questions).toEqual(baseline.questions);
  expect(ordered.verdicts).toEqual(baseline.verdicts);
  expect(ordered.prompts).not.toEqual(baseline.prompts);
  expect([...ordered.prompts].sort()).toEqual([...baseline.prompts].sort());
});

test('a higher-priority question from a large group still runs before an ordinary direct chat', () => {
  const store = new TierSnifferStore({ dbPath: ':memory:', now: () => new Date('2026-11-07T00:00:00Z') });
  try {
    const base = { pass: 'content' as const, mapRevision: 'none', flags: [] };
    store.enqueue({ ...base, subject: item('direct-ordinary').identity, material: 'a', conversationOrder: 1 });
    store.enqueue({ ...base, subject: item('large-held').identity, material: 'b', conversationOrder: -1, priority: 10 });
    expect(store.listQuestions().map(question => question.providerItemId)).toEqual(['large-held', 'direct-ordinary']);
  } finally { store.close(); }
});

test('a re-enqueue with no size hint (a re-judge) keeps the order an earlier hint gave', () => {
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  try {
    const subject = item('rejudged').identity;
    const question = { subject, pass: 'content' as const, material: 'same item text', mapRevision: 'none', flags: [] };
    store.enqueue({ ...question, conversationOrder: -1 });
    store.enqueue(question);
    expect(store.questionFor(subject, 'content')?.conversationOrder).toBe(-1);
    store.enqueue({ ...question, conversationOrder: 1 });
    expect(store.questionFor(subject, 'content')?.conversationOrder).toBe(1);
  } finally { store.close(); }
});
