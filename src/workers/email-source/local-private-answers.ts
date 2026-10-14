/**
 * Local Private answers inbox and Ask privately. HTTP admits only a local
 * control session, never dash_ readers, ChatGPT widgets or Gateway read scope.
 * Arrival starts a bounded local background answer; ChatGPT gets 30 seconds
 * to claim its sealed panel. Claimed jobs stay hidden until ack/expiry.
 * read returns stored text only after current eligibility of every identity;
 * changed evidence invalidates the generation and schedules a fresh answer.
 * Source opens are opaque, session-bound, expire after 30 minutes and recheck
 * every source immediately before desktop dispatch. No external URL is sent
 * to the page. Delete/revoke/withdrawal invalidates every outstanding completion.
 * Retries persist only attempts and next-attempt, never exception text.
 */
import { TIER_LEDGER_IDENTITY_FIELDS } from '../classification/tier-ledger.ts';
import { lstatSync } from 'node:fs';
import { answerReleaseWithheldReason, type ReleaseCheck } from '../../core/release-manifest.ts';
import { randomBytes } from 'node:crypto';
import { CHATGPT_INBOX_GRACE_MS, type StoredPrivateAnswer, type WaitingQuestion, type WaitingQuestionRef, type WaitingQuestionStore } from '../../core/waiting-private-questions.ts';
import { answerPrivately, type BuiltInAnalystModel } from '../../core/analyst-built-in.ts';
import type { PrivateAnswerSourceCitation, PrivateEvidenceItem } from '../chatgpt/private-answer-contract.ts';
import {
  createBuiltInPrivateAnswerModel,
  embeddingPanelRelevance,
  type PanelAnswerLimits,
  type PrivateSourceLinks,
} from '../chatgpt/private-answer-model.ts';
import type { AnalystAnswerLanes } from '../source-index/analyst-answer.ts';
import type { SourceIndexAnswerRequest } from '../source-index/answer-types.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import {
  answerOnThisComputer,
  checkLocalEvidenceItems,
  readLocalEvidenceItem,
  type LocalAnswerRequest,
  type LocalAnswerResult,
} from '../source-index/local-answer.ts';

export const LOCAL_PRIVATE_ANSWERS_PATH = '/dashboard/private-answers';
const TOKEN_TTL_MS = 30 * 60_000;
const MAX_TOKENS = 400;
const MAX_QUESTION_CHARS = 2_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

/** One waiting question as the page lists it. Only to a local control session. */
export interface WaitingQuestionView {
  id: string;
  question: string;
  /** Who asked: the connection's name ("ChatGPT", "Grok Bot"). */
  from: string;
  askedAt: string;
  /** The local probe could not tell yet whether Private items match. */
  unchecked: boolean;
  state: 'answering' | 'retrying' | 'answered' | 'unchecked' | 'queued';
  unread: boolean;
  answeredAt?: string;
}

/** A citation as the page gets it: never a path; a local file opens by token. */
export interface LocalCitationView {
  title?: string;
  source?: string;
  date?: string;
  url?: string | undefined;
  open?: string;
}

export interface LocalPrivateAnswersOptions {
  answer: (input: LocalAnswerRequest) => Promise<LocalAnswerResult>;
  store: () => Pick<WaitingQuestionStore, 'list' | 'get' | 'dismiss' | 'dismissAll' | 'acknowledge'> & Partial<WaitingQuestionStore> | undefined;
  /** A connection's display name, by id; undefined when unknown. */
  connectionName?: (connectionId: string) => string | undefined;
  /** The live eligibility guard, re-asked before a cited file opens. */
  eligible?: (items: readonly PrivateEvidenceItem[]) => Promise<readonly boolean[]>;
  /** Opens a local file (macOS `open`, checked by the caller). Absent: local files do not open. */
  openFile?: (path: string, eligible: () => Promise<boolean>) => Promise<void>;
  now?: () => number;
  /** A live panel claim suppresses the fallback until that panel's job expires. */
  panelClaimed?: (ref: WaitingQuestionRef) => boolean;
  interactiveBusy?: () => boolean;
  /** Privacy classification outranks automatic synthesis. */
  backgroundBusy?: () => boolean;
  backgroundAnswer?: (input: LocalAnswerRequest) => Promise<LocalAnswerResult>;
  isActive?: (connectionId: string) => boolean;
  openUrl?: (url: string, eligible: () => Promise<boolean>) => Promise<void>;
}

