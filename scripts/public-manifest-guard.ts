/**
 * The public release must ship a parseable plugin manifest.
 *
 * `openclaw.plugin.json` is copied into the release staging directory verbatim,
 * and it is the file OpenClaw validates configuration against. A staged
 * manifest that is missing, truncated, or not a JSON object produces a package
 * that refuses to load for every user who installs it, and the failure surfaces
 * on their machine rather than in the build.
 *
 * The owner-identifier scan cannot see this: the fault names no person, host,
 * or private operation. It is a structural mistake, so it gets a structural
 * check, in its own module so both the release builder and its test run the
 * same one.
 *
 * Until 2026-09-18 this also refused a manifest carrying
 * `olympus.privateExtensions`, the marker of the private overlay variant. The
 * overlay seam was deleted that day, so no tree can produce that manifest any
 * more and the branch went with it.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PUBLIC_MANIFEST_BASENAME = 'openclaw.plugin.json';

/** Throws when the staged manifest is not a readable JSON object. */
export function assertStagedManifestIsPublic(
  baseDir: string,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): void {
  const path = join(baseDir, PUBLIC_MANIFEST_BASENAME);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFile(path));
  } catch (error) {
    throw new Error(
      `Staged ${PUBLIC_MANIFEST_BASENAME} could not be parsed: `
      + `${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error(`Staged ${PUBLIC_MANIFEST_BASENAME} is not a JSON object.`);
  }
}
