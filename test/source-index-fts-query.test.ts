import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { sourceIndexFtsQuery } from '../src/core/source-index/fts.ts';

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
