/**
 * B5 — the local vision lane. Two extractors share this module because they
 * share a client seam and a prompt discipline.
 *
 *   - The PDF extractor rasterizes every page up to a cap and transcribes each
 *     one. It is the largest single extractor in the factory.
 *   - The layout extractor describes a single image.
 *
 * Three behaviours here exist because of live incidents and must survive the
 * port in intent, not just in shape:
 *
 *   1. An HTTP 200 carrying empty content is a RETRYABLE STRUCTURAL FAILURE,
 *      not a successful empty extraction. A vision backend has returned 200
 *      with dropped-image empty content, and a fresh attempt recovers real
 *      text. Empty content is never indexed silently and never settles as an
 *      empty output; once the budget is spent the job fails retryable.
 *   2. The page retry budget covers thrown errors AND empty content on ONE
 *      shared counter. A twenty-page document rarely survives twenty
 *      consecutive backend calls without one transport blip.
 *   3. The periodic model recycle is skipped after the final page (nothing
 *      left to benefit) and when the client exposes no recycle hook.
 *
 * The health probe is deliberately NOT folded into `extract()`. A backend that
 * rejects a malformed probe image starves the whole lane, so the gate belongs
 * to the batch runner, which can abandon the batch. This module ports the probe
 * payload and leaves the gate to its caller.
 *
 * Doc comments here are always multi-line blocks, and every regex lives inside
 * a named function enrolled in the architecture guard's allowlist.
 */

import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
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
  sanitizeThrownError,
} from './bounded-text.ts';
import {
  runExtractionCommand,
  type ExtractionCommandRunner,
} from './command-runner.ts';
import {
  DEFAULT_PDF_INFO_COMMAND,
  DEFAULT_PDF_RENDER_COMMAND,
  DEFAULT_PDF_RENDER_TIMEOUT_MS,
  PDF_RENDER_DPI_STEPS,
  renderPdfPages,
  renderSinglePdfPageForVision,
  type RenderedPdfPage,
} from './pdf-render.ts';
import { missingBytesFailure } from './text.ts';

export const VLM_PDF_EXTRACTOR_KIND = 'local_vlm_pdf';
export const VLM_PDF_EXTRACTOR_VERSION = '2026-08-17-delphi-vision-deep-v1';
export const VLM_LAYOUT_EXTRACTOR_KIND = 'local_vlm_layout';
export const VLM_LAYOUT_EXTRACTOR_VERSION = 'vlm-v1';

export const DEFAULT_VLM_PDF_MAX_PAGES = 40;
export const DEFAULT_VLM_PDF_MAX_TOKENS = 2_000;
export const DEFAULT_VLM_PDF_MAX_REQUEST_BYTES = 1_050_000;
export const DEFAULT_VLM_PDF_PAGE_RETRIES = 2;
export const DEFAULT_VLM_PDF_PAGE_RETRY_DELAY_MS = 3_000;
export const DEFAULT_VLM_PDF_HEALTHCHECK_TIMEOUT_MS = 20_000;

/**
 * Zero disables the periodic recycle. When positive the extractor unloads the
 * model after every N pages so the next page reloads fresh: each recycle costs
 * one cold load, bought in exchange for bounding backend drift across a long
 * document. A no-op on any client without the hook.
 */
export const DEFAULT_VLM_PDF_RECYCLE_EVERY_N_PAGES = 0;

export const DEFAULT_VLM_PROMPT = [
  'Describe the visible content for secure-local retrieval.',
  'Focus on document layout, headings, labels, diagrams, tables, handwriting, screenshots, and any clearly legible text.',
  'Do not infer private facts beyond what is visible.',
].join(' ');

export const DEFAULT_VLM_PDF_PROMPT = [
  'Faithfully transcribe this scanned PDF page for secure-local indexing.',
  'Return visible text only. Preserve headings, table rows, amounts, dates, identifiers, labels, and row/column relationships.',
  'Do not summarize, omit low-confidence visible text, or infer facts that are not visible.',
].join(' ');

/**
 * Prefix every page prompt with page and document identity before any shared
 * instruction text. The full SHA-256 token is stable for one item without
 * exposing its provider id, path, title, or content to logs or the model.
 */
export function buildVlmPdfPagePrompt(input: {
  prompt: string;
  pageNumber: number;
  totalPages: number | undefined;
  localItemId: string;
}): string {
  const itemToken = createHash('sha256').update(input.localItemId).digest('hex');
  return `Page ${input.pageNumber} of ${input.totalPages ?? 'unknown'} — item sha256:${itemToken}\n\n${input.prompt}`;
}

