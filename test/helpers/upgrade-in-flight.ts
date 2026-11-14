// A worker upgrade in flight: its copy of a store outside the test's view,
// recorded and made an hour ago. The boot copies a store before a schema
// update, and moves retired state aside, only while one is (boot-progress.ts).
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { recordSchemaBackup, UPGRADE_COPY_SUFFIX } from '../../src/core/boot-progress.ts';

export function upgradeInFlight(env: Record<string, string | undefined>, root = env.HOME!): void {
  const other = join(root, 'other', 'upgraded.sqlite');
  mkdirSync(dirname(other), { recursive: true });
  writeFileSync(other, '');
  writeFileSync(`${other}${UPGRADE_COPY_SUFFIX}`, '');
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  utimesSync(`${other}${UPGRADE_COPY_SUFFIX}`, hourAgo, hourAgo);
  recordSchemaBackup(env, { storeId: 'other/upgraded.sqlite', dbPath: other, backupPath: `${other}${UPGRADE_COPY_SUFFIX}` });
}
