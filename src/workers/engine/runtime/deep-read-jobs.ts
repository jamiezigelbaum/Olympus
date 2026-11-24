/**
 * Deep read jobs on the engine (1.5 item 8; core/deep-read.ts does the reading).
 *
 * The owner names a set by a search hit's selected_item: that item alone
 * (a document), or its whole conversation (a group, channel or chat), with an
 * optional authored span. Every store of the set's source is asked for the
 * conversation's items, so each tier's copy is found; each item's text comes
 * through its store's own content provider, which applies the owner's scope,
 * Names-only choices and tier visibility exactly as Ask does. Items whose text
 * is not readable there are counted and named, never read around.
 *
 * The model is the owner's private model from the shared chooser
 * (createLocalPrivateRoute). Deep read never takes the built-in small model:
 * with no private model set up it refuses and says so, and with the owner's
 * model down it fails and says so. The answer lands in the Private answers
 * inbox as an answered local question. No clock cuts a job in progress; the
 * owner's cancel is the only stop besides the model transport's own stall rule.
 *
 * A long conversation can take hours on the owner's model. Before it starts,
 * the job prices two reads at the pace measured on that model: the whole set,
 * and the days that mention the question (the set's own keyword and vector
 * hits, a day either side; pickRelevantDays). The default budget is 15
 * minutes (the owner's call, 19 Nov 2026): the full read runs when it fits,
 * else the most relevant days that fit, busiest first. A relevant-days answer
 * says how much it left unread and offers to keep reading with the full read;
 * nothing is skipped silently, and the budget only picks what to read first:
 * no clock stops a read that has started.
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Analyst, AnalystResult, EvidenceCandidate } from '../../../core/contracts.ts';
import { DeepReadRefused } from '../../../core/deep-read-refused.ts';
export { DeepReadRefused } from '../../../core/deep-read-refused.ts';
import { runDeepRead, planDeepReadSections, type DeepReadProgress } from '../../../core/deep-read.ts';
import { conversationCitationTitle } from '../../../core/parent-label.ts';
import { providerSourceLabel } from '../../../core/remote-result.ts';
import type { SourceItemIdentity, SourceTrustDomain } from '../../../core/source-index/types.ts';
import type { StoredPrivateAnswer, WaitingQuestionStore } from '../../../core/waiting-private-questions.ts';
import type { AnalystAnswerLanes } from '../../source-index/analyst-answer.ts';
import { inboxEvidenceIdentity } from './local-private-answers.ts';
import { runBackgroundInference } from '../../answer-activity.ts';
import type { LocalConnectorStore, OnDemandGrantWork } from '../../connector-store/local-index.ts';
import { DEFER_SEARCH_DELIVERY, deliverCorpusSearch, type SourceIndexCorpusSearchResponse } from '../../../core/source-index/router.ts';

/** What a deep read needs of a connector store: who it is and the conversation lister. */
export interface DeepReadStore {
  corpusId: string;
  family: string;
  conversationItems(key: {
    provider: string; accountScope: string; providerConversationId: string;
    providerThreadId?: string; after?: string; before?: string;
  }): Array<{ sourceItem: SourceItemIdentity; authoredAt?: string }>;
  activeLocalItemRow(localItemId: string): unknown;
  itemNames?: LocalConnectorStore['itemNames'];
  observeOnDemandRead?: LocalConnectorStore['observeOnDemandRead'];
}

export interface DeepReadSet {
  /** A search hit's selected_item (identifiers only). */
  selected_item: Record<string, string>;
  /** 'item': that document alone. 'conversation': every message of its conversation. */
  whole: 'item' | 'conversation';
  /** For a conversation: only messages authored at or after / before these ISO times. */
  after?: string;
  before?: string;
  /** Which read: every message, or the days that mention the question. Left out, the 15-minute budget picks. */
  read?: DeepReadMode;
}

export type DeepReadMode = 'all' | 'relevant_days';

/** One priced read the owner can pick. `seconds` is left out until the model's pace has been measured. */
export interface DeepReadChoice {
  sections: number;
  messageCount: number;
  seconds?: number;
  /** relevant_days only: days read, and days the set spans. */
  days?: number;
  totalDays?: number;
}

export type DeepReadModel =
  | { analyst: Analyst; promptBytes: number; modelId: string }
  | { unavailable: true; modelId: string }
  | undefined;

