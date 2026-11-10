// Whole-item calibration: the store side. Reads COPIES of an install's
// connector stores (never a live file), defines the eligible population, and
// builds each sampled item whole: its own text, every child attachment, and
// how the text was read (OCR, failures).
//
// Copy layout, one folder per account (`<source_id>@<slot>`, or `<source_id>`):
//   <stores>/<account>/secure_local.sqlite, internal.sqlite,
//                      secure_local.tier-ledger.sqlite, secure_local.tier-sniffer.sqlite
//   <stores>/file-extraction-jobs.sqlite   (optional: extraction outcomes)
// `snapshotInstall` makes it from an install without opening any install file
// with SQLite.

import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { accountFolder, accountStorePath, olympusDataRoot, sharedDataPath, type LayoutEnv } from '../../src/core/olympus-layout.ts';
import { readSourceRegistry, sourceAccountMovePending, type SourceRegistryAccount } from '../../src/core/source-registry.ts';
import { snapshotPrefilterDatabase } from '../../src/workers/classification/prefilter-training-dry-run.ts';
import { snifferInjectionRule, snifferMaterialForModel, snifferOwnMaterial } from '../../src/workers/classification/sniffer.ts';
import { tierLedgerPathForStore, tierSnifferPathForStore } from '../../src/workers/classification/tier-ledger-path.ts';
import { SNIFFER_EXCERPT_MAX_CHARS } from '../../src/workers/classification/tier-classifier.ts';
import type { CalibrationSampleItem, ExtractionNote, WholeItemChild } from './files.ts';
import { storedJudgeInput, type Row } from './stored-input.ts';
import type { PopulationUnit, WholeStratum } from './whole-item.ts';

/** What the judge is given: production keeps at most this much of an item's text. */
const JUDGE_TEXT_CHARS = 60_000;
/** What the labeling page keeps of one item or attachment: long documents whole, within reason. */
export const WHOLE_TEXT_CHARS = 400_000;
const STORE_FILES = ['secure_local.sqlite', 'internal.sqlite'] as const;
const ARCHIVE_IMPORTS = 'archive.imports';
const LEDGER_FILE = 'secure_local.tier-ledger.sqlite';
const SNIFFER_FILE = 'secure_local.tier-sniffer.sqlite';
export const EXTRACTION_FILE = 'file-extraction-jobs.sqlite';

export interface PopulationOptions {
  /** Items authored (else updated, else fetched) before this ISO date are not eligible. */
  since: string;
  /** Fewer characters of text than this, and no extraction failure to show: not eligible. */
  minTextChars: number;
}

/** Why a ledger row is not in the population, counted per source. */
export interface Exclusions {
  moving: number;
  secrets: number;
  noItem: number;
  childOfAnotherItem: number;
  beforeSince: number;
  notRead: number;
  tooLittleText: number;
}

export interface WholeUnit extends PopulationUnit {
  dir: string;
  identity: LedgerIdentity;
}

interface LedgerIdentity {
  provider: string;
  account_scope: string;
  conversation_key: string;
  provider_item_id: string;
}

interface LedgerRow extends LedgerIdentity {
  content_tier: string;
  metadata_tier: string;
  state: string;
  content_read: number;
  reasons_json: string;
}

const hasTable = (db: Database, name: string) => Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const columns = (db: Database, table: string) => new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

/** The judge's real answer in a ledger row: Private when it said so and the item went there. */
export function judgeCalledPrivate(row: Pick<LedgerRow, 'reasons_json' | 'content_tier'>): boolean {
  const code = /"content:sniffer:[^":]*:[^":]*:([^"]+)"/.exec(row.reasons_json)?.[1];
  if (!code || code === 'undecided' || code.startsWith('fail') || code.startsWith('unresolved') || code.startsWith('injection')) return false;
  return row.content_tier === 'secure';
}

/** The account folders under a copy root: those with a tier ledger. */
export function storeDirs(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, LEDGER_FILE)))
    .map((entry) => entry.name)
    .sort();
}

/** The source an account folder belongs to: its name before any `@slot`. */
export const areaOf = (dir: string) => dir.split('@')[0]!;

class Extraction {
  private readonly db: Database | undefined;
  private readonly latest: ReturnType<Database['query']> | undefined;
  private readonly artifacts: ReturnType<Database['query']> | undefined;

