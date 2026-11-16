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
 */
import { randomBytes } from 'node:crypto';
import type { Analyst, EvidenceCandidate } from '../../../core/contracts.ts';
import { runDeepRead, planDeepReadSections, type DeepReadProgress } from '../../../core/deep-read.ts';
import { providerSourceLabel } from '../../../core/remote-result.ts';
import type { SourceItemIdentity, SourceTrustDomain } from '../../../core/source-index/types.ts';
import type { StoredPrivateAnswer, WaitingQuestionStore } from '../../../core/waiting-private-questions.ts';
import type { AnalystAnswerLanes } from '../../source-index/analyst-answer.ts';
import { inboxEvidenceIdentity } from './local-private-answers.ts';
import { runBackgroundInference } from '../../answer-activity.ts';

/** What a deep read needs of a connector store: who it is and the conversation lister. */
export interface DeepReadStore {
  corpusId: string;
  family: string;
  conversationItems(key: {
    provider: string; accountScope: string; providerConversationId: string;
    providerThreadId?: string; after?: string; before?: string;
  }): Array<{ sourceItem: SourceItemIdentity; authoredAt?: string }>;
  activeLocalItemRow(localItemId: string): unknown;
}

export interface DeepReadSet {
  /** A search hit's selected_item (identifiers only). */
  selected_item: Record<string, string>;
  /** 'item': that document alone. 'conversation': every message of its conversation. */
  whole: 'item' | 'conversation';
  /** For a conversation: only messages authored at or after / before these ISO times. */
  after?: string;
  before?: string;
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
  waitingOn?: 'privacy checks';
}

export class DeepReadRefused extends Error {
  constructor(readonly code: 'no_private_model' | 'model_unavailable' | 'not_found' | 'nothing_readable' | 'invalid_set', message: string) { super(message); }
}

interface Job { view: DeepReadJobView; controller: AbortController }

