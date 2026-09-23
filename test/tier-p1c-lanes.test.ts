// P1c lanes on per-tier stores (design per-item-four-tier-classification.md,
// sections 2, 2.1 and 3.2): Dropbox (content that lands after listing),
// Readwise and X (a new item can be raised to Private or Secrets), WhatsApp
// (fails closed: Private unless an OWNER chat rule set the chat Personal).
// Existing items never move.

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { compactClassificationSignals, trustDomainPrior } from '../src/core/classification-signals.ts';
import { defaultDropboxIngestionPolicy, loadDropboxIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import type { SourceFamily } from '../src/core/source-index/types.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import type { OwnerTierRule } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { rehomeChatLaneOverrides } from '../src/workers/connector-store/tiered-store-set.ts';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  createDropboxProviderStoreSyncHandler,
  createDropboxTierLane,
  type DropboxMetadataClient,
  type DropboxMetadataPage,
} from '../src/workers/dropbox-files/index.ts';
import { createTieredStoreExtractionSink } from '../src/workers/file-extraction/tiered-store-sink.ts';
import { READWISE_STORE_PLACEMENT } from '../src/workers/readwise/connector.ts';
import {
  READWISE_SECURE_LIBRARY_CORPUS_ID,
  createReadwiseTierLane,
} from '../src/workers/readwise/tier-set.ts';
import { createWhatsAppTierLane, WHATSAPP_STORE_PLACEMENT } from '../src/workers/whatsapp/store-sync.ts';
import { X_BOOKMARKS_SECURE_CORPUS_ID, createXBookmarksTierLane } from '../src/workers/x-bookmarks/tier-set.ts';
import { cloudProvider, localProvider, snapshotStore } from './helpers/tier-fixtures.ts';

const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0).reverse()) close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-tier-p1c-lanes-'));
  roots.push(root);
  return root;
}

// Built at runtime: the repository refuses literal credential patterns.
const FAKE_AWS_KEY = ['AKIA', 'QRSTUVWXYZ765432'].join('');

interface Spec {
  id: string;
  title: string;
  text?: string;
  conversation?: string;
  sharing?: 'public_link';
}

/** A lane of any family: one page, text in the listing (Readwise, X, chats). */
function laneConnector(
  family: SourceFamily,
  provider: string,
  specs: () => readonly Spec[],
  signals: (spec: Spec) => ReturnType<SourceConnector['classificationSignals']> = (spec) => compactClassificationSignals({
    title: spec.title,
    ...(spec.sharing ? { sharing: spec.sharing } : {}),
  }),
): SourceConnector {
  const item = (spec: Spec): RawItem => ({
    identity: {
      family,
      provider,
      accountScope: 'personal',
      providerItemId: spec.id,
      localItemId: spec.conversation ? `personal:${spec.conversation}:${spec.id}` : `personal:${spec.id}`,
      ...(spec.conversation ? { providerConversationId: spec.conversation } : {}),
    },
    mimeType: 'text/plain',
    content: spec.text === undefined ? { kind: 'metadata_only' } : { kind: 'text', text: spec.text },
    metadata: { title: spec.title, name: spec.title },
    fetchedAt: '2026-09-23T00:00:00.000Z',
  });
  return {
    id: `${provider}_lane`,
    family,
    async authenticate() {},
    listItems(): AsyncIterable<SourceConnectorListPage> {
      const items = specs().map(item);
      return (async function* () {
        yield { items, done: true, nextCursor: 'cursor-1' };
      })();
    },
    async fetchItem(localItemId) {
      const spec = specs().find((candidate) => item(candidate).identity.localItemId === localItemId);
      if (!spec) throw new Error('unknown item');
      return item(spec);
    },
    classificationSignals(raw) {
      const spec = specs().find((candidate) => candidate.id === raw.identity.providerItemId
        && candidate.conversation === raw.identity.providerConversationId);
      return spec ? signals(spec) : {};
    },
  };
}

function ids(store: LocalConnectorStore | undefined, term: string): string[] {
  return (store?.searchItems(term, 20) ?? []).map((row) => row.sourceItem.providerItemId).sort();
}

