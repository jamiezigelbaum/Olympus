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
 * which is how a copy of the same export is known later. The media files the
 * connector bound along the way (media-bindings.ts) are checked with them,
 * by version: the import is whole when the manifest and the bindings both are.
 *
 * Findings the connector reports (a message too large, a part it could not
 * read) are counted on the record as the pages they belong to are listed.
 * A replay after a restart lists the same positions again and is not counted
 * twice (state.ts `recordFindings`).
 *
 * An import that is one input of a source (`record.target`,
 * source-targets.ts) is read by the source's own connector into the account's
 * own stores: the pass resolves the account again, inside the source's
 * exclusive runner, before it writes; the resume point is the set's committed
 * cursor under this input's own connector id, so it never moves the live
 * cursor; and every item is held until judged. Everything else is the same
 * pass.
 */
import { createHash } from 'node:crypto';
import { ARCHIVE_COMMON_FINDINGS } from '../../core/archive-formats.ts';
import type { RawItem, SourceConnector, SourceConnectorListOptions, SourceConnectorListPage } from '../../core/contracts.ts';
import type { SourceIntakeOutcome } from '../../core/source-inputs.ts';
import {
  ArchiveImportStoppedError,
  archiveFormatConnector,
  getArchiveFormat,
  type ArchiveConnectorFactory,
  type ArchiveConnectorInput,
  type ArchiveImportFinding,
} from '../../core/archive-formats.ts';
import { ScopeRoot, ScopeSafeError } from '../../core/scope-safe-fs.ts';
import { SourceStorageUnavailableError, importAccountIdentity, resolveImportAccount, sameImportAccount } from '../../core/source-storage.ts';
import type { ConnectorStoreSyncOptions, ConnectorStoreSyncSummary } from '../connector-store/index.ts';
import {
  TIER_DOMAIN_ORDER,
  tieredLaneReceiptCounts,
  type TieredLaneReceiptCounts,
  type TieredStoreSet,
} from '../connector-store/tiered-store-set.ts';
import type { ArchiveTierLane } from './lane.ts';
import { bindInputToFiles, holdingItems, observingIntake } from './source-input.ts';
import { archiveSourceTargets, type ArchiveSourceTargets } from './source-targets.ts';
import { archiveMediaAccess, verifyArchiveMediaBindings, type ArchiveMediaBindings } from './media-bindings.ts';

// Where an item is in the archive: the coordinates findings use.
type ItemPosition = { fileIndex: number; offset: number };
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
  /**
   * The family's archive stores: where an import that stays under Archives is
   * written. Not used by an import that is an input of a source.
   */
  lane?: ArchiveTierLane;
  /**
   * The sources an import can be an input of (default: the registered ones).
   */
  targets?: ArchiveSourceTargets;
  archiveId: string;
  maxItems?: number;
  /**
   * Test seams.
   */
  pageSize?: number;
  maxBytesPerListing?: number;
  shouldContinue?: () => boolean;
  connectorFactory?: (formatId: string) => ArchiveConnectorFactory | undefined;
  /**
   * The media bindings of the archives. Without them a connector is given no
   * means to bind media and lists the media it cannot read as left out.
   */
  media?: ArchiveMediaBindings;
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
 * Why the archive is not the one approved any more, from metadata alone: the
 * folder at its path and every file at its version. Undefined when all are.
 */
