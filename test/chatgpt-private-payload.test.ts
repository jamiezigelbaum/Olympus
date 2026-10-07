// The panel payload contract (design docs/design/frontier-consult-lane.md
// §A.5.1, eval B2): one set of limits, a total serializer and an exact-size
// padder. Every field filled to its limit with multilingual text, quotes,
// backslashes, lone surrogates and maximum URLs serializes inside its byte
// budget and pads to exactly 36,864 bytes; anything larger is rejected,
// never grown and never cut into invalid JSON.

import { describe, expect, test } from 'bun:test';
import type { PrivateAnswerCitation, PrivateAnswerEnvelopeV1 } from '../src/workers/chatgpt/private-answer-contract.ts';
import {
  PRIVATE_ANSWER_BYTE_BUDGETS as BUDGETS,
  PRIVATE_ANSWER_ENVELOPE_BYTES,
  PRIVATE_ANSWER_PAYLOAD_LIMITS as LIMITS,
  PrivateAnswerEnvelopeOverflowError,
  boundOutsideText,
  cleanTextField,
  fitJsonString,
  httpsUrl,
  padPrivateAnswerEnvelope,
  preparePrivateAnswer,
  serializePrivateAnswerEnvelope,
  serializePrivateAnswerPlaintext,
  utf8Bytes,
} from '../src/workers/chatgpt/private-answer-payload.ts';
import { plaintextOf } from '../src/workers/chatgpt/private-answer-jobs.ts';

const bytes = (value: unknown) => utf8Bytes(JSON.stringify(value));
const wellFormed = (text: string) => (text as unknown as { isWellFormed(): boolean }).isWellFormed();

/** Text that costs the most bytes per UTF-16 unit JSON can carry: 3-byte CJK, 2-byte escapes, surrogate pairs. */
const HEAVY = ['日本語テキスト', '"quoted"', 'back\\slash', '😀', 'Ünïcödé', 'Português: ação', 'עברית', 'العربية'];
function heavy(units: number, seed = 0): string {
  let out = '';
  let index = seed;
  while (out.length < units) {
    out += HEAVY[index % HEAVY.length];
    index += 1;
  }
  return out.slice(0, units);
}
/** Exactly the URL limit, 2,048 characters, already in normalized form. */
const LONG_URL = `https://example.com/${'p'.repeat(2_028)}`;
const TOKEN = 'A'.repeat(43);

function maxCitations(): PrivateAnswerCitation[] {
  return Array.from({ length: LIMITS.citations }, (_, index) => ({
    title: heavy(LIMITS.citationTextUnits, index),
    source: heavy(LIMITS.citationTextUnits, index + 3),
    date: heavy(LIMITS.dateUnits, index + 5),
    open: index % 2 === 0 ? { kind: 'web' as const, url: LONG_URL.slice(0, LIMITS.urlChars) } : { kind: 'mac' as const, token: TOKEN },
  }));
}

function maxEnvelope(outsideState: PrivateAnswerEnvelopeV1['outside']['state'] = 'appended'): PrivateAnswerEnvelopeV1 {
  return {
    v: 1,
    rev: Number.MAX_SAFE_INTEGER,
    state: 'answer',
    answer: heavy(LIMITS.answerUnits),
    citations: maxCitations(),
    unanswered: Array.from({ length: LIMITS.gaps }, (_, index) => heavy(LIMITS.gapUnits, index + 7)),
    followSeconds: 1_200,
    outside: {
      state: outsideState,
      text: Array.from({ length: 60 }, (_, index) => heavy(400, index)).join('\n'),
      question: heavy(2_000, 2),
      route: heavy(200, 1),
    },
  };
}

