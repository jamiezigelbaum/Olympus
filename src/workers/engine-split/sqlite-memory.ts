import type { Database } from 'bun:sqlite';

interface StoreProbe {
  db: WeakRef<Database>;
  hasTempStore: boolean;
  cacheBudget?: number;
  tempPages?: number;
  sampledAt?: number;
}

const stores = new Set<StoreProbe>();
const byDatabase = new WeakMap<Database, StoreProbe>();

export function trackSqliteStoreMemory(db: Database, hasTempStore: boolean): void {
  const store = { db: new WeakRef(db), hasTempStore };
  byDatabase.set(db, store);
  stores.add(store);
}

export function untrackSqliteStoreMemory(db: Database): void {
  const store = byDatabase.get(db);
  if (store) stores.delete(store);
  byDatabase.delete(db);
}

function pragmaNumber(db: Database, sql: string): number {
  using statement = db.prepare<unknown, []>(sql);
  return Number(statement.values()[0]?.[0] ?? 0);
}

let probing = false;
let supportsMemstat: boolean | undefined;
let allocation: { used: number; highwater: number; at: number } | undefined;
let probeErrors = 0;

/** Read cached results and schedule short connection-local probes between loop turns. */
export function sampleSqliteStoreMemory() {
  if (!probing) {
    probing = true;
    const remaining = stores.values();
    let sampleGlobal = true;
    const probeNext = () => {
      const next = remaining.next();
      if (next.done) { probing = false; return; }
      const store = next.value;
      const db = store.db.deref();
      if (!db) {
        stores.delete(store);
        setImmediate(probeNext);
        return;
      }
      try {
        if (store.cacheBudget === undefined) {
          const size = pragmaNumber(db, 'PRAGMA main.cache_size');
          store.cacheBudget = size < 0 ? -size * 1024 : size * pragmaNumber(db, 'PRAGMA main.page_size');
        }
        store.tempPages = store.hasTempStore ? pragmaNumber(db, 'PRAGMA temp.page_count') * pragmaNumber(db, 'PRAGMA temp.page_size') : 0;
        store.sampledAt = Date.now();
        if (sampleGlobal) {
          if (supportsMemstat === undefined) {
            using modules = db.prepare("SELECT 1 FROM pragma_module_list WHERE name = 'sqlite_memstat'");
            supportsMemstat = modules.get() !== null;
          }
          if (supportsMemstat) {
            using memory = db.prepare<{ value: number; hiwtr: number }, []>(
              "SELECT value, hiwtr FROM sqlite_memstat WHERE name = 'MEMORY_USED'",
            );
            const result = memory.get();
            allocation = result ? { used: result.value, highwater: result.hiwtr, at: Date.now() } : undefined;
          }
          sampleGlobal = false;
        }
      } catch {
        probeErrors++;
      }
      setImmediate(probeNext);
    };
    setImmediate(probeNext);
  }
  let cacheBudget = 0, tempPages = 0, measured = 0, age = 0;
  const now = Date.now();
  for (const store of stores.values()) {
    if (store.sampledAt === undefined) continue;
    measured++;
    cacheBudget += store.cacheBudget ?? 0;
    tempPages += store.tempPages ?? 0;
    age = Math.max(age, now - store.sampledAt);
  }
  return {
    sqlite_memory_status: allocation ? 'available' : supportsMemstat === undefined ? 'pending' : 'unavailable',
    ...(allocation ? { sqlite_memory_used_mb: allocation.used, sqlite_memory_highwater_mb: allocation.highwater,
      sqlite_memory_age_ms: Math.max(0, now - allocation.at) } : {}),
    sqlite_store_connections_sampled: measured, sqlite_store_age_ms: age,
    sqlite_store_cache_budget_mb: cacheBudget, sqlite_store_temp_pages_mb: tempPages, sqlite_probe_errors: probeErrors,
  };
}