describe('P1c Dropbox lane', () => {
  test('the policy names the lane by any of its corpora and no longer pins it to secure_local', () => {
    const policy = { ...defaultDropboxIngestionPolicy(), corpusId: 'internal.dropbox.files' };
    expect(loadDropboxIngestionPolicy({ inlinePolicy: policy }).corpusId).toBe('secure_local.dropbox.files');
    expect(() => loadDropboxIngestionPolicy({ inlinePolicy: { ...policy, corpusId: 'internal.drive.docs' } }))
      .toThrow(/must name the Dropbox lane/);
  });

  test('provider sync through the tier set: existing files stay put, a new file\'s names go Personal, its text lands by its own tier', async () => {
    const root = workspace();
    const env = {
      OLYMPUS_SOURCE_INDEX_DROPBOX_INTERNAL_CONNECTOR_STORE_DB_PATH: join(root, 'dropbox-internal.sqlite'),
      OLYMPUS_SOURCE_INDEX_DROPBOX_PUBLIC_CONNECTOR_STORE_DB_PATH: join(root, 'dropbox-public.sqlite'),
      OLYMPUS_SOURCE_INGESTION_EXCLUSIONS_PATH: join(root, 'no-exclusions.json'),
    };
    const entries: Array<{ tag: 'file'; id: string; name: string; pathDisplay: string; rev: string }> = [
      { tag: 'file', id: 'id:legacy', name: 'old-notes.pdf', pathDisplay: '/old-notes.pdf', rev: 'r1' },
    ];
    const metadataClient: DropboxMetadataClient = {
      supportsNativeRecursive: true,
      async listFolder(): Promise<DropboxMetadataPage> {
        return { entries: [...entries], cursor: 'cursor-1', hasMore: false };
      },
      async listFolderContinue(): Promise<DropboxMetadataPage> {
        return { entries: [...entries], cursor: 'cursor-2', hasMore: false };
      },
    };
    const broker = new StaticCredentialBroker([{
      handle: 'dropbox.personal',
      provider: 'dropbox',
      allowedCapabilities: ['dropbox.files.sync'],
      token: 'test-token',
      trustDomain: 'secure_local',
    }]);
    const securePath = join(root, 'dropbox-secure.sqlite');
    // Before per-item routing: the lane's one secure store.
    {
      const store = new LocalConnectorStore({ dbPath: securePath, corpusId: 'secure_local.dropbox.files', family: 'file', trustDomain: 'secure_local' });
      await createDropboxProviderStoreSyncHandler({ store, account: 'personal', broker, metadataClient })
        .pull({ approved_scope_key: 'dropbox.personal:/' });
      store.close();
    }
    const before = snapshotStore(securePath);

    const secure = new LocalConnectorStore({ dbPath: securePath, corpusId: 'secure_local.dropbox.files', family: 'file', trustDomain: 'secure_local' });
    closers.push(() => secure.close());
    const secrets = new SecretLocationsIndex({ dbPath: join(root, 'secrets.sqlite') });
    closers.push(() => secrets.close());
    const lane = createDropboxTierLane({ secureStore: secure, env, policy: defaultDropboxIngestionPolicy(), secretLocations: secrets });
    closers.push(() => {
      lane.internal.current()?.close();
      lane.public.current()?.close();
    });
    const sync = createDropboxProviderStoreSyncHandler({ store: secure, account: 'personal', broker, metadataClient, tierSet: lane.set });

    entries.push({ tag: 'file', id: 'id:integral', name: 'integral-theory-chapter.pdf', pathDisplay: '/Library/integral-theory-chapter.pdf', rev: 'r1' });
    entries.push({ tag: 'file', id: 'id:scan', name: 'scan-0413.pdf', pathDisplay: '/scan-0413.pdf', rev: 'r1' });
    const outcome = await sync.pull({ approved_scope_key: 'dropbox.personal:/' });
    expect(outcome.receipt.counts).toMatchObject({ tier_routed_items: 2, items_seen: 3 });
    // Resume point committed only after every tier store committed.
    expect(lane.set.committedCursor(sync.connectorIdForScope('dropbox.personal:/'))?.cursor).toBeTruthy();

    // The existing file: byte-identical, never routed.
    expect(snapshotStore(securePath, ['personal:id:legacy']).items)
      .toEqual(before.items.filter((row) => row['local_item_id'] === 'personal:id:legacy'));
    expect(lane.ledger.isRouted({ provider: 'dropbox', accountScope: 'personal', providerItemId: 'id:legacy' })).toBe(false);

    // New files: names in the Personal store only.
    const internal = lane.internal.current();
    expect(internal).toBeDefined();
    expect(ids(internal, 'integral')).toEqual(['id:integral']);
    expect(ids(secure, 'integral')).toEqual([]);
    expect(existsSync(env.OLYMPUS_SOURCE_INDEX_DROPBOX_PUBLIC_CONNECTOR_STORE_DB_PATH)).toBe(false);

    const sink = createTieredStoreExtractionSink({
      set: lane.set,
      syncConnectorId: 'extraction',
      ownerConnectorId: 'dropbox',
      ownershipKind: 'observed',
    });
    const land = (id: string, text: string) => sink.accept({
      ref: {
        corpusId: 'secure_local.dropbox.files',
        provider: 'dropbox',
        accountScope: 'personal',
        approvedScopeKey: 'dropbox.personal:/',
        providerItemId: id,
        localItemId: `personal:${id}`,
        sourceVersion: 'r1',
      },
      text,
      extractorKind: 'local_text',
      extractorVersion: 'test',
      fetchedAt: '2026-09-23T00:00:00.000Z',
    });
    expect((await land('id:integral', 'Integral theory maps quadrants, levels and lines of development.')).accepted).toBe(true);
    expect((await land('id:scan', 'The lab results confirm the diagnosis; the patient starts treatment.')).accepted).toBe(true);
    // Reference material is Personal: searchable (and cloud-embeddable) in the Personal store.
    expect(ids(internal, 'quadrants')).toEqual(['id:integral']);
    // Private content stays Private; its names stay Personal.
    expect(ids(internal, 'diagnosis')).toEqual([]);
    expect(ids(secure, 'diagnosis')).toEqual(['id:scan']);
    expect(ids(internal, 'scan')).toEqual(['id:scan']);

    // The next pass leaves every placement as it is.
    const again = await sync.pull({ approved_scope_key: 'dropbox.personal:/' });
    expect(again.receipt.counts.tier_moves_queued ?? 0).toBe(0);
    expect(ids(secure, 'diagnosis')).toEqual(['id:scan']);
    expect(ids(internal, 'quadrants')).toEqual(['id:integral']);
  });
});

