// How ready an extraction's stored evidence actually is, scored without touching
// the store.
//
// These predicates are the readable half of the Dropbox QA verdict ladder — the
// half a reader has to agree with before trusting a count. They live outside
// local-index.ts because they are pure: no database handle, no `this`, nothing
// but the row's own numbers, mime type and warnings. The SQL copy of the ladder
// and the TypeScript mirror both lean on them, and `staleRevisionExtractionSql`
// is the one predicate the store cannot express in TypeScript, so it ships as
// the SQL fragment every query site interpolates rather than as a second
// hand-written copy per site.
//
// `dropboxQaVerdictLadderSql` is the whole ladder on the same terms. There used
// to be two hand-written SQL copies of it — the store's counts query and the
// operator dashboard's remote probe — and they drifted until the same row got
// different verdicts in the two places an operator reads (R66 finding 6). Both
// query sites now interpolate this one builder, so they are identical by
// construction and a change can only be made in one place.
//
// EVERY SQL fragment exported from here is interpolated into a Python f-string
// inside the remote probe (scripts/source-ingestion-live-dashboard.ts), so none
// of them may contain `{` or `}`: str.format would read the brace as a
// replacement field and the probe would die on the live host. A test in
// test/dropbox-qa-verdict-ladder.test.ts holds that line.

import type {
  FileExtractionCompleteness,
  FileExtractionStatus,
} from '../../core/source-family.ts';
import { dropboxOutOfContentScopeSql } from './content-scope-policy.ts';

/**
 * Content the store deliberately does not read: the pixels and the shelf.
 *
 * A file matching these is expected to be metadata-only, so on its own it never
 * manufactures operator work — see the ladder's deferral rung for the one thing
 * that changes that.
 */
export const DROPBOX_DEFAULT_DEFERRED_MEDIA_EXTENSIONS = [
  '3gp', 'avi', 'bmp', 'gif', 'heic', 'heif', 'jpeg', 'jpg', 'm4v', 'mov',
  'mp4', 'mpeg', 'mpg', 'png', 'tif', 'tiff', 'webm', 'webp',
] as const;
export const DROPBOX_DEFAULT_DEFERRED_BOOK_EXTENSIONS = [
  'azw', 'azw3', 'azw4', 'cba', 'cb7', 'cbr', 'cbt', 'cbz', 'djv', 'djvu',
  'epub', 'fb2', 'ibooks', 'lit', 'mobi', 'opf',
] as const;
export const DROPBOX_DEFAULT_DEFERRED_BOOK_PATH_SEGMENTS = [
  'audiobooks',
  'book library',
  'books',
  'calibre library',
  'e-books',
  'ebooks',
  'kindle',
] as const;

/**
 * Does this entry's stored text come from bytes the file no longer has?
 *
 * A content extraction job records the revision and content hash it ran
 * against, and its UNIQUE key includes both, so a new revision opens a NEW job
 * row and leaves the old `indexed` one standing. The sync upsert, meanwhile,
 * clears stored content only for a tombstone or for an item that supplies its
 * own `boundedText` — so a metadata-only revision change advances the entry's
 * revision and leaves the previous revision's chunks in place.
 *
 * Both halves of the predicate are load-bearing. "No indexed job for the
 * current bytes" ALONE would flag every entry whose text arrived with the sync
 * item and never had a job at all; requiring positive evidence of an extraction
 * against OLDER bytes means the store only claims staleness it can prove. The
 * chunk table's own `content_hash` is not usable here: `replaceChunks` hashes
 * the chunk text, not the file.
 *
 * Known bound: nothing records WHICH revision the stored chunks came from, so
 * an entry that once had a job-based extraction and then received fresh text
 * from a sync item at the new revision reads as stale until a job indexes those
 * bytes. The live Dropbox sync never supplies `boundedText` (the mapper in
 * live-sync.ts sends metadata only), so this is reachable through the exported
 * sync API rather than the scheduled lane, and it errs toward disclosing.
 *
 * Emits two `?` placeholders, both the provider, in the order they appear.
 */
