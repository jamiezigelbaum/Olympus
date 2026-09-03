import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { describe, expect, test } from 'bun:test';

const REPO_ROOT = join(import.meta.dir, '..');

// ---------------------------------------------------------------------------
// A runtime artifact must never locate its toolchain by exact version.
//
// 2026-07-28: fifteen repo-owned artifacts defaulted the Node runtime to
// `${HOME}/.openclaw/tools/node-v22.22.0/bin`. The host upgrades Node behind a
// maintained `~/.openclaw/tools/node` symlink, so the pinned directory simply
// stopped existing. Nothing announced that. Scripts that only prepend the
// directory to PATH silently resolved some other node — or none — and the
// operators who passed OPENCLAW_SAFE_RESTART_NODE_BIN explicitly never saw the
// stale default at all, which is how it survived.
//
// This is the same failure class as the Homebrew Cellar pin that took GUI
// automation down for five days on 2026-07-23: a version-pinned path does not
// fail loudly, it falls back. The version belongs to whoever maintains the
// symlink, never to a file in this repo.
//
// The scan is derived from the tree, never enumerated: an artifact added next
// month is covered without anyone remembering to add it here.
// ---------------------------------------------------------------------------

// Roots that hold artifacts which run on, or are rendered onto, a host.
const SCAN_ROOTS = ['src', 'scripts', 'bin', 'config', 'tools'] as const;

// Environment and service artifacts remain in scope even though private host
// manifests moved to olympus-ops.
const SCANNED_EXTENSIONS = new Set([
  '.ts', '.js', '.mjs', '.cjs', '.py', '.sh', '.zsh', '.bash',
  '.service', '.timer', '.env', '.json', '.conf', '.yaml', '.yml', '.toml',
]);
const MAX_SCANNED_BYTES = 1_048_576;

// An artifact whose whole job is to install or repair a specific toolchain
// version has to name one. Empty by design — a pin lands here only with a
// comment saying who maintains the version and why a symlink cannot. The
// exemption is paid for, not granted.
const DELIBERATE_VERSION_PIN_OWNERS = new Set<string>([]);

// A filesystem path that embeds an exact toolchain version. Bare version
// strings are deliberately absent: `NODE_VERSION=22.22.0` in a build matrix
// declares a requirement, it does not resolve a binary at runtime.
const VERSION_PINNED_PATHS: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  // fnm / nvm keep every install under a version directory.
  { label: 'fnm/nvm version directory (`node-versions/v22.22.0`)', pattern: /node-versions\/v\d+(?:\.\d+)*/ },
  // The OpenClaw tools directory shape: `tools/node-v22.22.0/bin`.
  { label: 'versioned node directory (`node-v22.22.0`)', pattern: /\bnode-v\d+(?:\.\d+)*/ },
  { label: 'versioned node directory (`nodejs-v22.22.0`)', pattern: /\bnodejs-v\d+(?:\.\d+)*/ },
  { label: 'versioned node directory (`node/22.22.0`)', pattern: /\bnode(?:js)?\/v?\d+\.\d+\.\d+/ },
  // Homebrew's Cellar is the same defect wearing a different name — this is
  // the shape that broke GUI automation for five days.
  { label: 'Homebrew Cellar version directory', pattern: /\/Cellar\/[A-Za-z0-9_.+-]+\/\d+\.\d+/ },
];

export function versionPinViolations(text: string): string[] {
  const violations: string[] = [];
  text.split('\n').forEach((line, index) => {
    for (const { label, pattern } of VERSION_PINNED_PATHS) {
      if (pattern.test(line)) violations.push(`${index + 1}: ${label}`);
    }
  });
  return violations;
}

function scannedArtifacts(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const entry of new Bun.Glob('**/*').scanSync({ cwd: join(REPO_ROOT, root) })) {
      const rel = `${root}/${entry.split('\\').join('/')}`;
      if (SCANNED_EXTENSIONS.has(extname(rel))) {
        files.push(rel);
        continue;
      }
      // An extensionless executable is still a runtime artifact, so the list
      // cannot be an extension allow-list alone. Sniff the shebang; anything
      // too large to be a script is not one.
      const absolute = join(REPO_ROOT, rel);
      if (statSync(absolute).size > MAX_SCANNED_BYTES) continue;
      if (readFileSync(absolute, 'utf8').slice(0, 2) === '#!') files.push(rel);
    }
  }
  return files.sort();
}

