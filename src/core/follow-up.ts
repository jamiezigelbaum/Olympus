/**
 * Follow-up questions for a weak Ask (release 1.5, "Follow-up questions").
 *
 * When the first search finds nothing it can ground, the answer still
 * carries what was found, plus one question that offers the places the
 * search did see: `follow_up: { question, options: [{ label, narrow }] }`.
 * The assistant asks the owner and calls `source_answer` again with the
 * chosen option's `narrow`, which searches only inside that scope.
 *
 * Generic and deterministic, by construction:
 * - "Weak" reads counts the search already has: the Analyst's citation
 *   count, the reranker's best score and the stores' best relevance. Never
 *   the question's wording, never a model.
 * - The question and every label come only from candidates' metadata
 *   (source, conversation label, author label, year, counts): no item text,
 *   no model writes them, and the Analyst prompt is unchanged.
 * - A candidate's names appear only when they may be released beside the
 *   answer (the caller decides per item, by the same rule its citations
 *   follow); every label is secret-scanned and one line.
 * - `narrow` is an opaque handle minted here for filters `source_answer`
 *   already supports (corpus_ids, conversation_id, sender_label,
 *   authored_after/before). It carries no identifier, so it is safe on every
 *   surface; the engine turns it back into those filters.
 */
import { randomBytes } from 'node:crypto';
import { secretLabelsInText } from './opsec.ts';

export interface SourceAnswerFollowUpOption {
  /** One line from metadata only: source, conversation, author, years, count. */
  label: string;
  /** Opaque handle; pass it back unchanged as `source_answer.narrow`. */
  narrow: string;
}

export interface SourceAnswerFollowUp {
  question: string;
  options: SourceAnswerFollowUpOption[];
}

/** The filters one option narrows to, as `source_answer` names them. */
export interface SourceAnswerNarrowScope {
  corpus_ids?: string[];
  conversation_id?: string;
  sender_label?: string;
  authored_after?: string;
  authored_before?: string;
}

export interface FollowUpScopeOption {
  kind: 'conversation' | 'author' | 'source' | 'year';
  label: string;
  scope: SourceAnswerNarrowScope;
  /** Indexes into the candidates the option was built from. */
  members: number[];
}

/**
 * The bars below which a search counts as weak. Calibrated on the
 * 75-question passage eval (eval/run-passages.ts --narrow reports, per
 * question, whether the unnarrowed run would have asked): conservative, so
 * they rarely fire on a search that found its answer. All three must be
 * under their bar, and the reranker and a store's relevance must both have
 * been measured; a search missing either signal is never weak by relevance.
 * - rerankScore: the cross-encoder's best relevance logit over the pool.
 *   Pairs that answer the question score well above 0.
 * - conceptShare: the best store hit's share of the question's concepts.
 *   Below a third, no store matched most of what was asked.
 * - vectorMargin: the best vetted semantic hit's margin over its store's own
 *   bar. A store with no vetted semantic hit has none.
 */
export const FOLLOW_UP_WEAK_BARS = Object.freeze({
  rerankScore: -3,
  conceptShare: 0.34,
  vectorMargin: 0.02,
});

/** Counts only: how well the search's best candidate matched. */
export interface SearchStrength {
  rerankBest?: number;
  conceptShareBest?: number;
  vectorMarginBest?: number;
}

export type WeakSearchVerdict =
  | { weak: false }
  | { weak: true; reason: 'no_citations' | 'low_relevance' };

/**
 * Whether to ask a follow-up. A search cut short (a store skipped as busy or
 * cut by its deadline) is coverage, never weak: it is reported as incomplete.
 */