export function staleRevisionExtractionSql(entryAlias: string): string {
  return `(
    EXISTS (
      SELECT 1
      FROM content_extraction_jobs oj
      WHERE oj.provider = ?
        AND oj.local_entry_id = ${entryAlias}.local_entry_id
        AND oj.status = 'indexed'
        AND (
          COALESCE(oj.revision, '') <> COALESCE(${entryAlias}.revision, '')
          OR COALESCE(oj.content_hash, '') <> COALESCE(${entryAlias}.content_hash, '')
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM content_extraction_jobs cj
      WHERE cj.provider = ?
        AND cj.local_entry_id = ${entryAlias}.local_entry_id
        AND cj.status = 'indexed'
        AND COALESCE(cj.revision, '') = COALESCE(${entryAlias}.revision, '')
        AND COALESCE(cj.content_hash, '') = COALESCE(${entryAlias}.content_hash, '')
    )
  )`;
}

/**
 * Is there an indexed local VLM PDF job against the bytes this entry holds now?
 *
 * The raster-OCR escalation rungs use it to stop re-escalating a document the
 * VLM lane has already transcribed. Emits one `?` placeholder, the provider.
 */
export function dropboxLocalVlmPdfIndexedJobsSql(entryAlias: string): string {
  return `CASE WHEN EXISTS (
      SELECT 1
      FROM content_extraction_jobs vj
      WHERE vj.provider = ?
        AND vj.local_entry_id = ${entryAlias}.local_entry_id
        AND vj.revision = COALESCE(${entryAlias}.revision, '')
        AND vj.content_hash = COALESCE(${entryAlias}.content_hash, '')
        AND vj.extractor_kind = 'local_vlm_pdf'
        AND vj.status = 'indexed'
    ) THEN 1 ELSE 0 END`;
}

/**
 * The SQL twin of `minimumUsefulExtractionChars`. It is an INPUT to the ladder
 * rather than part of it, but a ladder rung that compares `text_char_count`
 * against a differently-defined threshold in each copy disagrees about real
 * rows while both copies contain the identical rung — so the threshold ships
 * from here too.
 */
export function minimumUsefulExtractionCharsSql(entryAlias: string): string {
  const mime = `lower(${entryAlias}.mime_type)`;
  return `CASE
      WHEN ${entryAlias}.size_bytes IS NOT NULL AND ${entryAlias}.size_bytes <= 512 THEN 0
      WHEN ${entryAlias}.mime_type IS NULL OR TRIM(${entryAlias}.mime_type) = '' THEN 0
      WHEN ${mime} LIKE 'image/%' OR ${mime} LIKE 'video/%' THEN 0
      WHEN ${mime} = 'application/pdf' THEN 120
      WHEN ${mime} LIKE '%wordprocessingml%' OR ${mime} = 'application/msword' THEN 120
      WHEN ${mime} LIKE '%presentationml%' OR ${mime} = 'application/vnd.ms-powerpoint' THEN 120
      WHEN ${mime} LIKE '%spreadsheet%' OR ${mime} LIKE '%excel%' OR ${mime} = 'application/vnd.ms-excel' THEN 80
      WHEN ${mime} LIKE '%csv%' THEN 80
      ELSE 0
    END`;
}

/**
 * Content the store expects to hold as metadata only, expressed against the
 * ladder's own `mime_type_lower` / `path_lower` columns.
 */
export function defaultDeferredContentReadinessSql(): string {
  return [
    "mime_type_lower LIKE 'image/%'",
    "mime_type_lower LIKE 'video/%'",
    ...DROPBOX_DEFAULT_DEFERRED_MEDIA_EXTENSIONS.map((extension) => `path_lower LIKE '%.${extension}'`),
    ...DROPBOX_DEFAULT_DEFERRED_BOOK_EXTENSIONS.map((extension) => `path_lower LIKE '%.${extension}'`),
    ...DROPBOX_DEFAULT_DEFERRED_BOOK_PATH_SEGMENTS.map((segment) => `path_lower LIKE '%/${segment}/%'`),
  ].join('\n                OR ');
}

/**
 * The one QA verdict ladder, as a SQL CASE expression over a `ledger` row.
 *
 * Interpolated by the store's counts query and by the operator dashboard's
 * remote probe. It binds NO parameters on purpose: a call site can drop it
 * anywhere in its query without renumbering its own placeholders.
 *
 * The columns it reads must be present, and mean the same thing, in every
 * caller's `ledger` CTE: extraction_status, extraction_completeness,
 * mime_type_lower, path_lower, size_bytes, chunk_count, text_char_count,
 * artifact_count, artifact_text_count, artifact_kinds, fact_count,
 * min_confidence, warning_blob, minimum_useful_chars, local_vlm_pdf_indexed_jobs,
 * stale_revision_extraction, blocked_policy_jobs, failed_retryable_jobs,
 * failed_terminal_jobs, pending_jobs.
 *
 * `contentScopePathPrefixes` are the approved content-lane folders, lowercased
 * and rooted (see content-scope-policy.ts). They come from the operator's own
 * configuration and default to none, which builds exactly the ladder that
 * existed before the scope rung: every call site that cannot name the policy
 * scores every row the way it always did.
 */