function changeSinceApproval(root: ScopeRoot, record: ArchiveImportRecord, at: string): ArchiveImportStop | undefined {
  try {
    root.statRelative('');
  } catch (error) {
    const missing = (error instanceof ScopeSafeError && error.code === 'not_found')
      || (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
    return missing
      ? { code: 'file_missing', message: 'The folder that holds this archive is no longer there.', at }
      : { code: 'root_changed', message: 'The folder that holds this archive was replaced.', at };
  }
  const check = verifyArchiveManifest(root, record.files);
  return check.ok ? undefined : stopFrom(check, at);
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
 * How many of a page's items are ones the stores already hold from an earlier
 * pass, or that an earlier item of this pass (`seen`: at most one pass of
 * items, which the pass's item limit bounds) already is. A pass is stored only
 * after its whole listing was read, so the stores cannot say what this pass has
 * listed so far.
 */
function repeatedIndexes(items: readonly RawItem[], holds: (identity: RawItem['identity']) => boolean, seen: Set<string>): number[] {
  const repeated: number[] = [];
  items.forEach((item, index) => {
    if (seen.has(item.identity.localItemId) || holds(item.identity)) repeated.push(index);
    seen.add(item.identity.localItemId);
  });
  return repeated;
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
  repeats?: {
    holds(identity: RawItem['identity']): boolean;
    // The positions the connector told for the page just listed, once.
    positions(): readonly ItemPosition[] | undefined;
    add(count: number, at?: { repeatedAt: ItemPosition[]; through: ItemPosition | undefined }): void;
  },
): { connector: SourceConnector; completed(): boolean; dates(): { earliest?: string; latest?: string } } {
  // The listing reached its end and the files are unchanged. Whether the stores consumed that last page is the
  // pass's to check (a leg's `traversalComplete`): this runs before the page is stored.
  let completed = false;
  const seenThisPass = new Set<string>();
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
        // The same message in two files imports once, and is counted here: it is a repeat of an item
        // an earlier pass stored, or of one this pass listed before this page.
        if (repeats) {
          const repeated = repeatedIndexes(page.items, repeats.holds, seenThisPass);
          const where = repeats.positions();
          // With each item's position, a repeat is counted by where it is; without, by the page it is in.
          if (where && where.length === page.items.length) {
            repeats.add(repeated.length, { repeatedAt: repeated.map((index) => where[index]!), through: where[where.length - 1] });
          } else {
            repeats.add(repeated.length);
          }
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
  if (record.target) {
    // An input of a source: the source's own connector writes it, and the source's runner serializes the account.
    const target = (options.targets ?? archiveSourceTargets).forSource(record.target.source_id);
    if (!target || !format || !target.formats.includes(record.format) || format.family !== record.family || format.provider !== record.provider) {
      return stop({ code: 'source_unavailable', message: 'This build does not read this export into its source.', at: now().toISOString() });
    }
    const pass = (): Promise<ArchiveImportPullOutcome> => runPass(options, record, {
      stop,
      idle,
      now,
      format,
      sink: (): PassSink | ArchiveImportStop => {
        let account;
        try {
          // The owner's yes was about one account. If the source holds another by now (the account guard may
          // bind other stores over an empty slot), it does not carry over: the import stops, and asks again.
          if (record.target!.owner_confirmed === true
            && !sameImportAccount(record.target!.confirmed_account, importAccountIdentity(record.target!.source_id, options.state.env))) {
            return { code: 'account_changed', message: 'The account this source holds now is not the one you said this export belongs to.', at: now().toISOString() };
          }
          // An account that is gone (the source's data was deleted since the import began) is never made again
          // by an import: it was created when the import was approved, and a record that outlived its delete
          // must not put the history back.
          if (importAccountIdentity(record.target!.source_id, options.state.env) === undefined) {
            return { code: 'source_unavailable', message: 'This source\'s account is gone, so nothing more was imported.', at: now().toISOString() };
          }
          const resolved = resolveImportAccount(record.target!.source_id, record.target!.import_account_id, {
            env: options.state.env,
            ...(record.target!.owner_confirmed === true ? { ownerConfirmed: true } : {}),
          });
          // The account Olympus holds now must be the export's: another one stops the import, with nothing more written.
          if ((resolved.match !== 'same' && resolved.match !== 'new') || !resolved.account) {
            return { code: 'account_changed', message: 'The account this source holds now is not the one this export belongs to.', at: now().toISOString() };
          }
          account = resolved.account;
        } catch (error) {
          if (error instanceof SourceStorageUnavailableError) {
            return { code: 'source_unavailable', message: 'This source is being deleted or moved, so nothing more was imported.', at: now().toISOString() };
          }
          throw error;
        }
        const lane = target.lane(account, options.state.env);
        return {
          set: lane.set,
          syncOptions: lane.sync,
          input: true,
          connector: (input, hooks) => {
            const bound = bindInputToFiles(target.input(input), record.manifest_sha256);
            if (!lane.connector.forInput) throw new Error('The source\'s connector has no way to read an archive.');
            return holdingItems(lane.connector.forInput(observingIntake(bound, hooks.observeIntake)));
          },
        };
      },
    });
    return target.exclusive ? target.exclusive(pass) : pass();
  }

  const lane = options.lane;
  if (!lane) throw new Error('An import that stays under Archives needs its family\'s stores.');
  if (record.family !== lane.family) throw new Error('This archive belongs to another family\'s stores.');
  const factory = (options.connectorFactory ?? archiveFormatConnector)(record.format);
  if (!format || !factory || format.family !== record.family || format.provider !== record.provider) {
    return stop({ code: 'format_unavailable', message: 'This build does not read this archive\'s format.', at: now().toISOString() });
  }
  return runPass(options, record, {
    stop,
    idle,
    now,
    format,
    sink: (): PassSink => ({
      set: lane.set,
      syncOptions: {
        placement: ARCHIVE_STORE_PLACEMENT,
        fetchContent: true,
        // A child (an attachment, a piece of media) is listed by name with the means to read its bytes
        // later; reading them is the extraction factory's work, never the listing's.
        deferMetadataOnlyContent: true,
      },
      input: false,
      connector: (input) => factory(input),
    }),
  });
}

/**
 * Where one pass writes, and how it reads: the family's archive stores and a
 * format's connector, or an account's own stores and the source's connector
 * over this archive as one of its inputs.
 */
interface PassSink {
  set: TieredStoreSet;
  syncOptions: ConnectorStoreSyncOptions;
  /**
   * True for an input of a source: intake is counted, not repeats.
   */
  input: boolean;
  connector(
    input: ArchiveConnectorInput,
    hooks: { observeIntake(outcomes: readonly SourceIntakeOutcome[]): void },
  ): SourceConnector;
}

async function runPass(
  options: ArchiveImportPullOptions,
  record: ArchiveImportRecord,
  context: {
    stop: (reason: ArchiveImportStop) => ArchiveImportPullOutcome;
    idle: (current: ArchiveImportRecord | undefined, warnings?: readonly string[], stopped?: boolean) => ArchiveImportPullOutcome;
    now: () => Date;
    format: NonNullable<ReturnType<typeof getArchiveFormat>>;
    sink: () => PassSink | ArchiveImportStop;
  },
): Promise<ArchiveImportPullOutcome> {
  const { stop, now, format } = context;
  const picked = context.sink();
  if ('code' in picked) return stop(picked);
  const sink = picked;

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
    let position: { fileIndex: number; offset: number } | undefined;
    let repeated = 0;
    let itemPositions: readonly ItemPosition[] | undefined;
    let repeatedAt: ItemPosition[] = [];
    let listedThrough: ItemPosition | undefined;
    const flush = (): void => {
      const moved = position;
      position = undefined;
      const repeats = repeated;
      repeated = 0;
      const items = repeatedAt.length > 0 || listedThrough ? { repeatedAt, ...(listedThrough ? { through: listedThrough } : {}) } : undefined;
      repeatedAt = [];
      listedThrough = undefined;
      if (pending.length === 0 && !moved && !items) return;
      const batch = pending.splice(0, pending.length);
      options.state.recordFindings(record.archive_id, batch, moved, repeats, items);
    };
    const connectorId = archiveConnectorId(record.archive_id);
    const shouldContinue = options.shouldContinue ?? (() => true);
    // Set when the listing stopped because the source's provider cannot be asked now: the import waits for its
    // next scheduled pass instead of being run again at once.
    let providerWait: string | undefined;
    const connector = sink.connector({
      archiveId: record.archive_id,
      connectorId,
      accountScope: record.archive_id,
      format,
      root,
      files: archiveFileEntries(record.files),
      manifestSha256: record.manifest_sha256,
      report: (finding) => { pending.push(finding); },
      reportPosition: (next) => { position = next; },
      reportItemPositions: (positions) => { itemPositions = positions; },
      waitForProvider: (reason) => { providerWait = reason; },
      shouldContinue,
      ...(options.media ? { media: archiveMediaAccess({ bindings: options.media, archiveId: record.archive_id, root, chosenRelPath: record.chosen_rel_path }) } : {}),
      ...(options.maxBytesPerListing !== undefined ? { maxBytesPerListing: options.maxBytesPerListing } : {}),
      ...(options.pageSize !== undefined ? { pageSize: options.pageSize } : {}),
    }, {
      // What the source did with each record of a page, told once the page's records were decided and
      // before its items go out: counted by position, so a replayed page counts nothing twice.
      observeIntake: (outcomes) => {
        const told = itemPositions;
        itemPositions = undefined;
        options.state.recordIntake(record.archive_id, outcomes, told);
      },
    });
    const completion: { digests?: string[] } = {};
    const observed = observeListing(connector, pending, flush, async () => {
      const digests = await digestArchiveFiles(root, record.files, shouldContinue);
      if (!digests) return false;
      // Every media file bound so far (the last page's included: bound before it was listed) must be
      // the version it was bound at, or the import is not whole.
      if (options.media) {
        const media = await verifyArchiveMediaBindings({ bindings: options.media, archiveId: record.archive_id, root, shouldContinue });
        if (!media) return false;
        if (!media.ok) throw new ArchiveImportStoppedError(media.code, media.message, media.relPath);
      }
      completion.digests = digests;
      return true;
    }, sink.input ? undefined : {
      holds: (identity) => sink.set.anyLegHasRow(identity),
      positions: () => {
        const told = itemPositions;
        itemPositions = undefined;
        return told;
      },
      add: (count, at) => {
        if (at) {
          repeatedAt.push(...at.repeatedAt);
          if (at.through) listedThrough = at.through;
        } else {
          repeated += count;
        }
      },
    });

    // The Private store first: with no store yet, the set would route nothing.
    const set = sink.set;
    set.store('secure_local', { create: true });
    const cursor = set.committedCursor(connectorId)?.cursor ?? undefined;
    let run;
    try {
      run = await set.sync(observed.connector, {
        ...sink.syncOptions,
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
    // An item a store refused (it fails closed rather than keep it in the wrong tier) is not imported: it is told as
    // a gap, at the place the pass had read to, so the owner sees it and a replay counts it once.
    const refused = TIER_DOMAIN_ORDER.reduce((sum, domain) => sum + (run.byDomain[domain]?.sync.itemsRejected ?? 0), 0);
    if (refused > 0) {
      const readTo = options.state.get(record.archive_id)?.read_position;
      pending.push({ kind: ARCHIVE_COMMON_FINDINGS.itemRefused, class: 'gap', fileIndex: position?.fileIndex ?? readTo?.file_index ?? 0, offset: position?.offset ?? readTo?.offset ?? 0, count: refused });
    }
    flush();

    const legs = TIER_DOMAIN_ORDER.flatMap((domain) => run.byDomain[domain] ? [run.byDomain[domain]!.sync] : []);
    // The listing reached its end and every file is unchanged, AND the stores consumed every item of
    // the last page: a page the store did not finish (an item budget ran out inside it) is not stored,
    // so the import is not complete however the listing ended.
    // A record the source accepted that no store could take (its item is in the middle of a move) is not
    // stored: the set kept its resume point, so the next pass reads the record again, and the import is not
    // complete however the listing ended.
    const waiting = run.routing.itemsUnstored;
    const complete = observed.completed() && legs.length > 0 && legs.every((leg) => leg.traversalComplete) && waiting === 0;
    const dates = observed.dates();
    const final: { stop?: ArchiveImportStop } = {};
    // Indexing the last page yielded after the bindings were checked: they are checked again as the
    // import is called complete, together with the manifest's files below.
    let mediaChange: ArchiveImportStop | undefined;
    let mediaChecked = true;
    if (complete && completion.digests && options.media) {
      const media = await verifyArchiveMediaBindings({ bindings: options.media, archiveId: record.archive_id, root, shouldContinue });
      if (!media) mediaChecked = false;
      else if (!media.ok) mediaChange = stopFrom(media, now().toISOString());
    }
    const updated = options.state.update(record.archive_id, (entry) => {
      if (dates.earliest && dates.latest) {
        entry.date_range = {
          earliest: entry.date_range && entry.date_range.earliest < dates.earliest ? entry.date_range.earliest : dates.earliest,
          latest: entry.date_range && entry.date_range.latest > dates.latest ? entry.date_range.latest : dates.latest,
        };
      }
      const digests = completion.digests;
      if (complete && digests && mediaChecked && entry.status === 'importing' && entry.manifest_sha256 === record.manifest_sha256) {
        // Indexing the last page yielded to other work after the files were
        // read whole: the folder and every file must still be those versions
        // (metadata only) at the moment the import is called complete.
        const changed = changeSinceApproval(root, record, now().toISOString()) ?? mediaChange;
        if (changed) {
          final.stop = changed;
          entry.status = 'stopped';
          entry.stop = changed;
          return;
        }
        entry.status = 'imported';
        entry.completed_at = now().toISOString();
        entry.files.forEach((file, index) => { file.sha256 = digests[index]!; });
      }
    });
    if (final.stop) return context.idle(updated, ['archive_import_stopped'], true);
    return {
      receipt: receiptOf(updated, {
        legs,
        tiered: tieredLaneReceiptCounts({
          ...(run.byDomain.public_safe ? { public: run.byDomain.public_safe } : {}),
          routing: run.routing,
        }),
        complete,
        stopped: false,
        warnings: [
          ...legs.flatMap((leg) => leg.gaps),
          ...(waiting > 0 ? [`archive_items_waiting: ${waiting} item(s) are in the middle of a tier move and are read again once it is done.`] : []),
          ...(providerWait !== undefined ? [`archive_import_waiting_for_provider: ${providerWait}`] : []),
        ],
      }),
      // Nothing more can be stored until the move is done, or until the provider can be asked again: the next
      // scheduled pass tries again.
      continueSoon: !complete && waiting === 0 && providerWait === undefined,
      ...(updated ? { record: updated } : {}),
    };
  } finally {
    root.close();
  }
}
