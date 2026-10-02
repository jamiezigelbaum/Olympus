/**
 * The private answer panel's model: the built-in private model
 * (src/core/analyst-built-in.ts), behind the panel's PrivateAnswerModel
 * contract (private-answer-contract.ts).
 *
 * - status: `ready` only once the model is downloaded and verified on this
 *   Mac; `model_downloading` (with its percent) while it installs; otherwise
 *   `no_model`. Reads the install status file; never starts a download.
 * - answerPrivately: the Private evidence (each matched item with its own
 *   passages, read locally) becomes the built-in model's evidence items
 *   (title, passages, locator, source, date); an item with no readable text
 *   is left out and reported as unreadable, never answered from its title.
 *   The model reads only the few most relevant items: ranked by how close
 *   each item's name and text are to the question (local embeddings, when
 *   this computer has them), cut at a relevance floor below the best, in a
 *   compact rendering that puts each item's name and date first.
 *   The answer (without evidence numbers), the cited titles and the
 *   unanswered gaps become the panel's plaintext. Nothing here
 *   leaves this computer except through the sealed panel payload.
 * - reset: stops the model's server process (it restarts on the next answer).
 */
import type {
  AnswerPrivatelyOptions,
  BuiltInAnalystModel,
  PrivateAnswer,
  PrivateEvidenceItem as BuiltInEvidenceItem,
} from '../../core/analyst-built-in.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import type { PrivateAnswerCitation, PrivateAnswerModel, PrivateEvidenceItem } from './private-answer-contract.ts';

export interface BuiltInPrivateAnswerModelOptions {
  /** The worker's one built-in model instance (shared with the sniffer and the answer pool). */
  model: BuiltInAnalystModel | undefined;
  /** Downloaded, verified and prepared in this process. */
  available: () => boolean;
  /** analyst-built-in.ts answerPrivately (injected, so tests run a stub). */
  answer: (question: string, evidence: readonly BuiltInEvidenceItem[], options: AnswerPrivatelyOptions) => Promise<PrivateAnswer>;
  /** The panel's work bound (PANEL_ANSWER_LIMITS by default). */
  limits?: Partial<PanelAnswerLimits>;
  /**
   * Scores each readable item's relevance to the question (higher is closer),
   * one number per item, or undefined when it cannot. Local only: Private
   * names and text never leave this computer for it. Without it, items keep
   * their retrieval order.
   */
  relevance?: PanelRelevance;
}

export type PanelRelevance = (
  question: string,
  items: ReadonlyArray<{ title?: string; text: string }>,
  signal?: AbortSignal,
) => Promise<readonly number[] | undefined>;

/**
 * How much work one panel answer may cost. The panel waits for it live, on
 * a small local model, so it reads only the most relevant readable items
 * (the evidence arrives in relevance order), each with its best passages, in
 * one tight prompt, and skips the Analyst's second (audit) pass, which would
 * cost a second full prompt. Generic: no question or source is consulted.
 */
export interface PanelAnswerLimits {
  /** Readable items read, most relevant first. */
  maxItems: number;
  /**
   * With relevance scores: items scoring more than this below the best item
   * are left out (the relevance floor). The best item is always read.
   */
  relevanceMargin: number;
  /** Characters of passage text per item. */
  maxPassageChars: number;
  /** Ceiling on the prompt's UTF-8 bytes (answerPrivately fits the evidence to it). */
  maxPromptBytes: number;
  /** The answer's character budget (bounds generation). */
  maxAnswerChars: number;
  audit: boolean;
}

export const PANEL_ANSWER_LIMITS: Readonly<PanelAnswerLimits> = {
  maxItems: 4,
  relevanceMargin: 0.04,
  maxPassageChars: 2_400,
  maxPromptBytes: 11_000,
  maxAnswerChars: 1_000,
  audit: false,
};