describe('P1c Readwise and X lanes', () => {
  test('existing items stay byte-identical; a new item rests Personal at the lane tier, is raised to Private by its text, or is Secrets', async () => {
    const root = workspace();
    const env = { OLYMPUS_SOURCE_INDEX_READWISE_SECURE_CONNECTOR_STORE_DB_PATH: join(root, 'readwise-secure.sqlite') };
    const internalPath = join(root, 'readwise.sqlite');
    const legacy: Spec[] = [{ id: 'hl-old', title: 'Old highlight', text: 'A passage about attention and practice.' }];
    {
      const store = new LocalConnectorStore({ dbPath: internalPath, corpusId: 'internal.readwise.library', family: 'readwise', trustDomain: 'internal' });
      await store.syncFromConnector(laneConnector('readwise', 'readwise', () => legacy), { fetchContent: true, placement: READWISE_STORE_PLACEMENT });
      await store.embedChunks({ provider: cloudProvider() });
      store.close();
    }
    const before = snapshotStore(internalPath);
    expect(before.vectors.length).toBeGreaterThan(0);
    const invalidate = spyOn(
      LocalConnectorStore.prototype as unknown as { invalidateEmbeddingModelCurrency(modelId: string): void },
      'invalidateEmbeddingModelCurrency',
    );
    closers.push(() => invalidate.mockRestore());

    const store = new LocalConnectorStore({ dbPath: internalPath, corpusId: 'internal.readwise.library', family: 'readwise', trustDomain: 'internal' });
    closers.push(() => store.close());
    const cloud = cloudProvider();
    const local = localProvider();
    const secrets = new SecretLocationsIndex({ dbPath: join(root, 'secrets.sqlite') });
    closers.push(() => secrets.close());
    const lane = createReadwiseTierLane({ store, env, embeddingProvider: cloud, secureEmbeddingProvider: local, secretLocations: secrets });
    closers.push(() => lane.newStores.secure_local?.current()?.close());
    const specs: Spec[] = [
      ...legacy,
      { id: 'hl-book', title: 'Book highlight', text: 'Integral theory maps quadrants and levels.' },
      { id: 'hl-private', title: 'My note', text: 'The lab results confirm the diagnosis; the patient starts treatment.' },
      { id: 'hl-secret', title: 'Snippet', text: `deploy with key ${FAKE_AWS_KEY}` },
    ];
    await lane.set.sync(laneConnector('readwise', 'readwise', () => specs), { fetchContent: true, placement: READWISE_STORE_PLACEMENT });
    await lane.set.sync(laneConnector('readwise', 'readwise', () => specs), { fetchContent: true, placement: READWISE_STORE_PLACEMENT });

    expect(snapshotStore(internalPath, ['personal:hl-old'])).toEqual(before);
    expect(invalidate).not.toHaveBeenCalled();
    expect(cloud.inputs.some((input) => input.includes('attention and practice'))).toBe(false);

    // Personal: the lane's own store, at the lane's own tier.
    expect(snapshotStore(internalPath, ['personal:hl-book']).items).toEqual([
      expect.objectContaining({ trust_tier: 'S1', tombstoned: 0 }),
    ]);
    // Private: the new Private store, embedded only by the private identity.
    const secure = lane.newStores.secure_local!.current();
    expect(secure?.corpusId).toBe(READWISE_SECURE_LIBRARY_CORPUS_ID);
    expect(ids(secure, 'diagnosis')).toEqual(['hl-private']);
    expect(ids(store, 'diagnosis')).toEqual([]);
    expect(cloud.inputs.some((input) => input.includes('diagnosis'))).toBe(false);
    expect(local.inputs.some((input) => input.includes('diagnosis'))).toBe(true);
    // Secrets: nowhere; location only.
    expect(ids(store, 'deploy')).toEqual([]);
    expect(ids(secure, 'deploy')).toEqual([]);
    expect(secrets.search('Snippet', {}, { limit: 5 }).length).toBe(1);
  });

  test('X keeps its Private store beside the internal one, created on first need', () => {
    const root = workspace();
    const store = new LocalConnectorStore({ dbPath: join(root, 'x.sqlite'), corpusId: 'internal.x.bookmarks', family: 'x', trustDomain: 'internal' });
    closers.push(() => store.close());
    const lane = createXBookmarksTierLane({
      store,
      env: { OLYMPUS_SOURCE_INDEX_X_BOOKMARKS_SECURE_CONNECTOR_STORE_DB_PATH: join(root, 'x-secure.sqlite') },
    });
    closers.push(() => lane.ledger.close());
    expect(lane.newStores.secure_local?.corpusId).toBe(X_BOOKMARKS_SECURE_CORPUS_ID);
    expect(lane.newStores.public_safe).toBeUndefined();
    expect(existsSync(join(root, 'x-secure.sqlite'))).toBe(false);
    // The set ledger sits beside the (future) Private store, where the data
    // lifecycle finds it.
    expect(lane.ledger.dbPath).toBe(join(root, 'x-secure.tier-ledger.sqlite'));
  });
});

