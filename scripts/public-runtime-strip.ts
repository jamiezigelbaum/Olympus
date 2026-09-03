/**
 * The public-runtime source transforms, in one importable place.
 *
 * `scripts/release-artifact.ts` applies these to build the shipped public
 * package, and `test/public-runtime-strip.test.ts` applies the same functions
 * to the same module list to prove the stripped result is still self-consistent.
 * The transforms live here rather than in the release script because that script
 * builds and packs the artifact the moment it is imported, so a test could never
 * reach the real implementation and would have had to copy it — and a copied
 * stripper proves nothing about the bytes that ship.
 *
 * The markers are plain line comments and the strip is textual, so a marker span
 * that swallows more than its author intended is invisible to `bun build` (it
 * does not type-check) and to every release gate. That is exactly how the v0.4
 * public package lost its OAuth2 mint path. The test is the gate for that class.
 */

/** Modules the public runtime build rewrites before bundling. */
export const PUBLIC_RUNTIME_STRIPPED_MODULES = [
  'src/core/config.ts',
  'src/core/connect.ts',
  'src/core/doctor.ts',
  'src/data-lifecycle.ts',
  'src/mcp/server.ts',
  'src/native-plugin.ts',
  'src/workers/credential-broker/index.ts',
  'src/workers/credential-health.ts',
  'src/workers/email-source/gogcli.ts',
  'src/workers/email-source/index.ts',
  'src/workers/email-source/server.ts',
] as const;

/**
 * The bundler-side filter for the same set. It is a separate expression because
 * Bun's `onLoad` takes a regular expression, so the test asserts the two agree
 * rather than letting a module join the list without joining the build.
 */
export const PUBLIC_RUNTIME_STRIPPED_MODULE_FILTER =
  /(?:email-source\/(?:index|server|gogcli)|credential-broker\/index|credential-health|core\/(?:config|connect|doctor)|data-lifecycle|native-plugin|mcp\/server)\.ts$/;

/** The one stripped module that also has its service-account handle set replaced. */
export const PUBLIC_RUNTIME_CREDENTIAL_BROKER_MODULE = 'src/workers/credential-broker/index.ts';

export const PUBLIC_RUNTIME_EXCLUDE_START = '// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_START';
export const PUBLIC_RUNTIME_EXCLUDE_END = '// OLYMPUS_PUBLIC_RUNTIME_EXCLUDE_END';

export function stripPublicRuntimeExcludedBlocks(source: string, path: string): string {
  const start = PUBLIC_RUNTIME_EXCLUDE_START;
  const end = PUBLIC_RUNTIME_EXCLUDE_END;
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
    const nestedStart = source.indexOf(start, startIndex + start.length);
    if (nestedStart !== -1 && nestedStart < matchingEnd) {
      throw new Error(`Nested public-runtime exclusion markers are not supported in ${path}.`);
    }
    output += source.slice(cursor, startIndex);
    cursor = matchingEnd + end.length;
    removed += 1;
  }
  if (removed === 0) throw new Error(`Public runtime expected explicit exclusion blocks in ${path}.`);
  return output;
}

/**
 * The spans the stripper removes, in original-source offsets, so a caller can
 * ask which declarations the public runtime loses.
 */
export function publicRuntimeExcludedSpans(source: string): Array<{ start: number; end: number }> {
  const start = PUBLIC_RUNTIME_EXCLUDE_START;
  const end = PUBLIC_RUNTIME_EXCLUDE_END;
  const spans: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  while (cursor < source.length) {
    const startIndex = source.indexOf(start, cursor);
    if (startIndex === -1) break;
    const matchingEnd = source.indexOf(end, startIndex + start.length);
    if (matchingEnd === -1) break;
    spans.push({ start: startIndex, end: matchingEnd + end.length });
    cursor = matchingEnd + end.length;
  }
  return spans;
}

export function replacePublicRuntimeCredentialHandles(source: string, path: string): string {
  const start = '// OLYMPUS_PUBLIC_RUNTIME_CREDENTIAL_HANDLES_START';
  const end = '// OLYMPUS_PUBLIC_RUNTIME_CREDENTIAL_HANDLES_END';
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`Public runtime credential-handle replacement markers are missing or malformed in ${path}.`);
  }
  if (source.indexOf(start, startIndex + start.length) !== -1 || source.indexOf(end, endIndex + end.length) !== -1) {
    throw new Error(`Public runtime credential-handle replacement markers must occur exactly once in ${path}.`);
  }
  return `${source.slice(0, startIndex)}export const SERVICE_ACCOUNT_CREDENTIAL_HANDLES: ReadonlySet<string> = new Set();\n${source.slice(endIndex + end.length)}`;
}
