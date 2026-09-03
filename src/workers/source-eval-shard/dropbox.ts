import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { DROPBOX_FILES_CORPUS_ID } from '../dropbox-files/corpus-adapter.ts';
import {
  DropboxApiContentDownloadClient,
  type DropboxContentDownloadClient,
} from '../dropbox-files/provider-client.ts';
import { renderPdfPages } from '../file-extraction/extractors/pdf-render.ts';
import type { ExtractionCommandRunner } from '../file-extraction/extractors/command-runner.ts';
import { createEnvCredentialBroker, type CredentialBroker } from '../credential-broker/index.ts';
import type { SourceTrustTier } from '../../core/source-index/types.ts';
import type {
  ConnectorStoreExtractionCandidatePage,
  ConnectorStoreLocalContent,
} from '../connector-store/index.ts';
import { DROPBOX_APPROVED_SCOPE_FILTER_CODEC } from '../dropbox-files/approved-scope-filter.ts';

const GROUND_TRUTH_EXCERPT_CHARS = 4_000;
const EVAL_SHARD_MAX_COUNT = 10_000;

export type DropboxContentExtractionRetargetTier = SourceTrustTier | 'unknown';

export interface DropboxEvalShardCandidateRequest {
  account?: string;
  approved_scope_key: string;
}

export interface DropboxEvalShardCandidate {
  local_entry_id: string | number;
  provider_file_id: string;
  doc_id_hash: string;
  privacy_allowed: boolean;
  privacy_tier: DropboxContentExtractionRetargetTier;
  privacy_reason: string;
  artifact_text: string;
  extractor_kind: string;
  revision?: string;
  content_hash?: string;
  name?: string;
  mime_type?: string;
  size_bytes?: number;
}

export interface DropboxEvalShardExportRequest extends DropboxEvalShardCandidateRequest {
  count: number;
  out_dir: string;
  doc_types?: string[];
  dry_run?: boolean;
}

export interface DropboxEvalShardSidecar {
  schema_version: 1;
  doc_id_hash: string;
  page_number: number;
  privacy_tier: DropboxContentExtractionRetargetTier;
  doc_type: string;
  ground_truth_status: 'draft';
  ground_truth_text: string;
  /**
   * Scope of `ground_truth_text` relative to this page image.
   * - 'page': the text covers exactly this page (single-page documents).
   * - 'document': document-level extraction text stamped onto one page of a
   *   multi-page document; it does NOT correspond page-for-page and must not
   *   be used as a per-page answer key.
   */
  text_scope: 'document' | 'page';
  extractor_kind: string;
}

export interface DropboxEvalShardSkippedDocument {
  doc_id_hash: string;
  reason: string;
}

export interface DropboxEvalShardManifestItem {
  doc_id_hash: string;
  privacy_tier: DropboxContentExtractionRetargetTier;
  doc_type: string;
  size_bucket: 'small' | 'medium' | 'large' | 'unknown';
  outcome: 'would_export' | 'exported';
  pages: number[];
}

export interface DropboxEvalShardManifest {
  schema_version: 1;
  kind: 'dropbox_eval_shard_export';
  corpus_id: typeof DROPBOX_FILES_CORPUS_ID;
  account: string;
  scope_key_hash: string;
  out_dir: string;
  requested_count: number;
  eligible_pool_documents: number;
  selected_documents: number;
  exported_documents: number;
  exported_pages: number;
  counts_by_tier: Record<string, number>;
  counts_by_type: Record<string, number>;
  skipped_documents: DropboxEvalShardSkippedDocument[];
  items: DropboxEvalShardManifestItem[];
  dry_run: boolean;
  policy: {
    worker_private_surface: true;
    s5_excluded: true;
    blocked_sensitive_excluded: true;
    local_models_allowed: true;
    venice_review_allowed_through_s4: true;
    ground_truth_status: 'draft';
  };
}

export interface DropboxEvalShardIndex {
  evalShardCandidates(request: DropboxEvalShardCandidateRequest): DropboxEvalShardCandidate[];
  evalShardPrivacyDecision(localEntryId: string | number): {
    allowed: boolean;
    tier: DropboxContentExtractionRetargetTier;
    reason: string;
  };
}

