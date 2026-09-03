// R62 finding: the x-bookmarks-api-usage v10→v11 migration (the durable
// `provenance` column behind the operator-run exemption) was proven only by a
// reviewer's manual probe. A probe is not a regression test, and this
// migration is the one place where getting the default backwards silently
// widens the exemption: every reservation a v10 store left standing would
// come back as `operator` and convert to its full unclamped charge past the
// daily budget — exactly the refusal-in-reverse the exemption exists to avoid.
//
// The fixture is a REAL v10 store, not a hand-written schema. It is built by
// the shipping code and then rewound by dropping exactly what migration 11
// added (the repo's existing pre-migration-store idiom, cf.
// test/connector-store.test.ts). Copying migration SQL into the test was the
// alternative, and it is the one that rots: the copy drifts from the source
// silently and the fixture quietly stops describing any store that ever
// existed. `the rewound fixture is a faithful v10 store` is the guard on the
// rewind instead — replaying migration 11 over it must reproduce a freshly
// built v11 schema byte for byte, so should migration 11 ever add more than
// this one column, the fixture fails loudly rather than testing fiction.

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertSqliteSchemaCanOpen,
  readSqliteSchemaVersion,
  runSqliteMigrations,
} from '../src/core/sqlite-migrations.ts';
import {
  LocalXBookmarksApiUsageStore,
  X_BOOKMARKS_API_USAGE_SCHEMA_VERSION,
  X_BOOKMARKS_API_USAGE_STORE_ID,
  defaultXBookmarksLiveSyncConfig,
  type XBookmarksLiveSyncConfig,
} from '../src/workers/x-bookmarks/index.ts';

const ACCOUNT = 'personal';
const NOON = new Date('2026-08-19T12:00:00.000Z');
/** Past the 15-minute in-flight lease: the crash verdict is in. */
const AFTER_LEASE = new Date(NOON.getTime() + 20 * 60_000);
/**
 * Pinned literally rather than derived from the store's current version. The
 * fixture rewinds by undoing exactly migration 11, so a later schema version
 * has to come back here and say what a v10 fixture means now instead of
 * sliding forward and quietly rewinding to the wrong place.
 */
const V10 = 10;
const V11 = 11;

describe('x-bookmarks-api-usage v10 to v11 provenance migration', () => {
  test('the rewound fixture is a faithful v10 store, and re-migrating it reproduces the v11 schema exactly', () => {
    withTempDir((dir) => {
      // The rewind below undoes migration 11 and nothing else, so this file
      // has to be revisited the moment the store grows a migration 12.
      expect(X_BOOKMARKS_API_USAGE_SCHEMA_VERSION).toBe(V11);

      const fresh = join(dir, 'fresh.sqlite');
      new LocalXBookmarksApiUsageStore(fresh).close();

      const rewound = join(dir, 'rewound.sqlite');
      buildV10Fixture(rewound);

      // The fixture really is v10: the column migration 11 adds is absent and
      // the recorded version is the one a v10-era build would have written.
      expect(reservationColumns(rewound)).not.toContain('provenance');
      expect(storedSchemaVersion(rewound)).toBe(V10);

      // Replaying the shipped migration over it lands on the shipped schema —
      // every table, index, and column definition identical to a store the
      // code built from nothing. This is what makes the fixture evidence.
      new LocalXBookmarksApiUsageStore(rewound).close();
      expect(schemaDump(rewound)).toEqual(schemaDump(fresh));
      expect(storedSchemaVersion(rewound)).toBe(X_BOOKMARKS_API_USAGE_SCHEMA_VERSION);
    });
  });

  test('a reservation a v10 store left standing is migrated to scheduled provenance, and the column refuses anything else', () => {
    withTempDir((dir) => {
      const path = join(dir, 'x-usage.sqlite');
      const reservationId = buildV10Fixture(path).standingReservationId;
      expect(reservationColumns(path)).not.toContain('provenance');

      const usage = new LocalXBookmarksApiUsageStore(path);
      try {
        // Opening is the migration. The pre-existing row was written before
        // provenance existed, so the DEFAULT is the only thing that can decide
        // it — and it must decide `scheduled`, the guarded lane.
        expect(reservationProvenance(usage, reservationId)).toBe('scheduled');
        expect(storedSchemaVersion(path)).toBe(X_BOOKMARKS_API_USAGE_SCHEMA_VERSION);
      } finally {
        usage.close();
      }

      // The CHECK travels with the migration, so a migrated store cannot be
      // talked into a third provenance by anything that writes the row.
      const raw = new Database(path);
      try {
        expect(() => raw.query(
          'UPDATE x_api_request_reservations SET provenance = ? WHERE reservation_id = ?',
        ).run('owner', reservationId)).toThrow(/CHECK constraint failed/);
        expect(() => raw.query(
          'UPDATE x_api_request_reservations SET provenance = ? WHERE reservation_id = ?',
        ).run('operator', reservationId)).not.toThrow();
      } finally {
        raw.close();
      }
    });
  });

  test('the crash-reap converts a migrated reservation at the clamped scheduled charge, not the operator charge', () => {
    withTempDir((dir) => {
      const path = join(dir, 'x-usage.sqlite');
      buildV10Fixture(path);
      const config = migrationTestConfig();

      const usage = new LocalXBookmarksApiUsageStore(path);
      try {
        // The fixture's day already stands at 8 of its 10 spend units, and the
        // standing reservation is worth 5. Reading status past the lease is
        // what convicts it of the crash and converts it.
        expect(usage.status({ account: ACCOUNT, config, now: NOON })).toMatchObject({
          resource_reads: 8,
          estimated_spend_microusd: 8_000,
          reserved_resource_reads: 5,
        });

        // Scheduled: clamped to the 2 units of budget actually left.
        // Operator would take all 5 and land at 13 — the widened exemption
        // this test exists to catch.
        expect(usage.status({ account: ACCOUNT, config, now: AFTER_LEASE })).toMatchObject({
          resource_reads: 10,
          estimated_billable_resources: 10,
          estimated_spend_microusd: 10_000,
          reserved_resource_reads: 0,
        });
      } finally {
        usage.close();
      }
    });
  });

  test('a v10-era build refuses to open the migrated v11 store instead of writing to it blind', () => {
    withTempDir((dir) => {
      const path = join(dir, 'x-usage.sqlite');
      buildV10Fixture(path);
      new LocalXBookmarksApiUsageStore(path).close();
      expect(storedSchemaVersion(path)).toBe(X_BOOKMARKS_API_USAGE_SCHEMA_VERSION);

      // A v10-era binary knows nothing of the provenance column. Both gates it
      // would pass through must refuse: were either to let it in, it would
      // reserve rows through a v10 INSERT that names no provenance and read
      // the ledger back through v10 queries that cannot see one.
      const stale = new Database(path);
      try {
        expect(() => assertSqliteSchemaCanOpen(stale, X_BOOKMARKS_API_USAGE_STORE_ID, V10))
          .toThrow(/schema_version 11.*only knows schema_version 10/s);
        expect(() => runSqliteMigrations(stale, X_BOOKMARKS_API_USAGE_STORE_ID, [], { knownVersion: V10 }))
          .toThrow(/schema_version 11.*only knows schema_version 10/s);

        // Forward-only, not version-pinned: the build that owns v11 opens it.
        expect(() => assertSqliteSchemaCanOpen(
          stale,
          X_BOOKMARKS_API_USAGE_STORE_ID,
          X_BOOKMARKS_API_USAGE_SCHEMA_VERSION,
        )).not.toThrow();
      } finally {
        stale.close();
      }
    });
  });
});

