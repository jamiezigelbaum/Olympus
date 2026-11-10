// A Dropbox restored onto another computer is read under the folders the owner
// approves there (PR #1149 review): the sign-in mints a new scope generation
// even for the same account, so without a carry-over every restored item stayed
// hidden until a traversal listed it again. The carry-over never widens the
// folders: an item outside the approved ones stays hidden.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import type { RawItem, SourceConnector } from '../src/core/contracts.ts';
import { sourceAccountBindingsPath, updateSourceAccountBinding } from '../src/core/source-account-binding.ts';
import {
  approveFileSourceScope,
  connectedFileSourceAccountGeneration,
  readFileSourceScopeApproval,
  type FileSourceScopeApprovalSnapshot,
} from '../src/core/source-scope-approval.ts';
import { exportOlympusData, lifecycleHandleRegistryPath } from '../src/data-lifecycle.ts';
import { SecretLocationsIndex, secretLocationWithinScope } from '../src/workers/classification/secret-locations.ts';
import { secretLocationsPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { restoreOlympusData } from '../src/data-restore.ts';
import {
  LocalConnectorStore,
  createConnectorStoreCorpusAdapter,
  defineConnectorCorpus,
} from '../src/workers/connector-store/index.ts';
import { fileSourceScopeContentFilters, rebindRestoredFileScope } from '../src/workers/source-scope-runtime.ts';
import { lifecycleViews } from './helpers/lifecycle-view.ts';

const CORPUS = 'secure_local.dropbox.files';
const OLD_GENERATION = 'a'.repeat(64);
const OLD_REVISION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storeOf = (homeDir: string) => lifecycleViews().find((entry) => entry.sourceId === 'dropbox.files')!.connectorStorePaths!({ homeDir })[0]!;

function registry(providerAccountId: string) {
  return {
    version: 1 as const,
    handles: [{
      handle: 'dropbox.personal',
      provider: 'dropbox' as const,
      allowedCapabilities: ['dropbox.files.sync'],
      scopes: [],
      // Signed in on the new computer: a new connection time, so a new generation.
      connectedAt: '2026-11-10T10:00:00.000Z',
      accountRole: 'personal',
      providerAccountId,
    }],
  };
}

function file(id: string, path: string, text: string): RawItem {
  return {
    identity: {
      family: 'file', provider: 'dropbox', accountScope: 'personal', providerItemId: `id:${id}`,
      providerFileId: `id:${id}`, localItemId: `personal:id:${id}`, sourceVersion: 'rev-1',
    },
    mimeType: 'text/plain',
    content: { kind: 'text', text },
    metadata: Object.freeze({ name: path.split('/').pop()!, pathDisplay: path }),
    fetchedAt: '2026-11-01T10:00:00.000Z',
  };
}

const SECRETS = [['id:s1', '/work/keys.txt'], ['id:s2', '/home/keys.txt']] as const;

/** The Secrets whose location a read under `approval` may name. */
function visibleSecrets(index: SecretLocationsIndex, approval: FileSourceScopeApprovalSnapshot): string[] {
  const scope = fileSourceScopeContentFilters(approval);
  if (!scope.allowed) return [];
  return SECRETS
    .map(([id]) => index.get({ provider: 'dropbox', accountScope: 'personal', providerItemId: id })!)
    .filter((location) => secretLocationWithinScope(location, { accountScope: 'personal', ...(scope.filters ? { filters: scope.filters } : {}) }))
    .map((location) => location.locator ?? '')
    .sort();
}

const ITEMS = [file('1', '/work/plan.txt', 'quarterly plan'), file('2', '/home/notes.txt', 'quarterly notes')];

const connector: SourceConnector = {
  id: 'dropbox-restore-test', family: 'file', async authenticate() {},
  async *listItems() { yield { items: ITEMS, done: true }; },
  async fetchItem(localItemId) { return ITEMS.find((item) => item.identity.localItemId === localItemId)!; },
  classificationSignals() { return {}; },
};

/** Backs up a Dropbox store filled under the old computer's approval, and restores it under homeB. */
async function backUpAndRestore(dir: string, accountId: string): Promise<string> {
  const homeA = join(dir, 'a');
  const homeB = join(dir, 'b');
  const backup = join(dir, 'backup');
  const store = new LocalConnectorStore({ dbPath: storeOf(homeA), corpusId: CORPUS, family: 'file', trustDomain: 'secure_local' });
  const secrets = new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(storeOf(homeA)) });
  try {
    await store.syncFromConnector(connector, {
      fetchContent: true,
      sourceScopeObservation: () => ({ accountGeneration: OLD_GENERATION, scopeRevision: OLD_REVISION }),
    });
    // Two Secrets, kept only as where they are: one in each folder.
    for (const [id, locator] of SECRETS) {
      secrets.record({
        identity: { provider: 'dropbox', accountScope: 'personal', providerItemId: id },
        locator,
        scopeGeneration: OLD_GENERATION,
        scopeRevision: OLD_REVISION,
        findingKinds: ['api_key'],
      });
    }
  } finally {
    store.close();
    secrets.close();
  }
  updateSourceAccountBinding(sourceAccountBindingsPath(lifecycleHandleRegistryPath({ homeDir: homeA })), 'dropbox.files', () => ({
    provider_account_id: accountId,
    bound_at: '2026-11-01T10:00:00.000Z',
  }));
  exportOlympusData({ destination: backup, homeDir: homeA });
  restoreOlympusData({ input: backup, homeDir: homeB });
  return storeOf(homeB);
}

