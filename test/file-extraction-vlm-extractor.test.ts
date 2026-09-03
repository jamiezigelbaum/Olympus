// B5 parity: the local vision lane, both extractors.
//
// Every case drives an injected client and an injected rendering command
// runner. The three incident-derived behaviours have their own tests and are
// named as such, because they are the reason this lane looks the way it does:
// empty content is retryable rather than empty, the retry budget is shared
// between throws and empty content, and the recycle is skipped after the last
// page.

import { describe, expect, test } from 'bun:test';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import type {
  VlmClient,
  VlmDescribeRequest,
  VlmDescribeResult,
} from '../src/workers/file-extraction/types.ts';
import type { ExtractionCommandRunner } from '../src/workers/file-extraction/extractors/command-runner.ts';
import {
  VLM_LAYOUT_EXTRACTOR_KIND,
  VLM_LAYOUT_EXTRACTOR_VERSION,
  VLM_PDF_EXTRACTOR_KIND,
  VLM_PDF_EXTRACTOR_VERSION,
  VLM_PDF_PROBE_IMAGE_BASE64,
  VLM_PDF_PROBE_IMAGE_DATA_URL,
  VlmRouterError,
  classifyVlmRouterEndpointError,
  createVlmLayoutExtractor,
  createVlmPdfExtractor,
  estimateVlmPdfPageDescribeRequestBytes,
} from '../src/workers/file-extraction/extractors/vlm.ts';
import {
  extractorInput,
  pdfImageOnly,
  textBytes,
} from './fixtures/file-extraction-extractor-fixtures.ts';

const PDF_MIME = 'application/pdf';

function pageBytes(size: number): Uint8Array {
  return new Uint8Array(size).fill(0x7f);
}

/**
 * A rendering command runner that writes the page files the real one would.
 */
function renderRunner(
  bytesFor: (pageNumber: number, dpi: number) => Uint8Array,
  calls: Array<{ dpi: number; singleFile: boolean; firstPage: number; lastPage: number }> = [],
): { runner: ExtractionCommandRunner; calls: typeof calls } {
  const runner: ExtractionCommandRunner = async (request) => {
    const args = request.args;
    const outputPrefix = args[args.length - 1]!;
    const dpi = Number(args[args.indexOf('-r') + 1]);
    const firstPage = Number(args[1]);
    const lastPage = Number(args[3]);
    const singleFile = args.includes('-singlefile');
    calls.push({ dpi, singleFile, firstPage, lastPage });
    if (singleFile) {
      await writeFile(`${outputPrefix}.jpg`, bytesFor(firstPage, dpi));
      return { stdout: '', stderr: '' };
    }
    for (let page = firstPage; page <= lastPage; page += 1) {
      await writeFile(`${outputPrefix}-${page}.jpg`, bytesFor(page, dpi));
    }
    return { stdout: '', stderr: '' };
  };
  return { runner, calls };
}

function infoRunner(totalPages: number | undefined): ExtractionCommandRunner {
  return async () => {
    if (totalPages === undefined) throw new Error('page count unavailable');
    return { stdout: `Producer: fixture\nPages: ${totalPages}\n`, stderr: '' };
  };
}

interface RecordingClient extends VlmClient {
  requests: VlmDescribeRequest[];
  recycleCalls: number;
}

function client(
  describe_: (request: VlmDescribeRequest, callIndex: number) => Promise<VlmDescribeResult>,
  options: { recycle?: boolean } = {},
): RecordingClient {
  const requests: VlmDescribeRequest[] = [];
  const state = { recycleCalls: 0 };
  const built: RecordingClient = {
    requests,
    get recycleCalls() {
      return state.recycleCalls;
    },
    async describe(request) {
      requests.push(request);
      return describe_(request, requests.length - 1);
    },
    ...(options.recycle
      ? {
          async recycle() {
            state.recycleCalls += 1;
          },
        }
      : {}),
  } as RecordingClient;
  return built;
}

