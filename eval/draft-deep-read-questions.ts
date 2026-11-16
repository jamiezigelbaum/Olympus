// Deep-read held-out set (1.5 item 8): questions whose answer sits in the back
// half of a long conversation or a long document, drafted by the local model
// on an offline copy. The set is private; stdout carries ids and counts only.
import { Database } from 'bun:sqlite';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import type { EvidenceCandidate } from '../src/core/contracts.ts';
import { planDeepReadSections } from '../src/core/deep-read.ts';
import { loadConfig } from '../src/core/config.ts';
import type { SourceFamily } from '../src/core/source-index/types.ts';
import { LOCAL_ANALYST_PROMPT_BYTES_CEILING } from '../src/workers/source-index/local-analyst-window.ts';
import type { AnalystAnswerLanes } from '../src/workers/source-index/analyst-answer.ts';
import { readDeepReadSet, type DeepReadSet, type DeepReadStore } from '../src/workers/engine/runtime/deep-read-jobs.ts';
import type { LocalConnectorStore } from '../src/workers/connector-store/index.ts';
import { openEvalDataRoot, type EvalDataRoot } from './data-root.ts';
import { parseDataRootArgs } from './data-root-args.ts';
import { createEvalSourceLanes } from './retrieval.ts';
import { enterStage, runEvalCli, type EvalStage } from './cli-failure.ts';
import { DraftRejected, draftOne, randomFor, shuffle, writePrivateFile, type DraftItem, type DraftRejectReason } from './draft-passage-questions.ts';
import { localEvalModel, type DraftModel } from './local-model.ts';
import { passageContainsQuote, passageWords } from './passage-match.ts';
import { positiveInteger } from './run-passages.ts';

export const DEEP_READ_DATASET_VERSION = 'deep-read-1';

/** The set a question reads: a search hit's selected_item identifiers, and whether the whole conversation or the item alone. */
export interface DeepReadQuestionSet {
  corpus_id: string; provider: string; account_scope: string; local_item_id: string; provider_item_id: string;
  provider_conversation_id?: string; provider_thread_id?: string; provider_file_id?: string; source_version?: string;
  whole: 'conversation' | 'item';
}
export interface DeepReadQuestion {
  id: string;
  kind: 'conversation' | 'item';
  question: string;
  /** Verbatim, 6 to 40 words, from the target message or passage. */
  quote: string;
  set: DeepReadQuestionSet;
  /** Every tier copy of the item holding the answer (the target message, or the document itself). */
  expected: Array<{ corpus_id: string; provider_item_id: string; local_item_id: string }>;
  /** Where the target sits: its item (conversation) or passage (document) index, of how many, at drafting time. */
  target: { index: number; of: number };
  /** The set's size when drafted: items listed, and passages read. */
  setItems: number; setPassages: number;
  notes: 'paraphrase' | 'natural';
}
export interface DeepReadDataset { version: typeof DEEP_READ_DATASET_VERSION; description: string; seed: string; questions: DeepReadQuestion[] }

export function validateDeepReadDataset(value: unknown): asserts value is DeepReadDataset {
  const fail = () => { throw new Error('Invalid deep-read dataset.'); };
  const dataset = value as DeepReadDataset;
  if (!dataset || dataset.version !== DEEP_READ_DATASET_VERSION || !Array.isArray(dataset.questions)) return fail();
  const ids = new Set<string>();
  for (const q of dataset.questions) {
    if (!q || typeof q.id !== 'string' || !q.id || ids.has(q.id) || typeof q.question !== 'string' || !q.question.trim()) return fail();
    ids.add(q.id);
    const words = passageWords(typeof q.quote === 'string' ? q.quote : '').length;
    if (words < 6 || words > 40) return fail();
    if (q.kind !== 'conversation' && q.kind !== 'item') return fail();
    const s = q.set;
    if (!s || s.whole !== q.kind || ![s.corpus_id, s.provider, s.account_scope, s.local_item_id].every(v => typeof v === 'string' && v)) return fail();
    if (q.kind === 'conversation' && !s.provider_conversation_id) return fail();
    if (!Array.isArray(q.expected) || !q.expected.length || q.expected.some(e => !e || !e.corpus_id || !e.provider_item_id)) return fail();
  }
}