export interface LocalPrivateAnswersResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface LocalPrivateAnswers {
  /** The waiting list for the page; undefined when the store cannot be read. */
  waiting(): { questions: WaitingQuestionView[]; olderRemoved: boolean } | undefined;
  /** How many questions wait, for the computer's Needs you line; 0 when unknown. */
  waitingCount(): number;
  /** One page action, by the local control session `session`. */
  start(): void;
  tick(): Promise<void>;
  close(): void;
  handle(body: Readonly<Record<string, unknown>>, session: string): Promise<LocalPrivateAnswersResponse>;
}

interface OpenEntry {
  ref?: WaitingQuestionRef;
  session: string;
  path?: string | undefined;
  url?: string | undefined;
  read: readonly PrivateEvidenceItem[];
  expiresAt: number;
}

export interface LocalAnswerPathOptions {
  /** Current ledger targets too: a moving-to-Secret item may still have a serving copy. */
  releaseCheck: ReleaseCheck;
  /** The worker's shared lane factory (source-answer-lanes.ts); called with `built_in_only`. */
  lanes: (request: SourceIndexAnswerRequest, embedding?: 'built_in_only') => AnalystAnswerLanes;
  /** The worker's one built-in private model. */
  model: BuiltInAnalystModel | undefined;
  available: () => boolean;
  /**
   * The embedding model that ranks the items read, as the built-in model this
   * process already holds (builtInEmbeddingOnly), or undefined.
   */
  relevanceEmbedding: () => SourceEmbeddingProvider | undefined;
  sourceLinks?: (item: PrivateEvidenceItem) => PrivateSourceLinks | undefined;
  sourceName?: (corpusId: string) => string | undefined;
  limits?: Partial<PanelAnswerLimits>;
}

/**
 * The answer path behind Ask privately and the inbox, as the worker wires it:
 * the shared lanes narrowed to this computer's built-in embedding model, the
 * live eligibility guard over those lanes, and the built-in private model.
 */
export function createLocalAnswerPath(options: LocalAnswerPathOptions): {
  eligible: (items: readonly PrivateEvidenceItem[]) => Promise<readonly boolean[]>;
  answer: (input: LocalAnswerRequest) => Promise<LocalAnswerResult>;
} {
  const lanes = (request: SourceIndexAnswerRequest) => options.lanes(request, 'built_in_only');
  const eligible = async (items: readonly PrivateEvidenceItem[]) => {
    const served = await checkLocalEvidenceItems({ lanes, items, throwOnUnavailable: true });
    // This local control path explicitly asks for Private content. Remote
    // manifests/tickets retain their own consent and release boundaries.
    const inputs = items.map(item => {
      const provenance = item.provenance as { sourceItem?: { provider?: string; accountScope?: string; providerItemId?: string; providerConversationId?: string } } | undefined;
      const identity = provenance?.sourceItem;
      return {
        corpusId: typeof item.corpusId === 'string' ? item.corpusId : '',
        provider: identity?.provider ?? '', accountScope: identity?.accountScope ?? '', providerItemId: identity?.providerItemId ?? '',
        ...(identity?.providerConversationId ? { providerConversationId: identity.providerConversationId } : {}),
        privateAtAnswer: item.trustDomain === 'secure_local' || item.trustTier === 'S4' || item.trustTier === 'S5',
      };
    });
    // Read once outside the fail-closed release formatter: unavailable state
    // must hide a retained answer without treating it as definitely withdrawn.
    const verdicts = options.releaseCheck.inputs(inputs);
    if (verdicts.length !== inputs.length || verdicts.some(v => v.tier === 'unknown')) throw new Error('Eligibility unavailable');
    const posture = options.releaseCheck.secureDerivativeDefault();
    const reason = answerReleaseWithheldReason([{ inputs, constraints: { secureDerivativeDefault: 'approval', includeSecureLocalContent: true } }], { inputs: () => verdicts, secureDerivativeDefault: () => posture });
    return reason ? items.map(() => false) : served;
  };
  const model = createBuiltInPrivateAnswerModel({
    model: options.model,
    eligible,
    available: options.available,
    answer: answerPrivately,
    relevance: embeddingPanelRelevance(options.relevanceEmbedding),
    readItem: (item, request) => readLocalEvidenceItem({ lanes, item, ...request }),
    ...(options.sourceLinks ? { sourceLinks: options.sourceLinks } : {}),
    ...(options.limits ? { limits: options.limits } : {}),
  });
  return {
    eligible,
    answer: (input) => answerOnThisComputer(input, {
      lanes,
      model,
      eligible,
      ...(options.sourceName ? { sourceName: options.sourceName } : {}),
    }),
  };
}

