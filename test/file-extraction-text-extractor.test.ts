// B3 parity: the local text lane.
//
// Every format path the production text extractor serves is covered here, plus
// the two invariants the landed seam adds: empty extraction is `empty_output`
// and never an indexed empty string, and no failure carries free-form text.

import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_BOUNDED_TEXT_CHARS,
  DOCX_MIME_TYPE,
  PPTX_MIME_TYPE,
  XLSX_MIME_TYPE,
} from '../src/workers/file-extraction/extractors/bounded-text.ts';
import {
  TEXT_EXTRACTOR_KIND,
  TEXT_EXTRACTOR_VERSION,
  createTextExtractor,
} from '../src/workers/file-extraction/extractors/text.ts';
import {
  extractorInput,
  pdfImageOnly,
  pdfWithFlateTextStream,
  pdfWithTextLayer,
  pdfWithoutContent,
  storedZipBytes,
  textBytes,
} from './fixtures/file-extraction-extractor-fixtures.ts';

const PDF_MIME = 'application/pdf';

function wordDocument(paragraphs: readonly string[]): string {
  return `<w:document><w:body>${paragraphs
    .map((paragraph) => `<w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p>`)
    .join('')}</w:body></w:document>`;
}

function wordTable(rows: readonly (readonly string[])[]): string {
  const body = rows
    .map((row) => `<w:tr>${row
      .map((cell) => `<w:tc><w:p><w:r><w:t>${cell}</w:t></w:r></w:p></w:tc>`)
      .join('')}</w:tr>`)
    .join('');
  return `<w:tbl>${body}</w:tbl>`;
}

describe('text extractor: registry surface', () => {
  test('declares the live kind, version, byte need and egress', () => {
    const extractor = createTextExtractor();
    expect(extractor.kind).toBe(TEXT_EXTRACTOR_KIND);
    expect(extractor.kind).toBe('local_text');
    expect(extractor.version).toBe(TEXT_EXTRACTOR_VERSION);
    expect(extractor.version).toBe('2026-05-22');
    expect(extractor.needsBytes).toBe(true);
    expect(extractor.egress).toBe('local');
  });

  test('accepts the formats it can read and declines the rest', () => {
    const extractor = createTextExtractor();
    expect(extractor.accepts('text/plain')).toBe(true);
    expect(extractor.accepts('text/csv')).toBe(true);
    expect(extractor.accepts(PDF_MIME)).toBe(true);
    expect(extractor.accepts(DOCX_MIME_TYPE)).toBe(true);
    expect(extractor.accepts(XLSX_MIME_TYPE)).toBe(true);
    expect(extractor.accepts(PPTX_MIME_TYPE)).toBe(true);
    expect(extractor.accepts('image/png')).toBe(true);
    expect(extractor.accepts('application/zip')).toBe(false);
    expect(extractor.accepts(undefined)).toBe(false);
  });

  test('a mime with parameters normalizes before dispatch', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: textBytes('Charset parameters do not change the lane.'),
      mimeType: 'text/plain; charset=utf-8',
    }));
    expect(result.status).toBe('indexed');
  });
});

