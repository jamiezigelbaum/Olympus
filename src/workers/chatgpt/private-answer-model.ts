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
 *   compact rendering that puts each item's name and date first. When one
 *   or two items clearly lead the rest, only they are read, in depth (their
 *   whole text, re-read from the store, within a larger prompt), with room
 *   for a longer answer, so "all the details" of an item are there to give.
 *   The answer (without evidence numbers), the cited items (title, and where
 *   each opens) and the unanswered gaps become the panel's plaintext.
 *   Nothing here leaves this computer except through the sealed panel
 *   payload; a source's local path stays here (the panel gets a one-time
 *   open token for it, private-answer-jobs.ts).
 * - reset: stops the model's server process (it restarts on the next answer).
 */
import type {
  AnswerPrivatelyOptions,
  BuiltInAnalystModel,
  PrivateAnswer,
  PrivateEvidenceItem as BuiltInEvidenceItem,
} from '../../core/analyst-built-in.ts';
import type { SourceEmbeddingProvider } from '../source-index/embeddings.ts';
import type { PrivateAnswerModel, PrivateAnswerSourceCitation, PrivateEvidenceItem } from './private-answer-contract.ts';

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
  /**
   * Re-reads one evidence item's own text, up to `maxChars`, with its
   * passages chosen for `question` (the whole item when it fits), from the
   * store on this computer. The panel reads an item that clearly leads in
   * depth through it. Without it (or when it fails), the search-time
   * passages are read.
   */
  readItem?: PanelItemReader;
  /**
   * Where one evidence item can be opened: its web address and, when the
   * file is on this computer, its local path (kept on this computer: the
   * panel gets a one-time open token for it, never the path). Undefined
   * when the item has neither.
   */
  sourceLinks?: (item: PrivateEvidenceItem) => PrivateSourceLinks | undefined;
}

export type PanelItemReader = (
  item: PrivateEvidenceItem,
  request: { question: string; maxChars: number },
  signal?: AbortSignal,
) => Promise<readonly string[] | undefined>;

export interface PrivateSourceLinks {
  /** An https address that opens the item in its service. */
  url?: string;
  /** The item's file on this computer. Never leaves this computer. */
  localPath?: string;
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
  /**
   * At most this many items can lead (0 turns leading off). When the top
   * one or two items clearly lead the rest by relevance, the panel reads
   * only them, in depth: their whole text (or their best passages, when
   * longer) within `deepEvidenceChars`, a larger prompt and a longer answer.
   * A request for every detail of an item then reads all of it, instead of
   * four thin slices of four items.
   */
  maxLeadingItems: number;
  /**
   * The top k items lead when the drop from the k-th to the next item is at
   * least this, and at least the spread among the k (so the k are close
   * together and clearly apart from the rest).
   */
  leadGap: number;
  /** Characters of item text read in depth, shared by the leading items. */
  deepEvidenceChars: number;
  /** The prompt ceiling when reading in depth (about 6k tokens). */
  deepPromptBytes: number;
  /** The answer budget when reading in depth (the answer field takes about half). */
  deepAnswerChars: number;
}