export interface DropboxEvalShardConnectorStore {
  extractionCandidates(options: {
    limit: number;
    cursor?: string;
    mimeTypes?: readonly string[];
    accountScope?: string;
  }): ConnectorStoreExtractionCandidatePage;
  localContent(localItemId: string, maxChars?: number): ConnectorStoreLocalContent | undefined;
}

/**
 * Read the protected-evaluation pool from the canonical connector store.
 *
 * The adapter owns the Dropbox scope-key/path comparison; the shared store
 * remains source-neutral and exposes only identities, trust, and bounded
 * chunks. Re-reading `localContent` immediately before export preserves the
 * old fail-closed privacy check without consulting the retired legacy index.
 */
export function createDropboxConnectorStoreEvalShardSource(
  store: DropboxEvalShardConnectorStore,
): DropboxEvalShardIndex {
  return {
    evalShardCandidates(request) {
      const account = request.account?.trim() || 'personal';
      const scope = DROPBOX_APPROVED_SCOPE_FILTER_CODEC.resolveLocatorPath(
        request.approved_scope_key,
        { provider: 'dropbox', accountScope: account },
      );
      if (scope.kind === 'invalid') throw new Error(scope.message);

      const candidates: DropboxEvalShardCandidate[] = [];
      let cursor: string | undefined;
      while (candidates.length < EVAL_SHARD_MAX_COUNT) {
        const page = store.extractionCandidates({
          limit: 5_000,
          ...(cursor ? { cursor } : {}),
          accountScope: scope.accountScope,
          mimeTypes: ['application/pdf', 'image/png'],
        });
        for (const item of page.candidates) {
          if (item.identity.provider !== 'dropbox' || !item.locatorUri) continue;
          if (!locatorWithinScope(item.locatorUri, scope.locatorPath)) continue;
          const content = store.localContent(item.identity.localItemId, GROUND_TRUTH_EXCERPT_CHARS);
          if (!content || content.storedChunks === 0) continue;
          const artifactText = content.chunks.map((chunk) => chunk.trim()).filter(Boolean).join('\n\n');
          if (!artifactText) continue;
          const privacy = evalShardPrivacyDecision(content.trustTier);
          const providerFileId = item.identity.providerFileId ?? item.identity.providerItemId;
          candidates.push({
            local_entry_id: item.identity.localItemId,
            provider_file_id: providerFileId,
            doc_id_hash: createHash('sha256').update(providerFileId).digest('hex'),
            privacy_allowed: privacy.allowed,
            privacy_tier: privacy.tier,
            privacy_reason: privacy.reason,
            artifact_text: artifactText,
            extractor_kind: 'connector_store_chunks',
            ...(item.identity.sourceVersion ? { revision: item.identity.sourceVersion } : {}),
            ...(item.contentHash ? { content_hash: item.contentHash } : {}),
            ...(item.name ? { name: item.name } : {}),
            ...(item.mimeType ? { mime_type: item.mimeType } : {}),
          });
          if (candidates.length === EVAL_SHARD_MAX_COUNT) break;
        }
        if (page.done || !page.nextCursor || candidates.length === EVAL_SHARD_MAX_COUNT) break;
        cursor = page.nextCursor;
      }
      return candidates;
    },
    evalShardPrivacyDecision(localEntryId) {
      if (typeof localEntryId !== 'string' || !localEntryId.trim()) {
        return { allowed: false, tier: 'unknown', reason: 'connector_store_item_identity_invalid' };
      }
      const content = store.localContent(localEntryId, 1);
      if (!content) {
        return { allowed: false, tier: 'unknown', reason: 'connector_store_item_missing' };
      }
      return evalShardPrivacyDecision(content.trustTier);
    },
  };
}

export interface DropboxEvalShardExportHandlerOptions {
  source: DropboxEvalShardIndex;
  downloader?: DropboxContentDownloadClient;
  broker?: CredentialBroker;
  credentialHandle?: string;
  renderCommandRunner?: ExtractionCommandRunner;
  infoCommandRunner?: ExtractionCommandRunner;
}

export interface DropboxEvalShardExportHandler {
  export(request: DropboxEvalShardExportRequest): Promise<DropboxEvalShardManifest>;
}