describe('runtime artifacts resolve their toolchain by a version-stable path', () => {
  test('no repo-owned runtime artifact pins an exact toolchain version', () => {
    const artifacts = scannedArtifacts();

    // A glob that matched nothing — or that stopped reaching the artifacts
    // which actually resolve a toolchain — would make the assertion below
    // vacuously green.
    expect(artifacts.length).toBeGreaterThan(0);
    for (const anchor of ['bin/olympus', 'scripts/ops/openclaw-safe-restart.sh']) {
      expect(artifacts).toContain(anchor);
    }

    const violations: string[] = [];
    for (const rel of artifacts) {
      if (DELIBERATE_VERSION_PIN_OWNERS.has(rel)) continue;
      for (const violation of versionPinViolations(readFileSync(join(REPO_ROOT, rel), 'utf8'))) {
        violations.push(`${rel}:${violation}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test('the detector recognizes every pinned shape and accepts the stable ones', () => {
    const rejected = [
      'NODE_BIN_DIR="${OLYMPUS_SPARTA_NODE_BIN_DIR:-${HOME}/.openclaw/tools/node-v22.22.0/bin}"',
      'NODE_BIN_DIR=${HOME}/.openclaw/tools/node-v22.22.0/bin',
      'NODE_BIN="${HOME}/.local/share/fnm/node-versions/v22.22.0/installation/bin/node"',
      'Environment=PATH=${HOME}/.openclaw/tools/node-v24/bin:/usr/bin',
      'export PATH="/opt/nodejs-v20.11.1/bin:$PATH"',
      'NODE="/usr/local/node/22.22.0/bin/node"',
      'PEEKABOO_BIN=/opt/homebrew/Cellar/peekaboo/1.4.2/bin/peekaboo',
    ];
    for (const line of rejected) {
      expect({ line, flagged: versionPinViolations(line).length > 0 })
        .toEqual({ line, flagged: true });
    }

    const accepted = [
      // The maintained symlink — the version is the host's to change.
      'NODE_BIN_DIR="${OLYMPUS_SPARTA_NODE_BIN_DIR:-${HOME}/.openclaw/tools/node/bin}"',
      'NODE_BIN="${OPENCLAW_SAFE_RESTART_NODE_BIN:-${HOME}/.openclaw/tools/node/bin/node}"',
      'NODE_BIN_DIR=${HOME}/.openclaw/tools/node/bin',
      // fnm's default alias tracks whatever the host selected.
      'NODE_BIN="${HOME}/.local/share/fnm/aliases/default/bin/node"',
      'NODE_BIN="$(command -v node)"',
      'Environment=PATH=${NODE_BIN_DIR}:${HOME}/.bun/bin:/usr/local/bin:/usr/bin:/bin',
      // A declared requirement is not a resolved path.
      'NODE_VERSION=22.22.0',
      'engines: { node: ">=22.0.0" }',
    ];
    for (const line of accepted) {
      expect({ line, violations: versionPinViolations(line) })
        .toEqual({ line, violations: [] });
    }
  });

  test('an artifact added after this guard was written is covered', () => {
    // The point of deriving the list from the tree is that next month's file
    // is guarded without anyone editing this test. Prove that by putting a
    // fresh offender in the tree and watching the same scan the guard above
    // uses pick it up.
    const fixtureDir = join(REPO_ROOT, 'scripts', `pin-guard-fixture-${process.pid}-${Math.random().toString(36).slice(2, 10)}`);
    const rel = `scripts/${fixtureDir.split('/').pop()}/install-tomorrows-service.sh`;
    try {
      mkdirSync(fixtureDir, { recursive: true });
      writeFileSync(
        join(fixtureDir, 'install-tomorrows-service.sh'),
        '#!/usr/bin/env bash\nNODE_BIN_DIR="${HOME}/.openclaw/tools/node-v22.22.0/bin"\n',
      );

      const artifacts = scannedArtifacts();
      expect(artifacts).toContain(rel);

      const violations = artifacts
        .filter((candidate) => candidate === rel)
        .flatMap((candidate) => versionPinViolations(readFileSync(join(REPO_ROOT, candidate), 'utf8')));
      expect(violations).toEqual(['2: versioned node directory (`node-v22.22.0`)']);
    } finally {
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