function approve(statePath: string, accountId: string, keys: string[]): FileSourceScopeApprovalSnapshot {
  const current = readFileSourceScopeApproval({ sourceId: 'dropbox.files', registry: registry(accountId), statePath });
  const approved = approveFileSourceScope({
    sourceId: 'dropbox.files',
    registry: registry(accountId),
    statePath,
    accountGeneration: connectedFileSourceAccountGeneration('dropbox.files', registry(accountId))!.generation,
    expectedRevision: current.revision,
    selections: keys.map((key) => ({ key, state: 'ingest' as const })),
    wholeAccount: false,
    explicitWholeAccountConfirmation: false,
  });
  expect(approved.status).toBe('approved');
  return approved;
}

/** The paths of the items a search reads under `approval`. */
async function visible(store: LocalConnectorStore, approval: FileSourceScopeApprovalSnapshot): Promise<string[]> {
  const scope = fileSourceScopeContentFilters(approval);
  if (!scope.allowed) return [];
  const response = await createConnectorStoreCorpusAdapter({
    store,
    accountScope: 'personal',
    ...(scope.filters ? { filters: scope.filters } : {}),
  })({
    query: 'quarterly', maxResults: 10,
    corpus: defineConnectorCorpus({ corpusId: CORPUS, family: 'file', trustDomain: 'secure_local' }),
    context: { allowedTrustDomains: ['secure_local'], allowedCorpusIds: [CORPUS] },
  });
  return response.hits.map((hit) => hit.provenance?.citation?.title ?? '').sort();
}

describe('restored folder scope', () => {
  test('the same account approving the same folders reads the restored items; a narrower set later keeps the rest hidden', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-restore-scope-'));
    try {
      const storePath = await backUpAndRestore(dir, 'account-1');
      const statePath = join(dir, 'scopes.json');
      const store = new LocalConnectorStore({ dbPath: storePath, corpusId: CORPUS, family: 'file', trustDomain: 'secure_local' });
      try {
        const same = approve(statePath, 'account-1', ['/work', '/home']);
        expect(same.accountGeneration).not.toBe(OLD_GENERATION);
        // Before the carry-over, the restored items carry the old computer's stamp.
        expect(await visible(store, same)).toEqual([]);
        expect(rebindRestoredFileScope({ approval: same, providerAccountId: 'account-1', sets: [{ stores: [store] }] })).toBe(2);
        expect(await visible(store, same)).toEqual(['notes.txt', 'plan.txt']);
        // Once only: the record is gone, and a second approval is like any re-approval.
        expect(rebindRestoredFileScope({ approval: same, providerAccountId: 'account-1', sets: [{ stores: [store] }] })).toBe(0);
        const narrower = approve(statePath, 'account-1', ['/work']);
        rebindRestoredFileScope({ approval: narrower, providerAccountId: 'account-1', sets: [{ stores: [store] }] });
        expect(await visible(store, narrower)).not.toContain('notes.txt');
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a narrower first approval carries over only what its folders hold', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-restore-scope-narrow-'));
    try {
      const storePath = await backUpAndRestore(dir, 'account-1');
      const store = new LocalConnectorStore({ dbPath: storePath, corpusId: CORPUS, family: 'file', trustDomain: 'secure_local' });
      try {
        const narrower = approve(join(dir, 'scopes.json'), 'account-1', ['/work']);
        rebindRestoredFileScope({ approval: narrower, providerAccountId: 'account-1', sets: [{ stores: [store] }] });
        expect(await visible(store, narrower)).toEqual(['plan.txt']);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the Secrets\' locations beside the store are carried over too, under the approved folders', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-restore-scope-secrets-'));
    try {
      const storePath = await backUpAndRestore(dir, 'account-1');
      const store = new LocalConnectorStore({ dbPath: storePath, corpusId: CORPUS, family: 'file', trustDomain: 'secure_local' });
      const secrets = new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(storePath) });
      try {
        const narrower = approve(join(dir, 'scopes.json'), 'account-1', ['/work']);
        expect(visibleSecrets(secrets, narrower)).toEqual([]);
        rebindRestoredFileScope({ approval: narrower, providerAccountId: 'account-1', sets: [{ stores: [store], secretLocations: secrets }] });
        expect(visibleSecrets(secrets, narrower)).toEqual(['/work/keys.txt']);
        // Another account's approval carries none over.
        const other = approve(join(dir, 'other.json'), 'account-2', ['/work', '/home']);
        expect(rebindRestoredFileScope({ approval: other, providerAccountId: 'account-2', sets: [{ stores: [store], secretLocations: secrets }] })).toBe(0);
      } finally {
        store.close();
        secrets.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('another account carries nothing over', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'olympus-restore-scope-other-'));
    try {
      const storePath = await backUpAndRestore(dir, 'account-1');
      const store = new LocalConnectorStore({ dbPath: storePath, corpusId: CORPUS, family: 'file', trustDomain: 'secure_local' });
      try {
        const other = approve(join(dir, 'scopes.json'), 'account-2', ['/work', '/home']);
        expect(rebindRestoredFileScope({ approval: other, providerAccountId: 'account-2', sets: [{ stores: [store] }] })).toBe(0);
        expect(await visible(store, other)).toEqual([]);
      } finally {
        store.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