describe('text extractor: plain text', () => {
  test('indexes plain text as one whole-file document derivation', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: textBytes('First line.\n\n\n\nSecond line.'),
      mimeType: 'text/plain',
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('First line.\n\nSecond line.');
    expect(result.derivations).toHaveLength(1);
    expect(result.derivations?.[0]?.artifactKind).toBe('document');
    expect(result.derivations?.[0]?.structuralRef).toMatchObject({
      kind: 'whole_file',
      artifact: 'text',
    });
    expect(result.derivations?.[0]?.chars).toBe('First line.\n\nSecond line.'.length);
  });

  test('whitespace-only text is empty output, never an indexed empty string', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: textBytes('   \n\n\t  '),
      mimeType: 'text/plain',
    }));
    expect(result.status).toBe('empty_output');
    expect(result).not.toHaveProperty('text');
  });

  test('truncation rides the warning token and keeps the source length', async () => {
    const result = await createTextExtractor({ maxBoundedTextChars: 10 }).extract(extractorInput({
      bytes: textBytes('0123456789ABCDEFGHIJ'),
      mimeType: 'text/plain',
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('0123456789');
    expect(result.warnings).toContain('bounded_text_truncated');
    expect(result.derivations?.[0]?.warnings).toContain('bounded_text_truncated');
    expect(result.derivations?.[0]?.structuralRef).toMatchObject({
      sourceChars: 20,
      truncationReason: 'max_bounded_text_chars',
    });
  });

  test('the default cap indexes well past the old two-hundred-thousand boundary', async () => {
    expect(DEFAULT_MAX_BOUNDED_TEXT_CHARS).toBe(2_000_000);
    const long = 'x'.repeat(500_000);
    const result = await createTextExtractor().extract(extractorInput({
      bytes: textBytes(long),
      mimeType: 'text/plain',
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toHaveLength(500_000);
    expect(result.warnings).toBeUndefined();
    expect(result.derivations?.[0]?.warnings).toBeUndefined();
    expect(result.derivations?.[0]?.structuralRef).not.toHaveProperty('sourceChars');
  });

  test('a binary payload wearing a text mime is skipped, not decoded', async () => {
    const bytes = new Uint8Array([0x41, 0x00, 0x42, 0x00, 0x43]);
    const result = await createTextExtractor().extract(extractorInput({
      bytes,
      mimeType: 'text/plain',
    }));
    expect(result.status).toBe('skipped_unsupported');
  });

  test('an unsupported mime is skipped', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: textBytes('anything'),
      mimeType: 'application/zip',
    }));
    expect(result.status).toBe('skipped_unsupported');
  });

  test('a missing mime is skipped', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: textBytes('anything'),
    }));
    expect(result.status).toBe('skipped_unsupported');
  });

  test('missing bytes is a terminal invariant failure with a bounded kind', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      mimeType: 'text/plain',
    }));
    expect(result.status).toBe('failed_terminal');
    if (result.status !== 'failed_terminal') return;
    expect(result.errorKind).toBe('extractor_input_missing_bytes');
  });
});

describe('text extractor: delimited tables', () => {
  test('summarizes CSV as a range derivation', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: textBytes('name,amount\nfirst,10\nsecond,20\n'),
      mimeType: 'text/csv',
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toContain('CSV table');
    expect(result.text).toContain('Rows: 3');
    expect(result.text).toContain('Columns: 2');
    expect(result.text).toContain('name | amount');
    expect(result.derivations?.[0]?.artifactKind).toBe('document');
    expect(result.derivations?.[0]?.structuralRef).toMatchObject({
      kind: 'range',
      artifact: 'table',
    });
  });

  test('honours the tab delimiter for TSV', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: textBytes('a\tb\n1\t2\n'),
      mimeType: 'text/tab-separated-values',
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toContain('TSV table');
  });

  test('quoted cells keep embedded delimiters and doubled quotes', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: textBytes('label,note\n"a,b","say ""hi"""\n'),
      mimeType: 'text/csv',
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toContain('a,b | say "hi"');
  });

  test('row and column sampling emit their own warnings', async () => {
    const rows = Array.from({ length: 5 }, (_, index) => `r${index}c0,r${index}c1,r${index}c2`);
    const result = await createTextExtractor({
      maxTableSampleRows: 2,
      maxTableSampleColumns: 2,
    }).extract(extractorInput({
      bytes: textBytes(rows.join('\n')),
      mimeType: 'text/csv',
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.derivations?.[0]?.warnings).toContain('row_sample_truncated');
    expect(result.derivations?.[0]?.warnings).toContain('column_sample_truncated');
  });

  test('a delimited file with no non-empty row is empty output', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: textBytes('\n,\n,\n'),
      mimeType: 'text/csv',
    }));
    expect(result.status).toBe('empty_output');
  });
});

