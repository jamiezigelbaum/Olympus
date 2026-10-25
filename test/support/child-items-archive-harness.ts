// An archive import runtime over a temp data folder whose connector is the
// child-items fixture (test/helpers/child-items-fixture.ts), so the spine is
// exercised through the real import, tier set, ledger and removal with no
// format involved. A tiny real mbox file stands in for the approved export:
// the import binds its manifest as it would any archive; the fixture connector
// ignores its bytes and lists the parents and children it was given.

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { SourceConnector } from '../../src/core/contracts.ts';
import { getArchiveFormat, type ArchiveConnectorFactory } from '../../src/core/archive-formats.ts';
import { SecretLocationsIndex } from '../../src/workers/classification/secret-locations.ts';
import { secretLocationsPathForStore } from '../../src/workers/classification/tier-ledger-path.ts';
import { createArchiveImportRuntime, type ArchiveImportRuntime } from '../../src/workers/archive-import/runtime.ts';
import { archiveConnectorStoreDbPath } from '../../src/workers/archive-import/store.ts';
import { pullArchiveImport, type ArchiveImportPullOptions } from '../../src/workers/archive-import/sync.ts';
import {
  createFixtureChildConnector,
  newFixtureReadLog,
  type FixtureConnectorOptions,
  type FixtureParentSpec,
  type FixtureReadLog,
} from '../helpers/child-items-fixture.ts';

export const FIXTURE_ARCHIVE_FORMAT = 'mbox';

export interface ChildItemsArchiveHarness {
  base: string;
  env: Record<string, string>;
  runtime: ArchiveImportRuntime;
  log: FixtureReadLog;
  /** Starts an import of a tiny stand-in export; returns the archive id (also its account scope). */
  start(name?: string): string;
  /**
   * Starts an import of a stand-in export FOLDER: the tiny export plus the media files given (path
   * under the folder -> bytes). Returns the archive id and the folder's path.
   */
  startFolder(name: string, media?: Record<string, string | Uint8Array>): { archiveId: string; folder: string };
  /** The factory handing the fixture connector to the import. */
  factory(parents: readonly FixtureParentSpec[], extra?: Partial<FixtureConnectorOptions>): (formatId: string) => ArchiveConnectorFactory;
  pull(archiveId: string, parents: readonly FixtureParentSpec[], options?: Partial<ArchiveImportPullOptions> & { connector?: Partial<FixtureConnectorOptions> }): ReturnType<typeof pullArchiveImport>;
  importAll(archiveId: string, parents: readonly FixtureParentSpec[], options?: Partial<ArchiveImportPullOptions> & { connector?: Partial<FixtureConnectorOptions> }): ReturnType<typeof pullArchiveImport>;
  /** Item rows per tier store for one archive: provider item id -> row. */
  rows(archiveId: string): Array<{ domain: string; providerItemId: string; tombstoned: number; trustTier: string; chunks: number; parent: string | null; locator: string | null; available: number | null; size: number | null }>;
  close(): void;
}

function miniMbox(): string {
  return [
    'From sender@example.invalid Mon Jan  5 10:00:00 2015',
    'From: Sam Example <sam@example.invalid>',
    'Subject: stand-in',
    'Date: Mon, 05 Jan 2015 10:00:00 +0000',
    'Message-ID: <stand-in@example.invalid>',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'stand-in',
    '',
  ].join('\n');
}

