/**
 * What each AI app received (#1061): the record of one request an AI app or
 * agent made, taken at the point its result leaves the worker.
 *
 * The output builders (workers/chatgpt/response-builder.ts searchToolResult
 * and answerToolResult, core/remote-result.ts sourceAnswerOutput) note the
 * items they actually put in a result into the current capture, the same way
 * an answer's release manifest travels (core/release-manifest.ts): the exit
 * opens a capture for one call, and the builders write into it. A builder
 * called outside a capture notes nothing. The last note wins, because an exit
 * may build its result twice (a release checked again after a wait).
 *
 * Names and titles only, never item text: a noted item is its source label,
 * its title as released, its tier at release and the identifiers the
 * "This should be Private" control needs to find it again on this computer.
 *
 * The record is handed to the recorder the worker installs
 * (workers/apps-received.ts), which keeps it in an owner-only SQLite file and
 * serves it to the local dashboard only. Recording never changes or fails a
 * response: every error is swallowed here.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { OperationCaller } from './operation-caller.ts';

export type ReleasedTier = 'public' | 'personal' | 'private';

/** One item a result carried, by name. */
export interface ReleasedItem {
  /** The product's name for its source (Gmail, Dropbox, Files). */
  source: string;
  /** The title as it was released, when there was one. */
  title?: string;
  tier: ReleasedTier;
  corpusId?: string;
  provider?: string;
  providerItemId?: string;
  providerConversationId?: string;
  /** The item's locator or link as the answer cited it: the per-item correction finds the item by it. */
  locator?: string;
}

export interface ReleaseCapture {
  /** Undefined until a builder notes a result. */
  items?: ReleasedItem[];
  /** Private items the result held back (or that only the computer answered from). */
  heldBack: number;
  /** The result was withheld whole under the owner's privacy rules. */
  withheld?: boolean;
  /**
   * The waiting private question this request left on the computer
   * (core/waiting-private-questions.ts), when Private items matched. Only its
   * completion (notePrivateAnswerCompleted) says the question was answered
   * privately: the completion of this generation, never an earlier one.
   */
  privateQuestion?: PrivateQuestionRef;
}

/**
 * A waiting private question at one generation. Asked again, a question keeps
 * its id and moves to a new generation, so an answer completes only the
 * generation it was made for.
 */
export interface PrivateQuestionRef {
  readonly id: string;
  readonly generation: number;
}

/** The stored key of a waiting question at one generation; undefined for anything else. */
export function privateQuestionKey(ref: unknown): string | undefined {
  if (!ref || typeof ref !== 'object') return undefined;
  const { id, generation } = ref as { id?: unknown; generation?: unknown };
  if (typeof id !== 'string' || !id || id.length > 128) return undefined;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 1) return undefined;
  return `${id}#${generation}`;
}

export interface AppConnection {
  id?: string;
  /** ChatGPT, Claude, Grok, or the agent's own name. */
  name: string;
  kind: 'app' | 'agent';
}

export interface AppRequestRecord {
  at: number;
  connection: AppConnection;
  question: string;
  items: readonly ReleasedItem[];
  heldBack: number;
  /**
   * The question was answered on this computer from Private items; the app got
   * only a note. True only once that answer completed, never from a match alone.
   */
  answeredPrivately: boolean;
  withheld: boolean;
  /** The waiting private question, at its generation (privateQuestionKey), whose completion marks the request answered privately. */
  privateQuestionKey?: string;
}

const storage = new AsyncLocalStorage<ReleaseCapture>();

export function createReleaseCapture(): ReleaseCapture {
  return { heldBack: 0 };
}

export function runWithReleaseCapture<T>(capture: ReleaseCapture, fn: () => T): T {
  return storage.run(capture, fn);
}

/** Notes what a result carries (replacing an earlier note in this call). A no-op outside a capture. */
export function noteReleasedItems(items: readonly ReleasedItem[], heldBack = 0, withheld = false): void {
  const capture = storage.getStore();
  if (!capture) return;
  capture.items = items.map((item) => ({ ...item }));
  capture.heldBack = Math.max(0, Math.floor(Number.isFinite(heldBack) ? heldBack : 0));
  capture.withheld = withheld;
}

const TITLE_MAX = 300;
const ID_MAX = 512;

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

/** The tier an item was released at, from its evidence's trust domain. */
export function releasedTierOf(trustDomain: unknown): ReleasedTier {
  if (trustDomain === 'public_safe') return 'public';
  if (trustDomain === 'internal') return 'personal';
  return 'private';
}

