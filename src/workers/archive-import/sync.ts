/**
 * One bounded pass of one archive's import into its family's tier stores.
 *
 * The pass re-checks everything the approval pinned before it reads a byte:
 * the root folder is the same folder, and every file in the manifest is the
 * same version (dev, ino, size, mtime). A file that changed or went missing
 * stops the import with the reason on the archive's record, visibly; nothing
 * more is read from it. The resume point is the set's committed cursor for
 * this archive's own connector id, so two archives never share one.
 *
 * The listing completes only once every file, read again whole, is still the
 * version the import started with; its SHA-256 is then kept on the record,
 * which is how a copy of the same export is known later.
 *
 * Findings the connector reports (a message too large, a part it could not
 * read) are counted on the record as the pages they belong to are listed.
 * A replay after a restart lists the same positions again and is not counted
 * twice (state.ts `recordFindings`).
 */
import { createHash } from 'node:crypto';
import type { SourceConnector, SourceConnectorListOptions, SourceConnectorListPage } from '../../core/contracts.ts';
import {
  ArchiveImportStoppedError,
  archiveFormatConnector,
  getArchiveFormat,
  type ArchiveConnectorFactory,
  type ArchiveImportFinding,
} from '../../core/archive-formats.ts';
import { ScopeRoot, ScopeSafeError } from '../../core/scope-safe-fs.ts';
import type { ConnectorStoreSyncSummary } from '../connector-store/index.ts';
import {
  TIER_DOMAIN_ORDER,
  tieredLaneReceiptCounts,
  type TieredLaneReceiptCounts,
} from '../connector-store/tiered-store-set.ts';
import type { ArchiveTierLane } from './lane.ts';
import {
  archiveFileDigestSteps,
  archiveFileEntries,
  verifyArchiveManifest,
  type ArchiveManifestFile,
} from './manifest.ts';
import {
  archiveConnectorId,
  type ArchiveImportRecord,
  type ArchiveImportStateStore,
  type ArchiveImportStop,
} from './state.ts';
import { ARCHIVE_STORE_PLACEMENT } from './store.ts';

export const ARCHIVE_IMPORT_RECEIPT_KIND = 'archive_import_pull_receipt';
/**
 * Items one pass writes before it yields to the scheduler.
 */
export const ARCHIVE_IMPORT_MAX_ITEMS_PER_PASS = 2_000;

export interface ArchiveImportReceipt {
  kind: typeof ARCHIVE_IMPORT_RECEIPT_KIND;
  status: 'progress' | 'idle';
  counts: {
    items_seen: number;
    items_indexed: number;
    items_changed: number;
    items_rejected: number;
    traversal_complete: number;
    import_stopped: number;
    gaps: number;
    skipped: number;
  } & TieredLaneReceiptCounts;
  warnings?: string[];
  policy: { counts_only: true; raw_source_exposed: false; source_text_returned: false };
  receipt_sha256: string;
}

export interface ArchiveImportPullOutcome {
  receipt: ArchiveImportReceipt;
  /**
   * More of the archive is waiting: run again soon.
   */
  continueSoon: boolean;
  record?: ArchiveImportRecord;
}

export interface ArchiveImportPullOptions {
  state: ArchiveImportStateStore;
  lane: ArchiveTierLane;
  archiveId: string;
  maxItems?: number;
  /**
   * Test seams.
   */
  pageSize?: number;
  maxBytesPerListing?: number;
  shouldContinue?: () => boolean;
  connectorFactory?: (formatId: string) => ArchiveConnectorFactory | undefined;
  now?: () => Date;
}

function tally(values: Readonly<Record<string, number>>): number {
  return Object.values(values).reduce((total, value) => total + value, 0);
}

function receiptOf(
  record: ArchiveImportRecord | undefined,
  input: {
    legs: readonly ConnectorStoreSyncSummary[];
    tiered?: TieredLaneReceiptCounts;
    complete: boolean;
    stopped: boolean;
    warnings: readonly string[];
  },
): ArchiveImportReceipt {
  const sum = (pick: (leg: ConnectorStoreSyncSummary) => number): number =>
    input.legs.reduce((total, leg) => total + pick(leg), 0);
  const changed = sum((leg) => leg.itemsChanged);
  const withoutDigest: Omit<ArchiveImportReceipt, 'receipt_sha256'> = {
    kind: ARCHIVE_IMPORT_RECEIPT_KIND,
    status: changed > 0 ? 'progress' : 'idle',
    counts: {
      items_seen: input.legs[0]?.itemsSeen ?? 0,
      items_indexed: sum((leg) => leg.itemsIndexed),
      items_changed: changed,
      items_rejected: sum((leg) => leg.itemsRejected),
      traversal_complete: Number(input.complete),
      import_stopped: Number(input.stopped),
      gaps: record ? tally(record.findings.gaps) : 0,
      skipped: record ? tally(record.findings.skipped) : 0,
      ...(input.tiered ?? {}),
    },
    ...(input.warnings.length > 0 ? { warnings: [...new Set(input.warnings)] } : {}),
    policy: { counts_only: true, raw_source_exposed: false, source_text_returned: false },
  };
  return {
    ...withoutDigest,
    receipt_sha256: createHash('sha256').update(JSON.stringify(withoutDigest)).digest('hex'),
  };
}

