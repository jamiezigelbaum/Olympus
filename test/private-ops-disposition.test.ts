import { expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertNoUnredactedIdentityPaths,
  classifyIdentityPath,
  assertFloorStillRedacted,
  readRedactedFloor,
  pathCarriesOwnerIdentifier,
} from '../scripts/private-ops-disposition.ts';
import { OWNER_IDENTITY_PATH_TOKENS, pathCarriesOwnerIdentityToken } from '../scripts/owner-identifier-patterns.ts';
import { pathDigest } from '../scripts/redacted-path-digest.ts';

test('Slice 3 private-ops disposition is exact and live-proven', () => {
  const result = Bun.spawnSync(['bun', 'scripts/private-ops-disposition.ts', 'verify'], {
    cwd: `${import.meta.dir}/..`,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout.toString())).toMatchObject({
    kind: 'olympus_private_ops_disposition_proof',
    schema_version: 1,
    entries: 427,
    canonical_docs: 15,
    live_proof: 'passed',
    content_free: true,
  });
}, 30_000);

// The redaction rule, exercised end to end. The stand-in identity-bearing path
// uses the home-directory identity pattern with a neutral fixture account, so
// the rule classifies it exactly as it classifies a real alias-bearing path
// while this file stays publishable.
const NEW_IDENTITY_PATH = 'scripts/home/fixture/retired-drain.sh';
const CLEAN_PATH = 'scripts/ops/example-clean-drain.sh';

function manifestRow(path: string, seed: string): string {
  return `${createHash('sha256').update(seed).digest('hex')}  ${path}`;
}

