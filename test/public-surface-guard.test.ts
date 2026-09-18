// Public-surface guard: the source tree must equal the public product, or say
// why not.
//
// The two earlier boundary cleanups each finished their own named scope and
// left everything outside it. This guard is scoped by construction instead:
// every `src/**` module the public entrypoints do not reach after the public
// runtime strip, every operation off the public tool lists, and every skill
// directory off the public skill list must be named in
// `config/public-surface-allowlist.json` with a reason and a retirement
// condition. An entry that is no longer a leftover fails too, so the list can
// only shrink. Do not add an entry to make a change pass; delete the leftover
// or put it on the public surface.

import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import allowlist from '../config/public-surface-allowlist.json';
import { operations } from '../src/core/operations.ts';
import {
  V0_4_PUBLIC_MCP_TOOLS,
  V0_4_PUBLIC_NATIVE_TOOLS,
  V0_4_PUBLIC_SKILL_DIRS,
} from '../src/core/public-surface.ts';
import { publicReachability } from '../scripts/public-surface-reach.ts';

const repoRoot = join(import.meta.dir, '..');

interface AllowlistEntry {
  readonly reason: string;
  readonly retire_when: string;
}

/**
 * The operation list is empty: every registered operation is now public. Its
 * JSON type is therefore `never[]`, so the shape the guard still enforces is
 * spelled out here rather than inferred — an entry added back has to satisfy
 * it, and the guard keeps failing on any entry that is no longer a leftover.
 */
const allowlistOperations = allowlist.operations as readonly (AllowlistEntry & { readonly name: string })[];

function assertJustified(kind: string, key: string, entry: AllowlistEntry): void {
  expect(entry.reason.trim().length, `${kind} ${key} needs a reason`).toBeGreaterThan(0);
  expect(entry.retire_when.trim().length, `${kind} ${key} needs a retirement condition`).toBeGreaterThan(0);
}

function ratchet(kind: string, actual: readonly string[], allowed: readonly string[], hint: string): void {
  const actualSet = new Set(actual);
  const allowedSet = new Set(allowed);
  const unlisted = actual.filter((item) => !allowedSet.has(item));
  const stale = allowed.filter((item) => !actualSet.has(item));
  expect(
    unlisted,
    `${kind} outside the public surface with no allowlist entry (${hint}):\n${unlisted.join('\n')}`,
  ).toEqual([]);
  expect(
    stale,
    `${kind} allowlist entries that are no longer outside the public surface; remove them:\n${stale.join('\n')}`,
  ).toEqual([]);
  expect(new Set(allowed).size, `${kind} allowlist has duplicate entries`).toBe(allowed.length);
}

describe('public-surface guard', () => {
  test('every src module is reachable from the public entrypoints or allowlisted with a reason', () => {
    const report = publicReachability(repoRoot);
    for (const entrypoint of report.entrypoints) {
      expect(existsSync(join(repoRoot, entrypoint)), `entrypoint ${entrypoint} missing`).toBe(true);
    }
    for (const entry of allowlist.modules) assertJustified('module', entry.path, entry);
    ratchet(
      'src modules',
      report.unreachable,
      allowlist.modules.map((entry) => entry.path),
      'delete the module, wire it into the product, or add an entry to config/public-surface-allowlist.json',
    );
  });

  test('every registered operation is on the public tool lists or allowlisted with a reason', () => {
    const publicTools = new Set<string>([...V0_4_PUBLIC_NATIVE_TOOLS, ...V0_4_PUBLIC_MCP_TOOLS]);
    const nonPublic = operations.map((operation) => operation.name).filter((name) => !publicTools.has(name));
    for (const entry of allowlistOperations) assertJustified('operation', entry.name, entry);
    ratchet(
      'operations',
      nonPublic,
      allowlistOperations.map((entry) => entry.name),
      'delete the operation, add it to src/core/public-surface.ts, or add an entry to config/public-surface-allowlist.json',
    );
  });

  test('every skill directory is on the public skill list or allowlisted with a reason', () => {
    const skillsRoot = join(repoRoot, 'skills');
    const skillDirs = readdirSync(skillsRoot)
      .filter((name) => statSync(join(skillsRoot, name)).isDirectory())
      .map((name) => `skills/${name}`)
      .sort();
    const publicSkills = new Set<string>(V0_4_PUBLIC_SKILL_DIRS);
    const nonPublic = skillDirs.filter((dir) => !publicSkills.has(dir));
    for (const entry of allowlist.skills) assertJustified('skill', entry.path, entry);
    ratchet(
      'skill directories',
      nonPublic,
      allowlist.skills.map((entry) => entry.path),
      'delete the skill, add it to V0_4_PUBLIC_SKILL_DIRS, or add an entry to config/public-surface-allowlist.json',
    );
  });
});