describe('P1c WhatsApp lane: fail closed', () => {
  const chatSignals = (spec: Spec) => compactClassificationSignals({
    prior: trustDomainPrior('secure_local', 'source_default'),
    title: spec.title,
    ...(spec.sharing ? { sharing: spec.sharing } : {}),
    folderKeys: spec.conversation ? [spec.conversation] : [],
  });

  function openLane(root: string, rules: readonly OwnerTierRule[] = []) {
    const store = new LocalConnectorStore({ dbPath: join(root, 'whatsapp.db'), corpusId: 'secure_local.whatsapp.messages', family: 'chat', trustDomain: 'secure_local' });
    closers.push(() => store.close());
    const lane = createWhatsAppTierLane({
      store,
      env: { OLYMPUS_SOURCE_INDEX_WHATSAPP_INTERNAL_CONNECTOR_STORE_DB_PATH: join(root, 'whatsapp-internal.db') },
      ...(rules.length > 0 ? { tierClassification: { rules } } : {}),
    });
    closers.push(() => lane.newStores.internal?.current()?.close());
    const sync = (specs: readonly Spec[]) => lane.set.sync(
      laneConnector('chat', 'whatsapp', () => specs, chatSignals),
      { fetchContent: true, placement: WHATSAPP_STORE_PLACEMENT, deferMetadataOnlyContent: true },
    );
    return { store, lane, sync, internal: () => lane.newStores.internal?.current() };
  }

  test('with no owner chat rule every new message stays Private, whatever its text or sharing says', async () => {
    const root = workspace();
    const { store, sync, internal } = openLane(root);
    await sync([
      { id: 'm1', conversation: 'chat-a', title: 'Garden club', text: 'See you at the allotment on Saturday.' },
      { id: 'm2', conversation: 'chat-a', title: 'Garden club', text: 'Photos are on the public page.', sharing: 'public_link' },
    ]);
    expect(internal()).toBeUndefined();
    expect(existsSync(join(root, 'whatsapp-internal.db'))).toBe(false);
    expect(ids(store, 'allotment')).toEqual(['m1']);
    expect(ids(store, 'photos')).toEqual(['m2']);
  });

  test('an owner chat rule setting a chat Personal lifts the floor for that chat only, and a message\'s own text still raises it', async () => {
    const root = workspace();
    const rules: OwnerTierRule[] = [{ id: 'garden-club', match: { kind: 'chat', value: 'chat-a' }, tier: 'private', strength: 'prior' }];
    const { store, sync, internal, lane } = openLane(root, rules);
    await sync([
      { id: 'm1', conversation: 'chat-a', title: 'Garden club', text: 'See you at the allotment on Saturday.' },
      { id: 'm2', conversation: 'chat-a', title: 'Garden club', text: 'The lab results confirm the diagnosis; treatment starts Monday.' },
      // The same message id in another chat: its own identity, its own tier.
      { id: 'm1', conversation: 'chat-b', title: 'Family', text: 'See you at the allotment on Sunday.' },
    ]);
    expect(ids(internal(), 'allotment')).toEqual(['m1']);
    expect((internal()?.searchItems('allotment', 5) ?? []).map((row) => row.sourceItem.providerConversationId)).toEqual(['chat-a']);
    expect(ids(internal(), 'diagnosis')).toEqual([]);
    expect(ids(store, 'diagnosis')).toEqual(['m2']);
    expect((store.searchItems('allotment', 5)).map((row) => row.sourceItem.providerConversationId)).toEqual(['chat-b']);
    expect(lane.ledger.getCurrent({ provider: 'whatsapp', accountScope: 'personal', providerItemId: 'm1', providerConversationId: 'chat-b' }))
      .toMatchObject({ metadataTier: 'secure' });
  });

  test('existing messages stay byte-identical and are never routed', async () => {
    const root = workspace();
    const legacy: Spec[] = [{ id: 'old', conversation: 'chat-a', title: 'Garden club', text: 'Old message about seedlings.' }];
    {
      const store = new LocalConnectorStore({ dbPath: join(root, 'whatsapp.db'), corpusId: 'secure_local.whatsapp.messages', family: 'chat', trustDomain: 'secure_local' });
      await store.syncFromConnector(laneConnector('chat', 'whatsapp', () => legacy, chatSignals), { fetchContent: true, placement: WHATSAPP_STORE_PLACEMENT });
      store.close();
    }
    const before = snapshotStore(join(root, 'whatsapp.db'));
    const rules: OwnerTierRule[] = [{ id: 'garden-club', match: { kind: 'chat', value: 'chat-a' }, tier: 'private', strength: 'prior' }];
    const { sync, lane, internal } = openLane(root, rules);
    await sync(legacy);
    expect(snapshotStore(join(root, 'whatsapp.db'))).toEqual(before);
    expect(lane.ledger.isRouted({ provider: 'whatsapp', accountScope: 'personal', providerItemId: 'old', providerConversationId: 'chat-a' })).toBe(false);
    expect(internal()).toBeUndefined();
  });

  test('pre-conversation overrides are re-homed when the chat is derivable and reported as orphaned otherwise', async () => {
    const root = workspace();
    const { store, sync, lane } = openLane(root);
    await sync([
      { id: 'solo', conversation: 'chat-a', title: 'Garden club', text: 'One chat only.' },
      { id: 'dup', conversation: 'chat-a', title: 'Garden club', text: 'First chat.' },
      { id: 'dup', conversation: 'chat-b', title: 'Family', text: 'Second chat.' },
    ]);
    const ledger: TierLedger = lane.ledger;
    ledger.setOverride({ provider: 'whatsapp', accountScope: 'personal', providerItemId: 'solo' }, { kind: 'tier', tier: 'private' });
    ledger.setOverride({ provider: 'whatsapp', accountScope: 'personal', providerItemId: 'dup' }, { kind: 'tier', tier: 'private' });
    expect(rehomeChatLaneOverrides(ledger, 'whatsapp', [store])).toEqual({ rehomed: 1, orphaned: 1 });
    expect(ledger.getOverride({ provider: 'whatsapp', accountScope: 'personal', providerItemId: 'solo', providerConversationId: 'chat-a' }))
      .toEqual({ kind: 'tier', tier: 'private' });
    expect(ledger.conversationlessOverrides('whatsapp')).toEqual([
      { provider: 'whatsapp', accountScope: 'personal', providerItemId: 'dup' },
    ]);
  });
});
