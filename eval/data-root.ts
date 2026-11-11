// Offline composition root. Never uses install path overrides to open data.
import { Database } from 'bun:sqlite';
import { existsSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { accountStorePath, accountStoreNames, olympusDataRoot } from '../src/core/olympus-layout.ts';
import { withArchiveImportCorpora } from '../src/workers/archive-import/store.ts';
import { createSourceCorpusRegistry } from '../src/core/source-corpus-registry.ts';
import { SOURCE_FAMILIES, SOURCE_TRUST_DOMAINS, type SourceFamily, type SourceTrustDomain } from '../src/core/source-index/types.ts';
import { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { TierLedger } from '../src/workers/classification/tier-ledger.ts';
import { tierLedgerIsWithin, tierSetLedgerCandidates } from '../src/workers/classification/tier-set-binding.ts';
import { tierLedgerPathForStore } from '../src/workers/classification/tier-ledger-path.ts';
import type { TierVisibilityScope } from '../src/workers/connector-store/tier-visibility.ts';

export interface EvalDataRootOptions {
  dataRoot: string;
  forbidRoots?: readonly string[];
  allowNoFdCheck?: boolean;
  /** Engine mount declarations, normally read from its JSON env setting. */
  mountDeclarations?: readonly { dbPath: string; corpusId: string; family: SourceFamily; trustDomain: SourceTrustDomain }[];
}
export interface EvalFdOptions extends EvalDataRootOptions { fdDirectory?: string }
export function assertEvalFileDescriptors(options: EvalFdOptions): void {
  const fdDirectory = options.fdDirectory ?? '/proc/self/fd';
  if (!existsSync(fdDirectory)) {
    if (options.allowNoFdCheck) return;
    throw new Error('File descriptor checks unavailable; --allow-no-fd-check is required.');
  }
  const root = realpathSync(options.dataRoot);
  const forbidden = [...(options.forbidRoots ?? []), olympusDataRoot()].map(path => resolve(path));
  for (const fd of readdirSync(fdDirectory)) {
    let target: string;
    try { target = readlinkSync(join(fdDirectory, fd)).replace(/ \(deleted\)$/, ''); } catch { continue; }
    if (!target.startsWith('/')) continue;
    // readlink names the kernel's resolved target, including a deleted file.
    if (tierLedgerIsWithin(root, target)) continue;
    if (forbidden.some(path => tierLedgerIsWithin(path, target))) {
      throw new Error('Open file descriptor in a forbidden data root.');
    }
  }
}

interface Declaration { dbPath: string; corpusId: string; family: SourceFamily; trustDomain: SourceTrustDomain; ledgerPath?: string; ledgerId?: string }
export interface EvalStoreCount { corpusId: string; family: SourceFamily; tier: SourceTrustDomain; rows: number }
export interface EvalSkippedStore { store: number; reason: 'unreadable_store' | 'unreadable_ledger' | 'unknown_identity' | 'duplicate_corpus' }
export interface EvalDataRoot {
  stores: LocalConnectorStore[];
  scopes: TierVisibilityScope[];
  storeCounts: EvalStoreCount[];
  skipped: EvalSkippedStore[];
  checkFileDescriptors(): void;
  close(): void;
}

/** Canonicalize the complete inventory before SQLite opens even a schema probe.
 * In-root directory aliases are visited once; external links always fail closed.
 * Sidecars are included, so SQLite cannot follow a linked -wal/-shm outside.
 */
function inventory(root: string): string[] {
  const files: string[] = [];
  const visited = new Set<string>();
  function walk(path: string): void {
    const canonical = realpathSync(path);
    if (!tierLedgerIsWithin(root, canonical)) throw new Error('Refusing path outside --data-root.');
    if (visited.has(canonical)) return;
    visited.add(canonical);
    if (statSync(canonical).isDirectory()) {
      for (const name of readdirSync(canonical).sort()) walk(join(canonical, name));
    } else files.push(canonical);
  }
  walk(root);
  return files;
}

// Known placements identify even empty stores. Populated extension stores carry
// their corpus in sync_runs and their family in items, as engine mounts do.
function knownIdentities(root: string, files: readonly string[]): Map<string, Omit<Declaration, 'dbPath'>> {
  const known = new Map<string, Omit<Declaration, 'dbPath'>>();
  const corpora = createSourceCorpusRegistry(withArchiveImportCorpora()).list();
  for (const corpus of corpora) {
    const identity = { corpusId: corpus.corpusId, family: corpus.family, trustDomain: corpus.trustDomain };
    const familyName = `${corpus.family}.${corpus.trustDomain}`;
    const names = accountStoreNames(corpus.sourceId, [corpus.family]);
    const storeName = names.includes(familyName) ? familyName : corpus.trustDomain;
    const folder = join(root, 'sources', corpus.sourceId, '1', 'stores', `${storeName}.sqlite`);
    known.set(folder, identity);
    try {
      const legacy = accountStorePath({ source_id: corpus.sourceId, slot: '1', layout: 'legacy' }, corpus.trustDomain);
      if (tierLedgerIsWithin(olympusDataRoot(), legacy)) known.set(join(root, legacy.slice(olympusDataRoot().length)), identity);
    } catch { /* Folder-only source. */ }
  }
  // Account slots are data, not a hardcoded single-account assumption.
  for (const file of files) {
    const parts = file.slice(root.length + 1).split('/');
    if (parts.length !== 5 || parts[0] !== 'sources' || parts[3] !== 'stores') continue;
    const firstSlot = join(root, 'sources', parts[1]!, '1', 'stores', parts[4]!);
    const identity = known.get(firstSlot);
    if (identity) known.set(file, identity);
  }
  return known;
}

function recordedMounts(root: string, explicit?: EvalDataRootOptions['mountDeclarations']): Map<string, Omit<Declaration, 'dbPath'>> {
  let raw: unknown = explicit;
  if (raw === undefined) {
    const configured = process.env.OLYMPUS_SOURCE_INDEX_CONNECTOR_STORES_JSON;
    try { raw = configured?.trim() ? JSON.parse(configured) as unknown : []; }
    catch { throw new Error('Invalid offline mount declarations.'); }
  }
  if (!Array.isArray(raw)) throw new Error('Invalid offline mount declarations.');
  const mounts = new Map<string, Omit<Declaration, 'dbPath'>>();
  for (const value of raw) {
    if (!value || typeof value !== 'object') throw new Error('Invalid offline mount declaration.');
    const { dbPath, corpusId, family, trustDomain } = value as Partial<Declaration>;
    // A pathless declaration enriches an engine-owned lane; standard placement
    // and the store's own saved identity already identify that lane here.
    if (dbPath === undefined) continue;
    if (typeof dbPath !== 'string' || !tierLedgerIsWithin(root, dbPath)) throw new Error('Refusing recorded store outside --data-root.');
    if (typeof corpusId !== 'string' || !corpusId || typeof family !== 'string' || (!(SOURCE_FAMILIES as readonly string[]).includes(family) && !/^x-[a-z0-9._-]+$/.test(family)) || !(SOURCE_TRUST_DOMAINS as readonly unknown[]).includes(trustDomain)) throw new Error('Invalid offline mount identity.');
    const path = existsSync(dbPath) ? realpathSync(dbPath) : resolve(dbPath);
    if (mounts.has(path)) throw new Error('Conflicting offline mount declarations.');
    mounts.set(path, { corpusId, family: family as SourceFamily, trustDomain: trustDomain as SourceTrustDomain });
  }
  return mounts;
}

export function openEvalDataRoot(options: EvalDataRootOptions): EvalDataRoot {
  const root = realpathSync(options.dataRoot);
  for (const forbidden of options.forbidRoots ?? []) {
    if (tierLedgerIsWithin(forbidden, root) || tierLedgerIsWithin(root, forbidden)) throw new Error('--data-root lies inside a forbidden root.');
  }
  const mounted = recordedMounts(root, options.mountDeclarations);
  const files = inventory(root);
  const known = knownIdentities(root, files);
  for (const [path, identity] of mounted) known.set(path, identity);
  const declarations: Declaration[] = [];
  const skipped: EvalSkippedStore[] = [];
  const report = (store: number, reason: EvalSkippedStore['reason']) => skipped.push({ store, reason });
  // Preflight all recorded ledger hints before constructing any store or ledger.
  // Schema probes themselves are read-only, query-only, bounded to the inventory.
  for (const [index, dbPath] of files.filter(path => /\.(sqlite|db)$/.test(path)).entries()) {
    let db: Database | undefined;
    let declaration: Declaration | undefined;
    let binding: { ledgerId: string; ledgerPath: string } | undefined;
    try {
      db = new Database(dbPath, { readonly: true, create: false });
      db.exec('PRAGMA query_only = ON;');
      if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_runs'").get()) {
        if (known.has(dbPath)) report(index, 'unreadable_store');
        continue;
      }
      const cursor = db.query("SELECT cursor FROM sync_runs WHERE sync_run_id = 'tiered-store-set-binding' AND connector_id = 'tiered_store_set_binding'").get() as { cursor: string | null } | null;
      if (cursor?.cursor) {
        const parsed: unknown = JSON.parse(cursor.cursor);
        if (!parsed || typeof parsed !== 'object' || typeof (parsed as typeof binding)?.ledgerId !== 'string' || typeof (parsed as typeof binding)?.ledgerPath !== 'string') throw new Error('Invalid binding');
        binding = parsed as NonNullable<typeof binding>;
      }
      const corpusRows = db.query('SELECT DISTINCT corpus_id FROM sync_runs').all() as { corpus_id: string }[];
      const familyRows = db.query('SELECT DISTINCT family FROM items LIMIT 2').all() as { family: SourceFamily }[];
      const placed = known.get(dbPath);
      const corpusId = corpusRows.length === 1 ? corpusRows[0]!.corpus_id : placed?.corpusId;
      const family = familyRows.length === 1 ? familyRows[0]!.family : placed?.family;
      const declared = mounted.get(dbPath);
      const trustDomain = declared?.trustDomain ?? corpusId?.split('.')[0] as SourceTrustDomain | undefined;
      if (declared && ((corpusRows.length && corpusRows.some(row => row.corpus_id !== declared.corpusId)) || (familyRows.length && familyRows.some(row => row.family !== declared.family)))) { report(index, 'unknown_identity'); continue; }
      if (!corpusId || !family || !trustDomain || !['public_safe', 'internal', 'secure_local'].includes(trustDomain)) {
        report(index, 'unknown_identity'); continue;
      }
      declaration = { dbPath, corpusId, family, trustDomain };
    } catch { report(index, 'unreadable_store'); continue; }
    finally { db?.close(); }
    if (binding) {
      const candidates = tierSetLedgerCandidates(dbPath, binding.ledgerPath)
        .filter(path => tierLedgerIsWithin(root, path) && existsSync(path));
      let ledgerPath: string | undefined;
      for (const candidate of candidates) {
        try { if (readOnlyLedgerId(candidate) === binding.ledgerId) { ledgerPath = realpathSync(candidate); break; } }
        catch { /* Report this store below; never repair its ledger. */ }
      }
      if (!ledgerPath && !tierLedgerIsWithin(root, binding.ledgerPath)) {
        throw new Error('Refusing recorded ledger outside --data-root; copy its bound ledger with the stores.');
      }
      if (!ledgerPath) { report(index, 'unreadable_ledger'); continue; }
      declaration.ledgerPath = ledgerPath;
      declaration.ledgerId = binding.ledgerId;
    } else {
      const own = tierLedgerPathForStore(dbPath);
      if (existsSync(own)) declaration.ledgerPath = realpathSync(own);
    }
    declarations.push(declaration);
  }
  const stores: LocalConnectorStore[] = [];
  const scopes: TierVisibilityScope[] = [];
  const storeCounts: EvalStoreCount[] = [];
  const ledgers = new Map<string, TierLedger>();
  const close = () => { for (const store of stores) store.close(); for (const ledger of ledgers.values()) ledger.close(); };
  const checkFileDescriptors = () => assertEvalFileDescriptors({ ...options, dataRoot: root });
  try {
    checkFileDescriptors();
    for (const [index, declaration] of declarations.entries()) {
      if (stores.some(store => store.corpusId === declaration.corpusId)) { report(index, 'duplicate_corpus'); continue; }
      let ledger: TierLedger | undefined;
      if (declaration.ledgerPath) {
        try {
          readOnlyLedgerId(declaration.ledgerPath);
          ledger = ledgers.get(declaration.ledgerPath) ?? new TierLedger({ dbPath: declaration.ledgerPath, readOnly: true });
          ledgers.set(declaration.ledgerPath, ledger);
          if (declaration.ledgerId && ledger.ledgerId() !== declaration.ledgerId) throw new Error('identity changed');
        } catch { report(index, 'unreadable_ledger'); continue; }
      }
      let store: LocalConnectorStore | undefined;
      try {
        store = new LocalConnectorStore({ ...declaration, readOnly: true, ...(ledger ? { tierLedger: ledger } : {}) });
        if (ledger) store.useTierLedger(ledger);
        // A counts-only snapshot on the same read-only schema path.
        const db = new Database(declaration.dbPath, { readonly: true, create: false });
        let rows: number;
        try { db.exec('PRAGMA query_only = ON;'); rows = (db.query('SELECT count(*) AS n FROM items').get() as { n: number }).n; }
        finally { db.close(); }
        stores.push(store);
        storeCounts.push({ corpusId: store.corpusId, family: store.family, tier: store.trustDomain, rows });
        if (ledger) {
          let scope = scopes.find(scope => scope.ledger === ledger);
          if (!scope) { scope = { ledger, corpusIds: new Set(), stores: () => stores.filter(s => scope!.corpusIds.has(s.corpusId)) }; scopes.push(scope); }
          (scope.corpusIds as Set<string>).add(store.corpusId);
        }
      } catch { store?.close(); report(index, 'unreadable_store'); }
      // Check while all handles accumulated so far are still open.
      checkFileDescriptors();
    }
    for (const scope of scopes) for (const store of stores.filter(s => scope.corpusIds.has(s.corpusId))) store.useChildVisibility({ ledger: () => scope.ledger, stores: scope.stores! });
    return { stores, scopes, storeCounts, skipped, checkFileDescriptors, close };
  } catch (error) { close(); throw error; }
}

function readOnlyLedgerId(path: string): string | undefined {
  const db = new Database(path, { readonly: true, create: false });
  try {
    db.exec('PRAGMA query_only = ON;');
    return (db.query("SELECT value FROM tier_ledger_meta WHERE key = 'ledger_id'").get() as { value: string } | null)?.value;
  } finally { db.close(); }
}
