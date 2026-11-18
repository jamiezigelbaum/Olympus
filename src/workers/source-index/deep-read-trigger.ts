import type { AnalystResult } from '../../core/contracts.ts';
import type { EvidencePackBuildDetail } from '../../core/evidence-pack.ts';
import { RESERVED_HEAD_SEATS } from '../../core/source-index/retrieval.ts';
import { DeepReadRefused } from '../../core/deep-read-refused.ts';
import type { DeepReadJobs } from '../engine/runtime/deep-read-jobs.ts';

const AUTOMATIC_READ_MAX_SECONDS = 900;

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
  onSkippedTooLong?: (sectionsTotal: number) => void,
): Promise<DeepReadTriggerResult> {
  if (result.unanswered.length === 0 && result.citations.length > 0) return {};
  const cited = new Set(result.citations.map(citation => citation.provenance.sourceItem.localItemId));
  const headSeats = (detail.truncatedCandidateIndexes ?? []).flatMap(seat => {
    const candidate = detail.pack.candidates[seat];
    const corpusId = detail.candidateCorpusIds[seat];
    if (seat >= RESERVED_HEAD_SEATS || !candidate || !corpusId) return [];
    return [{ seat, candidate, corpusId, cited: cited.has(candidate.provenance.sourceItem.localItemId) }];
  }).sort((a, b) => Number(b.cited) - Number(a.cited) || a.seat - b.seat);

  let firstRefusal: DeepReadTriggerResult | undefined;
  for (const { candidate, corpusId } of headSeats) {
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
      const view = await jobs.start(detail.pack.question, { selected_item: selected, whole: 'item' }, { maxSeconds: AUTOMATIC_READ_MAX_SECONDS });
      return {
        job: { id: view.id, sectionsTotal: view.sectionsTotal, providerItemId: item.providerItemId },
        notice: `Reading all of "${title}" for this question: ${view.sectionsDone} of ${view.sectionsTotal} sections; the answer follows in Private answers.`,
      };
    } catch (error) {
      if (!(error instanceof DeepReadRefused)) throw error;
      firstRefusal ??= {
        refused: error.code,
        notice: `"${title}" was read only in part. ${error.message} Use source_deep_read to request the full read.`,
      };
      if (error.code === 'too_long' && error.sectionsTotal !== undefined) onSkippedTooLong?.(error.sectionsTotal);
      if (error.code === 'no_private_model' || error.code === 'model_unavailable') break;
    }
  }
  return firstRefusal ?? {};
}
