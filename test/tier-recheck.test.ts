// "Check privacy again" for one chat or source (#638): the owner's re-check judges each
// item again from its stored names and text, may lower as well as raise, and never sets
// a tier for the chat. Owner overrides and owner rules still win.

import { afterEach, expect, test } from 'bun:test';
import { classifyItemTiers, type OwnerTierRule, type TierSnifferRequest } from '../src/workers/classification/tier-classifier.ts';
import { emptyTierRejudgeReport, rejudgeRoutedItems, rejudgeStoredContent } from '../src/workers/connector-store/tier-rejudge.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { runTierRecheck } from '../src/workers/classification/tier-cli.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, fixtureLocalId, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });

const CHAT = 'chat-8122';
const text = 'See you at the orchard on Saturday.';

/** Names and content judged Personal now, as the fixed judge answers. */
const personal = {
  id: 'prompt-now',
  judge: (_request: TierSnifferRequest) => ({ verdict: 'decided' as const, tier: 'private' as const, code: 'ordinary' }),
};

/** Two messages of one chat, held Private by an old build's names verdict (the 1.2.1 test-omarchy rows). */
async function stuckChat(rules: readonly OwnerTierRule[] = []) {
  const tmp = tempDir();
  const f = openTierFixture(tmp.dir, { embed: false });
  cleanup.push(() => { f.close(); tmp.cleanup(); });
  const ids = ['first', 'second'];
  await f.set.sync(fixtureConnector(() => ids.map(id => ({ id, name: 'Tiago Ferreira', text, conversation: CHAT }))),
    { fetchContent: true, placement: FIXTURE_PLACEMENT });
  for (const id of ids) {
    const identity = identityOf(id, CHAT);
    await moveTieredItem({ set: f.set, identity, target: { metadataTier: 'secure', contentTier: 'secure' } });
    const decision = { ...classifyItemTiers({ signals: { title: 'Tiago Ferreira' }, text }),
      metadataTier: 'secure' as const, contentTier: 'secure' as const,
      reasons: ['metadata:sniffer:old-build:identity', 'content:no_raise'],
    };
    f.ledger.recordRoutedPlacement(identity, decision, f.set.placementFor(decision));
  }
  // The engine's installed judge (and the owner's rules), as the sniffer service runs the pass.
  f.set.classification = () => ({ sniffer: personal, rules });
  return { f, first: identityOf('first', CHAT), second: identityOf('second', CHAT) };
}

test('without a re-check, a stuck names verdict stays Private (the automatic re-judge keeps older floors)', async () => {
  const { f, first } = await stuckChat();
  rejudgeStoredContent(f.set, f.ledger.getCurrent(first)!, { autoMoves: true, report: emptyTierRejudgeReport(), sniffer: personal });
  expect(f.ledger.getCurrent(first)).toMatchObject({ state: 'current', metadataTier: 'secure', contentTier: 'secure' });
});

test('a re-check of the chat lowers an item stuck Private to Personal when its content is Personal', async () => {
  const { f, first } = await stuckChat();
  expect(f.ledger.requestRecheck({ conversationKey: CHAT })).toEqual({ items: 2 });
  const { report } = rejudgeRoutedItems({ set: f.set, autoMoves: true });
  expect(report).toMatchObject({ rechecked: 2, failed: 0 });
  expect(f.ledger.getCurrent(first)).toMatchObject({ state: 'moving', targetMetadataTier: 'private', targetContentTier: 'private' });
  await moveTieredItem({ set: f.set, identity: first, target: { metadataTier: 'private', contentTier: 'private' } });
  expect(f.ledger.getCurrent(first)).toMatchObject({ metadataTier: 'private', contentTier: 'private' });
  expect(f.stores.internal!.localContent(fixtureLocalId({ id: 'first', conversation: CHAT }))?.chunks.join('')).toBe(text);
  // The request is done: the next pass does not re-check the chat again.
  expect(f.ledger.recheckRequests()).toEqual([]);
  expect(rejudgeRoutedItems({ set: f.set, autoMoves: true }).report.rechecked).toBe(0);
});

