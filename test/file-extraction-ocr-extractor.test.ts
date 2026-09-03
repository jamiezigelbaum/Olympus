// B4 parity: the local OCR lane.
//
// No real ocrmypdf or tesseract runs here; every case drives an injected
// command runner. The deterministic-rejection classifier is exercised directly
// as well, because it is the part of this lane that came from real failures.

import { describe, expect, test } from 'bun:test';
import { writeFile } from 'node:fs/promises';
import {
  ExtractionCommandError,
  ExtractionCommandTimeoutError,
  type ExtractionCommandRunRequest,
  type ExtractionCommandRunner,
} from '../src/workers/file-extraction/extractors/command-runner.ts';
import {
  OCR_EXTRACTOR_KIND,
  OCR_EXTRACTOR_VERSION,
  classifyOcrDeterministicPdfRejection,
  createOcrExtractor,
  imageExtensionForMimeType,
} from '../src/workers/file-extraction/extractors/ocr.ts';
import {
  extractorInput,
  pdfImageOnly,
  textBytes,
} from './fixtures/file-extraction-extractor-fixtures.ts';

const PDF_MIME = 'application/pdf';

function sidecarArg(request: ExtractionCommandRunRequest): string {
  const index = request.args.indexOf('--sidecar');
  const path = request.args[index + 1];
  if (!path) throw new Error('the OCR invocation carried no sidecar path');
  return path;
}

function sidecarWritingRunner(text: string, calls: ExtractionCommandRunRequest[] = []): {
  runner: ExtractionCommandRunner;
  calls: ExtractionCommandRunRequest[];
} {
  const runner: ExtractionCommandRunner = async (request) => {
    calls.push(request);
    await writeFile(sidecarArg(request), text, 'utf8');
    return { stdout: '', stderr: '' };
  };
  return { runner, calls };
}

describe('ocr extractor: registry surface', () => {
  test('declares the live kind, version, byte need and egress', () => {
    const extractor = createOcrExtractor();
    expect(extractor.kind).toBe(OCR_EXTRACTOR_KIND);
    expect(extractor.kind).toBe('local_ocr_tesseract');
    expect(extractor.version).toBe(OCR_EXTRACTOR_VERSION);
    expect(extractor.version).toBe('ocr-v1');
    expect(extractor.needsBytes).toBe(true);
    expect(extractor.egress).toBe('local');
  });

  test('accepts stays as broad as the text lane it delegates to', () => {
    const extractor = createOcrExtractor();
    expect(extractor.accepts(PDF_MIME)).toBe(true);
    expect(extractor.accepts('image/png')).toBe(true);
    expect(extractor.accepts('text/plain')).toBe(true);
    expect(extractor.accepts('application/zip')).toBe(false);
  });
});