/** The selected_item a deep read job is started with, from a dataset set. */
export function selectedItemOf(set: DeepReadQuestionSet): DeepReadSet {
  const { whole, ...ids } = set;
  return { whole, selected_item: Object.fromEntries(Object.entries(ids).filter(([, v]) => typeof v === 'string' && v)) as Record<string, string> };
}

interface SetCandidate { kind: 'conversation' | 'item'; corpusId: string; family: SourceFamily; size: number; set: DeepReadQuestionSet }

function readOnly(store: LocalConnectorStore): Database {
  const db = new Database(store.dbPath, { readonly: true, create: false });
  db.exec('PRAGMA busy_timeout = 10000; PRAGMA query_only = ON;');
  return db;
}

/** Conversations with at least `least` active messages, counted across every store of their family, largest first. */
function longConversations(stores: readonly LocalConnectorStore[], families: ReadonlySet<string>, least: number): SetCandidate[] {
  const byKey = new Map<string, SetCandidate>();
  for (const store of [...stores].filter(s => families.has(s.family)).sort((a, b) => a.corpusId.localeCompare(b.corpusId))) {
    const db = readOnly(store);
    try {
      const rows = db.query(`SELECT provider, account_scope, provider_conversation_id, COUNT(*) AS n, MIN(local_item_id) AS local_item_id
        FROM items WHERE tombstoned = 0 AND provider_conversation_id IS NOT NULL AND provider_conversation_id != ''
        GROUP BY provider, account_scope, provider_conversation_id`).all() as { provider: string; account_scope: string; provider_conversation_id: string; n: number; local_item_id: string }[];
      for (const row of rows) {
        const key = JSON.stringify([store.family, row.provider, row.account_scope, row.provider_conversation_id]);
        const anchor = db.query('SELECT provider_item_id FROM items WHERE local_item_id = ? AND tombstoned = 0').get(row.local_item_id) as { provider_item_id: string } | null;
        const seen = byKey.get(key);
        if (seen) { seen.size += row.n; continue; }
        byKey.set(key, { kind: 'conversation', corpusId: store.corpusId, family: store.family, size: row.n, set: {
          corpus_id: store.corpusId, provider: row.provider, account_scope: row.account_scope, local_item_id: row.local_item_id,
          provider_item_id: anchor?.provider_item_id ?? '', provider_conversation_id: row.provider_conversation_id, whole: 'conversation',
        } });
      }
    } finally { db.close(); }
  }
  return [...byKey.entries()].filter(([, c]) => c.size >= least)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).map(([, c]) => c);
}

/** Documents with at least `least` stored passages, one entry per item across tier copies, largest first. */
function longDocuments(stores: readonly LocalConnectorStore[], families: ReadonlySet<string>, least: number): SetCandidate[] {
  const byKey = new Map<string, SetCandidate>();
  for (const store of [...stores].filter(s => families.has(s.family)).sort((a, b) => a.corpusId.localeCompare(b.corpusId))) {
    const db = readOnly(store);
    try {
      const rows = db.query(`SELECT i.provider, i.account_scope, i.provider_item_id, i.local_item_id, i.provider_conversation_id,
          i.provider_thread_id, i.provider_file_id, i.source_version, COUNT(c.item_pk) AS n
        FROM items i JOIN chunks c ON c.item_pk = i.item_pk WHERE i.tombstoned = 0
        GROUP BY i.item_pk HAVING COUNT(c.item_pk) >= ?`).all(least) as {
          provider: string; account_scope: string; provider_item_id: string; local_item_id: string; provider_conversation_id: string | null;
          provider_thread_id: string | null; provider_file_id: string | null; source_version: string | null; n: number }[];
      for (const row of rows) {
        const key = JSON.stringify([store.family, row.provider, row.account_scope, row.provider_conversation_id ?? '', row.provider_item_id]);
        const seen = byKey.get(key);
        if (seen && seen.size >= row.n) continue;
        byKey.set(key, { kind: 'item', corpusId: store.corpusId, family: store.family, size: row.n, set: {
          corpus_id: store.corpusId, provider: row.provider, account_scope: row.account_scope, local_item_id: row.local_item_id, provider_item_id: row.provider_item_id,
          ...(row.provider_conversation_id ? { provider_conversation_id: row.provider_conversation_id } : {}),
          ...(row.provider_thread_id ? { provider_thread_id: row.provider_thread_id } : {}),
          ...(row.provider_file_id ? { provider_file_id: row.provider_file_id } : {}),
          ...(row.source_version ? { source_version: row.source_version } : {}),
          whole: 'item',
        } });
      }
    } finally { db.close(); }
  }
  return [...byKey.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).map(([, c]) => c);
}

