import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { REPOSITORY_ONLY_PLUGIN_CONFIG_KEYS } from '../src/core/config.ts';
import { V0_4_PUBLIC_PLUGIN_CONFIG_KEYS } from '../src/core/public-surface.ts';

const ROOT = join(import.meta.dir, '..');

// The public manifest is intentionally narrower than the repository reader:
// old and private-ops keys may remain readable until their source owners move,
// but they must not become accepted installation interfaces again.
function readerRootConfigKeys(): string[] {
  const source = readFileSync(join(ROOT, 'src', 'core', 'config.ts'), 'utf8');
  const body = source.slice(source.indexOf('const root = asRecord(pluginConfig)'));
  return [...new Set([...body.matchAll(/\broot\?\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]!))].sort();
}

describe('plugin config schema binding', () => {
  test('manifest validation accepts exactly the public keys and rejects repository-only compatibility keys', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'openclaw.plugin.json'), 'utf8')) as {
      configSchema: { additionalProperties?: boolean; properties: Record<string, unknown> };
    };
    const readerKeys = readerRootConfigKeys();

    expect(manifest.configSchema.additionalProperties).toBe(false);
    expect(Object.keys(manifest.configSchema.properties)).toEqual([...V0_4_PUBLIC_PLUGIN_CONFIG_KEYS]);
    expect(V0_4_PUBLIC_PLUGIN_CONFIG_KEYS.every((key) => readerKeys.includes(key))).toBe(true);
    expect(readerKeys.filter((key) => !(key in manifest.configSchema.properties)))
      .toEqual([...REPOSITORY_ONLY_PLUGIN_CONFIG_KEYS]);
  });
});
