import { expect, test } from 'bun:test';
import { compactPassageWhitespace } from '../src/core/source-index/chunk-selection.ts';

function legacyCompact(text: string): string {
  return text.replace(/[^\S\n]+\n/g, '\n').replace(/[^\S\n]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
}

test('passage compaction matches the prior replacements for generated whitespace runs', () => {
  const tokens = [
    'a', '漢', '🙂', '\0', '\ud800', '\u0085', '\u200b',
    ' ', '\t', '\n', '\r', '\r\n', '\v', '\f', '\u00a0', '\u1680',
    '\u2000', '\u2001', '\u2002', '\u2003', '\u2004', '\u2005', '\u2006', '\u2007', '\u2008', '\u2009', '\u200a',
    '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff',
  ];
  const cases = new Set(['']);
  for (const left of tokens) for (const right of tokens) cases.add(`a${left}${right}b`);
  let seed = 91;
  const next = () => seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
  for (let example = 0; example < 1_000; example++) {
    const length = next() % 32;
    let text = '';
    for (let index = 0; index < length; index++) {
      const token = tokens[(next() >>> 16) % tokens.length]!;
      text += token.repeat((next() >>> 16) % 16);
    }
    cases.add(text);
  }
  for (const length of [1, 2, 3, 32, 512, 4_096]) {
    const spaces = ' '.repeat(length);
    const lines = '\r\n'.repeat(length);
    cases.add(spaces);
    cases.add(`first${spaces}last`);
    cases.add(`first${spaces}\n${spaces}last`);
    cases.add(`first${lines}\tlast`);
  }
  for (const text of cases) expect(compactPassageWhitespace(text)).toBe(legacyCompact(text));
});

test('compacts 2 MiB of spaces in under 50 ms', () => {
  const text = ' '.repeat(2 * 1024 * 1024);
  const started = performance.now();
  expect(compactPassageWhitespace(text)).toBe(' ');
  expect(performance.now() - started).toBeLessThan(50);
});
