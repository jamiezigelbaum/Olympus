/**
 * The built plugin bundles must contain no top-level `await`.
 *
 * OpenClaw's plugin loader is synchronous end to end: it `require()`s the
 * plugin entry and, when that throws, falls back to a jiti source transform.
 * Top-level await anywhere in the entry's module graph breaks BOTH legs —
 * `ERR_REQUIRE_ASYNC_MODULE` on the first, "await is only valid in async
 * functions" on the second — so the plugin fails to load before `register` is
 * ever called. Nothing in the repository's own test suite notices: every test
 * here loads the source through `import()`, where top-level await is legal.
 *
 * That is exactly how the private extension point was first written, and it
 * would have failed every install, public and overlay alike. This is the class
 * gate for it. `test/plugin-host-loader-compatibility.test.ts` proves the same
 * property against the real host loader when that install is present; this file
 * needs no toolchain and therefore runs everywhere, on every change.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import ts from 'typescript';
import {
  STAGED_SYNCHRONOUS_ENTRYPOINTS,
  assertNoTopLevelAwait,
  assertStagedEntrypointsAreSynchronouslyLoadable,
  topLevelAwaitLines,
} from '../scripts/top-level-await-scan.ts';
import { assertStagedManifestIsPublic } from '../scripts/public-manifest-guard.ts';

const ROOT = join(import.meta.dir, '..');
const fixtures: string[] = [];

afterAll(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A staging tree with exactly the given relative files. */
function stagingFixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'olympus-staging-fixture-'));
  fixtures.push(dir);
  for (const [relative, contents] of Object.entries(files)) {
    const path = join(dir, relative);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, contents);
  }
  return dir;
}

describe('built plugin bundles', () => {
  for (const bundle of STAGED_SYNCHRONOUS_ENTRYPOINTS) {
    test(`${bundle} has no top-level await, so a synchronous host loader can load it`, () => {
      const path = join(ROOT, bundle);
      const source = readFileSync(path, 'utf8');
      expect(topLevelAwaitLines(source, path)).toEqual([]);
      expect(() => assertNoTopLevelAwait(source, path)).not.toThrow();
    }, 120_000);
  }

  test('the scanned set is exactly what the host loads synchronously', () => {
    // Scope, pinned against package.json: OpenClaw loads dist/index.js through
    // its synchronous plugin loader, and nothing else. dist/cli.js is run by
    // Bun through bin/olympus, where top-level await is legal. If a future
    // entrypoint joins openclaw.extensions this fails until it is scanned too.
    expect([...STAGED_SYNCHRONOUS_ENTRYPOINTS]).toEqual(['dist/index.js']);
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      openclaw: { extensions: string[]; runtimeExtensions: string[] };
    };
    const scanned: string[] = [...STAGED_SYNCHRONOUS_ENTRYPOINTS];
    for (const entry of [...pkg.openclaw.extensions, ...pkg.openclaw.runtimeExtensions]) {
      expect(scanned).toContain(entry.replace(/^\.\//, ''));
    }
  });

  test('the staged-entrypoint gate refuses a minified bundle carrying top-level await', () => {
    // Behavioural, not textual: the release re-bundles and re-minifies, so the
    // bytes that ship are not the bytes checked above. A fixture staging tree
    // proves the gate actually rejects, rather than that a name appears in the
    // builder's source.
    const staging = stagingFixture({
      'dist/index.js': 'var a=1;const m=await import("x");export default m;',
    });
    expect(() => assertStagedEntrypointsAreSynchronouslyLoadable(staging))
      .toThrow(/dist\/index\.js contains top-level await/);

    const clean = stagingFixture({
      'dist/index.js': 'async function f(){await 1}export default f;',
    });
    expect(() => assertStagedEntrypointsAreSynchronouslyLoadable(clean)).not.toThrow();
  });

  test('the staged-manifest gate refuses a private overlay manifest', () => {
    const publicManifest = JSON.stringify({ id: 'olympus', configSchema: { properties: {} } });
    expect(() => assertStagedManifestIsPublic(
      stagingFixture({ 'openclaw.plugin.json': publicManifest }),
    )).not.toThrow();

    for (const namespace of [
      { privateExtensions: { required: true, contractVersion: 1, module: 'private-extensions.cjs' } },
      { privateExtensions: false },
      'private',
      null,
    ]) {
      const staged = stagingFixture({
        'openclaw.plugin.json': JSON.stringify({ id: 'olympus', configSchema: {}, olympus: namespace }),
      });
      expect(() => assertStagedManifestIsPublic(staged), JSON.stringify(namespace))
        .toThrow(/privateExtensions|not a JSON object/);
    }
  });

  test('the release builder actually calls both staged gates on the staging directory', () => {
    // The behavioural tests above prove the gates work; this proves the builder
    // still invokes them. Asserted through the AST, so deleting the call cannot
    // stay green while the import lingers.
    const path = join(ROOT, 'scripts/release-artifact.ts');
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ESNext, false, ts.ScriptKind.TS);
    const invoked = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node)
        && ts.isIdentifier(node.expression)
        && node.arguments.length >= 1
        && ts.isIdentifier(node.arguments[0]!)
        && node.arguments[0]!.text === 'stagingDir'
      ) {
        invoked.add(node.expression.text);
      }
      node.forEachChild(visit);
    };
    file.forEachChild(visit);
    expect([...invoked].sort()).toContain('assertStagedEntrypointsAreSynchronouslyLoadable');
    expect([...invoked].sort()).toContain('assertStagedManifestIsPublic');
  });

  test('the detector actually finds top-level await, so a pass is not vacuous', () => {
    const where = 'fixture.js';
    expect(topLevelAwaitLines('const x = await load();', where)).toEqual([1]);
    expect(topLevelAwaitLines('for await (const x of y) {}', where)).toEqual([1]);
    expect(topLevelAwaitLines('async function f() { await load(); }', where)).toEqual([]);
    expect(topLevelAwaitLines('const f = async () => { await load(); };', where)).toEqual([]);
    expect(() => assertNoTopLevelAwait('const x = await load();', where))
      .toThrow(/top-level await at line\(s\) 1/);
  });
});