async function createEvalShardDownloader(
  options: Pick<DropboxEvalShardExportHandlerOptions, 'broker' | 'credentialHandle'>,
): Promise<DropboxContentDownloadClient> {
  const broker = options.broker ?? createEnvCredentialBroker();
  const handle = options.credentialHandle ?? 'dropbox.personal';
  const session = await broker.issueSession({
    handle,
    provider: 'dropbox',
    capability: 'dropbox.files.read',
    trustDomain: 'secure_local',
    purpose: 'Read an approved Dropbox document for a private evaluation shard.',
  });
  if (session.kind !== 'bearer_token') {
    throw new Error(`Credential handle ${handle} did not issue a Dropbox bearer token session.`);
  }
  return new DropboxApiContentDownloadClient({ token: session.token });
}

export function createDropboxEvalShardExportHandler(
  options: DropboxEvalShardExportHandlerOptions,
): DropboxEvalShardExportHandler {
  return {
    async export(request) {
      const normalized = normalizeRequest(request);
      const candidates = options.source.evalShardCandidates({
        account: normalized.account,
        approved_scope_key: normalized.approved_scope_key,
      });
      const skippedDocuments: DropboxEvalShardSkippedDocument[] = [];
      const eligible: Array<DropboxEvalShardCandidate & {
        doc_type: string;
        size_bucket: DropboxEvalShardManifestItem['size_bucket'];
      }> = [];

      for (const candidate of candidates) {
        if (!candidate.privacy_allowed) {
          skippedDocuments.push({ doc_id_hash: candidate.doc_id_hash, reason: candidate.privacy_reason });
          continue;
        }
        const docType = candidateDocType(candidate);
        if (normalized.doc_types && !normalized.doc_types.has(docType)) {
          skippedDocuments.push({ doc_id_hash: candidate.doc_id_hash, reason: `doc_type_filtered:${docType}` });
          continue;
        }
        if (docType !== 'pdf' && docType !== 'png') {
          skippedDocuments.push({ doc_id_hash: candidate.doc_id_hash, reason: `unsupported_raster_doc_type:${docType}` });
          continue;
        }
        eligible.push({ ...candidate, doc_type: docType, size_bucket: sizeBucket(candidate.size_bytes) });
      }

      const selected = stratifiedSelection(eligible, normalized.count);
      const items: DropboxEvalShardManifestItem[] = [];
      if (normalized.dry_run) {
        for (const candidate of selected) {
          items.push({
            doc_id_hash: candidate.doc_id_hash,
            privacy_tier: candidate.privacy_tier,
            doc_type: candidate.doc_type,
            size_bucket: candidate.size_bucket,
            outcome: 'would_export',
            pages: candidate.doc_type === 'pdf' ? [1, 2] : [1],
          });
        }
      } else {
        await mkdir(normalized.out_dir, { recursive: true });
        const downloader = options.downloader ?? await createEvalShardDownloader(options);
        for (const candidate of selected) {
          const privacy = options.source.evalShardPrivacyDecision(candidate.local_entry_id);
          if (!privacy.allowed) {
            skippedDocuments.push({
              doc_id_hash: candidate.doc_id_hash,
              reason: `privacy_eligibility_changed_before_export:${privacy.reason}`,
            });
            continue;
          }
          try {
            const downloaded = await downloader.download({
              job: {
                provider_file_id: candidate.provider_file_id,
                ...(candidate.revision ? { revision: candidate.revision } : {}),
              },
            });
            const rendered = candidate.doc_type === 'pdf'
              ? await renderPdfPages({
                  bytes: downloaded.bytes,
                  maxPages: 2,
                  outputFormat: 'png',
                  ...(options.renderCommandRunner ? { renderCommandRunner: options.renderCommandRunner } : {}),
                  ...(options.infoCommandRunner ? { infoCommandRunner: options.infoCommandRunner } : {}),
                })
              : {
                  pages: [{ pageNumber: 1, bytes: assertPng(downloaded.bytes), mime_type: 'image/png' as const, dpi: 180 }],
                  totalPages: 1,
                };
            const pages = rendered.pages;
            await replaceDocumentOutputs(normalized.out_dir, candidate, pages, rendered.totalPages);
            items.push({
              doc_id_hash: candidate.doc_id_hash,
              privacy_tier: privacy.tier,
              doc_type: candidate.doc_type,
              size_bucket: candidate.size_bucket,
              outcome: 'exported',
              pages: pages.map((page) => page.pageNumber),
            });
          } catch (error) {
            skippedDocuments.push({
              doc_id_hash: candidate.doc_id_hash,
              reason: `export_failed:${safeErrorKind(error)}`,
            });
          }
        }
      }

      const manifest = buildManifest(normalized, eligible.length, selected.length, items, skippedDocuments);
      if (!normalized.dry_run) {
        await atomicJsonWrite(join(normalized.out_dir, 'manifest.json'), manifest);
      }
      return manifest;
    },
  };
}

