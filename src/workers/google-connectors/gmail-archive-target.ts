/**
 * An mbox export of a Gmail account is an input of the Gmail connector
 * (docs/design/archive-live-one-dataset.md, sections 1, 4 and 7; step 6).
 *
 * What the Gmail source registers with the archive layer
 * (archive-import/source-targets.ts):
 *
 * - which account an export belongs to: Gmail's markers and one delivered-to
 *   address (archive-import/mbox/gmail-account.ts), hashed into the opaque
 *   address label the account binding uses. An address proves no account by
 *   itself, so joining a connected account always asks the owner; with no
 *   account yet, the import makes it, and a later connect of that address
 *   joins it. Any other mbox stays under Archives, as before;
 * - the export as an input: its messages as the connector's own record
 *   (archive-import/mbox/gmail-input.ts);
 * - the account's lane: the Gmail stores and ledger, the live lane's sync
 *   options, and the connector's record builder, so an imported message is
 *   built exactly as a live one is (gmail-mail-record.ts);
 * - the source's exclusive runner, held while an import resolves the account
 *   and writes into it, so the account guard cannot bind another account in
 *   between.
 */
import type { SourceConnector, SourceConnectorInput } from '../../core/contracts.ts';
import type { ArchiveConnectorInput } from '../../core/archive-formats.ts';
import { googleAccountIdFromAddress } from '../../core/provider-account-identity.ts';
import { inputConnector, type IntakeObservingInput, type SourceRecordBuilder } from '../../core/source-inputs.ts';
import type { ConnectorStoreEmbeddingTarget, ConnectorStoreSyncOptions, LocalConnectorStore } from '../connector-store/index.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import type { TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import { archiveFileEntries } from '../archive-import/manifest.ts';
import { identifyGmailExport } from '../archive-import/mbox/gmail-account.ts';
import { mboxGmailInput, type GmailLabelLookup, type MboxGmailMatch } from '../archive-import/mbox/gmail-input.ts';
import type { ArchiveAccountEvidence, ArchiveSourceLane, ArchiveSourceTarget, ArchiveToIdentify } from '../archive-import/source-targets.ts';
import {
  compareGmailMailVersions,
  gmailClassificationSignals,
  gmailMailEntries,
  gmailMailItems,
  type GmailMailBuild,
  type GmailMailRecord,
} from './gmail-mail-record.ts';

export const GMAIL_ARCHIVE_SOURCE_ID = 'gmail.email';
export const GMAIL_ARCHIVE_LABEL = 'Gmail';
const GMAIL_PROVIDER_ID = 'gmail';
/**
 * Every import's input writes under its own connector id, `archive.<archive id>`
 * (archive-import/state.ts): what the Gmail scope's observation filters accept
 * beside the live lane's own scoped id.
 */
export const GMAIL_IMPORT_CONNECTOR_PREFIX = 'archive.';

/**
 * The account scope Gmail's items are kept under: the connected handle's role
 * (`roleScope`), unless the stores already hold Gmail rows under exactly one
 * other scope. An import made before the account was connected keeps the
 * scope it was given (`personal`), and a later connect under another role
 * reuses it, so both inputs keep naming one item, never `work:<id>` beside
 * `personal:<id>`.
 */
export function gmailItemAccountScope(stores: readonly Pick<LocalConnectorStore, 'itemAccountScopes'>[], roleScope: string): string {
  const held = new Set(stores.flatMap((store) => store.itemAccountScopes(GMAIL_PROVIDER_ID, 3)));
  if (held.size !== 1 || held.has(roleScope)) return roleScope;
  return [...held][0]!;
}

/** What an import brought into the Gmail stores: rows an import's input observed. */
export const GMAIL_IMPORTED_FILTERS = Object.freeze({ provider: GMAIL_PROVIDER_ID, observedConnectorIdPrefix: GMAIL_IMPORT_CONNECTOR_PREFIX });

/** Whether any of these Gmail stores holds mail an import brought in (kept live mail does not count). */
export function gmailHoldsImportedHistory(stores: ReadonlyArray<Pick<LocalConnectorStore, 'holdsItemsMatching'> | undefined>): boolean {
  return stores.some((store) => store?.holdsItemsMatching(GMAIL_IMPORTED_FILTERS) === true);
}

/**
 * The embedding sweep of Gmail's stores with no live lane: only what the
 * imports brought, store-wide on each store's current provider, and never a
 * queue a live sync left under an approval that may no longer stand.
 */
export function gmailImportedHistoryEmbeddingTargets(input: {
  stores: readonly LocalConnectorStore[];
  providerFor: (store: LocalConnectorStore) => SourceEmbeddingProvider | undefined;
  accountScope: string;
}): ConnectorStoreEmbeddingTarget[] {
  return input.stores.flatMap((store) => {
    const provider = input.providerFor(store);
    return provider
      ? [{ store, provider, wholeStore: true, missingOnly: true, accountScope: input.accountScope, filters: GMAIL_IMPORTED_FILTERS }]
      : [];
  });
}

/**
 * The live Gmail lane's sweep targets, with the imports' recovery beside them:
 * the live lane drains its own queue (under its scope binding), and what the
 * imports brought is recovered store-wide whatever the live approval state,
 * so a backlog a restart left (the queue is in memory) never waits on the
 * fallback source. The imports' targets touch only archive-observed rows with
 * a vector missing, so live rows are never embedded twice.
 */
