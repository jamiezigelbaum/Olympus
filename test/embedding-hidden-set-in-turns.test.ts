// The embedding pass over a tiered store builds its hidden-copy set in turns
// and rechecks each batch's items against the ledger right before dispatch,
// for every embedder (Sparta, 2026-11-04: the pass's own synchronous rebuild
// was most of each sampled freeze). A copy hidden while an earlier batch is
// out is still never sent. The child sweep pages parents without sorting
// every remaining child on each page.

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { VISIBILITY_CHANGE_RETRIES, VisibilityChangedError, type VisibilityRead } from '../src/workers/connector-store/child-visibility.ts';
import type { SourceEmbeddingInput } from '../src/workers/source-index/embeddings.ts';
import {
  CORPORA,
  FIXTURE_PLACEMENT,
  fixtureConnector,
  identityOf,
  openTierFixture,
  RecordingProvider,
  tempDir,
  type FixtureSpec,
} from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

class HookedProvider extends RecordingProvider {
  calls = 0;
  constructor(private readonly onCall: (call: number) => Promise<void>, backend: 'cloud' | 'local' = 'cloud') {
    super(backend === 'cloud' ? 'google-gemini' : 'openai-compatible', backend === 'cloud' ? 'gemini-embedding-2' : 'secure-local-qwen3-embed', backend);
  }

  override async embed(inputs: SourceEmbeddingInput[]): Promise<number[][]> {
    this.calls += 1;
    await this.onCall(this.calls);
    return super.embed(inputs);
  }
}

describe('embedding pass over a tiered store', () => {
  test('a copy hidden while an earlier batch is out is not sent in a later batch', async () => {
    const { dir, cleanup } = tempDir();
    const fixture = openTierFixture(dir, { embed: false });
    cleanups.push(() => {
      fixture.close();
      cleanup();
    });
    // 33 items: the store embeds in batches of 32, so the last is in the second.
    const specs: FixtureSpec[] = Array.from({ length: 33 }, (_, index) => ({
      id: `row-${String(index + 1).padStart(2, '0')}`,
      name: `row-${index + 1}.txt`,
      text: index === 32 ? 'lilac row that moves to another tier' : `meadow row number ${index + 1}`,
    }));
    await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const internal = fixture.stores.internal!;
    const provider = new HookedProvider(async (call) => {
      if (call !== 1) return;
      // Moved to Public during the first provider call: the Personal copy is
      // superseded, so it must not be embedded here any more.
      const moved = await moveTieredItem({
        set: fixture.set,
        identity: identityOf('row-33'),
        target: { metadataTier: 'public', contentTier: 'public' },
        vectorIdentities: { public_safe: fixture.cloud },
        embeddingLedger: { path: join(dir, 'embedding-ledger.jsonl'), approvedBy: 'system-automatic' },
      });
      expect(moved.supersededCorpora).toEqual([CORPORA.internal]);
    });
    const summary = await internal.embedChunks({ provider });
    expect(provider.calls).toBe(1);
    expect(provider.inputs.join('\n')).not.toContain('lilac');
    expect(summary.chunksEmbedded).toBe(32);
    expect(summary.chunksSeen).toBe(summary.chunksEmbedded + summary.chunksSkipped);
  });

  test('an embedder approved for Private content gets the same recheck', async () => {
    const { dir, cleanup } = tempDir();
    const fixture = openTierFixture(dir, { embed: false });
    cleanups.push(() => {
      fixture.close();
      cleanup();
    });
    const specs: FixtureSpec[] = Array.from({ length: 33 }, (_, index) => ({
      id: `row-${String(index + 1).padStart(2, '0')}`,
      name: `row-${index + 1}.txt`,
      text: index === 32 ? 'lilac row that moves to another tier' : `meadow row number ${index + 1}`,
    }));
    await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const internal = fixture.stores.internal!;
    const provider = new HookedProvider(async (call) => {
      if (call !== 1) return;
      const moved = await moveTieredItem({
        set: fixture.set,
        identity: identityOf('row-33'),
        target: { metadataTier: 'public', contentTier: 'public' },
        vectorIdentities: { public_safe: fixture.cloud },
        embeddingLedger: { path: join(dir, 'embedding-ledger.jsonl'), approvedBy: 'system-automatic' },
      });
      expect(moved.supersededCorpora).toEqual([CORPORA.internal]);
    }, 'local');
    const summary = await internal.embedChunks({ provider });
    expect(provider.calls).toBe(1);
    expect(provider.inputs.join('\n')).not.toContain('lilac');
    expect(summary.chunksEmbedded).toBe(32);
  });

  test('the sweep finds the items still owed vectors, leaving out hidden copies', async () => {
    const { dir, cleanup } = tempDir();
    const fixture = openTierFixture(dir, { embed: false });
    cleanups.push(() => {
      fixture.close();
      cleanup();
    });
    const specs: FixtureSpec[] = [
      { id: 'garden', name: 'garden.txt', text: 'Weekly notes about the vegetable garden.' },
      { id: 'launch', name: 'launch.txt', text: 'Our launch post about the orchard.' },
    ];
    await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    await moveTieredItem({
      set: fixture.set,
      identity: identityOf('launch'),
      target: { metadataTier: 'public', contentTier: 'public' },
      vectorIdentities: { public_safe: fixture.cloud },
      embeddingLedger: { path: join(dir, 'embedding-ledger.jsonl'), approvedBy: 'system-automatic' },
    });
    const internal = fixture.stores.internal!;
    const sync = internal.missingEmbeddingItemIds(fixture.cloud, 10);
    const inTurns = await internal.missingEmbeddingItemIdsInTurns(fixture.cloud, 10);
    expect(inTurns).toEqual(sync);
    expect(inTurns).toEqual(['personal:garden']);
  });

  test('a store written during every pooled read still finishes its hidden-child set', async () => {
    // Sparta rc.13 (14 Nov 2026): on a store a live import writes all the
    // time, every pooled hidden-child read met a write and threw, so the
    // embedding pass failed and restarted the full build every few minutes.
    const { dir, cleanup } = tempDir();
    const fixture = openTierFixture(dir, { embed: false });
    cleanups.push(() => {
      fixture.close();
      cleanup();
    });
    const specs: FixtureSpec[] = [{ id: 'garden', name: 'garden.txt', text: 'Weekly notes about the vegetable garden.' }];
    await fixture.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    const internal = fixture.stores.internal!;
    let pooled = 0;
    let here = 0;
    (internal as unknown as { hiddenChildReadSteps: () => Generator<VisibilityRead, number[], unknown> }).hiddenChildReadSteps = function* () {
      yield {
        here: () => { here += 1; return undefined; },
        offThread: async () => { pooled += 1; throw new VisibilityChangedError(); },
      };
      return [];
    };
    expect(await internal.missingEmbeddingItemIdsInTurns(fixture.cloud, 10)).toEqual(['personal:garden']);
    expect(pooled).toBe(VISIBILITY_CHANGE_RETRIES);
    expect(here).toBe(1);
  });
});

