import { resolvedStorePath } from '../../../core/source-placement.ts';
import { existsSync } from 'node:fs';
import {
  GOOGLE_DRIVE_SOURCE_ID,
  GOOGLE_DRIVE_ENFORCEABLE_EXCLUSION_CRITERIA,
  GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE,
  GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
  GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
  googleDriveIngestionExclusionMatcher,
} from '../../google-connectors/index.ts';
import {
  DROPBOX_ENFORCEABLE_EXCLUSION_CRITERIA,
  DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
  DROPBOX_INGESTION_EXCLUSION_SOURCE,
  DROPBOX_FILES_SOURCE_ID,
  dropboxIngestionExclusionMatcher,
} from '../../dropbox-files/index.ts';
import {
  LOCAL_FILES_SOURCE_ID,
} from '../../local-files/scope.ts';
import {
  LOCAL_FILES_CORPUS_ID,
  LOCAL_FILES_INGESTION_EXCLUSION_SOURCE,
  LOCAL_FILES_ENFORCEABLE_EXCLUSION_CRITERIA,
  localFilesIngestionExclusionMatcher,
} from '../../local-files/store.ts';
import {
  createSourceExclusionMatcherFromPrefixes,
  type SourceExclusionCriterionKind,
  type SourceExclusionMatcher,
} from '../../../core/source-ingestion-exclusions.ts';
import type { SourceDispositionsSource } from '../../source-dispositions.ts';
import type { SourceDispositionItem } from '../../../core/source-disposition-tree.ts';
import {
  type LocalConnectorStore,
} from '../../connector-store/index.ts';
import {
  openConnectorStore,
  type StorageAccount,
} from '../../../core/source-storage.ts';
import {
  type SourceTrustDomain,
} from '../../../core/source-index/types.ts';

// Selects the Dropbox VLM transport. `openai` (default) keeps the historical
// OpenAI-compatible `/v1/chat/completions` path so non-Ollama installs are
// unchanged; `ollama` uses the native `/api/chat` client (native `images`
// field, base URL `/v1`-normalized) which is the maintained path on the
// inference appliance.

/**
 * The file-storage sources the folder-disposition picker offers, and the ONLY
 * place in that feature that names a provider.
 *
 * This is the bootstrap adapter's job by the architecture rule: the picker, the
 * tree engine and the gate are all source-neutral, and each source arrives here
 * carrying its own exclusion key, its own declared enforceable criteria, and
 * its own stores. A new file source becomes editable in the picker by adding a
 * row here — no change to the engine, the page, or the routes.
 *
 * A source may span several stores. Drive is two trust bands over one corpus
 * family, and folding both into one tree is what makes the counts on the page
 * equal what the purge would report.
 */
const INGESTION_DISPOSITION_SOURCES: ReadonlyArray<{
  sourceId: string;
  /** The source whose stores these are (`sourceId` is its exclusion key). */
  account: StorageAccount;
  label: string;
  enforceable: readonly SourceExclusionCriterionKind[];
  matcher: (env: Record<string, string | undefined>) => SourceExclusionMatcher;
  stores: (env: Record<string, string | undefined>) => Array<{
    dbPath: string;
    corpusId: string;
    trustDomain: SourceTrustDomain;
  }>;
}> = [
  {
    sourceId: DROPBOX_INGESTION_EXCLUSION_SOURCE,
    account: { sourceId: DROPBOX_FILES_SOURCE_ID },
    label: 'Dropbox',
    enforceable: DROPBOX_ENFORCEABLE_EXCLUSION_CRITERIA,
    matcher: (env) => dropboxIngestionExclusionMatcher(env),
    stores: (env) => [{
      dbPath: resolvedStorePath(DROPBOX_FILES_SOURCE_ID, 'secure_local', env),
      corpusId: DROPBOX_FILES_CONNECTOR_STORE_CORPUS_ID,
      trustDomain: 'secure_local',
    }],
  },
  {
    sourceId: LOCAL_FILES_INGESTION_EXCLUSION_SOURCE,
    account: { sourceId: LOCAL_FILES_SOURCE_ID },
    label: 'Files on this computer',
    enforceable: LOCAL_FILES_ENFORCEABLE_EXCLUSION_CRITERIA,
    matcher: (env) => localFilesIngestionExclusionMatcher(env),
    stores: (env) => [{
      dbPath: resolvedStorePath(LOCAL_FILES_SOURCE_ID, 'secure_local', env),
      corpusId: LOCAL_FILES_CORPUS_ID,
      trustDomain: 'secure_local',
    }],
  },
  {
    sourceId: GOOGLE_DRIVE_INGESTION_EXCLUSION_SOURCE,
    account: { sourceId: GOOGLE_DRIVE_SOURCE_ID },
    label: 'Google Drive',
    enforceable: GOOGLE_DRIVE_ENFORCEABLE_EXCLUSION_CRITERIA,
    matcher: (env) => googleDriveIngestionExclusionMatcher(env),
    stores: (env) => [
      {
        dbPath: resolvedStorePath(GOOGLE_DRIVE_SOURCE_ID, 'internal', env),
        corpusId: GOOGLE_DRIVE_INTERNAL_CONNECTOR_CORPUS_ID,
        trustDomain: 'internal',
      },
      {
        dbPath: resolvedStorePath(GOOGLE_DRIVE_SOURCE_ID, 'secure_local', env),
        corpusId: GOOGLE_DRIVE_SECURE_CONNECTOR_CORPUS_ID,
        trustDomain: 'secure_local',
      },
    ],
  },
];

