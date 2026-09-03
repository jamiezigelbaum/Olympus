/**
 * B11a — the explicit extractor registry.
 *
 * What this replaces is the whole point of it. Dispatch used to be substring
 * matching on a free-form kind string: a kind containing `ocr` went to the OCR
 * lane, one containing `vlm` or `vision` to the vision lane, one starting with
 * a provider prefix to the approved-remote lane. Sixteen kinds were in flight
 * and two of them were spelled into SQL. Here a kind is a key in a map, and a
 * kind nobody registered resolves to nothing at all rather than to whichever
 * lane happened to match its spelling.
 *
 * Everything in this module is DATA supplied by the wiring layer. No value is
 * read from the environment: the whole registry is exercisable from a unit test
 * with fake clients, which is the property that keeps the runner's dispositions
 * testable without a backend.
 *
 * Doc comments here are always multi-line blocks — the architecture guard's
 * regex-literal heuristic reads a one-line block comment as a regex — and this
 * module contains no regular expressions at all.
 */

import type {
  Extractor,
  ExtractionItemRef,
  ExtractorRegistry,
  ExtractorRegistryConfig,
  VlmProbeRequest,
} from './types.ts';
import {
  OCR_DETERMINISTIC_PDF_REJECTION_KINDS,
  OCR_EXTRACTOR_KIND,
  createOcrExtractor,
} from './extractors/ocr.ts';
import {
  REMOTE_VLM_EXTRACTOR_KINDS,
  createRemoteVlmExtractor,
} from './extractors/remote-vlm.ts';
import { TEXT_EXTRACTOR_KIND, createTextExtractor } from './extractors/text.ts';
import {
  TRANSCRIPTION_EXTRACTOR_KIND,
  createTranscriptionExtractor,
} from './extractors/transcription.ts';
import {
  DEFAULT_VLM_PDF_HEALTHCHECK_TIMEOUT_MS,
  VLM_LAYOUT_EXTRACTOR_KIND,
  VLM_PDF_EXTRACTOR_KIND,
  createVlmLayoutExtractor,
  createVlmPdfExtractor,
} from './extractors/vlm.ts';

/**
 * The order `select()` walks when no kind was requested.
 *
 * Only two lanes are ever chosen implicitly, and the order between them is the
 * whole of the rule: the transcription lane accepts a narrow audio set, and the
 * text lane accepts nearly everything, so a broad lane placed first would
 * swallow every audio item. OCR, both vision lanes and the approved-remote lane
 * are never selected implicitly — they are escalations, requested by kind,
 * because each one costs either a subprocess or an egress that a plain text
 * read does not.
 */
export const DEFAULT_EXTRACTOR_SELECTION_ORDER: readonly string[] = [
  TRANSCRIPTION_EXTRACTOR_KIND,
  TEXT_EXTRACTOR_KIND,
];

/**
 * One reopening rule: a job that came to rest terminally under `fromKind` with
 * `lastErrorKind` is re-targeted at `toKind`.
 *
 * Expressed as data rather than as a branch inside the runner because the set
 * of "this lane cannot read it, another lane can" pairs is a policy that grows,
 * and because a rule set can be inspected, logged and tested as a value.
 */
export interface ExtractionReclassificationRule {
  fromExtractorKind: string;
  lastErrorKind: string;
  toExtractorKind: string;
  toExtractorVersion: string;
  reason: string;
}

/**
 * Health probes by extractor kind.
 *
 * A probe belongs to the client, but the POLICY of what a failed probe means
 * belongs to the runner, so the two are handed over separately. Only kinds
 * whose configured client actually implements `probe` appear here; an absent
 * entry means "nothing to check", never "the check failed".
 */
export type ExtractionHealthProbeMap = ReadonlyMap<string, () => Promise<void>>;

/**
 * Build the registry from per-extractor construction knobs.
 *
 * Every kind is registered whether or not its client is configured. That is
 * deliberate for the approved-remote lane: an unconfigured remote extractor
 * answers with a retryable `remote_client_not_configured`, whereas an
 * unregistered one would resolve to `undefined` and settle its jobs as an
 * unknown kind. Neither of those is the privacy control — the runner's egress
 * gate is, and it refuses on the corpus's policy rather than on whether someone
 * remembered to leave a client out of the config.
 */