/**
 * A structurally valid one-pixel white PNG for the health probe.
 *
 * Backends that validate image data reject a malformed payload with HTTP 500,
 * which makes the probe fail permanently and starves the lane. That happened
 * once; the bytes are exported so a test can assert they really are a PNG.
 */
export const VLM_PDF_PROBE_IMAGE_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/**
 * Some native chat endpoints carry images as bare base64 with no data prefix,
 * so the probe image is exposed in both shapes.
 */
export const VLM_PDF_PROBE_IMAGE_BASE64 = stripDataUrlPrefix(VLM_PDF_PROBE_IMAGE_DATA_URL);

function stripDataUrlPrefix(dataUrl: string): string {
  return dataUrl.replace(/^data:[^,]+,/, '');
}

/**
 * The bounded error kinds a Delphi-router vision failure can carry.
 *
 * They are DIAGNOSTIC LABELS, not verdicts. Nothing a single request comes back
 * with can prove a permanent fault: a 404 is equally a retired profile and a
 * proxy hiccup, and provider prose ("model", "profile", "not found") is not part
 * of either Delphi contract, so it cannot be parsed for meaning. The one fault
 * we CAN establish is configuration-level, and it is established structurally —
 * by asking `/models` which profiles the router serves, before any job is
 * leased. See `listedVlmProfileIds` and the batch health gate.
 *
 * Consequence: every per-request failure is retryable and bounded by the page
 * attempt budget. What a router refusal changes is the LANE, not the document —
 * these kinds are the lane's stop signal.
 */
export const VLM_ROUTER_PROFILE_UNKNOWN_ERROR_KIND = 'vlm_router_profile_unknown';
export const VLM_ROUTER_REQUEST_REJECTED_ERROR_KIND = 'vlm_router_request_rejected';
export const VLM_ROUTER_AUTH_FAILED_ERROR_KIND = 'vlm_router_auth_failed';
export const VLM_BACKEND_UNAVAILABLE_ERROR_KIND = 'vlm_backend_unavailable';

/**
 * The kinds that mean "this lane cannot serve requests as configured".
 *
 * The batch runner halts on the first one and the supervisor's stop set is
 * rendered from exactly this list, so a misconfigured lane costs one refusal
 * per tick rather than one refusal per queued document.
 */
export const VLM_ROUTER_LANE_FAILURE_ERROR_KINDS = [
  VLM_ROUTER_PROFILE_UNKNOWN_ERROR_KIND,
  VLM_ROUTER_AUTH_FAILED_ERROR_KIND,
  VLM_ROUTER_REQUEST_REJECTED_ERROR_KIND,
] as const;

export function isVlmRouterLaneFailureErrorKind(kind: string | undefined): boolean {
  return kind !== undefined
    && (VLM_ROUTER_LANE_FAILURE_ERROR_KINDS as readonly string[]).includes(kind);
}

export interface VlmRouterErrorClass {
  kind: string;
  retryable: boolean;
}

/**
 * A vision-endpoint failure carrying the bounded kind the record will report.
 *
 * `retryable` is kept on the class because the health gate builds a
 * non-retryable instance for a structurally proven missing profile; no
 * per-request failure ever sets it false.
 */
export class VlmRouterError extends Error {
  readonly status: number;
  readonly errorKind: string;
  readonly retryable: boolean;

  constructor(input: {
    status: number;
    errorKind: string;
    retryable: boolean;
    message: string;
  }) {
    super(input.message);
    this.name = 'VlmRouterError';
    this.status = input.status;
    this.errorKind = input.errorKind;
    this.retryable = input.retryable;
  }
}

/**
 * Label a vision-endpoint HTTP failure. Status only — no body, by design.
 *
 * An earlier revision read the response prose to decide that a request was
 * permanently doomed. That mislabeled a page-validation 400 ("image dimensions
 * exceed model maximum") as an unknown profile and terminally discarded whole
 * documents on a transient 404. Neither Delphi contract specifies error prose,
 * so there is nothing here to parse; the status only picks which of three
 * operator responses to name, and every one of them is retryable.
 */
export function classifyVlmRouterEndpointError(status: number): VlmRouterErrorClass {
  if (status === 401 || status === 403) {
    return { kind: VLM_ROUTER_AUTH_FAILED_ERROR_KIND, retryable: true };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { kind: VLM_BACKEND_UNAVAILABLE_ERROR_KIND, retryable: true };
  }
  if (status >= 400) {
    return { kind: VLM_ROUTER_REQUEST_REJECTED_ERROR_KIND, retryable: true };
  }
  return { kind: VLM_BACKEND_UNAVAILABLE_ERROR_KIND, retryable: true };
}

