/**
 * Extraction for the items of imported archives: a child item (an attachment,
 * a photo, a voice note) is listed by name while the archive is imported and
 * read later, on its own, by the shared extraction factory
 * (docs/design/child-items.md, "Reading later").
 *
 * This is the archive half of the wiring and nothing more. The factory's
 * generic connector source does the reading; this module supplies what is
 * specific to archives: one corpus per family (every archive of the family
 * shares its stores, one account scope each), the connector of one archive
 * (the format's own, built for a single read over the archive's approved
 * folder), and the question the factory asks before every listing, read,
 * egress and landing: is this archive still here?
 *
 * Reading never goes around the record. An archive whose record is gone or
 * being removed is not served: its candidates are not offered, a read settles
 * as not found, and nothing lands (the factory asks again before it stores a
 * result).
 */

import { archiveCorpusId, archiveFormatConnector, getArchiveFormat, archiveImportFamilies, type ArchiveConnectorFactory } from '../../core/archive-formats.ts';
import type { SourceClassificationSignals, SourceConnector, SourceConnectorListPage } from '../../core/contracts.ts';
import { FileExtractionSourceError } from '../../core/file-extraction-source.ts';
import { ScopeRoot, ScopeSafeError } from '../../core/scope-safe-fs.ts';
import type { SourceFamily } from '../../core/source-index/types.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import type { TieredExtractionView } from '../connector-store/tiered-extraction.ts';
import { connectorStoreExtractionCandidateReader } from '../connector-store/extraction-candidate-reader.ts';
import {
  createConnectorFileExtractionSource,
  deferredBytesAnswerFor,
  type BoundedFetchConnector,
  type FileFetchConnector,
  readItemToFile,
  readItemWithin,
} from '../file-extraction/connector-source.ts';
import { discardExtractionSpoolFile } from '../file-extraction/spool.ts';
import type { FileExtractionSource } from '../file-extraction/types.ts';
import { archiveFileEntries, verifyArchiveManifest } from './manifest.ts';
import { archiveMediaAccess, type ArchiveMediaBindings } from './media-bindings.ts';
import {
  ARCHIVE_IMPORTS_SOURCE_ID,
  archiveConnectorId,
  type ArchiveImportRecord,
  type ArchiveImportStateStore,
} from './state.ts';

/**
 * The provider key of the roster's archive entries (the factory registry is
 * keyed by it). The items themselves carry their format's provider.
 */
export const ARCHIVE_EXTRACTION_PROVIDER = ARCHIVE_IMPORTS_SOURCE_ID;

/**
 * The one approved scope of an archive corpus: the person approved the
 * archive when they chose it, and the record says whether it is still served.
 */
export const ARCHIVE_EXTRACTION_SCOPE_KEY = `${ARCHIVE_IMPORTS_SOURCE_ID}:extraction`;

/**
 * Whether an archive is still served: recorded, of this family, and not being
 * removed. Read from the record each time it is asked.
 */
export function archiveServed(state: ArchiveImportStateStore, archiveId: string, family: SourceFamily): boolean {
  let record: ArchiveImportRecord | undefined;
  try {
    record = state.get(archiveId);
  } catch {
    // An unreadable record serves nothing; the next ask reads it again.
    return false;
  }
  return record !== undefined && record.family === family && record.status !== 'removing';
}

/**
 * One archive corpus of the extraction roster (the runtime's
 * `FileExtractionCorpusConfig`, which this is assignable to).
 */
export interface ArchiveExtractionCorpusConfig {
  corpusId: string;
  provider: string;
  scopes: readonly string[];
  ownerConnectorId: string;
  accountScopeCurrent: (accountScope: string) => boolean;
}

/**
 * The extraction corpus of each family archives import into: the family's
 * Private store is the corpus's home, and its tier set (the runtime's
 * `tierSets`) lists the family's other stores for it. Removal forgets the
 * extraction rows of all three of the family's corpora.
 */
export function archiveFileExtractionCorpora(input: {
  state: ArchiveImportStateStore;
  families?: readonly SourceFamily[];
}): ArchiveExtractionCorpusConfig[] {
  return (input.families ?? archiveImportFamilies()).map((family) => ({
    corpusId: archiveCorpusId('secure_local', family),
    provider: ARCHIVE_EXTRACTION_PROVIDER,
    scopes: [ARCHIVE_EXTRACTION_SCOPE_KEY],
    ownerConnectorId: ARCHIVE_IMPORTS_SOURCE_ID,
    accountScopeCurrent: (accountScope) => archiveServed(input.state, accountScope, family),
  }));
}

/**
 * The source factory for archive corpora, for the runtime's
 * `extraSourceFactories` under `ARCHIVE_EXTRACTION_PROVIDER`.
 */
export function archiveFileExtractionSourceFactory(input: {
  state: ArchiveImportStateStore;
  /**
   * The archives' media bindings: how a connector reaches the media files its
   * children name.
   */
  bindings?: ArchiveMediaBindings;
  /**
   * Test seam: the connector factory of a format; defaults to the registered one.
   */
  connectorFactory?: (formatId: string) => ArchiveConnectorFactory | undefined;
}): (build: { config: Pick<ArchiveExtractionCorpusConfig, 'corpusId' | 'provider'>; store: LocalConnectorStore; view?: TieredExtractionView }) => FileExtractionSource {
  return ({ config, store, view }) => {
    const family = archiveImportFamilies().find((candidate) => archiveCorpusId('secure_local', candidate) === config.corpusId);
    if (!family) throw new Error('[file-extraction] an archive corpus names a family no archive format imports into.');
    const reader = view ?? store;
    return createConnectorFileExtractionSource({
      id: `${config.corpusId}:extraction`,
      corpusId: config.corpusId,
      provider: config.provider,
      connector: (accountScope) => archiveAccountConnector({
        state: input.state,
        archiveId: accountScope,
        family,
        ...(input.bindings ? { bindings: input.bindings } : {}),
        ...(input.connectorFactory ? { connectorFactory: input.connectorFactory } : {}),
      }),
      deferredBytes: (ref) => deferredBytesAnswerFor(reader.deferredBytesStateOfLocalItem(ref.localItemId, ref.sourceVersion)),
      candidates: connectorStoreExtractionCandidateReader(reader),
      lanes: [{ approvedScopeKey: ARCHIVE_EXTRACTION_SCOPE_KEY }],
    });
  };
}