  constructor(root: string) {
    const path = join(root, EXTRACTION_FILE);
    this.db = undefined;
    this.latest = undefined;
    this.artifacts = undefined;
    if (!existsSync(path)) return;
    this.db = new Database(path, { readonly: true, create: false });
    if (!hasTable(this.db, 'extraction_jobs')) return;
    this.latest = this.db.query('SELECT * FROM extraction_jobs WHERE provider = ? AND local_item_id = ? ORDER BY updated_at DESC LIMIT 1');
    this.artifacts = hasTable(this.db, 'extraction_artifacts')
      ? this.db.query('SELECT artifact_kind, warnings_json FROM extraction_artifacts WHERE job_id = ? ORDER BY artifact_index')
      : undefined;
  }

  /** How the item's bytes were read, if a file extraction ever ran for it. */
  note(provider: string, localItemId: string): ExtractionNote | undefined {
    const job = this.latest?.get(provider, localItemId) as Row | null | undefined;
    if (!job) return undefined;
    const status = String(job['status'] ?? '');
    const extractorKind = String(job['extractor_kind'] ?? '');
    const parts = (this.artifacts?.all(String(job['job_id'])) ?? []) as Array<{ artifact_kind: string; warnings_json: string | null }>;
    const warnings = parts.flatMap((part) => {
      try {
        const parsed = JSON.parse(part.warnings_json ?? '[]') as unknown;
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
      } catch {
        return [];
      }
    });
    const outcome: ExtractionNote['outcome'] = ['queued', 'leased'].includes(status)
      ? 'pending'
      : status !== 'indexed'
        ? 'failed'
        : /transcri/i.test(extractorKind)
          ? 'transcript'
          : /ocr|vlm/i.test(extractorKind) || warnings.some((warning) => /ocr/i.test(warning)) || parts.some((part) => part.artifact_kind === 'image_description')
            ? 'ocr'
            : 'read';
    const errorKind = text(job['last_error_kind']);
    return {
      outcome,
      status,
      extractorKind,
      ...(errorKind ? { errorKind } : {}),
      artifactKinds: [...new Set(parts.map((part) => part.artifact_kind))].sort(),
      warnings: [...new Set(warnings)].sort(),
    };
  }

  close() { this.db?.close(); }
}

/** One account folder's copies, opened read-only. */
class AccountStores {
  readonly ledger: Database;
  private readonly sniffer: Database | undefined;
  private readonly stores: Array<{ domain: string; db: Database; item: ReturnType<Database['query']>; chunks: ReturnType<Database['query']>; children: ReturnType<Database['query']> | undefined; textChars: Map<number, number> }>;
  private readonly queued;
  private readonly copies: ReturnType<Database['query']> | undefined;

  constructor(dir: string) {
    const open = (file: string) => (existsSync(join(dir, file)) ? new Database(join(dir, file), { readonly: true, create: false }) : undefined);
    this.ledger = open(LEDGER_FILE)!;
    this.sniffer = open(SNIFFER_FILE);
    this.stores = STORE_FILES.flatMap((file) => {
      const db = open(file);
      if (!db || !hasTable(db, 'items') || !hasTable(db, 'chunks')) { db?.close(); return []; }
      const textChars = new Map((db.query('SELECT item_pk, SUM(LENGTH(bounded_text)) AS chars FROM chunks GROUP BY item_pk').all() as Array<{ item_pk: number; chars: number }>)
        .map((row) => [row.item_pk, row.chars]));
      return [{
        domain: file.replace(/\.sqlite$/, ''),
        db,
        item: db.query('SELECT * FROM items WHERE provider = ? AND account_scope = ? AND normalized_conversation = ? AND provider_item_id = ? AND tombstoned = 0'),
        chunks: db.query('SELECT bounded_text FROM chunks WHERE item_pk = ? ORDER BY chunk_index'),
        children: columns(db, 'items').has('parent_local_item_id')
          ? db.query('SELECT * FROM items WHERE parent_local_item_id = ? AND tombstoned = 0 ORDER BY provider_item_id')
          : undefined,
        textChars,
      }];
    });
    this.copies = hasTable(this.ledger, 'tier_copies')
      ? this.ledger.query(`SELECT trust_domain, layers FROM tier_copies WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND copy_state = 'current'`)
      : undefined;
    this.queued = this.sniffer && hasTable(this.sniffer, 'sniffer_questions')
      ? this.sniffer.query(`SELECT material FROM sniffer_questions WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND pass = 'content'`)
      : undefined;
  }

  ledgerRows(): LedgerRow[] {
    return this.ledger.query('SELECT * FROM tier_items ORDER BY provider, account_scope, conversation_key, provider_item_id').all() as LedgerRow[];
  }

