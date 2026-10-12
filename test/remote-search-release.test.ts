// The remote evidence search rereads every item's tier right before its
// result leaves (source-index/analyst-answer.ts searchReleasedEvidence
// releaseCheck): an item the owner moves to Private or Secrets while the
// search is reading it is withheld. Codex gpt-6-astra review of PR #300,
// 2026-10-12, reproduced exactly this with a paused content read.

import { afterEach, describe, expect, test } from 'bun:test';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import type { ReleaseCheck } from '../src/core/release-manifest.ts';
import { searchToolResult } from '../src/workers/chatgpt/response-builder.ts';
import { createConnectorStoreContentProvider, createConnectorStoreCorpusAdapter, defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createReleaseTierCheck, createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { searchReleasedEvidence } from '../src/workers/source-index/analyst-answer.ts';
import { CORPORA, FIXTURE_PLACEMENT, fixtureConnector, identityOf, openTierFixture, tempDir } from './helpers/tier-fixtures.ts';

const SENTENCE = 'The garden contains violet turnips.';
const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

async function gardenLane() {
  const { dir, cleanup } = tempDir();
  const fixture = openTierFixture(dir, { embed: false });
  cleanups.push(() => {
    fixture.close();
    cleanup();
  });
  await fixture.set.sync(fixtureConnector(() => [{ id: 'garden', name: 'garden-notes.txt', text: SENTENCE }]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  // Every content read waits here until the test lets it go.
  let pause: Promise<void> | undefined;
  let reading: (() => void) | undefined;
  const readStarted = new Promise<void>((resolve) => { reading = resolve; });
  const lanes = () => {
    const stores = fixture.set.openStores();
    return {
      registry: buildSourceIndexCorpusRegistry(stores.map((store) => defineConnectorCorpus({
        corpusId: store.corpusId, family: store.family, trustDomain: store.trustDomain,
      }))),
      adapters: Object.fromEntries(stores.map((store) => [store.corpusId, createConnectorStoreCorpusAdapter({ store })])),
      contentProviders: Object.fromEntries(stores.map((store) => {
        const provider = createConnectorStoreContentProvider({ store });
        return [store.corpusId, {
          ...provider,
          contentServable: provider.contentServable.bind(provider),
          async fetchLocalContent(request: Parameters<typeof provider.fetchLocalContent>[0]) {
            const block = await provider.fetchLocalContent(request);
            reading?.();
            if (pause) await pause;
            return block;
          },
        }];
      })),
      visibilityGate: createTierVisibilityGate(() => [{ ledger: fixture.ledger, corpusIds: new Set(stores.map((store) => store.corpusId)) }]),
    };
  };
  const releaseCheck = createReleaseTierCheck(() => [{ ledger: fixture.ledger, corpusIds: new Set(Object.values(CORPORA)) }], () => 'allow');
  const hold = () => {
    let release!: () => void;
    pause = new Promise<void>((resolve) => { release = resolve; });
    return release;
  };
  return { fixture, lanes, releaseCheck, hold, readStarted };
}

describe('remote search: tiers reread before release', () => {
  test('a Personal item is released when nothing changed', async () => {
    const lane = await gardenLane();
    const raw = await searchReleasedEvidence({ lanes: lane.lanes, question: 'violet turnips garden', releaseCheck: lane.releaseCheck });
    expect(JSON.stringify(searchToolResult(raw).content)).toContain(SENTENCE);
  });

  for (const target of [
    { name: 'Private', tiers: { metadataTier: 'private', contentTier: 'secure' } },
    { name: 'Secrets', tiers: { metadataTier: 'secrets', contentTier: 'secrets' } },
  ] as const) {
    test(`moved to ${target.name} while its content is being read: withheld`, async () => {
      const lane = await gardenLane();
      const release = lane.hold();
      const searching = searchReleasedEvidence({ lanes: lane.lanes, question: 'violet turnips garden', releaseCheck: lane.releaseCheck });
      await lane.readStarted;
      await moveTieredItem({ set: lane.fixture.set, identity: identityOf('garden'), target: target.tiers });
      release();
      const raw = await searching;
      const text = JSON.stringify(searchToolResult(raw));
      expect(text).not.toContain('violet turnips');
      expect(text).not.toContain('garden-notes');
      expect(raw.evidence).toEqual([]);
      expect(raw.withheld).toBeGreaterThanOrEqual(1);
    });
  }

  test('a tier check that cannot be read fails the whole search', async () => {
    const lane = await gardenLane();
    const broken: ReleaseCheck = {
      inputs: () => { throw new Error('ledger locked'); },
      secureDerivativeDefault: () => 'allow',
    };
    await expect(searchReleasedEvidence({ lanes: lane.lanes, question: 'violet turnips garden', releaseCheck: broken }))
      .rejects.toMatchObject({ code: 'source_index_policy_violation' });
  });

  test('an item whose tier cannot be proven is withheld', async () => {
    const lane = await gardenLane();
    const unknown: ReleaseCheck = {
      inputs: (inputs) => inputs.map(() => ({ tier: 'unknown', gone: false })),
      secureDerivativeDefault: () => 'allow',
    };
    const raw = await searchReleasedEvidence({ lanes: lane.lanes, question: 'violet turnips garden', releaseCheck: unknown });
    expect(raw.evidence).toEqual([]);
  });
});
