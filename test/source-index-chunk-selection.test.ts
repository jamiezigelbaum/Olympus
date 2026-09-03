import { describe, expect, test } from 'bun:test';
import {
  boundedSourceIndexChunks,
  sourceIndexChunkQueryTerms,
  sourceIndexChunkTermScore,
} from '../src/core/source-index/chunk-selection.ts';

describe('source-index relevant chunk selection', () => {
  test('uses the shared lexical vocabulary instead of question-prose stopwords', () => {
    expect(sourceIndexChunkQueryTerms('What is the alpha amount from the report?')).toEqual([
      ['alpha'], ['amount', 'balance', 'credit', 'deposit'],
    ]);
  });

  test('keeps request prose from pulling a bounded audit window away from evidence', () => {
    const selected = boundedSourceIndexChunks(
      [`${'please report document values ai '.repeat(80)}${'later '.repeat(20)}alpha amount 2400 EUR`],
      180,
      sourceIndexChunkQueryTerms('Please report the alpha amount and values from this AI document'),
    );

    expect(selected.chunks[0]).toContain('alpha amount 2400 EUR');
  });

  test('keeps ordinary conversational prose out of audit-window concept scoring', () => {
    const prose = 'could you tell me what you have in this document ';
    const selected = boundedSourceIndexChunks(
      [`${prose.repeat(80)}${'later '.repeat(20)}alpha amount 2400 EUR`],
      180,
      sourceIndexChunkQueryTerms('Could you tell me what alpha amount you have in this document?'),
    );

    expect(selected.chunks[0]).toContain('alpha amount 2400 EUR');
  });

  test('filters verbose request prose before applying the audit concept cap', () => {
    const prose = [
      'about', 'ai', 'answer', 'answers', 'can', 'could', 'document', 'documents',
      'does', 'file', 'files', 'give', 'has', 'have', 'here', 'how', 'list', 'please',
      'report', 'reports', 'result', 'results', 'search', 'show',
    ].join(' ');

    expect(sourceIndexChunkQueryTerms(`${prose} alpha amount`)).toEqual([
      ['alpha'], ['amount', 'balance', 'credit', 'deposit'],
    ]);
  });

  test('shares one budget across distinct relevant chunks', () => {
    const alpha = `${'lead '.repeat(100)}alpha value 2400 EUR${' tail'.repeat(100)}`;
    const beta = `${'lead '.repeat(100)}beta value 1200 EUR${' tail'.repeat(100)}`;
    const selected = boundedSourceIndexChunks(
      [alpha, alpha, beta],
      300,
      sourceIndexChunkQueryTerms('alpha beta values'),
    );

    expect(selected.chunks).toHaveLength(2);
    expect(selected.chunks.join('\n')).toContain('alpha value 2400 EUR');
    expect(selected.chunks.join('\n')).toContain('beta value 1200 EUR');
    expect(selected.chunks.reduce((total, chunk) => total + chunk.length, 0)).toBeLessThanOrEqual(300);
    expect(selected.truncated).toBe(true);
  });

  test('scores repeated query-term occurrences without source-specific concepts', () => {
    expect(sourceIndexChunkTermScore('alpha alpha beta', [['alpha'], ['beta']])).toBe(3);
  });

  test('scores synonym expansions as one concept when choosing an audit window', () => {
    const selected = boundedSourceIndexChunks(
      [`amount balance credit deposit ${'opening filler '.repeat(80)}amount beta 2400 EUR`],
      180,
      sourceIndexChunkQueryTerms('amount beta'),
    );

    expect(selected.chunks[0]).toContain('amount beta 2400 EUR');
    expect(selected.chunks[0]?.startsWith('amount balance credit deposit')).toBe(false);
  });

  test('clips around the densest query-term region instead of the first broad mention', () => {
    const selected = boundedSourceIndexChunks(
      [`alpha ${'opening filler '.repeat(80)}alpha beta beta gamma amount 2400 EUR`],
      180,
      sourceIndexChunkQueryTerms('alpha beta gamma amount'),
    );

    expect(selected.chunks).toHaveLength(1);
    expect(selected.chunks[0]).toContain('alpha beta beta gamma amount 2400 EUR');
    expect(selected.chunks[0]?.startsWith('alpha opening filler')).toBe(false);
    expect(selected.truncated).toBe(true);
  });
});
