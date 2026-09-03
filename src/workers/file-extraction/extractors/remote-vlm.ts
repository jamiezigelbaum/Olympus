/**
 * B6 — the approved-remote vision lane.
 *
 * This is the ONLY extractor in the factory whose egress is not `local`. Bytes
 * leave the machine here, which is why two guards live in this file and why
 * both are exported for the wiring layer to call before a client is ever
 * constructed:
 *
 *   - `requireLocalHttpBaseUrl` pins a local backend to loopback.
 *   - `requireApprovedRemoteExtractionBaseUrl` pins the remote backend to the
 *     single approved host over HTTPS.
 *
 * These two functions are the whole distance between a configuration typo and
 * document bytes going somewhere they were never approved to go. They were
 * ported unchanged apart from dropping a source-family word from one message.
 *
 * The provider may be named in this directory; the source family may not.
 *
 * Doc comments here are always multi-line blocks, and every regex lives inside
 * a named function enrolled in the architecture guard's allowlist.
 */

import type {
  Extractor,
  ExtractorInput,
  ExtractorOutput,
  VlmClient,
} from '../types.ts';
import {
  DEFAULT_MAX_BOUNDED_TEXT_CHARS,
  IMAGE_MIME_TYPES,
  PDF_MIME_TYPE,
  appendWarning,
  boundText,
  buildDerivation,
  mediaDescriptorOutput,
  normalizeExtractedText,
  normalizeMimeType,
} from './bounded-text.ts';
import {
  runExtractionCommand,
  type ExtractionCommandRunner,
} from './command-runner.ts';
import {
  DEFAULT_PDF_RENDER_COMMAND,
  DEFAULT_PDF_RENDER_TIMEOUT_MS,
  renderPdfFirstPageForVision,
} from './pdf-render.ts';
import { missingBytesFailure } from './text.ts';

export const REMOTE_VLM_EXTRACTOR_VERSION = 'venice-v1';
export const APPROVED_REMOTE_EXTRACTION_HOST = 'api.venice.ai';
export const DEFAULT_REMOTE_EXTRACTION_MODEL = 'kimi-k3';

/**
 * The three registered remote kinds. They differ only by the model behind the
 * injected client; the extraction behaviour is identical.
 */
export const REMOTE_VLM_EXTRACTOR_KINDS = [
  'venice_e2ee_document',
  'venice_grok43_document',
  'venice_qwen3vl235b_document',
] as const;

export type RemoteVlmExtractorKind = (typeof REMOTE_VLM_EXTRACTOR_KINDS)[number];

export const DEFAULT_REMOTE_EXTRACTION_PROMPT = [
  'Extract concise evidence text from this secure-local document for private indexing.',
  'Return only visible or directly readable content.',
  'For tables, reports, receipts, screenshots, or scans, preserve labels, values, dates, units, and row context.',
  'Do not infer private facts beyond the document.',
].join(' ');

export interface RemoteVlmExtractorOptions {
  kind?: string;
  version?: string;
  maxBoundedTextChars?: number;
  client?: VlmClient;
  prompt?: string;
  model?: string;
  pdfRenderCommand?: string;
  pdfRenderCommandRunner?: ExtractionCommandRunner;
  pdfRenderTimeoutMs?: number;
}