export function weakSearch(input: {
  citations: number;
  strength?: SearchStrength;
  cutShort: boolean;
  bars?: typeof FOLLOW_UP_WEAK_BARS;
}): WeakSearchVerdict {
  if (input.cutShort) return { weak: false };
  if (input.citations === 0) return { weak: true, reason: 'no_citations' };
  const bars = input.bars ?? FOLLOW_UP_WEAK_BARS;
  const strength = input.strength;
  if (strength?.rerankBest === undefined || strength.conceptShareBest === undefined) return { weak: false };
  const below = strength.rerankBest < bars.rerankScore
    && strength.conceptShareBest < bars.conceptShare
    && (strength.vectorMarginBest === undefined || strength.vectorMarginBest < bars.vectorMargin);
  return below ? { weak: true, reason: 'low_relevance' } : { weak: false };
}

/** Lane losses that make a search incomplete rather than weak. */
const CUT_SHORT_REASONS: ReadonlySet<string> = new Set(['lane_timeout', 'semantic_lane_skipped']);

export function searchCutShort(input: {
  skippedReasons: readonly string[];
  degradationReasons: readonly string[];
}): boolean {
  return input.skippedReasons.some((reason) => reason === 'lane_timeout')
    || input.degradationReasons.some((reason) => CUT_SHORT_REASONS.has(reason));
}

/** One evidence candidate's metadata, as the follow-up may use it. */
export interface FollowUpCandidate {
  corpusId: string;
  /** The source's product name, as citations show it (core/remote-result.ts sourceLabel). */
  source: string;
  conversationId?: string;
  conversationLabel?: string;
  authorLabel?: string;
  authoredAt?: string;
  /** False leaves the candidate out of every option: its names may not go where this answer goes. */
  namesReleasable: boolean;
}

export const FOLLOW_UP_MAX_OPTIONS = 4;
const LABEL_NAME_MAX_CHARS = 60;
const KIND_ORDER: Readonly<Record<FollowUpScopeOption['kind'], number>> = { conversation: 0, author: 1, source: 2, year: 3 };

/**
 * The places the search saw, grouped by metadata only, best first: up to
 * FOLLOW_UP_MAX_OPTIONS groups by size, no two with the same members.
 * Empty when no candidate may be named.
 */
export function followUpScopeOptions(candidates: readonly FollowUpCandidate[]): FollowUpScopeOption[] {
  interface Group { kind: FollowUpScopeOption['kind']; key: string; name: string; source: string; corpora: Set<string>; members: number[]; scope: (corpora: string[]) => SourceAnswerNarrowScope }
  const groups = new Map<string, Group>();
  const add = (kind: Group['kind'], key: string, index: number, init: Omit<Group, 'kind' | 'key' | 'corpora' | 'members'>) => {
    const id = `${kind}\u0000${key}`;
    const group = groups.get(id) ?? { kind, key, corpora: new Set<string>(), members: [], ...init };
    group.corpora.add(candidates[index]!.corpusId);
    group.members.push(index);
    groups.set(id, group);
  };
  candidates.forEach((candidate, index) => {
    if (!candidate.namesReleasable) return;
    const source = labelName(candidate.source) ?? 'Other source';
    add('source', source, index, { name: source, source, scope: (corpora) => ({ corpus_ids: corpora }) });
    const conversation = labelName(candidate.conversationLabel);
    const conversationId = candidate.conversationId?.trim();
    if (conversation && conversationId) {
      add('conversation', `${candidate.corpusId}\u0000${conversationId}`, index, {
        name: conversation, source, scope: (corpora) => ({ corpus_ids: corpora, conversation_id: conversationId }),
      });
    }
    const author = labelName(candidate.authorLabel);
    if (author) {
      add('author', `${source}\u0000${author.toLowerCase()}`, index, {
        name: author, source, scope: (corpora) => ({ corpus_ids: corpora, sender_label: author }),
      });
    }
    const year = yearOf(candidate.authoredAt);
    if (year !== undefined) {
      add('year', String(year), index, {
        name: String(year), source,
        scope: () => ({ authored_after: `${year}-01-01T00:00:00.000Z`, authored_before: `${year}-12-31T23:59:59.999Z` }),
      });
    }
  });
  const ranked = [...groups.values()].sort((left, right) => (right.members.length - left.members.length)
    || (KIND_ORDER[left.kind] - KIND_ORDER[right.kind])
    || left.key.localeCompare(right.key));
  const chosen: FollowUpScopeOption[] = [];
  const seen = new Set<string>();
  for (const group of ranked) {
    if (chosen.length >= FOLLOW_UP_MAX_OPTIONS) break;
    const memberKey = group.members.join(',');
    if (seen.has(memberKey)) continue;
    const years = group.members.flatMap((index) => {
      const year = yearOf(candidates[index]!.authoredAt);
      return year === undefined ? [] : [year];
    });
    const label = optionLabel(group.kind, group.name, group.source, group.members.length, years);
    if (!label) continue;
    seen.add(memberKey);
    chosen.push({ kind: group.kind, label, scope: group.scope([...group.corpora].sort()), members: [...group.members] });
  }
  return chosen;
}