function refused(status: number, code: string, message: string): LocalPrivateAnswersResponse {
  return { status, body: { ok: false, error: { code, message } } };
}

/** A content-free identity allowlist: source passages and future fields never persist. */
export function inboxEvidenceIdentity(item: PrivateEvidenceItem): PrivateEvidenceItem {
  const out: Record<string, unknown> = {};
  for (const key of ['corpusId', 'trustDomain', 'trustTier', 'tier']) {
    if (typeof item[key] === 'string') out[key] = item[key];
  }
  const provenance = item.provenance as { sourceItem?: Record<string, unknown> } | undefined;
  const source = provenance?.sourceItem;
  if (source) {
    const kept: Record<string, string> = {};
    for (const key of ['family', 'localItemId', ...TIER_LEDGER_IDENTITY_FIELDS]) {
      if (typeof source[key] === 'string') kept[key] = source[key];
    }
    out.provenance = { sourceItem: kept };
  }
  return out;
}

export function createLocalPrivateAnswers(options: LocalPrivateAnswersOptions): LocalPrivateAnswers {
  const now = options.now ?? Date.now;
  const opens = new Map<string, OpenEntry>();
  let running = false;
  let closed = false;
  let pass: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  const abort = new AbortController();
  const store = () => { try { return options.store(); } catch { return undefined; } };
  const refOf = (q: WaitingQuestion): WaitingQuestionRef => ({ id: q.id, generation: q.generation, connectionId: q.connectionId });
  const active = (q: WaitingQuestion) => {
    try { return !closed && (!options.isActive || options.isActive(q.connectionId)); } catch { return false; }
  };
  const hidden = (q: WaitingQuestion) => q.surface === 'chatgpt' && (
    now() < Date.parse(q.askedAt) + CHATGPT_INBOX_GRACE_MS || options.panelClaimed?.(refOf(q)) === true
  );
  const current = (q: WaitingQuestion) => {
    const fresh = store()?.get(q.id);
    return fresh && fresh.generation === q.generation && active(fresh) && !hidden(fresh) ? fresh : undefined;
  };
  const eligible = async (read: readonly PrivateEvidenceItem[]) => {
    try {
      const ok = options.eligible ? await options.eligible(read) : read.map(() => false);
      if (ok.length !== read.length) return 'unknown';
      return ok.every(value => value === true) ? 'eligible' : 'ineligible';
    } catch { return 'unknown'; }
  };
  const sweep = () => {
    for (const [id, entry] of opens) if (entry.expiresAt <= now()) opens.delete(id);
    while (opens.size > MAX_TOKENS) opens.delete(opens.keys().next().value!);
  };
  const answerFor = async (input: LocalAnswerRequest, background = false): Promise<LocalAnswerResult> => {
    try { return await (background ? options.backgroundAnswer ?? options.answer : options.answer)(input); }
    catch { return { status: 'failed' }; }
  };
  const wake = () => { if (!closed) void api.tick().catch(() => undefined); };
  const invalidate = (q: WaitingQuestion) => {
    store()?.invalidate?.(refOf(q));
    for (const [id, entry] of opens) if (entry.ref?.id === q.id) opens.delete(id);
    wake();
  };
  const answerBody = (result: LocalAnswerResult | StoredPrivateAnswer, session: string, q?: WaitingQuestion): Record<string, unknown> => {
    if (result.status !== 'answered') return { status: result.status, ...('leftOut' in result ? { left_out: result.leftOut } : {}) };
    sweep();
    const citations: LocalCitationView[] = result.citations.map(citation => {
      const view: LocalCitationView = {
        ...(citation.title ? { title: citation.title } : {}),
        ...(citation.source ? { source: citation.source } : {}),
        ...(citation.date ? { date: citation.date } : {}),
      };
      const path = citation.localPath && options.openFile ? citation.localPath : undefined;
      const url = !path && citation.url?.startsWith('https://') && options.openUrl ? citation.url : undefined;
      if (path || url) {
        const id = randomBytes(24).toString('base64url');
        opens.set(id, { session, ...(path ? { path } : { url }), read: result.read.map(inboxEvidenceIdentity), expiresAt: now() + TOKEN_TTL_MS, ...(q ? { ref: refOf(q) } : {}) });
        view.open = id;
      }
      return view;
    });
    return { status: 'answered', answer: result.answer, citations, unanswered: result.unanswered, left_out: result.leftOut };
  };
  const api: LocalPrivateAnswers = {
    start() {
      if (timer || closed) return;
      unsubscribe = store()?.subscribe?.(wake);
      timer = setInterval(wake, 1_000);
      timer.unref?.();
      wake();
    },
    tick() {
      if (pass) return pass;
      if (closed || options.interactiveBusy?.() || options.backgroundBusy?.()) return Promise.resolve();
      pass = (async () => {
        const currentStore = store();
        if (!currentStore) return;
        if (options.isActive) currentStore.reconcileConnections?.(options.isActive);
        // Oldest first avoids starving a retry behind a busy connection.
        for (const q of [...currentStore.list({ includeResults: false }).questions].reverse()) {
          if (closed || options.interactiveBusy?.() || options.backgroundBusy?.()) break;
          if (q.hasResult || q.result || q.state !== 'waiting' || q.nextAttemptAt > now() || hidden(q) || !active(q)) continue;
          let modelCalled = false;
          if (currentStore.reserveAutoAnswer && !currentStore.reserveAutoAnswer(refOf(q))) continue;
          const reservedAt = now();
          const result = await answerFor({ question: q.question, selectors: q.selectors, detail: q.detail, signal: abort.signal, onModelCall: () => { modelCalled = true; } }, true);
          if (result.status === 'no_model' || result.status === 'model_downloading' || (result.status === 'failed' && !modelCalled)) {
            currentStore.refundAutoAnswer?.(refOf(q), reservedAt);
          }
          if (!current(q)) continue;
          if ((result.status === 'answered' && await eligible(result.read) === 'eligible') || result.status === 'not_found') {
            if (!current(q)) continue;
            const saved: StoredPrivateAnswer = result.status === 'answered'
              ? { status: 'answered', answer: result.answer, citations: result.citations.map(c => ({ ...(c.title ? { title: c.title } : {}), ...(c.source ? { source: c.source } : {}), ...(c.date ? { date: c.date } : {}), ...(c.url ? { url: c.url } : {}), ...(c.localPath ? { localPath: c.localPath } : {}) })), unanswered: result.unanswered, leftOut: result.leftOut, read: result.read.map(inboxEvidenceIdentity) }
              : { status: 'not_found', citations: [], unanswered: [], leftOut: result.leftOut, read: [] };
            if (!currentStore.saveAnswer?.(refOf(q), saved)) currentStore.retry?.(refOf(q));
          } else currentStore.retry?.(refOf(q));
        }
      })().catch(() => undefined).finally(() => { pass = undefined; });
      return pass;
    },
    close() {
      closed = true;
      abort.abort();
      if (timer) clearInterval(timer);
      unsubscribe?.();
      opens.clear();
    },
    waiting() {
      try {
        const listed = store()?.list({ includeResults: false });
        if (!listed) return undefined;
        return { questions: listed.questions.filter(q => active(q) && !hidden(q)).map(q => ({
          id: q.id, question: q.question, from: options.connectionName?.(q.connectionId)?.trim() || (q.surface === 'chatgpt' ? 'ChatGPT' : 'An agent'),
          askedAt: q.askedAt, unchecked: q.state === 'unchecked', unread: !q.seen,
          state: q.hasResult || q.result ? 'answered' : q.state === 'unchecked' ? 'unchecked' : q.attempts > 0 ? 'retrying' : q.nextAttemptAt > now() || options.backgroundBusy?.() ? 'queued' : 'answering',
          ...(q.answeredAt ? { answeredAt: q.answeredAt } : {}),
        })), olderRemoved: listed.olderRemoved };
      } catch { return undefined; }
    },
    waitingCount() { return api.waiting()?.questions.filter(q => q.unread && q.state === 'answered').length ?? 0; },
    async handle(body, session) {
      const action = body.action;
      if (action === 'list') return { status: 200, body: { ok: true, ...api.waiting() } };
      if (action === 'ask') {
        const question = typeof body.question === 'string' ? body.question.trim() : '';
        if (!question || question.length > MAX_QUESTION_CHARS) return refused(400, 'invalid_params', 'Type a question first.');
        if (running) return refused(429, 'busy', 'Olympus is answering another question. Try again in a moment.');
        running = true;
        try {
          const result = await answerFor({ question, detail: body.detail === 'full' ? 'full' : 'summary' });
          if (result.status === 'answered') {
            const check = await eligible(result.read);
            if (check !== 'eligible') return { status: 200, body: { ok: true, status: check === 'unknown' ? 'check_unavailable' : 'changed' } };
          }
          return { status: 200, body: { ok: true, ...answerBody(result, session) } };
        } finally { running = false; }
      }
      if (action === 'read') {
        const q = typeof body.id === 'string' ? store()?.get(body.id) : undefined;
        if (!q || !current(q)) return refused(410, 'gone', 'That answer was deleted');
        if (!q.result) return { status: 200, body: { ok: true, status: q.state === 'unchecked' ? 'unchecked' : q.attempts ? 'retrying' : q.nextAttemptAt > now() || options.backgroundBusy?.() ? 'queued' : 'answering' } };
        const check = await eligible(q.result.read);
        if (check === 'unknown') return { status: 200, body: { ok: true, status: 'check_unavailable' } };
        if (check === 'ineligible' || !current(q)) {
          invalidate(q);
          return { status: 200, body: { ok: true, status: 'answering' } };
        }
        return { status: 200, body: { ok: true, generation: q.generation, ...answerBody(q.result, session, q) } };
      }
      if (action === 'seen') {
        const q = typeof body.id === 'string' ? store()?.get(body.id) : undefined;
        const marked = !!q && q.generation === body.generation && !!current(q) && store()?.markRead?.(refOf(q)) === true;
        return { status: 200, body: { ok: true, status: marked ? 'read' : 'kept' } };
      }
      if (action === 'delete' || action === 'delete_all') {
        try {
          const removed = action === 'delete_all' ? store()?.dismissAll() ?? 0 : typeof body.id === 'string' && store()?.dismiss(body.id) ? 1 : 0;
          // Tokens minted from an answer that was deleted cannot outlive its row.
          if (action === 'delete_all') opens.clear();
          else for (const [id, entry] of opens) if (entry.ref?.id === body.id) opens.delete(id);
          return { status: 200, body: { ok: true, status: 'deleted', removed } };
        } catch { return refused(503, 'unavailable', 'Private answers cannot be changed right now.'); }
      }
      if (action === 'open') {
        sweep();
        const id = typeof body.token === 'string' && TOKEN_PATTERN.test(body.token) ? body.token : '';
        const entry = opens.get(id);
        if (!entry || entry.session !== session) return refused(410, 'gone', 'This source cannot be opened from this session.');
        let checkUnavailable = false;
        const allowed = async () => {
          sweep();
          if (!entry || entry.session !== session || opens.get(id) !== entry) return false;
          if (entry.ref) {
            const q = store()?.get(entry.ref.id);
            if (!q || q.generation !== entry.ref.generation || !q.result || !current(q)) return false;
          }
          const check = await eligible(entry.read);
          if (check === 'unknown') checkUnavailable = true;
          if (check !== 'eligible') return false;
          // Authorization may change while the source guard awaits a store.
          sweep();
          if (opens.get(id) !== entry) return false;
          if (entry.ref) {
            const q = store()?.get(entry.ref.id);
            if (!q || q.generation !== entry.ref.generation || !q.result || !current(q)) return false;
          }
          return true;
        };
        if (!entry || !await allowed()) {
          if (checkUnavailable) return refused(503, 'check_unavailable', "Couldn't check this answer right now");
          if (entry?.ref) { const q = store()?.get(entry.ref.id); if (q) invalidate(q); }
          opens.delete(id);
          return refused(410, 'gone', 'This source changed. The answer is being written again.');
        }
        try {
          if (entry.path && options.openFile && lstatSync(entry.path).isFile()) await options.openFile(entry.path, allowed);
          else if (entry.url && options.openUrl) await options.openUrl(entry.url, allowed);
          else return refused(410, 'gone', 'This file is no longer on this computer.');
        } catch { return refused(500, 'failed', 'The source could not be opened.'); }
        return { status: 200, body: { ok: true, status: 'opened' } };
      }
      return refused(400, 'invalid_params', 'Unknown action.');
    },
  };
  return api;
}
