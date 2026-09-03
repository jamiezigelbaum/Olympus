// Contract 1 (SourceConnector) adapter for a Roam Research JSON export — an
// archive-import connector for the 'note' family implementing the frozen
// shape in src/core/contracts.ts.
//
// THIN by design: the export file IS the archive, so there is no live API
// client to adapt. The connector reads the export once, flattens each page's
// recursive block tree into indented markdown-ish text (order preserved,
// nothing else stripped), and emits one RawItem per page. Storage stays in
// the shared spine — no local-index code lives here.
//
// Empty pages are SURFACED, not skipped: a page with no blocks maps to a
// RawItem with content { kind: 'metadata_only' } and metadata.blockCount === 0
// so the shared ingest spine still sees the page exist. Skipping them would
// make a page that was emptied between exports silently vanish from the index.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  RawItem,
  SourceConnector,
  SourceConnectorListOptions,
  SourceConnectorListPage,
} from '../../core/contracts.ts';
import {
  buildSourceSensitivity,
  type SourceItemIdentity,
  type SourceSensitivity,
} from '../../core/source-index/types.ts';

const CONNECTOR_ID = 'roam';
const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1_000;
const ROAM_PAGE_MIME_TYPE = 'text/markdown';

export type RoamTrustDomain = 'secure_local' | 'internal';

export interface RoamSourceConnectorOptions {
  exportPath: string;
  account: string;
  trustDomain?: RoamTrustDomain;
}

interface RoamPageRecord {
  providerItemId: string;
  title: string;
  text: string;
  blockCount: number;
  createdAt?: string;
  updatedAt?: string;
}

interface RoamExportSnapshot {
  records: readonly RoamPageRecord[];
  byProviderItemId: ReadonlyMap<string, RoamPageRecord>;
}

