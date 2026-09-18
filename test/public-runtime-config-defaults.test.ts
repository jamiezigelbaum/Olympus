// The public package deletes marked spans from real source files, and `bun
// build` never type-checks the result. That is how the v0.4 package shipped a
// broker whose OAuth mint methods were stripped while their caller survived,
// and how src/core/config.ts once shipped a DEFAULT_CONFIG missing sections
// its own interface declared required — any packaged-build reader of those
// sections crashes invisibly to `tsc` over the repo.
//
// The retired private lanes took the last exclusion span in src/core/config.ts
// with them, so the config module is no longer marker-stripped at all: the
// public build gets the same defaults the repository does. This test locks
// both halves of the class gate that remains. The public defaults must carry
// no private section and must still load with no config file and no env, and
// every module that IS still marker-stripped must type-check after stripping
// under the repository compiler options.

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Glob } from 'bun';
import { afterAll, describe, expect, test } from 'bun:test';
import ts from 'typescript';
import { defaultConfig, loadConfig } from '../src/core/config.ts';

const ROOT = join(import.meta.dir, '..');
const CONFIG_MODULE = 'src/core/config.ts';
const START_MARKER = '// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START';
const temporaryRoots: string[] = [];

afterAll(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// Faithful copy of stripPublicRuntimeExcludedBlocks in
// scripts/release-artifact.ts, which executes the full release build at import
// time and so cannot be imported from a test. The markers are the contract;
// if the release stripper changes, re-copy it here.
function stripPublicRuntimeExcludedBlocks(source: string, path: string): string {
  const start = START_MARKER;
  const end = '// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END';
  let output = '';
  let cursor = 0;
  let removed = 0;
  while (cursor < source.length) {
    const startIndex = source.indexOf(start, cursor);
    const endIndex = source.indexOf(end, cursor);
    if (startIndex === -1) {
      if (endIndex !== -1) throw new Error(`Unmatched public-runtime exclusion end marker in ${path}.`);
      output += source.slice(cursor);
      break;
    }
    if (endIndex !== -1 && endIndex < startIndex) {
      throw new Error(`Public-runtime exclusion end marker precedes its start marker in ${path}.`);
    }
    const matchingEnd = source.indexOf(end, startIndex + start.length);
    if (matchingEnd === -1) throw new Error(`Unmatched public-runtime exclusion start marker in ${path}.`);
    output += source.slice(cursor, startIndex);
    cursor = matchingEnd + end.length;
    removed += 1;
  }
  if (removed === 0) throw new Error(`Public runtime expected explicit exclusion blocks in ${path}.`);
  return output;
}

/** Repo-relative paths of every src module carrying exclusion markers. */
function markedModules(): string[] {
  return [...new Glob('src/**/*.ts').scanSync({ cwd: ROOT })]
    .map((path) => path.split('\\').join('/'))
    .filter((path) => readFileSync(join(ROOT, path), 'utf8').includes(START_MARKER))
    .sort();
}

/** Copies src into a temp mirror with every marked module stripped. */
function strippedMirror(): { mirror: string; strippedPaths: string[] } {
  const mirror = mkdtempSync(join(ROOT, '.public-runtime-stripped-test-'));
  temporaryRoots.push(mirror);
  cpSync(join(ROOT, 'src'), join(mirror, 'src'), { recursive: true });
  const strippedPaths: string[] = [];
  for (const module of markedModules()) {
    const sourcePath = join(ROOT, module);
    const mirrorPath = join(mirror, module);
    writeFileSync(mirrorPath, stripPublicRuntimeExcludedBlocks(readFileSync(sourcePath, 'utf8'), sourcePath));
    strippedPaths.push(mirrorPath);
  }
  return { mirror, strippedPaths };
}

describe('public runtime config defaults', () => {
  test('src/core/config.ts carries no exclusion span, so the public build ships the repository defaults', () => {
    // A private section reappearing here is the regression: it would either
    // ship in the public bundle or grow a new exclusion span, and both are
    // decisions that belong in review rather than in a defaults literal.
    // Whether a repository-only plugin key reaches the public manifest is
    // proven by test/plugin-config-schema-reader-binding.test.ts, which
    // compares the reader's key set against the manifest; not repeated here.
    expect(markedModules()).not.toContain(CONFIG_MODULE);
    expect(readFileSync(join(ROOT, CONFIG_MODULE), 'utf8')).not.toContain(START_MARKER);
  });

  test('the private dev toggles default off and a defaults-only load still validates', () => {
    // The private surface the public build still carries is three dev toggles.
    // Each must be off by default, and a load with no config file and no env
    // must produce exactly the defaults — the validation path included.
    const defaults = defaultConfig();
    expect(defaults.email.localPacketsDevEnabled).toBe(false);
    expect(defaults.email.indexAdminDevEnabled).toBe(false);
    expect(defaults.sourceIndex.answerDevEnabled).toBe(false);
    expect(loadConfig({ OLYMPUS_CONFIG: join(ROOT, 'absent-config.json') })).toEqual(defaults);
  });

  // The delta fix wave repaired the broker and credential-health strip spans,
  // so the gate holds every stripped module to the fully strict bar.
  const KNOWN_STRIP_TYPE_DEFECTS: string[] = [];

  test('every marker-stripped module type-checks after stripping', () => {
    const { mirror, strippedPaths } = strippedMirror();
    const tsconfig = ts.readConfigFile(join(ROOT, 'tsconfig.json'), ts.sys.readFile);
    expect(tsconfig.error).toBeUndefined();
    const parsed = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, ROOT);
    const program = ts.createProgram(strippedPaths, { ...parsed.options, noEmit: true });
    // Only the stripped modules' own text is held to this bar: unstripped
    // shared modules may name the stripped config sections inside
    // PUBLIC_RUNTIME_BUILD-guarded branches the bundler eliminates, which tsc
    // still checks against the stripped interface.
    const strippedSet = new Set(strippedPaths.map((path) => resolve(path)));
    const diagnostics = [
      ...program.getSyntacticDiagnostics(),
      ...program.getSemanticDiagnostics(),
    ].filter((diagnostic) => diagnostic.file && strippedSet.has(resolve(diagnostic.file.fileName)));
    const byModule = new Map<string, string[]>();
    for (const diagnostic of diagnostics) {
      const module = resolve(diagnostic.file!.fileName).slice(resolve(mirror).length + 1);
      const messages = byModule.get(module) ?? [];
      messages.push(`${module}:${diagnostic.start}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`);
      byModule.set(module, messages);
    }
    expect([...byModule.keys()].sort()).toEqual(KNOWN_STRIP_TYPE_DEFECTS);
    expect([...byModule.entries()]
      .filter(([module]) => !KNOWN_STRIP_TYPE_DEFECTS.includes(module))
      .flatMap(([, messages]) => messages)).toEqual([]);
  }, 120_000);
});