export function createDefaultExtractorRegistry(
  config: ExtractorRegistryConfig = {},
): ExtractorRegistry {
  const extractors: Extractor[] = [
    createTranscriptionExtractor({
      ...(config.transcription?.command !== undefined ? { command: config.transcription.command } : {}),
      ...(config.transcription?.timeoutMs !== undefined ? { timeoutMs: config.transcription.timeoutMs } : {}),
      ...(config.transcription?.maxTranscriptChars !== undefined
        ? { maxTranscriptChars: config.transcription.maxTranscriptChars }
        : {}),
    }),
    createTextExtractor({
      ...(config.text?.pdfTextCommand !== undefined ? { pdfTextCommand: config.text.pdfTextCommand } : {}),
      ...(config.text?.pdfTextTimeoutMs !== undefined ? { pdfTextTimeoutMs: config.text.pdfTextTimeoutMs } : {}),
      ...(config.text?.maxBoundedTextChars !== undefined
        ? { maxBoundedTextChars: config.text.maxBoundedTextChars }
        : {}),
    }),
    createOcrExtractor({
      ...(config.ocr?.ocrTimeoutMs !== undefined ? { ocrTimeoutMs: config.ocr.ocrTimeoutMs } : {}),
      ...(config.text?.maxBoundedTextChars !== undefined
        ? { maxBoundedTextChars: config.text.maxBoundedTextChars }
        : {}),
    }),
    createVlmPdfExtractor({
      ...(config.vlmPdf?.client ? { client: config.vlmPdf.client } : {}),
      ...(config.vlmPdf?.prompt !== undefined ? { prompt: config.vlmPdf.prompt } : {}),
      ...(config.vlmPdf?.maxPages !== undefined ? { maxPages: config.vlmPdf.maxPages } : {}),
      ...(config.vlmPdf?.maxTokens !== undefined ? { maxTokens: config.vlmPdf.maxTokens } : {}),
      ...(config.vlmPdf?.maxRequestBytes !== undefined
        ? { maxRequestBytes: config.vlmPdf.maxRequestBytes }
        : {}),
      ...(config.vlmPdf?.pageRetries !== undefined ? { pageRetries: config.vlmPdf.pageRetries } : {}),
      ...(config.vlmPdf?.pageRetryDelayMs !== undefined
        ? { pageRetryDelayMs: config.vlmPdf.pageRetryDelayMs }
        : {}),
      ...(config.vlmPdf?.recycleEveryNPages !== undefined
        ? { recycleEveryNPages: config.vlmPdf.recycleEveryNPages }
        : {}),
      ...(config.ocr?.pdfRenderTimeoutMs !== undefined
        ? { pdfRenderTimeoutMs: config.ocr.pdfRenderTimeoutMs }
        : {}),
    }),
    createVlmLayoutExtractor({
      ...(config.vlm?.client ? { client: config.vlm.client } : {}),
      ...(config.vlm?.prompt !== undefined ? { prompt: config.vlm.prompt } : {}),
    }),
  ];

  // The three approved-remote kinds differ only by the model behind the
  // injected client; the extraction behaviour is one implementation. They are
  // registered from the same config block because the landed option shape
  // carries exactly one client.
  for (const kind of REMOTE_VLM_EXTRACTOR_KINDS) {
    extractors.push(createRemoteVlmExtractor({
      kind,
      ...(config.remote?.client ? { client: config.remote.client } : {}),
      ...(config.remote?.prompt !== undefined ? { prompt: config.remote.prompt } : {}),
      ...(config.remote?.model !== undefined ? { model: config.remote.model } : {}),
      ...(config.ocr?.pdfRenderTimeoutMs !== undefined
        ? { pdfRenderTimeoutMs: config.ocr.pdfRenderTimeoutMs }
        : {}),
    }));
  }

  return buildExtractorRegistry(extractors);
}

/**
 * Assemble a registry from an explicit extractor list.
 *
 * Exported so a test can register a fake extractor under a real kind and drive
 * the whole loop without a subprocess, which is how every runner disposition is
 * exercised.
 */
