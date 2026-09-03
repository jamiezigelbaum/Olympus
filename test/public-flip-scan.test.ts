import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import {
  NEUTRAL_MATCHES,
  SANCTIONED_HITS,
  formatReport,
  scanTree,
  trackedFiles,
} from '../scripts/public-flip-scan.ts';
import { OWNER_IDENTIFIER_PATTERNS } from '../scripts/owner-identifier-patterns.ts';

const ROOT = join(import.meta.dir, '..');
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true });
});

/** A throwaway tree scanned by explicit path list, so no git repository is needed. */
function fixtureTree(files: Record<string, string>): { root: string; paths: string[] } {
  const root = mkdtempSync(join(tmpdir(), 'olympus-flip-scan-'));
  temporaryRoots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  return { root, paths: Object.keys(files) };
}

describe('public flip owner-identifier scan', () => {
  test('reads every tracked file, not the packaged inventory', () => {
    const tracked = trackedFiles(ROOT);
    // The published tarball is 29 files. The repository is three orders of
    // magnitude wider, and all of it becomes world-readable at the flip.
    expect(tracked.length).toBeGreaterThan(500);
    for (const path of ['src/native-plugin.ts', 'test/lifecycle.test.ts', 'eval/README.md', 'skills/RESOLVER.md']) {
      expect(tracked).toContain(path);
    }
  });

  test('the severity split is exhaustive and stable', () => {
    expect(OWNER_IDENTIFIER_PATTERNS.length).toBeGreaterThan(0);
    for (const pattern of OWNER_IDENTIFIER_PATTERNS) {
      expect(['identity', 'private-surface']).toContain(pattern.severity);
    }
    const identityLabels = OWNER_IDENTIFIER_PATTERNS
      .filter((pattern) => pattern.severity === 'identity')
      .map((pattern) => pattern.label);
    expect(identityLabels).toContain('a tenant or host identity');
    expect(identityLabels).toContain('private key material');
    // Names of private operations are excluded from the package, not from the
    // repository; classifying them as blockers would make the scan unusable.
    const surfaceLabels = OWNER_IDENTIFIER_PATTERNS
      .filter((pattern) => pattern.severity === 'private-surface')
      .map((pattern) => pattern.label);
    expect(surfaceLabels).toContain('a private operation');
    expect(surfaceLabels).toContain('a private protocol');
  });

  test('an unsanctioned identity in any file is a blocker', () => {
    const { root, paths } = fixtureTree({
      'src/anything.ts': "export const host = 'ssh sparta';\n",
      'docs/notes.md': 'Deployed from /Users/realperson/Code/Olympus.\n',
    });
    const report = scanTree(root, paths);
    expect(report.blockers.map((hit) => `${hit.path}:${hit.match}`).sort()).toEqual([
      'docs/notes.md:/Users/realperson/',
      'src/anything.ts:sparta',
    ]);
    expect(report.sanctioned).toHaveLength(0);
    expect(formatReport(report, false)).toContain('BLOCKING');
  });

  test('a sanctioned identifier is allowed only in its own file', () => {
    const { root, paths } = fixtureTree({
      'config/critical-review.json': '{ "reviewerLogins": ["jamiezigelbaum"] }\n',
      'src/elsewhere.ts': "export const reviewer = 'jamiezigelbaum';\n",
    });
    const report = scanTree(root, paths);
    expect(report.sanctioned).toHaveLength(1);
    expect(report.sanctioned[0]!.path).toBe('config/critical-review.json');
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]!.path).toBe('src/elsewhere.ts');
  });

  test('a sanctioned file still fails on a different identifier', () => {
    const { root, paths } = fixtureTree({
      // The sanction covers the reviewer login, not everything in the file.
      'config/critical-review.json': '{ "reviewerLogins": ["jamiezigelbaum"], "host": "sparta" }\n',
    });
    const report = scanTree(root, paths);
    expect(report.sanctioned.map((hit) => hit.match)).toEqual(['jamiezigelbaum']);
    expect(report.blockers.map((hit) => hit.match)).toEqual(['sparta']);
  });

  test('the LICENSE copyright line is the only exempt owner name', () => {
    const { root, paths } = fixtureTree({
      LICENSE: 'MIT License\n\nCopyright (c) 2026 Jamie Zigelbaum\n\nPermission is hereby granted...\n',
    });
    expect(scanTree(root, paths).blockers).toHaveLength(0);

    const second = fixtureTree({
      LICENSE: 'MIT License\n\nCopyright (c) 2026 Jamie Zigelbaum\n\nContact jamie@example.test.\n',
    });
    const report = scanTree(second.root, second.paths);
    expect(report.blockers.map((hit) => hit.match)).toContain('jamie@example.test');
  });

  test('neutral fixture values are allowed anywhere, real ones are not', () => {
    const { root, paths } = fixtureTree({
      'test/a.test.ts': "const home = '/Users/owner/Health/notes';\n",
      'test/b.test.ts': "const home = '/Users/realperson/Health/notes';\n",
      'test/c.test.ts': "const sa = 'olympus-secure@olympus-fixture-project.iam.gserviceaccount.com';\n",
      'test/d.test.ts': "const sa = 'olympus-secure@castor-000001.iam.gserviceaccount.com';\n",
    });
    const report = scanTree(root, paths);
    expect(report.sanctioned.map((hit) => hit.path).sort()).toEqual(['test/a.test.ts', 'test/c.test.ts']);
    expect(report.blockers.map((hit) => hit.path)).toContain('test/b.test.ts');
    expect(report.blockers.map((hit) => hit.path)).toContain('test/d.test.ts');
  });

  test('private-surface names are reported but never block the flip', () => {
    const { root, paths } = fixtureTree({
      'docs/ops/PROTOCOL.md': 'Restart only via scripts/ops/openclaw-safe-restart.sh.\n',
      'src/ops.ts': "export const op = 'castor_workspace';\n",
    });
    const report = scanTree(root, paths);
    expect(report.blockers).toHaveLength(0);
    expect([...new Set(report.privateSurface.map((hit) => hit.path))].sort())
      .toEqual(['docs/ops/PROTOCOL.md', 'src/ops.ts']);
    expect(report.privateSurface.every((hit) => hit.severity === 'private-surface')).toBe(true);
  });

  test('a file holding NUL bytes is scanned, not written off as binary', () => {
    // Two WhatsApp connector sources carry a NUL in a string literal. A
    // "skip binaries" heuristic would have excluded real published source from
    // the only scan standing between it and a public remote.
    const { root, paths } = fixtureTree({ 'src/connector.ts': 'const sep = \'\u0000\'; // ssh sparta\n' });
    const report = scanTree(root, paths);
    expect(report.scannedFiles).toBe(1);
    expect(report.blockers.map((hit) => hit.match)).toEqual(['sparta']);
  });

  test('the real tree has no tracked file the scan silently skips', () => {
    const report = scanTree(ROOT);
    expect(report.scannedFiles).toBe(trackedFiles(ROOT).length - report.unreadable.length);
    // Nothing is expected to be unreadable today; if that changes, the report
    // names the paths so they can be inspected by hand rather than assumed safe.
    expect(report.unreadable).toEqual([]);
  });

  test('an unreadable tracked path is reported, never silently dropped', () => {
    const { root } = fixtureTree({ 'kept.ts': 'clean\n' });
    const report = scanTree(root, ['kept.ts', 'does/not/exist.ts']);
    expect(report.scannedFiles).toBe(1);
    expect(report.unreadable).toEqual(['does/not/exist.ts']);
    expect(formatReport(report, false)).toContain('UNREAD');
  });

  test('no sanction row is dead weight', () => {
    // A row whose literal ends up regex-escaped in its own file never matches,
    // so it silently stops being a decision anyone can audit. Three such rows
    // existed before this assertion did.
    const report = scanTree(ROOT);
    const live = new Set(report.sanctioned.map((hit) => `${hit.path}\u0000${hit.label}`));
    const dead = SANCTIONED_HITS
      .filter((entry) => !entry.path.endsWith('/'))
      .filter((entry) => !live.has(`${entry.path}\u0000${entry.label}`))
      .map((entry) => `${entry.path}: ${entry.label}`);
    expect(dead).toEqual([]);
  });

  test('every sanction carries a reason and an anchored match', () => {
    for (const entry of [...SANCTIONED_HITS, ...NEUTRAL_MATCHES]) {
      expect(entry.reason.length).toBeGreaterThan(20);
      // An unanchored match would sanction any string containing the allowed
      // one, which is how an allowlist quietly stops being a guard.
      expect(entry.match.source.startsWith('^')).toBe(true);
      expect(entry.match.source.endsWith('$')).toBe(true);
      expect(OWNER_IDENTIFIER_PATTERNS.some((pattern) => pattern.label === entry.label)).toBe(true);
    }
  });
});