function pdfExtractor(options: {
  client: VlmClient;
  totalPages?: number | undefined;
  maxPages?: number;
  maxRequestBytes?: number;
  pageRetries?: number;
  recycleEveryNPages?: number;
  bytesFor?: (pageNumber: number, dpi: number) => Uint8Array;
  renderCalls?: Array<{ dpi: number; singleFile: boolean; firstPage: number; lastPage: number }>;
}) {
  const { runner } = renderRunner(
    options.bytesFor ?? (() => pageBytes(64)),
    options.renderCalls ?? [],
  );
  return createVlmPdfExtractor({
    client: options.client,
    pdfRenderCommandRunner: runner,
    pdfInfoCommandRunner: infoRunner(options.totalPages),
    pageRetryDelayMs: 0,
    ...(options.maxPages !== undefined ? { maxPages: options.maxPages } : {}),
    ...(options.maxRequestBytes !== undefined ? { maxRequestBytes: options.maxRequestBytes } : {}),
    ...(options.pageRetries !== undefined ? { pageRetries: options.pageRetries } : {}),
    ...(options.recycleEveryNPages !== undefined
      ? { recycleEveryNPages: options.recycleEveryNPages }
      : {}),
  });
}

describe('vlm pdf extractor: registry surface', () => {
  test('declares the live kind, version, byte need and egress', () => {
    const extractor = createVlmPdfExtractor();
    expect(extractor.kind).toBe(VLM_PDF_EXTRACTOR_KIND);
    expect(extractor.kind).toBe('local_vlm_pdf');
    expect(extractor.version).toBe(VLM_PDF_EXTRACTOR_VERSION);
    expect(extractor.version).toBe('2026-08-17-delphi-vision-deep-v1');
    expect(extractor.needsBytes).toBe(true);
    expect(extractor.egress).toBe('local');
    expect(extractor.accepts(PDF_MIME)).toBe(true);
    expect(extractor.accepts('image/png')).toBe(false);
  });

  test('a non-PDF item is skipped rather than rendered', async () => {
    const fake = client(async () => ({ text: 'never reached' }));
    const result = await pdfExtractor({ client: fake }).extract(extractorInput({
      bytes: textBytes('png'),
      mimeType: 'image/png',
    }));
    expect(result.status).toBe('skipped_unsupported');
    expect(fake.requests).toHaveLength(0);
  });
});