export function gmailLaneEmbeddingTargets(input: {
  live: readonly ConnectorStoreEmbeddingTarget[];
  stores: readonly LocalConnectorStore[];
  providerFor: (store: LocalConnectorStore) => SourceEmbeddingProvider | undefined;
  accountScope: string;
}): ConnectorStoreEmbeddingTarget[] {
  return [...input.live, ...gmailImportedHistoryEmbeddingTargets(input)];
}

/** The Gmail connector's one way from a record to items, for any input of the account `account`. */
export function gmailRecordBuilder(account: string, build: GmailMailBuild = {}): SourceRecordBuilder<GmailMailRecord> {
  return {
    family: 'email',
    entriesOf: (record) => gmailMailEntries(record, account, build),
    compareVersions: compareGmailMailVersions,
    build: (record, wanted) => gmailMailItems(record, account, build, wanted),
    fetchItem: () => Promise.reject(new Error('An imported message is read only while its archive is listed.')),
    classificationSignals: gmailClassificationSignals,
  };
}

/** Which account an mbox belongs to, as the archive layer asks it. */
export function gmailExportEvidence(archive: ArchiveToIdentify): ArchiveAccountEvidence {
  const found = identifyGmailExport(archive.root, archiveFileEntries(archive.files));
  return found.kind === 'gmail'
    ? { kind: 'account', importAccountId: googleAccountIdFromAddress(found.address) }
    : { kind: 'archives' };
}

/** The Gmail account's lane, as the runtime has it: nothing of it is the archive layer's. */
export interface GmailArchiveLane {
  set: TieredStoreSet;
  /** The live lane's own sync options. */
  sync: ConnectorStoreSyncOptions;
  /** The account scope live Gmail writes under (`personal` unless the handle names another). */
  account: string;
  build?: GmailMailBuild;
  /** Finds stored mail by its headers, for messages without Takeout's id (section 4). */
  match?: MboxGmailMatch;
  /**
   * The account's labels, lower-cased name to id, or why they cannot be read
   * now. Asked only when an owner rule names a label.
   */
  labelIds?: () => Promise<ReadonlyMap<string, string> | { unavailable: string; minimum?: number }>;
}

/**
 * How an import resolves Takeout's label names: by the account's label list.
 * When an owner rule names a label and the list cannot be read, the import
 * waits (`unavailable`) rather than store mail the rule could miss.
 */
export async function gmailLabelLookup(lane: Pick<GmailArchiveLane, 'set' | 'labelIds'>): Promise<GmailLabelLookup> {
  const rules = lane.set.classification()?.rules ?? [];
  // No rule names a label: names are enough, and nothing is asked of Gmail.
  if (!rules.some((rule) => rule.match.kind === 'label')) return { kind: 'none' };
  let found: ReadonlyMap<string, string> | { unavailable: string; minimum?: number } | undefined;
  try {
    found = await lane.labelIds?.();
  } catch {
    found = undefined;
  }
  if (found instanceof Map) return { kind: 'map', byName: found };
  if (found && 'unavailable' in found) {
    return { kind: 'unavailable', reason: found.unavailable, ...(found.minimum !== undefined ? { minimum: found.minimum } : {}) };
  }
  return { kind: 'unavailable', reason: 'gmail_labels_unavailable' };
}

export interface GmailArchiveTargetOptions {
  /** The Gmail lane, built when an import needs it. */
  lane(): GmailArchiveLane;
  /** The source's exclusive runner (source-account-guard.ts `runExclusiveForSource`). */
  exclusive<T>(task: () => Promise<T>): Promise<T>;
  /** The scheduler key Gmail's own pulls run under. */
  concurrencyKey: string;
}

export function gmailArchiveTarget(options: GmailArchiveTargetOptions): ArchiveSourceTarget {
  // The lane an import pass reads and writes: built at the pass's account resolution, used for its input too.
  let current: GmailArchiveLane | undefined;
  const laneNow = (): GmailArchiveLane => {
    current = options.lane();
    return current;
  };
  return {
    sourceId: GMAIL_ARCHIVE_SOURCE_ID,
    label: GMAIL_ARCHIVE_LABEL,
    formats: ['mbox'],
    concurrencyKey: options.concurrencyKey,
    identify: gmailExportEvidence,
    input(archive: ArchiveConnectorInput): SourceConnectorInput {
      const lane = current ?? laneNow();
      return mboxGmailInput(archive, {
        ...(lane.build ? { build: lane.build } : {}),
        ...(lane.match ? { match: lane.match } : {}),
        labels: () => gmailLabelLookup(lane),
      });
    },
    lane(): ArchiveSourceLane {
      const lane = laneNow();
      const builder = gmailRecordBuilder(lane.account, lane.build);
      // Only the input half of the connector is used here: the live reader lists through its own lane.
      const connector: SourceConnector = {
        id: GMAIL_PROVIDER_ID,
        family: 'email',
        authenticate: () => Promise.resolve(),
        listItems: () => { throw new Error('Gmail lists live mail through its own lane.'); },
        fetchItem: (localItemId, fetchOptions) => builder.fetchItem(localItemId, fetchOptions),
        classificationSignals: (item) => builder.classificationSignals(item),
        forInput: (input) => inputConnector(builder, input as IntakeObservingInput<GmailMailRecord>),
      };
      return { set: lane.set, sync: lane.sync, connector };
    },
    exclusive: (task) => options.exclusive(task),
  };
}
