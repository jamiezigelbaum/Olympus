// The boot migration over real tiered stores (docs/design/source-storage.md,
// "What must not break"): a source whose three tier stores, tier ledger and
// secret-locations index were written by the real tiered store set, with
// embeddings, is moved into its account folder, and then answers exactly as it
// did: the same hits, the same vectors, the same sync history, nothing
// re-embedded. The move only renames files: no store or ledger is written to,
// each store's binding row still names the ledger's old place, and each store
// finds its set's ledger by the ledger's id. A move that is put back, or
// finished after a crash, ends the same way. Expected results are the stores'
// own content read before the move, not what the migration reports.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { secretLocationsPathForStore, tierLedgerPathForStore, tierSnifferPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { accountStorePath, legacyAccountFiles, olympusDataRoot } from '../src/core/olympus-layout.ts';
import {
  __accountMigrationTestHooks,
  AccountMigrationKilled,
  MIGRATE_ACCOUNT_FOLDERS_ENV,
  migrateAccountFolders,
  type MigrationLook,
} from '../src/core/source-account-migration.ts';
import { updateSourceRegistry } from '../src/core/source-registry.ts';
import { __sourceStorageTestHooks } from '../src/core/source-storage.ts';
import type { SourceTrustDomain } from '../src/core/source-index/types.ts';
import {
  CORPORA,
  FIXTURE_PLACEMENT,
  fixtureConnector,
  localId,
  openLegStore,
  openTierFixture,
  snapshotStore,
  type FixtureSpec,
  type TierFixture,
} from './helpers/tier-fixtures.ts';

const FAKE_AWS_KEY = ['AKIA', 'LMNOPQRSTUVWXYZ2'].join('');
const SPECS: FixtureSpec[] = [
  { id: 'plan', name: 'orchard-plan.txt', text: 'Orchard pruning plan for the apple trees this winter.' },
  { id: 'invoice', name: 'orchard-invoice.txt', text: 'Orchard invoice total and IBAN GB82WEST12345698765432.' },
  { id: 'secret', name: 'orchard-deploy.env', text: `orchard deploy key ${FAKE_AWS_KEY}` },
  { id: 'launch', name: 'orchard-launch.txt', text: 'Our orchard launch post, already on the blog.', sharing: 'public_link' },
  { id: 'lab', name: 'orchard-lab.txt', text: 'Orchard lab panel notes kept in the private store.', legacyDomain: 'secure_local' },
];
const DOMAINS = ['public_safe', 'internal', 'secure_local'] as const satisfies readonly SourceTrustDomain[];
type Tier = (typeof DOMAINS)[number];

type Env = Record<string, string>;

