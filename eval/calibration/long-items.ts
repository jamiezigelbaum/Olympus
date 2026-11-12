// Long Personal items: how much of them the privacy judge never reads, and
// whether the parts it skips hold anything Private.
//
// The judge reads one excerpt of at most SNIFFER_EXCERPT_MAX_CHARS per item
// (tier-classifier.ts), so the rest of a long item takes the tier that excerpt
// earned. This script measures that on a COPY of an install's data root:
//
//   bun eval/calibration/long-items.ts --root DATA_ROOT
//     Counts per source family: Personal items, how many are longer than the
//     judge reads, characters beyond it, and median and p90 length.
//
//   bun eval/calibration/long-items.ts --root DATA_ROOT --judge-sample 200
//     --endpoint http://127.0.0.1:PORT --model NAME (--owner-words FILE|saved | --no-owner-words)
//     [--seed 1] [--max-windows 25]
//     Also picks that many long Personal items at random (seeded), cuts the
//     text past the first SNIFFER_EXCERPT_MAX_CHARS into windows of that size,
//     and asks the judge about each window the way production asks about an
//     item (same input builder, screens, prompt and decision bar). Counts the
//     items with any window judged Private.
//
// Every database is opened read-only and immutable (`?immutable=1`): no lock,
// no WAL, no write. Point it at a copy, never a live install. Output is counts
// only: no item text, names, ids or paths. Item text goes to the endpoint and
// nowhere else, and only a loopback endpoint is accepted.

import { constants, Database } from 'bun:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { buildSnifferBatchPrompt, SNIFFER_SYSTEM_PROMPT, snifferInjectionRule, snifferMaterialCarriesSecret, snifferMaterialForModel, snifferOwnMaterial } from '../../src/workers/classification/sniffer.ts';
import { decisionDivergence, decisionPromptShape, REPLY_TO_TIER } from '../../src/workers/classification/sniffer-decision.ts';
import { privateChance, SNIFFER_DECISION_MIN_COVERAGE, SNIFFER_DECISION_PRIVATE_BAR, tierMass, type TokenChance } from '../../src/workers/classification/sniffer-decision-mass.ts';
import { TIER_LEDGER_FILE_SUFFIX } from '../../src/workers/classification/tier-ledger-path.ts';
import { SNIFFER_EXCERPT_MAX_CHARS } from '../../src/workers/classification/tier-classifier.ts';
import { privacyOwnerContext } from '../../src/workers/classification/privacy-profile.ts';
import { rng, shuffle } from './sample-random.ts';
import { storedJudgeInput, type Row } from './stored-input.ts';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const WINDOW = SNIFFER_EXCERPT_MAX_CHARS;
const SKIP_DIRS = new Set(['models', 'backup-staging', 'engine-run', 'node_modules', 'tier-migration']);

/** Opens a database file read-only and immutable, so a copy is never locked or written. */
function openImmutable(path: string): Database {
  return new Database(`file:${encodeURI(path)}?immutable=1`, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
}

const hasTable = (db: Database, name: string) => Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const columns = (db: Database, table: string) => new Set((db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));

/** Every tier ledger under the root. */
function ledgers(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name)); continue; }
      if (entry.isFile() && entry.name.endsWith(TIER_LEDGER_FILE_SUFFIX)) found.push(join(dir, entry.name));
    }
  };
  walk(root);
  return found.sort();
}

/**
 * The stores a ledger tiers: the store it sits beside, and that store set's
 * Personal store (`internal`, by the name each layout gives it). When neither
 * sibling name is found, every store in the same folder is a candidate.
 */
function storesFor(ledgerPath: string): string[] {
  const base = ledgerPath.slice(0, -TIER_LEDGER_FILE_SUFFIX.length);
  const dir = dirname(base);
  const name = basename(base);
  const named = [
    `${name}.sqlite`,
    name.includes('secure_local') ? `${name.replace('secure_local', 'internal')}.sqlite` : '',
    name.endsWith('-connector-store') ? `${name.replace(/-connector-store$/, '-internal-connector-store')}.sqlite` : '',
  ].filter(Boolean).map((file) => join(dir, file)).filter(existsSync);
  if (named.length >= 2) return named;
  const all = readdirSync(dir).filter((file) => file.endsWith('.sqlite') && !/\.(tier-ledger|tier-sniffer|secret-locations)\.sqlite$/.test(file)).map((file) => join(dir, file));
  return [...new Set([...named, ...all])];
}

