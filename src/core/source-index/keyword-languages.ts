// Counts and hashes only are cached; corpus text never leaves this computer.
// Old stores hydrate lazily, then only changed content is classified again.
import type { Database } from 'bun:sqlite';
import { franc } from 'franc-min';

interface Profile { revision: string; signature: string; languages: readonly string[]; detected: Map<string, string> }
const profiles = new WeakMap<Database, Profile>();
export function storeKeywordLanguages(db: Database): readonly string[] {
  const revision = JSON.stringify([db.query('PRAGMA data_version').get(), db.query('SELECT total_changes() AS n').get()]);
  const cached = profiles.get(db);
  if (cached?.revision === revision) return cached.languages;
  const total = (db.query('SELECT count(*) AS n FROM chunks c JOIN items i ON i.item_pk = c.item_pk WHERE i.tombstoned = 0').get() as {n:number}).n;
  // A stable uniform hash sample caps cold detection and JS memory. All chunks
  // in small stores; around 1,024 in large stores, never over 2,048.
  const threshold = Math.floor(Math.min(1, 1024 / Math.max(1, total)) * 4294967296);
  const rows = db.query(`SELECT c.rowid AS pk, c.content_hash AS hash FROM chunks c
    JOIN items i ON i.item_pk = c.item_pk WHERE i.tombstoned = 0
      AND ((c.rowid * 2654435761) % 4294967296) < ? ORDER BY c.rowid LIMIT 2048`).all(threshold) as {pk: number; hash: string}[];
  const signature = JSON.stringify(rows);
  if (cached?.signature === signature) { cached.revision = revision; return cached.languages; }
  const detected = new Map<string, string>();
  const counts = new Map<string, number>();
  const textFor = db.query('SELECT substr(bounded_text, 1, 1000) AS text FROM chunks WHERE rowid = ?');
  for (const row of rows) {
    let language = detected.get(row.hash) ?? cached?.detected.get(row.hash);
    if (language === undefined) language = franc((textFor.get(row.pk) as {text: string}).text, {minLength:40});
    detected.set(row.hash, language);
    if (language !== 'und') counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const languages = [...counts].filter(([, count]) => count / Math.max(1, rows.length) >= 0.05)
    .sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,6).map(([language])=>language).sort();
  profiles.set(db, {revision,signature,languages,detected});
  return languages;
}
