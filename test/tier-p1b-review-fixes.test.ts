import type { Database } from 'bun:sqlite';
import { createTestClock, waitFor } from './helpers/test-clock.ts';
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
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { SecretLocationsIndex } from '../src/workers/classification/secret-locations.ts';
import { classifyItemTiers } from '../src/workers/classification/tier-classifier.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { LocalConnectorStore, TierLedgerUnavailableError } from '../src/workers/connector-store/index.ts';
import { moveTieredItem } from '../src/workers/connector-store/tier-move.ts';
import { tieredStoreSetLedgerPath } from '../src/workers/connector-store/tiered-store-set.ts';
import { STORE_UNCHANGED_REUSE_MS } from '../src/workers/source-index/status.ts';
import {
  storedSecretLocation,
  standaloneSecretParents,
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

  test('status reads reuse the hidden copies until the store or ledger changes', async () => {
    const dir = workspace();
    const tiered = await raised(dir);
    const store = tiered.stores.internal!;
    const ledger = tiered.ledger;
    // Hidden copies come from one walk, then only the identities that changed (#938).
    const real = ledger.corpusVisibilityPages.bind(ledger);
    let reads = 0;
    ledger.corpusVisibilityPages = ((corpusId: string, identities?: Parameters<typeof real>[1]) => {
      if (identities === undefined || identities.length > 0) reads += 1;
      return real(corpusId, identities);
    }) as typeof real;
    try {
      const statusReads = (): number => {
        const before = reads;
        expect(store.status().counts.chunks).toBe(0);
        return reads - before;
      };
      statusReads();
      // Same turn, nothing changed: the hidden copies are not read again.
      expect(statusReads()).toBe(0);
      // A ledger write in the same turn is seen at once.
      ledger.recordDecision(identityOf('unrelated'), ledger.getCurrent(identityOf('garden'))! as unknown as Parameters<typeof ledger.recordDecision>[1]);
      expect(statusReads()).toBeGreaterThan(0);
      // A later turn with nothing changed still reuses them.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(statusReads()).toBe(0);
      // A write that cannot change which rows are hidden reads nothing.
      store.advanceItemVersion({ ...identityOf('garden'), sourceVersion: 'v2' });
      expect(statusReads()).toBe(0);
      // A write to the store's rows is seen at once.
      (store as unknown as { db: Database }).db.query("UPDATE items SET tombstoned = 1 WHERE provider_item_id = 'garden'").run();
      expect(statusReads()).toBeGreaterThan(0);
    } finally {
      ledger.corpusVisibilityPages = real;
      tiered.close();
    }
  });

  // A store the read pool reads never walks the hidden copies inside the
  // status call: on the loop that walk was the gate's top statement (16 Nov).
  // The call serves the last count and a new one is read in turns, on the
  // read worker when the store changes or the safety recount is due.
  test('status recounts settled unreadable copies off-thread on change or at the safety bound', async () => {
    const dir = workspace();
    const tiered = await raised(dir);
    const store = tiered.stores.internal!;
    const ledger = tiered.ledger;
    let inCall = 0;
    let inTurns = 0;
    const identity = identityOf('garden');
    const maxAgeMs = 60_000;
    const clock = createTestClock(Date.now());
    const now = spyOn(Date, 'now').mockImplementation(clock.now);
    const real = ledger.corpusCopyIdentities.bind(ledger);
    ledger.corpusCopyIdentities = ((...args: Parameters<typeof real>) => { inCall += 1; return real(...args); }) as typeof real;
    const realSteps = ledger.corpusCopyIdentitiesSteps.bind(ledger);
    ledger.corpusCopyIdentitiesSteps = ((...args: Parameters<typeof realSteps>) => { inCall += 1; return realSteps(...args); }) as typeof realSteps;
    const realReads = ledger.corpusCopyIdentityReads.bind(ledger);
    ledger.corpusCopyIdentityReads = ((...args: Parameters<typeof realReads>) => { inTurns += 1; return realReads(...args); }) as typeof realReads;
    try {
      const statusThenTurns = async (): Promise<void> => {
        store.status(undefined, { countsMaxAgeMs: maxAgeMs });
        await waitFor(() => ((store as unknown as { settledUnreadableCountRefresh?: Set<string> }).settledUnreadableCountRefresh?.size ?? 0) === 0,
          { timeoutMs: 5_000, intervalMs: 5, description: 'the recount finished or was reused' });
      };
      for (const prepare of [false, true]) {
        const recount = async (expectedWalks: number): Promise<void> => {
          const turnsBefore = inTurns;
          if (prepare) await store.prepareStatusCounts();
          else await statusThenTurns();
          expect(inCall).toBe(0);
          expect(inTurns - turnsBefore).toBe(expectedWalks);
        };
        await recount(prepare ? 0 : 1);
        await clock.advance(maxAgeMs + 1);
        await recount(0);

        const writes = store.writeSequence();
        const visibility = store.visibilityMarker();
        ledger.setOverride(identity, prepare ? { kind: 'not_secret' } : { kind: 'tier', tier: 'secrets' });
        expect(store.visibilityMarker()).not.toBe(visibility);
        expect(store.writeSequence()).toBe(writes);
        await recount(1);

        const afterOverride = store.visibilityMarker();
        store.advanceItemVersion({ ...identity, sourceVersion: prepare ? 'v3' : 'v2' });
        expect(store.writeSequence()).not.toBe(writes);
        expect(store.visibilityMarker()).toBe(afterOverride);
        await recount(1);

        await clock.advance(STORE_UNCHANGED_REUSE_MS);
        await recount(1);
      }
    } finally {
      now.mockRestore();
      ledger.corpusCopyIdentities = real;
      ledger.corpusCopyIdentitiesSteps = realSteps;
      ledger.corpusCopyIdentityReads = realReads;
      tiered.close();
    }
  });

  test('an expired snapshot set is served at once and rebuilt in turns, never in the status call', async () => {
    const dir = workspace();
    const tiered = await raised(dir);
    const store = tiered.stores.internal!;
    const ledger = tiered.ledger;
    const clock = createTestClock(Date.now());
    const now = spyOn(Date, 'now').mockImplementation(clock.now);
    const here = spyOn(ledger, 'corpusVisibilityPages');
    const pooled = spyOn(ledger, 'corpusVisibilityFlaggedSteps');
    const reads = () => here.mock.calls.length + pooled.mock.calls.length;
    try {
      await store.prepareStatusCounts();
      ledger.recordDecision(identityOf('unrelated'), ledger.getCurrent(identityOf('garden'))! as unknown as Parameters<typeof ledger.recordDecision>[1]);
      const maxAgeMs = 5;
      await clock.advance(maxAgeMs);
      // Expired: the call itself reads nothing and answers from the older set.
      const before = reads();
      expect(store.status(undefined, { countsMaxAgeMs: maxAgeMs }).counts.chunks).toBe(0);
      expect(reads()).toBe(before);
      // The rebuild runs in later turns.
      const refresh = (store as unknown as { tierHiddenCountsRefresh?: Promise<void> }).tierHiddenCountsRefresh;
      expect(refresh).toBeDefined();
      await refresh;
      expect(reads()).toBeGreaterThan(before);
    } finally {
      here.mockRestore();
      pooled.mockRestore();
      now.mockRestore();
      tiered.close();
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

    expect(() => openLegStore(paths, 'internal', null)).toThrow(/privacy ledger.*missing/);
    const standalone = new LocalConnectorStore({ dbPath: paths.internal, corpusId: CORPORA.internal, family: 'file', trustDomain: 'internal', readOnly: true });
    try {
      expect(standalone.searchItems('compost', 5)).toEqual([]);
      expect(() => standalone.status()).toThrow(TierLedgerUnavailableError);
    } finally {
      standalone.close();
    }
    // A fresh ledger in its place is a different ledger: the set refuses.
    const replacement = new TierLedger({ dbPath: ledgerPath });
    try {
      expect(() => openLegStore(paths, 'internal', replacement)).toThrow(/privacy ledger.*missing/);
    } finally { replacement.close(); }
  });
});