describe('text extractor: WordprocessingML', () => {
  const docx = storedZipBytes({
    'word/document.xml': `${wordDocument(['Proposal body', 'Second paragraph'])
      .replace('</w:body>', `${wordTable([['Item', 'Cost'], ['Widget', '10']])}</w:body>`)}`,
    'word/header1.xml': wordDocument(['Confidential header']),
    'word/footer1.xml': wordDocument(['Footer note']),
    'word/footnotes.xml': wordDocument(['A footnote']),
    'word/endnotes.xml': wordDocument(['An endnote']),
    'word/comments.xml': `<w:comments><w:comment w:id="1"><w:p><w:r><w:t>Reviewer comment</w:t></w:r></w:p></w:comment></w:comments>`,
    'docProps/core.xml': '<cp:coreProperties><dc:title>Proposal packet</dc:title><dc:creator>Author</dc:creator></cp:coreProperties>',
    'docProps/app.xml': '<Properties><Application>Writer</Application><Company>Acme</Company></Properties>',
  });

  test('collects body, notes, headers, footers, comments and properties', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: docx,
      mimeType: DOCX_MIME_TYPE,
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toContain('Proposal body\nSecond paragraph');
    expect(result.text).toContain('footnotes\nA footnote');
    expect(result.text).toContain('endnotes\nAn endnote');
    expect(result.text).toContain('header 1\nConfidential header');
    expect(result.text).toContain('footer 1\nFooter note');
    expect(result.text).toContain('comments\nReviewer comment');
    expect(result.text).toContain('document properties\nTitle: Proposal packet');
    expect(result.text).toContain('Application: Writer');
  });

  test('the body derivation is whole_file and the sections are section-scoped', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: docx,
      mimeType: DOCX_MIME_TYPE,
    }));
    if (result.status !== 'indexed') throw new Error('expected indexed');
    const refs = (result.derivations ?? []).map((derivation) => derivation.structuralRef);
    expect(refs[0]).toMatchObject({ kind: 'whole_file', label: 'document body' });
    expect(refs.map((ref) => ref?.label)).toEqual([
      'document body',
      'footnotes',
      'endnotes',
      'header 1',
      'footer 1',
      'comments',
      'document properties',
      'table 1',
    ]);
    expect((result.derivations ?? []).every((derivation) => derivation.artifactKind === 'document'))
      .toBe(true);
  });

  test('a table becomes a range derivation carrying the table token', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: docx,
      mimeType: DOCX_MIME_TYPE,
    }));
    if (result.status !== 'indexed') throw new Error('expected indexed');
    const table = (result.derivations ?? []).find(
      (derivation) => derivation.structuralRef?.artifact === 'table',
    );
    expect(table?.structuralRef).toMatchObject({ kind: 'range', index: 1, label: 'table 1' });
    expect(result.text).toContain('DOCX table 1');
    expect(result.text).toContain('Item | Cost');
  });

  test('header and footer parts are ordered numerically, not lexically', async () => {
    const bytes = storedZipBytes({
      'word/document.xml': wordDocument(['Body']),
      'word/header10.xml': wordDocument(['Header ten']),
      'word/header2.xml': wordDocument(['Header two']),
    });
    const result = await createTextExtractor().extract(extractorInput({
      bytes,
      mimeType: DOCX_MIME_TYPE,
    }));
    if (result.status !== 'indexed') throw new Error('expected indexed');
    expect((result.derivations ?? []).map((derivation) => derivation.structuralRef?.label))
      .toEqual(['document body', 'header 2', 'header 10']);
  });

  test('a document with no readable text is empty output', async () => {
    const bytes = storedZipBytes({ 'word/document.xml': '<w:document><w:body/></w:document>' });
    const result = await createTextExtractor().extract(extractorInput({
      bytes,
      mimeType: DOCX_MIME_TYPE,
    }));
    expect(result.status).toBe('empty_output');
  });

  test('a corrupt container is retryable and leaks nothing about the item', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: textBytes('not a zip archive'),
      mimeType: DOCX_MIME_TYPE,
      ref: { name: 'Corrupt Contract.docx' },
    }));
    expect(result.status).toBe('failed_retryable');
    if (result.status !== 'failed_retryable') return;
    expect(result.errorKind).toBe('structured_extraction_failed');
    expect(JSON.stringify(result)).not.toContain('Corrupt Contract');
  });
});

