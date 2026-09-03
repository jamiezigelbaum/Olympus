// cluster-09: a transcript longer than the cap must be REPORTED as truncated.
//
// The lane already carries the completeness signal — the `bounded_text_truncated`
// warning plus the pre-truncation `sourceChars` in `structuralRef` — and the
// runner forwards derivations to both the sink and the job record. The bug was
// upstream of all of that: the extractor sliced the transcript before handing it
// to `boundText`, so `sourceChars` could never exceed the cap and a half-read
// audio file was indistinguishable from a fully-read one.

import { describe, expect, test } from 'bun:test';
import {
  MAX_TRANSCRIPT_CHARS,
  createTranscriptionExtractor,
  type Transcriber,
} from '../src/workers/file-extraction/extractors/transcription.ts';
import { extractorInput, textBytes } from './fixtures/file-extraction-extractor-fixtures.ts';

const AUDIO_MIME = 'audio/mpeg';

function fixedTranscriber(result: { text: string; language?: string }): Transcriber {
  return {
    async transcribe() {
      return result;
    },
  };
}

async function transcribe(
  result: { text: string; language?: string },
  maxTranscriptChars?: number,
) {
  return createTranscriptionExtractor({
    transcriber: fixedTranscriber(result),
    ...(maxTranscriptChars !== undefined ? { maxTranscriptChars } : {}),
  }).extract(extractorInput({ bytes: textBytes('audio bytes'), mimeType: AUDIO_MIME }));
}

describe('transcription extractor: truncation is reported, not hidden', () => {
  test('an over-cap transcript rides the warning token and the true source length', async () => {
    const spoken = 'abcdefghij'.repeat(4);
    const result = await transcribe({ text: spoken }, 10);
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toBe('abcdefghij');
    expect(result.warnings).toContain('bounded_text_truncated');
    expect(result.derivations?.[0]?.warnings).toContain('bounded_text_truncated');
    expect(result.derivations?.[0]?.structuralRef).toMatchObject({
      artifact: 'text',
      sourceChars: spoken.length,
      truncationReason: 'max_bounded_text_chars',
    });
    expect(result.derivations?.[0]?.chars).toBe(10);
  });

  test('the default two-hundred-thousand cap reports the overflow too', async () => {
    const spoken = 'x'.repeat(MAX_TRANSCRIPT_CHARS + 1_000);
    const result = await transcribe({ text: spoken });
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.text).toHaveLength(MAX_TRANSCRIPT_CHARS);
    expect(result.warnings).toContain('bounded_text_truncated');
    expect(result.derivations?.[0]?.structuralRef).toMatchObject({
      sourceChars: MAX_TRANSCRIPT_CHARS + 1_000,
    });
  });

  test('a transcript inside the cap is still reported as a complete read', async () => {
    const result = await transcribe({ text: 'short enough' }, 100);
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.warnings).toBeUndefined();
    expect(result.derivations?.[0]?.warnings).toBeUndefined();
    expect(result.derivations?.[0]?.structuralRef).not.toHaveProperty('sourceChars');
    expect(result.derivations?.[0]?.structuralRef).not.toHaveProperty('truncationReason');
  });

  test('a detected language does not displace the truncation fields', async () => {
    const spoken = 'bonjour, '.repeat(10);
    const result = await transcribe({ text: spoken.trim(), language: 'fr' }, 12);
    expect(result.status).toBe('indexed');
    if (result.status !== 'indexed') return;
    expect(result.derivations?.[0]?.structuralRef).toMatchObject({
      kind: 'whole_file',
      label: 'audio transcript',
      language: 'fr',
      sourceChars: spoken.trim().length,
      truncationReason: 'max_bounded_text_chars',
    });
  });
});