export function createRoamSourceConnector(options: RoamSourceConnectorOptions): SourceConnector {
  const exportPath = requireNonEmpty(options.exportPath, 'Roam source connector exportPath');
  const account = requireNonEmpty(options.account, 'Roam source connector account');
  const trustDomain = options.trustDomain ?? 'secure_local';
  if (trustDomain !== 'secure_local' && trustDomain !== 'internal') {
    throw new Error('Roam source connector trustDomain must be secure_local or internal.');
  }

  let cachedSnapshot: RoamExportSnapshot | undefined;

  const loadSnapshot = async (): Promise<RoamExportSnapshot> => {
    if (cachedSnapshot) return cachedSnapshot;
    let raw: string;
    try {
      raw = await readFile(exportPath, 'utf8');
    } catch (error) {
      throw new Error(`Roam export is not readable at ${exportPath}: ${errorMessage(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`Roam export at ${exportPath} is not valid JSON: ${errorMessage(error)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Roam export at ${exportPath} must be a JSON array of pages.`);
    }
    const records = parsed.map((entry, index) => pageRecordFromExportEntry(entry, index));
    const byProviderItemId = new Map<string, RoamPageRecord>();
    for (const record of records) {
      if (byProviderItemId.has(record.providerItemId)) {
        throw new Error(
          `Roam export at ${exportPath} contains duplicate page identity ${record.providerItemId}; `
          + 'page uids/titles must be unique.',
        );
      }
      byProviderItemId.set(record.providerItemId, record);
    }
    cachedSnapshot = { records, byProviderItemId };
    return cachedSnapshot;
  };

  return {
    id: CONNECTOR_ID,
    family: 'note',

    async authenticate(): Promise<void> {
      await loadSnapshot();
    },

    listItems(listOptions?: SourceConnectorListOptions): AsyncIterable<SourceConnectorListPage> {
      const limit = normalizePositiveInteger(listOptions?.limit, DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT);
      const initialOffset = offsetFromCursor(listOptions?.cursor);
      return (async function* (): AsyncGenerator<SourceConnectorListPage> {
        const { records } = await loadSnapshot();
        let offset = initialOffset;
        while (true) {
          const slice = records.slice(offset, offset + limit);
          const fetchedAt = nowIso();
          const nextOffset = offset + slice.length;
          const done = nextOffset >= records.length;
          yield {
            items: slice.map((record) => rawItemFromPageRecord(record, account, fetchedAt)),
            ...(done ? {} : { nextCursor: String(nextOffset) }),
            done,
          };
          if (done) return;
          offset = nextOffset;
        }
      })();
    },

    async fetchItem(localItemId: string): Promise<RawItem> {
      const providerItemId = providerItemIdFromLocalItemId(localItemId, account);
      const { byProviderItemId } = await loadSnapshot();
      const record = byProviderItemId.get(providerItemId);
      if (!record) {
        throw new Error(`Roam export at ${exportPath} has no page with provider item id ${providerItemId}.`);
      }
      return rawItemFromPageRecord(record, account, nowIso());
    },

    classify(_item: RawItem): SourceSensitivity {
      // Conservative floor (PLAN doctrine): Roam notes default to
      // S4/secure_local. An explicitly configured 'internal' trust domain
      // relaxes the whole archive to S3/internal; nothing per-item.
      return buildSourceSensitivity({
        trustTier: trustDomain === 'internal' ? 'S3' : 'S4',
        trustDomain,
      });
    },
  };
}

function rawItemFromPageRecord(record: RoamPageRecord, account: string, fetchedAt: string): RawItem {
  const identity: SourceItemIdentity = {
    family: 'note',
    provider: CONNECTOR_ID,
    accountScope: account,
    providerItemId: record.providerItemId,
    localItemId: `${account}:${record.providerItemId}`,
    ...(record.updatedAt ? { sourceVersion: record.updatedAt } : {}),
  };
  return {
    identity,
    mimeType: ROAM_PAGE_MIME_TYPE,
    content: record.blockCount === 0
      ? { kind: 'metadata_only' }
      : { kind: 'text', text: record.text },
    metadata: Object.freeze({
      title: record.title,
      blockCount: record.blockCount,
      ...(record.createdAt ? { createdAt: record.createdAt } : {}),
      ...(record.updatedAt ? { updatedAt: record.updatedAt } : {}),
    }),
    fetchedAt,
  };
}

function pageRecordFromExportEntry(entry: unknown, index: number): RoamPageRecord {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`Roam export page at index ${index} is not an object.`);
  }
  const page = entry as Record<string, unknown>;
  const title = typeof page.title === 'string' ? page.title : '';
  const uid = typeof page.uid === 'string' ? page.uid.trim() : '';
  if (!uid && !title.trim()) {
    throw new Error(`Roam export page at index ${index} has neither a uid nor a title; cannot mint a stable identity.`);
  }
  const providerItemId = uid || slugifyTitle(title);
  const flattened = flattenBlockTree(page.children);
  const minCreateTimeMs = earliestMs(epochMs(page['create-time']), flattened.minCreateTimeMs);
  const maxEditTimeMs = latestMs(epochMs(page['edit-time']), flattened.maxEditTimeMs);
  const createdAt = minCreateTimeMs === undefined ? undefined : new Date(minCreateTimeMs).toISOString();
  const updatedAt = maxEditTimeMs === undefined ? undefined : new Date(maxEditTimeMs).toISOString();
  return {
    providerItemId,
    title,
    text: flattened.text,
    blockCount: flattened.blockCount,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}

interface RoamBlockTreeFlattening {
  text: string;
  blockCount: number;
  minCreateTimeMs?: number;
  maxEditTimeMs?: number;
}

// Depth-first, order-preserving flatten of the recursive block tree. Each
// block becomes one bullet line indented two spaces per nesting level; block
// text is kept verbatim (Roam markup like [[refs]], {{todo}}, ** stays).
function flattenBlockTree(children: unknown): RoamBlockTreeFlattening {
  const lines: string[] = [];
  let blockCount = 0;
  let minCreateTimeMs: number | undefined;
  let maxEditTimeMs: number | undefined;
  const walk = (nodes: unknown, depth: number): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null || Array.isArray(node)) continue;
      const block = node as Record<string, unknown>;
      blockCount += 1;
      const text = typeof block.string === 'string' ? block.string : '';
      lines.push(`${'  '.repeat(depth)}- ${text}`);
      minCreateTimeMs = earliestMs(minCreateTimeMs, epochMs(block['create-time']));
      maxEditTimeMs = latestMs(maxEditTimeMs, epochMs(block['edit-time']));
      walk(block.children, depth + 1);
    }
  };
  walk(children, 0);
  return {
    text: lines.join('\n'),
    blockCount,
    ...(minCreateTimeMs !== undefined ? { minCreateTimeMs } : {}),
    ...(maxEditTimeMs !== undefined ? { maxEditTimeMs } : {}),
  };
}

function slugifyTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug) return slug;
  return `page-${createHash('sha256').update(title).digest('hex').slice(0, 16)}`;
}

function providerItemIdFromLocalItemId(localItemId: string, account: string): string {
  const prefix = `${account}:`;
  if (!localItemId.startsWith(prefix) || localItemId.length <= prefix.length) {
    throw new Error(`Roam source connector local item ids look like ${prefix}<provider item id>.`);
  }
  return localItemId.slice(prefix.length);
}

function offsetFromCursor(cursor: string | undefined): number {
  const trimmed = cursor?.trim();
  if (trimmed === undefined || trimmed === '') return 0;
  if (!/^\d+$/.test(trimmed)) {
    throw new Error('Roam source connector cursors are non-negative page-array offsets.');
  }
  return Number.parseInt(trimmed, 10);
}

function epochMs(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function earliestMs(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

function latestMs(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.max(a, b);
}

function normalizePositiveInteger(value: number | undefined, fallback: number, maximum?: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.max(1, Math.floor(value));
  return maximum === undefined ? floored : Math.min(floored, maximum);
}

function requireNonEmpty(value: string, label: string): string {
  const text = value.trim();
  if (!text) throw new Error(`${label} is required.`);
  return text;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nowIso(): string {
  return new Date().toISOString();
}
