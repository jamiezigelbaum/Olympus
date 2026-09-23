// Critical-review fixes for P1b (#78 at d371a174):
// D1 — the conversation is part of every tier identity: chat message ids
//      repeat across chats, and a collision must never route, hide or lose a
//      different message.
// D2 — Secret locations are scoped to what the caller could read, and a
//      Private-metadata item is located only by an opaque reference.
// Plus: a store a set routed into fails closed without that set's ledger,
// standalone and read-only handles honour it, Secrets outrank a move in
// flight, and copy lists have no ceiling.

import { existsSync, rmSync } from 'node:fs';
import { afterEach, describe, expect, test } from 'bun:test';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore, TierLedgerUnavailableError } from '../src/workers/connector-store/index.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import {
  ACCOUNT,
  CORPORA,
  FIXTURE_PLACEMENT,
  cloudProvider,
  fixtureConnector,
  fixtureLocalId,
  identityOf,
  localId,
  openLegStore,
  openTierFixture,
  snapshotStore,
  storePaths,
  tempDir,
  type FixtureSpec,
  type TierFixture,
} from './helpers/tier-fixtures.ts';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function workspace(): string {
  const { dir, cleanup } = tempDir('olympus-tier-p1b-review-');
  cleanups.push(cleanup);
  return dir;
}

function fixture(dir: string, options: { embed?: boolean; splitLayers?: boolean } = {}): TierFixture {
  const tiered = openTierFixture(dir, { embed: false, ...options });
  cleanups.unshift(() => tiered.close());
  return tiered;
}