describe('the limits', () => {
  test('the byte budgets sum to the design total, inside the envelope', () => {
    expect(BUDGETS.answer + LIMITS.citations * BUDGETS.citation + LIMITS.gaps * BUDGETS.gap + BUDGETS.outside + BUDGETS.scalars).toBe(BUDGETS.total);
    expect(BUDGETS.total).toBe(35_328);
    expect(PRIVATE_ANSWER_ENVELOPE_BYTES).toBe(36_864);
    expect(BUDGETS.total).toBeLessThan(PRIVATE_ANSWER_ENVELOPE_BYTES);
    expect(LIMITS).toMatchObject({ answerUnits: 2_700, citations: 4, citationTextUnits: 300, dateUnits: 32, urlChars: 2_048, openTokenChars: 43, gaps: 4, gapUnits: 300 });
  });

  test('the jobs boundary applies them: answer 2,700 units, 4 citations, 4 gaps, 300-unit texts, 32-unit dates', () => {
    const plaintext = plaintextOf({
      answer: 'a'.repeat(70_000),
      citations: Array.from({ length: 20 }, (_, index) => ({ title: `t${index}`.padEnd(400, 'x'), source: 's'.repeat(400), date: 'd'.repeat(40), url: 'https://e.example/' })),
      unanswered: Array.from({ length: 10 }, (_, index) => `gap ${index} `.padEnd(400, 'y')),
    });
    expect(plaintext.answer).toHaveLength(2_700);
    expect(plaintext.citations).toHaveLength(4);
    expect(plaintext.unanswered).toHaveLength(4);
    expect(plaintext.citations[0]!.title).toHaveLength(300);
    expect(plaintext.citations[0]!.source).toHaveLength(300);
    expect(plaintext.citations[0]!.date).toHaveLength(32);
    expect(plaintext.unanswered![0]).toHaveLength(300);
    expect(plaintext.citations[0]!.open).toEqual({ kind: 'web', url: 'https://e.example/' });
    // Nothing the model layer produces today reaches a limit: a short answer is untouched.
    const small = plaintextOf({ answer: 'The lease ends in May.', citations: [{ title: 'Lease', source: 'Gmail', date: '2026-04-01' }], unanswered: ['the deposit'] });
    expect(small).toEqual({ v: 1, answer: 'The lease ends in May.', citations: [{ title: 'Lease', source: 'Gmail', date: '2026-04-01' }], unanswered: ['the deposit'] });
  });
});

describe('normalization', () => {
  test('lone surrogates become U+FFFD; control, bidirectional-override and zero-width characters are stripped', () => {
    const prepared = preparePrivateAnswer({
      answer: 'a\ud800b\udc00c\u0000d\u202ee\u200bf\u2066g\ufeffh\u0007i\rj\r\nk',
      citations: [{ title: 't\ud800\u0000\u202e x', source: '\u200b', date: '\u2066' }],
      unanswered: ['g\udc00\u0000ap'],
    });
    expect(prepared.answer).toBe('a\ufffdb\ufffdcdefgh' + 'i\nj\nk');
    expect(prepared.citations).toEqual([{ title: 't\ufffd x' }]);
    expect(cleanTextField('a \t  b\u0000c', 20)).toBe('a b c');
    expect(prepared.unanswered).toEqual(['g\ufffd ap']);
    expect(cleanTextField('   ', 10)).toBeUndefined();
    expect(cleanTextField(42, 10)).toBeUndefined();
  });

  test('a unit cut never leaves half a surrogate pair', () => {
    const emoji = '😀'.repeat(2_000);
    const prepared = preparePrivateAnswer({ answer: emoji });
    expect(prepared.answer.length).toBeLessThanOrEqual(LIMITS.answerUnits);
    expect(prepared.answer.length % 2).toBe(0);
    expect(wellFormed(prepared.answer)).toBe(true);
    expect(cleanTextField('😀'.repeat(200), 301)!.length).toBe(300);
  });

  test('URLs are the normalized https form, ASCII, at most 2,048 characters; anything else is dropped', () => {
    expect(httpsUrl('https://Example.com/a b/é?x=1#f')).toBe('https://example.com/a%20b/%C3%A9?x=1#f');
    expect(httpsUrl('https://münchen.example/')).toBe('https://xn--mnchen-3ya.example/');
    expect(httpsUrl('http://example.com/')).toBeUndefined();
    expect(httpsUrl('javascript:alert(1)')).toBeUndefined();
    expect(httpsUrl('https://user:pw@example.com/')).toBeUndefined();
    expect(httpsUrl('https://example.com/\u0000')).toBeUndefined();
    expect(httpsUrl(`https://example.com/${'a'.repeat(2_028)}`)).toHaveLength(2_048);
    expect(httpsUrl(`https://example.com/${'a'.repeat(2_029)}`)).toBeUndefined();
    // A URL that grows past the bound when normalized is dropped on the normalized length.
    expect(httpsUrl(`https://example.com/${'é'.repeat(1_000)}`)).toBeUndefined();
    expect(httpsUrl('not a url')).toBeUndefined();
    expect(httpsUrl(42)).toBeUndefined();
  });
});