export interface DeepReadJobView {
  id: string;
  state: 'reading' | 'answering' | 'done' | 'failed' | 'cancelled';
  question: string;
  setLabel: string;
  items: number;
  /** Items in the set whose text could not be read here (Names only, Private elsewhere, not extracted yet). */
  unreadable: number;
  sectionsTotal: number;
  sectionsDone: number;
  notes: number;
  model: string;
  startedAt: string;
  finishedAt?: string;
  /** Seconds left at the pace measured so far, once a section has been read. */
  estimateSecondsLeft?: number;
  failure?: string;
  /** The inbox question id the answer landed in. */
  inboxId?: string;
  /** What the read is waiting on right now, when it is waiting. */
  waitingOn?: 'privacy checks' | 'your questions';
  /** The read this job runs. */
  read: DeepReadMode;
  /** Both reads, priced, for the owner to choose (relevantDays is absent for a document or when nothing in the set matched). */
  choices: { all: DeepReadChoice; relevantDays?: DeepReadChoice };
  /** One line stating the two estimates and which read runs, to show the owner as is. */
  choiceSummary: string;
}


interface Job {
  view: DeepReadJobView;
  controller: AbortController;
  grantsCurrent(): boolean;
  completion?: Promise<AnalystResult | undefined>;
}

const INBOX_CONNECTION = '@local:You';
/** How often a read stepping aside looks again whether judging is done. */
const JUDGE_LOOK_MS = 2_000;
/** The least a read steps aside for judging before its first call has a measured length. */
const JUDGE_STEP_ASIDE_MIN_MS = 5_000;
const MAX_JOBS_KEPT = 50;
/** The full read is the default while its estimate is under this; past it, the relevant-days read is. */
/** The default deep-read budget: 15 minutes (owner's choice, 19 Nov 2026). It picks what to read, never stops a read. */
export const DEEP_READ_BUDGET_SECONDS = 900;
const UNMEASURED_SECTION_LIMIT = 40;

/** Hits a relevant-days read takes from each store of the set: each one adds its day and the day either side. */
export const DEEP_READ_DAY_HITS = 200;

function deepReadView(job: Job): DeepReadJobView {
  if (job.grantsCurrent()) return { ...job.view };
  const { inboxId: _inboxId, estimateSecondsLeft: _eta, waitingOn: _waiting, ...view } = job.view;
  return {
    ...view,
    state: 'cancelled',
    unreadable: 0,
    sectionsDone: 0,
    sectionsTotal: 0,
    notes: 0,
    read: 'all',
    choices: { all: { sections: 0, messageCount: 0 } },
    choiceSummary: 'Access to an item changed.',
  };
}

/**
 * The set's own search hits for the question: each store's ordinary keyword
 * and vector search, through lanes already scoped to the set (its
 * conversation and span), at a wide cut. Provider item ids only.
 */
export async function searchSetHits(lanes: AnalystAnswerLanes, question: string, corpusIds: readonly string[], maxResults = DEEP_READ_DAY_HITS): Promise<Set<string>> {
  const results: SourceIndexCorpusSearchResponse[] = [];
  for (const corpusId of corpusIds) {
    const adapter = lanes.adapters[corpusId];
    const corpus = lanes.registry.get(corpusId);
    if (!adapter || !corpus) continue;
    results.push(await adapter({ query: question, maxResults, corpus, [DEFER_SEARCH_DELIVERY]: true,
      context: { allowedTrustDomains: [corpus.trustDomain], allowCloudQueries: false } }));
  }
  const hits = new Set<string>();
  for (const result of results) {
    const response = deliverCorpusSearch([result]);
    for (const hit of response.hits) hits.add(hit.sourceItem.providerItemId);
  }
  return hits;
}

/** A day (UTC, YYYY-MM-DD) moved by `delta` days. */
function shiftDay(day: string, delta: number): string {
  const time = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(time) ? new Date(time + delta * 86_400_000).toISOString().slice(0, 10) : day;
}

function candidateDay(candidate: EvidenceCandidate): string | undefined {
  const authoredAt = candidate.provenance.citation?.authoredAt;
  return authoredAt && /^\d{4}-\d{2}-\d{2}/.test(authoredAt) ? authoredAt.slice(0, 10) : undefined;
}

