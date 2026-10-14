/** An owner question through the existing source_answer route, never a new model lane. */
import type { SovereigntyEngine } from '../../core/sovereignty.ts';
import { DASHBOARD_PRIVATE_ANSWERS_COPY as W } from '../dashboard/vocabulary.ts';
import type { PrivateEvidenceItem } from '../chatgpt/private-answer-contract.ts';
import type { SourceIndexAnswerHandler } from '../source-index/answer-types.ts';
import { localAnswerRequest, type LocalAnswerRequest, type LocalAnswerResult } from '../source-index/local-answer.ts';
import { inboxEvidenceIdentity } from './local-private-answers.ts';

export type AskDestinationState = 'ready' | 'not_set_up' | 'not_allowed' | 'busy';
export interface AskDestinationStates { computer: AskDestinationState; venice: AskDestinationState; computerReason?: string }

/** Resolve only the pool's approved Venice members: provider preference can otherwise fall back to local. */
export function privateVeniceMembers(engine: SovereigntyEngine) {
  if (engine.config.retrieval.trustDomains.secure_local?.secureHandling === 'metadata_only_gap') return [];
  try {
    return engine.resolveAnalystPool({ trustDomain: 'secure_local', requestedProvider: 'venice' }).members
      .filter(member => member.profile.provider === 'venice' && member.profile.trust === 'encrypted_cloud');
  } catch { return []; }
}

export function createVeniceInboxAnswer(options: {
  state: () => AskDestinationState;
  handler: SourceIndexAnswerHandler;
  corpusIds: () => string[];
  sourceName?: (corpusId: string) => string | undefined;
  eligible: (items: readonly PrivateEvidenceItem[]) => Promise<readonly boolean[]>;
}): (input: LocalAnswerRequest) => Promise<LocalAnswerResult> {
  return async input => {
    if (options.state() !== 'ready' || input.stillAuthorized?.() === false) throw new Error(W.veniceNotAllowed);
    const read: PrivateEvidenceItem[] = [];
    const sentItems: Array<{ title?: string; source?: string; date?: string }> = [];
    const corpusIds = options.corpusIds();
    if (!corpusIds.length) return { status: 'not_found', leftOut: [] };
    const request = { ...localAnswerRequest(input.question, input.selectors), corpus_ids: corpusIds, retrieval_mode: 'keyword' as const, analyst_provider: 'venice' as const };
    const result = await options.handler.answer(request, {
      beforeVeniceDispatch(pack, corpusIds) {
        // Repeated at the actual dispatch, after the shared handler's live release checks.
        if (options.state() !== 'ready' || input.stillAuthorized?.() === false) throw new Error(W.veniceNotAllowed);
        pack.candidates.forEach((candidate, i) => {
          const item = { ...candidate, corpusId: corpusIds[i] ?? '' } as unknown as PrivateEvidenceItem;
          read.push(inboxEvidenceIdentity(item));
          const citation = candidate.provenance.citation ?? {};
          sentItems.push({ ...(citation.title ? { title: citation.title } : {}), source: candidate.provenance.sourceItem.provider, ...(citation.authoredAt ? { date: citation.authoredAt } : {}) });
        });
      },
    });
    // A fallback is a useful source_answer result, but cannot be labeled as a Venice answer.
    if (result.audit.answer_synthesis.analyst_backend !== 'venice') return { status: 'failed' };
    const allowed = await options.eligible(read);
    if (allowed.length !== read.length || allowed.some(value => !value)) return { status: 'changed' };
    return {
      status: 'answered', answer: result.answer, read, sentItems,
      citations: result.evidence.map(item => ({ ...(item.title ? { title: item.title } : {}), source: item.provider, ...(item.authored_at ? { date: item.authored_at } : {}), ...(item.uri?.startsWith('https://') ? { url: item.uri } : {}) })),
      unanswered: [], leftOut: [...new Set(result.audit.skipped_corpora.filter(item => !['not_requested', 'trust_domain_not_allowed', 'corpus_not_allowed'].includes(item.reason)).map(item => options.sourceName?.(item.corpus_id) ?? W.oneSource))],
    };
  };
}
