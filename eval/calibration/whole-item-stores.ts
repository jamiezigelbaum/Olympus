// Whole-item calibration: the store side. Reads COPIES of an install's
// connector stores (never a live file), defines the eligible population, and
// builds each sampled item whole: its own text, every child attachment, how
// the text was read (OCR, failures) and where Olympus placed it.
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
import { accountStorePath, sharedDataPath, type LayoutEnv } from '../../src/core/olympus-layout.ts';
import { readSourceRegistry, sourceAccountMovePending } from '../../src/core/source-registry.ts';
import { snapshotPrefilterDatabase } from '../../src/workers/classification/prefilter-training-dry-run.ts';
import { snifferInjectionRule, snifferMaterialForModel, snifferOwnMaterial } from '../../src/workers/classification/sniffer.ts';
import { tierLedgerPathForStore, tierSnifferPathForStore } from '../../src/workers/classification/tier-ledger-path.ts';
import { SNIFFER_EXCERPT_MAX_CHARS } from '../../src/workers/classification/tier-classifier.ts';
import type { CalibrationSampleItem, ExtractionNote, PlacedTier, WholeItemChild } from './files.ts';
import { storedJudgeInput, type Row } from './stored-input.ts';
import type { PopulationUnit, WholeStratum } from './whole-item.ts';

/** What the judge is given: production keeps at most this much of an item's text. */
const JUDGE_TEXT_CHARS = 60_000;
/** What the labeling page keeps of one item or attachment: long documents whole, within reason. */
export const WHOLE_TEXT_CHARS = 400_000;
const STORE_FILES = ['secure_local.sqlite', 'internal.sqlite'] as const;
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

export const placedTier = (tier: string | null | undefined): PlacedTier => (tier === 'secrets' ? 'secret' : tier === 'secure' ? 'private' : 'personal');
const rank = { personal: 0, private: 1, secret: 2 } as const;
const highest = (tiers: readonly PlacedTier[]): PlacedTier => tiers.reduce<PlacedTier>((top, tier) => (rank[tier] > rank[top] ? tier : top), 'personal');

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
  private readonly stores: Array<{ db: Database; item: ReturnType<Database['query']>; chunks: ReturnType<Database['query']>; children: ReturnType<Database['query']> | undefined; textChars: Map<number, number> }>;
  private readonly ledgerRow;
  private readonly queued;

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
        db,
        item: db.query('SELECT * FROM items WHERE provider = ? AND account_scope = ? AND normalized_conversation = ? AND provider_item_id = ? AND tombstoned = 0'),
        chunks: db.query('SELECT bounded_text FROM chunks WHERE item_pk = ? ORDER BY chunk_index'),
        children: columns(db, 'items').has('parent_local_item_id')
          ? db.query('SELECT * FROM items WHERE parent_local_item_id = ? AND tombstoned = 0 ORDER BY provider_item_id')
          : undefined,
        textChars,
      }];
    });
    this.ledgerRow = this.ledger.query('SELECT * FROM tier_items WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ?');
    this.queued = this.sniffer && hasTable(this.sniffer, 'sniffer_questions')
      ? this.sniffer.query(`SELECT material FROM sniffer_questions WHERE provider = ? AND account_scope = ? AND conversation_key = ? AND provider_item_id = ? AND pass = 'content'`)
      : undefined;
  }

  ledgerRows(): LedgerRow[] {
    return this.ledger.query('SELECT provider, account_scope, conversation_key, provider_item_id, content_tier, metadata_tier, state, content_read, reasons_json FROM tier_items ORDER BY provider, account_scope, conversation_key, provider_item_id').all() as LedgerRow[];
  }

  ledgerOf(identity: LedgerIdentity): LedgerRow | undefined {
    return (this.ledgerRow.get(identity.provider, identity.account_scope, identity.conversation_key, identity.provider_item_id) as LedgerRow | null) ?? undefined;
  }

  /** The stored row of an item, from whichever tier's copy holds it (the one with text first). */
  find(identity: LedgerIdentity): { row: Row; chars: number; store: number } | undefined {
    let found: { row: Row; chars: number; store: number } | undefined;
    this.stores.forEach((store, index) => {
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

  /** Every child of an item across both copies, once each. */
  children(localItemId: string): Array<{ row: Row; store: number }> {
    const seen = new Map<string, { row: Row; store: number; chars: number }>();
    this.stores.forEach((store, index) => {
      for (const row of (store.children?.all(localItemId) ?? []) as Row[]) {
        const key = String(row['provider_item_id']);
        const chars = store.textChars.get(row['item_pk'] as number) ?? 0;
        const before = seen.get(key);
        if (!before || chars > before.chars) seen.set(key, { row, store: index, chars });
      }
    });
    return [...seen.values()];
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
      const ledger = stores.ledgerOf(unit.identity)!;
      const own = stores.textOf(found);
      const provider = String(found.row['provider']);
      const input = storedJudgeInput(found.row, own.slice(0, JUDGE_TEXT_CHARS), provider);
      const queued = stores.queuedInput(unit.identity);
      const judgeSees = queued ?? input.material;
      const injection = judgeSees !== undefined && snifferInjectionRule(snifferOwnMaterial(snifferMaterialForModel(judgeSees))) !== undefined;
      const children: WholeItemChild[] = stores.children(String(found.row['local_item_id'])).map((child) => {
        const childLedger = stores.ledgerOf({
          provider: String(child.row['provider']),
          account_scope: String(child.row['account_scope']),
          conversation_key: String(child.row['normalized_conversation'] ?? ''),
          provider_item_id: String(child.row['provider_item_id']),
        });
        const note = extraction.note(String(child.row['provider']), String(child.row['local_item_id']));
        return {
          name: text(child.row['title']) ?? '(no name)',
          mimeType: String(child.row['mime_type'] ?? ''),
          ...cut(stores.textOf(child)),
          ...(note ? { extraction: note } : {}),
          ...(childLedger ? { placement: highest([placedTier(childLedger.content_tier), placedTier(childLedger.metadata_tier)]) } : {}),
        };
      });
      const note = extraction.note(provider, String(found.row['local_item_id']));
      const whole = cut(own);
      const content = placedTier(ledger.content_tier);
      const metadata = placedTier(ledger.metadata_tier);
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
          placement: { metadata, content, final: highest([content, metadata, ...children.flatMap((child) => (child.placement ? [child.placement] : []))]) },
        },
      };
    });
  } finally {
    for (const stores of open.values()) stores.close();
    extraction.close();
  }
}