interface Store {
  db: Database;
  /** item key -> { pk, chars } */
  items: Map<string, { pk: number; chars: number }>;
  row: ReturnType<Database['query']>;
  chunks: ReturnType<Database['query']>;
}

const keyOf = (provider: string, scope: string, conversation: string, id: string) => JSON.stringify([provider, scope, conversation, id]);

const openStores = new Map<string, Store | null>();
function store(path: string): Store | null {
  if (openStores.has(path)) return openStores.get(path)!;
  let opened: Store | null = null;
  try {
    const db = openImmutable(path);
    if (hasTable(db, 'items') && hasTable(db, 'chunks')) {
      const conversation = columns(db, 'items').has('normalized_conversation') ? 'normalized_conversation' : "''";
      const items = new Map<string, { pk: number; chars: number }>();
      const rows = db.query(`SELECT i.item_pk AS pk, i.provider, i.account_scope, ${conversation === "''" ? "''" : `i.${conversation}`} AS conversation, i.provider_item_id,
          COALESCE((SELECT SUM(LENGTH(c.bounded_text)) + COUNT(*) - 1 FROM chunks c WHERE c.item_pk = i.item_pk), 0) AS chars
        FROM items i WHERE i.tombstoned = 0`).all() as Array<{ pk: number; provider: string; account_scope: string; conversation: string | null; provider_item_id: string; chars: number }>;
      for (const row of rows) {
        const key = keyOf(row.provider, row.account_scope, row.conversation ?? '', row.provider_item_id);
        const prior = items.get(key);
        if (!prior || row.chars > prior.chars) items.set(key, { pk: row.pk, chars: row.chars });
      }
      opened = {
        db,
        items,
        row: db.query('SELECT * FROM items WHERE item_pk = ?'),
        chunks: db.query('SELECT bounded_text FROM chunks WHERE item_pk = ? ORDER BY chunk_index'),
      };
    } else {
      db.close();
    }
  } catch {
    opened = null;
  }
  openStores.set(path, opened);
  return opened;
}

interface LongItem { store: Store; pk: number; provider: string; chars: number }

interface FamilyCount {
  personal: number;
  personalNotRead: number;
  longerThanJudgeReads: number;
  charsBeyond: number;
  noStoredText: number;
  lengths: number[];
  longLengths: number[];
}

const percentile = (sorted: number[], p: number) => (sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!);

function count(root: string): { families: Record<string, FamilyCount>; long: LongItem[]; ledgers: number; stores: number } {
  const families: Record<string, FamilyCount> = {};
  const long: LongItem[] = [];
  const found = ledgers(root);
  const usedStores = new Set<string>();
  for (const ledgerPath of found) {
    const ledger = openImmutable(ledgerPath);
    try {
      if (!hasTable(ledger, 'tier_items')) continue;
      const hasConversation = columns(ledger, 'tier_items').has('conversation_key');
      const candidates = storesFor(ledgerPath).map((path) => ({ path, opened: store(path) })).filter((entry) => entry.opened !== null);
      const rows = ledger.query(`SELECT provider, account_scope, ${hasConversation ? 'conversation_key' : "''"} AS conversation_key, provider_item_id, content_read
        FROM tier_items WHERE content_tier = 'private' AND state != 'moving'`).all() as Array<{ provider: string; account_scope: string; conversation_key: string; provider_item_id: string; content_read: number }>;
      for (const row of rows) {
        const family = (families[row.provider] ??= { personal: 0, personalNotRead: 0, longerThanJudgeReads: 0, charsBeyond: 0, noStoredText: 0, lengths: [], longLengths: [] });
        family.personal += 1;
        if (row.content_read !== 1) family.personalNotRead += 1;
        const key = keyOf(row.provider, row.account_scope, row.conversation_key, row.provider_item_id);
        let best: { store: Store; path: string; pk: number; chars: number } | undefined;
        for (const candidate of candidates) {
          const hit = candidate.opened!.items.get(key);
          if (hit && (!best || hit.chars > best.chars)) best = { store: candidate.opened!, path: candidate.path, pk: hit.pk, chars: hit.chars };
        }
        if (!best || best.chars === 0) { family.noStoredText += 1; continue; }
        usedStores.add(best.path);
        family.lengths.push(best.chars);
        if (best.chars > WINDOW) {
          family.longerThanJudgeReads += 1;
          family.charsBeyond += best.chars - WINDOW;
          family.longLengths.push(best.chars);
          if (row.content_read === 1) long.push({ store: best.store, pk: best.pk, provider: row.provider, chars: best.chars });
        }
      }
    } finally {
      ledger.close();
    }
  }
  return { families, long, ledgers: found.length, stores: usedStores.size };
}