  /**
   * The stored row of an item. The ledger's current copy serving the content
   * decides which store's copy that is: a superseded copy can stay behind after
   * a tier move. An item with no copy records (from before them) falls back to
   * the copy with the most text.
   */
  find(identity: LedgerIdentity): { row: Row; chars: number; store: number } | undefined {
    const current = (this.copies?.all(identity.provider, identity.account_scope, identity.conversation_key, identity.provider_item_id) ?? []) as Array<{ trust_domain: string; layers: string }>;
    const serving = new Set(current.filter((copy) => copy.layers === 'both' || copy.layers === 'content').map((copy) => copy.trust_domain));
    const names = new Set(current.filter((copy) => copy.layers === 'metadata').map((copy) => copy.trust_domain));
    const allowed = serving.size > 0 ? serving : names.size > 0 ? names : undefined;
    let found: { row: Row; chars: number; store: number } | undefined;
    this.stores.forEach((store, index) => {
      if (allowed && !allowed.has(store.domain)) return;
      const row = store.item.get(identity.provider, identity.account_scope, identity.conversation_key, identity.provider_item_id) as Row | null;
      if (!row) return;
      const chars = store.textChars.get(row['item_pk'] as number) ?? 0;
      if (!found || chars > found.chars) found = { row, chars, store: index };
    });
    return found;
  }

  textOf(found: { row: Row; store: number }): string {
    return (this.stores[found.store]!.chunks.all(found.row['item_pk'] as number) as Array<{ bounded_text: string }>).map((part) => part.bounded_text).join('\n');
  }

  /** Every child of an item, once each, from its current copy (as `find` picks it). */
  children(localItemId: string): Array<{ row: Row; store: number }> {
    const identities = new Map<string, LedgerIdentity>();
    for (const store of this.stores) {
      for (const row of (store.children?.all(localItemId) ?? []) as Row[]) {
        const identity = {
          provider: String(row['provider']),
          account_scope: String(row['account_scope']),
          conversation_key: String(row['normalized_conversation'] ?? ''),
          provider_item_id: String(row['provider_item_id']),
        };
        identities.set(JSON.stringify(identity), identity);
      }
    }
    return [...identities.values()].flatMap((identity) => {
      const found = this.find(identity);
      return found ? [found] : [];
    });
  }

  queuedInput(identity: LedgerIdentity): string | undefined {
    return (this.queued?.get(identity.provider, identity.account_scope, identity.conversation_key, identity.provider_item_id) as { material: string } | null)?.material;
  }

  close() {
    this.ledger.close();
    this.sniffer?.close();
    for (const store of this.stores) store.db.close();
  }
}

const whenOf = (row: Row) => text(row['authored_at']) ?? text(row['updated_at']) ?? text(row['fetched_at']) ?? '';

/**
 * The eligible population: every ledger row of every account that passes the
 * same filters the sample will see, counted per source after those filters.
 */
export function buildPopulation(root: string, options: PopulationOptions): {
  units: WholeUnit[];
  exclusions: Record<string, Exclusions>;
  ledgerRows: Record<string, number>;
} {
  const extraction = new Extraction(root);
  const units: WholeUnit[] = [];
  const exclusions: Record<string, Exclusions> = {};
  const ledgerRows: Record<string, number> = {};
  try {
    for (const dir of storeDirs(root)) {
      const area = areaOf(dir);
      const skip = (exclusions[area] ??= { moving: 0, secrets: 0, noItem: 0, childOfAnotherItem: 0, beforeSince: 0, notRead: 0, tooLittleText: 0 });
      const stores = new AccountStores(join(root, dir));
      try {
        for (const row of stores.ledgerRows()) {
          ledgerRows[area] = (ledgerRows[area] ?? 0) + 1;
          if (row.state === 'moving') { skip.moving += 1; continue; }
          if (row.content_tier === 'secrets' || row.metadata_tier === 'secrets') { skip.secrets += 1; continue; }
          const found = stores.find(row);
          if (!found) { skip.noItem += 1; continue; }
          if (text(found.row['parent_local_item_id'])) { skip.childOfAnotherItem += 1; continue; }
          if (whenOf(found.row) < options.since) { skip.beforeSince += 1; continue; }
          const failed = () => extraction.note(row.provider, String(found.row['local_item_id']))?.outcome === 'failed';
          if (found.chars < options.minTextChars) {
            // An item whose text could not be read is in scope: the judge saw only its names.
            if (!failed()) { skip.tooLittleText += 1; continue; }
          } else if (row.content_read !== 1) { skip.notRead += 1; continue; }
          const stratum: WholeStratum = judgeCalledPrivate(row) ? 'judge_private' : 'other';
          units.push({
            key: `${dir}\u0000${row.provider}\u0000${row.account_scope}\u0000${row.conversation_key}\u0000${row.provider_item_id}`,
            area,
            stratum,
            dir,
            identity: { provider: row.provider, account_scope: row.account_scope, conversation_key: row.conversation_key, provider_item_id: row.provider_item_id },
          });
        }
      } finally {
        stores.close();
      }
    }
  } finally {
    extraction.close();
  }
  return { units, exclusions, ledgerRows };
}