async function replaceDocumentOutputs(
  outDir: string,
  candidate: DropboxEvalShardCandidate & { doc_type: string },
  pages: Array<{ pageNumber: number; bytes: Uint8Array }>,
  documentPageCount: number | undefined,
): Promise<void> {
  for (const pageNumber of [1, 2]) {
    await rm(join(outDir, `${candidate.doc_id_hash}-p${pageNumber}.png`), { force: true });
    await rm(join(outDir, `${candidate.doc_id_hash}-p${pageNumber}.json`), { force: true });
  }
  // The index stores one document-level extraction text; there is no per-page
  // text. Label the scope honestly so downstream answer-key drafting never
  // treats document text as page text on multi-page documents.
  const textScope: DropboxEvalShardSidecar['text_scope'] =
    Math.max(documentPageCount ?? 0, pages.length) > 1 ? 'document' : 'page';
  for (const page of pages) {
    const stem = `${candidate.doc_id_hash}-p${page.pageNumber}`;
    await atomicWrite(join(outDir, `${stem}.png`), page.bytes);
    const sidecar: DropboxEvalShardSidecar = {
      schema_version: 1,
      doc_id_hash: candidate.doc_id_hash,
      page_number: page.pageNumber,
      privacy_tier: candidate.privacy_tier,
      doc_type: candidate.doc_type,
      ground_truth_status: 'draft',
      ground_truth_text: candidate.artifact_text.slice(0, GROUND_TRUTH_EXCERPT_CHARS),
      text_scope: textScope,
      extractor_kind: candidate.extractor_kind,
    };
    await atomicJsonWrite(join(outDir, `${stem}.json`), sidecar);
  }
}

function buildManifest(
  request: ReturnType<typeof normalizeRequest>,
  eligiblePoolDocuments: number,
  selectedDocuments: number,
  items: DropboxEvalShardManifestItem[],
  skippedDocuments: DropboxEvalShardSkippedDocument[],
): DropboxEvalShardManifest {
  const countsByTier: Record<string, number> = {};
  const countsByType: Record<string, number> = {};
  for (const item of items) {
    countsByTier[item.privacy_tier] = (countsByTier[item.privacy_tier] ?? 0) + 1;
    countsByType[item.doc_type] = (countsByType[item.doc_type] ?? 0) + 1;
  }
  const exported = items.filter((item) => item.outcome === 'exported');
  return {
    schema_version: 1,
    kind: 'dropbox_eval_shard_export',
    corpus_id: DROPBOX_FILES_CORPUS_ID,
    account: request.account,
    scope_key_hash: createHash('sha256').update(request.approved_scope_key).digest('hex'),
    out_dir: request.out_dir,
    requested_count: request.count,
    eligible_pool_documents: eligiblePoolDocuments,
    selected_documents: selectedDocuments,
    exported_documents: exported.length,
    exported_pages: exported.reduce((total, item) => total + item.pages.length, 0),
    counts_by_tier: countsByTier,
    counts_by_type: countsByType,
    skipped_documents: skippedDocuments,
    items,
    dry_run: request.dry_run,
    policy: {
      worker_private_surface: true,
      s5_excluded: true,
      blocked_sensitive_excluded: true,
      local_models_allowed: true,
      venice_review_allowed_through_s4: true,
      ground_truth_status: 'draft',
    },
  };
}