/** Every active tier copy of one item in the stores of its family. */
function copiesOf(stores: readonly LocalConnectorStore[], family: string, item: { provider: string; accountScope: string; providerItemId: string; providerConversationId?: string }) {
  const copies: DeepReadQuestion['expected'] = [];
  for (const store of stores.filter(s => s.family === family).sort((a, b) => a.corpusId.localeCompare(b.corpusId))) {
    const db = readOnly(store);
    try {
      const rows = db.query(`SELECT local_item_id FROM items WHERE tombstoned = 0 AND provider = ? AND account_scope = ? AND provider_item_id = ?
        AND COALESCE(provider_conversation_id, '') = ?`).all(item.provider, item.accountScope, item.providerItemId, item.providerConversationId ?? '') as { local_item_id: string }[];
      for (const row of rows) copies.push({ corpus_id: store.corpusId, provider_item_id: item.providerItemId, local_item_id: row.local_item_id });
    } finally { db.close(); }
  }
  return copies;
}

/** A set's readable pieces: for a conversation each message (its passages joined), for a document each passage. */
function piecesOf(kind: 'conversation' | 'item', candidates: readonly EvidenceCandidate[]): Array<{ text: string; candidate: EvidenceCandidate }> {
  if (kind === 'item') return candidates.map(candidate => ({ text: candidate.chunks.join('\n'), candidate }));
  const order: string[] = [];
  const byItem = new Map<string, { text: string[]; candidate: EvidenceCandidate }>();
  for (const candidate of candidates) {
    const key = candidate.provenance.sourceItem.localItemId;
    let entry = byItem.get(key);
    if (!entry) { entry = { text: [], candidate }; byItem.set(key, entry); order.push(key); }
    entry.text.push(...candidate.chunks);
  }
  return order.map(key => ({ text: byItem.get(key)!.text.join('\n'), candidate: byItem.get(key)!.candidate }));
}

export interface DeepReadDraftCounts {
  conversations: { eligible: number; tried: number; kept: number };
  documents: { eligible: number; tried: number; kept: number };
  /** Sets with no piece past the middle long enough to quote. */
  noTarget: number;
  /** Sets the deep read could not list or read here (a refusal code each). */
  unreadableSets: Record<string, number>;
  rejectedBy: Partial<Record<DraftRejectReason, number>>;
  requestsFailed: number; redrafted: number;
  /** Sections the kept sets take at the largest local prompt (a lower bound on the run's sections). */
  sectionsAtCeiling: number;
  kept: number;
}

