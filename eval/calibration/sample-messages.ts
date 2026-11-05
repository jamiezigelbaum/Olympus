// Calibration sample for messages and email (round 2 of the labeled set).
//
// A stand-alone, read-only tool. It reads COPIES of connector stores (each
// source's internal, secure_local, tier-ledger and tier-sniffer SQLite files,
// taken with `sqlite3 ".backup"`), never a live store, and writes one sample
// file to an owner-only directory outside the repository. It prints counts
// only, never an item's text or names.
//
//   bun eval/calibration/sample-messages.ts --stores DIR [--source NAME=DIR:COUNT ...]
//     [--out DIR] [--seed N] [--since YYYY-MM-DD] [--private-share 0.3] [--check N] [--force]
//
// `judgeSees` is the judge's input. An item still in the store's question queue
// uses the queued input verbatim (`judgeSeesExact`). An answered item has lost
// its question, so its input is rebuilt by the production classifier with a
// judge that only records what it is asked. A rebuilt input can lack names the
// stores do not keep (Gmail's labels, a Telegram forward's origin or attachment
// names); --check measures how close it comes against queued questions. An
// item the judge would never read (a secret or structured-identifier hit) is
// left out.
//
// Sampling: the items the judge already called Private are oversampled to
// `--private-share`, so both classes are big enough to measure. Every item
// keeps its `stratum` and the recipe keeps each stratum's population, so a
// score can be reweighted to the natural mix; unweighted recall on this sample
// flatters the judge.

import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { classifyItemTiers, type TierSniffer } from '../../src/workers/classification/tier-classifier.ts';
import { storedSignals } from '../../src/workers/connector-store/stored-names.ts';
import type { ConnectorStoreItemCopy } from '../../src/workers/connector-store/local-index.ts';
import { CALIBRATION_DIR_DEFAULT, SAMPLE_FILE, type CalibrationSample, type CalibrationSampleItem } from './files.ts';
import { rng, shuffle } from './sample-random.ts';

const MAX_TEXT_CHARS = 60_000;
/** Shorter than this, a message ("ok", "thanks") only spends the owner's time. */
const MIN_TEXT_CHARS = 15;
const PER_GROUP_CAP = 3;
const SHORT_CHARS = 80;
const LONG_CHARS = 400;

interface SourceSpec {
  name: string;
  dir: string;
  count: number;
  prefix: string;
  /** Group an item is capped within: its chat, or its sender when one conversation holds everything. */
  groupBy: 'chat' | 'sender';
  mime: (type: string) => boolean;
}

const isText = (type: string) => type.startsWith('text/plain');
const SOURCES: readonly SourceSpec[] = [
  { name: 'telegram', dir: 'telegram.messages', count: 100, prefix: 't', groupBy: 'chat', mime: isText },
  { name: 'whatsapp', dir: 'whatsapp.personal.messages', count: 50, prefix: 'w', groupBy: 'chat', mime: isText },
  { name: 'gmail', dir: 'gmail.email', count: 60, prefix: 'g', groupBy: 'sender', mime: (type) => type === 'message/rfc822' },
];

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

interface LedgerRow {
  account_scope: string;
  provider: string;
  conversation_key: string;
  provider_item_id: string;
  content_tier: string;
  reasons_json: string;
}

type Stratum = 'judged_private' | 'rest';
type Row = Record<string, string | number | null>;

/** The judge's answer recorded in a ledger row, if it gave a real one. */
function judgedPrivate(row: LedgerRow): boolean {
  const code = /"content:sniffer:[^":]*:[^":]*:([^"]+)"/.exec(row.reasons_json)?.[1];
  if (!code || code === 'undecided' || code.startsWith('fail')) return false;
  // A verdict that moved the item is recorded as decided by the move, so the tier and the verdict code decide this.
  return row.content_tier === 'secure';
}

class Stores {
  private readonly dbs: Database[];
  private readonly lookups;
  private readonly chunks;
  private readonly queued;
  readonly ledger: Database;
  readonly sniffer: Database;

