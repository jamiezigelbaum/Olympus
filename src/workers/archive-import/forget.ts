/**
 * What deleting a whole source forgets of the imports that were inputs of it
 * (docs/design/archive-live-one-dataset.md, section 6).
 *
 * An import that joined a source wrote the source's own stores, and its resume
 * point lives in that account's set ledger: deleting the source deletes both.
 * What stays outside the account is the import's record (it sits with the
 * Archives record) and the media files it bound: this removes them, so a
 * source connected again starts with no import still going into it.
 */
import { existsSync } from 'node:fs';
import { archiveContinuations } from './continuation-cache.ts';
import { archiveMediaBindingsPath, createArchiveMediaBindings } from './media-bindings.ts';
import { ArchiveImportStateStore, defaultArchiveImportStatePath } from './state.ts';

/**
 * Forgets the imports that are inputs of the named sources, and their media
 * bindings. Returns how many records went (on a dry run, would go). A record
 * that cannot be read is left alone, as the registry's other JSON steps do.
 */
export function forgetSourceArchiveImports(
  env: Record<string, string | undefined>,
  sourceIds: readonly string[],
  options: { dryRun?: boolean } = {},
): number {
  const path = defaultArchiveImportStatePath(env);
  if (!existsSync(path)) return 0;
  const state = new ArchiveImportStateStore({ path, env });
  let doomed: string[];
  try {
    doomed = state.list()
      .filter((record) => record.target !== undefined && sourceIds.includes(record.target.source_id))
      .map((record) => record.archive_id);
  } catch {
    return 0;
  }
  if (doomed.length === 0 || options.dryRun === true) return doomed.length;
  const bindings = createArchiveMediaBindings({ path: archiveMediaBindingsPath(path), env });
  try {
    let removed = 0;
    for (const archiveId of doomed) {
      archiveContinuations.dropArchive(archiveId);
      bindings.forgetArchive(archiveId);
      if (state.delete(archiveId)) removed += 1;
    }
    return removed;
  } finally {
    bindings.close();
  }
}