describe('fitJsonString: a total cut inside a byte budget', () => {
  test('cuts at a code-point boundary with the mark inside the budget, for every budget', () => {
    const text = 'aé😀日"\\z'.repeat(50);
    for (let budget = 0; budget <= bytes(text) + 2; budget += 1) {
      const fitted = fitJsonString(text, budget);
      expect(bytes(fitted.text)).toBeLessThanOrEqual(Math.max(budget, 2));
      expect(wellFormed(fitted.text)).toBe(true);
      expect(JSON.parse(JSON.stringify(fitted.text))).toBe(fitted.text);
      if (fitted.cut) expect(fitted.text === '' || fitted.text.endsWith('…')).toBe(true);
      else expect(fitted.text).toBe(text);
    }
    expect(fitJsonString('short', 100)).toEqual({ text: 'short', cut: false });
  });
});

describe('the outside text policy', () => {
  test('line endings, blank-line runs, 240-character lines, 40 lines, 4,096 bytes with the mark inside', () => {
    const long = 'x'.repeat(300);
    const bounded = boundOutsideText(`\r\n\r\nfirst\r\n\n\n\nsecond\u202e\u0000\r${long}\n${Array.from({ length: 60 }, (_, index) => `line ${index}`).join('\n')}\n\n`);
    const lines = bounded.text.split('\n');
    expect(lines[0]).toBe('first');
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('second');
    expect(lines[3]).toBe(`${'x'.repeat(239)}…`);
    expect(lines).toHaveLength(LIMITS.outsideLines);
    expect(bounded.cut).toBe(true);
    const tidy = boundOutsideText('one\n\ntwo');
    expect(tidy).toEqual({ text: 'one\n\ntwo', cut: false });
    const big = boundOutsideText(Array.from({ length: 40 }, () => '日本語'.repeat(80)).join('\n'));
    expect(bytes(big.text)).toBeLessThanOrEqual(LIMITS.outsideTextBytes);
    expect(big.text.endsWith('…')).toBe(true);
    expect(big.cut).toBe(true);
    expect(boundOutsideText(42)).toEqual({ text: '', cut: false });
    expect(boundOutsideText('\n'.repeat(5_000))).toEqual({ text: '', cut: false });
  });
});

