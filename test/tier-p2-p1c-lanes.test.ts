// P2 on the P1c lanes: the owner's tier rules file reaches WhatsApp (an
// explicit chat rule to Personal lifts the lane's Private floor for that chat
// only), and an edited sensitivity map or rules file takes effect at the next
// sync pass on every lane, with no restart.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector, SourceConnectorListPage } from '../src/core/contracts.ts';
import { compactClassificationSignals, trustDomainPrior } from '../src/core/classification-signals.ts';
import { defaultDropboxIngestionPolicy } from '../src/core/source-ingestion-policy.ts';
import { USER_FACING_TIER_MAPPING } from '../src/core/sensitivity-map.ts';
import {
  clearInstalledTierClassification,
  configureInstalledTierClassification,
} from '../src/workers/classification/installed-tier-classification.ts';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { StaticCredentialBroker } from '../src/workers/credential-broker/index.ts';
import {
  createDropboxProviderStoreSyncHandler,
  createDropboxTierLane,
  type DropboxMetadataClient,
  type DropboxMetadataPage,
} from '../src/workers/dropbox-files/index.ts';
import { createWhatsAppTierLane, WHATSAPP_STORE_PLACEMENT } from '../src/workers/whatsapp/store-sync.ts';

const roots: string[] = [];
const closers: Array<() => void> = [];
afterEach(() => {
  clearInstalledTierClassification();
  for (const close of closers.splice(0).reverse()) close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'olympus-tier-p2-p1c-'));
  roots.push(root);
  return root;
}

function ids(store: LocalConnectorStore | undefined, term: string): string[] {
  return (store?.searchItems(term, 20) ?? []).map((row) => row.sourceItem.providerItemId).sort();
}

function writeMap(path: string, keywords: string[]): void {
  writeFileSync(path, JSON.stringify({
    schemaVersion: 2,
    userFacingTiers: USER_FACING_TIER_MAPPING,
    categories: [{
      id: 'owner-private',
      label: 'owner private',
      targetTierName: 'secure',
      targetTrustTier: USER_FACING_TIER_MAPPING.secure.targetTrustTier,
      targetTrustDomain: USER_FACING_TIER_MAPPING.secure.targetTrustDomain,
      examples: ['example'],
      match: { keywords, senderPatterns: [], pathPatterns: [] },
    }],
  }));
}

describe('WhatsApp: owner chat rules from tier-rules.json', () => {
  interface ChatSpec { id: string; conversation: string; title: string; text: string }

  function chatConnector(specs: () => readonly ChatSpec[]): SourceConnector {
    const item = (spec: ChatSpec): RawItem => ({
      identity: {
        family: 'chat',
        provider: 'whatsapp',
        accountScope: 'personal',
        providerItemId: spec.id,
        localItemId: `personal:${spec.conversation}:${spec.id}`,
        providerConversationId: spec.conversation,
      },
      mimeType: 'text/plain',
      content: { kind: 'text', text: spec.text },
      metadata: { title: spec.title, name: spec.title },
      fetchedAt: '2026-09-23T00:00:00.000Z',
    });
    return {
      id: 'whatsapp_lane',
      family: 'chat',
      async authenticate() {},
      listItems(): AsyncIterable<SourceConnectorListPage> {
        const items = specs().map(item);
        return (async function* () { yield { items, done: true, nextCursor: 'cursor-1' }; })();
      },
      async fetchItem(localItemId) {
        const spec = specs().find((candidate) => item(candidate).identity.localItemId === localItemId);
        if (!spec) throw new Error('unknown item');
        return item(spec);
      },
      classificationSignals(raw) {
        const spec = specs().find((candidate) => candidate.id === raw.identity.providerItemId
          && candidate.conversation === raw.identity.providerConversationId);
        return spec
          ? compactClassificationSignals({ prior: trustDomainPrior('secure_local', 'source_default'), title: spec.title, folderKeys: [spec.conversation] })
          : {};
      },
    };
  }

  function openLane(root: string) {
    const store = new LocalConnectorStore({ dbPath: join(root, 'whatsapp.db'), corpusId: 'secure_local.whatsapp.messages', family: 'chat', trustDomain: 'secure_local' });
    closers.push(() => store.close());
    // No lane rules at all: the owner's rules come only from the installed file.
    const lane = createWhatsAppTierLane({
      store,
      env: { OLYMPUS_SOURCE_INDEX_WHATSAPP_INTERNAL_CONNECTOR_STORE_DB_PATH: join(root, 'whatsapp-internal.db') },
    });
    closers.push(() => lane.newStores.internal?.current()?.close());
    return {
      store,
      lane,
      sync: (specs: readonly ChatSpec[]) => lane.set.sync(chatConnector(() => specs), {
        fetchContent: true,
        placement: WHATSAPP_STORE_PLACEMENT,
        deferMetadataOnlyContent: true,
      }),
      internal: () => lane.newStores.internal?.current(),
    };
  }

  test('an explicit chat rule to Personal moves a new Personal message to internal; nothing else moves', async () => {
    const root = workspace();
    const rulesPath = join(root, 'tier-rules.json');
    writeFileSync(rulesPath, JSON.stringify({
      schemaVersion: 1,
      rules: [{ id: 'garden-club', match: { chat: 'chat-a' }, tier: 'private', strength: 'prior' }],
    }));
    configureInstalledTierClassification({ env: { OLYMPUS_TIER_RULES_PATH: rulesPath, OLYMPUS_SENSITIVITY_MAP_PATH: join(root, 'no-map.json') } });
    const { store, sync, internal } = openLane(root);
    await sync([
      { id: 'm1', conversation: 'chat-a', title: 'Garden club', text: 'See you at the allotment on Saturday.' },
      { id: 'm2', conversation: 'chat-a', title: 'Garden club', text: 'The lab results confirm the diagnosis; treatment starts Monday.' },
      { id: 'm3', conversation: 'chat-b', title: 'Family', text: 'See you at the allotment on Sunday.' },
    ]);
    expect(ids(internal(), 'allotment')).toEqual(['m1']);
    expect(ids(internal(), 'diagnosis')).toEqual([]);
    expect(ids(store, 'diagnosis')).toEqual(['m2']);
    expect(ids(store, 'allotment')).toEqual(['m3']);
  });

  test('with no rules file every new message stays Private', async () => {
    const root = workspace();
    configureInstalledTierClassification({ env: { OLYMPUS_TIER_RULES_PATH: join(root, 'none.json'), OLYMPUS_SENSITIVITY_MAP_PATH: join(root, 'no-map.json') } });
    const { store, sync, internal } = openLane(root);
    await sync([{ id: 'm1', conversation: 'chat-a', title: 'Garden club', text: 'See you at the allotment on Saturday.' }]);
    expect(internal()).toBeUndefined();
    expect(ids(store, 'allotment')).toEqual(['m1']);
  });
});

