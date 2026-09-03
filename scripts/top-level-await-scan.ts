/**
 * Top-level `await` detection for built JavaScript bundles.
 *
 * OpenClaw's plugin loader is synchronous end to end: it `require()`s the
 * plugin entry and, when that throws, falls back to a jiti source transform.
 * Neither leg can represent top-level await, so an async entry graph fails both
 * — `ERR_REQUIRE_ASYNC_MODULE`, then "await is only valid in async functions" —
 * and the plugin never reaches `register`.
 *
 * This lives in `scripts/` rather than inside the test because two different
 * artifacts have to be checked with the same rule: the committed `dist/` bundle
 * and the re-minified entrypoints the release builder stages. A copy in each
 * place would let them drift, and the one that matters for an install is the
 * one that ships.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/** Line numbers (1-based) of `await` / `for await` outside any function body. */
export function topLevelAwaitLines(source: string, path: string): number[] {
  // `setParentNodes: false` on purpose: these bundles are megabytes, and
  // building the parent chain dominates the walk.
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, false, ts.ScriptKind.JS);
  const lines: number[] = [];

  const isFunctionLike = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
    || ts.isClassStaticBlockDeclaration(node);

  const visit = (node: ts.Node, insideFunction: boolean): void => {
    if (!insideFunction) {
      if (ts.isAwaitExpression(node) || (ts.isForOfStatement(node) && node.awaitModifier)) {
        lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
      }
    }
    node.forEachChild((child) => visit(child, insideFunction || isFunctionLike(node)));
  };

  file.forEachChild((child) => visit(child, false));
  return lines;
}

/** Throws when a bundle carries top-level await, naming where. */
export function assertNoTopLevelAwait(source: string, path: string): void {
  const lines = topLevelAwaitLines(source, path);
  if (lines.length === 0) return;
  throw new Error(
    `${path} contains top-level await at line(s) ${lines.join(', ')}. OpenClaw's plugin loader is `
    + 'synchronous (native require, then a jiti source transform), and neither leg can load an '
    + 'async module graph, so this bundle would fail to load in every install.',
  );
}

/**
 * The staged release entrypoints must still be loadable by a synchronous host.
 *
 * These are not the bytes the committed-bundle test checks: the release
 * re-bundles from stripped sources and re-minifies with Terser, so a transform
 * could in principle hoist an `await` the committed bundle does not have.
 * OpenClaw `require()`s the entry and falls back to a jiti source transform,
 * and neither leg can load an async module graph, so this is the last point at
 * which that is cheap to catch.
 */
/**
 * Only the plugin entry, because only it is loaded synchronously.
 * `package.json` points OpenClaw's `extensions` and `runtimeExtensions` at
 * `dist/index.js` alone; `dist/cli.js` is executed directly by Bun through
 * `bin/olympus`, where top-level await is legal and harmless. Asserting it
 * there would be a property that does not matter, and the scoped set is pinned
 * against `package.json` by the test so this cannot drift if that changes.
 */
export const STAGED_SYNCHRONOUS_ENTRYPOINTS = ['dist/index.js'] as const;

export function assertStagedEntrypointsAreSynchronouslyLoadable(
  baseDir: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): void {
  for (const entry of STAGED_SYNCHRONOUS_ENTRYPOINTS) {
    const path = join(baseDir, entry);
    assertNoTopLevelAwait(readFile(path), path);
  }
}
