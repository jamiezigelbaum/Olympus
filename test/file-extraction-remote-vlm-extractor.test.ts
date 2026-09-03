// B6 parity: the approved-remote vision lane.
//
// This is the only extractor whose egress is not local, so the two guards that
// decide whether bytes may leave the machine get their own tests, including
// the negative cases. Nothing here touches the network.

import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import type {
  VlmClient,
  VlmDescribeRequest,
  VlmDescribeResult,
} from '../src/workers/file-extraction/types.ts';
import type { ExtractionCommandRunner } from '../src/workers/file-extraction/extractors/command-runner.ts';
import {
  APPROVED_REMOTE_EXTRACTION_HOST,
  DEFAULT_REMOTE_EXTRACTION_MODEL,
  REMOTE_VLM_EXTRACTOR_KINDS,
  REMOTE_VLM_EXTRACTOR_VERSION,
  classifyRemoteVlmEndpointError,
  createRemoteVlmExtractor,
  extractJsonMessages,
  requireApprovedRemoteExtractionBaseUrl,
  requireLocalHttpBaseUrl,
} from '../src/workers/file-extraction/extractors/remote-vlm.ts';
import {
  extractorInput,
  pdfImageOnly,
  textBytes,
} from './fixtures/file-extraction-extractor-fixtures.ts';

const PDF_MIME = 'application/pdf';

function recordingClient(
  describe_: (request: VlmDescribeRequest) => VlmDescribeResult,
): VlmClient & { requests: VlmDescribeRequest[] } {
  const requests: VlmDescribeRequest[] = [];
  return {
    requests,
    async describe(request) {
      requests.push(request);
      return describe_(request);
    },
  };
}

function firstPageRenderRunner(bytes: Uint8Array): {
  runner: ExtractionCommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: ExtractionCommandRunner = async (request) => {
    calls.push(request.args);
    await writeFile(`${request.args[request.args.length - 1]}.png`, bytes);
    return { stdout: '', stderr: '' };
  };
  return { runner, calls };
}

describe('remote vlm extractor: registry surface', () => {
  test('all three registered kinds carry approved_remote egress', () => {
    expect(REMOTE_VLM_EXTRACTOR_KINDS).toEqual([
      'venice_e2ee_document',
      'venice_grok43_document',
      'venice_qwen3vl235b_document',
    ]);
    for (const kind of REMOTE_VLM_EXTRACTOR_KINDS) {
      const extractor = createRemoteVlmExtractor({ kind });
      expect(extractor.kind).toBe(kind);
      expect(extractor.version).toBe(REMOTE_VLM_EXTRACTOR_VERSION);
      expect(extractor.version).toBe('venice-v1');
      expect(extractor.needsBytes).toBe(true);
      expect(extractor.egress).toBe('approved_remote');
    }
  });

  test('defaults to the base document kind and accepts images and PDFs only', () => {
    const extractor = createRemoteVlmExtractor();
    expect(DEFAULT_REMOTE_EXTRACTION_MODEL).toBe('kimi-k3');
    expect(extractor.kind).toBe('venice_e2ee_document');
    expect(extractor.accepts('image/jpeg')).toBe(true);
    expect(extractor.accepts(PDF_MIME)).toBe(true);
    expect(extractor.accepts('text/plain')).toBe(false);
    expect(extractor.accepts(undefined)).toBe(false);
  });

  test('a non-image, non-PDF item is skipped without a describe call', async () => {
    const client = recordingClient(() => ({ text: 'never reached' }));
    const result = await createRemoteVlmExtractor({ client }).extract(extractorInput({
      bytes: textBytes('plain'),
      mimeType: 'text/plain',
    }));
    expect(result.status).toBe('skipped_unsupported');
    expect(client.requests).toHaveLength(0);
  });
});