function messageKey(candidate: EvidenceCandidate): string {
  const item = candidate.provenance.sourceItem;
  return JSON.stringify([item.providerConversationId ?? '', item.providerItemId]);
}

/**
 * The relevant-days read: every message on a day that holds one of the set's
 * search hits, and on the day either side, in authored order. Generic: the
 * hits come from the ordinary keyword and vector search scoped to the set,
 * and days are calendar days. A message with no date is kept.
 */
export function pickRelevantDays(
  candidates: readonly EvidenceCandidate[],
  hitProviderItemIds: ReadonlySet<string>,
  spread = 1,
): { candidates: EvidenceCandidate[]; days: number; totalDays: number; hitDays: number; messages: number; totalMessages: number } {
  const allDays = new Set<string>();
  const hitDays = new Set<string>();
  let anyHit = false;
  for (const candidate of candidates) {
    const hit = hitProviderItemIds.has(candidate.provenance.sourceItem.providerItemId);
    anyHit ||= hit;
    const day = candidateDay(candidate);
    if (!day) continue;
    allDays.add(day);
    if (hit) hitDays.add(day);
  }
  const keep = new Set<string>();
  for (const day of hitDays) for (let delta = -spread; delta <= spread; delta += 1) keep.add(shiftDay(day, delta));
  const picked = !anyHit ? [] : candidates.filter(candidate => {
    const day = candidateDay(candidate);
    return day === undefined || keep.has(day);
  });
  return {
    candidates: picked,
    days: [...allDays].filter(day => keep.has(day)).length,
    totalDays: allDays.size,
    hitDays: hitDays.size,
    messages: new Set(picked.map(messageKey)).size,
    totalMessages: new Set(candidates.map(messageKey)).size,
  };
}

/**
 * The relevant-days pick within a budget: hit days join in order of how many
 * hits they hold (most first, then earliest), each with the day either side,
 * until the next day would no longer fit. The first day always joins. Generic:
 * hit counts only, no question-specific logic.
 */
export function pickRelevantDaysWithin(
  candidates: readonly EvidenceCandidate[],
  hitProviderItemIds: ReadonlySet<string>,
  fits: (picked: readonly EvidenceCandidate[]) => boolean,
  spread = 1,
): ReturnType<typeof pickRelevantDays> & { capped: boolean } {
  const whole = pickRelevantDays(candidates, hitProviderItemIds, spread);
  if (whole.candidates.length === 0 || fits(whole.candidates)) return { ...whole, capped: false };
  const hitsByDay = new Map<string, Set<string>>();
  const undated = new Set<string>();
  for (const candidate of candidates) {
    const id = candidate.provenance.sourceItem.providerItemId;
    if (!hitProviderItemIds.has(id)) continue;
    const day = candidateDay(candidate);
    if (!day) { undated.add(id); continue; }
    const ids = hitsByDay.get(day) ?? new Set<string>();
    ids.add(id);
    hitsByDay.set(day, ids);
  }
  const order = [...hitsByDay.entries()].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
  const chosen = new Set(undated);
  let kept: ReturnType<typeof pickRelevantDays> | undefined;
  for (const [, ids] of order) {
    for (const id of ids) chosen.add(id);
    const next = pickRelevantDays(candidates, chosen, spread);
    if (kept && !fits(next.candidates)) break;
    kept = next;
  }
  return { ...(kept ?? whole), capped: true };
}

function aboutDuration(seconds: number): string {
  if (seconds < 90) return 'about a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `about ${minutes} minutes`;
  const hours = Math.round(seconds / 360) / 10;
  return `about ${hours} hours`;
}

/**
 * Which read runs: the one asked for, else the full read when it fits in
 * the 15-minute budget at the measured pace, else the relevant-days read. Before the model's
 * pace has been measured the smaller read goes first, and the summary says
 * the estimates come after its first section.
 */
export function chooseDeepRead(choices: DeepReadJobView['choices'], requested?: DeepReadMode): DeepReadMode {
  const relevant = choices.relevantDays;
  if (!relevant || relevant.messageCount >= choices.all.messageCount) return 'all';
  if (requested) return requested;
  if (choices.all.seconds === undefined) return relevant.sections < choices.all.sections ? 'relevant_days' : 'all';
  return choices.all.seconds < DEEP_READ_BUDGET_SECONDS ? 'all' : 'relevant_days';
}