export function createRemoteVlmExtractor(options: RemoteVlmExtractorOptions = {}): Extractor {
  const kind = options.kind ?? REMOTE_VLM_EXTRACTOR_KINDS[0];
  const version = options.version ?? REMOTE_VLM_EXTRACTOR_VERSION;
  const maxBoundedTextChars = options.maxBoundedTextChars ?? DEFAULT_MAX_BOUNDED_TEXT_CHARS;
  const prompt = options.prompt ?? DEFAULT_REMOTE_EXTRACTION_PROMPT;
  const pdfRenderCommand = options.pdfRenderCommand?.trim() || DEFAULT_PDF_RENDER_COMMAND;
  const pdfRenderCommandRunner = options.pdfRenderCommandRunner ?? runExtractionCommand;
  const pdfRenderTimeoutMs = options.pdfRenderTimeoutMs ?? DEFAULT_PDF_RENDER_TIMEOUT_MS;
  return {
    kind,
    version,
    needsBytes: true,
    egress: 'approved_remote',
    ...(options.client?.approvedRemoteDestination
      ? { approvedRemoteDestination: options.client.approvedRemoteDestination }
      : {}),
    accepts(mimeType) {
      const normalized = normalizeMimeType(mimeType);
      if (!normalized) return false;
      return normalized === PDF_MIME_TYPE || IMAGE_MIME_TYPES.has(normalized);
    },
    async extract(input: ExtractorInput): Promise<ExtractorOutput> {
      const client = options.client;
      if (!client) {
        return { status: 'failed_retryable', errorKind: 'remote_client_not_configured' };
      }
      const bytes = input.bytes;
      if (!bytes) return missingBytesFailure();
      const mimeType = normalizeMimeType(input.mimeType ?? input.ref.mimeType);
      if (!mimeType || (!IMAGE_MIME_TYPES.has(mimeType) && mimeType !== PDF_MIME_TYPE)) {
        return { status: 'skipped_unsupported' };
      }
      const isImage = IMAGE_MIME_TYPES.has(mimeType);
      const renderedPdf = mimeType === PDF_MIME_TYPE
        ? await renderPdfFirstPageForVision({
          bytes,
          command: pdfRenderCommand,
          commandRunner: pdfRenderCommandRunner,
          timeoutMs: pdfRenderTimeoutMs,
        })
        : undefined;
      const described = await client.describe({
        bytes: renderedPdf?.bytes ?? bytes,
        mimeType: renderedPdf?.mimeType ?? mimeType,
        prompt,
        maxOutputChars: maxBoundedTextChars,
      });
      const bounded = boundText(normalizeExtractedText(described.text), maxBoundedTextChars);
      const warnings = renderedPdf
        ? appendWarning(described.warnings ?? ['venice_e2ee_extraction'], 'pdf_rendered_first_page')
        : described.warnings ?? ['venice_e2ee_extraction'];
      if (!bounded.text) {
        return {
          ...mediaDescriptorOutput({
          mimeType,
          sizeBytes: input.sizeBytes ?? bytes.byteLength,
          maxBoundedTextChars,
          kind: isImage ? 'image' : 'media',
          label: isImage ? 'image file' : 'document file',
          warnings: renderedPdf
            ? ['venice_empty', 'document_empty', 'pdf_rendered_first_page']
            : ['venice_empty', isImage ? 'image_only' : 'document_empty'],
          }),
          ...(described.egressDestination
            ? { egressDestination: described.egressDestination }
            : {}),
        };
      }
      return {
        status: 'indexed',
        text: bounded.text,
        derivations: [buildDerivation({
          artifact: isImage ? 'image_vlm' : 'text',
          structural: isImage
            ? { kind: 'image', label: 'Venice E2EE visual extraction' }
            : { kind: 'whole_file', label: 'Venice E2EE document extraction' },
          bounded,
          confidence: described.confidence ?? 0.75,
          warnings,
        })],
        ...(bounded.warnings.length > 0 ? { warnings: [...bounded.warnings] } : {}),
        ...(described.egressDestination
          ? { egressDestination: described.egressDestination }
          : {}),
      };
    },
  };
}

// --- egress guards ---------------------------------------------------------

/**
 * Accept only a loopback HTTP(S) endpoint for a local vision backend.
 *
 * A local backend that has drifted onto a routable address stops being local,
 * and nothing downstream would notice, so the check happens where the URL is
 * first read rather than where it is first used.
 */
export function requireLocalHttpBaseUrl(value: string | undefined, label: string): string {
  const raw = requireNonEmpty(value, label).replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid local/private HTTP URL.`);
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLoopback = hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1'
    || hostname.startsWith('127.');
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !isLoopback) {
    throw new Error(`${label} must use a loopback HTTP(S) endpoint for secure-local vision extraction.`);
  }
  return raw;
}

/**
 * Accept only the single approved remote extraction host, over HTTPS.
 */
export function requireApprovedRemoteExtractionBaseUrl(
  value: string | undefined,
  label: string,
): string {
  const raw = requireNonEmpty(value, label).replace(/\/+$/, '');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid approved Venice HTTPS URL.`);
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== APPROVED_REMOTE_EXTRACTION_HOST) {
    throw new Error(
      `${label} must use the approved Venice E2EE HTTPS endpoint ${APPROVED_REMOTE_EXTRACTION_HOST}.`,
    );
  }
  return raw;
}

export function requireNonEmpty(value: string | undefined, label: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

// --- endpoint error classification -----------------------------------------

/**
 * Map an endpoint failure onto a bounded categorical token.
 *
 * The image-validation branch is the one that matters operationally: it is a
 * permanent property of the payload, not a transient endpoint condition, and
 * conflating it with a server error made a bad page look retryable.
 */
export function classifyRemoteVlmEndpointError(status: number, body: string): string {
  const messages = extractJsonMessages(body).join(' ').toLowerCase();
  if (status === 400 && /\bimage\b/.test(messages) && /\bvalidation\b/.test(messages)) {
    return 'venice_image_validation_failed';
  }
  if (status === 401 || status === 403) return 'venice_auth_failed';
  if (status === 404) return 'venice_model_unavailable';
  if (status === 408 || status === 429) return 'venice_rate_limited';
  if (status >= 500) return 'venice_server_error';
  return `venice_http_${status}`;
}

export function extractJsonMessages(body: string): string[] {
  if (!body.trim()) return [];
  try {
    const parsed = JSON.parse(body) as unknown;
    const messages: string[] = [];
    collectJsonMessages(parsed, messages);
    return messages;
  } catch {
    return [];
  }
}

function collectJsonMessages(value: unknown, messages: string[]): void {
  if (messages.length >= 12) return;
  if (typeof value === 'string') return;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonMessages(item, messages);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  for (const key of ['message', 'error', 'code']) {
    const field = record[key];
    if (typeof field === 'string') messages.push(field);
  }
  for (const key of ['issues', 'errors', 'details']) {
    collectJsonMessages(record[key], messages);
  }
}
