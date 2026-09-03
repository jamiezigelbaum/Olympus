// XLSX cell placement in the shared file-extraction lane.
//
// Two writer behaviours break a row that is read in document order: XLSX omits
// an empty cell entirely, and a formatted-but-empty cell is written as a
// self-closing `<c r="B3" s="2"/>` element. Both mis-attribute values to the
// wrong header, silently, on a sheet that is otherwise well formed.

import { describe, expect, test } from 'bun:test';
import { XLSX_MIME_TYPE } from '../src/workers/file-extraction/extractors/bounded-text.ts';
import { createTextExtractor } from '../src/workers/file-extraction/extractors/text.ts';
import {
  extractorInput,
  storedZipBytes,
} from './fixtures/file-extraction-extractor-fixtures.ts';

describe('text extractor: SpreadsheetML cell references', () => {
  test('places sparse cells by their column reference instead of document order', async () => {
    const bytes = storedZipBytes({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Ledger"/></sheets></workbook>',
      'xl/sharedStrings.xml': '<sst>'
        + '<si><t>Name</t></si><si><t>Amount</t></si><si><t>Currency</t></si>'
        + '<si><t>Alpha</t></si><si><t>USD</t></si>'
        + '</sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
        + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>'
        // B2 is omitted outright, the way Excel writes a blank cell.
        + '<row r="2"><c r="A2" t="s"><v>3</v></c><c r="C2" t="s"><v>4</v></c></row>'
        // B3 is present but styled-empty, so it is self-closing.
        + '<row r="3"><c r="A3" t="s"><v>3</v></c><c r="B3" s="2"/><c r="C3" t="s"><v>4</v></c></row>'
        + '</sheetData></worksheet>',
    });
    const result = await createTextExtractor().extract(extractorInput({
      bytes,
      mimeType: XLSX_MIME_TYPE,
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toContain('XLSX Ledger');
    expect(result.text).toContain('Columns: 3');
    expect(result.text).toContain('Name | Amount | Currency');
    // Both blank cells hold their column, so the currency never slides under
    // the Amount header.
    expect(result.text).toContain('Alpha |  | USD');
    expect(result.text).not.toContain('Alpha | USD');
    // A `>`-only cell match lets the self-closing B3 swallow C3 and surface its
    // shared-string index as the value.
    expect(result.text).not.toContain('Alpha | 4');
  });

  test('keeps appending in document order for writers that omit cell references', async () => {
    const bytes = storedZipBytes({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Budget"/></sheets></workbook>',
      'xl/sharedStrings.xml': '<sst><si><t>Name</t></si><si><t>Amount</t></si><si><t>Alpha</t></si></sst>',
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
        + '<row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>'
        + '<row><c t="s"><v>2</v></c><c><v>10</v></c></row>'
        + '</sheetData></worksheet>',
    });
    const result = await createTextExtractor().extract(extractorInput({
      bytes,
      mimeType: XLSX_MIME_TYPE,
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toContain('Columns: 2');
    expect(result.text).toContain('Name | Amount');
    expect(result.text).toContain('Alpha | 10');
  });

  test('a reference past the column ceiling appends instead of driving the fill', async () => {
    const bytes = storedZipBytes({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Malformed"/></sheets></workbook>',
      'xl/sharedStrings.xml': '<sst><si><t>Opening</t></si></sst>',
      // XFE is one column past Excel's XFD ceiling.
      'xl/worksheets/sheet1.xml': '<worksheet><sheetData>'
        + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="XFE1"><v>9</v></c></row>'
        + '</sheetData></worksheet>',
    });
    const result = await createTextExtractor().extract(extractorInput({
      bytes,
      mimeType: XLSX_MIME_TYPE,
    }));
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toContain('Columns: 2');
    expect(result.text).toContain('Opening | 9');
  });
});
