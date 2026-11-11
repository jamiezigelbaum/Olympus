// Counts and hashes only are cached; corpus text never leaves this computer.
// Old stores hydrate lazily, then only changed content is classified again.
import type { Database } from 'bun:sqlite';
import { franc } from 'franc-min';

interface Profile { revision: string; signature: string; languages: readonly string[]; detected: Map<string, string> }
const profiles = new WeakMap<Database, Profile>();
const SAMPLE_TARGET = 1024;
const SAMPLE_LIMIT = 2048;
export function storeKeywordLanguages(db: Database): readonly string[] {
  const revision = JSON.stringify([db.query('PRAGMA data_version').get(), db.query('SELECT total_changes() AS n').get()]);
  const cached = profiles.get(db);
  if (cached?.revision === revision) return cached.languages;
  // A stable uniform sample caps cold detection and JS memory: every live
  // chunk in a small store, about 1,024 evenly spaced rowids in a large one,
  // never over 2,048. Both reads use the rowid, never a scan: this runs on
  // the request thread before every Ask's keyword search, and a full pass
  // over a 700k-item store's chunks held that thread for about 36 s on
  // Sparta (#1305), again after every write the cache could not survive.
  const maxRowid = (db.query('SELECT max(rowid) AS n FROM chunks').get() as {n: number | null}).n ?? 0;
  const live = `SELECT c.rowid AS pk, c.content_hash AS hash FROM chunks c
    JOIN items i ON i.item_pk = c.item_pk WHERE i.tombstoned = 0`;
  let rows: {pk: number; hash: string}[];
  if (maxRowid <= SAMPLE_LIMIT) {
    rows = db.query(`${live} ORDER BY c.rowid LIMIT ${SAMPLE_LIMIT}`).all() as {pk: number; hash: string}[];
  } else {
    const step = maxRowid / SAMPLE_TARGET;
    const ids = Array.from({ length: SAMPLE_TARGET }, (_, k) => Math.max(1, Math.floor((k + 1) * step)));
    rows = [];
    for (let at = 0; at < ids.length; at += 500) {
      const batch = ids.slice(at, at + 500);
      rows.push(...db.query(`${live} AND c.rowid IN (${batch.map(() => '?').join(',')}) ORDER BY c.rowid`).all(...batch) as {pk: number; hash: string}[]);
    }
  }
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