export function createBuiltInPrivateAnswerModel(options: BuiltInPrivateAnswerModelOptions): PrivateAnswerModel {
  const { model } = options;
  const limits: PanelAnswerLimits = { ...PANEL_ANSWER_LIMITS, ...options.limits };
  return {
    status() {
      if (!model) return { state: 'no_model' };
      if (options.available()) return { state: 'ready' };
      let status;
      try {
        status = model.status();
      } catch {
        return { state: 'no_model' };
      }
      if (status.state === 'downloading' || status.state === 'verifying' || status.state === 'loading') {
        return { state: 'model_downloading', ...(Number.isFinite(status.percent) ? { percent: status.percent } : {}) };
      }
      return { state: 'no_model' };
    },
    async answerPrivately(question, evidence, signal, observe) {
      if (!model) throw new Error('no private answer model');
      const read = privateEvidence(evidence, limits.maxPassageChars);
      const unreadable = read.unreadable;
      const picked = await panelItems(question, read, limits, options.relevance, signal);
      const items = picked.map((index) => read.items[index]!);
      try {
        observe?.evidence?.({
          items: items.length,
          unreadable,
          bytes: items.reduce((sum, item) => sum + utf8Bytes(item.text), 0),
          used: picked.map((index) => read.sources[index]!),
        });
      } catch {
        // A reporting hook never fails the answer.
      }
      if (items.length === 0) {
        if (unreadable === 0) throw new Error('no private evidence');
        // Never answer from titles alone: say plainly that nothing was readable.
        return { answer: unreadableAnswer(unreadable), citations: [], unanswered: [] };
      }
      const result = await options.answer(question, items, {
        model,
        maxPromptBytes: limits.maxPromptBytes,
        maxAnswerChars: limits.maxAnswerChars,
        audit: limits.audit,
        evidenceFormat: 'compact',
        ...(observe?.modelCall ? { onModelCall: (call) => observe.modelCall?.(call) } : {}),
        ...(signal ? { signal } : {}),
      });
      const byId = new Map(items.map((item) => [item.id, item]));
      const citations: PrivateAnswerCitation[] = [];
      const seen = new Set<string>();
      for (const citation of result.citations) {
        if (seen.has(citation.id)) continue;
        seen.add(citation.id);
        const item = byId.get(citation.id);
        const title = citation.title ?? item?.title;
        citations.push({
          ...(title ? { title } : {}),
          ...(item?.source ? { source: item.source } : {}),
          ...(item?.date ? { date: item.date } : {}),
        });
      }
      const unanswered = [...result.unanswered];
      if (unreadable > 0) unanswered.push(unreadableNote(unreadable));
      return { answer: withoutEvidenceMarkers(result.answer), citations, unanswered };
    },
    async reset() {
      await model?.stop();
    },
  };
}

/**
 * Private evidence (the shared EvidencePack's Private candidates, or worker
 * search hits) as the built-in model's evidence items. An item is read only
 * from its own text: its passages (`chunks`), or a bounded passage the worker
 * returned. An item with no readable text is left out and counted as
 * unreadable, never answered from its title.
 */
export function privateEvidence(
  hits: readonly PrivateEvidenceItem[],
  maxPassageChars = MAX_PASSAGE_CHARS,
): { items: BuiltInEvidenceItem[]; unreadable: number; sources: number[] } {
  const items: BuiltInEvidenceItem[] = [];
  /** Each readable item's index in `hits`. */
  const sources: number[] = [];
  let unreadable = 0;
  hits.forEach((hit, index) => {
    const provenance = record(hit.provenance);
    const sourceItem = record(hit.sourceItem) ?? record(provenance?.sourceItem);
    const citation = record(provenance?.citation);
    const content = record(hit.internalContent);
    const title = string(citation?.title) ?? string(hit.title);
    const chunks = Array.isArray(hit.chunks)
      ? hit.chunks.filter((chunk): chunk is string => typeof chunk === 'string' && chunk.trim() !== '').map((chunk) => chunk.trim())
      : [];
    const passage = (chunks.length > 0 ? chunks.join('\n…\n') : undefined)
      ?? string(content?.passage) ?? string(hit.excerpt) ?? string(hit.text);
    const text = passage?.slice(0, maxPassageChars);
    if (!text) {
      unreadable += 1;
      return;
    }
    const id = string(sourceItem?.localItemId) ?? string(sourceItem?.providerItemId) ?? `item-${index + 1}`;
    const locator = string(hit.locator) ?? string(citation?.uri) ?? string(content?.url);
    const source = string(citation?.sourceLabel) ?? string(sourceItem?.provider);
    const date = string(citation?.authoredAt) ?? string(content?.authoredAt) ?? string(citation?.updatedAt);
    sources.push(index);
    items.push({
      id: items.some((item) => item.id === id) ? `${id}#${index + 1}` : id,
      text,
      ...(title ? { title } : {}),
      ...(locator ? { locator } : {}),
      ...(source ? { source } : {}),
      ...(date ? { date } : {}),
    });
  });
  return { items, unreadable, sources };
}

/**
 * Which readable items the panel's model reads, as indexes into `read.items`,
 * most relevant first: by relevance score when there is one (ties keep
 * retrieval order), cut at `relevanceMargin` below the best and at
 * `maxItems`; otherwise the first `maxItems` in retrieval order. Generic: no
 * question, source or document kind is consulted, only the scores.
 */