/**
 * The bounded kind a thrown vision failure carries, if it carries one.
 *
 * Duck-typed rather than `instanceof`-only so a client built against another
 * copy of the class still reports its kind instead of a generic failure.
 */
export function vlmRouterErrorKind(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as { errorKind?: unknown };
  return typeof candidate.errorKind === 'string' && candidate.errorKind
    ? candidate.errorKind
    : undefined;
}

export interface VlmPdfExtractorOptions {
  kind?: string;
  version?: string;
  maxBoundedTextChars?: number;
  client?: VlmClient;
  prompt?: string;
  maxPages?: number;
  maxTokens?: number;
  maxRequestBytes?: number;
  pageRetries?: number;
  pageRetryDelayMs?: number;
  recycleEveryNPages?: number;
  healthcheckTimeoutMs?: number;
  pdfRenderCommand?: string;
  pdfInfoCommand?: string;
  pdfRenderCommandRunner?: ExtractionCommandRunner;
  pdfInfoCommandRunner?: ExtractionCommandRunner;
  pdfRenderTimeoutMs?: number;
}

export interface VlmLayoutExtractorOptions {
  kind?: string;
  version?: string;
  maxBoundedTextChars?: number;
  client?: VlmClient;
  prompt?: string;
}

export function createVlmPdfExtractor(options: VlmPdfExtractorOptions = {}): Extractor {
  const kind = options.kind ?? VLM_PDF_EXTRACTOR_KIND;
  const version = options.version ?? VLM_PDF_EXTRACTOR_VERSION;
  const maxBoundedTextChars = options.maxBoundedTextChars ?? DEFAULT_MAX_BOUNDED_TEXT_CHARS;
  const prompt = options.prompt ?? DEFAULT_VLM_PDF_PROMPT;
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? DEFAULT_VLM_PDF_MAX_PAGES));
  const maxTokens = Math.max(1, Math.floor(options.maxTokens ?? DEFAULT_VLM_PDF_MAX_TOKENS));
  const maxRequestBytes = Math.max(1, Math.floor(options.maxRequestBytes ?? DEFAULT_VLM_PDF_MAX_REQUEST_BYTES));
  const pdfRenderCommand = options.pdfRenderCommand?.trim() || DEFAULT_PDF_RENDER_COMMAND;
  const pdfInfoCommand = options.pdfInfoCommand?.trim() || DEFAULT_PDF_INFO_COMMAND;
  const pdfRenderCommandRunner = options.pdfRenderCommandRunner ?? runExtractionCommand;
  const pdfInfoCommandRunner = options.pdfInfoCommandRunner ?? pdfRenderCommandRunner;
  const pdfRenderTimeoutMs = options.pdfRenderTimeoutMs ?? DEFAULT_PDF_RENDER_TIMEOUT_MS;
  const pageRetries = Math.max(0, Math.floor(options.pageRetries ?? DEFAULT_VLM_PDF_PAGE_RETRIES));
  const pageRetryDelayMs = Math.max(0, Math.floor(options.pageRetryDelayMs ?? DEFAULT_VLM_PDF_PAGE_RETRY_DELAY_MS));
  const recycleEveryNPages = Math.max(0, Math.floor(options.recycleEveryNPages ?? DEFAULT_VLM_PDF_RECYCLE_EVERY_N_PAGES));
  return {
    kind,
    version,
    needsBytes: true,
    egress: 'local',
    accepts(mimeType) {
      return normalizeMimeType(mimeType) === PDF_MIME_TYPE;
    },
    async extract(input: ExtractorInput): Promise<ExtractorOutput> {
      const client = options.client;
      if (!client) {
        return { status: 'failed_retryable', errorKind: 'vlm_client_not_configured' };
      }
      const bytes = input.bytes;
      if (!bytes) return missingBytesFailure();
      const mimeType = normalizeMimeType(input.mimeType ?? input.ref.mimeType);
      if (mimeType !== PDF_MIME_TYPE) {
        return { status: 'skipped_unsupported' };
      }
      const rendered = await renderPdfPages({
        bytes,
        renderCommand: pdfRenderCommand,
        infoCommand: pdfInfoCommand,
        renderCommandRunner: pdfRenderCommandRunner,
        infoCommandRunner: pdfInfoCommandRunner,
        timeoutMs: pdfRenderTimeoutMs,
        maxPages,
        outputFormat: 'jpeg',
      });
      const pageTexts: string[] = [];
      for (const page of rendered.pages) {
        const pagePrompt = buildVlmPdfPagePrompt({
          prompt,
          pageNumber: page.pageNumber,
          totalPages: rendered.totalPages,
          localItemId: input.ref.localItemId,
        });
        const fittedPage = await fitVlmPdfPageRequestPayload({
          bytes,
          page,
          prompt: pagePrompt,
          maxTokens,
          maxRequestBytes,
          renderCommand: pdfRenderCommand,
          renderCommandRunner: pdfRenderCommandRunner,
          timeoutMs: pdfRenderTimeoutMs,
        });
        if (!fittedPage.ok) {
          // Bounded-retryable, like every other page failure: the job's attempt
          // budget decides when it comes to rest. A page that will not fit today
          // may fit after a render-setting change, and discarding the document
          // on the first look forecloses that.
          return { status: 'failed_retryable', errorKind: 'vlm_page_payload_too_large' };
        }
        let pageText = '';
        let lastError: unknown;
        let sawEmptyContent = false;
        for (let attempt = 0; attempt <= pageRetries; attempt += 1) {
          try {
            const described = await client.describe({
              bytes: fittedPage.page.bytes,
              mimeType: fittedPage.page.mimeType,
              prompt: pagePrompt,
              maxOutputChars: maxBoundedTextChars,
              maxTokens,
            });
            const candidate = normalizeExtractedText(described.text);
            if (candidate) {
              pageText = candidate;
              lastError = undefined;
              sawEmptyContent = false;
              break;
            }
            sawEmptyContent = true;
            lastError = undefined;
          } catch (error) {
            sawEmptyContent = false;
            lastError = error;
          }
          if (attempt < pageRetries && pageRetryDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, pageRetryDelayMs));
          }
        }
        if (!pageText) {
          if (sawEmptyContent) {
            return { status: 'failed_retryable', errorKind: 'vlm_empty_content' };
          }
          if (lastError !== undefined) {
            console.error(
              `Local vision page describe threw: page=${page.pageNumber} error=${sanitizeThrownError(lastError)}`,
            );
          }
          // Retryable, always: a refused request never proves the document is
          // bad, and the pages after this one have not been looked at. The kind
          // still names what the router said so the lane can act on it.
          return {
            status: 'failed_retryable',
            errorKind: vlmRouterErrorKind(lastError) ?? 'vlm_backend_unavailable',
          };
        }
        pageTexts.push(`--- Page ${page.pageNumber} ---\n${pageText}`);
        if (
          recycleEveryNPages > 0
          && pageTexts.length % recycleEveryNPages === 0
          && pageTexts.length < rendered.pages.length
          && typeof client.recycle === 'function'
        ) {
          try {
            await client.recycle();
          } catch (error) {
            console.error(
              `Local vision PDF recycle after page ${page.pageNumber} failed: ${sanitizeThrownError(error)}`,
            );
          }
        }
      }
      const joinedText = pageTexts.join('\n\n');
      if (!joinedText) {
        return { status: 'failed_retryable', errorKind: 'vlm_empty_transcription' };
      }
      const bounded = boundText(joinedText, maxBoundedTextChars);
      const pageCapBites = rendered.totalPages !== undefined
        && rendered.totalPages > rendered.pages.length;
      const warnings = pageCapBites
        ? appendWarning(['vlm_text', 'vlm_source_rasterized_pdf'], 'vlm_pdf_pages_capped')
        : ['vlm_text', 'vlm_source_rasterized_pdf'];
      const derivation = buildDerivation({
        artifact: 'text',
        structural: { kind: 'whole_file', label: 'local VLM PDF transcription' },
        bounded,
        confidence: 0.8,
        warnings,
      });
      return {
        status: 'indexed',
        text: bounded.text,
        derivations: [{
          ...derivation,
          structuralRef: {
            ...derivation.structuralRef,
            renderedPages: rendered.pages.length,
            ...(rendered.totalPages !== undefined ? { totalPages: rendered.totalPages } : {}),
            ...(pageCapBites ? { truncationReason: 'vlm_pdf_pages_capped' } : {}),
          },
        }],
        ...(pageCapBites || bounded.warnings.length > 0
          ? {
              warnings: pageCapBites
                ? appendWarning([...bounded.warnings], 'vlm_pdf_pages_capped')
                : [...bounded.warnings],
            }
          : {}),
      };
    },
  };
}