/**
 * Open the picker's inputs for one request, read-only, and hand back the way to
 * close them.
 *
 * Read-only opens throughout: this page must never be able to create a store
 * file as a side effect of being looked at, and it must never hold a writer's
 * lock. A store whose file does not exist is reported as absent rather than
 * created, exactly as the purge script does.
 *
 * A source whose gate REFUSES to compile is carried as an error rather than
 * thrown. That refusal means the owner has a rule naming a source that cannot
 * enforce it, and this page is the tool they would use to fix it.
 */
type StoredExclusionDebt = ReturnType<LocalConnectorStore['exclusionDebtPresent']>;

/**
 * Both debts across a source's stores, walked once however many of the two
 * numbers the caller ends up reading.
 *
 * The runtime hands the page two separate accessors, and the page calls both;
 * without the memo that is two full walks of every store per render, for one
 * decision per row that already answers both. The memo is scoped to a runtime
 * that is opened and closed inside a single request, so it can never serve a
 * count from an earlier render.
 */
function storedExclusionDebtReader(handles: readonly LocalConnectorStore[]): () => StoredExclusionDebt {
  let walked: StoredExclusionDebt | undefined;
  return () => {
    if (walked) return walked;
    const total: StoredExclusionDebt = {
      excluded: { items: 0, unevaluable: 0 },
      metadataOnlyContent: { items: 0, unevaluable: 0 },
    };
    for (const handle of handles) {
      const debt = handle.exclusionDebtPresent();
      total.excluded.items += debt.excluded.items;
      total.excluded.unevaluable += debt.excluded.unevaluable;
      total.metadataOnlyContent.items += debt.metadataOnlyContent.items;
      total.metadataOnlyContent.unevaluable += debt.metadataOnlyContent.unevaluable;
    }
    walked = total;
    return total;
  };
}

export function openIngestionDispositionsRuntime(
  env: Record<string, string | undefined> = process.env,
  options: {
    /**
     * Open each store only when its items or debt are first read. The
     * dashboard reads the debt once per reuse window, yet opened (and
     * schema-checked) every store on every poll: the longest freeze in
     * Sparta's 2007d67 window, 9.7 s (2026-11-05). A store that then fails
     * to open throws from the accessor instead of being carried as an error.
     */
    lazyStores?: boolean;
  } = {},
): { sources: SourceDispositionsSource[]; close: () => void } {
  const opened: LocalConnectorStore[] = [];
  const sources: SourceDispositionsSource[] = [];
  for (const definition of INGESTION_DISPOSITION_SOURCES) {
    let stores: ReturnType<typeof definition.stores> = [];
    const handles: LocalConnectorStore[] = [];
    const readDebt = storedExclusionDebtReader(handles);
    try {
      stores = definition.stores(env);
      const matcher = definition.matcher(env);
      const present = stores.filter((store) => existsSync(store.dbPath));
      let openedAll = false;
      const openStores = (): readonly LocalConnectorStore[] => {
        if (openedAll) return handles;
        for (const store of present) {
          const handle = openConnectorStore(definition.account, {
            dbPath: store.dbPath,
            corpusId: store.corpusId,
            family: 'file',
            trustDomain: store.trustDomain,
            exclusions: matcher,
            readOnly: true,
          }, env);
          handles.push(handle);
          opened.push(handle);
        }
        openedAll = true;
        return handles;
      };
      if (options.lazyStores !== true) openStores();
      sources.push({
        source_id: definition.sourceId,
        label: definition.label,
        corpus_ids: stores.map((store) => store.corpusId),
        enforceable: definition.enforceable,
        matcher,
        store_present: present.length > 0,
        ...(present.length > 0
          ? {
            items: function* (): Generator<SourceDispositionItem> {
              for (const handle of openStores()) yield* handle.itemLocatorCensus();
            },
            excludedItemsPresent: () => {
              openStores();
              return readDebt().excluded;
            },
            metadataOnlyContentPresent: () => {
              openStores();
              return readDebt().metadataOnlyContent;
            },
          }
          : {}),
      });
    } catch (error) {
      // A store that refuses to open is carried as data like a gate that
      // refuses to compile — but the handles this source already opened would
      // otherwise be orphaned, because the caller's `finally` only ever sees a
      // runtime this function returned.
      for (const handle of handles) {
        const index = opened.indexOf(handle);
        if (index >= 0) opened.splice(index, 1);
        try {
          handle.close();
        } catch {
          // Closing a handle we are already discarding cannot change the entry.
        }
      }
      sources.push({
        source_id: definition.sourceId,
        label: definition.label,
        corpus_ids: stores.map((store) => store.corpusId),
        enforceable: definition.enforceable,
        matcher: createSourceExclusionMatcherFromPrefixes([]),
        store_present: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    sources,
    close: () => {
      for (const handle of opened.reverse()) {
        try {
          handle.close();
        } catch {
          // A close failure must not mask the response that already rendered.
        }
      }
    },
  };
}