/** A released item from one raw evidence record and the label and title the result showed. */
export function releasedItemFromEvidence(evidence: Record<string, unknown>, source: string, title?: string): ReleasedItem {
  const shownTitle = boundedString(title, TITLE_MAX);
  const corpusId = boundedString(evidence.corpus_id, ID_MAX);
  const provider = boundedString(evidence.provider, ID_MAX);
  const providerItemId = boundedString(evidence.provider_item_id, ID_MAX);
  const providerConversationId = boundedString(evidence.provider_conversation_id, ID_MAX);
  const locator = boundedString(evidence.uri, ID_MAX);
  return {
    source: boundedString(source, 80) ?? 'Other source',
    ...(shownTitle ? { title: shownTitle } : {}),
    tier: releasedTierOf(evidence.trust_domain),
    ...(corpusId ? { corpusId } : {}),
    ...(provider ? { provider } : {}),
    ...(providerItemId ? { providerItemId } : {}),
    ...(providerConversationId ? { providerConversationId } : {}),
    ...(locator ? { locator } : {}),
  };
}

const PROVIDER_APP_NAMES: Readonly<Record<string, string>> = {
  openai: 'ChatGPT',
  anthropic: 'Claude',
  xai: 'Grok',
  meta: 'Meta AI',
};

/**
 * Who asked, in the owner's words. A remote connection is named by the app
 * that hosts it when Olympus knows it, else by the name the owner approved;
 * an agent on this computer by its own name. The owner's own command line is
 * not an AI app and records nothing (undefined).
 */
export function appConnectionOf(caller: OperationCaller | undefined): AppConnection | undefined {
  if (!caller || caller.surface === 'cli') return undefined;
  const display = boundedString(caller.displayName, 80);
  const id = boundedString(caller.connectionId, 128);
  if (caller.surface === 'remote') {
    const known = caller.provider ? PROVIDER_APP_NAMES[caller.provider] : undefined;
    return { ...(id ? { id } : {}), name: known ?? display ?? 'An AI app', kind: 'app' };
  }
  return { ...(id ? { id } : {}), name: display ?? 'An agent', kind: 'agent' };
}

type Recorder = (record: AppRequestRecord) => void;
let recorder: Recorder | undefined;
let completionHook: ((privateQuestionKey: string) => void) | undefined;

// Private answers completed recently, in memory only: a fast answer can finish
// before its request's result leaves, so the record reads it here.
const COMPLETED_MAX = 512;
const completedPrivateAnswers = new Set<string>();

/** The worker installs the store's hook that marks a recorded request answered privately. */
export function setPrivateAnswerCompletionHook(next: ((privateQuestionKey: string) => void) | undefined): void {
  completionHook = next;
}

/**
 * A waiting private question was answered on this computer (the panel's
 * analysis finished, or the local inbox saved an answer), at the generation
 * the answer was made for. Never throws.
 */
export function notePrivateAnswerCompleted(ref: PrivateQuestionRef | undefined): void {
  try {
    const key = privateQuestionKey(ref);
    if (!key) return;
    completedPrivateAnswers.add(key);
    while (completedPrivateAnswers.size > COMPLETED_MAX) completedPrivateAnswers.delete(completedPrivateAnswers.values().next().value!);
    completionHook?.(key);
  } catch {
    // Never changes an answer.
  }
}

/** Notes, in the current capture, the waiting private question (at its generation) a request left on the computer. */
export function notePrivateQuestion(ref: PrivateQuestionRef | undefined): void {
  const capture = storage.getStore();
  if (capture && ref && privateQuestionKey(ref)) capture.privateQuestion = { id: ref.id, generation: ref.generation };
}

/** The worker installs the store's recorder; undefined removes it (tests, shutdown). */
export function setAppReleaseRecorder(next: Recorder | undefined): void {
  recorder = next;
}

/**
 * Records one request from a capture. Nothing without a recorder, a
 * connection, a question or a noted result; never throws.
 */
