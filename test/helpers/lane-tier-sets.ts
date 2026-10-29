// Every lane syncs through its tier set: each item is judged on its own and
// lands in the store its tier names (production has no single-store path).
// These build a lane's set over a test's store, with the stores the set opens
// on first need placed beside it.
//
// A test of a file lane's deletions, cursors, scope or receipts reads the
// lane's own store, so its set carries the owner's rule "everything in this
// source is Private": a real configuration, and the one way a whole source
// rests at one tier. Routing is tested on unpinned lanes (tier-p1c-lanes,
// tier-p1b-routing, and the per-tier cases beside these tests).

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type { LocalConnectorStore } from '../../src/workers/connector-store/index.ts';
import type { ConnectorStoreTierClassification } from '../../src/workers/connector-store/tier-placement.ts';
import { TIER_DOMAIN_ORDER, type TieredStoreSet } from '../../src/workers/connector-store/tiered-store-set.ts';
import { createDropboxTierLane } from '../../src/workers/dropbox-files/tier-set.ts';
import { createLocalFilesTierLane } from '../../src/workers/local-files/store.ts';
import { createReadwiseTierLane } from '../../src/workers/readwise/tier-set.ts';
import type { SourceEmbeddingProvider } from '../../src/workers/source-index/embeddings.ts';
import { createWhatsAppTierLane } from '../../src/workers/whatsapp/store-sync.ts';
import { createXBookmarksTierLane } from '../../src/workers/x-bookmarks/tier-set.ts';

type Env = Record<string, string | undefined>;

/** The owner's rule for a whole file source: every file is Private, by its path. */
const EVERYTHING_PRIVATE: ConnectorStoreTierClassification = {
  rules: [{ id: 'test.everything-private', match: { kind: 'pathPrefix', value: '/' }, tier: 'secure', strength: 'force' }],
};

/** One set per store, as a worker builds it once: a test that lands text later reaches the same set. */
const sets = new WeakMap<LocalConnectorStore, TieredStoreSet>();
function once(store: LocalConnectorStore, build: () => TieredStoreSet): TieredStoreSet {
  let set = sets.get(store);
  if (!set) { set = build(); sets.set(store, set); }
  return set;
}

/** A home of the store's own, so the stores a set opens later never meet another test's. */
function homeBeside(store: LocalConnectorStore): Env {
  if (!isAbsolute(store.dbPath)) return { HOME: mkdtempSync(join(tmpdir(), 'olympus-lane-tiers-')) };
  return { HOME: join(dirname(store.dbPath), `.tiers-${basename(store.dbPath)}`) };
}

export function dropboxTestTierSet(store: LocalConnectorStore, env: Env = homeBeside(store)): TieredStoreSet {
  return once(store, () => createDropboxTierLane({ secureStore: store, env, tierClassification: EVERYTHING_PRIVATE }).set);
}

export function localFilesTestTierSet(store: LocalConnectorStore, env: Env = homeBeside(store)): TieredStoreSet {
  return once(store, () => createLocalFilesTierLane({ secureStore: store, env, tierClassification: EVERYTHING_PRIVATE }).set);
}

/** A lane whose own store is its Personal store embeds there with the lane's identity, as a worker builds it. */
interface PersonalLaneOptions { embeddingProvider?: SourceEmbeddingProvider; env?: Env }

export function readwiseTestTierSet(store: LocalConnectorStore, options: PersonalLaneOptions = {}): TieredStoreSet {
  const { embeddingProvider, env = homeBeside(store) } = options;
  return once(store, () => createReadwiseTierLane({ store, env, ...(embeddingProvider ? { embeddingProvider } : {}) }).set);
}

export function xBookmarksTestTierSet(store: LocalConnectorStore, options: PersonalLaneOptions = {}): TieredStoreSet {
  const { embeddingProvider, env = homeBeside(store) } = options;
  return once(store, () => createXBookmarksTierLane({ store, env, ...(embeddingProvider ? { embeddingProvider } : {}) }).set);
}

export function whatsappTestTierSet(store: LocalConnectorStore, env: Env = homeBeside(store)): TieredStoreSet {
  return once(store, () => createWhatsAppTierLane({ store, env }).set);
}

/** Items the set's stores hold between them: what a lane stored, wherever each item's tier put it. */
export function itemsInSet(set: TieredStoreSet): number {
  return TIER_DOMAIN_ORDER.reduce((sum, domain) => sum + (set.store(domain)?.status().counts.items ?? 0), 0);
}
