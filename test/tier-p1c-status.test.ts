// P1c: a per-tier store a tier set creates while the runtime is up is reported
// by status from that moment, with no restart (design
// per-item-four-tier-classification.md, section 3.2).

import { afterEach, describe, expect, test } from 'bun:test';
import { defineConnectorCorpus } from '../src/workers/connector-store/index.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { createSourceIndexStatusHandler } from '../src/workers/source-index/status.ts';
import {
  CORPORA,
  FIXTURE_PLACEMENT,
  fixtureConnector,
  openTierFixture,
  tempDir,
  type FixtureSpec,
} from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('P1c status', () => {
  test('a Public store created at runtime is reported by the same status handler, with no restart', async () => {
    const { dir, cleanup } = tempDir();
    const tiered = openTierFixture(dir);
    cleanups.push(() => {
      tiered.close();
      cleanup();
    });
    // The runtime's live store list: the tier set appends a store it opens.
    const connectorStores: LocalConnectorStore[] = tiered.set.openStores();
    const definitions = () => connectorStores.map((store) => defineConnectorCorpus({
      corpusId: store.corpusId,
      family: store.family,
      trustDomain: store.trustDomain,
    }));
    const handler = createSourceIndexStatusHandler({ corpusDefinitions: definitions, connectorStores });

    const before = await handler.status({});
    expect(before.corpora.map((corpus) => corpus.corpus_id)).not.toContain(CORPORA.public_safe);

    const specs: FixtureSpec[] = [
      { id: 'launch', name: 'launch-post.txt', text: 'Our launch post, already on the blog.', sharing: 'public_link' },
    ];
    await tiered.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const opened = tiered.stores.public_safe;
    expect(opened).toBeDefined();
    connectorStores.push(opened!);

    const after = await handler.status({});
    const publicStatus = after.corpora.find((corpus) => corpus.corpus_id === CORPORA.public_safe) as
      | { counts: Record<string, number> }
      | undefined;
    expect(publicStatus).toBeDefined();
    expect(publicStatus!.counts['indexed_items']).toBe(1);
  });
});
