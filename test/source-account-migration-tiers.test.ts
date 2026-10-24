// The boot migration over real tiered stores (docs/design/source-storage.md,
// "What must not break"): a source whose three tier stores, tier ledger and
// secret-locations index were written by the real tiered store set, with
// embeddings, is moved into its account folder, and then answers exactly as it
// did: the same hits, the same vectors, the same sync history, nothing
// re-embedded. A move that is put back leaves the stores bound to the ledger
// where it was. Expected results are the stores' own content read before the
// move, not what the migration reports.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTierVisibilityGate } from '../src/workers/connector-store/tier-visibility.ts';
import { createEmailSourceWorker } from '../src/workers/email-source/index.ts';
import { secretLocationsPathForStore, tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import { accountStorePath, legacyAccountFiles, olympusDataRoot } from '../src/core/olympus-layout.ts';
import {
  __accountMigrationTestHooks,
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

/** The rows of a store's sync history, with the one thing a move changes, the tier ledger's path in its binding, left out. */
function syncHistory(path: string): Array<Record<string, unknown>> {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.query(`
      SELECT sync_run_id, connector_id, status, cursor, items_seen, items_indexed, started_at, completed_at
      FROM sync_runs ORDER BY sync_run_id
    `).all() as Array<Record<string, unknown>>;
    return rows.map((row) => (row['connector_id'] === 'tiered_store_set_binding'
      ? { ...row, cursor: JSON.stringify({ ledgerId: (JSON.parse(String(row['cursor'])) as { ledgerId: string }).ledgerId }) }
      : row));
  } finally {
    db.close();
  }
}

/** The ledger path each bound store names, by tier. */
function boundLedger(path: string): string | undefined {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query(`SELECT cursor FROM sync_runs WHERE connector_id = 'tiered_store_set_binding'`).get() as { cursor: string } | null;
    return row ? (JSON.parse(row.cursor) as { ledgerPath: string }).ledgerPath : undefined;
  } finally {
    db.close();
  }
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

describe('a tiered source, moved into its folder', () => {
  test('answers the same, holds the same vectors and sync history, binds to the ledger where it is now, and re-embeds nothing', async () => {
    const { env } = home();
    const before = await populate(env);
    const answered = await observe(before);
    const held = snapshots(before);
    // The fixture is what it claims to be: every tier has content, vectors and a binding.
    expect(answered.hits.length).toBeGreaterThanOrEqual(3);
    expect(answered.secrets).toHaveLength(1);
    for (const tier of DOMAINS) {
      expect(held[tier]!.rows.items.length, tier).toBeGreaterThan(0);
      expect(boundLedger(before[tier]), tier).toBe(tierLedgerPathForStore(before.secure_local));
    }
    expect(held.internal!.rows.vectors.length).toBeGreaterThan(0);
    expect(held.secure_local!.rows.vectors.length).toBeGreaterThan(0);
    expect(held.public_safe!.rows.vectors.length).toBeGreaterThan(0);
    // A cursor was stored by the sync.
    expect(JSON.stringify(held.internal!.history)).toContain('page-2');

    const report = migrateAccountFolders(env);
    expect(report, JSON.stringify(report)).toMatchObject({ moved: ['dropbox.files'], movedBack: [], stuck: [] });

    const after = folderPaths(env);
    // The same answers: hits per tier, the Secret location beside them, the policy.
    expect(await observe(after)).toEqual(answered);
    // The same rows, chunks, vectors (bytes and embedded_at), owners, embedding authority and sync history.
    expect(snapshots(after)).toEqual(held);
    // Each store is bound to the ledger where it is now, and the ledger is the one it was.
    for (const tier of DOMAINS) expect(boundLedger(after[tier]), tier).toBe(tierLedgerPathForStore(after.secure_local));

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

  test('a move that fails its check is put back with the stores bound to the ledger where it was', async () => {
    const { env } = home();
    const before = await populate(env);
    const answered = await observe(before);
    const held = snapshots(before);
    const folder = dirname(folderPaths(env).secure_local);
    __accountMigrationTestHooks.look = (path, actual): MigrationLook | undefined => (
      path.startsWith(`${folder}/`) && path.endsWith('.secret-locations.sqlite') && actual.kind === 'file'
        ? { ...actual, size: actual.size + 1n }
        : undefined
    );

    const report = migrateAccountFolders(env);
    expect(report.movedBack).toEqual([{ sourceId: 'dropbox.files', reason: 'verify_failed' }]);
    __accountMigrationTestHooks.reset();

    for (const tier of DOMAINS) expect(boundLedger(before[tier]), tier).toBe(tierLedgerPathForStore(before.secure_local));
    expect(await observe(before)).toEqual(answered);
    expect(snapshots(before)).toEqual(held);
  });

  test('a move that fails after the stores were bound to the new ledger binds them to the old one again', async () => {
    const { env } = home();
    const before = await populate(env);
    const answered = await observe(before);
    const held = snapshots(before);
    __accountMigrationTestHooks.checkpoint = (at) => {
      if (at === 'rebound') throw new Error('something stopped the move');
    };

    const report = migrateAccountFolders(env);
    expect(report.movedBack).toEqual([{ sourceId: 'dropbox.files', reason: 'move_failed' }]);
    __accountMigrationTestHooks.reset();

    for (const tier of DOMAINS) expect(boundLedger(before[tier]), tier).toBe(tierLedgerPathForStore(before.secure_local));
    expect(await observe(before)).toEqual(answered);
    expect(snapshots(before)).toEqual(held);
  });

  test('a store bound to a ledger the move does not name keeps its binding', async () => {
    const { env } = home();
    const before = await populate(env);
    // One store bound to some other set's ledger: not this move's to rewrite.
    const stranger = join(dirname(before.secure_local), 'some-other-set.tier-ledger.sqlite');
    const db = new Database(before.internal);
    const binding = JSON.parse((db.query(`SELECT cursor FROM sync_runs WHERE connector_id = 'tiered_store_set_binding'`).get() as { cursor: string }).cursor) as Record<string, string>;
    db.query(`UPDATE sync_runs SET cursor = ? WHERE connector_id = 'tiered_store_set_binding'`).run(JSON.stringify({ ...binding, ledgerPath: stranger }));
    db.close();

    expect(migrateAccountFolders(env).moved).toEqual(['dropbox.files']);

    expect(boundLedger(folderPaths(env).internal)).toBe(stranger);
    expect(boundLedger(folderPaths(env).secure_local)).toBe(tierLedgerPathForStore(folderPaths(env).secure_local));
  });
});
