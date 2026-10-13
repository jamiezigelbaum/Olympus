/**
 * The Private answers page's actions on this computer (design
 * docs/design/background-agents.md, sections A and B, and "Dashboard
 * changes" 2): one POST route, /dashboard/private-answers, held to a local
 * control session at the HTTP boundary (workers/http.ts), never the worker
 * bearer, a dash_ reader, ChatGPT or the Gateway.
 *
 * Actions (`action` in the body):
 * - `ask` {question, detail?}: answers on this computer only
 *   (source-index/local-answer.ts). A question asked here is never recorded
 *   as a waiting question and never reaches anonymous outside help.
 * - `answer` {id}: answers one waiting question the same way, with its own
 *   stored selectors (never a wider search), and hands the page a single-use
 *   acknowledgment for that record at the generation it read.
 * - `seen` {ack}: the page rendered the answer; the record is deleted only if
 *   it is still at that generation (a newer ask of the same question stays).
 * - `dismiss` {id}, `dismiss_all`.
 * - `open` {token}: opens a cited file on this computer. The token was minted
 *   for this session with the answer; the path stays here. Every item the
 *   answer read is re-checked first.
 *
 * Tokens (acknowledgments and opens) live in memory, are bound to the control
 * session that received them, are spent once (opens: reusable until expiry,
 * like the panel's) and expire after 30 minutes. A restart forgets them: the
 * question then simply stays waiting.
 *
 * Plain closures, no class: this module is reachable from the bundled CLI
 * graph through the worker, and class-field initializers balloon dist/.
 */
import { lstatSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { WaitingQuestion, WaitingQuestionRef, WaitingQuestionStore } from '../../core/waiting-private-questions.ts';
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
}

/** A citation as the page gets it: never a path; a local file opens by token. */
export interface LocalCitationView {
  title?: string;
  source?: string;
  date?: string;
  url?: string;
  open?: string;
}

export interface LocalPrivateAnswersOptions {
  answer: (input: LocalAnswerRequest) => Promise<LocalAnswerResult>;
  store: () => Pick<WaitingQuestionStore, 'list' | 'get' | 'dismiss' | 'dismissAll' | 'acknowledge'> | undefined;
  /** A connection's display name, by id; undefined when unknown. */
  connectionName?: (connectionId: string) => string | undefined;
  /** The live eligibility guard, re-asked before a cited file opens. */
  eligible?: (items: readonly PrivateEvidenceItem[]) => Promise<readonly boolean[]>;
  /** Opens a local file (macOS `open`, checked by the caller). Absent: local files do not open. */
  openFile?: (path: string, eligible: () => Promise<boolean>) => Promise<void>;
  now?: () => number;
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
  handle(body: Readonly<Record<string, unknown>>, session: string): Promise<LocalPrivateAnswersResponse>;
}

interface AckEntry {
  session: string;
  ref: WaitingQuestionRef;
  expiresAt: number;
}

interface OpenEntry {
  session: string;
  path: string;
  read: readonly PrivateEvidenceItem[];
  expiresAt: number;
}

