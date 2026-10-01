/**
 * The private answer panel's model: the built-in private model
 * (src/core/analyst-built-in.ts), behind the panel's PrivateAnswerModel
 * contract (private-answer-contract.ts).
 *
 * - status: `ready` only once the model is downloaded and verified on this
 *   Mac; `model_downloading` (with its percent) while it installs; otherwise
 *   `no_model`. Reads the install status file; never starts a download.
 * - answerPrivately: the Private search hits become the built-in model's
 *   evidence items (title, passage, locator, source, date), and its answer,
 *   citations and unanswered gaps become the panel's plaintext. Nothing here
 *   leaves this computer except through the sealed panel payload.
 * - reset: stops the model's server process (it restarts on the next answer).
 */
import type {
  AnswerPrivatelyOptions,
  BuiltInAnalystModel,
  PrivateAnswer,
  PrivateEvidenceItem as BuiltInEvidenceItem,
} from '../../core/analyst-built-in.ts';
import type { PrivateAnswerCitation, PrivateAnswerModel, PrivateEvidenceItem } from './private-answer-contract.ts';

export interface BuiltInPrivateAnswerModelOptions {
  /** The worker's one built-in model instance (shared with the sniffer and the answer pool). */
  model: BuiltInAnalystModel | undefined;
  /** Downloaded, verified and prepared in this process. */
  available: () => boolean;
  /** analyst-built-in.ts answerPrivately (injected, so tests run a stub). */
  answer: (question: string, evidence: readonly BuiltInEvidenceItem[], options: AnswerPrivatelyOptions) => Promise<PrivateAnswer>;
}

const MAX_PASSAGE_CHARS = 6_000;

export function createBuiltInPrivateAnswerModel(options: BuiltInPrivateAnswerModelOptions): PrivateAnswerModel {
  const { model } = options;
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
    async answerPrivately(question, evidence, signal) {
      if (!model) throw new Error('no private answer model');
      const items = privateEvidenceItems(evidence);
      if (items.length === 0) throw new Error('no private evidence');
      const result = await options.answer(question, items, { model, ...(signal ? { signal } : {}) });
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
      return { answer: result.answer, citations, unanswered: [...result.unanswered] };
    },
    async reset() {
      await model?.stop();
    },
  };
}

/** Search hits (worker `source_index_search` shape) as the built-in model's evidence items. */
export function privateEvidenceItems(hits: readonly PrivateEvidenceItem[]): BuiltInEvidenceItem[] {
  const items: BuiltInEvidenceItem[] = [];
  hits.forEach((hit, index) => {
    const sourceItem = record(hit.sourceItem);
    const provenance = record(hit.provenance);
    const citation = record(provenance?.citation);
    const content = record(hit.internalContent);
    const title = string(citation?.title) ?? string(hit.title);
    const passage = string(content?.passage) ?? string(hit.excerpt) ?? string(hit.text);
    const text = (passage ?? title)?.slice(0, MAX_PASSAGE_CHARS);
    if (!text) return;
    const id = string(sourceItem?.localItemId) ?? string(sourceItem?.providerItemId) ?? `item-${index + 1}`;
    const locator = string(hit.locator) ?? string(citation?.uri) ?? string(content?.url);
    const source = string(citation?.sourceLabel) ?? string(sourceItem?.provider);
    const date = string(citation?.authoredAt) ?? string(content?.authoredAt) ?? string(citation?.updatedAt);
    items.push({
      id: items.some((item) => item.id === id) ? `${id}#${index + 1}` : id,
      text,
      ...(title ? { title } : {}),
      ...(locator ? { locator } : {}),
      ...(source ? { source } : {}),
      ...(date ? { date } : {}),
    });
  });
  return items;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
