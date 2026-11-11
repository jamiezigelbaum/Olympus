// Counts and hashes only are cached; corpus text never leaves this computer.
// Old stores hydrate lazily, then only changed content is classified again.
import type { Database } from 'bun:sqlite';
import { franc } from 'franc-min';

interface Profile { revision: string; signature: string; languages: readonly string[]; detected: Map<string, string>; sampledAtMs: number; large: boolean }
const profiles = new WeakMap<Database, Profile>();
const SAMPLE_TARGET = 1024;
const SAMPLE_LIMIT = 2048;
const READ_BATCH = 500;
// A large store's languages change slowly, but a store being written changes
// its revision on every Ask. Within this long a large store's profile is
// reused anyway: on a large install's copy the resample's random chunk reads
// cost 0.4 s each, cold, on the request thread before an Ask's keyword search
// (#1305). A small store is sampled whole, cheaply, and tracks every change.
const PROFILE_REUSE_MS = 10 * 60_000;
/** One read of the sample: the same shape as a connector store's pool read. */
export interface KeywordLanguageRead { sql: string; params: readonly unknown[]; mode: 'get' | 'all' }

/** The store's content languages, sampled on this thread: for tests and stores the read pool cannot open. */
export function storeKeywordLanguages(db: Database): readonly string[] {
  const steps = profileSteps(db);
  let next = steps.next();
  while (!next.done) {
    const read = next.value;
    const statement = db.query(read.sql);
    next = steps.next(read.mode === 'get' ? statement.get(...(read.params as never[])) : statement.all(...(read.params as never[])));
  }
  return next.value;
}

const sampling = new WeakMap<Database, Promise<readonly string[]>>();

/**
 * `storeKeywordLanguages` with the sample's reads made by `read`, a store's
 * read pool, so a cold sample never holds the request thread: on a large
 * install's copy its random chunk reads took 4.1 s of one Ask's request
 * thread (#1305). A current profile is answered without a read, and one
 * sample at a time is taken per store.
 */
export function storeKeywordLanguagesWith(db: Database, read: (query: KeywordLanguageRead) => Promise<unknown>): Promise<readonly string[]> {
  const steps = profileSteps(db);
  const first = steps.next();
  if (first.done) return Promise.resolve(first.value);
  const pending = sampling.get(db);
  if (pending) return pending;
  const run = (async () => {
    let next: IteratorResult<KeywordLanguageRead, readonly string[]> = first;
    while (!next.done) next = steps.next(await read(next.value));
    return next.value;
  })().finally(() => sampling.delete(db));
  sampling.set(db, run);
  return run;
}

/** The last profile sampled for this store, current or not; empty before the first. */
export function lastKeywordLanguages(db: Database): readonly string[] {
  return profiles.get(db)?.languages ?? [];
}

function* profileSteps(db: Database): Generator<KeywordLanguageRead, readonly string[], unknown> {
  // The change markers are this connection's own and cost no page read.
  const revision = JSON.stringify([db.query('PRAGMA data_version').get(), db.query('SELECT total_changes() AS n').get()]);
  const cached = profiles.get(db);
  if (cached?.revision === revision) return cached.languages;
  if (cached && cached.large && Date.now() - cached.sampledAtMs < PROFILE_REUSE_MS) return cached.languages;
  // A stable uniform sample caps cold detection and JS memory: every live
  // chunk in a small store, about 1,024 evenly spaced rowids in a large one,
  // never over 2,048. Every read uses the rowid, never a scan: a full pass
  // over a 700k-item store's chunks held the request thread for about 36 s
  // on Sparta (#1305), again after every write the cache could not survive.
  const maxRowid = ((yield { sql: 'SELECT max(rowid) AS n FROM chunks', params: [], mode: 'get' }) as {n: number | null} | null)?.n ?? 0;
  const large = maxRowid > SAMPLE_LIMIT;
  if (large && cached && Date.now() - cached.sampledAtMs < PROFILE_REUSE_MS) return cached.languages;
  const live = `SELECT c.rowid AS pk, c.content_hash AS hash FROM chunks c
    JOIN items i ON i.item_pk = c.item_pk WHERE i.tombstoned = 0`;
  let rows: {pk: number; hash: string}[];
  if (!large) {
    rows = (yield { sql: `${live} ORDER BY c.rowid LIMIT ${SAMPLE_LIMIT}`, params: [], mode: 'all' }) as {pk: number; hash: string}[];
  } else {
    const step = maxRowid / SAMPLE_TARGET;
    const ids = Array.from({ length: SAMPLE_TARGET }, (_, k) => Math.max(1, Math.floor((k + 1) * step)));
    rows = [];
    for (let at = 0; at < ids.length; at += READ_BATCH) {
      const batch = ids.slice(at, at + READ_BATCH);
      rows.push(...(yield { sql: `${live} AND c.rowid IN (${batch.map(() => '?').join(',')}) ORDER BY c.rowid`, params: batch, mode: 'all' }) as {pk: number; hash: string}[]);
    }
  }
  const signature = JSON.stringify(rows);
  if (cached?.signature === signature) {
    profiles.set(db, { ...cached, revision, large, sampledAtMs: Date.now() });
    return cached.languages;
  }
  const detected = new Map<string, string>();
  for (const row of rows) {
    const known = cached?.detected.get(row.hash);
    if (known !== undefined) detected.set(row.hash, known);
  }
  // Only content not classified before is read, a batch at a time.
  const unread = [...new Map(rows.filter((row) => !detected.has(row.hash)).map((row) => [row.hash, row.pk])).values()];
  for (let at = 0; at < unread.length; at += READ_BATCH) {
    const batch = unread.slice(at, at + READ_BATCH);
    const texts = (yield { sql: `SELECT c.rowid AS pk, c.content_hash AS hash, substr(c.bounded_text, 1, 1000) AS text FROM chunks c WHERE c.rowid IN (${batch.map(() => '?').join(',')})`, params: batch, mode: 'all' }) as {pk: number; hash: string; text: string | null}[];
    for (const text of texts) detected.set(text.hash, franc(text.text ?? '', {minLength:40}));
  }
  const counts = new Map<string, number>();
  for (const row of rows) {
    const language = detected.get(row.hash) ?? 'und';
    if (language !== 'und') counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  const languages = [...counts].filter(([, count]) => count / Math.max(1, rows.length) >= 0.05)
    .sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,6).map(([language])=>language).sort();
  profiles.set(db, {revision,signature,languages,detected,sampledAtMs:Date.now(),large});
  return languages;
}
