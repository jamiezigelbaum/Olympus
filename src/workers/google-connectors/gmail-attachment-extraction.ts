/**
 * Reading Gmail's attachment children (docs/design/child-items.md, "Reading
 * later"; archive-live-one-dataset.md, step 6): one extraction roster entry
 * over the Gmail stores, whose one reader takes a child's bytes from wherever
 * its locator says they are, whichever input listed it:
 *
 * - `gmail-part1:<message>:<part>`: live Gmail, through the Gmail lane's
 *   connector (the message once, then the part inline or by its attachment
 *   id), only while live Gmail is connected and its mail approval current;
 * - `mbox-part1:<import>:<file>:<offset>:<digest>:<message>:<part>`: an imported mbox, from the
 *   import's own approved files (archive-import/mbox/part-reader.ts).
 *
 * A readable attachment brings its text through the shared extraction runner,
 * held, judged and stored like any other file, each child on its own; one
 * over the readers' byte limits keeps its names and is listed as a file Olympus
 * could not read. Only children are candidates: a message is read with its
 * listing, never here.
 */
import { CHILD_ITEM_ID_SEPARATOR } from '../../core/child-item-id.ts';
import type { RawItem, SourceConnector, SourceConnectorFetchOptions, SourceConnectorListPage } from '../../core/contracts.ts';
import { FileExtractionSourceError, type ExtractionCandidateReader } from '../../core/file-extraction-source.ts';
import { parseMboxMessage } from '../archive-import/mbox/parse.ts';
import { readMboxPart } from '../archive-import/mbox/part-reader.ts';
import type { ArchiveImportStateStore } from '../archive-import/state.ts';
import { tierLedgerIdentityKey } from '../classification/tier-ledger.ts';
import { hiddenByParentIdentity, itemVerdicts, type ChildProbe, type ChildVisibilityLane } from '../connector-store/child-visibility.ts';
import { connectorStoreExtractionCandidateReader } from '../connector-store/extraction-candidate-reader.ts';
import type { LocalConnectorStore } from '../connector-store/index.ts';
import type { TieredExtractionView } from '../connector-store/tiered-extraction.ts';
import type { TieredStoreSet } from '../connector-store/tiered-store-set.ts';
import {
  createConnectorFileExtractionSource,
  deferredBytesAnswerFor,
  type BoundedFetchConnector,
} from '../file-extraction/connector-source.ts';
import type { ExtractorRegistryConfig } from '../file-extraction/types.ts';
import { createFileExtractionRuntime, type FileExtractionRuntime } from '../email-source/file-extraction-runtime.ts';
import { GMAIL_INTERNAL_CONNECTOR_CORPUS_ID, GMAIL_SECURE_CONNECTOR_CORPUS_ID, gmailPartLocatorPrefix } from './gmail.ts';
import { GMAIL_ARCHIVE_SOURCE_ID } from './gmail-archive-target.ts';
import { MBOX_PART_LOCATOR_PREFIX } from '../archive-import/mbox/gmail-input.ts';

/** The roster's key for Gmail's attachments (its corpus is the Gmail Private store, which lists the other stores). */
export const GMAIL_ATTACHMENT_EXTRACTION_PROVIDER = 'gmail.attachments';
export const GMAIL_ATTACHMENT_EXTRACTION_SCOPE_KEY = 'gmail.attachments:extraction';
export const GMAIL_ATTACHMENT_EXTRACTION_PLAN_LIMIT = 200;
/**
 * The corpora the entry reads: each of the Gmail lane's two legacy stores is
 * a home of its own (a child's names may rest in the Personal store or the
 * Private one), and the Private one also lists the routed Public store.
 */
export const GMAIL_ATTACHMENT_CORPUS_IDS: readonly string[] = [GMAIL_SECURE_CONNECTOR_CORPUS_ID, GMAIL_INTERNAL_CONNECTOR_CORPUS_ID];

/**
 * The extraction lanes of Gmail's attachments for an account scope: one per
 * corpus, keyed by the rows' own provider (jobs are), as an archive lane is.
 */
export function gmailAttachmentLanes(accountScope: string): Array<{ corpusId: string; provider: string; accountScope: string; approvedScopeKey: string }> {
  return GMAIL_ATTACHMENT_CORPUS_IDS.map((corpusId) => ({
    corpusId,
    provider: 'gmail',
    accountScope,
    approvedScopeKey: GMAIL_ATTACHMENT_EXTRACTION_SCOPE_KEY,
  }));
}
export const GMAIL_ATTACHMENT_EXTRACTION_BATCH_SIZE = 10;