describe('remote vlm extractor: image path', () => {
  test('sends the image bytes untouched and indexes the description', async () => {
    const bytes = textBytes('pretend jpeg');
    const client = recordingClient(() => ({ text: 'A receipt with a total of 12.40.' }));
    const result = await createRemoteVlmExtractor({ client }).extract(extractorInput({
      bytes,
      mimeType: 'image/jpeg',
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('A receipt with a total of 12.40.');
    expect(client.requests[0]?.mimeType).toBe('image/jpeg');
    expect(client.requests[0]?.bytes).toBe(bytes);
    const derivation = result.derivations?.[0];
    expect(derivation?.artifactKind).toBe('image_description');
    expect(derivation?.structuralRef).toMatchObject({
      kind: 'image',
      label: 'Venice E2EE visual extraction',
      artifact: 'image_vlm',
    });
    expect(derivation?.confidence).toBe(0.75);
    expect(derivation?.warnings).toEqual(['venice_e2ee_extraction']);
  });

  test('client-supplied confidence and warnings win', async () => {
    const client = recordingClient(() => ({
      text: 'described',
      confidence: 0.42,
      warnings: ['provider_warning'],
    }));
    const result = await createRemoteVlmExtractor({ client }).extract(extractorInput({
      bytes: textBytes('pretend png'),
      mimeType: 'image/png',
    }));
    if (result.status !== 'indexed') throw new Error('expected indexed');
    expect(result.derivations?.[0]?.confidence).toBe(0.42);
    expect(result.derivations?.[0]?.warnings).toEqual(['provider_warning']);
  });
});

describe('remote vlm extractor: PDF first-page render path', () => {
  test('renders page one and sends the rendered PNG instead of the PDF', async () => {
    const rendered = textBytes('rendered png bytes');
    const { runner, calls } = firstPageRenderRunner(rendered);
    const client = recordingClient(() => ({ text: 'Page one says hello.' }));
    const result = await createRemoteVlmExtractor({
      client,
      pdfRenderCommandRunner: runner,
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(client.requests[0]?.mimeType).toBe('image/png');
    expect(Buffer.from(client.requests[0]!.bytes).toString('utf8')).toBe('rendered png bytes');
    expect(calls[0]).toContain('-singlefile');
    expect(calls[0]).toContain('-png');
    const derivation = result.derivations?.[0];
    expect(derivation?.artifactKind).toBe('document');
    expect(derivation?.structuralRef).toMatchObject({
      kind: 'whole_file',
      label: 'Venice E2EE document extraction',
      artifact: 'text',
    });
    expect(derivation?.warnings).toEqual(['venice_e2ee_extraction', 'pdf_rendered_first_page']);
  });
});

describe('remote vlm extractor: empty response fallback', () => {
  test('an empty description for an image falls back to a media descriptor', async () => {
    const client = recordingClient(() => ({ text: '   ' }));
    const result = await createRemoteVlmExtractor({ client }).extract(extractorInput({
      bytes: textBytes('pretend png'),
      mimeType: 'image/png',
      sizeBytes: 11,
    }));
    expect(result.status).toBe('metadata_only');
    expect(result).not.toHaveProperty('text');
    if (result.status !== 'metadata_only') return;
    expect(result.derivations?.[0]?.artifactKind).toBe('image_description');
    expect(result.derivations?.[0]?.structuralRef).toMatchObject({
      kind: 'image',
      label: 'image file',
      artifact: 'media_descriptor',
    });
    expect(result.derivations?.[0]?.warnings).toEqual(['venice_empty', 'image_only']);
  });

  test('an empty description for a rendered PDF names the render in its warnings', async () => {
    const { runner } = firstPageRenderRunner(textBytes('png'));
    const client = recordingClient(() => ({ text: '' }));
    const result = await createRemoteVlmExtractor({
      client,
      pdfRenderCommandRunner: runner,
    }).extract(extractorInput({ bytes: pdfImageOnly(), mimeType: PDF_MIME }));
    expect(result.status).toBe('metadata_only');
    if (result.status !== 'metadata_only') return;
    expect(result.derivations?.[0]?.structuralRef).toMatchObject({
      kind: 'media',
      label: 'document file',
    });
    expect(result.derivations?.[0]?.warnings).toEqual([
      'venice_empty',
      'document_empty',
      'pdf_rendered_first_page',
    ]);
  });
});

describe('remote vlm extractor: configuration failures', () => {
  test('a missing client is retryable under a bounded token', async () => {
    const result = await createRemoteVlmExtractor().extract(extractorInput({
      bytes: textBytes('png'),
      mimeType: 'image/png',
    }));
    expect(result.status).toBe('failed_retryable');
    if (result.status !== 'failed_retryable') return;
    expect(result.errorKind).toBe('remote_client_not_configured');
  });

  test('missing bytes is a terminal invariant failure', async () => {
    const client = recordingClient(() => ({ text: 'unused' }));
    const result = await createRemoteVlmExtractor({ client }).extract(extractorInput({
      mimeType: 'image/png',
    }));
    expect(result.status).toBe('failed_terminal');
    expect(client.requests).toHaveLength(0);
  });
});

describe('remote vlm extractor: the egress guards', () => {
  test('the approved-remote guard accepts only the approved host over HTTPS', () => {
    expect(requireApprovedRemoteExtractionBaseUrl(`https://${APPROVED_REMOTE_EXTRACTION_HOST}/api/v1/`, 'base url'))
      .toBe(`https://${APPROVED_REMOTE_EXTRACTION_HOST}/api/v1`);
  });

  test('the approved-remote guard rejects a non-approved host', () => {
    expect(() => requireApprovedRemoteExtractionBaseUrl('https://example.com/v1', 'base url'))
      .toThrow(/approved Venice E2EE HTTPS endpoint/);
  });

  test('the approved-remote guard rejects a lookalike subdomain and plain HTTP', () => {
    expect(() => requireApprovedRemoteExtractionBaseUrl(
      `https://${APPROVED_REMOTE_EXTRACTION_HOST}.evil.example/v1`,
      'base url',
    )).toThrow(/approved Venice E2EE HTTPS endpoint/);
    expect(() => requireApprovedRemoteExtractionBaseUrl(
      `http://${APPROVED_REMOTE_EXTRACTION_HOST}/v1`,
      'base url',
    )).toThrow(/approved Venice E2EE HTTPS endpoint/);
  });

  test('the approved-remote guard rejects empty and unparseable values', () => {
    expect(() => requireApprovedRemoteExtractionBaseUrl(undefined, 'base url'))
      .toThrow(/base url is required/);
    expect(() => requireApprovedRemoteExtractionBaseUrl('   ', 'base url'))
      .toThrow(/base url is required/);
    expect(() => requireApprovedRemoteExtractionBaseUrl('not-a-url', 'base url'))
      .toThrow(/valid approved Venice HTTPS URL/);
  });

  test('the local guard accepts loopback in its several spellings', () => {
    expect(requireLocalHttpBaseUrl('http://localhost:11434/', 'local url'))
      .toBe('http://localhost:11434');
    expect(requireLocalHttpBaseUrl('http://127.0.0.1:8080', 'local url'))
      .toBe('http://127.0.0.1:8080');
    expect(requireLocalHttpBaseUrl('http://127.9.9.9:1234', 'local url'))
      .toBe('http://127.9.9.9:1234');
  });

  test('bracketed IPv6 loopback is REJECTED, as it is in the lane this ports', () => {
    // The guard compares against the bare '::1', but a parsed URL reports the
    // hostname with its brackets, so the IPv6 branch never fires. Ported
    // unchanged: this fails closed, and closing an egress guard tighter than
    // its author intended is not a defect worth "fixing" inside a port.
    expect(() => requireLocalHttpBaseUrl('https://[::1]:9000', 'local url'))
      .toThrow(/loopback/);
  });

  test('the local guard rejects anything routable', () => {
    expect(() => requireLocalHttpBaseUrl('http://10.0.0.4:11434', 'local url'))
      .toThrow(/loopback/);
    expect(() => requireLocalHttpBaseUrl('https://example.com', 'local url'))
      .toThrow(/loopback/);
    expect(() => requireLocalHttpBaseUrl('ftp://localhost', 'local url'))
      .toThrow(/loopback/);
  });
});

describe('remote vlm extractor: endpoint error classification', () => {
  test('an image validation rejection is its own category', () => {
    expect(classifyRemoteVlmEndpointError(400, JSON.stringify({
      message: 'Image failed validation checks',
    }))).toBe('venice_image_validation_failed');
    expect(classifyRemoteVlmEndpointError(400, JSON.stringify({
      errors: [{ message: 'image did not pass validation' }],
    }))).toBe('venice_image_validation_failed');
  });

  test('a message nested under `error` is NOT collected, as in the lane this ports', () => {
    // The walker reads string values at `message`/`error`/`code` and only
    // recurses through `issues`/`errors`/`details`. An object at `error` is
    // therefore a blind spot. Ported unchanged; the consequence is only a
    // coarser category, never a wrong retry decision.
    expect(extractJsonMessages(JSON.stringify({
      error: { message: 'image validation failed' },
    }))).toEqual([]);
  });

  test('a 400 without both signals is not an image validation failure', () => {
    expect(classifyRemoteVlmEndpointError(400, JSON.stringify({ message: 'bad request' })))
      .toBe('venice_http_400');
  });

  test('auth, model, rate limit and server categories', () => {
    expect(classifyRemoteVlmEndpointError(401, '')).toBe('venice_auth_failed');
    expect(classifyRemoteVlmEndpointError(403, '')).toBe('venice_auth_failed');
    expect(classifyRemoteVlmEndpointError(404, '')).toBe('venice_model_unavailable');
    expect(classifyRemoteVlmEndpointError(408, '')).toBe('venice_rate_limited');
    expect(classifyRemoteVlmEndpointError(429, '')).toBe('venice_rate_limited');
    expect(classifyRemoteVlmEndpointError(500, '')).toBe('venice_server_error');
    expect(classifyRemoteVlmEndpointError(503, '')).toBe('venice_server_error');
    expect(classifyRemoteVlmEndpointError(418, '')).toBe('venice_http_418');
  });

  test('message collection walks nested issue arrays and stops at a bound', () => {
    expect(extractJsonMessages(JSON.stringify({
      errors: [{ message: 'first' }, { issues: [{ code: 'second' }] }],
    }))).toEqual(['first', 'second']);
    expect(extractJsonMessages('')).toEqual([]);
    expect(extractJsonMessages('not json')).toEqual([]);
  });
});
