// P2 on top of P1b: the sniffer settles routed items through the tiered store
// set's placement (a lowering verdict queues a move; nothing is rewritten in
// place), the ledger identity includes the conversation everywhere the
// sniffer and overrides touch it, and `olympus tier explain` shows overrides
// orphaned by the conversation-keyed identity.

import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { AnalystModel, AnalystModelRequest } from '../src/core/analyst.ts';
import { tierSetPlannerForLedger } from '../src/workers/classification/installed-tier-classification-registry.ts';
import {
  clearInstalledTierClassification,
  configureInstalledTierClassification,
} from '../src/workers/classification/installed-tier-classification.ts';
import { CachedTierSniffer } from '../src/workers/classification/sniffer.ts';
import type { SnifferLane } from '../src/workers/classification/sniffer-lane.ts';
import { runSnifferPass } from '../src/workers/classification/sniffer-resolver.ts';
import { TierSnifferStore } from '../src/workers/classification/sniffer-store.ts';
import { runTierCommand } from '../src/workers/classification/tier-cli.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import {
  CORPORA,
  FIXTURE_PLACEMENT,
  fixtureConnector,
  identityOf,
  openTierFixture,
  tempDir,
  type FixtureSpec,
} from './helpers/tier-fixtures.ts';

const LANE: SnifferLane = {
  kind: 'local',
  modelId: 'fixture-local-sniffer',
  profileId: 'local-sniffer',
  profile: { provider: 'local-openai-compatible', trust: 'local', baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture-local-sniffer' },
};

function model(answer: (material: string) => { tier: string; category: string; confidence: number }): AnalystModel & { requests: AnalystModelRequest[] } {
  const requests: AnalystModelRequest[] = [];
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const items = request.prompt.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as { i: number; names?: string; excerpt?: string });
      return {
        text: JSON.stringify({ verdicts: items.map((item) => ({ i: item.i, ...answer(item.names ?? item.excerpt ?? '') })) }),
        modelId: LANE.modelId,
      };
    },
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  clearInstalledTierClassification();
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('the sniffer settles routed items through the tiered store set', () => {
  test('a Personal verdict on a pending routed item queues a move; a Private one releases the embedding hold', async () => {
    const workspace = tempDir('olympus-tier-p2-set-');
    cleanups.push(workspace.cleanup);
    const env = { OLYMPUS_TIER_RULES_PATH: join(workspace.dir, 'none.json'), OLYMPUS_SENSITIVITY_MAP_PATH: join(workspace.dir, 'none-map.json') };
    const installed = configureInstalledTierClassification({ env, lane: { kind: LANE.kind, modelId: LANE.modelId } });
    const fixture = openTierFixture(workspace.dir, { embed: false });
    cleanups.push(() => fixture.close());
    const specs: FixtureSpec[] = [
      { id: 'mortgage-letter', name: 'mortgage letter', text: 'Lunch with the neighbours on Friday.' },
      { id: 'therapy-notes', name: 'therapy notes', text: 'Notes from the Tuesday meeting.' },
    ];
    await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const copies = (id: string) => fixture.ledger.copies(identityOf(id)).map((copy) => [copy.corpusId, copy.layers, copy.state, copy.embedHold]);
    expect(copies('mortgage-letter')).toEqual([[CORPORA.secure_local, 'both', 'current', true]]);
    expect(fixture.ledger.getCurrent(identityOf('mortgage-letter'))?.state).toBe('pending');

    const sniffer = installed.snifferStoreForLedger(fixture.ledger.dbPath);
    expect(sniffer.counts().questions).toBeGreaterThanOrEqual(2);
    const planner = tierSetPlannerForLedger(fixture.ledger.dbPath);
    expect(planner).toBeDefined();
    const answers = model((material) => /therapy/i.test(material)
      ? { tier: 'private', category: 'therapy', confidence: 0.95 }
      : { tier: 'personal', category: 'ordinary', confidence: 0.96 });
    const report = await runSnifferPass({ targets: [{ ledger: fixture.ledger, sniffer, placementFor: planner! }], lane: LANE, model: answers });
    expect(report.movesQueued).toBe(1);

    // Lowered: queued as a move to the Personal store; the secure copy stays
    // current until the move primitive runs. Nothing was rewritten in place.
    const lowered = fixture.ledger.getCurrent(identityOf('mortgage-letter'))!;
    expect(lowered).toMatchObject({ state: 'moving', targetContentTier: 'private' });
    expect(copies('mortgage-letter')).toEqual([[CORPORA.secure_local, 'both', 'current', true]]);

    // Stays Private: same store, decided, the embedding hold released.
    expect(fixture.ledger.getCurrent(identityOf('therapy-notes'))).toMatchObject({ state: 'current', contentTier: 'secure' });
    expect(copies('therapy-notes')).toEqual([[CORPORA.secure_local, 'both', 'current', false]]);
  });

  test('without the set planner a routed item stays pending and its question is kept', async () => {
    const workspace = tempDir('olympus-tier-p2-set-');
    cleanups.push(workspace.cleanup);
    const env = { OLYMPUS_TIER_RULES_PATH: join(workspace.dir, 'none.json'), OLYMPUS_SENSITIVITY_MAP_PATH: join(workspace.dir, 'none-map.json') };
    const installed = configureInstalledTierClassification({ env, lane: { kind: LANE.kind, modelId: LANE.modelId } });
    const fixture = openTierFixture(workspace.dir, { embed: false });
    cleanups.push(() => fixture.close());
    await fixture.set.sync(fixtureConnector(() => [{ id: 'bank-note', name: 'bank note', text: 'Garden plans.' }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const sniffer = installed.snifferStoreForLedger(fixture.ledger.dbPath);
    const before = sniffer.counts().questions;
    const report = await runSnifferPass({
      targets: [{ ledger: fixture.ledger, sniffer }],
      lane: LANE,
      model: model(() => ({ tier: 'personal', category: 'ordinary', confidence: 0.99 })),
    });
    expect(report.awaitingPlacement).toBeGreaterThanOrEqual(1);
    expect(fixture.ledger.getCurrent(identityOf('bank-note'))?.state).toBe('pending');
    expect(sniffer.counts().questions).toBe(before);
  });
});

describe('conversation-aware identity', () => {
  test('the same message id in two conversations is two questions and two decisions', async () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    const store = new TierSnifferStore({ dbPath: ':memory:' });
    cleanups.push(() => { store.close(); ledger.close(); });
    const sniffer = new CachedTierSniffer(store, LANE);
    const inConversation = (conversation: string, title: string) => {
      const subject = { provider: 'fixture', accountScope: 'personal', providerItemId: 'm1', providerConversationId: conversation };
      ledger.recordDecision(subject, classifyItemTiers({ signals: { title }, subject }, { sniffer }));
      return subject;
    };
    const family = inConversation('chat:family', 'therapy');
    const work = inConversation('chat:work', 'bank');
    expect(store.counts().questions).toBe(2);
    await runSnifferPass({
      targets: [{ ledger, sniffer: store }],
      lane: LANE,
      model: model((material) => /therapy/.test(material)
        ? { tier: 'private', category: 'therapy', confidence: 0.95 }
        : { tier: 'personal', category: 'ordinary', confidence: 0.95 }),
    });
    expect(ledger.getCurrent(family)?.metadataTier).toBe('secure');
    expect(ledger.getCurrent(work)?.metadataTier).toBe('private');
    expect(ledger.getCurrent({ provider: 'fixture', accountScope: 'personal', providerItemId: 'm1' })).toBeUndefined();
  });

  test('tier set keys the override with the conversation; explain shows a pre-conversation override as orphaned', async () => {
    const workspace = tempDir('olympus-tier-p2-conv-');
    cleanups.push(workspace.cleanup);
    const dbPath = join(workspace.dir, 'chat-store.sqlite');
    const store = new LocalConnectorStore({ dbPath, corpusId: 'secure_local.fixture.chat', family: 'file', trustDomain: 'secure_local' });
    cleanups.push(() => store.close());
    const specs: FixtureSpec[] = [{ id: 'm7', name: 'hello', text: 'See you at noon.', conversation: 'chat:family', legacyDomain: 'secure_local' }];
    await store.syncFromConnector(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const ledger = store.tierLedger()!;
    const withConversation = identityOf('m7', 'chat:family');
    expect(ledger.getCurrent(withConversation)).toBeDefined();
    // An override written under the conversation-less identity (schema 1).
    ledger.setOverride({ provider: 'fixture', accountScope: 'personal', providerItemId: 'm7' }, { kind: 'tier', tier: 'public' });

    const explained = await runTierCommand(['explain', 'm7'], { storePaths: [dbPath] });
    expect(explained).toMatchObject({
      item: { providerItemId: 'm7' },
      stores: [{ recorded: true, override: null, orphanedOverride: 'Public' }],
    });

    await runTierCommand(['set', 'm7', 'private'], { storePaths: [dbPath] });
    expect(ledger.getOverride(withConversation)).toEqual({ kind: 'tier', tier: 'secure' });
    expect(ledger.getCurrent(withConversation)).toMatchObject({ contentTier: 'secure', decidedBy: 'override' });
  });
});
