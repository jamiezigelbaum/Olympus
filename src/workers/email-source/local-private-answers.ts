import { DASHBOARD_PRIVATE_ANSWERS_COPY as W } from '../dashboard/vocabulary.ts';
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
 * Retries persist bounded content-free reason codes and settle after eight attempts; never exception text.
 */
import { TIER_LEDGER_IDENTITY_FIELDS } from '../classification/tier-ledger.ts';
import { lstatSync } from 'node:fs';
import { answerReleaseWithheldReason, type ReleaseCheck } from '../../core/release-manifest.ts';
import { randomBytes } from 'node:crypto';
import { CHATGPT_INBOX_GRACE_MS, WAITING_QUESTION_RETRY_REASONS, type WaitingQuestionRetryReason, type StoredPrivateAnswer, type WaitingQuestion, type WaitingQuestionRef, type WaitingQuestionStore } from '../../core/waiting-private-questions.ts';
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
  localAnswerRequest,
  checkLocalEvidenceItems,
  readLocalEvidenceItem,
  type LocalAnswerRequest,
  type LocalAnswerResult,
} from '../source-index/local-answer.ts';

export const LOCAL_AGENT_INBOX_ID = '@local:agents';
export function anonymousInboxConnectionId(caller?: { connection_id?: string; display_name?: string }) {
  return caller?.connection_id ?? LOCAL_AGENT_INBOX_ID;
}
export function localInboxLabel(id: string): string | undefined {
  return id === '@local:You' ? 'You' : id === LOCAL_AGENT_INBOX_ID ? 'Local agent' : id.startsWith('@local:') ? `Local agent: ${id.slice(7)}` : undefined;
}

export const LOCAL_PRIVATE_ANSWERS_PATH = '/dashboard/private-answers';
const TOKEN_TTL_MS = 30 * 60_000;
/**
 * How long an automatic answer defers to privacy classification. Beyond it the
 * sniffer stops at its next question (overdue()): on a fresh install its
 * backlog outlasts any reasonable wait (release check 2026-10-29: queued past 10 min).
 */
export const AUTO_ANSWER_DEFER_MS = 60_000;
const MAX_TOKENS = 400;
const MAX_QUESTION_CHARS = 2_000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,64}$/;

