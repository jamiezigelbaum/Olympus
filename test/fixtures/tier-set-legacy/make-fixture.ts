// Writes the legacy tiered-store-set fixture next to this file: three tier
// stores and the set ledger as a lane wrote them before account folders, each
// gzipped. It must run in a checkout of main at 2b58a8ef (before the ledger
// binding found its ledger by identity), so the binding rows are the old
// form, written by that code:
//
//   HOME="$(mktemp -d)" bun test/fixtures/tier-set-legacy/make-fixture.ts
//
// Only the directory in the recorded ledger path is replaced, with
// LEGACY_DATA_DIR, so no machine's path ends up in the repository. The set:
// a plain-text item and a public one routed by the set, a Personal item
// raised to Private (its Personal copy stays behind, hidden), and two items
// the lane stored before the set existed.
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { moveTieredItem } from '../../../src/workers/connector-store/tier-move.ts';
import {
  FIXTURE_PLACEMENT,
  fixtureConnector,
  identityOf,
  openLegStore,
  openTierFixture,
  storePaths,
  type FixtureSpec,
} from '../../helpers/tier-fixtures.ts';

export const LEGACY_DATA_DIR = '/olympus-legacy-data';

const work = mkdtempSync(join(tmpdir(), 'olympus-tier-set-legacy-'));
try {
  const paths = storePaths(work);

  // Items the lane stored before the set existed: the lane's own placement.
  const FERRY: FixtureSpec = { id: 'ferry', name: 'ferry-timetable.txt', text: 'Harbour ferry timetable for the early crew.' };
  const VAULT: FixtureSpec = { id: 'vault', name: 'vault-notes.txt', text: 'Harbour vault inventory kept private.', legacyDomain: 'secure_local' };
  const internal = openLegStore(paths, 'internal');
  const secure = openLegStore(paths, 'secure_local');
  await internal.syncFromConnector(fixtureConnector(() => [FERRY]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await secure.syncFromConnector(fixtureConnector(() => [VAULT]), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  internal.close();
  secure.close();

  const tiered = openTierFixture(work, { embed: false });
  const specs: FixtureSpec[] = [
    { id: 'garden', name: 'garden-plan.txt', text: 'Weekly notes about the vegetable garden and the compost bins.' },
    { id: 'rota', name: 'harbour-rota.txt', text: 'Harbour cleaning rota for the volunteers.' },
    { id: 'notice', name: 'harbour-notice.txt', text: 'Our public harbour notice, already on the blog.', sharing: 'public_link' },
  ];
  await tiered.set.sync(fixtureConnector(() => specs), { fetchContent: true, placement: FIXTURE_PLACEMENT });
  await moveTieredItem({ set: tiered.set, identity: identityOf('garden'), target: { metadataTier: 'secure', contentTier: 'secure' } });
  tiered.close();

  const files = [paths.internal, paths.public_safe, paths.secure_local, `${paths.secure_local.replace(/\.sqlite$/, '')}.tier-ledger.sqlite`,
    `${paths.internal.replace(/\.sqlite$/, '')}.tier-ledger.sqlite`];
  for (const file of files) {
    const name = file.slice(work.length + 1);
    if (name.includes('-store.sqlite')) {
      const db = new Database(file);
      const row = db.query(`SELECT cursor FROM sync_runs WHERE connector_id = 'tiered_store_set_binding'`).get() as { cursor: string } | null;
      if (row) {
        const binding = JSON.parse(row.cursor) as { ledgerId: string; ledgerPath: string };
        binding.ledgerPath = `${LEGACY_DATA_DIR}/${binding.ledgerPath.slice(work.length + 1)}`;
        db.query(`UPDATE sync_runs SET cursor = ? WHERE connector_id = 'tiered_store_set_binding'`).run(JSON.stringify(binding));
      }
      db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
      db.close();
    }
    writeFileSync(join(import.meta.dir, `${name}.gz`), gzipSync(readFileSync(file), { level: 9 }));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