describe('child sweep paging', () => {
  test('pages every parent once, in order, across tombstoned windows and several accounts', () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const dbPath = join(dir, 'children.sqlite');
    const store = new LocalConnectorStore({ dbPath, corpusId: 'internal.fixture.chats', family: 'chat', trustDomain: 'internal' });
    store.close();
    const db = new Database(dbPath);
    const insert = db.prepare(`
      INSERT INTO items (local_item_id, family, provider, account_scope, provider_item_id, source_version, mime_type,
        trust_tier, tombstoned, parent_local_item_id, fetched_at, indexed_at, sync_run_id)
      VALUES (?, 'chat', 'telegram', ?, ?, 'v1', 'image/jpeg', ?, ?, ?, '2026-11-04T00:00:00Z', '2026-11-04T00:00:00Z', 'fixture-run')
    `);
    const expected: string[] = [];
    try {
      db.run(`INSERT INTO sync_runs (sync_run_id, corpus_id, connector_id, status, started_at)
        VALUES ('fixture-run', 'internal.fixture.chats', 'telegram', 'completed', '2026-11-04T00:00:00Z')`);
      db.transaction(() => {
        for (let parent = 0; parent < 120; parent += 1) {
          const parentId = `p${String(parent).padStart(4, '0')}`;
          for (const account of ['a', 'b']) {
            // Parents 20-59 have only removed children: a whole window with no row.
            const removed = parent >= 20 && parent < 60;
            // Account b: one in three parents has a child kept as a Secret's location.
            if (account === 'b' && parent % 3 !== 0) continue;
            const secret = account === 'b' && removed;
            for (let child = 0; child < 2; child += 1) {
              const id = `${parentId}-${account}-${child}`;
              insert.run(`${account}:${id}`, account, id, secret ? 'S5' : 'S3', removed ? 1 : 0, parentId);
            }
            if (!removed || secret) expected.push(`${parentId}|telegram|${account}`);
          }
        }
      })();
    } catch (error) {
      db.close();
      throw error;
    }
    db.close();
    const reopened = new LocalConnectorStore({ dbPath, corpusId: 'internal.fixture.chats', family: 'chat', trustDomain: 'internal' });
    try {
      for (const limit of [1, 7, 20, 200]) {
        const seen: string[] = [];
        let after: ReturnType<LocalConnectorStore['activeChildParents']>[number] | undefined;
        for (;;) {
          const page = reopened.activeChildParents(after, limit);
          if (page.length === 0) break;
          // A page is full unless it is the last one.
          seen.push(...page.map((parent) => `${parent.parentLocalItemId}|${parent.provider}|${parent.accountScope}`));
          after = page[page.length - 1];
          if (page.length < limit) {
            expect(reopened.activeChildParents(after, limit)).toEqual([]);
            break;
          }
        }
        expect(seen).toEqual(expected);
      }
    } finally {
      reopened.close();
    }
  });
});
