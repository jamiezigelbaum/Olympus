// A fixture connector for child items (docs/design/child-items.md): parents
// with children, listed in pages that may end INSIDE a parent's children, with
// each child a `metadata_only` item carrying `deferredBytes`, and a
// `fetchItem` that reads a child only from the persisted locator it is handed.
// It stands in for every format so the spine is proved without touching one.
//
// What it records is what the tests assert on: which pages were cut where,
// which locators reached `fetchItem`, and how many bytes a bounded read took.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  RawItem,
  SourceClassificationSignals,
  SourceConnector,
  SourceConnectorFetchOptions,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../src/core/contracts.ts';
import type { ArchiveMediaAccess } from '../../src/core/archive-formats.ts';
import { FileExtractionSourceError } from '../../src/core/file-extraction-source.ts';
import type { SourceFamily } from '../../src/core/source-index/types.ts';

export interface FixtureChildSpec {
  /** Stable within the parent: the `#child:<key>` of its providerItemId. */
  key: string;
  name: string;
  mimeType: string;
  /** What the child's bytes hold (UTF-8) unless `bytes` is given. */
  text?: string;
  bytes?: Uint8Array;
  /** False: the source says the bytes are not there (a listed name only). */
  available?: boolean;
  /** The size the source STATES; defaults to the real size. May be wrong on purpose. */
  declaredSizeBytes?: number;
  /**
   * The child's bytes are a media file beside the export, at this path under the chosen folder. The
   * connector binds it through the import's media access while it lists, names the binding in the
   * child's locator, and reads it through that binding later. Where binding is refused the child is
   * listed by name as unavailable, which is what a connector does for media an export left out.
   */
  mediaPath?: string;
}

export interface FixtureParentSpec {
  id: string;
  subject: string;
  sender: string;
  sentAt: string;
  body: string;
  children: readonly FixtureChildSpec[];
  /** Bumped to model the source replacing the item. */
  version?: string;
  /**
   * The source reports this parent as deleted (a tombstone with no content) and lists none of its
   * children, as a provider does for a message that is gone.
   */
  deleted?: boolean;
}

export interface FixtureReadLog {
  listCalls: number;
  /** Every media binding the connector asked for while listing, and what it was told. */
  binds: Array<{ mediaPath: string; result: 'bound' | 'chosen_file' | 'missing' | 'not_regular' | 'unreadable' | 'no_access'; bindingId?: string }>;
  /** The size of each page the connector yielded, in order. */
  pages: number[];
  /** Every `fetchItem` / `fetchItemWithin` call: what reached the connector. */
  fetches: Array<{ localItemId: string; locator?: string; maxBytes?: number; bytesRead?: number; refused?: string }>;
  /** Files spooled for a file reader, and whether the connector was asked to. */
  spooled: string[];
}

export interface FixtureConnectorOptions {
  accountScope: string;
  parents: readonly FixtureParentSpec[];
  family?: SourceFamily;
  provider?: string;
  id?: string;
  /** Items per page; the page ends wherever this lands, children included. */
  pageSize?: number;
  /** Fired before each page is yielded, with the index of the first item in it. */
  beforePage?: (firstItem: number) => void;
  /**
   * What an archive connector tells the import (`ArchiveConnectorInput`): where each item of the
   * page about to go out is, in archive coordinates. A parent sits at a multiple of 1000 in file 0;
   * its children sit strictly after it and before the next parent, at the offset of their reference
   * inside the parent's bytes.
   */
  reportItemPositions?: (positions: ReadonlyArray<{ fileIndex: number; offset: number }>) => void;
  /** Whether to offer the bounded reader (`fetchItemWithin`). Default true. */
  bounded?: boolean;
  /** What the import gives an archive connector to bind and read media files (`ArchiveConnectorInput.media`). */
  media?: ArchiveMediaAccess;
  /**
   * Awaited inside a child's fetch, after the locator was accepted and before any byte is
   * returned: a test holds a read here to act in the middle of it.
   */
  onFetch?: (localItemId: string) => void | Promise<void>;
  log?: FixtureReadLog;
}

export function newFixtureReadLog(): FixtureReadLog {
  return { listCalls: 0, binds: [], pages: [], fetches: [], spooled: [] };
}

export function childProviderItemId(parentId: string, key: string): string {
  return `${parentId}#child:${key}`;
}

export function fixtureLocalItemId(accountScope: string, providerItemId: string): string {
  return `${accountScope}:${providerItemId}`;
}

