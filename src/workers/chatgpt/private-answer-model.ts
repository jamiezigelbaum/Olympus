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
      const { items, unreadable } = privateEvidence(evidence);
      if (items.length === 0) {
        if (unreadable === 0) throw new Error('no private evidence');
        // Never answer from titles alone: say plainly that nothing was readable.
        return { answer: unreadableAnswer(unreadable), citations: [], unanswered: [] };
      }
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
export function privateEvidence(hits: readonly PrivateEvidenceItem[]): { items: BuiltInEvidenceItem[]; unreadable: number } {
  const items: BuiltInEvidenceItem[] = [];
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
    const text = passage?.slice(0, MAX_PASSAGE_CHARS);
    if (!text) {
      unreadable += 1;
      return;
    }
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
  return { items, unreadable };
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