  constructor(dir: string) {
    const open = (file: string) => new Database(join(dir, file), { readonly: true });
    this.dbs = [open('secure_local.sqlite'), open('internal.sqlite')];
    this.ledger = open('secure_local.tier-ledger.sqlite');
    this.sniffer = open('secure_local.tier-sniffer.sqlite');
    this.lookups = this.dbs.map((db) => db.query(
      `SELECT * FROM items WHERE provider = ? AND account_scope = ? AND normalized_conversation = ?
         AND provider_item_id = ? AND tombstoned = 0`,
    ));
    this.chunks = this.dbs.map((db) => db.query('SELECT bounded_text FROM chunks WHERE item_pk = ? ORDER BY chunk_index'));
    this.queued = this.sniffer.query(
      `SELECT material FROM sniffer_questions WHERE provider = ? AND account_scope = ? AND conversation_key = ?
         AND provider_item_id = ? AND pass = 'content'`,
    );
  }

  /** The production input of a question still waiting for the judge. */
  queuedInput(row: Pick<LedgerRow, 'provider' | 'account_scope' | 'conversation_key' | 'provider_item_id'>): string | undefined {
    const found = this.queued.get(row.provider, row.account_scope, row.conversation_key, row.provider_item_id) as { material: string } | null;
    return found?.material;
  }

  /** The copy of an item that holds its text. */
  read(row: Pick<LedgerRow, 'provider' | 'account_scope' | 'conversation_key' | 'provider_item_id'>) {
    for (let index = 0; index < this.dbs.length; index += 1) {
      const item = this.lookups[index]!.get(row.provider, row.account_scope, row.conversation_key, row.provider_item_id) as Row | null;
      if (!item) continue;
      const parts = this.chunks[index]!.all(item['item_pk']) as Array<{ bounded_text: string }>;
      if (parts.length === 0) continue;
      return { item, text: parts.map((part) => part.bounded_text).join('\n').slice(0, MAX_TEXT_CHARS) };
    }
    return undefined;
  }
}

/** What the production classifier would ask the judge about this item, or why it would not ask. */
function judgeInput(item: Row, text: string, provider: string) {
  const conversation = typeof item['provider_conversation_id'] === 'string' ? item['provider_conversation_id'] : undefined;
  const signals = storedSignals({
    columns: item,
    identity: { providerConversationId: conversation },
  } as unknown as ConnectorStoreItemCopy);
  let material: string | undefined;
  const sniffer: TierSniffer = {
    id: 'calibration-recorder',
    judge(request) {
      if (request.pass === 'content') material = request.material;
      return { verdict: 'undecided' };
    },
  };
  const decision = classifyItemTiers({ signals, provider, text }, { sniffer, retirePublic: true });
  const secret = decision.metadataTier === 'secrets' || decision.contentTier === 'secrets';
  return { signals, material: secret ? undefined : material, secret };
}

function quarter(iso: string): string {
  return `${iso.slice(0, 4)}Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1}`;
}

function lengthBucket(chars: number): 'short' | 'medium' | 'long' {
  if (chars < SHORT_CHARS) return 'short';
  return chars < LONG_CHARS ? 'medium' : 'long';
}

