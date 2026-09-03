/**
 * The public release must never ship a private plugin manifest.
 *
 * `openclaw.plugin.json` is copied into the release staging directory verbatim,
 * and it is the file OpenClaw validates configuration against. A private
 * variant additionally carries `olympus.privateExtensions`, which declares that
 * the install REQUIRES an overlay module the public package does not contain —
 * so a public artifact built from a tree where that manifest had been swapped
 * in would refuse to load for every user who installed it, and would have
 * accepted private configuration keys on the way there.
 *
 * The owner-identifier scan cannot see this: the marker names no person, host,
 * or private operation. It is a structural mistake, so it gets a structural
 * check, in its own module so both the release builder and its test run the
 * same one.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PUBLIC_MANIFEST_BASENAME = 'openclaw.plugin.json';
const PRIVATE_EXTENSION_NAMESPACE = 'olympus';
const PRIVATE_EXTENSION_KEY = 'privateExtensions';

/** Throws when the staged manifest carries a private-extension requirement. */
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
  const namespace = (manifest as Record<string, unknown>)[PRIVATE_EXTENSION_NAMESPACE];
  if (namespace === undefined) return;
  // Present in ANY form is a mistake here: the public package has no overlay to
  // satisfy a requirement with, whatever shape the declaration takes.
  if (
    namespace === null
    || typeof namespace !== 'object'
    || Array.isArray(namespace)
    || Object.hasOwn(namespace as Record<string, unknown>, PRIVATE_EXTENSION_KEY)
  ) {
    throw new Error(
      `Staged ${PUBLIC_MANIFEST_BASENAME} carries `
      + `${PRIVATE_EXTENSION_NAMESPACE}.${PRIVATE_EXTENSION_KEY}. That is the private overlay `
      + 'manifest: the public package contains no overlay module, so every install built from it '
      + 'would refuse to load. Build the release from the public manifest.',
    );
  }
}
