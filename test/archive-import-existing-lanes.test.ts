// One archive family whose lane cannot be built yet must not stop a ready
// family from mounting in the same refresh. Synthetic paths only.

import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { archiveImportFamilies } from '../src/core/archive-formats.ts';
import { createArchiveImportRuntime } from '../src/workers/archive-import/runtime.ts';
import { archiveConnectorStoreDbPath } from '../src/workers/archive-import/store.ts';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

test('a family whose lane fails does not keep a later ready family from mounting', () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'archive-existing-lanes-')));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const env = { HOME: join(base, 'home'), XDG_DATA_HOME: join(base, 'xdg'), OPENCLAW_STATE_DIR: join(base, 'openclaw') };
  const [first, second] = archiveImportFamilies();
  expect(first).toBeDefined();
  expect(second).toBeDefined();
  // Both families have data on disk, so both are candidates.
  for (const family of [first!, second!]) {
    const path = archiveConnectorStoreDbPath('internal', family, env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
  }
  const unfinished = new Error('first family ledger unfinished');
  const runtime = createArchiveImportRuntime({
    env,
    statePath: join(base, 'xdg', 'archive-imports.json'),
    openSecretLocations: (secureDbPath) => {
      if (secureDbPath === archiveConnectorStoreDbPath('secure_local', first!, env)) throw unfinished;
      return undefined;
    },
  });
  cleanups.push(() => {
    for (const family of [first!, second!]) {
      if (runtime.laneMounted(family)) runtime.lane(family).ledger.close();
    }
  });
  expect(() => runtime.existingLanes()).toThrow(unfinished);
  expect(runtime.laneMounted(first!)).toBe(false);
  expect(runtime.laneMounted(second!)).toBe(true);
});