export interface LocalAnswerPathOptions {
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
 * The answer path behind Ask privately and Answer, as the worker wires it:
 * the shared lanes narrowed to this computer's built-in embedding model, the
 * live eligibility guard over those lanes, and the built-in private model.
 */
export function createLocalAnswerPath(options: LocalAnswerPathOptions): {
  eligible: (items: readonly PrivateEvidenceItem[]) => Promise<readonly boolean[]>;
  answer: (input: LocalAnswerRequest) => Promise<LocalAnswerResult>;
} {
  const lanes = (request: SourceIndexAnswerRequest) => options.lanes(request, 'built_in_only');
  const eligible = (items: readonly PrivateEvidenceItem[]) => checkLocalEvidenceItems({ lanes, items });
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

export function createLocalPrivateAnswers(options: LocalPrivateAnswersOptions): LocalPrivateAnswers {
  const now = options.now ?? Date.now;
  const acks = new Map<string, AckEntry>();
  const opens = new Map<string, OpenEntry>();
  let running = false;

  const sweep = () => {
    const at = now();
    for (const map of [acks, opens] as Array<Map<string, { expiresAt: number }>>) {
      for (const [key, entry] of map) if (entry.expiresAt <= at) map.delete(key);
      while (map.size > MAX_TOKENS) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    }
  };

  const token = () => randomBytes(24).toString('base64url');

  const nameOf = (question: WaitingQuestion): string => {
    let name: string | undefined;
    try {
      name = options.connectionName?.(question.connectionId)?.trim();
    } catch {
      name = undefined;
    }
    return name || (question.surface === 'chatgpt' ? 'ChatGPT' : 'An agent');
  };

  const store = () => {
    try {
      return options.store();
    } catch {
      return undefined;
    }
  };

  /** The answer as the page gets it: citations without paths, local files by session-bound token. */
  const answerBody = (result: LocalAnswerResult, session: string): Record<string, unknown> => {
    if (result.status !== 'answered') {
      return {
        status: result.status,
        ...(result.status === 'not_found' ? { left_out: result.leftOut } : {}),
        ...(result.status === 'model_downloading' && result.percent !== undefined ? { percent: Math.round(result.percent) } : {}),
      };
    }
    sweep();
    const citations: LocalCitationView[] = result.citations.map((citation: PrivateAnswerSourceCitation) => {
      const view: LocalCitationView = {
        ...(citation.title ? { title: citation.title } : {}),
        ...(citation.source ? { source: citation.source } : {}),
        ...(citation.date ? { date: citation.date } : {}),
        ...(typeof citation.url === 'string' && /^https:\/\//.test(citation.url) ? { url: citation.url } : {}),
      };
      if (citation.localPath && options.openFile) {
        const id = token();
        opens.set(id, { session, path: citation.localPath, read: result.read, expiresAt: now() + TOKEN_TTL_MS });
        view.open = id;
      }
      return view;
    });
    return {
      status: 'answered',
      answer: result.answer,
      citations,
      unanswered: result.unanswered,
      left_out: result.leftOut,
    };
  };

  /** One answer at a time: the built-in model serves one question at once. */
  const exclusive = async (run: () => Promise<LocalPrivateAnswersResponse>): Promise<LocalPrivateAnswersResponse> => {
    if (running) return refused(429, 'busy', 'Olympus is answering another question. Try again in a moment.');
    running = true;
    try {
      return await run();
    } finally {
      running = false;
    }
  };

  const answerFor = async (input: LocalAnswerRequest): Promise<LocalAnswerResult> => {
    try {
      return await options.answer(input);
    } catch {
      return { status: 'failed' };
    }
  };

  return {
    waiting() {
      const current = store();
      if (!current) return undefined;
      try {
        const listed = current.list();
        return {
          questions: listed.questions.map((question) => ({
            id: question.id,
            question: question.question,
            from: nameOf(question),
            askedAt: question.askedAt,
            unchecked: question.state === 'unchecked',
          })),
          olderRemoved: listed.olderRemoved,
        };
      } catch {
        return undefined;
      }
    },

    waitingCount() {
      try {
        return store()?.list().questions.length ?? 0;
      } catch {
        return 0;
      }
    },

    async handle(body, session) {
      const action = body.action;
      if (action === 'ask') {
        const question = typeof body.question === 'string' ? body.question.trim() : '';
        if (!question || question.length > MAX_QUESTION_CHARS) return refused(400, 'invalid_params', 'Type a question first.');
        const detail = body.detail === 'full' ? 'full' : 'summary';
        return exclusive(async () => ({ status: 200, body: { ok: true, ...answerBody(await answerFor({ question, detail }), session) } }));
      }
      if (action === 'answer') {
        const id = typeof body.id === 'string' ? body.id : '';
        const current = store();
        if (!current) return refused(503, 'unavailable', 'Waiting questions cannot be read right now.');
        const record = id ? current.get(id) : undefined;
        if (!record) return refused(410, 'gone', 'This question is no longer waiting.');
        return exclusive(async () => {
          const result = await answerFor({ question: record.question, selectors: record.selectors, detail: record.detail });
          const out = answerBody(result, session);
          // Shown answers (and a plain "nothing here answers this") are what
          // the acknowledgment is for; anything else leaves the question waiting.
          if (result.status === 'answered' || result.status === 'not_found') {
            sweep();
            const ack = token();
            acks.set(ack, {
              session,
              ref: { id: record.id, generation: record.generation, connectionId: record.connectionId },
              expiresAt: now() + TOKEN_TTL_MS,
            });
            out.ack = ack;
          }
          return { status: 200, body: { ok: true, ...out } };
        });
      }
      if (action === 'seen') {
        sweep();
        const ack = typeof body.ack === 'string' && TOKEN_PATTERN.test(body.ack) ? body.ack : '';
        const entry = ack ? acks.get(ack) : undefined;
        if (!entry || entry.session !== session) return refused(410, 'gone', 'This answer can no longer be marked seen.');
        acks.delete(ack);
        let cleared = false;
        try {
          cleared = store()?.acknowledge(entry.ref) === true;
        } catch {
          cleared = false;
        }
        return { status: 200, body: { ok: true, status: cleared ? 'cleared' : 'kept' } };
      }
      if (action === 'dismiss') {
        const id = typeof body.id === 'string' ? body.id : '';
        let removed = false;
        try {
          removed = id ? store()?.dismiss(id) === true : false;
        } catch {
          return refused(503, 'unavailable', 'Waiting questions cannot be changed right now.');
        }
        return { status: 200, body: { ok: true, status: removed ? 'dismissed' : 'gone' } };
      }
      if (action === 'dismiss_all') {
        try {
          const removed = store()?.dismissAll() ?? 0;
          return { status: 200, body: { ok: true, status: 'dismissed', removed } };
        } catch {
          return refused(503, 'unavailable', 'Waiting questions cannot be changed right now.');
        }
      }
      if (action === 'open') {
        sweep();
        const id = typeof body.token === 'string' && TOKEN_PATTERN.test(body.token) ? body.token : '';
        const entry = id ? opens.get(id) : undefined;
        if (!entry || entry.session !== session || !options.openFile) return refused(410, 'gone', 'Ask again to open this file.');
        // The answer's sources open only while every item it read may still be read.
        let ok: readonly boolean[] = [];
        try {
          ok = options.eligible ? await options.eligible(entry.read) : entry.read.map(() => false);
        } catch {
          ok = [];
        }
        if (ok.length !== entry.read.length || !ok.every((value) => value === true)) {
          opens.delete(id);
          return refused(410, 'gone', 'This file changed since the answer. Ask again.');
        }
        let isFile = false;
        try {
          isFile = lstatSync(entry.path).isFile();
        } catch {
          isFile = false;
        }
        if (!isFile) return refused(410, 'gone', 'This file is no longer on this computer.');
        try {
          await options.openFile(entry.path, async () => {
            const current = options.eligible ? await options.eligible(entry.read) : [];
            sweep();
            return opens.get(id) === entry && current.length === entry.read.length && current.every(value => value === true);
          });
        } catch {
          return refused(500, 'failed', 'The file could not be opened.');
        }
        return { status: 200, body: { ok: true, status: 'opened' } };
      }
      return refused(400, 'invalid_params', 'Unknown action.');
    },
  };
}