export async function draftDeepReadQuestions(input: {
  opened: Pick<EvalDataRoot, 'stores'>;
  lanes: () => AnalystAnswerLanes;
  model: DraftModel;
  seed: string;
  conversations: number; documents: number;
  minMessages?: number; minChunks?: number;
  /** Least words a target message or passage needs. */
  minWords?: number;
  /** Targets tried per set before moving on to the next set. */
  attempts?: number;
  conversationFamilies?: readonly string[]; documentFamilies?: readonly string[];
  progress?: (line: string) => void;
}): Promise<{ dataset: DeepReadDataset; counts: DeepReadDraftCounts }> {
  const progress = input.progress ?? (() => {});
  const minWords = input.minWords ?? 25;
  const attempts = input.attempts ?? 3;
  const stores = input.opened.stores;
  const counts: DeepReadDraftCounts = {
    conversations: { eligible: 0, tried: 0, kept: 0 }, documents: { eligible: 0, tried: 0, kept: 0 },
    noTarget: 0, unreadableSets: {}, rejectedBy: {}, requestsFailed: 0, redrafted: 0, sectionsAtCeiling: 0, kept: 0,
  };
  const questions: DeepReadQuestion[] = [];
  const plans: Array<{ kind: 'conversation' | 'item'; wanted: number; sets: SetCandidate[] }> = [
    { kind: 'conversation', wanted: input.conversations, sets: longConversations(stores, new Set(input.conversationFamilies ?? ['chat']), input.minMessages ?? 300) },
    { kind: 'item', wanted: input.documents, sets: longDocuments(stores, new Set(input.documentFamilies ?? ['file']), input.minChunks ?? 8) },
  ];
  for (const plan of plans) {
    const tally = plan.kind === 'conversation' ? counts.conversations : counts.documents;
    tally.eligible = plan.sets.length;
    progress(`${plan.kind}: ${plan.sets.length} eligible sets`);
    // Largest first; at most three sets per wanted question are tried.
    for (const candidate of plan.sets.slice(0, plan.wanted * 3)) {
      if (tally.kept >= plan.wanted) break;
      tally.tried++;
      let read: Awaited<ReturnType<typeof readDeepReadSet>>;
      try { read = await readDeepReadSet(selectedItemOf(candidate.set), () => stores as readonly DeepReadStore[], input.lanes); }
      catch (error) {
        const code = (error as { code?: unknown }).code;
        const label = typeof code === 'string' && /^[a-z_]{1,40}$/.test(code) ? code : 'other';
        counts.unreadableSets[label] = (counts.unreadableSets[label] ?? 0) + 1; continue;
      }
      const pieces = piecesOf(plan.kind, read.candidates);
      const back = pieces.flatMap((piece, index) => index / pieces.length > 0.5 && passageWords(piece.text).length >= minWords ? [index] : []);
      if (!back.length) { counts.noTarget++; continue; }
      const targets = shuffle(back, randomFor(`${input.seed}:${candidate.kind}:${candidate.set.corpus_id}:${candidate.set.local_item_id}`)).slice(0, attempts);
      for (const index of targets) {
        const piece = pieces[index]!;
        const identity = piece.candidate.provenance.sourceItem;
        const item: DraftItem = { corpusId: candidate.corpusId, providerItemId: identity.providerItemId, family: candidate.family, tier: piece.candidate.trustDomain, identity, text: piece.text };
        const paraphrase = questions.length % 2 === 0;
        let drafted: Awaited<ReturnType<typeof draftOne>>;
        try { drafted = await draftOne(input.model, item, paraphrase); }
        catch (error) {
          if (error instanceof DraftRejected) counts.rejectedBy[error.reason] = (counts.rejectedBy[error.reason] ?? 0) + 1;
          else counts.requestsFailed++;
          continue;
        }
        if (!passageContainsQuote(piece.text, drafted.quote)) continue;
        const expected = copiesOf(stores, candidate.family, { provider: identity.provider, accountScope: identity.accountScope, providerItemId: identity.providerItemId, ...(identity.providerConversationId ? { providerConversationId: identity.providerConversationId } : {}) });
        if (!expected.length) continue;
        if (drafted.redrafted) counts.redrafted++;
        counts.sectionsAtCeiling += planDeepReadSections(drafted.question, read.candidates, read.corpusIds, LOCAL_ANALYST_PROMPT_BYTES_CEILING, 'compact').length;
        questions.push({ id: `d${String(questions.length + 1).padStart(3, '0')}`, kind: plan.kind, question: drafted.question, quote: drafted.quote,
          set: candidate.set, expected, target: { index, of: pieces.length }, setItems: read.items, setPassages: read.candidates.length,
          notes: paraphrase ? 'paraphrase' : 'natural' });
        tally.kept++;
        progress(`${plan.kind}: kept ${tally.kept} of ${plan.wanted} (set ${tally.tried}, ${read.items} items, target ${index + 1} of ${pieces.length})`);
        break;
      }
    }
  }
  counts.kept = questions.length;
  const dataset: DeepReadDataset = { version: DEEP_READ_DATASET_VERSION, description: 'Local deep-read drafts: answers in the back half of a long conversation or document.', seed: input.seed, questions };
  validateDeepReadDataset(dataset);
  return { dataset, counts };
}

