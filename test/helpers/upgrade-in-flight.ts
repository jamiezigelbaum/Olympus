// A worker upgrade in flight, as `olympus worker upgrade` marks one before it
// copies the stores. The boot copies a store before a schema update, and
// moves retired state aside, only while one is (boot-progress.ts).
import { readFileSync, writeFileSync } from 'node:fs';
import { markWorkerUpgradeInFlight } from '../../src/core/boot-progress.ts';
import { sharedDataPath } from '../../src/core/olympus-layout.ts';

export function upgradeInFlight(env: Record<string, string | undefined>): void {
  markWorkerUpgradeInFlight(env, new Date(Date.now() - 60 * 60 * 1000).toISOString());
  // The stores a test makes next stand for ones the earlier version had: a mark without its list of state files
  // (one an earlier build wrote) takes nothing away on a put-back.
  const path = sharedDataPath('upgrade-in-flight', env);
  const { state_files: _listed, ...mark } = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  writeFileSync(path, `${JSON.stringify(mark)}\n`);
}
