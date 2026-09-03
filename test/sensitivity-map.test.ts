import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import {
  USER_FACING_TIER_MAPPING,
  parseSensitivityMap,
  validateSensitivityMapFile,
} from '../src/core/sensitivity-map.ts';

function validMap(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    userFacingTiers: USER_FACING_TIER_MAPPING,
    categories: [
      {
        id: 'therapy',
        label: 'Therapy',
        targetTierName: 'secure',
        targetTrustTier: 'S4',
        targetTrustDomain: 'secure_local',
        examples: ['therapy appointment emails', 'session notes'],
        notes: 'Operator wants therapy-related material handled securely.',
        match: {
          keywords: ['therapy', 'therapist'],
          senderPatterns: ['therapist.example'],
          pathPatterns: ['/Health/Therapy'],
        },
      },
    ],
    ...overrides,
  };
}

async function withTempMap(
  map: Record<string, unknown>,
  run: (input: { dir: string; path: string }) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-sensitivity-map-'));
  const path = join(dir, 'sensitivity-map.json');
  try {
    writeFileSync(path, JSON.stringify(map, null, 2));
    await run({ dir, path });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('sensitivity map schema', () => {
  test('parses a valid raise-only map', () => {
    const parsed = parseSensitivityMap(validMap());
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.userFacingTiers.secure).toEqual({ targetTrustTier: 'S4', targetTrustDomain: 'secure_local' });
    expect(parsed.userFacingTiers.secrets).toEqual({ targetTrustTier: 'S5', targetTrustDomain: 'secure_local' });
    expect(parsed.categories[0]).toMatchObject({
      id: 'therapy',
      targetTierName: 'secure',
      targetTrustTier: 'S4',
      targetTrustDomain: 'secure_local',
    });
  });

  test('CLI validation shape reports only counts and ids', async () => {
    await withTempMap(validMap(), async ({ path }) => {
      const proc = Bun.spawn([process.execPath, 'src/cli.ts', 'sensitivity', 'validate', '--path', path], {
        cwd: process.cwd(),
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) throw new Error(stderr || stdout);
      expect(JSON.parse(stdout)).toEqual({
        ok: true,
        path,
        schemaVersion: 1,
        categories: 1,
        categoryIds: ['therapy'],
      });
    });
  }, 30_000);

  test('environment path override is honored', () => {
    return withTempMap(validMap(), ({ path }) => {
      expect(validateSensitivityMapFile({ env: { OLYMPUS_SENSITIVITY_MAP_PATH: path } })).toMatchObject({
        ok: true,
        path,
        categoryIds: ['therapy'],
      });
    });
  });

  test('rejects wrong schema version', () => {
    expect(() => parseSensitivityMap(validMap({ schemaVersion: 2 }))).toThrow(/schemaVersion must be 1/);
  });

  test('rejects unstable or duplicate category ids', () => {
    expect(() => parseSensitivityMap(validMap({
      categories: [
        { ...(validMap().categories as Record<string, unknown>[])[0], id: 'Therapy Notes' },
      ],
    }))).toThrow(/stable lowercase slug/);

    const category = (validMap().categories as Record<string, unknown>[])[0];
    expect(() => parseSensitivityMap(validMap({ categories: [category, { ...category }] }))).toThrow(/must be unique/);
  });

  test('rejects public and private downgrade guidance in Phase 2', () => {
    const category = (validMap().categories as Record<string, unknown>[])[0];
    expect(() => parseSensitivityMap(validMap({
      categories: [{ ...category, targetTierName: 'public', targetTrustTier: 'S0', targetTrustDomain: 'public_safe' }],
    }))).toThrow(/raise-only/);
    expect(() => parseSensitivityMap(validMap({
      categories: [{ ...category, targetTierName: 'private', targetTrustTier: 'S3', targetTrustDomain: 'internal' }],
    }))).toThrow(/raise-only/);
  });

  test('rejects unsupported tier names, trust tiers, and trust domains', () => {
    const category = (validMap().categories as Record<string, unknown>[])[0];
    expect(() => parseSensitivityMap(validMap({
      categories: [{ ...category, targetTierName: 'secret' }],
    }))).toThrow(/targetTierName must be one of/);
    expect(() => parseSensitivityMap(validMap({
      categories: [{ ...category, targetTrustTier: 'S9' }],
    }))).toThrow(/targetTrustTier must be one of/);
    expect(() => parseSensitivityMap(validMap({
      categories: [{ ...category, targetTrustDomain: 'external' }],
    }))).toThrow(/targetTrustDomain must be one of/);
  });

  test('rejects target fields that do not match the user-facing tier', () => {
    const category = (validMap().categories as Record<string, unknown>[])[0];
    expect(() => parseSensitivityMap(validMap({
      categories: [{ ...category, targetTierName: 'secrets', targetTrustTier: 'S4', targetTrustDomain: 'secure_local' }],
    }))).toThrow(/target fields must match secrets/);
  });

  test('rejects empty examples and unbounded match arrays', () => {
    const category = (validMap().categories as Record<string, unknown>[])[0];
    expect(() => parseSensitivityMap(validMap({
      categories: [{ ...category, examples: [] }],
    }))).toThrow(/examples must include at least 1 item/);
    expect(() => parseSensitivityMap(validMap({
      categories: [{
        ...category,
        match: {
          keywords: Array.from({ length: 65 }, (_, index) => `term-${index}`),
          senderPatterns: [],
          pathPatterns: [],
        },
      }],
    }))).toThrow(/match.keywords must include at most 64 items/);
  });

  test('rejects categories with no match terms', () => {
    const category = (validMap().categories as Record<string, unknown>[])[0];
    expect(() => parseSensitivityMap(validMap({
      categories: [{ ...category, match: { keywords: [], senderPatterns: [], pathPatterns: [] } }],
    }))).toThrow(/must include at least one keyword/);
  });
});