function report(families: Record<string, FamilyCount>) {
  const total: FamilyCount = { personal: 0, personalNotRead: 0, longerThanJudgeReads: 0, charsBeyond: 0, noStoredText: 0, lengths: [], longLengths: [] };
  const rows: Record<string, unknown> = {};
  const line = (family: FamilyCount) => {
    const lengths = [...family.lengths].sort((a, b) => a - b);
    const longLengths = [...family.longLengths].sort((a, b) => a - b);
    return {
      personal: family.personal,
      personalNotRead: family.personalNotRead,
      noStoredText: family.noStoredText,
      longerThanJudgeReads: family.longerThanJudgeReads,
      charsBeyond: family.charsBeyond,
      medianChars: percentile(lengths, 0.5),
      p90Chars: percentile(lengths, 0.9),
      longMedianChars: percentile(longLengths, 0.5),
      longP90Chars: percentile(longLengths, 0.9),
    };
  };
  for (const [name, family] of Object.entries(families).sort()) {
    rows[name] = line(family);
    total.personal += family.personal;
    total.personalNotRead += family.personalNotRead;
    total.noStoredText += family.noStoredText;
    total.longerThanJudgeReads += family.longerThanJudgeReads;
    total.charsBeyond += family.charsBeyond;
    total.lengths.push(...family.lengths);
    total.longLengths.push(...family.longLengths);
  }
  rows['ALL'] = line(total);
  return rows;
}

// ---- judging the unseen windows ----

function assertLoopback(url: string): void {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('--endpoint must be a URL, such as http://127.0.0.1:8012.');
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) {
    throw new Error('--endpoint must be loopback: item text may reach no other host. Use an SSH tunnel to reach another machine.');
  }
}

type Via = 'judge' | 'no_answer' | 'secret' | 'injection' | 'detector' | 'not_asked';