/** What a read of one part's bytes needs from live Gmail: the lane's connector, which reads a part by its locator within a bound. */
export type GmailLiveAttachmentReader = Pick<BoundedFetchConnector, 'fetchItemWithin'>;

/**
 * A forwarded message's child is read as the message it is: its own headers
 * and text, without its attachments (each its own child), so the shared text
 * extractor reads it. Anything not a forwarded message passes unchanged.
 */
export async function forwardedMessageAsText(item: RawItem): Promise<RawItem> {
  if (item.content.kind !== 'bytes' || item.content.mimeType.trim().toLowerCase() !== 'message/rfc822') return item;
  const parsed = await parseMboxMessage(item.content.bytes, { rfc822AsAttachments: true });
  if (!parsed) throw new FileExtractionSourceError('source_content_unavailable');
  const text = [
    `From: ${parsed.from}`,
    ...(parsed.to ? [`To: ${parsed.to}`] : []),
    ...(parsed.subject ? [`Subject: ${parsed.subject}`] : []),
    ...(parsed.dateHeader ? [`Date: ${parsed.dateHeader}`] : []),
    '',
    parsed.body,
  ].join('\n');
  const bytes = new TextEncoder().encode(text);
  return { ...item, mimeType: 'text/plain', content: { kind: 'bytes', mimeType: 'text/plain', bytes } };
}

function childIdentity(account: string, localItemId: string) {
  const providerItemId = localItemId.startsWith(`${account}:`) ? localItemId.slice(account.length + 1) : localItemId;
  return { family: 'email' as const, provider: 'gmail', accountScope: account, providerItemId, localItemId };
}

/**
 * The one reader of Gmail's attachments: by the locator the child's row keeps.
 * `live` is undefined while live Gmail is not connected or its approval is not
 * current: a live part then waits (it is asked again later).
 */
export function gmailAttachmentConnector(input: {
  account: string;
  live: () => GmailLiveAttachmentReader | undefined;
  imports?: ArchiveImportStateStore;
}): BoundedFetchConnector {
  const read = async (localItemId: string, options: { maxBytes?: number; deferredBytes?: { locator: string } }): Promise<RawItem> => {
    const locator = options.deferredBytes?.locator;
    // Only children are read here; a message is read with its listing.
    if (!locator) throw new FileExtractionSourceError('source_content_unavailable');
    if (locator.startsWith(gmailPartLocatorPrefix())) {
      const live = input.live();
      if (!live) throw new FileExtractionSourceError('source_unavailable');
      // The connector binds the locator to the child, re-checks the scope and the approval, and bounds the size.
      const item = await live.fetchItemWithin(localItemId, { deferredBytes: { locator }, ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}) });
      if (item.content.kind === 'bytes' && options.maxBytes !== undefined && item.content.bytes.byteLength > options.maxBytes) {
        throw new FileExtractionSourceError('source_too_large');
      }
      return forwardedMessageAsText(item);
    }
    if (locator.startsWith(MBOX_PART_LOCATOR_PREFIX)) {
      if (!input.imports) throw new FileExtractionSourceError('source_item_not_found');
      const part = await readMboxPart({
        state: input.imports,
        sourceId: GMAIL_ARCHIVE_SOURCE_ID,
        locator,
        // The locator must name the child it is read for: its message and its part key.
        childProviderItemId: childIdentity(input.account, localItemId).providerItemId,
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      });
      return forwardedMessageAsText({
        identity: childIdentity(input.account, localItemId),
        mimeType: part.mimeType,
        content: { kind: 'bytes', mimeType: part.mimeType, bytes: part.bytes },
        metadata: {},
        fetchedAt: new Date().toISOString(),
      });
    }
    throw new FileExtractionSourceError('source_content_unavailable');
  };
  return {
    id: GMAIL_ATTACHMENT_EXTRACTION_PROVIDER,
    family: 'email',
    async authenticate(): Promise<void> {},
    // Extraction never lists: the inputs did.
    async *listItems(): AsyncIterable<SourceConnectorListPage> {},
    fetchItem: (localItemId: string, options?: SourceConnectorFetchOptions) => read(localItemId, options?.deferredBytes ? { deferredBytes: options.deferredBytes } : {}),
    fetchItemWithin: (localItemId, options) => read(localItemId, options),
    classificationSignals: () => ({}),
  };
}

