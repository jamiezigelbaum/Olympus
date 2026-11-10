// Read-only, content-free replay of saved verdicts. No default data paths.
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { constants, closeSync, existsSync, fchmodSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createDecisionSnifferModel, NativeRequestError } from '../../src/workers/classification/sniffer-decision.ts';
import { completeSnifferQuestion } from '../../src/workers/classification/sniffer-resolver.ts';
import type { SnifferLane } from '../../src/workers/classification/sniffer-lane.ts';
import { SNIFFER_DECISION_MIN_COVERAGE } from '../../src/workers/classification/sniffer-decision-mass.ts';
import { parseSnifferBatchResponse, snifferInjectionRule, snifferMaterialCarriesSecret, snifferOwnMaterial, snifferPromptVersions } from '../../src/workers/classification/sniffer.ts';
import { snifferMaterialHash } from '../../src/workers/classification/sniffer-store.ts';
import { storedJudgeInput, type Row } from './stored-input.ts';

export const SOURCES = ['dropbox.files', 'gmail.email', 'google_drive.docs', 'telegram.messages', 'whatsapp.personal.messages', 'x.bookmarks'] as const;
interface Verdict { material_hash: string; tier: string; model_id: string; prompt_version: string; map_revision: string; category: string; fail_safe: number }
interface LedgerRow { provider: string; account_scope: string; conversation_key: string; provider_item_id: string; content_tier: string; map_revision: string | null; reasons_json: string }
interface Material { material: string; ids: Set<string> }
export interface ReplaySource {
  source: string; verdicts: Verdict[]; materials: Map<string, Material>;
  counts: { verdictRows: number; matched: number; unmatched: number; exactInput: number };
}
type Failure = 'error' | 'timeout' | 'parse' | 'coverage' | 'secret' | null;
export interface Result {
  type: 'result'; source: string; materialHash: string; storedTier: string;
  storedModelId: string; storedPromptVersion: string; storedMapRevision: string;
  storedBucket: string; newTier: string; privateProbability: number | null; coverage: number | null;
  storedInjection: boolean; injection: boolean; failure: Failure; failSafe: boolean; milliseconds: number;
}
interface Header { type: 'inventory'; identity: string; sources: Record<string, ReplaySource['counts']> }
type RecordLine = Header | Result;
export interface ReplayOptions {
  stores: string; endpoint: string; model: string; ownerWords: string; out: string; disagreements: string;
  sources?: string[]; limit?: number; deadlineSeconds?: number;
  /** The clock the deadline is read on (tests); defaults to performance.now(). */
  now?: () => number;
}

export function loopbackEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  // Literal addresses avoid DNS rebinding. URL normalizes the 127/8 forms.
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
    || !(url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname))) {
    throw new Error('A literal loopback endpoint is required.');
  }
  if (!['/', '/v1', '/v1/'].includes(url.pathname)) throw new Error('Use the server root or /v1.');
  return url.href;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const hasTable = (db: Database, name: string) => Boolean(db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

/** A real content verdict in a ledger row: model, prompt version and category. Undecided and fail-safe rows are not verdicts. */
function ledgerVerdict(reasons: string): { model: string; prompt: string; category: string } | undefined {
  const found = /"content:sniffer:([^":]*):([^":]*):([^":]+)[^"]*"/.exec(reasons);
  if (!found || found[3] === 'undecided' || found[3]!.startsWith('fail')) return undefined;
  return { model: found[1]!, prompt: found[2]!, category: found[3]! };
}