export function dropboxQaVerdictLadderSql(
  contentScopePathPrefixes: readonly string[] = [],
): string {
  return `CASE
              WHEN extraction_status = 'blocked_policy' OR blocked_policy_jobs > 0 THEN 'qa_blocked_policy'
              -- Staleness outranks a page gap. If the bytes moved, the stored
              -- text AND the gaps recorded against it describe a version of the
              -- file that no longer exists, so "this is from an older version"
              -- is the truer thing to say about it than "some of its pages
              -- could not be read".
              WHEN stale_revision_extraction = 1 AND (chunk_count > 0 OR artifact_count > 0 OR fact_count > 0) THEN 'qa_stale_revision'
              -- Ahead of the default-deferred rung AND of every pass rung. A
              -- document that produced content and a real durable gap was
              -- extracted incompletely; calling it "metadata-only, as expected"
              -- because it sits under /Books/ hides a reviewable gap (R65
              -- finding 5).
              WHEN extraction_status = 'extracted' AND extraction_completeness = 'partial' THEN 'qa_partial_pages_gap'
              -- Outside the folders the content lanes are pointed at. Nothing
              -- ever asked for this file's text, so its missing text is policy
              -- rather than a gap — the owner ruling of 2026-08-21, expressed
              -- where the verdict is decided instead of subtracted back out on
              -- the card.
              --
              -- Qualified exactly like the deferral rung below, and for the
              -- same reason: scope explains an ABSENCE of evidence, never the
              -- presence of one. A file someone extracted anyway keeps the
              -- verdict its extraction earned, so it stays in both the
              -- numerator and the denominator and the ratio cannot climb past
              -- 100 by counting a pass it excluded. With no chunks, artifacts
              -- or facts the row also carries no warnings — warning_blob is
              -- built from artifact rows — so no escalation rung below can be
              -- stolen by this one either.
              WHEN ${dropboxOutOfContentScopeSql(contentScopePathPrefixes)} = 1
                AND chunk_count = 0
                AND artifact_count = 0
                AND fact_count = 0
                AND failed_terminal_jobs = 0
                AND failed_retryable_jobs = 0
                AND pending_jobs = 0
              THEN 'qa_out_of_content_scope'
              -- Deferral keeps its early position, so a deferred file nobody
              -- tried to extract stays out of needs-review: a file the system
              -- deliberately does not read should not manufacture operator
              -- work. But the rung is QUALIFIED, not merely ordered. A job only
              -- exists because something asked for one, so a deferred file
              -- whose extraction was actually attempted keeps whatever verdict
              -- the attempt earned it. Before this, the store called such a row
              -- "metadata-only, as expected" and hid a real terminal failure
              -- that the dashboard's copy of the ladder was reporting.
              WHEN (
                ${defaultDeferredContentReadinessSql()}
              )
                AND failed_terminal_jobs = 0
                AND failed_retryable_jobs = 0
                AND pending_jobs = 0
              THEN 'qa_metadata_only_expected'
              WHEN extraction_status = 'failed' AND failed_terminal_jobs > 0 THEN 'qa_failed_needs_operator'
              WHEN extraction_status <> 'extracted' AND (pending_jobs > 0 OR failed_retryable_jobs > 0) THEN 'qa_pending'
              WHEN mime_type_lower = 'application/pdf'
                AND local_vlm_pdf_indexed_jobs = 0
                AND (
                  warning_blob LIKE '%"ocrmypdf_pdf_rejected"%'
                  OR warning_blob LIKE '%"ocrmypdf_pdf_encrypted"%'
                  OR warning_blob LIKE '%"ocrmypdf_pdf_signed"%'
                  OR warning_blob LIKE '%"ocrmypdf_pdf_invalid"%'
                  OR warning_blob LIKE '%"vlm_pdf_required"%'
                )
              THEN 'qa_raster_ocr_vlm_escalation'
              WHEN extraction_status = 'extracted'
                AND COALESCE(extraction_completeness, 'complete') = 'complete'
                AND mime_type_lower = 'application/pdf'
                AND (',' || artifact_kinds || ',') LIKE '%,image_ocr,%'
                AND warning_blob LIKE '%"ocr_source_rasterized_pdf"%'
                AND local_vlm_pdf_indexed_jobs = 0
              THEN 'qa_raster_ocr_vlm_escalation'
              WHEN warning_blob LIKE '%"ocr_required"%' OR warning_blob LIKE '%"pdf_image_only"%' OR warning_blob LIKE '%"image_only"%' OR warning_blob LIKE '%"vlm_empty"%' THEN 'qa_low_confidence_candidate_for_venice'
              WHEN warning_blob LIKE '%"ocr_empty"%' OR warning_blob LIKE '%"document_fact_extraction_failed"%' OR warning_blob LIKE '%"row_sample_truncated"%' OR warning_blob LIKE '%"column_sample_truncated"%' OR (min_confidence IS NOT NULL AND min_confidence < 0.55) THEN 'qa_low_confidence_retry_local'
              WHEN (chunk_count > 0 OR artifact_text_count > 0 OR fact_count > 0) AND fact_count = 0 AND minimum_useful_chars > 0 AND text_char_count > 0 AND text_char_count < minimum_useful_chars THEN 'qa_low_confidence_retry_local'
              WHEN chunk_count > 0 OR artifact_text_count > 0 OR fact_count > 0 THEN 'qa_pass'
              WHEN extraction_status = 'metadata_only' AND (
                size_bytes = 0
                OR (
                  mime_type_lower <> ''
                  -- No 'image/%' in this list, matching metadataOnlyIsExpected.
                  -- It used to be here and it used to be dead: nothing with an
                  -- image mime type could get past the deferral rung to reach
                  -- this one. Qualifying that rung makes this reachable, and a
                  -- picture the store holds as metadata is metadata-only
                  -- exactly as expected.
                  AND NOT (
                    mime_type_lower LIKE 'text/%'
                    OR mime_type_lower = 'application/pdf'
                    OR mime_type_lower IN ('application/json', 'application/xml', 'application/rtf', 'application/msword', 'application/vnd.ms-excel', 'application/vnd.ms-powerpoint')
                    OR mime_type_lower LIKE '%csv%'
                    OR mime_type_lower LIKE '%spreadsheet%'
                    OR mime_type_lower LIKE '%excel%'
                    OR mime_type_lower LIKE '%wordprocessingml%'
                    OR mime_type_lower LIKE '%presentationml%'
                  )
                )
              ) THEN 'qa_metadata_only_expected'
              WHEN extraction_status = 'metadata_only' THEN 'qa_metadata_only_gap'
              WHEN extraction_status = 'extracted' AND fact_count = 0 AND minimum_useful_chars > 0 AND text_char_count > 0 AND text_char_count < minimum_useful_chars THEN 'qa_low_confidence_retry_local'
              WHEN extraction_status = 'extracted' AND (chunk_count > 0 OR artifact_text_count > 0 OR fact_count > 0) THEN 'qa_pass'
              WHEN extraction_status IN ('skipped_unsupported', 'skipped_too_large') THEN 'qa_metadata_only_expected'
              WHEN artifact_count > 0 OR fact_count > 0 THEN 'qa_pass'
              ELSE 'qa_metadata_only_gap'
            END`;
}

