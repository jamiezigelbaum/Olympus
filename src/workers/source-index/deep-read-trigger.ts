import type { AnalystResult } from '../../core/contracts.ts';
import type { EvidencePackBuildDetail } from '../../core/evidence-pack.ts';
import { RESERVED_HEAD_SEATS } from '../../core/source-index/retrieval.ts';
import { DeepReadRefused } from '../../core/deep-read-refused.ts';
import type { DeepReadJobs } from '../engine/runtime/deep-read-jobs.ts';

export interface DeepReadTriggerResult {
  job?: { id: string; sectionsTotal: number; providerItemId: string };
  refused?: DeepReadRefused['code'];
  notice?: string;
}

/** Only structured retrieval and Analyst fields decide whether to read further. */
export async function triggerDeepRead(
  detail: EvidencePackBuildDetail,
  result: AnalystResult,
  jobs: Pick<DeepReadJobs, 'start'> | undefined,
): Promise<DeepReadTriggerResult> {
  if (result.unanswered.length === 0 && result.citations.length > 0) return {};
  const index = detail.truncatedCandidateIndexes?.find(seat => seat < RESERVED_HEAD_SEATS);
  if (index === undefined) return {};
  const candidate = detail.pack.candidates[index];
  const corpusId = detail.candidateCorpusIds[index];
  if (!candidate || !corpusId) return {};
  const item = candidate.provenance.sourceItem;
  const title = candidate.provenance.citation?.title ?? 'the document';
  const selected = {
    corpus_id: corpusId, family: item.family, provider: item.provider,
    account_scope: item.accountScope, provider_item_id: item.providerItemId,
    local_item_id: item.localItemId,
    ...(item.sourceVersion ? { source_version: item.sourceVersion } : {}), title,
  };
  try {
    if (!jobs) throw new DeepReadRefused('no_private_model', 'Deep read needs your own private model. Set one up in Settings, Models.');
    const view = await jobs.start(detail.pack.question, { selected_item: selected, whole: 'item' });
    return {
      job: { id: view.id, sectionsTotal: view.sectionsTotal, providerItemId: item.providerItemId },
      notice: `Reading all of "${title}" for this question: ${view.sectionsDone} of ${view.sectionsTotal} sections; the answer follows in Private answers.`,
    };
  } catch (error) {
    if (!(error instanceof DeepReadRefused)) throw error;
    return { refused: error.code, notice: `"${title}" was not read in full: ${error.message} Use source_deep_read to request the full read.` };
  }
}