test('generate redacts a NEW identity-bearing disposed path it has never published', () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-disposition-generate-'));
  try {
    const sourceManifest = join(dir, 'source.txt');
    const replacementManifest = join(dir, 'replacement.txt');
    const output = join(dir, 'ledger.json');
    const rows = [manifestRow(CLEAN_PATH, 'clean'), manifestRow(NEW_IDENTITY_PATH, 'identity')];
    writeFileSync(sourceManifest, `${rows.join('\n')}\n`);
    writeFileSync(replacementManifest, `${rows.join('\n')}\n`);

    // Neither path appears in the committed ledger, so nothing about this
    // decision can have come from the previous public output.
    const committed = readFileSync(join(import.meta.dir, '..', 'config/private-ops-disposition.json'), 'utf8');
    expect(committed).not.toContain(pathDigest(NEW_IDENTITY_PATH));

    const result = Bun.spawnSync([
      'bun', 'scripts/private-ops-disposition.ts', 'generate',
      '--source', sourceManifest,
      '--replacements', replacementManifest,
      '--output', output,
    ], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);

    const ledger = JSON.parse(readFileSync(output, 'utf8')) as {
      entries: Array<{ path?: string; path_sha256?: string }>;
    };
    const written = readFileSync(output, 'utf8');
    expect(written).not.toContain(NEW_IDENTITY_PATH);
    expect(written).not.toContain('/home/fixture/');
    expect(ledger.entries.find((entry) => entry.path === CLEAN_PATH)).toBeDefined();
    expect(ledger.entries.find((entry) => entry.path_sha256 === pathDigest(NEW_IDENTITY_PATH))).toBeDefined();
    expect(ledger.entries.every((entry) => entry.path !== NEW_IDENTITY_PATH)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test('generation refuses when an identity-bearing path cannot be redacted', () => {
  // A disposed path is redacted automatically, so the fail-closed branch is
  // reachable only for a retained one — which has to keep its name in order to
  // be hashed. That is a human decision, not something to publish quietly.
  const retained = {
    path: NEW_IDENTITY_PATH,
    source_sha256: 'a'.repeat(64),
    replacement_sha256: 'b'.repeat(64),
    disposition: 'retained_product_or_governance' as const,
  };
  const clean = { ...retained, path: CLEAN_PATH };
  expect(() => assertNoUnredactedIdentityPaths([clean])).not.toThrow();
  expect(() => assertNoUnredactedIdentityPaths([clean, retained]))
    .toThrow('Refusing to write 1 path(s) carrying an owner identity.');
  expect(pathCarriesOwnerIdentifier(NEW_IDENTITY_PATH)).toBe(true);
  expect(pathCarriesOwnerIdentifier(CLEAN_PATH)).toBe(false);
});

test('path classification catches an identity token embedded in a longer name', () => {
  // The real tokens, read at runtime from the scanner's own definition, so this
  // file proves the real behaviour without spelling any identifier.
  expect(OWNER_IDENTITY_PATH_TOKENS.length).toBeGreaterThan(0);

  for (const token of OWNER_IDENTITY_PATH_TOKENS) {
    const shapes = [
      `scripts/ops/${token}-drain.sh`,                  // token as its own word
      `scripts/ops/${token}drain.sh`,                   // run straight into the next word
      `scripts/ops/install-${token}bridge-systemd.sh`,  // embedded mid-token
      `docs/ops/${token.toUpperCase()}_WRITE_CREDENTIAL.md`, // upper case, `_` neighbour
      `scripts/${token}-ops/helper.ts`,                 // a directory component
      `scripts/ops/prefix${token}`,                     // trailing, no separator
    ];
    for (const shape of shapes) {
      expect({ shape: shape.replaceAll(token, '<token>'), carries: pathCarriesOwnerIdentityToken(shape) })
        .toEqual({ shape: shape.replaceAll(token, '<token>'), carries: true });
      expect(pathCarriesOwnerIdentifier(shape)).toBe(true);
    }
  }

  // The word-boundary content regexes alone are what missed the `_` shape, and
  // that is precisely why path classification does not rely on them.
  expect(pathCarriesOwnerIdentityToken('scripts/ops/example-clean-drain.sh')).toBe(false);
  expect(pathCarriesOwnerIdentifier(CLEAN_PATH)).toBe(false);
});

test('the redaction floor is independent, checksummed and append-only', () => {
  const ledger = JSON.parse(readFileSync(
    join(import.meta.dir, '..', 'config/private-ops-disposition.json'),
    'utf8',
  )) as { entries: Array<{ path?: string; path_sha256?: string }> };
  const floor = readRedactedFloor();
  const redacted = new Set(ledger.entries.flatMap((entry) => (entry.path_sha256 ? [entry.path_sha256] : [])));
  const literal = ledger.entries.flatMap((entry) => (entry.path ? [entry.path] : []));

  expect(floor.size).toBe(75);
  expect(redacted).toEqual(floor);
  expect(literal.filter((path) => floor.has(pathDigest(path)))).toEqual([]);
  expect(() => assertFloorStillRedacted(floor, redacted)).not.toThrow();

  // The substitution a cardinality check cannot see: swap one digest for
  // another, keep the count identical.
  const substituted = new Set(redacted);
  const [victim] = [...floor];
  substituted.delete(victim!);
  substituted.add(pathDigest('config/never-redacted-substitute.json'));
  expect(substituted.size).toBe(redacted.size);
  expect(() => assertFloorStillRedacted(floor, substituted))
    .toThrow('path(s) on the append-only redaction floor are no longer redacted');

  // The floor alone redacts, even if both matchers were to regress.
  expect(classifyIdentityPath(CLEAN_PATH, { historicalDigests: new Set([pathDigest(CLEAN_PATH)]) }))
    .toMatchObject({ byContentPattern: false, byPathToken: false, byHistoricalDigest: true, carriesIdentity: true });
});

test('the floor file rejects tampering, shrinking and drift', () => {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-floor-'));
  try {
    const digests = [...readRedactedFloor()].sort();
    const write = (value: unknown) => {
      const path = join(dir, `${randomUUID()}.json`);
      writeFileSync(path, JSON.stringify(value, null, 2));
      return path;
    };
    const checksum = (list: string[]) => createHash('sha256').update(list.join('\n')).digest('hex');

    // Honest copy round-trips.
    expect(readRedactedFloor(write({ schema_version: 1, note: 'copy', digests, digests_sha256: checksum(digests) })).size)
      .toBe(digests.length);

    // A substituted digest with the OLD checksum is caught by the checksum.
    const substituted = [...digests.slice(1), pathDigest('config/substitute.json')].sort();
    expect(() => readRedactedFloor(write({ schema_version: 1, note: 'x', digests: substituted, digests_sha256: checksum(digests) })))
      .toThrow('checksum does not match');

    // Shrinking below the append-only minimum is refused even with a valid checksum.
    const shrunk = digests.slice(0, digests.length - 1);
    expect(() => readRedactedFloor(write({ schema_version: 1, note: 'x', digests: shrunk, digests_sha256: checksum(shrunk) })))
      .toThrow('append-only minimum');

    // Growth is allowed: the floor may only ever gain entries.
    const grown = [...digests, pathDigest('config/newly-redacted.json')].sort();
    expect(readRedactedFloor(write({ schema_version: 1, note: 'x', digests: grown, digests_sha256: checksum(grown) })).size)
      .toBe(digests.length + 1);

    for (const [label, value] of [
      ['unsorted', { schema_version: 1, note: 'x', digests: [...digests].reverse(), digests_sha256: checksum([...digests].reverse()) }],
      ['not a digest', { schema_version: 1, note: 'x', digests: ['nope'], digests_sha256: checksum(['nope']) }],
      ['wrong schema', { schema_version: 2, note: 'x', digests, digests_sha256: checksum(digests) }],
    ] as const) {
      expect({ label, threw: (() => { try { readRedactedFloor(write(value)); return false; } catch { return true; } })() })
        .toEqual({ label, threw: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('generate redacts every embedded and split token shape, end to end', () => {
  // Shapes built at runtime from the exported token list, so this file proves
  // the real tokens without spelling one. Every shape goes through the actual
  // generate CLI, and the assertion is on the file it writes.
  const shapes = OWNER_IDENTITY_PATH_TOKENS.flatMap((token) => {
    const cut = Math.ceil(token.length / 2);
    const head = token.slice(0, cut);
    const tail = token.slice(cut);
    return [
      `scripts/ops/${token}-drain.sh`,                       // plain
      `scripts/ops/${token}drain.sh`,                        // run into the next word
      `docs/ops/${token.toUpperCase()}_CREDENTIAL.md`,       // upper case, `_` neighbour
      `scripts/${token}-ops/helper.ts`,                      // directory component
      `scripts/ops/${head}/${tail}-drain.sh`,                // split across a directory boundary
      `scripts/ops/${head}-${tail}-drain.sh`,                // split by a hyphen
      `scripts/ops/${head}_${tail}_drain.sh`,                // split by an underscore
      `scripts/ops/${head}.${tail}.drain.sh`,                // split by a dot
    ];
  });
  expect(shapes.length).toBeGreaterThanOrEqual(24);

  const dir = mkdtempSync(join(tmpdir(), 'olympus-disposition-shapes-'));
  try {
    const rows = shapes.map((path, index) => manifestRow(path, `shape-${index}`));
    const sourceManifest = join(dir, 'source.txt');
    const replacementManifest = join(dir, 'replacement.txt');
    const output = join(dir, 'ledger.json');
    writeFileSync(sourceManifest, `${rows.join('\n')}\n`);
    writeFileSync(replacementManifest, `${rows.join('\n')}\n`);

    const result = Bun.spawnSync([
      'bun', 'scripts/private-ops-disposition.ts', 'generate',
      '--source', sourceManifest,
      '--replacements', replacementManifest,
      '--output', output,
    ], { cwd: join(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);

    const written = readFileSync(output, 'utf8');
    const ledger = JSON.parse(written) as { entries: Array<{ path?: string; path_sha256?: string }> };

    // Every entry redacted: a digest, never a path.
    expect(ledger.entries).toHaveLength(shapes.length);
    expect(ledger.entries.filter((entry) => entry.path !== undefined)).toEqual([]);
    expect(ledger.entries.every((entry) => entry.path_sha256 !== undefined)).toBe(true);
    expect(new Set(ledger.entries.map((entry) => entry.path_sha256)))
      .toEqual(new Set(shapes.map((shape) => pathDigest(shape))));

    // And no token survives in the ENTRIES, in any casing or separator-split
    // form. Scoped to the entries on purpose: the ledger header carries
    // `private_ops_ci`, a real github.com receipt URL that is a sanctioned
    // identifier and has to stay resolvable, so a whole-file assertion would be
    // asserting the wrong thing.
    const serializedEntries = JSON.stringify(ledger.entries).toLowerCase();
    const flattened = serializedEntries.replace(/[^a-z0-9]/g, '');
    for (const token of OWNER_IDENTITY_PATH_TOKENS) {
      expect({ token: token.length, inEntries: serializedEntries.includes(token.toLowerCase()) })
        .toEqual({ token: token.length, inEntries: false });
      expect({ token: token.length, inFlattened: flattened.includes(token.toLowerCase()) })
        .toEqual({ token: token.length, inFlattened: false });
    }
    expect(written).toContain('private_ops_ci');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test('an embedded token that no content pattern sees is still refused for a retained path', () => {
  const tokens = ['retiredalias'];
  const embedded = [
    'scripts/ops/retiredaliasdrain.sh',
    'docs/ops/RETIREDALIAS_WRITE_CREDENTIAL.md',
    'scripts/retiredalias-ops/helper.ts',
    'scripts/ops/retired/alias-drain.sh',
  ];
  for (const path of embedded) {
    expect(pathCarriesOwnerIdentityToken(path, tokens)).toBe(true);
    expect(pathCarriesOwnerIdentifier(path, [], tokens)).toBe(true);
    // With no tokens and no content match it would have been written literally.
    expect(pathCarriesOwnerIdentifier(path, [], [])).toBe(false);
  }
  expect(() => assertNoUnredactedIdentityPaths(
    [{ path: embedded[0]!, source_sha256: 'a'.repeat(64), replacement_sha256: 'b'.repeat(64), disposition: 'retained_product_or_governance' }],
    { patterns: [], tokens },
  )).toThrow('Refusing to write 1 path(s) carrying an owner identity.');
});
