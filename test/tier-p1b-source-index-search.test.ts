// P1b source_index_search (design section 5): a search names one corpus and
// covers every tier of that source, judged by one ledger snapshot, with Secret
// locations beside the hits. `all_tiers: false` pins the one corpus.

import { afterEach, describe, expect, test } from 'bun:test';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import {
  CORPORA,
  FIXTURE_PLACEMENT,
  fixtureConnector,
  openTierFixture,
  tempDir,
  type FixtureSpec,
  type TierFixture,
} from './helpers/tier-fixtures.ts';

const FAKE_AWS_KEY = ['AKIA', 'LMNOPQRSTUVWXYZ2'].join('');
const SPECS: FixtureSpec[] = [
  { id: 'plan', name: 'orchard-plan.txt', text: 'Orchard pruning plan for the apple trees this winter.' },
  { id: 'invoice', name: 'orchard-invoice.txt', text: 'Orchard invoice total and IBAN GB82WEST12345698765432 for the transfer.' },
  { id: 'secret', name: 'orchard-deploy.env', text: `orchard deploy key ${FAKE_AWS_KEY}` },
];

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function workerFixture(): Promise<{ tiered: TierFixture; worker: ReturnType<typeof createEmailSourceWorker> }> {
  const { dir, cleanup } = tempDir();
  const tiered = openTierFixture(dir, { embed: false });
  cleanups.push(() => {
    tiered.close();
    cleanup();
  });
  await tiered.set.sync(fixtureConnector(() => SPECS), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  const corpusIds = new Set(Object.values(CORPORA));
  const worker = createEmailSourceWorker({
    connectorStores: tiered.set.openStores(),
    connectorStoreTierSiblings: (corpusId) => [...corpusIds].filter((sibling) => sibling !== corpusId),
    sourceIndexVisibilityGate: createTierVisibilityGate(() => [{ ledger: tiered.ledger, corpusIds }]),
    secretLocationSearch: (query, searched) => (
      searched.some((scope) => scope.corpusId === CORPORA.secure_local) ? tiered.secrets.search(query, {}) : []
    ),
  });
  return { tiered, worker };
}

async function search(worker: ReturnType<typeof createEmailSourceWorker>, body: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  }));
  const payload = await response.json() as Record<string, any>;
  expect({ status: response.status, payload }).toMatchObject({ status: 200 });
  return payload;
}

describe('P1b source_index_search', () => {
  test('a search of one corpus covers every tier of its source, with Secret locations beside', async () => {
    const { worker } = await workerFixture();
    const result = await search(worker, { corpus_id: CORPORA.internal, query: 'orchard' });
    const found = result.hits.map((hit: any) => [hit.sourceItem.providerItemId, hit.selected_item.corpus_id]);
    // The plan is Personal; the invoice's names are Personal and its body is
    // Private, so it is found in both tiers, once per layer.
    expect(found).toEqual(expect.arrayContaining([
      ['plan', CORPORA.internal],
      ['invoice', CORPORA.secure_local],
    ]));
    expect(result.audit.searched_corpora).toEqual([CORPORA.internal, CORPORA.secure_local]);
    // The policy describes the most private tier the search read.
    expect(result.policy).toMatchObject({ trust_domain: 'secure_local', local_only: true });
    expect(result.secret_locations).toEqual([{
      source: 'fixture',
      ref: expect.stringMatching(/^secret:[0-9a-f]{16}$/),
      locator: '/Files/orchard-deploy.env',
      title: 'orchard-deploy.env',
      finding_kinds: ['aws_access_key_id'],
    }]);
    expect(JSON.stringify(result)).not.toContain(FAKE_AWS_KEY);
  });

  test('all_tiers: false keeps the search on the named corpus', async () => {
    const { worker } = await workerFixture();
    const result = await search(worker, { corpus_id: CORPORA.internal, query: 'orchard', all_tiers: false });
    expect(result.hits.every((hit: any) => hit.selected_item.corpus_id === CORPORA.internal)).toBe(true);
    expect(result.audit.searched_corpora).toBeUndefined();
    expect(result.secret_locations).toBeUndefined();
    expect(result.policy).toMatchObject({ trust_domain: 'internal', local_only: false });
  });
});