/** The follow-up question for these options; undefined when there are none. */
export function followUpQuestion(options: readonly Pick<FollowUpScopeOption, 'label'>[]): string | undefined {
  if (options.length === 0) return undefined;
  const question = `I didn't find a clear answer. Possible places: ${options.map((option) => option.label).join('; ')}. `
    + 'Which should I look in, or which person or period?';
  return secretLabelsInText(question).length > 0 ? undefined : question;
}

/**
 * The follow-up for a weak search, with each option's scope behind a fresh
 * opaque handle. `contributors` are the candidates whose names it shows, so
 * the caller can record them as released names.
 */
export function buildFollowUp(candidates: readonly FollowUpCandidate[]): { followUp: SourceAnswerFollowUp; contributors: number[] } | undefined {
  const options = followUpScopeOptions(candidates);
  const question = followUpQuestion(options);
  if (!question) return undefined;
  return {
    followUp: { question, options: options.map((option) => ({ label: option.label, narrow: issueNarrowHandle(option.scope) })) },
    contributors: [...new Set(options.flatMap((option) => option.members))].sort((a, b) => a - b),
  };
}

function optionLabel(kind: FollowUpScopeOption['kind'], name: string, source: string, count: number, years: readonly number[]): string | undefined {
  const items = `${count} ${count === 1 ? 'item' : 'items'}`;
  const span = yearSpan(years);
  const detail = span ? `${items}, ${span}` : items;
  const label = kind === 'conversation' ? `${name} in ${source} (${detail})`
    : kind === 'author' ? `${source} from ${name} (${detail})`
      : kind === 'source' ? `${source} (${detail})`
        : `${name} (${items})`;
  return secretLabelsInText(label).length > 0 ? undefined : label;
}

function yearSpan(years: readonly number[]): string | undefined {
  if (years.length === 0) return undefined;
  const first = Math.min(...years);
  const last = Math.max(...years);
  return first === last ? String(first) : `${first} to ${last}`;
}

function yearOf(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return undefined;
  const year = new Date(time).getUTCFullYear();
  return year >= 1970 && year <= 9999 ? year : undefined;
}

/** A name as one bounded line, or undefined when empty or secret-like. */
function labelName(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const line = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!line || secretLabelsInText(value).length > 0) return undefined;
  const bounded = line.length > LABEL_NAME_MAX_CHARS ? `${line.slice(0, LABEL_NAME_MAX_CHARS - 1).trimEnd()}…` : line;
  return secretLabelsInText(bounded).length > 0 ? undefined : bounded;
}

/* ------------------------------------------------------------------ */
/* Narrow handles                                                      */
/* ------------------------------------------------------------------ */

/** A narrow handle as minted here: no identifier, no content. */
export const NARROW_HANDLE_PATTERN = /^fu_[A-Za-z0-9_-]{24}$/;
const NARROW_HANDLE_LIFETIME = 60 * 60 * 1000;
const NARROW_HANDLE_CAPACITY = 5_000;