function stopFrom(error: ArchiveImportStoppedError | { code: ArchiveImportStop['code']; message: string; relPath?: string }, at: string): ArchiveImportStop {
  return {
    code: error.code,
    message: error.message,
    ...(error.relPath ? { rel_path: error.relPath } : {}),
    at,
  };
}

function fileStop(error: unknown, relPath: string): unknown {
  if (!(error instanceof ScopeSafeError)) return error;
  if (error.code === 'not_found') {
    return new ArchiveImportStoppedError('file_missing', 'A file of this archive is no longer there.', relPath);
  }
  if (error.code === 'changed' || error.code === 'escape' || error.code === 'not_regular') {
    return new ArchiveImportStoppedError('file_changed', 'A file of this archive changed since the import started.', relPath);
  }
  return new ArchiveImportStoppedError('file_unreadable', 'A file of this archive could not be read.', relPath);
}

/**
 * Every file's SHA-256, each read again whole once the listing reached the
 * end, so an import completes only on files that are still the versions it
 * read, and its record says what it holds. Undefined when the pass is asked
 * to stop first.
 */
async function digestArchiveFiles(
  root: ScopeRoot,
  files: readonly ArchiveManifestFile[],
  shouldContinue: () => boolean,
): Promise<string[] | undefined> {
  const digests: string[] = [];
  for (const file of files) {
    const steps = archiveFileDigestSteps(root, file);
    try {
      for (;;) {
        const step = steps.next();
        if (step.done) {
          digests.push(step.value);
          break;
        }
        if (!shouldContinue()) {
          steps.return('');
          return undefined;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    } catch (error) {
      throw fileStop(error, file.rel_path);
    }
  }
  return digests;
}

/**
 * Watches the listing: counts findings page by page, notes the dates the
 * items carry, and whether the listing reached the end. The last page goes
 * on only once `complete` confirmed every file is unchanged.
 */
function observeListing(
  connector: SourceConnector,
  pending: ArchiveImportFinding[],
  flush: () => void,
  complete: () => Promise<boolean>,
): { connector: SourceConnector; completed(): boolean; dates(): { earliest?: string; latest?: string } } {
  let completed = false;
  let earliest: string | undefined;
  let latest: string | undefined;
  const wrapped = Object.create(connector) as SourceConnector;
  wrapped.listItems = (options?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> => {
    const pages = connector.listItems(options);
    return (async function* (): AsyncGenerator<SourceConnectorListPage> {
      for await (const page of pages) {
        for (const item of page.items) {
          const authoredAt = item.metadata.authoredAt;
          if (typeof authoredAt !== 'string' || !Number.isFinite(Date.parse(authoredAt))) continue;
          if (!earliest || authoredAt < earliest) earliest = authoredAt;
          if (!latest || authoredAt > latest) latest = authoredAt;
        }
        flush();
        if (page.done) {
          if (!(await complete())) return;
          completed = true;
        }
        yield page;
      }
      flush();
    })();
  };
  return {
    connector: wrapped,
    completed: () => completed,
    dates: () => ({ ...(earliest ? { earliest } : {}), ...(latest ? { latest } : {}) }),
  };
}

export async function pullArchiveImport(options: ArchiveImportPullOptions): Promise<ArchiveImportPullOutcome> {
  const now = options.now ?? (() => new Date());
  const record = options.state.get(options.archiveId);
  const idle = (current: ArchiveImportRecord | undefined, warnings: readonly string[] = [], stopped = false): ArchiveImportPullOutcome => ({
    receipt: receiptOf(current, { legs: [], complete: current?.status === 'imported', stopped, warnings }),
    continueSoon: false,
    ...(current ? { record: current } : {}),
  });
  if (!record || record.status !== 'importing') return idle(record);
  if (record.family !== options.lane.family) throw new Error('This archive belongs to another family\'s stores.');

  // Only an import still importing stops: a removal asked for while this
  // pass read keeps its `removing` status, or the data would never go.
  const stop = (reason: ArchiveImportStop): ArchiveImportPullOutcome => {
    const stoppedRecord = options.state.update(record.archive_id, (entry) => {
      if (entry.status !== 'importing') return false;
      entry.status = 'stopped';
      entry.stop = reason;
    });
    return idle(stoppedRecord, stoppedRecord?.status === 'stopped' ? ['archive_import_stopped'] : [], stoppedRecord?.status === 'stopped');
  };

  const format = getArchiveFormat(record.format);
  const factory = (options.connectorFactory ?? archiveFormatConnector)(record.format);
  if (!format || !factory || format.family !== record.family || format.provider !== record.provider) {
    return stop({ code: 'format_unavailable', message: 'This build does not read this archive\'s format.', at: now().toISOString() });
  }

  let root: ScopeRoot;
  try {
    root = ScopeRoot.open(record.root_path);
  } catch (error) {
    const missing = error instanceof ScopeSafeError && error.code === 'not_found';
    return stop({
      code: missing ? 'file_missing' : 'root_changed',
      message: missing ? 'The folder that holds this archive is no longer there.' : 'The folder that holds this archive could not be opened as approved.',
      at: now().toISOString(),
    });
  }
  try {
    if (root.identity.dev !== record.root_identity.dev || root.identity.ino !== record.root_identity.ino) {
      return stop({ code: 'root_changed', message: 'The folder that holds this archive was replaced.', at: now().toISOString() });
    }
    const check = verifyArchiveManifest(root, record.files);
    if (!check.ok) return stop(stopFrom(check, now().toISOString()));

    const pending: ArchiveImportFinding[] = [];
    const flush = (): void => {
      if (pending.length === 0) return;
      const batch = pending.splice(0, pending.length);
      options.state.recordFindings(record.archive_id, batch);
    };
    const connectorId = archiveConnectorId(record.archive_id);
    const shouldContinue = options.shouldContinue ?? (() => true);
    const connector = factory({
      archiveId: record.archive_id,
      connectorId,
      accountScope: record.archive_id,
      format,
      root,
      files: archiveFileEntries(record.files),
      manifestSha256: record.manifest_sha256,
      report: (finding) => { pending.push(finding); },
      shouldContinue,
      ...(options.maxBytesPerListing !== undefined ? { maxBytesPerListing: options.maxBytesPerListing } : {}),
      ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    });
    const completion: { digests?: string[] } = {};
    const observed = observeListing(connector, pending, flush, async () => {
      const digests = await digestArchiveFiles(root, record.files, shouldContinue);
      if (digests) completion.digests = digests;
      return digests !== undefined;
    });

    // The Private store first: with no store yet, the set would route nothing.
    const set = options.lane.set;
    set.store('secure_local', { create: true });
    const cursor = set.committedCursor(connectorId)?.cursor ?? undefined;
    let run;
    try {
      run = await set.sync(observed.connector, {
        placement: ARCHIVE_STORE_PLACEMENT,
        fetchContent: true,
        maxItems: Math.max(1, options.maxItems ?? ARCHIVE_IMPORT_MAX_ITEMS_PER_PASS),
        ...(cursor ? { cursor } : {}),
      });
    } catch (error) {
      if (error instanceof ArchiveImportStoppedError) {
        flush();
        return stop(stopFrom(error, now().toISOString()));
      }
      throw error;
    }
    flush();

    const complete = observed.completed();
    const dates = observed.dates();
    const updated = options.state.update(record.archive_id, (entry) => {
      if (dates.earliest && dates.latest) {
        entry.date_range = {
          earliest: entry.date_range && entry.date_range.earliest < dates.earliest ? entry.date_range.earliest : dates.earliest,
          latest: entry.date_range && entry.date_range.latest > dates.latest ? entry.date_range.latest : dates.latest,
        };
      }
      const digests = completion.digests;
      if (complete && digests && entry.status === 'importing' && entry.manifest_sha256 === record.manifest_sha256) {
        entry.status = 'imported';
        entry.completed_at = now().toISOString();
        entry.files.forEach((file, index) => { file.sha256 = digests[index]!; });
      }
    });
    const legs = TIER_DOMAIN_ORDER.flatMap((domain) => run.byDomain[domain] ? [run.byDomain[domain]!.sync] : []);
    return {
      receipt: receiptOf(updated, {
        legs,
        tiered: tieredLaneReceiptCounts({
          ...(run.byDomain.public_safe ? { public: run.byDomain.public_safe } : {}),
          routing: run.routing,
        }),
        complete,
        stopped: false,
        warnings: legs.flatMap((leg) => leg.gaps),
      }),
      continueSoon: !complete,
      ...(updated ? { record: updated } : {}),
    };
  } finally {
    root.close();
  }
}