// The verdict table is keyed by a hash of the complete input, which the stores
// do not fully keep. The tier ledger names each judged item, so the item comes
// from there and its input is rebuilt; `exactInput` says how many rebuilt inputs
// hash to a stored verdict. Same stored names and bounded chunks as sample-messages.
export function loadSource(root: string, source: string): ReplaySource {
  const open = (file: string) => {
    const path = join(root, source, file);
    return existsSync(path) ? new Database(path, { readonly: true, create: false }) : undefined;
  };
  const materials = new Map<string, Material>();
  const verdicts = new Map<string, Verdict>();
  const counts = { verdictRows: 0, matched: 0, unmatched: 0, exactInput: 0 };
  const sniffer = open('secure_local.tier-sniffer.sqlite');
  const stored = new Set(sniffer && hasTable(sniffer, 'sniffer_verdicts')
    ? (sniffer.query('SELECT material_hash FROM sniffer_verdicts').all() as Array<{ material_hash: string }>).map(row => row.material_hash) : []);
  sniffer?.close();
  const ledger = open('secure_local.tier-ledger.sqlite');
  const dbs = ['secure_local.sqlite', 'internal.sqlite'].map(open).filter((db): db is Database => db !== undefined && hasTable(db, 'items') && hasTable(db, 'chunks'));
  const reads = dbs.map(db => ({
    item: db.query('SELECT * FROM items WHERE provider=? AND account_scope=? AND normalized_conversation=? AND provider_item_id=? AND tombstoned=0'),
    chunks: db.query('SELECT bounded_text FROM chunks WHERE item_pk=? ORDER BY chunk_index'),
  }));
  try {
    if (!ledger || !hasTable(ledger, 'tier_items')) return { source, verdicts: [], materials, counts };
    const rows = ledger.query(`SELECT provider, account_scope, conversation_key, provider_item_id, content_tier, map_revision, reasons_json FROM tier_items WHERE reasons_json LIKE '%"content:sniffer:%'`).all() as LedgerRow[];
    for (const row of rows) {
      const verdict = ledgerVerdict(row.reasons_json);
      if (!verdict) continue;
      counts.verdictRows++;
      let input: ReturnType<typeof storedJudgeInput> | undefined;
      for (const read of reads) {
        const item = read.item.get(row.provider, row.account_scope, row.conversation_key, row.provider_item_id) as Row | null;
        const parts = item ? read.chunks.all(item['item_pk'] as number) as Array<{ bounded_text: string }> : [];
        if (!item || !parts.length) continue;
        input = storedJudgeInput(item, parts.map(part => part.bounded_text).join('\n').slice(0, 60_000), String(item['provider']));
        break;
      }
      if (input?.material === undefined) { counts.unmatched++; continue; }
      counts.matched++;
      if (input.materialHash && stored.has(input.materialHash)) counts.exactInput++;
      const hash = snifferMaterialHash('content', input.material);
      const found = materials.get(hash);
      if (found) found.ids.add(row.provider_item_id);
      else materials.set(hash, { material: input.material, ids: new Set([row.provider_item_id]) });
      const old: Verdict = { material_hash: hash, tier: row.content_tier === 'secure' ? 'private' : 'personal', model_id: verdict.model,
        prompt_version: verdict.prompt, map_revision: row.map_revision ?? 'none', category: verdict.category, fail_safe: 0 };
      verdicts.set(key({ source, materialHash: hash, storedModelId: old.model_id, storedPromptVersion: old.prompt_version, storedMapRevision: old.map_revision }), old);
    }
  } finally { ledger?.close(); for (const db of dbs) db.close(); }
  return { source, verdicts: [...verdicts.values()].sort((a, b) => a.material_hash.localeCompare(b.material_hash)), materials, counts };
}
function bucket(row: Verdict): string {
  if (row.category === 'injection') return 'injection';
  if (row.category === 'undecided') return 'undecided';
  if (row.fail_safe || row.category.startsWith('fail') || row.category === 'unresolved') return 'fail-safe';
  return ['personal', 'private'].includes(row.tier) ? row.tier : 'undecided';
}
// A hash can have multiple old model/prompt/map verdicts. Keep all comparisons,
// but perform only one new inference for that hash (also across sources).
function key(row: Pick<Result, 'source' | 'materialHash' | 'storedModelId' | 'storedPromptVersion' | 'storedMapRevision'>): string {
  return JSON.stringify([row.source, row.materialHash, row.storedModelId, row.storedPromptVersion, row.storedMapRevision]);
}
function readCheckpoint(path: string): RecordLine[] {
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  if (text && !text.endsWith('\n')) throw new Error('Incomplete checkpoint tail; restore or remove the interrupted final line before resuming.');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as RecordLine);
}
function privateOutput(path: string): number {
  // Refuse symlinks; never truncate a store or follow an output symlink.
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_APPEND, 0o600);
  fchmodSync(fd, 0o600);
  return fd;
}
function append(fd: number, record: unknown) { writeSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); }

