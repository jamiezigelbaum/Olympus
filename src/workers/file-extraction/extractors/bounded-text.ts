/**
 * Text bounding, normalization, warning and derivation helpers shared by every
 * extractor in this directory.
 *
 * Ported from the production content-extraction lane, behaviour first. The
 * numbers and the warning tokens here are live vocabulary: they appear in
 * stored artifact rows today, so changing one is a data change, not a tuning
 * knob.
 *
 * Two directory rules shape the file and are worth restating where they will
 * be read:
 *
 *   - Doc comments are ALWAYS multi-line blocks. The architecture guard's
 *     regex-literal heuristic reads a trimmed line that starts and ends with
 *     a slash as a regex literal, so a one-line block comment is an offender.
 *   - Every regular expression lives inside a NAMED function declaration, and
 *     that name is enrolled in the guard's allowlist for this file. A regex at
 *     module level is attributed to top-level and can never be allowlisted.
 */

import type {
  ExtractionArtifactKind,
  ExtractionDerivation,
  ExtractorNonTextOutput,
} from '../types.ts';

export const DEFAULT_MAX_BOUNDED_TEXT_CHARS = 2_000_000;
export const BOUNDED_TEXT_TRUNCATED_WARNING = 'bounded_text_truncated';
export const BOUNDED_TEXT_TRUNCATION_REASON = 'max_bounded_text_chars';
export const DEFAULT_MAX_TABLE_SAMPLE_ROWS = 25;
export const DEFAULT_MAX_TABLE_SAMPLE_COLUMNS = 25;

export const PDF_MIME_TYPE = 'application/pdf';
export const DOCX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PPTX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

export const TEXT_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/json',
  'application/x-ndjson',
  'application/xml',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
  'text/tab-separated-values',
  'text/xml',
]);

export const TABLE_MIME_TYPES: ReadonlySet<string> = new Set([
  'text/csv',
  'text/tab-separated-values',
]);

export const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/bmp',
  'image/gif',
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/png',
  'image/tiff',
  'image/webp',
]);

/**
 * The eight structural artifact kinds the production lane produces. The landed
 * `ExtractionArtifactKind` has six values, so this token is carried verbatim
 * inside `structuralRef` and the six-value kind is derived from the structural
 * pointer. See `artifactKindForStructuralKind` for the mapping and the leg
 * report for the full table.
 */
export type DerivedArtifactToken =
  | 'text'
  | 'table'
  | 'page'
  | 'slide'
  | 'sheet'
  | 'image_ocr'
  | 'image_vlm'
  | 'media_descriptor';

/**
 * The structural pointer vocabulary, carried through unchanged.
 */
export type StructuralRefKind =
  | 'whole_file'
  | 'page'
  | 'sheet'
  | 'slide'
  | 'section'
  | 'range'
  | 'image'
  | 'media';

const ARTIFACT_KIND_BY_STRUCTURAL_KIND: Readonly<Record<StructuralRefKind, ExtractionArtifactKind>> = {
  whole_file: 'document',
  section: 'document',
  range: 'document',
  page: 'page',
  sheet: 'sheet',
  slide: 'slide',
  image: 'image_description',
  media: 'image_description',
};

/**
 * The eight-to-six collapse, expressed once. The structural pointer decides
 * the landed kind because the landed kind describes structure, not technique;
 * the technique token survives in `structuralRef.artifact`.
 */
export function artifactKindForStructuralKind(kind: StructuralRefKind): ExtractionArtifactKind {
  return ARTIFACT_KIND_BY_STRUCTURAL_KIND[kind];
}

export interface BoundedText {
  text: string;
  truncated: boolean;
  chars: number;
  sourceChars: number;
  truncationReason?: string;
  warnings: readonly string[];
}

/**
 * Collapse null bytes and carriage returns, cap consecutive blank lines, trim.
 */