function stratifiedSelection<T extends { doc_type: string; size_bucket: string; doc_id_hash: string }>(
  candidates: T[],
  count: number,
): T[] {
  const strata = new Map<string, T[]>();
  for (const candidate of candidates) {
    const key = `${candidate.doc_type}:${candidate.size_bucket}`;
    const rows = strata.get(key);
    if (rows) rows.push(candidate);
    else strata.set(key, [candidate]);
  }
  const queues = [...strata.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, rows]) => rows.sort((left, right) => left.doc_id_hash.localeCompare(right.doc_id_hash)));
  const selected: T[] = [];
  while (selected.length < count && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next) selected.push(next);
      if (selected.length >= count) break;
    }
  }
  return selected;
}

function normalizeRequest(request: DropboxEvalShardExportRequest): {
  account: string;
  approved_scope_key: string;
  count: number;
  out_dir: string;
  doc_types?: Set<string>;
  dry_run: boolean;
} {
  const approvedScopeKey = request.approved_scope_key?.trim();
  if (!approvedScopeKey) throw new Error('Dropbox eval shard export requires an explicit approved folder/root scope.');
  if (!Number.isSafeInteger(request.count) || request.count <= 0 || request.count > EVAL_SHARD_MAX_COUNT) {
    throw new Error(`Dropbox eval shard export count must be an integer from 1 to ${EVAL_SHARD_MAX_COUNT}.`);
  }
  const outDir = request.out_dir?.trim();
  if (!outDir) throw new Error('Dropbox eval shard export requires an output directory.');
  const docTypes = request.doc_types?.map(normalizeDocType).filter(Boolean);
  if (request.doc_types && (!docTypes || docTypes.length === 0)) {
    throw new Error('Dropbox eval shard export doc_types must contain at least one type.');
  }
  return {
    account: request.account?.trim() || 'personal',
    approved_scope_key: approvedScopeKey,
    count: request.count,
    out_dir: resolve(outDir),
    ...(docTypes ? { doc_types: new Set(docTypes) } : {}),
    dry_run: request.dry_run ?? true,
  };
}

function candidateDocType(candidate: Pick<DropboxEvalShardCandidate, 'mime_type' | 'name'>): string {
  const mime = candidate.mime_type?.trim().toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/jpeg') return 'jpeg';
  return normalizeDocType(extname(candidate.name ?? '').slice(1)) || 'unknown';
}

function normalizeDocType(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/^\./, '');
  if (normalized === 'application/pdf') return 'pdf';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/jpeg' || normalized === 'jpg') return 'jpeg';
  return normalized.replace(/[^a-z0-9_+-]/g, '');
}

function locatorWithinScope(locatorUri: string, locatorPath: string): boolean {
  const locator = locatorUri.trim().toLowerCase();
  const scope = locatorPath.trim().toLowerCase();
  return scope === '/' || locator === scope || locator.startsWith(`${scope}/`);
}

function evalShardPrivacyDecision(
  tier: SourceTrustTier,
): { allowed: boolean; tier: SourceTrustTier; reason: string } {
  if (tier === 'S5') {
    return { allowed: false, tier, reason: 'privacy_tier_s5_cloud_refused' };
  }
  return { allowed: true, tier, reason: 'privacy_tier_cloud_eligible' };
}

function sizeBucket(size: number | undefined): DropboxEvalShardManifestItem['size_bucket'] {
  if (size === undefined || !Number.isFinite(size) || size < 0) return 'unknown';
  if (size < 1_000_000) return 'small';
  if (size < 10_000_000) return 'medium';
  return 'large';
}

function assertPng(bytes: Uint8Array): Uint8Array {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.byteLength < signature.length || signature.some((byte, index) => bytes[index] !== byte)) {
    throw new Error('invalid_png_bytes');
  }
  return bytes;
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`));
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const tempPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, bytes);
    await rename(tempPath, path);
  } finally {
    await rm(tempPath, { force: true });
  }
}

function safeErrorKind(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message === 'invalid_png_bytes') return message;
  if (/pdftoppm|render/i.test(message)) return 'raster_failed';
  if (/download|dropbox content api/i.test(message)) return 'download_failed';
  return 'unknown';
}
