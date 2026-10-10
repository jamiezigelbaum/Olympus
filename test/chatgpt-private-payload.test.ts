// The panel payload contract: one set of limits and a total serializer.
// Every field filled to its limit with multilingual text, quotes,
// backslashes, lone surrogates and maximum URLs serializes inside its byte
// budget, and malformed input never throws.

import { describe, expect, test } from 'bun:test';
import type { PrivateAnswerCitation, PrivateAnswerPlaintextV1 } from '../src/workers/chatgpt/private-answer-contract.ts';
import {
  PRIVATE_ANSWER_BYTE_BUDGETS as BUDGETS,
  PRIVATE_ANSWER_PAYLOAD_LIMITS as LIMITS,
  cleanTextField,
  fitJsonString,
  httpsUrl,
  preparePrivateAnswer,
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

function maxPlaintext(): PrivateAnswerPlaintextV1 {
  return {
    v: 1,
    answer: heavy(LIMITS.answerUnits),
    citations: maxCitations(),
    unanswered: Array.from({ length: LIMITS.gaps }, (_, index) => heavy(LIMITS.gapUnits, index + 7)),
  };
}

/** The most a serialized plaintext can be: every part at its budget, plus 512 bytes of keys and punctuation. */
const PLAINTEXT_MAX_BYTES = BUDGETS.answer + LIMITS.citations * BUDGETS.citation + LIMITS.gaps * BUDGETS.gap + 512;

describe('the limits', () => {
  test('the limits and the byte budgets', () => {
    expect(BUDGETS).toEqual({ answer: 8_192, citation: 4_096, gap: 1_024 });
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

describe('the serializer', () => {
  test('every field at its limit stays inside its budget, in the contract\'s key order', () => {
    const json = serializePrivateAnswerPlaintext(maxPlaintext());
    const parsed = JSON.parse(json) as Record<string, unknown> & { citations: PrivateAnswerCitation[]; unanswered: string[] };
    expect(Object.keys(parsed)).toEqual(['v', 'answer', 'citations', 'unanswered']);
    expect(bytes(parsed.answer)).toBeLessThanOrEqual(BUDGETS.answer);
    expect(parsed.citations).toHaveLength(LIMITS.citations);
    for (const citation of parsed.citations) expect(bytes(citation)).toBeLessThanOrEqual(BUDGETS.citation);
    expect(parsed.unanswered).toHaveLength(LIMITS.gaps);
    for (const gap of parsed.unanswered) expect(bytes(gap)).toBeLessThanOrEqual(BUDGETS.gap);
    expect(utf8Bytes(json)).toBeLessThanOrEqual(PLAINTEXT_MAX_BYTES);
    // The maximum URL and the token survive whole.
    expect((parsed.citations[0]!.open as { url: string }).url).toHaveLength(LIMITS.urlChars);
    expect(parsed.citations[1]!.open).toEqual({ kind: 'mac', token: TOKEN });
  });

  test('the heaviest citation the limits allow fits its budget whole (3 bytes per unit is JSON\'s worst case after stripping)', () => {
    const json = serializePrivateAnswerPlaintext({
      v: 1, answer: 'a',
      citations: [{ title: '日'.repeat(300), source: '本'.repeat(300), date: '語'.repeat(32), open: { kind: 'web', url: LONG_URL.slice(0, 2_048) } }],
    });
    const citation = (JSON.parse(json) as PrivateAnswerPlaintextV1).citations[0]!;
    expect(bytes(citation)).toBeLessThanOrEqual(BUDGETS.citation);
    expect(citation).toEqual({ title: '日'.repeat(300), source: '本'.repeat(300), date: '語'.repeat(32), open: { kind: 'web', url: LONG_URL.slice(0, 2_048) } });
  });

  test('over-long lists and text are cut to the limits; a small plaintext is unchanged', () => {
    const json = serializePrivateAnswerPlaintext({ v: 1, answer: heavy(5_000), citations: maxCitations().concat(maxCitations()), unanswered: Array.from({ length: 9 }, () => heavy(500)) });
    const parsed = JSON.parse(json) as PrivateAnswerPlaintextV1;
    expect(Object.keys(parsed)).toEqual(['v', 'answer', 'citations', 'unanswered']);
    expect(parsed.answer.length).toBeLessThanOrEqual(LIMITS.answerUnits);
    expect(parsed.citations).toHaveLength(LIMITS.citations);
    expect(parsed.unanswered).toHaveLength(LIMITS.gaps);
    expect(utf8Bytes(json)).toBeLessThanOrEqual(PLAINTEXT_MAX_BYTES);
    expect(serializePrivateAnswerPlaintext({ v: 1, answer: 'x', citations: [] })).toBe('{"v":1,"answer":"x","citations":[]}');
  });

  test('malformed fields never throw: the serializer is total', () => {
    const json = serializePrivateAnswerPlaintext({
      v: 1, answer: 42 as unknown as string, citations: [null, 7, { open: { kind: 'web', url: 'ftp://x' } }, { open: { kind: 'mac', token: 'short' } }] as unknown as PrivateAnswerCitation[],
      unanswered: [null, '', 9] as unknown as string[],
    });
    expect(JSON.parse(json)).toEqual({ v: 1, answer: '', citations: [] });
  });
});