/** One waiting question as the page lists it. Only to a local control session. */
export interface WaitingQuestionView {
  path?: 'private' | 'anonymous' | 'venice';
  id: string;
  question: string;
  /** Who asked: the connection's name ("ChatGPT", "Grok Bot"). */
  from: string;
  askedAt: string;
  /** The local probe could not tell yet whether Private items match. */
  unchecked: boolean;
  state: 'answering' | 'retrying' | 'answered' | 'unchecked' | 'queued' | 'changed' | 'failed';
  unread: boolean;
  answeredAt?: string;
  failureReason?: WaitingQuestionRetryReason;
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
  panelSecretNotice?: (ref: WaitingQuestionRef) => boolean;
  resolveSecretInbox?: (handle: string) => WaitingQuestionRef | undefined;
  secretSources?: (input: LocalAnswerRequest, locations: readonly import('../../core/evidence-pack.ts').SavedSecretLocation[]) => PrivateAnswerSourceCitation[];
  /** The computer's own ask identity; omitted by read-only/test adapters. */
  localConnectionId?: string;
  anonymousAsk?: (input: import('../../core/consult-ask.ts').ConsultAskInput) => Promise<import('../../core/consult-ask.ts').ConsultAskResult>;
  destinations?: () => import('./venice-inbox-answer.ts').AskDestinationStates;
  veniceAnswer?: (input: LocalAnswerRequest) => Promise<LocalAnswerResult>;
  answer: (input: LocalAnswerRequest) => Promise<LocalAnswerResult>;
  store: () => Pick<WaitingQuestionStore, 'list' | 'get' | 'dismiss' | 'dismissAll' | 'acknowledge'> & Partial<WaitingQuestionStore> | undefined;
  /** A connection's display name, by id; undefined when unknown. */
  connectionName?: (connectionId: string) => string | undefined;
  /** The live eligibility guard, re-asked before a cited file opens. */
  eligible?: (items: readonly PrivateEvidenceItem[]) => Promise<readonly boolean[]>;
  eligibleSecrets?: (input: LocalAnswerRequest, locations: readonly import('../../core/evidence-pack.ts').SavedSecretLocation[]) => boolean;
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
  destinations(): import('./venice-inbox-answer.ts').AskDestinationStates;
  waiting(): { questions: WaitingQuestionView[]; olderRemoved: boolean } | undefined;
  /** How many questions wait, for the computer's Needs you line; 0 when unknown. */
  waitingCount(): number;
  /** One page action, by the local control session `session`. */
  start(): void;
  tick(): Promise<void>;
  /**
   * An automatic answer has waited long enough that privacy classification
   * should stop at its next question and let it run.
   */
  overdue(): boolean;
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
  eligibleSecrets: (input: LocalAnswerRequest, locations: readonly import('../../core/evidence-pack.ts').SavedSecretLocation[]) => boolean;
  secretSources: NonNullable<LocalPrivateAnswersOptions['secretSources']>;
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
    secretSources: (input, locations) => {
      const current = lanes(localAnswerRequest(input.question, input.selectors));
      if (current.checkSecretLocations?.(locations) !== true) return [];
      const matches = current.secretLocations?.(input.question, current.registry.list().map(c => c.corpusId)) ?? [];
      return matches.filter(location => locations.some(saved => saved.source === location.source && saved.ref === location.ref)).map(location => {
        const links = location.locator ? options.sourceLinks?.({ provenance: { sourceItem: { provider: location.source }, citation: { uri: location.locator } } }) : undefined;
        return { title: location.title ?? location.locator ?? 'Secret', source: location.source, ...links };
      });
    },
    eligibleSecrets: (input, locations) => {
      if (!locations.length) return true;
      const current = lanes(localAnswerRequest(input.question, input.selectors));
      return current.checkSecretLocations?.(locations) === true;
    },
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
  let runningDestination: 'computer' | 'venice' = 'computer';
  let closed = false;
  let pass: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let unsubscribe: (() => void) | undefined;
  const abort = new AbortController();
  // An automatic answer in progress: classification keeps yielding between its model calls.
  let autoAnswering = false;
  const store = () => { try { return options.store(); } catch { return undefined; } };
  const refOf = (q: WaitingQuestion): WaitingQuestionRef => ({ id: q.id, generation: q.generation, connectionId: q.connectionId });
  const active = (q: WaitingQuestion) => {
    try { return !closed && (!options.isActive || options.isActive(q.connectionId)); } catch { return false; }
  };
  const hidden = (q: WaitingQuestion) => q.surface === 'chatgpt' && options.panelSecretNotice?.(refOf(q)) !== true && (
    now() < Date.parse(q.askedAt) + CHATGPT_INBOX_GRACE_MS || options.panelClaimed?.(refOf(q)) === true
  );
  const autoAnswerable = (q: WaitingQuestion) => q.path !== 'anonymous' && q.path !== 'venice' && !q.hasResult && !q.result
    && q.state === 'waiting' && q.nextAttemptAt <= now() && !hidden(q) && active(q);
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
  const failureReason = (q: WaitingQuestion | undefined): { failureReason?: WaitingQuestionRetryReason } => {
    if (!q || !(q.failed || q.result?.status === 'failed')) return {};
    const reason = q.retryReasons?.at(-1);
    return reason && WAITING_QUESTION_RETRY_REASONS.includes(reason) ? { failureReason: reason } : {};
  };
  const answerBody = (result: LocalAnswerResult | StoredPrivateAnswer, session: string, q?: WaitingQuestion): Record<string, unknown> => {
    if (result.status === 'withdrawn') return { status: 'withdrawn', sent_items: result.sentItems, reason: result.reason };
    if (result.status !== 'answered') return { status: result.status, ...(result.status === 'failed' ? failureReason(q) : {}), ...('leftOut' in result ? { left_out: result.leftOut } : {}) };
    sweep();
    const secretSources = q && result.secretLocations?.length
      ? options.secretSources?.({ question: q.question, selectors: q.selectors }, result.secretLocations) ?? [] : [];
    const citations: LocalCitationView[] = [...result.citations, ...secretSources].map(citation => {
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
    return { status: 'answered', answer: result.answer, citations, ...('sentItems' in result && result.sentItems ? { sent_items: result.sentItems } : {}), unanswered: result.unanswered, left_out: result.leftOut };
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
      if (closed || running || options.interactiveBusy?.() || options.backgroundBusy?.()) return Promise.resolve();
      pass = (async () => {
        const currentStore = store();
        if (!currentStore) return;
        if (options.isActive) currentStore.reconcileConnections?.(options.isActive);
        // Oldest first avoids starving a retry behind a busy connection.
        for (const q of [...currentStore.list({ includeResults: false }).questions].reverse()) {
          if (closed || running || options.interactiveBusy?.() || options.backgroundBusy?.()) break;
          if (!autoAnswerable(q)) continue;
          // No allowance per connection (Jamie, 2026-10-29): every question an agent asks is answered.
          autoAnswering = true;
          const result = await answerFor({ question: q.question, selectors: q.selectors, detail: q.detail, signal: abort.signal }, true)
            .finally(() => { autoAnswering = false; });
          if (!current(q)) continue;
          let check = result.status === 'answered' ? await eligible(result.read) : undefined;
          if (result.status === 'answered' && (result.secretLocations?.length ?? 0) > 0 && options.eligibleSecrets?.({ question: q.question, selectors: q.selectors }, result.secretLocations!) !== true) check = 'ineligible';
          if ((result.status === 'answered' && check === 'eligible') || result.status === 'not_found') {
            if (!current(q)) continue;
            const saved: StoredPrivateAnswer = result.status === 'answered'
              ? { status: 'answered', answer: result.answer, citations: result.citations.map(c => ({ ...(c.title ? { title: c.title } : {}), ...(c.source ? { source: c.source } : {}), ...(c.date ? { date: c.date } : {}), ...(c.url ? { url: c.url } : {}), ...(c.localPath ? { localPath: c.localPath } : {}) })), ...(result.sentItems ? { sentItems: result.sentItems } : {}), unanswered: result.unanswered, leftOut: result.leftOut, read: result.read.map(inboxEvidenceIdentity), secretLocations: result.secretLocations ?? [] }
              : { status: 'not_found', citations: [], unanswered: [], leftOut: result.leftOut, read: [] };
            if (!currentStore.saveAnswer?.(refOf(q), saved)) currentStore.retry?.(refOf(q), 'save_refused');
          } else currentStore.retry?.(refOf(q), check === 'unknown' ? 'eligibility_unavailable'
            : check === 'ineligible' || result.status === 'changed' ? 'evidence_changed'
            : result.status === 'no_model' || result.status === 'model_downloading' ? result.status : 'answer_failed');
        }
      })().catch(() => undefined).finally(() => { pass = undefined; });
      return pass;
    },
    overdue() {
      if (closed) return false;
      if (autoAnswering) return true;
      try {
        const questions = store()?.list({ includeResults: false }).questions ?? [];
        return questions.some(q => autoAnswerable(q)
          && now() - Date.parse(q.askedAt) >= AUTO_ANSWER_DEFER_MS);
      } catch { return false; }
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
        return { questions: listed.questions.filter(q => active(q) && !hidden(q) && (q.path !== 'anonymous' || q.hasResult || q.result)).map(q => ({
          id: q.id, path: q.path ?? 'private', question: q.question, from: options.connectionName?.(q.connectionId)?.trim() || (q.surface === 'chatgpt' ? 'ChatGPT' : 'An agent'),
          askedAt: q.askedAt, unchecked: q.state === 'unchecked', unread: !q.seen, ...failureReason(q),
          state: q.failed || q.result?.status === 'failed' ? 'failed' : q.hasResult || q.result ? 'answered' : q.path === 'venice' && q.answeredAt ? 'changed' : q.state === 'unchecked' ? 'unchecked' : q.attempts > 0 ? 'retrying' : q.nextAttemptAt > now() || options.backgroundBusy?.() ? 'queued' : 'answering',
          ...(q.answeredAt ? { answeredAt: q.answeredAt } : {}),
        })), olderRemoved: listed.olderRemoved };
      } catch { return undefined; }
    },
    destinations() { const states = options.destinations?.() ?? { computer: 'ready' as const, venice: 'not_set_up' as const }; return running ? { ...states, [runningDestination]: 'busy' as const } : states; },
    waitingCount() { return api.waiting()?.questions.filter(q => q.unread && (q.state === 'answered' || q.state === 'failed')).length ?? 0; },
    async handle(body, session) {
      const action = body.action;
      if (action === 'resolve_secret') {
        const ref = typeof body.handle === 'string' ? options.resolveSecretInbox?.(body.handle) : undefined;
        const q = ref ? store()?.get(ref.id) : undefined;
        if (!ref || !q || q.generation !== ref.generation || q.connectionId !== ref.connectionId || !current(q)) return refused(410, 'gone', 'Open Olympus on your computer, then Inbox');
        return { status: 200, body: { ok: true, id: q.id } };
      }
      if (action === 'list') return { status: 200, body: { ok: true, ...api.waiting(), destinations: api.destinations() } };
      if (action === 'ask_anonymous') {
        if (!options.anonymousAsk) return refused(503, 'unavailable', W.anonymousNotSetUp);
        // Strict or Standard for this question (owner, 2026-10-24); absent: the saved setting.
        if (body.level !== undefined && body.level !== 'strict' && body.level !== 'standard') return refused(400, 'invalid_params', W.levelInvalid);
        const result = await options.anonymousAsk({ question: typeof body.question === 'string' ? body.question : '', ...(body.level !== undefined ? { level: body.level } : {}) });
        return result.ok
          ? { status: 200, body: { ok: true, status: 'answered', answer: result.reply, sent: result.sent, citations: [] } }
          : refused(400, result.code, result.message);
      }
      if (action === 'ask' || action === 'ask_venice') {
        const venice = action === 'ask_venice';
        if (running) return refused(429, 'busy', W.destinationBusy);
        if (venice && (!options.veniceAnswer || api.destinations().venice !== 'ready')) return refused(403, 'venice_not_allowed', api.destinations().venice === 'not_set_up' ? W.veniceNotSetUp : W.veniceNotAllowed);
        const question = typeof body.question === 'string' ? body.question.trim() : '';
        if (!question || question.length > MAX_QUESTION_CHARS) return refused(400, 'invalid_params', W.emptyQuestion);
        running = true;
        runningDestination = venice ? 'venice' : 'computer';
        try {
          const currentStore = store();
          const ticket = options.localConnectionId && currentStore?.ticket?.(options.localConnectionId);
          const ref = ticket && currentStore?.record?.(ticket, { question, ...(venice ? { path: 'venice' as const } : {}), surface: 'remote', state: 'waiting', retainEachAsk: true, detail: body.detail === 'full' ? 'full' : 'summary' });
          if (options.localConnectionId && !ref) {
            if (ref) currentStore?.acknowledge(ref);
            return refused(429, 'unavailable', W.inboxUnavailable);
          }
          let retained = false;
          try {
            const request = { question, stillAuthorized: () => !closed && (!ref || !!currentStore?.get(ref.id) && currentStore.get(ref.id)?.generation === ref.generation), detail: body.detail === 'full' ? 'full' as const : 'summary' as const };
            let result: LocalAnswerResult;
            try { result = venice ? await options.veniceAnswer!(request) : await answerFor(request); } catch { result = { status: 'failed' }; }
            if (result.status === 'answered') {
              const check = await eligible(result.read);
              if (check !== 'eligible' || (!venice && (result.secretLocations?.length ?? 0) > 0 && options.eligibleSecrets?.(request, result.secretLocations!) !== true)) {
                if (venice && result.sentItems) result = { status: 'withdrawn', sentItems: result.sentItems, reason: check === 'unknown' ? 'Sent to Venice, but source eligibility could not be checked. No answer was kept.' : 'Sent to Venice, but the sources changed. No answer was kept.' };
                else return { status: 200, body: { ok: true, status: check === 'unknown' ? 'check_unavailable' : 'changed' } };
              }
            }
            if (ref && (result.status === 'answered' || result.status === 'not_found' || result.status === 'withdrawn')) {
              retained = currentStore?.saveAnswer?.(ref, result.status === 'answered'
                ? { status: 'answered', answer: result.answer, citations: result.citations.map(c => ({ ...(c.title ? { title: c.title } : {}), ...(c.source ? { source: c.source } : {}), ...(c.date ? { date: c.date } : {}), ...(c.url ? { url: c.url } : {}), ...(c.localPath ? { localPath: c.localPath } : {}) })), ...(result.sentItems ? { sentItems: result.sentItems } : {}), unanswered: result.unanswered, leftOut: result.leftOut, read: result.read.map(inboxEvidenceIdentity), ...(!venice ? { secretLocations: result.secretLocations ?? [] } : {}) }
                : result.status === 'withdrawn' ? { ...result, citations: [], unanswered: [], leftOut: [], read: [] } : { status: 'not_found', citations: [], unanswered: [], leftOut: result.leftOut, read: [] }) === true;
            }
            if (ref && !retained && (result.status === 'answered' || result.status === 'not_found' || result.status === 'withdrawn')) return refused(410, 'gone', W.deleted);
            return { status: 200, body: { ok: true, ...answerBody(result, session, ref ? currentStore?.get(ref.id) : undefined) } };
          } finally { if (ref && !retained) currentStore?.acknowledge(ref); }
        } finally { running = false; }
      }
      if (action === 'read') {
        const q = typeof body.id === 'string' ? store()?.get(body.id) : undefined;
        if (!q || !current(q)) return refused(410, 'gone', 'That answer was deleted');
        if (!q.result) return { status: 200, body: { ok: true, status: q.path === 'venice' && q.answeredAt ? 'changed' : q.state === 'unchecked' ? 'unchecked' : q.attempts ? 'retrying' : q.nextAttemptAt > now() || options.backgroundBusy?.() ? 'queued' : 'answering' } };
        if (q.result.status === 'withdrawn' || q.result.status === 'failed') return { status: 200, body: { ok: true, generation: q.generation, ...answerBody(q.result, session, q) } };
        const check = await eligible(q.result.read);
        if (check === 'unknown') return { status: 200, body: { ok: true, status: 'check_unavailable' } };
        const secretCheck = q.result.status !== 'answered' || q.path === 'venice' || q.path === 'anonymous'
          || (q.result.secretLocations !== undefined && (q.result.secretLocations.length === 0 || options.eligibleSecrets?.({ question: q.question, selectors: q.selectors }, q.result.secretLocations) === true));
        if (check === 'ineligible' || !secretCheck || !current(q)) {
          invalidate(q);
          const fresh = store()?.get(q.id);
          const withdrawn = fresh?.result;
          return { status: 200, body: { ok: true, ...(withdrawn?.status === 'withdrawn' ? { generation: fresh!.generation, ...answerBody(withdrawn, session) } : { status: q.path === 'venice' ? 'changed' : 'answering' }) } };
        }
        return { status: 200, body: { ok: true, generation: q.generation, ...answerBody(q.result, session, q), ...(q.path === 'anonymous' ? { sent: q.question } : {}) } };
      }
      if (action === 'seen') {
        const q = typeof body.id === 'string' ? store()?.get(body.id) : undefined;
        const marked = !!q && q.generation === body.generation && !!current(q) && store()?.markRead?.(refOf(q)) === true;
        return { status: 200, body: { ok: true, status: marked ? 'read' : 'kept' } };
      }
      if (action === 'delete' || action === 'delete_all') {
        // Success only for what was removed: a store that cannot be opened, or an answer it does not hold, is
        // said as such, so the page never shows a deletion that did not happen.
        const answers = store();
        if (!answers) return refused(503, 'unavailable', W.deleteUnavailable);
        try {
          const removed = action === 'delete_all' ? answers.dismissAll() : typeof body.id === 'string' && answers.dismiss(body.id) ? 1 : 0;
          // Tokens minted from an answer that was deleted cannot outlive its row.
          if (action === 'delete_all') opens.clear();
          else for (const [id, entry] of opens) if (entry.ref?.id === body.id) opens.delete(id);
          if (action === 'delete' && removed === 0) return refused(410, 'not_found', W.deleteNotFound);
          return { status: 200, body: { ok: true, status: 'deleted', removed } };
        } catch { return refused(503, 'unavailable', W.deleteUnavailable); }
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
            if (q.result.secretLocations?.length && options.eligibleSecrets?.({ question: q.question, selectors: q.selectors }, q.result.secretLocations) !== true) return false;
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
            if (q.result.secretLocations?.length && options.eligibleSecrets?.({ question: q.question, selectors: q.selectors }, q.result.secretLocations) !== true) return false;
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

/** Only the local inbox receives this copy. Sealed ChatGPT panels bypass it.
 * Reserve before sending: delete/revoke during the paid call cannot resurrect a row.
 * Anonymous questions have no retrieval context, source identities or citations. */
export async function askWithAnonymousInbox(
  input: import('../../core/consult-ask.ts').ConsultAskInput,
  options: { deliveredToPanel?: boolean; isActive?: (id: string) => boolean; store: () => WaitingQuestionStore | undefined; connectionId: string; ask: (input: import('../../core/consult-ask.ts').ConsultAskInput) => Promise<import('../../core/consult-ask.ts').ConsultAskResult> },
): Promise<import('../../core/consult-ask.ts').ConsultAskResult> {
  if (options.deliveredToPanel) return options.ask(input);
  if (typeof input.question !== 'string' || !input.question.trim()) return { ok: false, code: 'transport_unavailable', message: 'Type a question first.' };
  const store = options.store();
  const ref = store?.record(store.ticket(options.connectionId), { question: W.anonymousPending, surface: 'remote', state: 'waiting', path: 'anonymous' });
  if (!store || !ref) return { ok: false, code: 'transport_unavailable', message: W.inboxBeforeSend };
  const acknowledge = () => { try { store.acknowledge(ref); } catch { /* Closed/deleted store: never restore the row. */ } };
  try {
    const result = await options.ask({ ...input, stillAuthorized: () => {
      try {
        const current = store.get(ref.id);
        return !!current && current.generation === ref.generation && current.connectionId === ref.connectionId && options.isActive?.(ref.connectionId) !== false && input.stillAuthorized?.() !== false;
      } catch { return false; }
    } });
    if (result.ok) {
      if (!store.saveAnswer(ref, { status: 'answered', answer: result.reply, citations: [], unanswered: [], leftOut: [], read: [] }, result.sent)) acknowledge();
    }
    else acknowledge();
    return result;
  } catch {
    acknowledge();
    return { ok: false, code: 'transport_unavailable', message: W.anonymousFailed };
  }
}