describe('ocr extractor: PDF lane', () => {
  test('indexes the sidecar transcript with the rasterized-pdf warnings', async () => {
    const { runner, calls } = sidecarWritingRunner('Scanned invoice\n\n\n\ntotal 42');
    const result = await createOcrExtractor({ commandRunner: runner }).extract(extractorInput({
      bytes: pdfImageOnly(),
      mimeType: PDF_MIME,
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('Scanned invoice\n\ntotal 42');
    const derivation = result.derivations?.[0];
    expect(derivation?.artifactKind).toBe('document');
    expect(derivation?.structuralRef).toMatchObject({
      kind: 'whole_file',
      label: 'pdf ocr text',
      artifact: 'image_ocr',
    });
    expect(derivation?.confidence).toBe(0.5);
    expect(derivation?.warnings).toEqual([
      'ocr_text',
      'ocr_confidence_unavailable',
      'ocr_source_rasterized_pdf',
    ]);
    expect(calls[0]?.command).toBe('ocrmypdf');
    expect(calls[0]?.args).toContain('--force-ocr');
    expect(calls[0]?.args).toContain('--deskew');
  });

  test('an empty sidecar becomes a metadata-only media descriptor', async () => {
    const { runner } = sidecarWritingRunner('   \n  ');
    const result = await createOcrExtractor({ commandRunner: runner }).extract(extractorInput({
      bytes: pdfImageOnly(),
      mimeType: PDF_MIME,
      sizeBytes: 900,
    }));
    expect(result.status).toBe('metadata_only');
    expect(result).not.toHaveProperty('text');
    if (result.status !== 'metadata_only') return;
    expect(result.derivations?.[0]?.artifactKind).toBe('image_description');
    expect(result.derivations?.[0]?.warnings).toEqual(['ocr_empty', 'pdf_image_only']);
  });

  test('a deterministic rejection is terminal and carries the rejection token', async () => {
    const runner: ExtractionCommandRunner = async () => {
      throw new ExtractionCommandError({
        command: 'ocrmypdf',
        exitCode: 8,
        stdout: '',
        stderr: 'This PDF is encrypted.',
      });
    };
    const result = await createOcrExtractor({ commandRunner: runner }).extract(extractorInput({
      bytes: pdfImageOnly(),
      mimeType: PDF_MIME,
      ref: { name: 'Statement.pdf' },
    }));
    expect(result.status).toBe('failed_terminal');
    if (result.status !== 'failed_terminal') return;
    expect(result.errorKind).toBe('ocrmypdf_pdf_encrypted');
    expect(JSON.stringify(result)).not.toContain('Statement.pdf');
    expect(JSON.stringify(result)).not.toContain('encrypted.');
  });

  test('a transient command failure is retryable, not terminal', async () => {
    const runner: ExtractionCommandRunner = async () => {
      throw new ExtractionCommandError({
        command: 'ocrmypdf',
        exitCode: 1,
        stdout: '',
        stderr: 'temporary resource shortage',
      });
    };
    const result = await createOcrExtractor({ commandRunner: runner }).extract(extractorInput({
      bytes: pdfImageOnly(),
      mimeType: PDF_MIME,
    }));
    expect(result.status).toBe('failed_retryable');
    if (result.status !== 'failed_retryable') return;
    expect(result.errorKind).toBe('ocr_command_failed');
  });

  test('a timeout is retryable under its own token', async () => {
    const runner: ExtractionCommandRunner = async () => {
      throw new ExtractionCommandTimeoutError({ command: 'ocrmypdf', timeoutMs: 10 });
    };
    const result = await createOcrExtractor({ commandRunner: runner }).extract(extractorInput({
      bytes: pdfImageOnly(),
      mimeType: PDF_MIME,
    }));
    expect(result.status).toBe('failed_retryable');
    if (result.status !== 'failed_retryable') return;
    expect(result.errorKind).toBe('ocr_command_timeout');
  });
});

describe('ocr extractor: image lane', () => {
  test('indexes stdout as an image derivation', async () => {
    const calls: ExtractionCommandRunRequest[] = [];
    const runner: ExtractionCommandRunner = async (request) => {
      calls.push(request);
      return { stdout: 'Handwritten note', stderr: '' };
    };
    const result = await createOcrExtractor({ commandRunner: runner }).extract(extractorInput({
      bytes: textBytes('pretend jpeg'),
      mimeType: 'image/jpeg',
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('Handwritten note');
    expect(result.derivations?.[0]?.artifactKind).toBe('image_description');
    expect(result.derivations?.[0]?.structuralRef).toMatchObject({
      kind: 'image',
      label: 'image ocr text',
      artifact: 'image_ocr',
    });
    expect(result.derivations?.[0]?.warnings).toEqual(['ocr_text', 'ocr_confidence_unavailable']);
    expect(calls[0]?.command).toBe('tesseract');
    expect(calls[0]?.args).toContain('stdout');
    expect(calls[0]?.args[0]).toContain('input.jpg');
  });

  test('empty OCR output becomes a metadata-only media descriptor', async () => {
    const runner: ExtractionCommandRunner = async () => ({ stdout: '\n\n', stderr: '' });
    const result = await createOcrExtractor({ commandRunner: runner }).extract(extractorInput({
      bytes: textBytes('pretend png'),
      mimeType: 'image/png',
    }));
    expect(result.status).toBe('metadata_only');
    if (result.status !== 'metadata_only') return;
    expect(result.derivations?.[0]?.warnings).toEqual(['ocr_empty', 'image_only']);
  });

  test('the temp file extension follows the mime type', () => {
    expect(imageExtensionForMimeType('image/jpeg')).toBe('.jpg');
    expect(imageExtensionForMimeType('image/png')).toBe('.png');
    expect(imageExtensionForMimeType('image/tiff')).toBe('.tiff');
    expect(imageExtensionForMimeType('image/heic')).toBe('.heic');
    expect(imageExtensionForMimeType('image/unknown')).toBe('.img');
  });
});

describe('ocr extractor: non-OCR fallback', () => {
  test('anything that is neither PDF nor image is read by the composed text lane', async () => {
    let invoked = false;
    const runner: ExtractionCommandRunner = async () => {
      invoked = true;
      return { stdout: '', stderr: '' };
    };
    const result = await createOcrExtractor({ commandRunner: runner }).extract(extractorInput({
      bytes: textBytes('Plain text still gets read.'),
      mimeType: 'text/plain',
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('Plain text still gets read.');
    expect(invoked).toBe(false);
  });

  test('the fallback keeps the text lane empty-output invariant', async () => {
    const result = await createOcrExtractor().extract(extractorInput({
      bytes: textBytes('   '),
      mimeType: 'text/plain',
    }));
    expect(result.status).toBe('empty_output');
  });

  test('missing bytes is a terminal invariant failure', async () => {
    const result = await createOcrExtractor().extract(extractorInput({ mimeType: PDF_MIME }));
    expect(result.status).toBe('failed_terminal');
    if (result.status !== 'failed_terminal') return;
    expect(result.errorKind).toBe('extractor_input_missing_bytes');
  });
});

describe('ocr extractor: deterministic rejection classifier', () => {
  function commandError(input: {
    exitCode?: number | null;
    stderr?: string;
    command?: string;
  }): ExtractionCommandError {
    return new ExtractionCommandError({
      command: input.command ?? 'ocrmypdf',
      exitCode: input.exitCode ?? 1,
      stdout: '',
      stderr: input.stderr ?? '',
    });
  }

  test('exit code 8 alone is enough for the encrypted verdict', () => {
    expect(classifyOcrDeterministicPdfRejection(commandError({ exitCode: 8 })))
      .toBe('ocrmypdf_pdf_encrypted');
  });

  test('encryption wording is recognized without the exit code', () => {
    expect(classifyOcrDeterministicPdfRejection(commandError({
      stderr: 'InputFile is password-protected',
    }))).toBe('ocrmypdf_pdf_encrypted');
    expect(classifyOcrDeterministicPdfRejection(commandError({
      stderr: 'needs an owner password to open',
    }))).toBe('ocrmypdf_pdf_encrypted');
  });

  test('signed documents classify separately', () => {
    expect(classifyOcrDeterministicPdfRejection(commandError({
      stderr: 'DigitalSignatureError: refusing to modify',
    }))).toBe('ocrmypdf_pdf_signed');
    expect(classifyOcrDeterministicPdfRejection(commandError({
      stderr: 'this file is digitally signed',
    }))).toBe('ocrmypdf_pdf_signed');
  });

  test('structural damage classifies as invalid', () => {
    expect(classifyOcrDeterministicPdfRejection(commandError({
      stderr: 'InputFileError: not a PDF',
    }))).toBe('ocrmypdf_pdf_invalid');
    expect(classifyOcrDeterministicPdfRejection(commandError({
      stderr: 'unable to find trailer dictionary',
    }))).toBe('ocrmypdf_pdf_invalid');
    expect(classifyOcrDeterministicPdfRejection(commandError({
      stderr: 'qpdf: reported a damaged xref table',
    }))).toBe('ocrmypdf_pdf_invalid');
  });

  test('an unrecognized failure stays retryable, which is the safe direction', () => {
    expect(classifyOcrDeterministicPdfRejection(commandError({
      stderr: 'connection reset by peer',
    }))).toBeUndefined();
    expect(classifyOcrDeterministicPdfRejection(new Error('something else')))
      .toBeUndefined();
    expect(classifyOcrDeterministicPdfRejection('not an error')).toBeUndefined();
  });

  test('a failure from a different command is never classified as a PDF rejection', () => {
    expect(classifyOcrDeterministicPdfRejection(commandError({
      command: 'tesseract',
      exitCode: 8,
      stderr: 'encrypted',
    }))).toBeUndefined();
  });
});
