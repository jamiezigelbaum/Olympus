/**
 * The extraction runtime of imported archives, for the scheduler source
 * (docs/design/child-items.md, "Reading later"): the shared factory over the
 * archive lanes' stores, so a child item listed by name while an archive was
 * imported is read afterwards, on its own, by the same code that reads every
 * other source's files.
 *
 * It is a runtime of its own beside the product's main one, built from the
 * archive runtime's lanes. The main one is constructed before the archive
 * runtime exists and with the stores that exist then; a lane is created when
 * its first archive is, and its Private store on first need. So this one is
 * built on first use and again whenever the set of lane stores changes, over
 * the same jobs file and the same extractor configuration.
 *
 * Nothing here names a source or a format: the archive corpora, source and
 * served check are extraction-source.ts, and the reading of a single item is
 * the registered format's connector.
 */

import type { FileExtractionRunner } from '../file-extraction/runner.ts';
import type { ExtractorRegistryConfig } from '../file-extraction/types.ts';
import {
  createFileExtractionRuntime,
  fileExtractionCorporaRoster,
  type FileExtractionRuntime,
} from '../email-source/file-extraction-runtime.ts';
import type { ArchiveConnectorFactory } from '../../core/archive-formats.ts';
import { archiveCorpusId } from './store.ts';
import {
  ARCHIVE_EXTRACTION_PROVIDER,
  archiveFileExtractionCorpora,
  archiveFileExtractionSourceFactory,
} from './extraction-source.ts';
import { archiveLaneStores } from './lane.ts';
import type { ArchiveImportRuntime } from './runtime.ts';

export interface ArchiveExtractionRuntimeInput {
  runtime: Pick<ArchiveImportRuntime, 'state' | 'media' | 'existingLanes'>;
  /**
   * The product's extractor configuration, the one the main runtime was built with.
   */
  extractors?: ExtractorRegistryConfig;
  env?: Record<string, string | undefined>;
  jobsDbPath?: string;
  warn?: (message: string) => void;
  /**
   * Test seam: the connector factory of a format; defaults to the registered one.
   */
  connectorFactory?: (formatId: string) => ArchiveConnectorFactory | undefined;
}

export interface ArchiveExtractionRuntime {
  /**
   * The archive lanes' runner as the stores stand now; undefined while there
   * is nothing to read from (no lane yet, or no Private store yet).
   */
  runner(): FileExtractionRunner | undefined;
  /**
   * The archive corpora this runtime serves now.
   */
  corpusIds(): readonly string[];
  close(): void;
}

export function createArchiveExtractionRuntime(input: ArchiveExtractionRuntimeInput): ArchiveExtractionRuntime {
  let built: { key: string; runtime: FileExtractionRuntime | undefined } | undefined;
  let closed = false;

  const current = (): FileExtractionRuntime | undefined => {
    if (closed) return undefined;
    const lanes = input.runtime.existingLanes();
    const openStores = lanes.map((lane) => ({ lane, stores: archiveLaneStores(lane) }));
    // A lane's Private store is the corpus's home: until it exists there is nothing to read from.
    // Every import pass makes it before listing anything (sync.ts), even when every parent is judged
    // Personal, so a lane with a child to read always has it.
    const served = openStores.filter(({ lane, stores }) => stores.some((store) => store.corpusId === archiveCorpusId('secure_local', lane.family)));
    const key = served
      .map(({ lane, stores }) => `${lane.family}:${stores.map((store) => store.corpusId).sort().join(',')}`)
      .sort()
      .join('|');
    if (built?.key === key) return built.runtime;
    const previous = built?.runtime;
    const families = served.map(({ lane }) => lane.family);
    const runtime = families.length === 0
      ? undefined
      : createFileExtractionRuntime({
          ...(input.env ? { env: input.env } : {}),
          enabled: true,
          connectorStores: served.flatMap(({ stores }) => stores),
          corpora: fileExtractionCorporaRoster({
            configured: [],
            archive: archiveFileExtractionCorpora({ state: input.runtime.state, families }),
          }),
          extraSourceFactories: new Map([[
            ARCHIVE_EXTRACTION_PROVIDER,
            archiveFileExtractionSourceFactory({
              state: input.runtime.state,
              bindings: input.runtime.media,
              ...(input.connectorFactory ? { connectorFactory: input.connectorFactory } : {}),
            }),
          ]]),
          tierSets: new Map(served.map(({ lane }) => [archiveCorpusId('secure_local', lane.family), lane.set] as const)),
          ...(input.extractors ? { extractors: input.extractors } : {}),
          ...(input.jobsDbPath ? { jobsDbPath: input.jobsDbPath } : {}),
          ...(input.warn ? { warn: input.warn } : {}),
        });
    built = { key, runtime };
    // The swap is done before the old one is put down: its jobs file is the new one's.
    try {
      previous?.close();
    } catch {
      // Closing an old connection never decides whether the new one serves.
    }
    return runtime;
  };

  return {
    runner: () => {
      try {
        return current()?.runner;
      } catch (error) {
        console.warn(`[archive-import] extraction is not available this pass: ${error instanceof Error ? error.name : 'error'}`);
        return undefined;
      }
    },
    corpusIds: () => {
      try {
        return current()?.corpusIds ?? [];
      } catch {
        return [];
      }
    },
    close() {
      closed = true;
      try {
        built?.runtime?.close();
      } catch {
        // Already down.
      }
      built = undefined;
    },
  };
}