export function buildExtractorRegistry(
  extractors: readonly Extractor[],
  selectionOrder: readonly string[] = DEFAULT_EXTRACTOR_SELECTION_ORDER,
): ExtractorRegistry {
  const byKind = new Map<string, Extractor>();
  for (const extractor of extractors) {
    if (byKind.has(extractor.kind)) {
      throw new Error(`Extractor kind ${extractor.kind} is registered twice.`);
    }
    byKind.set(extractor.kind, extractor);
  }
  const ordered = [...extractors];
  const implicitOrder = selectionOrder
    .map((kind) => byKind.get(kind))
    .filter((extractor): extractor is Extractor => extractor !== undefined);

  return {
    get(kind: string): Extractor | undefined {
      return byKind.get(kind);
    },
    /**
     * An explicitly requested kind is honoured exactly, including when it
     * accepts nothing about this item: the job was enqueued for that lane on
     * purpose, and the lane's own `extract` answers `skipped_unsupported` far
     * more usefully than a silent re-route ever did. Only a request with NO
     * kind falls through to media-type selection.
     */
    select(ref: ExtractionItemRef, requestedKind?: string): Extractor | undefined {
      if (requestedKind !== undefined) return byKind.get(requestedKind);
      return implicitOrder.find((extractor) => extractor.accepts(ref.mimeType, ref.name));
    },
    list(): readonly Extractor[] {
      return ordered;
    },
  };
}

/**
 * Probes for the kinds whose configured client offers one.
 */
export function extractorHealthProbes(
  config: ExtractorRegistryConfig = {},
): ExtractionHealthProbeMap {
  const probes = new Map<string, () => Promise<void>>();
  const vlmPdfProbeRequest: VlmProbeRequest = {
    timeoutMs: config.vlmPdf?.healthcheckTimeoutMs ?? DEFAULT_VLM_PDF_HEALTHCHECK_TIMEOUT_MS,
  };
  const vlmPdfClient = config.vlmPdf?.client;
  if (vlmPdfClient?.probe) {
    probes.set(VLM_PDF_EXTRACTOR_KIND, () => vlmPdfClient.probe!(vlmPdfProbeRequest));
  }
  const vlmClient = config.vlm?.client;
  if (vlmClient?.probe) {
    probes.set(VLM_LAYOUT_EXTRACTOR_KIND, () => vlmClient.probe!());
  }
  const remoteClient = config.remote?.client;
  if (remoteClient?.probe) {
    for (const kind of REMOTE_VLM_EXTRACTOR_KINDS) {
      probes.set(kind, () => remoteClient.probe!());
    }
  }
  return probes;
}

/**
 * The reopening rules the factory ships with.
 *
 * One rule per deterministic OCR rejection, all pointing at the raster vision
 * lane. This is the carried obligation from the wave that landed the
 * extractors: an OCR refusal now settles `failed_terminal` and, because a
 * failure output structurally cannot carry a derivation, it can no longer leave
 * behind the media descriptor that used to tell an operator "send this one to
 * the vision lane". Without these rules every scanned PDF the OCR command
 * refuses stays terminal forever and never reaches the model that can read it.
 *
 * Encrypted, signed and structurally invalid are all included. The OCR command
 * refuses all three because it must REWRITE the file; the vision lane only ever
 * rasterizes one, so a refusal there is a different question. Re-targeting is
 * bounded to one attempt per job by the job store, so a PDF that neither lane
 * can read costs exactly one extra try.
 *
 * Rules are dropped rather than invented when the target kind is not
 * registered: a rule pointing at a lane this process cannot run would enqueue
 * jobs nothing will ever lease.
 */
export function defaultTerminalReclassificationRules(
  registry: ExtractorRegistry,
  options: { fromExtractorKind?: string; toExtractorKind?: string } = {},
): readonly ExtractionReclassificationRule[] {
  const fromExtractorKind = options.fromExtractorKind ?? OCR_EXTRACTOR_KIND;
  const toExtractorKind = options.toExtractorKind ?? VLM_PDF_EXTRACTOR_KIND;
  const target = registry.get(toExtractorKind);
  if (!target || !registry.get(fromExtractorKind)) return [];
  return OCR_DETERMINISTIC_PDF_REJECTION_KINDS.map((lastErrorKind) => ({
    fromExtractorKind,
    lastErrorKind,
    toExtractorKind,
    toExtractorVersion: target.version,
    reason: `deterministic ${lastErrorKind} reroute to ${toExtractorKind}`,
  }));
}