describe('an edited map applies at the next pass, without a restart', () => {
  test('Dropbox: a Private category added to the map keeps the next new file Private and queues the earlier one to move', async () => {
    const root = workspace();
    const mapPath = join(root, 'sensitivity-map.json');
    const env = {
      OLYMPUS_SOURCE_INDEX_DROPBOX_INTERNAL_CONNECTOR_STORE_DB_PATH: join(root, 'dropbox-internal.sqlite'),
      OLYMPUS_SOURCE_INDEX_DROPBOX_PUBLIC_CONNECTOR_STORE_DB_PATH: join(root, 'dropbox-public.sqlite'),
      OLYMPUS_SOURCE_INGESTION_EXCLUSIONS_PATH: join(root, 'no-exclusions.json'),
    };
    configureInstalledTierClassification({ env: { OLYMPUS_SENSITIVITY_MAP_PATH: mapPath, OLYMPUS_TIER_RULES_PATH: join(root, 'none.json') } });

    const entries: Array<{ tag: 'file'; id: string; name: string; pathDisplay: string; rev: string }> = [];
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
    const secure = new LocalConnectorStore({ dbPath: join(root, 'dropbox-secure.sqlite'), corpusId: 'secure_local.dropbox.files', family: 'file', trustDomain: 'secure_local' });
    closers.push(() => secure.close());
    const secrets = new SecretLocationsIndex({ dbPath: join(root, 'secrets.sqlite') });
    closers.push(() => secrets.close());
    const lane = createDropboxTierLane({ secureStore: secure, env, policy: defaultDropboxIngestionPolicy(), secretLocations: secrets });
    closers.push(() => {
      lane.internal.current()?.close();
      lane.public.current()?.close();
    });
    const sync = createDropboxProviderStoreSyncHandler({ store: secure, account: 'personal', broker, metadataClient, tierSet: lane.set });

    // Pass 1, no map: a new file's names are Personal.
    entries.push({ tag: 'file', id: 'id:first', name: 'zebracorn-plan.pdf', pathDisplay: '/zebracorn-plan.pdf', rev: 'r1' });
    await sync.pull({ approved_scope_key: 'dropbox.personal:/' });
    expect(ids(lane.internal.current(), 'zebracorn')).toEqual(['id:first']);

    // The owner adds a Private category. The same worker, the next pass:
    writeMap(mapPath, ['zebracorn']);
    entries.push({ tag: 'file', id: 'id:second', name: 'zebracorn-budget.pdf', pathDisplay: '/zebracorn-budget.pdf', rev: 'r1' });
    const second = await sync.pull({ approved_scope_key: 'dropbox.personal:/' });
    expect(ids(secure, 'budget')).toEqual(['id:second']);
    expect(ids(lane.internal.current(), 'budget')).toEqual([]);
    expect(lane.ledger.getCurrent({ provider: 'dropbox', accountScope: 'personal', providerItemId: 'id:second' })?.reasons)
      .toContain('metadata:sensitivity_map:owner-private');
    // The earlier file is re-judged too: raised, so queued to move (hidden first).
    expect(second.receipt.counts.tier_moves_queued).toBe(1);
    expect(lane.ledger.getCurrent({ provider: 'dropbox', accountScope: 'personal', providerItemId: 'id:first' }))
      .toMatchObject({ state: 'moving', targetMetadataTier: 'secure' });
  });
});