interface NarrowEntry { scope: SourceAnswerNarrowScope; expiresAt: number }
const narrowHandles = new Map<string, NarrowEntry>();
let clock: () => number = () => Date.now();

/** Test seam: the clock the handles expire by. */
export function setNarrowHandleClockForTest(now: (() => number) | undefined): void {
  clock = now ?? (() => Date.now());
}

export function isNarrowHandle(value: unknown): value is string {
  return typeof value === 'string' && NARROW_HANDLE_PATTERN.test(value);
}

/** Mint a handle for one scope. Process memory only; an hour, then gone. */
export function issueNarrowHandle(scope: SourceAnswerNarrowScope): string {
  const now = clock();
  for (const [handle, entry] of narrowHandles) {
    if (entry.expiresAt <= now) narrowHandles.delete(handle);
  }
  while (narrowHandles.size >= NARROW_HANDLE_CAPACITY) narrowHandles.delete(narrowHandles.keys().next().value!);
  const handle = `fu_${randomBytes(18).toString('base64url')}`;
  narrowHandles.set(handle, { scope: copyScope(scope), expiresAt: now + NARROW_HANDLE_LIFETIME });
  return handle;
}

/** The scope behind a handle, or undefined when it is unknown or expired. */
export function resolveNarrowHandle(handle: unknown): SourceAnswerNarrowScope | undefined {
  if (!isNarrowHandle(handle)) return undefined;
  const entry = narrowHandles.get(handle);
  if (!entry) return undefined;
  if (entry.expiresAt <= clock()) {
    narrowHandles.delete(handle);
    return undefined;
  }
  return copyScope(entry.scope);
}

function copyScope(scope: SourceAnswerNarrowScope): SourceAnswerNarrowScope {
  return {
    ...(scope.corpus_ids?.length ? { corpus_ids: [...scope.corpus_ids] } : {}),
    ...(scope.conversation_id ? { conversation_id: scope.conversation_id } : {}),
    ...(scope.sender_label ? { sender_label: scope.sender_label } : {}),
    ...(scope.authored_after ? { authored_after: scope.authored_after } : {}),
    ...(scope.authored_before ? { authored_before: scope.authored_before } : {}),
  };
}

/** Whether an item with this metadata lies inside a scope (eval oracle check). */
export function scopeContains(scope: SourceAnswerNarrowScope, item: {
  corpusId: string; conversationId?: string; senderLabel?: string; authoredAt?: string;
}): boolean {
  if (scope.corpus_ids && !scope.corpus_ids.includes(item.corpusId)) return false;
  if (scope.conversation_id !== undefined && scope.conversation_id !== item.conversationId) return false;
  if (scope.sender_label !== undefined
    && !(item.senderLabel ?? '').toLowerCase().includes(scope.sender_label.toLowerCase())) return false;
  if (scope.authored_after !== undefined || scope.authored_before !== undefined) {
    const at = item.authoredAt ? Date.parse(item.authoredAt) : Number.NaN;
    if (!Number.isFinite(at)) return false;
    if (scope.authored_after !== undefined && at < Date.parse(scope.authored_after)) return false;
    if (scope.authored_before !== undefined && at > Date.parse(scope.authored_before)) return false;
  }
  return true;
}

/** A follow-up as a boundary receives it: well-formed, or undefined. */
export function parseFollowUp(value: unknown): SourceAnswerFollowUp | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.question !== 'string' || !record.question.trim() || !Array.isArray(record.options)) return undefined;
  const options = record.options.flatMap((option): SourceAnswerFollowUpOption[] => {
    if (!option || typeof option !== 'object') return [];
    const { label, narrow } = option as Record<string, unknown>;
    return typeof label === 'string' && label.trim() && isNarrowHandle(narrow) ? [{ label, narrow }] : [];
  });
  return options.length > 0 ? { question: record.question, options: options.slice(0, FOLLOW_UP_MAX_OPTIONS) } : undefined;
}