export const PANEL_ANSWER_LIMITS: Readonly<PanelAnswerLimits> = {
  maxItems: 4,
  relevanceMargin: 0.04,
  maxPassageChars: 2_400,
  maxPromptBytes: 11_000,
  maxAnswerChars: 1_000,
  audit: false,
  maxLeadingItems: 2,
  leadGap: 0.01,
  deepEvidenceChars: 10_000,
  deepPromptBytes: 14_500,
  deepAnswerChars: 3_700,
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
      const selection = await panelSelection(question, read, limits, options.relevance, signal);
      const picked = selection.items;
      let items = picked.map((index) => read.items[index]!);
      if (selection.leading && options.readItem) {
        items = await readInDepth(
          question,
          items,
          picked.map((index) => evidence[read.sources[index]!]!),
          limits.deepEvidenceChars,
          options.readItem,
          signal,
        );
      }
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
        maxPromptBytes: selection.leading ? limits.deepPromptBytes : limits.maxPromptBytes,
        maxAnswerChars: selection.leading ? limits.deepAnswerChars : limits.maxAnswerChars,
        audit: limits.audit,
        evidenceFormat: 'compact',
        ...(observe?.modelCall ? { onModelCall: (call) => observe.modelCall?.(call) } : {}),
        ...(signal ? { signal } : {}),
      });
      const byId = new Map(items.map((item, position) => [item.id, { item, hit: evidence[read.sources[picked[position]!]!] }]));
      const citations: PrivateAnswerSourceCitation[] = [];
      const seen = new Set<string>();
      // Only the items the answer cites are its sources.
      for (const citation of result.citations) {
        if (seen.has(citation.id)) continue;
        seen.add(citation.id);
        const entry = byId.get(citation.id);
        const item = entry?.item;
        const title = citation.title ?? item?.title;
        let links: PrivateSourceLinks | undefined;
        try {
          links = entry?.hit && options.sourceLinks ? options.sourceLinks(entry.hit) : undefined;
        } catch {
          links = undefined;
        }
        citations.push({
          ...(title ? { title } : {}),
          ...(item?.source ? { source: item.source } : {}),
          ...(item?.date ? { date: item.date } : {}),
          ...(links?.url ? { url: links.url } : {}),
          ...(links?.localPath ? { localPath: links.localPath } : {}),
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
  limits: Pick<PanelAnswerLimits, 'maxItems' | 'relevanceMargin'> & Partial<Pick<PanelAnswerLimits, 'maxLeadingItems' | 'leadGap'>>,
  relevance?: PanelRelevance,
  signal?: AbortSignal,
): Promise<number[]> {
  return (await panelSelection(question, read, limits, relevance, signal)).items;
}

/**
 * panelItems, and whether the picked items lead: one or two items (at most
 * `maxLeadingItems`) clearly ahead of every other item by relevance
 * (leadingCount), or the only readable item. Leading items are read alone,
 * in depth; an item merely within the relevance floor of them is left out.
 */
export async function panelSelection(
  question: string,
  read: { items: readonly BuiltInEvidenceItem[] },
  limits: Pick<PanelAnswerLimits, 'maxItems' | 'relevanceMargin'> & Partial<Pick<PanelAnswerLimits, 'maxLeadingItems' | 'leadGap'>>,
  relevance?: PanelRelevance,
  signal?: AbortSignal,
): Promise<{ items: number[]; leading: boolean }> {
  const max = Math.max(1, limits.maxItems);
  const maxLeading = Math.max(0, Math.floor(limits.maxLeadingItems ?? 0));
  const order = read.items.map((_, index) => index);
  if (order.length === 0) return { items: [], leading: false };
  if (order.length === 1) return { items: order, leading: maxLeading > 0 };
  let scores: readonly number[] | undefined;
  if (relevance && order.length > 1) {
    try {
      scores = await relevance(question, read.items.map((item) => ({ ...(item.title ? { title: item.title } : {}), text: item.text })), signal);
    } catch {
      scores = undefined;
    }
  }
  if (!scores || scores.length !== order.length || scores.some((score) => !Number.isFinite(score))) {
    return { items: order.slice(0, max), leading: false };
  }
  const ranked = [...order].sort((a, b) => (scores![b]! - scores![a]!) || (a - b));
  const floor = scores[ranked[0]!]! - Math.max(0, limits.relevanceMargin);
  const picked = ranked.filter((index) => scores![index]! >= floor).slice(0, max);
  const leading = leadingCount(ranked.map((index) => scores![index]!), Math.min(maxLeading, picked.length), limits.leadGap ?? 0);
  return leading > 0 ? { items: picked.slice(0, leading), leading: true } : { items: picked, leading: false };
}

/**
 * How many of the top items lead, from scores sorted best first: the k (1 to
 * maxLeading) whose drop to the next score is largest, counting only a k
 * whose drop is at least `gap` and at least the spread among the k. 0 when
 * none leads. Scores only: no question, source or content is consulted.
 */
export function leadingCount(sorted: readonly number[], maxLeading: number, gap: number): number {
  let best = 0;
  let bestDrop = Number.NEGATIVE_INFINITY;
  for (let k = 1; k <= Math.min(maxLeading, sorted.length); k += 1) {
    const drop = k < sorted.length ? sorted[k - 1]! - sorted[k]! : Number.POSITIVE_INFINITY;
    const spread = sorted[0]! - sorted[k - 1]!;
    if (drop >= gap && drop >= spread && drop > bestDrop) {
      best = k;
      bestDrop = drop;
    }
  }
  return best;
}

/**
 * The leading items' text, re-read in depth: each item's whole text when
 * all of them fit `budget` characters; otherwise the shorter ones whole and
 * the rest an equal share of what is left, each re-read for its best
 * passages at that size. An item whose re-read fails or comes back shorter
 * keeps its search-time passages.
 */
async function readInDepth(
  question: string,
  items: readonly BuiltInEvidenceItem[],
  hits: readonly PrivateEvidenceItem[],
  budget: number,
  readItem: PanelItemReader,
  signal?: AbortSignal,
): Promise<BuiltInEvidenceItem[]> {
  const read = async (index: number, maxChars: number): Promise<string | undefined> => {
    try {
      const chunks = await readItem(hits[index]!, { question, maxChars }, signal);
      const text = (chunks ?? []).map((chunk) => chunk.trim()).filter(Boolean).join('\n…\n');
      return text ? text.slice(0, maxChars) : undefined;
    } catch {
      return undefined;
    }
  };
  const whole = await Promise.all(items.map((_, index) => read(index, budget)));
  const sizes = whole.map((text, index) => text?.length ?? items[index]!.text.length);
  // Fair shares: the shorter items whole, the rest split what is left.
  const share = new Array<number>(items.length).fill(0);
  const byLength = sizes.map((size, index) => ({ size, index })).sort((a, b) => a.size - b.size);
  let remaining = budget;
  byLength.forEach(({ size, index }, position) => {
    const fair = Math.floor(remaining / (byLength.length - position));
    share[index] = Math.min(size, fair);
    remaining -= share[index]!;
  });
  return Promise.all(items.map(async (item, index) => {
    const full = whole[index];
    if (!full) return item;
    const text = full.length <= share[index]! ? full : (await read(index, share[index]!)) ?? full.slice(0, share[index]!);
    return text.length > item.text.length ? { ...item, text } : item;
  }));
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