const cleanups: Array<() => void> = [];
afterEach(() => {
  __accountMigrationTestHooks.reset();
  __sourceStorageTestHooks.disableAdoption();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function home(): { env: Env; root: string } {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-account-migration-tiers-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const base = join(dir, 'home');
  const env: Env = {
    HOME: base,
    XDG_DATA_HOME: join(base, '.local', 'share'),
    XDG_STATE_HOME: join(base, '.local', 'state'),
    PATH: process.env.PATH ?? '',
    [MIGRATE_ACCOUNT_FOLDERS_ENV]: '1',
  };
  return { env, root: olympusDataRoot(env) };
}

const legacyPaths = (env: Env): Record<Tier, string> => {
  const files = legacyAccountFiles('dropbox.files', env, []);
  const at = (tier: string): string => files.find((file) => file.area === 'store' && file.name === tier)!.legacy;
  return { public_safe: at('public_safe'), internal: at('internal'), secure_local: at('secure_local') };
};

const folderPaths = (env: Env): Record<Tier, string> => {
  const account = { source_id: 'dropbox.files', slot: '1', layout: 'folder' as const };
  return Object.fromEntries(DOMAINS.map((tier) => [tier, accountStorePath(account, tier, env)])) as Record<Tier, string>;
};

function open(paths: Record<Tier, string>): TierFixture {
  return openTierFixture(dirname(paths.secure_local), { paths, secretsPath: secretLocationsPathForStore(paths.secure_local) });
}

/** A source the way the engine leaves it: synced through the real tiered set, embedded, closed. */
async function populate(env: Env): Promise<Record<Tier, string>> {
  const paths = legacyPaths(env);
  mkdirSync(dirname(paths.secure_local), { recursive: true });
  const fixture = open(paths);
  try {
    await fixture.set.sync(fixtureConnector(() => SPECS, { cursor: 'page-2' }), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  } finally {
    fixture.close();
  }
  updateSourceRegistry(env, (registry) => {
    registry.accounts.push({
      source_id: 'dropbox.files',
      slot: '1',
      state: 'active',
      layout: 'legacy',
      corpus_ids: DOMAINS.map((tier) => CORPORA[tier]),
      created_at: '2026-10-01T00:00:00.000Z',
    });
  });
  return paths;
}

// ---------------------------------------------------------------------------
// What the source answers and holds

async function search(tiered: TierFixture, query: string): Promise<Record<string, any>> {
  const corpusIds = new Set(Object.values(CORPORA));
  const worker = createEmailSourceWorker({
    connectorStores: tiered.set.openStores(),
    connectorStoreTierSiblings: (corpusId) => [...corpusIds].filter((sibling) => sibling !== corpusId),
    sourceIndexVisibilityGate: createTierVisibilityGate(() => [{ ledger: tiered.ledger, corpusIds }]),
    secretLocationSearch: (text, searched) => (
      searched.some((scope) => scope.corpusId === CORPORA.secure_local) ? tiered.secrets.search(text, {}) : []
    ),
  });
  const response = await worker.fetch(new Request('http://worker.test/v1/source/index/search', {
    method: 'POST',
    body: JSON.stringify({ corpus_id: CORPORA.internal, query }),
    headers: { 'Content-Type': 'application/json' },
  }));
  const payload = await response.json() as Record<string, any>;
  expect({ status: response.status, payload }).toMatchObject({ status: 200 });
  return payload;
}

/** The rows of a store's sync history, the binding row included: a move writes none of them. */
function syncHistory(path: string): Array<Record<string, unknown>> {
  const db = new Database(path, { readonly: true });
  try {
    return db.query(`
      SELECT sync_run_id, connector_id, status, cursor, items_seen, items_indexed, started_at, completed_at
      FROM sync_runs ORDER BY sync_run_id
    `).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

/** The ledger path each bound store names: where the ledger was when the store was bound, a hint that is never rewritten. */
function boundLedger(path: string): string | undefined {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query(`SELECT cursor FROM sync_runs WHERE connector_id = 'tiered_store_set_binding'`).get() as { cursor: string } | null;
    return row ? (JSON.parse(row.cursor) as { ledgerPath: string }).ledgerPath : undefined;
  } finally {
    db.close();
  }
}

/**
 * Where a store alone (no set around it) finds the ledger it is bound to: by the ledger's id, whatever the binding
 * row names. Undefined when no ledger with that id can be found.
 */
function ledgerFoundBy(paths: Record<Tier, string>, tier: Tier): string | undefined {
  const store = openLegStore(paths, tier);
  try {
    return store.tierSetLedgerPath();
  } finally {
    store.close();
  }
}

/** The connections the fixtures open are closed but may not be collected yet; a store file must have none open when it is renamed (the engine moves it before it opens any). */
const settle = (): void => { Bun.gc(true); };

/** The switch turned off: the pass is on by default, so off is said (`OLYMPUS_MIGRATE_ACCOUNT_FOLDERS=0`). */
const withoutSwitch = (env: Env): Env => ({ ...env, [MIGRATE_ACCOUNT_FOLDERS_ENV]: '0' });

/** Adds a handler to the pass's checkpoints; the ones set before it run first, so a handler that kills the pass goes last. */
function onCheckpoint(handler: (at: string) => void): void {
  const previous = __accountMigrationTestHooks.checkpoint;
  __accountMigrationTestHooks.checkpoint = (at) => {
    previous?.(at);
    handler(at);
  };
}

const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const siblings = (store: string): string[] => [store, tierLedgerPathForStore(store), secretLocationsPathForStore(store), tierSnifferPathForStore(store)];

/**
 * The bytes of every store, ledger and sidecar once the pass has folded the logs in (its `folded` step), by the
 * place they end up when moved (`to`) and the place they are put back to (`from`). The move writes nothing to them.
 */
function foldedBytes(from: Record<Tier, string>, to: Record<Tier, string>): Array<{ from: string; to: string; bytes?: string }> {
  const files = DOMAINS.flatMap((tier) => siblings(from[tier]).map((path, index) => ({ from: path, to: siblings(to[tier])[index]! })));
  const taken = files.map((file): { from: string; to: string; bytes?: string } => ({ ...file }));
  onCheckpoint((at) => {
    if (at !== 'folded') return;
    for (const file of taken) if (existsSync(file.from)) file.bytes = digest(file.from);
  });
  return taken;
}

function expectBytesKept(taken: Array<{ from: string; to: string; bytes?: string }>, where: 'from' | 'to', label = ''): void {
  const held = taken.filter((file) => file.bytes !== undefined);
  // The three stores, and the set's ledger and secret-locations index beside the secure one.
  expect(held.length, `${label}: the fold was not reached`).toBeGreaterThanOrEqual(5);
  for (const file of held) expect(digest(file[where]), `${label}: ${file[where]} changed`).toBe(file.bytes!);
}

const itemIds = SPECS.map((spec) => localId(spec.id));

async function observe(paths: Record<Tier, string>) {
  const tiered = open(paths);
  try {
    const result = await search(tiered, 'orchard');
    return {
      hits: result.hits.map((hit: any) => [hit.sourceItem.providerItemId, hit.selected_item.corpus_id]).sort(),
      searched: result.audit.searched_corpora,
      secrets: result.secret_locations,
      policy: result.policy,
    };
  } finally {
    tiered.close();
  }
}

const snapshots = (paths: Record<Tier, string>) => Object.fromEntries(
  DOMAINS.map((tier) => [tier, { rows: snapshotStore(paths[tier], itemIds), history: syncHistory(paths[tier]) }]),
);

/** Every secret-locations index in the folder reads as another size, so the identity check fails with nothing changed on disk. */
function lieAboutSecretLocations(env: Env): void {
  const folder = dirname(folderPaths(env).secure_local);
  __accountMigrationTestHooks.look = (path, actual): MigrationLook | undefined => (
    path.startsWith(`${folder}/`) && path.endsWith('.secret-locations.sqlite') && actual.kind === 'file'
      ? { ...actual, size: actual.size + 1n }
      : undefined
  );
}

describe('a tiered source, moved into its folder', () => {
  test('answers the same, holds the same vectors and sync history, finds its ledger by id where it is now, writes nothing, and re-embeds nothing', async () => {
    const { env } = home();
    const before = await populate(env);
    const answered = await observe(before);
    settle();
    const held = snapshots(before);
    settle();
    const after = folderPaths(env);
    const bytes = foldedBytes(before, after);
    const legacyLedger = tierLedgerPathForStore(before.secure_local);
    // The fixture is what it claims to be: every tier has content, vectors and a binding.
    expect(answered.hits.length).toBeGreaterThanOrEqual(3);
    expect(answered.secrets).toHaveLength(1);
    for (const tier of DOMAINS) {
      expect(held[tier]!.rows.items.length, tier).toBeGreaterThan(0);
      expect(boundLedger(before[tier]), tier).toBe(legacyLedger);
      expect(ledgerFoundBy(before, tier), tier).toBe(legacyLedger);
    }
    expect(held.internal!.rows.vectors.length).toBeGreaterThan(0);
    expect(held.secure_local!.rows.vectors.length).toBeGreaterThan(0);
    expect(held.public_safe!.rows.vectors.length).toBeGreaterThan(0);
    // A cursor was stored by the sync.
    expect(JSON.stringify(held.internal!.history)).toContain('page-2');
    settle();

    const report = migrateAccountFolders(env);
    expect(report, JSON.stringify(report)).toMatchObject({ moved: ['dropbox.files'], movedBack: [], stuck: [] });

    // The same answers: hits per tier, the Secret location beside them, the policy.
    expect(await observe(after)).toEqual(answered);
    settle();
    // The same rows, chunks, vectors (bytes and embedded_at), owners, embedding authority and sync history, binding rows included.
    expect(snapshots(after)).toEqual(held);
    settle();
    // The move wrote nothing to any store, ledger or sidecar: the bytes at the new places are the bytes after the logs were folded in.
    expectBytesKept(bytes, 'to', 'moved');
    // The binding row still names the ledger's old place, which is gone; each store finds the ledger by its id, beside the folder's secure_local store.
    for (const tier of DOMAINS) {
      expect(boundLedger(after[tier]), tier).toBe(legacyLedger);
      expect(existsSync(legacyLedger)).toBe(false);
      expect(ledgerFoundBy(after, tier), tier).toBe(tierLedgerPathForStore(after.secure_local));
    }

    // Syncing again from the moved stores: no provider sees a byte of what was already embedded.
    const again = open(after);
    try {
      await again.set.sync(fixtureConnector(() => SPECS, { cursor: 'page-2' }), { fetchContent: true, placement: FIXTURE_PLACEMENT });
      expect([...again.cloud.inputs, ...again.local.inputs]).toEqual([]);
    } finally {
      again.close();
    }
    for (const tier of DOMAINS) expect(snapshotStore(after[tier], itemIds).vectors, tier).toEqual(held[tier]!.rows.vectors);
  });

  test('a move that fails its check is put back: the stores are the bytes they were, bound to the ledger where it was', async () => {
    const { env } = home();
    const before = await populate(env);
    const answered = await observe(before);
    settle();
    const held = snapshots(before);
    settle();
    const bytes = foldedBytes(before, folderPaths(env));
    lieAboutSecretLocations(env);

    const report = migrateAccountFolders(env);
    expect(report.movedBack).toEqual([{ sourceId: 'dropbox.files', reason: 'verify_failed' }]);
    __accountMigrationTestHooks.reset();

    expectBytesKept(bytes, 'from', 'put back');
    for (const tier of DOMAINS) {
      expect(boundLedger(before[tier]), tier).toBe(tierLedgerPathForStore(before.secure_local));
      expect(ledgerFoundBy(before, tier), tier).toBe(tierLedgerPathForStore(before.secure_local));
    }
    expect(await observe(before)).toEqual(answered);
    settle();
    expect(snapshots(before)).toEqual(held);
  });

  test('killed at each step, then finished or found wrong and put back: the stores open, answer the same, are the same bytes, and find their ledger', async () => {
    const labels: string[] = [];
    {
      const { env } = home();
      await populate(env);
      settle();
      __accountMigrationTestHooks.checkpoint = (at) => { labels.push(at); };
      migrateAccountFolders(env);
      __accountMigrationTestHooks.reset();
    }
    expect(labels.length).toBeGreaterThanOrEqual(9);
    for (const way of ['finished', 'put back'] as const) {
      for (const label of labels.filter((at) => way === 'finished' || at !== 'flipped')) {
        const { env } = home();
        const before = await populate(env);
        const answered = await observe(before);
        settle();
        const held = snapshots(before);
        settle();
        const after = folderPaths(env);
        const bytes = foldedBytes(before, after);
        onCheckpoint((at) => {
          if (at === label) throw new AccountMigrationKilled(at);
        });
        expect(() => migrateAccountFolders(env), `${way} ${label}`).toThrow(AccountMigrationKilled);
        __accountMigrationTestHooks.reset();
        if (way === 'put back') lieAboutSecretLocations(env);

        const boot = migrateAccountFolders(label === 'folded' ? env : withoutSwitch(env));

        expect(boot.errors, `${way} ${label}`).toEqual([]);
        expect(boot.stuck, `${way} ${label}`).toEqual([]);
        const where = way === 'finished' ? 'to' : 'from';
        const paths = way === 'finished' ? after : before;
        if (way === 'finished') expect(boot.moved, `${way} ${label}`).toEqual(label === 'flipped' ? [] : ['dropbox.files']);
        else expect(boot.movedBack, `${way} ${label}`).toEqual([{ sourceId: 'dropbox.files', reason: 'verify_failed' }]);
        expectBytesKept(bytes, where, `${way} ${label}`);
        for (const tier of DOMAINS) expect(ledgerFoundBy(paths, tier), `${way} ${label}: ${tier}`).toBe(tierLedgerPathForStore(paths.secure_local));
        expect(await observe(paths), `${way} ${label}`).toEqual(answered);
        settle();
        expect(snapshots(paths), `${way} ${label}`).toEqual(held);
        settle();
      }
    }
  }, 240_000);

  test('a store bound to a ledger that is not in the folder stays refused after the move: it is never handed the set\'s ledger', async () => {
    const { env } = home();
    const before = await populate(env);
    settle();
    // One store bound to some other set's ledger (an id nothing here carries).
    const db = new Database(before.internal);
    const binding = JSON.parse((db.query(`SELECT cursor FROM sync_runs WHERE connector_id = 'tiered_store_set_binding'`).get() as { cursor: string }).cursor) as Record<string, string>;
    db.query(`UPDATE sync_runs SET cursor = ? WHERE connector_id = 'tiered_store_set_binding'`).run(JSON.stringify({ ...binding, ledgerId: 'ledger-of-another-set' }));
    db.close();
    settle();

    expect(migrateAccountFolders(env).moved).toEqual(['dropbox.files']);

    const after = folderPaths(env);
    expect(ledgerFoundBy(after, 'internal')).toBeUndefined();
    expect(ledgerFoundBy(after, 'secure_local')).toBe(tierLedgerPathForStore(after.secure_local));
  });
});