export function recordAppRequest(input: {
  caller: OperationCaller | undefined;
  question: string | undefined;
  capture: ReleaseCapture;
  /** The waiting private question (at its generation) the request left on the computer, if any (else the capture's). */
  privateQuestion?: PrivateQuestionRef | undefined;
  /** The exit replaced the noted result with a withheld one after the builders ran. */
  withheldAfter?: boolean;
  now?: () => number;
  /** Where the record goes when this process has no recorder installed (an agent's own process). */
  fallback?: Recorder;
}): void {
  try {
    const write = recorder ?? input.fallback;
    if (!write) return;
    const connection = appConnectionOf(input.caller);
    const question = boundedString(input.question, 2_000);
    if (!connection || !question || input.capture.items === undefined) return;
    const withheld = input.withheldAfter === true || input.capture.withheld === true;
    const privateQuestionKeyOf = privateQuestionKey(input.privateQuestion ?? input.capture.privateQuestion);
    write({
      at: (input.now ?? Date.now)(),
      connection,
      question,
      items: withheld ? [] : input.capture.items,
      heldBack: input.capture.heldBack + (withheld ? input.capture.items.length : 0),
      // A Private answer that finished before the result left is already known; a later one marks the row.
      // Only this generation's answer: the same question asked again is a new attempt.
      answeredPrivately: privateQuestionKeyOf !== undefined && completedPrivateAnswers.has(privateQuestionKeyOf),
      withheld,
      ...(privateQuestionKeyOf ? { privateQuestionKey: privateQuestionKeyOf } : {}),
    });
  } catch {
    // A log that cannot be written never changes what an app gets.
  }
}

// A handed-off answer is collected by job id, without its question: the
// question is kept here, in memory only, until the result is collected.
const JOB_QUESTIONS_MAX = 256;
const JOB_QUESTION_TTL_MS = 30 * 60_000;
const jobQuestions = new Map<string, { question: string; expires: number }>();

export function rememberJobQuestion(jobId: unknown, question: unknown, now = Date.now()): void {
  if (typeof jobId !== 'string' || typeof question !== 'string' || !jobId || !question.trim()) return;
  for (const [key, entry] of jobQuestions) if (entry.expires <= now) jobQuestions.delete(key);
  jobQuestions.set(jobId, { question: question.trim().slice(0, 2_000), expires: now + JOB_QUESTION_TTL_MS });
  while (jobQuestions.size > JOB_QUESTIONS_MAX) jobQuestions.delete(jobQuestions.keys().next().value!);
}

/** The question a job was asked with, while its result is still being collected. */
export function jobQuestion(jobId: unknown, now = Date.now()): string | undefined {
  if (typeof jobId !== 'string') return undefined;
  const entry = jobQuestions.get(jobId);
  if (!entry || entry.expires <= now) return undefined;
  return entry.question;
}

/** Clear and Delete all forget the in-memory questions too. */
export function forgetJobQuestions(): void {
  jobQuestions.clear();
  completedPrivateAnswers.clear();
}

/**
 * The question of a source answer call: its own, or, for a collected job, the
 * one it was asked with. A call still working remembers its question.
 */
export function sourceAnswerQuestion(name: string, args: Record<string, unknown>, status: unknown, jobId: unknown): string | undefined {
  if (name === 'source_answer') {
    const question = typeof args.question === 'string' ? args.question : undefined;
    if (status === 'working') rememberJobQuestion(jobId, question);
    return question;
  }
  if (name === 'source_answer_result') return jobQuestion(args.job_id);
  return undefined;
}

/**
 * Records a remote operation's output as it leaves for an agent (the remote
 * MCP and OpenAPI surfaces, which build it with core/remote-result.ts). Only a
 * source answer that answered or was withheld; a job still working remembers
 * its question for the call that collects it.
 */
export function recordRemoteOperation(input: {
  operation: string;
  args: Record<string, unknown>;
  caller: OperationCaller | undefined;
  output: Record<string, unknown>;
  capture: ReleaseCapture;
  /** The waiting private question, at its generation, the call left on the computer (core/remote-private-part.ts answerRef), if any. */
  privateQuestion: PrivateQuestionRef | undefined;
}): void {
  const { operation, args, output } = input;
  if (operation !== 'source_answer' && operation !== 'source_answer_result') return;
  const question = sourceAnswerQuestion(operation, args, output.status, output.job_id);
  if (output.kind !== 'source_answer' || (output.status !== 'answered' && output.status !== 'withheld')) return;
  recordAppRequest({
    caller: input.caller,
    question,
    capture: input.privateQuestion ? { ...input.capture, heldBack: Math.max(1, input.capture.heldBack) } : input.capture,
    privateQuestion: input.privateQuestion,
  });
}
