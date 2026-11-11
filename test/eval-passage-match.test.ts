import { expect, test } from 'bun:test';
import { passageContainsQuote, passageWords, PASSAGE_MATCH_RULE } from '../eval/passage-match.ts';
import { validatePassageDataset } from '../eval/types.ts';
const quote = 'The Kestrel invoice totals forty seven dollars payable next Tuesday';
test('ordered coverage uses a local window, including dropped, inserted and OCR words', () => {
  expect(PASSAGE_MATCH_RULE).toBe('ordered-word-coverage-0.8-window-v1');
  for (const passage of [quote, quote.replace('seven ', ''), quote.replace('invoice', 'invoice [PAGE 4]'), quote.replace('Kestrel', 'Kestre1')]) expect(passageContainsQuote(passage, quote)).toBe(true);
  expect(passageContainsQuote(quote.split(' ').join(' unrelated '.repeat(10)), quote)).toBe(false);
  expect(passageContainsQuote(quote.split(' ').reverse().join(' '), quote)).toBe(false);
});
test('normalizes line break hyphens, diacritics, symbols and Portuguese', () => {
  expect(passageWords('invo-\nice CAFÉ € café')).toEqual(['invoice', 'cafe', 'cafe']);
  expect(passageContainsQuote('A reunião será na próxima terça-feira às dez horas.', 'A reuniao sera na proxima terca feira as dez horas')).toBe(true);
  expect(passageContainsQuote('Ａ reunião será na próxi-\nma terça-feira às dez horas.', 'A reunião será na próxima terça feira às dez horas')).toBe(true);
});
test('validates quote bounds without echoing private content', () => {
  for (const quote of ['private short quote', Array(41).fill('privateword').join(' ')]) {
    try { validatePassageDataset({ version: '2', description: '', questions: [{ id: 'q', shape: 'locator', question: 'sensitive question', expectedEvidence: [{ corpusId: 'internal.fixture', providerItemId: 'id', hint: '', quote }] }] }); throw new Error('not rejected'); }
    catch (error) { expect(String(error)).toContain('6 to 40'); expect(String(error)).not.toContain(quote); expect(String(error)).not.toContain('sensitive question'); }
  }
});