/**
 * Whether a child may still be read and landed: its own row is not gone (not
 * tombstoned in every store) and its parent may be seen (child visibility: a
 * deleted or hidden parent hides it). Asked before its bytes are fetched and
 * again before its text is accepted; a queued job for a child that fails it is
 * closed and its text dropped.
 */
export function gmailChildStillServed(lane: ChildVisibilityLane, child: ChildProbe): boolean {
  const own = itemVerdicts(lane, [child]).get(tierLedgerIdentityKey(child));
  if (!own || own.gone) return false;
  return hiddenByParentIdentity(lane, [child]).size === 0;
}

/** Only attachment children are candidates (their ids carry the child separator). */
export function gmailAttachmentCandidates(reader: ExtractionCandidateReader): ExtractionCandidateReader {
  return {
    async extractionCandidates(options) {
      const page = await reader.extractionCandidates(options);
      return { ...page, candidates: page.candidates.filter((row) => (row.providerItemId ?? row.localItemId).includes(CHILD_ITEM_ID_SEPARATOR)) };
    },
  };
}

/**
 * The Gmail attachments' extraction runtime: the shared factory over the Gmail
 * stores, with this module's one reader, the Gmail tier set to place what is
 * read, and the product's extractors and jobs file.
 */
export function createGmailAttachmentExtractionRuntime(input: {
  stores: readonly LocalConnectorStore[];
  set: TieredStoreSet;
  accountScope: () => string;
  connector: (accountScope: string) => BoundedFetchConnector | undefined;
  extractors?: ExtractorRegistryConfig;
  env?: Record<string, string | undefined>;
  jobsDbPath?: string;
  warn?: (message: string) => void;
}): FileExtractionRuntime | undefined {
  return createFileExtractionRuntime({
    ...(input.env ? { env: input.env } : {}),
    enabled: true,
    connectorStores: [...input.stores],
    corpora: GMAIL_ATTACHMENT_CORPUS_IDS.map((corpusId) => ({
      corpusId,
      provider: GMAIL_ATTACHMENT_EXTRACTION_PROVIDER,
      scopes: [GMAIL_ATTACHMENT_EXTRACTION_SCOPE_KEY],
      ownerConnectorId: GMAIL_ATTACHMENT_EXTRACTION_PROVIDER,
      resolveAccountScope: input.accountScope,
    })),
    extraSourceFactories: new Map([[
      GMAIL_ATTACHMENT_EXTRACTION_PROVIDER,
      ({ config, store, view }: { config: { corpusId: string; provider: string }; store: LocalConnectorStore; view?: TieredExtractionView }) => {
        const reader = view ?? store;
        return createConnectorFileExtractionSource({
          id: `${config.corpusId}:attachments`,
          corpusId: config.corpusId,
          provider: config.provider,
          connector: input.connector,
          deferredBytes: (ref) => deferredBytesAnswerFor(reader.deferredBytesStateOfLocalItem(ref.localItemId, ref.sourceVersion)),
          candidates: gmailAttachmentCandidates(connectorStoreExtractionCandidateReader(reader)),
          lanes: [{ approvedScopeKey: GMAIL_ATTACHMENT_EXTRACTION_SCOPE_KEY }],
        });
      },
    ]]),
    tierSets: new Map(GMAIL_ATTACHMENT_CORPUS_IDS.map((corpusId) => [corpusId, input.set] as const)),
    // Rechecked before candidates are listed, before bytes are fetched and before text is accepted: a child
    // whose parent was deleted (or which was removed itself) while its job waited is never read or landed.
    scopeGuard: {
      assertAuthorized: () => {},
      allowsRef: ({ ref }) => gmailChildStillServed(
        { ledger: () => input.set.ledger, stores: () => input.set.openStores() },
        { provider: ref.provider, accountScope: ref.accountScope, providerItemId: ref.providerItemId },
      ),
    },
    ...(input.extractors ? { extractors: input.extractors } : {}),
    ...(input.jobsDbPath ? { jobsDbPath: input.jobsDbPath } : {}),
    ...(input.warn ? { warn: input.warn } : {}),
  });
}