describe('text extractor: SpreadsheetML', () => {
  test('summarizes each sheet under its workbook name', async () => {
    const bytes = storedZipBytes({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Ledger"/><sheet name="Notes"/></sheets></workbook>',
      'xl/sharedStrings.xml': '<sst><si><t>Opening</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
        + '<row><c t="s"><v>0</v></c><c><v>42</v></c></row>'
        + '</sheetData></worksheet>',
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData>'
        + '<row><c t="inlineStr"><is><t>Second sheet</t></is></c></row>'
        + '</sheetData></worksheet>',
    });
    const result = await createTextExtractor().extract(extractorInput({
      bytes,
      mimeType: XLSX_MIME_TYPE,
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toContain('XLSX Ledger');
    expect(result.text).toContain('Opening | 42');
    expect(result.text).toContain('XLSX Notes');
    expect(result.text).toContain('Second sheet');
    const refs = (result.derivations ?? []).map((derivation) => derivation.structuralRef);
    expect(refs).toEqual([
      { kind: 'sheet', label: 'Ledger', index: 1, artifact: 'sheet' },
      { kind: 'sheet', label: 'Notes', index: 2, artifact: 'sheet' },
    ]);
    expect((result.derivations ?? []).every((derivation) => derivation.artifactKind === 'sheet'))
      .toBe(true);
  });

  test('a formula cell renders as formula and value and warns that values are static', async () => {
    const bytes = storedZipBytes({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Calc"/></sheets></workbook>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
        + '<row><c><f>SUM(A1:A2)</f><v>7</v></c></row>'
        + '</sheetData></worksheet>',
    });
    const result = await createTextExtractor().extract(extractorInput({
      bytes,
      mimeType: XLSX_MIME_TYPE,
    }));
    if (result.status !== 'indexed') throw new Error('expected indexed');
    expect(result.text).toContain('=SUM(A1:A2) -> 7');
    expect(result.derivations?.[0]?.warnings).toContain('formula_values_static');
  });

  test('a workbook with no populated row is empty output', async () => {
    const bytes = storedZipBytes({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Blank"/></sheets></workbook>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c><v></v></c></row></sheetData></worksheet>',
    });
    const result = await createTextExtractor().extract(extractorInput({
      bytes,
      mimeType: XLSX_MIME_TYPE,
    }));
    expect(result.status).toBe('empty_output');
  });
});

describe('text extractor: DrawingML presentations', () => {
  test('collects slides, slide tables and speaker notes', async () => {
    const bytes = storedZipBytes({
      'ppt/slides/slide1.xml': '<p:sld><a:t>Title slide</a:t>'
        + '<a:tbl><a:tr><a:tc><a:t>Metric</a:t></a:tc><a:tc><a:t>Value</a:t></a:tc></a:tr></a:tbl>'
        + '</p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:t>Second slide</a:t></p:sld>',
      'ppt/notesSlides/notesSlide1.xml': '<p:notes><a:t>Remember the framing</a:t></p:notes>',
    });
    const result = await createTextExtractor().extract(extractorInput({
      bytes,
      mimeType: PPTX_MIME_TYPE,
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toContain('Slide 1\nTitle slide');
    expect(result.text).toContain('Slide 2\nSecond slide');
    expect(result.text).toContain('Slide 1 table 1');
    expect(result.text).toContain('Metric | Value');
    expect(result.text).toContain('Slide 1 notes\nRemember the framing');
    const kinds = (result.derivations ?? []).map((derivation) => derivation.artifactKind);
    expect(kinds).toEqual(['slide', 'document', 'slide', 'slide']);
    const refs = (result.derivations ?? []).map((derivation) => derivation.structuralRef?.label);
    expect(refs).toEqual(['slide 1', 'slide 1 table 1', 'slide 2', 'slide 1 notes']);
  });

  test('a deck with no text is empty output', async () => {
    const bytes = storedZipBytes({ 'ppt/slides/slide1.xml': '<p:sld/>' });
    const result = await createTextExtractor().extract(extractorInput({
      bytes,
      mimeType: PPTX_MIME_TYPE,
    }));
    expect(result.status).toBe('empty_output');
  });
});

describe('text extractor: PDF text layer', () => {
  test('reads an uncompressed text stream inline, with no command', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: pdfWithTextLayer(['Invoice total 42.00']),
      mimeType: PDF_MIME,
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toContain('Invoice total 42.00');
    expect(result.derivations?.[0]?.structuralRef).toMatchObject({
      kind: 'whole_file',
      label: 'pdf text layer',
    });
    expect(result.derivations?.[0]?.warnings).toContain('pdf_text_layer_only');
  });

  test('a configured command replaces the inline decoder and adds its warning', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const extractor = createTextExtractor({
      pdfTextCommand: 'pdftotext',
      pdfTextCommandRunner: async (request) => {
        calls.push({ command: request.command, args: request.args });
        return { stdout: 'Text from the command runner.', stderr: '' };
      },
    });
    const result = await extractor.extract(extractorInput({
      bytes: pdfWithoutContent(),
      mimeType: PDF_MIME,
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('Text from the command runner.');
    expect(result.derivations?.[0]?.warnings).toContain('pdf_text_poppler');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('pdftotext');
    expect(calls[0]?.args).toContain('-layout');
    expect(calls[0]?.args).toContain('-nopgbrk');
  });

  test('an image-only PDF becomes a metadata-only media descriptor', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: pdfImageOnly(),
      mimeType: PDF_MIME,
      sizeBytes: 2048,
    }));
    expect(result.status).toBe('metadata_only');
    expect(result).not.toHaveProperty('text');
    if (result.status !== 'metadata_only') return;
    const derivation = result.derivations?.[0];
    expect(derivation?.artifactKind).toBe('image_description');
    expect(derivation?.structuralRef).toMatchObject({
      kind: 'media',
      label: 'scanned or image-only pdf',
      artifact: 'media_descriptor',
      mimeType: PDF_MIME,
      sizeBytes: 2048,
    });
    expect(derivation?.warnings).toEqual([
      'ocr_required',
      'pdf_image_only',
      'no_selectable_text_layer',
    ]);
    expect(derivation?.confidence).toBe(0.3);
  });

  test('inflates a Flate stream and decodes literal and hex TJ array tokens', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: pdfWithFlateTextStream('BT /F1 12 Tf 72 720 Td [(Alpha ) 120 <42657461>] TJ ET'),
      mimeType: PDF_MIME,
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('Alpha Beta');
    expect(result.derivations?.[0]?.warnings).toEqual(['pdf_text_layer_only']);
  });

  test('a PDF text command failure propagates, as it does in the lane this ports', async () => {
    // The production text lane let a command failure escape the extractor and
    // be settled one level up. Ported unchanged rather than converted in place,
    // so the runner must wrap extract() in its own try/catch. Flagged for B11.
    const extractor = createTextExtractor({
      pdfTextCommand: 'pdftotext',
      pdfTextCommandRunner: async () => {
        throw new Error('pdftotext is not installed');
      },
    });
    await expect(extractor.extract(extractorInput({
      bytes: pdfWithoutContent(),
      mimeType: PDF_MIME,
    }))).rejects.toThrow(/pdftotext is not installed/);
  });

  test('a PDF with neither text nor image markers is empty output', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: pdfWithoutContent(),
      mimeType: PDF_MIME,
    }));
    expect(result.status).toBe('empty_output');
  });
});

describe('text extractor: images', () => {
  test('declines an image by default, the way the local text kind does today', async () => {
    const result = await createTextExtractor().extract(extractorInput({
      bytes: textBytes('pretend png'),
      mimeType: 'image/png',
    }));
    expect(result.status).toBe('metadata_only');
    expect(result.derivations).toBeUndefined();
  });

  test('a descriptor-emitting instance produces the media descriptor instead', async () => {
    const result = await createTextExtractor({ imageMediaDescriptor: true }).extract(extractorInput({
      bytes: textBytes('pretend png'),
      mimeType: 'image/png',
      sizeBytes: 11,
    }));
    expect(result.status).toBe('metadata_only');
    if (result.status !== 'metadata_only') return;
    expect(result.derivations?.[0]?.structuralRef).toMatchObject({
      kind: 'image',
      label: 'image file',
      artifact: 'media_descriptor',
    });
    expect(result.derivations?.[0]?.warnings).toEqual(['ocr_required', 'image_only']);
  });
});