/**
 * Copies an install's connector stores, their ledgers and sniffer files, and
 * the extraction jobs, into `dest` in the layout above. Each file is copied
 * with its WAL by production's snapshot (no SQLite handle on an install file;
 * an overlapping write is retried or refused), then the copy is folded into
 * one file so it opens read-only.
 */
export function snapshotInstall(dest: string, env: LayoutEnv = process.env): { accounts: number; files: number; skippedAccounts: number } {
  mkdirSync(dest, { recursive: true, mode: 0o700 });
  chmodSync(dest, 0o700);
  const registry = readSourceRegistry(env);
  let files = 0;
  let accounts = 0;
  let skippedAccounts = 0;
  const copy = (from: string, to: string) => {
    if (!existsSync(from)) return false;
    snapshotPrefilterDatabase(from, to, () => {});
    const db = new Database(to);
    try {
      db.exec('PRAGMA journal_mode = DELETE');
    } finally {
      db.close();
    }
    chmodSync(to, 0o600);
    files += 1;
    return true;
  };
  for (const account of registry.accounts) {
    if (account.state !== 'active' || sourceAccountMovePending(account)) { skippedAccounts += 1; continue; }
    let secure: string;
    try {
      secure = accountStorePath(account, 'secure_local', env);
    } catch {
      // Imported archives keep one store set per family: not part of this sample.
      skippedAccounts += 1;
      continue;
    }
    if (!existsSync(tierLedgerPathForStore(secure))) { skippedAccounts += 1; continue; }
    const folder = join(dest, `${account.source_id}@${account.slot}`);
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    copy(secure, join(folder, 'secure_local.sqlite'));
    copy(tierLedgerPathForStore(secure), join(folder, LEDGER_FILE));
    copy(tierSnifferPathForStore(secure), join(folder, SNIFFER_FILE));
    try {
      copy(accountStorePath(account, 'internal', env), join(folder, 'internal.sqlite'));
    } catch {
      // A source with no Personal store.
    }
    accounts += 1;
  }
  copy(sharedDataPath('file-extraction-jobs', env), join(dest, EXTRACTION_FILE));
  return { accounts, files, skippedAccounts };
}