/** The locator of a child whose bytes are a bound media file: it names the binding, never the path. */
export const FIXTURE_MEDIA_LOCATOR_PREFIX = 'fixture-media-locator:';

/** The opaque locator the fixture writes: bound to the child and its parent's version. */
export function fixtureLocator(accountScope: string, parent: FixtureParentSpec, child: FixtureChildSpec): string {
  return `fixture-locator:${accountScope}:${parent.id}:${child.key}@${parent.version ?? 'v1'}`;
}

function childBytes(child: FixtureChildSpec): Uint8Array {
  return child.bytes ?? new TextEncoder().encode(child.text ?? '');
}

type Flat = { kind: 'parent'; parent: FixtureParentSpec } | { kind: 'child'; parent: FixtureParentSpec; child: FixtureChildSpec };

function flatten(parents: readonly FixtureParentSpec[]): Flat[] {
  return parents.flatMap((parent): Flat[] => parent.deleted ? [{ kind: 'parent', parent }] : [
    { kind: 'parent', parent },
    ...parent.children.map((child): Flat => ({ kind: 'child', parent, child })),
  ]);
}

/**
 * A connector over `parents`. The resume point is the index in the flattened
 * sequence (parent, its children, next parent...), so a page can end between
 * two children of one parent and the next listing resumes there.
 */