export function deepReadChoiceSummary(choices: DeepReadJobView['choices'], read: DeepReadMode, requested?: DeepReadMode): string {
  const n = (value: number) => value.toLocaleString('en-US');
  const time = (choice: DeepReadChoice) => choice.seconds === undefined ? '' : `, ${aboutDuration(choice.seconds)}`;
  const all = `All ${n(choices.all.messageCount)} messages${time(choices.all)}`;
  const relevant = choices.relevantDays;
  if (!relevant) return `${all}. Reading all of it.`;
  const days = `The days that mention this${time(relevant)}: ${n(relevant.days ?? 0)} days of ${n(relevant.totalDays ?? 0)}, ${n(relevant.messageCount)} messages`;
  const reason = requested
    ? 'as asked'
    : choices.all.seconds === undefined
      ? 'the smaller read first; estimates follow once your model\'s pace is measured'
      : read === 'all' ? 'the full read fits in 15 minutes' : 'the full read would take over 15 minutes';
  const next = read === 'relevant_days' ? ' To keep reading after it, ask for read: all to read every message.' : '';
  return `${all}. ${days}. Reading ${read === 'all' ? 'all of it' : 'the days that mention this'} (${reason}).${next}`;
}

/** Measured seconds per section on each model, kept across restarts when a file is given. */
function paceBook(file?: string) {
  let paces: Record<string, number> = {};
  if (file) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const [model, value] of Object.entries(parsed)) if (typeof value === 'number' && value > 0) paces[model] = value;
      }
    } catch {
      paces = {}; // No pace measured yet: the first read measures it.
    }
  }
  return {
    get: (model: string): number | undefined => paces[model],
    set(model: string, secondsPerSection: number): void {
      if (!(secondsPerSection > 0)) return;
      paces[model] = secondsPerSection;
      if (!file) return;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.tmp`, JSON.stringify(paces));
      renameSync(`${file}.tmp`, file);
    },
  };
}

/**
 * Lists a set and reads its text the way a deep read job does: every store of
 * the anchor's family for a conversation (authored order), or the one item,
 * each item's text through its store's own content provider, one candidate
 * per passage. Exported so the deep-read eval builds the very same set.
 */
export async function readDeepReadSet(
  set: DeepReadSet,
  storesOf: () => readonly DeepReadStore[],
  lanesOf: () => AnalystAnswerLanes | undefined,
  grants?: { controller: AbortController; work: OnDemandGrantWork[] },
): Promise<{ candidates: EvidenceCandidate[]; corpusIds: string[]; unreadable: number; items: number; label: string }> {
  const selected = set.selected_item;
  const provider = selected.provider; const accountScope = selected.account_scope;
  if (!provider || !accountScope || !selected.local_item_id || !selected.corpus_id) throw new DeepReadRefused('invalid_set', 'The set must be a selected_item from a search hit.');
  const lanes = lanesOf();
  if (!lanes) throw new DeepReadRefused('not_found', 'Source search is not running.');
  const stores = storesOf();
  const anchorStore = stores.find(store => store.corpusId === selected.corpus_id);
  if (!anchorStore) throw new DeepReadRefused('not_found', 'That source is not on this computer.');
  const family = anchorStore.family;
  let members: Array<{ corpusId: string; sourceItem: SourceItemIdentity; authoredAt?: string }>;
  if (set.whole === 'conversation') {
    const conversationId = selected.provider_conversation_id;
    if (!conversationId) throw new DeepReadRefused('invalid_set', 'That item is not part of a conversation.');
    members = stores.filter(store => store.family === family).flatMap(store => store.conversationItems({
      provider, accountScope, providerConversationId: conversationId,
      ...(selected.provider_thread_id ? { providerThreadId: selected.provider_thread_id } : {}),
      ...(set.after ? { after: set.after } : {}), ...(set.before ? { before: set.before } : {}),
    }).map(member => ({ corpusId: store.corpusId, ...member })));
    members.sort((a, b) => (a.authoredAt ?? '').localeCompare(b.authoredAt ?? ''));
  } else {
    if (!anchorStore.activeLocalItemRow(selected.local_item_id)) throw new DeepReadRefused('not_found', 'That item is no longer stored.');
    members = [{ corpusId: selected.corpus_id, sourceItem: {
      family: family as SourceItemIdentity['family'], provider, accountScope, providerItemId: selected.provider_item_id ?? '', localItemId: selected.local_item_id,
      ...(selected.provider_conversation_id ? { providerConversationId: selected.provider_conversation_id } : {}),
      ...(selected.provider_thread_id ? { providerThreadId: selected.provider_thread_id } : {}),
      ...(selected.provider_file_id ? { providerFileId: selected.provider_file_id } : {}),
      ...(selected.source_version ? { sourceVersion: selected.source_version } : {}),
    } }];
  }
  // One copy per item: the tier legs of a source can each hold a row for it; the copy with text wins.
  const candidates: EvidenceCandidate[] = [];
  const corpusIds = new Set<string>();
  const readItems = new Set<string>();
  const seen = new Set<string>();
  let unreadable = 0;
  for (const member of members) {
    const key = JSON.stringify([member.sourceItem.providerConversationId ?? '', member.sourceItem.providerItemId]);
    seen.add(key);
    if (readItems.has(key)) continue;
    const trustDomain = lanes.registry.get(member.corpusId)?.trustDomain as SourceTrustDomain | undefined;
    const contentProvider = lanes.contentProviders[member.corpusId];
    if (!trustDomain || !contentProvider) continue;
    const holder = stores.find(store => store.corpusId === member.corpusId);
    const observed = grants && holder?.observeOnDemandRead?.(
      member.sourceItem.localItemId, undefined, grants.controller,
    );
    if (observed) grants?.work.push(observed);
    const content = await contentProvider.fetchLocalContent({ provenance: { sourceItem: member.sourceItem }, trustDomain, maxChars: Number.MAX_SAFE_INTEGER });
    if (grants?.controller.signal.aborted || observed?.check() === false) {
      throw new DeepReadRefused('nothing_readable', 'Access to an item changed while opening this read.');
    }
    if (!content || content.namesOnly || content.contentPrivate || content.chunks.length === 0) continue;
    readItems.add(key);
    corpusIds.add(member.corpusId);
    const names = family === 'chat' ? holder?.itemNames?.(member.sourceItem) : undefined;
    const conversationLabel = family === 'chat' ? names?.title ?? selected.conversation_label : undefined;
    const title = names?.title ?? (set.whole === 'conversation' ? selected.conversation_label ?? selected.title : selected.title);
    const authoredAt = names?.authoredAt ?? member.authoredAt;
    const citation = {
      ...(title ? { title } : {}),
      ...(conversationLabel ? { conversationLabel } : {}),
      ...(names?.sender ? { authorLabel: names.sender } : {}),
      ...(authoredAt ? { authoredAt } : {}),
    };
    // One candidate per passage, so a long document spreads over sections in order.
    for (const chunk of content.chunks) {
      candidates.push({
        provenance: { sourceItem: member.sourceItem, ...(Object.keys(citation).length ? { citation } : {}) },
        trustTier: content.sensitivity.trustTier,
        trustDomain,
        chunks: [chunk],
      } as EvidenceCandidate);
    }
  }
  unreadable = [...seen].filter(key => !readItems.has(key)).length;
  const label = set.whole === 'conversation'
    ? `${selected.conversation_label ?? 'the conversation'}${set.after || set.before ? ` (${set.after?.slice(0, 10) ?? 'start'} to ${set.before?.slice(0, 10) ?? 'now'})` : ''}`
    : selected.title ?? 'the document';
  return { candidates, corpusIds: [...corpusIds], unreadable, items: seen.size, label };
}

export function createDeepReadJobs(options: {
  stores: () => readonly DeepReadStore[];
  lanes: () => AnalystAnswerLanes | undefined;
  model: () => Promise<DeepReadModel>;
  inbox: () => WaitingQuestionStore | undefined;
  /**
   * Whether privacy judging has queued work for the same model. Before each
   * model call a deep read steps aside for it, for at most as long as its own
   * last call took, so a standing judging backlog still gets at least half the
   * model and the read still moves. The job says what it is waiting on.
   */
  judgeBusy?: () => boolean;
  /** Whether the owner's own questions are being answered: a read waits for them to finish before its next call. */
  interactiveBusy?: () => boolean;
  /**
   * The set's own search hits for the question (provider item ids): the
   * ordinary keyword and vector search scoped to the set's conversation and
   * span. Without it, only the full read is offered.
   */
  relevantItems?: (question: string, set: DeepReadSet, corpusIds: readonly string[]) => Promise<ReadonlySet<string>>;
  /** Where measured pace per model is kept across restarts. */
  paceFile?: string;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}) {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const jobs = new Map<string, Job>();
  const paces = paceBook(options.paceFile);

  function land(view: DeepReadJobView, result: Awaited<ReturnType<typeof runDeepRead>>, candidates: readonly EvidenceCandidate[], corpusIds: readonly string[]): string | undefined {
    const store = options.inbox();
    if (!store) return undefined;
    const cited = new Map<string, EvidenceCandidate>();
    for (const citation of result.citations) {
      const local = citation.provenance.sourceItem.localItemId;
      const candidate = candidates.find(c => c.provenance.sourceItem.localItemId === local);
      if (candidate && !cited.has(local)) cited.set(local, candidate);
    }
    const corpusOf = (candidate: EvidenceCandidate) => corpusIds.find(id => options.lanes()?.registry.get(id)?.trustDomain === candidate.trustDomain) ?? corpusIds[0] ?? '';
    const stored: StoredPrivateAnswer = {
      status: result.citations.length ? 'answered' : 'not_found',
      ...(result.citations.length ? { answer: `${result.answer}\n\n${readFooter(view, result)}` } : {}),
      citations: [...cited.values()].map(candidate => {
        const citation = candidate.provenance.citation;
        const title = conversationCitationTitle(citation?.title, citation?.conversationLabel, citation?.authorLabel);
        const source = providerSourceLabel(candidate.provenance.sourceItem.provider);
        return {
          ...(title ? { title } : {}),
          ...(source ? { source } : {}),
          ...(citation?.authoredAt ? { date: citation.authoredAt.slice(0, 10) } : {}),
        };
      }),
      unanswered: [...result.unanswered],
      leftOut: [],
      read: [...cited.values()].map(candidate => inboxEvidenceIdentity({ corpusId: corpusOf(candidate), trustDomain: candidate.trustDomain, trustTier: candidate.trustTier, provenance: candidate.provenance })),
    };
    const ticket = store.ticket(INBOX_CONNECTION);
    // Recorded and answered in one step, so the inbox's own background answerer never picks it up.
    const ref = store.record(ticket, { retainEachAsk: true, question: `${view.read === 'all' ? 'Read all of' : 'Read the days that mention this in'} ${view.setLabel}: ${view.question}`, surface: 'remote', state: 'waiting' });
    if (!ref) return undefined;
    return store.saveAnswer(ref, stored) ? ref.id : undefined;
  }

  function readFooter(view: DeepReadJobView, result: { sectionsRead: number; sectionsTotal: number }): string {
    const unreadable = view.unreadable ? ` (${view.unreadable} not readable here)` : '';
    const relevant = view.choices.relevantDays;
    if (view.read === 'relevant_days' && relevant) {
      const left = view.choices.all.messageCount - relevant.messageCount;
      return `Read the days that mention this in ${view.setLabel} with ${view.model}: ${relevant.days} of ${relevant.totalDays} days, ${relevant.messageCount} of ${view.choices.all.messageCount} messages, ${result.sectionsRead} of ${result.sectionsTotal} sections${unreadable}. ${left} messages on other days were not read. To continue, ask for the full read (read: all) to read every message.`;
    }
    return `Read all of ${view.setLabel} with ${view.model}: ${result.sectionsRead} of ${result.sectionsTotal} sections, ${view.items} items${unreadable}.`;
  }

  async function startRead(question: string, set: DeepReadSet, maxSeconds: number | undefined, grants: {
    controller: AbortController;
    work: OnDemandGrantWork[];
  }): Promise<Job> {
    const { controller, work } = grants;
    const grantsCurrent = () => work.every(hold => hold.check());
    if (!question.trim()) throw new DeepReadRefused('invalid_set', 'A question is required.');
    const model = await options.model();
    if (!model) throw new DeepReadRefused('no_private_model', 'Deep read needs your own private model. Set one up in Settings, Models.');
    if ('unavailable' in model) throw new DeepReadRefused('model_unavailable', `Your private model ${model.modelId} is not reachable right now.`);
    const { candidates, corpusIds, unreadable, items, label } = await readDeepReadSet(set, options.stores, options.lanes, grants);
    if (candidates.length === 0) throw new DeepReadRefused('nothing_readable', `Nothing in ${label} is readable here (${items} items found).`);
    if (set.read !== undefined && set.read !== 'all' && set.read !== 'relevant_days') throw new DeepReadRefused('invalid_set', 'read must be all or relevant_days.');
    const sectionsOf = (pieces: readonly EvidenceCandidate[]) => planDeepReadSections(question, pieces, corpusIds, model.promptBytes, 'compact').length;
    const pace = paces.get(model.modelId);
    const priced = (sections: number) => (pace === undefined ? {} : { seconds: Math.round(sections * pace) });
    const fullSections = sectionsOf(candidates);
    const allMessages = new Set(candidates.map(messageKey)).size;
    const choices: DeepReadJobView['choices'] = { all: { sections: fullSections, messageCount: allMessages, ...priced(fullSections) } };
    let relevantCandidates: EvidenceCandidate[] | undefined;
    if (set.whole === 'conversation' && options.relevantItems) {
      // Within the 15-minute budget at the measured pace (sections scale with the text read); unmeasured, the whole pick.
      const totalChars = candidates.reduce((n, c) => n + c.chunks.join('').length, 0) || 1;
      const pick = pickRelevantDaysWithin(candidates, await options.relevantItems(question, set, corpusIds), picked => pace === undefined
        || fullSections * (picked.reduce((n, c) => n + c.chunks.join('').length, 0) / totalChars) * pace <= DEEP_READ_BUDGET_SECONDS);
      if (pick.candidates.length > 0) {
        relevantCandidates = pick.candidates;
        const sections = sectionsOf(pick.candidates);
        choices.relevantDays = { sections, messageCount: pick.messages, days: pick.days, totalDays: pick.totalDays, ...priced(sections) };
      }
    }
    if (set.read === 'relevant_days' && !relevantCandidates) {
      throw new DeepReadRefused('nothing_readable', `No day in ${label} mentions this, so there is no relevant-days read; ask for read: all.`);
    }
    const read = chooseDeepRead(choices, set.read);
    const reading = read === 'relevant_days' && relevantCandidates ? relevantCandidates : candidates;
    const sectionsTotal = read === 'relevant_days' ? choices.relevantDays!.sections : fullSections;
    if (!grantsCurrent()) throw new DeepReadRefused('nothing_readable', 'Access to an item changed while opening this read.');
    if (maxSeconds !== undefined) {
      // With no measured pace, use the section limit as the time budget for the notice.
      const estimateSeconds = sectionsTotal * (pace ?? maxSeconds / UNMEASURED_SECTION_LIMIT);
      if (pace === undefined ? sectionsTotal > UNMEASURED_SECTION_LIMIT : estimateSeconds > maxSeconds) {
        const minutes = Math.max(1, Math.round(estimateSeconds / 60));
        throw new DeepReadRefused('too_long', `A full read would take about ${minutes} minutes.`, { sectionsTotal, estimateSeconds });
      }
    }
    const id = `dr_${randomBytes(9).toString('base64url')}`;
    const view: DeepReadJobView = {
      id, state: 'reading', question, setLabel: label, items, unreadable, sectionsTotal, sectionsDone: 0, notes: 0,
      model: model.modelId, startedAt: now().toISOString(), read, choices,
      choiceSummary: deepReadChoiceSummary(choices, read, set.read),
    };
    const coverageNotes = read === 'relevant_days' && choices.relevantDays
      ? [`Only the days that mention this were read: ${choices.relevantDays.days} of ${choices.relevantDays.totalDays} days, ${choices.relevantDays.messageCount} of ${allMessages} messages. ${allMessages - choices.relevantDays.messageCount} messages on other days were not read.`]
      : [];
    const job: Job = { view, controller, grantsCurrent };
    jobs.set(id, job);
    while (jobs.size > MAX_JOBS_KEPT) jobs.delete(jobs.keys().next().value!);
    const started = now().getTime();
    let lastCallMs = 0;
    let callStarted: number | undefined;
    let waitedMs = 0;
    const stepAside = async () => {
      if (callStarted !== undefined) lastCallMs = now().getTime() - callStarted;
      const waitStarted = now().getTime();
      const until = waitStarted + Math.max(JUDGE_STEP_ASIDE_MIN_MS, lastCallMs);
      for (;;) {
        if (controller.signal.aborted) break;
        // The owner's own questions go first for as long as they run; judging gets at most one call's length.
        if (options.interactiveBusy?.()) view.waitingOn = 'your questions';
        else if (options.judgeBusy?.() && now().getTime() < until) view.waitingOn = 'privacy checks';
        else break;
        await sleep(JUDGE_LOOK_MS);
      }
      delete view.waitingOn;
      grantsCurrent();
      callStarted = now().getTime();
      waitedMs += callStarted - waitStarted;
    };
    // Background priority on the shared model: the owner's own asks go first.
    job.completion = runBackgroundInference(() => runDeepRead({
      question, candidates: reading, corpusIds, analyst: model.analyst, promptBytes: model.promptBytes, evidenceFormat: 'compact',
      signal: controller.signal, coverageNotes,
      beforeModelCall: stepAside,
      onProgress: (progress: DeepReadProgress) => {
        view.state = progress.phase === 'done' ? 'answering' : progress.phase;
        view.sectionsDone = progress.sectionsDone; view.notes = progress.notes;
        if (progress.sectionsDone > 0 && progress.phase === 'reading') {
          // Model time only: waiting for the owner's questions or judging is not the model's pace.
          const perSection = Math.max(0, now().getTime() - started - waitedMs) / 1000 / progress.sectionsDone;
          if (perSection > 0) paces.set(model.modelId, perSection);
          view.estimateSecondsLeft = Math.round(perSection * (progress.sectionsTotal - progress.sectionsDone + 1));
        }
      },
    })).then(result => {
      if (controller.signal.aborted || !grantsCurrent()) {
        view.state = 'cancelled';
        view.finishedAt = now().toISOString(); delete view.estimateSecondsLeft;
        return undefined;
      }
      const inboxId = land(view, result, reading, corpusIds);
      if (inboxId) view.inboxId = inboxId;
      view.state = 'done'; view.finishedAt = now().toISOString(); delete view.estimateSecondsLeft;
      if (!inboxId) view.failure = 'The answer could not be saved to Private answers.';
      return result;
    }, (error: unknown) => {
      view.state = controller.signal.aborted ? 'cancelled' : 'failed';
      view.finishedAt = now().toISOString(); delete view.estimateSecondsLeft;
      if (!controller.signal.aborted) {
        view.failure = 'The private model stopped before the read finished.';
        options.log?.(`[deep-read] ${id} failed: ${error instanceof Error ? error.name : 'error'}`);
      }
      return undefined;
    }).finally(() => { for (const hold of work) hold.release(); });
    return job;
  }

  return {
    /** Starts a deep read; resolves once the set is listed and the model chosen, while reading goes on in the background. */
    async start(question: string, set: DeepReadSet, { maxSeconds }: { maxSeconds?: number } = {}): Promise<DeepReadJobView> {
      const grants = { controller: new AbortController(), work: [] as OnDemandGrantWork[] };
      let job: Job | undefined;
      try {
        job = await startRead(question, set, maxSeconds, grants);
        if (!job.grantsCurrent()) {
          throw new DeepReadRefused('nothing_readable', 'Access to an item changed while opening this read.');
        }
        return { ...job.view };
      } finally {
        if (!job) for (const hold of grants.work) hold.release();
      }
    },
    /** In-process consumers can await the same background job without a polling clock. */
    async wait(id: string): Promise<AnalystResult | undefined> {
      const job = jobs.get(id);
      const result = await job?.completion;
      return job?.grantsCurrent() ? result : undefined;
    },
    status(id?: string): DeepReadJobView[] {
      return [...jobs.values()].filter(job => id === undefined || job.view.id === id).reverse().map(deepReadView);
    },
    cancel(id: string): boolean {
      const job = jobs.get(id);
      if (!job || job.view.state === 'done' || job.view.state === 'failed' || job.view.state === 'cancelled') return false;
      job.controller.abort();
      return true;
    },
  };
}

export type DeepReadJobs = ReturnType<typeof createDeepReadJobs>;