export function createVlmLayoutExtractor(options: VlmLayoutExtractorOptions = {}): Extractor {
  const kind = options.kind ?? VLM_LAYOUT_EXTRACTOR_KIND;
  const version = options.version ?? VLM_LAYOUT_EXTRACTOR_VERSION;
  const maxBoundedTextChars = options.maxBoundedTextChars ?? DEFAULT_MAX_BOUNDED_TEXT_CHARS;
  const prompt = options.prompt ?? DEFAULT_VLM_PROMPT;
  return {
    kind,
    version,
    needsBytes: true,
    egress: 'local',
    accepts(mimeType) {
      const normalized = normalizeMimeType(mimeType);
      return Boolean(normalized && IMAGE_MIME_TYPES.has(normalized));
    },
    async extract(input: ExtractorInput): Promise<ExtractorOutput> {
      const client = options.client;
      if (!client) {
        return { status: 'failed_retryable', errorKind: 'vlm_client_not_configured' };
      }
      const bytes = input.bytes;
      if (!bytes) return missingBytesFailure();
      const mimeType = normalizeMimeType(input.mimeType ?? input.ref.mimeType);
      if (!mimeType || !IMAGE_MIME_TYPES.has(mimeType)) {
        return { status: 'skipped_unsupported' };
      }
      const described = await client.describe({
        bytes,
        mimeType,
        prompt,
        maxOutputChars: maxBoundedTextChars,
      });
      const bounded = boundText(normalizeExtractedText(described.text), maxBoundedTextChars);
      if (!bounded.text) {
        return mediaDescriptorOutput({
          mimeType,
          sizeBytes: input.sizeBytes ?? bytes.byteLength,
          maxBoundedTextChars,
          kind: 'image',
          label: 'image file',
          warnings: ['vlm_empty', 'image_only'],
        });
      }
      return {
        status: 'indexed',
        text: bounded.text,
        derivations: [buildDerivation({
          artifact: 'image_vlm',
          structural: { kind: 'image', label: 'image visual description' },
          bounded,
          confidence: described.confidence ?? 0.65,
          warnings: described.warnings ?? ['vlm_description', 'local_private_model'],
        })],
        ...(bounded.warnings.length > 0 ? { warnings: [...bounded.warnings] } : {}),
      };
    },
  };
}