const cut = (value: string) => ({ text: value.slice(0, WHOLE_TEXT_CHARS), truncatedChars: Math.max(0, value.length - WHOLE_TEXT_CHARS) });

/** Group keys that join related items: conversation, folder, and an email's sender (its template). */
export function groupsOf(area: string, row: Row): string[] {
  const groups: string[] = [];
  const conversation = text(row['provider_conversation_id']);
  if (conversation) groups.push(`conversation:${area}:${conversation}`);
  const locator = text(row['locator_uri']);
  if (locator?.startsWith('/')) groups.push(`folder:${area}:${dirname(locator)}`);
  // Sources such as Drive keep folder ancestry here instead of in a path. Items with the
  // same ancestry list sit in the same folder, so the whole list is the folder's identity.
  const keysJson = text(row['source_scope_folder_keys_json']);
  if (keysJson) {
    try {
      const keys = JSON.parse(keysJson) as unknown;
      if (Array.isArray(keys)) {
        const ancestry = keys.filter((key): key is string => typeof key === 'string' && key.length > 0);
        if (ancestry.length > 0) groups.push(`folderkeys:${area}:${JSON.stringify(ancestry)}`);
      }
    } catch {
      // An unreadable key list adds no group.
    }
  }
  const sender = text(row['sender_id']) ?? text(row['sender_label']);
  if (sender && String(row['mime_type'] ?? '') === 'message/rfc822') groups.push(`sender:${area}:${sender.toLowerCase()}`);
  return groups;
}

/** Each picked unit, whole. The id is assigned by the caller. */
export function buildWholeItems(root: string, picked: ReadonlyArray<WholeUnit & { inclusionProbability: number }>, ids: readonly string[]): CalibrationSampleItem[] {
  const extraction = new Extraction(root);
  const open = new Map<string, AccountStores>();
  const storesFor = (dir: string) => open.get(dir) ?? open.set(dir, new AccountStores(join(root, dir))).get(dir)!;
  try {
    return picked.map((unit, index): CalibrationSampleItem => {
      const stores = storesFor(unit.dir);
      const found = stores.find(unit.identity)!;
      const own = stores.textOf(found);
      const provider = String(found.row['provider']);
      const input = storedJudgeInput(found.row, own.slice(0, JUDGE_TEXT_CHARS), provider);
      const queued = stores.queuedInput(unit.identity);
      const judgeSees = queued ?? input.material;
      const injection = judgeSees !== undefined && snifferInjectionRule(snifferOwnMaterial(snifferMaterialForModel(judgeSees))) !== undefined;
      const children: WholeItemChild[] = stores.children(String(found.row['local_item_id'])).map((child) => {
        const note = extraction.note(String(child.row['provider']), String(child.row['local_item_id']));
        return {
          name: text(child.row['title']) ?? '(no name)',
          mimeType: String(child.row['mime_type'] ?? ''),
          ...cut(stores.textOf(child)),
          ...(note ? { extraction: note } : {}),
        };
      });
      const note = extraction.note(provider, String(found.row['local_item_id']));
      const whole = cut(own);
      const locator = text(found.row['locator_uri']);
      return {
        id: ids[index]!,
        path: '',
        rel: `${unit.area}${locator?.startsWith('/') ? locator : `/${text(found.row['title']) ?? ids[index]}`}`,
        name: text(found.row['title']) ?? ids[index]!,
        area: unit.area,
        mimeType: String(found.row['mime_type'] ?? ''),
        sizeBytes: typeof found.row['size_bytes'] === 'number' ? found.row['size_bytes'] : own.length,
        modifiedAt: whenOf(found.row),
        recordsHint: false,
        text: whole.text,
        source: provider,
        stratum: unit.stratum,
        signals: input.signals,
        ...(judgeSees !== undefined ? { judgeSees, judgeSeesExact: queued !== undefined } : {}),
        inclusionProbability: unit.inclusionProbability,
        whole: {
          groups: groupsOf(unit.area, found.row),
          truncatedChars: whole.truncatedChars,
          children,
          ...(note ? { extraction: note } : {}),
          judgeReadsAll: own.replace(/\s+/g, ' ').trim().length <= SNIFFER_EXCERPT_MAX_CHARS,
          injection,
        },
      };
    });
  } finally {
    for (const stores of open.values()) stores.close();
    extraction.close();
  }
}