test('an owner override on one item of the chat survives the re-check', async () => {
  const { f, first, second } = await stuckChat();
  f.ledger.setOverride(second, { kind: 'tier', tier: 'secure' });
  f.ledger.requestRecheck({ conversationKey: CHAT });
  const { report } = rejudgeRoutedItems({ set: f.set, autoMoves: true });
  expect(report.failed).toBe(0);
  expect(f.ledger.getCurrent(first)).toMatchObject({ state: 'moving', targetContentTier: 'private' });
  expect(f.ledger.getCurrent(second)).toMatchObject({ state: 'current', metadataTier: 'secure', contentTier: 'secure' });
  expect(f.ledger.getOverride(second)).toEqual({ kind: 'tier', tier: 'secure' });
  expect(f.stores.internal!.localContent(fixtureLocalId({ id: 'second', conversation: CHAT }))).toBeUndefined();
});

test('an owner chat rule still holds the chat Private through a re-check', async () => {
  const rule: OwnerTierRule = { id: 'tiago-private', match: { kind: 'chat', value: CHAT }, tier: 'secure', strength: 'prior' };
  const { f, first, second } = await stuckChat([rule]);
  f.ledger.requestRecheck({ conversationKey: CHAT });
  rejudgeRoutedItems({ set: f.set, autoMoves: true });
  for (const identity of [first, second]) {
    expect(f.ledger.getCurrent(identity)).toMatchObject({ state: 'current', metadataTier: 'secure', contentTier: 'secure' });
  }
  expect(f.stores.internal!.localContent(fixtureLocalId({ id: 'first', conversation: CHAT }))).toBeUndefined();
});

test('names resting on a provider floor are not lowered by a re-check', async () => {
  const { f, first } = await stuckChat();
  const record = f.ledger.getCurrent(first)!;
  const decision = { ...classifyItemTiers({ signals: { title: 'Tiago Ferreira' }, text }),
    metadataTier: 'secure' as const, contentTier: 'secure' as const,
    reasons: ['metadata:floor:provider-secret-chat', 'metadata:sniffer:old-build:identity', 'content:no_raise'],
  };
  f.ledger.recordRoutedPlacement(first, decision, f.set.placementFor(decision), { guard: { generation: record.generation, override: undefined } });
  f.ledger.requestRecheck({ conversationKey: CHAT });
  rejudgeRoutedItems({ set: f.set, autoMoves: true });
  expect(f.ledger.getCurrent(first)).toMatchObject({ state: 'current', metadataTier: 'secure', contentTier: 'secure' });
});

test('a re-check of a source covers only that source, and a scope with no items asks for nothing', async () => {
  const { f, first } = await stuckChat();
  expect(f.ledger.requestRecheck({ provider: 'another-source' })).toEqual({ items: 0 });
  expect(f.ledger.recheckRequests()).toEqual([]);
  expect(f.ledger.requestRecheck({ provider: first.provider })).toEqual({ items: 2 });
  expect(rejudgeRoutedItems({ set: f.set, autoMoves: true, limit: 1 }).report.rechecked).toBe(1);
  expect(f.ledger.recheckRequests()).toHaveLength(1);
  expect(rejudgeRoutedItems({ set: f.set, autoMoves: true, limit: 5 }).report.rechecked).toBe(1);
  expect(f.ledger.recheckRequests()).toEqual([]);
});

test('olympus tier recheck records the request in the ledger that holds the chat', async () => {
  const { f, first } = await stuckChat();
  const storePaths = [f.paths.internal, f.paths.secure_local];
  expect(runTierRecheck([`chat:${CHAT}`], { storePaths })).toMatchObject({ items: 2, ledgers: 1, outcome: 'recheck_requested' });
  expect(f.ledger.recheckRequests()).toEqual([expect.objectContaining({ scope: { conversationKey: CHAT } })]);
  expect(runTierRecheck([`source:${first.provider}`, '--account', first.accountScope], { storePaths })).toMatchObject({ items: 2 });
  expect(() => runTierRecheck(['chat:nobody'], { storePaths })).toThrow('No stored items match');
  expect(() => runTierRecheck(['everything'], { storePaths })).toThrow('Usage');
  expect(() => runTierRecheck([`chat:${CHAT}`, '--account', 'x'], { storePaths })).toThrow('Usage');
});