function sampleSource(spec: SourceSpec, stores: Stores, since: string, privateShare: number, random: () => number) {
  const rows = stores.ledger.query(
    `SELECT provider, account_scope, conversation_key, provider_item_id, content_tier, reasons_json
       FROM tier_items
      WHERE content_read = 1 AND state != 'moving' AND content_tier != 'secrets' AND metadata_tier != 'secrets'`,
  ).all() as LedgerRow[];
  const pools: Record<Stratum, LedgerRow[]> = {
    judged_private: shuffle(rows.filter(judgedPrivate), random),
    rest: shuffle(rows.filter((row) => !judgedPrivate(row)), random),
  };
  const population = { judged_private: pools.judged_private.length, rest: pools.rest.length };
  const skipped = { notEligible: 0, tooShort: 0, secret: 0, judgeNotAsked: 0, duplicate: 0 };

  const picked: CalibrationSampleItem[] = [];
  const groups = new Map<string, number>();
  const quarters = new Map<string, number>();
  const seen = new Set<string>();
  const taken = new Set<LedgerRow>();
  const rejected = new Set<LedgerRow>();

  const fill = (stratum: Stratum, quota: number) => {
    const buckets = new Map<string, number>();
    const bucketQuota = Math.ceil(quota / 3);
    const quarterQuota = Math.max(3, Math.ceil(quota / 4));
    let got = 0;
    // Each pass drops a constraint, so a small source still reaches its count.
    const passes = [
      { cap: PER_GROUP_CAP, spreadTime: true, spreadLength: true },
      { cap: PER_GROUP_CAP, spreadTime: true, spreadLength: false },
      { cap: PER_GROUP_CAP, spreadTime: false, spreadLength: false },
      { cap: PER_GROUP_CAP * 2, spreadTime: false, spreadLength: false },
      { cap: PER_GROUP_CAP * 4, spreadTime: false, spreadLength: false },
      { cap: Number.MAX_SAFE_INTEGER, spreadTime: false, spreadLength: false },
    ];
    for (const pass of passes) {
      for (const row of pools[stratum]) {
        if (got >= quota) return;
        if (taken.has(row) || rejected.has(row)) continue;
        const found = stores.read(row);
        const authored = typeof found?.item['authored_at'] === 'string' ? found.item['authored_at'] : '';
        const mime = String(found?.item['mime_type'] ?? '');
        if (!found || !authored || authored < since || !spec.mime(mime) || found.item['parent_local_item_id']) {
          skipped.notEligible += 1;
          rejected.add(row);
          continue;
        }
        const chars = found.text.replace(/\s+/g, ' ').trim().length;
        if (chars < MIN_TEXT_CHARS) {
          skipped.tooShort += 1;
          rejected.add(row);
          continue;
        }
        const sender = String(found.item['sender_label'] ?? found.item['sender_id'] ?? '');
        const group = spec.groupBy === 'chat' ? row.conversation_key : sender;
        const when = quarter(authored);
        const bucket = lengthBucket(chars);
        if ((groups.get(group) ?? 0) >= pass.cap) continue;
        if (pass.spreadTime && (quarters.get(when) ?? 0) >= quarterQuota) continue;
        if (pass.spreadLength && (buckets.get(bucket) ?? 0) >= bucketQuota) continue;
        const input = judgeInput(found.item, found.text, spec.name);
        if (!input.material) {
          if (input.secret) skipped.secret += 1;
          else skipped.judgeNotAsked += 1;
          rejected.add(row);
          continue;
        }
        const queued = stores.queuedInput(row);
        const judgeSees = queued ?? input.material;
        if (seen.has(judgeSees)) {
          skipped.duplicate += 1;
          rejected.add(row);
          continue;
        }
        seen.add(judgeSees);
        taken.add(row);
        groups.set(group, (groups.get(group) ?? 0) + 1);
        quarters.set(when, (quarters.get(when) ?? 0) + 1);
        buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
        got += 1;
        const id = `${spec.prefix}${String(picked.length + 1).padStart(3, '0')}`;
        picked.push({
          id,
          path: '',
          rel: `${spec.name}/${id}`,
          name: id,
          area: spec.name,
          mimeType: mime,
          sizeBytes: found.text.length,
          modifiedAt: authored,
          recordsHint: false,
          text: found.text,
          source: spec.name,
          stratum,
          signals: input.signals,
          judgeSees,
          judgeSeesExact: queued !== undefined,
        });
      }
    }
  };
  const wanted = Number(flag(`--${spec.name}`) ?? spec.count);
  fill('judged_private', Math.min(Math.round(wanted * privateShare), population.judged_private));
  fill('rest', wanted - picked.length);

  const count = <T extends string>(values: readonly T[]) => {
    const out: Record<string, number> = {};
    for (const value of values) out[value] = (out[value] ?? 0) + 1;
    return out;
  };
  return {
    picked,
    report: {
      wanted,
      sampled: picked.length,
      population,
      sampledByStratum: count(picked.map((item) => item.stratum ?? '')),
      judgeInputExact: picked.filter((item) => item.judgeSeesExact).length,
      groups: groups.size,
      largestGroup: Math.max(0, ...groups.values()),
      quarters: Object.fromEntries([...quarters.entries()].sort()),
      lengths: count(picked.map((item) => lengthBucket(item.text.replace(/\s+/g, ' ').trim().length))),
      skipped,
    },
  };
}

