// P1b answers and status (design sections 2.3, 4.3, 5): every tier is
// searched through one visibility gate, Secret locations ride BESIDE the pack
// (never in it, so no model sees them), pending items become a counts-only
// coverage note, and status reports pending, superseded and moving counts
// with those chunks out of the parity denominator.

import { afterEach, describe, expect, test } from 'bun:test';
import { buildEvidencePackDetailed } from '../src/core/evidence-pack.ts';
import { buildSourceIndexCorpusRegistry } from '../src/core/source-index/corpus.ts';
import {
  createConnectorStoreContentProvider,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { releaseAnalystAnswer } from '../src/workers/source-index/analyst-answer.ts';
import { createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';
import {
  CORPORA,
  FIXTURE_PLACEMENT,
  fixtureConnector,
  identityOf,
  openTierFixture,
  tempDir,
  type FixtureSpec,
  type TierFixture,
} from './helpers/tier-fixtures.ts';

const FAKE_AWS_KEY = ['AKIA', 'QRSTUVWXYZ234567'].join('');
const SPECS: FixtureSpec[] = [
  { id: 'garden', name: 'orchard-plan.txt', text: 'Orchard pruning plan for the apple trees this winter.' },
  { id: 'biopsy', name: 'biopsy results.txt', text: 'Orchard clinic: the lab results confirm the diagnosis.' },
  { id: 'secret', name: 'orchard-deploy.env', text: `orchard deploy key ${FAKE_AWS_KEY} for the pipeline` },
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function fixture(): Promise<TierFixture> {
  const { dir, cleanup } = tempDir();
  const tiered = openTierFixture(dir);
  cleanups.push(() => {
    tiered.close();
    cleanup();
  });
  await tiered.set.sync(fixtureConnector(() => SPECS), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  return tiered;
}

function lanes(tiered: TierFixture) {
  const stores = tiered.set.openStores();
  return {
    registry: buildSourceIndexCorpusRegistry(stores.map((store) => defineConnectorCorpus({
      corpusId: store.corpusId,
      family: store.family,
      trustDomain: store.trustDomain,
    }))),
    adapters: Object.fromEntries(stores.map((store) => [store.corpusId, createConnectorStoreCorpusAdapter({ store })])),
    contentProviders: Object.fromEntries(stores.map((store) => [store.corpusId, createConnectorStoreContentProvider({ store })])),
    visibilityGate: createTierVisibilityGate(() => [{ ledger: tiered.ledger, corpusIds: new Set(Object.values(CORPORA)) }]),
    // As the runtime does: only when the source's Private corpus was searched.
    secretLocations: (query: string, searched: readonly string[]) => (
      searched.includes(CORPORA.secure_local) ? tiered.secrets.search(query, {}) : []
    ),
    classificationCoverage: (searched: readonly string[]) => searched.map((corpusId) => ({
      corpusId,
      pendingClassificationItems: tiered.ledger.corpusCopyCounts(corpusId).held,
    })),
  };
}

describe('P1b answers', () => {
  test('one query searches every tier; Secrets ride beside the pack by location only; pending is a coverage note', async () => {
    const tiered = await fixture();
    const detail = await buildEvidencePackDetailed({
      question: 'orchard',
      maxResults: 10,
      searchContext: { allowedTrustDomains: ['public_safe', 'internal', 'secure_local'] },
      ...lanes(tiered),
    });
    // Both tiers answered: the Personal plan and the (pending, Private) clinic note.
    expect(new Set(detail.candidateCorpusIds)).toEqual(new Set([CORPORA.internal, CORPORA.secure_local]));
    expect(detail.secretLocations).toEqual([expect.objectContaining({
      source: 'fixture',
      locator: '/Files/orchard-deploy.env',
      title: 'orchard-deploy.env',
      findingKinds: ['aws_access_key_id'],
    })]);
    expect(detail.classificationCoverage).toEqual([{ corpusId: CORPORA.secure_local, pendingClassificationItems: 1 }]);
    // Nothing of the Secret is in the pack the Analyst reads.
    const pack = JSON.stringify(detail.pack);
    expect(pack).not.toContain(FAKE_AWS_KEY);
    expect(pack).not.toContain('orchard-deploy');

    const internalCandidate = detail.pack.candidates[detail.candidateCorpusIds.indexOf(CORPORA.internal)]!;
    const released = releaseAnalystAnswer({
      detail,
      result: {
        answer: 'The orchard plan is to prune the apple trees this winter.',
        citations: [{ provenance: internalCandidate.provenance, claim: 'Orchard pruning plan for the apple trees this winter.' }],
        unanswered: [],
      },
      releaseSecureContent: true,
    });
    expect(released.answer).toContain('1 item(s) pending classification in secure_local.fixture.files were searched by keyword only.');
    expect(released.answer).toContain('1 Secret(s) matched by location only');
    expect(released.answer).not.toContain(FAKE_AWS_KEY);
  });

  test('a superseded copy is never searched or served, and the gate keeps one tier per item', async () => {
    const tiered = await fixture();
    await moveTieredItem({
      set: tiered.set,
      identity: identityOf('garden'),
      target: { metadataTier: 'secure', contentTier: 'secure' },
    });
    const detail = await buildEvidencePackDetailed({
      question: 'pruning',
      maxResults: 10,
      searchContext: { allowedTrustDomains: ['public_safe', 'internal', 'secure_local'] },
      ...lanes(tiered),
    });
    expect(detail.candidateCorpusIds).toEqual([CORPORA.secure_local]);
    expect(detail.pack.candidates[0]?.trustDomain).toBe('secure_local');
  });
});

describe('P1b status', () => {
  test('status publishes pending, superseded and moving counts and keeps them out of parity', async () => {
    const tiered = await fixture();
    // A raise: the Personal copy is superseded (kept, hidden).
    await moveTieredItem({
      set: tiered.set,
      identity: identityOf('garden'),
      target: { metadataTier: 'secure', contentTier: 'secure' },
    });
    const handler = createSourceIndexStatusHandler({
      corpusDefinitions: tiered.set.openStores().map((store) => defineConnectorCorpus({
        corpusId: store.corpusId,
        family: store.family,
        trustDomain: store.trustDomain,
      })),
      connectorStores: tiered.set.openStores(),
    });
    const status = await handler.status({});
    const byCorpus = new Map(status.corpora.map((corpus) => [corpus.corpus_id, corpus]));
    const internal = byCorpus.get(CORPORA.internal) as { counts: Record<string, number> };
    const secure = byCorpus.get(CORPORA.secure_local) as { counts: Record<string, number> };
    expect(internal.counts).toMatchObject({ chunks: 0, embedded_chunks: 0, tier_move_in_progress: 0 });
    expect(internal.counts['superseded_chunks']).toBeGreaterThan(0);
    expect(secure.counts['pending_classification_items']).toBe(1);
  });
});