export function createFixtureChildConnector(options: FixtureConnectorOptions): SourceConnector & {
  fetchItemWithin?: (
    localItemId: string,
    fetchOptions: { maxBytes?: number; expectedVersion?: string; deferredBytes?: { locator: string } },
  ) => Promise<RawItem>;
  fetchItemToFile?: (
    localItemId: string,
    fetchOptions: { maxBytes?: number; expectedVersion?: string; deferredBytes?: { locator: string }; spoolDir: string },
  ) => Promise<{ item: RawItem; path: string; spooled: boolean }>;
} {
  const provider = options.provider ?? 'fixture-archive';
  const family = options.family ?? 'email';
  const log = options.log ?? newFixtureReadLog();
  const flat = flatten(options.parents);
  const parentItemOf = (parent: FixtureParentSpec): RawItem => parent.deleted ? {
    identity: {
      family,
      provider,
      accountScope: options.accountScope,
      providerItemId: parent.id,
      localItemId: fixtureLocalItemId(options.accountScope, parent.id),
      sourceVersion: parent.version ?? 'v1',
    },
    mimeType: 'application/octet-stream',
    content: { kind: 'metadata_only' },
    metadata: Object.freeze({ deleted: true }),
    fetchedAt: '2026-10-25T00:00:00.000Z',
  } : ({
    identity: {
      family,
      provider,
      accountScope: options.accountScope,
      providerItemId: parent.id,
      localItemId: fixtureLocalItemId(options.accountScope, parent.id),
      sourceVersion: parent.version ?? 'v1',
    },
    mimeType: 'text/plain',
    content: {
      kind: 'text',
      text: `${parent.body}\nAttachments: ${parent.children.map((child) => child.name).join(', ')}`,
    },
    metadata: Object.freeze({
      name: parent.subject,
      subject: parent.subject,
      sender: parent.sender,
      sentAt: parent.sentAt,
    }),
    fetchedAt: '2026-10-25T00:00:00.000Z',
  });
  const childItemOf = (parent: FixtureParentSpec, child: FixtureChildSpec, withBytes: boolean, read?: Uint8Array): RawItem => {
    const providerItemId = childProviderItemId(parent.id, child.key);
    const bytes = read ?? childBytes(child);
    const identity = {
      family,
      provider,
      accountScope: options.accountScope,
      providerItemId,
      localItemId: fixtureLocalItemId(options.accountScope, providerItemId),
      sourceVersion: parent.version ?? 'v1',
      parent: { providerItemId: parent.id, localItemId: fixtureLocalItemId(options.accountScope, parent.id) },
    };
    // A media child is bound while it is listed, so the binding is written before the page goes out.
    const media = !withBytes && child.mediaPath !== undefined ? bindMedia(child.mediaPath) : undefined;
    return {
      identity,
      mimeType: child.mimeType,
      content: withBytes
        ? { kind: 'bytes', mimeType: child.mimeType, bytes }
        : { kind: 'metadata_only' },
      metadata: Object.freeze({
        name: child.name,
        sender: parent.sender,
        sentAt: parent.sentAt,
      }),
      fetchedAt: '2026-10-25T00:00:00.000Z',
      ...(withBytes ? {} : {
        deferredBytes: media
          ? media.ok
            ? { locator: `${FIXTURE_MEDIA_LOCATOR_PREFIX}${media.bindingId}`, available: child.available !== false, sizeBytes: child.declaredSizeBytes ?? media.sizeBytes }
            : { locator: `${FIXTURE_MEDIA_LOCATOR_PREFIX}none`, available: false, sizeBytes: child.declaredSizeBytes ?? 0 }
          : {
            locator: fixtureLocator(options.accountScope, parent, child),
            available: child.available !== false,
            sizeBytes: child.declaredSizeBytes ?? bytes.byteLength,
          },
      }),
    };
  };

  const bindMedia = (mediaPath: string): ReturnType<ArchiveMediaAccess['bind']> => {
    if (!options.media) {
      log.binds.push({ mediaPath, result: 'no_access' });
      return { ok: false, reason: 'unreadable' };
    }
    const bound = options.media.bind(mediaPath);
    log.binds.push({ mediaPath, result: bound.ok ? 'bound' : bound.reason, ...(bound.ok ? { bindingId: bound.bindingId } : {}) });
    return bound;
  };

  /**
   * A media child's bytes, read through the binding its locator names: at most `maxBytes + 1` of
   * them when bounded (so "over the limit" is told from "exactly the limit"), checked to still be
   * the bound version after they were read. A changed or missing file throws what the import's
   * media access throws; nothing here maps it.
   */
  const mediaBytes = (bindingId: string, maxBytes?: number): Uint8Array => {
    const media = options.media;
    if (!media) throw new FileExtractionSourceError('source_unavailable');
    if (maxBytes === undefined) return media.read(bindingId);
    const reader = media.open(bindingId);
    try {
      const bytes = reader.readAt(0, Math.min(reader.size, maxBytes + 1));
      reader.assertCurrent();
      return bytes;
    } finally {
      reader.close();
    }
  };
  const bytesOf = (entry: { child: FixtureChildSpec; bindingId?: string }, maxBytes?: number): Uint8Array =>
    entry.bindingId !== undefined ? mediaBytes(entry.bindingId, maxBytes) : childBytes(entry.child);

  const find = (localItemId: string): Flat | undefined => flat.find((entry) =>
    fixtureLocalItemId(
      options.accountScope,
      entry.kind === 'parent' ? entry.parent.id : childProviderItemId(entry.parent.id, entry.child.key),
    ) === localItemId);

  /** The child a fetch is for, after the locator and the version are checked. */
  const resolveChild = (
    localItemId: string,
    fetchOptions: { expectedVersion?: string; deferredBytes?: { locator: string } } | undefined,
    maxBytes?: number,
  ): { parent: FixtureParentSpec; child: FixtureChildSpec; bindingId?: string } => {
    const entry = find(localItemId);
    const locator = fetchOptions?.deferredBytes?.locator;
    const record = { localItemId, ...(locator ? { locator } : {}), ...(maxBytes !== undefined ? { maxBytes } : {}) };
    if (!entry || entry.kind !== 'child') {
      log.fetches.push({ ...record, refused: 'source_item_not_found' });
      throw new FileExtractionSourceError('source_item_not_found');
    }
    // After a restart the connector has nothing but its account and the
    // locator the store kept: a fetch without one cannot read a child.
    if (entry.child.mediaPath !== undefined) {
      if (locator === undefined || !locator.startsWith(FIXTURE_MEDIA_LOCATOR_PREFIX) || locator === `${FIXTURE_MEDIA_LOCATOR_PREFIX}none`) {
        log.fetches.push({ ...record, refused: 'source_version_gone' });
        throw new FileExtractionSourceError('source_version_gone');
      }
      return { parent: entry.parent, child: entry.child, bindingId: locator.slice(FIXTURE_MEDIA_LOCATOR_PREFIX.length) };
    }
    if (locator === undefined || locator !== fixtureLocator(options.accountScope, entry.parent, entry.child)) {
      log.fetches.push({ ...record, refused: 'source_version_gone' });
      throw new FileExtractionSourceError('source_version_gone');
    }
    if (fetchOptions?.expectedVersion !== undefined && fetchOptions.expectedVersion !== (entry.parent.version ?? 'v1')) {
      log.fetches.push({ ...record, refused: 'source_version_gone' });
      throw new FileExtractionSourceError('source_version_gone');
    }
    return { parent: entry.parent, child: entry.child };
  };

  const connector: ReturnType<typeof createFixtureChildConnector> = {
    id: options.id ?? 'fixture-child-connector',
    family,
    async authenticate() {},
    listItems(listOptions?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      log.listCalls += 1;
      const pageSize = Math.max(1, Math.min(listOptions?.limit ?? Number.POSITIVE_INFINITY, options.pageSize ?? 3));
      const start = listOptions?.cursor ? Number(listOptions.cursor) : 0;
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        for (let index = start; index < flat.length; index += pageSize) {
          options.beforePage?.(index);
          const slice = flat.slice(index, index + pageSize);
          const items = slice.map((entry) => entry.kind === 'parent'
            ? parentItemOf(entry.parent)
            : childItemOf(entry.parent, entry.child, false));
          log.pages.push(items.length);
          options.reportItemPositions?.(slice.map((entry) => ({
            fileIndex: 0,
            offset: options.parents.indexOf(entry.parent) * 1000
              + (entry.kind === 'parent' ? 0 : 10 * (entry.parent.children.indexOf(entry.child) + 1)),
          })));
          const next = index + slice.length;
          yield next >= flat.length
            ? { items, done: true }
            : { items, nextCursor: String(next), done: false };
        }
        if (start >= flat.length) yield { items: [], done: true };
      })();
    },
    async fetchItem(localItemId: string, fetchOptions?: SourceConnectorFetchOptions): Promise<RawItem> {
      const entry = find(localItemId);
      if (entry?.kind === 'parent') {
        log.fetches.push({ localItemId });
        return parentItemOf(entry.parent);
      }
      const resolved = resolveChild(localItemId, fetchOptions);
      const { parent, child } = resolved;
      const read = bytesOf(resolved);
      log.fetches.push({ localItemId, locator: fetchOptions!.deferredBytes!.locator, bytesRead: read.byteLength });
      await options.onFetch?.(localItemId);
      return childItemOf(parent, child, true, read);
    },
    classificationSignals(item: RawItem): SourceClassificationSignals {
      const meta = item.metadata as Record<string, unknown>;
      return {
        title: String(meta['name'] ?? ''),
        ...(typeof meta['sender'] === 'string' ? { sender: meta['sender'] } : {}),
      };
    },
  };

  if (options.bounded !== false) {
    connector.fetchItemWithin = async (localItemId, fetchOptions) => {
      const resolved = resolveChild(localItemId, fetchOptions, fetchOptions.maxBytes);
      const { parent, child } = resolved;
      const whole = bytesOf(resolved, fetchOptions.maxBytes);
      // A bounded read takes at most the limit plus one byte, so a size the
      // source stated wrongly cannot overrun memory (and the caller can still
      // tell "over the limit" from "exactly the limit").
      const take = fetchOptions.maxBytes === undefined ? whole.byteLength : Math.min(whole.byteLength, fetchOptions.maxBytes + 1);
      log.fetches.push({
        localItemId,
        locator: fetchOptions.deferredBytes!.locator,
        ...(fetchOptions.maxBytes !== undefined ? { maxBytes: fetchOptions.maxBytes } : {}),
        bytesRead: take,
      });
      await options.onFetch?.(localItemId);
      const item = childItemOf(parent, child, true);
      return { ...item, content: { kind: 'bytes', mimeType: child.mimeType, bytes: whole.slice(0, take) } };
    };
    connector.fetchItemToFile = async (localItemId, fetchOptions) => {
      const resolved = resolveChild(localItemId, fetchOptions, fetchOptions.maxBytes);
      const { parent, child } = resolved;
      const whole = bytesOf(resolved, fetchOptions.maxBytes);
      const digest = createHash('sha256').update(localItemId).digest('hex').slice(0, 16);
      mkdirSync(fetchOptions.spoolDir, { recursive: true, mode: 0o700 });
      const path = join(fetchOptions.spoolDir, `spool-${digest}`);
      const take = fetchOptions.maxBytes === undefined ? whole.byteLength : Math.min(whole.byteLength, fetchOptions.maxBytes + 1);
      writeFileSync(path, whole.slice(0, take), { mode: 0o600 });
      log.spooled.push(path);
      log.fetches.push({
        localItemId,
        locator: fetchOptions.deferredBytes!.locator,
        ...(fetchOptions.maxBytes !== undefined ? { maxBytes: fetchOptions.maxBytes } : {}),
        bytesRead: take,
      });
      await options.onFetch?.(localItemId);
      return { item: childItemOf(parent, child, false), path, spooled: true };
    };
  }
  return connector;
}