export function childItemsArchiveHarness(cleanups: Array<() => void>): ChildItemsArchiveHarness {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'archive-child-items-')));
  const env = { HOME: base, XDG_DATA_HOME: join(base, 'xdg'), OPENCLAW_STATE_DIR: join(base, 'openclaw') };
  const exports = join(base, 'exports');
  mkdirSync(exports);
  const runtime = createArchiveImportRuntime({
    env,
    statePath: join(base, 'xdg', 'archive-imports.json'),
    waitingQuestionsDbPath: join(base, 'waiting-private-questions.sqlite'),
    openSecretLocations: (secureDbPath) => new SecretLocationsIndex({ dbPath: secretLocationsPathForStore(secureDbPath) }),
  });
  const log = newFixtureReadLog();
  const close = (): void => {
    runtime.media.close();
    for (const lane of runtime.existingLanes()) {
      for (const store of lane.set.openStores()) store.close();
      lane.secretLocations?.close();
      lane.ledger.close();
    }
    rmSync(base, { recursive: true, force: true });
  };
  cleanups.push(close);
  let started = 0;
  const format = getArchiveFormat(FIXTURE_ARCHIVE_FORMAT)!;
  const factory = (parents: readonly FixtureParentSpec[], extra: Partial<FixtureConnectorOptions> = {}) =>
    (): ArchiveConnectorFactory => (input): SourceConnector => createFixtureChildConnector({
      accountScope: input.accountScope,
      provider: format.provider,
      family: format.family,
      id: input.connectorId,
      parents,
      log,
      ...(input.pageSize !== undefined ? { pageSize: input.pageSize } : {}),
      reportItemPositions: (positions) => input.reportItemPositions?.(positions),
      ...(input.media ? { media: input.media } : {}),
      ...extra,
    });
  const pullOptions = (parents: readonly FixtureParentSpec[], options: Partial<ArchiveImportPullOptions> & { connector?: Partial<FixtureConnectorOptions> }) => {
    const { connector, ...rest } = options;
    return { connectorFactory: factory(parents, connector), media: runtime.media, ...rest };
  };
  const harness: ChildItemsArchiveHarness = {
    base,
    env,
    runtime,
    log,
    start(name = `Export-${(started += 1)}.mbox`) {
      const path = join(exports, name);
      // Distinct bytes per archive: the same export is refused as already imported.
      writeFileSync(path, `${miniMbox()}\nX-Stand-In: ${name}\n`);
      const result = runtime.start(path);
      if (result.kind !== 'started') throw new Error(`expected a start, got ${result.kind}`);
      return result.archive.archive_id;
    },
    startFolder(name, media = {}) {
      // The shape of a mail export folder: `Name.mbox` holding a file called `mbox`.
      const folder = join(exports, `${name}.mbox`);
      mkdirSync(folder, { recursive: true });
      // Distinct bytes per archive: the same export is refused as already imported.
      writeFileSync(join(folder, 'mbox'), `${miniMbox()}\nX-Stand-In: ${name}\n`);
      for (const [rel, bytes] of Object.entries(media)) {
        mkdirSync(dirname(join(folder, rel)), { recursive: true });
        writeFileSync(join(folder, rel), bytes);
      }
      const result = runtime.start(folder);
      if (result.kind !== 'started') throw new Error(`expected a start, got ${result.kind}`);
      return { archiveId: result.archive.archive_id, folder };
    },
    factory,
    pull(archiveId, parents, options = {}) {
      return pullArchiveImport({
        state: runtime.state,
        lane: runtime.lane(format.family),
        archiveId,
        ...pullOptions(parents, options),
      });
    },
    async importAll(archiveId, parents, options = {}) {
      for (let pass = 0; pass < 100; pass += 1) {
        const outcome = await harness.pull(archiveId, parents, options);
        if (!outcome.continueSoon) return outcome;
      }
      throw new Error('the import did not finish');
    },
    rows(archiveId) {
      const found: ReturnType<ChildItemsArchiveHarness['rows']> = [];
      for (const domain of ['public_safe', 'internal', 'secure_local'] as const) {
        const path = archiveConnectorStoreDbPath(domain, format.family, env);
        if (!existsSync(path)) continue;
        const db = new Database(path, { readonly: true });
        try {
          const rows = db.query(`
            SELECT i.provider_item_id AS id, i.tombstoned AS tombstoned, i.trust_tier AS tier, i.parent_local_item_id AS parent,
              i.deferred_locator AS locator, i.bytes_available AS available, i.size_bytes AS size,
              (SELECT COUNT(*) FROM chunks c WHERE c.item_pk = i.item_pk) AS chunks
            FROM items i WHERE i.account_scope = ? ORDER BY i.item_pk
          `).all(archiveId) as Array<{ id: string; tombstoned: number; tier: string; parent: string | null; locator: string | null; available: number | null; size: number | null; chunks: number }>;
          for (const row of rows) {
            found.push({ domain, providerItemId: row.id, tombstoned: row.tombstoned, trustTier: row.tier, chunks: row.chunks, parent: row.parent, locator: row.locator, available: row.available, size: row.size });
          }
        } finally {
          db.close();
        }
      }
      return found;
    },
    close,
  };
  return harness;
}