describe('the serializer', () => {
  test('every field at its limit stays inside its budget and the total', () => {
    const json = serializePrivateAnswerEnvelope(maxEnvelope());
    const parsed = JSON.parse(json) as Record<string, unknown> & { citations: PrivateAnswerCitation[]; unanswered: string[]; outside: Record<string, unknown> };
    expect(bytes(parsed.answer)).toBeLessThanOrEqual(BUDGETS.answer);
    expect(parsed.citations).toHaveLength(LIMITS.citations);
    for (const citation of parsed.citations) expect(bytes(citation)).toBeLessThanOrEqual(BUDGETS.citation);
    expect(parsed.unanswered).toHaveLength(LIMITS.gaps);
    for (const gap of parsed.unanswered) expect(bytes(gap)).toBeLessThanOrEqual(BUDGETS.gap);
    expect(bytes(parsed.outside)).toBeLessThanOrEqual(BUDGETS.outside);
    const scalars = bytes({ v: parsed.v, rev: parsed.rev, state: parsed.state, followSeconds: parsed.followSeconds }) + '"answer":,"citations":,"unanswered":,"outside":,'.length;
    expect(scalars).toBeLessThanOrEqual(BUDGETS.scalars);
    expect(utf8Bytes(json)).toBeLessThanOrEqual(BUDGETS.total);
    expect(Object.keys(parsed)).toEqual(['v', 'rev', 'state', 'answer', 'citations', 'unanswered', 'followSeconds', 'outside']);
    expect(parsed.outside).toMatchObject({ state: 'appended', cut: true });
    // Heavy text meets the byte cap before the line cap.
    expect(String(parsed.outside.text).split('\n').length).toBeLessThanOrEqual(LIMITS.outsideLines);
    expect(bytes(parsed.outside.text)).toBeLessThanOrEqual(LIMITS.outsideTextBytes);
    expect(bytes(parsed.outside.question)).toBeLessThanOrEqual(LIMITS.outsideQuestionBytes);
    expect(bytes(parsed.outside.route)).toBeLessThanOrEqual(LIMITS.outsideRouteBytes);
    // The maximum URL and the token survive whole.
    expect((parsed.citations[0]!.open as { url: string }).url).toHaveLength(LIMITS.urlChars);
    expect(parsed.citations[1]!.open).toEqual({ kind: 'mac', token: TOKEN });
  });

  test('the fill test: every field at its budget pads to exactly 36,864 bytes, for every outside state', () => {
    for (const state of ['idle', 'pending', 'appended', 'paused'] as const) {
      const padded = padPrivateAnswerEnvelope(serializePrivateAnswerEnvelope(maxEnvelope(state)));
      expect(utf8Bytes(padded)).toBe(PRIVATE_ANSWER_ENVELOPE_BYTES);
      const parsed = JSON.parse(padded) as PrivateAnswerEnvelopeV1;
      expect(parsed.outside.state).toBe(state);
      if (state !== 'appended') expect(parsed.outside).toEqual({ state });
    }
    const withdrawn = padPrivateAnswerEnvelope(serializePrivateAnswerEnvelope({ v: 1, rev: 3, state: 'withdrawn', followSeconds: 0, outside: { state: 'idle' } }));
    expect(utf8Bytes(withdrawn)).toBe(PRIVATE_ANSWER_ENVELOPE_BYTES);
    expect(JSON.parse(withdrawn)).toEqual({ v: 1, rev: 3, state: 'withdrawn', followSeconds: 0, outside: { state: 'idle' } });
  });

  test('a withdrawn envelope carries no answer, no citations and no gaps whatever it is given', () => {
    const json = serializePrivateAnswerEnvelope({ ...maxEnvelope(), state: 'withdrawn' });
    const parsed = JSON.parse(json) as PrivateAnswerEnvelopeV1;
    expect(Object.keys(parsed)).toEqual(['v', 'rev', 'state', 'followSeconds', 'outside']);
    expect(parsed).toMatchObject({ v: 1, rev: Number.MAX_SAFE_INTEGER, state: 'withdrawn', followSeconds: 1_200, outside: { state: 'appended' } });
    expect(json).not.toContain('"answer"');
    expect(json).not.toContain('"citations"');
  });

  test('the heaviest citation the limits allow fits its budget whole (3 bytes per unit is JSON\'s worst case after stripping)', () => {
    const json = serializePrivateAnswerEnvelope({
      v: 1, rev: 1, state: 'answer', answer: 'a', followSeconds: 1,
      citations: [{ title: '日'.repeat(300), source: '本'.repeat(300), date: '語'.repeat(32), open: { kind: 'web', url: LONG_URL.slice(0, 2_048) } }],
      outside: { state: 'idle' },
    });
    const citation = (JSON.parse(json) as PrivateAnswerEnvelopeV1).citations![0]!;
    expect(bytes(citation)).toBeLessThanOrEqual(BUDGETS.citation);
    expect(citation).toEqual({ title: '日'.repeat(300), source: '本'.repeat(300), date: '語'.repeat(32), open: { kind: 'web', url: LONG_URL.slice(0, 2_048) } });
  });

  test('today\'s plaintext serializes under the same limits, with its key order', () => {
    const json = serializePrivateAnswerPlaintext({ v: 1, answer: heavy(5_000), citations: maxCitations().concat(maxCitations()), unanswered: Array.from({ length: 9 }, () => heavy(500)) });
    const parsed = JSON.parse(json) as PrivateAnswerEnvelopeV1;
    expect(Object.keys(parsed)).toEqual(['v', 'answer', 'citations', 'unanswered']);
    expect(parsed.answer!.length).toBeLessThanOrEqual(LIMITS.answerUnits);
    expect(parsed.citations).toHaveLength(LIMITS.citations);
    expect(parsed.unanswered).toHaveLength(LIMITS.gaps);
    expect(utf8Bytes(json)).toBeLessThanOrEqual(BUDGETS.total - BUDGETS.outside);
    expect(serializePrivateAnswerPlaintext({ v: 1, answer: 'x', citations: [] })).toBe('{"v":1,"answer":"x","citations":[]}');
  });

  test('malformed fields never throw: the serializer is total', () => {
    const json = serializePrivateAnswerEnvelope({
      v: 1, rev: -1, state: 'answer', answer: 42 as unknown as string, citations: [null, 7, { open: { kind: 'web', url: 'ftp://x' } }, { open: { kind: 'mac', token: 'short' } }] as unknown as PrivateAnswerCitation[],
      unanswered: [null, '', 9] as unknown as string[], followSeconds: Number.NaN, outside: { state: 'bogus' as never, text: 7 as never },
    });
    expect(JSON.parse(json)).toEqual({ v: 1, rev: 0, state: 'answer', answer: '', citations: [], followSeconds: 0, outside: { state: 'idle' } });
  });
});