export function normalizeExtractedText(input: string): string {
  return input
    .replace(/\u0000/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Cap normalized text at the configured ceiling and report what that cost.
 *
 * Truncation has no field on the landed seam; it travels as the
 * `bounded_text_truncated` warning token plus the exact source length carried
 * in `structuralRef`, so nothing the production lane recorded is lost.
 */
export function boundText(
  normalizedText: string,
  maxBoundedTextChars: number,
  reason: string = BOUNDED_TEXT_TRUNCATION_REASON,
): BoundedText {
  const sourceChars = normalizedText.length;
  const truncated = sourceChars > maxBoundedTextChars;
  const text = truncated ? normalizedText.slice(0, maxBoundedTextChars) : normalizedText;
  return {
    text,
    truncated,
    chars: text.length,
    sourceChars,
    ...(truncated ? { truncationReason: reason } : {}),
    warnings: truncated ? [BOUNDED_TEXT_TRUNCATED_WARNING] : [],
  };
}

export function appendWarning(
  warnings: readonly string[] | undefined,
  warning: string,
): string[] {
  const next = warnings ? [...warnings] : [];
  if (!next.includes(warning)) next.push(warning);
  return next;
}

export function appendBoundedTextWarnings(
  warnings: readonly string[] | undefined,
  bounded: Pick<BoundedText, 'warnings'>,
): string[] {
  let next = warnings ? [...warnings] : [];
  for (const warning of bounded.warnings) {
    next = appendWarning(next, warning);
  }
  return next;
}

export interface DerivationInput {
  artifact: DerivedArtifactToken;
  structural: {
    kind: StructuralRefKind;
    label?: string;
    index?: number;
  };
  bounded: BoundedText;
  artifactKind?: ExtractionArtifactKind;
  confidence?: number;
  warnings?: readonly string[];
}

/**
 * Build one structural-provenance record.
 *
 * `structuralRef` is a free-form record on the landed seam, which is what makes
 * the eight-to-six collapse lossless: the production artifact token, the
 * structural label and index, and the pre-truncation source length all ride
 * inside it.
 */
export function buildDerivation(input: DerivationInput): ExtractionDerivation {
  const warnings = appendBoundedTextWarnings(input.warnings, input.bounded);
  return {
    artifactKind: input.artifactKind ?? artifactKindForStructuralKind(input.structural.kind),
    structuralRef: {
      kind: input.structural.kind,
      ...(input.structural.label !== undefined ? { label: input.structural.label } : {}),
      ...(input.structural.index !== undefined ? { index: input.structural.index } : {}),
      artifact: input.artifact,
      ...(input.bounded.truncated
        ? {
            sourceChars: input.bounded.sourceChars,
            ...(input.bounded.truncationReason !== undefined
              ? { truncationReason: input.bounded.truncationReason }
              : {}),
          }
        : {}),
    },
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    chars: input.bounded.chars,
  };
}

/**
 * The "there is nothing readable here yet" outcome.
 *
 * The production lane recorded a synthetic descriptor artifact whose text names
 * the mime type and size and says another lane has to read this item. That text
 * was never indexed as searchable content — the recorder stores text only for
 * an indexed status — so the landed seam losing `text` on a non-text output
 * costs nothing. The descriptor is a pure function of the mime type, the size
 * and the kind, and all three ride in `structuralRef`, so a consumer can
 * reconstruct it exactly.
 */
export function mediaDescriptorOutput(input: {
  mimeType: string | undefined;
  sizeBytes: number;
  maxBoundedTextChars: number;
  kind: 'image' | 'media';
  label: string;
  warnings: readonly string[];
}): ExtractorNonTextOutput {
  const descriptor = boundText(normalizeExtractedText([
    input.kind === 'image' ? 'Image file' : 'PDF visual content',
    input.mimeType ? `MIME type: ${input.mimeType}` : undefined,
    Number.isFinite(input.sizeBytes) ? `Size bytes: ${input.sizeBytes}` : undefined,
    'No local OCR text has been extracted.',
    'OCR or vision-language processing is required before content-level retrieval.',
  ].filter((value): value is string => Boolean(value)).join('\n')), input.maxBoundedTextChars);
  const derivation = buildDerivation({
    artifact: 'media_descriptor',
    structural: { kind: input.kind, label: input.label },
    bounded: descriptor,
    confidence: 0.3,
    warnings: input.warnings,
  });
  return {
    status: 'metadata_only',
    derivations: [{
      ...derivation,
      structuralRef: {
        ...derivation.structuralRef,
        ...(input.mimeType !== undefined ? { mimeType: input.mimeType } : {}),
        ...(Number.isFinite(input.sizeBytes) ? { sizeBytes: input.sizeBytes } : {}),
      },
    }],
  };
}

/**
 * Strip the media-type parameters and lowercase, the way the production lane
 * resolves a stored mime against a fetched one.
 */
export function normalizeMimeType(input: string | undefined): string | undefined {
  const value = input?.split(';', 1)[0]?.trim().toLowerCase();
  return value || undefined;
}

/**
 * Prefer the fetched mime, fall back to the enqueued one when the transport
 * returned a generic octet stream.
 */
export function resolveExtractionMimeType(
  refMimeType: string | undefined,
  fetchedMimeType: string | undefined,
): string | undefined {
  const enqueued = normalizeMimeType(refMimeType);
  const fetched = normalizeMimeType(fetchedMimeType);
  if (!fetched || fetched === 'application/octet-stream' || fetched === 'binary/octet-stream') {
    return enqueued;
  }
  return fetched;
}

/**
 * Content-free digest of an error for operator logs.
 *
 * This never reaches `errorKind` or `warnings` — both of those are bounded
 * categorical tokens on the landed seam. It exists so a backend failure is
 * still diagnosable on stderr without private content riding a stored field.
 */
export function sanitizeErrorDetail(body: string, maxChars = 120): string {
  return body.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxChars);
}

export function sanitizeThrownError(error: unknown, maxChars = 120): string {
  const detail = error instanceof Error
    ? `${error.name || 'Error'}: ${error.message}`
    : String(error);
  return sanitizeErrorDetail(detail, maxChars);
}