/** An account's store sets: one for most sources, one per family for imported archives. */
export function accountStoreSets(account: SourceRegistryAccount, env: LayoutEnv): Array<{ folder: string; secure: string; internal?: string }> {
  const storeOf = (name: string) => {
    try {
      return accountStorePath(account, name, env);
    } catch {
      return undefined;
    }
  };
  const set = (folder: string, secure: string | undefined, internal: string | undefined) => (secure
    ? [{ folder, secure, ...(internal ? { internal } : {}) }]
    : []);
  if (account.source_id !== ARCHIVE_IMPORTS) {
    return set(`${account.source_id}@${account.slot}`, storeOf('secure_local'), storeOf('internal'));
  }
  // Imported archives (a Telegram or WhatsApp export, say) keep one store set per family.
  const families = new Set<string>();
  if (account.layout === 'folder') {
    const stores = join(accountFolder(account, env), 'stores');
    for (const name of existsSync(stores) ? readdirSync(stores) : []) {
      const found = /^([A-Za-z0-9_-]+)\.secure_local\.sqlite$/.exec(name);
      if (found) families.add(found[1]!);
    }
  } else {
    const root = olympusDataRoot(env);
    const names = existsSync(root) ? readdirSync(root) : [];
    for (const name of names) {
      const found = /^archive-([A-Za-z0-9_-]+)-connector-store\.sqlite$/.exec(name);
      if (!found) continue;
      // `archive-<family>-internal-…` is that family's Personal store, not a family of its own.
      const base = /^(.+)-(internal|public)$/.exec(found[1]!)?.[1];
      if (base && names.includes(`archive-${base}-connector-store.sqlite`)) continue;
      families.add(found[1]!);
    }
  }
  return [...families].sort().flatMap((family) =>
    set(`${ARCHIVE_IMPORTS}.${family}@${account.slot}`, storeOf(`${family}.secure_local`), storeOf(`${family}.internal`)));
}

/**
 * Copies an install's connector stores (imported archives included, one set
 * per family), their ledgers and sniffer files, and the extraction jobs, into
 * `dest` in the layout above. Each file is copied with its WAL by production's
 * snapshot (no SQLite handle on an install file; an overlapping write is
 * retried or refused), then the copy is folded into one file so it opens
 * read-only. `env` picks the install: this machine's by default, or a copied
 * home (`installEnv`).
 */
export function snapshotInstall(dest: string, env: LayoutEnv = process.env): { accounts: number; storeSets: number; files: number; skippedAccounts: number } {
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  chmodSync(dest, 0o700);
  const registry = readSourceRegistry(env);
  let files = 0;
  let accounts = 0;
  let storeSets = 0;
  let skippedAccounts = 0;
  const copy = (from: string, to: string) => {
    if (!existsSync(from)) return;
    snapshotPrefilterDatabase(from, to, () => {});
    const db = new Database(to);
    try {
      db.exec('PRAGMA journal_mode = DELETE');
    } finally {
      db.close();
    }
    chmodSync(to, 0o600);
    files += 1;
  };
  for (const account of registry.accounts) {
    if (account.state !== 'active' || sourceAccountMovePending(account)) { skippedAccounts += 1; continue; }
    const sets = accountStoreSets(account, env).filter((found) => existsSync(tierLedgerPathForStore(found.secure)));
    if (sets.length === 0) { skippedAccounts += 1; continue; }
    for (const found of sets) {
      const folder = join(dest, found.folder);
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      copy(found.secure, join(folder, 'secure_local.sqlite'));
      copy(tierLedgerPathForStore(found.secure), join(folder, LEDGER_FILE));
      copy(tierSnifferPathForStore(found.secure), join(folder, SNIFFER_FILE));
      if (found.internal) copy(found.internal, join(folder, 'internal.sqlite'));
      storeSets += 1;
    }
    accounts += 1;
  }
  copy(sharedDataPath('file-extraction-jobs', env), join(dest, EXTRACTION_FILE));
  return { accounts, storeSets, files, skippedAccounts };
}

/**
 * The layout of a COPIED home from another machine: stores are read where
 * Olympus's default layout puts them under that home. A copied Linux engine
 * receipt is ignored, since its paths name the other machine.
 */
export function installEnv(home: string): LayoutEnv {
  return {
    HOME: home,
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    OPENCLAW_STATE_DIR: join(home, '.openclaw'),
  };
}