describe('the padder', () => {
  test('pads with spaces to exactly 36,864 bytes; JSON reads the same value', () => {
    const padded = padPrivateAnswerEnvelope('{"a":"é"}');
    expect(utf8Bytes(padded)).toBe(PRIVATE_ANSWER_ENVELOPE_BYTES);
    expect(padded.startsWith('{"a":"é"}')).toBe(true);
    expect(JSON.parse(padded)).toEqual({ a: 'é' });
    expect(utf8Bytes(padPrivateAnswerEnvelope('x'.repeat(PRIVATE_ANSWER_ENVELOPE_BYTES)))).toBe(PRIVATE_ANSWER_ENVELOPE_BYTES);
  });

  test('a plaintext over the envelope is rejected, never grown or cut', () => {
    const over = `{"a":"${'x'.repeat(PRIVATE_ANSWER_ENVELOPE_BYTES)}"}`;
    expect(() => padPrivateAnswerEnvelope(over)).toThrow(PrivateAnswerEnvelopeOverflowError);
    expect(() => padPrivateAnswerEnvelope('x'.repeat(PRIVATE_ANSWER_ENVELOPE_BYTES + 1))).toThrow(/exceeds the 36864-byte envelope/);
    // Bytes, not characters: 3-byte characters count three times.
    expect(() => padPrivateAnswerEnvelope('日'.repeat(12_289))).toThrow(PrivateAnswerEnvelopeOverflowError);
    expect(utf8Bytes(padPrivateAnswerEnvelope('日'.repeat(12_288)))).toBe(PRIVATE_ANSWER_ENVELOPE_BYTES);
  });
});