describe('Secrets and moves', () => {
  test('a Secret found while a move is queued tombstones every copy, current and superseded', async () => {
    const dir = workspace();
    const tiered = fixture(dir);
    const specs: FixtureSpec[] = [{ id: 'garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden.' }];
    await tiered.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
    // A raise: queued, the Personal copy hidden but kept.
    specs[0] = { ...specs[0]!, version: 'v2', text: 'Garden notes. IBAN GB82WEST12345698765432.' };
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
    const secrets = new SecretLocationsIndex({ dbPath: `${workspace()}/locations.sqlite` });
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
    const parents = standaloneSecretParents();
    cleanups.push(parents.close);
    expect(secrets.search('aws key', { accountScope: 'work' }, parents).map((match) => match.title)).toEqual(['env.txt']);
    expect(secrets.search('aws key', { accountScope: 'personal' }, parents)).toEqual([]);
    const approved = { sourceScopeGeneration: 'g1', sourceScopeRevision: 'r1', sourceScopeFolderAnyKeys: ['folder-deploy'] };
    expect(secrets.search('aws', { filters: approved }, parents)).toHaveLength(1);
    expect(secrets.search('aws', { filters: { ...approved, sourceScopeRevision: 'r2' } }, parents)).toEqual([]);
    expect(secrets.search('aws', { filters: { ...approved, sourceScopeFolderAnyKeys: ['folder-other'] } }, parents)).toEqual([]);
    expect(secrets.search('aws', { filters: { locatorPathScopes: ['/Work'] } }, parents)).toHaveLength(1);
    expect(secrets.search('aws', { filters: { locatorPathExcludedScopes: ['/Work/Deploy'] } }, parents)).toEqual([]);
    expect(secrets.search('credential', { filters: { conversationId: 'chat-b' } }, parents)).toHaveLength(1);
    expect(secrets.search('credential', { filters: { conversationId: 'chat-a' } }, parents)).toEqual([]);
    // A filter the index holds no fact for excludes everything, fail closed.
    expect(secrets.search('aws', { filters: { senderId: 'someone' } }, parents)).toEqual([]);
    expect(secrets.search('aws', { filters: { authoredAfter: '2026-01-01' } }, parents)).toEqual([]);
  });

  test('a Private-metadata Secret is located by an opaque reference: no title, no locator, not findable by name', () => {
    const secrets = index();
    const parents = standaloneSecretParents();
    cleanups.push(parents.close);
    const [match] = secrets.search('credential', {}, parents);
    expect(match).toMatchObject({ source: 'chat', title: null, locator: null, findingKinds: ['credential_assignment'] });
    expect(match!.ref).toMatch(/^secret:[0-9a-f]{16}$/);
    expect(secrets.search('therapist', {}, parents)).toEqual([]);
    expect(storedSecretLocation(secrets, { provider: 'chat', accountScope: 'personal', providerConversationId: 'chat-b', providerItemId: '7' })?.title).toBeNull();
  });
});
