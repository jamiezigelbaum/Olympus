import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { queryInitialisms, sourceIndexFtsGroupQuery, sourceIndexFtsQuery, sourceIndexFtsTermGroups } from '../src/core/source-index/fts.ts';

describe('source-index FTS query modes', () => {
  test('keeps the default type-ahead prefix mode and offers bounded exact Porter tokens', () => {
    const prefixed = sourceIndexFtsQuery('invoice credited');
    const exact = sourceIndexFtsQuery('invoice credited', { prefix: false });

    expect(prefixed).toContain('"invoice"*');
    expect(prefixed).toContain('"credit"*');
    expect(exact).toContain('"invoice"');
    expect(exact).toContain('"credit"');
    expect(exact).not.toContain('*');
  });

  test('bounded answer mode does not expand a broad query across a large prefix vocabulary', () => {
    const db = new Database(':memory:');
    try {
      db.exec("CREATE VIRTUAL TABLE docs USING fts5(body, tokenize = 'porter unicode61')");
      const insert = db.prepare('INSERT INTO docs (body) VALUES (?)');
      db.transaction(() => {
        for (let index = 0; index < 5_000; index += 1) {
          insert.run(`invoicevariant${index} compliancevariant${index} amountvariant${index}`);
        }
        insert.run('invoice compliance amount');
      })();
      const count = (query: string) => (db.query(
        'SELECT COUNT(*) AS count FROM docs WHERE docs MATCH ?',
      ).get(query) as { count: number }).count;
      const naturalLanguage = 'What invoice compliance amount was recorded?';

      expect(count(sourceIndexFtsQuery(naturalLanguage, { prefix: false }))).toBe(1);
      expect(count(sourceIndexFtsQuery(naturalLanguage))).toBe(5_001);
    } finally {
      db.close();
    }
  });
});

// 2026-10-10 live: the owner's letter of intent is filed as "LOI_…". A
// question that says "Letter of Intent" never reached it by keyword.
describe('initialisms of the names in a question', () => {
  test('"Letter of Intent" is also "loi", standing for both words, matched as a whole token', () => {
    expect([...queryInitialisms('Letter of Intent notary costs')]).toEqual([['loi', ['letter', 'intent']]]);
    expect(queryInitialisms('Non-Disclosure Agreement with Acme').get('nda')).toEqual(['non', 'disclosure', 'agreement']);
    expect(sourceIndexFtsTermGroups('Letter of Intent notary')).toEqual([['letter', 'loi'], ['intent', 'loi'], ['notary']]);
    expect(sourceIndexFtsQuery('Letter of Intent notary')).toMatch(/"loi"(?!\*)/);
    expect(sourceIndexFtsGroupQuery(['letter', 'loi'], queryInitialisms('Letter of Intent'))).toBe('"letter"* OR "loi"');

    const db = new Database(':memory:');
    try {
      db.exec("CREATE VIRTUAL TABLE docs USING fts5(title, body, tokenize = 'porter unicode61')");
      db.prepare('INSERT INTO docs (title, body) VALUES (?, ?)').run('LOI_house_16-12-2025.pdf', 'Carta de intención.');
      db.prepare('INSERT INTO docs (title, body) VALUES (?, ?)').run('loire-trip.pdf', 'Notes.');
      const titles = (query: string) => (db.query('SELECT title FROM docs WHERE docs MATCH ?').all(query) as Array<{ title: string }>).map((row) => row.title);
      expect(titles(sourceIndexFtsGroupQuery(['letter', 'loi'], queryInitialisms('Letter of Intent')))).toEqual(['LOI_house_16-12-2025.pdf']);
    } finally {
      db.close();
    }
  });

  test('lower-case words, single names and numbers give none', () => {
    expect(queryInitialisms('what does my letter of intent say')).toEqual(new Map());
    expect(queryInitialisms('What did Ken Wilber say?').size).toBe(0);
    expect(queryInitialisms('June 2026 blood work').size).toBe(0);
  });
});