/**
 * Build a store as a v10 Olympus would have left it after crashing between
 * dispatch and settlement: 8 of 10 spend units recorded, and one dispatched
 * reservation for 5 more standing with an expired in-flight lease.
 *
 * Written entirely through the shipping store, then rewound by dropping the
 * single column migration 11 adds and restoring the recorded version. Nothing
 * about the resulting file is invented: the provenance the rows were created
 * with is dropped along with the column, which is precisely why a v10 store
 * has none to read.
 */
function buildV10Fixture(path: string): { standingReservationId: string } {
  const config = migrationTestConfig();
  const usage = new LocalXBookmarksApiUsageStore(path);
  // Operator provenance only so the fixture's numbers are reachable at all —
  // it is dropped with the column below, and a v10 store could have reached
  // the same state through any sequence of guarded reservations.
  const standing = usage.reserveRequest({
    account: ACCOUNT,
    requestedMaxResources: 5,
    provenance: 'operator',
    config,
    now: NOON,
  });
  const spent = usage.reserveRequest({
    account: ACCOUNT,
    requestedMaxResources: 8,
    provenance: 'operator',
    config,
    now: NOON,
  });
  usage.settleSuccess({
    reservation: spent,
    resourceIds: Array.from({ length: 8 }, (_, index) => `post:fixture-${index}`),
    config,
    now: NOON,
  });
  usage.close();

  const rewind = new Database(path);
  try {
    rewind.exec('ALTER TABLE x_api_request_reservations DROP COLUMN provenance;');
    rewind.query('UPDATE schema_version SET version = ? WHERE store_id = ?')
      .run(V10, X_BOOKMARKS_API_USAGE_STORE_ID);
  } finally {
    rewind.close();
  }
  return { standingReservationId: standing.reservationId };
}

/** Ten spend units at 1000 microUSD each, no reserves: the same shape the
 * operator-provenance suite uses, so the two read against one another. */
function migrationTestConfig(): XBookmarksLiveSyncConfig {
  return {
    ...defaultXBookmarksLiveSyncConfig({}),
    dailyApiRequestBudget: 100,
    dailyResourceReadBudget: 100,
    dailyEstimatedSpendMicrousd: 10_000,
    estimatedUnitCostMicrousd: 1_000,
    headApiRequestReserve: 0,
    headResourceReadReserve: 0,
    headEstimatedSpendReserveMicrousd: 0,
    rateLimitLowWatermark: 0,
    richResourceExpansionMultiplier: 1,
  };
}

function reservationProvenance(usage: LocalXBookmarksApiUsageStore, reservationId: string): string | undefined {
  const raw = new Database(usage.dbPath, { readonly: true });
  try {
    const row = raw.query('SELECT provenance FROM x_api_request_reservations WHERE reservation_id = ?')
      .get(reservationId) as { provenance?: string } | null;
    return row?.provenance;
  } finally {
    raw.close();
  }
}

function reservationColumns(path: string): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return (db.query('PRAGMA table_info(x_api_request_reservations)').all() as Array<{ name: string }>)
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

function storedSchemaVersion(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    return readSqliteSchemaVersion(db, X_BOOKMARKS_API_USAGE_STORE_ID);
  } finally {
    db.close();
  }
}

function schemaDump(path: string): Array<Record<string, unknown>> {
  const db = new Database(path, { readonly: true });
  try {
    return db.query(`
      SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name
    `).all() as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-x-usage-v10-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