export async function panelItems(
  question: string,
  read: { items: readonly BuiltInEvidenceItem[] },
  limits: Pick<PanelAnswerLimits, 'maxItems' | 'relevanceMargin'>,
  relevance?: PanelRelevance,
  signal?: AbortSignal,
): Promise<number[]> {
  const max = Math.max(1, limits.maxItems);
  const order = read.items.map((_, index) => index);
  if (order.length === 0) return [];
  let scores: readonly number[] | undefined;
  if (relevance && order.length > 1) {
    try {
      scores = await relevance(question, read.items.map((item) => ({ ...(item.title ? { title: item.title } : {}), text: item.text })), signal);
    } catch {
      scores = undefined;
    }
  }
  if (!scores || scores.length !== order.length || scores.some((score) => !Number.isFinite(score))) {
    return order.slice(0, max);
  }
  const ranked = [...order].sort((a, b) => (scores![b]! - scores![a]!) || (a - b));
  const floor = scores[ranked[0]!]! - Math.max(0, limits.relevanceMargin);
  return ranked.filter((index) => scores![index]! >= floor).slice(0, max);
}

/** How much an item's name counts against its name plus passages in its relevance. */
const TITLE_WEIGHT = 0.7;
/**
 * Passage characters embedded per item for its relevance. The embedding model
 * is shared with search (one queue), so this stays small: on the owner's lab
 * files 400 characters ranked like the whole passage at a quarter of the cost.
 */
const RELEVANCE_TEXT_CHARS = 400;

/**
 * PanelRelevance from a local embedding model: the question's cosine
 * similarity to each item's name (weighted most: a file's or message's name
 * says what it is about) and to its name plus the start of its passages. An item without a
 * name is scored by its text alone. One batch per kind, query embedded once.
 */
export function embeddingPanelRelevance(
  provider: () => Pick<SourceEmbeddingProvider, 'embed' | 'backend' | 'dimension'> | undefined,
): PanelRelevance {
  return async (question, items, signal) => {
    const model = provider();
    // Local only: a cloud embedding service never sees Private names or text.
    if (!model || model.backend !== 'local' || items.length === 0) return undefined;
    const [query] = await model.embed([{ text: question }], { taskType: 'RETRIEVAL_QUERY' });
    if (signal?.aborted) return undefined;
    const named = items.map((item, index) => ({ index, title: item.title?.trim() })).filter((item) => item.title);
    const [titles, texts] = await Promise.all([
      named.length > 0
        ? model.embed(named.map((item) => ({ text: item.title! })), { taskType: 'RETRIEVAL_DOCUMENT' })
        : Promise.resolve([] as number[][]),
      model.embed(items.map((item) => {
        const head = item.text.slice(0, RELEVANCE_TEXT_CHARS);
        return { text: item.title ? `${item.title}\n${head}` : head };
      }), { taskType: 'RETRIEVAL_DOCUMENT' }),
    ]);
    if (!query || texts.length !== items.length || titles.length !== named.length) return undefined;
    const titleScore = new Map(named.map((item, position) => [item.index, cosine(query, titles[position]!)]));
    return items.map((_, index) => {
      const text = cosine(query, texts[index]!);
      const title = titleScore.get(index);
      return title === undefined ? text : TITLE_WEIGHT * title + (1 - TITLE_WEIGHT) * text;
    });
  };
}

function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return Number.NaN;
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    left += a[index]! * a[index]!;
    right += b[index]! * b[index]!;
  }
  return left > 0 && right > 0 ? dot / Math.sqrt(left * right) : Number.NaN;
}

/** privateEvidence's readable items alone. */
export function privateEvidenceItems(hits: readonly PrivateEvidenceItem[]): BuiltInEvidenceItem[] {
  return privateEvidence(hits).items;
}

/**
 * The Analyst cites by evidence number ("… [1]."); the panel lists its
 * sources by title under the answer ("From: …"), so the numbers point at
 * nothing there and are taken out.
 */
export function withoutEvidenceMarkers(answer: string): string {
  return answer
    .replace(/\s*\[\d{1,2}(?:\s*[,;–-]\s*\d{1,2})*\]/g, '')
    .trim();
}

function unreadableNote(count: number): string {
  return count === 1
    ? '1 matching private item has no readable text on this computer, so it was not read.'
    : `${count} matching private items have no readable text on this computer, so they were not read.`;
}

function unreadableAnswer(count: number): string {
  return count === 1
    ? 'The matching private item has no readable text on this computer, so there is no private answer.'
    : `None of the ${count} matching private items has readable text on this computer, so there is no private answer.`;
}

const MAX_PASSAGE_CHARS = 6_000;

function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