/** The dataset may only be written under this checkout's eval/private/. */
export function assertPrivateOutput(path: string): void {
  const root = resolve(import.meta.dir, 'private');
  const target = resolve(path);
  if (!target.startsWith(`${root}/`)) throw new Error('The deep-read set is written under eval/private/ only.');
}

export async function main(argv = process.argv.slice(2), stage?: EvalStage): Promise<void> {
  const enter = (name: string) => enterStage(stage, name, 'deep-read drafting');
  enter('arguments');
  if (hostname().split('.')[0]!.toLowerCase() !== 'sparta') throw new Error('Run the drafting CLI on Sparta.');
  const { isolation, rest } = parseDataRootArgs(argv);
  if (!isolation) throw new Error('--data-root is required.');
  const options = ['--conversations', '--documents', '--seed', '--min-messages', '--min-chunks', '--min-words', '--attempts', '--base-url', '--model', '--output', '--conversation-families', '--document-families'];
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index++) {
    const [key, inline] = rest[index]!.split('=', 2);
    if (!options.includes(key!)) throw new Error('Unsupported deep-read drafting option.');
    const value = inline ?? rest[++index];
    if (!value || value.startsWith('--')) throw new Error('Drafting option requires a value.');
    values.set(key!, value);
  }
  const output = values.get('--output') ?? resolve(import.meta.dir, 'private', 'deep-read-questions.json');
  assertPrivateOutput(output);
  const config = loadConfig();
  const model = localEvalModel(config, { baseUrl: values.get('--base-url'), model: values.get('--model') });
  enter('open_data_root');
  const opened = openEvalDataRoot(isolation);
  try {
    const lanes = createEvalSourceLanes({ ...opened });
    const list = (key: string, fallback: string) => (values.get(key) ?? fallback).split(',').map(v => v.trim()).filter(Boolean);
    enter('draft');
    const result = await draftDeepReadQuestions({
      opened, lanes: () => lanes(''), model, seed: values.get('--seed') ?? '1',
      conversations: positiveInteger(values.get('--conversations'), 6), documents: positiveInteger(values.get('--documents'), 6),
      minMessages: positiveInteger(values.get('--min-messages'), 300), minChunks: positiveInteger(values.get('--min-chunks'), 8),
      minWords: positiveInteger(values.get('--min-words'), 25), attempts: positiveInteger(values.get('--attempts'), 3),
      conversationFamilies: list('--conversation-families', 'chat'), documentFamilies: list('--document-families', 'file'),
      progress: line => console.error(line),
    });
    enter('write_set');
    opened.checkFileDescriptors();
    writePrivateFile(output, `${JSON.stringify(result.dataset, null, 2)}\n`);
    console.log(JSON.stringify({ storesOpened: opened.stores.length, storesSkipped: opened.skipped.length, ...result.counts, ids: result.dataset.questions.map(q => `${q.id}:${q.kind}`) }));
  } finally { try { opened.checkFileDescriptors(); } finally { opened.close(); } }
}
if (import.meta.main) runEvalCli('Deep-read drafting', stage => main(process.argv.slice(2), stage));