/** Items a lane stored before P1b: plain store syncs with the lane's placement. */
async function populateLegacy(dir: string, specs: readonly FixtureSpec[]): Promise<void> {
  const paths = storePaths(dir);
  const internal = openLegStore(paths, 'internal');
  const secure = openLegStore(paths, 'secure_local');
  try {
    await internal.syncFromConnector(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    await secure.syncFromConnector(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  } finally {
    internal.close();
    secure.close();
  }
}

const CHAT_B_LEGACY: FixtureSpec = {
  id: '7',
  conversation: 'chat-b',
  name: 'chat-b message',
  text: 'Harbour ferry timetable for the chat B crew.',
};

describe('D1: the same message id in two chats is two items', () => {
  test('a routed chat-A message never routes an existing chat-B message into another tier', async () => {
    const dir = workspace();
    await populateLegacy(dir, [CHAT_B_LEGACY]);
    const tiered = fixture(dir);
    const chatA: FixtureSpec = {
      id: '7',
      conversation: 'chat-a',
      name: 'chat-a announcement',
      text: 'Our public harbour announcement, already on the blog.',
      sharing: 'public_link',
    };
    // Chat A's message first, then chat B's existing message is re-observed.
    await tiered.set.sync(fixtureConnector(() => [chatA, CHAT_B_LEGACY]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    await tiered.set.sync(fixtureConnector(() => [chatA, CHAT_B_LEGACY]), { fetchContent: true, placement: FIXTURE_PLACEMENT });

    expect(tiered.ledger.isRouted(identityOf('7', 'chat-a'))).toBe(true);
    expect(tiered.ledger.isRouted(identityOf('7', 'chat-b'))).toBe(false);
    expect(tiered.stores.public_safe!.hasItemRow(identityOf('7', 'chat-a'))).toBe(true);
    expect(tiered.stores.public_safe!.hasItemRow(identityOf('7', 'chat-b'))).toBe(false);
    // Chat B's message is visible exactly where it always was, and only there.
    const found = (store: LocalConnectorStore | undefined) => (store?.searchItems('ferry', 5) ?? [])
      .map((row) => row.sourceItem.providerConversationId);
    expect(found(tiered.stores.internal)).toEqual(['chat-b']);
    expect(found(tiered.stores.public_safe)).toEqual([]);
  });

  test('a routed chat-A message never hides an existing Private chat-B message', async () => {
    const dir = workspace();
    await populateLegacy(dir, [{ ...CHAT_B_LEGACY, legacyDomain: 'secure_local' }]);
    const tiered = fixture(dir);
    const chatA: FixtureSpec = { id: '7', conversation: 'chat-a', name: 'chat-a note', text: 'Garden rota for chat A.' };
    await tiered.set.sync(fixtureConnector(() => [chatA]), { fetchContent: true, placement: FIXTURE_PLACEMENT });

    expect(tiered.ledger.copies(identityOf('7', 'chat-a')).map((copy) => copy.corpusId)).toEqual([CORPORA.internal]);
    expect(tiered.stores.secure_local!.searchItems('ferry', 5).map((row) => row.sourceItem.localItemId))
      .toEqual([fixtureLocalId(CHAT_B_LEGACY)]);
    expect(tiered.stores.secure_local!.localContent(fixtureLocalId(CHAT_B_LEGACY))).toBeDefined();
  });

  test('across runs, a new chat-B message sharing a routed chat-A id is stored, not held or lost past the cursor', async () => {
    const dir = workspace();
    const tiered = fixture(dir, { splitLayers: false });
    const chatA: FixtureSpec = { id: '7', conversation: 'chat-a', name: 'chat-a note', text: 'Garden rota for chat A.' };
    const chatB: FixtureSpec = { id: '7', conversation: 'chat-b', name: 'chat-b note', text: 'Ferry timetable for chat B.', legacyDomain: 'secure_local' };
    await tiered.set.syncLegs([
      { trustDomain: 'internal', connector: fixtureConnector(() => [chatA], { id: 'lane_internal', cursor: 'i:1' }), sync: { fetchContent: true, placement: FIXTURE_PLACEMENT } },
    ]);
    await tiered.set.syncLegs([
      { trustDomain: 'secure_local', connector: fixtureConnector(() => [chatB], { id: 'lane_secure', cursor: 's:1' }), sync: { fetchContent: true, placement: FIXTURE_PLACEMENT } },
    ]);
    expect(tiered.ledger.isRouted(identityOf('7', 'chat-b'))).toBe(true);
    const stored = [tiered.stores.internal!, tiered.stores.secure_local!]
      .filter((store) => store.itemPresence(identityOf('7', 'chat-b')).active);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.searchItems('ferry', 5)).toHaveLength(1);
    expect(tiered.stores.secure_local!.lastCompletedSyncRun('lane_secure')?.cursor).toBe('s:1');
    // Chat A's routed copy is untouched.
    expect(tiered.ledger.copies(identityOf('7', 'chat-a')).map((copy) => [copy.corpusId, copy.state])).toEqual([[CORPORA.internal, 'current']]);
  });
});

describe('the set ledger governs every handle, and its loss fails closed', () => {
  const GARDEN: FixtureSpec = { id: 'garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden and the compost bins.' };

  async function raised(dir: string): Promise<TierFixture> {
    const tiered = fixture(dir);
    await tiered.set.sync(fixtureConnector(() => [GARDEN]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    await moveTieredItem({ set: tiered.set, identity: identityOf('garden'), target: { metadataTier: 'secure', contentTier: 'secure' } });
    return tiered;
  }

  test('standalone and read-only handles on a routed store still hide its superseded copy', async () => {
    const dir = workspace();
    await raised(dir);
    const paths = storePaths(dir);
    const standalone = openLegStore(paths, 'internal');
    const readOnly = new LocalConnectorStore({
      dbPath: paths.internal,
      corpusId: CORPORA.internal,
      family: 'file',
      trustDomain: 'internal',
      readOnly: true,
    });
    try {
      expect(standalone.searchItems('compost', 5)).toEqual([]);
      expect(readOnly.searchItems('compost', 5)).toEqual([]);
      expect(standalone.localContent(localId('garden'))).toBeUndefined();
      expect(standalone.status().counts.chunks).toBe(0);
      // An embedding pass from a standalone handle never embeds the hidden copy.
      expect((await standalone.embedChunks({ provider: cloudProvider() })).chunksSeen).toBe(0);
    } finally {
      standalone.close();
      readOnly.close();
    }
  });

  test('with the set ledger lost, a routed store refuses to sync and serves nothing', async () => {
    const dir = workspace();
    const first = await raised(dir);
    first.close();
    const paths = storePaths(dir);
    const ledgerPath = tieredStoreSetLedgerPath(paths.secure_local);
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${ledgerPath}${suffix}`, { force: true });
    expect(existsSync(ledgerPath)).toBe(false);

    const standalone = openLegStore(paths, 'internal', null);
    try {
      expect(standalone.searchItems('compost', 5)).toEqual([]);
      expect(() => standalone.status()).toThrow(TierLedgerUnavailableError);
    } finally {
      standalone.close();
    }
    // A fresh ledger in its place is a different ledger: the set refuses.
    const reopened = fixture(dir);
    await expect(reopened.set.sync(fixtureConnector(() => [GARDEN]), { fetchContent: true, placement: FIXTURE_PLACEMENT }))
      .rejects.toThrow(TierLedgerUnavailableError);
  });
});

describe('Secrets and moves', () => {
  test('a Secret found while a move is queued tombstones every copy, current and superseded', async () => {
    const dir = workspace();
    const tiered = fixture(dir);
    const specs: FixtureSpec[] = [{ id: 'garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden.' }];
    await tiered.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    // A raise: queued, the Personal copy hidden but kept.
    specs[0] = { ...specs[0]!, version: 'v2', text: 'Garden notes. IBAN GB82WEST12345698765432 for the seeds.' };
    await tiered.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(tiered.ledger.getCurrent(identityOf('garden'))?.state).toBe('moving');
    // Now a secret: the move is abandoned and every copy goes.
    specs[0] = { ...specs[0]!, version: 'v3', text: `Garden notes. key ${['AKIA', 'ZYXWVUTSRQPONMLK'].join('')}` };
    const run = await tiered.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    expect(run.routing.itemsSecrets).toBe(1);
    const internal = snapshotStore(tiered.paths.internal, [localId('garden')]);
    expect(internal.items).toEqual([expect.objectContaining({ tombstoned: 1 })]);
    expect(internal.chunks).toEqual([]);
    expect(tiered.ledger.copies(identityOf('garden'))).toEqual([]);
    expect(tiered.ledger.getCurrent(identityOf('garden'))).toMatchObject({ state: 'current', contentTier: 'secrets' });
    expect(tiered.secrets.get(identityOf('garden'))?.findingKinds).toEqual(['aws_access_key_id']);
  });

  test('copy lists have no ceiling', () => {
    const ledger = new TierLedger({ dbPath: ':memory:' });
    try {
      const decision = classifyItemTiers({ signals: { title: 'x' }, text: 'weekly notes' });
      for (let index = 0; index < 5_003; index += 1) {
        ledger.recordRoutedPlacement(
          { provider: 'fixture', accountScope: ACCOUNT, providerItemId: `item-${index}` },
          decision,
          { copies: [{ corpusId: CORPORA.secure_local, trustDomain: 'secure_local', layers: 'both' }], embedHold: true },
        );
      }
      expect(ledger.corpusCopyIdentities(CORPORA.secure_local, 'held')).toHaveLength(5_003);
    } finally {
      ledger.close();
    }
  });
});

describe('D2: Secret locations are scoped, and Private names are never released', () => {
  function index(): SecretLocationsIndex {
    const secrets = new SecretLocationsIndex({ dbPath: ':memory:' });
    cleanups.push(() => secrets.close());
    secrets.record({
      identity: { provider: 'files', accountScope: 'work', providerItemId: 'a' },
      locator: '/Work/Deploy/env.txt',
      title: 'env.txt',
      namesReleasable: true,
      folderKeys: ['folder-deploy'],
      scopeGeneration: 'g1',
      scopeRevision: 'r1',
      findingKinds: ['aws_access_key_id'],
    });
    secrets.record({
      identity: { provider: 'chat', accountScope: 'personal', providerConversationId: 'chat-b', providerItemId: '7' },
      title: 'therapist login notes',
      namesReleasable: false,
      locator: '/Therapy/login.txt',
      findingKinds: ['credential_assignment'],
    });
    return secrets;
  }

  test('account, approved folder and path scopes, and the conversation, confine a search', () => {
    const secrets = index();
    expect(secrets.search('aws key', { accountScope: 'work' }).map((match) => match.title)).toEqual(['env.txt']);
    expect(secrets.search('aws key', { accountScope: 'personal' })).toEqual([]);
    const approved = { sourceScopeGeneration: 'g1', sourceScopeRevision: 'r1', sourceScopeFolderAnyKeys: ['folder-deploy'] };
    expect(secrets.search('aws', { filters: approved })).toHaveLength(1);
    expect(secrets.search('aws', { filters: { ...approved, sourceScopeRevision: 'r2' } })).toEqual([]);
    expect(secrets.search('aws', { filters: { ...approved, sourceScopeFolderAnyKeys: ['folder-other'] } })).toEqual([]);
    expect(secrets.search('aws', { filters: { locatorPathScopes: ['/Work'] } })).toHaveLength(1);
    expect(secrets.search('aws', { filters: { locatorPathExcludedScopes: ['/Work/Deploy'] } })).toEqual([]);
    expect(secrets.search('credential', { filters: { conversationId: 'chat-b' } })).toHaveLength(1);
    expect(secrets.search('credential', { filters: { conversationId: 'chat-a' } })).toEqual([]);
    // A filter the index holds no fact for excludes everything, fail closed.
    expect(secrets.search('aws', { filters: { senderId: 'someone' } })).toEqual([]);
    expect(secrets.search('aws', { filters: { authoredAfter: '2026-01-01' } })).toEqual([]);
  });

  test('a Private-metadata Secret is located by an opaque reference: no title, no locator, not findable by name', () => {
    const secrets = index();
    const [match] = secrets.search('credential', {});
    expect(match).toMatchObject({ source: 'chat', title: null, locator: null, findingKinds: ['credential_assignment'] });
    expect(match!.ref).toMatch(/^secret:[0-9a-f]{16}$/);
    expect(secrets.search('therapist', {})).toEqual([]);
    expect(secrets.get({ provider: 'chat', accountScope: 'personal', providerConversationId: 'chat-b', providerItemId: '7' })?.title).toBeNull();
  });
});
