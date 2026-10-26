// A source added after account folders declares only its tiers in the layout
// module (docs/CREATE_CONNECTOR.md, Leg 3): every account of it lives in its
// folder, whatever the registry or the data folder can say, and nothing of it
// is looked for at a legacy path or moved by the boot migration.

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  __layoutTestHooks,
  accountFolder,
  accountStoreNames,
  accountStorePath,
  legacyAccountPaths,
  migratableSources,
} from '../src/core/olympus-layout.ts';
import { decideAccountLayout, placedAccount, resolvedStorePath } from '../src/core/source-placement.ts';
import { sourceRegistryPath } from '../src/core/source-registry.ts';

const SOURCE = 'example.files';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fresh(): Record<string, string> {
  const home = mkdtempSync(join(tmpdir(), 'folder-only-source-'));
  roots.push(home);
  return { HOME: home, XDG_DATA_HOME: join(home, 'data') };
}

describe('a source added after account folders', () => {
  test('its stores are the tiers it declares, in its account folder', () => {
    __layoutTestHooks.withFolderOnlySource(SOURCE, ['secure_local', 'internal'], () => {
      const env = fresh();
      expect(accountStoreNames(SOURCE)).toEqual(['secure_local', 'internal']);
      expect(placedAccount(SOURCE, env).layout).toBe('folder');
      expect(resolvedStorePath(SOURCE, 'internal', env))
        .toBe(join(accountFolder({ source_id: SOURCE, slot: '1' }, env), 'stores', 'internal.sqlite'));
    });
  });

  test('it has no legacy paths: none is looked for, none is moved, none can be asked for', () => {
    __layoutTestHooks.withFolderOnlySource(SOURCE, ['secure_local'], () => {
      const env = fresh();
      expect(legacyAccountPaths(SOURCE, env)).toEqual({ stores: [], raw: [] });
      expect(migratableSources()).not.toContain(SOURCE);
      expect(() => accountStorePath({ source_id: SOURCE, slot: '1', layout: 'legacy' }, 'secure_local', env)).toThrow(/no legacy layout/);
    });
  });

  test('an unreadable registry or data folder still places it in its folder', () => {
    __layoutTestHooks.withFolderOnlySource(SOURCE, ['secure_local'], () => {
      const env = fresh();
      const registry = sourceRegistryPath(env);
      mkdirSync(dirname(registry), { recursive: true });
      writeFileSync(registry, '{ not json');
      expect(placedAccount(SOURCE, env).layout).toBe('folder');
      // A data folder that is a file cannot be looked at; a source with legacy paths would stay legacy.
      const blocked = fresh();
      mkdirSync(blocked.XDG_DATA_HOME!, { recursive: true });
      writeFileSync(join(blocked.XDG_DATA_HOME!, 'openclaw'), '');
      expect(decideAccountLayout(SOURCE, blocked).layout).toBe('folder');
      expect(decideAccountLayout('gmail.email', blocked).layout).toBe('legacy');
    });
  });
});
