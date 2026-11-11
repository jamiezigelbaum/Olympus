import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { BUILT_IN_SNIFFER_LANE } from '../src/workers/classification/built-in-sniffer.ts';
import { CachedTierSniffer, snifferCacheModelId, snifferId, snifferPromptVersions, SNIFFER_UNION_VERSION } from '../src/workers/classification/sniffer.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { TierSnifferStore, snifferMaterialHash } from '../src/workers/classification/sniffer-store.ts';
import { classifyItemTiers, TIER_CLASSIFIER_VERSION, HELD_UNTIL_JUDGED_PRIORITY } from '../src/workers/classification/tier-classifier.ts';
import { QWEN35_2B, QWEN35_4B, QWEN35_9B } from '../src/workers/source-index/built-in-reasoning/manifest.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { registerInstalledTierClassification } from '../src/workers/classification/installed-tier-classification-registry.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/local-index.ts';
import { TieredStoreSet } from '../src/workers/connector-store/tiered-store-set.ts';
import { rejudgeRoutedItems } from '../src/workers/connector-store/tier-rejudge.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { FIXTURE_PLACEMENT, fixtureConnector, identityOf, CORPORA } from './helpers/tier-fixtures.ts';

const prompt = snifferPromptVersions().cache;
const weights = (spec: typeof QWEN35_4B) => `${spec.modelId}:${spec.revision}:${spec.file.sha256}`;
const lane: SnifferLane = { ...BUILT_IN_SNIFFER_LANE, cacheModelId: weights(QWEN35_4B) };
// Independent reconstruction of the shipped pre-union key, not the changed function.
const oldId = (lane: SnifferLane) => `${lane.kind}:${prompt}.m${createHash('sha256').update(lane.cacheModelId ?? lane.modelId).digest('hex').slice(0, 16)}`;
const decision = () => ({ ...classifyItemTiers({ signals: {}, text: 'Bring apples to the picnic.' }),
  state: 'current' as const, metadataTier: 'private' as const, contentTier: 'private' as const,
  metadataPending: false, contentPending: false, decidedBy: 'sniffer' as const });

const lanes: SnifferLane[] = [lane,
  ...[QWEN35_2B, QWEN35_9B].map(spec => ({ ...BUILT_IN_SNIFFER_LANE, cacheModelId: weights(spec) })),
  { ...lane, profileId: 'local', profile: { provider: 'local-openai-compatible', trust: 'local', model: QWEN35_4B.modelId, snifferMode: 'full' } },
  { kind: 'venice', modelId: 'fixture', profileId: 'venice', profile: { provider: 'venice', trust: 'encrypted_cloud', model: 'fixture' } },
];
for (const [index, current] of lanes.entries()) test(`only built-in 4B identity changes and selects one-time re-judge: lane ${index}`, () => {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  const subject = identityOf('note');
  const previous = oldId(current);
  const id = snifferId(current, prompt);
  const key = { engineVersion: TIER_CLASSIFIER_VERSION, snifferId: id };
  const material = 'Bring apples to the picnic.';
  try {
    expect(id !== previous).toBe(index === 0);
    expect(snifferCacheModelId(current)).toBe((current.cacheModelId ?? current.modelId) + (index === 0 ? `:${SNIFFER_UNION_VERSION}` : ''));
    ledger.recordRoutedPlacement(subject, { ...decision(), reasons: [`content:sniffer:${previous}:ordinary:0.95`] },
      { copies: [{ corpusId: 'fixture', trustDomain: 'internal', layers: 'both' }], embedHold: false });
    ledger.markJudged(subject, { ...key, snifferId: previous });
    const page = ledger.rejudgeCandidatePage(key);
    expect(page.records.length).toBe(index === 0 ? 1 : 0);
    if (index === 0) expect(page.causes).toEqual(['judge_model']);
    // Stored Personal under the old key cannot clear a union-lane cache miss.
    store.putVerdict({ materialHash: snifferMaterialHash('content', material), modelId: current.cacheModelId ?? current.modelId,
      promptVersion: prompt, mapRevision: 'none' }, { tier: 'personal', category: 'ordinary', confidence: 0.95, failSafe: false });
    expect(new CachedTierSniffer(store, current).judge({ pass: 'content', material, flags: [], subject }).verdict)
      .toBe(index === 0 ? 'undecided' : 'decided');
    ledger.markRejudged(subject, key);
    expect(ledger.rejudgeCandidatePage(key).records).toHaveLength(0);
  } finally { store.close(); ledger.close(); }
});

test('upgrade re-judge uses lowest queue priority, leaves the item visible, settles once', async () => {
  const ledger = new TierLedger({ dbPath: ':memory:' });
  const legs = (['internal', 'secure_local'] as const).map(trustDomain => ({ trustDomain, corpusId: CORPORA[trustDomain],
    store: new LocalConnectorStore({ dbPath: ':memory:', corpusId: CORPORA[trustDomain], family: 'file', trustDomain, tierLedger: ledger }),
  }));
  const set = new TieredStoreSet({ setId: 'union-upgrade', ledger, legs });
  const fixture = { ledger, set };
  const store = new TierSnifferStore({ dbPath: ':memory:' });
  try {
    await fixture.set.sync(fixtureConnector(() => [{ id: 'note', name: 'Picnic notes', text: 'Bring apples to the picnic.' }]),
      { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const subject = identityOf('note');
    const settled = { ...decision(), reasons: [`content:sniffer:${oldId(lane)}:ordinary:0.95`] };
    fixture.ledger.recordRoutedPlacement(subject, settled, fixture.set.placementFor(settled));
    const sniffer = new CachedTierSniffer(store, lane);
    registerInstalledTierClassification({ forLedger: () => ({ sniffer }) });
    const first = rejudgeRoutedItems({ set: fixture.set, autoMoves: true });
    expect(first.report).toMatchObject({ seen: 1, asked: 1, causeJudgeModel: 1 });
    expect(store.listQuestions().length).toBeGreaterThan(0);
    expect(store.listQuestions().every(question => question.priority === HELD_UNTIL_JUDGED_PRIORITY)).toBe(true);
    expect(fixture.ledger.getCurrent(subject)).toMatchObject({ contentTier: 'private', state: 'current' });
    expect(rejudgeRoutedItems({ set: fixture.set, autoMoves: true }).report.seen).toBe(0);
    // The transport/union itself is exercised against a fake server in the parity suite.
    const report = await runSnifferPass({ targets: [{ ledger: fixture.ledger, sniffer: store,
      placementFor: next => fixture.set.placementFor(next) }], lane, model: { async complete() {
      return { modelId: 'built_in', text: JSON.stringify({ verdicts: [{ i: 1, tier: 'personal', category: 'ordinary', confidence: 0.95, ownRecord: false, privateKind: 'none' }] }) };
    } } });
    expect(report.resolvedPersonal).toBeGreaterThan(0);
    expect(store.counts().questions).toBe(0);
    expect(rejudgeRoutedItems({ set: fixture.set, autoMoves: true }).report.seen).toBe(0);
  } finally { registerInstalledTierClassification(undefined); store.close(); for (const leg of legs) leg.store.close(); ledger.close(); }
});