export function rasterOcrNeedsLocalVlmPdfEscalation(
  input: {
    extractionStatus: FileExtractionStatus;
    extractionCompleteness?: FileExtractionCompleteness;
    mimeType?: string;
    artifactKinds: ReadonlySet<string>;
    minConfidence?: number;
    localVlmPdfIndexedJobs: number;
  },
  warnings: ReadonlySet<string>,
): boolean {
  if (ocrmypdfRejectionNeedsLocalVlmPdfEscalation(input, warnings)) return true;
  if (input.extractionStatus !== 'extracted') return false;
  // Rows migrated before WO-35 carry NULL/undefined completeness; an
  // 'extracted' row derives to 'complete' (see extractionCompletenessFromStatus).
  if ((input.extractionCompleteness ?? 'complete') !== 'complete') return false;
  if (input.mimeType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/pdf') return false;
  if (!input.artifactKinds.has('image_ocr')) return false;
  if (!warnings.has('ocr_source_rasterized_pdf')) return false;
  if (input.localVlmPdfIndexedJobs > 0) return false;
  // Deliberately no confidence condition, matching the SQL rung.
  //
  // This used to end `minConfidence === undefined || minConfidence <= 0.5`,
  // which the SQL copy never had. The threshold was calibrated to tesseract's
  // hardcoded 0.5 for this class, but it decided the rung on a number that is
  // not what the rung is about, and it broke in both directions for anything
  // else: at 0.52 the document fell through to `qa_low_confidence_retry_local`
  // — whose sweep re-runs the SAME tesseract recipe that produced this text,
  // the exact loop WO-36 added this rung to break — and at 0.55 it read
  // `qa_pass`, so a page-image PDF nothing had read properly looked finished.
  //
  // The conditions above already say the whole thing: text lifted off a page
  // image by OCR, from a PDF, that the VLM lane has never read. That is the
  // escalation criterion, and how confident the OCR claimed to be about text
  // it could not verify adds nothing to it.
  return true;
}

export function ocrmypdfRejectionNeedsLocalVlmPdfEscalation(
  input: {
    mimeType?: string;
    localVlmPdfIndexedJobs: number;
  },
  warnings: ReadonlySet<string>,
): boolean {
  if (input.mimeType?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/pdf') return false;
  if (input.localVlmPdfIndexedJobs > 0) return false;
  return warnings.has('ocrmypdf_pdf_rejected')
    || warnings.has('ocrmypdf_pdf_encrypted')
    || warnings.has('ocrmypdf_pdf_signed')
    || warnings.has('ocrmypdf_pdf_invalid')
    || warnings.has('vlm_pdf_required');
}

export function hasUsableExtractionEvidence(input: {
  chunkCount: number;
  artifactTextCount: number;
  factCount: number;
}): boolean {
  return input.chunkCount > 0 || input.artifactTextCount > 0 || input.factCount > 0;
}

/**
 * Anything an extraction left behind, text-bearing or not. Wider than
 * `hasUsableExtractionEvidence` because the last qa_pass rung in the ladder
 * passes on `artifactCount` alone: a stale entry has to be caught there too.
 */
export function hasStoredExtractionEvidence(input: {
  chunkCount: number;
  artifactCount: number;
  factCount: number;
}): boolean {
  return input.chunkCount > 0 || input.artifactCount > 0 || input.factCount > 0;
}

export function richExtractionNeedsLocalRetry(input: {
  mimeType?: string;
  sizeBytes?: number;
  textCharCount: number;
  factCount: number;
}): boolean {
  if (input.factCount > 0) return false;
  const minimumChars = minimumUsefulExtractionChars(input.mimeType, input.sizeBytes);
  return minimumChars > 0 && input.textCharCount > 0 && input.textCharCount < minimumChars;
}

export function minimumUsefulExtractionChars(mimeType: string | undefined, sizeBytes: number | undefined): number {
  if (sizeBytes !== undefined && sizeBytes <= 512) return 0;
  if (!mimeType) return 0;
  const mime = mimeType.toLowerCase();
  if (mime === 'application/pdf') return 120;
  if (mime.startsWith('image/') || mime.startsWith('video/')) return 0;
  if (mime.includes('wordprocessingml') || mime === 'application/msword') return 120;
  if (mime.includes('presentationml') || mime === 'application/vnd.ms-powerpoint') return 120;
  if (mime.includes('spreadsheet') || mime.includes('excel') || mime === 'application/vnd.ms-excel') return 80;
  if (mime.includes('csv')) return 80;
  return 0;
}

export function hasVeniceCandidateWarning(warnings: ReadonlySet<string>): boolean {
  return warnings.has('ocr_required')
    || warnings.has('pdf_image_only')
    || warnings.has('image_only')
    || warnings.has('vlm_empty');
}

export function hasRetryLocalWarning(warnings: ReadonlySet<string>): boolean {
  return warnings.has('ocr_empty')
    || warnings.has('document_fact_extraction_failed')
    || warnings.has('row_sample_truncated')
    || warnings.has('column_sample_truncated');
}

export function metadataOnlyIsExpected(mimeType: string | undefined, sizeBytes: number | undefined): boolean {
  if (sizeBytes === 0) return true;
  if (!mimeType) return false;
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('text/')) return false;
  if (mime.startsWith('image/') || mime.startsWith('video/')) return true;
  if (mime === 'application/pdf') return false;
  if (mime === 'application/json' || mime === 'application/xml' || mime === 'application/rtf') return false;
  if (mime.includes('csv') || mime.includes('spreadsheet') || mime.includes('excel')) return false;
  if (mime.includes('wordprocessingml') || mime.includes('presentationml')) return false;
  if (mime === 'application/msword' || mime === 'application/vnd.ms-excel' || mime === 'application/vnd.ms-powerpoint') {
    return false;
  }
  return true;
}