/**
 * Shrink a rendered page until the describe request fits its byte cap.
 *
 * Walks the DPI ladder downward, re-rendering only when a step is genuinely
 * lower than what is already in hand. A page that will not fit at the lowest
 * step is terminal: no retry will make it smaller.
 */
async function fitVlmPdfPageRequestPayload(input: {
  bytes: Uint8Array;
  page: RenderedPdfPage;
  prompt: string;
  maxTokens: number;
  maxRequestBytes: number;
  renderCommand: string;
  renderCommandRunner: ExtractionCommandRunner;
  timeoutMs: number;
}): Promise<
  | { ok: true; page: RenderedPdfPage; requestBytes: number }
  | { ok: false }
> {
  let page = input.page;
  let requestBytes = estimateVlmPdfPageDescribeRequestBytes({
    page,
    prompt: input.prompt,
    maxTokens: input.maxTokens,
  });
  if (requestBytes <= input.maxRequestBytes) {
    return { ok: true, page, requestBytes };
  }
  for (const dpi of PDF_RENDER_DPI_STEPS) {
    if (dpi >= page.dpi) continue;
    page = await renderSinglePdfPageForVision({
      bytes: input.bytes,
      pageNumber: page.pageNumber,
      dpi,
      renderCommand: input.renderCommand,
      renderCommandRunner: input.renderCommandRunner,
      timeoutMs: input.timeoutMs,
    });
    requestBytes = estimateVlmPdfPageDescribeRequestBytes({
      page,
      prompt: input.prompt,
      maxTokens: input.maxTokens,
    });
    if (requestBytes <= input.maxRequestBytes) {
      return { ok: true, page, requestBytes };
    }
  }
  return { ok: false };
}

/**
 * Size the describe request the way the chat transport will serialize it, so
 * the cap is measured against real wire bytes rather than image bytes alone.
 */
export function estimateVlmPdfPageDescribeRequestBytes(input: {
  page: RenderedPdfPage;
  prompt: string;
  maxTokens: number;
}): number {
  const body = {
    model: '',
    temperature: 0,
    max_tokens: input.maxTokens,
    chat_template_kwargs: { enable_thinking: false },
    messages: [
      {
        role: 'system',
        content: 'You are a local secure visual extraction worker. Return concise evidence text only.',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: input.prompt },
          {
            type: 'image_url',
            image_url: {
              url: `data:${input.page.mimeType};base64,${Buffer.from(input.page.bytes).toString('base64')}`,
            },
          },
        ],
      },
    ],
  };
  return Buffer.byteLength(JSON.stringify(body), 'utf8');
}