export function summarize(records: readonly Result[]) {
  const one = (rows: readonly Result[]) => {
    const matrix: Record<string, Record<string, number>> = {};
    for (const old of ['personal', 'private', 'undecided', 'fail-safe', 'injection']) matrix[old] = Object.fromEntries(['personal', 'private', 'undecided', 'secrets'].map(tier => [tier, 0]));
    let comparable = 0, agreed = 0;
    for (const row of rows) {
      matrix[row.storedBucket]![row.newTier] = (matrix[row.storedBucket]![row.newTier] ?? 0) + 1;
      if (['personal', 'private'].includes(row.storedBucket) && ['personal', 'private'].includes(row.newTier)) {
        comparable++; if (row.storedBucket === row.newTier) agreed++;
      }
    }
    const unique = [...new Map(rows.map(row => [row.materialHash, row])).values()];
    const times = unique.filter(row => !row.injection && row.failure !== 'secret').map(row => row.milliseconds).sort((a,b) => a-b);
    const n = times.length, total = times.reduce((a,b) => a+b, 0);
    const median = n ? (times[Math.floor((n-1)/2)]! + times[Math.floor(n/2)]!) / 2 : 0;
    return { rows: rows.length, matrix, comparable, agreementPercent: comparable ? agreed / comparable * 100 : 0,
      itemsPerMinute: { median: median ? 60_000 / median : 0, overall: total ? n * 60_000 / total : 0 },
      errors: rows.filter(r => r.failure === 'error').length, timeouts: rows.filter(r => r.failure === 'timeout').length,
      parseFailures: rows.filter(r => r.failure === 'parse').length, coverageBelowFloor: rows.filter(r => r.failure === 'coverage').length,
      secretRefused: rows.filter(r => r.failure === 'secret').length, failSafeVerdicts: rows.filter(r => r.failSafe).length,
      injection: { stored: rows.filter(r => r.storedInjection).length, now: rows.filter(r => r.injection).length, regressions: rows.filter(r => r.storedInjection && !r.injection).length } };
  };
  return { overall: one(records), sources: Object.fromEntries([...new Set(records.map(r => r.source))].map(source => [source, one(records.filter(r => r.source === source))])) };
}
export function reportFile(path: string) {
  const records = readCheckpoint(path);
  const header = records.find((r): r is Header => r.type === 'inventory');
  const summary = summarize(records.filter((r): r is Result => r.type === 'result'));
  for (const source of Object.keys(header?.sources ?? {})) summary.sources[source] ??= summarize([]).overall;
  return { inventory: header?.sources ?? {}, ...summary };
}