const INBOX_CONNECTION = '@local:You';
/** How often a read stepping aside looks again whether judging is done. */
const JUDGE_LOOK_MS = 2_000;
/** The least a read steps aside for judging before its first call has a measured length. */
const JUDGE_STEP_ASIDE_MIN_MS = 5_000;
const MAX_JOBS_KEPT = 50;

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
    const content = await contentProvider.fetchLocalContent({ provenance: { sourceItem: member.sourceItem }, trustDomain, maxChars: Number.MAX_SAFE_INTEGER });
    if (!content || content.namesOnly || content.contentPrivate || content.chunks.length === 0) continue;
    readItems.add(key);
    corpusIds.add(member.corpusId);
    const citation = {
      ...(selected.conversation_label && set.whole === 'conversation' ? { title: selected.conversation_label } : selected.title ? { title: selected.title } : {}),
      ...(member.authoredAt ? { authoredAt: member.authoredAt } : {}),
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
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
}) {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const jobs = new Map<string, Job>();

  const readSet = (set: DeepReadSet) => readDeepReadSet(set, options.stores, options.lanes);

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
      ...(result.citations.length ? { answer: `${result.answer}\n\nRead all of ${view.setLabel} with ${view.model}: ${result.sectionsRead} of ${result.sectionsTotal} sections, ${view.items} items${view.unreadable ? ` (${view.unreadable} not readable here)` : ''}.` } : {}),
      citations: [...cited.values()].map(candidate => ({
        ...(candidate.provenance.citation?.title ? { title: candidate.provenance.citation.title } : {}),
        ...(providerSourceLabel(candidate.provenance.sourceItem.provider) ? { source: providerSourceLabel(candidate.provenance.sourceItem.provider)! } : {}),
        ...(candidate.provenance.citation?.authoredAt ? { date: candidate.provenance.citation.authoredAt.slice(0, 10) } : {}),
      })),
      unanswered: [...result.unanswered],
      leftOut: [],
      read: [...cited.values()].map(candidate => inboxEvidenceIdentity({ corpusId: corpusOf(candidate), trustDomain: candidate.trustDomain, trustTier: candidate.trustTier, provenance: candidate.provenance })),
    };
    const ticket = store.ticket(INBOX_CONNECTION);
    // Recorded and answered in one step, so the inbox's own background answerer never picks it up.
    const ref = store.record(ticket, { retainEachAsk: true, question: `Read all of ${view.setLabel}: ${view.question}`, surface: 'remote', state: 'waiting' });
    if (!ref) return undefined;
    return store.saveAnswer(ref, stored) ? ref.id : undefined;
  }

  return {
    /** Starts a deep read; resolves once the set is listed and the model chosen, while reading goes on in the background. */
    async start(question: string, set: DeepReadSet): Promise<DeepReadJobView> {
      if (!question.trim()) throw new DeepReadRefused('invalid_set', 'A question is required.');
      const model = await options.model();
      if (!model) throw new DeepReadRefused('no_private_model', 'Deep read needs your own private model. Set one up in Settings, Models.');
      if ('unavailable' in model) throw new DeepReadRefused('model_unavailable', `Your private model ${model.modelId} is not reachable right now.`);
      const { candidates, corpusIds, unreadable, items, label } = await readSet(set);
      if (candidates.length === 0) throw new DeepReadRefused('nothing_readable', `Nothing in ${label} is readable here (${items} items found).`);
      const sectionsTotal = planDeepReadSections(question, candidates, corpusIds, model.promptBytes, 'compact').length;
      const id = `dr_${randomBytes(9).toString('base64url')}`;
      const view: DeepReadJobView = {
        id, state: 'reading', question, setLabel: label, items, unreadable, sectionsTotal, sectionsDone: 0, notes: 0,
        model: model.modelId, startedAt: now().toISOString(),
      };
      const controller = new AbortController();
      jobs.set(id, { view, controller });
      while (jobs.size > MAX_JOBS_KEPT) jobs.delete(jobs.keys().next().value!);
      const started = now().getTime();
      let lastCallMs = 0;
      let callStarted: number | undefined;
      const stepAside = async () => {
        if (callStarted !== undefined) lastCallMs = now().getTime() - callStarted;
        const until = now().getTime() + Math.max(JUDGE_STEP_ASIDE_MIN_MS, lastCallMs);
        while (options.judgeBusy?.() && now().getTime() < until && !controller.signal.aborted) {
          view.waitingOn = 'privacy checks';
          await sleep(JUDGE_LOOK_MS);
        }
        delete view.waitingOn;
        callStarted = now().getTime();
      };
      // Background priority on the shared model: the owner's own asks go first.
      void runBackgroundInference(() => runDeepRead({
        question, candidates, corpusIds, analyst: model.analyst, promptBytes: model.promptBytes, evidenceFormat: 'compact',
        signal: controller.signal,
        beforeModelCall: stepAside,
        onProgress: (progress: DeepReadProgress) => {
          view.state = progress.phase === 'done' ? 'answering' : progress.phase;
          view.sectionsDone = progress.sectionsDone; view.notes = progress.notes;
          if (progress.sectionsDone > 0) {
            const perSection = (now().getTime() - started) / 1000 / progress.sectionsDone;
            view.estimateSecondsLeft = Math.round(perSection * (progress.sectionsTotal - progress.sectionsDone + 1));
          }
        },
      })).then(result => {
        const inboxId = land(view, result, candidates, corpusIds);
        if (inboxId) view.inboxId = inboxId;
        view.state = 'done'; view.finishedAt = now().toISOString(); delete view.estimateSecondsLeft;
        if (!inboxId) view.failure = 'The answer could not be saved to Private answers.';
      }, (error: unknown) => {
        view.state = controller.signal.aborted ? 'cancelled' : 'failed';
        view.finishedAt = now().toISOString(); delete view.estimateSecondsLeft;
        if (!controller.signal.aborted) {
          view.failure = 'The private model stopped before the read finished.';
          options.log?.(`[deep-read] ${id} failed: ${error instanceof Error ? error.name : 'error'}`);
        }
      });
      return { ...view };
    },
    status(id?: string): DeepReadJobView[] {
      const all = [...jobs.values()].map(job => ({ ...job.view })).reverse();
      return id ? all.filter(view => view.id === id) : all;
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