/** How close a rebuilt input comes to queued production questions, names and excerpt apart. */
function checkAgainstQueue(spec: SourceSpec, stores: Stores, limit: number) {
  const questions = stores.sniffer.query(
    `SELECT provider, account_scope, conversation_key, provider_item_id, material FROM sniffer_questions
      WHERE pass = 'content' ORDER BY random() LIMIT ?`,
  ).all(limit) as Array<Pick<LedgerRow, 'provider' | 'account_scope' | 'conversation_key' | 'provider_item_id'> & { material: string }>;
  const parts = (material: string) => {
    const at = material.indexOf('\nExcerpt: ');
    return at < 0 ? { names: material, excerpt: '' } : { names: material.slice(0, at), excerpt: material.slice(at) };
  };
  const result = { checked: 0, identical: 0, sameNames: 0, sameExcerpt: 0 };
  for (const question of questions) {
    const found = stores.read(question);
    if (!found || !spec.mime(String(found.item['mime_type'] ?? ''))) continue;
    const rebuilt = judgeInput(found.item, found.text, spec.name).material ?? '';
    result.checked += 1;
    if (rebuilt === question.material) result.identical += 1;
    if (parts(rebuilt).names === parts(question.material).names) result.sameNames += 1;
    if (parts(rebuilt).excerpt === parts(question.material).excerpt) result.sameExcerpt += 1;
  }
  return result;
}

function main(): void {
  const storesDir = flag('--stores');
  if (!storesDir) throw new Error('--stores DIR is required: a folder of store copies, never a live data directory.');
  const out = flag('--out') ?? join(CALIBRATION_DIR_DEFAULT, 'round2');
  const seed = Number(flag('--seed') ?? 20261105);
  const since = flag('--since') ?? '2024-11-05';
  const privateShare = Number(flag('--private-share') ?? 0.3);
  const check = Number(flag('--check') ?? 500);
  const outPath = join(out, SAMPLE_FILE);
  if (existsSync(outPath) && !argv.includes('--force')) {
    throw new Error(`A sample already exists at ${outPath}. Labels refer to it; pass --force to replace it.`);
  }

  const random = rng(seed);
  const items: CalibrationSampleItem[] = [];
  const sources: Record<string, unknown> = {};
  for (const spec of SOURCES) {
    const stores = new Stores(join(storesDir, spec.dir));
    const { picked, report } = sampleSource(spec, stores, since, privateShare, random);
    items.push(...picked);
    sources[spec.name] = { ...report, queueCheck: check > 0 ? checkAgainstQueue(spec, stores, check) : undefined };
  }

  const recipe = {
    seed,
    since,
    privateShare,
    perGroupCap: PER_GROUP_CAP,
    minTextChars: MIN_TEXT_CHARS,
    lengthBuckets: { shortBelow: SHORT_CHARS, longFrom: LONG_CHARS },
    sources,
  };
  const sample: CalibrationSample = {
    version: 1,
    createdAt: new Date().toISOString(),
    root: 'connector store copies',
    seed,
    candidates: items.length,
    items: shuffle(items, random),
    recipe,
  };
  if (!argv.includes('--dry-run')) {
    mkdirSync(out, { recursive: true, mode: 0o700 });
    chmodSync(out, 0o700);
    writeFileSync(outPath, JSON.stringify(sample, null, 1), { mode: 0o600 });
    chmodSync(outPath, 0o600);
  }
  console.log(JSON.stringify(recipe, null, 1));
}

main();