export async function replay(options: ReplayOptions) {
  const endpoint = loopbackEndpoint(options.endpoint);
  const sources = options.sources ?? [...SOURCES];
  if (!sources.length || new Set(sources).size !== sources.length || sources.some(s => !(SOURCES as readonly string[]).includes(s))) throw new Error('Unknown or repeated source.');
  for (const value of [options.limit, options.deadlineSeconds]) if (value !== undefined && (!Number.isFinite(value) || value < 0)) throw new Error('Limits must be finite and nonnegative.');
  if (options.limit !== undefined && !Number.isInteger(options.limit)) throw new Error('Limit must be an integer.');
  if ([options.out, options.disagreements].some(path => (resolve(path) === resolve(options.stores) || resolve(path).startsWith(resolve(options.stores) + '/'))) || resolve(options.out) === resolve(options.disagreements) || [options.out, options.disagreements].some(path => resolve(path) === resolve(options.ownerWords))) throw new Error('Outputs must be separate from inputs.');
  const now = options.now ?? (() => performance.now());
  const deadline = now() + (options.deadlineSeconds ?? Infinity) * 1_000;
  const ownerContext = readFileSync(options.ownerWords, 'utf8');
  const loaded = sources.map(source => loadSource(options.stores, source));
  const identity = digest(JSON.stringify({ endpoint, model: options.model, owner: digest(ownerContext), prompt: snifferPromptVersions(ownerContext).cache,
    sources: loaded.map(s => [s.source, s.verdicts]) }));
  const records = readCheckpoint(options.out);
  if (records.length && (records[0]?.type !== 'inventory' || records[0].identity !== identity)) throw new Error('Checkpoint inputs or model differ. Use a separate output.');
  const previous = records.filter((r): r is Result => r.type === 'result');
  const done = new Set(previous.map(key));
  const answers = new Map(previous.map(row => [row.materialHash, row]));
  const lane: SnifferLane = { kind: 'local', modelId: options.model, profileId: 'replay', profile: {
    provider: 'local-openai-compatible', trust: 'local', model: options.model, baseUrl: endpoint, snifferMode: 'decision',
  } };
  const model = createDecisionSnifferModel(lane, { async complete() { throw new Error('Full mode is not enabled for replay.'); } });
  const out = privateOutput(options.out);
  let disagreements: number | undefined;
  try {
    if (!records.length) append(out, { type: 'inventory', identity, sources: Object.fromEntries(loaded.map(s => [s.source, s.counts])) } satisfies Header);
    // Recover this derived file from checkpoint + matched identities each run,
    // so a crash between the two writes cannot lose a disagreement.
    const mismatchRows = new Map<string, { source: string; materialHash: string; itemId: string }>();
    const remember = (row: Result) => {
      if (!(row.storedBucket === 'private' && row.newTier === 'personal') && !(row.storedBucket === 'personal' && row.newTier === 'private')) return;
      for (const itemId of loaded.find(s => s.source === row.source)?.materials.get(row.materialHash)?.ids ?? []) {
        const record = { source: row.source, materialHash: row.materialHash, itemId };
        mismatchRows.set(JSON.stringify(record), record);
      }
    };
    for (const row of previous) remember(row);
    // Append only; idempotent on resume. No text or model/server response is serialized.
    disagreements = privateOutput(options.disagreements);
    const existing = new Set(existsSync(options.disagreements) ? readFileSync(options.disagreements, 'utf8').split('\n').filter(Boolean) : []);
    const flushMismatches = () => { for (const [line, row] of mismatchRows) if (!existing.has(line)) { append(disagreements!, row); existing.add(line); } };
    flushMismatches();
    let processed = 0;
    const pending = loaded.map(s => s.verdicts.filter(row => s.materials.has(row.material_hash)));
    while (pending.some(rows => rows.length)) {
      for (let index = 0; index < loaded.length; index++) {
        const old = pending[index]!.shift(); if (!old) continue;
        const source = loaded[index]!;
        const base = { type: 'result' as const, source: source.source, materialHash: old.material_hash,
          storedTier: old.tier, storedModelId: old.model_id, storedPromptVersion: old.prompt_version, storedMapRevision: old.map_revision,
          storedBucket: bucket(old), storedInjection: old.category === 'injection' };
        if (done.has(key(base))) continue;
        if (now() >= deadline || processed >= (options.limit ?? Infinity)) return reportFile(options.out);
        let answer = answers.get(old.material_hash);
        if (!answer) {
          const material = source.materials.get(old.material_hash)!.material;
          const own = snifferOwnMaterial(material);
          const started = performance.now();
          answer = { ...base, newTier: 'undecided', privateProbability: null, coverage: null, injection: false, failure: null, failSafe: false, milliseconds: 0 };
          if (snifferMaterialCarriesSecret(own)) { answer.newTier = 'secrets'; answer.failure = 'secret'; }
          else if (snifferInjectionRule(own)) { answer.newTier = 'private'; answer.injection = true; answer.failSafe = true; }
          else {
            const remaining = Math.max(1, Math.min(60_000, Math.ceil(deadline - now())));
            const signal = AbortSignal.timeout(remaining);
            try {
              const completion = await completeSnifferQuestion(model, { pass: 'content', material, ownerContext, signal });
              answer.privateProbability = completion.decisionMetrics?.privateProbability ?? null;
              answer.coverage = completion.decisionMetrics?.coverage ?? null;
              const verdict = completion.decisionVerdict ?? parseSnifferBatchResponse(completion.text, new Set([1])).get(1);
              if (verdict) answer.newTier = verdict.tier;
              else answer.failure = answer.coverage !== null && answer.coverage + Number.EPSILON < SNIFFER_DECISION_MIN_COVERAGE ? 'coverage' : 'parse';
            } catch (error) { answer.failure = signal.aborted || (error instanceof NativeRequestError && error.timedOut) ? 'timeout' : 'error'; }
          }
          answer.milliseconds = Math.max(0, performance.now() - started);
          answers.set(old.material_hash, answer);
        }
        const row: Result = { ...answer, ...base };
        append(out, row); done.add(key(row)); processed++;
        remember(row); flushMismatches();
      }
    }
    return reportFile(options.out);
  } finally { closeSync(out); if (disagreements !== undefined) closeSync(disagreements); }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const value = (name: string) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i+1]; };
    const required = (name: string) => { const result = value(name); if (!result || result.startsWith('--')) throw new Error('Missing argument.'); return result; };
    const out = required('--out');
    const report = args.includes('--report') ? reportFile(out) : await replay({ stores: required('--stores'), endpoint: required('--endpoint'), model: required('--model'),
      ownerWords: required('--owner-words'), out, disagreements: required('--disagreements'),
      ...(value('--sources') ? { sources: value('--sources')!.split(',') } : {}),
      ...(value('--limit') ? { limit: Number(value('--limit')) } : {}),
      ...(value('--deadline-seconds') ? { deadlineSeconds: Number(value('--deadline-seconds')) } : {}),
    });
    console.log(JSON.stringify(report));
  } catch { console.error('Replay failed; check arguments, copies and checkpoint compatibility. No item details are logged.'); process.exitCode = 1; }
}