async function judgeWindows(long: LongItem[], sampleSize: number) {
  const endpoint = (flag('--endpoint') ?? '').replace(/\/+$/, '');
  assertLoopback(endpoint);
  const model = flag('--model');
  if (!model) throw new Error('--model NAME is required, so the result says what produced it.');
  const wordsFile = flag('--owner-words');
  if (!wordsFile && !argv.includes('--no-owner-words')) throw new Error('Pass --owner-words FILE (or saved), or --no-owner-words.');
  const ownerContext = !wordsFile ? undefined : wordsFile === 'saved' ? privacyOwnerContext() : (readFileSync(wordsFile, 'utf8').trim() || undefined);
  const maxWindows = Number(flag('--max-windows') ?? 25);
  const seed = Number(flag('--seed') ?? 1);

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const response = await fetch(`${endpoint}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    // Never the response body: a server error can echo the prompt.
    if (!response.ok) throw new Error(`${path} answered ${response.status}.`);
    return await response.json() as T;
  };
  const shape = await decisionPromptShape(async (material) => (await post<{ prompt: string }>('/apply-template', {
    messages: [
      { role: 'system', content: SNIFFER_SYSTEM_PROMPT },
      { role: 'user', content: buildSnifferBatchPrompt('content', [{ i: 1, material }], ownerContext) },
    ],
    chat_template_kwargs: { enable_thinking: false },
  })).prompt);
  const written = await decisionDivergence(post);
  await post('/completion', { prompt: shape.shared, n_predict: 0, cache_prompt: true });

  const ask = async (row: Row, text: string, provider: string): Promise<{ via: Via; private: boolean }> => {
    const input = storedJudgeInput(row, text, provider);
    if (input.secret) return { via: 'secret', private: true };
    if (input.material === undefined) return input.privateWithoutJudge ? { via: 'detector', private: true } : { via: 'not_asked', private: false };
    const forModel = snifferMaterialForModel(input.material);
    const own = snifferOwnMaterial(forModel);
    if (snifferMaterialCarriesSecret(own)) return { via: 'secret', private: true };
    if (snifferInjectionRule(own)) return { via: 'injection', private: true };
    const reply = await post<{ completion_probabilities?: Array<{ top_logprobs?: TokenChance[] }> }>('/completion', {
      prompt: `${shape.render(forModel)}${REPLY_TO_TIER}${written}`,
      n_predict: 1,
      n_probs: 40,
      temperature: 0,
      cache_prompt: true,
    });
    const mass = tierMass(reply.completion_probabilities?.[0]?.top_logprobs ?? [], written);
    const chance = privateChance(mass);
    // Production's fail-safe: no clear answer holds the item Private.
    if (chance === undefined || mass.private + mass.personal < SNIFFER_DECISION_MIN_COVERAGE) return { via: 'no_answer', private: true };
    return { via: 'judge', private: chance >= SNIFFER_DECISION_PRIVATE_BAR };
  };

  const picked = shuffle([...long], rng(seed)).slice(0, sampleSize);
  const byFamily: Record<string, { items: number; windows: number; itemsWithPrivateWindow: number; itemsWithJudgePrivateWindow: number; cappedItems: number; openingWindowPrivate: number; privateWindowsBy: Record<string, number> }> = {};
  const started = performance.now();
  let windowsAsked = 0;
  let modelCalls = 0;
  for (const item of picked) {
    const family = (byFamily[item.provider] ??= { items: 0, windows: 0, itemsWithPrivateWindow: 0, itemsWithJudgePrivateWindow: 0, cappedItems: 0, openingWindowPrivate: 0, privateWindowsBy: {} });
    const row = item.store.row.get(item.pk) as Row;
    const text = (item.store.chunks.all(item.pk) as Array<{ bounded_text: string }>).map((part) => part.bounded_text).join('\n');
    const windows: string[] = [];
    for (let at = WINDOW; at < text.length; at += WINDOW) windows.push(text.slice(at, at + WINDOW));
    if (windows.length > maxWindows) family.cappedItems += 1;
    family.items += 1;
    // Control: the opening window, which the judge already called Personal. Private here is judge noise.
    if ((await ask(row, text.slice(0, WINDOW), item.provider)).private) family.openingWindowPrivate += 1;
    let anyPrivate = false;
    let anyByJudge = false;
    for (const window of windows.slice(0, maxWindows)) {
      const answer = await ask(row, window, item.provider);
      family.windows += 1;
      windowsAsked += 1;
      if (answer.via === 'judge' || answer.via === 'no_answer') modelCalls += 1;
      if (answer.private) {
        anyPrivate = true;
        if (answer.via === 'judge') anyByJudge = true;
        family.privateWindowsBy[answer.via] = (family.privateWindowsBy[answer.via] ?? 0) + 1;
      }
    }
    if (anyPrivate) family.itemsWithPrivateWindow += 1;
    if (anyByJudge) family.itemsWithJudgePrivateWindow += 1;
  }
  const minutes = (performance.now() - started) / 60_000;
  return {
    model,
    ownerWords: ownerContext ? 'supplied' : 'none',
    seed,
    windowChars: WINDOW,
    maxWindowsPerItem: maxWindows,
    longPersonalItemsAvailable: long.length,
    itemsJudged: picked.length,
    windowsAsked,
    modelCalls,
    minutes: Number(minutes.toFixed(1)),
    modelCallsPerMinute: minutes > 0 ? Number((modelCalls / minutes).toFixed(1)) : null,
    itemsWithPrivateWindow: Object.values(byFamily).reduce((sum, family) => sum + family.itemsWithPrivateWindow, 0),
    byFamily,
  };
}

async function main() {
  const root = flag('--root');
  if (!root || !existsSync(root)) throw new Error('--root DATA_ROOT is required: a copy of an install\'s Olympus data root.');
  const counted = count(root);
  const out: Record<string, unknown> = {
    judgeReadsChars: WINDOW,
    ledgers: counted.ledgers,
    storesWithPersonalText: counted.stores,
    byFamily: report(counted.families),
  };
  const sample = Number(flag('--judge-sample') ?? 0);
  if (sample > 0) out['windowJudge'] = await judgeWindows(counted.long, sample);
  for (const opened of openStores.values()) opened?.db.close();
  console.log(JSON.stringify(out, null, 1));
}

await main();