/**
 * A media file that is not the version bound (replaced, changed, missing, or a
 * binding that is not there) is a version that is gone; one that cannot be
 * read now is retried. Anything else is the connector's own to report.
 */
function settleMediaError(error: unknown): unknown {
  if (!(error instanceof ScopeSafeError)) return error;
  switch (error.code) {
    case 'not_found':
    case 'changed':
    case 'escape':
    case 'not_regular':
      return new FileExtractionSourceError('source_version_gone');
    case 'too_large':
      return new FileExtractionSourceError('source_too_large');
    case 'permission':
      return new FileExtractionSourceError('source_permission_denied');
    default:
      return new FileExtractionSourceError('source_unavailable');
  }
}

/**
 * The connector of one archive, for reading single items: the format's own
 * connector, built over the archive's approved folder for each read and
 * closed after it. `undefined` when the archive is not served (the record is
 * gone or being removed). Nothing is listed through it.
 *
 * Before every read the folder is the one approved and each file of the
 * archive is the version imported; a replaced file settles the read as a
 * version that is gone, a folder that cannot be opened as a failure to retry.
 */
export function archiveAccountConnector(input: {
  state: ArchiveImportStateStore;
  archiveId: string;
  family: SourceFamily;
  bindings?: ArchiveMediaBindings;
  connectorFactory?: (formatId: string) => ArchiveConnectorFactory | undefined;
}): SourceConnector | undefined {
  if (!archiveServed(input.state, input.archiveId, input.family)) return undefined;
  const record = input.state.get(input.archiveId);
  if (!record) return undefined;
  const format = getArchiveFormat(record.format);
  const factory = (input.connectorFactory ?? archiveFormatConnector)(record.format);
  if (!format || !factory || format.family !== record.family || format.provider !== record.provider) {
    throw new FileExtractionSourceError('source_content_unavailable');
  }

  const using = async <T>(run: (connector: SourceConnector) => Promise<T>): Promise<T> => {
    // Asked again here: the read may have waited behind a removal.
    if (!archiveServed(input.state, input.archiveId, input.family)) throw new FileExtractionSourceError('source_item_not_found');
    let root: ScopeRoot;
    try {
      root = ScopeRoot.open(record.root_path);
    } catch (error) {
      throw new FileExtractionSourceError(
        error instanceof ScopeSafeError && error.code === 'not_found' ? 'source_content_unavailable' : 'source_unavailable',
      );
    }
    try {
      if (root.identity.dev !== record.root_identity.dev || root.identity.ino !== record.root_identity.ino) {
        throw new FileExtractionSourceError('source_version_gone');
      }
      const check = verifyArchiveManifest(root, record.files, { memberTables: false });
      if (!check.ok) {
        throw new FileExtractionSourceError(check.code === 'file_unreadable' ? 'source_unavailable' : 'source_version_gone');
      }
      const connector = factory({
        archiveId: record.archive_id,
        connectorId: archiveConnectorId(record.archive_id),
        accountScope: record.archive_id,
        format,
        root,
        files: archiveFileEntries(record.files),
        manifestSha256: record.manifest_sha256,
        report: () => {},
        shouldContinue: () => archiveServed(input.state, input.archiveId, input.family),
        ...(input.bindings
          ? { media: archiveMediaAccess({ bindings: input.bindings, archiveId: record.archive_id, root, chosenRelPath: record.chosen_rel_path }) }
          : {}),
      });
      try {
        return await run(connector);
      } catch (error) {
        throw settleMediaError(error);
      }
    } finally {
      root.close();
    }
  };

  const connector: BoundedFetchConnector & FileFetchConnector = {
    id: archiveConnectorId(record.archive_id),
    family: record.family,
    async authenticate(): Promise<void> {},
    // Extraction never lists an archive: the import did, once.
    async *listItems(): AsyncIterable<SourceConnectorListPage> {},
    fetchItem: (localItemId, options) => using((inner) => inner.fetchItem(localItemId, options)),
    fetchItemWithin: (localItemId, options) => using((inner) => readItemWithin(inner, localItemId, options)),
    // The scratch file is made only while the archive is served, and is taken back if a removal
    // lands while the bytes are being fetched: a removal marks the record first and forgets the
    // archive's scratch files after, so a file written after the mark is seen here and removed.
    // The format's own connector may write the file itself, so the answer is asked again once
    // the file is written, whoever wrote it.
    fetchItemToFile: async (localItemId, options) => {
      const served = (): boolean => archiveServed(input.state, input.archiveId, input.family);
      const handed = await using((inner) => readItemToFile(inner, localItemId, { ...options, stillServed: served }));
      if (!served()) {
        if (handed.spooled) discardExtractionSpoolFile(handed.path, options.spoolDir);
        throw new FileExtractionSourceError('source_item_not_found');
      }
      return handed;
    },
    classificationSignals: (): SourceClassificationSignals => ({}),
  };
  return connector;
}