describe('vlm pdf extractor: transcription', () => {
  test('transcribes every rendered page and joins them with page markers', async () => {
    const fake = client(async (request) => ({
      text: `text for ${request.prompt.includes('Page 1') ? 'one' : 'two'}`,
    }));
    const result = await pdfExtractor({ client: fake, totalPages: 2 }).extract(extractorInput({
      bytes: pdfImageOnly(),
      mimeType: PDF_MIME,
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('--- Page 1 ---\ntext for one\n\n--- Page 2 ---\ntext for two');
    expect(fake.requests).toHaveLength(2);
    const itemToken = createHash('sha256').update('local-item-1').digest('hex');
    expect(fake.requests[0]?.prompt).toStartWith(`Page 1 of 2 — item sha256:${itemToken}\n\n`);
    expect(fake.requests[1]?.prompt).toStartWith(`Page 2 of 2 — item sha256:${itemToken}\n\n`);
    const derivation = result.derivations?.[0];
    expect(derivation?.artifactKind).toBe('document');
    expect(derivation?.structuralRef).toMatchObject({
      kind: 'whole_file',
      label: 'local VLM PDF transcription',
      artifact: 'text',
      renderedPages: 2,
      totalPages: 2,
    });
    expect(derivation?.confidence).toBe(0.8);
    expect(derivation?.warnings).toEqual(['vlm_text', 'vlm_source_rasterized_pdf']);
  });

  test('the prompt prefix is unique across documents at the same page number', async () => {
    const fake = client(async () => ({ text: 'page text' }));
    const extractor = pdfExtractor({ client: fake, totalPages: 1 });
    for (const localItemId of ['local-item-alpha', 'local-item-beta']) {
      await extractor.extract(extractorInput({
        bytes: pdfImageOnly(),
        mimeType: PDF_MIME,
        ref: { localItemId },
      }));
    }
    const alphaToken = createHash('sha256').update('local-item-alpha').digest('hex');
    const betaToken = createHash('sha256').update('local-item-beta').digest('hex');
    expect(fake.requests[0]?.prompt).toStartWith(`Page 1 of 1 — item sha256:${alphaToken}\n\n`);
    expect(fake.requests[1]?.prompt).toStartWith(`Page 1 of 1 — item sha256:${betaToken}\n\n`);
    expect(fake.requests[0]?.prompt).not.toBe(fake.requests[1]?.prompt);
  });

  test('an unavailable page count still transcribes, with an unknown page label', async () => {
    const fake = client(async () => ({ text: 'page text' }));
    const result = await pdfExtractor({
      client: fake,
      totalPages: undefined,
      maxPages: 1,
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result.status).toBe('indexed');
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.prompt).toStartWith('Page 1 of unknown — item sha256:');
    if (result.status !== 'indexed') return;
    expect(result.derivations?.[0]?.structuralRef).not.toHaveProperty('totalPages');
  });

  test('the page cap warns and records both counts, without putting them in the warning', async () => {
    const fake = client(async () => ({ text: 'capped page' }));
    const result = await pdfExtractor({
      client: fake,
      totalPages: 10,
      maxPages: 3,
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(fake.requests).toHaveLength(3);
    expect(result.warnings).toContain('vlm_pdf_pages_capped');
    expect(result.derivations?.[0]?.warnings).toContain('vlm_pdf_pages_capped');
    expect(result.derivations?.[0]?.structuralRef).toMatchObject({
      renderedPages: 3,
      totalPages: 10,
      truncationReason: 'vlm_pdf_pages_capped',
    });
    for (const warning of result.derivations?.[0]?.warnings ?? []) {
      expect(warning).not.toContain('10');
      expect(warning).not.toContain('_3_');
    }
  });

  test('no page cap warning when everything rendered', async () => {
    const fake = client(async () => ({ text: 'page text' }));
    const result = await pdfExtractor({ client: fake, totalPages: 1 }).extract(extractorInput({
      bytes: pdfImageOnly(),
      mimeType: PDF_MIME,
    }));
    if (result.status !== 'indexed') throw new Error('expected indexed');
    expect(result.derivations?.[0]?.warnings).not.toContain('vlm_pdf_pages_capped');
    expect(result.warnings).toBeUndefined();
  });
});

describe('vlm pdf extractor: page-fit backoff', () => {
  test('re-renders down the DPI ladder until the request fits its byte cap', async () => {
    const fake = client(async () => ({ text: 'fitted page' }));
    const renderCalls: Array<{ dpi: number; singleFile: boolean; firstPage: number; lastPage: number }> = [];
    const result = await pdfExtractor({
      client: fake,
      totalPages: 1,
      maxRequestBytes: 2_000,
      renderCalls,
      bytesFor: (_page, dpi) => pageBytes(dpi >= 180 ? 5_000 : 100),
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result.status).toBe('indexed');
    expect(renderCalls.map((call) => call.dpi)).toEqual([180, 150]);
    expect(renderCalls[1]?.singleFile).toBe(true);
    expect(fake.requests[0]?.bytes.byteLength).toBe(100);
  });

  test('a page that will not fit at the lowest step is terminal', async () => {
    const fake = client(async () => ({ text: 'never reached' }));
    const renderCalls: Array<{ dpi: number; singleFile: boolean; firstPage: number; lastPage: number }> = [];
    const result = await pdfExtractor({
      client: fake,
      totalPages: 1,
      maxRequestBytes: 500,
      renderCalls,
      bytesFor: () => pageBytes(5_000),
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    // Bounded-retryable like every other page failure: the job's own attempt
    // budget decides when it comes to rest, not this one call.
    expect(result.status).toBe('failed_retryable');
    if (result.status !== 'failed_retryable') return;
    expect(result.errorKind).toBe('vlm_page_payload_too_large');
    expect(JSON.stringify(result)).not.toContain('5000');
    expect(renderCalls.map((call) => call.dpi)).toEqual([180, 150, 120, 100]);
    expect(fake.requests).toHaveLength(0);
  });

  test('the byte estimate grows with the image and counts the transport envelope', () => {
    const small = estimateVlmPdfPageDescribeRequestBytes({
      page: { pageNumber: 1, bytes: pageBytes(10), mimeType: 'image/jpeg', dpi: 180 },
      prompt: 'p',
      maxTokens: 100,
    });
    const large = estimateVlmPdfPageDescribeRequestBytes({
      page: { pageNumber: 1, bytes: pageBytes(1_000), mimeType: 'image/jpeg', dpi: 180 },
      prompt: 'p',
      maxTokens: 100,
    });
    expect(large).toBeGreaterThan(small);
    expect(small).toBeGreaterThan(10);
  });
});

describe('vlm pdf extractor: the incident behaviours', () => {
  test('HTTP-200 empty content is retried, and a later attempt recovers real text', async () => {
    const fake = client(async (_request, callIndex) => (
      callIndex === 0 ? { text: '   ' } : { text: 'recovered transcription' }
    ));
    const result = await pdfExtractor({
      client: fake,
      totalPages: 1,
      pageRetries: 2,
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toContain('recovered transcription');
    expect(fake.requests).toHaveLength(2);
  });

  test('exhausted retries on empty content fail retryable as vlm_empty_content', async () => {
    const fake = client(async () => ({ text: '\n \n' }));
    const result = await pdfExtractor({
      client: fake,
      totalPages: 1,
      pageRetries: 2,
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result.status).toBe('failed_retryable');
    if (result.status !== 'failed_retryable') return;
    expect(result.errorKind).toBe('vlm_empty_content');
    expect(fake.requests).toHaveLength(3);
  });

  test('empty content is never indexed silently and never settles as empty output', async () => {
    const fake = client(async () => ({ text: '' }));
    const result = await pdfExtractor({
      client: fake,
      totalPages: 1,
      pageRetries: 0,
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result.status).not.toBe('indexed');
    expect(result.status).not.toBe('empty_output');
    expect(result.status).toBe('failed_retryable');
  });

  test('a thrown error retries, then fails retryable as vlm_backend_unavailable', async () => {
    const fake = client(async () => {
      throw new Error('connection refused to the private backend at 127.0.0.1');
    });
    const result = await pdfExtractor({
      client: fake,
      totalPages: 1,
      pageRetries: 1,
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result.status).toBe('failed_retryable');
    if (result.status !== 'failed_retryable') return;
    expect(result.errorKind).toBe('vlm_backend_unavailable');
    expect(JSON.stringify(result)).not.toContain('127.0.0.1');
    expect(fake.requests).toHaveLength(2);
  });

  test('a throw recovers within the same shared budget', async () => {
    const fake = client(async (_request, callIndex) => {
      if (callIndex === 0) throw new Error('transient blip');
      return { text: 'second attempt worked' };
    });
    const result = await pdfExtractor({
      client: fake,
      totalPages: 1,
      pageRetries: 2,
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result.status).toBe('indexed');
    expect(fake.requests).toHaveLength(2);
  });

  test('the recycle runs on the page boundary and is skipped after the final page', async () => {
    const fake = client(async () => ({ text: 'page text' }), { recycle: true });
    const result = await pdfExtractor({
      client: fake,
      totalPages: 4,
      recycleEveryNPages: 2,
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result.status).toBe('indexed');
    expect(fake.requests).toHaveLength(4);
    expect(fake.recycleCalls).toBe(1);
  });

  test('every non-final boundary recycles when the interval is one page', async () => {
    const fake = client(async () => ({ text: 'page text' }), { recycle: true });
    await pdfExtractor({
      client: fake,
      totalPages: 3,
      recycleEveryNPages: 1,
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(fake.recycleCalls).toBe(2);
  });

  test('recycling is off by default and a client without the hook is fine', async () => {
    const withHook = client(async () => ({ text: 'page text' }), { recycle: true });
    await pdfExtractor({ client: withHook, totalPages: 3 }).extract(extractorInput({
      bytes: pdfImageOnly(),
      mimeType: PDF_MIME,
    }));
    expect(withHook.recycleCalls).toBe(0);

    const withoutHook = client(async () => ({ text: 'page text' }));
    const result = await pdfExtractor({
      client: withoutHook,
      totalPages: 3,
      recycleEveryNPages: 1,
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result.status).toBe('indexed');
  });
});

describe('vlm pdf extractor: configuration failures', () => {
  test('a missing client is retryable under a bounded token', async () => {
    const result = await createVlmPdfExtractor().extract(extractorInput({
      bytes: pdfImageOnly(),
      mimeType: PDF_MIME,
    }));
    expect(result.status).toBe('failed_retryable');
    if (result.status !== 'failed_retryable') return;
    expect(result.errorKind).toBe('vlm_client_not_configured');
  });

  test('missing bytes is a terminal invariant failure', async () => {
    const fake = client(async () => ({ text: 'unused' }));
    const result = await pdfExtractor({ client: fake }).extract(extractorInput({
      mimeType: PDF_MIME,
    }));
    expect(result.status).toBe('failed_terminal');
  });
});

describe('vlm layout extractor', () => {
  test('declares the live kind, version, byte need and egress', () => {
    const extractor = createVlmLayoutExtractor();
    expect(extractor.kind).toBe(VLM_LAYOUT_EXTRACTOR_KIND);
    expect(extractor.kind).toBe('local_vlm_layout');
    expect(extractor.version).toBe(VLM_LAYOUT_EXTRACTOR_VERSION);
    expect(extractor.version).toBe('vlm-v1');
    expect(extractor.needsBytes).toBe(true);
    expect(extractor.egress).toBe('local');
    expect(extractor.accepts('image/png')).toBe(true);
    expect(extractor.accepts('application/pdf')).toBe(false);
  });

  test('indexes a description as an image derivation with the default confidence', async () => {
    const fake = client(async () => ({ text: 'A chart with two labelled axes.' }));
    const result = await createVlmLayoutExtractor({ client: fake }).extract(extractorInput({
      bytes: textBytes('pretend png'),
      mimeType: 'image/png',
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('A chart with two labelled axes.');
    expect(result.derivations?.[0]?.artifactKind).toBe('image_description');
    expect(result.derivations?.[0]?.structuralRef).toMatchObject({
      kind: 'image',
      label: 'image visual description',
      artifact: 'image_vlm',
    });
    expect(result.derivations?.[0]?.confidence).toBe(0.65);
    expect(result.derivations?.[0]?.warnings).toEqual(['vlm_description', 'local_private_model']);
  });

  test('client-supplied confidence and warnings win over the defaults', async () => {
    const fake = client(async () => ({
      text: 'described',
      confidence: 0.9,
      warnings: ['custom_warning'],
    }));
    const result = await createVlmLayoutExtractor({ client: fake }).extract(extractorInput({
      bytes: textBytes('pretend png'),
      mimeType: 'image/png',
    }));
    if (result.status !== 'indexed') throw new Error('expected indexed');
    expect(result.derivations?.[0]?.confidence).toBe(0.9);
    expect(result.derivations?.[0]?.warnings).toEqual(['custom_warning']);
  });

  test('an empty description becomes a metadata-only media descriptor', async () => {
    const fake = client(async () => ({ text: '  ' }));
    const result = await createVlmLayoutExtractor({ client: fake }).extract(extractorInput({
      bytes: textBytes('pretend png'),
      mimeType: 'image/png',
      sizeBytes: 11,
    }));
    expect(result.status).toBe('metadata_only');
    expect(result).not.toHaveProperty('text');
    if (result.status !== 'metadata_only') return;
    expect(result.derivations?.[0]?.warnings).toEqual(['vlm_empty', 'image_only']);
  });

  test('a non-image item is skipped', async () => {
    const fake = client(async () => ({ text: 'never reached' }));
    const result = await createVlmLayoutExtractor({ client: fake }).extract(extractorInput({
      bytes: textBytes('doc'),
      mimeType: 'text/plain',
    }));
    expect(result.status).toBe('skipped_unsupported');
    expect(fake.requests).toHaveLength(0);
  });
});

/**
 * Build the failure the client would raise for a given status, through the
 * shipped classifier — so a test cannot accidentally assert a shape the real
 * client never produces.
 */
function routerError(status: number, detail: string): VlmRouterError {
  const classified = classifyVlmRouterEndpointError(status);
  return new VlmRouterError({
    status,
    errorKind: classified.kind,
    retryable: classified.retryable,
    message: `Local vision endpoint returned HTTP ${status}: ${detail}.`,
  });
}

describe('vlm pdf extractor: delphi router failure classification', () => {
  test('a request failure is labelled by HTTP status alone and is never terminal', () => {
    // Provider prose is not part of either Delphi contract, so it cannot decide
    // anything. Configuration-level terminality — a profile id the router does
    // not serve — is established by the pre-lease listing gate, never here.
    expect(classifyVlmRouterEndpointError(404)).toEqual({ kind: 'vlm_router_request_rejected', retryable: true });
    expect(classifyVlmRouterEndpointError(400)).toEqual({ kind: 'vlm_router_request_rejected', retryable: true });
    expect(classifyVlmRouterEndpointError(422)).toEqual({ kind: 'vlm_router_request_rejected', retryable: true });
    expect(classifyVlmRouterEndpointError(401)).toEqual({ kind: 'vlm_router_auth_failed', retryable: true });
    expect(classifyVlmRouterEndpointError(403)).toEqual({ kind: 'vlm_router_auth_failed', retryable: true });
    expect(classifyVlmRouterEndpointError(408)).toEqual({ kind: 'vlm_backend_unavailable', retryable: true });
    expect(classifyVlmRouterEndpointError(429)).toEqual({ kind: 'vlm_backend_unavailable', retryable: true });
    expect(classifyVlmRouterEndpointError(503)).toEqual({ kind: 'vlm_backend_unavailable', retryable: true });
  });

  test('a transient 404 keeps its retry budget instead of parking a healthy document', async () => {
    const fake = client(async () => {
      throw new VlmRouterError({
        status: 404,
        errorKind: 'vlm_router_request_rejected',
        retryable: true,
        message: 'Local vision endpoint returned HTTP 404: Not Found.',
      });
    });
    const result = await pdfExtractor({ client: fake, totalPages: 3, pageRetries: 2 })
      .extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    // A router or proxy 404 is ambiguous; a healthy document must survive it.
    expect(result).toEqual({
      status: 'failed_retryable',
      errorKind: 'vlm_router_request_rejected',
    });
    expect(fake.requests).toHaveLength(3);
  });

  test('a page-validation 400 whose prose mentions a model stays page-local and retryable', async () => {
    // Built outside the callback: a classifier that cannot produce this failure
    // must fail the test rather than be swallowed by the page retry loop.
    const pageValidation = routerError(400, 'image dimensions exceed model maximum');
    expect(pageValidation.errorKind).toBe('vlm_router_request_rejected');
    const fake = client(async (_request, callIndex) => {
      if (callIndex === 0) throw pageValidation;
      return { text: `recovered page text ${callIndex}` };
    });
    const result = await pdfExtractor({ client: fake, totalPages: 2, pageRetries: 2 })
      .extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    // The word "model" in a page-validation message must not discard the
    // document, and the shared budget must still recover the page.
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toContain('recovered page text');
  });

  test('an unknown-profile refusal phrased without "model" or "profile" is classified like any other refusal', async () => {
    const fake = client(async () => {
      throw new VlmRouterError({
        status: 404,
        errorKind: 'vlm_router_request_rejected',
        retryable: true,
        message: 'Local vision endpoint returned HTTP 404: delphi/vision-dep not found.',
      });
    });
    const result = await pdfExtractor({ client: fake, totalPages: 1, pageRetries: 1 })
      .extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result).toEqual({
      status: 'failed_retryable',
      errorKind: 'vlm_router_request_rejected',
    });
    expect(fake.requests).toHaveLength(2);
  });

  test('an auth refusal is retryable at the record level so the lane, not the document, is what stops', async () => {
    const fake = client(async () => {
      throw new VlmRouterError({
        status: 401,
        errorKind: 'vlm_router_auth_failed',
        retryable: true,
        message: 'Local vision endpoint returned HTTP 401.',
      });
    });
    const result = await pdfExtractor({ client: fake, totalPages: 1, pageRetries: 1 })
      .extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result).toEqual({
      status: 'failed_retryable',
      errorKind: 'vlm_router_auth_failed',
    });
  });

  test('a down router still spends the shared page budget and reports the generic kind', async () => {
    const fake = client(async () => {
      throw new VlmRouterError({
        status: 503,
        errorKind: 'vlm_backend_unavailable',
        retryable: true,
        message: 'Local vision endpoint returned HTTP 503.',
      });
    });
    const result = await pdfExtractor({ client: fake, totalPages: 3, pageRetries: 2 })
      .extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result).toEqual({
      status: 'failed_retryable',
      errorKind: 'vlm_backend_unavailable',
    });
    expect(fake.requests).toHaveLength(3);
  });

  test('no vision failure can settle a document as terminal', async () => {
    // The only terminal verdict this extractor may reach is the payload cap; a
    // router refusal must never discard pages the lane has not seen.
    for (const status of [400, 401, 403, 404, 409, 422, 500, 503]) {
      const refusal = routerError(status, 'unknown profile delphi/vision-dep is not a served model');
      expect(refusal.retryable).toBe(true);
      const fake = client(async () => {
        throw refusal;
      });
      const result = await pdfExtractor({ client: fake, totalPages: 2, pageRetries: 0 })
        .extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
      expect(result.status).toBe('failed_retryable');
    }
  });
});

describe('vlm health probe payload', () => {
  test('the probe image is a structurally valid PNG', () => {
    const bytes = Buffer.from(VLM_PDF_PROBE_IMAGE_BASE64, 'base64');
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(bytes.indexOf(Buffer.from('IDAT'))).toBeGreaterThan(0);
    expect(bytes.subarray(bytes.length - 8).toString('latin1')).toContain('IEND');
  });

  test('the bare base64 form is the data URL with its prefix removed', () => {
    expect(VLM_PDF_PROBE_IMAGE_DATA_URL).toStartWith('data:image/png;base64,');
    expect(VLM_PDF_PROBE_IMAGE_BASE64).not.toContain(',');
    expect(`data:image/png;base64,${VLM_PDF_PROBE_IMAGE_BASE64}`)
      .toBe(VLM_PDF_PROBE_IMAGE_DATA_URL);
  });
});
