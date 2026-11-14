// A worker upgrade in flight, as `olympus worker upgrade` marks one before it
// copies the stores. The boot copies a store before a schema update, and
// moves retired state aside, only while one is (boot-progress.ts).
import { markWorkerUpgradeInFlight } from '../../src/core/boot-progress.ts';

export function upgradeInFlight(env: Record<string, string | undefined>): void {
  markWorkerUpgradeInFlight(env, new Date(Date.now() - 60 * 60 * 1000).toISOString());
}
